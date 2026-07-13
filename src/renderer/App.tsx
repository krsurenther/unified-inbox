import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message, ThreadView } from '../core/types';
import type { MessageMedia } from '../core/channels/ChannelAdapter';
import type { ChannelSummary, HealthStatus, NormalizedDuokeOrder, ProviderInfo, TriageCounts, UiPrefs, WaGuardStatus, WaNumberState } from '../shared/inbox-api';
import { needsReply } from '../core/triage';
import { formatRelative } from './time';
import { mediaLabel } from './mediaLabel';
import { Icon, type IconName } from './Icon';
import { inbox } from './api';

/** A triage bucket or a specific channel account. */
type Triage = 'needs' | 'mine' | 'all' | 'done';
type Filter = Triage | { channelId: string };
type SortBy = 'newest' | 'oldest';
const isActive = (t: ThreadView) => t.thread.status !== 'closed';

// Deterministic accent per channel kind (avatars + dots + chips).
const CHANNEL_COLOR: Record<string, string> = { whatsapp: '#34d399', duoke: '#ff8a5c', webstore: '#6ee7f2', fake: '#8b93a7' };
const channelIcon = (kind: string): IconName => (kind === 'whatsapp' ? 'phone' : kind === 'webstore' ? 'globe' : 'bag');
const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0]!.replace(/^\+?/, '').slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
};
/** Group history messages by local calendar day for separators. */
const dayKey = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const dayLabel = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return dayKey(iso);
};
const shortTime = (iso: string): string => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

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
  const [drafting, setDrafting] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [waOpen, setWaOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [promptTarget, setPromptTarget] = useState('default');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [providerPrompts, setProviderPrompts] = useState<Record<string, string>>({});
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpToken, setMcpToken] = useState('');
  const [mcpHasToken, setMcpHasToken] = useState(false);
  const [waNumbers, setWaNumbers] = useState<WaNumberState[]>([]);
  const [waGuard, setWaGuard] = useState<WaGuardStatus | null>(null);
  const [sendStates, setSendStates] = useState<Record<string, { state: 'pacing' | 'failed'; etaMs?: number; error?: string }>>({});
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [orders, setOrders] = useState<NormalizedDuokeOrder[]>([]);
  const [filter, setFilter] = useState<Filter>('needs'); // default to the work queue
  const [sortBy, setSortBy] = useState<SortBy>('newest');
  const [sortOpen, setSortOpen] = useState(false);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [triage, setTriage] = useState<TriageCounts>({ needs: 0, mine: 0, all: 0, done: 0 });
  const [staff, setStaff] = useState<string[]>([]);
  const [me, setMe] = useState('');
  const [prefs, setPrefs] = useState<UiPrefs>({ railCollapsed: false, contextOpen: true, autoDraft: false, autoAdvance: false });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ThreadView[] | null>(null); // non-null while searching
  const [related, setRelated] = useState<ThreadView[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

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

  const filteredThreads = useMemo(() => {
    if (results) return results; // search overrides filter+sort (already ordered newest-first)
    let list: ThreadView[];
    if (typeof filter === 'object') list = threads.filter((t) => isActive(t) && t.channel.id === filter.channelId);
    else if (filter === 'needs') list = threads.filter(needsReply);
    else if (filter === 'mine') list = threads.filter((t) => isActive(t) && !!me && t.assignee === me);
    else if (filter === 'done') list = threads.filter((t) => t.thread.status === 'closed');
    else list = threads.filter(isActive);
    const dir = sortBy === 'oldest' ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = a.thread.lastMessageAt ?? '';
      const bv = b.thread.lastMessageAt ?? '';
      return av === bv ? 0 : dir * (av < bv ? -1 : 1);
    });
  }, [threads, filter, sortBy, results, me]);

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
      // On-demand AI: load a real, unsent draft if one already exists; otherwise start empty.
      // The operator presses Generate to draft — we never auto-spend tokens on open.
      if (draft && draft.status !== 'sent' && draft.model !== 'placeholder' && draft.providerId !== 'echo') {
        applyDraft(draft.id, draft.body);
      } else {
        applyDraft(null, '');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, applyDraft, refreshThreads]);

  // Rail data (channels + triage counts) — refreshed with the poll below.
  const refreshRail = useCallback(async () => {
    const [ch, tri] = await Promise.all([inbox.listChannels(), inbox.triageCounts()]);
    setChannels(ch);
    setTriage(tri);
  }, []);

  // Poll for newly-synced threads + messages + rail counts. Never touches the draft box.
  useEffect(() => {
    const iv = setInterval(async () => {
      await refreshThreads();
      await refreshRail();
      if (selectedId) setHistory(await inbox.getHistory(selectedId));
    }, 3000);
    return () => clearInterval(iv);
  }, [selectedId, refreshThreads, refreshRail]);

  // One-time load: rail, staff, UI prefs.
  useEffect(() => {
    void refreshRail();
    inbox.listStaff().then((s) => { setStaff(s.staff); setMe(s.me); }).catch(() => {});
    inbox.getUiPrefs().then(setPrefs).catch(() => {});
  }, [refreshRail]);

  // Debounced search — matches name / phone / id / message body server-side.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults(null); return; }
    const h = setTimeout(() => { inbox.searchThreads(q).then(setResults).catch(() => setResults([])); }, 180);
    return () => clearTimeout(h);
  }, [query]);

  // ⌘K / '/' focuses search (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Related threads (same customer on other channels) for the context panel.
  useEffect(() => {
    if (!selectedId) { setRelated([]); return; }
    let cancelled = false;
    inbox.relatedThreads(selectedId).then((r) => { if (!cancelled) setRelated(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId]);

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

  // Load prompts + Hub MCP config when the AI settings modal opens.
  useEffect(() => {
    if (!keysOpen) return;
    inbox.getPrompts().then((p) => { setSystemPrompt(p.systemPrompt); setProviderPrompts(p.providerPrompts); }).catch(() => {});
    inbox.getMcp().then((m) => { setMcpUrl(m.url); setMcpHasToken(m.hasToken); setMcpToken(''); }).catch(() => {});
  }, [keysOpen]);

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


  const onPickProvider = async (id: string) => {
    const list = await inbox.setProvider(id);
    setProviders(list);
    const picked = list.find((p) => p.id === id);
    flash(
      picked && !picked.configured
        ? `${picked.label} selected — add its API key via 🔑 AI keys to use it`
        : `AI set to ${picked?.label ?? id}`,
      picked ? !picked.configured : false,
    );
  };

  const saveKey = async (id: string) => {
    const key = keyInputs[id]?.trim();
    if (!key) return;
    const list = await inbox.setProviderKey(id, key);
    setProviders(list);
    setKeyInputs((s) => ({ ...s, [id]: '' }));
    flash(`${list.find((p) => p.id === id)?.label ?? id} key saved ✓`);
  };

  const promptValue = promptTarget === 'default' ? systemPrompt : providerPrompts[promptTarget] ?? '';
  const onPromptChange = (v: string) => {
    if (promptTarget === 'default') setSystemPrompt(v);
    else setProviderPrompts((s) => ({ ...s, [promptTarget]: v }));
  };
  const savePrompts = async () => {
    const overrides = Object.fromEntries(Object.entries(providerPrompts).filter(([, v]) => v.trim())); // drop empties
    await inbox.setPrompts(systemPrompt, overrides);
    setProviderPrompts(overrides);
    flash('Prompt saved ✓');
  };

  const saveMcp = async () => {
    const m = await inbox.setMcp(mcpUrl, mcpToken); // blank token box keeps the saved token
    setMcpHasToken(m.hasToken);
    setMcpToken('');
    flash(m.url ? 'Hub tools connected ✓' : 'Hub tools disabled');
  };

  const setStatus = async (threadId: string, status: 'open' | 'closed') => {
    await inbox.setThreadStatus(threadId, status);
    if (status === 'closed' && threadId === selectedId) {
      // Auto-advance to the next unanswered thread when working a queue (opt-in); else leave the view.
      const next = prefs.autoAdvance && (filter === 'needs' || filter === 'mine')
        ? filteredThreads.find((t) => t.thread.id !== threadId && needsReply(t))?.thread.id ?? null
        : null;
      setSelectedId(next);
    }
    await Promise.all([refreshThreads(), refreshRail()]);
    flash(status === 'closed' ? 'Marked done ✓' : 'Reopened');
  };

  const toggleMuted = async (threadId: string, muted: boolean) => {
    await inbox.setThreadMuted(threadId, muted);
    await refreshThreads();
    flash(muted ? '🔇 Muted — no AI drafts or alerts' : 'Unmuted');
  };

  const renameWa = async (id: string, label: string) => {
    const l = label.trim();
    if (!l) return;
    await inbox.renameWhatsApp(id, l);
    await refreshThreads(); // update the channel chip on every thread
    flash('Number renamed ✓');
  };

  const disconnectWa = async (id: string, linked: boolean) => {
    const msg = linked
      ? "Unlink this WhatsApp number? This removes it from your phone's Linked Devices and deletes all its conversations from this inbox. Chats still on the phone re-import if you re-link."
      : 'Stop connecting this number?';
    if (!window.confirm(msg)) return;
    await inbox.disconnectWhatsApp(id);
    flash(linked ? 'WhatsApp unlinked' : 'Connect cancelled');
  };

  const assign = async (threadId: string, who: string | null) => {
    await inbox.assignThread(threadId, who);
    setAssignOpen(false);
    await Promise.all([refreshThreads(), refreshRail()]);
    flash(who ? `Assigned to ${who}` : 'Unassigned');
  };

  const savePrefs = async (patch: Partial<UiPrefs>) => setPrefs(await inbox.setUiPrefs(patch));
  const toggleRail = () => savePrefs({ railCollapsed: !prefs.railCollapsed });
  const toggleContext = () => savePrefs({ contextOpen: !prefs.contextOpen });

  const saveStaff = async (names: string[], meName: string) => {
    const r = await inbox.setStaff(names, meName);
    setStaff(r.staff);
    setMe(r.me);
    flash('Team saved ✓');
  };

  // Keyboard loop: ↑↓ move threads, ⌘⏎ send, ⌘G generate, ⌘R regenerate, E done, Esc back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'Enter') { e.preventDefault(); if (selectedId && draftBody.trim()) void onSend(); return; }
      if (mod && (e.key === 'g' || e.key === 'r')) { e.preventDefault(); if (selectedId) void onRegenerate(); return; }
      if (typing) return;
      if (e.key === 'Escape') { setSelectedId(null); return; }
      if (e.key === 'e' && selectedId) { e.preventDefault(); void setStatus(selectedId, 'closed'); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = filteredThreads;
        if (!list.length) return;
        const i = list.findIndex((t) => t.thread.id === selectedId);
        const next = e.key === 'ArrowDown' ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0);
        setSelectedId(list[i === -1 ? 0 : next]!.thread.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, draftBody, filteredThreads]);

  return (
    <div className={`app4 ${prefs.railCollapsed ? 'rail-collapsed' : ''}`}>
      {/* ZONE 1 — channel nav rail */}
      <nav className="rail">
        <div className="rail-group rail-triage">
          {([
            ['needs', 'inbox', 'Needs reply', triage.needs, true],
            ['mine', 'user', 'Assigned to me', triage.mine, false],
            ['all', 'list', 'All', triage.all, false],
            ['done', 'check', 'Done', triage.done, false],
          ] as const).map(([key, icon, label, n, hot]) => (
            <button
              key={key}
              className={`rail-item ${filter === key ? 'active' : ''}`}
              onClick={() => { setFilter(key); setQuery(''); }}
              title={label}
            >
              <Icon name={icon} />
              <span className="rail-text">{label}</span>
              <span className={`n ${hot && n > 0 ? 'hot' : ''}`}>{n}</span>
            </button>
          ))}
        </div>
        {(['whatsapp', 'duoke', 'webstore'] as const).map((kind) => {
          const rows = channels.filter((c) => c.kind === kind && (kind !== 'webstore' || c.total > 0));
          if (!rows.length) return null;
          const groupLabel = kind === 'whatsapp' ? 'WhatsApp' : kind === 'duoke' ? 'Marketplace' : 'Webstore';
          return (
            <div className="rail-group" key={kind}>
              <div className="rail-label">{groupLabel}</div>
              {rows.map((c) => (
                <button
                  key={c.channelId}
                  className={`rail-item ${typeof filter === 'object' && filter.channelId === c.channelId ? 'active' : ''}`}
                  onClick={() => { setFilter({ channelId: c.channelId }); setQuery(''); }}
                  title={c.label}
                >
                  <span className="dot" style={{ background: CHANNEL_COLOR[c.kind] }} />
                  <span className="rail-text">{c.label}</span>
                  <span className={`n ${c.needs > 0 ? 'hot' : ''}`}>{c.needs > 0 ? c.needs : c.total}</span>
                </button>
              ))}
            </div>
          );
        })}
        <div className="rail-foot">
          <button className="rail-item" onClick={() => setKeysOpen(true)} title="AI settings"><Icon name="gear" /><span className="rail-text">AI settings</span></button>
          <button className="rail-item" onClick={() => setWaOpen(true)} title="WhatsApp connection">
            <Icon name="phone" /><span className="rail-text">WhatsApp{waNumbers.some((n) => n.state === 'ready') ? ' · linked' : ''}</span>
            {waGuard?.killed && <span className="dot" style={{ background: '#ef4444' }} />}
          </button>
          <button className="rail-item rail-collapse" onClick={toggleRail} title={prefs.railCollapsed ? 'Expand' : 'Collapse'}>
            <Icon name="chevron-left" /><span className="rail-text">Collapse</span>
          </button>
        </div>
      </nav>

      {/* ZONE 2 — thread list */}
      <aside className="list">
        <div className="list-head">
          <div className="filter-box">
            <Icon name="search" size={13} />
            <input
              ref={searchRef}
              placeholder="Name, phone, or message…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query
              ? <button className="filter-x" onClick={() => setQuery('')} title="Clear (Esc)"><Icon name="x" size={12} /></button>
              : <span className="kbd">⌘K</span>}
          </div>
          <div className="sort-wrap">
            <button className="sort-mini" onClick={() => setSortOpen((v) => !v)}>{sortBy === 'newest' ? 'Newest' : 'Oldest'} <Icon name="chevron-down" size={11} /></button>
            {sortOpen && (
              <div className="sort-menu" onMouseLeave={() => setSortOpen(false)}>
                <button onClick={() => { setSortBy('newest'); setSortOpen(false); }}>Newest first</button>
                <button onClick={() => { setSortBy('oldest'); setSortOpen(false); }}>Oldest first</button>
              </div>
            )}
          </div>
        </div>
        {(typeof filter === 'object' || filter === 'all') && duokeDown && (
          <div className="banner warn">⚠ Marketplaces not syncing — open Duoke and log in.</div>
        )}
        <div className="threads">
          {results && <div className="search-note">{results.length} result{results.length === 1 ? '' : 's'} for “{query.trim()}”</div>}
          {filteredThreads.length === 0 && <div className="empty">{results ? 'No matches.' : 'No conversations here.'}</div>}
          {filteredThreads.map((t) => {
            const name = t.customer.name ?? t.customer.externalId;
            const ml = mediaLabel(t.lastMessagePreview ?? '');
            return (
              <button
                key={t.thread.id}
                className={`row ${t.thread.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(t.thread.id)}
              >
                <span className="ava" style={{ background: CHANNEL_COLOR[t.channel.kind] }}>{initials(name)}</span>
                <span className="row-main">
                  <span className="row-top">
                    <span className="row-name">{name}</span>
                    <span className="row-time">{formatRelative(t.thread.lastMessageAt)}</span>
                    {t.thread.unread > 0 && <span className="unread">{t.thread.unread}</span>}
                  </span>
                  <span className="row-prev">
                    {t.lastMessageDirection === 'outbound' && <span className="you">You: </span>}
                    {ml ? <span className="ml"><Icon name={ml.icon} size={12} /> {ml.label}</span> : (t.lastMessagePreview ?? '—')}
                  </span>
                  <span className="row-foot">
                    <span className="chip" style={{ color: CHANNEL_COLOR[t.channel.kind], background: CHANNEL_COLOR[t.channel.kind] + '22' }}>{t.channel.label}</span>
                    {t.muted && <Icon name="mute" size={12} className="muted-tag" />}
                    {!t.muted && t.draft && t.draft.status !== 'sent' && <span className="draft-ok"><Icon name="sparkle" size={11} /> draft</span>}
                    {t.assignee && <span className="assignee" title={`Assigned to ${t.assignee}`}>{initials(t.assignee)}</span>}
                  </span>
                </span>
                <span className="quick">
                  <span onClick={(e) => { e.stopPropagation(); void setStatus(t.thread.id, 'closed'); }} title="Done"><Icon name="check" size={12} /></span>
                  <span onClick={(e) => { e.stopPropagation(); void toggleMuted(t.thread.id, !t.muted); }} title={t.muted ? 'Unmute' : 'Mute'}><Icon name="mute" size={12} /></span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

        <main className="convo">
          {!selected && <div className="placeholder">Select a conversation to see its history.</div>}

          {selected && (
            <>
              <div className="convo-head">
                <div className="convo-id">
                  <div className="convo-name">{selected.customer.name ?? selected.customer.externalId}</div>
                  <div className="convo-sub">{selected.channel.label} · {selected.customer.externalId}</div>
                </div>
                <div className="convo-actions">
                  <div className="assign-wrap">
                    <button className="assign-chip" onClick={() => setAssignOpen((v) => !v)} title="Assign to staff">
                      {selected.assignee
                        ? <><span className="assignee">{initials(selected.assignee)}</span> {selected.assignee}</>
                        : <><Icon name="user-plus" size={13} /> Assign</>}
                      <Icon name="chevron-down" size={11} />
                    </button>
                    {assignOpen && (
                      <div className="assign-menu" onMouseLeave={() => setAssignOpen(false)}>
                        {staff.length === 0 && <div className="assign-empty">Add staff in AI settings → Team</div>}
                        {staff.map((s) => (
                          <button key={s} onClick={() => assign(selected.thread.id, s)}>{s}{s === me ? ' (me)' : ''}</button>
                        ))}
                        {selected.assignee && <button className="assign-clear" onClick={() => assign(selected.thread.id, null)}>Unassign</button>}
                      </div>
                    )}
                  </div>
                  <button className="btn icon-btn" onClick={() => toggleMuted(selected.thread.id, !selected.muted)} title={selected.muted ? 'Unmute' : 'Not a customer'}>
                    <Icon name="mute" size={14} />
                  </button>
                  {selected.thread.status === 'closed'
                    ? <button className="btn" onClick={() => setStatus(selected.thread.id, 'open')}><Icon name="refresh" size={13} /> Reopen</button>
                    : <button className="btn" onClick={() => setStatus(selected.thread.id, 'closed')}><Icon name="check" size={13} /> Done</button>}
                  {!prefs.contextOpen && <button className="btn icon-btn" onClick={toggleContext} title="Show customer panel"><Icon name="info" size={14} /></button>}
                </div>
              </div>

              <div className="history" ref={historyRef} onScroll={onHistoryScroll}>
                {history.map((m, idx) => {
                  const media = (m.meta as { media?: MessageMedia } | undefined)?.media;
                  const src = media?.dataUri ?? media?.url;
                  const mime = media?.mimetype ?? '';
                  const kind =
                    media?.kind ??
                    (mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : media ? 'image' : undefined);
                  const ml = mediaLabel(m.body, kind);
                  const showText = !!m.body && !ml && !(media && /\[[a-z ]+\]$/i.test(m.body.trim()));
                  const prev = history[idx - 1];
                  const sep = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
                  return (
                    <div key={m.id} className="msg-wrap">
                      {sep && <div className="day">{dayLabel(m.createdAt)}</div>}
                      <div className={`msg ${m.direction}`}>
                        <div className="bubble">
                          {kind === 'image' && src && <img className="msg-img" src={src} alt="attachment" />}
                          {kind === 'video' && src && <video className="msg-video" src={src} controls preload="metadata" />}
                          {kind === 'audio' && src && <audio className="msg-audio" src={src} controls preload="metadata" />}
                          {kind === 'file' && <span className="msg-file"><Icon name="clip" size={13} /> {media?.filename ?? 'attachment'}</span>}
                          {ml && <span className="mchip"><Icon name={ml.icon} size={13} /> {ml.label}</span>}
                          {showText && <div className="bubble-text">{m.body}</div>}
                          <span className="t">{shortTime(m.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="composer">
                <div className="composer-head">
                  <span className={`ai-tag ${drafting ? 'pulse' : ''}`}>
                    {drafting
                      ? 'Drafting with AI…'
                      : selected.draft?.status === 'edited'
                        ? 'Edited by you'
                        : draftBody.trim()
                          ? `AI suggestion${selected.draft?.providerId && selected.draft.providerId !== 'echo' ? ` · ${selected.draft.providerId}` : ''}`
                          : `Reply as ${selected.channel.label}`}
                  </span>
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
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                )}
                <textarea
                  value={draftBody}
                  onChange={(e) => onDraftChange(e.target.value)}
                  placeholder={drafting ? 'Generating a reply…' : 'Type a reply, or generate one…'}
                  rows={4}
                />
                <div className="composer-actions">
                  <button className="btn gen" onClick={onRegenerate} disabled={pacing || drafting}>
                    <Icon name="sparkle" size={13} /> {drafting ? 'Generating…' : draftBody.trim() ? 'Regenerate' : 'Generate with AI'} <span className="kbd">⌘G</span>
                  </button>
                  <span className="spacer" />
                  <span className="safety-foot"><Icon name="lock" size={11} /> approval required</span>
                  <button className="btn primary" onClick={onSend} disabled={pacing || drafting || !draftBody.trim()}>
                    <Icon name="send" size={13} /> {pacing ? `Sending…${sending?.etaMs ? ` ~${Math.ceil(sending.etaMs / 1000)}s` : ''}` : 'Send'} <span className="kbd">⌘⏎</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </main>

        {/* ZONE 4 — customer & orders context */}
        {selected && prefs.contextOpen && (
          <aside className="ctx">
            <div className="ctx-head">
              <Icon name="info" size={14} /> Customer
              <button className="ctx-x" onClick={toggleContext} title="Hide panel"><Icon name="x" size={12} /></button>
            </div>
            <div className="ctx-body">
              <div className="card">
                <div className="cust-top">
                  <span className="cust-ava" style={{ background: CHANNEL_COLOR[selected.channel.kind] }}>{initials(selected.customer.name ?? selected.customer.externalId)}</span>
                  <div>
                    <div className="cust-name">{selected.customer.name ?? selected.customer.externalId}</div>
                    <div className="cust-sub">{selected.channel.label}</div>
                  </div>
                </div>
                <div className="stat-row">
                  <div className="stat"><b>{orders.length}</b><span>orders</span></div>
                  <div className="stat"><b>{orders.reduce((s, o) => s + o.total, 0).toFixed(0)}</b><span>{orders[0]?.currency ?? 'MYR'} spent</span></div>
                  <div className="stat"><b>{related.length}</b><span>channels</span></div>
                </div>
                <div className="kv"><span className="m">ID</span><b>{selected.customer.externalId}</b></div>
                {selected.customer.phone && <div className="kv"><span className="m">Phone</span><b>{selected.customer.phone}</b></div>}
                <div className="kv"><span className="m">Assigned</span><b>{selected.assignee ?? '—'}</b></div>
                {related.length > 0 && (
                  <div className="other-ch">
                    <span className="m">Also on</span>
                    {related.slice(0, 3).map((r) => (
                      <button key={r.thread.id} className="oc-chip" onClick={() => setSelectedId(r.thread.id)}>
                        <span className="dot" style={{ background: CHANNEL_COLOR[r.channel.kind] }} /> {r.channel.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {orders.map((o) => (
                <div key={o.orderId} className="card order-card">
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
                      {o.trackingNumber && <span><Icon name="box" size={11} /> {o.logisticsService ?? ''} {o.trackingNumber}</span>}
                      {o.logisticsStatus && <span>{o.logisticsStatus}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </aside>
        )}

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
                  <input
                    className="wa-label-input"
                    key={n.label}
                    defaultValue={n.label}
                    title="Rename this number (Enter to save)"
                    onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim() !== n.label) void renameWa(n.id, e.target.value); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  />
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

      {keysOpen && (
        <div className="wa-overlay" onClick={() => setKeysOpen(false)}>
          <div className="wa-panel" onClick={(e) => e.stopPropagation()}>
            <div className="wa-head">
              <span>AI settings</span>
              <button className="btn ghost" onClick={() => setKeysOpen(false)}>✕</button>
            </div>

            <div className="settings-section-title">Which AI drafts replies</div>
            <div className="prompt-editor">
              <select value={providers.find((p) => p.active)?.id ?? ''} onChange={(e) => onPickProvider(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}{p.configured ? '' : ' (needs key)'}</option>
                ))}
              </select>
            </div>

            <div className="settings-section-title">Team</div>
            <p className="wa-sub">
              People you can assign conversations to (routing only — no logins). Comma-separated. Pick who
              <strong> you</strong> are so "Assigned to me" shows your queue.
            </p>
            <div className="prompt-editor">
              <input
                type="text"
                placeholder="Farah, Suren, Aina"
                defaultValue={staff.join(', ')}
                onBlur={(e) => { const names = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); void saveStaff(names, me && names.includes(me) ? me : names[0] ?? ''); }}
              />
              {staff.length > 0 && (
                <select value={me} onChange={(e) => saveStaff(staff, e.target.value)}>
                  <option value="">— I am… —</option>
                  {staff.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </div>

            <div className="settings-section-title">Behaviour</div>
            <label className="toggle-row">
              <input type="checkbox" checked={prefs.autoDraft} onChange={(e) => savePrefs({ autoDraft: e.target.checked })} />
              <span><strong>Auto-generate drafts</strong> — draft a reply for every incoming message. Off saves tokens (generate on demand).</span>
            </label>
            <label className="toggle-row">
              <input type="checkbox" checked={prefs.autoAdvance} onChange={(e) => savePrefs({ autoAdvance: e.target.checked })} />
              <span><strong>Auto-advance</strong> — after Send or Done in a queue, jump to the next unanswered conversation.</span>
            </label>

            <div className="settings-section-title">API keys</div>
            <p className="wa-sub">
              Paste an API key to enable a cloud model. Keys are stored locally on this machine only — never
              in the code or synced anywhere. Local (Ollama) needs no key.
            </p>
            {providers
              .filter((p) => p.id !== 'ollama')
              .map((p) => (
                <div key={p.id} className="key-row">
                  <div className="key-row-head">
                    <span className="wa-label">{p.label}</span>
                    <span className={`wa-badge ${p.configured ? 'ready' : ''}`}>{p.configured ? 'key set ✓' : 'no key'}</span>
                  </div>
                  <div className="key-input">
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder={p.configured ? '•••••• saved — paste to replace' : `Paste ${p.label} API key`}
                      value={keyInputs[p.id] ?? ''}
                      onChange={(e) => setKeyInputs((s) => ({ ...s, [p.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(p.id); }}
                    />
                    <button className="btn primary" disabled={!keyInputs[p.id]?.trim()} onClick={() => saveKey(p.id)}>
                      Save
                    </button>
                  </div>
                </div>
              ))}

            <div className="settings-section-title">System prompt</div>
            <p className="wa-sub">
              This is what tells the AI how to reply. “Default” applies to every AI; pick a specific model to
              give it its own prompt (leave that empty to fall back to Default).
            </p>
            <div className="prompt-editor">
              <select value={promptTarget} onChange={(e) => setPromptTarget(e.target.value)}>
                <option value="default">Default (all AIs)</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {providerPrompts[p.id]?.trim() ? ' · custom' : ''}
                  </option>
                ))}
              </select>
              <textarea
                value={promptValue}
                onChange={(e) => onPromptChange(e.target.value)}
                rows={12}
                spellCheck={false}
                placeholder={promptTarget === 'default' ? 'System prompt for all AIs…' : 'Override for this model — leave empty to use the Default prompt'}
              />
              <button className="btn primary" onClick={savePrompts}>Save prompt</button>
            </div>

            <div className="settings-section-title">Hub tools (MCP) {mcpUrl && mcpHasToken ? <span className="wa-badge ready">connected ✓</span> : null}</div>
            <p className="wa-sub">
              Let the AI look up live stock, pricing, order and repair status from your Kronoshop Hub while it
              drafts. Paste your Hub MCP URL and a service token. Works with <strong>every AI</strong> — Claude,
              ChatGPT, Gemini, and tool-capable local (Ollama) models. Stored locally; the token is never shown again.
            </p>
            <div className="prompt-editor">
              <input
                type="url"
                placeholder="https://hub.kronoshop.my/mcp"
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
                spellCheck={false}
              />
              <input
                type="password"
                autoComplete="off"
                placeholder={mcpHasToken ? '•••••• saved — paste to replace' : 'Hub MCP service token'}
                value={mcpToken}
                onChange={(e) => setMcpToken(e.target.value)}
              />
              <button className="btn primary" onClick={saveMcp}>{mcpHasToken || mcpUrl ? 'Save Hub tools' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.error ? 'err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
