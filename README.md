# srevoice

A voice-native SRE console. You talk, it answers out loud, and everything it looked up to get there lands on the screen in full.

It connects to remote PagerDuty MCP endpoints — the SRE agent MCP and the incident MCP — and turns their tools into a conversation. Ask "what's triggered right now?" and you get a spoken two-sentence answer plus the complete incident list rendered on screen. No dashboards, no tab-hunting, no reading JSON aloud.

## The shape of it

```
Browser ──WebSocket──▶ ElevenLabs Agents (STT + LLM + TTS)
   │                            │
   │   agent invokes a client tool
   ◀────────────────────────────┘
   │
   └──POST /api/mcp/call──▶ srevoice server ──▶ PagerDuty MCP (Streamable HTTP)
                                  │
              short text ─────────┴───────── full payload
              back to the agent               to the screen
```

The voice loop belongs to ElevenLabs. The data does not.

Every MCP tool is registered with ElevenLabs as a **client** tool, so invocations come back to the browser, which asks this server to run them. Three things follow from that, and they are the whole reason for the design:

- **MCP credentials never leave the server.** The browser holds a signed WebSocket URL and nothing else.
- **Your MCP endpoints never need to be reachable from ElevenLabs' network.** They only need to be reachable from this container.
- **Every result passes through here**, so the screen gets the full payload while the agent gets a trimmed version to speak from. One round trip, two output channels.

## Running it

```bash
npm install
cp .env.example .env        # set SREVOICE_MASTER_KEY at minimum
npm run dev                 # API on :5280, Vite on :5281
```

```bash
npm run build               # both workspaces
npm test                    # server suite (vitest)
npm run typecheck
npm run docker:up           # single container on :5280
```

`SREVOICE_MASTER_KEY` seals the settings file. Generate one with `openssl rand -base64 32`. Lose it and every stored credential becomes unreadable — that is the point, but plan for it. The server refuses to start in production without it.

`SREVOICE_ACCESS_TOKEN` gates every `/api` route behind an `x-srevoice-token` header. Set it the moment this is reachable from anywhere but localhost; the console prompts for it in Settings and keeps it in browser storage.

## First run

1. Open the console and go to **Settings → Connections**.
2. Paste your **ElevenLabs API key** (needs Agents access) and hit *Test key*.
3. Add your MCP servers. PagerDuty's hosted endpoint is `https://mcp.pagerduty.com/mcp` with an `Authorization: Bearer <token>` header. The *reference* you give each server prefixes its tool names, so keep it short — `pd`, `sre`.
4. Hit **Save & provision agent**. This connects to each MCP server, reads its tool list, registers one ElevenLabs client tool per MCP tool, and builds an agent that references them all.
5. Close Settings and hit **Start session**. Allow the microphone.

Re-provision whenever you add a server or an MCP server changes its tools. It reconciles rather than recreating, so it is safe to run repeatedly.

## Configuration that lives in the UI, not in env

Only infrastructure goes in environment variables. The ElevenLabs key, the MCP endpoints, their auth headers, the voice, the model, and the system prompt are all pasted into Settings and sealed into `$DATA_DIR/settings.sealed` with AES-256-GCM. The browser only ever receives masked previews (`sk_1••••cdef`) and a `configured` boolean.

That means secrets survive a redeploy as long as the volume and the master key survive, and it means you can rotate a PagerDuty token without touching the deployment.

## Notes that will save you time

**Tool names are namespaced** as `<reference>__<tool>` and capped at 64 characters, because that is what the ElevenLabs tool-name parser accepts. If an MCP tool name is long it gets truncated — the server keeps the real name internally, so calls still route correctly.

**MCP schemas get flattened.** MCP servers emit full JSON Schema; the ElevenLabs parameter parser handles a conservative subset. Nullable unions collapse to their concrete type, `anyOf` takes its first usable branch, and anything nested more than four levels deep becomes a string field described as "pass as a JSON string". Nothing is dropped silently.

**Transport is negotiated.** Streamable HTTP first, SSE as a fallback. Hosted MCP providers are mid-migration between the two and pinning either one strands half of them.

**Long results are trimmed for speech, not for the screen.** Anything over ~6k characters gets cut before it reaches the agent, with a note telling it to summarise what is on screen. The screen always shows everything.

**Writes ask first.** The system prompt requires explicit confirmation before escalating, acknowledging, resolving, or adding notes. Read-only lookups happen without ceremony.

## Deployment

Single container. The API serves the built SPA from its own origin, so there is no CORS setup and no second deployment target.

On Coolify: mount a persistent volume at `/data`, set `SREVOICE_MASTER_KEY` and `SREVOICE_ACCESS_TOKEN`, expose port `5280`. Health check is `GET /api/health`. HTTPS is not optional — microphone access requires a secure context.

Set the healthcheck **host** to `127.0.0.1`, not `localhost`. Fastify's `0.0.0.0` bind is IPv4-only, alpine resolves `localhost` to `::1` first, and the probe comes back `Connection refused` while the app is serving perfectly — which fails the deploy and rolls it back.

Do not set `NODE_ENV` as a platform env var. The Dockerfile already sets it in the runtime stage, and Coolify injects env vars into the build as `ARG`s, where a production value strips `tsc` and `vite` out of the install.

Live at <https://sre.apps.fintonlabs.com>.

## Layout

```
server/src/
  crypto/seal.ts        AES-256-GCM envelope
  store/                sealed settings, atomic writes, serialised mutations
  mcp/pool.ts           one client per server, namespaced catalogue, retry-on-stale
  mcp/render.ts         result → speech + display split
  elevenlabs/           REST client, schema normaliser, prompt, provisioning
  routes/               settings, mcp, session, health
web/src/
  hooks/useSreConversation.ts   the voice session and everything it produces
  lib/inspect.ts                runtime shape sniffing for tool results
  components/                   console, transcript, tool cards, settings
```
