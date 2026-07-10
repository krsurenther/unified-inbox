// Translate Duoke's Tencent-IM-derived payloads into our normalized shapes.
// `messageContent` is a JSON string; `fromAccountType` is 1=buyer, 2=seller, 3=system.

export interface DuokeRawMessage {
  messageId: string;
  fromAccountType: number;
  messageType: string;
  dkMessageType?: string;
  messageContent?: string;
  cloudCustomData?: { text?: string } | null;
  createdTimestamp: number; // epoch ms
}

export type AuthorRole = 'buyer' | 'seller' | 'system';

export interface DuokeMedia {
  kind: 'image' | 'video' | 'audio';
  url: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

export interface NormalizedDuokeMessage {
  direction: 'inbound' | 'outbound';
  authorRole: AuthorRole;
  body: string;
  channelMessageId: string;
  kind: string;
  media?: DuokeMedia;
  timestamp: string; // ISO-8601 UTC
}

export interface DuokeRawConversation {
  conversationId: string;
  buyerId: string;
  buyerNick?: string;
  platform: string;
  shopId: string;
  unReadCount?: number;
  lastMessageTimestamp?: number;
  latestMessageContent?: string;
  latestMessageType?: string;
}

export interface NormalizedDuokeConversation {
  conversationId: string;
  buyerId: string;
  buyerNick?: string;
  platform: string;
  shopId: string;
  unread: number;
  lastMessageAt?: string;
  preview: string;
}

function parseContent(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function roleOf(fromAccountType: number): AuthorRole {
  if (fromAccountType === 2) return 'seller';
  if (fromAccountType === 3) return 'system';
  return 'buyer';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : v != null ? String(v) : undefined;
}

/** Build a human-readable one-liner from a Duoke message's structured content. */
function bodyOf(messageType: string, content: Record<string, unknown>, cloudText?: string): string {
  const text = str(content.text) ?? cloudText;
  switch (messageType) {
    case 'text':
      return text ?? '';
    case 'image':
      return '🖼️ [image]';
    case 'order':
    case 'order_card': {
      const bits = [str(content.productName), price(content)].filter(Boolean);
      const oid = str(content.orderId);
      return `🧾 Order${oid ? ` ${oid}` : ''}${bits.length ? ': ' + bits.join(' · ') : ''}`;
    }
    case 'goods_card':
    case 'item': {
      const bits = [str(content.title), price(content)].filter(Boolean);
      return `🛍️ ${bits.join(' · ') || '[product]'}`;
    }
    case 'logistics_card':
      return `🚚 ${str(content.latestTrackingInfo) ?? 'logistics update'}`;
    case 'notification':
    case 'allocated_service':
      return text ?? '[notification]';
    default:
      return text ?? `[${messageType || 'message'}]`;
  }
}

function price(content: Record<string, unknown>): string | undefined {
  if (content.price == null) return undefined;
  const cur = str(content.currency) ?? '';
  return `${cur} ${content.price}`.trim();
}

/**
 * Extract a playable media URL from a Duoke message. image/sticker → content.imageUrl
 * (confirmed live, public URLs). video/voice field names are inferred from Duoke's own
 * cloudCustomData schema (not seen live in this account) — harmless if absent.
 */
function mediaOf(messageType: string, content: Record<string, unknown>): DuokeMedia | undefined {
  switch (messageType) {
    case 'image':
    case 'sticker': {
      const url = str(content.imageUrl);
      return url ? { kind: 'image', url } : undefined;
    }
    case 'video': {
      const url = str(content.videoUrl);
      if (!url) return undefined;
      return {
        kind: 'video',
        url,
        thumbnailUrl: str(content.imageUrl),
        durationSeconds: content.durationSeconds != null ? Number(content.durationSeconds) : undefined,
      };
    }
    case 'voice':
    case 'sound':
    case 'audio': {
      const url = str(content.soundUrl) ?? str(content.voiceUrl) ?? str(content.url);
      if (!url) return undefined;
      return { kind: 'audio', url, durationSeconds: content.durationSeconds != null ? Number(content.durationSeconds) : undefined };
    }
    default:
      return undefined;
  }
}

export function normalizeDuokeMessage(raw: DuokeRawMessage): NormalizedDuokeMessage {
  const role = roleOf(raw.fromAccountType);
  const content = parseContent(raw.messageContent);
  return {
    direction: role === 'seller' ? 'outbound' : 'inbound',
    authorRole: role,
    body: bodyOf(raw.messageType, content, raw.cloudCustomData?.text ?? undefined),
    channelMessageId: raw.messageId,
    kind: raw.messageType,
    media: mediaOf(raw.messageType, content),
    timestamp: new Date(raw.createdTimestamp).toISOString(),
  };
}

// --- orders / products (from POST /api/v1/dk/unity/order/list) ----------------

export interface DuokeRawOrderProduct {
  productName?: string;
  productImage?: string;
  productUrl?: string;
  productSku?: string;
  variationSku?: string;
  variation?: string;
  quantity?: number;
  price?: number;
  originalPrice?: number;
  currency?: string | null;
}

export interface DuokeRawOrder {
  id?: string | number;
  orderNumber?: string;
  platform?: string;
  dkOrderStatus?: string;
  platformOrderStatus?: string;
  amount?: number;
  currency?: string;
  paymentMethod?: string;
  platformCreateTime?: number;
  logistics?: { logisticsServiceName?: string; trackingNumber?: string[]; shippingStatus?: string };
  productList?: DuokeRawOrderProduct[];
}

export interface NormalizedDuokeOrderItem {
  name: string;
  imageUrl?: string;
  productUrl?: string;
  sku?: string;
  variation?: string;
  quantity: number;
  price: number;
  originalPrice?: number;
  currency: string;
}

export interface NormalizedDuokeOrder {
  orderId: string;
  status?: string;
  statusCode?: string;
  total: number;
  currency: string;
  paymentMethod?: string;
  placedAt?: string; // ISO
  trackingNumber?: string;
  logisticsService?: string;
  logisticsStatus?: string;
  items: NormalizedDuokeOrderItem[];
}

export function normalizeOrder(raw: DuokeRawOrder): NormalizedDuokeOrder {
  const currency = raw.currency ?? 'MYR';
  return {
    orderId: String(raw.orderNumber ?? raw.id ?? ''),
    status: raw.dkOrderStatus,
    statusCode: raw.platformOrderStatus,
    total: Number(raw.amount ?? 0),
    currency,
    paymentMethod: raw.paymentMethod,
    placedAt: raw.platformCreateTime ? new Date(raw.platformCreateTime).toISOString() : undefined,
    trackingNumber: raw.logistics?.trackingNumber?.find((t) => t && t.length > 0),
    logisticsService: raw.logistics?.logisticsServiceName,
    logisticsStatus: raw.logistics?.shippingStatus,
    items: (raw.productList ?? []).map((p) => ({
      name: String(p.productName ?? ''),
      imageUrl: p.productImage ?? undefined,
      productUrl: p.productUrl ?? undefined,
      sku: p.productSku ?? p.variationSku ?? undefined,
      variation: p.variation ?? undefined,
      quantity: Number(p.quantity ?? 1),
      price: Number(p.price ?? 0),
      originalPrice: p.originalPrice != null ? Number(p.originalPrice) : undefined,
      currency: p.currency ?? currency,
    })),
  };
}

export function normalizeConversation(raw: DuokeRawConversation): NormalizedDuokeConversation {
  return {
    conversationId: raw.conversationId,
    buyerId: raw.buyerId,
    buyerNick: raw.buyerNick,
    platform: raw.platform,
    shopId: raw.shopId,
    unread: raw.unReadCount ?? 0,
    // No timestamp → undefined (NOT epoch 0 / 1970, which would sink the thread).
    lastMessageAt: raw.lastMessageTimestamp ? new Date(raw.lastMessageTimestamp).toISOString() : undefined,
    preview: bodyOf(raw.latestMessageType ?? 'text', parseContent(raw.latestMessageContent)),
  };
}
