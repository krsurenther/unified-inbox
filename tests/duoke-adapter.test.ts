import { describe, it, expect } from 'vitest';
import { DuokeClient } from '../src/core/channels/duoke/DuokeClient';
import { createDuokeAdapters, DuokeAdapter } from '../src/core/channels/duoke/DuokeAdapter';

function clientWith(reply: (url: string) => unknown): DuokeClient {
  const fn = (async (url: string | URL) => ({ status: 200, text: async () => JSON.stringify(reply(String(url))) })) as unknown as typeof fetch;
  return new DuokeClient({ token: 't', fetchFn: fn });
}

describe('DuokeAdapter', () => {
  it('creates one adapter per shop with a friendly platform label', async () => {
    const c = clientWith(() => ({ code: 0, data: { shops: [
      { id: 's1', platform: 'tiktok', country: 'MY' },
      { id: 's2', platform: 'shopee', country: 'MY' },
      { id: 's3', platform: 'lazada', country: 'MY' },
    ] } }));
    const adapters = await createDuokeAdapters(c);
    expect(adapters.map((a) => a.channel.label)).toEqual(['TikTok · MY', 'Shopee · MY', 'Lazada · MY']);
    expect(adapters[0]!.channel.id).toBe('duoke:s1');
    expect(adapters[0]!.channel.kind).toBe('duoke');
  });

  it('lists threads and history through the client + normalizer', async () => {
    const c = clientWith((url) => {
      if (url.includes('queryConversationList')) {
        return { code: 0, data: { list: [{ conversationId: 'cv1', buyerId: 'b1', buyerNick: 'Aisha', platform: 'shopee', shopId: 's1', unReadCount: 1, lastMessageTimestamp: 1781777802000, latestMessageContent: '{"text":"hi"}', latestMessageType: 'text' }], hasMore: false } };
      }
      if (url.includes('message/list')) {
        return { code: 0, data: { list: [{ messageId: 'm1', fromAccountType: 1, messageType: 'text', messageContent: '{"text":"Hi, in stock?"}', createdTimestamp: 1000 }] } };
      }
      return { code: 0, data: {} };
    });
    const a = new DuokeAdapter({ client: c, shop: { id: 's1', platform: 'shopee', country: 'MY' } });
    const threads = await a.listThreads();
    expect(threads[0]).toMatchObject({ threadKey: 'cv1', participant: { externalId: 'b1', name: 'Aisha' }, unread: 1 });
    const hist = await a.getHistory('cv1');
    expect(hist[0]).toMatchObject({ direction: 'inbound', body: 'Hi, in stock?', channelMessageId: 'm1' });
  });

  it('refuses to send when no send driver is configured', async () => {
    const a = new DuokeAdapter({ client: clientWith(() => ({ code: 0, data: {} })), shop: { id: 's1', platform: 'shopee' } });
    await expect(a.send({ threadKey: 'cv1', body: 'hi' })).rejects.toThrow(/disabled|remote-debugging/i);
  });
});
