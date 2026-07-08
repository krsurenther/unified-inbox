// Bundle the MCP server into a single runnable file: out/mcp/server.mjs
//   npm run build:mcp
import { build } from 'esbuild';

await build({
  entryPoints: ['src/mcp/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'out/mcp/server.mjs',
  // Some bundled deps use require(); shim it under ESM.
  banner: { js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);" },
});
console.log('built out/mcp/server.mjs');
