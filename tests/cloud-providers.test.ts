import { describe, it, expect } from 'vitest';
import { ClaudeProvider, OpenAiProvider, GeminiProvider } from '../src/core/llm/cloud';
import type { DraftRequest } from '../src/core/llm/LLMProvider';

const req: DraftRequest = {
  thread: { id: 't1', channelId: 'whatsapp:num-1', channelKind: 'whatsapp', customerName: 'Aisha' },
  history: [
    { role: 'customer', text: 'Is the red one in stock?', at: '2026-06-24T00:00:00Z' },
    { role: 'agent', text: 'Let me check for you', at: '2026-06-24T00:01:00Z' },
    { role: 'customer', text: 'thanks!', at: '2026-06-24T00:02:00Z' },
  ],
  systemPrompt: 'You are a helpful support agent.',
};

function mockJson(reply: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    calls.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
    return { ok: true, status: 200, json: async () => reply } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('ClaudeProvider', () => {
  it('posts to the Anthropic messages API with system + mapped turns', async () => {
    const { fn, calls } = mockJson({ content: [{ type: 'text', text: '  Yes, in stock! ' }] });
    const res = await new ClaudeProvider({ apiKey: 'sk-ant-x', model: 'claude-haiku-4-5', fetchFn: fn }).draftReply(req);
    expect(res.text).toBe('Yes, in stock!');
    expect(res.providerId).toBe('claude');
    expect(calls[0]!.url).toContain('api.anthropic.com/v1/messages');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-x');
    expect(calls[0]!.headers['anthropic-version']).toBeTruthy();
    const body = calls[0]!.body as { system: string; messages: Array<{ role: string; content: string }> };
    expect(body.system).toContain('Aisha');
    expect(body.messages[0]).toEqual({ role: 'user', content: 'Is the red one in stock?' });
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'Let me check for you' });
  });
  it('throws (with a clear hint) when no API key is configured', async () => {
    const { fn } = mockJson({});
    await expect(new ClaudeProvider({ apiKey: '', fetchFn: fn }).draftReply(req)).rejects.toThrow(/ANTHROPIC_API_KEY/i);
  });
});

describe('OpenAiProvider', () => {
  it('posts to chat completions with a system message + bearer auth', async () => {
    const { fn, calls } = mockJson({ choices: [{ message: { content: 'On its way!' } }] });
    const res = await new OpenAiProvider({ apiKey: 'sk-x', model: 'gpt-4o-mini', fetchFn: fn }).draftReply(req);
    expect(res.text).toBe('On its way!');
    expect(res.providerId).toBe('openai');
    expect(calls[0]!.url).toContain('api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-x');
    const body = calls[0]!.body as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Is the red one in stock?' });
  });
  it('throws when no API key', async () => {
    const { fn } = mockJson({});
    await expect(new OpenAiProvider({ apiKey: '', fetchFn: fn }).draftReply(req)).rejects.toThrow(/OPENAI_API_KEY/i);
  });
});

describe('GeminiProvider', () => {
  it('posts to generateContent with systemInstruction + user/model roles + key header', async () => {
    const { fn, calls } = mockJson({ candidates: [{ content: { parts: [{ text: 'Hello!' }] } }] });
    const res = await new GeminiProvider({ apiKey: 'g-x', model: 'gemini-2.0-flash', fetchFn: fn }).draftReply(req);
    expect(res.text).toBe('Hello!');
    expect(res.providerId).toBe('gemini');
    expect(calls[0]!.url).toContain('generativelanguage.googleapis.com');
    expect(calls[0]!.headers['x-goog-api-key']).toBe('g-x'); // key in header, never the URL
    const body = calls[0]!.body as { systemInstruction: { parts: Array<{ text: string }> }; contents: Array<{ role: string; parts: Array<{ text: string }> }> };
    expect(body.systemInstruction.parts[0]!.text).toContain('Aisha');
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: 'Is the red one in stock?' }] });
    expect(body.contents[1]).toEqual({ role: 'model', parts: [{ text: 'Let me check for you' }] });
  });
  it('throws when no API key', async () => {
    const { fn } = mockJson({});
    await expect(new GeminiProvider({ apiKey: '', fetchFn: fn }).draftReply(req)).rejects.toThrow(/GEMINI_API_KEY/i);
  });
});
