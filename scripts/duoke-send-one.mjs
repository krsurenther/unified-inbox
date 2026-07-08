// GUARDED send tool. Reads Duoke's CURRENT active conversation id from its Vuex
// store (state.Chat.conversationId) and refuses to send unless it equals
// TARGET_CONV. Confirms delivery via the read API afterwards.
//
//   TARGET_CONV=<id> SHOP=<id> PLATFORM=lazada MSG="reply" CDP_PORT=9333 node scripts/duoke-send-one.mjs        # dry run
//   ...add SEND=1 to actually send.
//
// Have the TARGET conversation OPEN (active) in Duoke before running.

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const { TARGET_CONV, SHOP, PLATFORM, MSG } = process.env;
const PORT = process.env.CDP_PORT || 9333;
const DO_SEND = process.env.SEND === '1';
for (const [k, v] of Object.entries({ TARGET_CONV, SHOP, PLATFORM, MSG })) {
  if (!v) { console.error(`Missing env ${k}`); process.exit(1); }
}

function readToken() {
  const src = join(homedir(), 'Library', 'Application Support', 'Duoke', 'Cookies');
  const tmp = mkdtempSync(join(tmpdir(), 'dk-'));
  const cp = join(tmp, 'Cookies');
  copyFileSync(src, cp);
  const db = new DatabaseSync(cp);
  const t = db.prepare("SELECT value FROM cookies WHERE name='token' AND host_key LIKE '%duoke%' AND value<>'' ORDER BY LENGTH(value) DESC LIMIT 1").get()?.value;
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  return t;
}
const TOKEN = readToken();
const H = { Cookie: `token=${TOKEN}`, token: TOKEN, Referer: 'https://app.duoke.com/', Origin: 'https://app.duoke.com', Accept: 'application/json' };
const outbound = async () => {
  const q = new URLSearchParams({ pageNo: '1', pageSize: '20', shopId: SHOP, conversationId: TARGET_CONV, platform: PLATFORM, language: 'en' });
  const j = await (await fetch(`https://app.duoke.com/api/v1/im/message/list?${q}`, { headers: H })).json();
  return (j?.data?.list || []).filter((m) => m.fromAccountType === 2);
};

// Reads the active conversation id straight from Duoke's Vuex store.
const CUR = `(() => { let s=null; for (const el of document.querySelectorAll('*')) { if (el.__vue__ && el.__vue__.$store) { s = el.__vue__.$store; break; } } return s && s.state && s.state.Chat ? s.state.Chat.conversationId : null; })()`;
const COMPOSE = `[...document.querySelectorAll('textarea.el-textarea__inner')].find(t=>/reply/i.test(t.placeholder)&&(t.offsetWidth||t.offsetHeight))`;

const res = await fetch(`http://localhost:${PORT}/json/list`);
const targets = await res.json();
const target = targets.find((t) => t.type === 'page' && /duoke|tongpaidang/i.test(t.url || '')) || targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r?.result?.result?.value; };
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });

ws.addEventListener('open', async () => {
  await cmd('Runtime.enable');
  console.log(`Mode: ${DO_SEND ? 'SEND' : 'DRY RUN'} | target=${TARGET_CONV}`);

  const cur = await evaluate(CUR);
  console.log(`Active conversation in Duoke: ${cur}`);
  if (cur !== TARGET_CONV) {
    console.error(`REFUSED: the open conversation is ${cur}, not the target ${TARGET_CONV}. Open the target in Duoke, then rerun.`);
    process.exit(1);
  }
  console.log('Verified: target conversation is the active one.');

  const setOk = await evaluate(`(() => { const ta=${COMPOSE}; if(!ta) return false; ta.focus(); const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; s.call(ta, ${JSON.stringify(MSG)}); ta.dispatchEvent(new Event('input',{bubbles:true})); return ta.value===${JSON.stringify(MSG)}; })()`);
  console.log(`Compose set: ${setOk}. Message: ${JSON.stringify(MSG)}`);
  if (!DO_SEND) { console.log('DRY RUN — not sent. Add SEND=1 to send.'); process.exit(0); }

  const cur2 = await evaluate(CUR);
  if (cur2 !== TARGET_CONV) { console.error(`REFUSED at send time: active conversation changed to ${cur2}.`); process.exit(1); }
  const before = new Set((await outbound()).map((m) => m.messageId));
  console.log('SENDING (Enter)...');
  await evaluate(`(() => { const ta=${COMPOSE}; ta.focus(); for(const t of ['keydown','keypress','keyup']) ta.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true})); return true; })()`);

  let ok = null;
  for (let i = 0; i < 8 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 900));
    ok = (await outbound()).find((m) => { let t = ''; try { t = JSON.parse(m.messageContent).text; } catch { /**/ } return !before.has(m.messageId) && t === MSG; });
  }
  console.log(ok ? `CONFIRMED in target conversation. messageId=${ok.messageId}` : 'WARNING: could not confirm in the target conversation — check Duoke.');
  process.exit(0);
});
