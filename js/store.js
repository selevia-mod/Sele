// ════════════════════════════════════════════════════════════════════════════
// store.js — Coin Shop + Wallet History (Stage 13B owner module)
// ════════════════════════════════════════════════════════════════════════════
//
// Extracted from js/app.js on 2026-05-17. Owns:
//   • Coin Shop page (showStore, pack grid render, HitPay purchase flow)
//   • Migration-from-Appwrite banner + edge-function call
//   • Rewarded-ad stub (web is mobile-only-earnings today; kept for
//     future SDK swap-in)
//   • Wallet history modal (open/close, summary, grouped list)
//   • HitPay return handler (?store=success&ref=… on cold-load)
//
// Bridges (3, injected via initStore({...}) from app.js onSignedIn):
//   • getCurrentUser  — () => currentUser, observed via getter so sign-out
//                       is seen by every internal call without re-init
//   • hideAllMainPages — UI helper from app.js (deactivates all other
//                        full-screen pages before we paint ours)
//   • setSidebarActive — UI helper from app.js (kills sidebar highlight
//                        when none of the sidebar entries are active)
//
// Direct imports (no bridge — owner modules already export these):
//   • supabase.js: supabase, toast, escHTML, callEdgeFunction
//   • wallet.js:   getWallet, loadWalletState, onWalletChange
//   • earnings.js: resolveEarningsTitles (for wallet history title lookup)
//
// Exports:
//   • initStore(config)  — call once inside onSignedIn before the cold
//                          handleStoreReturn poll fires
//   • showStore()        — navigate to the Coin Shop page (used by app.js's
//                          hash router + by inline bridge configs that
//                          route "buy more coins" CTAs)
//
// Module-load wires (run at import time — DOM is ready because index.html
// loads this as <script type="module"> which defers like DOMContentLoaded):
//   • topbarCoinPill click → showStore (moved from app.js in 13B per the
//     user's design decision)
//   • btnMigrateDismiss click → localStorage-stash dismissal
//   • btnMigrateFromAppwrite click → call edge function, refresh wallet
//   • btnWatchAd click → friendly toast (web doesn't credit ad stars)
//   • [data-history-currency] clicks → openWalletHistory
//   • btnCloseWalletHistory + modal-backdrop click → closeWalletHistory
//   • onWalletChange subscriber → renderStoreBalances if visible
//   • setTimeout(handleStoreReturn, 0) — fires on the next tick; the
//     handler itself polls for bridges-ready (up to 5s) before calling
//     showStore so a slow onSignedIn doesn't lose the post-payment
//     landing. The poll-then-bail makes the historical 800ms safety
//     buffer redundant (Codex Round 2 P2).

import { supabase, toast, escHTML, callEdgeFunction } from './supabase.js';
import { getWallet, loadWalletState, onWalletChange } from './wallet.js';
import { resolveEarningsTitles } from './earnings.js';

// ─── Module-private state ──────────────────────────────────────────────────

// Bridges injected by initStore. Default no-op closures so any pre-init
// call (e.g. the cold handleStoreReturn poll) at worst no-ops instead of
// ReferenceError-ing. Real values land when app.js calls initStore.
let _cfg = {
  getCurrentUser:    () => null,
  hideAllMainPages:  () => {},
  setSidebarActive:  () => {},
};

// Flag set by initStore. handleStoreReturn polls this so it can wait
// for the app shell to wire its bridges before calling showStore (which
// needs hideAllMainPages + setSidebarActive). See plan H2.
let _bridgesReady = false;

// DOM ref captured at module load. Safe because the index.html script
// tag is `type="module"` (defers like DOMContentLoaded). Module-private
// rather than bridged because DOM refs don't need to cross modules —
// this is just an optimization to avoid re-querying.
const storePageEl = document.getElementById('storePage');

// ─── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Wire the bridges store.js needs from app.js. Call once inside
 * onSignedIn, before any user-driven Store interaction can happen.
 * Idempotent — safe to call again on subsequent sign-ins (overwrites
 * the previous getter, which is fine because we want the freshest one).
 */
export function initStore(config) {
  _cfg = { ..._cfg, ...config };
  _bridgesReady = true;
}

// ─── Coin Shop page ────────────────────────────────────────────────────────

/**
 * Poll _bridgesReady up to maxMs. Used by both showStore (Codex P1) and
 * handleStoreReturn (H2 mitigation) to wait for app.js's onSignedIn to
 * call initStore before we touch bridge-dependent code.
 */
