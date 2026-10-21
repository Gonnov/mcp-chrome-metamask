/**
 * The CLI runs from a bundle (dist/cli.mjs) so each call skips the tsx loader.
 * A bundle older than any source would run stale code, so on start it checks,
 * and when stale rebuilds and hands the call to the fresh build.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Newest modification time of the .ts files under `dir`, 0 when there are none. */
export function newestSource(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const m = statSync(resolve(entry.parentPath, entry.name)).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

export function isStale(bundleMtime: number, sourceMtime: number): boolean {
  return sourceMtime > bundleMtime;
}

/**
 * When this process is the bundle and src/ has moved on, rebuild and rerun the
 * same call on the new build (or on the sources through tsx if the build
 * fails), then exit with its status. Returns only when the bundle is current
 * or the CLI is not running from one.
 */
export function rerunIfStale(root: string, moduleUrl: string): void {
  const self = fileURLToPath(moduleUrl);
  // The rerun below sets this, so a source dated in the future cannot loop.
  if (!self.endsWith('.mjs') || process.env['RIG_BUNDLE_RERUN']) return;
  let stale: boolean;
  try {
    stale = isStale(statSync(self).mtimeMs, newestSource(resolve(root, 'src')));
  } catch {
    return;
  }
  if (!stale) return;
  const args = process.argv.slice(2);
  let argv: string[];
  try {
    execFileSync(resolve(root, 'scripts/build-cli.sh'), { stdio: 'ignore' });
    argv = [self, ...args];
  } catch {
    argv = ['--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'), resolve(root, 'src/cli.ts'), ...args];
  }
  const r = spawnSync(process.execPath, argv, { stdio: 'inherit', env: { ...process.env, RIG_BUNDLE_RERUN: '1' } });
  process.exit(r.status ?? 1);
}
