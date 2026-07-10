import { SendPolicy } from './SendPolicy';
import type { BanRisk } from './SendPolicy';

export interface WaNumberSendStatus {
  id: string;
  label: string;
  sentInWindow: number;
  cap: number;
  remaining: number;
  risk: BanRisk;
}

export interface WaGuardStatus {
  /** Global kill switch — pauses ALL WhatsApp sending when true. */
  killed: boolean;
  numbers: WaNumberSendStatus[];
}

export interface WhatsAppGuardOptions {
  numbers: Array<{ id: string; label: string }>;
  /**
   * Recent-send count for a channel id. The caller binds the rolling window
   * (e.g. last 24h) so the guard stays clock-agnostic and unit-testable.
   */
  countRecentSends: (channelId: string) => number;
  /** Per-number cap within the window. */
  dailyCap?: number;
  /** Kill-switch state restored from persistence (default false). */
  initialKilled?: boolean;
  /** Called whenever the kill switch flips — persist it so a restart can't silently re-arm sending. */
  onKillChange?: (killed: boolean) => void;
}

/**
 * The WhatsApp anti-ban guard: one {@link SendPolicy} per number sharing a single
 * global kill switch, plus a status roll-up for the UI. Puppeteer-free so it (and
 * the pacing/cap logic it holds) is fully unit-tested; the WhatsAppManager owns one
 * and hands each number's policy to that number's adapter.
 */
export class WhatsAppGuard {
  private killed: boolean;
  private readonly onKillChange?: (killed: boolean) => void;
  private readonly entries = new Map<string, { label: string; policy: SendPolicy }>();

  constructor(opts: WhatsAppGuardOptions) {
    this.killed = opts.initialKilled ?? false;
    this.onKillChange = opts.onKillChange;
    const cap = opts.dailyCap ?? 200;
    for (const n of opts.numbers) {
      const channelId = `whatsapp:${n.id}`;
      this.entries.set(n.id, {
        label: n.label,
        policy: new SendPolicy({
          dailyCap: cap,
          countRecentSends: () => opts.countRecentSends(channelId),
          isKilled: () => this.killed,
        }),
      });
    }
  }

  /** The policy for a number — passed into that number's adapter as its send gate. */
  policyFor(id: string): SendPolicy | undefined {
    return this.entries.get(id)?.policy;
  }

  isKilled(): boolean {
    return this.killed;
  }

  setKill(on: boolean): void {
    this.killed = on;
    this.onKillChange?.(on);
  }

  async status(): Promise<WaGuardStatus> {
    const numbers: WaNumberSendStatus[] = [];
    for (const [id, { label, policy }] of this.entries) {
      const s = await policy.check();
      numbers.push({ id, label, sentInWindow: s.sentInWindow, cap: s.cap, remaining: s.remaining, risk: s.risk });
    }
    return { killed: this.killed, numbers };
  }
}