async function waitForStoreBridges(maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (!_bridgesReady && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return _bridgesReady;
}

/**
 * Navigate to the Coin Shop page. Called from:
 *   • topbarCoinPill click listener (wired at module load below)
 *   • app.js's hash router (when URL is #store)
 *   • inline bridge configs from books.js / videos.js (the "out of coins,
 *     buy more" CTA inside paywall dialogs routes here)
 *   • handleStoreReturn after a successful HitPay payment
 *
 * Codex Round 2 P1: bridge-safety. The topbar pill listener is wired at
 * module load, but initStore() runs from onSignedIn (async). If the user
 * clicks the pill before bridges land, the old code called
 * _cfg.hideAllMainPages() as a no-op, then painted the Store OVER the
 * current page without clearing it. Now we (a) DOM-guard first, then
 * (b) poll bridges before any bridge-dependent work.
 */
export async function showStore() {
  if (!storePageEl) return;
  if (!_bridgesReady && !(await waitForStoreBridges())) {
    console.warn('[store] bridges not ready after 5s; skipping showStore nav');
    return;
  }
  _cfg.hideAllMainPages();
  storePageEl.style.display = 'block';
  history.pushState(null, '', '#store');
  _cfg.setSidebarActive(null);
  renderStoreBalances();
  loadStorePacks();
  renderStoreAdProgress();
  refreshMigrateBanner();
}

// ─── "Bring my balance over" migration banner (Phase 4) ────────────────────
//
// Visibility rules:
//   • Hidden if the user has already migrated (coin_transactions row of
//     type 'migration_grant' exists).
//   • Hidden if the user explicitly dismissed it (localStorage flag).
//   • Otherwise shown — we let the user decide whether they have a mobile
//     balance to bring over. We don't pre-check Appwrite to avoid an extra
//     server round-trip on every Store open.
async function refreshMigrateBanner() {
  const banner = document.getElementById('storeMigrateBanner');
  const me = _cfg.getCurrentUser();
  if (!banner || !me) return;

  const dismissKey = `selebox_migrate_dismiss_${me.id}`;
  if (localStorage.getItem(dismissKey)) { banner.style.display = 'none'; return; }

  // Server check: did we already grant?
  const { count, error } = await supabase
    .from('coin_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', me.id)
    .eq('type', 'migration_grant');
  if (error) { banner.style.display = 'flex'; return; }
  banner.style.display = (count && count > 0) ? 'none' : 'flex';
}

// ─── Balance cards (in the Store header) ───────────────────────────────────

function renderStoreBalances() {
  const c = document.getElementById('storeCoinBalance');
  const s = document.getElementById('storeStarBalance');
  // Reads from wallet.js's getWallet snapshot. The onWalletChange
  // subscriber wired at the bottom of this file re-paints these
  // cards whenever the wallet mutates (realtime UPDATE, unlock,
  // sign-out reset), but ONLY if the Store page is currently visible
  // (otherwise we'd waste paint cycles on hidden DOM).
  const w = getWallet();
  if (c) c.textContent = `${w.coin_balance.toLocaleString()} Coin${w.coin_balance === 1 ? '' : 's'}`;
  if (s) s.textContent = `${w.star_balance.toLocaleString()} Star${w.star_balance === 1 ? '' : 's'}`;
}

// ─── Coin pack grid + HitPay purchase ──────────────────────────────────────

async function loadStorePacks() {
  const grid = document.getElementById('storePacks');
  if (!grid) return;
  grid.innerHTML = '<div class="loading">Loading packs…</div>';
  const { data: packs, error } = await supabase
    .from('coin_packages')
    .select('id, name, base_coins, bonus_coins, price_minor, currency, is_best_value, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) {
    grid.innerHTML = `<div class="loading">Couldn't load packs: ${escHTML(error.message)}</div>`;
    return;
  }
  if (!packs?.length) {
    grid.innerHTML = '<div class="loading">No packs available right now.</div>';
    return;
  }
  grid.innerHTML = packs.map(p => {
    const total    = p.base_coins + p.bonus_coins;
    const bonusPct = p.base_coins > 0 ? Math.round((p.bonus_coins / p.base_coins) * 100) : 0;
    const priceMaj = (p.price_minor / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 });
    const symbol   = p.currency === 'PHP' ? '₱' : (p.currency + ' ');
    return `
      <button class="store-pack ${p.is_best_value ? 'is-best-value' : ''}" data-pack-id="${escHTML(p.id)}" type="button">
        <div class="store-pack-icon">
          <svg viewBox="0 0 24 24" width="36" height="36">
            <ellipse cx="12" cy="6" rx="8" ry="3" fill="#fbbf24" stroke="#b45309" stroke-width="1"/>
            <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" fill="#fde68a" stroke="#b45309" stroke-width="1"/>
            <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" fill="#fbbf24" stroke="#b45309" stroke-width="1"/>
          </svg>
        </div>
        <div class="store-pack-meta">
          <div class="store-pack-name">${p.base_coins} Coins</div>
          <div class="store-pack-bonus">+${p.bonus_coins} free coins</div>
          <div class="store-pack-tags">
            ${bonusPct > 0 ? `<span class="store-pack-bonus-pill">BONUS ${bonusPct}%</span>` : ''}
            ${p.is_best_value ? '<span class="store-pack-best-pill">BEST VALUE</span>' : ''}
          </div>
          <div class="store-pack-total">Total ${total.toLocaleString()} coins delivered instantly</div>
        </div>
        <div class="store-pack-cta">
          <div class="store-pack-price">${symbol}${priceMaj}</div>
          <div class="store-pack-buy">TAP TO BUY</div>
        </div>
      </button>
    `;
  }).join('');

  grid.querySelectorAll('.store-pack').forEach(btn => {
    btn.addEventListener('click', () => purchasePack(btn.dataset.packId, btn));
  });
}

