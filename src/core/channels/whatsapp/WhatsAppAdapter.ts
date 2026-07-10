import type {
  ChannelAdapter,
  ChannelHealth,
  HistoryMessage,
  InboundMessage,
  MessageMedia,
  OutboundMessage,
  SendResult,
  ThreadDescriptor,
} from '../ChannelAdapter';
import type { ChannelRef } from '../../types';
import type { WaClient, WaMessage } from './wa-types';
import type { SendPolicy } from './SendPolicy';
import { isInboxWaChat, isSystemWaMessage, normalizeWaMessage, stripWaId, waChatToDescriptor } from './normalize';

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
  /** Called when authentication fails (session invalidated) — the number needs relinking. */
  onAuthFailure?: (message: string) => void;
  /** Anti-ban guard (Phase 5): per-number cap, human-like pacing, kill switch. Optional. */
  sendPolicy?: SendPolicy;
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
  private readonly onAuthFailureCb?: (message: string) => void;
  private readonly sendPolicy?: SendPolicy;
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
    this.onAuthFailureCb = opts.onAuthFailure;
    this.sendPolicy = opts.sendPolicy;
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
    this.client.on('auth_failure', (message?: string) => {
      this.ready = false;
      this.onAuthFailureCb?.(String(message ?? 'authentication failed'));
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

  /**
   * Download an attachment and normalize it: image/video/voice become inline data URIs the
   * renderer plays; documents become a named 'file' chip (not inlined, to keep rows small).
   */
  private async mediaOf(msg: WaMessage): Promise<MessageMedia | undefined> {
    if (!msg.hasMedia || !msg.downloadMedia) return undefined;
    try {
      const m = await msg.downloadMedia();
      if (!m?.data || !m.mimetype) return undefined;
      const base = m.mimetype.split(';')[0] ?? m.mimetype;
      if (base.startsWith('image/')) return { kind: 'image', mimetype: m.mimetype, dataUri: `data:${m.mimetype};base64,${m.data}` };
      if (base.startsWith('video/')) return { kind: 'video', mimetype: m.mimetype, dataUri: `data:${m.mimetype};base64,${m.data}` };
      if (base.startsWith('audio/')) return { kind: 'audio', mimetype: m.mimetype, dataUri: `data:${m.mimetype};base64,${m.data}` };
      return { kind: 'file', mimetype: m.mimetype, filename: m.filename }; // documents etc. — name only
    } catch {
      return undefined; // media expired on WhatsApp's servers / download failed — keep the caption
    }
  }

  private async handleIncoming(msg: WaMessage): Promise<void> {
    if (!isInboxWaChat(msg.from)) return; // groups / status / broadcasts / newsletters aren't inbox chats
    if (msg.fromMe) return; // only inbound
    if (isSystemWaMessage(msg.type)) return; // skip encryption/notification noise
    const n = normalizeWaMessage(msg);
    const media = await this.mediaOf(msg);
    if (!n.body && !media) return; // nothing displayable — don't store a blank bubble or draft on it
    try {
      await this.handler?.({
        channelId: this.channel.id,
        from: { externalId: stripWaId(msg.from), phone: stripWaId(msg.from) },
        threadKey: msg.from,
        body: n.body,
        channelMessageId: n.channelMessageId,
        timestamp: n.timestamp,
        media,
        raw: msg,
      });
    } catch (e) {
      // Never let a store/pipeline error become an unhandled rejection that
      // silently drops the customer's message — log loud; backfill re-syncs it.
      console.error(`[wa:${this.number.id}] ingest failed for ${n.channelMessageId}:`, (e as Error).message);
    }
  }

  async listThreads(): Promise<ThreadDescriptor[]> {
    const chats = await this.client.getChats();
    return chats
      .filter((c) => !c.isGroup && isInboxWaChat(c.id._serialized))
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, this.threadLimit)
      .map(waChatToDescriptor);
  }

  async getHistory(threadKey: string): Promise<HistoryMessage[]> {
    const chat = await this.client.getChatById(threadKey);
    const msgs = await chat.fetchMessages({ limit: this.historyLimit });
    const kept = msgs.filter((m) => !isSystemWaMessage(m.type));
    const out = await Promise.all(
      kept.map(async (m) => {
        const n = normalizeWaMessage(m);
        const media = await this.mediaOf(m);
        return { direction: n.direction, body: n.body, channelMessageId: n.channelMessageId, timestamp: n.timestamp, media };
      }),
    );
    return out.filter((m) => m.body !== '' || m.media); // keep image bubbles even with an empty caption
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.ready) {
      throw new Error(`WhatsApp '${this.number.label}' is not connected (scan the QR to link it).`);
    }
    // Anti-ban gate: refuse if the number is capped or the kill switch is on, then
    // pace the send (human-like, randomized delay) before it actually goes out.
    if (this.sendPolicy) {
      const decision = await this.sendPolicy.check();
      if (!decision.allowed) throw new Error(decision.reason ?? 'Sending is paused for this number.');
      await this.sendPolicy.pace(msg.body);
    }
    const sent = await this.client.sendMessage(msg.threadKey, msg.body);
    return { channelMessageId: sent.id._serialized, sentAt: new Date().toISOString() };
  }

  async health(): Promise<ChannelHealth> {
    const status = this.sendPolicy ? await this.sendPolicy.check() : undefined;
    return {
      connected: this.ready,
      banRisk: status?.risk ?? 'low', // reply-only + aged numbers keep this low until the cap nears
      detail: this.ready ? undefined : this.lastQr ? 'awaiting QR scan' : 'connecting',
    };
  }
}
