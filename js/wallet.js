// js/wallet.js — Stage 13A
//
// Owner module for: wallet state (coins + stars + unlocks), unlock paywall
// dialogs (single + bulk), and the time-based video monetization gate.
// Extracted from js/app.js per refactor roadmap stage 13A (2026-05-17).
//
// What lives here:
//   • Module state — _wallet, _userUnlocks, _walletConfigDefaults,
//     _walletChannel, _unlockInFlight, _videoMonetGate.
//   • _UNLOCK_ERROR_REGISTRY + _interpretUnlockError +
//     _submitUnlockRecoveryRequest + _handleUnlockFailure (mirrors mobile
//     lib/unlock-error-codes.js — keep both in sync when a new code lands).
//   • _verifyBulkUnlockPersistence + _previewBookBulkUnlock — bulk-unlock
//     diagnostics + server-authoritative price preview.
//   • loadWalletState — fetch + subscribe to my wallets row + unlocks set.
//   • renderTopbarCoinPill + formatBalance — topbar pill UI.
//   • onWalletChange(cb) — subscriber API. Replaces the monkey-patch
//     pattern (app.js used to reassign renderTopbarCoinPill, which is
//     illegal for ES module imports). Internal renderers + external
//     subscribers all run on _notifyWalletChange().
//   • normalizeUnlockTargetId / markUnlocked / isUnlocked /
//     resolveUnlockCost — read API used by feed, books, videos modules.
//   • openUnlockDialog + openBulkBookUnlockDialog — paywall modals.
//   • setupVideoMonetGate + teardownVideoMonetGate +
//     openVideoMonetThresholdDialog — Phase 6 time-based paywall.
//
// What stays in app.js (for Stage 13B):
//   • Store page (showStore, loadStorePacks, purchasePack, handleStoreReturn)
//   • Wallet history modal (openWalletHistory + helpers)
//   • renderStoreBalances (registers onWalletChange in app.js so the
//     Store-card render fires alongside the topbar pill).
//   • Migration banner, ad reward stub.
//
// Bridge contract:
//   initWallet({ getCurrentUser, tickGoalUnique, confirmDialog })
//     - getCurrentUser: () => currentUser | null. Read fresh each call so
//       sign-out is observed without a re-wire.
//     - tickGoalUnique: (goalKey, dedupeKey) => void. Called on successful
//       unlock (single + bulk) to credit the "Unlock N items" goal.
//     - confirmDialog: (msg) => Promise<boolean>. Reserved; currently
//       unused inside wallet.js (the dialogs use synchronous "are you
//       sure?" via in-flight guard) but Stage 13B's "negative balance
//       after refund" warning may need it.
//
// Sign-out cleanup:
//   App.js's signOut() calls teardownWallet() (removes realtime channel)
//   followed by resetWalletState() (clears _wallet + _userUnlocks). Order
//   matters: teardown FIRST so any in-flight realtime callback can't
//   touch state we're about to clear.

import { supabase, toast, escHTML } from './supabase.js';

// ─── Bridge config (filled by initWallet) ──────────────────────────────
let _cfg = {
  getCurrentUser:  () => null,
  tickGoalUnique:  () => {},
  confirmDialog:   async () => true,
};

