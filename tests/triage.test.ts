import { describe, it, expect } from 'vitest';
import { needsReply } from '../src/core/triage';
import type { ThreadView } from '../src/core/types';

const view = (status: 'open' | 'closed', dir?: 'inbound' | 'outbound', muted = false): ThreadView =>
  ({ thread: { status }, lastMessageDirection: dir, muted } as unknown as ThreadView);

describe('needsReply', () => {
  it('is true only for an open thread whose last message is inbound', () => {
    expect(needsReply(view('open', 'inbound'))).toBe(true);
    expect(needsReply(view('open', 'outbound'))).toBe(false); // we already replied
    expect(needsReply(view('closed', 'inbound'))).toBe(false); // marked done
    expect(needsReply(view('open', undefined))).toBe(false); // no messages yet
    expect(needsReply(view('open', 'inbound', true))).toBe(false); // muted (not a customer)
  });
});
