import { describe, it, expect } from 'vitest';
import { normalizeDuokeMessage, normalizeConversation, normalizeOrder } from '../src/core/channels/duoke/normalize';

describe('normalizeDuokeMessage', () => {
  const base = { messageId: 'm1', createdTimestamp: 1777794100000 };

  it('maps a buyer text message to an inbound message', () => {
    const n = normalizeDuokeMessage({ ...base, fromAccountType: 1, messageType: 'text', messageContent: '{"text":"Is this in stock?"}' });
    expect(n.direction).toBe('inbound');
    expect(n.authorRole).toBe('buyer');
    expect(n.body).toBe('Is this in stock?');
    expect(n.channelMessageId).toBe('m1');
    expect(n.timestamp).toBe(new Date(1777794100000).toISOString());
  });

  it('maps a seller text message to an outbound message (prefers .text over .translateTxt)', () => {
    const n = normalizeDuokeMessage({ ...base, fromAccountType: 2, messageType: 'text', messageContent: '{"translateTxt":"Hi","text":"Hi there!"}' });
    expect(n.direction).toBe('outbound');
    expect(n.authorRole).toBe('seller');
    expect(n.body).toBe('Hi there!');
  });

  it('maps a system notification to an inbound system message', () => {
    const n = normalizeDuokeMessage({ ...base, fromAccountType: 3, messageType: 'notification', messageContent: '{"text":"Conversation assigned to you"}' });
    expect(n.direction).toBe('inbound');
    expect(n.authorRole).toBe('system');
    expect(n.body).toBe('Conversation assigned to you');
  });

  it('summarizes an image message', () => {
    const n = normalizeDuokeMessage({ ...base, fromAccountType: 1, messageType: 'image', messageContent: '{"imageUrl":"https://x/y.jpg"}' });
    expect(n.body).toContain('image');
  });

  it('summarizes an order card with product + price', () => {
    const n = normalizeDuokeMessage({
      ...base,
      fromAccountType: 1,
      messageType: 'order_card',
      messageContent: '{"orderId":"MY123","productName":"Red Tumbler 500ml","price":29.9,"currency":"MYR"}',
    });
    expect(n.body).toContain('Red Tumbler 500ml');
    expect(n.body).toContain('MY123');
  });

  it('falls back to cloudCustomData.text, then a typed placeholder', () => {
    const viaCloud = normalizeDuokeMessage({ ...base, fromAccountType: 1, messageType: 'text', messageContent: '{}', cloudCustomData: { text: 'fallback hi' } });
    expect(viaCloud.body).toBe('fallback hi');
    const placeholder = normalizeDuokeMessage({ ...base, fromAccountType: 1, messageType: 'faq_category_choice', messageContent: '{"unknownData":1}' });
    expect(placeholder.body).toBe('[faq_category_choice]');
  });
});

describe('normalizeConversation', () => {
  it('normalizes a conversation list item into thread + customer fields', () => {
    const n = normalizeConversation({
      conversationId: 'c1',
      buyerId: 'b1',
      buyerNick: 'Aisha',
      platform: 'shopee',
      shopId: 's1',
      unReadCount: 2,
      lastMessageTimestamp: 1781777802000,
      latestMessageContent: '{"text":"hello there"}',
      latestMessageType: 'text',
    });
    expect(n).toMatchObject({ conversationId: 'c1', buyerId: 'b1', buyerNick: 'Aisha', platform: 'shopee', shopId: 's1', unread: 2 });
    expect(n.preview).toBe('hello there');
    expect(n.lastMessageAt).toBe(new Date(1781777802000).toISOString());
  });

  it('leaves lastMessageAt undefined when the source timestamp is missing (no 1970 sink)', () => {
    const n = normalizeConversation({
      conversationId: 'c2',
      buyerId: 'b2',
      platform: 'shopee',
      shopId: 's1',
      unReadCount: 0,
      latestMessageContent: '{"text":"hi"}',
      latestMessageType: 'text',
    });
    expect(n.lastMessageAt).toBeUndefined();
  });
});

describe('normalizeDuokeMessage media', () => {
  const base = { messageId: 'm', fromAccountType: 1, createdTimestamp: 1 };
  it('extracts the image URL for image + sticker messages; text has no media', () => {
    expect(normalizeDuokeMessage({ ...base, messageType: 'image', messageContent: '{"imageUrl":"https://cdn/x.jpg"}' }).media).toEqual({ kind: 'image', url: 'https://cdn/x.jpg' });
    expect(normalizeDuokeMessage({ ...base, messageType: 'sticker', messageContent: '{"imageUrl":"https://cdn/s.png","text":"[thumbsup]"}' }).media).toEqual({ kind: 'image', url: 'https://cdn/s.png' });
    expect(normalizeDuokeMessage({ ...base, messageType: 'text', messageContent: '{"text":"hi"}' }).media).toBeUndefined();
  });
  it('maps video + voice to playable media (inferred fields)', () => {
    expect(normalizeDuokeMessage({ ...base, messageType: 'video', messageContent: '{"videoUrl":"https://cdn/v.mp4","imageUrl":"https://cdn/poster.jpg"}' }).media).toMatchObject({ kind: 'video', url: 'https://cdn/v.mp4', thumbnailUrl: 'https://cdn/poster.jpg' });
    expect(normalizeDuokeMessage({ ...base, messageType: 'voice', messageContent: '{"soundUrl":"https://cdn/a.mp3"}' }).media).toMatchObject({ kind: 'audio', url: 'https://cdn/a.mp3' });
  });
});

describe('normalizeOrder', () => {
  it('normalizes an order + its products from the order/list payload', () => {
    const n = normalizeOrder({
      id: 42,
      orderNumber: '58212324',
      platform: 'tiktok',
      dkOrderStatus: 'Cancelled',
      platformOrderStatus: '140',
      amount: 989.1,
      currency: 'MYR',
      paymentMethod: 'PayLater',
      platformCreateTime: 1781777802000,
      logistics: { logisticsServiceName: 'GDEX', trackingNumber: ['', 'MY37343500185'], shippingStatus: 'To ship' },
      productList: [
        { productName: 'Sharp Aquos GH3000X', productImage: 'https://cdn/x.jpg', productUrl: 'https://p/x', productSku: '2TC43GH3000X', variation: '43 INCH', quantity: 1, originalPrice: 1099, price: 989.1, currency: null },
      ],
    });
    expect(n).toMatchObject({
      orderId: '58212324',
      status: 'Cancelled',
      statusCode: '140',
      total: 989.1,
      currency: 'MYR',
      paymentMethod: 'PayLater',
      trackingNumber: 'MY37343500185', // first non-empty
      logisticsService: 'GDEX',
      logisticsStatus: 'To ship',
    });
    expect(n.placedAt).toBe(new Date(1781777802000).toISOString());
    expect(n.items[0]).toEqual({
      name: 'Sharp Aquos GH3000X',
      imageUrl: 'https://cdn/x.jpg',
      productUrl: 'https://p/x',
      sku: '2TC43GH3000X',
      variation: '43 INCH',
      quantity: 1,
      price: 989.1,
      originalPrice: 1099,
      currency: 'MYR', // product currency null → falls back to order currency
    });
  });
});
