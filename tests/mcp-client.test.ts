import { describe, it, expect } from 'vitest';
import { McpClient } from '../src/core/llm/mcp/McpClient';

/** Mock a Streamable-HTTP MCP server that replies with plain JSON, keyed by method. */
function mockMcp(results: Record<string, unknown>) {
  const calls: Array<{ method: string; params: unknown; headers: Record<string, string> }> = [];
  const fn = (async (_url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: unknown };
    calls.push({ method: body.method, params: body.params, headers });
    if (body.id == null) return { ok: true, status: 202, headers: new Headers(), text: async () => '' } as Response; // notification
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: results[body.method] ?? {} }),
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('McpClient', () => {
  it('initializes once, lists tools, and carries the session id + bearer token', async () => {
    const { fn, calls } = mockMcp({
      'tools/list': { tools: [{ name: 'stock_levels', description: 'Get stock', inputSchema: { type: 'object', properties: { sku: { type: 'string' } } } }] },
    });
    const c = new McpClient({ url: 'https://hub/mcp', token: 'tok', fetchFn: fn });
    const tools = await c.listTools();
    expect(tools[0]).toMatchObject({ name: 'stock_levels', description: 'Get stock' });
    expect(calls.map((x) => x.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(calls[0]!.headers['authorization']).toBe('Bearer tok');
    expect(calls[2]!.headers['mcp-session-id']).toBe('sess-1'); // captured from the initialize response

    await c.listTools(); // cached — no more requests
    expect(calls).toHaveLength(3);
  });

  it('calls a tool and flattens its text content', async () => {
    const { fn, calls } = mockMcp({ 'tools/call': { content: [{ type: 'text', text: '2 units at Temerloh' }] } });
    const c = new McpClient({ url: 'https://hub/mcp', fetchFn: fn });
    const out = await c.callTool('stock_levels', { sku: 'X' });
    expect(out).toBe('2 units at Temerloh');
    const call = calls.find((x) => x.method === 'tools/call')!;
    expect(call.params).toEqual({ name: 'stock_levels', arguments: { sku: 'X' } });
  });

  it('parses an SSE (text/event-stream) response body', async () => {
    const fn = (async (_u: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (body.id == null) return { ok: true, status: 202, headers: new Headers(), text: async () => '' } as Response;
      const result = body.method === 'tools/call' ? { content: [{ type: 'text', text: 'SSE ok' }] } : { tools: [] };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`,
      } as Response;
    }) as unknown as typeof fetch;
    const c = new McpClient({ url: 'https://hub/mcp', fetchFn: fn });
    expect(await c.callTool('x', {})).toBe('SSE ok');
  });
});
