import { describe, it, expect } from 'vitest';
import { WhatsAppGuard } from '../src/core/channels/whatsapp/WhatsAppGuard';

describe('WhatsAppGuard', () => {
  it('exposes a per-number send policy and aggregates each number\'s status', async () => {
    const counts: Record<string, number> = { 'whatsapp:num-1': 10, 'whatsapp:num-2': 190 };
    const guard = new WhatsAppGuard({
      numbers: [
        { id: 'num-1', label: 'WA1' },
        { id: 'num-2', label: 'WA2' },
      ],
      countRecentSends: (channelId) => counts[channelId] ?? 0,
      dailyCap: 200,
    });

    expect(guard.policyFor('num-1')).toBeDefined();
    expect(guard.policyFor('nope')).toBeUndefined();

    const status = await guard.status();
    expect(status.killed).toBe(false);
    expect(status.numbers).toEqual([
      { id: 'num-1', label: 'WA1', sentInWindow: 10, cap: 200, remaining: 190, risk: 'low' },
      { id: 'num-2', label: 'WA2', sentInWindow: 190, cap: 200, remaining: 10, risk: 'high' },
    ]);
  });

  it('starts killed from initialKilled and reports kill changes', async () => {
    const changes: boolean[] = [];
    const g = new WhatsAppGuard({
      numbers: [{ id: 'num-1', label: 'WA1' }],
      countRecentSends: () => 0,
      initialKilled: true,
      onKillChange: (on) => changes.push(on),
    });
    expect(g.isKilled()).toBe(true);
    expect((await g.policyFor('num-1')!.check()).allowed).toBe(false);
    g.setKill(false);
    expect(changes).toEqual([false]);
    expect((await g.policyFor('num-1')!.check()).allowed).toBe(true);
  });

  it('the kill switch flips status and makes every number\'s policy deny sends', async () => {
    const guard = new WhatsAppGuard({
      numbers: [{ id: 'num-1', label: 'WA1' }],
      countRecentSends: () => 0,
      dailyCap: 200,
    });
    expect(guard.isKilled()).toBe(false);

    guard.setKill(true);
    expect(guard.isKilled()).toBe(true);
    expect((await guard.status()).killed).toBe(true);
    const decision = await guard.policyFor('num-1')!.check();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/kill/i);

    guard.setKill(false);
    expect((await guard.policyFor('num-1')!.check()).allowed).toBe(true);
  });
});
