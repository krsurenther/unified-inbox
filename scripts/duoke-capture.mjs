// Duoke endpoint-capture harness (recon, read-only).
//
// Launch Duoke with CDP first:
//   open -a Duoke --args --remote-debugging-port=9222
// then run:
//   node scripts/duoke-capture.mjs
//
// It attaches to Duoke's Chromium via the DevTools Protocol (Node's built-in
// WebSocket — no dependencies) and records the DISTINCT API endpoints it calls
// plus the SHAPE of each request/response (every string/number leaf replaced by
// its type). It never stores message text, customer PII, or the auth token.
// Output: .capture/duoke-endpoints.json  (gitignored)

import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9222;
const OUT_DIR = '.capture';
const OUT_FILE = `${OUT_DIR}/duoke-endpoints.json`;
// API hosts we care about (exclude static asset/cdn hosts).
const API_HOST = /\b(app|cn-app|global-app|ac|im|cn-im|global-im|events)\.(duoke|tongpaidang)\.com\b/i;

/** Replace every leaf value with its type name so we keep structure, not content. */
function shapeOf(v, depth = 0) {
  if (depth > 8) return '…';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = shapeOf(v[k], depth + 1);
    return o;
  }
  return typeof v;
}

async function findTarget() {
  const res = await fetch(`http://localhost:${PORT}/json/list`);
  const targets = await res.json();
  return (
    targets.find((t) => t.type === 'page' && /duoke|tongpaidang/i.test(t.url || '')) ||
    targets.find((t) => t.type === 'page')
  );
}

const endpoints = new Map(); // "METHOD origin+path" -> details
const sockets = new Set();

function record(meta, status, mime, bodyText) {
  let u;
  try {
    u = new URL(meta.url);
  } catch {
    return;
  }
  const key = `${meta.method} ${u.origin}${u.pathname}`;
  const e = endpoints.get(key) || {
    endpoint: key,
    count: 0,
    queryKeys: new Set(),
    status,
    mime,
    reqShape: null,
    respShape: null,
  };
  e.count++;
  for (const k of u.searchParams.keys()) e.queryKeys.add(k);
  if (meta.postData && !e.reqShape) {
    try {
      e.reqShape = shapeOf(JSON.parse(meta.postData));
    } catch {
      e.reqShape = '(non-json body)';
    }
  }
  if (bodyText && !e.respShape && /json/i.test(mime || '')) {
    try {
      e.respShape = shapeOf(JSON.parse(bodyText));
    } catch {
      /* ignore non-json */
    }
  }
  endpoints.set(key, e);
  flush();
}

function flush() {
  const out = [...endpoints.values()].map((e) => ({
    endpoint: e.endpoint,
    count: e.count,
    queryKeys: [...e.queryKeys],
    status: e.status,
    mime: e.mime,
    reqShape: e.reqShape,
    respShape: e.respShape,
  }));
  writeFileSync(OUT_FILE, JSON.stringify({ webSockets: [...sockets], endpoints: out }, null, 2));
  console.log(`captured ${out.length} REST endpoints, ${sockets.size} websockets`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let target;
  for (let i = 0; i < 30 && !target; i++) {
    try {
      target = await findTarget();
    } catch {
      /* retry */
    }
    if (!target) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!target) {
    console.error(`No CDP target on :${PORT}. Launch Duoke with --remote-debugging-port=${PORT}`);
    process.exit(1);
  }
  console.log('attached:', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const reqMeta = new Map();
  const bodyWaiters = new Map();
  const send = (method, params = {}) => {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params }));
    return mid;
  };

  ws.addEventListener('open', () => {
    send('Network.enable');
    console.log('Network capture ON — interact with Duoke (open a conversation / switch marketplace tabs).');
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.method) {
      case 'Network.webSocketCreated':
        if (API_HOST.test(msg.params.url)) {
          sockets.add(msg.params.url.replace(/\?.*$/, ''));
          flush();
        }
        break;
      case 'Network.requestWillBeSent': {
        const r = msg.params.request;
        if (API_HOST.test(r.url)) reqMeta.set(msg.params.requestId, { method: r.method, url: r.url, postData: r.postData });
        break;
      }
      case 'Network.responseReceived': {
        const m = reqMeta.get(msg.params.requestId);
        if (m) {
          m.status = msg.params.response.status;
          m.mime = msg.params.response.mimeType;
        }
        break;
      }
      case 'Network.loadingFinished': {
        const m = reqMeta.get(msg.params.requestId);
        if (m) {
          const bid = send('Network.getResponseBody', { requestId: msg.params.requestId });
          bodyWaiters.set(bid, m);
        }
        break;
      }
      default:
        if (msg.id && bodyWaiters.has(msg.id)) {
          const m = bodyWaiters.get(msg.id);
          bodyWaiters.delete(msg.id);
          let body;
          if (msg.result && typeof msg.result.body === 'string') {
            body = msg.result.base64Encoded ? Buffer.from(msg.result.body, 'base64').toString('utf8') : msg.result.body;
          }
          record(m, m.status, m.mime, body);
        }
    }
  });

  ws.addEventListener('error', (e) => console.error('ws error:', e?.message || 'unknown'));
  ws.addEventListener('close', () => console.log('CDP socket closed.'));
  process.on('SIGINT', () => {
    flush();
    console.log('saved', OUT_FILE);
    process.exit(0);
  });
}

main();
