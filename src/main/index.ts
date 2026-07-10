import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { setDefaultResultOrder } from 'node:dns';
import { join } from 'node:path';

// app.duoke.com publishes unreachable IPv6 (AAAA) records; Electron's Node hangs
// on IPv6 before falling back. Prefer IPv4 so fetch connects reliably (reads +
// the localhost CDP send driver).
setDefaultResultOrder('ipv4first');
import { InboxStore } from '../core/store/InboxStore';
import { InboxService, type InboundEvent } from '../core/InboxService';
import { LlmRouter } from '../core/llm/LlmRouter';
import { EchoProvider } from '../core/llm/EchoProvider';
import { OllamaProvider } from '../core/llm/OllamaProvider';
import { FakeAdapter } from '../core/channels/FakeAdapter';
import { DuokeClient } from '../core/channels/duoke/DuokeClient';
import { createDuokeAdapters, type DuokeAdapter } from '../core/channels/duoke/DuokeAdapter';
import { DuokeSendDriver } from '../core/channels/duoke/DuokeSendDriver';
import { AppConfigSchema, type AppConfig } from '../core/config/Config';
import { WhatsAppManager } from './WhatsAppManager';

let service: InboxService;
let store: InboxStore;
let config: AppConfig;
let fake: FakeAdapter;
let simSeq = 0;
let win: BrowserWindow | undefined;
let waManager: WhatsAppManager | undefined;
let duokeClient: DuokeClient | undefined;
let duokeSendDriver: DuokeSendDriver | undefined;
const duokeChannelIds: string[] = [];
const duokeAdapters: DuokeAdapter[] = [];
let duokeBooting = false;
let duokeTick = false;
let syncTimer: ReturnType<typeof setInterval> | undefined;

// Seed data so the inbox demonstrates the pipeline on first launch.
const DEMO_INBOUND = [
  {
    threadKey: 'wa-60123456789',
    from: { externalId: '60123456789', name: 'Aisha Rahman' },
    body: 'Hi! Is the red 500ml tumbler still available? I need 2 before Friday 🙏',
  },
  {
    threadKey: 'shopee-88231',
    from: { externalId: 'buyer_88231', name: 'kael***ng' },
    body: 'Order #88231 — can I still change the delivery address? I moved last week.',
  },
  {
    threadKey: 'web-visitor-7',
    from: { externalId: 'visitor-7', name: 'Web visitor' },
    body: 'Do you ship to Sabah, and how long does delivery usually take?',
  },
];

const SIM_POOL = [
  { name: 'Daniel Lim', body: 'Is there a warranty on the stainless steel bottles?' },
  { name: 'Priya N.', body: 'My order arrived but one item is missing — can you help?' },
  { name: 'Hafiz', body: 'Do you have the matte black version in stock?' },
  { name: 'Mei Ling', body: 'Can I self-collect from your store today?' },
];

async function bootCore(): Promise<void> {
  config = AppConfigSchema.parse({
    defaultProvider: 'ollama',
    channels: { 'fake:demo': { llm: 'echo', autoSend: false } },
    whatsapp: {
      numbers: [
        { id: 'num-1', label: 'WhatsApp · 1' },
        { id: 'num-2', label: 'WhatsApp · 2' },
        { id: 'num-3', label: 'WhatsApp · 3' },
      ],
    },
  });

  const dbPath = join(app.getPath('userData'), 'inbox.sqlite');
  store = new InboxStore(dbPath);
  const router = new LlmRouter(config, {
    echo: new EchoProvider(),
    ollama: new OllamaProvider({ baseUrl: process.env.OLLAMA_BASE_URL, model: process.env.OLLAMA_MODEL }),
  });
  service = new InboxService({ store, router, config, onInbound: notifyInbound });

  fake = new FakeAdapter({ id: 'fake:demo', label: 'Demo channel' });
  service.registerChannel(fake);
  await service.start();

  if (service.listThreads().length === 0) {
    for (const m of DEMO_INBOUND) await fake.inject(m);
  }

  // Sweep junk that was stored before the live-path status/newsletter filter existed.
  const swept = store.deleteThreadsByKey('status@broadcast');
  if (swept.threads) console.log(`[inbox] swept ${swept.threads} status thread(s), ${swept.messages} messages`);
}

/**
 * Connect Duoke (Lazada/TikTok/Shopee) by reusing its stored session token.
 * Read-only extraction for now — send stays gated. Runs in the background so the
 * window shows immediately; marketplace threads stream in as they sync.
 */
async function bootDuoke(): Promise<void> {
  if (duokeBooting || duokeChannelIds.length) return; // already booting / connected
  duokeBooting = true;
  try {
    duokeClient = new DuokeClient();
    if (!duokeClient.hasToken()) {
      console.log('[duoke] not logged in (no token) — skipping marketplace channels');
      return;
    }
    const adapters = await createDuokeAdapters(duokeClient, { pageSize: 10 });
    for (const a of adapters) {
      service.registerChannel(a);
      duokeChannelIds.push(a.channel.id);
      duokeAdapters.push(a);
    }
    console.log(`[duoke] ${adapters.length} shops:`, adapters.map((a) => a.channel.label).join(', '));
    await syncDuoke();
    await ensureDuokeSend();
  } catch (e) {
    console.error('[duoke] setup failed:', (e as Error).message);
  } finally {
    duokeBooting = false;
  }
}

