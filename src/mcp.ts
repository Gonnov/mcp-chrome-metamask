/**
 * MCP server for mcp-chrome-metamask.
 *
 * A thin client over the browser daemon rather than an owner of it: MCP servers
 * live and die with a session, and the browser should not. The daemon is started
 * on demand and survives restarts of this process.
 *
 * Nothing may write to stdout here except protocol frames.
 */
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { DaemonError, callDaemon, ensureDaemon } from './launcher.js';
import { launchArgsToArgv, parseLaunchArgs, setLaunchArgs } from './config.js';
import { tools } from './mcp/tools.js';
import type { Args } from './types.js';
import { bool as isTrue, numOpt as numOf, pick as passthrough, str, unknownKeys } from './args.js';
import { toErrorBody } from './util.js';

/** Widest image worth sending inline; beyond this the model downsamples anyway. */
const MAX_SHOT_WIDTH = 1000;

/** Errors keep their code and details, so a client can branch on CHAIN_NOT_ALLOWED and friends. */
function failure(err: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(toErrorBody(err), null, 2) }], isError: true };
}

function text(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function session(a: Args): Promise<CallToolResult> {
  const action = str(a, 'action') ?? 'status';
  switch (action) {
    case 'start': {
      // The daemon stages the wallet extension itself on first run; doing it
      // here too would make this process a second writer of the state file.
      const info = await ensureDaemon(isTrue(a, 'headless') || LAUNCH.headless === true, launchArgsToArgv(LAUNCH));
      return text({ started: true, port: info.port, pid: info.pid, headless: info.headless });
    }
    case 'stop':
      return text(
        await callDaemon('stop', {}, { autoStart: false }).catch((err: DaemonError) =>
          err.code === 'NO_DAEMON' ? { stopped: true, note: 'nothing was running' } : Promise.reject(err),
        ),
      );
    case 'pages':
      return text(await callDaemon('pages'));
    case 'boot':
      return text(await callDaemon('boot'));
    default:
      return text(await callDaemon('status'));
  }
}

async function navigate(a: Args): Promise<CallToolResult> {
  const action = str(a, 'action') ?? 'goto';
  const target = passthrough(a, ['target']);
  switch (action) {
    case 'wait': {
      const kind = str(a, 'for') ?? 'ms';
      const args: Args = { ...target, timeout: numOf(a, 'timeout') ?? 15_000 };
      if (kind === 'popup') args['popup'] = true;
      else if (kind === 'popup-gone') args['popup-gone'] = true;
      else if (kind === 'ms') args['ms'] = Number(str(a, 'value') ?? 500);
      else if (kind === 'selector') args['sel'] = str(a, 'value');
      else args[kind] = str(a, 'value');
      return text(await callDaemon('wait', args));
    }
    case 'resize':
      return text(
        await callDaemon('resize', {
          ...target,
          width: numOf(a, 'width') ?? 1440,
          height: numOf(a, 'height') ?? 900,
        }),
      );
    case 'close':
      return text(await callDaemon('close', target));
    case 'use':
      return text(await callDaemon('use', { value: str(a, 'value') ?? 'active' }));
    default:
      return text(await callDaemon('goto', { ...target, value: str(a, 'url') }));
  }
}

async function look(a: Args): Promise<CallToolResult> {
  const action = str(a, 'action') ?? 'screenshot';
  const target = passthrough(a, ['target']);
  switch (action) {
    case 'aria':
      return text(await callDaemon('aria', target));
    case 'ocr':
      return text(await callDaemon('ocr', target));
    case 'find':
      return text(await callDaemon('find', { ...target, value: str(a, 'text'), role: str(a, 'role') }));
    case 'console':
      return text(await callDaemon('console', target));
    default: {
      const shot = await callDaemon('shot', {
        ...target,
        annotate: isTrue(a, 'annotate'),
        full: isTrue(a, 'full_page'),
      });
      const path = String(shot['annotated'] ?? shot['path']);
      if (isTrue(a, 'path_only')) return text(shot);
      const raw = await readFile(path);

      // A full-resolution PNG of a desktop window costs more context than the
      // whole conversation around it, so downscale unless asked not to.
      if (isTrue(a, 'full_quality')) {
        return {
          content: [
            { type: 'text', text: JSON.stringify(shot) },
            { type: 'image', data: raw.toString('base64'), mimeType: 'image/png' },
          ],
        };
      }
      const meta = await sharp(raw).metadata();
      const width = Math.min(meta.width ?? MAX_SHOT_WIDTH, MAX_SHOT_WIDTH);
      const small = await sharp(raw).resize({ width }).jpeg({ quality: 72 }).toBuffer();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...shot, sentWidth: width, sentKB: Math.round(small.length / 1024) }),
          },
          { type: 'image', data: small.toString('base64'), mimeType: 'image/jpeg' },
        ],
      };
    }
  }
}

