// Diagnose why WhatsApp message bodies come back empty. Uses the existing num-1
// session (app must be stopped first — one session, one client).
//   node scripts/wa-diag.mjs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

function resolveChrome() {
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome');
  for (const v of readdirSync(base).sort().reverse()) {
    const app = join(base, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents');
    const bin = join(app, 'MacOS', 'Google Chrome for Testing');
    const fw = join(app, 'Frameworks', 'Google Chrome for Testing Framework.framework', 'Versions');
    if (existsSync(bin) && existsSync(fw) && readdirSync(fw).some((x) => /^\d/.test(x))) return bin;
  }
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'num-1', dataPath: '.wwebjs_auth' }),
  puppeteer: { headless: true, executablePath: resolveChrome(), args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] },
});

client.on('qr', () => { console.log('NOT LINKED (QR shown) — aborting'); process.exit(1); });
client.on('loading_screen', (p) => console.log('loading', p + '%'));
client.on('authenticated', () => console.log('authenticated'));
client.on('change_state', (s) => console.log('state:', s));
client.on('ready', async () => {
  console.log('READY');
  const chats = await client.getChats();
  const suffixes = {};
  for (const c of chats) {
    const s = c.id._serialized.split('@')[1] || '?';
    suffixes[s] = (suffixes[s] || 0) + 1;
  }
  console.log('total chats:', chats.length, '| id suffixes:', JSON.stringify(suffixes));

  const sample = chats.filter((c) => !c.isGroup).slice(0, 6);
  for (const c of sample) {
    console.log(`\n--- ${c.id._serialized} name=${JSON.stringify(c.name)} unread=${c.unreadCount}`);
    try {
      const msgs = await c.fetchMessages({ limit: 4 });
      for (const m of msgs) {
        const d = m._data || {};
        console.log(`   type=${m.type} media=${m.hasMedia} fromMe=${m.fromMe} bodyLen=${(m.body || '').length} | _data.body=${JSON.stringify((d.body || '').slice(0, 30))} caption=${JSON.stringify((d.caption || '').slice(0, 20))} deviceType=${m.deviceType}`);
      }
    } catch (e) {
      console.log('   fetchMessages err:', e.message);
    }
  }
  await client.destroy();
  process.exit(0);
});
client.on('auth_failure', (m) => { console.log('AUTH FAILURE', m); process.exit(1); });
client.initialize().catch((e) => { console.log('INIT ERR', e.message); process.exit(1); });
setTimeout(() => { console.log('timeout (no ready)'); process.exit(1); }, 150000);
