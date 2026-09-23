/**
 * One complete Laika purchase driven entirely through the MCP tools, as a
 * client would drive them. Proof that the server is usable for the real job,
 * and a worked example for anyone installing it.
 */
import { McpClient } from './mcp-client.js';
import { McpDriver, buyOnce, loopOptions } from './laika.js';

const { opts } = loopOptions(process.argv.slice(2));
const mcp = new McpClient();
await mcp.init();
console.log('tools:', (await mcp.listTools()).join(', '));
await mcp.json('rig_session', { action: 'start' });
const result = await buyOnce(new McpDriver(mcp), 1, { ...opts, restart: false });
mcp.close();
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
