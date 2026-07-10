import { describe, it, expect } from 'vitest';
import { InboxStore } from '../src/core/store/InboxStore';

function seedThread(s: InboxStore, key = 'k1') {
  s.upsertChannel({ id: 'c', kind: 'fake', label: 'C' });
  const cu = s.upsertCustomer('c', 'x', 'X');
  return s.findOrCreateThread('c', cu.id, key);
}

describe('InboxStore.renameChannel', () => {
  it('renames a channel so its thread views show the new label', () => {
    const s = new InboxStore(':memory:');
    s.upsertChannel({ id: 'whatsapp:num-1', kind: 'whatsapp', label: 'WhatsApp · 1' });
    const c = s.upsertCustomer('whatsapp:num-1', '60123', 'A');
    const t = s.findOrCreateThread('whatsapp:num-1', c.id, '60123@c.us');
    s.renameChannel('whatsapp:num-1', 'Sales line');
    expect(s.getThreadView(t.id)!.channel.label).toBe('Sales line');
  });
});

describe('InboxStore thread status', () => {
  it('sets status and rejects invalid values', () => {
    const s = new InboxStore(':memory:');
    const t = seedThread(s);
    expect(s.getThreadView(t.id)!.thread.status).toBe('open');
    s.setThreadStatus(t.id, 'closed');
    expect(s.getThreadView(t.id)!.thread.status).toBe('closed');
    expect(() => s.setThreadStatus(t.id, 'bogus' as never)).toThrow(/status/i);
  });

  it('a new inbound reopens a closed thread', () => {
    const s = new InboxStore(':memory:');
    const t = seedThread(s);
    s.setThreadStatus(t.id, 'closed');
    s.recordInbound({ threadId: t.id, body: 'back again', channelMessageId: 'm2' });
    expect(s.getThreadView(t.id)!.thread.status).toBe('open');
  });

  it('last_message_at tracks the newest STORED message, resisting out-of-order delivery', () => {
    const s = new InboxStore(':memory:');
    const t = seedThread(s);
    s.recordInbound({ threadId: t.id, body: 'new', channelMessageId: 'm1', createdAt: '2027-01-01T00:00:00.000Z' });
    s.recordInbound({ threadId: t.id, body: 'older, arrives late', channelMessageId: 'm2', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(s.getThreadView(t.id)!.thread.lastMessageAt).toBe('2027-01-01T00:00:00.000Z'); // MAX keeps the newest
  });

  it('a channel unread update never bumps last_message_at past the newest stored message', () => {
    const s = new InboxStore(':memory:');
    const t = seedThread(s);
    s.recordInbound({ threadId: t.id, body: 'last visible', channelMessageId: 'm1', createdAt: '2026-06-09T00:00:00.000Z' });
    s.setThreadSummary(t.id, { unread: 3 }); // channel says "recent activity" — must NOT move the row time
    const v = s.getThreadView(t.id)!;
    expect(v.thread.lastMessageAt).toBe('2026-06-09T00:00:00.000Z'); // stays on the last shown bubble
    expect(v.thread.unread).toBe(3);
  });

  it('a freshly-synced thread adopts its first message time even when it is in the past (no now() seed)', () => {
    const s = new InboxStore(':memory:');
    const t = seedThread(s); // created "now"
    s.recordInbound({ threadId: t.id, body: 'old backfill', channelMessageId: 'm1', createdAt: '2026-06-17T03:58:52.000Z' });
    // Regression: last_message_at was seeded to now() and MAX() refused to move it back, so an
    // old thread showed "2h ago". It must reflect the real (older) message time.
    expect(s.getThreadView(t.id)!.thread.lastMessageAt).toBe('2026-06-17T03:58:52.000Z');
  });

  it('repairThreadLastMessageAt recomputes last_message_at to the newest stored message (EPOCH if none)', () => {
    const s = new InboxStore(':memory:');
    const withMsgs = seedThread(s, 'k1');
    s.recordInbound({ threadId: withMsgs.id, body: 'a', channelMessageId: 'm1', createdAt: '2026-06-01T00:00:00.000Z' });
    s.recordInbound({ threadId: withMsgs.id, body: 'b', channelMessageId: 'm2', createdAt: '2026-06-05T00:00:00.000Z' });
    const empty = seedThread(s, 'k2'); // no messages
    s.repairThreadLastMessageAt();
    expect(s.getThreadView(withMsgs.id)!.thread.lastMessageAt).toBe('2026-06-05T00:00:00.000Z'); // newest stored
    expect(s.getThreadView(empty.id)!.thread.lastMessageAt < '2000-01-01').toBe(true); // EPOCH sentinel → blank in UI
  });

  it('a sync-path recordMessage bumps last_message_at (regression: Duoke replies were invisible)', () => {
    const s = new InboxStore(':memory:');
    const t = seedThread(s);
    // Pull-sync backfill: both directions go through recordMessage, not recordInbound/Outbound.
    s.recordMessage({ threadId: t.id, direction: 'inbound', body: 'q', channelMessageId: 'm1', createdAt: '2026-07-10T10:00:00.000Z' });
    s.recordMessage({ threadId: t.id, direction: 'outbound', body: 'sorry no', channelMessageId: 'm2', createdAt: '2026-07-10T16:00:40.000Z' });
    expect(s.getThreadView(t.id)!.thread.lastMessageAt).toBe('2026-07-10T16:00:40.000Z');
    // Idempotent re-sync of an older message must not move it (monotonic), and a dup insert changes nothing.
    s.recordMessage({ threadId: t.id, direction: 'inbound', body: 'q', channelMessageId: 'm1', createdAt: '2026-07-10T10:00:00.000Z' });
    expect(s.getThreadView(t.id)!.thread.lastMessageAt).toBe('2026-07-10T16:00:40.000Z');
  });

  it('exposes the last message direction on the thread view', () => {
    const s = new InboxStore(':memory:');
    const t = seedThread(s);
    s.recordInbound({ threadId: t.id, body: 'hi', channelMessageId: 'm1' });
    expect(s.getThreadView(t.id)!.lastMessageDirection).toBe('inbound');
    s.recordOutbound({ threadId: t.id, body: 'hello!', channelMessageId: 'm2' });
    expect(s.getThreadView(t.id)!.lastMessageDirection).toBe('outbound');
  });
});
