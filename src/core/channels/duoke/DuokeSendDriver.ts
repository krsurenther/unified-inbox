// Sends a Duoke reply by driving Duoke's own compose box over the Chrome DevTools
// Protocol. Duoke must be running with --remote-debugging-port. This is the
// pragmatic workaround for send (Duoke's real send is opaque Tencent-IM frames);
// the future robust path is to replicate the TIM websocket directly.
//
// SAFETY: send() refuses unless the conversation currently open in Duoke matches
// the target (identity is taken from Duoke's own message-list call), so it can
// never deliver to the wrong customer.

/** Pull the conversationId out of a Duoke `im/message/list` request URL. */
export function parseOpenConversationId(url: string): string | undefined {
  if (!/\/api\/v1\/im\/message\/list\b/.test(url)) return undefined;
  try {
    const cid = new URL(url).searchParams.get('conversationId');
    return cid ?? undefined;
  } catch {
    return undefined;
  }
}

export interface DuokeSendDriverOptions {
  port?: number;
  host?: string;
}

/**
 * CDP errors that mean "the page/frame we were driving is gone" — Duoke reloaded,
 * navigated, or was reopened, detaching the frame our cached WebSocket pointed at.
 * These are recoverable by reconnecting to a fresh target and redoing the action.
 */
export function isStaleFrameError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /detached frame|execution context was destroyed|cannot find context|target closed|inspected target|no target with given id|session with given id/i.test(m);
}

const COMPOSE_SELECTOR =
  `[...document.querySelectorAll('textarea.el-textarea__inner')].find(t=>/reply/i.test(t.placeholder)&&(t.offsetWidth||t.offsetHeight))`;

export class DuokeSendDriver {
  private ws?: WebSocket;
  private seq = 0;
  private readonly pending = new Map<number, (r: unknown) => void>();
  private readonly base: string;

  constructor(opts: DuokeSendDriverOptions = {}) {
    this.base = `http://${opts.host ?? 'localhost'}:${opts.port ?? 9333}`;
  }

