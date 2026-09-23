export type TargetName = 'app' | 'popup' | 'mm' | 'active';
/** A target is a named alias or a numeric page id as a string. */
export type Target = TargetName | string;

export type PageKind = 'app' | 'popup' | 'mm' | 'other';

/** Loose command arguments as they arrive over HTTP, MCP or the CLI. */
export type Args = Record<string, unknown>;

export interface PageInfo {
  id: number;
  kind: PageKind;
  url: string;
  title: string;
  viewport: { w: number; h: number } | null;
  dpr: number;
  active: boolean;
}

export interface OcrBox {
  id: string;
  text: string;
  conf: number;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export interface OcrResult {
  ts: number;
  target: string;
  scale: number;
  words: OcrBox[];
  lines: OcrBox[];
}

export type PopupKind =
  | 'unlock'
  | 'connect'
  | 'confirmation'
  | 'tx-or-sign'
  | 'legacy'
  | 'unknown';

/** What one read of a wallet request page yields. Taken once, passed around. */
export interface PromptInfo {
  kind: PopupKind;
  /** The network the request will execute on, as MetaMask renders it. */
  network: string | null;
  /** The requesting origin as MetaMask renders it, e.g. "HTTPS app.example". */
  origin: string | null;
  /** The RPC host shown on an add-network prompt. */
  rpcHost: string | null;
  /** An add-network or update-network prompt (structural check). */
  isNetworkPrompt: boolean;
  /** MetaMask's templated switch-network confirmation. */
  isSwitchPrompt: boolean;
}

/**
 * Decides, per queued wallet request, whether the rig may act on it. Called
 * with the request as read from its page, before any button is clicked;
 * throws to refuse.
 */
export type PopupGate = (prompt: PromptInfo, page: import('playwright').Page) => Promise<void>;

export interface PopupInfo {
  id: number;
  url: string;
  kind: PopupKind;
}

/** A network as the rig adds it. `chainId` is decimal or 0x hex; parseChainId normalises. */
export interface NetworkSpec {
  chainId: string;
  name: string;
  rpcUrl: string;
  symbol: string;
  explorer?: string;
}

/** EIP-3085 parameter for wallet_addEthereumChain. */
export interface AddEthereumChainParameter {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

/** Outcome of one provider request parked on the page bridge. */
export type BridgeResult =
  | { done: true; value: unknown; method: string }
  | { done: true; error: string; code?: unknown; method: string }
  | { done: false; navigated: true }
  | { done: false; timeout: true }
  | { done: false };

export interface RigState {
  extensionId?: string;
  metamaskDir?: string;
  metamaskVersion?: string;
  metamaskSource?: 'brave' | 'github';
  onboarded?: boolean;
  importedAddress?: string;
  /** The selected account as last read from the wallet's own UI. */
  walletAddress?: string;
  networks?: { chainId: string; name: string; rpc: string }[];
  chainId?: number;
  /** Generated MetaMask unlock password for this profile's throwaway wallet. */
  walletPassword?: string;
  /** Chain ids the operator has vouched for, despite the classifier. */
  allowedChains?: number[];
}

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  headless: boolean;
  /** Server is up but the browser is still launching; commands are refused. */
  booting?: boolean;
  /** Shutdown in progress; the browser profile is still held. */
  stopping?: boolean;
}

export type CmdResult = Record<string, unknown>;

/** Every error code the rig emits. Adding one here is the only way to add one. */
export type RigCode =
  | 'ADD_CHAIN_FAILED'
  | 'BAD_ARGS'
  | 'BAD_EXTENSION'
  | 'BODY_TOO_LARGE'
  | 'CHAIN_NOT_ALLOWED'
  | 'CHAIN_UNKNOWN'
  | 'DOWNLOAD_FAILED'
  | 'ERROR'
  | 'IMPORT_FAILED'
  | 'NETWORK_ADD_REFUSED'
  | 'NETWORK_LOCKED'
  | 'NOT_FORK'
  | 'NO_ACTION'
  | 'NO_APP_PAGE'
  | 'NO_BROWSER'
  | 'NO_EXTENSION'
  | 'NO_KEY'
  | 'NO_MATCH'
  | 'NO_PROVIDER'
  | 'NO_REQ'
  | 'NO_RPC'
  | 'NO_SOURCE'
  | 'NO_TARGET'
  | 'OCR_FAILED'
  | 'OCR_UNAVAILABLE'
  | 'RPC_ERROR'
  | 'RPC_HTTP'
  | 'RPC_UNREACHABLE'
  | 'SHOT_FAILED'
  | 'SOURCE_SWITCH'
  | 'STALE_OCR'
  | 'TIMEOUT'
  | 'UNKNOWN_CMD';

export class RigError extends Error {
  code: RigCode;
  /** Structured context for the caller, e.g. partial results before a refusal. */
  details?: Record<string, unknown>;
  constructor(code: RigCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.name = 'RigError';
    if (details) this.details = details;
  }

  /**
   * Turn any thrown value into a RigError, keeping a RigError's code and
   * details, naming a Playwright timeout as such, and merging `extra` into the
   * details so partial progress survives the throw.
   */
  static wrap(err: unknown, extra?: Record<string, unknown>): RigError {
    if (err instanceof RigError) {
      if (extra) err.details = { ...(err.details ?? {}), ...extra };
      return err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const code: RigCode = err instanceof Error && err.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR';
    return new RigError(code, message, extra);
  }
}
