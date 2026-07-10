import type { McpClient, McpToolDef } from './McpClient';

export interface McpToolCall {
  id?: string; // provider-assigned call id (OpenAI/Ollama); Gemini keys by name
  name: string;
  args: Record<string, unknown>;
}

export interface ModelTurn {
  text?: string;
  calls?: McpToolCall[];
}

/**
 * A provider plugs its request/response shape into these three hooks; the loop
 * below is identical for everyone. `step` calls the model with the running
 * conversation + encoded tools; if it asks for tools, `record` appends the
 * assistant turn and the tool results so the next `step` can continue.
 */
export interface ToolLoopDriver {
  encodeTools(tools: McpToolDef[]): unknown;
  step(encodedTools: unknown): Promise<ModelTurn>;
  record(calls: McpToolCall[], results: string[]): void;
}

/**
 * Drive a model through an MCP tool-use conversation and return its final text.
 * Tool errors are fed back to the model (not thrown) so it can recover or apologize.
 */
export async function runMcpToolLoop(mcp: McpClient, driver: ToolLoopDriver, maxIterations = 4): Promise<string> {
  const encoded = driver.encodeTools(await mcp.listTools());
  for (let i = 0; i < maxIterations; i++) {
    const turn = await driver.step(encoded);
    if (!turn.calls?.length) return (turn.text ?? '').trim();
    const results = await Promise.all(
      turn.calls.map((c) => mcp.callTool(c.name, c.args).catch((e) => `Tool "${c.name}" failed: ${(e as Error).message}`)),
    );
    driver.record(turn.calls, results);
  }
  throw new Error('MCP tool loop did not converge (too many tool rounds).');
}

/** Best-effort JSON parse of a tool-call argument string (OpenAI sends a string). */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
