// Domain types shared across the core. Storage-agnostic, Electron-agnostic.

export type ChannelKind = 'whatsapp' | 'duoke' | 'webstore' | 'fake';

/** A concrete channel instance the app talks to. */
export interface ChannelRef {
  id: string; // stable instance id, e.g. 'whatsapp:num-1' | 'duoke' | 'webstore' | 'fake:demo'
  kind: ChannelKind;
  label: string; // human label shown in the UI
}

export interface Customer {
  id: string;
  channelId: string;
  externalId: string; // phone / marketplace buyer id / web visitor id
  name?: string;
  phone?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export type MessageDirection = 'inbound' | 'outbound';

export interface Message {
  id: string;
  threadId: string;
  direction: MessageDirection;
  body: string;
  channelMessageId?: string;
  authorName?: string;
  meta?: Record<string, unknown>;
  createdAt: string; // ISO-8601 UTC
}

export type ThreadStatus = 'open' | 'snoozed' | 'closed';

export interface Thread {
  id: string;
  channelId: string;
  customerId: string;
  threadKey: string;
  subject?: string;
  status: ThreadStatus;
  unread: number;
  lastMessageAt: string;
  createdAt: string;
}

export type DraftStatus = 'suggested' | 'edited' | 'approved' | 'sent' | 'discarded';

export interface Draft {
  id: string;
  threadId: string;
  body: string;
  status: DraftStatus;
  providerId?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

/** A thread joined with its channel + customer + latest draft, for the inbox UI / MCP. */
export interface ThreadView {
  thread: Thread;
  channel: ChannelRef;
  customer: Customer;
  lastMessagePreview?: string;
  draft?: Draft;
}
