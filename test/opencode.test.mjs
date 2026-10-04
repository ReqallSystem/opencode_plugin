import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../index.js';
import { INSTRUCTIONS, SKILLS_DIR, createServer, partId } from '../src/reqall-plugin.js';
import { SAMPLE_RECORDS, fakeReqall, testEnv } from './fake-reqall.mjs';

function fakeClient() {
  const prompts = [];
  return { prompts, session: { promptAsync: async (req) => { prompts.push(req); return { data: {} }; } } };
}

async function setup(options = {}, envExtra = {}) {
  const env = testEnv(envExtra);
  const fake = fakeReqall({ records: SAMPLE_RECORDS });
  const client = fakeClient();
  const hooks = await createServer({ env, fetch: fake.fetch })({ client, directory: '/tmp', worktree: '/tmp' }, options);
  return { hooks, fake, client };
}

function userMessage(text, sessionID = 'ses_1') {
  return [
    { sessionID, agent: 'build', model: { providerID: 'anthropic', modelID: 'claude' }, messageID: 'msg_1' },
    { message: { id: 'msg_1' }, parts: [{ id: 'prt_0', type: 'text', text }] },
  ];
}

test('default export is a v1 server plugin', () => {
  assert.equal(plugin.id, 'reqall');
  assert.equal(typeof plugin.server, 'function');
});

test('part ids are ascending and OpenCode-shaped', () => {
  const a = partId();
  const b = partId();
  assert.match(a, /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(b > a);
});

test('config adds MCP, skills, instructions and commands without overriding the user', async () => {
  const { hooks } = await setup();
  const cfg = { command: { 'reqall-persist': { template: 'mine' } } };
  await hooks.config(cfg);
  assert.deepEqual(cfg.mcp.reqall, {
    type: 'remote', url: 'https://reqall.test/mcp', enabled: true,
    headers: { Authorization: 'Bearer rq_test' }, oauth: false,
  });
  assert.deepEqual(cfg.skills.paths, [SKILLS_DIR]);
  assert.deepEqual(cfg.instructions, [INSTRUCTIONS]);
  assert.equal(cfg.command['reqall-persist'].template, 'mine');
  assert.match(cfg.command['reqall-context'].template, /reqall-context skill/);

  const user = { mcp: { reqall: { type: 'remote', url: 'https://example/mcp' } } };
  await hooks.config(user);
  assert.equal(user.mcp.reqall.url, 'https://example/mcp');
  await hooks.config(user);
  assert.equal(user.skills.paths.length, 1, 'idempotent');
});

test('without a key the MCP entry relies on OpenCode OAuth', async () => {
  const { hooks } = await setup({}, { REQALL_API_KEY: '' });
  const cfg = {};
  await hooks.config(cfg);
  assert.deepEqual(cfg.mcp.reqall, { type: 'remote', url: 'https://reqall.test/mcp', enabled: true });
});

test('chat.message attaches recall as a synthetic part', async () => {
  const { hooks, fake } = await setup();
  const [info, output] = userMessage('Add CSV export to widgets');
  await hooks['chat.message'](info, output);
  assert.equal(output.parts.length, 2);
  const part = output.parts[1];
  assert.equal(part.type, 'text');
  assert.equal(part.synthetic, true);
  assert.equal(part.sessionID, 'ses_1');
  assert.equal(part.messageID, 'msg_1');
  assert.match(part.text, /#7 spec\/open/);
  assert.match(part.text, /session_id="opencode:[0-9a-f]{32}"/);
  assert.match(part.text, /reqall-intend/);
  assert.equal(fake.calls.find((c) => c.name === 'upsert_project').args.name, 'acme/widgets');
});

test('trivial, follow-up, command and subagent messages get no recall', async () => {
  const { hooks, fake } = await setup();
  for (const text of ['thanks', '[reqall] Before finishing…', 'Use the reqall-persist skill. now']) {
    const [info, output] = userMessage(text);
    await hooks['chat.message'](info, output);
    assert.equal(output.parts.length, 1, text);
  }
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_1' } } } });
  const [info, output] = userMessage('Implement the exporter', 'ses_child');
  await hooks['chat.message'](info, output);
  assert.equal(output.parts.length, 1);
  assert.equal(fake.calls.filter((c) => c.method === 'tools/call').length, 0);
});

test('idle after unpersisted edits sends one persist follow-up per turn', async () => {
  const { hooks, client } = await setup();
  await hooks['chat.message'](...userMessage('Refactor the exporter'));
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
  assert.equal(client.prompts.length, 0, 'clean turn: no nudge');

  await hooks['tool.execute.after']({ sessionID: 'ses_1', tool: 'edit', args: { filePath: 'src/a.ts' } });
  await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } } });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
  assert.equal(client.prompts.length, 1);
  const req = client.prompts[0];
  assert.equal(req.path.id, 'ses_1');
  assert.equal(req.body.agent, 'build');
  assert.deepEqual(req.body.model, { providerID: 'anthropic', modelID: 'claude' });
  assert.match(req.body.parts[0].text, /^\[reqall\].*reqall-persist/);
  assert.equal(req.body.noReply, undefined);

  await hooks['tool.execute.after']({ sessionID: 'ses_1', tool: 'reqall_upsert_record', args: {} });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
  assert.equal(client.prompts.length, 1);
});

test('git bookkeeping is not work; reminder mode does not start a turn', async () => {
  const { hooks, client } = await setup({ autoPersist: 'reminder' });
  await hooks['chat.message'](...userMessage('commit it'));
  await hooks['tool.execute.after']({ sessionID: 'ses_1', tool: 'bash', args: { command: 'git commit -am x && git push' } });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
  assert.equal(client.prompts.length, 0);
  await hooks['tool.execute.after']({ sessionID: 'ses_1', tool: 'bash', args: { command: 'npm run build' } });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
  assert.equal(client.prompts[0].body.noReply, true);
});

test('compaction keeps the binding', async () => {
  const { hooks } = await setup();
  await hooks['chat.message'](...userMessage('Implement the exporter'));
  const output = { context: [] };
  await hooks['experimental.session.compacting']({ sessionID: 'ses_1' }, output);
  assert.match(output.context[0], /project_name="acme\/widgets"/);
});
