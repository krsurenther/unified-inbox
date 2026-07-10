import type { DraftRequest, DraftResult, LLMProvider } from './LLMProvider';
import { buildSystemPrompt, buildChatTurns } from './prompt';
import type { McpClient, McpToolDef } from './mcp/McpClient';
import { runMcpToolLoop, parseArgs, type ToolLoopDriver } from './mcp/toolLoop';

export interface CloudProviderOptions {
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Remote MCP server the model may call during drafting (Claude only, native connector). url='' disables it. */
  mcp?: { url: string; token?: string };
  /** MCP client for providers that run the tool loop app-side (OpenAI, Gemini). */
  mcpClient?: McpClient;
}

/** Gemini's functionDeclarations reject JSON-Schema meta keys — keep only the OpenAPI subset it accepts. */
export function geminiToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object' };
  const allow = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable']);
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (allow.has(k)) out[k] = clean(val);
      return out;
    }
    return v;
  };
  return clean(schema) as Record<string, unknown>;
}

/**
 * Cloud chat providers behind the one LLMProvider interface — Claude, ChatGPT
 * (OpenAI), Gemini. All plain `fetch` (no vendor SDKs, so no new dependencies).
 * Keys come from the environment only; a provider constructs even without its key
 * (so the app can list it) and throws a clear hint at draft time if it's missing.
 */
abstract class HttpProvider implements LLMProvider {
  abstract readonly id: string;
  protected readonly apiKey: string;
  protected readonly model: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: CloudProviderOptions, envKey: string, defaultModel: string) {
    this.apiKey = opts.apiKey ?? process.env[envKey] ?? '';
    this.model = opts.model ?? defaultModel;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Whether an API key is present — drives the "configured" flag in the UI picker. */
  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  protected async post(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
    const res = (await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })) as Response;
    if (res.ok === false) {
      // Surface the provider's actual error (e.g. "model no longer available", bad key) instead of a generic failure.
      let detail = `HTTP ${res.status}`;
      try {
        const text = await res.text();
        try {
          detail = (JSON.parse(text) as { error?: { message?: string } })?.error?.message ?? text.slice(0, 200);
        } catch {
          detail = text.slice(0, 200) || detail;
        }
      } catch {
        /* keep HTTP status */
      }
      throw new Error(`${this.id}: ${detail}`);
    }
    return res;
  }

  protected done(text: string): DraftResult {
    const t = text.trim();
    if (!t) throw new Error(`${this.id} returned an empty draft.`);
    return { text: t, providerId: this.id, model: this.model };
  }

  abstract draftReply(req: DraftRequest): Promise<DraftResult>;
}

export class ClaudeProvider extends HttpProvider {
  readonly id = 'claude';
  private readonly mcp?: { url: string; token?: string };
  constructor(opts: CloudProviderOptions = {}) {
    super(opts, 'ANTHROPIC_API_KEY', 'claude-haiku-4-5');
    this.mcp = opts.mcp?.url ? opts.mcp : undefined; // only wire the connector when a URL is set
  }
  async draftReply(req: DraftRequest): Promise<DraftResult> {
    if (!this.apiKey) throw new Error('Claude needs an API key — add it via ⚙️ AI settings (or ANTHROPIC_API_KEY).');
    const headers: Record<string, string> = { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' };
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 500,
      system: buildSystemPrompt(req),
      messages: buildChatTurns(req),
    };
    if (this.mcp) {
      // Remote MCP connector: Anthropic runs the Hub tool loop (stock/pricing/order/repair)
      // server-side and returns the final text. Requires the beta header + a matching mcp_toolset.
      headers['anthropic-beta'] = 'mcp-client-2025-11-20';
      body.mcp_servers = [
        { type: 'url', url: this.mcp.url, name: 'kronoshop-hub', ...(this.mcp.token ? { authorization_token: this.mcp.token } : {}) },
      ];
      body.tools = [{ type: 'mcp_toolset', mcp_server_name: 'kronoshop-hub' }];
    }
    const res = await this.post('https://api.anthropic.com/v1/messages', headers, body);
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    // With tool use the content interleaves mcp_tool_use/result blocks — the reply is the last text block.
    const text = [...(data.content ?? [])].reverse().find((b) => b.type === 'text')?.text ?? '';
    return this.done(text);
  }
}

