import type { ChannelRef, MessageDirection } from '../types';

/** An inline image attachment, normalized to a data URI the renderer can show directly. */
export interface MessageMedia {
  mimetype: string;
  dataUri: string; // data:<mimetype>;base64,<...>
}

/**
 * A normalized inbound message handed to the app by an adapter. The adapter is
 * responsible for translating the channel's native payload into this shape.
 */
export interface InboundMessage {
  channelId: string;
  from: { externalId: string; name?: string; phone?: string };
  threadKey: string; // adapter-stable conversation key within the channel
  body: string;
  channelMessageId?: string;
  timestamp: string; // ISO-8601 UTC
  media?: MessageMedia; // inline image, if any
  raw?: unknown; // original payload, kept for debugging / future fields
}

export interface OutboundMessage {
  threadKey: string;
  body: string;
}

export interface SendResult {
  channelMessageId?: string;
  sentAt: string;
}

/** One normalized message as returned by getHistory (either direction). */
export interface HistoryMessage {
  direction: MessageDirection;
  body: string;
  authorName?: string;
  channelMessageId?: string;
  timestamp: string;
  media?: MessageMedia; // inline image, if any
}

export interface HistoryQuery {
  before?: string; // ISO timestamp; page backwards
  limit?: number;
}

/**
 * A conversation the adapter knows about, for channels that hold their own
 * thread history (Duoke, WhatsApp). The service enumerates these and backfills
 * each thread's history via getHistory().
 */
export interface ThreadDescriptor {
  threadKey: string;
  participant: { externalId: string; name?: string; phone?: string };
  lastMessageAt?: string;
  unread?: number;
  preview?: string;
}

export interface ChannelHealth {
  connected: boolean;
  banRisk?: 'low' | 'medium' | 'high'; // meaningful for the WhatsApp workaround
  detail?: string;
}

/**
 * The ONE interface every channel hides behind.
 *
 * A workaround adapter (WhatsApp Web automation, Duoke token-reuse, webstore poll)
 * and a future official-API adapter are fully interchangeable as long as they
 * implement this. Nothing outside `channels/` may import a vendor SDK.
 */
export interface ChannelAdapter {
  readonly channel: ChannelRef;

  /** Begin receiving: open socket / register webhook / start poll loop. */
  start(): Promise<void>;

  /** Stop receiving and release resources. Part of the kill switch. */
  stop(): Promise<void>;

  /** Register the callback invoked for every new inbound message. */
  onMessage(handler: (msg: InboundMessage) => void | Promise<void>): void;

  /**
   * Enumerate the conversations this channel currently holds. Pull-style channels
   * (Duoke, WhatsApp) return their threads here so the service can backfill them;
   * push-only channels may return [].
   */
  listThreads(): Promise<ThreadDescriptor[]>;

  /** Send a human-approved outbound reply. */
  send(msg: OutboundMessage): Promise<SendResult>;

  /** Backfill history for a thread from the channel, newest-last. */
  getHistory(threadKey: string, query?: HistoryQuery): Promise<HistoryMessage[]>;

  /** Connection + (for WhatsApp) ban-risk surface. */
  health(): Promise<ChannelHealth>;
}
