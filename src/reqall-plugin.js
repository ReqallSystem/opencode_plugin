/**
 * Reqall server plugin for OpenCode (v1 plugin API).
 *
 * - config: adds the `reqall` remote MCP server, bundled skills, the Reqall
 *   instructions file and /reqall-* commands (user settings win)
 * - chat.message: binds the project and attaches recall to each non-trivial
 *   user message as a synthetic text part
 * - tool.execute.after: tracks unpersisted edits; Reqall writes clear them
 * - session idle: one follow-up per turn asking the agent to persist
 * - experimental.session.compacting: keeps the binding and intent IDs
 *
 * Every Reqall call fails open.
 */
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractProjectHint, resolveProjectBinding } from '../lib/project-policy.mjs';
import {
  ReqallClient,
  bindingNote,
  compactionNote,
  intentDirective,
  isMutatingTool,
  isReqallWriteTool,
  isTrivialPrompt,
  persistDirective,
  recallContext,
  resolveApiKey,
  resolveApiUrl,
  sessionLabel,
} from '../lib/reqall.mjs';

const HOST = 'OpenCode';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = join(ROOT, 'skills');
export const INSTRUCTIONS = join(ROOT, 'REQALL.md');
const MARK = '[reqall]';

const COMMANDS = {
  'reqall-context': 'Load Reqall project context for: $ARGUMENTS',
  'reqall-intend': 'Record the agreed intent in Reqall before editing: $ARGUMENTS',
  'reqall-persist': 'Persist this session\'s meaningful work to Reqall. $ARGUMENTS',
  'reqall-review': 'Review open Reqall records for this project. $ARGUMENTS',
  'reqall-triage': 'Triage this issue or request into Reqall: $ARGUMENTS',
  'reqall-sleep': 'Run Reqall SLEEP memory compression. $ARGUMENTS',
};

// Same layout as OpenCode's ascending identifiers: prefix_<6-byte time+counter><14 base62>.
let lastMs = 0;
let counter = 0;
export function partId() {
  const now = Date.now();
  if (now !== lastMs) {
    lastMs = now;
    counter = 0;
  }
  counter += 1;
  const value = BigInt(now) * 0x1000n + BigInt(counter);
  const time = Buffer.alloc(6);
  for (let i = 0; i < 6; i += 1) time[i] = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const rand = [...randomBytes(14)].map((b) => chars[b % 62]).join('');
  return `prt_${time.toString('hex')}${rand}`;
}

function setting(options, key, envKey, env, fallback) {
  const value = options?.[key] ?? env[envKey];
  return value === undefined || value === null || value === '' ? fallback : String(value).toLowerCase();
}