async function purchasePack(packId, btnEl) {
  if (!_cfg.getCurrentUser()) { toast('Sign in to buy coins', 'error'); return; }
  // 2026-05-15: the hitpay-create-payment call takes ~3-5s because it does
  // auth verify + pack lookup + insert pending row + POST to HitPay's API +
  // patch back the request_id, all sequentially. We can't speed up the
  // external HitPay call, but a clear label-change makes the wait less
  // confusing — users see something happening instead of staring at an
  // unresponsive purple button.
  const originalText = btnEl ? btnEl.textContent : null;
  if (btnEl) {
    btnEl.classList.add('is-loading');
    btnEl.disabled = true;
    btnEl.textContent = 'Connecting to HitPay…';
  }
  // Codex Round 2 P2: skip the finally-block re-enable when we're about
  // to navigate. window.location.href is async; the finally block runs
  // before the new page commits, so a fast double-clicker could fire
  // a SECOND hitpay-create-payment (duplicate pending checkout row,
  // confusing UX). The redirecting flag keeps the button disabled
  // until the page is gone.
  let redirecting = false;
  try {
    const data = await callEdgeFunction('hitpay-create-payment', { package_id: packId });
    if (!data?.url) { toast('Could not start checkout', 'error'); return; }
    redirecting = true;
    window.location.href = data.url;
  } catch (err) {
    toast(err.message || 'Checkout failed', 'error');
  } finally {
    if (!redirecting && btnEl) {
      btnEl.classList.remove('is-loading');
      btnEl.disabled = false;
      if (originalText !== null) btnEl.textContent = originalText;
    }
  }
}

// ─── Phase 3: rewarded ads for stars (web is mobile-only-earnings) ─────────
//
// Decision (April 2026): web does NOT host rewarded ads. AdMob's mobile units
// don't render in browsers; AdSense forbids incentivized ad views; GAM
// rewarded requires 100k+ users we don't have yet. So stars are
// **mobile-only earnings** — users watch ads in the Selebox mobile app and
// the wallet (which is unified across both surfaces) shows the balance.
// Spending stars works on either platform.
//
// The "Watch ad" button on the Store stays clickable but only shows a
// friendly redirect toast — it doesn't credit any stars on web.
//
// The credit_star_for_ad RPC, ad_watches table, and the playRewardedAd()
// helper are intentionally kept in the codebase. When/if we add a real web
// ad provider (e.g. self-served promo videos), only this section needs to
// change.