export function initWallet(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// ════════════════════════════════════════════════════════════════════════
// MODULE STATE
// ════════════════════════════════════════════════════════════════════════

// Live wallet — mutated by realtime + unlock RPCs. Other modules can read
// via getWallet() but should never mutate directly.
let _wallet = { coin_balance: 0, star_balance: 0 };

// Keys: "video:UUID", "chapter:aw_xyz", "book:UUID". Bulk unlock adds
// per-chapter rows (one per chapter), not a single book row, per mobile
// parity (see _verifyBulkUnlockPersistence).
const _userUnlocks = new Set();

// app_config snapshot — fetched once on signin. Keys mirror the SQL
// app_config rows that the unlock/withdrawal/editor paths read. Defaults
// here are sensible fallbacks if app_config row is missing for any reason
// (network error during loadWalletState, etc.).
let _walletConfigDefaults = {
  default_chapter_unlock_coins:    3,
  default_chapter_unlock_stars:    3,
  default_video_unlock_coins:      1,
  default_video_unlock_stars:      1,
  star_daily_cap:                  20,
  book_bulk_unlock_discount_pct:   15,
  video_initial_unlock_seconds:    180,
  video_recurring_unlock_seconds:  600,
  min_chapter_words:               100,
  max_chapter_words:               10000,
  author_earnings_hold_days:       7,
};

// Realtime channel for wallets row UPDATEs. Owned per-session.
let _walletChannel = null;

// In-flight guard for unlock RPCs. Tap-coin-then-tap-star within ~50ms
// could otherwise fire two parallel RPCs (real money exposure).
let _unlockInFlight = false;

// Video monet gate registry. One active gate per session (one player at
// a time). { videoId, listener, player, seq } — listener is the
// timeupdate handler we attached to the player. Storing the player ref
// here (vs requiring callers to pass it back) lets teardownWallet()
// remove the listener even if the caller forgot to pass the element
// (Codex P1).
let _videoMonetGate = null;

// Setup sequence token. Each call to setupVideoMonetGate bumps this;
// the in-flight call records its own seq and bails after the await if
// the seq has been bumped by a newer call. Closes a race where the
// user switches videos while video_progress is loading — without this,
// the older setup's continuation could attach a listener that prompts
// for the WRONG video/threshold (Codex P1).
let _videoMonetSetupSeq = 0;

// ─── Wallet-change subscribers (onWalletChange API) ────────────────────
// Stage 13A introduced this to replace the function-replacement antipattern
// at app.js:2607 which reassigned `renderTopbarCoinPill` to also call
// `renderStoreBalances`. ES module exports are read-only bindings, so the
// old pattern can't survive extraction. Subscribers register here; we
// call them after every wallet mutation (realtime push, manual unlock,
// load, etc.).
const _walletChangeSubscribers = new Set();

function _notifyWalletChange() {
  renderTopbarCoinPill();
  for (const cb of _walletChangeSubscribers) {
    try { cb(); }
    catch (e) { console.warn('[wallet] subscriber threw:', e); }
  }
}

/**
 * Register a callback that runs after any wallet mutation (realtime
 * push, unlock success, sign-in load, etc.). Returns an unsubscribe
 * function.
 *
 * Used by Stage 13B's Store page to keep the in-page balance cards
 * in sync without monkey-patching renderTopbarCoinPill.
 *
 * Subscribers should be cheap (called on every realtime tick). If you
 * need to do work, debounce inside the callback.
 */
export function onWalletChange(cb) {
  if (typeof cb !== 'function') return () => {};
  _walletChangeSubscribers.add(cb);
  return () => _walletChangeSubscribers.delete(cb);
}

// ════════════════════════════════════════════════════════════════════════
// LIFECYCLE — load, teardown, reset
// ════════════════════════════════════════════════════════════════════════

/**
 * Fetch + subscribe to wallet state for the current user. Idempotent —
 * re-running closes the previous realtime subscription before opening
 * a new one.
 *
 * Called from:
 *   • App.js auth/signin path (after a fresh session lands).
 *   • Migration success handler (post Appwrite→Supabase wallet import).
 *   • Goal-claim refresh (after claiming a goal that pays coins/stars).
 */
export async function loadWalletState() {
  const me = _cfg.getCurrentUser();
  if (!me) return;
  // Capture userId at start so we can drop the write entirely if the user
  // signs out mid-load. Codex P1-3 — without this guard, a slow query
  // could complete after sign-out and write the OLD user's wallet data
  // into state that's about to be picked up by the NEW user's load.
  const userId = me.id;

  const [walletRes, unlocksRes, configRes] = await Promise.all([
    supabase.from('wallets').select('coin_balance, star_balance').eq('user_id', userId).maybeSingle(),
    supabase.from('unlocks').select('target_type, target_id').eq('user_id', userId),
    supabase.from('app_config').select('key, value_int'),
  ]);

  // Stale-user guard: if sign-out fired during the await, the current
  // user is now null OR a different person. Drop everything.
  const stillMe = _cfg.getCurrentUser();
  if (!stillMe || stillMe.id !== userId) return;

  // Codex P1 — don't clobber state on partial failure. A network blip
  // could fail any of the 3 parallel queries; previously we'd zero the
  // wallet and clear the unlocks set even though the server didn't say
  // they were empty. Worst case: user sees "0 coins" + locked content
  // they already paid for. Now: log and skip the offending slice;
  // anything that succeeded still updates.
  if (walletRes.error || unlocksRes.error || configRes.error) {
    console.warn('[wallet] loadWalletState partial failure:', {
      wallet: walletRes.error?.message,
      unlocks: unlocksRes.error?.message,
      config: configRes.error?.message,
    });
  }

  // Wallet row: only overwrite on success. maybeSingle returning null
  // data is a valid "no row yet" state (brand-new account before
  // wallets trigger fires) — that one IS a legit zero.
  if (!walletRes.error) {
    _wallet = walletRes.data || { coin_balance: 0, star_balance: 0 };
  }

  // Unlocks set: only clear+rebuild on successful fetch. Previously
  // an unlocks query error would empty the set silently and re-lock
  // content the user had paid for.
  if (!unlocksRes.error) {
    _userUnlocks.clear();
    for (const u of (unlocksRes.data || [])) {
      markUnlocked(u.target_type, u.target_id);
    }
  }

  // app_config: defaults stay if the fetch failed (the local defaults
  // at module-init are sensible fallbacks).
  if (!configRes.error) {
    for (const c of (configRes.data || [])) {
      if (c.key in _walletConfigDefaults) _walletConfigDefaults[c.key] = c.value_int;
    }
  }

  // Realtime subscription. Re-running loadWalletState (e.g. after goal
  // claim) tears down the old channel first.
  if (_walletChannel) {
    try { supabase.removeChannel(_walletChannel); } catch {}
  }
  _walletChannel = supabase
    .channel(`wallet-${userId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'wallets', filter: `user_id=eq.${userId}` },
      (payload) => {
        // Codex P2 — stale-user guard. supabase.removeChannel isn't
        // awaited inside teardownWallet (and even when it is, late
        // UPDATEs can still land between unsubscribe + ack). Without
        // this check, a UPDATE for the PREVIOUS user could land in
        // module state after sign-out and briefly show their balance
        // to the next user who signs in.
        const current = _cfg.getCurrentUser();
        if (!current || current.id !== userId) return;
        _wallet = { coin_balance: payload.new.coin_balance, star_balance: payload.new.star_balance };
        _notifyWalletChange();
      },
    )
    .subscribe();

  _notifyWalletChange();
}

/**
 * Tear down realtime + listeners. Called from app.js sign-out BEFORE
 * resetWalletState so any in-flight realtime callback can't write to
 * state we're about to clear. Mirror of Stage 1's teardownNotifications.
 *
 * Removes the video monet timeupdate listener too. Per Codex P1, we
 * store the player ref inside _videoMonetGate so this teardown can
 * clean up properly without the caller having to remember the
 * player element.
 */
export function teardownWallet() {
  if (_walletChannel) {
    try { supabase.removeChannel(_walletChannel); } catch {}
    _walletChannel = null;
  }
  // Delegate video monet teardown to teardownVideoMonetGate() rather
  // than inlining the removeEventListener — the helper also bumps
  // _videoMonetSetupSeq, which invalidates any in-flight
  // setupVideoMonetGate() awaiting video_progress. Without the seq
  // bump, sign-out during an active gate setup could resume after
  // teardownWallet() and re-attach a stale `timeupdate` listener
  // (Codex Round 6, P1).
  teardownVideoMonetGate();
}

/**
 * Clear in-memory wallet state. Called after teardownWallet from sign-out.
 * Subscribers are intentionally KEPT — they were registered at boot and
 * are independent of session.
 *
 * Notifies subscribers after clearing so the topbar pill + any Store
 * balance cards repaint to zero immediately (Codex P2). Without this,
 * sign-out leaves the previous user's balance numbers visible until
 * the next sign-in's loadWalletState fires.
 */
export function resetWalletState() {
  _wallet = { coin_balance: 0, star_balance: 0 };
  _userUnlocks.clear();
  // _walletConfigDefaults intentionally NOT reset — the next user's
  // loadWalletState will overwrite from app_config anyway, and the
  // defaults are useful between sign-out and next sign-in.
  _unlockInFlight = false;
  _notifyWalletChange();
}

// ════════════════════════════════════════════════════════════════════════
// READ API + topbar pill rendering
// ════════════════════════════════════════════════════════════════════════

export function getWallet() {
  return { ..._wallet };
}

/**
 * Returns the live app_config snapshot. Mutable by reference — callers
 * should treat as READ-ONLY. Reassigning a value here would silently
 * drift away from app_config on the next loadWalletState. (Codex P2 —
 * acceptable for now; future revision could return a frozen copy.)
 */
export function getWalletConfig() {
  return _walletConfigDefaults;
}

export function renderTopbarCoinPill() {
  const coinEl = document.getElementById('topbarCoinBalance');
  const starEl = document.getElementById('topbarStarBalance');
  if (coinEl) coinEl.textContent = formatBalance(_wallet.coin_balance);
  if (starEl) starEl.textContent = formatBalance(_wallet.star_balance);
}

function formatBalance(n) {
  // 1234 → "1,234"; 12345 → "12.3K"; 12345678 → "12.3M"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 10_000)    return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

// ════════════════════════════════════════════════════════════════════════
// UNLOCK STATE — normalize, mark, lookup, cost resolve
// ════════════════════════════════════════════════════════════════════════

// Codex bug #192 (2026-05-16): videos can carry either a bare Supabase
// UUID or an 'sb_<uuid>' prefixed id depending on call path. playVideo
// uses the prefixed form for the player but strips down to the bare
// UUID before calling isUnlocked / unlock_content. Storing one shape
// and looking up the other → isUnlocked returns false after a
// successful unlock and the paywall re-shows. Everything is
// normalized to the bare server id here.
function normalizeUnlockTargetId(targetType, targetId) {
  const id = String(targetId || '');
  if (targetType === 'video' && id.startsWith('sb_')) return id.slice(3);
  return id;
}

export function markUnlocked(targetType, targetId) {
  const normalized = normalizeUnlockTargetId(targetType, targetId);
  _userUnlocks.add(`${targetType}:${normalized}`);
}

export function isUnlocked(targetType, targetId) {
  const normalized = normalizeUnlockTargetId(targetType, targetId);
  return _userUnlocks.has(`${targetType}:${normalized}`);
}

// Per-row override → app_config default. row is the rendering row
// (chapter or video) which MAY carry unlock_cost_coins/_stars columns.
export function resolveUnlockCost(targetType, currency, row) {
  const colCoins = row?.unlock_cost_coins;
  const colStars = row?.unlock_cost_stars;
  if (currency === 'coin') {
    if (Number.isFinite(colCoins) && colCoins > 0) return colCoins;
    return _walletConfigDefaults[targetType === 'video' ? 'default_video_unlock_coins' : 'default_chapter_unlock_coins'];
  } else {
    if (Number.isFinite(colStars) && colStars > 0) return colStars;
    return _walletConfigDefaults[targetType === 'video' ? 'default_video_unlock_stars' : 'default_chapter_unlock_stars'];
  }
}

// ════════════════════════════════════════════════════════════════════════
// UNLOCK ERROR INTERPRETATION + RECOVERY
// ════════════════════════════════════════════════════════════════════════
//
// Single source of truth for unlock error code → user-facing copy.
// Mirrors mobile's lib/unlock-error-codes.js — keep both sides in
// sync. When a new error code lands anywhere in the unlock stack, add
// a row here AND in mobile.
//
// Each entry: { title, message, recoverable, kind }
//   recoverable — true if the user can fix it (retry, top up, contact support)
//   kind        — 'coin' | 'star' | 'account' (drives the support-ticket form)
const _UNLOCK_ERROR_REGISTRY = {
  not_authenticated:      { title: 'Reconnecting your account',     message: "We're still connecting your account. Please try again in a moment — if the problem keeps happening, sign out and sign back in.", recoverable: true,  kind: 'account' },
  insufficient_balance:   { title: 'Not enough balance',            message: "You don't have enough to unlock this. Top up in the Store and try again.", recoverable: true,  kind: 'coin' },
  insufficient_coins:     { title: 'Not enough coins',              message: "You don't have enough coins to unlock this. Top up in the Store and try again.", recoverable: true,  kind: 'coin' },
  insufficient_stars:     { title: 'Not enough stars',              message: "You don't have enough stars to unlock this. Earn more from the Goals tab or top up in the Store, then try again.", recoverable: true,  kind: 'coin' },
  wallet_missing:         { title: 'Setting up your wallet',        message: "We're finalizing your wallet. Please try again in a few seconds. If the issue persists, we'll restore it manually within 24 hours.", recoverable: true,  kind: 'coin' },
  cost_unresolved:        { title: 'Pricing temporarily unavailable', message: "We couldn't load the unlock price. Please refresh the screen and try again.", recoverable: true,  kind: 'coin' },
  invalid_cost:           { title: 'Pricing missing for this chapter', message: "The author hasn't set a price for this chapter yet. Try a different chapter or contact support and we'll fix it within 24 hours.", recoverable: true,  kind: 'coin' },
  invalid_book_cost:      { title: 'Bulk pricing missing',          message: "The author hasn't set a whole-book price yet. You can still unlock individual chapters, or contact support and we'll resolve it within 24 hours.", recoverable: true,  kind: 'coin' },
  invalid_currency:       { title: 'Unlock unavailable',            message: 'Something went wrong with the payment type. Please refresh and try again.', recoverable: true,  kind: 'coin' },
  invalid_target_type:    { title: 'Unlock unavailable',            message: "This item can't be unlocked right now. Please refresh and try again.", recoverable: false, kind: 'coin' },
  invalid_target_id:      { title: 'Item not found',                message: "We couldn't find this chapter or book. It may have been removed by the author.", recoverable: false, kind: 'coin' },
  book_not_found:         { title: 'Book not found',                message: "We couldn't find this book. It may have been removed.", recoverable: false, kind: 'coin' },
  no_locks_on_book:       { title: 'Already free to read',          message: "This book doesn't have any locked chapters — you can start reading right away.", recoverable: false, kind: 'coin' },
  kyc_not_approved:       { title: 'Verify your account first',     message: 'Please complete your Payment Info before unlocking content.', recoverable: true,  kind: 'account' },
  kyc_required:           { title: 'Verify your account first',     message: 'Please complete your Payment Info before unlocking content.', recoverable: true,  kind: 'account' },
  network:                { title: 'Connection issue',              message: "We couldn't reach our servers. Check your connection and try again.", recoverable: true,  kind: 'coin' },
  rate_limited:           { title: 'Slow down a moment',            message: "You're going a little fast. Please wait a few seconds and try again.", recoverable: true,  kind: 'coin' },
  cannot_resolve_chapter: { title: 'Chapter not ready',             message: "This chapter isn't fully synced yet. Please refresh the book and try again.", recoverable: true,  kind: 'coin' },
  cannot_resolve_book:    { title: 'Book not ready',                message: "This book isn't fully synced yet. Please refresh and try again.", recoverable: true,  kind: 'coin' },
};

function _interpretUnlockError(input, ctx = {}) {
  const rawCode = (() => {
    if (!input) return 'unknown';
    if (typeof input === 'string') return input;
    if (typeof input === 'object') {
      if (typeof input.error === 'string') return input.error;
      if (typeof input.message === 'string') {
        const m = input.message.toLowerCase();
        if (m.includes('cannot resolve chapter')) return 'cannot_resolve_chapter';
        if (m.includes('cannot resolve book'))    return 'cannot_resolve_book';
        if (m.includes('network') || m.includes('fetch')) return 'network';
        if (m.includes('not signed in') || m.includes('not authenticated')) return 'not_authenticated';
        return input.message;
      }
    }
    return String(input);
  })();
  let lookupCode = rawCode;
  if (rawCode === 'insufficient_balance') {
    const cur = ctx.currency || input?.currency;
    if (cur === 'coin' || cur === 'coins') lookupCode = 'insufficient_coins';
    else if (cur === 'star' || cur === 'stars') lookupCode = 'insufficient_stars';
  }
  const entry = _UNLOCK_ERROR_REGISTRY[lookupCode];
  if (!entry) {
    console.warn('[unlock] unmapped error code', rawCode, ctx);
    return { title: 'Unlock failed', message: "We couldn't complete the unlock. Please try again.", recoverable: true, kind: 'coin', rawCode };
  }
  return { ...entry, rawCode };
}

async function _submitUnlockRecoveryRequest({ kind, amount, reason, context }) {
  try {
    const me = _cfg.getCurrentUser();
    const { error } = await supabase.rpc('submit_balance_recovery_request', {
      p_kind: kind,
      p_reported_amount: kind === 'account' ? 1 : Math.max(1, Math.round(Number(amount) || 1)),
      p_reason: reason || null,
      p_context: context || {},
      p_actor_id: me?.id || null,
    });
    if (error) console.warn('[unlock] auto-file recovery failed:', error.message);
  } catch (e) {
    console.warn('[unlock] auto-file recovery exception:', e?.message || e);
  }
}

function _handleUnlockFailure(errorOrResult, context) {
  const ui = _interpretUnlockError(errorOrResult, context);
  toast(ui.message, 'error');
  console.error('[unlock] failure:', { code: ui.rawCode, ...context });
  const shouldFile = ui.recoverable
    && ui.rawCode !== 'insufficient_balance'
    && ui.rawCode !== 'insufficient_coins'
    && ui.rawCode !== 'insufficient_stars'
    && ui.rawCode !== 'no_locks_on_book';
  const me = _cfg.getCurrentUser();
  if (shouldFile && me?.id) {
    _submitUnlockRecoveryRequest({
      kind: ui.kind === 'account' ? 'account' : (context?.currency === 'star' ? 'star' : 'coin'),
      amount: context?.cost || 1,
      reason: [
        `Unlock failed: ${ui.rawCode}`,
        context?.target_type && context?.target_id ? `Target: ${context.target_type}/${context.target_id}` : null,
        context?.currency ? `Currency: ${context.currency}` : null,
        typeof context?.balance_at_attempt === 'number' ? `Balance at attempt: ${context.balance_at_attempt}` : null,
      ].filter(Boolean).join('\n'),
      context: { source: 'web_unlock', ...context },
    });
  }
}

async function _verifyBulkUnlockPersistence(bookId, expectedUnlocksCount) {
  try {
    const me = _cfg.getCurrentUser();
    if (!me?.id) return;
    const { data: bookRow } = await supabase
      .from('books').select('id').eq('id', bookId).maybeSingle();
    if (!bookRow) return;
    const { data: chapters } = await supabase
      .from('chapters').select('id').eq('book_id', bookId);
    const chapterIds = (chapters || []).map((c) => c.id);
    if (chapterIds.length === 0) return;
    const { data: unlockRows } = await supabase
      .from('unlocks')
      .select('target_id')
      .eq('user_id', me.id)
      .eq('target_type', 'chapter')
      .in('target_id', chapterIds);
    const persisted = (unlockRows || []).length;
    if (persisted < expectedUnlocksCount) {
      console.warn(
        `[unlock-bulk] PERSISTENCE-MISMATCH book=${bookId}: server said ${expectedUnlocksCount} chapters unlocked, but only ${persisted} unlock rows are visible to the client. Real-money bug — investigate.`,
        { user_id: me.id, bookId, expected: expectedUnlocksCount, persisted },
      );
    }
  } catch (e) {
    console.warn('[unlock-bulk] verify exception:', e?.message || e);
  }
}

async function _previewBookBulkUnlock(bookId) {
  try {
    const [coinRes, starRes] = await Promise.all([
      supabase.rpc('preview_book_bulk_unlock', { p_book_id: bookId, p_currency: 'coin' }),
      supabase.rpc('preview_book_bulk_unlock', { p_book_id: bookId, p_currency: 'star' }),
    ]);
    if (coinRes.error || starRes.error) {
      console.warn('[bulk-preview] RPC failed; falling back to client estimate',
        coinRes.error?.message, starRes.error?.message);
      return null;
    }
    const coin = coinRes.data?.total_after ?? coinRes.data?.cost ?? null;
    const star = starRes.data?.total_after ?? starRes.data?.cost ?? null;
    if (coin == null || star == null) {
      console.warn('[bulk-preview] RPC returned no total; falling back to client estimate', coinRes.data, starRes.data);
      return null;
    }
    return { coin, star };
  } catch (e) {
    console.warn('[bulk-preview] exception; falling back to client estimate', e);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// UNLOCK DIALOG — single content (chapter / video)
// ════════════════════════════════════════════════════════════════════════
//
// Premium two-button modal (coin OR star). Insufficient balance
// disables the button + shows current balance as hint. On success,
// updates _wallet, adds to _userUnlocks, fires onUnlocked() so the
// caller can re-render.
//
// _unlockInFlight gate: disables BOTH buttons + the close button while
// any unlock RPC is mid-network. Closes the "tap-coin-then-tap-star
// within 50ms → two parallel RPCs" exposure.

export function openUnlockDialog({ targetType, targetId, row, title, onUnlocked }) {
  const costCoins = resolveUnlockCost(targetType, 'coin', row);
  const costStars = resolveUnlockCost(targetType, 'star', row);
  const canCoin = _wallet.coin_balance >= costCoins;
  const canStar = _wallet.star_balance >= costStars;

  document.querySelector('.unlock-modal-backdrop')?.remove();
  const modal = document.createElement('div');
  modal.className = 'unlock-modal-backdrop';
  modal.innerHTML = `
    <div class="unlock-modal" role="dialog" aria-modal="true">
      <button class="unlock-modal-close" aria-label="Close">×</button>
      <div class="unlock-modal-icon">🔒</div>
      <h2>Unlock this ${targetType}</h2>
      ${title ? `<p class="unlock-modal-title">${escHTML(title)}</p>` : ''}
      <p class="unlock-modal-sub">Pay once and read/watch as many times as you like.</p>
      <div class="unlock-options">
        <button class="unlock-option unlock-option-coin ${canCoin ? '' : 'is-disabled'}" data-cur="coin" ${canCoin ? '' : 'disabled'}>
          <span class="unlock-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3" fill="#fbbf24" stroke="#b45309" stroke-width="1"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" fill="#fde68a" stroke="#b45309" stroke-width="1"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" fill="#fbbf24" stroke="#b45309" stroke-width="1"/></svg>
          </span>
          <span class="unlock-option-cost">${costCoins}</span>
          <span class="unlock-option-label">Coin${costCoins === 1 ? '' : 's'}</span>
          <span class="unlock-option-hint">${canCoin ? 'Tap to unlock' : `You have ${_wallet.coin_balance}`}</span>
        </button>
        <div class="unlock-or">or</div>
        <button class="unlock-option unlock-option-star ${canStar ? '' : 'is-disabled'}" data-cur="star" ${canStar ? '' : 'disabled'}>
          <span class="unlock-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 2l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16l-5.6 3.2 1.5-6.3L3 8.7l6.4-.5z" fill="#a855f7"/></svg>
          </span>
          <span class="unlock-option-cost">${costStars}</span>
          <span class="unlock-option-label">Star${costStars === 1 ? '' : 's'}</span>
          <span class="unlock-option-hint">${canStar ? 'Tap to unlock' : `You have ${_wallet.star_balance}`}</span>
        </button>
      </div>
      ${(!canCoin && !canStar) ? '<p class="unlock-need-more">Not enough coins or stars yet. Open the Store to top up, or watch ads to earn stars.</p>' : ''}
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('open'));

  const close = () => {
    if (_unlockInFlight) return;
    modal.classList.remove('open');
    setTimeout(() => modal.remove(), 180);
  };
  modal.querySelector('.unlock-modal-close').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelectorAll('.unlock-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      if (_unlockInFlight) return;
      const currency = btn.dataset.cur;
      btn.classList.add('is-loading');
      modal.querySelectorAll('.unlock-option').forEach((b) => { b.disabled = true; });
      _unlockInFlight = true;
      let data = null, error = null;
      try {
        const res = await supabase.rpc('unlock_content', {
          p_target_type: targetType,
          p_target_id:   targetId,
          p_currency:    currency,
        });
        data = res.data; error = res.error;
      } finally {
        _unlockInFlight = false;
        btn.classList.remove('is-loading');
      }
      if (error) {
        modal.querySelectorAll('.unlock-option').forEach((b) => { if (!b.classList.contains('is-disabled')) b.disabled = false; });
        _handleUnlockFailure(error, {
          target_type: targetType,
          target_id: targetId,
          currency,
          balance_at_attempt: currency === 'coin' ? _wallet.coin_balance : _wallet.star_balance,
        });
        return;
      }
      if (!data?.ok) {
        modal.querySelectorAll('.unlock-option').forEach((b) => { if (!b.classList.contains('is-disabled')) b.disabled = false; });
        _handleUnlockFailure(data, {
          target_type: targetType,
          target_id: targetId,
          currency,
          balance_at_attempt: currency === 'coin' ? _wallet.coin_balance : _wallet.star_balance,
        });
        return;
      }
      // Codex P0 — guard against ok:true responses that don't include
      // balance_after (server returns these when the user already owned
      // the unlock — already_unlocked path). Without this guard we'd
      // set _wallet.X = undefined, then formatBalance(undefined) crashes
      // the topbar pill render.
      const alreadyUnlocked = data.already_unlocked === true;
      if (!alreadyUnlocked) {
        if (!Number.isFinite(data.balance_after)) {
          // Unexpected: server reported success but no balance number.
          // Resync from server so we don't trust local optimistic state.
          await loadWalletState();
          toast('Unlocked, but wallet sync needed. Refreshing balance…', 'success');
          markUnlocked(targetType, targetId);
          close();
          if (typeof onUnlocked === 'function') onUnlocked();
          return;
        }
        if (currency === 'coin') _wallet.coin_balance = data.balance_after;
        else                     _wallet.star_balance = data.balance_after;
      }
      markUnlocked(targetType, targetId);
      _notifyWalletChange();
      close();
      toast(alreadyUnlocked ? 'Already unlocked' : `Unlocked! −${data.cost} ${currency}${data.cost === 1 ? '' : 's'}`, 'success');
      if (!alreadyUnlocked) {
        try { _cfg.tickGoalUnique('unlock', `unlock:${targetType}:${targetId}`); } catch {}
      }
      if (typeof onUnlocked === 'function') onUnlocked();
    });
  });
}

