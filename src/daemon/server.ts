import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { RigError, type CmdResult } from '../types.js';
import { toErrorBody } from '../util.js';
import { dispatch } from './dispatch.js';
import { busy, resolveTarget, serialize } from './browser.js';

const MAX_BODY_BYTES = 1024 * 1024;

/** The port the daemon is listening on, once it is. */
let listeningPort = 0;
export function getPort(): number {
  return listeningPort;
}

const LIVE_HTML = `<!doctype html><html><head><meta charset="utf8"><title>rig live</title>
<style>body{margin:0;background:#111;display:grid;place-items:center;min-height:100vh}
img{max-width:100vw;max-height:100vh}</style></head><body>
<img id="v" src="">
<script>const v=document.getElementById('v');const q=new URLSearchParams(location.search);
const tick=()=>{v.src='/live.jpg?t='+Date.now()+'&target='+(q.get('target')||'active')+'&token='+encodeURIComponent(q.get('token')||'')};
tick();setInterval(tick,500);
</script></body></html>`;

const liveCache = new Map<string, { at: number; buf: Buffer }>();

/** Set once the browser is up; until then commands are refused with BOOTING. */
let ready = false;
export function markReady(): void {
  ready = true;
}
let stopping = false;
export function markStopping(): void {
  stopping = true;
}

/**
 * Only the loopback names the daemon binds to may appear in Host. A page on any
 * other origin whose name resolves to 127.0.0.1 (DNS rebinding) sends its own
 * hostname here and is refused.
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RigError('BODY_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function errorBody(err: unknown): CmdResult {
  return { ...toErrorBody(err) };
}

/** Send 403 and report false unless the request carried the token. */
function requireAuth(res: ServerResponse, authed: boolean): boolean {
  if (authed) return true;
  send(res, 403, { error: 'bad token', code: 'FORBIDDEN' });
  return false;
}

export function startServer(port: number, token: string): Promise<number> {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const body = errorBody(err);
      send(res, body['code'] === 'BODY_TOO_LARGE' ? 413 : 500, body);
    });
  });
  // Nothing here should take longer than a slow wallet flow; anything else is stuck.
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 30_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${listeningPort}`);

    if (!hostAllowed(req.headers.host, listeningPort)) {
      send(res, 421, { error: 'unexpected Host header', code: 'BAD_HOST' });
      return;
    }

    const authed = tokenMatches(req.headers['x-rig-token'] ?? url.searchParams.get('token'), token);

    if (url.pathname === '/live') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LIVE_HTML);
      return;
    }

    if (url.pathname === '/live.jpg') {
      if (!requireAuth(res, authed)) return;
      const target = url.searchParams.get('target') ?? 'active';
      const cached = liveCache.get(target);
      if (cached && Date.now() - cached.at < 400) {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(cached.buf);
        return;
      }
      try {
        const buf = await serialize(async () => {
          const page = resolveTarget(target);
          return page.screenshot({ type: 'jpeg', quality: 60, scale: 'css' });
        });
        liveCache.set(target, { at: Date.now(), buf });
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(buf);
      } catch {
        res.writeHead(503).end();
      }
      return;
    }

    // Liveness for launchers: no browser or network work, so it answers at
    // once even while a long command holds the mutex.
    if (url.pathname === '/health' && req.method === 'GET') {
      if (!requireAuth(res, authed)) return;
      const state = stopping ? 'stopping' : ready ? 'ready' : 'booting';
      send(res, state === 'ready' ? 200 : 503, { state, [state]: true, pid: process.pid, busy: busy() });
      return;
    }

    if (url.pathname === '/status' && req.method === 'GET') {
      if (!requireAuth(res, authed)) return;
      if (stopping) {
        send(res, 503, { stopping: true, pid: process.pid });
        return;
      }
      if (!ready) {
        send(res, 503, { booting: true, pid: process.pid });
        return;
      }
      send(res, 200, await dispatch('status', {}));
      return;
    }

    if (url.pathname === '/cmd' && req.method === 'POST') {
      if (!requireAuth(res, authed)) return;
      if (stopping) {
        send(res, 503, { error: 'daemon is shutting down', code: 'STOPPING' });
        return;
      }
      if (!ready) {
        send(res, 503, { error: 'daemon is still starting the browser', code: 'BOOTING' });
        return;
      }
      const body = await readBody(req);
      let parsed: { cmd?: string; args?: Record<string, unknown> };
      try {
        parsed = JSON.parse(body) as { cmd?: string; args?: Record<string, unknown> };
      } catch {
        send(res, 400, { error: 'bad json', code: 'BAD_JSON' });
        return;
      }
      if (!parsed.cmd || typeof parsed.cmd !== 'string') {
        send(res, 400, { error: 'no cmd', code: 'BAD_ARGS' });
        return;
      }
      const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args) ? parsed.args : {};
      try {
        const result: CmdResult = await dispatch(parsed.cmd, args);
        send(res, 200, result);
      } catch (err) {
        send(res, 400, errorBody(err));
      }
      return;
    }

    res.writeHead(404).end('not found');
  }

  listeningPort = port;
  return new Promise((resolvePort, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      // Another checkout already holds the preferred port: fall back to any
      // free one rather than refusing to start.
      if (err.code === 'EADDRINUSE' && port !== 0) {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          listeningPort = typeof addr === 'object' && addr ? addr.port : 0;
          resolvePort(listeningPort);
        });
        return;
      }
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      listeningPort = typeof addr === 'object' && addr ? addr.port : port;
      resolvePort(listeningPort);
    });
  });
}
