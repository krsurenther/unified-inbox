import { describe, it, expect } from 'vitest';
import { isInboxWaChat, normalizeWaMessage, waChatToDescriptor } from '../src/core/channels/whatsapp/normalize';

describe('isInboxWaChat', () => {
  it('accepts 1:1 chats, rejects groups, broadcasts (incl. status) and newsletters', () => {
    expect(isInboxWaChat('60123456789@c.us')).toBe(true);
    expect(isInboxWaChat('96971972935865@lid')).toBe(true);
    expect(isInboxWaChat('123@g.us')).toBe(false);
    expect(isInboxWaChat('status@broadcast')).toBe(false);
    expect(isInboxWaChat('99@broadcast')).toBe(false);
    expect(isInboxWaChat('abc@newsletter')).toBe(false);
  });
});

describe('normalizeWaMessage', () => {
  const base = { id: { _serialized: 'm1' }, from: '60123456789@c.us', to: 'me@c.us', timestamp: 1700000000, type: 'chat', hasMedia: false };

  it('maps an inbound text message', () => {
    const n = normalizeWaMessage({ ...base, body: 'Hi, in stock?', fromMe: false });
    expect(n.direction).toBe('inbound');
    expect(n.body).toBe('Hi, in stock?');
    expect(n.channelMessageId).toBe('m1');
    expect(n.timestamp).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('maps an outbound message via fromMe', () => {
    const n = normalizeWaMessage({ ...base, body: 'Yes!', fromMe: true });
    expect(n.direction).toBe('outbound');
  });

  it('summarizes media messages with no caption', () => {
    const n = normalizeWaMessage({ ...base, body: '', fromMe: false, type: 'image', hasMedia: true });
    expect(n.body).toBe('[image]');
  });
});

describe('waChatToDescriptor', () => {
  it('maps a 1:1 chat to a thread descriptor (phone stripped of @c.us)', () => {
    const d = waChatToDescriptor({
      id: { _serialized: '60123456789@c.us' },
      name: 'Aisha',
      isGroup: false,
      unreadCount: 2,
      timestamp: 1700000000,
      lastMessage: { id: { _serialized: 'x' }, from: '60123456789@c.us', to: 'me', body: 'see you tmr', fromMe: false, timestamp: 1700000000, type: 'chat', hasMedia: false },
    });
    expect(d).toMatchObject({
      threadKey: '60123456789@c.us',
      participant: { externalId: '60123456789', name: 'Aisha', phone: '60123456789' },
      unread: 2,
      preview: 'see you tmr',
    });
    expect(d.lastMessageAt).toBe(new Date(1700000000 * 1000).toISOString());
  });
});
