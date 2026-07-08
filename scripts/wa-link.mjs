// Link a WhatsApp number to the app (one-time QR scan). Writes the QR to a PNG
// (refreshed as WhatsApp rotates it) and waits for the scan to complete; the
// session persists under .wwebjs_auth/ so the app can use it without re-scanning.
//   NUMBER_ID=num-1 node scripts/wa-link.mjs

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';

const { Client, LocalAuth } = pkg;
const CLIENT_ID = process.env.NUMBER_ID || 'num-1';
const QR_PATH = join(process.cwd(), '.capture', `wa-qr-${CLIENT_ID}.png`);
mkdirSync(join(process.cwd(), '.capture'), { recursive: true });

function resolveChrome() {
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome');
  for (const v of readdirSync(base).sort().reverse()) {
    const app = join(base, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents');
    const bin = join(app, 'MacOS', 'Google Chrome for Testing');
    const fw = join(app, 'Frameworks', 'Google Chrome for Testing Framework.framework', 'Versions');
    if (existsSync(bin) && existsSync(fw) && readdirSync(fw).some((x) => /^\d/.test(x))) return bin;
  }
  return undefined;
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: CLIENT_ID, dataPath: '.wwebjs_auth' }),
  puppeteer: { headless: true, executablePath: resolveChrome(), args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] },
});

let qrCount = 0;
client.on('qr', async (qr) => {
  qrCount++;
  await QRCode.toFile(QR_PATH, qr, { width: 440, margin: 2 });
  console.log(`QR#${qrCount} ready: ${QR_PATH}`);
});
client.on('authenticated', () => console.log('AUTHENTICATED — scan accepted, finishing...'));
client.on('ready', () => { console.log(`LINKED & READY: ${CLIENT_ID} (session saved).`); process.exit(0); });
client.on('auth_failure', (m) => { console.log('AUTH FAILURE:', m); process.exit(1); });
client.on('disconnected', (r) => { console.log('DISCONNECTED:', r); process.exit(1); });

console.log(`Linking '${CLIENT_ID}' — launching...`);
client.initialize().catch((e) => { console.log('INIT ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT — no scan within 4 minutes.'); process.exit(1); }, 240000);
