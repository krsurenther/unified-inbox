/**
 * Minimal Model Context Protocol client over Streamable HTTP (JSON-RPC 2.0).
 * Just enough to let a non-Anthropic model use a remote MCP server's tools:
 * initialize → tools/list → tools/call. No SDK, plain `fetch`.
 *
 * Anthropic's own API runs the MCP loop server-side (see ClaudeProvider), so this
 * client is only used for the providers that can't — OpenAI, Gemini, Ollama.
 */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface RpcMessage {
  id?: number;
  result?: { tools?: unknown[]; content?: unknown[] } & Record<string, unknown>;
  error?: { message?: string; code?: number };
}

export class McpClient {
  private readonly url: string;
  private readonly token?: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private sessionId?: string;
  private initialized = false;
  private toolsCache?: McpToolDef[];
  private nextId = 1;

  constructor(opts: { url: string; token?: string; fetchFn?: typeof fetch; timeoutMs?: number }) {
    this.url = opts.url;
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  /** Send a JSON-RPC request and return its `result` (throws on RPC/HTTP error). */
  private async request(method: string, params?: unknown): Promise<RpcMessage['result']> {
    const id = this.nextId++;
    const res = (await this.fetchFn(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })) as Response;
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid; // capture the session from the initialize response
    if (res.ok === false) {
      const detail = await res.text().catch(() => '');
      throw new Error(`MCP ${method}: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    const msg = await this.readMessage(res, id);
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message ?? `code ${msg.error.code}`}`);
    return msg.result;
  }

  /** Fire-and-forget JSON-RPC notification (no id, no reply expected). */
  private async notify(method: string, params?: unknown): Promise<void> {
    await this.fetchFn(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch(() => {}); // notifications are best-effort
  }

  /** A Streamable-HTTP response is either plain JSON or an SSE stream — handle both. */
  private async readMessage(res: Response, id: number): Promise<RpcMessage> {
    const body = await res.text();
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const block of body.split(/\n\n/)) {
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as RpcMessage;
          if (parsed.id === id || parsed.result || parsed.error) return parsed;
        } catch {
          /* skip non-JSON frames (comments, keep-alives) */
        }
      }
      throw new Error('MCP: no matching response in the event stream');
    }
    return JSON.parse(body) as RpcMessage;
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'unified-inbox', version: '1.0' },
    });
    await this.notify('notifications/initialized');
    this.initialized = true;
  }

  /** The server's tools, normalized (cached after the first call). */
  async listTools(): Promise<McpToolDef[]> {
    if (this.toolsCache) return this.toolsCache;
    await this.ensureInit();
    const result = await this.request('tools/list');
    const tools = ((result?.tools as Array<Record<string, unknown>>) ?? []).map((t) => ({
      name: String(t.name),
      description: typeof t.description === 'string' ? t.description : undefined,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }));
    this.toolsCache = tools;
    return tools;
  }

  /** Invoke a tool; returns its content flattened to text (what the model reads back). */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureInit();
    const result = await this.request('tools/call', { name, arguments: args });
    const content = (result?.content as Array<Record<string, unknown>>) ?? [];
    const text = content
      .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
      .join('\n')
      .trim();
    return text || JSON.stringify(result ?? {});
  }
}
