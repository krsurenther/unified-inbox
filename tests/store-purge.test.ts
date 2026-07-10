import { describe, it, expect } from 'vitest';
import { InboxStore } from '../src/core/store/InboxStore';

describe('InboxStore thread deletion + channel purge', () => {
  it('deleteThreadsByKey removes the thread + its messages + drafts, leaves others', () => {
    const s = new InboxStore(':memory:');
    s.upsertChannel({ id: 'whatsapp:num-1', kind: 'whatsapp', label: 'WA' });
    const c = s.upsertCustomer('whatsapp:num-1', 'status', 'status');
    const t1 = s.findOrCreateThread('whatsapp:num-1', c.id, 'status@broadcast');
    s.recordInbound({ threadId: t1.id, body: '[video]', channelMessageId: 's1' });
    s.saveDraft({ threadId: t1.id, body: 'junk draft' });
    const c2 = s.upsertCustomer('whatsapp:num-1', '60123', 'Real');
    const t2 = s.findOrCreateThread('whatsapp:num-1', c2.id, '60123@c.us');
    s.recordInbound({ threadId: t2.id, body: 'hi', channelMessageId: 'r1' });

    const r = s.deleteThreadsByKey('status@broadcast');
    expect(r.threads).toBe(1);
    expect(r.messages).toBe(1);
    expect(s.getThreadView(t1.id)).toBeUndefined();
    expect(s.getLatestDraft(t1.id)).toBeUndefined();
    expect(s.getHistory(t2.id)).toHaveLength(1); // the real thread is untouched
  });

  it('purgeChannelData removes threads/messages/drafts/customers for ONE channel, keeps audit + others', () => {
    const s = new InboxStore(':memory:');
    for (const ch of ['whatsapp:num-1', 'whatsapp:num-2']) {
      s.upsertChannel({ id: ch, kind: 'whatsapp', label: ch });
      const c = s.upsertCustomer(ch, `cust-${ch}`, 'C');
      const t = s.findOrCreateThread(ch, c.id, `${ch}-t1`);
      s.recordInbound({ threadId: t.id, body: 'hi', channelMessageId: `${ch}-m1` });
      s.saveDraft({ threadId: t.id, body: 'draft' });
      s.recordSendAudit({ threadId: t.id, channelId: ch, body: 'sent reply', sentAt: '2026-07-10T00:00:00.000Z' });
    }
    const before = s.countSendsSince('whatsapp:num-1', '1970-01-01T00:00:00.000Z');
    expect(before).toBe(1);

    const r = s.purgeChannelData('whatsapp:num-1');
    expect(r.threads).toBe(1);
    expect(s.listThreads().map((t) => t.channel.id)).toEqual(['whatsapp:num-2']); // only num-2 remains
    // the anti-ban ledger is untouched — disconnect→reconnect cannot reset the daily cap
    expect(s.countSendsSince('whatsapp:num-1', '1970-01-01T00:00:00.000Z')).toBe(before);
  });
});
