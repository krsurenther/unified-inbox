import { describe, it, expect } from 'vitest';
import { normalizeDuokeMessage, normalizeConversation } from '../src/core/channels/duoke/normalize';

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
});
