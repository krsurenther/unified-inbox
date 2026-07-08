// Locate which conversation a recent outbound message landed in.
//   TEXT="We will try to do better" node scripts/duoke-find-msg.mjs
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const TEXT = process.env.TEXT;
if (!TEXT) { console.error('Set TEXT="..."'); process.exit(1); }

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

const matches = [];
for (const s of shops) {
  const r = await fetch('https://app.duoke.com/api/v1/im/conversation/queryConversationList', {
    method: 'POST', headers: H,
    body: JSON.stringify({ shopIdList: [s.id], filterGroups: [], size: 30, offset: 0, sortModel: '' }),
  });
  const list = (await r.json())?.data?.list || [];
  for (const c of list) {
    const q = new URLSearchParams({ pageNo: '1', pageSize: '6', shopId: s.id, conversationId: c.conversationId, platform: s.platform, language: 'en' });
    const mj = await (await fetch(`https://app.duoke.com/api/v1/im/message/list?${q}`, { headers: H })).json();
    for (const m of (mj?.data?.list || [])) {
      if (m.fromAccountType !== 2) continue;
      let text = '';
      try { text = JSON.parse(m.messageContent).text; } catch { /**/ }
      if (text === TEXT) {
        matches.push({ platform: s.platform, conversationId: c.conversationId, buyerNick: c.buyerNick, messageId: m.messageId, ts: m.createdTimestamp });
      }
    }
  }
}
console.log(JSON.stringify({ text: TEXT, matches }, null, 2));
