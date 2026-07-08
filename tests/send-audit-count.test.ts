import { describe, it, expect } from 'vitest';
import { InboxStore } from '../src/core/store/InboxStore';

describe('InboxStore.countSendsSince', () => {
  it('counts a channel\'s sends at/after a timestamp, ignoring older sends and other channels', () => {
    const store = new InboxStore(':memory:');
    store.upsertChannel({ id: 'whatsapp:num-1', kind: 'whatsapp', label: 'WA1' });
    store.upsertChannel({ id: 'whatsapp:num-2', kind: 'whatsapp', label: 'WA2' });
    const c = store.upsertCustomer('whatsapp:num-1', '60123', 'A');
    const t = store.findOrCreateThread('whatsapp:num-1', c.id, '60123@c.us');

    store.recordSendAudit({ threadId: t.id, channelId: 'whatsapp:num-1', body: 'in-window a', sentAt: '2026-07-08T01:00:00.000Z' });
    store.recordSendAudit({ threadId: t.id, channelId: 'whatsapp:num-1', body: 'in-window b', sentAt: '2026-07-08T05:00:00.000Z' });
    store.recordSendAudit({ threadId: t.id, channelId: 'whatsapp:num-1', body: 'too old', sentAt: '2026-07-06T00:00:00.000Z' });
    store.recordSendAudit({ threadId: t.id, channelId: 'whatsapp:num-2', body: 'other number', sentAt: '2026-07-08T06:00:00.000Z' });

    expect(store.countSendsSince('whatsapp:num-1', '2026-07-07T00:00:00.000Z')).toBe(2);
    expect(store.countSendsSince('whatsapp:num-1', '2026-07-05T00:00:00.000Z')).toBe(3);
    expect(store.countSendsSince('whatsapp:num-2', '2026-07-07T00:00:00.000Z')).toBe(1);
    expect(store.countSendsSince('whatsapp:num-1', '2026-07-09T00:00:00.000Z')).toBe(0);
  });
});
