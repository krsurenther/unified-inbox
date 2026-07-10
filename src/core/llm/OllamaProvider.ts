import type { DraftRequest, DraftResult, LLMProvider } from './LLMProvider';
import { buildSystemPrompt, buildChatTurns } from './prompt';
import type { McpClient, McpToolDef } from './mcp/McpClient';
import { runMcpToolLoop, type ToolLoopDriver } from './mcp/toolLoop';

export interface OllamaProviderOptions {
  baseUrl?: string; // default http://localhost:11434
  model?: string; // default 'gemma3:4b'
  fetchFn?: typeof fetch;
  temperature?: number;
  /** Abort a request that hasn't responded in this many ms (default 30_000). */
  timeoutMs?: number;
  /** MCP client so the local model can call Hub tools (needs a tool-capable model). */
  mcpClient?: McpClient;
}

interface OllamaMessage {
  role: string;
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
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
  private readonly mcp?: McpClient;

  constructor(opts: OllamaProviderOptions = {}) {
    this.base = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.model = opts.model ?? 'gemma3:4b';
    this.fetchFn = opts.fetchFn ?? fetch;
    this.temperature = opts.temperature ?? 0.5;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.mcp = opts.mcpClient;
  }

  private async chat(messages: unknown[], tools?: unknown): Promise<OllamaMessage> {
    const res = await this.fetchFn(`${this.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: false, options: { temperature: this.temperature }, ...(tools ? { tools } : {}) }),
      signal: AbortSignal.timeout(this.timeoutMs), // a hung model must not stall syncs forever
    });
    if (!(res as Response).ok && (res as Response).ok !== undefined) {
      throw new Error(`Ollama ${(res as Response).status}: chat request failed`);
    }
    const data = (await res.json()) as { message?: OllamaMessage };
    return data.message ?? { role: 'assistant' };
  }

  async draftReply(req: DraftRequest): Promise<DraftResult> {
    const messages: unknown[] = [{ role: 'system', content: buildSystemPrompt(req) }, ...buildChatTurns(req)];

    let text: string;
    if (!this.mcp) {
      text = ((await this.chat(messages)).content ?? '').trim();
    } else {
      let last: OllamaMessage = { role: 'assistant' };
      const driver: ToolLoopDriver = {
        encodeTools: (tools: McpToolDef[]) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema } })),
        step: async (tools) => {
          last = await this.chat(messages, tools);
          return { text: last.content ?? '', calls: (last.tool_calls ?? []).map((tc) => ({ name: tc.function.name, args: tc.function.arguments ?? {} })) };
        },
        record: (calls, results) => {
          messages.push(last); // assistant turn carrying the tool_calls
          calls.forEach((c, i) => messages.push({ role: 'tool', content: results[i] }));
        },
      };
      text = await runMcpToolLoop(this.mcp, driver);
    }

    if (!text) throw new Error('Ollama returned an empty draft (no content).');
    return { text, providerId: this.id, model: this.model };
  }
}
