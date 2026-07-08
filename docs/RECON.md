# RECON.md — Unified Customer-Message Inbox

**Date:** 2026-06-24 · **Phase:** 0 (Recon — no app code yet) · **Machine:** macOS, Node v26, Ollama installed.

A single local inbox for every customer conversation across **3 WhatsApp numbers + Lazada/TikTok/Shopee (via Duoke) + our webstore live chat**, where an **AI drafts a reply per thread that a human edits, approves, and sends**. Every channel sits behind a swappable adapter so an official-API adapter can replace each low-cost workaround later with zero changes to the rest of the app.

> **Status of this document:** findings + a recommended architecture. It ends with the decisions I need from you (the Phase 0 checkpoint). Nothing has been built yet beyond this file.

---

## 0. TL;DR — Recommended architecture

```
                         ┌─────────────────────────────────────────────┐
                         │   Electron main process (one long-lived)     │
                         │                                              │
  WhatsApp num-1 ──┐     │  ChannelManager                              │
  WhatsApp num-2 ──┼─────┼─►  • WhatsAppAdapter ×3 (1 utilityProcess ea)│
  WhatsApp num-3 ──┘     │    • DuokeAdapter (Lazada/TikTok/Shopee)     │
                         │    • WebstoreAdapter (TBD product)           │     ┌──────────────┐
  Duoke (local app) ─────┼─►  • FakeAdapter (Phase 1 pipeline proof)    │◄────┤ MCP client    │
                         │                                              │ MCP │ (claude.ai /  │
  Webstore connector ────┼─►  LLM router ──► LLMProvider                │stdio│  Cowork)      │
                         │      • OllamaProvider (local)                │     └──────────────┘
                         │      • Claude / OpenAI (cloud)               │
                         │                                              │
                         │  better-sqlite3 store (threads/messages/...) │
                         │  MCP server (stdio): resources + gated tools │
                         └───────────────────────┬──────────────────────┘
                                                 │ typed IPC
                                       ┌─────────▼─────────┐
                                       │ React renderer    │
                                       │ unified inbox UI  │
                                       └───────────────────┘
```

| Layer | Choice | Why |
|---|---|---|
| Shell / runtime | **Electron** (main = long-lived Node) | Every moving part (whatsapp-web.js, Baileys, MCP SDK, Ollama/OpenAI clients, webstore listener) is Node-native; the WhatsApp Web session is **stateful and must stay alive**; in-process MCP server + shared SQLite. Tauri would force a Node sidecar anyway. |
| UI | **React** renderer, thin **typed IPC** to main | Renderer never touches channels/DB directly — keeps the boundary clean. |
| Store | **better-sqlite3** (WAL), synchronous, in-process | Fast, native, no daemon. Tables: `threads`, `messages`, `customers`, `channels`, `drafts`, `send_audit`. |
| Channels | one **`ChannelAdapter`** interface | `receive + send + getHistory + health`. Workaround now, official-API later = one-class swap. |
| WhatsApp | **whatsapp-web.js** primary / **Baileys** fallback, **1 `utilityProcess` per number** | Real WhatsApp-Web fingerprint (lowest ban vector); per-number crash + ban-risk isolation. |
| AI | **`LLMProvider`** interface + per-channel config router | `OllamaProvider` (local) + `Claude`/`OpenAI` (cloud). Provider choice never enters business logic. |
| AI clients | **MCP server** (`@modelcontextprotocol/sdk`, stdio) | Any MCP client reads threads + drafts; **`send` is server-side-gated on human approval + per-channel auto-send enable**. |
| Secrets | gitignored `.env` / `config.local.json` | No keys in code. Duoke token is read live from Duoke's own profile, never copied into the repo. |

**Human-in-the-loop is the product's spine and its main ban defense:** AI drafts, human approves, nothing auto-sends until explicitly enabled per channel.

---

## 1. WhatsApp — 3 numbers, unofficial (no paid Business API)

