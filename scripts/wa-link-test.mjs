// Validate the whatsapp-web.js + puppeteer stack launches and reaches the QR
// stage. Does NOT link anything (no scan). Uses a throwaway session id.
//   node scripts/wa-link-test.mjs

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

function resolveChrome() {
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome');
  for (const v of readdirSync(base).sort().reverse()) {
    const bin = join(base, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    const fw = join(base, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'Frameworks', 'Google Chrome for Testing Framework.framework', 'Versions');
    if (existsSync(bin) && existsSync(fw) && readdirSync(fw).some((x) => /^\d/.test(x))) return bin;
  }
  throw new Error('no complete chrome in puppeteer cache');
}

const executablePath = resolveChrome();
console.log('using chrome:', executablePath.split('/').slice(-6, -5)[0] || executablePath);

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'stack-test', dataPath: '.wwebjs_auth' }),
  puppeteer: { headless: true, executablePath, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', (qr) => { console.log(`QR received (length ${qr.length}) — stack works.`); client.destroy().then(() => process.exit(0)); });
client.on('ready', () => { console.log('READY (session already linked).'); client.destroy().then(() => process.exit(0)); });
client.on('auth_failure', (m) => { console.log('AUTH FAILURE:', m); process.exit(1); });
client.on('loading_screen', (p, m) => console.log('loading:', p, m));

console.log('initializing (launching Chromium + WhatsApp Web)...');
client.initialize().catch((e) => { console.log('INIT ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT (no qr/ready in 75s)'); process.exit(1); }, 75000);
