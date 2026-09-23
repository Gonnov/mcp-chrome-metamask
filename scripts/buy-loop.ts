/**
 * Acceptance through the daemon's HTTP API: N purchases in a row, each in a
 * freshly restarted browser, verified against the chain.
 *
 *   pnpm buy:loop -- --runs 10 [--token 0x...] [--amount 0.05] [--keep-session]
 */
import { DaemonDriver, buyOnce, loopOptions, type RunResult } from './laika.js';

const { runs, opts } = loopOptions(process.argv.slice(2));
const driver = new DaemonDriver();

const results: RunResult[] = [];
for (let i = 1; i <= runs; i++) {
  const r = await buyOnce(driver, i, opts);
  results.push(r);
  console.log(JSON.stringify(r));
}
const passed = results.filter((r) => r.ok).length;
console.log(JSON.stringify({ summary: `${passed}/${runs} passed`, passed, runs, via: 'daemon' }));
if (passed !== runs) process.exit(1);
