#!/usr/bin/env node
// Stage 11A extraction — earnings read/render → js/earnings.js
//
// Reads js/app.js, extracts the two source ranges, applies the
// cross-module substitutions (currentUser → _cfg.getCurrentUser() etc.),
// wraps with the module header + _cfg injection + exports, and writes
// js/earnings.js. Then removes the source ranges from app.js and
// replaces with MOVED markers (mirrors Stage 10's manual style).
//
// Source ranges:
//   1935-1968 — showEarnings + switchEarningsTab + boot wiring (top)
//   7796-8843 — _authorBalance / _authorKyc state + all read/render fns
//
// Substitutions applied:
//   \bcurrentUser\b         → _cfg.getCurrentUser()
//   \bcurrentProfile\b      → _cfg.getCurrentProfile()
//   _walletConfigDefaults   → _cfg.getWalletConfig()
//   \bsetSidebarActive\(    → _cfg.setSidebarActive(
//   \bhideAllMainPages\(    → _cfg.hideAllMainPages(
//   \brenderAuthorKycBanner\(  → _cfg.renderAuthorKycBanner(
//   \bsyncAuthorPayoutButton\( → _cfg.syncAuthorPayoutButton(
//   \bfillPaymentsInfoForm\(   → _cfg.fillPaymentsInfoForm(

const fs = require('fs');

const APP_PATH      = 'js/app.js';
const EARNINGS_PATH = 'js/earnings.js';

const src = fs.readFileSync(APP_PATH, 'utf8');
const lines = src.split('\n');

// 1-based ranges as in the editor.
const BOOT_START = 1935, BOOT_END = 1968;     // showEarnings + switchEarningsTab + boot listeners
const BODY_START = 7796, BODY_END = 8843;     // _authorBalance + all read/render fns

const slice = (s, e) => lines.slice(s - 1, e).join('\n');

const bootBlock = slice(BOOT_START, BOOT_END);
const bodyBlock = slice(BODY_START, BODY_END);