function renderStoreAdProgress() {
  const sub  = document.getElementById('storeAdSub');
  const bar  = document.querySelector('#storePage .store-ad-progress');
  const text = document.getElementById('storeAdProgressText');
  const btn  = document.getElementById('btnWatchAd');

  if (sub)  sub.textContent  = 'Watch ads in the Selebox mobile app to earn stars. Your balance works in both apps.';
  if (bar)  bar.style.display = 'none';
  if (text) text.style.display = 'none';
  if (btn)  {
    btn.disabled    = false;
    btn.textContent = 'Open mobile app';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Rewarded-ad player — STUB FOR NOW.
//
// This function is the integration point. Today it shows a 5-second
// countdown placeholder so the rest of the flow (RPC, balance update, daily
// cap enforcement) can be tested end-to-end. When the real ad SDK lands
// (AdMob H5, AdSense rewarded video, or Google Ad Manager), replace the
// body of this function with the real SDK call. It must:
//   • Resolve with { completed: true, provider, adId } only after the user
//     watched the ad to completion.
//   • Resolve with { completed: false } if the user skipped/closed early.
// The provider and adId fields land in ad_watches.ad_provider / ad_id, used
// for fraud auditing in the admin Wallet panel.
//
// HEADS-UP: today the only abuse-prevention is the 20/day server cap. When
// you wire AdMob, also enable Server-Side Verification (SSV) so the ad
// network calls a Supabase Edge Function on completion — that gives you a
// signed reward-token instead of the client self-reporting completion.
//
// NOTE (Stage 13B): not currently called from web UI (btnWatchAd shows
// the mobile-app toast). Kept here for the Phase 3 swap-in; not exported
// because no current caller needs it.
// ─────────────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
function playRewardedAd() {
  return new Promise((resolve) => {
    const adId    = 'stub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const seconds = 5;

    const modal = document.createElement('div');
    modal.className = 'ad-modal-backdrop';
    modal.innerHTML = `
      <div class="ad-modal" role="dialog" aria-modal="true">
        <div class="ad-modal-tag">Test ad</div>
        <div class="ad-modal-icon">
          <svg viewBox="0 0 24 24" width="64" height="64" fill="#a855f7"><path d="M12 2l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16l-5.6 3.2 1.5-6.3L3 8.7l6.4-.5z"/></svg>
        </div>
        <h2>Watch to earn 1 Star</h2>
        <p class="ad-modal-sub">Real ads via AdMob / AdSense will replace this stub when integrated. For now, it's a 5-second placeholder.</p>
        <div class="ad-modal-progress">
          <div class="ad-modal-progress-fill" id="adProgressFill"></div>
        </div>
        <div class="ad-modal-countdown" id="adCountdown">${seconds}s remaining</div>
        <button class="ad-modal-cancel" id="adCancelBtn">Cancel — no reward</button>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('open'));

    const fill      = modal.querySelector('#adProgressFill');
    const countdown = modal.querySelector('#adCountdown');
    const cancelBtn = modal.querySelector('#adCancelBtn');
    let remaining   = seconds;
    let timer       = null;

    const cleanup = (result) => {
      if (timer) clearInterval(timer);
      modal.classList.remove('open');
      setTimeout(() => modal.remove(), 180);
      resolve(result);
    };

    cancelBtn.onclick = () => cleanup({ completed: false });

    let elapsedMs = 0;
    const totalMs = seconds * 1000;
    timer = setInterval(() => {
      elapsedMs += 100;
      const pct = Math.min(100, (elapsedMs / totalMs) * 100);
      fill.style.width = pct + '%';
      remaining = Math.max(0, Math.ceil((totalMs - elapsedMs) / 1000));
      countdown.textContent = remaining > 0 ? `${remaining}s remaining` : 'Almost there…';
      if (elapsedMs >= totalMs) {
        cleanup({ completed: true, provider: 'stub', adId });
      }
    }, 100);
  });
}

// ─── Wallet history (May 2026 — canonical ledger version) ──────────────────
//
// Reads directly from coin_transactions / star_transactions, the
// authoritative wallet ledgers that every balance-mutating RPC
// already writes to. Each row carries:
//   • delta         signed integer (+credit / −debit)
//   • balance_after wallet balance immediately after the txn
//   • type          categorical ('unlock_chapter', 'unlock_video',
//                                 'unlock_book_bulk', 'admin_adjust',
//                                 'withdrawal_request', etc.)
//   • reference_type + reference_id  polymorphic source pointer
//   • metadata      jsonb with kind-specific extras
//
// Replaces the pre-May-2026 reconstruction-from-three-tables approach
// (which couldn't show debit amounts because the unlocks table doesn't
// store costs). The ledger HAS the cost on every row.

async function loadWalletHistory(currency) {
  const me = _cfg.getCurrentUser();
  if (!me) return [];
  const cur = currency === 'star' ? 'star' : 'coin';
  const table = cur === 'star' ? 'star_transactions' : 'coin_transactions';

  const { data, error } = await supabase
    .from(table)
    .select('id, delta, balance_after, type, reference_type, reference_id, metadata, created_at')
    .eq('user_id', me.id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.warn(`[wallet-history] ${table} fetch failed:`, error.message);
    return [];
  }
  const rows = data || [];

  // Resolve titles for unlock debit rows (chapter / video / book).
  // resolveEarningsTitles handles all three. Map the ledger's
  // reference_type → the resolver's source_type:
  //   chapter → chapter, video → video, book → book_bulk
  const titleLookupInput = [];
  for (const r of rows) {
    if (r.delta >= 0) continue;
    if (!r.reference_type || !r.reference_id) continue;
    const refType =
      r.reference_type === 'book' ? 'book_bulk' :
      r.reference_type === 'chapter' ? 'chapter' :
      r.reference_type === 'video' ? 'video' :
      null;
    if (!refType) continue;
    titleLookupInput.push({ source_type: refType, source_id: r.reference_id });
  }
  const titles = titleLookupInput.length
    ? await resolveEarningsTitles(titleLookupInput)
    : new Map();

  const events = [];
  for (const r of rows) {
    // delta = 0 rows are pure audit (e.g., withdrawal_request) —
    // skip from the user-facing list. They're still useful for
    // admins reading the table directly.
    if (r.delta === 0) continue;

    const direction = r.delta > 0 ? 'credit' : 'debit';
    const amount = Math.abs(r.delta);
    let title = '';
    let sub = '';

    switch (r.type) {
      case 'unlock_chapter':
        title = titles.get(`chapter:${r.reference_id}`) || 'Chapter unlock';
        sub = 'Chapter unlock';
        break;
      case 'unlock_video':
        title = titles.get(`video:${r.reference_id}`) || 'Video unlock';
        sub = 'Video unlock';
        break;
      case 'unlock_book_bulk': {
        const chapterCount = r.metadata?.chapter_count;
        const bookTitle = titles.get(`book_bulk:${r.reference_id}`) || 'a book';
        title = chapterCount
          ? `Bulk unlock — ${chapterCount} chapter${chapterCount === 1 ? '' : 's'} from ${bookTitle}`
          : `Bulk unlock — ${bookTitle}`;
        sub = 'Whole book unlock';
        break;
      }
      case 'admin_adjust': {
        const reason = r.metadata?.reason;
        if (r.reference_type === 'goal_pool_claim' || reason === 'goal_pool_claim') {
          const period = r.metadata?.period;
          title = _walletHistoryClaimTitle(period);
          sub = r.metadata?.period_key || 'Goal pool claim';
        } else if (r.reference_type === 'balance_recovery' || reason === 'balance_recovery') {
          title = 'Balance restored';
          sub = 'Approved recovery request';
        } else {
          title = 'Admin adjustment';
          sub = reason || r.reference_type || '';
        }
        break;
      }
      case 'purchase':
      case 'coin_purchase':
      case 'iap_purchase':
      case 'hitpay_purchase':
        title = 'Store top-up';
        sub = r.metadata?.package_name
          || r.metadata?.product_id
          || (r.reference_type === 'hitpay' ? 'HitPay purchase' : 'In-app purchase');
        break;
      case 'withdrawal_request':
        title = 'Withdrawal';
        sub = 'Payout to bank';
        break;
      case 'ad_reward':
        title = 'Star earned';
        sub = 'Rewarded ad';
        break;
      default:
        title = String(r.type || 'Wallet event').replace(/_/g, ' ');
        sub = r.reference_type || '';
    }

    events.push({
      kind: r.type,
      direction,
      amount,
      currency: cur,
      title,
      sub,
      at: r.created_at,
      balance_after: r.balance_after,
    });
  }
  return events;
}

function _walletHistoryClaimTitle(period) {
  if (period === 'daily')   return 'Daily goal pool claim';
  if (period === 'weekly')  return 'Weekly goal pool claim';
  if (period === 'monthly') return 'Monthly goal pool claim';
  return 'Goal pool claim';
}

// Compact, two-piece timestamp: "9:55 AM" + (date, when not today/yesterday).
// Date grouping lives at the section-header level so individual rows
// only need the time. Returns { primary, secondary }:
//   • primary   — short time ("9:55 AM")
//   • secondary — relative day for older rows ("Mar 14" or "Mar 14, 2025"
//                 when not in current year); blank for today / yesterday
function _formatWalletHistoryTime(iso) {
  if (!iso) return { primary: '—', secondary: '' };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { primary: '—', secondary: '' };

  const primary = d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
  });

  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (sameDay || isYesterday) return { primary, secondary: '' };

  const secondary = d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return { primary, secondary };
}

// Group key + display label for date section headers. Keeps the
// wallet history list visually segmented so the eye can scan blocks
// instead of an undifferentiated wall of rows.
function _walletHistoryDateKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { key: 'unknown', label: 'Unknown date' };

  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return { key: 'today', label: 'Today' };

  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return { key: 'yesterday', label: 'Yesterday' };
  }

  const dayDiff = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (dayDiff < 7) {
    return {
      key: d.toDateString(),
      label: d.toLocaleDateString('en-US', { weekday: 'long' }),
    };
  }

  if (d.getFullYear() === now.getFullYear()) {
    return {
      key: d.toDateString(),
      label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    };
  }
  return {
    key: d.toDateString(),
    label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  };
}

async function openWalletHistory(currency) {
  const cur = currency === 'star' ? 'star' : 'coin';
  const modal = document.getElementById('walletHistoryModal');
  if (!modal) return;

  // Codex Round 2 P2: cache + null-check every required child node up
  // front. If the modal shell is present but one of its inner slots
  // is missing (deploy mismatch, half-applied template change), the
  // old code would NPE on `.innerHTML` of a null element. Now we just
  // bail cleanly with a console.warn.
  const titleText = document.getElementById('walletHistoryTitleText');
  const iconWrap  = document.getElementById('walletHistoryIcon');
  const balEl     = document.getElementById('walletHistoryBalance');
  const earnedEl  = document.getElementById('walletHistoryEarned');
  const spentEl   = document.getElementById('walletHistorySpent');
  const listEl    = document.getElementById('walletHistoryList');
  if (!earnedEl || !spentEl || !listEl) {
    console.warn('[wallet-history] modal shell missing required children; aborting open');
    return;
  }

  if (titleText) titleText.textContent = cur === 'star' ? 'Stars history' : 'Coins history';
  if (iconWrap) iconWrap.innerHTML = _walletCurrencyIconSvg(cur, 20);

  // Current balance card — render the new SVG glyph inline rather than
  // an emoji (the 🪙 / ⭐ emoji render as flat gray discs at small sizes
  // on many systems, which is what made the icon read as a moon).
  const summaryGlyphHtml = `<span class="wallet-history-summary-glyph" aria-hidden="true">${_walletCurrencyIconSvg(cur, 14)}</span>`;
  if (balEl) {
    const _w = getWallet();
    const bal = cur === 'star' ? (_w.star_balance || 0) : (_w.coin_balance || 0);
    balEl.innerHTML = `${bal.toLocaleString()} ${summaryGlyphHtml}`;
  }

  earnedEl.innerHTML = `+0 ${summaryGlyphHtml}`;
  spentEl.innerHTML  = `−0 ${summaryGlyphHtml}`;
  listEl.innerHTML = `
    <div class="wallet-history-loading">
      <div class="wallet-history-loading-spinner" aria-hidden="true"></div>
      <div class="wallet-history-loading-text">Loading your history…</div>
    </div>
  `;

  modal.style.display = 'flex';

  const events = await loadWalletHistory(cur);

  let earned = 0, spent = 0;
  for (const e of events) {
    if (e.direction === 'credit' && e.amount) earned += e.amount;
    if (e.direction === 'debit'  && e.amount) spent  += e.amount;
  }
  earnedEl.innerHTML = `+${earned.toLocaleString()} ${summaryGlyphHtml}`;
  spentEl.innerHTML  = `−${spent.toLocaleString()} ${summaryGlyphHtml}`;

  if (!events.length) {
    listEl.innerHTML = `
      <div class="wallet-history-empty">
        <div class="wallet-history-empty-illustration" aria-hidden="true">${_walletCurrencyIconSvg(cur, 56)}</div>
        <div class="wallet-history-empty-title">No history yet</div>
        <div class="wallet-history-empty-sub">When you earn or spend ${cur === 'star' ? 'stars' : 'coins'}, entries will show here.</div>
      </div>
    `;
    return;
  }

  // Build the list. Credits → green + sign, debits → red − sign.
  // Bulk-unlock rows get a "BULK" pill, a stacked-books icon, and a
  // soft purple tint so a whole-book purchase is visually distinct
  // from individual chapter/video unlocks.
  //
  // Premium redesign (May 2026):
  //   • Date section dividers ("Today", "Yesterday", "Tuesday", "Sat, May 3")
  //     so the eye scans clusters instead of an undifferentiated list.
  //   • Two-line metadata: title + sub-line, time on the right column above
  //     the running balance for at-a-glance verification.
  //   • Card-style rows with subtle elevation on hover.
  //   • Stagger fade-in animation per row.
  const rowBalGlyph = `<span class="wallet-history-bal-glyph" aria-hidden="true">${_walletCurrencyIconSvg(cur, 11)}</span>`;
  let lastDateKey = null;
  const html = [];
  events.forEach((e, idx) => {
    const grp = _walletHistoryDateKey(e.at);
    if (grp.key !== lastDateKey) {
      lastDateKey = grp.key;
      html.push(`<div class="wallet-history-date-divider"><span>${escHTML(grp.label)}</span></div>`);
    }

    const sign = e.direction === 'credit' ? '+' : '−';
    const dirCls = e.direction === 'credit' ? 'wallet-history-row-credit' : 'wallet-history-row-debit';
    const kindCls = e.kind === 'unlock_book_bulk' ? 'wallet-history-row-bulk' : '';
    const amountText = e.amount != null
      ? `${sign}${e.amount.toLocaleString()}`
      : '—';
    const icon = _walletHistoryIconFor(e);
    const pill = e.kind === 'unlock_book_bulk'
      ? '<span class="wallet-history-pill wallet-history-pill-bulk" title="Whole-book purchase">BULK</span>'
      : '';
    const t = _formatWalletHistoryTime(e.at);
    const balanceHtml = e.balance_after != null
      ? `Bal ${Number(e.balance_after).toLocaleString()} ${rowBalGlyph}`
      : (t.secondary ? escHTML(t.secondary) : '');
    const subText = e.sub ? escHTML(e.sub) : '';
    const stagger = `style="animation-delay:${Math.min(idx * 20, 600)}ms"`;
    html.push(`
      <div class="wallet-history-row ${dirCls} ${kindCls}" ${stagger}>
        <div class="wallet-history-row-icon" aria-hidden="true">${icon}</div>
        <div class="wallet-history-row-meta">
          <div class="wallet-history-row-title" title="${escHTML(e.title)}">
            <span class="wallet-history-row-title-text">${escHTML(e.title)}</span>
            ${pill}
          </div>
          <div class="wallet-history-row-sub">
            ${subText}${subText && t.primary ? '<span class="wallet-history-row-sub-dot">·</span>' : ''}<span class="wallet-history-row-time">${escHTML(t.primary)}${t.secondary ? `, ${escHTML(t.secondary)}` : ''}</span>
          </div>
        </div>
        <div class="wallet-history-row-right">
          <div class="wallet-history-row-amount">${amountText}</div>
          ${balanceHtml ? `<div class="wallet-history-row-balance">${balanceHtml}</div>` : ''}
        </div>
      </div>
    `);
  });
  listEl.innerHTML = html.join('');
}

// Currency icon SVG — used by the modal header AND every credit row.
// Two designs, both disc-shaped so they read as "currency" at a glance
// (the previous coin icon was a stacked cylinder that looked like a
// crescent moon at small sizes):
//   • coin → two overlapping gold discs with a faint inner ring on the
//     top coin (suggests dimensional embossing)
//   • star → light-purple disc with a deep-purple star emblem inside
//     (matches Selebox's existing star-as-purple-glyph convention while
//     pairing visually with the coin disc as a sibling)
// The `size` arg lets the same SVG drive 20px header icons and 18px
// row icons without duplicating markup.
function _walletCurrencyIconSvg(currency, size = 18) {
  if (currency === 'star') {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">`
      + `<circle cx="12" cy="12" r="9" fill="#c4b5fd" stroke="#6b21a8" stroke-width="1.2"/>`
      + `<path d="M12 6.8l1.55 3.25 3.6.3-2.78 2.36.88 3.49L12 14.45l-3.25 1.75.88-3.49-2.78-2.36 3.6-.3z" fill="#5b21b6"/>`
      + `</svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">`
    + `<circle cx="9" cy="14.5" r="6.6" fill="#fbbf24" stroke="#b45309" stroke-width="1.2"/>`
    + `<circle cx="15" cy="9.5"  r="6.6" fill="#f59e0b" stroke="#b45309" stroke-width="1.2"/>`
    + `<circle cx="15" cy="9.5"  r="3.4" fill="none"   stroke="#78350f" stroke-width="0.8" opacity="0.55"/>`
    + `</svg>`;
}

// Pick an icon by event kind. Each row gets a small left-side glyph
// so the eye lands on the right category without reading. Bulk
// unlocks get a books-stack so they pop visually next to single-
// chapter or single-video unlocks. Credits get currency-specific
// glyphs (coin / star) instead of a kind icon — money in is money
// in, regardless of source.
function _walletHistoryIconFor(e) {
  if (e.direction === 'credit') {
    return _walletCurrencyIconSvg(e.currency, 18);
  }
  switch (e.kind) {
    case 'unlock_book_bulk':
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6v16H4z"/><path d="M10 4h6v16h-6z"/><path d="M16.5 5.5l5 1.2-3.4 14.6-5-1.2z"/></svg>';
    case 'unlock_chapter':
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>';
    case 'unlock_video':
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
    case 'withdrawal_request':
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 22 8 2 8 12 2"/><line x1="5" y1="11" x2="5" y2="18"/><line x1="10" y1="11" x2="10" y2="18"/><line x1="14" y1="11" x2="14" y2="18"/><line x1="19" y1="11" x2="19" y2="18"/><line x1="2" y1="22" x2="22" y2="22"/></svg>';
    default:
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>';
  }
}

function closeWalletHistory() {
  const modal = document.getElementById('walletHistoryModal');
  if (modal) modal.style.display = 'none';
}

// ─── HitPay return handler (?store=success&ref=… on cold-load) ─────────────
//
// HitPay redirects users back to /?store=success&ref=<purchase_id> after
// payment AND after cancel — the redirect_url field in a HitPay
// payment-request is single-purpose, so the URL alone can't tell us
// whether the user actually paid or just hit Back. The fix (May 2026)
// is to verify against the database: when we see ?store=success&ref=…,
// fetch the matching coin_purchases row and look at its real status.
//
// `failed` / `cancelled` rows trigger a cancel toast. `pending` rows
// (webhook hasn't fired yet OR was never going to because the user
// bailed) stay silent — the wallet's realtime subscription will still
// credit the coins if a webhook eventually lands, and we'd rather
// show no toast than a wrong toast.
//
// 2026-05-15 UX update: no more success toast. The toast was firing
// even when the user just clicked Back from HitPay without paying,
// which felt dishonest. The wallet pill ticking up + a fresh entry in
// the Coins history is confirmation enough. We also always route back
// to the Coins/Store page on a `success` flag so the user lands
// directly on their updated balance instead of Home.
//
// Stage 13B hazard H2: this fires from a 800ms setTimeout at module
// load. initStore() is called from inside onSignedIn which is async
// and depends on Supabase resolving the session. If the user lands on
// /?store=success and auth takes longer than 800ms, the bridges
// (hideAllMainPages, setSidebarActive) used by showStore are still
// no-op stubs. Poll up to 5s for _bridgesReady before calling
// showStore — pure-DOM bits (URL strip, toast) run regardless.

async function handleStoreReturn() {
  const params = new URLSearchParams(window.location.search);
  const storeFlag = params.get('store');
  const ref = params.get('ref');
  if (!storeFlag) return;

  // Strip params first so refresh / back-forward navigation doesn't
  // keep re-firing this logic. Pure DOM — runs regardless of bridges.
  params.delete('store');
  params.delete('ref');
  const newQuery = params.toString();
  history.replaceState(null, '', window.location.pathname + (newQuery ? '?' + newQuery : '') + window.location.hash);

  if (storeFlag !== 'success') {
    if (storeFlag === 'cancelled' || storeFlag === 'cancel') {
      toast('Payment cancelled.', 'error');
    }
    return;
  }

  // success branch — wait for bridges (auth) before nav-ing to Store.
  // Uses the shared waitForStoreBridges helper. If bridges never wire
  // (auth failed), skip the nav and just verify-then-maybe-toast on
  // the purchase row below — toast still surfaces correctly.
  const ready = _bridgesReady || (await waitForStoreBridges());
  if (ready) {
    setTimeout(() => showStore(), 50);
  } else {
    console.warn('[store-return] bridges still not ready after 5s; skipping showStore nav');
  }

  if (!ref) {
    return;
  }

  let purchaseStatus = null;
  try {
    const { data, error } = await supabase
      .from('coin_purchases')
      .select('status')
      .eq('id', ref)
      .maybeSingle();
    if (!error && data) purchaseStatus = data.status;
  } catch (e) {
    console.warn('[store] purchase status verify failed:', e?.message);
    return;
  }

  // Only surface the error toast when the row definitively says the
  // payment didn't go through. credited / completed / paid → silent
  // (no more success toast, per UX feedback). pending / null →
  // silent (the realtime wallet subscription will catch a late credit).
  if (purchaseStatus === 'failed' || purchaseStatus === 'cancelled') {
    toast('Payment was not completed. No coins added.', 'error');
  }
}

// ─── Migrate-from-Appwrite click handlers ──────────────────────────────────

document.getElementById('btnMigrateDismiss')?.addEventListener('click', () => {
  const me = _cfg.getCurrentUser();
  if (!me) return;
  localStorage.setItem(`selebox_migrate_dismiss_${me.id}`, '1');
  const banner = document.getElementById('storeMigrateBanner');
  if (banner) banner.style.display = 'none';
});

document.getElementById('btnMigrateFromAppwrite')?.addEventListener('click', async () => {
  const me = _cfg.getCurrentUser();
  if (!me) { toast('Sign in first', 'error'); return; }
  // Codex Round 2 P1: capture the user id upfront so we can re-verify
  // after each async hop. The edge function takes 3-5s; if the user
  // signs out or switches accounts mid-call, the old user's
  // localStorage / toast / banner update would leak into the new
  // session.
  const userId = me.id;
  const stillSameUser = () => _cfg.getCurrentUser()?.id === userId;
  const btn = document.getElementById('btnMigrateFromAppwrite');
  const originalLabel = btn.textContent;
  btn.disabled = true; btn.textContent = 'Checking your mobile account…';
  try {
    const data = await callEdgeFunction('migrate-from-appwrite', {});
    if (!stillSameUser()) return;
    if (data?.nothing_to_import) {
      toast('Checked your mobile account — nothing to import.', '');
      localStorage.setItem(`selebox_migrate_dismiss_${userId}`, '1');
      const banner = document.getElementById('storeMigrateBanner');
      if (banner) banner.style.display = 'none';
      return;
    }
    if (data?.ok === false) {
      if (data.error === 'already_migrated') {
        toast('Looks like you already brought your balance over.', '');
        const banner = document.getElementById('storeMigrateBanner');
        if (banner) banner.style.display = 'none';
        return;
      }
      toast(data.error || 'Migration failed', 'error');
      return;
    }
    // Success — Realtime on wallet will auto-update the pill, but force a
    // refresh here so the Store balance shows immediately.
    await loadWalletState();
    if (!stillSameUser()) return;
    const banner = document.getElementById('storeMigrateBanner');
    if (banner) banner.style.display = 'none';
    const parts = [];
    if (data?.coins_credited)  parts.push(`${data.coins_credited.toLocaleString()} coins`);
    if (data?.stars_credited)  parts.push(`${data.stars_credited.toLocaleString()} stars`);
    if (data?.unlocks_imported) parts.push(`${data.unlocks_imported} unlocked`);
    toast(parts.length ? `Imported: ${parts.join(' · ')}` : 'Migration complete.', 'success');
  } catch (err) {
    toast(err.message || 'Migration failed', 'error');
  } finally {
    btn.disabled = false; btn.textContent = originalLabel;
  }
});

// ─── Watch-ad button (web is mobile-only-earnings) ─────────────────────────

document.getElementById('btnWatchAd')?.addEventListener('click', () => {
  toast('Use the Selebox mobile app to watch ads and earn stars.', '');
});

// ─── Topbar pill → showStore (moved from app.js in Stage 13B) ──────────────

document.getElementById('topbarCoinPill')?.addEventListener('click', () => showStore());

// ─── Wallet history modal triggers ─────────────────────────────────────────

document.querySelectorAll('[data-history-currency]').forEach((btn) => {
  btn.addEventListener('click', () => openWalletHistory(btn.dataset.historyCurrency));
});
document.getElementById('btnCloseWalletHistory')?.addEventListener('click', closeWalletHistory);
document.getElementById('walletHistoryModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'walletHistoryModal') closeWalletHistory();
});

// ─── Refresh Store balance cards on wallet changes ─────────────────────────
//
// Stage 13A introduced the subscriber pattern to replace the load-time-
// fatal renderTopbarCoinPill monkey-patch. Stage 13B moves the
// subscriber from app.js into store.js where it actually belongs.
// wallet.js notifies every onWalletChange subscriber whenever _wallet
// mutates (Realtime UPDATE, successful unlock, sign-out reset). We
// only re-paint if the Store page is currently visible — avoids
// wasted paint cycles on hidden DOM.
onWalletChange(() => {
  if (storePageEl && storePageEl.style.display === 'block') renderStoreBalances();
});

// ─── Cold-load HitPay return ───────────────────────────────────────────────
// Codex Round 2 P2: 0ms (next-tick) instead of 800ms. The old 800ms delay
// predates the bridge-readiness poll inside handleStoreReturn itself —
// today the handler waits up to 5s for _bridgesReady, so the extra 800ms
// at the top adds latency to every payment-return cold load without
// buying anything. Using setTimeout(_, 0) so we still defer past the
// rest of the module-load synchronous work.

setTimeout(handleStoreReturn, 0);
