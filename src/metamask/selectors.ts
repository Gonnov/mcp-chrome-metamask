/**
 * MetaMask 13.48.0.0 selectors and UI text. Every string marked VERIFIED was
 * grepped out of the shipped bundle or seen live. This is the one place to
 * audit after a MetaMask bump: the code never embeds a selector or a button
 * label of its own.
 *
 * SRP import selectors were removed with the SRP import path; the rig creates
 * a wallet and imports a private key.
 */
import type { PopupKind } from '../types.js';

export const UNLOCK = {
  password: '[data-testid="unlock-password"]', // VERIFIED
  submit: '[data-testid="unlock-submit"]', // VERIFIED
};

/** Cancel ladder for any dapp notification. Order matters. */
export const REJECT_SELECTORS = [
  '[data-testid="confirm-footer-cancel-button"]', // VERIFIED
  '[data-testid="cancel-btn"]', // VERIFIED
  '[data-testid="confirmation-cancel-button"]', // VERIFIED
  '[data-testid="page-container-footer-cancel"]', // VERIFIED
];

export const REJECT_TEXTS = ['Reject', 'Cancel', 'No thanks'];

export const REJECT_ALL = '[data-testid="confirm-nav__reject-all"]'; // VERIFIED
export const SCROLL_TO_BOTTOM = '[data-testid="scroll-to-bottom"]'; // VERIFIED

/**
 * Markers used to classify what a notification window is asking for. Order is
 * priority: the value-moving kinds come before `connect`, since `confirm-btn`
 * also appears as a secondary button on some warning pages. The gate judges
 * the kind found here, and approve clicks only that kind's own button.
 */
export const KIND_MARKERS: { kind: PopupKind; sel: string }[] = [
  { kind: 'unlock', sel: UNLOCK.password },
  { kind: 'tx-or-sign', sel: '[data-testid="confirm-footer-button"]' },
  { kind: 'legacy', sel: '[data-testid="page-container-footer-next"]' },
  { kind: 'confirmation', sel: '[data-testid="confirmation-submit-button"]' },
  { kind: 'connect', sel: '[data-testid="confirm-btn"]' },
];

/** The one primary button each kind owns. Approve never clicks anything else. */
export const KIND_APPROVE: Partial<Record<PopupKind, string>> = {
  'tx-or-sign': '[data-testid="confirm-footer-button"]',
  legacy: '[data-testid="page-container-footer-next"]',
  confirmation: '[data-testid="confirmation-submit-button"]',
  connect: '[data-testid="confirm-btn"]',
};

/**
 * Where a request page names the network it will execute on, when it has a
 * dedicated element. The redesigned tx and signature pages (13.x) have none:
 * they render a "Network" row, read from the accessibility tree instead.
 * (`header-network-display-name` is NOT the network: it shows the account
 * group, e.g. "Imported accounts".)
 */
export const NETWORK_DISPLAY = [
  '[data-testid="confirmation__details-network-name"]', // VERIFIED - templated confirmations
  '[data-testid="signature-request-network-display"]', // VERIFIED - legacy signature pages
  '[data-testid="network-display"]', // VERIFIED - legacy pages
];
/** Switch-network confirmations name the target network here. */
export const NETWORK_SWITCH_TARGET = '[data-testid="network-switch-to-network"]'; // VERIFIED

/**
 * Rows on a request page, as the accessibility tree labels them. The gate's
 * exemption for add-network prompts is keyed on these exact strings, so a
 * MetaMask rewording fails closed (prompts refused, never approved blind).
 */
export const PROMPT_ROWS = {
  network: 'Network',
  requestFrom: 'Request from',
  rpc: 'RPC',
  addNetworkSentence: 'A site is suggesting additional network details.',
  /** Rows only value-moving requests carry. */
  valueRows: ['Message', 'Signing with', 'Sending', 'Spending cap'],
};

