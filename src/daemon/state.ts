import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonInfo, RigState } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');
export const RIG_DIR = resolve(ROOT, '.rig');
export const PROFILE_DIR = resolve(RIG_DIR, 'profile');
export const MM_ROOT = resolve(RIG_DIR, 'metamask');
export const SHOTS_DIR = resolve(RIG_DIR, 'shots');
export const STATE_FILE = resolve(RIG_DIR, 'state.json');
export const DAEMON_FILE = resolve(RIG_DIR, 'daemon.json');
export const DAEMON_LOG = resolve(RIG_DIR, 'daemon.log');
/** The unlock password, mirrored outside state.json so a bad state write cannot lose it. */
export const PASSWORD_FILE = resolve(RIG_DIR, 'wallet.password');

/** Files under .rig that hold secrets or a live token. Always 0600. */
const PRIVATE_FILES = [
  STATE_FILE,
  `${STATE_FILE}.bak`,
  DAEMON_FILE,
  DAEMON_LOG,
  PASSWORD_FILE,
  resolve(RIG_DIR, 'config.json'),
  resolve(RIG_DIR, 'config.json.bak'),
];

export function ensureDirs(): void {
  for (const d of [RIG_DIR, MM_ROOT, SHOTS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  // `mode` on writeFileSync only applies when a file is created, so re-assert
  // the permissions every time rather than trusting the first write.
  try {
    chmodSync(RIG_DIR, 0o700);
    for (const f of PRIVATE_FILES) if (existsSync(f)) chmodSync(f, 0o600);
  } catch {
    /* best effort; not all filesystems support it */
  }
}

function parseFile<T>(file: string): T | null {
  try {
    const raw = readFileSync(file, 'utf8');
    if (raw.trim() === '') return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Read a JSON file, falling back to its `.bak` twin when the primary is
 * unreadable. A half-written primary must never look like a fresh install.
 */
function readJson<T>(file: string, opts: { backup?: boolean } = {}): T | null {
  const primary = existsSync(file) ? parseFile<T>(file) : null;
  if (primary !== null) return primary;
  // Missing, empty, unreadable or torn: the backup is the last good write. To
  // reset on purpose, remove the .bak (and wallet.password) too.
  if (opts.backup) return parseFile<T>(`${file}.bak`);
  return null;
}

/**
 * Write JSON via a temp file and rename, so a crash mid-write leaves either the
 * old file or the new one, never a truncated one. With `backup`, the previous
 * (valid) contents are kept beside it.
 */
export function writeJsonAtomic(file: string, value: unknown, opts: { backup?: boolean } = {}): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  if (opts.backup && existsSync(file) && parseFile(file) !== null) {
    try {
      copyFileSync(file, `${file}.bak`);
      chmodSync(`${file}.bak`, 0o600);
    } catch {
      /* a missing backup is not worth failing the write */
    }
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

export function readState(): RigState {
  return readJson<RigState>(STATE_FILE, { backup: true }) ?? {};
}

export function writeState(patch: Partial<RigState>): RigState {
  ensureDirs();
  const next = { ...readState(), ...patch };
  writeJsonAtomic(STATE_FILE, next, { backup: true });
  return next;
}

export function readDaemon(): DaemonInfo | null {
  return readJson<DaemonInfo>(DAEMON_FILE);
}

export function writeDaemon(info: DaemonInfo): void {
  ensureDirs();
  writeJsonAtomic(DAEMON_FILE, info);
}

/**
 * Remove the daemon record. With `ownerPid`, only when the record belongs to
 * that process: a daemon must not wipe a record that a newer daemon wrote.
 */
export function clearDaemon(ownerPid?: number): boolean {
  const current = readDaemon();
  if (ownerPid !== undefined && current && current.pid !== ownerPid) return false;
  try {
    if (existsSync(DAEMON_FILE)) unlinkSync(DAEMON_FILE);
  } catch {
    /* ignore */
  }
  return true;
}

/** Minimal .env reader: KEY=value lines, no export, no interpolation. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Configuration comes from the process environment, which is how an MCP client
 * passes it: the `env` block of its own server entry. A `.env` beside the
 * project is read too, but only as a convenience for driving the CLI by hand;
 * it is not the documented path and nothing writes one.
 */
export function loadEnv(): Record<string, string> {
  const fromFile = readEnvFile(resolve(ROOT, '.env'));
  const merged: Record<string, string> = { ...fromFile };
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('RIG_') && v) merged[k] = v;
  }
  return merged;
}

export function env(key: string, fallback: string): string {
  const v = loadEnv()[key];
  return v && v.length > 0 ? v : fallback;
}

function readPasswordFile(): string | null {
  if (!existsSync(PASSWORD_FILE)) return null;
  const v = readFileSync(PASSWORD_FILE, 'utf8').trim();
  return v.length > 0 ? v : null;
}

function writePasswordFile(password: string): void {
  writeFileSync(PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  try {
    chmodSync(PASSWORD_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * MetaMask insists on a password at wallet creation and asks for it again after
 * every restart, so the rig has to know one. It does not have to be chosen by a
 * human: this guards a throwaway wallet whose profile already sits unencrypted
 * on the same disk. Generated once and kept in .rig, which is gitignored.
 *
 * The password is stored twice, in state.json and in its own file, and is only
 * ever generated when neither has it. Losing it would lock the vault for good,
 * so the state file's read-modify-write churn must not be its only home.
 *
 * An explicit RIG_MM_PASSWORD still wins, and is adopted on first use so an
 * existing profile keeps working after the variable is removed.
 */
export function walletPassword(): string {
  const state = readState();
  const fromEnv = loadEnv()['RIG_MM_PASSWORD'];
  if (fromEnv && fromEnv.length >= 8) {
    if (state.walletPassword !== fromEnv) writeState({ walletPassword: fromEnv });
    if (readPasswordFile() !== fromEnv) writePasswordFile(fromEnv);
    return fromEnv;
  }
  if (state.walletPassword) {
    if (readPasswordFile() !== state.walletPassword) writePasswordFile(state.walletPassword);
    return state.walletPassword;
  }
  const mirrored = readPasswordFile();
  if (mirrored) {
    writeState({ walletPassword: mirrored });
    return mirrored;
  }
  const generated = `rig-${randomBytes(12).toString('base64url')}`;
  writeState({ walletPassword: generated });
  writePasswordFile(generated);
  return generated;
}
