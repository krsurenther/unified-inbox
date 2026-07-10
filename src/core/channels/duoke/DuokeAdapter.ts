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
import { DuokeClient, type DuokeShop } from './DuokeClient';
import type { NormalizedDuokeOrder } from './normalize';
import type { DuokeSendDriver } from './DuokeSendDriver';

const PLATFORM_LABELS: Record<string, string> = { tiktok: 'TikTok', shopee: 'Shopee', lazada: 'Lazada' };
const platformLabel = (p: string): string => PLATFORM_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DuokeAdapterOptions {
  client: DuokeClient;
  shop: DuokeShop;
  pageSize?: number;
  /** Enables send via CDP UI automation. Absent → send() refuses. */
  sendDriver?: DuokeSendDriver;
}

/**
 * One adapter per Duoke shop (TikTok / Shopee / Lazada). Pull-style: the service
 * enumerates threads via listThreads() and backfills via getHistory() on a poll.
 * Extraction only for now — send() is the gated step.
 */
export class DuokeAdapter implements ChannelAdapter {
  readonly channel: ChannelRef;
  private readonly client: DuokeClient;
  private readonly shop: DuokeShop;
  private readonly pageSize: number;
  private sendDriver?: DuokeSendDriver;

  constructor(opts: DuokeAdapterOptions) {
    this.client = opts.client;
    this.shop = opts.shop;
    this.pageSize = opts.pageSize ?? 20;
    this.sendDriver = opts.sendDriver;
    this.channel = {
      id: `duoke:${this.shop.id}`,
      kind: 'duoke',
      label: `${platformLabel(this.shop.platform)}${this.shop.country ? ` · ${this.shop.country}` : ''}`,
    };
  }

  /** Attach (or replace) the CDP send driver after construction — enables send later. */
  setSendDriver(driver: DuokeSendDriver): void {
    this.sendDriver = driver;
  }

  // Duoke is poll-driven through InboxService.syncChannel — no socket to open.
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(_handler: (m: InboundMessage) => void | Promise<void>): void {}

  async listThreads(): Promise<ThreadDescriptor[]> {
    const { conversations } = await this.client.queryConversations(this.shop.id, { size: this.pageSize });
    return conversations.map((c) => ({
      threadKey: c.conversationId,
      participant: { externalId: c.buyerId, name: c.buyerNick },
      lastMessageAt: c.lastMessageAt,
      unread: c.unread,
      preview: c.preview,
    }));
  }

  async getHistory(threadKey: string): Promise<HistoryMessage[]> {
    const msgs = await this.client.getMessages({
      shopId: this.shop.id,
      conversationId: threadKey,
      platform: this.shop.platform,
    });
    return msgs.map((m) => ({
      direction: m.direction,
      body: m.body,
      authorName: m.authorRole === 'system' ? 'System' : undefined,
      channelMessageId: m.channelMessageId,
      timestamp: m.timestamp,
      media: m.media ? { kind: m.media.kind, mimetype: '', url: m.media.url } : undefined,
    }));
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.sendDriver) {
      throw new Error('Duoke send is disabled (Duoke must run with --remote-debugging-port for send).');
    }

    // Snapshot existing outbound ids so we can spot the newly-sent one.
    const before = new Set(
      (await this.getRawMessages(msg.threadKey)).filter((m) => m.direction === 'outbound').map((m) => m.channelMessageId),
    );

    // The driver refuses unless this exact conversation is open in Duoke.
    await this.sendDriver.send({ conversationId: msg.threadKey, text: msg.body });

    // Confirm via Duoke's own read API that the reply actually appeared.
    for (let i = 0; i < 5; i++) {
      await delay(800);
      const fresh = (await this.getRawMessages(msg.threadKey)).filter(
        (m) => m.direction === 'outbound' && !before.has(m.channelMessageId),
      );
      const match = fresh.find((m) => m.body.trim() === msg.body.trim()) ?? fresh.at(-1);
      if (match) return { channelMessageId: match.channelMessageId, sentAt: new Date().toISOString() };
    }
    throw new Error('Sent to Duoke, but could not confirm the reply appeared — please check Duoke.');
  }

  private getRawMessages(conversationId: string) {
    return this.client.getMessages({ shopId: this.shop.id, conversationId, platform: this.shop.platform });
  }

  /** Orders + products for this conversation's buyer (for the detail-panel order card). */
  getOrders(conversationId: string, buyerId: string): Promise<NormalizedDuokeOrder[]> {
    return this.client.getOrders({ shopId: this.shop.id, buyerId, conversationId, platform: this.shop.platform });
  }

  async health(): Promise<ChannelHealth> {
    const ok = this.client.hasToken();
    return { connected: ok, detail: ok ? undefined : 'Duoke not logged in' };
  }
}

/** Discover the logged-in Duoke shops and build one adapter per shop. */
export async function createDuokeAdapters(
  client: DuokeClient,
  opts: { pageSize?: number; sendDriver?: DuokeSendDriver } = {},
): Promise<DuokeAdapter[]> {
  const shops = await client.listShops();
  return shops.map((shop) => new DuokeAdapter({ client, shop, pageSize: opts.pageSize, sendDriver: opts.sendDriver }));
}
