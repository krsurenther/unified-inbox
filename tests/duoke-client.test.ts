import { describe, it, expect } from 'vitest';
import { DuokeClient } from '../src/core/channels/duoke/DuokeClient';

function mockFetch(reply: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = reply(String(url), init);
    return { status: 200, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('DuokeClient', () => {
  it('lists shops', async () => {
    const { fn } = mockFetch(() => ({ code: 0, data: { shops: [{ id: 's1', platform: 'shopee', country: 'MY', shopName: 'KS' }] } }));
    const shops = await new DuokeClient({ token: 't', fetchFn: fn }).listShops();
    expect(shops).toEqual([{ id: 's1', platform: 'shopee', country: 'MY', shopName: 'KS' }]);
  });

  it('queries + normalizes conversations and posts the right body', async () => {
    const { fn, calls } = mockFetch(() => ({
      code: 0,
      data: {
        list: [{ conversationId: 'c1', buyerId: 'b1', buyerNick: 'Aisha', platform: 'shopee', shopId: 's1', unReadCount: 1, lastMessageTimestamp: 1781777802000, latestMessageContent: '{"text":"hi"}', latestMessageType: 'text' }],
        hasMore: false,
        nextOffset: '0',
      },
    }));
    const r = await new DuokeClient({ token: 't', fetchFn: fn }).queryConversations('s1', { size: 10 });
    expect(r.conversations[0]).toMatchObject({ conversationId: 'c1', buyerNick: 'Aisha', unread: 1, preview: 'hi' });
    expect(r.hasMore).toBe(false);
    expect(calls[0]!.url).toContain('/api/v1/im/conversation/queryConversationList');
    expect(JSON.parse(String(calls[0]!.init!.body)).shopIdList).toEqual(['s1']);
  });

  it('gets orders for a conversation and posts the ids order/list needs', async () => {
    const { fn, calls } = mockFetch(() => ({
      code: 0,
      data: { list: [{ orderNumber: 'O1', dkOrderStatus: 'Shipped', amount: 100, currency: 'MYR', productList: [{ productName: 'TV', productSku: 'SKU1', quantity: 1, price: 100 }] }] },
    }));
    const orders = await new DuokeClient({ token: 't', fetchFn: fn }).getOrders({ shopId: 's1', buyerId: 'b1', conversationId: 'c1', platform: 'shopee' });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ orderId: 'O1', status: 'Shipped', total: 100, currency: 'MYR' });
    expect(orders[0]!.items[0]).toMatchObject({ name: 'TV', sku: 'SKU1', quantity: 1, price: 100 });
    expect(calls[0]!.url).toContain('/api/v1/dk/unity/order/list');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toMatchObject({ shopId: 's1', buyerId: 'b1', conversationId: 'c1', platform: 'shopee' });
  });

  it('gets messages chronological (oldest-first) and sends auth on the request', async () => {
    const { fn, calls } = mockFetch(() => ({
      code: 0,
      data: {
        list: [
          { messageId: 'm2', fromAccountType: 2, messageType: 'text', messageContent: '{"text":"reply"}', createdTimestamp: 2000 },
          { messageId: 'm1', fromAccountType: 1, messageType: 'text', messageContent: '{"text":"hi"}', createdTimestamp: 1000 },
        ],
      },
    }));
    const msgs = await new DuokeClient({ token: 'tok', fetchFn: fn }).getMessages({ shopId: 's1', conversationId: 'c1', platform: 'shopee' });
    expect(msgs.map((m) => m.channelMessageId)).toEqual(['m1', 'm2']);
    expect(msgs[0]!.direction).toBe('inbound');
    expect(msgs[1]!.direction).toBe('outbound');
    expect(calls[0]!.url).toContain('/api/v1/im/message/list?');
    expect(calls[0]!.url).toContain('conversationId=c1');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.token).toBe('tok');
    expect(headers.Cookie).toContain('token=tok');
  });

  it('throws on a non-zero API code', async () => {
    const { fn } = mockFetch(() => ({ code: 401, message: 'unauthorized' }));
    await expect(new DuokeClient({ token: 'bad', fetchFn: fn }).listShops()).rejects.toThrow();
  });
});