export class OpenAiProvider extends HttpProvider {
  readonly id = 'openai';
  private readonly mcp?: McpClient;
  constructor(opts: CloudProviderOptions = {}) {
    super(opts, 'OPENAI_API_KEY', 'gpt-4o-mini');
    this.mcp = opts.mcpClient;
  }
  private async chat(messages: unknown[], tools?: unknown): Promise<{ content: string; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>; raw: Record<string, unknown> }> {
    const res = await this.post(
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${this.apiKey}` },
      tools ? { model: this.model, messages, tools, tool_choice: 'auto' } : { model: this.model, messages },
    );
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
    const msg = data.choices?.[0]?.message ?? {};
    return { content: msg.content ?? '', toolCalls: msg.tool_calls ?? [], raw: msg as Record<string, unknown> };
  }
  async draftReply(req: DraftRequest): Promise<DraftResult> {
    if (!this.apiKey) throw new Error('ChatGPT needs an API key — add it via ⚙️ AI settings (or OPENAI_API_KEY).');
    const messages: unknown[] = [{ role: 'system', content: buildSystemPrompt(req) }, ...buildChatTurns(req)];
    if (!this.mcp) return this.done((await this.chat(messages)).content);

    let lastAssistant: Record<string, unknown> = {};
    const driver: ToolLoopDriver = {
      encodeTools: (tools: McpToolDef[]) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema } })),
      step: async (tools) => {
        const r = await this.chat(messages, tools);
        lastAssistant = r.raw;
        return { text: r.content, calls: r.toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, args: parseArgs(tc.function.arguments) })) };
      },
      record: (calls, results) => {
        messages.push(lastAssistant); // assistant turn carrying the tool_calls
        calls.forEach((c, i) => messages.push({ role: 'tool', tool_call_id: c.id, content: results[i] }));
      },
    };
    return this.done(await runMcpToolLoop(this.mcp, driver));
  }
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
}

export class GeminiProvider extends HttpProvider {
  readonly id = 'gemini';
  private readonly mcp?: McpClient;
  constructor(opts: CloudProviderOptions = {}) {
    super(opts, 'GEMINI_API_KEY', 'gemini-2.5-flash');
    this.mcp = opts.mcpClient;
  }
  private async generate(systemInstruction: unknown, contents: unknown[], tools?: unknown): Promise<GeminiPart[]> {
    const res = await this.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      { 'x-goog-api-key': this.apiKey }, // key in a header, never the URL query
      tools ? { systemInstruction, contents, tools } : { systemInstruction, contents },
    );
    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> };
    return data.candidates?.[0]?.content?.parts ?? [];
  }
  async draftReply(req: DraftRequest): Promise<DraftResult> {
    if (!this.apiKey) throw new Error('Gemini needs an API key — add it via ⚙️ AI settings (or GEMINI_API_KEY).');
    const systemInstruction = { parts: [{ text: buildSystemPrompt(req) }] };
    const contents: unknown[] = buildChatTurns(req).map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] }));
    const textOf = (parts: GeminiPart[]) => parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('');
    if (!this.mcp) return this.done(textOf(await this.generate(systemInstruction, contents)));

    let lastParts: GeminiPart[] = [];
    const driver: ToolLoopDriver = {
      encodeTools: (tools: McpToolDef[]) => [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description ?? '', parameters: geminiToolSchema(t.inputSchema) })) }],
      step: async (tools) => {
        lastParts = await this.generate(systemInstruction, contents, tools);
        const calls = lastParts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
        return { text: textOf(lastParts), calls };
      },
      record: (calls, results) => {
        contents.push({ role: 'model', parts: lastParts }); // model turn with the functionCall parts
        contents.push({ role: 'user', parts: calls.map((c, i) => ({ functionResponse: { name: c.name, response: { result: results[i] } } })) });
      },
    };
    return this.done(await runMcpToolLoop(this.mcp, driver));
  }
}