/** Build the plugin's server function. Tests inject `env` and `fetch`. */
export function createServer({ env = process.env, fetch: fetchImpl } = {}) {
  return async function server(input = {}, options = {}) {
    const client = input.client;
    const cwd = input.directory || input.worktree || process.cwd();
    const reqall = new ReqallClient({ env, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    const sessions = new Map();
    const children = new Set();
    const autoContext = setting(options, 'autoContext', 'REQALL_AUTO_CONTEXT', env, 'inject');
    const autoPersist = setting(options, 'autoPersist', 'REQALL_AUTO_PERSIST', env, 'followup');
    const contextLimit = Number(options.contextLimit ?? env.REQALL_CONTEXT_LIMIT) || 5;
    const openLimit = Number(options.openLimit ?? env.REQALL_OPEN_LIMIT) || 10;

    function session(id) {
      if (!sessions.has(id)) {
        sessions.set(id, { project: '', selected: '', turn: 0, dirty: false, nudgedTurn: 0, agent: undefined, model: undefined });
      }
      return sessions.get(id);
    }

    async function nudge(sessionID) {
      const state = sessions.get(sessionID);
      if (!state?.dirty || children.has(sessionID) || autoPersist === 'off' || state.nudgedTurn === state.turn) return;
      state.nudgedTurn = state.turn;
      const body = {
        parts: [{ type: 'text', text: persistDirective(state.project || 'the bound project', sessionLabel('opencode', sessionID)) }],
        ...(state.agent ? { agent: state.agent } : {}),
        ...(state.model ? { model: state.model } : {}),
        ...(autoPersist === 'reminder' ? { noReply: true } : {}),
      };
      try {
        await client?.session?.promptAsync?.({ path: { id: sessionID }, body });
      } catch { /* fail open */ }
    }

    return {
      async config(cfg) {
        if (!cfg || typeof cfg !== 'object') return;
        if (options.mcp !== false && env.REQALL_OPENCODE_MCP !== 'off') {
          cfg.mcp ??= {};
          if (!cfg.mcp.reqall) {
            const key = resolveApiKey(env);
            cfg.mcp.reqall = {
              type: 'remote',
              url: `${resolveApiUrl(env)}/mcp`,
              enabled: true,
              ...(key ? { headers: { Authorization: `Bearer ${key}` }, oauth: false } : {}),
            };
          }
        }
        cfg.skills ??= {};
        cfg.skills.paths = [...new Set([...(cfg.skills.paths ?? []), SKILLS_DIR])];
        if (options.instructions !== false) {
          cfg.instructions = [...new Set([...(cfg.instructions ?? []), INSTRUCTIONS])];
        }
        cfg.command ??= {};
        for (const [name, template] of Object.entries(COMMANDS)) {
          cfg.command[name] ??= { template: `Use the ${name} skill. ${template}`, description: `Reqall: ${name.slice(7)}` };
        }
      },

      async event({ event } = {}) {
        const props = event?.properties || {};
        if (event?.type === 'session.created' && props.info?.parentID) children.add(props.info.id);
        else if (event?.type === 'session.deleted') {
          sessions.delete(props.info?.id);
          children.delete(props.info?.id);
        } else if (event?.type === 'session.idle') await nudge(props.sessionID);
        else if (event?.type === 'session.status' && props.status?.type === 'idle') await nudge(props.sessionID);
      },

      async 'chat.message'(info = {}, output = {}) {
        const { sessionID } = info;
        if (!sessionID || children.has(sessionID)) return;
        const parts = Array.isArray(output.parts) ? output.parts : [];
        const text = parts
          .filter((p) => p?.type === 'text' && !p.synthetic && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n')
          .trim();
        // Skip our own follow-ups and /reqall-* command prompts.
        if (!text || text.startsWith(MARK) || text.startsWith('Use the reqall-')) return;

        const state = session(sessionID);
        state.turn += 1;
        if (info.agent) state.agent = info.agent;
        if (info.model?.providerID && info.model?.modelID) state.model = { providerID: info.model.providerID, modelID: info.model.modelID };
        state.selected = extractProjectHint(text) || state.selected;
        state.project = resolveProjectBinding(cwd, env, text, state.selected).name;
        if (isTrivialPrompt(text) || autoContext === 'off') return;

        const label = sessionLabel('opencode', sessionID);
        let context = bindingNote(state.project, label, HOST);
        if (autoContext === 'inject' && reqall.configured) {
          context = (await recallContext(reqall, {
            projectName: state.project, query: text.slice(0, 500), label, host: HOST, contextLimit, openLimit,
          })).text;
        }
        parts.push({
          id: partId(),
          sessionID,
          messageID: output.message?.id ?? info.messageID,
          type: 'text',
          synthetic: true,
          text: `${context}\n\n${intentDirective(state.project)}`,
        });
      },

      async 'tool.execute.after'(info = {}) {
        const { sessionID, tool, args } = info;
        if (!sessionID || children.has(sessionID)) return;
        const state = session(sessionID);
        if (isReqallWriteTool(tool)) state.dirty = false;
        else if (isMutatingTool(tool, args)) state.dirty = true;
      },

      async 'experimental.session.compacting'(info = {}, output = {}) {
        const state = sessions.get(info.sessionID);
        if (!state?.project || !Array.isArray(output.context)) return;
        output.context.push(compactionNote(state.project, sessionLabel('opencode', info.sessionID)));
      },
    };
  };
}
