# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                      # root install; npm workspaces (server, web)
npm run dev                      # API :5280 + Vite :5281 concurrently
npm run build                    # server tsc, then web tsc -b && vite build
npm test                         # vitest, both workspaces
npm run typecheck                # both workspaces
npm run lint                     # eslint over server/src and web/src
npm run docker:up                # single container, needs SREVOICE_MASTER_KEY in .env
                                 # SREVOICE_ACCESS_TOKEN gates /api behind x-srevoice-token

npm test --workspace web         # frontend only (jsdom + testing-library)
npm test --workspace server -- src/crypto/seal.test.ts        # one file
npm test --workspace server -- -t "serialises concurrent"     # one test by name
npm run test:watch --workspace server
```

`npm run build` after editing TypeScript in either `src/` — the web build is the only thing that typechecks JSX properly.

## What this is

A voice console for PagerDuty MCP servers (plus Rundeck through them). The agent persona is **Paige**. ElevenLabs Agents owns the realtime voice loop (STT, LLM, TTS over WebSocket); this app owns the data path.

## The one architectural decision everything follows from

MCP tools are registered with ElevenLabs as **client** tools, not via ElevenLabs' native MCP server integration.

That means the agent's tool invocations arrive in the *browser*, which POSTs them to `/api/mcp/call`, which runs the actual MCP call server-side. Consequences, all deliberate:

- MCP credentials never reach the browser or ElevenLabs.
- MCP endpoints only need to be reachable from this container, not from ElevenLabs' network.
- Every result passes through `renderToolResult`, which splits it into `speech` (trimmed to ~6k chars, what the agent says) and `display` (everything, what the screen shows).

If you are tempted to switch to native MCP integration, you lose all three.

## Data flow

```
Settings UI ──▶ PUT /api/settings ──▶ SettingsStore (sealed) ──▶ McpPool.sync()
                                                                      │
POST /api/provision ──▶ pool.catalogue() ──▶ ElevenLabs client tools ─┘
                                          └─▶ agent (tool_ids + prompt)

POST /api/session/start ──▶ signed WebSocket URL ──▶ browser
browser client tool ──▶ POST /api/mcp/call ──▶ guard ──▶ pool.call() ──▶ {speech, display}
                                   └─ > SOFT_BUDGET_MS ──▶ PendingCalls ──▶ GET /api/mcp/pending (browser polls)
```

Everything persisted lives in `$DATA_DIR` as separate sealed files, all with the same atomic-write pattern: `settings`, `memory` (Paige's notes), `skills` (on-demand instructions), `authored` (jobs the agent wrote).

**Built-in tools masquerade as MCP servers.** `memory__*` and `skill__*` (`server/src/memory/tools.ts`) are provisioned and routed exactly like MCP tools so naming, `unqualify` and UI grouping work unchanged. `screen__show` and `session__end` are handled entirely in the browser (`useSreConversation.tsx`) and never reach the server.

## Things that will bite you

**Secrets are never returned to the browser.** `redactSettings` masks everything. On save, an MCP header value of `null` means "keep what is stored" — the browser only has masked previews, so without that sentinel every save would overwrite live tokens with dots. `web/src/components/McpServerEditor.tsx:draftToPayload` produces those nulls; `server/src/routes/settings.ts` resolves them.

**Tool names are the routing key.** `qualify(serverId, toolName)` → `<serverId>__<tool>`, capped at 64 chars for ElevenLabs. When truncation happens the tool half is cut, never the server prefix. `unqualify` recovers only the server id — the real remote name lives in the pool's `CatalogueEntry.remoteName`, so never reconstruct a remote name from a qualified one.

**`useSreConversation` binds client-tool handlers at hook construction.** `App.tsx` remounts `<Console>` with `key={tools.join('|')}` for exactly this reason. If you make the tool list mutable without remounting, newly provisioned tools silently do nothing.

**Tool failures return HTTP 200** with `ok: false`. A 4xx/5xx surfaces to the agent as a broken tool instead of a result it can explain out loud. Same reason `runTool` returns the error string rather than throwing.

**`SettingsStore.update` serialises writes** through a promise chain and writes atomically via tmp-file rename. Concurrent read-modify-writes would otherwise lose credentials. The chain survives a rejected mutation.

**Losing `SREVOICE_MASTER_KEY` orphans every stored credential.** The store throws rather than silently starting empty. Production startup refuses without it.

**Some refusals are code, not prompt.** `server/src/mcp/guard.ts` refuses running a Rundeck job the agent authored itself (tracked in `AuthoredJobStore`) and ad-hoc command/script runs; workflows stay allowed. The agent has overridden prompt rules before, so don't move this into the system prompt. Refusals return `isError: false` so Paige explains rather than reports a broken tool.

**Slow tool calls become pending, not failures.** ElevenLabs waits at most ~2 minutes and interruptions end turns sooner. `routes/mcp.ts` races the call against `SOFT_BUDGET_MS`; overruns answer `pending: true`, keep running, and are collected via `/api/mcp/pending`. Pending results are scoped to `sessionId` (a resumed session keeps its id; a new one must never receive the old one's results), and `answeredInline` prevents the same result arriving twice. `followup.ts` reuses this path to re-check a remediation workflow ~90s later.

**A saved system prompt replaces the built-in one entirely.** Provisioning uses `settings.agent.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT` (`elevenlabs/prompt.ts`). Edits to `DEFAULT_SYSTEM_PROMPT` do nothing on an install with a saved override — check that first when a prompt fix "doesn't work". Settings reports which default sections an override is missing.

**MCP transport is negotiated per server** — Streamable HTTP, then SSE. The reported error is always the Streamable HTTP one; SSE's failure is appended in parentheses.

## Stack notes

Fastify 5 with a pino instance cast to `FastifyBaseLogger` in `app.ts` — passing a concrete pino `Logger` widens every route generic downstream and produces pages of unrelated type errors.

React 19 + Vite + Tailwind v4 (`@tailwindcss/vite`, `@theme` block in `index.css`, no `tailwind.config.js`). Radix primitives, Framer Motion, `@elevenlabs/react`. Deliberately PagerDuty's own look, not the house style: PD palette and severity colours, Helvetica-family fallback stack (no webfont), green accent for interactive surfaces only — status colour always means status, never decoration. Dark is the base; light mode overrides only the surface ladder. Avatar art exists per state and per theme.

Ports 5280 (API) and 5281 (Vite) avoid the crowded 3000/5173 range shared with other `~/work` projects. Docker resources are prefixed `srevoice-`.

## Testing

Server: pure logic only, by design: `seal`, the sealed stores, tool-name qualification, result rendering, JSON Schema normalisation, prompt building, provisioning helpers, the guard, pending calls and follow-ups. Network paths (`McpPool`, `ElevenLabsClient`) are not mocked — verify those against a real endpoint. `pool.sync()` against a real URL with a bad token is a fast, honest check that the transport stack works.

Web: `RichText` and `lib/inspect`, under jsdom. The results panel renders third-party tool
output, so the test that raw HTML never reaches the DOM is load-bearing — and
`SpokenText` exists precisely because parsing the transcript as Markdown mangles
identifiers like `checkout_api_v2`.
