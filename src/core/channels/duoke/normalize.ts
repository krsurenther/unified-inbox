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

export interface NormalizedDuokeMessage {
  direction: 'inbound' | 'outbound';
  authorRole: AuthorRole;
  body: string;
  channelMessageId: string;
  kind: string;
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

export function normalizeDuokeMessage(raw: DuokeRawMessage): NormalizedDuokeMessage {
  const role = roleOf(raw.fromAccountType);
  const content = parseContent(raw.messageContent);
  return {
    direction: role === 'seller' ? 'outbound' : 'inbound',
    authorRole: role,
    body: bodyOf(raw.messageType, content, raw.cloudCustomData?.text ?? undefined),
    channelMessageId: raw.messageId,
    kind: raw.messageType,
    timestamp: new Date(raw.createdTimestamp).toISOString(),
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
