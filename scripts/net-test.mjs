import { app, net } from 'electron';
const to = (p, ms, l) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(l + ' timeout')), ms))]);
app.whenReady().then(async () => {
  console.log('WHENREADY');
  try { const r = await to(net.fetch('https://app.duoke.com/api/v1/health'), 8000, 'net'); console.log('NETFETCH ok', r.status); } catch (e) { console.log('NETFETCH ERR', e.message); }
  try { const r = await to(fetch('https://app.duoke.com/api/v1/health'), 8000, 'g'); console.log('GLOBAL ok', r.status); } catch (e) { console.log('GLOBAL ERR', e.message, e.cause?.code || ''); }
  app.quit();
}).catch((e) => { console.log('READYERR', e.message); app.quit(); });
setTimeout(() => { console.log('HARDTIMEOUT'); app.quit(); }, 22000);
