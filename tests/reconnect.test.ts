import { describe, it, expect } from 'vitest';
import { nextReconnectDelay } from '../src/core/channels/whatsapp/reconnect';

describe('nextReconnectDelay', () => {
  it('backs off 5s → 30s → 2m, then gives up (manual/liveness takes over)', () => {
    expect(nextReconnectDelay(1)).toBe(5_000);
    expect(nextReconnectDelay(2)).toBe(30_000);
    expect(nextReconnectDelay(3)).toBe(120_000);
    expect(nextReconnectDelay(4)).toBeUndefined();
    expect(nextReconnectDelay(9)).toBeUndefined();
  });
});
