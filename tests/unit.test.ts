/**
 * Unit tests for the pure decision points: chain classification and parsing,
 * launch-argument parsing, the daemon's request guards, and atomic state I/O.
 * Nothing here opens a browser or touches the project's .rig directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classify, parseChainId, primeRegistry, isLocalRpc, KNOWN_MAINNETS } from '../src/chains.js';
import { parseLaunchArgs, launchArgsToArgv } from '../src/config.js';
import { toHexChainId } from '../src/metamask/network.js';
import { assertVersion, VERSION_RE } from '../src/metamask/fetch.js';
import { hostAllowed } from '../src/daemon/server.js';
import { allowedUrl, shotPath } from '../src/daemon/commands.js';
import { readEnvFile, writeJsonAtomic } from '../src/daemon/state.js';
import { networkPromptFromAria, rowFromAria } from '../src/metamask/popup.js';
import { METAMASK_BUILTIN, isSettingsRoute, resolveNetworkName } from '../src/daemon/gate.js';
import { assertNameFree, chainParams } from '../src/metamask/network.js';
import { newReqId, toErrorBody } from '../src/util.js';
import { bool, num, numOpt, pick, str, unknownKeys } from '../src/args.js';
import { formatNative, toWeiHex } from '../src/chain.js';
import { similarity } from '../src/ocr.js';
import { shortAddress } from '../src/metamask/onboard.js';
import { RigError } from '../src/types.js';

// ---- chain id parsing ---------------------------------------------------------

test('parseChainId accepts decimal and hex, rejects garbage', () => {
  assert.equal(parseChainId('6281971'), 6281971);
  assert.equal(parseChainId('0x5fdaf3'), 6281971);
  assert.equal(parseChainId('0X1'), 1);
  assert.equal(parseChainId(137), 137);
  for (const bad of ['abc', '', '-1', '0', '1.5', '0xNaN', '0x', ' 12 3', NaN, Infinity]) {
    assert.throws(() => parseChainId(bad as string), (e: unknown) => (e as RigError).code === 'BAD_ARGS', String(bad));
  }
});

test('toHexChainId never yields 0xNaN', () => {
  assert.equal(toHexChainId('6281971'), '0x5fdaf3');
  assert.equal(toHexChainId('0x1'), '0x1');
  assert.throws(() => toHexChainId('abc'));
});

// ---- classifier -----------------------------------------------------------------

const registry = [
  { chainId: 11155111, name: 'Sepolia', shortName: 'sep', faucets: ['https://faucet'] },
  { chainId: 100, name: 'Gnosis', shortName: 'gno', faucets: ['https://faucet.gnosischain.com'] },
  { chainId: 57, name: 'Syscoin Mainnet', shortName: 'sys', faucets: ['https://faucet.syscoin.org'] },
  { chainId: 80002, name: 'Amoy', shortName: 'polygonamoy', faucets: [] },
  { chainId: 31337, name: 'GoChain Testnet', shortName: 'got', faucets: [] },
  { chainId: 4242, name: 'Some Chain', shortName: 'sc', faucets: [] },
];

test('classify: names that read as testnets pass', async () => {
  primeRegistry(registry);
  assert.equal((await classify(11155111, undefined, [])).klass, 'testnet');
  assert.equal((await classify(80002, undefined, [])).klass, 'testnet');
});

test('classify: faucets alone are not proof of a testnet', async () => {
  primeRegistry(registry);
  const gnosis = await classify(100, undefined, []);
  assert.equal(gnosis.klass, 'real-money');
  const sys = await classify(57, undefined, []);
  assert.equal(sys.klass, 'real-money');
  assert.match(sys.why, /faucets alone are not proof/);
});

test('classify: well-known mainnets are real money even if the registry lies', async () => {
  primeRegistry([{ chainId: 1, name: 'Ethereum Testnet Lol', faucets: ['x'] }]);
  const v = await classify(1, undefined, []);
  assert.equal(v.klass, 'real-money');
  assert.equal(v.name, KNOWN_MAINNETS.get(1));
});

test('classify: unknown chains fail closed; vouching and local RPC clear them', async () => {
  primeRegistry(registry);
  assert.equal((await classify(6281971, undefined, [])).klass, 'real-money');
  assert.equal((await classify(6281971, undefined, [6281971])).klass, 'allowed');
  assert.equal((await classify(4242, undefined, [])).klass, 'real-money');
  assert.equal((await classify(1, 'http://127.0.0.1:8545', [])).klass, 'local');
  assert.equal((await classify(31337, undefined, [])).klass, 'local');
  // A dev-node id on a remote RPC is judged by the registry like any other chain.
  assert.equal((await classify(31337, 'https://rpc.example.com', [])).klass, 'testnet');
  assert.equal((await classify(1337, 'https://rpc.example.com', [])).klass, 'real-money');
});

test('isLocalRpc', () => {
  assert.equal(isLocalRpc('http://localhost:8545'), true);
  assert.equal(isLocalRpc('http://127.0.0.1:8545'), true);
  assert.equal(isLocalRpc('https://rpc.testnet.dogeos.com'), false);
  assert.equal(isLocalRpc('not a url'), false);
  assert.equal(isLocalRpc(undefined), false);
});

// ---- launch args ------------------------------------------------------------------

test('parseLaunchArgs: a flag never swallows the next flag as its value', () => {
  assert.throws(() => parseLaunchArgs(['--chain-id', '--rpc-url', 'http://x']), /needs a value/);
  assert.throws(() => parseLaunchArgs(['--app-url', '--headless']), /needs a value/);
  assert.throws(() => parseLaunchArgs(['--chain-id', '1']), /given together/);
  assert.throws(() => parseLaunchArgs(['--chain-id', '1', '--rpc-url', 'ftp://x']), /http\(s\)/);
});

test('parseLaunchArgs round-trips through launchArgsToArgv', () => {
  const cfg = parseLaunchArgs([
    '--chain-id', '0x5fdaf3', '--rpc-url', 'https://rpc.testnet.dogeos.com', '--symbol', 'DOGE', '--headless', '--allow-mainnet',
  ]);
  assert.deepEqual(cfg, {
    network: { chainId: 6281971, rpcUrl: 'https://rpc.testnet.dogeos.com', symbol: 'DOGE' },
    headless: true,
    allowMainnet: true,
  });
  assert.deepEqual(parseLaunchArgs(launchArgsToArgv(cfg)), cfg);
});

// ---- daemon guards -----------------------------------------------------------------

test('hostAllowed: loopback names on the bound port only', () => {
  assert.equal(hostAllowed('127.0.0.1:7331', 7331), true);
  assert.equal(hostAllowed('localhost:7331', 7331), true);
  assert.equal(hostAllowed('127.0.0.1:7332', 7331), false);
  assert.equal(hostAllowed('evil.example:7331', 7331), false);
  assert.equal(hostAllowed(undefined, 7331), false);
});

test('allowedUrl: web and own wallet pages only', () => {
  const ext = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(allowedUrl('https://laika.example/tokens', ext), true);
  assert.equal(allowedUrl('http://localhost:3000', ext), true);
  assert.equal(allowedUrl(`chrome-extension://${ext}/home.html`, ext), true);
  assert.equal(allowedUrl('chrome-extension://otherextensionid/home.html', ext), false);
  assert.equal(allowedUrl('file:///etc/passwd', ext), false);
  assert.equal(allowedUrl('javascript:alert(1)', ext), false);
  assert.equal(allowedUrl('about:blank', ext), true);
  assert.equal(allowedUrl('nonsense', ext), false);
});

test('shotPath stays inside the shots directory', () => {
  assert.match(shotPath(undefined, 'stamp'), /stamp\.png$/);
  assert.match(shotPath('mine.png', 'stamp'), /shots\/mine\.png$/);
  assert.throws(() => shotPath('../../etc/cron.png', 'stamp'), /inside/);
  assert.throws(() => shotPath('/tmp/x.png', 'stamp'), /inside/);
  assert.throws(() => shotPath('x.txt', 'stamp'), /\.png/);
});

test('assertVersion: digits and dots, never a path', () => {
  assert.equal(VERSION_RE.test('13.48.0'), true);
  assert.doesNotThrow(() => assertVersion('13.48.0'));
  assert.doesNotThrow(() => assertVersion('13.48.0.0'));
  for (const bad of ['../profile', '../../..', '13.48.0/../x', '', 'latest', '13.48.0;rm', '1']) {
    assert.throws(() => assertVersion(bad), (e: unknown) => (e as RigError).code === 'BAD_ARGS', bad);
  }
});

// ---- state I/O ------------------------------------------------------------------------

test('writeJsonAtomic keeps a valid backup and never leaves a torn file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rig-test-'));
  try {
    const file = join(dir, 'state.json');
    writeJsonAtomic(file, { a: 1 }, { backup: true });
    assert.equal(existsSync(`${file}.bak`), false);
    writeJsonAtomic(file, { a: 2 }, { backup: true });
    assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), { a: 1 });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 2 });
    // A corrupt primary must not be copied over the good backup.
    writeFileSync(file, '{"a": 2', 'utf8');
    writeJsonAtomic(file, { a: 3 }, { backup: true });
    assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')), { a: 1 });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 3 });
    assert.equal(existsSync(`${file}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEnvFile: quotes stripped, comments ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rig-env-'));
  try {
    const file = join(dir, '.env');
    writeFileSync(file, '# comment\nA=1\nB="two"\nC=\'three\'\nbroken\n', 'utf8');
    assert.deepEqual(readEnvFile(file), { A: '1', B: 'two', C: 'three' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- request page reading -------------------------------------------------------------

const TX_SNAPSHOT = `- button "Advanced tx details"
- paragraph: Sending
- heading "0 DOGE" [level=2]
- text: D
- paragraph: From Imported accounts
- paragraph: Imported Account 1
- img "maskicon"
- paragraph: Network
- text: D
- paragraph: DogeOS Chikyu Testnet
- paragraph: Request from
- paragraph: HTTP
- paragraph: 127.0.0.1:7331
- paragraph: Network fee
- button "Edit":
  - img
- paragraph: < 0.0001
- button "Cancel"
- button "Confirm"`;

test('rowFromAria reads the Network and Request from rows of a MetaMask 13.x page', () => {
  assert.equal(rowFromAria(TX_SNAPSHOT, 'Network'), 'DogeOS Chikyu Testnet');
  assert.equal(rowFromAria(TX_SNAPSHOT, 'Request from', 2), 'HTTP 127.0.0.1:7331');
  assert.equal(rowFromAria(TX_SNAPSHOT, 'Network fee'), '< 0.0001');
  assert.equal(rowFromAria(TX_SNAPSHOT, 'Nope'), null);
  assert.equal(rowFromAria('- paragraph: Network\n- button "Confirm"', 'Network'), null);
});

const ADD_CHAIN_SNAPSHOT = `- heading "Add Hoodi" [level=2]
- paragraph: A site is suggesting additional network details.
- paragraph: Request from
- text: h
- paragraph: example.com
- paragraph: Network
- text: H
- paragraph: Hoodi
- paragraph: RPC
- paragraph: ethereum-hoodi-rpc.publicnode.com
- button "Cancel"
- button "Confirm"`;

const SIGN_SNAPSHOT = `- img "maskicon"
- paragraph: Imported Account 1
- heading "Signature request" [level=2]
- paragraph: Review request details before you confirm.
- paragraph: Network
- text: D
- paragraph: DogeOS Chikyu Testnet
- paragraph: Request from
- paragraph: HTTP
- paragraph: 127.0.0.1:7331
- paragraph: Signing with
- paragraph: Message
- paragraph: A site is suggesting additional network details.
- button "Cancel"
- button "Confirm"`;

test('networkPromptFromAria: add-chain prompts are recognised by structure, not words', () => {
  assert.equal(networkPromptFromAria(ADD_CHAIN_SNAPSHOT), true);
  assert.equal(networkPromptFromAria(SIGN_SNAPSHOT), false);
  // A message that mimics the sentence, under a heading a site controls, is still a signature.
  assert.equal(networkPromptFromAria(SIGN_SNAPSHOT.replace('heading "Signature request"', 'heading "Add network"')), false);
  assert.equal(networkPromptFromAria(TX_SNAPSHOT), false);
});

// ---- the gate's name resolution -------------------------------------------------------

const RIG_NETWORKS = [{ chainId: '0x5fdaf3', name: 'DogeOS Chikyu Testnet', rpc: 'https://rpc.testnet.dogeos.com' }];

test('resolveNetworkName: rig-added names first, then built-ins, mainnets, registry; unknown stays unknown', async () => {
  primeRegistry(registry);
  assert.equal(await resolveNetworkName('DogeOS Chikyu Testnet', RIG_NETWORKS), 6281971);
  assert.equal(await resolveNetworkName('  dogeos chikyu testnet ', RIG_NETWORKS), 6281971);
  assert.equal(await resolveNetworkName('Sepolia', []), 11155111);
  assert.equal(METAMASK_BUILTIN.get('ethereum mainnet'), 1);
  assert.equal(await resolveNetworkName('Gnosis', []), 100);
  assert.equal(await resolveNetworkName('Amoy', []), 80002);
  assert.equal(await resolveNetworkName('Rig Hoodi Check', []), null);
  assert.equal(await resolveNetworkName('', []), null);
});

test('assertNameFree refuses a name that already means another chain', async () => {
  primeRegistry(registry);
  await assert.rejects(() => assertNameFree('Sepolia', 100, []), (e: unknown) => (e as RigError).code === 'BAD_ARGS');
  await assert.rejects(() => assertNameFree('Ethereum', 100, []), (e: unknown) => (e as RigError).code === 'BAD_ARGS');
  await assert.doesNotReject(() => assertNameFree('Sepolia', 11155111, []));
  await assert.doesNotReject(() => assertNameFree('My Own Chain', 999999, []));
  await assert.doesNotReject(() => assertNameFree('DogeOS Chikyu Testnet', 6281971, RIG_NETWORKS));
});

test('isSettingsRoute: settings and home skip the click gate, confirmation routes do not', () => {
  const ext = 'chrome-extension://abc/home.html';
  for (const h of ['', '#/', '#/networks', '#/networks?view=add', '#/settings/advanced', '#/permissions', '#/account-list']) {
    assert.equal(isSettingsRoute(ext + h), true, h);
  }
  for (const h of ['#/confirm-transaction/1', '#/confirmation', '#/connect', '#/signature-request', '#/networksomething', '#/snaps-connect']) {
    assert.equal(isSettingsRoute(ext + h), false, h);
  }
  assert.equal(isSettingsRoute('not a url'), false);
});

// ---- network payloads and bridge ids ------------------------------------------------------

test('chainParams builds an EIP-3085 payload', () => {
  const p = chainParams({ chainId: '6281971', name: 'DogeOS', rpcUrl: 'https://rpc', symbol: 'DOGE' });
  assert.deepEqual(p, {
    chainId: '0x5fdaf3',
    chainName: 'DogeOS',
    nativeCurrency: { name: 'DOGE', symbol: 'DOGE', decimals: 18 },
    rpcUrls: ['https://rpc'],
  });
  assert.deepEqual(chainParams({ chainId: '1', name: 'x', rpcUrl: 'https://r', symbol: 'E', explorer: 'https://e' }).blockExplorerUrls, ['https://e']);
});

test('newReqId is unique within a millisecond and shaped as the bridge expects', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 2000; i++) ids.add(newReqId());
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^r[0-9a-z]+$/);
});

// ---- helpers ------------------------------------------------------------------------------

test('toErrorBody keeps codes and details, names Playwright timeouts, tolerates non-errors', () => {
  assert.deepEqual(toErrorBody(new RigError('NO_TARGET', 'x', { a: 1 })), { error: 'x', code: 'NO_TARGET', details: { a: 1 } });
  const t = new Error('waited'); t.name = 'TimeoutError';
  assert.deepEqual(toErrorBody(t), { error: 'waited', code: 'TIMEOUT' });
  assert.deepEqual(toErrorBody('boom'), { error: 'boom', code: 'ERROR' });
  assert.deepEqual(toErrorBody(null), { error: 'null', code: 'ERROR' });
  assert.equal(RigError.wrap(t).code, 'TIMEOUT');
  const wrapped = RigError.wrap(new RigError('NO_ACTION', 'n', { a: 1 }), { b: 2 });
  assert.deepEqual(wrapped.details, { a: 1, b: 2 });
});

test('args coercers accept both key spellings and numeric strings', () => {
  const a = { chain_id: '5', 'min-conf': '60', all: 'true', nth: 2, flag: true, name: 'x' };
  assert.equal(str(a, 'chain-id'), '5');
  assert.equal(str(a, 'chain_id'), '5');
  assert.equal(num(a, 'min_conf', 0), 60);
  assert.equal(numOpt(a, 'nope'), undefined);
  assert.equal(num(a, 'nth', 0), 2);
  assert.equal(bool(a, 'all'), true);
  assert.equal(bool(a, 'flag'), true);
  assert.equal(bool(a, 'name'), false);
  assert.deepEqual(pick(a, ['name', 'missing']), { name: 'x' });
  assert.deepEqual(unknownKeys({ name: 1, nth: 1 }, a).sort(), ['all', 'chain_id', 'flag', 'min-conf']);
  assert.deepEqual(unknownKeys({}, { constructor: 1 }), ['constructor']);
});

test('toWeiHex and formatNative round-trip whole and fractional amounts', () => {
  assert.equal(toWeiHex(1), '0xde0b6b3a7640000');
  assert.equal(toWeiHex(0.05), '0xb1a2bc2ec50000');
  assert.equal(formatNative('0xde0b6b3a7640000'), '1.000000');
  assert.equal(formatNative('0xb1a2bc2ec50000'), '0.050000');
  assert.equal(formatNative('0x0'), '0.000000');
});

test('similarity is 1 for equal text and drops with edits', () => {
  assert.equal(similarity('Buy FEE66607', 'Buy FEE66607'), 1);
  assert.ok(similarity('Buy FEE66607', 'Buy FEE6607') > 0.8);
  assert.ok(similarity('Connect Wallet', 'Disconnect') < 0.8);
});

test('shortAddress matches MetaMask truncation at both ends', () => {
  assert.deepEqual(shortAddress('0xFB1525e16FDA109a5180a3Ec23A7146b870E045b'), { head: '0xfb152', tail: 'e045b' });
});
