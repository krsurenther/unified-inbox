// whatsapp-web.js is CommonJS — must be imported via the default export under ESM.
import wweb from 'whatsapp-web.js';
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
 * Construct a real whatsapp-web.js Client and present it as the adapter's `WaClient`.
 * Session persists via LocalAuth (scan the QR once per number).
 */
export function createWaClient(opts: CreateWaClientOptions): WaClient {
  const executablePath = resolveChromeExecutable();
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: opts.clientId, dataPath: opts.dataPath ?? '.wwebjs_auth' }),
    puppeteer: {
      headless: opts.headless ?? true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });
  return client as unknown as WaClient;
}
