/**
 * Argument coercers for the loose bags that arrive over HTTP, MCP and the CLI.
 * One set for every layer, so `chain_id` and `chain-id` mean the same thing
 * everywhere.
 */
import type { Args } from './types.js';

/** A string argument, accepting the hyphenated or underscored spelling of the key. */
export function str(args: Args, key: string): string | undefined {
  const v = args[key];
  if (typeof v === 'string') return v;
  const alt = args[key.includes('_') ? key.replace(/_/g, '-') : key.replace(/-/g, '_')];
  return typeof alt === 'string' ? alt : undefined;
}

/** A number argument, or a numeric string (clients differ on how they encode numbers). */
export function numOpt(args: Args, key: string): number | undefined {
  const v = args[key] ?? args[key.includes('_') ? key.replace(/_/g, '-') : key.replace(/-/g, '_')];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

export function num(args: Args, key: string, fallback: number): number {
  return numOpt(args, key) ?? fallback;
}

/** A flag: true, or the string "true" (the CLI cannot send a boolean). */
export function bool(args: Args, key: string): boolean {
  const v = args[key] ?? args[key.includes('_') ? key.replace(/_/g, '-') : key.replace(/-/g, '_')];
  return v === true || v === 'true';
}

/** Copy only the listed keys that are set. */
export function pick(args: Args, keys: string[]): Args {
  const out: Args = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

/** Keys the caller sent that a schema does not declare. */
export function unknownKeys(declared: Record<string, unknown>, args: Args): string[] {
  return Object.keys(args).filter((k) => !Object.hasOwn(declared, k));
}
