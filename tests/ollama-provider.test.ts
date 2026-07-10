import { describe, it, expect } from 'vitest';
import { OllamaProvider } from '../src/core/llm/OllamaProvider';
import type { DraftRequest } from '../src/core/llm/LLMProvider';

function mockFetch(reply: unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return { ok: true, json: async () => reply };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const req: DraftRequest = {
  thread: { id: 't1', channelId: 'whatsapp:num-1', channelKind: 'whatsapp', customerName: 'Aisha' },
  history: [
    { role: 'customer', text: 'Is the red one in stock?', at: '2026-06-24T00:00:00Z' },
    { role: 'agent', text: 'Let me check for you', at: '2026-06-24T00:01:00Z' },
    { role: 'customer', text: 'thanks!', at: '2026-06-24T00:02:00Z' },
  ],
  systemPrompt: 'You are a helpful support agent.',
};

describe('OllamaProvider', () => {
  it('drafts a reply via the Ollama chat API with mapped history', async () => {
    const { fn, calls } = mockFetch({ message: { role: 'assistant', content: '  Yes! The red one is in stock. ' } });
    const res = await new OllamaProvider({ model: 'gemma3:4b', fetchFn: fn }).draftReply(req);

    expect(res.text).toBe('Yes! The red one is in stock.'); // trimmed
    expect(res.providerId).toBe('ollama');
    expect(res.model).toBe('gemma3:4b');

    const body = calls[0]!.body as { model: string; stream: boolean; messages: Array<{ role: string; content: string }> };
    expect(calls[0]!.url).toContain('/api/chat');
    expect(body.model).toBe('gemma3:4b');
    expect(body.stream).toBe(false);
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[0]!.content).toContain('Aisha');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Is the red one in stock?' });
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'Let me check for you' });
    expect(body.messages[3]).toEqual({ role: 'user', content: 'thanks!' });
  });

  it('throws a clear error when Ollama returns no content', async () => {
    const { fn } = mockFetch({ message: { role: 'assistant', content: '' } });
    await expect(new OllamaProvider({ model: 'gemma3:4b', fetchFn: fn }).draftReply(req)).rejects.toThrow(/empty|no content/i);
  });

  it('aborts a hung request after timeoutMs', async () => {
    // A fetch that never resolves on its own — only the abort signal ends it.
    const hung = ((_url: string | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
      })) as unknown as typeof fetch;
    await expect(
      new OllamaProvider({ model: 'gemma3:4b', fetchFn: hung, timeoutMs: 25 }).draftReply(req),
    ).rejects.toThrow(/abort|timed?\s?out/i);
  });
});
