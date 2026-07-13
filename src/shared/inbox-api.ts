import type { ChannelSummary, Draft, Message, ThreadView, TriageCounts } from '../core/types';
import type { WaGuardStatus } from '../core/channels/whatsapp/WhatsAppGuard';
import type { SendEvent } from '../main/SendQueue';
import type { ChannelHealthRow } from '../core/InboxService';
import type { NormalizedDuokeOrder } from '../core/channels/duoke/normalize';

export type { SendEvent } from '../main/SendQueue';
export type { ChannelHealthRow } from '../core/InboxService';
export type { NormalizedDuokeOrder } from '../core/channels/duoke/normalize';

export type { ChannelSummary, TriageCounts } from '../core/types';

export interface HealthStatus {
  channels: ChannelHealthRow[];
  draft: { ok: boolean; error?: string };
}

export interface UiPrefs {
  railCollapsed: boolean;
  contextOpen: boolean;
  autoDraft: boolean;
  autoAdvance: boolean;
}

export interface ProviderInfo {
  id: string;
  label: string;
  /** Whether the provider is usable now (cloud: API key present; local: always). */
  configured: boolean;
  active: boolean;
}

export type { WaGuardStatus, WaNumberSendStatus } from '../core/channels/whatsapp/WhatsAppGuard';

export type WaState = 'idle' | 'connecting' | 'qr' | 'ready' | 'disconnected' | 'error';

export interface WaNumberState {
  id: string;
  label: string;
  state: WaState;
  qrDataUrl?: string; // data: URL of the link QR while state === 'qr'
  detail?: string;
  threads?: number;
}

/**
 * The IPC contract between the Electron main process (which owns the core) and
 * the renderer (the inbox UI). Exposed on `window.inbox` by the preload.
 * Keeping it here means preload, renderer, and main all share one typed shape.
 */
export interface InboxApi {
  listThreads(): Promise<ThreadView[]>;
  /** Search by customer name / phone / id / message body. Empty query → []. */
  searchThreads(q: string): Promise<ThreadView[]>;
  /** One row per connected channel + live counts, for the nav rail. */
  listChannels(): Promise<ChannelSummary[]>;
  /** Triage counts (needs / assigned-to-me / all / done) for the rail. */
  triageCounts(): Promise<TriageCounts>;
  /** Other threads for the same person on other channels. */
  relatedThreads(threadId: string): Promise<ThreadView[]>;
  /** Route a thread to a staff member (null unassigns). */
  assignThread(threadId: string, assignee: string | null): Promise<void>;
  /** Save the team-shared note on the customer behind a thread ('' clears it). */
  setThreadNote(threadId: string, note: string): Promise<void>;
  /** Canned reply snippets, and save them. */
  getQuickReplies(): Promise<string[]>;
  setQuickReplies(replies: string[]): Promise<string[]>;
  /** Assignable staff + who "me" is on this machine. */
  listStaff(): Promise<{ staff: string[]; me: string }>;
  setStaff(staff: string[], me: string): Promise<{ staff: string[]; me: string }>;
  /** Persisted UI prefs (rail/context layout + AI/queue behaviour). */
  getUiPrefs(): Promise<UiPrefs>;
  setUiPrefs(patch: Partial<UiPrefs>): Promise<UiPrefs>;
  getHistory(threadId: string): Promise<Message[]>;
  /** Live channel + drafting health, for status banners. */
  health(): Promise<HealthStatus>;
  /** Orders + products for a marketplace (Duoke) thread — for the detail-panel order card. */
  threadOrders(threadId: string): Promise<NormalizedDuokeOrder[]>;
  /** The AI models available in the picker (Local / Claude / ChatGPT / Gemini). */
  listProviders(): Promise<ProviderInfo[]>;
  /** Choose which AI drafts replies (persists across restarts). Returns the fresh list. */
  setProvider(id: string): Promise<ProviderInfo[]>;
  /** Save a cloud provider's API key (stored locally; takes effect immediately). Returns the fresh list. */
  setProviderKey(id: string, key: string): Promise<ProviderInfo[]>;
  /** The global system prompt + any per-provider overrides. */
  getPrompts(): Promise<{ systemPrompt: string; providerPrompts: Record<string, string> }>;
  /** Save the global prompt + per-provider overrides (takes effect immediately). */
  setPrompts(systemPrompt: string, providerPrompts: Record<string, string>): Promise<void>;
  /** Hub MCP connector config (Claude only). Token is write-only — never returned. */
  getMcp(): Promise<{ url: string; hasToken: boolean }>;
  /** Save the Hub MCP url + token (stored locally; applies immediately to Claude). */
  setMcp(url: string, token: string): Promise<{ url: string; hasToken: boolean }>;
  /** Clear a thread's unread locally (on open). No channel read receipt is sent. */
  markRead(threadId: string): Promise<void>;
  /** Set a thread's workflow status (Done = 'closed', reopen = 'open'). */
  setThreadStatus(threadId: string, status: 'open' | 'snoozed' | 'closed'): Promise<void>;
  /** Mute/unmute a thread ("not a customer") — stops AI drafts + notifications for it. */
  setThreadMuted(threadId: string, muted: boolean): Promise<void>;
  regenerateDraft(threadId: string): Promise<Draft>;
  /** Persist a human-edited draft body (marks it 'edited' so drafting won't overwrite it). */
  updateDraft(draftId: string, body: string): Promise<Draft>;
  /** Enqueue an approved reply; returns immediately with the pacing ETA. Watch onSendUpdate for the result. */
  approveAndSend(threadId: string, body: string): Promise<{ queued: true; etaMs: number }>;
  /** Subscribe to send lifecycle events (queued → pacing → sent | failed). Returns unsubscribe. */
  onSendUpdate(cb: (e: SendEvent) => void): () => void;

  // WhatsApp connect/link
  listWhatsApp(): Promise<WaNumberState[]>;
  connectWhatsApp(id: string): Promise<void>;
  /** Unlink a number (logout + clear session); historical threads are kept. */
  disconnectWhatsApp(id: string): Promise<void>;
  /** Give a WhatsApp number a friendly label (persists; updates its chip everywhere). */
  renameWhatsApp(id: string, label: string): Promise<void>;
  /** Subscribe to WhatsApp connection/QR updates. Returns an unsubscribe fn. */
  onWaUpdate(cb: (states: WaNumberState[]) => void): () => void;

  // WhatsApp anti-ban guard (Phase 5): per-number send caps + global kill switch.
  /** Per-number send counts / ban-risk + the kill-switch state. */
  whatsappGuard(): Promise<WaGuardStatus>;
  /** Engage/release the kill switch that pauses ALL WhatsApp sending. Returns fresh status. */
  setWhatsappKill(on: boolean): Promise<WaGuardStatus>;

  /** Subscribe to main-process "open this thread" pushes (notification clicks). Returns unsubscribe. */
  onSelectThread(cb: (threadId: string) => void): () => void;
}
