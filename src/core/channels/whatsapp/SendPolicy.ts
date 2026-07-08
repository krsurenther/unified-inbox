export type BanRisk = 'low' | 'medium' | 'high';

export interface SendPolicyStatus {
  /** Whether a send is permitted right now. */
  allowed: boolean;
  /** Human-readable reason when blocked (cap reached / kill switch). */
  reason?: string;
  /** Sends by THIS number inside the rolling window. */
  sentInWindow: number;
  /** The per-number cap for the window. */
  cap: number;
  /** cap - sentInWindow, floored at 0. */
  remaining: number;
  /** Ban-risk band derived from how close to the cap we are. */
  risk: BanRisk;
  /** Whether the global kill switch is engaged. */
  killed: boolean;
}

export interface SendPolicyOptions {
  /**
   * Rolling-window send count for THIS number — wired to the send-audit log so it
   * survives restarts. Injected to keep the policy decoupled from the store.
   */
  countRecentSends: () => number | Promise<number>;
  /** Per-number cap within the rolling window. Default 200 (conservative for aged numbers). */
  dailyCap?: number;
  /** Global kill switch reader. When it returns true, ALL sends are blocked. */
  isKilled?: () => boolean;
  /** Pacing floor — minimum "typing" delay before any send (ms). */
  minDelayMs?: number;
  /** Extra delay per character of the reply (ms) — simulates typing speed. */
  perCharMs?: number;
  /** Hard ceiling on the pacing delay (ms). */
  maxDelayMs?: number;
  /** Random jitter added on top (0..jitterMs, ms) so pacing isn't robotic. */
  jitterMs?: number;
  // --- test seams ---
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RISK_MEDIUM = 0.6;
const RISK_HIGH = 0.85;

/**
 * Anti-ban guard for the WhatsApp workaround path. Enforces a per-number rolling
 * cap, human-like send pacing (randomized, length-scaled delays), a global kill
 * switch, and surfaces a ban-risk band — so a human never blasts a number into a
 * ban. Pure and injectable: the send count, clock jitter and sleep are all seams.
 */
export class SendPolicy {
  private cap: number;
  private readonly countRecentSends: () => number | Promise<number>;
  private readonly isKilled: () => boolean;
  private readonly minDelayMs: number;
  private readonly perCharMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterMs: number;
  private readonly random: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(opts: SendPolicyOptions) {
    this.cap = opts.dailyCap ?? 200;
    this.countRecentSends = opts.countRecentSends;
    this.isKilled = opts.isKilled ?? (() => false);
    this.minDelayMs = opts.minDelayMs ?? 2500;
    this.perCharMs = opts.perCharMs ?? 60;
    this.maxDelayMs = opts.maxDelayMs ?? 15000;
    this.jitterMs = opts.jitterMs ?? 2000;
    this.random = opts.random ?? Math.random;
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  setCap(cap: number): void {
    this.cap = cap;
  }

  async check(): Promise<SendPolicyStatus> {
    const sentInWindow = await this.countRecentSends();
    const remaining = Math.max(0, this.cap - sentInWindow);
    const risk = this.riskFor(sentInWindow);
    const killed = this.isKilled();

    if (killed) {
      return { allowed: false, reason: 'Kill switch is ON — WhatsApp sending is paused.', sentInWindow, cap: this.cap, remaining, risk, killed };
    }
    if (sentInWindow >= this.cap) {
      return {
        allowed: false,
        reason: `Daily cap reached for this number (${sentInWindow}/${this.cap}). Paused to avoid a ban.`,
        sentInWindow,
        cap: this.cap,
        remaining,
        risk,
        killed,
      };
    }
    return { allowed: true, sentInWindow, cap: this.cap, remaining, risk, killed };
  }

  private riskFor(sent: number): BanRisk {
    const pct = this.cap === 0 ? 1 : sent / this.cap;
    if (pct >= RISK_HIGH) return 'high';
    if (pct >= RISK_MEDIUM) return 'medium';
    return 'low';
  }

  /** Compute the human-like delay for a reply of this length (ms), clamped to [min, max]. */
  delayFor(text: string): number {
    const base = this.minDelayMs + text.length * this.perCharMs;
    const jitter = this.random() * this.jitterMs;
    return Math.min(this.maxDelayMs, Math.round(base + jitter));
  }

  /** Wait out the pacing delay for a reply before it is sent. */
  async pace(text: string): Promise<void> {
    await this.sleepFn(this.delayFor(text));
  }
}
