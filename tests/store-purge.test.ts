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
});
