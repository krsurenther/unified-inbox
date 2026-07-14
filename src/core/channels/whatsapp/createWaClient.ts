// whatsapp-web.js is CommonJS — must be imported via the default export under ESM.
import wweb from 'whatsapp-web.js';
import { readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveChromeExecutable } from './resolveChrome';
import type { WaClient } from './wa-types';

const { Client, LocalAuth } = wweb;

export interface CreateWaClientOptions {
  /** Stable per-number id (e.g. 'num-1'); LocalAuth persists the session under it. */
  clientId: string;
  dataPath?: string;
  headless?: boolean;
}

/**
 * Remove Chrome's single-instance locks left behind when a prior run was killed
 * (force-quit / crash) instead of shutting down cleanly. Only clears a lock whose
 * owning process is actually dead — so it never disturbs a live instance. Without
 * this, puppeteer refuses to launch with "browser is already running for <session>".
 */
export function clearStaleChromeLocks(sessionDir: string): void {
  let owner: string;
  try {
    owner = readlinkSync(join(sessionDir, 'SingletonLock')); // e.g. "Hosts-Mac.local-60671"
  } catch {
    return; // no lock (or not a symlink) → nothing to clear
  }
  const pid = Number(owner.split('-').pop());
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0); // signal 0 = liveness probe; throws ESRCH if the process is gone
      return; // owner still alive — leave the lock alone
    } catch {
      /* ESRCH → dead owner, fall through and clear */
    }
  }
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(join(sessionDir, f), { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Construct a real whatsapp-web.js Client and present it as the adapter's `WaClient`.
 * Session persists via LocalAuth (scan the QR once per number).
 */
export function createWaClient(opts: CreateWaClientOptions): WaClient {
  const executablePath = resolveChromeExecutable();
  const dataPath = opts.dataPath ?? '.wwebjs_auth';
  clearStaleChromeLocks(join(dataPath, `session-${opts.clientId}`)); // self-heal after a crash/force-quit
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: opts.clientId, dataPath }),
    puppeteer: {
      headless: opts.headless ?? true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });
  return client as unknown as WaClient;
}