/**
 * Connect the CDP send driver (needs Duoke running with --remote-debugging-port)
 * and attach it to the Duoke adapters. Retryable + idempotent, so the interval can
 * call it — send self-heals once Duoke's debug port comes up.
 */
async function ensureDuokeSend(): Promise<void> {
  if (duokeSendDriver || duokeAdapters.length === 0) return;
  const port = Number(process.env.UNIFIED_INBOX_DUOKE_PORT ?? 9333);
  try {
    const driver = new DuokeSendDriver({ port });
    await driver.connect();
    duokeSendDriver = driver;
    for (const a of duokeAdapters) a.setSendDriver(driver);
    console.log(`[duoke] send ENABLED via CDP on :${port}`);
  } catch {
    // Duoke not on the debug port yet — stay read-only; the interval retries.
  }
}

async function syncDuoke(): Promise<void> {
  for (const id of duokeChannelIds) {
    try {
      const r = await service.syncChannel(id);
      console.log(`[duoke] synced ${id}: ${r.threads} threads, +${r.messages} messages`);
    } catch (e) {
      console.error(`[duoke] sync ${id} failed:`, (e as Error).message);
    }
  }
}

/** Reflect total unread onto the macOS dock badge. */
function updateBadge(): void {
  if (process.platform !== 'darwin') return;
  const n = store.totalUnread();
  app.dock?.setBadge(n > 0 ? String(n) : '');
}

/** Notify the team of a fresh inbound (and keep the badge current). */
function notifyInbound(e: InboundEvent): void {
  updateBadge();
  // G2: only messages fresher than 10 min — suppresses the notification storm when
  // a number links or a channel backfills its history.
  if (Date.now() - new Date(e.at).getTime() > 10 * 60_000) return;
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: `${e.customerName} · ${e.channelLabel}`, body: e.body.slice(0, 120) });
  note.on('click', () => {
    win?.show();
    win?.focus();
    win?.webContents.send('inbox:select', e.threadId);
  });
  note.show();
}

function registerIpc(): void {
  ipcMain.handle('inbox:listThreads', () => service.listThreads());
  ipcMain.handle('inbox:getHistory', (_e, threadId: string) => service.getHistory(threadId));
  ipcMain.handle('inbox:markRead', (_e, threadId: string) => {
    service.markRead(threadId);
    updateBadge();
  });
  ipcMain.handle('inbox:regenerateDraft', (_e, threadId: string) => service.generateDraft(threadId));
  ipcMain.handle('inbox:approveAndSend', async (_e, threadId: string, body: string) => {
    const r = await service.approveAndSend(threadId, { body, approvedBy: 'human:ui' });
    updateBadge(); // the outbound cleared this thread's unread
    return r;
  });
  ipcMain.handle('inbox:simulateIncoming', async () => {
    const pick = SIM_POOL[simSeq++ % SIM_POOL.length]!;
    await fake.inject({
      threadKey: `sim-${Date.now()}-${simSeq}`,
      from: { externalId: `sim-${simSeq}`, name: pick.name },
      body: pick.body,
    });
  });
  ipcMain.handle('wa:list', () => waManager?.list() ?? []);
  ipcMain.handle('wa:connect', (_e, id: string) => waManager?.connect(id));
  ipcMain.handle('wa:disconnect', (_e, id: string) => waManager?.disconnect(id));
  ipcMain.handle('wa:guardStatus', () => waManager?.guardStatus() ?? { killed: false, numbers: [] });
  ipcMain.handle('wa:setKill', (_e, on: boolean) => {
    waManager?.setKillSwitch(on);
    return waManager?.guardStatus() ?? { killed: false, numbers: [] };
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    show: false,
    title: 'Unified Inbox',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  });

  win.on('ready-to-show', () => win.show());
  win.on('closed', () => { win = undefined; }); // stop sending to a destroyed window (macOS)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  await bootCore();
  registerIpc();
  createWindow();
  updateBadge(); // reflect any already-unread threads on launch
  // WhatsApp: per-number clients; linked sessions auto-start, others link in-app.
  waManager = new WhatsAppManager({
    service,
    numbers: config.whatsapp.numbers,
    dataPath: join(process.cwd(), '.wwebjs_auth'),
    dailyCap: config.whatsapp.dailyCap,
    initialKilled: store.getSetting('wa.kill') === '1', // restore across restarts
    onKillChange: (on) => store.setSetting('wa.kill', on ? '1' : '0'),
    onChange: () => win?.webContents.send('wa:update', waManager?.list() ?? []),
  });
  waManager.autoStartLinked();
  // Connect Duoke in the background, then keep it fresh.
  void bootDuoke();
  syncTimer = setInterval(() => {
    if (duokeTick) return; // single-flight: a slow sync must not stack another tick
    duokeTick = true;
    const work = duokeChannelIds.length
      ? syncDuoke().then(() => ensureDuokeSend()) // self-heal send once the debug port is up
      : bootDuoke(); // self-heal after a transient blip / late login
    void work.catch(() => {}).finally(() => { duokeTick = false; });
  }, 60_000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault(); // let adapters (WA Chromes) tear down + DB close before exit
  quitting = true;
  if (syncTimer) clearInterval(syncTimer);
  duokeSendDriver?.close();
  const force = setTimeout(() => app.exit(0), 5000); // never hang on a slow Chrome teardown
  void service
    .dispose()
    .catch((err) => console.error('[quit] dispose:', (err as Error).message))
    .finally(() => { clearTimeout(force); app.exit(0); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