  get connected(): boolean {
    return this.ws?.readyState === 1;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const res = await fetch(`${this.base}/json/list`);
    const targets = (await res.json()) as Array<{ type: string; url?: string; webSocketDebuggerUrl?: string }>;
    const target =
      targets.find((t) => t.type === 'page' && /duoke|tongpaidang/i.test(t.url ?? '')) ??
      targets.find((t) => t.type === 'page');
    if (!target?.webSocketDebuggerUrl) {
      throw new Error('Duoke CDP target not found — launch Duoke with --remote-debugging-port.');
    }
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl!);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('Duoke CDP connection failed.')));
      ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(String(ev.data)));
      ws.addEventListener('close', () => { if (this.ws === ws) this.ws = undefined; }); // stale socket → next connect() rebuilds
    });
    await this.cmd('Runtime.enable');
  }

  close(): void {
    // Fail any in-flight commands so callers don't hang on a socket we're tearing down.
    for (const resolve of this.pending.values()) resolve({ error: { message: 'Duoke CDP connection closed.' } });
    this.pending.clear();
    this.ws?.close();
    this.ws = undefined;
  }

  /** Drop the stale connection and reconnect to a fresh CDP target. */
  async reconnect(): Promise<void> {
    this.close();
    await this.connect();
  }

  private onMessage(data: string): void {
    const msg = JSON.parse(data) as { id?: number };
    if (msg.id != null && this.pending.has(msg.id)) {
      this.pending.get(msg.id)!(msg);
      this.pending.delete(msg.id);
    }
  }

  private cmd(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws) throw new Error('Duoke send driver not connected.');
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ error: { message: 'Duoke CDP timeout.' } });
      }, 10_000); // a dead socket must not stall the send queue forever
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  protected async evaluate<T>(expression: string): Promise<T> {
    const res = (await this.cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
      error?: { message?: string }; // CDP protocol-level error (e.g. detached frame)
      result?: { result?: { value?: T }; exceptionDetails?: { text?: string } };
    };
    const err = res.error?.message ?? res.result?.exceptionDetails?.text;
    if (err) throw new Error(`Duoke eval error: ${err}`);
    return res.result?.result?.value as T;
  }

  /** The conversation currently active in Duoke, read from its Vuex store. */
  async currentConversationId(): Promise<string | undefined> {
    const cid = await this.evaluate<string | null>(
      `(() => { let s=null; for (const el of document.querySelectorAll('*')) { if (el.__vue__ && el.__vue__.$store) { s = el.__vue__.$store; break; } } return s && s.state && s.state.Chat ? s.state.Chat.conversationId : null; })()`,
    );
    return cid ?? undefined;
  }

  /**
   * Ask Duoke itself to open a conversation, the way a human click would:
   * click the rendered session row if present, else dispatch Duoke's own
   * 'Chat/select-session' store action for a session in its loaded list.
   * Resolves true only once Duoke's store confirms the target is active.
   * Returns false when Duoke doesn't have the session loaded at all (old
   * conversation outside the list) — the caller falls back to a clear error.
   */
  async openConversation(conversationId: string): Promise<boolean> {
    await this.connect();
    if ((await this.currentConversationId()) === conversationId) return true;
    return this.evaluate<boolean>(`(async () => {
      let s=null; for (const el of document.querySelectorAll('*')) { if (el.__vue__ && el.__vue__.$store) { s = el.__vue__.$store; break; } }
      if (!s || !s.state || !s.state.Chat) return false;
      const TARGET=${JSON.stringify(conversationId)};
      const waitCid = async () => { for (let i=0;i<24;i++){ if (s.state.Chat.conversationId===TARGET) return true; await new Promise(x=>setTimeout(x,250)); } return false; };
      if (s.state.Chat.conversationId === TARGET) return true;
      for (const li of document.querySelectorAll('li')) {
        const src = li.__vue__ && li.__vue__.$props && li.__vue__.$props.source;
        if (src && src.conversationId === TARGET) { li.click(); return waitCid(); }
      }
      const ss = s.state.Chat.sessions;
      const flat = (Array.isArray(ss) ? ss : Object.values(ss ?? {})).flat();
      const sess = flat.find((x) => x && x.conversationId === TARGET);
      if (sess) { try { await s.dispatch('Chat/select-session', sess); } catch (e) { /* fall through to verify */ } return waitCid(); }
      return false;
    })()`);
  }

  /** What conversation + compose text Duoke is currently showing (best effort). */
  async readContext(): Promise<{ composeFound: boolean; composeText: string }> {
    return this.evaluate(`(() => {
      const ta=${COMPOSE_SELECTOR};
      return ta ? { composeFound:true, composeText: ta.value } : { composeFound:false, composeText:'' };
    })()`);
  }

  /** Put text into Duoke's reply box (Vue-aware). Does not send. */
  async setComposeText(text: string): Promise<boolean> {
    return this.evaluate(`(() => {
      const ta=${COMPOSE_SELECTOR};
      if(!ta) return false;
      ta.focus();
      const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      return ta.value === ${JSON.stringify(text)};
    })()`);
  }

  /** Press Enter in the reply box (Duoke sends on Enter). */
  async pressEnter(): Promise<boolean> {
    return this.evaluate(`(() => {
      const ta=${COMPOSE_SELECTOR};
      if(!ta) return false;
      ta.focus();
      for(const type of ['keydown','keypress','keyup']){
        ta.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
      }
      return true;
    })()`);
  }

  /**
   * Send a reply into a specific Duoke conversation. Auto-opens the target
   * conversation in Duoke first; refuses unless Duoke's own store confirms that
   * exact conversation is active (so it can never deliver to the wrong customer).
   *
   * If Duoke reloaded/navigated and detached the frame our connection pointed at,
   * reconnect and redo the whole flow ONCE — re-opening, re-composing the text on
   * the fresh frame, and re-verifying the conversation before it presses Enter.
   */
  async send(opts: { conversationId: string; text: string }): Promise<{ sent: boolean }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendOnce(opts);
      } catch (e) {
        if (attempt === 0 && isStaleFrameError(e)) {
          await this.reconnect();
          continue;
        }
        throw e;
      }
    }
  }

  private async sendOnce(opts: { conversationId: string; text: string }): Promise<{ sent: boolean }> {
    await this.connect();
    let cur = await this.currentConversationId();
    if (cur !== opts.conversationId) {
      await this.openConversation(opts.conversationId); // result re-verified below from the store
      cur = await this.currentConversationId();
    }
    if (cur !== opts.conversationId) {
      throw new Error(
        `Couldn't auto-open conversation ${opts.conversationId} in Duoke (it shows ${cur ?? 'none'} — probably an old chat outside its loaded list). Open it in Duoke, then Approve & Send again.`,
      );
    }
    if (!(await this.setComposeText(opts.text))) {
      throw new Error('Could not set Duoke compose text (reply box not found).');
    }
    // Re-verify the active conversation immediately before sending.
    if ((await this.currentConversationId()) !== opts.conversationId) {
      throw new Error('Duoke active conversation changed before send — aborted.');
    }
    await this.pressEnter();
    return { sent: true };
  }
}
