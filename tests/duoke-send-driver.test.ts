import { describe, it, expect } from 'vitest';
import { parseOpenConversationId, DuokeSendDriver } from '../src/core/channels/duoke/DuokeSendDriver';

/**
 * Drives the send() orchestration against a scripted page: `active` is the
 * conversation Duoke currently shows; openConversation's page script flips it
 * to the target only when `canOpen` is true (session rendered/loaded in Duoke).
 */
class FakeDuoke extends DuokeSendDriver {
  active: string;
  canOpen: boolean;
  log: string[] = [];
  constructor(active: string, canOpen: boolean) {
    super();
    this.active = active;
    this.canOpen = canOpen;
  }
  override async connect(): Promise<void> {}
  protected override async evaluate<T>(expression: string): Promise<T> {
    if (expression.includes('select-session')) {
      this.log.push('open');
      if (this.canOpen) this.active = (expression.match(/const TARGET="([^"]+)"/) ?? [])[1] ?? this.active;
      return this.canOpen as T;
    }
    if (expression.includes('state.Chat.conversationId')) return this.active as T;
    if (expression.includes('setter.call')) { this.log.push('compose'); return true as T; }
    if (expression.includes('KeyboardEvent')) { this.log.push('enter'); return true as T; }
    throw new Error(`unexpected eval: ${expression.slice(0, 60)}`);
  }
}

describe('DuokeSendDriver.send auto-open', () => {
  it('auto-opens the target conversation, then composes and sends', async () => {
    const d = new FakeDuoke('100193255_2_4055380_1_103', true);
    const res = await d.send({ conversationId: '100193255_2_3255507_1_103', text: 'hi' });
    expect(res).toEqual({ sent: true });
    expect(d.log).toEqual(['open', 'compose', 'enter']); // opened first, verified, then typed + sent
  });

  it('sends straight away when the target is already active (no open step)', async () => {
    const d = new FakeDuoke('c-1', true);
    await d.send({ conversationId: 'c-1', text: 'hi' });
    expect(d.log).toEqual(['compose', 'enter']);
  });

  it("refuses (clear error, nothing typed) when Duoke can't open the conversation", async () => {
    const d = new FakeDuoke('c-other', false);
    await expect(d.send({ conversationId: 'c-target', text: 'hi' })).rejects.toThrow(/auto-open/i);
    expect(d.log).toEqual(['open']); // tried to open; never touched the compose box
  });
});

describe('parseOpenConversationId', () => {
  it('extracts conversationId from a Duoke message/list request URL', () => {
    const url = 'https://app.duoke.com/api/v1/im/message/list?pageNo=1&pageSize=30&shopId=s1&conversationId=7635567393180467463&platform=tiktok&language=en';
    expect(parseOpenConversationId(url)).toBe('7635567393180467463');
  });

  it('returns undefined for unrelated URLs', () => {
    expect(parseOpenConversationId('https://app.duoke.com/api/v1/shop/')).toBeUndefined();
    expect(parseOpenConversationId('https://events.duoke.com/events')).toBeUndefined();
  });

  it('url-decodes the conversationId', () => {
    expect(parseOpenConversationId('https://app.duoke.com/api/v1/im/message/list?conversationId=abc%2F123&platform=shopee')).toBe('abc/123');
  });
});