### Approaches compared (verified current, 2026)
| | **whatsapp-web.js** (Puppeteer) | **Baileys** (`@whiskeysockets/baileys`) |
|---|---|---|
| Mechanism | Drives the **real WhatsApp Web** app in managed Chromium | Hand-rolled client speaking WA's **multi-device WebSocket** protocol, no browser |
| 2026 status | v1.34.7 (Apr 2026), maintained, multi-device, Apache-2.0 | Maintained, de-facto raw-protocol lib, multi-device |
| 3 numbers | 3 `Client`s, `LocalAuth({ clientId })` → isolated session dirs, persist across restart | `useMultiFileAuthState('./auth/num-N')`, one dir per number |
| Cost | **Heavy** — one Chromium/number (~300–500 MB ea) | **Light** — a socket + keystore/number (tens of MB) |
| Fingerprint | **Legitimate WA-Web client** (lowest ban vector) | Custom protocol client — easier to flag |
| Realism primitives | via WA-Web internals | first-class: `sendPresenceUpdate('composing')`, `sendReceipt(...,'read')` |

### Ban risk (this is the part to take seriously)
WhatsApp's 2026 detection is layered: registration fingerprint → behavioral (velocity/reply-ratio/timing) → recipient reports → content matching. **Two facts dominate:**
1. **Usage pattern beats tool choice ~10×.** Reply-only bots (answer inbound only) ≈ **<2% ban/12mo**; proactive cold-messaging ≈ **15–30%**. Our human-approved, reply-to-inbound design sits in the safe regime *by construction*.
2. **2026 rule:** WhatsApp counts **messages with no reply within 48h on a rolling 30-day window**. Cold first-contact is the single most dangerous action.

**Signal traffic-lights to engineer against:** reply rate >30% safe / <15% danger · velocity <30/hr safe / >60/hr danger · stranger-sends <20/day safe / >50/day danger · identical-message <5/hr safe / >15/hr danger · block/report >2% → account quality drops.

