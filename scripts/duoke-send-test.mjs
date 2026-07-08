// SAFE (no send): validate that we can inject text into Duoke's compose box via CDP.
// Sets a benign marker into the currently-open conversation's compose box and reads
// it back. Does NOT press send / Enter. Clear it in Duoke yourself afterwards.
//   CDP_PORT=9333 node scripts/duoke-send-test.mjs

const PORT = process.env.CDP_PORT || 9333;
const MARKER = '✎ Unified Inbox compose-injection test — NOT sent';

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
const evaluate = async (expression) => {
  const res = await call('Runtime.evaluate', { expression, returnByValue: true });
  if (res?.exceptionDetails) return { __err: res.exceptionDetails.text };
  return res?.result?.value;
};

ws.addEventListener('open', async () => {
  await call('Runtime.enable');

  const before = await evaluate(`(() => {
    const ta=[...document.querySelectorAll('textarea.el-textarea__inner')].find(t=>/reply/i.test(t.placeholder)&&(t.offsetWidth||t.offsetHeight));
    return ta ? { found:true, placeholder: ta.placeholder, value: ta.value } : { found:false };
  })()`);
  console.log('compose BEFORE:', JSON.stringify(before));

  const set = await evaluate(`(() => {
    const ta=[...document.querySelectorAll('textarea.el-textarea__inner')].find(t=>/reply/i.test(t.placeholder)&&(t.offsetWidth||t.offsetHeight));
    if(!ta) return { ok:false, err:'compose not found' };
    ta.focus();
    const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    setter.call(ta, ${JSON.stringify(MARKER)});
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    return { ok: ta.value === ${JSON.stringify(MARKER)}, value: ta.value };
  })()`);
  console.log('compose SET result:', JSON.stringify(set));

  console.log('\\nNo send was triggered. Check Duoke — the marker should be sitting in the reply box. Clear it yourself.');
  ws.close();
  process.exit(0);
});
