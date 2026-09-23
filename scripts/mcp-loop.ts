/**
 * Acceptance through the MCP tools: N purchases in a row, each in a freshly
 * restarted browser (rig_session stop/start), verified against the chain.
 *
 *   pnpm mcp:loop -- --runs 10 [--token 0x...] [--amount 0.05] [--keep-session]
 */
import { McpClient } from './mcp-client.js';
import { McpDriver, buyOnce, loopOptions, type RunResult } from './laika.js';

const { runs, opts } = loopOptions(process.argv.slice(2));
const mcp = new McpClient();
await mcp.init();
const driver = new McpDriver(mcp);

const results: RunResult[] = [];
for (let i = 1; i <= runs; i++) {
  const r = await buyOnce(driver, i, opts);
  results.push(r);
  console.log(JSON.stringify(r));
}
mcp.close();
const passed = results.filter((r) => r.ok).length;
console.log(JSON.stringify({ summary: `${passed}/${runs} passed`, passed, runs, via: 'mcp' }));
if (passed !== runs) process.exit(1);