/** Onboarding + home screens, each a step in the mm setup state machine. */
export const ONBOARD = {
  termsCheckbox: '[data-testid="terms-of-use-checkbox"]', // VERIFIED
  termsScroll: '[data-testid="terms-of-use-scroll-button"]', // VERIFIED
  termsAgree: '[data-testid="terms-of-use-agree-button"]', // VERIFIED
  createWallet: '[data-testid="onboarding-create-wallet"]', // VERIFIED
  createWithSrp: '[data-testid="onboarding-create-with-srp-button"]', // VERIFIED (templated)
  /** Detected only, never clicked: the rig does not opt into telemetry. */
  metricsAgree: '[data-testid="metametrics-i-agree"]', // VERIFIED
  metricsCheckbox: '[data-testid="onboarding-metametrics__checkbox"]', // VERIFIED
  passwordNew: '#create-password-new', // VERIFIED (element id, not testid)
  passwordConfirm: '#create-password-confirm', // VERIFIED (element id)
  passwordTerms: '[data-testid="create-password-terms"]', // VERIFIED
  passwordSubmit: '[data-testid="create-password-submit"]', // VERIFIED
  passkeyLater: '[data-testid="passkey-maybe-later-button"]', // VERIFIED
  privacySettings: '[data-testid="privacy-settings-settings"]', // VERIFIED
  complete: '[data-testid="onboarding-complete-done"]', // VERIFIED
};

/** Nags MetaMask shows on the home screen after onboarding. */
export const NAGS = [
  '[data-testid="popover-close"]', // VERIFIED
  '[data-testid="musd-education-not-now-button"]', // VERIFIED
  '[data-testid="perps-tutorial-skip-button"]', // VERIFIED
  '[data-testid="recovery-phrase-remind-later"]', // VERIFIED
];

/** The add-network form under Manage networks (13.48; from the bundle audit). */
export const NETWORK_FORM = {
  nameInput: '[data-testid="network-form-network-name"]', // VERIFIED (inner input)
  chainIdInput: '[data-testid="network-form-chain-id"]', // VERIFIED (inner input)
  tickerInput: '[data-testid="network-form-ticker-input"]', // VERIFIED (inner input)
  chainIdError: '[data-testid="network-form-chain-id-error"]', // VERIFIED
  rpcDropdown: '[data-testid="test-add-rpc-drop-down"]', // VERIFIED
  rpcUrlInput: '[data-testid="rpc-url-input-test"]', // VERIFIED
  explorerDropdown: '[data-testid="test-explorer-drop-down"]', // VERIFIED
  explorerUrlInput: '[data-testid="explorer-url-input"]', // UNVERIFIED (modal variant)
  addExplorerButton: '[data-testid="add-block-explorer-url-button"]', // UNVERIFIED (modal variant)
  footerNext: '[data-testid="page-container-footer-next"]', // VERIFIED - "Add URL" in sub-views, "Save" on the form
  successToast: '[data-testid="networks-page-network-success-toast"]', // VERIFIED
  listPage: '[data-testid="networks-page-list"]', // VERIFIED
  menuNetworks: '[data-testid="global-menu-networks"]', // VERIFIED (menu item id)
  addCustomNetworkButton: '[data-testid="networks-page-add-custom-network-button"]', // VERIFIED
};

/** Where the home page shows the selected account's address. */
export const ACCOUNT = {
  addressContainer: '[data-testid="default-address-container"]', // VERIFIED - truncated
  addressMenuButton: '[data-testid="default-address-menu-button"]', // VERIFIED
  qrRowButton: '[data-testid="multichain-address-row-qr-button"]', // VERIFIED
  qrAddress: '[data-testid="account-address"]', // VERIFIED - full address, three spans
  qrBack: '[data-testid="address-qr-code-modal-back-button"]', // VERIFIED
};

export const HOME = {
  accountMenu: '[data-testid="account-menu-icon"]', // VERIFIED
  accountOptions: '[data-testid="account-options-menu-button"]', // VERIFIED
};

/** Button labels the rig matches by text. Regexes, so a locale change is visible here. */
export const TEXT = {
  noThanks: /no thanks/i,
  continueOrNext: /^(continue|next|done)$/i,
  createPassword: /create password|create a new wallet|confirm/i,
  privacyDismiss: /no thanks|skip|done/i,
  closeButton: /^close /i,
  addWallet: /add wallet/i,
  addAccount: /add account/i,
  importAccount: /import an account/i,
  privateKey: /private key/i,
  importSubmit: /^import$/i,
  addRpcUrl: /^add rpc url$/i,
  addExplorerUrl: /^add a block explorer url$/i,
  chainIdExists: /already|exist|used|in use/i,
  rpcRejected: /currently used|invalid|unreachable|could not/i,
};
