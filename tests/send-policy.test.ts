import { describe, it, expect } from 'vitest';
import { SendPolicy } from '../src/core/channels/whatsapp/SendPolicy';

describe('SendPolicy', () => {
  it('allows a send under the cap and reports remaining + low risk', async () => {
    const p = new SendPolicy({ dailyCap: 100, countRecentSends: () => 10 });
    const s = await p.check();
    expect(s.allowed).toBe(true);
    expect(s.sentInWindow).toBe(10);
    expect(s.cap).toBe(100);
    expect(s.remaining).toBe(90);
    expect(s.risk).toBe('low');
    expect(s.killed).toBe(false);
  });

  it('blocks once the per-number cap is reached, with a reason', async () => {
    const p = new SendPolicy({ dailyCap: 100, countRecentSends: () => 100 });
    const s = await p.check();
    expect(s.allowed).toBe(false);
    expect(s.reason).toMatch(/cap/i);
    expect(s.remaining).toBe(0);
  });

  it('kill switch blocks every send regardless of count', async () => {
    const p = new SendPolicy({ dailyCap: 100, countRecentSends: () => 0, isKilled: () => true });
    const s = await p.check();
    expect(s.allowed).toBe(false);
    expect(s.reason).toMatch(/kill/i);
    expect(s.killed).toBe(true);
  });

  it('escalates ban risk as the count approaches the cap', async () => {
    const low = await new SendPolicy({ dailyCap: 100, countRecentSends: () => 40 }).check();
    const med = await new SendPolicy({ dailyCap: 100, countRecentSends: () => 70 }).check();
    const high = await new SendPolicy({ dailyCap: 100, countRecentSends: () => 90 }).check();
    expect(low.risk).toBe('low');
    expect(med.risk).toBe('medium');
    expect(high.risk).toBe('high');
  });

  it('computes a human-like delay that scales with message length within bounds', () => {
    const p = new SendPolicy({
      dailyCap: 100,
      countRecentSends: () => 0,
      minDelayMs: 2000,
      perCharMs: 50,
      maxDelayMs: 15000,
      jitterMs: 1000,
      random: () => 0.5, // deterministic jitter = 500ms
    });
    // 'hello' = 5 chars → 2000 + 5*50 + 500 = 2750
    expect(p.delayFor('hello')).toBe(2750);
    // longer message takes longer, but never below the floor
    expect(p.delayFor('hi')).toBeGreaterThanOrEqual(2000);
    expect(p.delayFor('a very long reply '.repeat(5))).toBeGreaterThan(p.delayFor('hi'));
  });

  it('clamps the delay to the max for very long messages', () => {
    const p = new SendPolicy({
      dailyCap: 100,
      countRecentSends: () => 0,
      minDelayMs: 2000,
      perCharMs: 50,
      maxDelayMs: 8000,
      jitterMs: 0,
      random: () => 0,
    });
    expect(p.delayFor('x'.repeat(1000))).toBe(8000); // 2000 + 50000 clamped to 8000
  });

  it('pace() waits for the computed delay before resolving', async () => {
    let slept = -1;
    const p = new SendPolicy({
      dailyCap: 100,
      countRecentSends: () => 0,
      minDelayMs: 2000,
      perCharMs: 0,
      jitterMs: 0,
      random: () => 0,
      sleep: async (ms) => { slept = ms; },
    });
    await p.pace('anything');
    expect(slept).toBe(2000);
  });
});