### Anti-ban config (enforced defaults, per number) — to implement in Phase 5
```
sendDelayMinSec: 3 / sendDelayMaxSec: 8     # randomized, NEVER a fixed interval
newChatExtraDelaySec: 3
maxPerMinute: 8 / maxPerHourSteady: 25      # stay in the <30/hr green band
cooldownAfterMessages: 100 / cooldownMinutes: 5   # human-style break
maxStrangerMessagesPerDay: 5                # hard first-contact cap
maxIdenticalPerHour: 5                      # spintax/name-vars; no byte-identical repeats
dailyCap_established: 200–300 (aged 90d+ number, velocity-bound)
dailyCap_newNumber: 20 (day 1; warmup ramp below)
```
- **Warmup new numbers:** wk1 10–20/day to known contacts → wk2 30–50 → wk3 80–100 → wk4 normal. Going silent >72h resets warmup.
- **Realism (nearly free with human approval):** fire `composing`→`paused` sized to message length before send; delay read receipts 10–60 min; circadian throttle (slow 02:00–06:00 `Asia/Kuala_Lumpur`); don't fire instantly on the approve click.
- **Kill switch / canary:** **Error 463** = soft early-warning ("too many strangers") — auto-halt *new-contact* sends on that number, let in-session replies continue. On a temp-ban countdown: **wait it out, do NOT reinstall/switch device/use a mod** (escalates). Per-number isolated queues (one number's restriction never pushes volume onto the others). Global red **PAUSE-ALL** + per-number ban-risk indicator in the UI.

**Caveat to surface:** every QR-connected unofficial client violates Meta ToS and carries structural ban risk no behavior fully removes (lifespans weeks→months). Start conservative. The only zero-ban path is the official Business API — which is exactly why this lives behind a swappable adapter.

> **Decision:** whatsapp-web.js primary (legitimate fingerprint), Baileys behind the same `ChannelAdapter` as a swappable lighter fallback. Reply-only, drafts-by-default, hard human-approval gate, per-number kill switch + visible ban-risk surface.

---

## 2. Marketplace — Duoke (Lazada / TikTok Shop / Shopee)

### What Duoke actually is (dissected read-only from the installed app)
- **Thin Electron shell** (Electron **22.3.27** / Chromium 108). `main.js` loads the *remote* web app `https://app.duoke.com/index.html` — the real conversation/history/send logic is a webpack bundle served from `app.duoke.com`, **not in the local `app.asar`**.
- **Chat transport is Tencent Cloud IM** (`tim-js-sdk`, SDKAppID `1400575678`, seller TIM userID `1182761223`) brokered through Duoke's own gateway: `im.duoke.com` / `cn-im.duoke.com` / `global-im.duoke.com`. Conversations are C2C (seller ↔ per-buyer TIM accounts); marketplace messages arrive as Tencent **`TIMCustomElem`** custom payloads (the Lazada/Shopee/TikTok text + order context is JSON inside `payload.data`).
- **No local app messages DB.** The data dir `~/Library/Application Support/Duoke/` is a Chromium profile: chat lives in LevelDB-backed Local Storage + a tiny (48 KB) IndexedDB that only caches the **latest message per conversation** — not full history. `config.json` is electron-store AES-encrypted with a **hardcoded key** (`e]X*0rYwsW&I#9xM`) and decrypts cleanly.

### The load-bearing credential
- Duoke's reusable backend credential is a JWT named **`token`**, stored **in plaintext** in Duoke's Chromium `Cookies` SQLite (`encrypted_value` empty — not Keychain/safeStorage) and **mirrored into Local Storage** (httponly=0, secure=0 → page JS reads it and attaches it to backend calls).
- It's an HS256 JWT with **`exp` = 2048-05-07** (~22-year TTL → effectively non-expiring) and `rememberMe:"yes"`. This is what makes a "reuse the token → call Duoke's backend" path viable and durable.
- Tencent IM also needs a `userSig` (HMAC, backend-issued, genuinely rotates) cached in the TIM Local Storage keys — relevant only if we talk to Tencent IM directly instead of Duoke's wrapper.
- Other useful local facts: a **localhost control server** on `:63352` (`/api/appIsOpen`, `/api/appconfig` — *not* chat); the app sets `ignore-certificate-errors`, so a **local MITM proxy needs no cert trust** to observe traffic.

### Extract path (ranked)
1. **Reuse the stored JWT → Duoke's own backend** (REST/WSS on `app.duoke.com` + `*-im.duoke.com`). *Most robust:* token is plaintext/JS-readable/non-expiring, returns complete structured history. **Cost:** the exact list/history endpoints are in the remote bundle → must be captured **once** from a live logged-in session via a local MITM proxy.
2. **Tencent IM SDK directly** against `*-im.duoke.com` — most faithful real-time push, but you must refresh `userSig` and replicate the `TIMCustomElem` schema. More moving parts.
3. **Local store as a "new-message" signal** — poll `conversationMap`/IndexedDB (latest-only) while Duoke runs, then fetch bodies via #1. Brittle alone; good as a low-latency trigger.
4. UI automation — last resort.

### Send path (ranked)
1. **Reuse the JWT → Duoke's send endpoint** (Duoke's server builds the `TIMCustomElem` + marketplace delivery, so we don't reverse the custom payload). Capture the endpoint+body once via MITM. **Highest ToS exposure** (it writes to buyers) → strictest pacing + human approval.
2. **Tencent IM `sendMessage`** — resilient to Duoke UI changes but must reproduce the exact custom payload + refresh `userSig`.
3. UI automation of the compose box — most "human", but brittle/needs Duoke focused. Reasonable fallback.

> **Decision (Duoke adapter strategy):** **Hybrid.** Use the local store/IndexedDB as a *new-message signal*, fetch full bodies and **send via Duoke's own backend reusing the stored JWT** (read live from Duoke's profile at runtime — never copied into our repo). The one prerequisite is a **one-time endpoint capture** via a local MITM proxy with Duoke running and logged in — **this is a Phase 2 step I will not do without your go-ahead** (it observes your live marketplace session). Token + domains are stable; pin captured endpoints and re-verify after Duoke updates.

