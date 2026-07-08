import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['out/mcp/server.mjs'], cwd: process.cwd() }));

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

const list = await client.callTool({ name: 'list_threads', arguments: { channel: 'whatsapp', limit: 3 } });
const rows = JSON.parse(list.content[0].text);
console.log(`list_threads → ${rows.length} threads. first: ${rows[0]?.customer} | ${(rows[0]?.preview || '').slice(0, 45)}`);

if (rows[0]) {
  const th = await client.callTool({ name: 'get_thread', arguments: { threadId: rows[0].threadId } });
  console.log('get_thread → history msgs:', JSON.parse(th.content[0].text).history.length);
  const draft = await client.callTool({ name: 'draft_reply', arguments: { threadId: rows[0].threadId } });
  console.log('draft_reply →', JSON.stringify(draft.content[0].text.slice(0, 180)));
}
await client.close();
process.exit(0);
