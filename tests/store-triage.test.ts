import { describe, it, expect } from 'vitest';
import { InboxStore } from '../src/core/store/InboxStore';

function seedThread(s: InboxStore, key = 'k1') {
  s.upsertChannel({ id: 'c', kind: 'fake', label: 'C' });
  const cu = s.upsertCustomer('c', 'x', 'X');
  return s.findOrCreateThread('c', cu.id, key);
}

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
});