// ════════════════════════════════════════════════════════════════════════
// VIDEO MONETIZATION GATE (Phase 6 — time-based paywall)
// ════════════════════════════════════════════════════════════════════════
//
// Attaches a `timeupdate` listener. Crossing the next paid threshold
// (180s initial, then 600s recurring) pauses-on-cancel and prompts:
// "1 coin forever, or 1 star for the next 10 min." Coin path → permanent
// unlock + nextThreshold=Infinity. Star path → bump nextThreshold by
// recurring_window. Re-watching below paid_through_seconds is free.

export async function setupVideoMonetGate(player, sbId, video) {
  // Codex P0 (round 4) — order matters: teardown FIRST (which bumps
  // the seq itself, invalidating any older setup that's still awaiting),
  // THEN capture our own seq for this fresh call. The previous order
  // (bump → teardown → bump) meant every call bailed immediately
  // because teardown's bump made our captured seq stale before the
  // await even started.
  teardownVideoMonetGate(player);
  const seq = ++_videoMonetSetupSeq;

  const initialSec   = _walletConfigDefaults.video_initial_unlock_seconds   || 180;
  const recurringSec = _walletConfigDefaults.video_recurring_unlock_seconds || 600;

  // Legacy aw_/sb_ ids don't have a UUID, so they're not in video_progress
  // (which FKs to videos). Fall back to "no prior progress" — every
  // threshold is fresh.
  let paidThrough = 0;
  const isLegacy = sbId.startsWith('aw_') || sbId.startsWith('sb_');
  const me = _cfg.getCurrentUser();
  if (!isLegacy && me) {
    const { data: prog } = await supabase
      .from('video_progress')
      .select('paid_through_seconds')
      .eq('user_id', me.id)
      .eq('video_id', sbId)
      .maybeSingle();
    paidThrough = prog?.paid_through_seconds || 0;
  }

  // Stale-call guard. If the user switched videos (or signed out) while
  // we were awaiting video_progress, a newer setupVideoMonetGate has
  // already run and our continuation here is stale — bail.
  if (seq !== _videoMonetSetupSeq) return;

  // nextThreshold = the wallclock-seconds position at which the listener
  // should next prompt the user to pay. On fresh load: if the user has
  // no prior payment, that's the initial free-window boundary; if they
  // do, it's one second past the end of their paid window (the moment
  // their granted access expires). We used to derive this with a
  // computeNext() that walked the canonical 180/780/1380/... boundary
  // schedule, but that schedule misaligns with windows granted from a
  // scrubbed-forward promptAt (see bug fix below), so we just use
  // paidThrough + 1 directly.
  let nextThreshold = paidThrough > 0 ? paidThrough + 1 : initialSec;
  let modalOpen = false;

  const listener = () => {
    if (!_videoMonetGate || _videoMonetGate.videoId !== sbId) return;
    if (modalOpen) return;
    if (player.currentTime < nextThreshold) return;

    // The threshold we prompt for is ALWAYS the next sequential gate,
    // never the user's scrub position.
    //
    // Bug report 2026-05-17 round 2: an earlier fix (b542b53) snapped
    // promptAt to max(nextThreshold, currentTime) so the star window
    // would cover where the user scrubbed to. That eliminated the
    // duplicate-paywall symptom but broke the product semantics: a
    // user could scrub to 60min and pay 1 star to unlock that segment,
    // bypassing the 3→13, 13→23, 23→33, … sequential gates they were
    // supposed to pay through.
    //
    // Correct design: 1 star = the NEXT sequential 10-min segment only.
    // If the user scrubbed past their paid range, we still prompt for
    // the next sequential threshold; on success, we seek the player
    // BACK to the start of the just-unlocked segment so they consume
    // what they paid for. To watch a later segment they must pay for
    // every segment in between (or use 1 coin = permanent unlock).
    const promptedThreshold = nextThreshold;

    modalOpen = true;
    openVideoMonetThresholdDialog({
      videoTitle: video.title,
      videoId:    sbId,
      threshold:  promptedThreshold,
      onSuccess: (result) => {
        modalOpen = false;
        if (result.mode === 'permanent') {
          markUnlocked('video', sbId);
          nextThreshold = Infinity;
        } else if (result.mode === 'window') {
          // Codex P1 — prefer server's paid_through_seconds when it
          // comes back (e.g. already_paid_for_threshold path). Without
          // this, the client estimate could disagree with the server
          // and either over-charge (re-prompt before server's window
          // is up) or under-charge (skip a prompt the server expects).
          paidThrough = Number.isFinite(result.paidThroughSeconds)
            ? result.paidThroughSeconds
            : promptedThreshold + recurringSec - 1;
          // Re-prompt the moment the paid window expires. paidThrough+1
          // is the start of the next sequential gate; for a 10-min
          // window that's promptedThreshold + recurringSec, matching
          // the legacy boundary schedule.
          nextThreshold = paidThrough + 1;
          // Sequential enforcement (the seek-back). If the user
          // scrubbed past the segment they just paid for, currentTime
          // is still in the locked range and the listener would
          // re-fire immediately on the next timeupdate — effectively
          // letting them watch past their paid range by tapping the
          // second paywall closed. Move them BACK to the start of the
          // segment they actually paid for so they consume the
          // 10 minutes they bought (and the next paywall fires at the
          // correct sequential gate, not the scrubbed position).
          if (player.currentTime > paidThrough) {
            try {
              player.currentTime = Math.max(0, promptedThreshold);
            } catch {}
          }
        }
        _notifyWalletChange();
        // Defensive resume. The browser pauses for any seek (including
        // the seek-back above, or the user's original scrub-seek that
        // brought them past nextThreshold in the first place). The
        // modal-backdrop blocked them from pressing play. Kick
        // playback back on. Wrapped in try/catch because autoplay
        // blockers may reject the promise silently if the browser
        // doesn't recognize this as a user-gesture chain.
        try {
          const playPromise = player.play();
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => {});
          }
        } catch {}
      },
      onCancel: () => {
        // Pause so the user has to re-engage; on next play, listener
        // re-fires and re-prompts. Keep modalOpen=true while paused —
        // listener can't fire anyway, and clearing it synchronously
        // before pause settles causes "N taps to dismiss" bug
        // (2026-05-16: scrub-forward over 15 min → 2 taps to close).
        try { player.pause(); } catch {}
        player.addEventListener('play', () => { modalOpen = false; }, { once: true });
      },
    });
  };

  player.addEventListener('timeupdate', listener);
  _videoMonetGate = { videoId: sbId, listener, player, seq };
}

