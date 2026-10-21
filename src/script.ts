/** Run scripts: rig command lines, parsed into the daemon's `run` steps. */

/** Split a script line into words the way a shell would: quotes group, backslash escapes. */
export function splitWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unclosed ${quote} in: ${line}`);
  if (inWord) words.push(cur);
  return words;
}

/**
 * A run script (one rig command per line) or JSON steps, to the daemon's steps
 * array. `toCommand` is the CLI's own argv parser, so a line means exactly what
 * it would on the command line.
 */
export function parseScript(
  source: string,
  toCommand: (argv: string[]) => { cmd: string; args: Record<string, unknown> },
): unknown[] {
  if (source.trimStart().startsWith('[')) return JSON.parse(source) as unknown[];
  const steps: unknown[] = [];
  for (const raw of source.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const optional = line.startsWith('?');
    if (optional) line = line.slice(1).trim();
    const words = splitWords(line);
    if (words[0] === './bin/rig' || words[0] === 'rig') words.shift();
    const { cmd, args } = toCommand(words);
    if (!cmd) continue;
    steps.push({ cmd, ...args, ...(optional ? { optional: true } : {}) });
  }
  return steps;
}