async function act(a: Args): Promise<CallToolResult> {
  const action = str(a, 'action') ?? 'click';
  const target = passthrough(a, ['target']);
  const nth = numOf(a, 'nth');
  switch (action) {
    case 'type':
      return text(
        await callDaemon('type', { ...target, value: str(a, 'text'), sel: str(a, 'selector'), nth }),
      );
    case 'press':
      return text(await callDaemon('press', { ...target, value: str(a, 'key') }));
    case 'scroll':
      return text(await callDaemon('scroll', { ...target, dy: numOf(a, 'dy') ?? 400 }));
    default:
      return text(
        await callDaemon('click', {
          ...target,
          text: str(a, 'text'),
          sel: str(a, 'selector'),
          id: str(a, 'ocr_id'),
          xy: str(a, 'xy'),
          role: str(a, 'role'),
          name: str(a, 'name'),
          nth,
        }),
      );
  }
}

async function wallet(a: Args): Promise<CallToolResult> {
  const action = str(a, 'action') ?? 'status';
  const common = passthrough(a, [
    'all', 'dry', 'version', 'chain_id', 'rpc_url', 'name', 'symbol', 'explorer',
    'key_file', 'target',
  ]);
  const map: Record<string, string> = { add_network: 'add-network', import_key: 'import-key' };
  const sub = map[action] ?? action;
  if (action === 'request') {
    return text(
      await callDaemon('mm.request', { ...common, value: str(a, 'method'), params: str(a, 'params') }),
    );
  }
  return text(await callDaemon(`mm.${sub}`, common));
}

async function chainTool(a: Args): Promise<CallToolResult> {
  const action = str(a, 'action') ?? 'info';
  const args = passthrough(a, ['doge', 'amount', 'blocks', 'rpc']);
  const value = str(a, 'address') ?? str(a, 'id');
  if (value !== undefined) args['value'] = value;
  return text(await callDaemon(`chain.${action}`, args));
}

async function evalTool(a: Args): Promise<CallToolResult> {
  const target = passthrough(a, ['target']);
  if ((str(a, 'action') ?? 'eval') === 'result') {
    return text(await callDaemon('result', { ...target, value: str(a, 'request_id') }));
  }
  return text(await callDaemon('eval', { ...target, value: str(a, 'code'), fire: isTrue(a, 'fire') }));
}

async function network(a: Args): Promise<CallToolResult> {
  const action = str(a, 'action') ?? 'list';
  const args = passthrough(a, ['chain_id', 'rpc_url', 'name', 'symbol', 'explorer']);
  if (action === 'allow' || action === 'disallow') {
    throw new DaemonError(
      'OPERATOR_ONLY',
      'vouching for a chain is an operator action: run "./bin/rig network allow <chainId>" from a shell, or fix the chain in the server entry.',
    );
  }
  return text(await callDaemon(`network.${action}`, args));
}

const handlers: Record<string, (a: Args) => Promise<CallToolResult>> = {
  rig_network: network,
  rig_session: session,
  rig_navigate: navigate,
  rig_look: look,
  rig_act: act,
  rig_wallet: wallet,
  rig_chain: chainTool,
  rig_eval: evalTool,
};

// The client's own server entry is the one configuration channel every MCP
// client supports, so the flags it passes have to be enough on their own.
function parseLaunchOrExit(): ReturnType<typeof parseLaunchArgs> {
  try {
    return parseLaunchArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`mcp-chrome-metamask: bad launch arguments: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
const LAUNCH = parseLaunchOrExit();
setLaunchArgs(LAUNCH);

const server = new Server(
  { name: 'mcp-chrome-metamask', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = handlers[req.params.name];
  const tool = tools.find((t) => t.name === req.params.name);
  if (!handler || !tool) {
    return failure(new DaemonError('UNKNOWN_TOOL', `unknown tool: ${req.params.name}`));
  }
  const args = (req.params.arguments ?? {}) as Args;
  const unknown = unknownKeys(tool.inputSchema.properties, args);
  if (unknown.length > 0) {
    return failure(
      new DaemonError(
        'UNKNOWN_ARGS',
        `${req.params.name} does not take: ${unknown.join(', ')}. Accepted: ${Object.keys(tool.inputSchema.properties).join(', ')}.`,
      ),
    );
  }
  try {
    return await handler(args);
  } catch (err) {
    return failure(err);
  }
});

try {
  await server.connect(new StdioServerTransport());
} catch (err) {
  process.stderr.write(`mcp-chrome-metamask: cannot start stdio transport: ${(err as Error).message}\n`);
  process.exit(1);
}
