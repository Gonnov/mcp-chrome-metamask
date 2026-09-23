/** Speak MCP over stdio to the server and exercise a few tools for real. */
import { McpClient } from './mcp-client.js';
import { FIXTURES } from './fixtures.js';

const mcp = new McpClient();
await mcp.init();
console.log('tools:', (await mcp.listTools()).join(', '));

const call = async (name: string, args: Record<string, unknown>): Promise<void> => {
  const r = await mcp.call(name, args);
  console.log(`${name} ${JSON.stringify(args)} -> ${McpClient.describe(r)}`);
};

await call('rig_session', { action: 'start' });
await call('rig_session', { action: 'status' });
await call('rig_navigate', { action: 'goto', url: FIXTURES.app });
await call('rig_navigate', { action: 'resize', width: 1440, height: 900, target: 'app' });
await call('rig_navigate', { action: 'wait', for: 'ms', value: '6000', target: 'app' });
await call('rig_look', { action: 'aria', target: 'app' });
await call('rig_look', { action: 'screenshot', target: 'app' });
await call('rig_chain', { action: 'info' });
await call('rig_wallet', { action: 'status' });

mcp.close();
