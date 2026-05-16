#!/usr/bin/env node
// Stage 11B extraction — KYC + Payments Info subsystem → js/earnings.js
//
// Reads js/app.js, slices out the KYC subsystem block (lines 7805-8241
// in the post-11A app.js), applies cross-module substitutions to revert
// the getAuthorBalance()/getAuthorKyc() getters back to direct module-
// private state access (since the moved code now lives in the same
// module as the state), runs the same _cfg substitutions Stage 11A
// used (currentUser/currentProfile/_walletConfigDefaults), and APPENDS
// the transformed block to js/earnings.js.
//
// Then:
//   - Removes the source range from app.js, replaces with MOVED marker.
//   - Updates earnings.js _cfg block — drops the 3 temporary KYC
//     bridges (renderAuthorKycBanner, syncAuthorPayoutButton,
//     fillPaymentsInfoForm).
//   - Rewrites earnings.js's `_cfg.renderAuthorKycBanner()` /
//     `_cfg.syncAuthorPayoutButton()` / `_cfg.fillPaymentsInfoForm()`
//     calls to direct intra-module calls.
//   - Updates app.js's initEarnings({...}) block — drops the 3 bridge
//     entries.

const fs = require('fs');

const APP_PATH      = 'js/app.js';
const EARNINGS_PATH = 'js/earnings.js';

const BODY_START = 7805;  // function renderAuthorKycBanner()
const BODY_END   = 8241;  // end of submitPaymentInfoChange + module-load wiring

const appSrc = fs.readFileSync(APP_PATH, 'utf8');
const appLines = appSrc.split('\n');
const slice = (s, e) => appLines.slice(s - 1, e).join('\n');

const block = slice(BODY_START, BODY_END);

// ── Transform the block ──────────────────────────────────────────────────
// The moved code now lives in earnings.js, which has:
//   - _cfg.getCurrentUser() / _cfg.getCurrentProfile() (use these)
//   - _cfg.getWalletConfig() (use this)
//   - Direct module-private state: _authorBalance, _authorKyc,
//     _allEarningsCache, etc. — so revert getAuthorBalance() /
//     getAuthorKyc() to bare identifiers.
//   - Direct functions: loadAuthorEarnings, formatPhpFromMinor, etc.
function transform(s) {
  return s
    // Revert the getters → direct state (intra-module access now)
    .replace(/\bgetAuthorBalance\(\)/g, '_authorBalance')
    .replace(/\bgetAuthorKyc\(\)/g, '_authorKyc')
    // Same substitutions Stage 11A applied (any new instances in this
    // block get the same treatment)
    .replace(/\bcurrentUser\b/g, '_cfg.getCurrentUser()')
    .replace(/\bcurrentProfile\b/g, '_cfg.getCurrentProfile()')
    .replace(/\b_walletConfigDefaults\b/g, '_cfg.getWalletConfig()');
}

const blockT = transform(block);

// ── Append to earnings.js ────────────────────────────────────────────────
let earningsSrc = fs.readFileSync(EARNINGS_PATH, 'utf8');

const stage11bHeader = `
// ════════════════════════════════════════════════════════════════════════
// STAGE 11B — KYC + Payments Info form subsystem
// ════════════════════════════════════════════════════════════════════════
// Moved from app.js (was lines 7805-8241, the block between the Stage 11A
// read/render layer and the Stage 11C withdrawal request flow). Owns:
//
//   • renderAuthorKycBanner — the colored banner at the top of the
//     Earnings tab that nudges creators through the KYC pipeline
//     (Submit / Pending review / Approved / Rejected with reason).
//   • syncAuthorPayoutButton — keeps the Request payout button's tooltip
//     in sync with KYC + balance + min-payout state.
//   • Payments Info form (inline, replaces the old modal):
//     uploadKycImage, wireKycUpload, _piUploads state, fillPayments-
//     InfoForm, applyPaymentsInfoLockState.
//   • Payments Info change request modal:
//     openPaymentInfoChangeModal, closePaymentInfoChangeModal,
//     createPaymentInfoChangeModal, submitPaymentInfoChange.
//
// These were bridged into earnings.js via _cfg during Stage 11A. After
// 11B those bridges are gone — switchEarningsTab calls
// fillPaymentsInfoForm directly, and loadAuthorEarnings calls
// renderAuthorKycBanner + syncAuthorPayoutButton directly.
//
// (Stage 11C — withdrawal request flow — still in app.js.)
// ════════════════════════════════════════════════════════════════════════

`;

earningsSrc = earningsSrc.trimEnd() + '\n' + stage11bHeader + blockT + '\n';

// ── Drop the 3 KYC bridges from earnings.js _cfg defaults ────────────────
earningsSrc = earningsSrc.replace(
  /\n  renderAuthorKycBanner:    \(\) => \{\},\n  syncAuthorPayoutButton:   \(\) => \{\},\n  fillPaymentsInfoForm:     \(\) => \{\},\n/,
  '\n'
);

// ── Rewrite earnings.js _cfg.X() calls to direct intra-module calls ──────
earningsSrc = earningsSrc
  .replace(/\b_cfg\.renderAuthorKycBanner\(\)/g, 'renderAuthorKycBanner()')
  .replace(/\b_cfg\.syncAuthorPayoutButton\(\)/g, 'syncAuthorPayoutButton()')
  .replace(/\b_cfg\.fillPaymentsInfoForm\(\)/g, 'fillPaymentsInfoForm()');

fs.writeFileSync(EARNINGS_PATH, earningsSrc);

// ── Remove the block from app.js, replace with MOVED marker ─────────────
const marker = [
  '// ════════════════════════════════════════════════════════════════════════',
  '// KYC + Payments Info form subsystem MOVED to js/earnings.js (Stage 11B).',
  '// ~437 lines, 10 functions: renderAuthorKycBanner, syncAuthorPayoutButton,',
  '// uploadKycImage, wireKycUpload, fillPaymentsInfoForm, applyPaymentsInfo-',
  '// LockState, openPaymentInfoChangeModal, closePaymentInfoChangeModal,',
  '// createPaymentInfoChangeModal, submitPaymentInfoChange.',
  '//',
  '// Stage 11A bridges (_cfg.renderAuthorKycBanner / syncAuthorPayoutButton /',
  '// fillPaymentsInfoForm) are now intra-module direct calls. The 3 entries',
  "// were dropped from app.js's initEarnings({...}) block too.",
  '//',
  '// Stage 11C — withdrawal request flow — still below.',
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

// ── Drop the 3 KYC bridges from app.js initEarnings({...}) ───────────────
let appAfter = newLines.join('\n');
appAfter = appAfter.replace(
  /\n  renderAuthorKycBanner,\n  syncAuthorPayoutButton,\n  fillPaymentsInfoForm,\n/,
  '\n'
);

fs.writeFileSync(APP_PATH, appAfter);

console.log('Appended', (BODY_END - BODY_START + 1), 'lines to', EARNINGS_PATH);
console.log('Removed same from', APP_PATH);
console.log('Dropped 3 KYC bridges from _cfg defaults + initEarnings call');
