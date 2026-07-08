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
    });
    await this.cmd('Runtime.enable');
  }

  close(): void {
    this.ws?.close();
    this.ws = undefined;
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
      this.pending.set(id, resolve);
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const res = (await this.cmd('Runtime.evaluate', { expression, returnByValue: true })) as {
      result?: { result?: { value?: T }; exceptionDetails?: { text?: string } };
    };
    if (res.result?.exceptionDetails) {
      throw new Error(`Duoke eval error: ${res.result.exceptionDetails.text ?? 'unknown'}`);
    }
    return res.result?.result?.value as T;
  }

  /** The conversation currently active in Duoke, read from its Vuex store. */
  async currentConversationId(): Promise<string | undefined> {
    const cid = await this.evaluate<string | null>(
      `(() => { let s=null; for (const el of document.querySelectorAll('*')) { if (el.__vue__ && el.__vue__.$store) { s = el.__vue__.$store; break; } } return s && s.state && s.state.Chat ? s.state.Chat.conversationId : null; })()`,
    );
    return cid ?? undefined;
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
   * Send a reply into a specific Duoke conversation. Refuses unless that exact
   * conversation is the one currently open in Duoke.
   */
  async send(opts: { conversationId: string; text: string }): Promise<{ sent: boolean }> {
    await this.connect();
    const cur = await this.currentConversationId();
    if (cur !== opts.conversationId) {
      throw new Error(
        `Duoke's active conversation is ${cur ?? 'none'}, not the target ${opts.conversationId}. Open it in Duoke first.`,
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
