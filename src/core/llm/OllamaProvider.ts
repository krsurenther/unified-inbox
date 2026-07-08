import type { DraftRequest, DraftResult, LLMProvider } from './LLMProvider';

export interface OllamaProviderOptions {
  baseUrl?: string; // default http://localhost:11434
  model?: string; // default 'gemma3:4b'
  fetchFn?: typeof fetch;
  temperature?: number;
}

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  duoke: 'a marketplace (Lazada/TikTok/Shopee)',
  webstore: 'the webstore live chat',
  fake: 'a demo',
};

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

  constructor(opts: OllamaProviderOptions = {}) {
    this.base = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.model = opts.model ?? 'gemma3:4b';
    this.fetchFn = opts.fetchFn ?? fetch;
    this.temperature = opts.temperature ?? 0.5;
  }

  async draftReply(req: DraftRequest): Promise<DraftResult> {
    const messages = [
      { role: 'system', content: buildSystemPrompt(req) },
      ...req.history.map((h) => ({ role: h.role === 'customer' ? 'user' : 'assistant', content: h.text })),
    ];
    // Chat models return an empty turn when the last message is the assistant's
    // (nothing to add). Nudge with a final user instruction so a draft is always
    // produced — e.g. when regenerating on an already-answered thread.
    if (messages[messages.length - 1]?.role !== 'user') {
      messages.push({ role: 'user', content: 'Draft the seller’s next reply to this customer now — output only the message text.' });
    }

    const res = await this.fetchFn(`${this.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: false, options: { temperature: this.temperature } }),
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

function buildSystemPrompt(req: DraftRequest): string {
  const channel = CHANNEL_LABEL[req.thread.channelKind] ?? req.thread.channelKind;
  const who = req.thread.customerName ? ` You are talking to ${req.thread.customerName}.` : '';
  return (
    `${req.systemPrompt}\n\n` +
    `You are drafting the seller's next reply in ${channel}.${who} ` +
    `Reply in the customer's language. Write ONLY the message to send — no quotes, ` +
    `no "Draft:" prefix, no explanation, no options. Keep it concise, warm, and helpful. ` +
    `If you don't have enough information (e.g. exact price, stock, or order status), don't invent it — ` +
    `say you'll check and get back to them.`
  );
}
