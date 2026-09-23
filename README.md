# Chrome MetaMask MCP Server 🦊

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-20+-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-purple.svg)](https://modelcontextprotocol.io/)
[![Playwright](https://img.shields.io/badge/Playwright-1.61-red.svg)](https://playwright.dev/)

> 🌟 **Let your agent drive a real wallet** — a real browser with a real MetaMask extension, where the agent clicks through connect, signature and transaction prompts by itself.

> ⚠️ **Testnets only.** This is a testing tool. It automates wallet approvals, so it must only ever hold a throwaway account with test funds. It refuses to approve on any chain it cannot prove is a test or local network, and there is no tool argument that overrides that. Never import a key that holds real money.

> The project is young. It is proven on one dapp end to end (twenty consecutive purchases on the DogeOS testnet through the MCP tools), but it has not been published to a registry and has been exercised on macOS only.

---

## 🎯 What is Chrome MetaMask MCP Server?

`mcp-chrome-metamask` is a **Model Context Protocol (MCP) server** that gives an AI agent a
real browser with a real wallet extension loaded, and lets it drive both.

The hard part of dapp automation is not the page, it is the wallet. Wallet mocks
are invisible to any app that does not implement EIP-6963, and ordinary browser
automation cannot reach another extension's windows. mcp-chrome-metamask can: it opens
MetaMask's pending-request queue itself and clicks Confirm, so a full flow like
**connect → sign in → trade → confirm** runs without a human.

It is built for **testing dapps on testnets**, not for moving real money, and
the safety model reflects that; see the Safety section below.

## ✨ Core Features

- 🦊 **Real MetaMask, really driven** — connect, signature, add-network and transaction prompts are all approved by the agent
- 👁️ **See the page three ways** — accessibility tree, screenshot, or OCR word boxes with clickable coordinates
- 🎯 **Click however you can name it** — CSS selector, visible text, OCR box id, or raw coordinates
- 🔒 **Fails closed on real money** — refuses to auto-approve on any chain it cannot prove is a testnet
- 🔑 **No secret required** — the wallet generates its own account and tells you the address to fund
- ♻️ **The browser outlives your session** — a daemon owns it, so restarting your agent keeps the wallet unlocked
- 🌐 **Any EVM chain** — pick one at launch or at runtime, by chain id and RPC
- 🐚 **Two front ends** — the same engine from MCP or from your shell
- 🫥 **Nothing of its own on screen** — provider calls run in the page under test; the browser shows only your app and MetaMask

## 🆚 Comparison with Similar Approaches

| Comparison Dimension | Playwright / browser MCP | Injected wallet mock | Route-to-human signer | **mcp-chrome-metamask** |
| --- | --- | --- | --- | --- |
| **Approves wallet prompts** | ❌ cannot reach extension pages | ⚠️ no prompts exist to approve | ❌ by design, a human clicks | ✅ the agent clicks |
| **Works without EIP-6963** | ✅ | ❌ invisible to the app | ✅ | ✅ |
| **Real signatures** | ❌ | ❌ simulated | ✅ | ✅ |
| **Unattended runs** | ✅ | ✅ | ❌ blocks on a human | ✅ |
| **Guards against mainnet** | n/a | n/a | ✅ the human is the guard | ✅ fails closed |
| **Setup cost** | ✅ low | ✅ low | ✅ low | ⚠️ downloads a browser and a wallet |

## 🚀 Getting It

### What you need

- macOS (the only platform exercised so far), Node.js >= 20, and [pnpm](https://pnpm.io)
- A display. The browser has a window; headless is exposed but not exercised
- A testnet with a public RPC and a faucet. The examples use the DogeOS testnet (chain 6281971) and Sepolia (11155111)
- Optional: `tesseract` on PATH (`brew install tesseract`), only for the OCR fallback when a page cannot be read from the DOM

### Install

There is no npm package yet: you get the source and run it in place through
`tsx`; nothing is built. Clone the repository (or copy this directory) and:

```bash
cd mcp-chrome-metamask
pnpm install          # dependencies
pnpm setup            # the pinned Chromium (a one-time download, not run by install)
pnpm check            # typecheck + unit tests, no browser needed
```

MetaMask itself is staged on the first start: copied from a Brave or Chrome
profile on this machine when one has it installed, otherwise downloaded from
the pinned GitHub release (13.48.0). Everything the rig owns lives in `.rig/`
next to the code: the browser profile, the wallet's encrypted vault, the
daemon record. It is gitignored and mode 0700.

## 🤖 For an Agent

The server speaks MCP over stdio. Register it with your client, then drive it
with the eight `rig_*` tools. Every tool takes an `action`, and unknown
arguments are refused rather than dropped.

### 1. Register the server

Claude Code, from the directory that holds your project:

```bash
claude mcp add mcp-chrome-metamask -- /absolute/path/to/mcp-chrome-metamask/bin/mcp-chrome-metamask \
  --chain-id 6281971 --rpc-url https://rpc.testnet.dogeos.com \
  --network-name "DogeOS Chikyu Testnet" --symbol DOGE
```

Or in a `.mcp.json` / client config by hand:

```json
{
  "mcpServers": {
    "mcp-chrome-metamask": {
      "command": "/absolute/path/to/mcp-chrome-metamask/bin/mcp-chrome-metamask",
      "args": ["--chain-id", "6281971", "--rpc-url", "https://rpc.testnet.dogeos.com",
               "--network-name", "DogeOS Chikyu Testnet", "--symbol", "DOGE"],
      "env": { "RIG_KEY_FILE": "/Users/you/.secrets/dogeos-burner.key" }
    }
  }
}
```

`args` and `env` are both optional. With no network in `args` the agent picks
one at runtime with `rig_network use`; with no key the wallet generates its own
account. A network given in `args` is the operator's word: it is fixed for the
session and the gate approves on it. A network the agent picks at runtime is
not, so a chain the public registry does not know (DogeOS testnet is one) must
then be vouched for from your shell: `./bin/rig network allow 6281971`.

### 2. First session

The calls an agent makes, in order, the first time:

```text
rig_session  { "action": "start" }                     launch the browser; stages MetaMask on first use
rig_wallet   { "action": "setup" }                     create the wallet (once); returns fundThisAddress
                                                       → fund that address from the testnet faucet
rig_wallet   { "action": "status" }                    locked? address? what the site sees
rig_navigate { "action": "goto", "url": "http://localhost:3000" }
rig_act      { "action": "click", "text": "Connect Wallet", "target": "app" }
rig_navigate { "action": "wait", "for": "popup", "timeout": 30000 }
rig_wallet   { "action": "approve", "all": true }      connect prompt, then the sign-in signature
rig_act      { "action": "type", "text": "0.05", "selector": "input[placeholder=\"0.0\"]", "target": "app" }
rig_act      { "action": "click", "text": "Buy", "target": "app" }
rig_navigate { "action": "wait", "for": "popup", "timeout": 60000 }
rig_wallet   { "action": "approve", "all": true }      the transaction
```

Things an agent should know:

- **The wallet persists.** `setup` runs once; later sessions start unlocked. `rig_session stop` closes the browser, the next call relaunches it.
- **Open the site before wallet calls.** `rig_wallet connect` and `rig_wallet request` run `window.ethereum` in the page under test, because MetaMask scopes accounts and the selected network per site. With no site open they return `NO_APP_PAGE`.
- **Look before you click.** `rig_look aria` is the cheap way to read a page; `rig_look find` reports whether a control is visible and enabled, and apps often render a disabled twin of the button you want.
- **Wait for the prompt, then approve.** `rig_navigate wait for=popup` returns as soon as MetaMask has a request; `rig_wallet approve all=true` clears the queue, gating each item on its own.
- **Every error carries a code.** `CHAIN_NOT_ALLOWED`, `CHAIN_UNKNOWN`, `NETWORK_ADD_REFUSED`, `NO_APP_PAGE`, `TIMEOUT`, `UNKNOWN_ARGS` and the rest come back as JSON with `error`, `code` and often `details`, so a client can branch on them.
- **A refusal is final from the agent's side.** No tool argument lifts the real-money gate. If a chain is legitimately a testnet the registry does not know, the person running the rig vouches for it from their shell.

## 🧑‍💻 For a Person

The same engine from the shell. `./bin/rig` is the CLI (`./bin/dapp` still works as an alias).

1. **Start the browser.** It stays running and survives restarts of your shell and your agent:

```bash
./bin/rig serve --daemon
```

2. **Create the wallet.** MetaMask is staged automatically:

```bash
./bin/rig mm setup
```

```json
{ "onboarded": true, "fundThisAddress": "0x217c31f9c1dcbd2339b3564b759ae0ca2ea188b1" }
```

> The wallet is **saved**. It lives in `.rig/profile`, MetaMask's own encrypted vault. Running `mm setup` again does nothing, and restarting the browser keeps the wallet and unlocks it for you. This step happens once.

3. **Fund that address** from your testnet's faucet. Nothing works until it has a balance.

4. **Choose a network.** The name and native symbol are looked up for you when the public registry knows the chain:

```bash
./bin/rig network use --chain-id 11155111 --rpc-url https://rpc.sepolia.org
# or a chain the registry does not know, then vouch for it:
./bin/rig network use --chain-id 6281971 --rpc-url https://rpc.testnet.dogeos.com --name "DogeOS Chikyu Testnet" --symbol DOGE
./bin/rig network allow 6281971
```

5. **Drive your app:**

```bash
./bin/rig goto http://localhost:3000
./bin/rig click --text "Connect Wallet"
./bin/rig wait --popup
./bin/rig mm approve --all
```

`./bin/rig --help` lists every command. Each takes `--target <app|popup|mm|active|id>`.

## 🛠️ Available Tools

Eight tools, each taking an `action`. 44 actions in total.

<details>
<summary><strong>🖥️ Session (5 actions)</strong></summary>

- `rig_session start` - Launch the browser, staging the wallet on first use
- `rig_session status` - Daemon, wallet, chain and open pages in one call
- `rig_session pages` - List open tabs with their kind and size
- `rig_session boot` - Unlock and clear stray extension tabs
- `rig_session stop` - Close the browser
</details>

<details>
<summary><strong>🧭 Navigation (5 actions)</strong></summary>

- `rig_navigate goto` - Open a URL
- `rig_navigate wait` - Wait for milliseconds, text, a URL, a selector, or **a wallet prompt**
- `rig_navigate resize` - Resize the window
- `rig_navigate close` - Close a page
- `rig_navigate use` - Pin which page later calls act on
</details>

<details>
<summary><strong>👁️ Looking (5 actions)</strong></summary>

- `rig_look aria` - Accessibility tree, usually enough and far cheaper than an image
- `rig_look screenshot` - Image inline, downscaled by default, full resolution on request
- `rig_look ocr` - Numbered word boxes with centre coordinates, for markup you cannot query
- `rig_look find` - Locate by text, reporting whether it is visible and enabled
- `rig_look console` - Console output of a page, for debugging blank screens
</details>

<details>
<summary><strong>🎯 Interaction (4 actions)</strong></summary>

- `rig_act click` - By selector, text, OCR box id, or raw coordinates
- `rig_act type` - Type text, or fill a field by selector
- `rig_act press` - Send a key such as Enter or Escape
- `rig_act scroll` - Scroll the page
</details>

<details>
<summary><strong>🦊 Wallet (14 actions)</strong></summary>

- `rig_wallet setup` - Onboard the wallet and import a burner key if one is configured
- `rig_wallet approve` - Confirm whatever the wallet is asking, the heart of the rig
- `rig_wallet reject` - Decline it instead
- `rig_wallet pending` - Is there a request waiting?
- `rig_wallet status` - Locked, what the site under test sees (accounts, chain), open prompts
- `rig_wallet address` - The selected account, read from the wallet itself; no site needed
- `rig_wallet unlock` - Unlock with the generated password
- `rig_wallet connect` - Connect the site under test to the wallet (open it first)
- `rig_wallet add_network` - Add a chain through the wallet's prompt
- `rig_wallet import_key` - Import a burner key from a file or the environment
- `rig_wallet request` - Send any JSON-RPC method through the provider
- `rig_wallet popups` - List open wallet prompts and what each is asking
- `rig_wallet fetch` - Stage a MetaMask build
- `rig_wallet home` - Open the wallet's own UI
</details>

<details>
<summary><strong>🌐 Network (3 actions)</strong></summary>

- `rig_network list` - What is configured, what the wallet has, what is allowed
- `rig_network current` - Classify the chain the site under test is on (else the last seen) and say whether it spends real money
- `rig_network use` - Add a network; switches the site under test to it when one is open

Vouching for a chain (`network allow`) is deliberately **not** a tool action: it
is an operator decision, made from your own shell with `./bin/rig network allow <chainId>`
(and undone with `disallow`). A prompt-injected agent can ask for anything a
tool exposes, so the override is kept off the tool surface.
</details>

<details>
<summary><strong>⛓️ Chain (6 actions)</strong></summary>

- `rig_chain info` - Chain id and head block
- `rig_chain balance` - Native balance of an address
- `rig_chain snapshot` / `revert` - Save and restore state, local nodes only
- `rig_chain fund` / `mine` - Top up an account and mine blocks, local nodes only
</details>

<details>
<summary><strong>📜 Scripting (2 actions)</strong></summary>

- `rig_eval eval` - Run JavaScript in a page, optionally without awaiting it
- `rig_eval result` - Read the outcome of a call that opened a wallet prompt
</details>

## 🔑 The Burner Key

The wallet needs an account. In order of preference:

1. **Give it none.** Setup generates one and reports the address to fund. Nothing secret is handled at all.
2. **`RIG_PRIVATE_KEY` in your client's `env` block**, ideally as `${VAR}` so the value lives in your shell or secret manager rather than any file in this project.
3. **`--key-file`**, a path to a file holding only the key, read once at import. Only the path is ever visible.
4. **`--pkey 0x…`**, straight on the command line. The quickest, and the most exposed: argv is readable by any process of this user and the key lands in your shell history. The rig returns a warning alongside the imported address when you use it. Throwaway accounts only.

> There is deliberately **no way to pass a key as a tool argument**, and the
> server refuses unknown arguments outright rather than dropping them. Arguments
> become part of the model's context and of every transcript and log downstream,
> so a key crossing that boundary is the leak itself. `key_file` is a tool
> argument, though: the agent can name a file, so keep burner keys only where a
> burner belongs. The key is read once at import, handed to MetaMask, and never
> stored by the rig.

The unlock password is generated on first setup and kept in `.rig`, mode 0700,
in the state file and mirrored in `wallet.password`, both 0600, so a bad state
write can never lose it. State files are written atomically with a `.bak`
beside them. You never choose or type the password.

## 🛡️ Safety

Approvals are automatic. That is the point of the tool and also its hazard, so
the rig classifies the chain before clicking Confirm and **fails closed**:

1. You vouched for it from your shell with `./bin/rig network allow <id>`, or fixed it in the server entry (`--chain-id`/`--rpc-url` or `RIG_CHAIN_ID`/`RIG_RPC_URL`) → **allowed**. A network chosen at runtime with `rig_network use` does *not* count: the agent can do that itself.
2. The RPC is a local node → **local**, allowed. Checked before the registry, because it lists chain 31337 as "GoChain Testnet" and 1337 as "Geth Testnet", real chains sharing the ids Anvil and Hardhat use.
3. The chain is a well-known mainnet (Ethereum, Base, Gnosis, Polygon, …) → **real money**, refused, whatever the registry says.
4. The registry name reads as a test network → **testnet**, allowed. A listed faucet on its own is *not* enough: 169 mainnets in the registry list one.
5. Anything else → **real money**, refused.

> No registry carries a reliable testnet flag. The main public one has no such field across all 2,764 entries, and viem's is missing for roughly a third of its chains, so guessing permissively would auto-approve real transactions wherever the data is thin.

Two rules make the gate hold. It asks the wallet which chain it is on, every
time, instead of trusting configuration, because a page can switch the wallet's
chain at will; if the wallet does not answer, it refuses. And it runs once per
queued request, inside the drain loop, because MetaMask's queue is global: a
connect prompt from the site under test can be followed by a transaction from
any other tab. Every path that clicks a wallet button goes through it, including
`rig_wallet request`, `connect`, `add_network`, `setup`, and a raw `rig_act`
click or keypress on the popup.

Connecting a site and adding or switching a network are not gated, since they
move no value. Transactions and signatures are, because a signature can
authorise a transfer just as a transaction can.

No tool argument overrides the gate. `--force` exists on the CLI only, and
`--allow-mainnet` / `RIG_ALLOW_MAINNET=1` on the server entry.

**Use a burner wallet with only test funds.** The rig can spend whatever the
wallet it drives can spend.

On a refused chain, a raw `rig_act` click or keypress on the wallet page is
refused too, including a click on Reject; use `rig_wallet reject` for that.

## 🧪 Usage Examples

### One purchase, end to end, through the MCP tools

```bash
pnpm buy
```

`scripts/mcp-buy.ts` opens the token page, clears site storage, connects the
wallet, passes the sign-in signature, trades, and verifies the result against
the chain rather than the UI. `scripts/laika.ts` holds the flow; both loop
scripts reuse it.

### Ten runs, fresh browser each time

```bash
pnpm mcp:loop -- --runs 10        # through the MCP tools, as a client would
pnpm buy:loop -- --runs 10        # through the daemon's HTTP API
```

```json
{"run":1,"ok":true,"address":"0xFB15…045b","connect":"connected (1 approvals)","tokensGained":"1911.9597","nonceDelta":1,"elapsedMs":108527}
{"summary":"10/10 passed","passed":10,"runs":10,"via":"mcp"}
```

Both scripts read the burner address from the wallet, restart the browser
before every run and clear the site's session, so each run goes through the
Tomo modal, the MetaMask connect prompt, the sign-in signature and the trade
from cold, then waits for the token balance to move on chain.

### Finding a control the page will not name

```bash
./bin/rig shot --annotate     # numbered boxes and a coordinate grid
./bin/rig ocr                 # the same boxes as text, with centres
./bin/rig click --id 14
```

### Resetting the wallet

```bash
./bin/rig stop
rm -rf .rig/profile
./bin/rig serve --daemon && ./bin/rig mm setup
```

That keeps the generated password and the rig's own records. For a truly
blank slate remove those too: `rm -f .rig/state.json .rig/state.json.bak
.rig/wallet.password .rig/config.json .rig/config.json.bak`. A state file that
is merely deleted is restored from its `.bak` on the next read, by design.

## ⚙️ Configuration

Three things: a burner key, a chain id, and an RPC node. Nothing else is
required, and there is no config file to create.

**From an MCP client**, pass them in your own server entry. This is the one
channel every client supports, and it keeps the key out of any file in the
project:

```json
{
  "mcpServers": {
    "mcp-chrome-metamask": {
      "command": "/absolute/path/to/mcp-chrome-metamask/bin/mcp-chrome-metamask",
      "args": ["--chain-id", "6281971", "--rpc-url", "https://rpc.testnet.dogeos.com",
               "--network-name", "DogeOS Chikyu Testnet", "--symbol", "DOGE"],
      "env": { "RIG_KEY_FILE": "/Users/you/.secrets/dogeos-burner.key" }
    }
  }
}
```

A network given here is fixed for the session and counts as vouched for, so
the gate approves on it even when the public chain registry has never heard of
it (DogeOS testnet is such a chain).

**From the shell**, two commands, no dotfile:

```bash
./bin/rig network use --chain-id 11155111 --rpc-url https://rpc.sepolia.org
./bin/rig mm setup --key-file ~/.secrets/burner.key
```

The network is remembered in `.rig/config.json`, mode 0600 inside the gitignored
state directory, so you set it once. The key is read at import and handed to the
wallet; nothing here stores it, because the extension's encrypted vault holds it
from then on. Delete the key file afterwards if it was only for setup.

> A `.env` beside the project is still read if you make one, as a convenience
> for shell use. It is not the documented path and nothing writes one: the
> convention for MCP servers is that the client supplies the environment.

Optional, for a chain the public registry does not know, or to change defaults:

| Argument | Environment | Meaning |
| --- | --- | --- |
| `--network-name` | `RIG_NETWORK_NAME` | Display name |
| `--symbol` | `RIG_NATIVE_SYMBOL` | Native currency symbol |
| `--explorer` | `RIG_EXPLORER_URL` | Block explorer |
| `--app-url` | `RIG_APP_URL` | Default app URL |
| `--key-file` | `RIG_KEY_FILE` | File holding only a burner key |
| `--headless` | `RIG_HEADLESS=1` | No visible window (untested; extensions in new headless Chromium may work, may not) |
| `--allow-mainnet` | `RIG_ALLOW_MAINNET=1` | Permit approvals on real-money chains |
| | `RIG_PORT` | Daemon port, default 7331 |

> Give a network in `args` and it is fixed for the session: `rig_network use` will refuse to change it. Give none and choose at runtime.

## ✅ Verifying an install

```bash
pnpm check                      # typecheck + unit tests
pnpm smoke                      # a handful of MCP calls against RIG_APP_URL
pnpm mcp:loop -- --runs 10      # ten purchases in a row through the MCP tools, verified on chain
pnpm buy:loop -- --runs 10      # the same through the daemon's HTTP API
```

The loops restart the browser between runs and clear the site's session, so every run exercises connect, signature and trade from cold. `./bin/rig` is the CLI (`./bin/rig` still works as an alias).

## 🐛 Traps Already Handled

- **MetaMask never raises a usable approval window under automation.** With any extension page open it suppresses the popup; with none open it opens its home page, showing the wallet rather than the request. The queue is only reachable at `notification.html`, which the rig opens itself and reloads on every poll.
- **The browser must not close straight after an approval.** Extension state is written asynchronously, so shutting down too fast loses the permission, network or account just granted.
- **Two daemons must never share the profile.** The daemon claims `.rig/daemon.json` the moment it listens, flagged `booting`, and flags it `stopping` on the way out; every launcher waits on those states instead of starting a twin, and a daemon only ever removes its own record. If the browser is closed from outside, the daemon exits and the next call relaunches it.
- **The rig has no tab of its own.** Provider calls (`connect`, `request`, `add_network` with a site open) run `window.ethereum` in the page under test, exactly as a user's dapp would; MetaMask scopes accounts and the selected network per site, so that is the only honest place to ask. Wallet-only work (reading the address, adding a network with no site open, checking the lock) drives MetaMask's own pages in a temporary tab that is closed again and hands focus back. Nothing but the app and MetaMask is ever on screen.
- **The daemon speaks only to loopback names.** Every request must carry `Host: 127.0.0.1:<port>` or `localhost:<port>` and the session token (`x-rig-token`, or `?token=` for the live viewer at `/live`), so a page elsewhere whose name resolves to 127.0.0.1 gets nothing.
- **"Your wallet is ready" can leave its button permanently disabled.** The vault already exists by then, so setup navigates past it.
- **Script evaluation is blocked on wallet pages.** Locators still work there; `rig_eval` does not.
- **Screenshot scale.** Images are captured so that pixels equal click coordinates, while OCR uses the higher-resolution capture and maps back.
- **Duplicate labels.** Apps often render a disabled copy of a button beside the live one, so match the first *enabled* hit.

## 🚧 Future Roadmap

- [ ] Publish to npm and the MCP registry
- [ ] Verify on Linux and Windows
- [ ] More wallets, starting with Rabby
- [ ] Optional OCR, so `tesseract` stops being a system dependency
- [ ] Record and replay a driven flow as a test
- [ ] Elicitation for network choice, where the client supports it

## 🧩 Extending It

| Add | Where |
| --- | --- |
| An action such as click or scroll | A function in `src/daemon/cmds/` plus an entry in the `generic` map in `src/daemon/commands.ts` |
| An MCP tool | An entry in the `tools` array in `src/mcp/tools.ts` plus a handler in `src/mcp.ts` |
| A wallet subcommand | An entry in the `commands` map in `src/daemon/cmds/wallet.ts` |
| A moved MetaMask screen | A selector in `src/metamask/selectors.ts` |

Onboarding and settings screens fall back from test id to role to text, so a moved button degrades instead of failing. Approvals never fall back: a request the rig cannot classify is refused, not guessed. Run `pnpm typecheck` after any
change.

> **The daemon caches loaded modules.** After editing anything under `src/`, stop and start it, or you are testing the old code.

## 📄 License

MIT.