### Risks
- **ToS/ban:** automating replies through Duoke risks (a) Duoke account suspension and (b) downstream marketplace action against the shop. Read/extract is materially lower risk than send. Expect server-side rate limits on send.
- **Fragility:** the renderer is a *remote* bundle that can change with no installer update; captured endpoints must be re-verified after Duoke updates.
- **Token invalidation:** the JWT is durable but Duoke can server-side kill it (logout / password change / device cap). `userSig` genuinely rotates.
- **Region split:** this MYR/Malaysia account routes via `app.duoke.com` + `im.duoke.com`; confirm per-account before hardcoding gateways.

---

## 3. Webstore live chat (product currently UNKNOWN — blocks this adapter)

The right design depends entirely on which chat product the webstore runs. Verified 2026 capabilities:

| Tier | Products | Capture | Send back |
|---|---|---|---|
| **1 — two-way (happy path)** | **custom/Laravel** (we own the contract), **Crisp**, **Intercom**, **FB Messenger** | provider webhook (HMAC) or RTM socket | REST `POST …/reply` |
| **2 — read-only / poll** | **Tidio** | poll `GET …/messages?since=` | ⚠ no live-chat send API (only its ticket channel) |
| **3 — receive-only** | **Tawk.to** | webhook on chat-start + transcript | ⚠ **no server-side send API** → would need DOM-scrape |

- **Best case:** webstore chat is **in-house (Laravel)** → we add an internal HMAC webhook (message-create → ingest), a send endpoint (`POST /api/chat/conversations/{id}/messages`), and a cursor-poll fallback. Mind the shared-hosting "no always-on worker" reality (favor synchronous emit + polling over daemon sockets).
- The `ChannelAdapter` interface (below) hides webhook-vs-poll behind `onMessage`, so swapping Crisp→Tidio→official is a one-class change.

> **OPEN QUESTION (blocks Phase 2c, not Phase 1):** which product powers the webstore chat — and if it's custom/Laravel, can we add an internal webhook + send endpoint + read view? **Do not design an approve-and-send UX around Tawk.to** (it can't send).

---

## 4. Local app stack — why Electron is fastest *here*

The requirements that decide it: reach the local Duoke app + drive a **stateful, must-stay-alive** WhatsApp Web session + a local webstore connector; desktop-grade inbox UI; **persistent background sockets/pollers**; local store; **embed an MCP server in-process**.

- Every load-bearing dependency is **Node** (whatsapp-web.js/Puppeteer, Baileys, `@modelcontextprotocol/sdk`, Ollama/OpenAI clients, the webstore HTTP listener). Electron runs them all in **one long-lived main process** sharing one SQLite store and hosting the MCP server, with the renderer as pure UI.
- **Tauri** (Rust) gives a lighter/faster UI, but for *this* app it forces a **Node sidecar** for the WhatsApp + MCP stack — multi-process glue without escaping Node. The 2026 Tauri RAM/size win is real but secondary when a stateful Chromium WhatsApp session already dominates memory.
- "Responsive" here = real-time message delivery (sockets, not polling where avoidable) + instant UI updates via IPC. Electron delivers both.

**Process/worker model:** main process owns lifecycle/tray/SQLite + `ChannelManager` + MCP server + LLM router; **one `utilityProcess` per WhatsApp number** (crash/ban isolation); webstore capture = its own worker; renderer = React over typed IPC; launch-at-login + tray-resident so sessions/pollers never die on window close.

---

## 5. MCP + LLM wiring

### `LLMProvider` (per-channel, provider kept out of business logic)
```ts
interface LLMProvider {
  readonly id: string;                                   // 'ollama' | 'claude' | 'openai'
  draftReply(req: DraftRequest): Promise<DraftResult>;
  draftReplyStream?(req: DraftRequest): AsyncIterable<string>;
}
// DraftRequest = { thread, history[], systemPrompt, context? }
```
- **OllamaProvider (local):** OpenAI-compatible endpoint `http://localhost:11434/v1` (OpenAI Node SDK with `baseURL`+`apiKey:'ollama'`) or `ollama-js`.
- **Claude / OpenAI (cloud):** official SDKs behind the same `draftReply`. *(Confirm current Claude model IDs/params against the `claude-api` reference at Phase 4, not from memory.)*
- **Per-channel router** maps `channelId → provider`; switching a channel local↔cloud is a config edit:
```jsonc
{ "channels": {
    "whatsapp:num-1": { "llm": "ollama", "model": "llama3.1:8b" },
    "whatsapp:num-2": { "llm": "claude", "model": "<verify-id>" },
    "webstore":       { "llm": "ollama", "model": "qwen2.5:14b" } } }
```

