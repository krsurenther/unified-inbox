import { describe, it, expect } from 'vitest';
import { InboxStore } from '../src/core/store/InboxStore';
import { InboxService } from '../src/core/InboxService';
import { LlmRouter } from '../src/core/llm/LlmRouter';
import { EchoProvider } from '../src/core/llm/EchoProvider';
import { AppConfigSchema } from '../src/core/config/Config';
import type { ChannelAdapter } from '../src/core/channels/ChannelAdapter';

// A minimal pull-style adapter (like Duoke): enumerates threads + serves history.
function pullAdapter(): ChannelAdapter {
  return {
    channel: { id: 'duoke:s1', kind: 'duoke', label: 'Shopee · MY' },
    async start() {},
    async stop() {},
    onMessage() {},
    async send() {
      throw new Error('send not enabled');
    },
    async listThreads() {
      return [
        { threadKey: 'c1', participant: { externalId: 'b1', name: 'Aisha' }, unread: 1, lastMessageAt: '2026-06-18T00:02:00.000Z', preview: 'Great, 2 please' },
      ];
    },
    async getHistory(threadKey) {
      if (threadKey !== 'c1') return [];
      return [
        { direction: 'inbound', body: 'Hi, is the red one in stock?', channelMessageId: 'm1', timestamp: '2026-06-18T00:00:00.000Z' },
        { direction: 'outbound', body: 'Yes it is!', channelMessageId: 'm2', timestamp: '2026-06-18T00:01:00.000Z' },
        { direction: 'inbound', body: 'Great, 2 please', channelMessageId: 'm3', timestamp: '2026-06-18T00:02:00.000Z' },
      ];
    },
    async health() {
      return { connected: true };
    },
  };
}

function makeService() {
  const config = AppConfigSchema.parse({ defaultProvider: 'echo' });
  const store = new InboxStore(':memory:');
  const router = new LlmRouter(config, { echo: new EchoProvider() });
  const service = new InboxService({ store, router, config });
  return { service, store };
}

describe('InboxService.syncChannel (pull-style adapter)', () => {
  it('backfills threads + full two-way history and drafts when the last message is inbound', async () => {
    const { service } = makeService();
    service.registerChannel(pullAdapter());

    const res = await service.syncChannel('duoke:s1');
    expect(res.threads).toBe(1);

    const threads = service.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]!.channel.label).toBe('Shopee · MY');
    expect(threads[0]!.customer.name).toBe('Aisha');

    const history = service.getHistory(threads[0]!.thread.id);
    expect(history.map((m) => m.direction)).toEqual(['inbound', 'outbound', 'inbound']);
    expect(history[2]!.body).toBe('Great, 2 please');

    // last message is inbound (buyer) → an AI draft is waiting
    expect(service.getDraft(threads[0]!.thread.id)?.status).toBe('suggested');
  });

  it('is idempotent — re-syncing does not duplicate messages', async () => {
    const { service } = makeService();
    service.registerChannel(pullAdapter());

    await service.syncChannel('duoke:s1');
    await service.syncChannel('duoke:s1');

    const tid = service.listThreads()[0]!.thread.id;
    expect(service.getHistory(tid)).toHaveLength(3);
  });

  it('fires onInbound for each new inbound via syncChannel, but not on re-sync', async () => {
    const events: Array<{ body: string }> = [];
    const config = AppConfigSchema.parse({ defaultProvider: 'echo' });
    const store = new InboxStore(':memory:');
    const router = new LlmRouter(config, { echo: new EchoProvider() });
    const service = new InboxService({ store, router, config, onInbound: (e) => events.push(e) });
    service.registerChannel(pullAdapter());

    await service.syncChannel('duoke:s1');
    // the two inbound messages fire, the outbound does not
    expect(events.map((e) => e.body)).toEqual(['Hi, is the red one in stock?', 'Great, 2 please']);

    await service.syncChannel('duoke:s1'); // re-sync inserts nothing
    expect(events).toHaveLength(2);
  });

  it('sync regenerates a suggested draft on new inbound, but leaves an edited draft alone', async () => {
    let n = 0;
    const config = AppConfigSchema.parse({ defaultProvider: 'count' });
    const store = new InboxStore(':memory:');
    const router = new LlmRouter(config, {
      count: { id: 'count', async draftReply() { return { text: `d${++n}`, providerId: 'count', model: 'm' }; } },
    });
    const service = new InboxService({ store, router, config });
    const hist = [{ direction: 'inbound' as const, body: 'q1', channelMessageId: 'm1', timestamp: '2026-06-18T00:00:00.000Z' }];
    service.registerChannel({
      channel: { id: 'duoke:s1', kind: 'duoke', label: 'S' },
      async start() {}, async stop() {}, onMessage() {}, async send() { throw new Error('no'); },
      async listThreads() { return [{ threadKey: 'c1', participant: { externalId: 'b1', name: 'A' }, lastMessageAt: hist[hist.length - 1]!.timestamp }]; },
      async getHistory() { return hist; },
      async health() { return { connected: true }; },
    });

    await service.syncChannel('duoke:s1');
    const tid = service.listThreads()[0]!.thread.id;
    expect(service.getDraft(tid)!.body).toBe('d1');

    // a new customer message arrives → the suggested draft must refresh (the #15 bug: it stayed d1)
    hist.push({ direction: 'inbound', body: 'q2 any update?', channelMessageId: 'm2', timestamp: '2026-06-18T01:00:00.000Z' });
    await service.syncChannel('duoke:s1');
    expect(service.getDraft(tid)!.body).toBe('d2');

    // once a human edits the draft, later syncs must NOT overwrite it
    service.updateDraft(service.getDraft(tid)!.id, 'my own reply');
    hist.push({ direction: 'inbound', body: 'q3 hello?', channelMessageId: 'm3', timestamp: '2026-06-18T02:00:00.000Z' });
    await service.syncChannel('duoke:s1');
    expect(service.getDraft(tid)!.body).toBe('my own reply');
    expect(service.getDraft(tid)!.status).toBe('edited');
  });

  it('unregisterChannel removes a channel from the live registry (history kept)', async () => {
    const { service } = makeService();
    service.registerChannel(pullAdapter());
    await service.syncChannel('duoke:s1');
    expect(service.isChannelRegistered('duoke:s1')).toBe(true);

    service.unregisterChannel('duoke:s1');
    expect(service.isChannelRegistered('duoke:s1')).toBe(false);
    // stored threads remain visible in the inbox
    expect(service.listThreads()).toHaveLength(1);
  });
});
