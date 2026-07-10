import type { DraftRequest, DraftResult, LLMProvider } from './LLMProvider';
import { buildSystemPrompt, buildChatTurns } from './prompt';

export interface CloudProviderOptions {
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
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
    if (res.ok === false) throw new Error(`${this.id} ${res.status}: request failed`);
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
  constructor(opts: CloudProviderOptions = {}) {
    super(opts, 'ANTHROPIC_API_KEY', 'claude-haiku-4-5');
  }
  async draftReply(req: DraftRequest): Promise<DraftResult> {
    if (!this.apiKey) throw new Error('Claude needs an API key — set ANTHROPIC_API_KEY in .env.');
    const res = await this.post(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      { model: this.model, max_tokens: 500, system: buildSystemPrompt(req), messages: buildChatTurns(req) },
    );
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return this.done(data.content?.[0]?.text ?? '');
  }
}

export class OpenAiProvider extends HttpProvider {
  readonly id = 'openai';
  constructor(opts: CloudProviderOptions = {}) {
    super(opts, 'OPENAI_API_KEY', 'gpt-4o-mini');
  }
  async draftReply(req: DraftRequest): Promise<DraftResult> {
    if (!this.apiKey) throw new Error('ChatGPT needs an API key — set OPENAI_API_KEY in .env.');
    const messages = [{ role: 'system', content: buildSystemPrompt(req) }, ...buildChatTurns(req)];
    const res = await this.post(
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${this.apiKey}` },
      { model: this.model, messages },
    );
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return this.done(data.choices?.[0]?.message?.content ?? '');
  }
}

export class GeminiProvider extends HttpProvider {
  readonly id = 'gemini';
  constructor(opts: CloudProviderOptions = {}) {
    super(opts, 'GEMINI_API_KEY', 'gemini-2.0-flash');
  }
  async draftReply(req: DraftRequest): Promise<DraftResult> {
    if (!this.apiKey) throw new Error('Gemini needs an API key — set GEMINI_API_KEY in .env.');
    const contents = buildChatTurns(req).map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content }],
    }));
    const res = await this.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      { 'x-goog-api-key': this.apiKey }, // key in a header, never the URL query
      { systemInstruction: { parts: [{ text: buildSystemPrompt(req) }] }, contents },
    );
    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return this.done(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '');
  }
}
