import type { DraftRequest, DraftResult, LLMProvider } from './LLMProvider';
import { buildSystemPrompt, buildChatTurns } from './prompt';

export interface OllamaProviderOptions {
  baseUrl?: string; // default http://localhost:11434
  model?: string; // default 'gemma3:4b'
  fetchFn?: typeof fetch;
  temperature?: number;
  /** Abort a request that hasn't responded in this many ms (default 30_000). */
  timeoutMs?: number;
}

/**
 * Real local LLM via Ollama's chat API. Swaps in for EchoProvider behind the
 * same LLMProvider interface — business logic is unchanged. Runs entirely on the
 * user's machine (no cloud, no cost). Cloud adapters (Claude/OpenAI) slot in the
 * same way when keys are configured.
 */
export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  private readonly base: string;
  private readonly model: string;
  private readonly fetchFn: typeof fetch;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(opts: OllamaProviderOptions = {}) {
    this.base = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.model = opts.model ?? 'gemma3:4b';
    this.fetchFn = opts.fetchFn ?? fetch;
    this.temperature = opts.temperature ?? 0.5;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async draftReply(req: DraftRequest): Promise<DraftResult> {
    const messages = [{ role: 'system', content: buildSystemPrompt(req) }, ...buildChatTurns(req)];

    const res = await this.fetchFn(`${this.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: false, options: { temperature: this.temperature } }),
      signal: AbortSignal.timeout(this.timeoutMs), // a hung model must not stall syncs forever
    });
    if (!(res as Response).ok && (res as Response).ok !== undefined) {
      throw new Error(`Ollama ${(res as Response).status}: chat request failed`);
    }
    const data = (await res.json()) as { message?: { content?: string }; done_reason?: string };
    const text = (data.message?.content ?? '').trim();
    if (!text) throw new Error('Ollama returned an empty draft (no content).');

    return { text, providerId: this.id, model: this.model, finishReason: data.done_reason };
  }
}
