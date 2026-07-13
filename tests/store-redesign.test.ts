import { describe, it, expect } from 'vitest';
import { InboxStore } from '../src/core/store/InboxStore';

/** Seed a channel + customer + thread and return the thread id. */
function seed(s: InboxStore, chan: string, kind: 'whatsapp' | 'duoke', ext: string, name: string, phone?: string) {
  s.upsertChannel({ id: chan, kind, label: `${kind}:${chan}` });
  const c = s.upsertCustomer(chan, ext, name, phone);
  return s.findOrCreateThread(chan, c.id, `${ext}@k`);
}

describe('InboxStore.searchThreads', () => {
  it('matches customer name, external id, phone, and message body', () => {
    const s = new InboxStore(':memory:');
    const t = seed(s, 'whatsapp:1', 'whatsapp', '60123456789', 'Aisha Rahman', '60123456789');
    s.recordInbound({ threadId: t.id, body: 'is the red kettle in stock?', channelMessageId: 'm1' });
    seed(s, 'whatsapp:1', 'whatsapp', '60999', 'Someone Else'); // decoy

    expect(s.searchThreads('aisha').map((v) => v.thread.id)).toEqual([t.id]); // name
    expect(s.searchThreads('456789').map((v) => v.thread.id)).toEqual([t.id]); // phone/id fragment
    expect(s.searchThreads('kettle').map((v) => v.thread.id)).toEqual([t.id]); // message body
    expect(s.searchThreads('')).toEqual([]); // empty query
    expect(s.searchThreads('zzz-nomatch')).toEqual([]);
  });

  it('returns each matching thread once even with many matching messages', () => {
    const s = new InboxStore(':memory:');
    const t = seed(s, 'whatsapp:1', 'whatsapp', '60123', 'Bo');
    s.recordInbound({ threadId: t.id, body: 'kettle one', channelMessageId: 'm1' });
    s.recordInbound({ threadId: t.id, body: 'kettle two', channelMessageId: 'm2' });
    expect(s.searchThreads('kettle')).toHaveLength(1);
  });
});

describe('InboxStore.channelSummaries', () => {
  it('reports needs/total per channel and excludes the fake dev channel', () => {
    const s = new InboxStore(':memory:');
    s.upsertChannel({ id: 'fake:demo', kind: 'fake', label: 'Demo' });
    const a = seed(s, 'whatsapp:1', 'whatsapp', '601', 'A'); // needs (inbound)
    s.recordInbound({ threadId: a.id, body: 'hi', channelMessageId: 'a1' });
    const b = seed(s, 'whatsapp:1', 'whatsapp', '602', 'B'); // answered → not needs
    s.recordInbound({ threadId: b.id, body: 'hi', channelMessageId: 'b1' });
    s.recordOutbound({ threadId: b.id, body: 'reply', channelMessageId: 'b2' });
    const d = seed(s, 'duoke:1', 'duoke', '700', 'D'); // other channel, needs
    s.recordInbound({ threadId: d.id, body: 'hi', channelMessageId: 'd1' });

    const sums = s.channelSummaries();
    expect(sums.find((x) => x.channelId === 'fake:demo')).toBeUndefined();
    const wa = sums.find((x) => x.channelId === 'whatsapp:1')!;
    expect(wa).toMatchObject({ kind: 'whatsapp', needs: 1, total: 2 });
    expect(sums.find((x) => x.channelId === 'duoke:1')).toMatchObject({ needs: 1, total: 1 });
  });
});

describe('InboxStore triage counts + assignment', () => {
  it('countsByTriage tallies needs / mine / all / done', () => {
    const s = new InboxStore(':memory:');
    const a = seed(s, 'whatsapp:1', 'whatsapp', '601', 'A');
    s.recordInbound({ threadId: a.id, body: 'hi', channelMessageId: 'a1' });
    const b = seed(s, 'whatsapp:1', 'whatsapp', '602', 'B');
    s.recordInbound({ threadId: b.id, body: 'hi', channelMessageId: 'b1' });
    s.setThreadStatus(b.id, 'closed');
    s.assignThread(a.id, 'Farah');

    const c = s.countsByTriage('Farah');
    expect(c).toEqual({ needs: 1, mine: 1, all: 1, done: 1 });
    expect(s.countsByTriage('Nobody').mine).toBe(0);
  });

  it('assignThread round-trips through the thread view (and unassigns with null)', () => {
    const s = new InboxStore(':memory:');
    const t = seed(s, 'whatsapp:1', 'whatsapp', '601', 'A');
    s.assignThread(t.id, 'Suren');
    expect(s.getThreadView(t.id)!.assignee).toBe('Suren');
    s.assignThread(t.id, null);
    expect(s.getThreadView(t.id)!.assignee).toBeUndefined();
  });
});

describe('InboxStore.setCustomerNote', () => {
  it('round-trips a customer note and clears it with an empty string', () => {
    const s = new InboxStore(':memory:');
    const t = seed(s, 'whatsapp:1', 'whatsapp', '601', 'A');
    const cid = s.getThreadView(t.id)!.customer.id;
    s.setCustomerNote(cid, '  card only, no COD  ');
    expect(s.getThreadView(t.id)!.customer.note).toBe('card only, no COD'); // trimmed
    s.setCustomerNote(cid, '   ');
    expect(s.getThreadView(t.id)!.customer.note).toBeUndefined(); // blank clears
  });
});

describe('InboxStore.relatedThreads', () => {
  it('finds the same person on another channel by shared phone', () => {
    const s = new InboxStore(':memory:');
    const wa = seed(s, 'whatsapp:1', 'whatsapp', '60123', 'Kang', '60123');
    const lz = seed(s, 'duoke:1', 'duoke', 'buyer-9', 'Kang', '60123'); // same phone, different channel
    seed(s, 'duoke:1', 'duoke', 'buyer-x', 'Other', '60999'); // unrelated

    const rel = s.relatedThreads(wa.id).map((v) => v.thread.id);
    expect(rel).toContain(lz.id);
    expect(rel).not.toContain(wa.id); // excludes self
  });
});
