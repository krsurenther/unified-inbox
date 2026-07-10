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

  it('last_message_at only moves forward (monotonic), resisting stale/out-of-order updates', () => {
    const s = new InboxStore(':memory:');
    const t = seedThread(s);
    s.recordInbound({ threadId: t.id, body: 'new', channelMessageId: 'm1', createdAt: '2027-01-01T00:00:00.000Z' });
    s.setThreadSummary(t.id, { lastMessageAt: '2026-01-01T00:00:00.000Z' }); // stale channel summary
    expect(s.getThreadView(t.id)!.thread.lastMessageAt).toBe('2027-01-01T00:00:00.000Z');
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
