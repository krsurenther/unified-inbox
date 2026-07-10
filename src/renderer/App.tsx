import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Message, ThreadView } from '../core/types';
import type { WaGuardStatus, WaNumberState } from '../shared/inbox-api';
import { inbox } from './api';

export function App() {
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<Message[]>([]);
  const [draftBody, setDraftBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [waOpen, setWaOpen] = useState(false);
  const [waNumbers, setWaNumbers] = useState<WaNumberState[]>([]);
  const [waGuard, setWaGuard] = useState<WaGuardStatus | null>(null);
  const [filter, setFilter] = useState<'all' | 'marketplace' | 'whatsapp'>('all');

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

  const counts = useMemo(() => {
    let marketplace = 0;
    let whatsapp = 0;
    for (const t of threads) {
      if (t.channel.kind === 'duoke') marketplace += 1;
      else if (t.channel.kind === 'whatsapp') whatsapp += 1;
    }
    return { all: threads.length, marketplace, whatsapp };
  }, [threads]);

  const filteredThreads = useMemo(() => {
    if (filter === 'marketplace') return threads.filter((t) => t.channel.kind === 'duoke');
    if (filter === 'whatsapp') return threads.filter((t) => t.channel.kind === 'whatsapp');
    return threads;
  }, [threads, filter]);

  // On selection change only: load history + the current draft into the editor.
  // (Deliberately NOT depending on `threads`, so the 3s poll can't clobber edits.)
  useEffect(() => {
    if (!selectedId) {
      setHistory([]);
      setDraftBody('');
      return;
    }
    let cancelled = false;
    (async () => {
      const [h, all] = await Promise.all([inbox.getHistory(selectedId), inbox.listThreads()]);
      if (cancelled) return;
      setHistory(h);
      const draft = all.find((x) => x.thread.id === selectedId)?.draft;
      // Use an existing real draft; the old `echo` placeholders regenerate on open.
      if (draft && draft.status !== 'sent' && draft.providerId !== 'echo') {
        setDraftBody(draft.body);
        return;
      }
      const last = h[h.length - 1];
      if (last?.direction === 'inbound') {
        setDraftBody('');
        setDrafting(true);
        try {
          const d = await inbox.regenerateDraft(selectedId);
          if (!cancelled) setDraftBody(d.body);
        } catch {
          if (!cancelled) setDraftBody('');
        } finally {
          if (!cancelled) setDrafting(false);
        }
      } else {
        setDraftBody(draft && draft.status !== 'sent' ? draft.body : '');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Poll for newly-synced threads + messages. Refreshes the list and the open
  // thread's history, but never the draft textarea (so edits survive).
  useEffect(() => {
    const iv = setInterval(async () => {
      await refreshThreads();
      if (selectedId) setHistory(await inbox.getHistory(selectedId));
    }, 3000);
    return () => clearInterval(iv);
  }, [selectedId, refreshThreads]);

  // WhatsApp connect state — initial load + live updates pushed from main.
  useEffect(() => {
    inbox.listWhatsApp().then(setWaNumbers);
    return inbox.onWaUpdate(setWaNumbers);
  }, []);

  // Open the thread when a macOS notification is clicked.
  useEffect(() => inbox.onSelectThread((id) => setSelectedId(id)), []);

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

  const onRegenerate = async () => {
    if (!selectedId) return;
    setDrafting(true);
    try {
      const d = await inbox.regenerateDraft(selectedId);
      setDraftBody(d.body);
      await refreshThreads();
    } catch (e) {
      flash(`Draft failed: ${(e as Error).message?.split(': ').pop() ?? 'error'}`, true);
    } finally {
      setDrafting(false);
    }
  };

  const onSend = async () => {
    if (!selectedId || !draftBody.trim()) return;
    setBusy(true);
    try {
      const res = await inbox.approveAndSend(selectedId, draftBody.trim());
      if (res.sent) {
        setHistory(await inbox.getHistory(selectedId));
        await refreshThreads();
        refreshGuard(); // a WhatsApp send moves the daily counter / risk band
        flash('Reply sent ✓');
      }
    } catch (e) {
      flash(`Send blocked: ${(e as Error).message?.split(': ').pop() ?? 'error'}`, true);
    } finally {
      setBusy(false);
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
                ['all', 'All'],
                ['marketplace', 'Marketplace'],
                ['whatsapp', 'WhatsApp'],
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
          {filteredThreads.length === 0 && <div className="empty">No conversations here.</div>}
          {filteredThreads.map((t) => (
            <button
              key={t.thread.id}
              className={`thread ${t.thread.id === selectedId ? 'active' : ''}`}
              onClick={() => setSelectedId(t.thread.id)}
            >
              <div className="thread-top">
                <span className="who">{t.customer.name ?? t.customer.externalId}</span>
                {t.thread.unread > 0 && <span className="badge">{t.thread.unread}</span>}
              </div>
              <div className="preview">{t.lastMessagePreview ?? '—'}</div>
              <div className="thread-foot">
                <span className="chan">{t.channel.label}</span>
                {t.draft && t.draft.status !== 'sent' && <span className="dot-draft">draft ready</span>}
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
              </div>

              <div className="history">
                {history.map((m) => (
                  <div key={m.id} className={`msg ${m.direction}`}>
                    <div className="bubble">{m.body}</div>
                    <div className="meta">{new Date(m.createdAt).toLocaleString()}</div>
                  </div>
                ))}
              </div>

              <div className="composer">
                <div className="composer-head">
                  <span className={`ai-tag ${drafting ? 'pulse' : ''}`}>
                    {drafting
                      ? '✨ Drafting with AI…'
                      : `✨ AI draft${selected.draft?.providerId && selected.draft.providerId !== 'echo' ? ` · ${selected.draft.providerId}` : ''}`}
                  </span>
                  <span className="safety">🔒 Auto-send OFF · human approval required</span>
                </div>
                <textarea
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  placeholder={drafting ? 'Generating a reply…' : 'No draft yet — click Regenerate.'}
                  rows={4}
                />
                <div className="composer-actions">
                  <button className="btn ghost" onClick={onRegenerate} disabled={busy || drafting}>
                    {drafting ? '⋯ Generating' : '↻ Regenerate'}
                  </button>
                  <button className="btn primary" onClick={onSend} disabled={busy || drafting || !draftBody.trim()}>
                    ✓ Approve &amp; Send
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
