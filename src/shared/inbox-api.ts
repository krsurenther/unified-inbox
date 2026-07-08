import type { Draft, Message, ThreadView } from '../core/types';

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
  getHistory(threadId: string): Promise<Message[]>;
  regenerateDraft(threadId: string): Promise<Draft>;
  approveAndSend(threadId: string, body: string): Promise<{ sent: boolean; channelMessageId?: string }>;
  /** Demo-only: inject a synthetic inbound message to show live receive→draft. */
  simulateIncoming(): Promise<void>;

  // WhatsApp connect/link
  listWhatsApp(): Promise<WaNumberState[]>;
  connectWhatsApp(id: string): Promise<void>;
  /** Unlink a number (logout + clear session); historical threads are kept. */
  disconnectWhatsApp(id: string): Promise<void>;
  /** Subscribe to WhatsApp connection/QR updates. Returns an unsubscribe fn. */
  onWaUpdate(cb: (states: WaNumberState[]) => void): () => void;
}