### MCP server over the inbox
- **SDK:** official **`@modelcontextprotocol/sdk`** (Anthropic, MIT, **stable v1.29.x**, Node ≥18). Pin stable v1 — a v2.0-alpha exists with different import paths; do not use alpha in production.
- **Transport:** **stdio** (desktop MCP client spawns the server as a child process); optional Streamable HTTP for network clients.
- **Resources (read):** `inbox://threads`, `inbox://threads/{id}`, `inbox://threads/{id}/messages`, `inbox://customers/{id}`, `inbox://channels` (incl. per-number ban-risk + health).
- **Tools (act):** `list_threads`, `get_history`, `draft_reply` (runs the per-channel provider, **stores a draft, never sends**), `approve_draft`, `send_reply` (**refuses unless draft is approved AND that channel's auto-send is explicitly enabled**). Same maker-checker gate as the UI → an MCP client can draft freely but **cannot blast**, no matter which client connects.

---

## 6. Security notes (observed during recon)
- **Our app:** no secrets in code; Duoke's JWT is read live from Duoke's own profile at runtime (not copied into the repo); LLM/cloud keys via gitignored `.env`/`config.local.json`; a `send_audit` table logs every outbound (who/which channel/when).
- **Duoke (vendor — flagging, not acting on):** a stray build script in the asar ships **live Tencent COS keys + a WeCom webhook key**; the Duoke session JWT is stored **plaintext, non-httponly, non-secure**. These are facts about your vendor's app, not blockers for us — but worth knowing (and arguably worth reporting to Duoke).

---

## 7. Swap-to-official roadmap (detailed in Phase 5)
Because everything is behind `ChannelAdapter` / `LLMProvider`, each workaround is replaced independently with no business-logic change:
- **WhatsApp:** whatsapp-web.js → official **WhatsApp Business / Cloud API** adapter (same `ChannelAdapter`, swap receive=webhook, send=Graph API; warmup/anti-ban code becomes inert).
- **Duoke:** token-reuse → official **Lazada Open Platform / TikTok Shop / Shopee Open API** chat adapters (per-marketplace), or Duoke's official API if they expose one.
- **Webstore:** poll/DOM → provider webhook+REST (or our own Laravel chat API).
- **LLM:** any provider is already a config swap.

---

## 8. Dependencies I'll propose for Phase 1 (will STOP and ask before adding any)
`electron`, `better-sqlite3`, `react`+`react-dom`, a bundler (`vite` + `electron-vite`), `@modelcontextprotocol/sdk`, `zod` (schemas/validation). Phase 2 adds `whatsapp-web.js` (+ `puppeteer`), later `@whiskeysockets/baileys`. Phase 4 adds `openai`/`ollama`/`@anthropic-ai/sdk` as chosen. **None added without your OK.**

---

## 9. Phase 0 checkpoint — what I need from you
**To start Phase 1 (core scaffold + fake adapter) I only need #1.** The rest block Phase 2 and can be answered later.
1. **Approve the recommended architecture** (Electron + React + better-sqlite3 + ChannelAdapter/LLMProvider + in-process MCP). Yes / adjust?
2. **Webstore chat product?** (custom-Laravel / Crisp / Intercom / Tidio / Tawk.to / Messenger / other) — and if custom, can we add a webhook + send endpoint?
3. **WhatsApp numbers:** how many are aged/established vs brand-new? (sets per-number caps + warmup).
4. **Cloud LLM:** which provider/account, and which channels default to local Ollama vs cloud?
5. **MCP scope:** can the human approve *from inside* an MCP client (claude.ai/Cowork), or must approval happen only in the desktop UI?
6. **Duoke MITM endpoint-capture:** OK to do the one-time live-session capture in Phase 2 (observes your real marketplace traffic locally)?