export function teardownVideoMonetGate(player) {
  // Bump the setup token so any in-flight setupVideoMonetGate call
  // bails when its await resolves. Otherwise an explicit teardown
  // followed by the older setup's continuation would re-attach a
  // listener that we just tried to clear (Codex P1).
  _videoMonetSetupSeq++;
  // Prefer the stored player ref (set by setupVideoMonetGate) — that way
  // callers who pass a stale element or null still get a clean teardown.
  // Falls back to the caller's player if for some reason we don't have
  // one in the registry.
  const target = _videoMonetGate?.player || player;
  if (_videoMonetGate?.listener && target) {
    try { target.removeEventListener('timeupdate', _videoMonetGate.listener); } catch {}
  }
  _videoMonetGate = null;
}

// Threshold-crossing dialog — visually distinct from openUnlockDialog
// because the choice has different consequences (one-time forever vs
// pay-as-you-go window). NOT exported — only setupVideoMonetGate's
// listener uses it.
function openVideoMonetThresholdDialog({ videoTitle, videoId, threshold, onSuccess, onCancel }) {
  const coinCost = _walletConfigDefaults.default_video_unlock_coins || 1;
  const starCost = _walletConfigDefaults.default_video_unlock_stars || 1;
  const canCoin = _wallet.coin_balance >= coinCost;
  const canStar = _wallet.star_balance >= starCost;
  const recurringMin = Math.round((_walletConfigDefaults.video_recurring_unlock_seconds || 600) / 60);

  document.querySelector('.unlock-modal-backdrop')?.remove();
  const modal = document.createElement('div');
  modal.className = 'unlock-modal-backdrop video-monet-backdrop';
  modal.innerHTML = `
    <div class="unlock-modal video-monet-modal" role="dialog" aria-modal="true">
      <button class="unlock-modal-close" aria-label="Close">×</button>
      <div class="video-monet-icon-wrap">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </div>
      <h2>Keep watching</h2>
      ${videoTitle ? `<p class="unlock-modal-title">${escHTML(videoTitle)}</p>` : ''}
      <p class="unlock-modal-sub">First ${Math.floor(threshold / 60)} minutes done — pick how to continue:</p>
      <div class="video-monet-options">
        <button class="video-monet-option video-monet-option-coin ${canCoin ? '' : 'is-disabled'}" data-cur="coin" ${canCoin ? '' : 'disabled'}>
          <div class="video-monet-option-icon">
            <svg viewBox="0 0 24 24" width="28" height="28"><ellipse cx="12" cy="6" rx="8" ry="3" fill="#fbbf24" stroke="#b45309" stroke-width="1"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" fill="#fde68a" stroke="#b45309" stroke-width="1"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" fill="#fbbf24" stroke="#b45309" stroke-width="1"/></svg>
          </div>
          <div class="video-monet-option-cost">${coinCost} <small>coin${coinCost === 1 ? '' : 's'}</small></div>
          <div class="video-monet-option-mode">Forever</div>
        </button>
        <button class="video-monet-option video-monet-option-star ${canStar ? '' : 'is-disabled'}" data-cur="star" ${canStar ? '' : 'disabled'}>
          <div class="video-monet-option-icon">
            <svg viewBox="0 0 24 24" width="28" height="28"><path d="M12 2l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16l-5.6 3.2 1.5-6.3L3 8.7l6.4-.5z" fill="#a855f7"/></svg>
          </div>
          <div class="video-monet-option-cost">${starCost} <small>star${starCost === 1 ? '' : 's'}</small></div>
          <div class="video-monet-option-mode">${recurringMin}-min window</div>
        </button>
      </div>
      ${(!canCoin && !canStar) ? '<p class="unlock-need-more">Out of coins and stars. Top up in the Store.</p>' : `
        <div class="video-monet-countdown" id="vmCountdown">
          <span class="video-monet-countdown-bar"><span class="video-monet-countdown-fill" id="vmCountdownFill"></span></span>
          <span class="video-monet-countdown-text">Auto-paying with <strong>${coinCost} coin</strong> in <span id="vmCountdownNum">5</span>s · tap to choose differently</span>
        </div>`}
    </div>
  `;
  // Scope the monet paywall to the video player wrap, not the whole page.
  // Fix #196: mount inside .video-player-wrap so it doesn't inherit the
  // backdrop's `position: fixed; inset: 0` and cover the entire screen.
  const monetParent = document.querySelector('#videoPlayerPage .video-player-wrap') || document.body;
  monetParent.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('open'));

  let countdownTimer = null;
  let countdownInterval = null;
  const cancelCountdown = () => {
    if (countdownTimer)    { clearTimeout(countdownTimer);    countdownTimer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    const cd = modal.querySelector('#vmCountdown');
    if (cd) cd.classList.add('is-cancelled');
  };

  // Codex P1 — block close while an unlock RPC is in flight. Otherwise
  // a user could tap a currency, then immediately close the modal; the
  // RPC still completes and charges them after they thought they
  // cancelled. localInFlight is set inside tryUnlock below.
  const close = (cancelled) => {
    if (localInFlight) return;
    cancelCountdown();
    modal.classList.remove('open');
    setTimeout(() => modal.remove(), 180);
    if (cancelled && typeof onCancel === 'function') onCancel();
  };
  modal.querySelector('.unlock-modal-close').onclick = () => close(true);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(true); });

  // Local in-flight guard (Codex P2). The shared _unlockInFlight is
  // used by openUnlockDialog + openBulkBookUnlockDialog; the threshold
  // dialog has its own modal lifecycle (auto-countdown + cancel) so a
  // local flag is cleaner than sharing the module flag. Blocks the
  // double-tap and the auto-countdown firing on top of a manual tap.
  let localInFlight = false;

  const tryUnlock = async (currency, btn) => {
    if (btn?.disabled) return false;
    if (localInFlight) return false;
    cancelCountdown();
    localInFlight = true;
    if (btn) btn.classList.add('is-loading');
    // Disable BOTH currency buttons while the first one is in flight.
    modal.querySelectorAll('.video-monet-option').forEach((b) => { b.disabled = true; });
    let data, error;
    try {
      const res = await supabase.rpc('unlock_video_threshold', {
        p_video_id:          videoId,
        p_currency:          currency,
        p_threshold_seconds: threshold,
      });
      data = res.data; error = res.error;
    } finally {
      localInFlight = false;
      if (btn) btn.classList.remove('is-loading');
    }
    if (error) {
      // Re-enable sibling buttons so the user can retry.
      modal.querySelectorAll('.video-monet-option').forEach((b) => { if (!b.classList.contains('is-disabled')) b.disabled = false; });
      toast(error.message, 'error');
      return false;
    }
    if (!data?.ok) {
      modal.querySelectorAll('.video-monet-option').forEach((b) => { if (!b.classList.contains('is-disabled')) b.disabled = false; });
      toast(data?.error === 'insufficient_balance' ? 'Insufficient balance' : (data?.error || 'Unlock failed'), 'error');
      return false;
    }
    // Codex P0 — handle ok:true responses that don't include
    // balance_after. unlock_video_threshold can return success without
    // a charge when the user already paid for this threshold/window
    // (already_permanent or already_paid_for_threshold flag).
    const noChargePath = data.already_permanent === true || data.already_paid_for_threshold === true;
    if (!noChargePath) {
      if (!Number.isFinite(data.balance_after)) {
        await loadWalletState();
        toast('Continuing… wallet sync needed.', 'success');
        close(false);
        // Same mode-derivation as success path below — see comment there.
        const fallbackMode = data.already_permanent
          ? 'permanent'
          : data.already_paid_for_threshold
            ? 'window'
            : (data.mode || (currency === 'coin' ? 'permanent' : 'window'));
        onSuccess({ mode: fallbackMode, paidThroughSeconds: data.paid_through_seconds });
        return true;
      }
      if (currency === 'coin') _wallet.coin_balance = data.balance_after;
      else                     _wallet.star_balance = data.balance_after;
    }
    _notifyWalletChange();
    close(false);
    toast(
      noChargePath
        ? 'Continuing — already paid for this segment'
        : (data.mode === 'permanent' ? `Unlocked forever! −${data.cost} coin` : `Continuing ${recurringMin} more min · −${data.cost} star`),
      'success',
    );
    // Codex P1 — derive mode from server flags FIRST. The previous
    // fallback `currency === 'coin' ? 'permanent' : 'window'` could
    // grant the wrong mode on no-charge responses (e.g. server says
    // already_paid_for_threshold but user tapped coin → local code
    // would incorrectly mark as 'permanent'). Server's already_X
    // flags are the source of truth; falling back to data.mode +
    // currency only when neither flag is set.
    const resultMode = data.already_permanent
      ? 'permanent'
      : data.already_paid_for_threshold
        ? 'window'
        : (data.mode || (currency === 'coin' ? 'permanent' : 'window'));
    onSuccess({ mode: resultMode, paidThroughSeconds: data.paid_through_seconds });
    return true;
  };

  modal.querySelectorAll('.video-monet-option').forEach((btn) => {
    btn.addEventListener('click', () => tryUnlock(btn.dataset.cur, btn));
  });

  if (canCoin) {
    let secsLeft = 5;
    const fill = modal.querySelector('#vmCountdownFill');
    const num  = modal.querySelector('#vmCountdownNum');
    if (fill) fill.style.width = '0%';
    requestAnimationFrame(() => { if (fill) fill.style.width = '100%'; });
    countdownInterval = setInterval(() => {
      secsLeft--;
      if (num) num.textContent = secsLeft;
      if (secsLeft <= 0) clearInterval(countdownInterval);
    }, 1000);
    countdownTimer = setTimeout(() => {
      tryUnlock('coin', modal.querySelector('.video-monet-option-coin'));
    }, 5000);
  }
}

