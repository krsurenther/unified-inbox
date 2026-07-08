// Read-only probe: validates that we can call Duoke's backend from Node using the
// stored token, and reveals the auth mechanism + buyer/seller direction mapping.
// Prints METADATA ONLY (types, lengths, ids) — never buyer names or message text.
//   node scripts/duoke-probe.mjs

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function readToken() {
  const src = join(homedir(), 'Library', 'Application Support', 'Duoke', 'Cookies');
  const tmp = mkdtempSync(join(tmpdir(), 'dk-'));
  const cp = join(tmp, 'Cookies');
  copyFileSync(src, cp);
  const db = new DatabaseSync(cp);
  const r = db
    .prepare("SELECT value FROM cookies WHERE name='token' AND host_key LIKE '%duoke%' AND value<>'' ORDER BY LENGTH(value) DESC LIMIT 1")
    .get();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  return r?.value;
}

const token = readToken();
if (!token) {
  console.log('NO TOKEN');
  process.exit(1);
}
const BASE = 'https://app.duoke.com';
const H = {
  Cookie: `token=${token}`,
  token,
  Referer: 'https://app.duoke.com/',
  Origin: 'https://app.duoke.com',
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 Duoke/1.2.3',
};
const get = async (p) => {
  const r = await fetch(BASE + p, { headers: H });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { /**/ }
  return { status: r.status, j, t: t.slice(0, 160) };
};
const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { /**/ }
  return { status: r.status, j, t: t.slice(0, 160) };
};

const main = async () => {
  const shops = await get('/api/v1/shop/');
  console.log('SHOP:', shops.status, 'code=', shops.j?.code);
  const list = shops.j?.data?.shops ?? [];
  console.log('shops:', list.map((s) => ({ platform: s.platform, country: s.country, idLen: (s.id || '').length })));
  if (!list.length) {
    console.log('AUTH FAILED or no shops. body:', shops.t);
    return;
  }

  // Aggregate sender types + content formats across several conversations from each shop.
  const shapeKeys = (s) => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === 'object' ? `json{${Object.keys(o).slice(0, 12).join(',')}}` : `json:${typeof o}`;
    } catch {
      return 'plaintext';
    }
  };
  const stats = new Map(); // fromAccountType -> {count, types:Set, dk:Set, contentFmt:Set, textField:Set}
  let scanned = 0;

  for (const shop of list) {
    const conv = await post('/api/v1/im/conversation/queryConversationList', {
      shopIdList: [shop.id], filterGroups: [], size: 10, offset: 0, sortModel: '',
    });
    for (const c of conv.j?.data?.list ?? []) {
      if (scanned >= 12) break;
      scanned++;
      const q = new URLSearchParams({ pageNo: '1', pageSize: '30', shopId: c.shopId, conversationId: c.conversationId, platform: c.platform, language: 'en' }).toString();
      const msgs = await get('/api/v1/im/message/list?' + q);
      for (const m of msgs.j?.data?.list ?? []) {
        const k = m.fromAccountType;
        const s = stats.get(k) ?? { count: 0, types: new Set(), dk: new Set(), contentFmt: new Set(), textField: new Set() };
        s.count++;
        s.types.add(m.messageType);
        s.dk.add(m.dkMessageType);
        if (m.messageContent) s.contentFmt.add(shapeKeys(m.messageContent));
        if (m.cloudCustomData?.text) s.textField.add('cloudCustomData.text');
        stats.set(k, s);
      }
    }
  }
  console.log(`\nscanned ${scanned} conversations. fromAccountType map:`);
  for (const [k, s] of [...stats.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  fromAccountType=${k}: n=${s.count} types=[${[...s.types]}] dk=[${[...s.dk]}] contentFmt=[${[...s.contentFmt]}] textIn=[${[...s.textField]}]`);
  }
};
main().catch((e) => console.log('ERR', e.message));
