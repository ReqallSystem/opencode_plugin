# Reqall OpenCode Plugin

Persistent semantic project memory for [OpenCode](https://opencode.ai), backed
by the [Reqall](https://reqall.net) MCP server: recall before work, record agreed
intent, persist outcomes before the turn ends.

One server plugin wires everything. It adds the MCP server, skills,
instructions and commands through OpenCode's `config` hook, so there is nothing
else to copy.

## Install

The plugin installs from GitHub; it is not published to npm. Add it to
`opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:ReqallSystem/opencode_plugin"]
}
```

```bash
export REQALL_API_KEY="rq_..."         # or rely on OpenCode's MCP OAuth (see below)
```

Options go in the tuple form, e.g.
`["github:ReqallSystem/opencode_plugin", { "autoPersist": "reminder" }]`.
OpenCode caches the download under `~/.cache/opencode/packages/`; delete the
`github:ReqallSystem` entry there to pick up a newer `main`.

For a local checkout, add a one-line file at `.opencode/plugins/reqall.js` (or
`~/.config/opencode/plugins/reqall.js`):

```js
export { default } from '/path/to/opencode_plugin/index.js';
```

Confirm with `opencode debug config` (look for `mcp.reqall` and `skills.paths`)
and `opencode debug skill`.

## What it adds

| Hook | Behavior |
|---|---|
| `config` | Adds the `reqall` remote MCP server (`https://www.reqall.net/mcp`). With `REQALL_API_KEY` it sends a bearer header and disables OAuth; without a key, OpenCode's MCP OAuth flow handles auth (`opencode mcp auth reqall`). Also adds the bundled `skills/` to `skills.paths`, `REQALL.md` to `instructions`, and `/reqall-context`, `/reqall-intend`, `/reqall-persist`, `/reqall-review`, `/reqall-triage` and `/reqall-sleep` commands. Your own `mcp.reqall` or commands with the same names win. |
| `chat.message` | For each non-trivial user message in a root session, binds the project and attaches recall (`upsert_project` → `search` → open `list_records`) as a synthetic text part, plus a `reqall-intend` reminder. |
| `tool.execute.after` | `edit` / `write` / `patch` / mutating `bash` mark the turn unpersisted; `reqall_upsert_record` clears it. Read-only commands and git add/commit/push bookkeeping do not count. |
| `session.idle` | If the turn left unpersisted edits, sends **one** follow-up prompt (same agent and model) asking the agent to run `reqall-persist`. Subagent sessions are skipped. |
| `experimental.session.compacting` | Keeps the project binding, session label and intent IDs in the compaction summary. |

Each session gets an opaque `opencode:<sha256>` label. The agent is told to pass
it as `session_id` on Reqall writes whose schema lists that field. Recalled
records are framed as background data, not instructions. Every Reqall failure is
fail-open.

## Configuration

Plugin options (or environment variables):

| Option | Env | Default | Description |
|---|---|---|---|
| `autoContext` | `REQALL_AUTO_CONTEXT` | `inject` | `inject` recall, `reminder` (binding only) or `off` |
| `autoPersist` | `REQALL_AUTO_PERSIST` | `followup` | `followup` (new turn), `reminder` (message without reply) or `off` |
| `contextLimit` / `openLimit` | `REQALL_CONTEXT_LIMIT` / `REQALL_OPEN_LIMIT` | `5` / `10` | Recall sizes |
| `mcp: false` | `REQALL_OPENCODE_MCP=off` | on | Do not add the MCP server |
| `instructions: false` | — | on | Do not add `REQALL.md` to instructions |

Also: `REQALL_API_KEY`, `REQALL_URL`, `REQALL_PROJECT_NAME`,
`REQALL_WORKSPACE_ROOT`, `REQALL_MACHINE_NAME`.

## Project identity

Resolved from OpenCode's working directory with the shared
[naming contract](https://github.com/ReqallSystem/plugins/blob/main/doc/PROJECT_NAMING.md)
(`lib/project-policy.mjs` is vendored byte-for-byte from `@reqall/core`):
`REQALL_PROJECT_NAME` → Git `origin` (`org/repo`) → a labelled
`project_name: …` in the prompt → `.reqall.yml` → package identity →
workspace-relative path → `.machine/<host>/<user>`.

## Development

```bash
npm test   # offline node --test + npm pack --dry-run
```

Tests drive the hooks with a fake OpenCode client and an in-process fake Reqall
endpoint; nothing touches the network or your OpenCode config.

## License

MIT
