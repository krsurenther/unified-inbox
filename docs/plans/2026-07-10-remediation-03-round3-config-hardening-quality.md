# Round 3 — Config, Hardening & Draft Quality Implementation Plan

> **For agentic workers:** superpowers:subagent-driven-development or
> superpowers:executing-plans. **Freshness rule (master) applies** — expand to bite-sized
> steps against the post-Round-2 code before executing. Scope/interfaces/tests/acceptance
> below are LOCKED.

**Goal:** The operator can tune the app without editing source; the Duoke send path cannot
hang or mis-target; demo scaffolding is gated out of production; drafts become genuinely
useful on Malay/Manglish retail threads.

**Architecture:** wire the already-built `loadConfig()` into both entry points; harden
`DuokeSendDriver` at the CDP boundary; extend `SendPolicy` with two more windows; make
draft quality a config + model problem, not a code problem.

## Global Constraints
Master's constraints apply. Decision gates consumed here: ⛔ G3 (hourly cap, default
20/h), ⛔ G4 (business hours, default 09:00–22:00 Asia/Kuala_Lumpur), ⛔ G5 (qwen2.5:7b
pull ~4.7 GB), ⛔ G6 (ClaudeProvider — only with owner-supplied key).

---

### Task 1: Wire `loadConfig()` — config file rules the app (review #5)
**Files:** `main/index.ts` (bootCore), `mcp/server.ts`, `core/config/Config.ts`
(systemPrompt default gains the example file's "reply in the customer's language" +
"never invent prices/stock — say you'll check" lines so zod default ≡ documented default;
`loadConfig` drops `config.example.json` from the runtime fallback chain), `README.md`
(setup section), `.env.example` (correct the `UNIFIED_INBOX_DB` claim).
**Interfaces:** `loadConfig({ path })` unchanged; main resolves
`join(app.getPath('userData'), 'config.json')` → `UNIFIED_INBOX_CONFIG` env → repo
`config.local.json` (dev convenience) → zod defaults. The three WhatsApp numbers +
`dailyCap` move INTO the default config value so existing behavior is preserved on first
run; a template `config.json` is written to userData if absent (commented example values).
**Tests:** config: precedence order (env beats userData path beats defaults — use temp
files); systemPrompt default contains the language line; `config.example.json` no longer
consulted at runtime.
**Acceptance:** edit userData `config.json` → change a WhatsApp label + `dailyCap` →
relaunch → panel shows both; MCP server honors the same file.

### Task 2: Demo gating (review #21)
**Files:** `main/index.ts` (FakeAdapter registration + `DEMO_INBOUND` seed + `SIM_POOL`
behind `process.env.UNIFIED_INBOX_DEMO === '1'`; new `app:info` IPC `{demo: boolean}`;
when demo is OFF at boot, `store.purgeChannelData('fake:demo')` clears old demo rows),
`shared/inbox-api.ts` + `preload` (+`appInfo()`), `App.tsx` (Simulate button rendered only
when `appInfo.demo`).
**Tests:** pipeline: purge of `fake:demo` leaves real channels intact (reuses Round 1 purge
tests' shape); renderer logic untested here (Round 4 jsdom covers the button's absence).
**Acceptance:** normal launch: no Demo threads anywhere (including MCP `list_threads`), no
Simulate button, tab counts add up; `UNIFIED_INBOX_DEMO=1 npm run dev` restores the old
behavior for pipeline demos.

### Task 3: SendPolicy — hourly burst window + business hours (⛔ G3, ⛔ G4)
**Files:** `SendPolicy.ts` (+opts `hourlyCap?: number` default 20,
`countRecentSendsHour?: () => number|Promise<number>`, `withinHours?: () => boolean`;
`check()` deny-order: kill → outside-hours → daily cap → hourly cap, each with a distinct
reason string), `WhatsAppGuard` (wire hour-window counter via the same
`countSendsSince(channelId, nowMinus1h)` mechanism + hours from config), `Config.ts`
(`whatsapp.hours: { start: '09:00', end: '22:00', tz: 'Asia/Kuala_Lumpur' }` — zod
defaults), panel UI shows the active reason when blocked (already renders `reason`).
**Interfaces:** `SendPolicyStatus` gains `hourly: { sent: number; cap: number }` and
`outsideHours: boolean`.
**Tests:** policy: hourly cap blocks at 20 while daily has headroom; outside-hours blocks
with /hours/i reason; kill still wins; guard status aggregates the new fields. Clock is
already injectable — inject `withinHours`.
**Acceptance:** guard panel shows `x/20 this hour`; at 22:05 MYT a send is refused with a
clear "outside business hours" reason (manual: temporarily set hours to test).

