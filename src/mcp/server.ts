import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { setDefaultResultOrder } from 'node:dns';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { InboxStore } from '../core/store/InboxStore';
import { LlmRouter } from '../core/llm/LlmRouter';
import { EchoProvider } from '../core/llm/EchoProvider';
import { OllamaProvider } from '../core/llm/OllamaProvider';
import { AppConfigSchema } from '../core/config/Config';

// See index.ts — some hosts' IPv6 hangs; prefer IPv4.
setDefaultResultOrder('ipv4first');

/**
 * Local MCP server over the unified inbox. Exposes READ tools (list conversations,
 * read a conversation) and DRAFT (generate an AI reply) so any MCP client can
 * triage the inbox. It deliberately does NOT expose approve/send — approval and
 * sending happen only in the desktop app (human-in-the-loop).
 *
 * Opens the same SQLite store the desktop app writes. Point an MCP client at:
 *   node <repo>/out/mcp/server.mjs
 */
const dbPath =
  process.env.UNIFIED_INBOX_DB ?? join(homedir(), 'Library', 'Application Support', 'unified-inbox', 'inbox.sqlite');
if (!existsSync(dbPath)) {
  console.error(`[unified-inbox mcp] no database at ${dbPath} — launch the desktop app once first.`);
  process.exit(1);
}
// Read-only: this process must never write the shared inbox. draft_reply returns
// text only; approval/sending live in the desktop app (human-in-the-loop).
const store = new InboxStore(dbPath, { readOnly: true });
const config = AppConfigSchema.parse({ defaultProvider: 'ollama' });
const router = new LlmRouter(config, {
  echo: new EchoProvider(),
  ollama: new OllamaProvider({ baseUrl: process.env.OLLAMA_BASE_URL, model: process.env.OLLAMA_MODEL }),
});

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const err = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

const server = new McpServer({ name: 'unified-inbox', version: '0.1.0' });

server.registerTool(
  'list_threads',
  {
    title: 'List inbox conversations',
    description:
      'List customer conversations across all channels (WhatsApp, Lazada/TikTok/Shopee via Duoke, webstore), newest first. Optionally filter by channel.',
    inputSchema: {
      channel: z.enum(['all', 'whatsapp', 'duoke', 'webstore']).optional().describe("Channel filter; 'duoke' = the marketplaces. Default all."),
      limit: z.number().int().min(1).max(200).optional().describe('Max threads to return (default 30).'),
    },
  },
  async ({ channel, limit }) => {
    let threads = store.listThreads();
    if (channel && channel !== 'all') threads = threads.filter((t) => t.channel.kind === channel);
    const rows = threads.slice(0, limit ?? 30).map((t) => ({
      threadId: t.thread.id,
      channel: t.channel.label,
      customer: t.customer.name ?? t.customer.externalId,
      unread: t.thread.unread,
      lastMessageAt: t.thread.lastMessageAt,
      preview: t.lastMessagePreview,
    }));
    return text(rows);
  },
);

server.registerTool(
  'get_thread',
  {
    title: 'Read a conversation',
    description: 'Get the full message history (both directions) for one conversation by threadId.',
    inputSchema: { threadId: z.string().describe('The threadId from list_threads.') },
  },
  async ({ threadId }) => {
    const view = store.getThreadView(threadId);
    if (!view) return err(`No thread with id ${threadId}`);
    return text({
      customer: view.customer.name ?? view.customer.externalId,
      channel: view.channel.label,
      history: store.getHistory(threadId).map((m) => ({ direction: m.direction, body: m.body, at: m.createdAt })),
    });
  },
);

server.registerTool(
  'draft_reply',
  {
    title: 'Draft a reply',
    description:
      "Generate an AI-drafted reply for a conversation from its history + channel context. Returns the draft TEXT only — it is NOT saved or sent. Approval and sending happen only in the desktop app.",
    inputSchema: { threadId: z.string().describe('The threadId to draft a reply for.') },
  },
  async ({ threadId }) => {
    const view = store.getThreadView(threadId);
    if (!view) return err(`No thread with id ${threadId}`);
    const history = store.getHistory(threadId).map((m) => ({
      role: m.direction === 'inbound' ? ('customer' as const) : ('agent' as const),
      text: m.body,
      at: m.createdAt,
    }));
    try {
      const result = await router.draft(view.channel.id, {
        thread: { id: threadId, channelId: view.channel.id, channelKind: view.channel.kind, customerName: view.customer.name },
        history,
        systemPrompt: config.systemPrompt,
      });
      return text(result.text);
    } catch (e) {
      return err(`Draft failed: ${(e as Error).message}`);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error('[unified-inbox mcp] ready on stdio; db:', dbPath);
