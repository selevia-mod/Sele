#!/usr/bin/env node
// Stage 11C extraction — withdrawal request flow → js/earnings.js
//
// Reads js/app.js, slices out the "Withdrawal modal wiring" block
// (lines 7815-8047), applies the same revert-getters + _cfg
// substitutions Stage 11B used, and APPENDS to js/earnings.js. With
// 11C landed, all 18 getAuthorBalance() / getAuthorKyc() callsites in
// app.js disappear; the exported getters become unused, so we drop
// the imports from app.js too.

const fs = require('fs');

const APP_PATH      = 'js/app.js';
const EARNINGS_PATH = 'js/earnings.js';

const BODY_START = 7815;  // // ── Withdrawal modal wiring ─
const BODY_END   = 8047;  // last line before // ── New book modal

const appSrc = fs.readFileSync(APP_PATH, 'utf8');
const appLines = appSrc.split('\n');

const block = appLines.slice(BODY_START - 1, BODY_END).join('\n');

// Same transforms as Stage 11B — revert getters to direct state
// access, apply _cfg subs.
function transform(s) {
  return s
    .replace(/\bgetAuthorBalance\(\)/g, '_authorBalance')
    .replace(/\bgetAuthorKyc\(\)/g, '_authorKyc')
    .replace(/\bcurrentUser\b/g, '_cfg.getCurrentUser()')
    .replace(/\bcurrentProfile\b/g, '_cfg.getCurrentProfile()')
    .replace(/\b_walletConfigDefaults\b/g, '_cfg.getWalletConfig()');
}

const blockT = transform(block);

// ── Append to earnings.js ────────────────────────────────────────────────
let earningsSrc = fs.readFileSync(EARNINGS_PATH, 'utf8');

const header = `
// ════════════════════════════════════════════════════════════════════════
// STAGE 11C — Withdrawal request flow
// ════════════════════════════════════════════════════════════════════════
// Moved from app.js (was lines 7815-8047, the block between Stage 11B's
// KYC subsystem and the Books / New Book modal). Owns:
//
//   • PAYMENT_METHOD_LABELS constant (gcash/maya/bank/gotyme display
//     names — used by the Request payout modal header).
//   • btnRequestPayout click handler — opens the min-payout / no-KYC /
//     no-balance dispatch modal OR the actual withdrawal modal.
//   • _closeMinPayoutModal — dismisses the gate modal.
//   • _isPioneerExempt + _pioneerDaysRemaining — Pioneer-fee-exemption
//     helpers (reads profile.created_at against app_config).
//   • _renderWithdrawalFeePreview — recomputes the fee breakdown line
//     items (platform cost, transfer fee, net) on every input keystroke.
//     Pioneer-aware: shows "Waived" + countdown banner when exempt.
//   • withdrawalAmount input/change listeners — debounce-free per-key
//     refresh of the fee preview.
//   • withdrawalSubmit click handler — calls request_author_withdrawal
//     RPC (the same one mobile uses), translates server error codes
//     to friendly toasts, refreshes the earnings page on success.
//
// With this stage landed, the Earnings page is fully self-contained in
// js/earnings.js — read/render (11A) + KYC (11B) + withdrawal flow (11C).
// The exported getAuthorBalance / getAuthorKyc getters are no longer
// used by app.js (no callers remain) and could be removed in a future
// cleanup, but kept for now in case other modules want to read state.
// ════════════════════════════════════════════════════════════════════════

`;

earningsSrc = earningsSrc.trimEnd() + '\n' + header + blockT + '\n';
fs.writeFileSync(EARNINGS_PATH, earningsSrc);

// ── Remove block from app.js + drop now-unused getAuthorBalance/Kyc imports ─
const marker = [
  '// ════════════════════════════════════════════════════════════════════════',
  '// Withdrawal request flow MOVED to js/earnings.js (Stage 11C).',
  '// ~232 lines, 4 fns + 3 listeners + PAYMENT_METHOD_LABELS constant:',
  '// btnRequestPayout click handler, _closeMinPayoutModal,',
  '// _isPioneerExempt, _pioneerDaysRemaining, _renderWithdrawalFeePreview,',
  '// withdrawalAmount input/change listeners, withdrawalSubmit handler.',
  '//',
  "// With 11C landed, ALL Earnings page logic lives in earnings.js. The",
  '// only earnings touchpoint in app.js is the initEarnings({...}) call',
  '// (which wires the 5 cross-feature _cfg handles) and the import line.',
  '// ════════════════════════════════════════════════════════════════════════',
].join('\n');

const newLines = [];
for (let i = 0; i < appLines.length; i++) {
  const lineNum = i + 1;
  if (lineNum === BODY_START) {
    newLines.push(marker);
    i = BODY_END - 1;
    continue;
  }
  newLines.push(appLines[i]);
}

let appAfter = newLines.join('\n');

// Drop the now-unused getter imports + the comment line above them.
appAfter = appAfter.replace(
  /\n  \/\/ Read-only getters for state that 11B \(KYC handlers\) \+ 11C \(withdrawal\n  \/\/ request\) need until they're extracted\. `resolveEarningsTitles` is\n  \/\/ borrowed by the wallet-history block \(Stage 13 territory\)\.\n  getAuthorBalance, getAuthorKyc, resolveEarningsTitles,\n/,
  '\n  // resolveEarningsTitles borrowed by the wallet-history block until\n  // Stage 13 extracts wallet. getAuthorBalance/getAuthorKyc were used by\n  // the KYC + withdrawal handlers before 11B/11C extracted them — those\n  // sites are all gone now, so dropping the getters from this import.\n  resolveEarningsTitles,\n'
);

fs.writeFileSync(APP_PATH, appAfter);

console.log('Appended', (BODY_END - BODY_START + 1), 'lines to', EARNINGS_PATH);
console.log('Removed same from', APP_PATH);
console.log('Dropped getAuthorBalance + getAuthorKyc from app.js import (no callers left)');
