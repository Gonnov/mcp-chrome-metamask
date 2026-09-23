import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { RigError } from '../types.js';
import { MM_ROOT, ensureDirs, readState, writeState } from '../daemon/state.js';

const run = promisify(execFile);

const MM_ID = 'nkbihfbeogaeaoehlefnkodbefgpgknn';

/** The release the rig is verified against; RIG_MM_VERSION overrides it. */
export const DEFAULT_MM_VERSION = '13.48.0';

/**
 * A browser-copied MetaMask carries the webstore key, so it keeps the canonical
 * extension id. A GitHub release build does not, so its id is derived from its
 * path. Different id means different extension storage, which would orphan an
 * already-onboarded wallet, so switching source is refused unless forced.
 */
function commitSource(
  dir: string,
  version: string,
  source: 'brave' | 'github',
  force: boolean,
): void {
  const state = readState();
  if (!force && state.onboarded && state.metamaskSource && state.metamaskSource !== source) {
    throw new RigError(
      'SOURCE_SWITCH',
      `this profile was set up from the ${state.metamaskSource} build; switching to ${source} changes the extension id and orphans the existing wallet. Pass force to do it anyway, then run wallet setup again.`,
    );
  }
  writeState({ metamaskDir: dir, metamaskVersion: version, metamaskSource: source });
}

const BROWSER_EXT_DIRS = [
  join(
    homedir(),
    'Library/Application Support/BraveSoftware/Brave-Browser/Default/Extensions',
    MM_ID,
  ),
  join(homedir(), 'Library/Application Support/Google/Chrome/Default/Extensions', MM_ID),
];

/** Newest installed MetaMask version directory across local browsers. */
async function findInstalled(): Promise<string | null> {
  const found: string[] = [];
  for (const dir of BROWSER_EXT_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of await readdir(dir)) {
      if (/^\d+\./.test(entry)) found.push(join(dir, entry));
    }
  }
  if (found.length === 0) return null;
  found.sort((a, b) => collateVersion(basename(a), basename(b)));
  return found[found.length - 1] ?? null;
}

function collateVersion(a: string, b: string): number {
  const pa = a.split(/[._]/).map(Number);
  const pb = b.split(/[._]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

async function verify(dir: string): Promise<{ version: string }> {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new RigError('BAD_EXTENSION', `no manifest.json in ${dir}`);
  }
  if (existsSync(join(dir, '_metadata'))) {
    throw new RigError(
      'BAD_EXTENSION',
      `${dir} still contains _metadata/; Chromium refuses to load it unpacked`,
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    version?: string;
    name?: string;
  };
  if (!manifest.version) throw new RigError('BAD_EXTENSION', 'manifest has no version');
  return { version: manifest.version };
}

/**
 * Stage MetaMask: copy a local install when there is one, otherwise download the
 * pinned release. A machine with no wallet installed is the normal case for
 * anyone but the author, so this must not require a local browser profile.
 */
export async function fetchAuto(version: string, force = false): Promise<Record<string, unknown>> {
  // Prefer whichever source this profile was already built from.
  const state = readState();
  if (state.metamaskSource === 'github') return fetchFromGithub(version, force);
  const local = await findInstalled();
  if (local) return fetchFromBrowser(force);
  return fetchFromGithub(version, force);
}

/** Copy an installed unpacked MetaMask, excluding reserved underscore dirs. */
export async function fetchFromBrowser(force = false): Promise<Record<string, unknown>> {
  ensureDirs();
  const src = await findInstalled();
  if (!src) {
    throw new RigError(
      'NO_SOURCE',
      'no installed MetaMask found in Brave or Chrome; use --version to download instead',
    );
  }
  const version = basename(src).replace(/_\d+$/, '');
  const dest = resolve(MM_ROOT, version);
  if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(src, dest, {
    recursive: true,
    // Chromium rejects unpacked extensions containing paths that start with "_".
    filter: (from) => !basename(from).startsWith('_metadata'),
  });
  const { version: manifestVersion } = await verify(dest);
  commitSource(dest, manifestVersion, 'brave', force);
  return { dir: dest, version: manifestVersion, source: src };
}

/** A release version: digits and dots only. Anything else is not a version and never a path. */
export const VERSION_RE = /^\d+(\.\d+){1,3}$/;

export function assertVersion(version: string): void {
  if (!VERSION_RE.test(version)) {
    throw new RigError('BAD_ARGS', `invalid MetaMask version "${version}": expected digits and dots, e.g. 13.48.0`);
  }
  const dest = resolve(MM_ROOT, version);
  if (!dest.startsWith(MM_ROOT + sep)) {
    throw new RigError('BAD_ARGS', `version "${version}" resolves outside the MetaMask staging directory`);
  }
}

/** Download a pinned release zip from GitHub and unpack it. */
export async function fetchFromGithub(version: string, force = false): Promise<Record<string, unknown>> {
  // Validate before anything touches the disk: the version names a directory
  // that is wiped and recreated below.
  assertVersion(version);
  ensureDirs();
  const url = `https://github.com/MetaMask/metamask-extension/releases/download/v${version}/metamask-chrome-${version}.zip`;
  const dest = resolve(MM_ROOT, version);
  const zip = resolve(MM_ROOT, `metamask-chrome-${version}.zip`);

  // Download first, so a bad version or a network failure leaves the existing
  // staged copy in place.
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new RigError('DOWNLOAD_FAILED', `${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await (await import('node:fs/promises')).writeFile(zip, buf);
  await run('unzip', ['-q', '-o', zip, '-d', dest]);
  await rm(zip, { force: true });
  await rm(join(dest, '_metadata'), { recursive: true, force: true });

  const { version: manifestVersion } = await verify(dest);
  commitSource(dest, manifestVersion, 'github', force);
  return { dir: dest, version: manifestVersion, source: url, bytes: buf.length };
}
