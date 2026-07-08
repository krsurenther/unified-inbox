import type {
  ChannelAdapter,
  ChannelHealth,
  HistoryMessage,
  InboundMessage,
  OutboundMessage,
  SendResult,
  ThreadDescriptor,
} from './ChannelAdapter';
import type { ChannelRef } from '../types';

/**
 * A synthetic channel with no external dependency.
 *
 * `inject()` simulates a customer message arriving; `send()` records what was
 * "sent" (and reflects it into history). It proves the whole pipeline —
 * receive → store → draft → approve → send — without touching a real network.
 * In Phase 2 it's replaced by WhatsApp/Duoke/webstore adapters implementing the
 * same `ChannelAdapter` interface.
 */
export class FakeAdapter implements ChannelAdapter {
  readonly channel: ChannelRef;
  readonly sent: OutboundMessage[] = [];
  private handler?: (m: InboundMessage) => void | Promise<void>;
  private readonly history = new Map<string, HistoryMessage[]>();
  private readonly participants = new Map<string, { externalId: string; name?: string }>();
  private seq = 0;

  constructor(channel?: Partial<ChannelRef>) {
    this.channel = {
      id: channel?.id ?? 'fake:demo',
      kind: 'fake',
      label: channel?.label ?? 'Demo channel',
    };
  }

  async start(): Promise<void> {
    /* nothing to connect */
  }

  async stop(): Promise<void> {
    this.handler = undefined;
  }

  onMessage(handler: (m: InboundMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  /** Test/demo helper: simulate a customer message arriving on this channel. */
  async inject(opts: {
    threadKey: string;
    from: { externalId: string; name?: string };
    body: string;
    at?: string;
  }): Promise<void> {
    const timestamp = opts.at ?? new Date().toISOString();
    this.participants.set(opts.threadKey, opts.from);
    const channelMessageId = `fake-in-${++this.seq}`;
    const msg: InboundMessage = {
      channelId: this.channel.id,
      from: opts.from,
      threadKey: opts.threadKey,
      body: opts.body,
      channelMessageId,
      timestamp,
    };
    this.push(opts.threadKey, {
      direction: 'inbound',
      body: opts.body,
      authorName: opts.from.name,
      channelMessageId,
      timestamp,
    });
    await this.handler?.(msg);
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const sentAt = new Date().toISOString();
    const channelMessageId = `fake-out-${++this.seq}`;
    this.sent.push(msg);
    this.push(msg.threadKey, {
      direction: 'outbound',
      body: msg.body,
      channelMessageId,
      timestamp: sentAt,
    });
    return { channelMessageId, sentAt };
  }

  async getHistory(threadKey: string): Promise<HistoryMessage[]> {
    return this.history.get(threadKey) ?? [];
  }

  async listThreads(): Promise<ThreadDescriptor[]> {
    return [...this.participants.entries()].map(([threadKey, from]) => {
      const msgs = this.history.get(threadKey) ?? [];
      const last = msgs[msgs.length - 1];
      return {
        threadKey,
        participant: from,
        lastMessageAt: last?.timestamp,
        preview: last?.body,
      };
    });
  }

  async health(): Promise<ChannelHealth> {
    return { connected: true, banRisk: 'low', detail: 'fake adapter — no real channel' };
  }

  private push(threadKey: string, m: HistoryMessage): void {
    const list = this.history.get(threadKey) ?? [];
    list.push(m);
    this.history.set(threadKey, list);
  }
}
