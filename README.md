# Unified Inbox

One local desktop inbox for every customer conversation across **3 WhatsApp numbers + Lazada / TikTok / Shopee (via Duoke) + our webstore live chat**, where an **AI drafts a reply per thread that a human edits, approves, and sends**.

This is a deliberate low-cost workaround until official channel APIs are affordable. **Every channel sits behind a swappable adapter** (`ChannelAdapter`) and **every AI engine behind one interface** (`LLMProvider`), so an official-API adapter (or a different model) drops in later with no change to the rest of the app. Recon and the full rationale: [docs/RECON.md](docs/RECON.md).

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Recon → `docs/RECON.md` | ✅ done |
| 1 | Scaffold: store/schema, `ChannelAdapter` + `LLMProvider`, config, fake adapter proving the pipeline | ✅ done |
| 2 | Real adapters: WhatsApp ×3 ✅, Duoke ✅ (send too), webstore ⬜ | 🚧 2a/2b done, 2c left |
| 3 | Unified inbox UI (cross-channel list, history, approve/edit/send, channel tabs) | ✅ core done |
| 4 | AI reply layer (Ollama, per-channel, swappable) + MCP server | ✅ done |
| 5 | Hardening: WhatsApp anti-ban (pacing/caps/kill-switch) ✅, persistence ⬜, swap-to-official docs ⬜ | 🚧 anti-ban done |

## Architecture (one-liner)

Electron (one long-lived Node main process) hosts the local SQLite store, the channel adapters, the LLM router, and an MCP server; a React renderer is the inbox UI over a thin typed IPC boundary. See [docs/RECON.md](docs/RECON.md) §0.

```
src/
  core/            platform-agnostic business logic (no Electron import — unit-tested)
    channels/      ChannelAdapter interface + FakeAdapter + ChannelManager
    llm/           LLMProvider interface + EchoProvider + LlmRouter
    store/         SQLite-backed InboxStore
    config/        config load + validation (no secrets in code)
    InboxService   the pipeline: ingest -> draft -> approve -> send
  main/            Electron main: lifecycle, IPC, boots core
  preload/         typed contextBridge
  renderer/        React inbox UI
db/schema.sql      the message store schema
tests/             pipeline + store + config tests
```

## Develop (after `npm install` — see Phase 1 notes)

```bash
npm install          # see package.json
npm test             # core unit tests (Node)
npm run dev          # launch the Electron app (electron-vite + HMR)
```

## AI drafts + MCP

Drafts come from a pluggable `LLMProvider` (default: **Ollama**, local + free — set `OLLAMA_MODEL`, e.g. `gemma3:4b`). Provider is per-channel in config; cloud adapters (Claude/OpenAI) drop in the same way.

The inbox is also exposed over **MCP** so any MCP client can read threads and draft replies (never approve/send — that stays in the desktop app):

```bash
npm run build:mcp    # bundle → out/mcp/server.mjs
```

Then point a client at it (Claude Desktop `claude_desktop_config.json`, etc.):

```json
{ "mcpServers": { "unified-inbox": { "command": "node", "args": ["<repo>/out/mcp/server.mjs"] } } }
```

Tools: `list_threads`, `get_thread`, `draft_reply`.

## WhatsApp anti-ban guard

The WhatsApp path is an unofficial workaround (WhatsApp Web), so every outbound
reply passes through a `SendPolicy` before it leaves:

- **Per-number daily cap** — max sends per number in a rolling 24h window (default
  200, `whatsapp.dailyCap` in config), counted from the send-audit log so it
  survives restarts. At the cap, the send is refused with a clear reason.
- **Human-like pacing** — a randomized, length-scaled "typing" delay before each
  send, so replies never fire back-to-back like a bot.
- **Global kill switch** — one toggle in the WhatsApp panel instantly pauses *all*
  outbound WhatsApp sending; reads/drafts keep working.
- **Surfaced ban risk** — each number shows `sent/cap · low|medium|high risk`, and
  the risk band drives the header indicator.

The guard is a swappable seam: replace `WhatsAppAdapter` with an official-API
adapter later and the caps/pacing/kill-switch policy still applies unchanged.

## Principles

- **Human-in-the-loop by default.** AI drafts; nothing sends until a human approves. Auto-send is per-channel and OFF until explicitly enabled.
- **No secrets in code.** Keys via `.env` / `config.local.json` (both gitignored).
- **Thin, swappable adapters.** Business logic never imports a vendor SDK.
