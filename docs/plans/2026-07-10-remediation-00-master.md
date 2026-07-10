# Unified Inbox Remediation — Master Spec (00)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement round-by-round. Execute plans
> 01 → 04 IN ORDER. After each round: run the full gate, STOP, and report to the owner.

**Goal:** Take the app from "working pipeline" to "team daily driver" by fixing every
finding in [docs/REVIEW-2026-07-10.md](../REVIEW-2026-07-10.md) plus the owner-requested
disconnect-purge, in four independently-shippable rounds.

**Architecture:** No structural changes — the review graded the seams A. Every fix lands
inside the existing layers: `InboxStore` (only DB toucher), `InboxService` (only pipeline),
`ChannelAdapter`/`LLMProvider` implementations, thin typed IPC, renderer. New capabilities
(send queue, settings k/v, notifications) follow the same injection patterns the tests
already rely on.

**Tech stack:** unchanged — Electron 42 + electron-vite 5, React 19, node:sqlite, vitest 3,
whatsapp-web.js, CDP for Duoke, Ollama. No new runtime dependencies in Rounds 1–3.

## Global constraints (apply to every task in every round)

- **TDD, RED→GREEN, no exceptions.** Core logic gets a failing vitest test first. Electron
  main-process wiring that vitest can't reach gets: typecheck + a scripted manual check
  recorded in the task.
- **Gate per task:** `npx vitest run` all-green + `npx tsc --noEmit` introduces **no NEW
  errors** (4 known pre-existing: main/index.ts `win` TS18048, styles.css side-effect
  import, 2 in tests). Commit per task, conventional prefixes.
- **No new dependencies without owner approval** — including npm devDeps (electron-builder,
  eslint), Ollama model pulls (multi-GB downloads), and any cloud API usage. These are
  marked ⛔ DECISION GATE below.
- **Human-in-the-loop is untouchable:** `approveAndSend` stays the only send path;
  auto-send stays OFF; the MCP server stays read+draft only (and becomes read-only at the
  DB layer in Round 1). **First real WhatsApp send test remains a hard stop** — nothing in
  these rounds performs it.
- **No secrets in code.** Keys only via `.env` / gitignored config.
- **`send_audit` is immutable and load-bearing** (feeds the anti-ban cap). No task may
  delete or rewrite audit rows. (Disconnect-purge explicitly keeps them.)
- **Plan freshness rule:** plans 02–04 lock scope/interfaces/acceptance now; at round
  start, expand the round's plan to full bite-sized steps against the then-current code
  (line numbers and surrounding code WILL have moved). Do not execute a stale plan blind.

## Round index → review findings

| Plan | Round | Review items | Ships |
|---|---|---|---|
| [01](2026-07-10-remediation-01-round1-data-safety.md) | Data safety & awareness | #1 #2 #3 #6 #7 #9 #17 #18 #25 #28(win-guard) + disconnect-purge | No dropped messages, notifications, clean quit, persistent kill switch, purge-on-unlink |
| [02](2026-07-10-remediation-02-round2-triage-loop.md) | Triage loop | #4 #8 #11 #12 #13 #14 #15 #16 #22 #23 #26 #30 | Read/Done/Needs-reply workflow, durable edits, send queue with pacing UI, reconnects & health banners |
| [03](2026-07-10-remediation-03-round3-config-hardening-quality.md) | Config, hardening, draft quality | #5 #10 #19 #20 #21 #27 #28(IPC) + burst cap/business hours + model/prompt work | Operator-tunable config, un-hangable Duoke send, gated demo, better drafts |
| [04](2026-07-10-remediation-04-round4-packaging-scale.md) | Packaging & scale | #29 #31 #32 #33 #34 + test-coverage holes | Installable .app, push-driven UI, migrations, keyboard, renderer/manager/MCP tests |

Phase 2c (webstore adapter) is **out of scope** for this set — slot it after Round 2.

## ⛔ Decision gates (owner sign-off required before the task that consumes them)

| # | Decision | Default (used unless owner overrides) | Consumed by |
|---|---|---|---|
| G1 | Disconnect-purge confirm copy | "Unlink this WhatsApp number? This removes it from your phone's Linked Devices and **deletes all its conversations from this inbox**. Chats still on the phone re-import if you re-link." | 01·T10 |
| G2 | Notification scope | All channels, inbound only, message ≤10 min old (suppresses backfill storms); dock badge = total unread | 01·T3 |
| G3 | Hourly burst cap | 20 sends/number/rolling hour (same audit-count mechanism as daily) | 03·T3 |
| G4 | Business-hours send window | 09:00–22:00 Asia/Kuala_Lumpur, config-overridable, kill-switch-style reason when outside | 03·T3 |
| G5 | Local model upgrade | Pull `qwen2.5:7b` (~4.7 GB download) and A/B against gemma3:4b on 5 real threads | 03·T7 |
| G6 | Cloud drafts (ClaudeProvider) | OPTIONAL — only with owner-supplied `ANTHROPIC_API_KEY` in `.env`; owner pastes key themselves | 03·T7b |
| G7 | electron-builder devDependency | Required for Round 4 packaging | 04·T3 |
| G8 | Default thread filter | "Needs reply" as the default list view | 02·T3 |

## Execution protocol

1. Expand the round plan (02+) to bite-sized steps if not already (per freshness rule).
2. Execute task-by-task: failing test → verify RED → minimal code → verify GREEN → commit.
3. End of round: full `npx vitest run` + `npx tsc --noEmit` + the round's manual
   verification checklist (each plan's tail) + **update README status table**.
4. STOP. Report to owner: what shipped, gate output, anything deferred. Wait for OK.
5. Commits stay local (`main`, no remote) unless the owner says push.