### Task 4: Duoke send driver — unhangable and atomic (review #10, #20)
**Files:** `DuokeSendDriver.ts`: (a) `cmd()` gains a 10s deadline (reject `Duoke CDP
timeout: <method>`) and `connect()` registers ws `close`/`error` handlers that reject ALL
pending commands + null the socket; (b) `send()` collapses verify-conversation +
set-compose-text + press-Enter into ONE `Runtime.evaluate` IIFE that re-reads
`state.Chat.conversationId` inside the page, throws `{code:'CONV_MISMATCH'}` on mismatch,
sets the textarea via the native setter, dispatches Enter, and returns
`{ok: true}` — a single page-JS turn cannot interleave with a user click; (c) the Enter
dispatch result is checked (throw on false).
**Interfaces:** `send()` signature unchanged; failure modes become typed error messages.
**Tests:** driver tests already mock the ws — add: pending cmd rejects on ws close; cmd
times out at deadline; send() composes the single-evaluate expression (assert the
expression string contains one evaluate call and the conversationId literal).
**Acceptance:** quitting Duoke mid-send fails the send within 10s with a clear error (and
Round 2's queue surfaces it inline); the wrong-customer class of bug is structurally closed.

### Task 5: Duoke token refresh + health detail (review #11 remainder)
**Files:** `DuokeClient.ts` (on auth-shaped API failure — 401/419/token-invalid body —
call the existing `refreshToken()` once and retry the request; expose
`tokenExpiresAt(): string | undefined`), `DuokeAdapter.health()` (report
`connected: tokenValid`, `detail: 'token expires <date>' | 'session expired — log into
Duoke'`), which Round 2's `channels:health` banner already renders.
**Tests:** client: auth failure triggers exactly one refresh+retry, second failure
propagates; adapter health reflects expiry.
**Acceptance:** with a deliberately-corrupted token file, the Marketplace banner appears
within one poll; after logging into Duoke again, reads self-heal on the next tick.

### Task 6: Input hygiene sweep (review #19, #27, #28-IPC)
**Files:** `InboxStore.recordMessage`/`recordInbound` (when `channelMessageId` absent,
synthesize `fb:<sha1(direction|body|createdAt)>` so the dedupe index always engages),
`LlmRouter.providerFor` (`console.warn` once per unknown provider id before falling back),
draft placeholder marker (`saveDraft` callers pass `model: 'placeholder'` for echo;
`App.tsx` regenerate-on-open keys off `draft.model === 'placeholder'` instead of
`providerId === 'echo'` — kills the regenerate-forever loop under echo default),
`main/index.ts` IPC handlers (every string arg: `typeof === 'string'` + length caps —
threadId ≤ 64, body ≤ 4096 — throw on violation).
**Tests:** store: two id-less identical messages insert once, different bodies insert
twice; router: unknown id warns + falls back; pipeline: echo drafts carry the placeholder
marker.
**Acceptance:** re-syncing a channel with id-less messages never duplicates; a config typo
logs a visible warning at boot.

### Task 7: Draft quality — prompt facts + model A/B (⛔ G5), optional cloud (⛔ G6)
**Files:** `Config.ts` (`business: { name?: string; facts: string[] }` zod-defaulted
empty), `OllamaProvider.buildSystemPrompt` (inject facts as a bulleted block when
present), `docs/draft-quality.md` (the A/B protocol + results table).
**A/B protocol (G5):** owner approves the ~4.7 GB pull → `ollama pull qwen2.5:7b` →
for 5 real threads (mix BM/English/Manglish) generate drafts under gemma3:4b and
qwen2.5:7b with identical prompts → owner picks per-thread winners in the doc's table →
winner becomes `OLLAMA_MODEL` default in `.env.example` + README.
**Optional (G6) Task 7b — ClaudeProvider:** new `src/core/llm/ClaudeProvider.ts`
(~40 lines: POST `https://api.anthropic.com/v1/messages`, model `claude-haiku-4-5`,
`max_tokens: 400`, system = built prompt, messages = mapped history, key from
`process.env.ANTHROPIC_API_KEY` — NEVER config/code; constructor throws without key),
registered in both routers as `claude`; per-channel opt-in via config `llm: 'claude'`.
Tests: provider maps history/roles correctly against a stubbed fetch; missing key throws;
router selects it per channel. **Owner pastes the key into `.env` themselves.**
**Tests:** prompt builder includes facts block when configured; A/B doc exists with
results before the default flips.
**Acceptance:** with `business.facts` set (e.g. "COD available in Klang Valley",
"Warranty: 2 years TCL panels"), drafts stop hedging on those topics; the chosen model's
draft for the review's "Okay" thread is a usable reply.

---

## Round 3 exit checklist
1. Full gate green; no new tsc errors; `npm run build:mcp` rebuilt.
2. Manual: config edit round-trip; demo absent; hourly/business-hours reasons render;
   Duoke-quit-mid-send fails fast + inline error; token-expiry banner; A/B doc filled and
   default model decided with owner.
3. README status table updated; STOP and report.
