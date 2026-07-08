// Verify the latest outbound message in a Duoke conversation (post-send check).
//   CONV=... SHOP=... PLATFORM=lazada EXPECT="text" node scripts/duoke-verify-last.mjs
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const { CONV, SHOP, PLATFORM, EXPECT } = process.env;
const src = join(homedir(), 'Library', 'Application Support', 'Duoke', 'Cookies');
const tmp = mkdtempSync(join(tmpdir(), 'dk-'));
const cp = join(tmp, 'Cookies');
copyFileSync(src, cp);
const db = new DatabaseSync(cp);
const token = db.prepare("SELECT value FROM cookies WHERE name='token' AND host_key LIKE '%duoke%' AND value<>'' ORDER BY LENGTH(value) DESC LIMIT 1").get()?.value;
db.close();
rmSync(tmp, { recursive: true, force: true });

const H = { Cookie: `token=${token}`, token, Referer: 'https://app.duoke.com/', Origin: 'https://app.duoke.com', Accept: 'application/json' };
const q = new URLSearchParams({ pageNo: '1', pageSize: '10', shopId: SHOP, conversationId: CONV, platform: PLATFORM, language: 'en' });
const j = await (await fetch(`https://app.duoke.com/api/v1/im/message/list?${q}`, { headers: H })).json();
const out = (j?.data?.list || []).filter((m) => m.fromAccountType === 2);
const newest = out[0];
let text = '';
try { text = JSON.parse(newest.messageContent).text; } catch { /**/ }
console.log(JSON.stringify({ latestOutboundMessageId: newest?.messageId, text, ts: newest?.createdTimestamp, canRecall: newest?.canRecall, notRecallReason: newest?.notRecallReason, matchesExpected: EXPECT ? text === EXPECT : undefined }, null, 2));
