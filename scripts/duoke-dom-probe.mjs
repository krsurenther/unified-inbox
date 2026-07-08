// Read-only: inspect Duoke's chat compose UI via CDP to gauge send-automation
// feasibility. Returns element metadata only (classes/placeholders), no content.
//   CDP_PORT=9333 node scripts/duoke-dom-probe.mjs

const PORT = process.env.CDP_PORT || 9333;

const expr = `(() => {
  const cut = (s) => (s || '').toString().slice(0, 70);
  const textareas = [...document.querySelectorAll('textarea')].map((t) => ({ placeholder: cut(t.placeholder), cls: cut(t.className), visible: !!(t.offsetWidth || t.offsetHeight) }));
  const editables = [...document.querySelectorAll('[contenteditable="true"]')].map((e) => ({ cls: cut(e.className), visible: !!(e.offsetWidth || e.offsetHeight) }));
  const buttons = [...document.querySelectorAll('button,[role=button],.btn,[class*=send]')]
    .map((b) => ({ text: cut(b.textContent).trim(), cls: cut(b.className), title: cut(b.title) }))
    .filter((b) => /send|发送|reply|回复|提交/i.test(b.text + ' ' + b.cls + ' ' + b.title));
  return JSON.stringify({ url: location.hash, textareas, editables, sendButtons: buttons });
})()`;

const r = await fetch(`http://localhost:${PORT}/json/list`);
const targets = await r.json();
const target = targets.find((t) => t.type === 'page' && /duoke|tongpaidang/i.test(t.url || '')) || targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
});

ws.addEventListener('open', async () => {
  await call('Runtime.enable');
  const res = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(JSON.stringify(res?.result?.value ? JSON.parse(res.result.value) : res, null, 2));
  ws.close();
  process.exit(0);
});