// ════════════════════════════════════════════════════════════════════════
// BULK BOOK UNLOCK DIALOG (Phase 6)
// ════════════════════════════════════════════════════════════════════════
//
// Whole-book unlock. Re-renders prices from server-authoritative
// preview_book_bulk_unlock RPC after open so the user can't see one
// price and get charged another. After success, refreshes the unlocks
// set from server (cheaper than refetching the whole wallet) and runs
// _verifyBulkUnlockPersistence as a fire-and-forget telemetry check.

export function openBulkBookUnlockDialog({ bookId, bookTitle, lockedCount, coinCost, starCost, discountPct, onUnlocked }) {
  const canCoin = _wallet.coin_balance >= coinCost;
  const canStar = _wallet.star_balance >= starCost;

  document.querySelector('.unlock-modal-backdrop')?.remove();
  const modal = document.createElement('div');
  modal.className = 'unlock-modal-backdrop';
  modal.innerHTML = `
    <div class="unlock-modal" role="dialog" aria-modal="true">
      <button class="unlock-modal-close" aria-label="Close">×</button>
      <div class="unlock-modal-icon">📚</div>
      <h2>Unlock the whole book</h2>
      <p class="unlock-modal-title">${escHTML(bookTitle)}</p>
      <p class="unlock-modal-sub">${lockedCount} locked chapter${lockedCount === 1 ? '' : 's'} · ${discountPct}% off vs unlocking individually</p>
      <div class="unlock-options">
        <button class="unlock-option unlock-option-coin ${canCoin ? '' : 'is-disabled'}" data-cur="coin" ${canCoin ? '' : 'disabled'}>
          <span class="unlock-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3" fill="#fbbf24" stroke="#b45309" stroke-width="1"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" fill="#fde68a" stroke="#b45309" stroke-width="1"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" fill="#fbbf24" stroke="#b45309" stroke-width="1"/></svg>
          </span>
          <span class="unlock-option-cost">${coinCost}</span>
          <span class="unlock-option-label">Coin${coinCost === 1 ? '' : 's'}</span>
          <span class="unlock-option-hint">${canCoin ? `Unlock all ${lockedCount} part${lockedCount === 1 ? '' : 's'}` : `You have ${_wallet.coin_balance}`}</span>
        </button>
        <div class="unlock-or">or</div>
        <button class="unlock-option unlock-option-star ${canStar ? '' : 'is-disabled'}" data-cur="star" ${canStar ? '' : 'disabled'}>
          <span class="unlock-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 2l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16l-5.6 3.2 1.5-6.3L3 8.7l6.4-.5z" fill="#a855f7"/></svg>
          </span>
          <span class="unlock-option-cost">${starCost}</span>
          <span class="unlock-option-label">Star${starCost === 1 ? '' : 's'}</span>
          <span class="unlock-option-hint">${canStar ? `Unlock all ${lockedCount} part${lockedCount === 1 ? '' : 's'}` : `You have ${_wallet.star_balance}`}</span>
        </button>
      </div>
      ${(!canCoin && !canStar) ? '<p class="unlock-need-more">Not enough coins or stars yet. Open the Store to top up.</p>' : ''}
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('open'));

  // Codex P2 — actually block taps until the server price preview
  // resolves. The previous comment claimed buttons were blocked but
  // they were enabled at render time, so a fast click could submit
  // against the CLIENT-ESTIMATED price (which the server would then
  // override silently). Disable both buttons now; the preview's
  // .then() re-enables them with server-canonical pricing, or the
  // .catch() re-enables them with the client fallback.
  const initialCoinBtn = modal.querySelector('.unlock-option-coin');
  const initialStarBtn = modal.querySelector('.unlock-option-star');
  const initialCanCoin = canCoin;
  const initialCanStar = canStar;
  if (initialCoinBtn) initialCoinBtn.disabled = true;
  if (initialStarBtn) initialStarBtn.disabled = true;

  // Refresh displayed prices with server-authoritative totals BEFORE the
  // user can tap. If the preview RPC fails, client estimates we rendered
  // above stay as a graceful fallback (buttons re-enabled per original
  // affordability).
  _previewBookBulkUnlock(bookId).then((server) => {
    if (!server) {
      // Fallback path — re-enable using the original client-estimated
      // affordability so the user isn't stuck with permanently-disabled
      // buttons on a transient preview RPC failure.
      if (initialCoinBtn && initialCanCoin) initialCoinBtn.disabled = false;
      if (initialStarBtn && initialCanStar) initialStarBtn.disabled = false;
      return;
    }
    const coinEl  = modal.querySelector('.unlock-option-coin .unlock-option-cost');
    const starEl  = modal.querySelector('.unlock-option-star .unlock-option-cost');
    const coinLbl = modal.querySelector('.unlock-option-coin .unlock-option-label');
    const starLbl = modal.querySelector('.unlock-option-star .unlock-option-label');
    if (coinEl) coinEl.textContent = server.coin;
    if (starEl) starEl.textContent = server.star;
    if (coinLbl) coinLbl.textContent = `Coin${server.coin === 1 ? '' : 's'}`;
    if (starLbl) starLbl.textContent = `Star${server.star === 1 ? '' : 's'}`;
    const canCoinServer = _wallet.coin_balance >= server.coin;
    const canStarServer = _wallet.star_balance >= server.star;
    const coinBtn = modal.querySelector('.unlock-option-coin');
    const starBtn = modal.querySelector('.unlock-option-star');
    [[coinBtn, canCoinServer, _wallet.coin_balance], [starBtn, canStarServer, _wallet.star_balance]].forEach(([btn, can, bal]) => {
      if (!btn) return;
      btn.disabled = !can;
      btn.classList.toggle('is-disabled', !can);
      const hint = btn.querySelector('.unlock-option-hint');
      if (hint) hint.textContent = can
        ? `Unlock all ${lockedCount} part${lockedCount === 1 ? '' : 's'}`
        : `You have ${bal}`;
    });
    modal.dataset.coinCost = String(server.coin);
    modal.dataset.starCost = String(server.star);
  });

  const close = () => {
    if (_unlockInFlight) return;
    modal.classList.remove('open');
    setTimeout(() => modal.remove(), 180);
  };
  modal.querySelector('.unlock-modal-close').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelectorAll('.unlock-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      if (_unlockInFlight) return;
      const currency = btn.dataset.cur;
      btn.classList.add('is-loading');
      modal.querySelectorAll('.unlock-option').forEach((b) => { b.disabled = true; });
      _unlockInFlight = true;
      let data = null, error = null;
      try {
        const res = await supabase.rpc('unlock_book_bulk', {
          p_book_id:  bookId,
          p_currency: currency,
        });
        data = res.data; error = res.error;
      } finally {
        _unlockInFlight = false;
        btn.classList.remove('is-loading');
      }
      if (error) {
        modal.querySelectorAll('.unlock-option').forEach((b) => { if (!b.classList.contains('is-disabled')) b.disabled = false; });
        _handleUnlockFailure(error, {
          target_type: 'book',
          target_id: bookId,
          currency,
          balance_at_attempt: currency === 'coin' ? _wallet.coin_balance : _wallet.star_balance,
          locked_count: lockedCount,
        });
        return;
      }
      if (!data?.ok) {
        modal.querySelectorAll('.unlock-option').forEach((b) => { if (!b.classList.contains('is-disabled')) b.disabled = false; });
        _handleUnlockFailure(data, {
          target_type: 'book',
          target_id: bookId,
          currency,
          balance_at_attempt: currency === 'coin' ? _wallet.coin_balance : _wallet.star_balance,
          locked_count: lockedCount,
        });
        return;
      }
      // Codex P0 — unlock_book_bulk can return ok:true with already_unlocked
      // when the user has already paid for the entire book. No balance_after,
      // no chapters_unlocked. Don't write undefined.
      const alreadyUnlocked = data.already_unlocked === true;
      if (!alreadyUnlocked) {
        if (!Number.isFinite(data.balance_after)) {
          await loadWalletState();
          toast('Unlocked, but wallet sync needed. Refreshing balance…', 'success');
          close();
          if (typeof onUnlocked === 'function') onUnlocked();
          return;
        }
        if (currency === 'coin') _wallet.coin_balance = data.balance_after;
        else                     _wallet.star_balance = data.balance_after;
      }
      // Refresh unlocks from server (cheaper than refetching wallet).
      // Codex P1 — gate the clear on a successful fetch. Previously if
      // the SELECT failed we'd empty _userUnlocks and content the user
      // had ALREADY PAID FOR would re-lock locally.
      const me = _cfg.getCurrentUser();
      if (me?.id) {
        const { data: unlocks, error: unlocksError } = await supabase
          .from('unlocks').select('target_type, target_id').eq('user_id', me.id);
        if (!unlocksError) {
          _userUnlocks.clear();
          for (const u of (unlocks || [])) markUnlocked(u.target_type, u.target_id);
        } else {
          console.warn('[wallet] post-bulk-unlock refresh failed, keeping cached unlocks:', unlocksError.message);
        }
      }
      _notifyWalletChange();
      close();
      const saved = Number.isFinite(data.cost_before_discount) && Number.isFinite(data.cost)
        ? data.cost_before_discount - data.cost
        : 0;
      const chaptersUnlocked = data.chapters_unlocked || 0;
      toast(
        alreadyUnlocked
          ? 'Already unlocked'
          : `Unlocked ${chaptersUnlocked} chapter${chaptersUnlocked === 1 ? '' : 's'} — saved ${saved} ${currency}${saved === 1 ? '' : 's'}`,
        'success',
      );
      if (!alreadyUnlocked) {
        try { _cfg.tickGoalUnique('unlock', `unlock:book:${bookId}`); } catch {}
        if (chaptersUnlocked > 0) _verifyBulkUnlockPersistence(bookId, chaptersUnlocked);
      }
      if (typeof onUnlocked === 'function') onUnlocked();
    });
  });
}
