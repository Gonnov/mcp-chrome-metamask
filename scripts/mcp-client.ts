/** Minimal MCP stdio client, so scripts can drive the server as a real client. */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { resolve } from 'node:path';
import { ROOT } from '../src/daemon/state.js';

export interface ToolResult {
  content?: { type: string; text?: string; data?: string }[];
  isError?: boolean;
}

export class McpClient {
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private buffer = '';
  private id = 0;
  private pending = new Map<number, (v: unknown) => void>();

  constructor() {
    this.child = spawn(
      process.execPath,
      ['--import', resolve(ROOT, 'node_modules/tsx/dist/loader.mjs'), resolve(ROOT, 'src/mcp.ts')],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      } catch {
        // Anything that is not a protocol frame is noise from a dependency.
        process.stderr.write(`[non-protocol stdout] ${line.slice(0, 300)}\n`);
        continue;
      }
      if (msg.id !== undefined) {
        this.pending.get(msg.id)?.(msg.result ?? msg.error);
        this.pending.delete(msg.id);
      }
    }
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const myId = ++this.id;
    return new Promise((res) => {
      this.pending.set(myId, res);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
    });
  }

  async init(): Promise<void> {
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'rig-script', version: '0' },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  async listTools(): Promise<string[]> {
    const r = (await this.send('tools/list', {})) as { tools: { name: string }[] };
    return r.tools.map((t) => t.name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await this.send('tools/call', { name, arguments: args })) as ToolResult;
  }

  /** Tool results are content blocks; most of ours are a single JSON payload. */
  async json(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.call(name, args);
    const block = (r.content ?? []).find((c) => c.type === 'text');
    if (r.isError) throw new Error(block?.text ?? 'tool error');
    try {
      return JSON.parse(block?.text ?? '{}') as Record<string, unknown>;
    } catch {
      return { raw: block?.text };
    }
  }

  /** One line per content block: text truncated, images by size. */
  static describe(r: ToolResult): string {
    return (r.content ?? [])
      .map((c) => (c.type === 'image' ? `[image ${Math.round((c.data?.length ?? 0) / 1024)}KB]` : (c.text ?? '').slice(0, 220)))
      .join(' | ');
  }

  close(): void {
    this.child.kill();
  }
}
