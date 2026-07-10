import { describe, it, expect } from 'vitest';
import { InboxStore } from '../src/core/store/InboxStore';
import { InboxService } from '../src/core/InboxService';
import { LlmRouter } from '../src/core/llm/LlmRouter';
import { EchoProvider } from '../src/core/llm/EchoProvider';
import { FakeAdapter } from '../src/core/channels/FakeAdapter';
import { AppConfigSchema } from '../src/core/config/Config';

function makeService() {
  const config = AppConfigSchema.parse({
    defaultProvider: 'echo',
    channels: { 'fake:demo': { llm: 'echo', autoSend: false } },
  });
  const store = new InboxStore(':memory:');
  const router = new LlmRouter(config, { echo: new EchoProvider() });
  const service = new InboxService({ store, router, config });
  const fake = new FakeAdapter({ id: 'fake:demo', label: 'Demo channel' });
  service.registerChannel(fake);
  return { service, fake, store, config };
}

describe('inbox pipeline — fake channel + echo provider', () => {
  it('ingests an inbound message into a thread and auto-drafts a reply, sending nothing', async () => {
    const { service, fake } = makeService();
    await service.start();

    await fake.inject({
      threadKey: 't1',
      from: { externalId: 'cust-1', name: 'Aisha' },
      body: 'Is the red one in stock?',
    });

    const threads = service.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]!.channel.id).toBe('fake:demo');
    expect(threads[0]!.customer.name).toBe('Aisha');

    const draft = service.getDraft(threads[0]!.thread.id);
    expect(draft?.status).toBe('suggested');
    expect(draft?.providerId).toBe('echo');
    expect(draft?.body).toContain('Aisha');

    // human-in-the-loop: a draft exists but NOTHING was sent
    expect(fake.sent).toHaveLength(0);
  });

  it('sends a human-approved (edited) reply, persists it, and writes a non-auto audit row', async () => {
    const { service, fake, store } = makeService();
    await service.start();
    await fake.inject({
      threadKey: 't1',
      from: { externalId: 'cust-1', name: 'Aisha' },
      body: 'Is the red one in stock?',
    });
    const threadId = service.listThreads()[0]!.thread.id;

    const edited = 'Yes! The red one is in stock — want me to reserve it for you?';
    const res = await service.approveAndSend(threadId, { body: edited, approvedBy: 'human:ui' });

    expect(res.sent).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.body).toBe(edited);

    const history = service.getHistory(threadId);
    expect(history.map((m) => m.direction)).toEqual(['inbound', 'outbound']);
    expect(history[1]!.body).toBe(edited);

    const audit = store.listSendAudit(threadId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.approvedBy).toBe('human:ui');
    expect(audit[0]!.auto).toBe(0);

    expect(service.getDraft(threadId)?.status).toBe('sent');
  });

  it('is idempotent: re-delivering the same channel message does not duplicate it', async () => {
    const { service, store } = makeService();
    await service.start();

    // Two deliveries carrying the SAME channelMessageId (e.g. a poll re-reading the same row).
    const inbound = {
      channelId: 'fake:demo',
      from: { externalId: 'cust-1', name: 'Aisha' },
      threadKey: 't1',
      body: 'hello?',
      channelMessageId: 'dup-1',
      timestamp: new Date('2026-06-24T00:00:00Z').toISOString(),
    };
    await service.ingest(inbound);
    await service.ingest(inbound);

    const threadId = service.listThreads()[0]!.thread.id;
    expect(store.getHistory(threadId).filter((m) => m.direction === 'inbound')).toHaveLength(1);
  });

  it('fires onInbound exactly once per NEW inbound message (not on duplicates)', async () => {
    const events: Array<{ threadId: string; customerName: string; body: string }> = [];
    const config = AppConfigSchema.parse({ defaultProvider: 'echo' });
    const store = new InboxStore(':memory:');
    const router = new LlmRouter(config, { echo: new EchoProvider() });
    const service = new InboxService({ store, router, config, onInbound: (e) => events.push(e) });
    const fake = new FakeAdapter({ id: 'fake:demo', label: 'Demo channel' });
    service.registerChannel(fake);
    await service.start();

    const inbound = { channelId: 'fake:demo', from: { externalId: 'c1', name: 'Aisha' }, threadKey: 't1', body: 'hello?', channelMessageId: 'dup-1', timestamp: new Date().toISOString() };
    await service.ingest(inbound);
    await service.ingest(inbound); // duplicate delivery — must not re-fire
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ customerName: 'Aisha', body: 'hello?' });
    expect(store.totalUnread()).toBe(1);
  });

  it('exposes a rolling send count per channel (feeds the WhatsApp anti-ban cap)', async () => {
    const { service, fake } = makeService();
    await service.start();
    await fake.inject({ threadKey: 't1', from: { externalId: 'cust-1', name: 'Aisha' }, body: 'hi' });
    const threadId = service.listThreads()[0]!.thread.id;
    await service.approveAndSend(threadId, { body: 'On its way!', approvedBy: 'human:ui' });

    expect(service.sendCountSince('fake:demo', '1970-01-01T00:00:00.000Z')).toBe(1);
    expect(service.sendCountSince('fake:demo', '2999-01-01T00:00:00.000Z')).toBe(0);
    expect(service.sendCountSince('whatsapp:num-1', '1970-01-01T00:00:00.000Z')).toBe(0);
  });
});
