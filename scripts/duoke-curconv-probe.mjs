// Read-only: try to read Duoke's CURRENTLY-open conversationId from its Vue state /
// DOM, so the send guard doesn't depend on a fresh network call.
//   CDP_PORT=9333 node scripts/duoke-curconv-probe.mjs

const PORT = process.env.CDP_PORT || 9333;
const expr = `(() => {
  const hits = [];
  const seen = new Set();
  const check = (obj, where) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (/conversationId|currentConversation|activeConversation|curConv|conversationInfo|currentSession|activeSession/i.test(k)) {
        let v = obj[k];
        if (v && typeof v === 'object') v = v.conversationId || v.id || JSON.stringify(v).slice(0, 80);
        if (v && !seen.has(where + k + v)) { seen.add(where + k + v); hits.push({ where, key: k, val: String(v).slice(0, 80) }); }
      }
    }
  };
  let scanned = 0;
  for (const el of document.querySelectorAll('*')) {
    const vm = el.__vue__;
    if (!vm) continue;
    scanned++;
    check(vm.$data, 'data');
    check(vm.$props, 'props');
    if (scanned > 6000) break;
  }
  // Vuex store: where SPAs usually keep "current conversation".
  let store = null;
  for (const el of document.querySelectorAll('*')) { if (el.__vue__ && el.__vue__.$store) { store = el.__vue__.$store; break; } }
  const chat = store && store.state && store.state.Chat;
  const chatTop = {};
  if (chat) {
    for (const k of Object.keys(chat)) {
      const v = chat[k];
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) chatTop[k] = String(v).slice(0, 90);
      else if (Array.isArray(v)) chatTop[k] = 'array:' + v.length;
      else chatTop[k] = 'obj:' + Object.keys(v || {}).slice(0, 8).join(',');
    }
  }
  // does the active session carry a flag?
  const sessionFlags = (chat && Array.isArray(chat.sessions) ? chat.sessions.slice(0, 3) : []).map((s) => Object.keys(s || {}).filter((k) => /active|select|current|focus|show/i.test(k)));
  return JSON.stringify({ foundStore: !!store, chatTop, sessionFlagKeys: sessionFlags });
})()`;

const r = await fetch(`http://localhost:${PORT}/json/list`);
const targets = await r.json();
const target = targets.find((t) => t.type === 'page' && /duoke|tongpaidang/i.test(t.url || '')) || targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
ws.addEventListener('open', async () => {
  await call('Runtime.enable');
  const res = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(res?.result?.value ? JSON.stringify(JSON.parse(res.result.value), null, 2) : JSON.stringify(res));
  ws.close();
  process.exit(0);
});
