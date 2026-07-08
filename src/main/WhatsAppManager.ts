import { existsSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { createWaClient } from '../core/channels/whatsapp/createWaClient';
import { WhatsAppAdapter } from '../core/channels/whatsapp/WhatsAppAdapter';
import type { InboxService } from '../core/InboxService';
import type { WaNumberState } from '../shared/inbox-api';

interface Entry {
  cfg: { id: string; label: string };
  adapter?: WhatsAppAdapter;
  state: WaNumberState;
}

/**
 * Owns the WhatsApp clients in the main process: one per configured number.
 * Forwards QR / connection state to the renderer for in-app linking, and on
 * `ready` registers the adapter with the inbox + backfills its chats. Numbers
 * with a saved session auto-start; the rest wait for an explicit connect().
 */
export class WhatsAppManager {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly service: InboxService,
    numbers: Array<{ id: string; label: string }>,
    private readonly dataPath: string,
    private readonly onChange: () => void,
  ) {
    for (const n of numbers) this.entries.set(n.id, { cfg: n, state: { id: n.id, label: n.label, state: 'idle' } });
  }

  list(): WaNumberState[] {
    return [...this.entries.values()].map((e) => e.state);
  }

  private hasSession(id: string): boolean {
    return existsSync(join(this.dataPath, `session-${id}`));
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
    e.state = { id: e.cfg.id, label: e.cfg.label, state: 'connecting' };
    this.onChange();

    const adapter = new WhatsAppAdapter({
      client: createWaClient({ clientId: id, dataPath: this.dataPath }),
      number: e.cfg,
      onQr: (qr) => {
        void QRCode.toDataURL(qr, { width: 320, margin: 1 }).then((qrDataUrl) => {
          e.state = { ...e.state, state: 'qr', qrDataUrl };
          this.onChange();
        });
      },
      onReady: () => {
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
   * Historical threads are kept in the inbox. Resets to idle so it can re-link.
   */
  async disconnect(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
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
  }
}
