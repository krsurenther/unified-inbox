import { app } from 'electron';
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');
app.whenReady().then(async () => {
  const t0 = Date.now();
  try {
    const r = await fetch('http://localhost:11434/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gemma3:4b', messages: [{ role: 'user', content: 'Reply with exactly: hello there friend' }], stream: false }) });
    const j = await r.json();
    console.log('OLLAMA ok in', Math.round((Date.now() - t0) / 1000) + 's:', JSON.stringify(j.message?.content));
  } catch (e) { console.log('OLLAMA ERR:', e.message, '|', e.cause?.code || ''); }
  app.quit();
});
setTimeout(() => { console.log('HARDTIMEOUT'); app.quit(); }, 30000);
