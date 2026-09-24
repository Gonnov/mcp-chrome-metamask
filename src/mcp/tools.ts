/**
 * The MCP tool surface: eight tools, each taking an `action`. This literal is
 * the public contract; handlers live in src/mcp.ts.
 */
const TARGET = {
  type: 'string',
  description:
    'Which page to act on: app (the site under test), popup (the wallet approval window), mm (the wallet UI), active (default), or a numeric page id.',
} as const;

export const tools = [
  {
    name: 'rig_session',
    description:
      'Control the browser session. start launches it (and stages the wallet extension on first use), status reports wallet and chain state, pages lists open tabs, stop closes the browser. Call start or status before anything else.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'status', 'stop', 'pages', 'boot'],
          description: 'What to do. Defaults to status.',
        },
        headless: { type: 'boolean', description: 'Run without a visible window (start only).' },
      },
    },
  },
  {
    name: 'rig_navigate',
    description:
      'Move around: open a URL, wait for a condition, resize the window, or close a page. wait with for="popup" is how you block until the wallet has a request to approve; it returns cleanly instead of hanging when nothing is pending.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['goto', 'wait', 'resize', 'close', 'use'], description: 'Defaults to goto.' },
        url: { type: 'string', description: 'URL for goto.' },
        for: {
          type: 'string',
          enum: ['ms', 'text', 'url', 'selector', 'popup', 'popup-gone'],
          description: 'What wait should wait for.',
        },
        value: { type: 'string', description: 'The text, url fragment, selector, or millisecond count to wait for.' },
        timeout: { type: 'number', description: 'Wait timeout in ms. Default 15000.' },
        width: { type: 'number' },
        height: { type: 'number' },
        target: TARGET,
      },
    },
  },
  {
    name: 'rig_look',
    description:
      'See the page. screenshot returns the image inline. aria returns the accessibility tree, which is usually enough and far cheaper than an image; it also covers modals portalled outside <body> and child frames, appended as labelled sections. ocr returns numbered word boxes with centre coordinates for clicking by id when the DOM is not usable. find locates an element by text and reports whether it is visible and enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'aria', 'ocr', 'find', 'console'],
          description: 'Defaults to screenshot.',
        },
        text: { type: 'string', description: 'Text to find (find only).' },
        role: { type: 'string', description: 'Restrict find to an ARIA role, e.g. button.' },
        annotate: { type: 'boolean', description: 'Overlay numbered OCR boxes and a coordinate grid.' },
        full_page: { type: 'boolean', description: 'Capture the whole scrollable page.' },
        path_only: {
          type: 'boolean',
          description: 'Return the file path instead of the image, to save context.',
        },
        full_quality: {
          type: 'boolean',
          description: 'Return the full-resolution PNG instead of a downscaled JPEG. Costs far more context; use only when fine detail matters.',
        },
        target: TARGET,
      },
    },
  },
  {
    name: 'rig_act',
    description:
      'Interact. click accepts text (tried against the DOM first, then OCR), a CSS selector, an OCR box id, or raw x,y coordinates. Coordinates match screenshot pixels exactly. Prefer text or selector; fall back to coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'press', 'scroll'], description: 'Defaults to click.' },
        text: { type: 'string', description: 'Text to click, or the text to type.' },
        selector: { type: 'string', description: 'CSS selector to click or fill.' },
        ocr_id: { type: 'string', description: 'Box id from a recent ocr call.' },
        xy: { type: 'string', description: 'Raw coordinates as "x,y".' },
        role: { type: 'string' },
        name: { type: 'string' },
        nth: { type: 'number', description: 'Pick the nth match. Default 0.' },
        key: { type: 'string', description: 'Key for press, e.g. Enter or Escape.' },
        dy: { type: 'number', description: 'Scroll distance.' },
        target: TARGET,
      },
    },
  },
  {
    name: 'rig_wallet',
    description:
      'Drive MetaMask. setup onboards a fresh wallet on first run, generating its password, and imports a burner key if one is configured. connect and request run window.ethereum in the site under test, so open it first with rig_navigate; the wallet scopes accounts and network per site. add_network adds any EVM chain by chain_id and rpc_url, through the site when one is open (and switches it), else through the wallet\'s own settings. approve confirms whatever the wallet is currently asking, which is how connect, signature and transaction prompts are cleared. Every transaction or signature prompt is checked against the chain the wallet is on right now and refused unless that chain is provably a test or local network, or the operator vouched for it from their own shell. There is no tool argument that overrides this.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status', 'setup', 'unlock', 'approve', 'reject', 'pending',
            'connect', 'add_network', 'import_key', 'request', 'popups', 'fetch', 'home', 'address',
          ],
          description: 'Defaults to status.',
        },
        all: { type: 'boolean', description: 'Drain every queued request, not just the first. Each one is gated on its own.' },
        chain_id: { type: 'string', description: 'Chain id to add, decimal or 0x hex (add_network).' },
        rpc_url: { type: 'string', description: 'RPC endpoint for the network being added.' },
        name: { type: 'string', description: 'Display name for the network being added.' },
        symbol: { type: 'string', description: 'Native currency symbol, e.g. ETH or DOGE.' },
        explorer: { type: 'string', description: 'Block explorer URL for the network.' },
        method: { type: 'string', description: 'JSON-RPC method for request, e.g. personal_sign.' },
        params: { type: 'string', description: 'JSON array of params for request.' },
        version: { type: 'string', description: 'MetaMask version to download (fetch only).' },
        dry: { type: 'boolean', description: 'For setup: report each detected screen without acting.' },
        key_file: {
          type: 'string',
          description: 'Path to a file containing only a burner private key, read by the server at import time. A key must never be passed as an argument: arguments become part of the transcript. Omit this and the wallet generates its own account.',
        },
        target: TARGET,
      },
    },
  },
  {
    name: 'rig_network',
    description:
      'Choose and inspect the chain the wallet runs on. list shows what is configured and what the wallet already has. use adds a network, and switches the site under test to it when one is open. current classifies the chain the site under test is on (else the last one seen) and says whether it spends real money. A chain the classifier cannot place must be vouched for by the operator from their own shell (./bin/dapp network allow <id>) before the rig will auto-approve on it; that is deliberately not a tool action.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'current', 'use'], description: 'Defaults to list.' },
        chain_id: { type: 'string', description: 'Chain id, decimal or 0x hex.' },
        rpc_url: { type: 'string', description: 'RPC endpoint for the network.' },
        name: { type: 'string', description: 'Display name for the network.' },
        symbol: { type: 'string', description: 'Native currency symbol.' },
        explorer: { type: 'string', description: 'Block explorer URL.' },
      },
    },
  },
  {
    name: 'rig_chain',
    description:
      'Read chain state, and on a local node only, manipulate it. info reports chain id and head block; balance reads a native balance. snapshot, revert, fund and mine refuse to run against anything but a local node. Pass rpc to choose an endpoint; otherwise the RPC of the configured network is used, else the last network added to the wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['info', 'balance', 'snapshot', 'revert', 'fund', 'mine'],
          description: 'Defaults to info.',
        },
        address: { type: 'string' },
        rpc: {
          type: 'string',
          description: 'RPC endpoint to query. Defaults to the configured network, else the last one added to the wallet.',
        },
        doge: { type: 'number', description: 'Amount to fund, in whole native units (the name is historical; amount works too).' },
        amount: { type: 'number', description: 'Amount to fund, in whole native units.' },
        blocks: { type: 'number', description: 'Blocks to mine (mine only). Default 1.' },
        id: { type: 'string', description: 'Snapshot id to revert to.' },
      },
    },
  },
  {
    name: 'rig_eval',
    description:
      'Run JavaScript in a page and return the result. Use fire=true for calls that open a wallet prompt, then approve, then read the outcome with action=result. Does not work on wallet pages, which block script evaluation.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['eval', 'result'], description: 'Defaults to eval.' },
        code: { type: 'string', description: 'JavaScript to evaluate.' },
        fire: { type: 'boolean', description: 'Return immediately with a request id instead of awaiting.' },
        request_id: { type: 'string', description: 'Request id to read (action=result).' },
        target: TARGET,
      },
    },
  },
];