// Apply substitutions to a code block. Word-boundary regex to avoid
// matching inside identifiers like _currentUserMeta. We deliberately
// do NOT skip comments — substituting inside a comment is harmless,
// the result is still a comment.
function transform(block) {
  return block
    // Identifiers
    .replace(/\bcurrentUser\b/g, '_cfg.getCurrentUser()')
    .replace(/\bcurrentProfile\b/g, '_cfg.getCurrentProfile()')
    .replace(/\b_walletConfigDefaults\b/g, '_cfg.getWalletConfig()')
    // Calls (only when followed by `(`)
    .replace(/\bsetSidebarActive\(/g, '_cfg.setSidebarActive(')
    .replace(/\bhideAllMainPages\(/g, '_cfg.hideAllMainPages(')
    .replace(/\brenderAuthorKycBanner\(/g, '_cfg.renderAuthorKycBanner(')
    .replace(/\bsyncAuthorPayoutButton\(/g, '_cfg.syncAuthorPayoutButton(')
    .replace(/\bfillPaymentsInfoForm\(/g, '_cfg.fillPaymentsInfoForm(');
}

const bootT = transform(bootBlock);
const bodyT = transform(bodyBlock);

// ────────────────────────────────────────────────────────────────────────
// Compose earnings.js
// ────────────────────────────────────────────────────────────────────────
const header = `// ════════════════════════════════════════════════════════════════════════
// Selebox earnings — extracted from js/app.js as Stage 11A of the
// refactor roadmap (2026-05-16). This module owns the READ / RENDER
// layer of the creator Earnings page:
//   • showEarnings + switchEarningsTab + boot wiring (top of page)
//   • loadAuthorEarnings (parallel fetch of balance + earnings +
//     withdrawals + KYC), month-picker, finalized-only filtering
//   • Breakdown drill-down (summary + paginated transactions) for
//     Posts / Videos / Books tiles
//   • Render functions: totals, breakdown tiles, balance card,
//     recent earnings list with pagination, withdrawal history list
//     with pagination, status label, currency formatter
//
// What's NOT here yet (queued):
//   • Stage 11B (#250) — KYC + Payments Info form subsystem
//     (renderAuthorKycBanner, syncAuthorPayoutButton, fillPaymentsInfoForm,
//      uploadKycImage, wireKycUpload, applyPaymentsInfoLockState,
//      openPaymentInfoChangeModal, submitPaymentInfoChange — bridged
//     via _cfg until they land here).
//   • Stage 11C (#251) — Withdrawal request flow
//     (_renderWithdrawalFeePreview, submit handler, _isPioneerExempt,
//      _pioneerDaysRemaining — still in app.js; the submit handler
//     calls back into loadAuthorEarnings via the export).
//
// CAREFUL: this is pure code movement, not a rewrite. If you see
// something you want to "improve while you're here" — DON'T. Open a
// separate task. The whole point of the stage discipline is
// "translation, not interpretation."
//
// See REFACTOR_ROADMAP.md (Stage 11A section).
// ════════════════════════════════════════════════════════════════════════

import { supabase, escHTML, initials, toast } from './supabase.js';

// ─── Config-injection dependency surface ──────────────────────────────────
// app.js INJECTS the live functions when it calls initEarnings(config) at
// sign-in. Default no-ops keep the page alive if a caller fires before
// init. The KYC bridges (renderAuthorKycBanner / syncAuthorPayoutButton /
// fillPaymentsInfoForm) are temporary — they'll be replaced by intra-
// module calls once Stage 11B moves the KYC subsystem here too.
let _cfg = {
  getCurrentUser:           () => null,
  getCurrentProfile:        () => null,
  getWalletConfig:          () => ({}),
  setSidebarActive:         () => {},
  hideAllMainPages:         () => {},
  renderAuthorKycBanner:    () => {},
  syncAuthorPayoutButton:   () => {},
  fillPaymentsInfoForm:     () => {},
};

export function initEarnings(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// Lazy DOM ref — element exists in index.html. We resolve it on first
// use rather than at module-load time so this module imports cleanly
// even when imported before DOMContentLoaded (matches the pattern from
// videos.js Stage 7A).
let _earningsPage = null;
function earningsPageEl() {
  if (!_earningsPage) _earningsPage = document.getElementById('earningsPage');
  return _earningsPage;
}

`;

// The original `showEarnings` body references `earningsPage` (a
// const lookup from app.js line 6889). Rewrite that to the lazy getter
// above so this module doesn't depend on a module-load-time DOM lookup.
const bootRewritten = bootT
  .replace(/\bif \(!earningsPage\) return;\n\s*earningsPage\.style\.display = 'block';/,
           `const __ep = earningsPageEl();\n  if (!__ep) return;\n  __ep.style.display = 'block';`);

// The original boot block ends with the btnEarnings click listener. That
// listener calls showEarnings() — intra-module call now. Keep as-is.

const composed = header + bootRewritten + '\n\n' + bodyT + '\n';

// ────────────────────────────────────────────────────────────────────────
// Promote selected functions to `export` and add an export block.
// We export by string replacement on the well-known declarations so
// callers in app.js (KYC, withdrawal, notifications, studio) can import
// them by name.
// ────────────────────────────────────────────────────────────────────────
const exportTargets = [
  'function switchEarningsTab',
  'async function loadAuthorEarnings',
  'async function openEarningsBreakdown',
  'function closeEarningsBreakdown',
  'async function _loadMoreEarningsBreakdown',
  'function renderEarningsTotals',
  'function renderEarningsBreakdown',
  'function renderAuthorEarningsBalance',
  'function formatPhpFromMinor',
  'function renderAuthorEarningsList',
  'function renderAuthorWithdrawalsList',
  'function earningsStatusLabel',
];
let withExports = composed;
for (const sig of exportTargets) {
  // Only the first occurrence of each signature should get the export
  // prefix. Use a non-global regex.
  const re = new RegExp('(?<![A-Za-z_])' + sig.replace(/\$/g, '\\$'));
  withExports = withExports.replace(re, 'export ' + sig);
}

// `showEarnings` already has `export function showEarnings` in the source
// — it was exported from app.js for studio/notifications consumers. The
// boot block we sliced preserved the `export` keyword, so no replacement
// needed there.

fs.writeFileSync(EARNINGS_PATH, withExports);

// ────────────────────────────────────────────────────────────────────────
// Delete the moved ranges from app.js, replace with MOVED markers.
// ────────────────────────────────────────────────────────────────────────
const bootMarker = [
  '// ── Earnings page (Phase 7 — own sidebar entry, tabs) ────────────────────',
  '// showEarnings + switchEarningsTab + boot listeners MOVED to js/earnings.js',
  '// (Stage 11A). The earnings module wires its own .earnings-tab + btnEarnings',
  "// listeners at module-load time. App.js still imports showEarnings for the",
  '// notification routing (nav.earnings) + Studio Share modal hand-off.',
].join('\n');

const bodyMarker = [
  '// ════════════════════════════════════════════════════════════════════════',
  '// Earnings read/render layer MOVED to js/earnings.js (Stage 11A).',
  '// ~1,000 lines covering loadAuthorEarnings + breakdown modal + all',
  '// totals/balance/recent-list/withdrawal-list rendering.',
  '//',
  '// Bridges still here in app.js (queued for later stages):',
  '//   • Stage 11B (#250) — KYC + Payments Info form subsystem',
  '//   • Stage 11C (#251) — Withdrawal request flow + Pioneer helpers',
  '//',
  '// formatPhpFromMinor is re-imported at the top of this file so the',
  '// withdrawal-flow handlers (still in app.js) and the _cfg passthrough',
  '// to other modules keep working.',
  '// ════════════════════════════════════════════════════════════════════════',
].join('\n');

const newLines = [];
for (let i = 0; i < lines.length; i++) {
  const lineNum = i + 1;
  if (lineNum === BOOT_START) {
    newLines.push(bootMarker);
    // Skip through BOOT_END
    i = BOOT_END - 1;
    continue;
  }
  if (lineNum === BODY_START) {
    newLines.push(bodyMarker);
    i = BODY_END - 1;
    continue;
  }
  newLines.push(lines[i]);
}
fs.writeFileSync(APP_PATH, newLines.join('\n'));

console.log('Wrote', EARNINGS_PATH, '(' + withExports.split('\n').length + ' lines)');
console.log('Removed', (BOOT_END - BOOT_START + 1) + (BODY_END - BODY_START + 1), 'lines from', APP_PATH);
