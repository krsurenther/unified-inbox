import { describe, it, expect } from 'vitest';
import { ClaudeProvider, OpenAiProvider, GeminiProvider } from '../src/core/llm/cloud';
import { McpClient } from '../src/core/llm/mcp/McpClient';
import type { DraftRequest } from '../src/core/llm/LLMProvider';

/** A mock MCP server (one tool that returns stock text) for the tool-loop tests. */
function mcpClientFor() {
  const fn = (async (_u: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (body.id == null) return { ok: true, status: 202, headers: new Headers(), text: async () => '' } as Response;
    const result =
      body.method === 'tools/list'
        ? { tools: [{ name: 'stock_levels', description: 'Live stock', inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, additionalProperties: false } }] }
        : body.method === 'tools/call'
          ? { content: [{ type: 'text', text: '2 units at Temerloh' }] }
          : {};
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) } as Response;
  }) as unknown as typeof fetch;
  return new McpClient({ url: 'https://hub/mcp', token: 't', fetchFn: fn });
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
  it('attaches the Hub MCP connector when configured, and reads the answer past the tool blocks', async () => {
    const { fn, calls } = mockJson({
      content: [
        { type: 'mcp_tool_use', name: 'stock_levels' },
        { type: 'mcp_tool_result' },
        { type: 'text', text: 'ada 2 unit kat Temerloh 👍' },
      ],
    });
    const res = await new ClaudeProvider({ apiKey: 'sk-ant-x', fetchFn: fn, mcp: { url: 'https://hub.example/mcp', token: 'svc-tok' } }).draftReply(req);
    expect(res.text).toBe('ada 2 unit kat Temerloh 👍'); // final text, not the tool-use blocks
    expect(calls[0]!.headers['anthropic-beta']).toContain('mcp-client-2025-11-20');
    const body = calls[0]!.body as { mcp_servers: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> };
    expect(body.mcp_servers[0]).toMatchObject({ type: 'url', url: 'https://hub.example/mcp', name: 'kronoshop-hub', authorization_token: 'svc-tok' });
    expect(body.tools[0]).toEqual({ type: 'mcp_toolset', mcp_server_name: 'kronoshop-hub' });
  });
  it('omits MCP fields (and the beta header) when the Hub MCP is not configured', async () => {
    const { fn, calls } = mockJson({ content: [{ type: 'text', text: 'hi' }] });
    await new ClaudeProvider({ apiKey: 'sk-ant-x', fetchFn: fn }).draftReply(req);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.mcp_servers).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(calls[0]!.headers['anthropic-beta']).toBeUndefined();
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

describe('MCP tool loop (non-Claude providers)', () => {
  it('Gemini calls a Hub tool, then answers from the tool result', async () => {
    let gen = 0;
    const calls: Array<Record<string, unknown>> = [];
    const llm = (async (_u: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      gen += 1;
      const parts = gen === 1 ? [{ functionCall: { name: 'stock_levels', args: { sku: 'CU8100' } } }] : [{ text: 'ada 2 unit kat Temerloh 👍' }];
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts } }] }) } as Response;
    }) as unknown as typeof fetch;

    const res = await new GeminiProvider({ apiKey: 'g', fetchFn: llm, mcpClient: mcpClientFor() }).draftReply(req);
    expect(res.text).toBe('ada 2 unit kat Temerloh 👍');
    // 1st call declared the tool (schema stripped of additionalProperties for Gemini)
    const decl = (calls[0]!.tools as Array<{ functionDeclarations: Array<{ name: string; parameters: Record<string, unknown> }> }>)[0]!.functionDeclarations[0]!;
    expect(decl.name).toBe('stock_levels');
    expect(decl.parameters).not.toHaveProperty('additionalProperties');
    // 2nd call carried the functionResponse turn back to the model
    const contents = calls[1]!.contents as Array<{ parts?: Array<{ functionResponse?: { name: string; response: { result: string } } }> }>;
    const fr = contents.flatMap((c) => c.parts ?? []).find((p) => p.functionResponse);
    expect(fr?.functionResponse?.response.result).toBe('2 units at Temerloh');
  });

  it('OpenAI calls a Hub tool, then answers from the tool result', async () => {
    let turn = 0;
    const calls: Array<Record<string, unknown>> = [];
    const llm = (async (_u: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      turn += 1;
      const message =
        turn === 1
          ? { tool_calls: [{ id: 'call_1', function: { name: 'stock_levels', arguments: '{"sku":"CU8100"}' } }] }
          : { content: 'In stock — 2 units at Temerloh.' };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) } as Response;
    }) as unknown as typeof fetch;

    const res = await new OpenAiProvider({ apiKey: 'sk', fetchFn: llm, mcpClient: mcpClientFor() }).draftReply(req);
    expect(res.text).toBe('In stock — 2 units at Temerloh.');
    const secondMsgs = calls[1]!.messages as Array<{ role: string; tool_call_id?: string; content?: string }>;
    const toolMsg = secondMsgs.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ tool_call_id: 'call_1', content: '2 units at Temerloh' });
  });
});
