import { describe, it, expect } from 'vitest';
import { WhatsAppAdapter } from '../src/core/channels/whatsapp/WhatsAppAdapter';
import type { WaChat, WaClient, WaMessage } from '../src/core/channels/whatsapp/wa-types';

function makeMock() {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const sent: Array<{ chatId: string; content: string }> = [];
  const chats: WaChat[] = [];
  const histories: Record<string, WaMessage[]> = {};
  const flags = { loggedOut: false, destroyed: false };
  const client = {
    on(ev: string, cb: (...a: unknown[]) => void) { (handlers[ev] ??= []).push(cb); },
    emit(ev: string, ...args: unknown[]) { (handlers[ev] ?? []).forEach((cb) => cb(...args)); },
    async initialize() {},
    async destroy() { flags.destroyed = true; },
    async logout() { flags.loggedOut = true; },
    async getChats() { return chats; },
    async getChatById(id: string): Promise<WaChat> {
      return { id: { _serialized: id }, name: 'X', isGroup: false, unreadCount: 0, timestamp: 0, fetchMessages: async () => histories[id] ?? [] };
    },
    async sendMessage(chatId: string, content: string): Promise<WaMessage> {
      sent.push({ chatId, content });
      return { id: { _serialized: `out-${sent.length}` }, from: 'me', to: chatId, body: content, fromMe: true, timestamp: 1700000100, type: 'chat', hasMedia: false };
    },
  };
  return { client: client as unknown as WaClient & { emit: (ev: string, ...a: unknown[]) => void }, sent, chats, histories, flags };
}

const waMsg = (over: Partial<WaMessage>): WaMessage => ({ id: { _serialized: 'm' }, from: '60123456789@c.us', to: 'me', body: 'hi', fromMe: false, timestamp: 1700000000, type: 'chat', hasMedia: false, ...over });

describe('WhatsAppAdapter', () => {
  it('has a whatsapp channel ref', () => {
    const { client } = makeMock();
    const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WhatsApp · 1' } });
    expect(a.channel).toMatchObject({ id: 'whatsapp:num-1', kind: 'whatsapp', label: 'WhatsApp · 1' });
  });

  it('emits inbound messages, skipping own and group messages', async () => {
    const { client } = makeMock();
    const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' } });
    const got: Array<Record<string, unknown>> = [];
    a.onMessage((m) => { got.push(m as unknown as Record<string, unknown>); });
    await a.start();
    client.emit('message', waMsg({ id: { _serialized: 'm1' }, body: 'Is it available?' }));
    client.emit('message', waMsg({ fromMe: true, body: 'mine' }));
    client.emit('message', waMsg({ from: '12345@g.us', body: 'group' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ channelId: 'whatsapp:num-1', threadKey: '60123456789@c.us', from: { externalId: '60123456789' }, body: 'Is it available?' });
  });

  it('lists only 1:1 chats as thread descriptors', async () => {
    const { client, chats } = makeMock();
    chats.push(
      { id: { _serialized: '60123456789@c.us' }, name: 'Aisha', isGroup: false, unreadCount: 1, timestamp: 1700000000, fetchMessages: async () => [] },
      { id: { _serialized: '99@g.us' }, name: 'Group', isGroup: true, unreadCount: 0, timestamp: 1700000000, fetchMessages: async () => [] },
    );
    const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' } });
    const threads = await a.listThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ threadKey: '60123456789@c.us', participant: { name: 'Aisha', phone: '60123456789' } });
  });

  it('fetches history for a chat (chronological)', async () => {
    const { client, histories } = makeMock();
    histories['60123456789@c.us'] = [
      waMsg({ id: { _serialized: 'h1' }, body: 'hello', fromMe: false }),
      waMsg({ id: { _serialized: 'h2' }, body: 'hi there', fromMe: true }),
    ];
    const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' } });
    const hist = await a.getHistory('60123456789@c.us');
    expect(hist.map((m) => m.direction)).toEqual(['inbound', 'outbound']);
    expect(hist[0]!.channelMessageId).toBe('h1');
  });

  it('skips system messages (e2e_notification etc.) in history and inbound', async () => {
    const { client, histories } = makeMock();
    histories['60123456789@c.us'] = [
      waMsg({ id: { _serialized: 'h1' }, body: 'real msg', fromMe: false, type: 'chat' }),
      waMsg({ id: { _serialized: 'sys' }, body: '', fromMe: false, type: 'e2e_notification' }),
    ];
    const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' } });
    const hist = await a.getHistory('60123456789@c.us');
    expect(hist.map((m) => m.channelMessageId)).toEqual(['h1']);

    const got: Array<Record<string, unknown>> = [];
    a.onMessage((m) => got.push(m as unknown as Record<string, unknown>));
    await a.start();
    client.emit('message', waMsg({ id: { _serialized: 'sys2' }, type: 'e2e_notification', body: '' }));
    client.emit('message', waMsg({ id: { _serialized: 'm9' }, type: 'chat', body: 'real' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(got.map((g) => g.channelMessageId)).toEqual(['m9']);
  });

  it('caps and orders threads by recency', async () => {
    const { client, chats } = makeMock();
    for (let i = 0; i < 60; i++) {
      chats.push({ id: { _serialized: `${i}@lid` }, name: `c${i}`, isGroup: false, unreadCount: 0, timestamp: i, fetchMessages: async () => [] });
    }
    const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' }, threadLimit: 5 });
    const threads = await a.listThreads();
    expect(threads).toHaveLength(5);
    expect(threads[0]!.threadKey).toBe('59@lid'); // newest first
  });

  it('sends via the client when connected', async () => {
    const { client, sent } = makeMock();
    const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' } });
    a.onMessage(() => {});
    await a.start();
    client.emit('ready');
    const res = await a.send({ threadKey: '60123456789@c.us', body: 'On its way!' });
    expect(sent).toEqual([{ chatId: '60123456789@c.us', content: 'On its way!' }]);
    expect(res.channelMessageId).toBe('out-1');
  });

  it('refuses to send before connected', async () => {
    const { client } = makeMock();
    const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' } });
    await expect(a.send({ threadKey: '60123456789@c.us', body: 'hi' })).rejects.toThrow(/not connected/i);
  });

  it('logout() unlinks via the client and marks disconnected', async () => {
    const { client, flags } = makeMock();
    const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' } });
    a.onMessage(() => {});
    await a.start();
    client.emit('ready');
    expect(a.connected).toBe(true);
    await a.logout();
    expect(flags.loggedOut).toBe(true);
    expect(a.connected).toBe(false);
  });

  it('exposes the QR string for linking', async () => {
    const { client } = makeMock();
    let qrSeen = '';
    const a = new WhatsAppAdapter({ client, number: { id: 'num-1', label: 'WA' }, onQr: (q) => { qrSeen = q; } });
    await a.start();
    client.emit('qr', 'QR-DATA-123');
    expect(qrSeen).toBe('QR-DATA-123');
    expect(a.qr).toBe('QR-DATA-123');
  });
});
