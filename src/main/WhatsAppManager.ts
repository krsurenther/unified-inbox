import { existsSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { createWaClient } from '../core/channels/whatsapp/createWaClient';
import { WhatsAppAdapter } from '../core/channels/whatsapp/WhatsAppAdapter';
import { WhatsAppGuard, type WaGuardStatus } from '../core/channels/whatsapp/WhatsAppGuard';
import { nextReconnectDelay } from '../core/channels/whatsapp/reconnect';
import type { InboxService } from '../core/InboxService';
import type { WaNumberState } from '../shared/inbox-api';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Entry {
  cfg: { id: string; label: string };
  adapter?: WhatsAppAdapter;
  state: WaNumberState;
}

export interface WhatsAppManagerOptions {
  service: InboxService;
  numbers: Array<{ id: string; label: string }>;
  dataPath: string;
  onChange: () => void;
  /** Anti-ban: max sends per number per rolling 24h. */
  dailyCap?: number;
  /** Kill-switch state restored from persistence. */
  initialKilled?: boolean;
  /** Persist the kill switch whenever it flips. */
  onKillChange?: (killed: boolean) => void;
}

/**
 * Owns the WhatsApp clients in the main process: one per configured number.
 * Forwards QR / connection state to the renderer for in-app linking, and on
 * `ready` registers the adapter with the inbox + backfills its chats. Numbers
 * with a saved session auto-start; the rest wait for an explicit connect().
 */
export class WhatsAppManager {
  private readonly entries = new Map<string, Entry>();
  private readonly service: InboxService;
  private readonly dataPath: string;
  private readonly onChange: () => void;
  private readonly guard: WhatsAppGuard;
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly userDisconnecting = new Set<string>();

  constructor(opts: WhatsAppManagerOptions) {
    this.service = opts.service;
    this.dataPath = opts.dataPath;
    this.onChange = opts.onChange;
    for (const n of opts.numbers) this.entries.set(n.id, { cfg: n, state: { id: n.id, label: n.label, state: 'idle' } });
    // Anti-ban guard: one send policy per number + a shared kill switch. The
    // recent-send count comes from the send-audit log over a rolling 24h window.
    this.guard = new WhatsAppGuard({
      numbers: opts.numbers,
      dailyCap: opts.dailyCap,
      countRecentSends: (channelId) =>
        this.service.sendCountSince(channelId, new Date(Date.now() - DAY_MS).toISOString()),
      initialKilled: opts.initialKilled,
      onKillChange: opts.onKillChange,
    });
  }

  list(): WaNumberState[] {
    return [...this.entries.values()].map((e) => e.state);
  }

  /** Per-number send counts / risk + the global kill-switch state (for the UI). */
  guardStatus(): Promise<WaGuardStatus> {
    return this.guard.status();
  }

  /** Engage/release the global kill switch — pauses ALL WhatsApp sending when on. */
  setKillSwitch(on: boolean): void {
    this.guard.setKill(on);
    this.onChange();
  }

  /** Give a number a friendly label (e.g. "Sales", "Repair") — updates its chip everywhere. */
  rename(id: string, label: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.cfg = { ...e.cfg, label };
    e.state = { ...e.state, label };
    if (e.adapter) e.adapter.channel.label = label; // stop re-registration reverting the label
    this.service.renameChannel(`whatsapp:${id}`, label);
    this.onChange();
  }

  /** Human-pacing delay (ms) a send on this channel will incur — 0 for non-WhatsApp channels. */
  etaFor(channelId: string, body: string): number {
    if (!channelId.startsWith('whatsapp:')) return 0;
    const policy = this.guard.policyFor(channelId.slice('whatsapp:'.length));
    return policy ? policy.delayFor(body) : 0;
  }

  private hasSession(id: string): boolean {
    return existsSync(join(this.dataPath, `session-${id}`));
  }

  /** Capped-backoff auto-reconnect after an unexpected drop (5s → 30s → 2m, then stop). */
  private scheduleReconnect(id: string): void {
    const attempt = (this.reconnectAttempts.get(id) ?? 0) + 1;
    const delay = nextReconnectDelay(attempt);
    if (delay === undefined) {
      console.log(`[wa] ${id} gave up auto-reconnect after ${attempt - 1} tries — Connect to retry`);
      return;
    }
    this.reconnectAttempts.set(id, attempt);
    console.log(`[wa] ${id} reconnect attempt ${attempt} in ${delay / 1000}s`);
    setTimeout(() => {
      if (this.userDisconnecting.has(id)) return; // unlinked in the meantime
      void this.connect(id).catch((e) => console.error(`[wa] reconnect ${id}:`, (e as Error).message));
    }, delay);
  }

  autoStartLinked(): void {
    for (const [id] of this.entries) {
      if (this.hasSession(id)) {
        this.connect(id).catch((e) => console.error(`[wa] autostart ${id}:`, (e as Error).message));
      }
    }
  }

  async connect(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.adapter) return;
    this.userDisconnecting.delete(id); // a fresh connect re-enables auto-reconnect
    e.state = { id: e.cfg.id, label: e.cfg.label, state: 'connecting' };
    this.onChange();

    const adapter = new WhatsAppAdapter({
      client: createWaClient({ clientId: id, dataPath: this.dataPath }),
      number: e.cfg,
      sendPolicy: this.guard.policyFor(id), // anti-ban: cap + pacing + kill switch
      onQr: (qr) => {
        void QRCode.toDataURL(qr, { width: 320, margin: 1 }).then((qrDataUrl) => {
          e.state = { ...e.state, state: 'qr', qrDataUrl };
          this.onChange();
        });
      },
      onReady: () => {
        this.reconnectAttempts.delete(id); // healthy again — reset backoff
        e.state = { ...e.state, state: 'ready', qrDataUrl: undefined, detail: 'linked' };
        this.onChange();
        this.service
          .syncChannel(adapter.channel.id)
          .then((r) => {
            e.state = { ...e.state, threads: r.threads };
            console.log(`[wa] ${id} synced ${r.threads} chats, +${r.messages} messages`);
            this.onChange();
          })
          .catch((err) => console.error(`[wa] sync ${id}:`, (err as Error).message));
      },
      onDisconnected: (reason) => {
        e.state = { ...e.state, state: 'disconnected', detail: reason };
        e.adapter = undefined; // critical: without this, connect(id) is a silent no-op (dead number)
        this.service.unregisterChannel(adapter.channel.id);
        void adapter.stop().catch(() => {});
        this.onChange();
        if (!this.userDisconnecting.has(id)) this.scheduleReconnect(id);
      },
      onAuthFailure: (m) => {
        e.state = { ...e.state, state: 'error', detail: `session expired — relink (${m})` };
        this.onChange();
      },
    });

    e.adapter = adapter;
    this.service.registerChannel(adapter);
    try {
      await adapter.start();
    } catch (err) {
      e.state = { ...e.state, state: 'error', detail: (err as Error).message };
      this.onChange();
    }
  }

  /**
   * Unlink a number: log it out (removes the device from the phone + clears the
   * saved session) if it was linked, otherwise just tear down the pending connect.
   * Unlinking a LINKED number also purges its stored conversations (owner request
   * 2026-07-10); the send_audit ledger is kept. Resets to idle so it can re-link.
   */
  async disconnect(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    this.userDisconnecting.add(id); // suppress auto-reconnect for this intentional unlink
    this.reconnectAttempts.delete(id);
    const wasReady = e.state.state === 'ready';
    const adapter = e.adapter;
    e.adapter = undefined;
    e.state = { id: e.cfg.id, label: e.cfg.label, state: 'idle' };
    this.onChange();

    if (!adapter) return;
    this.service.unregisterChannel(adapter.channel.id);
    try {
      if (wasReady) await adapter.logout();
      else await adapter.stop();
    } catch (err) {
      console.error(`[wa] disconnect ${id}:`, (err as Error).message);
      try {
        await adapter.stop();
      } catch {
        /* already down */
      }
    }

    if (wasReady) {
      try {
        const purged = this.service.purgeChannel(adapter.channel.id);
        console.log(`[wa] ${id} unlinked — purged ${purged.threads} threads, ${purged.messages} messages`);
      } catch (err) {
        console.error(`[wa] purge ${id}:`, (err as Error).message);
      }
      this.onChange();
    }
  }
}
