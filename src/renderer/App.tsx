import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message, ThreadView } from '../core/types';
import type { MessageMedia } from '../core/channels/ChannelAdapter';
import type { HealthStatus, NormalizedDuokeOrder, ProviderInfo, WaGuardStatus, WaNumberState } from '../shared/inbox-api';
import { needsReply } from '../core/triage';
import { formatRelative } from './time';
import { inbox } from './api';

type Filter = 'needs' | 'all' | 'marketplace' | 'whatsapp' | 'done';
const isActive = (t: ThreadView) => t.thread.status !== 'closed';

export function App() {
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [draftBody, setDraftBody] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const dirtyRef = useRef(false); // did the user type since we last set the box programmatically?
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const historyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // is the history scrolled to (near) the bottom?
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [waOpen, setWaOpen] = useState(false);
  const [waNumbers, setWaNumbers] = useState<WaNumberState[]>([]);
  const [waGuard, setWaGuard] = useState<WaGuardStatus | null>(null);
  const [sendStates, setSendStates] = useState<Record<string, { state: 'pacing' | 'failed'; etaMs?: number; error?: string }>>({});
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [orders, setOrders] = useState<NormalizedDuokeOrder[]>([]);
  const [filter, setFilter] = useState<Filter>('needs'); // G8: default to the work queue

  const refreshThreads = useCallback(async () => {
    const t = await inbox.listThreads();
    setThreads(t);
    return t;
  }, []);

  useEffect(() => {
    refreshThreads();
  }, [refreshThreads]);

  const selected = useMemo(
    () => threads.find((t) => t.thread.id === selectedId) ?? null,
    [threads, selectedId],
  );
  const sending = selectedId ? sendStates[selectedId] : undefined;
  const pacing = sending?.state === 'pacing';
  const duokeDown = !!health && !health.channels.some((c) => c.kind === 'duoke' && c.health.connected);
  const draftDown = !!health && !health.draft.ok;

  const counts = useMemo(() => {
    let needs = 0;
    let all = 0;
    let marketplace = 0;
    let whatsapp = 0;
    let done = 0;
    for (const t of threads) {
      if (t.thread.status === 'closed') { done += 1; continue; }
      all += 1;
      if (needsReply(t)) needs += 1;
      if (t.channel.kind === 'duoke') marketplace += 1;
      else if (t.channel.kind === 'whatsapp') whatsapp += 1;
    }
    return { needs, all, marketplace, whatsapp, done };
  }, [threads]);

  const filteredThreads = useMemo(() => {
    switch (filter) {
      case 'needs': return threads.filter(needsReply);
      case 'done': return threads.filter((t) => t.thread.status === 'closed');
      case 'marketplace': return threads.filter((t) => isActive(t) && t.channel.kind === 'duoke');
      case 'whatsapp': return threads.filter((t) => isActive(t) && t.channel.kind === 'whatsapp');
      default: return threads.filter(isActive);
    }
  }, [threads, filter]);

  // Load the composer from a draft programmatically (resets the dirty flag).
  const applyDraft = useCallback((id: string | null, body: string) => {
    setDraftId(id);
    setDraftBody(body);
    dirtyRef.current = false;
  }, []);

  // User typing: update + mark dirty + debounce-persist the edit (status 'edited').
  const onDraftChange = useCallback((body: string) => {
    setDraftBody(body);
    dirtyRef.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const id = draftId;
    if (!id) return;
    saveTimer.current = setTimeout(() => { void inbox.updateDraft(id, body); }, 800);
  }, [draftId]);

  // On selection change only: load history + the current draft into the editor.
  // (Deliberately NOT depending on `threads`, so the 3s poll can't clobber edits.)
  useEffect(() => {
    if (!selectedId) {
      setHistory([]);
      applyDraft(null, '');
      return;
    }
    let cancelled = false;
    void inbox.markRead(selectedId).then(() => refreshThreads()); // clear the badge on open
    (async () => {
      const [h, all] = await Promise.all([inbox.getHistory(selectedId), inbox.listThreads()]);
      if (cancelled) return;
      setHistory(h);
      const draft = all.find((x) => x.thread.id === selectedId)?.draft;
      // Use an existing real draft; the old `echo` placeholders regenerate on open.
      if (draft && draft.status !== 'sent' && draft.model !== 'placeholder' && draft.providerId !== 'echo') {
        applyDraft(draft.id, draft.body);
        return;
      }
      const last = h[h.length - 1];
      if (last?.direction === 'inbound') {
        applyDraft(null, '');
        setDrafting(true);
        try {
          const d = await inbox.regenerateDraft(selectedId);
          if (!cancelled && !dirtyRef.current) applyDraft(d.id, d.body); // don't clobber text typed while drafting
        } catch {
          if (!cancelled && !dirtyRef.current) applyDraft(null, '');
        } finally {
          if (!cancelled) setDrafting(false);
        }
      } else {
        applyDraft(draft && draft.status !== 'sent' ? draft.id : null, draft && draft.status !== 'sent' ? draft.body : '');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, applyDraft, refreshThreads]);

  // Poll for newly-synced threads + messages. Refreshes the list and the open
  // thread's history, but never the draft textarea (so edits survive).
  useEffect(() => {
    const iv = setInterval(async () => {
      await refreshThreads();
      if (selectedId) setHistory(await inbox.getHistory(selectedId));
    }, 3000);
    return () => clearInterval(iv);
  }, [selectedId, refreshThreads]);

  // Marketplace order/product card — fetched lazily on thread open (main returns [] for non-Duoke).
  useEffect(() => {
    if (!selectedId) { setOrders([]); return; }
    let cancelled = false;
    setOrders([]);
    inbox.threadOrders(selectedId).then((o) => { if (!cancelled) setOrders(o); }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId]);

  // Opening a thread lands on the newest message.
  useEffect(() => { pinnedRef.current = true; }, [selectedId]);
  // When history grows, stick to the bottom only if the reader was already there.
  useEffect(() => {
    const el = historyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [history]);
  const onHistoryScroll = () => {
    const el = historyRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // WhatsApp connect state — initial load + live updates pushed from main.
  useEffect(() => {
    inbox.listWhatsApp().then(setWaNumbers);
    return inbox.onWaUpdate(setWaNumbers);
  }, []);

  // Open the thread when a macOS notification is clicked.
  useEffect(() => inbox.onSelectThread((id) => setSelectedId(id)), []);

  // Channel + drafting health — polled for the status banners.
  useEffect(() => {
    const load = () => inbox.health().then(setHealth).catch(() => {});
    load();
    const iv = setInterval(load, 15000);
    return () => clearInterval(iv);
  }, []);

  // AI picker — which model drafts replies.
  useEffect(() => { inbox.listProviders().then(setProviders).catch(() => {}); }, []);

  // WhatsApp anti-ban guard — per-number send counts / risk + kill switch. Polled
  // so the risk bands and daily counters stay live as replies go out.
  const refreshGuard = useCallback(() => {
    inbox.whatsappGuard().then(setWaGuard).catch(() => {});
  }, []);
  useEffect(() => {
    refreshGuard();
    const iv = setInterval(refreshGuard, 15000);
    return () => clearInterval(iv);
  }, [refreshGuard]);

  const toggleKill = async () => {
    const next = !(waGuard?.killed ?? false);
    if (next && !window.confirm('Engage the kill switch? This immediately pauses ALL WhatsApp sending until you turn it back off.')) return;
    try {
      setWaGuard(await inbox.setWhatsappKill(next));
      flash(next ? '⛔ WhatsApp sending paused (kill switch ON)' : 'WhatsApp sending resumed');
    } catch (e) {
      flash(`Kill switch failed: ${(e as Error).message}`, true);
    }
  };

  const flash = (text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast(null), error ? 4500 : 2500);
  };

  // Send lifecycle (queued → pacing → sent | failed), streamed from the send queue.
  useEffect(
    () =>
      inbox.onSendUpdate((e) => {
        setSendStates((s) => {
          const next = { ...s };
          if (e.state === 'sent') delete next[e.threadId];
          else if (e.state === 'failed') next[e.threadId] = { state: 'failed', error: e.error };
          else next[e.threadId] = { state: 'pacing', etaMs: next[e.threadId]?.etaMs }; // queued/pacing
          return next;
        });
        if (e.state === 'sent') {
          void refreshThreads();
          if (e.threadId === selectedId) void inbox.getHistory(selectedId).then(setHistory);
          refreshGuard();
          flash('Reply sent ✓');
        }
      }),
    [selectedId, refreshThreads, refreshGuard],
  );

  const onRegenerate = async () => {
    if (!selectedId) return;
    setDrafting(true);
    try {
      const d = await inbox.regenerateDraft(selectedId);
      applyDraft(d.id, d.body); // user asked for a fresh draft — replace + reset dirty
      await refreshThreads();
    } catch (e) {
      flash(`Draft failed: ${(e as Error).message?.split(': ').pop() ?? 'error'}`, true);
    } finally {
      setDrafting(false);
    }
  };

  const onSend = async () => {
    if (!selectedId || !draftBody.trim()) return;
    if (saveTimer.current) clearTimeout(saveTimer.current); // don't let a pending edit-save race the send
    const tid = selectedId;
    setSendStates((s) => ({ ...s, [tid]: { state: 'pacing' } })); // optimistic; enrich with etaMs below
    try {
      const { etaMs } = await inbox.approveAndSend(tid, draftBody.trim());
      setSendStates((s) => ({ ...s, [tid]: { state: 'pacing', etaMs } }));
    } catch (e) {
      setSendStates((s) => ({ ...s, [tid]: { state: 'failed', error: (e as Error).message } }));
    }
  };

  const onSimulate = async () => {
    setBusy(true);
    try {
      await inbox.simulateIncoming();
      const t = await refreshThreads();
      if (t.length) setSelectedId(t[0]!.thread.id);
      flash('New message received');
    } finally {
      setBusy(false);
    }
  };

  const onPickProvider = async (id: string) => {
    const list = await inbox.setProvider(id);
    setProviders(list);
    const picked = list.find((p) => p.id === id);
    flash(
      picked && !picked.configured
        ? `${picked.label} selected — add its API key to .env to use it`
        : `AI set to ${picked?.label ?? id}`,
      picked ? !picked.configured : false,
    );
  };

  const setStatus = async (threadId: string, status: 'open' | 'closed') => {
    await inbox.setThreadStatus(threadId, status);
    if (status === 'closed' && threadId === selectedId) setSelectedId(null); // it left the active view
    await refreshThreads();
    flash(status === 'closed' ? 'Marked done ✓' : 'Reopened');
  };

  const toggleMuted = async (threadId: string, muted: boolean) => {
    await inbox.setThreadMuted(threadId, muted);
    await refreshThreads();
    flash(muted ? '🔇 Muted — no AI drafts or alerts' : 'Unmuted');
  };

  const disconnectWa = async (id: string, linked: boolean) => {
    const msg = linked
      ? "Unlink this WhatsApp number? This removes it from your phone's Linked Devices and deletes all its conversations from this inbox. Chats still on the phone re-import if you re-link."
      : 'Stop connecting this number?';
    if (!window.confirm(msg)) return;
    await inbox.disconnectWhatsApp(id);
    flash(linked ? 'WhatsApp unlinked' : 'Connect cancelled');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▦</span>
          <div>
            <div className="title">Unified Inbox</div>
            <div className="subtitle">All channels · AI drafts · you approve &amp; send</div>
          </div>
        </div>
        <div className="top-actions">
          {providers.length > 0 && (
            <label className="ai-pick" title="Which AI drafts replies">
              <span>✨ AI</span>
              <select value={providers.find((p) => p.active)?.id ?? ''} onChange={(e) => onPickProvider(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.configured ? '' : ' (needs key)'}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="btn ghost" onClick={() => setWaOpen(true)}>
            ✆ WhatsApp{waNumbers.some((n) => n.state === 'ready') ? ' ✓' : ''}
            {waGuard?.killed ? ' ⛔' : waGuard?.numbers.some((n) => n.risk === 'high') ? ' ⚠️' : ''}
          </button>
          <button className="btn ghost" onClick={onSimulate} disabled={busy}>
            ✦ Simulate incoming
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="threadlist">
          <div className="tabs">
            {(
              [
                ['needs', 'Needs reply'],
                ['all', 'All'],
                ['marketplace', 'Marketplace'],
                ['whatsapp', 'WhatsApp'],
                ['done', 'Done'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={`tab ${filter === key ? 'active' : ''}`}
                onClick={() => setFilter(key)}
              >
                {label}
                <span className="tab-count">{counts[key]}</span>
              </button>
            ))}
          </div>
          {(filter === 'marketplace' || filter === 'all') && duokeDown && (
            <div className="banner warn">⚠ Marketplaces not syncing — open Duoke and log in.</div>
          )}
          {filteredThreads.length === 0 && <div className="empty">No conversations here.</div>}
          {filteredThreads.map((t) => (
            <button
              key={t.thread.id}
              className={`thread ${t.thread.id === selectedId ? 'active' : ''}`}
              onClick={() => setSelectedId(t.thread.id)}
            >
              <div className="thread-top">
                <span className="who">{t.customer.name ?? t.customer.externalId}</span>
                <span className="thread-time">{formatRelative(t.thread.lastMessageAt)}</span>
                {t.thread.unread > 0 && <span className="badge">{t.thread.unread}</span>}
              </div>
              <div className="preview">
                {t.lastMessageDirection === 'outbound' && <span className="you">You: </span>}
                {t.lastMessagePreview ?? '—'}
              </div>
              <div className="thread-foot">
                <span className={`chan chan-${t.channel.kind}`}>{t.channel.label}</span>
                {t.muted && <span className="muted-tag">🔇</span>}
                {!t.muted && t.draft && t.draft.status !== 'sent' && <span className="dot-draft">draft ready</span>}
              </div>
            </button>
          ))}
        </aside>

        <main className="detail">
          {!selected && <div className="placeholder">Select a conversation to see its history and AI draft.</div>}

          {selected && (
            <>
              <div className="detail-head">
                <div>
                  <div className="dh-name">{selected.customer.name ?? selected.customer.externalId}</div>
                  <div className="dh-sub">
                    {selected.channel.label} · {selected.customer.externalId}
                  </div>
                </div>
                <div className="dh-actions">
                  <button className="btn ghost" onClick={() => toggleMuted(selected.thread.id, !selected.muted)}>
                    {selected.muted ? '🔔 Unmute' : '🔇 Not a customer'}
                  </button>
                  {selected.thread.status === 'closed' ? (
                    <button className="btn ghost" onClick={() => setStatus(selected.thread.id, 'open')}>↩ Reopen</button>
                  ) : (
                    <button className="btn ghost" onClick={() => setStatus(selected.thread.id, 'closed')}>✓ Done</button>
                  )}
                </div>
              </div>

              {orders.length > 0 && (
                <div className="orders">
                  {orders.map((o) => (
                    <div key={o.orderId} className="order-card">
                      <div className="order-top">
                        <span className="order-id">#{o.orderId}</span>
                        {o.status && <span className="order-status">{o.status}</span>}
                        <span className="order-total">{o.currency} {o.total.toFixed(2)}</span>
                      </div>
                      {o.items.map((it, i) => (
                        <div key={i} className="order-item">
                          {it.imageUrl && <img className="order-img" src={it.imageUrl} alt="" />}
                          <div className="order-item-info">
                            <div className="order-item-name">{it.name}</div>
                            <div className="order-item-sub">
                              {it.sku && <span>SKU {it.sku}</span>}
                              {it.variation && <span> · {it.variation}</span>}
                              <span> · ×{it.quantity}</span>
                            </div>
                          </div>
                          <div className="order-item-price">{it.currency} {it.price.toFixed(2)}</div>
                        </div>
                      ))}
                      {(o.paymentMethod || o.trackingNumber || o.logisticsStatus) && (
                        <div className="order-foot">
                          {o.paymentMethod && <span>{o.paymentMethod}</span>}
                          {o.trackingNumber && <span>📦 {o.logisticsService ?? ''} {o.trackingNumber}</span>}
                          {o.logisticsStatus && <span>{o.logisticsStatus}</span>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="history" ref={historyRef} onScroll={onHistoryScroll}>
                {history.map((m) => {
                  const media = (m.meta as { media?: MessageMedia } | undefined)?.media;
                  const src = media?.dataUri ?? media?.url;
                  const isPlaceholder = /\[[a-z ]+\]$/i.test(m.body.trim()); // "[image]", "[video]", "🖼️ [image]", …
                  return (
                    <div key={m.id} className={`msg ${m.direction}`}>
                      <div className="bubble">
                        {media?.kind === 'image' && src && <img className="msg-img" src={src} alt="attachment" />}
                        {media?.kind === 'video' && src && <video className="msg-video" src={src} controls preload="metadata" />}
                        {media?.kind === 'audio' && src && <audio className="msg-audio" src={src} controls preload="metadata" />}
                        {media?.kind === 'file' && <span className="msg-file">📎 {media.filename ?? 'attachment'}</span>}
                        {m.body && !(media && isPlaceholder) && <div className="bubble-text">{m.body}</div>}
                      </div>
                      <div className="meta">{new Date(m.createdAt).toLocaleString()}</div>
                    </div>
                  );
                })}
              </div>

              <div className="composer">
                <div className="composer-head">
                  <span className={`ai-tag ${drafting ? 'pulse' : ''}`}>
                    {drafting
                      ? '✨ Drafting with AI…'
                      : selected.draft?.status === 'edited'
                        ? '✍️ Edited by you'
                        : `✨ AI suggestion${selected.draft?.providerId && selected.draft.providerId !== 'echo' ? ` · ${selected.draft.providerId}` : ''}`}
                  </span>
                  <span className="safety">🔒 Auto-send OFF · human approval required</span>
                </div>
                {draftDown && !drafting && !draftBody.trim() && (
                  <div className="banner warn">⚠ Drafting unavailable — {health?.draft.error}. Is Ollama running?</div>
                )}
                {sending?.state === 'failed' && (
                  <div className="send-error">
                    <span>⚠ {sending.error}</span>
                    <button
                      className="send-error-x"
                      onClick={() => setSendStates((s) => { const n = { ...s }; if (selectedId) delete n[selectedId]; return n; })}
                    >
                      ✕
                    </button>
                  </div>
                )}
                <textarea
                  value={draftBody}
                  onChange={(e) => onDraftChange(e.target.value)}
                  placeholder={drafting ? 'Generating a reply…' : 'No draft yet — click Regenerate.'}
                  rows={4}
                />
                <div className="composer-actions">
                  <button className="btn ghost" onClick={onRegenerate} disabled={pacing || drafting}>
                    {drafting ? '⋯ Generating' : '↻ Regenerate'}
                  </button>
                  <button className="btn primary" onClick={onSend} disabled={pacing || drafting || !draftBody.trim()}>
                    {pacing
                      ? `⋯ Sending…${sending?.etaMs ? ` ~${Math.ceil(sending.etaMs / 1000)}s (pacing)` : ''}`
                      : '✓ Approve & Send'}
                  </button>
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {waOpen && (
        <div className="wa-overlay" onClick={() => setWaOpen(false)}>
          <div className="wa-panel" onClick={(e) => e.stopPropagation()}>
            <div className="wa-head">
              <span>Connect WhatsApp</span>
              <button className="btn ghost" onClick={() => setWaOpen(false)}>✕</button>
            </div>
            <p className="wa-sub">
              Link a number once. On your phone: WhatsApp → Settings → Linked Devices → Link a Device → scan.
              Receiving only — replies are always approved by you.
            </p>

            <div className={`wa-kill ${waGuard?.killed ? 'on' : ''}`}>
              <div className="wa-kill-text">
                <span className="wa-kill-title">{waGuard?.killed ? '⛔ Sending paused' : '🟢 Sending active'}</span>
                <span className="wa-kill-sub">
                  Kill switch — instantly stop all outbound WhatsApp messages. Human-like pacing &amp; per-number daily caps are always on.
                </span>
              </div>
              <button className={`btn ${waGuard?.killed ? 'primary' : 'danger'}`} onClick={toggleKill}>
                {waGuard?.killed ? 'Resume sending' : 'Pause all sending'}
              </button>
            </div>

            {waNumbers.length === 0 && <div className="wa-hint">No WhatsApp numbers configured.</div>}
            {waNumbers.map((n) => (
              <div key={n.id} className="wa-row">
                <div className="wa-row-head">
                  <span className="wa-label">{n.label}</span>
                  <span className={`wa-badge ${n.state}`}>
                    {n.state}
                    {n.threads != null ? ` · ${n.threads} chats` : ''}
                  </span>
                </div>
                {(() => {
                  const g = waGuard?.numbers.find((x) => x.id === n.id);
                  if (!g) return null;
                  return (
                    <div className={`wa-quota risk-${g.risk}`}>
                      <span className="wa-quota-count">
                        {g.sentInWindow}/{g.cap} sent · last 24h
                      </span>
                      <span className="wa-quota-risk">{g.risk} ban risk</span>
                    </div>
                  );
                })()}
                {n.state === 'qr' && n.qrDataUrl && (
                  <div className="wa-qr">
                    <img src={n.qrDataUrl} alt="WhatsApp link QR" />
                    <span>Scan to link this number</span>
                  </div>
                )}
                {n.state === 'connecting' && <div className="wa-hint">Starting WhatsApp Web…</div>}
                {(n.state === 'idle' || n.state === 'disconnected' || n.state === 'error') && (
                  <button className="btn primary" onClick={() => inbox.connectWhatsApp(n.id)}>
                    Connect
                  </button>
                )}
                {(n.state === 'qr' || n.state === 'connecting') && (
                  <button className="btn ghost wa-disc" onClick={() => disconnectWa(n.id, false)}>
                    Cancel
                  </button>
                )}
                {n.state === 'ready' && (
                  <div className="wa-actions">
                    <span className="wa-ok">✓ Linked &amp; receiving</span>
                    <button className="btn ghost wa-disc" onClick={() => disconnectWa(n.id, true)}>
                      Disconnect
                    </button>
                  </div>
                )}
                {n.detail && n.state !== 'ready' && <div className="wa-detail">{n.detail}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.error ? 'err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
