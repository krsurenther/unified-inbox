// Determine HOW Duoke sends a marketplace reply: a REST POST, or a Tencent-IM
// websocket frame. Records websocket frames (JSON SHAPE only — values replaced by
// types; non-JSON frames recorded as opcode+length, never content) and any POST.
//   open -a Duoke --args --remote-debugging-port=9333  (already running)
//   CDP_PORT=9333 node scripts/duoke-send-capture.mjs   → then send one reply in Duoke

import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;
const OUT = '.capture/duoke-send.json';
mkdirSync('.capture', { recursive: true });

function shape(v, d = 0) {
  if (d > 7) return '…';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shape(v[0], d + 1)] : [];
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = shape(v[k], d + 1);
    return o;
  }
  return typeof v;
}

const out = { wsCreated: [], framesSent: [], framesRecv: [], posts: [] };
const flush = () => {
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`wsCreated:${out.wsCreated.length} sent:${out.framesSent.length} recv:${out.framesRecv.length} posts:${out.posts.length}`);
};

function frameEntry(f) {
  const e = { opcode: f.opcode, len: (f.payloadData || '').length };
  if (f.opcode === 1) {
    try {
      e.shape = shape(JSON.parse(f.payloadData));
    } catch {
      e.json = false; // text but not JSON — content withheld
    }
  }
  return e;
}

const r = await fetch(`http://localhost:${PORT}/json/list`);
const targets = await r.json();
const target = targets.find((t) => t.type === 'page' && /duoke|tongpaidang/i.test(t.url || '')) || targets.find((t) => t.type === 'page');
console.log('attached:', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const send = (m, p = {}) => ws.send(JSON.stringify({ id: ++id, method: m, params: p }));

ws.addEventListener('open', () => {
  send('Network.enable');
  console.log('CAPTURING — now send ONE reply in Duoke.');
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.method) {
    case 'Network.webSocketCreated':
      out.wsCreated.push(msg.params.url.replace(/\?.*/, ''));
      flush();
      break;
    case 'Network.webSocketFrameSent':
      out.framesSent.push(frameEntry(msg.params.response));
      flush();
      break;
    case 'Network.webSocketFrameReceived':
      if (out.framesRecv.length < 40) out.framesRecv.push(frameEntry(msg.params.response));
      break;
    case 'Network.requestWillBeSent': {
      const req = msg.params.request;
      if (req.method === 'POST' && /duoke|tongpaidang/i.test(req.url) && !/events|aegis/.test(req.url)) {
        let bodyShape;
        try {
          bodyShape = shape(JSON.parse(req.postData || '{}'));
        } catch {
          bodyShape = '(non-json)';
        }
        out.posts.push({ url: req.url.replace(/\?.*/, ''), bodyShape });
        flush();
      }
      break;
    }
  }
});
ws.addEventListener('error', (e) => console.error('ws error', e?.message || ''));
