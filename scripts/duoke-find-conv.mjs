// Find a Duoke conversation by buyerId or buyer nick (for send verification).
//   BUYER=300015276982 node scripts/duoke-find-conv.mjs
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const BUYER = process.env.BUYER;
if (!BUYER) { console.error('Set BUYER=<buyerId or nick>'); process.exit(1); }

const src = join(homedir(), 'Library', 'Application Support', 'Duoke', 'Cookies');
const tmp = mkdtempSync(join(tmpdir(), 'dk-'));
const cp = join(tmp, 'Cookies');
copyFileSync(src, cp);
const db = new DatabaseSync(cp);
const token = db.prepare("SELECT value FROM cookies WHERE name='token' AND host_key LIKE '%duoke%' AND value<>'' ORDER BY LENGTH(value) DESC LIMIT 1").get()?.value;
db.close();
rmSync(tmp, { recursive: true, force: true });

const H = { Cookie: `token=${token}`, token, Referer: 'https://app.duoke.com/', Origin: 'https://app.duoke.com', 'Content-Type': 'application/json', Accept: 'application/json' };
const shops = (await (await fetch('https://app.duoke.com/api/v1/shop/', { headers: H })).json())?.data?.shops || [];

for (const s of shops) {
  const r = await fetch('https://app.duoke.com/api/v1/im/conversation/queryConversationList', {
    method: 'POST', headers: H,
    body: JSON.stringify({ shopIdList: [s.id], filterGroups: [], size: 50, offset: 0, sortModel: '' }),
  });
  const list = (await r.json())?.data?.list || [];
  const hit = list.find((c) => String(c.buyerId) === BUYER || (c.buyerNick || '').toLowerCase().includes(BUYER.toLowerCase()));
  if (hit) {
    console.log(JSON.stringify({ found: true, platform: s.platform, shopId: s.id, conversationId: hit.conversationId, buyerNick: hit.buyerNick, buyerId: hit.buyerId, unread: hit.unReadCount }, null, 2));
    process.exit(0);
  }
}
console.log(JSON.stringify({ found: false, buyer: BUYER }));
