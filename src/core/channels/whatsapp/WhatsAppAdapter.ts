import type {
  ChannelAdapter,
  ChannelHealth,
  HistoryMessage,
  InboundMessage,
  OutboundMessage,
  SendResult,
  ThreadDescriptor,
} from '../ChannelAdapter';
import type { ChannelRef } from '../../types';
import type { WaClient, WaMessage } from './wa-types';
import { isSystemWaMessage, normalizeWaMessage, stripWaId, waChatToDescriptor } from './normalize';

export interface WhatsAppNumber {
  id: string; // 'num-1'
  label: string; // 'WhatsApp · Sales'
  phone?: string;
}

export interface WhatsAppAdapterOptions {
  client: WaClient;
  number: WhatsAppNumber;
  historyLimit?: number;
  /** Max chats to surface (most-recent first). WhatsApp accounts can have 100s. */
  threadLimit?: number;
  /** Called with the QR string when the number needs (re)linking — render it for the user to scan. */
  onQr?: (qr: string) => void;
  /** Called once the number is linked and the client is ready. */
  onReady?: () => void;
  /** Called when the linked session drops. */
  onDisconnected?: (reason: string) => void;
}

/**
 * One adapter per WhatsApp number, wrapping a whatsapp-web.js Client (injected so
 * the adapter is unit-tested without a browser). Reply-only by design; anti-ban
 * pacing/caps/kill-switch land in Phase 5. The first real send is a hard stop
 * handled by the human-approval flow, not here.
 */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel: ChannelRef;
  private readonly client: WaClient;
  private readonly number: WhatsAppNumber;
  private readonly historyLimit: number;
  private readonly threadLimit: number;
  private readonly onQrCb?: (qr: string) => void;
  private readonly onReadyCb?: () => void;
  private readonly onDisconnectedCb?: (reason: string) => void;
  private handler?: (m: InboundMessage) => void | Promise<void>;
  private ready = false;
  private lastQr?: string;

  constructor(opts: WhatsAppAdapterOptions) {
    this.client = opts.client;
    this.number = opts.number;
    this.historyLimit = opts.historyLimit ?? 50;
    this.threadLimit = opts.threadLimit ?? 40;
    this.onQrCb = opts.onQr;
    this.onReadyCb = opts.onReady;
    this.onDisconnectedCb = opts.onDisconnected;
    this.channel = { id: `whatsapp:${opts.number.id}`, kind: 'whatsapp', label: opts.number.label };
  }

  get qr(): string | undefined {
    return this.lastQr;
  }

  get connected(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    this.client.on('qr', (qr) => {
      this.lastQr = qr;
      this.onQrCb?.(qr);
    });
    this.client.on('ready', () => {
      this.ready = true;
      this.lastQr = undefined;
      this.onReadyCb?.();
    });
    this.client.on('disconnected', (reason) => {
      this.ready = false;
      this.onDisconnectedCb?.(reason);
    });
    this.client.on('auth_failure', () => {
      this.ready = false;
    });
    this.client.on('message', (msg) => void this.handleIncoming(msg));
    await this.client.initialize();
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.client.destroy();
  }

  /** Unlink this number from the phone and clear its saved session. */
  async logout(): Promise<void> {
    this.ready = false;
    this.lastQr = undefined;
    await this.client.logout();
  }

  onMessage(handler: (m: InboundMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  private async handleIncoming(msg: WaMessage): Promise<void> {
    if (/@g\.us$/.test(msg.from)) return; // skip group chats — customer inbox is 1:1
    if (msg.fromMe) return; // only inbound
    if (isSystemWaMessage(msg.type)) return; // skip encryption/notification noise
    const n = normalizeWaMessage(msg);
    await this.handler?.({
      channelId: this.channel.id,
      from: { externalId: stripWaId(msg.from), phone: stripWaId(msg.from) },
      threadKey: msg.from,
      body: n.body,
      channelMessageId: n.channelMessageId,
      timestamp: n.timestamp,
      raw: msg,
    });
  }

  async listThreads(): Promise<ThreadDescriptor[]> {
    const chats = await this.client.getChats();
    return chats
      .filter((c) => !c.isGroup && !c.id._serialized.endsWith('@broadcast'))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, this.threadLimit)
      .map(waChatToDescriptor);
  }

  async getHistory(threadKey: string): Promise<HistoryMessage[]> {
    const chat = await this.client.getChatById(threadKey);
    const msgs = await chat.fetchMessages({ limit: this.historyLimit });
    return msgs
      .filter((m) => !isSystemWaMessage(m.type))
      .map((m) => {
        const n = normalizeWaMessage(m);
        return { direction: n.direction, body: n.body, channelMessageId: n.channelMessageId, timestamp: n.timestamp };
      });
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.ready) {
      throw new Error(`WhatsApp '${this.number.label}' is not connected (scan the QR to link it).`);
    }
    const sent = await this.client.sendMessage(msg.threadKey, msg.body);
    return { channelMessageId: sent.id._serialized, sentAt: new Date().toISOString() };
  }

  async health(): Promise<ChannelHealth> {
    return {
      connected: this.ready,
      banRisk: 'low', // reply-only + aged numbers; refined in Phase 5
      detail: this.ready ? undefined : this.lastQr ? 'awaiting QR scan' : 'connecting',
    };
  }
}
