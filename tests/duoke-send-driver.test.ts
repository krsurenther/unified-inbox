import { describe, it, expect } from 'vitest';
import { parseOpenConversationId } from '../src/core/channels/duoke/DuokeSendDriver';

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
