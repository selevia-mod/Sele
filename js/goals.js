// ════════════════════════════════════════════════════════════════════════════
// goals.js — Daily / Weekly / Monthly Quests + Pool Claims (Stage 14 owner)
// ════════════════════════════════════════════════════════════════════════════
//
// Extracted from js/app.js on 2026-05-17. Owns:
//   • In-memory quest state (_dailyQuestsState) — streak, daily[],
//     weekly[], monthly[], pool configs, activeTab, featuredState
//   • Server I/O — _fetchGoalsFromSupabase (panel open) + _fireTickGoalRpc
//     (engagement events) + _fireClaimGoalPoolRpc (pool claim button)
//   • Public engagement API — tickGoal, tickGoalUnique, tickDailyLogin
//   • localStorage write-through cache (user-scoped, key v3)
//   • Quests panel render + 7-day strip + countdown timer
//   • Pool claim button wiring + flying reward animation
//   • All boot listeners (btnDailyQuests click, tab clicks, outside-click)
//
// Bridges (1, injected via initGoals({...}) from app.js onSignedIn):
//   • getCurrentUser — () => currentUser, observed via getter so sign-out
//                      is seen by every internal RPC call without re-init
//
// Direct imports (no bridge — owner modules already export these):
//   • supabase.js: supabase, toast
//   • wallet.js:   loadWalletState (called after pool claim so the topbar
//                  pill refreshes immediately instead of waiting for the
//                  Realtime UPDATE on wallets)
//
// Exports:
//   • initGoals(config)   — call once inside onSignedIn after initWallet
//   • resetGoalsState()   — call from signOut to clear in-memory state
//                           and re-render an empty panel
//   • tickGoal(category, delta=1)             — engagement dispatcher
//   • tickGoalUnique(category, key, delta=1)  — deduped variant
//   • tickDailyLogin()                        — login-tick wrapper
//
// Module-load wires (run at import time — DOM is ready because index.html
// loads this as <script type="module"> which defers like DOMContentLoaded):
//   • btnDailyQuests click → toggleDailyQuestsPanel
//   • .quests-tab clicks → switch activeTab + re-render
//   • document click outside panel → close
//   • Initial renderDailyQuests() with default state (cache load deferred
//     to initGoals because the v3 localStorage key needs userId)
//
// Stage 14 design notes:
//   • H1 — wallet.js stays UNCHANGED. Its `_cfg.tickGoalUnique` bridge
//     still receives the imported tickGoalUnique from app.js. We do NOT
//     direct-import from goals.js into wallet.js — that would create a
//     circular import (goals.js already imports loadWalletState from
//     wallet.js). The cycle is theoretically safe but not worth it in
//     this commit. Cleanup deferred to a follow-up.
//   • H7 — `_dailyQuestsState.dayHistory` is dropped. It was hand-seeded
//     "looks lived-in" demo data, never read by the renderer (the day
//     strip is derived from `.streak` in _renderQuestsDayStrip).
//   • H8 — User-scoped localStorage. Old global key
//     'daily_quests_demo_state_v2' would leak User A's progress into
//     User B's first panel open on the same browser. New key is
//     `daily_quests_state_v3:${userId}`. resetGoalsState() clears
//     in-memory state on sign-out (the localStorage entry stays — it's
//     the user's cache for next time they sign back in).
//   • H9 — Async stale-user guards on every state mutation after an
//     await. Both _fetchGoalsFromSupabase and the pool-claim handler
//     capture userId before the await and bail before mutating state if
//     the auth user changed mid-call (e.g. sign-out during claim RPC).

import { supabase, toast } from './supabase.js';
import { loadWalletState } from './wallet.js';

// ─── Module-private state ──────────────────────────────────────────────────

// Bridge injected by initGoals. Default no-op getter so any pre-init
// call (rare — only happens if module-load boot wires fire before
// initGoals lands) at worst returns null instead of throwing.
let _cfg = {
  getCurrentUser: () => null,
};

// ─── Quest definitions + mutable state ─────────────────────────────────────

// Per-tab display config. Lets us drive title text + day-strip cadence
// + footer label off a single source. Daily strip is fixed at 7 pips
// (one per day of the current week — Day 1 to Day 7); weekly is a
// 5-week rolling window; monthly is the last 6 months.
// User-facing rebrand: "Quests" → "Goals" so the system reads cleaner
// and matches the mobile app's [Goals][Store] tab. Internal ID/class
// names (questsXyz, _dailyQuestsState) intentionally NOT renamed —
// touching them would ripple across hundreds of CSS rules and JS
// selectors. Only the visible labels change.
const QUEST_TAB_META = {
  daily:   { title: 'Daily Goals',   stripCadence: 'day',   stripCount: 7 },
  weekly:  { title: 'Weekly Goals',  stripCadence: 'week',  stripCount: 5 },
  monthly: { title: 'Monthly Goals', stripCadence: 'month', stripCount: 6 },
};

const QUEST_ICONS = {
  door:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v18"/><line x1="2" y1="22" x2="22" y2="22"/><line x1="14" y1="12" x2="14" y2="13"/></svg>',
  book:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  video:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
  heart:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
  star:    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  userplus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
  gift:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
  ad:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2" ry="2"/><polygon points="10 8 16 11 10 14 10 8" fill="currentColor"/><line x1="6" y1="22" x2="18" y2="22"/><line x1="12" y1="18" x2="12" y2="22"/></svg>',
};

// Default-state factory. Used at module load AND on every sign-out
// (resetGoalsState replaces _dailyQuestsState with a fresh copy so
// arrays/objects aren't mutated across sessions). Pull this out of
// the const so we can re-build it on demand.
function _defaultGoalsState() {
  return {
    streak: 0,
    bonusClaimed: false,
    activeTab: 'daily',
    featuredPool: [
      { id: 'feat_genre',    icon: 'compass', label: 'Try a book in a new genre',  target: 1, reward: 30, unit: '' },
      { id: 'feat_creator',  icon: 'compass', label: 'Discover a new creator',     target: 1, reward: 30, unit: '' },
      { id: 'feat_finish',   icon: 'compass', label: 'Finish a chapter today',     target: 1, reward: 30, unit: '' },
      { id: 'feat_share',    icon: 'compass', label: 'Share a post or book',       target: 1, reward: 30, unit: '' },
    ],
    featuredState: {},
    // Daily quest list (see app.js historic comment for abuse-guard +
    // economy notes; preserved in git blame).
    daily: [
      { id: 'login',         icon: 'door',     label: 'Log in today',            progress: 0, target: 1,  unit: '' },
      { id: 'read_chapters', icon: 'book',     label: 'Read 3 chapters',         progress: 0, target: 3,  unit: '' },
      { id: 'watch_video',   icon: 'video',    label: 'Watch 10 mins of video',  progress: 0, target: 10, unit: 'min' },
      { id: 'like_comment',  icon: 'heart',    label: 'Like & comment 3 posts',  progress: 0, target: 3,  unit: '' },
      { id: 'follow_user',   icon: 'userplus', label: 'Follow 1 new user',       progress: 0, target: 1,  unit: '' },
      { id: 'watch_ads',     icon: 'ad',       label: 'Watch 3 ads',             progress: 0, target: 3,  unit: '' },
      { id: 'invite_friend', icon: 'gift',     label: 'Invite 1 friend',         progress: 0, target: 1,  unit: '', bonus: { stars: 0, coins: 1 } },
    ],
    dailyPool: {
      questsRequired: 5,
      reward: { stars: 4, coins: 1 },
      claimed: false,
    },
    weeklyPool: {
      questsRequired: 6,
      reward: { stars: 8, coins: 2 },
      claimed: false,
    },
    monthlyPool: {
      questsRequired: 9,
      reward: { stars: 0, coins: 1000 },
      claimed: false,
    },
    weekly: [
      { id: 'w_read_chapters', icon: 'book',     label: 'Read 20 chapters',           progress: 0, target: 20, unit: '' },
      { id: 'w_watch_video',   icon: 'video',    label: 'Watch 60 mins of video',     progress: 0, target: 60, unit: 'min' },
      { id: 'w_like_comment',  icon: 'heart',    label: 'Like & comment 20 times',    progress: 0, target: 20, unit: '' },
      { id: 'w_follow_users',  icon: 'userplus', label: 'Follow 5 users',             progress: 0, target: 5,  unit: '' },
      { id: 'w_share',         icon: 'compass',  label: 'Share 5 books or videos',    progress: 0, target: 5,  unit: '' },
      { id: 'w_unlock',        icon: 'gift',     label: 'Unlock 3 books or videos',   progress: 0, target: 3,  unit: '' },
      { id: 'w_watch_ads',     icon: 'ad',       label: 'Watch 10 ads',               progress: 0, target: 10, unit: '' },
      { id: 'w_invite_friend', icon: 'userplus', label: 'Invite 5 friends',           progress: 0, target: 5,  unit: '', bonus: { stars: 0, coins: 3 } },
      { id: 'w_purchase_coin', icon: 'gift',     label: 'Purchase coins',             progress: 0, target: 1,  unit: '', bonus: { stars: 0, coins: 3 } },
    ],
    monthly: [
      { id: 'm_read_chapters', icon: 'book',     label: 'Read 100 chapters',         progress: 0, target: 100, unit: '' },
      { id: 'm_watch_video',   icon: 'video',    label: 'Watch 300 mins of video',   progress: 0, target: 300, unit: 'min' },
      { id: 'm_like_comment',  icon: 'heart',    label: 'Like & comment 100 times',  progress: 0, target: 100, unit: '' },
      { id: 'm_follow_users',  icon: 'userplus', label: 'Follow 20 users',           progress: 0, target: 20,  unit: '' },
      { id: 'm_share',         icon: 'compass',  label: 'Share 20 books or videos',  progress: 0, target: 20,  unit: '' },
      { id: 'm_unlock',        icon: 'gift',     label: 'Unlock 30 books or videos', progress: 0, target: 30,  unit: '' },
      { id: 'm_watch_ads',     icon: 'ad',       label: 'Watch 100 ads',             progress: 0, target: 100, unit: '' },
      // `required: true` — server-side claim_user_goal_pool RPC v2
      // (migration_goals_required_gate.sql) rejects monthly claims
      // with error 'required_goal_incomplete' if m_active30 < 30
      // even when 9 of the other 9 quests are done. Mirror that gate
      // client-side so the Claim button is BLOCKED instead of merely
      // failing on click. Without this flag the web UI would enable
      // the button at 9/10, the user clicks, server rejects, friendly
      // toast fires — confusing UX. Mobile already enforces this; web
      // was the parity gap.
      { id: 'm_active30',      icon: 'door',     label: 'Stay active 30 days',       progress: 0, target: 30,  unit: ' days', required: true },
      { id: 'm_purchase_coin', icon: 'gift',     label: 'Purchase coins 4 times',    progress: 0, target: 4,   unit: '', bonus: { stars: 0, coins: 5 } },
      { id: 'm_invite_friend', icon: 'userplus', label: 'Invite 10 friends',         progress: 0, target: 10,  unit: '', bonus: { stars: 0, coins: 5 } },
    ],
    // Stage 14 (Codex R1 P2 #6): dropped `dayHistory`. It was hand-
    // seeded "looks lived-in" demo data, never read by the renderer.
  };
}

let _dailyQuestsState = _defaultGoalsState();

let _dailyQuestsPanelOpen = false;
let _questsCountdownInterval = null;

// ─── Lifecycle ─────────────────────────────────────────────────────────────

/**
 * Wire the bridges goals.js needs from app.js. Call once inside
 * onSignedIn. Triggers a user-scoped localStorage load + render so the
 * panel reflects the now-known user's cached progress.
 */
export function initGoals(config) {
  _cfg = { ..._cfg, ...config };
  _loadDailyQuestsFromStorage();
  renderDailyQuests();
}

/**
 * Clear in-memory quest state. Called from signOut (see app.js) so the
 * next user signed in on the same browser doesn't see the previous
 * user's progress before initGoals re-loads. The localStorage entry
 * for the signed-out user is intentionally KEPT — it's their cache for
 * the next time they sign back in (the v3 key is user-scoped so there
 * is no cross-user leak).
 *
 * Codex R1 P1 #2: prior to Stage 14, neither the in-memory state nor
 * the localStorage key was reset on sign-out, and the key was global
 * (not user-scoped), so progress leaked across user changes on the
 * same browser.
 */
export function resetGoalsState() {
  _dailyQuestsState = _defaultGoalsState();
  if (_questsCountdownInterval) {
    clearInterval(_questsCountdownInterval);
    _questsCountdownInterval = null;
  }
  _dailyQuestsPanelOpen = false;
  // Re-render to clear any stale numbers in the panel + topbar badge.
  renderDailyQuests();
}

// ─── localStorage cache (user-scoped per Codex R1 P1 #2) ───────────────────

const _PERSIST_KEY_PREFIX = 'daily_quests_state_v3';

function _persistKeyForCurrentUser() {
  const u = _cfg.getCurrentUser();
  if (!u?.id) return null;
  return `${_PERSIST_KEY_PREFIX}:${u.id}`;
}

function _loadDailyQuestsFromStorage() {
  const key = _persistKeyForCurrentUser();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.day !== new Date().toISOString().slice(0, 10)) return; // new day → reset
    // Streak intentionally NOT restored from localStorage (May 2026).
    // The previous code seeded a hardcoded `streak: 7` demo value that
    // got persisted on first save, then resurrected on every reload —
    // so even after zeroing the seed, returning users still saw a
    // fake "7" on the topbar trophy. Until a real streak source is
    // wired (server-side compute or mobile-synced field), the streak
    // stays at the in-memory seed (0) which hides the badge.
    if (typeof saved.bonusClaimed === 'boolean') _dailyQuestsState.bonusClaimed = saved.bonusClaimed;
    if (typeof saved.activeTab === 'string') _dailyQuestsState.activeTab = saved.activeTab;
    if (saved.featuredState && typeof saved.featuredState === 'object') {
      _dailyQuestsState.featuredState = saved.featuredState;
    }
    for (const tab of ['daily', 'weekly', 'monthly']) {
      if (Array.isArray(saved[tab])) {
        for (const q of _dailyQuestsState[tab]) {
          const found = saved[tab].find((s) => s.id === q.id);
          if (found) {
            if (typeof found.progress === 'number') q.progress = found.progress;
            if (typeof found.claimed === 'boolean') q.claimed = found.claimed;
          }
        }
      }
    }
  } catch (_e) { /* corrupt cache, fall back to defaults */ }
}

function _saveDailyQuestsToStorage() {
  const key = _persistKeyForCurrentUser();
  if (!key) return;
  try {
    const snap = (list) => list.map((q) => ({ id: q.id, progress: q.progress, claimed: !!q.claimed }));
    localStorage.setItem(key, JSON.stringify({
      day: new Date().toISOString().slice(0, 10),
      // streak persistence intentionally omitted (May 2026) — see
      // matching note in _loadDailyQuestsFromStorage. We write a
      // sentinel 0 so any existing cache holding a stale value gets
      // overwritten on the first save after this deploy.
      streak: 0,
      bonusClaimed: _dailyQuestsState.bonusClaimed,
      activeTab: _dailyQuestsState.activeTab,
      daily: snap(_dailyQuestsState.daily),
      weekly: snap(_dailyQuestsState.weekly),
      monthly: snap(_dailyQuestsState.monthly),
      featuredState: _dailyQuestsState.featuredState || {},
    }));
  } catch (_e) { /* localStorage full or disabled — non-fatal */ }
}

// ─── Period-key helpers (shared with mobile via the same algorithms) ───────

const _periodKeyDaily   = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const _periodKeyWeekly  = (now = new Date()) => {
  // ISO week — same algorithm mobile uses, so both platforms compute
  // the SAME period_key for the same calendar week.
  const tmp = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7;
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
  const firstThursday = tmp.valueOf();
  tmp.setUTCMonth(0, 1);
  if (tmp.getUTCDay() !== 4) tmp.setUTCMonth(0, 1 + ((4 - tmp.getUTCDay()) + 7) % 7);
  const weekNum = 1 + Math.round((firstThursday - tmp) / 604800000);
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
};
const _periodKeyMonthly = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

const _PERIOD_KEY_FN = { daily: _periodKeyDaily, weekly: _periodKeyWeekly, monthly: _periodKeyMonthly };

// ─── Featured Quest of the Day ─────────────────────────────────────────────

// Pick today's featured quest deterministically from the day-of-year so
// every user sees the SAME quest on a given day (creates a shared "daily
// thing" to talk about) but rotates through the pool over time.
// eslint-disable-next-line no-unused-vars
function _featuredQuestForToday() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now - start;
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  const pool = _dailyQuestsState.featuredPool || [];
  if (pool.length === 0) return null;
  const def = pool[dayOfYear % pool.length];
  const overlay = (_dailyQuestsState.featuredState && _dailyQuestsState.featuredState[def.id]) || {};
  return {
    ...def,
    isFeatured: true,
    progress: typeof overlay.progress === 'number' ? overlay.progress : 0,
    claimed: !!overlay.claimed,
  };
}

// ─── Supabase-backed goals (cross-device alignment) ────────────────────────
//
// Migration: Selebox/migration_goals_progress.sql. The same Dear Jen
// account → identical state on phone + laptop. localStorage stays as
// a write-through cache so the panel renders instantly on open;
// authoritative state is read from / written to Supabase.

// Pull current-period progress + claim state from Supabase, fold the
// counters into _dailyQuestsState quest rows. Called on panel open.
//
// Codex R1 P1 #4 (H9): capture userId BEFORE the await, bail if the
// auth user changed mid-call. Otherwise the previous user's server
// counters would land in the new user's state.
async function _fetchGoalsFromSupabase() {
  const me = _cfg.getCurrentUser();
  if (!me?.id) return;
  const userId = me.id;
  try {
    const periods = ['daily', 'weekly', 'monthly'];
    const [progressRes, claimsRes] = await Promise.all([
      supabase
        .from('user_goal_progress')
        .select('period, period_key, counters')
        .eq('user_id', userId)
        .in('period', periods),
      supabase
        .from('user_goal_claims')
        .select('period, period_key')
        .eq('user_id', userId)
        .in('period', periods),
    ]);

    // Stale-user guard (H9). Any signed-out / switched-user state
    // mutation below would corrupt the new user's view.
    if (_cfg.getCurrentUser()?.id !== userId) return;

    // Codex Round 2 P1 #3: clear current-period progress + claim flags
    // BEFORE overlaying the server response. Without this, local-cache
    // progress that the server doesn't know about (e.g. period rolled
    // over server-side but local cache is still mid-day, or a multi-
    // device race left local state ahead of server) lingers in the
    // panel. Worst case: stale "5/5 quests" + Claim button that the
    // server immediately rejects with goals_threshold_not_met. The
    // server is authoritative — wipe local-only optimism on every
    // panel-open fetch and let the fetched values rebuild it.
    for (const tab of periods) {
      for (const q of _dailyQuestsState[tab]) q.progress = 0;
    }
    if (_dailyQuestsState.dailyPool)   _dailyQuestsState.dailyPool.claimed   = false;
    if (_dailyQuestsState.weeklyPool)  _dailyQuestsState.weeklyPool.claimed  = false;
    if (_dailyQuestsState.monthlyPool) _dailyQuestsState.monthlyPool.claimed = false;

    if (progressRes.error) {
      console.warn('[goals] fetch progress', progressRes.error.message);
    } else {
      const byPeriod = {};
      for (const row of progressRes.data || []) {
        if (row.period_key === _PERIOD_KEY_FN[row.period]()) {
          byPeriod[row.period] = row.counters || {};
        }
      }
      for (const tab of periods) {
        const counters = byPeriod[tab] || {};
        for (const q of _dailyQuestsState[tab]) {
          if (typeof counters[q.id] === 'number') q.progress = counters[q.id];
        }
      }
    }

    if (claimsRes.error) {
      console.warn('[goals] fetch claims', claimsRes.error.message);
    } else {
      for (const row of claimsRes.data || []) {
        if (row.period_key !== _PERIOD_KEY_FN[row.period]()) continue;
        const poolKey = row.period === 'daily' ? 'dailyPool' : row.period === 'weekly' ? 'weeklyPool' : 'monthlyPool';
        if (_dailyQuestsState[poolKey]) _dailyQuestsState[poolKey].claimed = true;
      }
    }
  } catch (e) {
    console.warn('[goals] fetch fatal', e);
  }
}

// ─── Goal dispatch ─────────────────────────────────────────────────────────
//
// `tickGoal(category, delta)` mirrors mobile's lib/goals-store.js
// export of the same name. Web engagement events (chapter open, video
// minute crossed, like, follow, share, unlock, login) call this
// instead of building their own RPC payload. Each event fans out to
// up to three periods (daily / weekly / monthly) per the
// _QUEST_ID_MAP table — same map mobile uses, kept in sync by hand.

const _QUEST_ID_MAP = {
  login:         { daily: 'login',         weekly: null,              monthly: null              },
  read_chapters: { daily: 'read_chapters', weekly: 'w_read_chapters', monthly: 'm_read_chapters' },
  watch_video:   { daily: 'watch_video',   weekly: 'w_watch_video',   monthly: 'm_watch_video'   },
  like_comment:  { daily: 'like_comment',  weekly: 'w_like_comment',  monthly: 'm_like_comment'  },
  follow_user:   { daily: 'follow_user',   weekly: 'w_follow_users',  monthly: 'm_follow_users'  },
  share:         { daily: null,            weekly: 'w_share',         monthly: 'm_share'         },
  unlock:        { daily: null,            weekly: 'w_unlock',        monthly: 'm_unlock'        },
  watch_ads:     { daily: 'watch_ads',     weekly: 'w_watch_ads',     monthly: 'm_watch_ads'     },
  invite_friend: { daily: 'invite_friend', weekly: 'w_invite_friend', monthly: 'm_invite_friend' },
  purchase_coin: { daily: null,            weekly: 'w_purchase_coin', monthly: 'm_purchase_coin' },
  active_day:    { daily: null,            weekly: null,              monthly: 'm_active30'      },
};

// Bump the matching quest's progress in local state for optimistic UI.
// Cap at the target so we never render "11/10 chapters".
function _optimisticBumpGoal(period, questId, delta) {
  const list = _dailyQuestsState[period];
  if (!Array.isArray(list)) return;
  const q = list.find((x) => x.id === questId);
  if (!q) return;
  q.progress = Math.min((q.progress || 0) + delta, q.target || Infinity);
}

// Public-facing dispatcher. Categories are stable abstract names; the
// underlying quest IDs are the implementation detail tracked in
// _QUEST_ID_MAP. Callers stay simple: `tickGoal('read_chapters')`.
export function tickGoal(category, delta = 1) {
  if (!_cfg.getCurrentUser()?.id) return; // logged-out — no goals
  const map = _QUEST_ID_MAP[category];
  if (!map) { console.warn('[goals] unknown category', category); return; }
  if (!Number.isFinite(delta) || delta === 0) return;
  for (const period of ['daily', 'weekly', 'monthly']) {
    const questId = map[period];
    if (!questId) continue;
    _optimisticBumpGoal(period, questId, delta);
    _fireTickGoalRpc(period, { [questId]: delta });
  }
  // Persist the optimistic state so a quick reload doesn't flicker
  // back to the pre-tick values before _fetchGoalsFromSupabase lands.
  try { _saveDailyQuestsToStorage(); } catch {}
  // Re-render the panel if it's open, so the user watches the bar
  // advance as soon as the event lands.
  try { if (_dailyQuestsPanelOpen) renderDailyQuests(); } catch {}
}

// Deduped tick — used for things like read_chapters where a user
// could re-open the same chapter multiple times in one day; we only
// want the first open to count. Local-only dedup, mirrors mobile's
// SEEN_PREFIX approach. Server-side dedup is a future hardening.
const _GOAL_SEEN_PREFIX = 'selebox_goal_seen_v1';
export function tickGoalUnique(category, uniqueKey, delta = 1) {
  const userId = _cfg.getCurrentUser()?.id;
  if (!userId || !uniqueKey) return false;
  if (!_QUEST_ID_MAP[category]) return false;
  const dayKey = _periodKeyDaily();
  // Codex Round 2 P1 #4: user-scope the dedupe key. Without the
  // userId namespace, User A reading chapter X today would mark
  // X as "seen" in the global key; User B (different account on
  // same browser, e.g. a shared device or developer account
  // switching) would then NOT get credit for reading X. Same key
  // shape mobile uses post-launch.
  const storageKey = `${_GOAL_SEEN_PREFIX}:${userId}:${dayKey}:${category}`;
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(storageKey) || '[]') || []; } catch {}
  if (seen.includes(uniqueKey)) return false;
  seen.push(uniqueKey);
  try { localStorage.setItem(storageKey, JSON.stringify(seen)); } catch {}
  tickGoal(category, delta);
  return true;
}

/**
 * Convenience wrapper for the onSignedIn login tick. Builds the
 * deduped key internally so app.js doesn't need to know the
 * `daily-login:${periodKey}` format.
 *
 * Stage 14 / Codex R1 P1 #5: replaces the inline
 * `tickGoalUnique('login', \`daily-login:${_periodKeyDaily()}\`)` call
 * site in app.js — keeps the semantic API tight and the dedupe key
 * format owned by the goals module.
 */
export function tickDailyLogin(now = new Date()) {
  return tickGoalUnique('login', `daily-login:${_periodKeyDaily(now)}`);
}

// Fire the tick_user_goal RPC for a given (period, deltas) pair.
// Fire-and-forget — local optimistic write already happened, so a
// failed RPC just logs.
async function _fireTickGoalRpc(period, deltas) {
  const me = _cfg.getCurrentUser();
  if (!me?.id) return;
  if (!deltas || Object.keys(deltas).length === 0) return;
  const { error } = await supabase.rpc('tick_user_goal', {
    p_actor_id: me.id,
    p_period: period,
    p_period_key: _PERIOD_KEY_FN[period](),
    p_deltas: deltas,
  });
  if (error) console.warn('[goals] tick rpc', period, error.message);
}

// Atomic claim. Returns the full RPC envelope so callers can surface
// server-side rejections (goals_threshold_not_met,
// required_goal_incomplete, no_progress, …) instead of treating every
// failure as a generic ok:false.
async function _fireClaimGoalPoolRpc(period, reward = { stars: 0, coins: 0 }) {
  const me = _cfg.getCurrentUser();
  if (!me?.id) return { ok: false, error: 'not_signed_in' };
  const { data, error } = await supabase.rpc('claim_user_goal_pool', {
    p_actor_id: me.id,
    p_period: period,
    p_period_key: _PERIOD_KEY_FN[period](),
    p_stars_to_credit: reward.stars || 0,
    p_coins_to_credit: reward.coins || 0,
  });
  if (error) {
    console.warn('[goals] claim rpc', period, error.message);
    return { ok: false, error: error.message || 'network_error' };
  }
  return {
    ok: !!data?.ok,
    alreadyClaimed: !!data?.already_claimed,
    error: data?.ok ? undefined : data?.error,
    stars: data?.stars,
    coins: data?.coins,
    coinBalance: data?.coin_balance,
    starBalance: data?.star_balance,
    completed: data?.completed,
    required: data?.required,
  };
}

// Human-readable mapping for the server error codes returned by
// claim_user_goal_pool. Anything unrecognized falls through to a
// generic "try again" — better to be vague than to render a code
// like 'goals_threshold_not_met' to an end user.
function _friendlyGoalClaimError(code) {
  switch (code) {
    case 'no_progress':
      return "We couldn't find your progress for this period yet. Refresh and try again.";
    case 'goals_threshold_not_met':
      return "Server doesn't see enough goals completed yet. Refresh and try again.";
    case 'required_goal_incomplete':
      return 'You still have a required goal to finish before claiming.';
    case 'missing_actor':
    case 'not_signed_in':
      return 'You need to be signed in to claim. Try signing in again.';
    default:
      return "We couldn't credit your reward right now. Please try again.";
  }
}

// ─── Day strip + panel render ──────────────────────────────────────────────

// Render the day-strip pips. Cadence comes from QUEST_TAB_META so each
// tab gets a different timeline view:
//   • daily   → recent days as "Day N" pips around the current streak
//   • weekly  → recent 5 weeks as "W1..W5"
//   • monthly → recent 6 months as "Jan..Jun"
function _renderQuestsDayStrip() {
  const strip = document.getElementById('questsDayStrip');
  if (!strip) return;
  const meta = QUEST_TAB_META[_dailyQuestsState.activeTab] || QUEST_TAB_META.daily;

  let pips = [];
  if (meta.stripCadence === 'day') {
    // Always show Day 1 through Day 7 — represents the current 7-day
    // cycle. Status mapping based on streak.
    const streak = Math.max(_dailyQuestsState.streak, 0);
    const cappedStreak = streak === 0 ? 0 : ((streak - 1) % 7) + 1; // 1..7
    const showFullWeek = streak >= 7;
    for (let i = 1; i <= 7; i++) {
      let status;
      if (showFullWeek) {
        status = i < cappedStreak ? 'complete' : (i === cappedStreak ? 'today' : 'complete');
      } else if (streak === 0) {
        status = i === 1 ? 'today' : 'future';
      } else {
        if (i < cappedStreak) status = 'complete';
        else if (i === cappedStreak) status = 'today';
        else status = 'future';
      }
      pips.push({ label: 'Day', num: i, status });
    }
  } else if (meta.stripCadence === 'week') {
    for (let i = 0; i < meta.stripCount; i++) {
      const offset = i - (meta.stripCount - 1);
      pips.push({
        label: 'Wk',
        num: meta.stripCount + offset,
        status: offset === 0 ? 'today' : (offset < 0 ? 'complete' : 'future'),
      });
    }
  } else if (meta.stripCadence === 'month') {
    const now = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let i = 0; i < meta.stripCount; i++) {
      const offset = i - (meta.stripCount - 1);
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      pips.push({
        label: months[d.getMonth()],
        num: '',
        status: offset === 0 ? 'today' : (offset < 0 ? 'complete' : 'future'),
      });
    }
  }

  strip.classList.toggle('is-flex', meta.stripCadence !== 'day');

  strip.innerHTML = pips.map((p) => {
    const klass = ['quest-day-pip', `is-${p.status}`].join(' ');
    const mark = p.status === 'complete' ? '<span class="quest-day-pip-mark">✓</span>' : '';
    const num = p.num !== '' ? `<span class="quest-day-pip-num">${p.num}</span>` : '';
    return `<div class="${klass}"><span class="quest-day-pip-label">${p.label}</span>${num}${mark}</div>`;
  }).join('');
}

function renderDailyQuests() {
  const list = document.getElementById('questsList');
  const streakCount = document.getElementById('questsStreakCount');
  const streakBadge = document.getElementById('questsStreakBadge');
  const titleEl = document.getElementById('questsTitle');
  if (!list) return;

  const tab = _dailyQuestsState.activeTab;
  const meta = QUEST_TAB_META[tab] || QUEST_TAB_META.daily;
  const baseQuests = _dailyQuestsState[tab] || [];
  // Featured "Quest of the Day" disabled — the +30 ⭐ daily payout
  // sits outside the budget envelope. Quest definitions are still in
  // _dailyQuestsState.featuredPool for when budget allows reactivating.
  let quests = baseQuests;

  if (titleEl) titleEl.textContent = meta.title;

  if (streakCount) streakCount.textContent = _dailyQuestsState.streak;
  if (streakBadge) {
    streakBadge.textContent = _dailyQuestsState.streak;
    streakBadge.style.display = _dailyQuestsState.streak > 0 ? 'flex' : 'none';
  }

  document.querySelectorAll('.quests-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.questsTab === tab);
  });

  _renderQuestsDayStrip();

  // Premium monochrome currency SVGs — used in the pool reward header
  // and (for invite-friend) the per-quest bonus tag.
  const STAR_SVG = '<svg class="quest-currency-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12,2 14.6,9 22,9.5 16.2,14 17.9,21.5 12,17.5 6.1,21.5 7.8,14 2,9.5 9.4,9"/></svg>';
  const COIN_SVG = '<svg class="quest-currency-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="6.5" fill="rgba(255,255,255,0.35)"/><circle cx="12" cy="12" r="3.5"/></svg>';

  // ─── Pool reward header ──────────────────────────────────────────────
  let poolHeader = '';
  const POOL_KEY_BY_TAB = { daily: 'dailyPool', weekly: 'weeklyPool', monthly: 'monthlyPool' };
  const POOL_TITLE_BY_TAB = { daily: 'Daily Reward', weekly: 'Weekly Reward', monthly: 'Monthly Reward' };
  const POOL_BTN_ID_BY_TAB = { daily: 'dailyPoolClaimBtn', weekly: 'weeklyPoolClaimBtn', monthly: 'monthlyPoolClaimBtn' };
  if (POOL_KEY_BY_TAB[tab]) {
    const pool = _dailyQuestsState[POOL_KEY_BY_TAB[tab]] || { questsRequired: 4, reward: { stars: 0, coins: 0 }, claimed: false };
    const completedCount = quests.filter((q) => q.progress >= q.target).length;
    const required = pool.questsRequired || 4;
    const reachedThreshold = completedCount >= required;
    // Required-quest gate — mirrors the server's claim_user_goal_pool
    // v2 RPC. Quests marked `required: true` MUST be at target before
    // the pool can be claimed, regardless of how many other quests
    // are done. Today only m_active30 (monthly "Stay active 30 days")
    // is required. If we ever add required quests to daily/weekly,
    // this same logic gates them automatically.
    const requiredIncomplete = quests.filter((q) => q.required && q.progress < q.target);
    const hasRequiredBlock = requiredIncomplete.length > 0;
    const isClaimed = !!pool.claimed;
    const stars = pool.reward?.stars || 0;
    const coins = pool.reward?.coins || 0;
    const starWord = stars === 1 ? 'Star' : 'Stars';
    const coinWord = coins === 1 ? 'Coin' : 'Coins';
    const rewardLabel = [
      stars > 0 ? `${stars} ${STAR_SVG} ${starWord}` : '',
      coins > 0 ? `${coins} ${COIN_SVG} ${coinWord}` : '',
    ].filter(Boolean).join(' &nbsp;·&nbsp; ');
    // Action priority:
    //   1. Already claimed → show ✓
    //   2. Required quest still incomplete → tell user which one,
    //      regardless of threshold (a 9/10 user is still blocked
    //      if m_active30 isn't done)
    //   3. Threshold met → enable Claim button
    //   4. Threshold not met → progress counter
    let action;
    if (isClaimed) {
      action = '<span class="quest-pool-claimed">✓ Claimed</span>';
    } else if (hasRequiredBlock) {
      const names = requiredIncomplete.map((q) => q.label).join(', ');
      // Amber styling matches the per-row REQUIRED pill so the user
      // sees the same color when the Claim button is blocked AND on
      // the quest row that's blocking it. Inline style so it renders
      // without new CSS; classes preserved for future styling.
      action = `<span class="quest-pool-progress quest-pool-required-block" style="color:#d97706;font-weight:600;">⚠ Required: ${names}</span>`;
    } else if (reachedThreshold) {
      action = `<button class="quest-pool-claim-btn" id="${POOL_BTN_ID_BY_TAB[tab]}">Claim Reward</button>`;
    } else {
      action = `<span class="quest-pool-progress">${completedCount}/${required} quests</span>`;
    }
    const canClaim = reachedThreshold && !hasRequiredBlock && !isClaimed;
    poolHeader = `
      <div class="quest-pool-header ${canClaim ? 'is-claimable' : ''} ${isClaimed ? 'is-claimed' : ''}">
        <div class="quest-pool-row">
          <div class="quest-pool-meta">
            <div class="quest-pool-title">${POOL_TITLE_BY_TAB[tab]}</div>
            <div class="quest-pool-subtitle">Finish ${required} quests to earn</div>
          </div>
          <div class="quest-pool-reward">${rewardLabel}</div>
        </div>
        <div class="quest-pool-action">${action}</div>
      </div>`;
  }

  // ─── Per-quest rows ──────────────────────────────────────────────────
  const isPoolTab = !!POOL_KEY_BY_TAB[tab];
  const questRows = quests.map((q) => {
    const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
    const isComplete = q.progress >= q.target;
    const isClaimed = !!q.claimed;
    const klass = [
      isClaimed ? 'is-claimed' : (isComplete ? 'is-claimable' : ''),
    ].filter(Boolean).join(' ');

    let actionHtml = '';
    let labelExtras = '';
    if (isPoolTab) {
      // "[Required]" suffix renders inline with the quest title text
      // (e.g. "Stay active 30 days [Required]") — user-confirmed visual
      // 2026-05-17 follow-up. Today only m_active30 shows this, and
      // it telegraphs "this one is mandatory" so the user knows why
      // their 9/10 isn't claimable. Amber tint to draw the eye
      // without being as alarming as red. Class kept so future CSS
      // can restyle if needed.
      const requiredTag = q.required
        ? '<span class="quest-required-tag" style="margin-left:6px;color:#d97706;font-weight:700;font-size:0.85em;">[Required]</span>'
        : '';
      const bonusTag = q.bonus
        ? `<span class="quest-bonus-tag">+${q.bonus.coins || 0} ${COIN_SVG} BONUS</span>`
        : '';
      labelExtras = requiredTag + bonusTag;
    } else {
      const currency = q.currency === 'coin' ? 'coin' : 'star';
      const glyph = currency === 'coin' ? COIN_SVG : STAR_SVG;
      actionHtml = isClaimed
        ? '<span class="quest-claimed-mark">✓</span>'
        : (isComplete
            ? `<button class="quest-claim-btn" data-quest="${q.id}">Claim</button>`
            : `<span class="quest-reward-pill">+${q.reward} ${glyph}</span>`);
    }

    return `
      <div class="quest-item ${klass}" data-quest-id="${q.id}">
        <div class="quest-icon">${QUEST_ICONS[q.icon] || ''}</div>
        <div class="quest-body">
          <div class="quest-label-row">
            <div class="quest-label">${q.label}</div>
            ${labelExtras}
          </div>
          <div class="quest-progress">
            <div class="quest-progress-bar"><div class="quest-progress-fill" style="width:${pct}%"></div></div>
            <div class="quest-progress-label">${q.progress}${q.unit}/${q.target}${q.unit}</div>
          </div>
        </div>
        ${actionHtml ? `<div class="quest-action">${actionHtml}</div>` : ''}
      </div>`;
  }).join('');

  list.innerHTML = poolHeader + questRows;

  // Wire up the pool claim button — works for daily/weekly/monthly.
  const POOL_PERIOD_BY_KEY = { dailyPool: 'daily', weeklyPool: 'weekly', monthlyPool: 'monthly' };

  const wirePoolClaim = (btnId, poolKey) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pool = _dailyQuestsState[poolKey];
      if (!pool || pool.claimed || pool._claiming) return;

      // Defense in depth (Stage 14 follow-up to Codex Round 2): even
      // though renderDailyQuests blocks the Claim button when a
      // required quest is incomplete, a stale-state race could
      // briefly leave the button enabled (e.g. between server fetch
      // and re-render). If we let the RPC fire, server rejects with
      // 'required_goal_incomplete' and the user sees a generic toast.
      // Better to refuse client-side and tell them exactly which
      // required quest is missing.
      const periodTab = POOL_PERIOD_BY_KEY[poolKey] || 'daily';
      const periodQuests = _dailyQuestsState[periodTab] || [];
      const requiredIncomplete = periodQuests.filter((q) => q.required && q.progress < q.target);
      if (requiredIncomplete.length > 0) {
        const names = requiredIncomplete.map((q) => q.label).join(', ');
        toast(`Finish required: ${names}`, 'error');
        return;
      }

      pool._claiming = true;
      const originalLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Claiming…';

      const stars = pool.reward?.stars || 0;
      const coins = pool.reward?.coins || 0;

      // Stage 14 / Codex R1 P1 #4 (H9): capture userId before the
      // await, bail if the user switched mid-claim. Without this, the
      // old user's claim response (success ✓, reward animation) could
      // land in the new user's session.
      const me = _cfg.getCurrentUser();
      const userId = me?.id;

      let result;
      try {
        result = await _fireClaimGoalPoolRpc(
          POOL_PERIOD_BY_KEY[poolKey] || 'daily',
          pool.reward || {}
        );
      } catch (err) {
        result = { ok: false, error: err?.message || 'network_error' };
      }

      // Stale-user guard. If sign-out / user-switch happened during
      // the claim RPC, abort all UI mutations + animations. The
      // server already committed the claim under the original user;
      // their next sign-in will see _fetchGoalsFromSupabase pick it up.
      if (_cfg.getCurrentUser()?.id !== userId) return;

      if (!result?.ok) {
        pool._claiming = false;
        btn.disabled = false;
        btn.textContent = originalLabel;
        toast(_friendlyGoalClaimError(result?.error), 'error');
        return;
      }

      // Codex Round 2 P1 #1: server says it was already settled (e.g.
      // claimed on another tab or the mobile app within the same
      // period). Mark the local pool as claimed + refresh wallet, but
      // SKIP the reward fly animation — the user's balance already
      // contains the previous claim, so showing a fresh "+4 Stars"
      // pop is a lie. Friendly toast tells them what happened.
      if (result.alreadyClaimed) {
        pool.claimed = true;
        pool._claiming = false;
        _saveDailyQuestsToStorage();
        try { await loadWalletState(); } catch (_) { /* non-fatal */ }
        if (_cfg.getCurrentUser()?.id !== userId) return;
        renderDailyQuests();
        toast('Already claimed on another device', '');
        return;
      }

      // Server confirmed a fresh claim.
      pool.claimed = true;
      pool._claiming = false;
      if (stars > 0) _flyRewardToBalance(btn, stars, 'star');
      if (coins > 0) setTimeout(() => _flyRewardToBalance(btn, coins, 'coin'), 180);
      _saveDailyQuestsToStorage();
      // loadWalletState pulls coin_balance / star_balance fresh from
      // the wallets row and re-renders the topbar pill. Without this
      // the user has to wait for the Realtime UPDATE event on
      // wallets, which can lag on flakier networks.
      try {
        await loadWalletState();
      } catch (_) { /* non-fatal */ }
      // Second stale-user guard after the wallet refresh await — the
      // user could sign out between RPC success and wallet refresh.
      // Skip the re-render if so; resetGoalsState already cleared
      // state on their behalf.
      if (_cfg.getCurrentUser()?.id !== userId) return;
      renderDailyQuests();
    });
  };
  wirePoolClaim('dailyPoolClaimBtn', 'dailyPool');
  wirePoolClaim('weeklyPoolClaimBtn', 'weeklyPool');
  wirePoolClaim('monthlyPoolClaimBtn', 'monthlyPool');

  // Streak tick — bump the streak counter when all REGULAR daily quests
  // are claimed. The +25 ⭐ "complete all" bonus is intentionally GONE.
  const regularQuests = quests.filter((q) => !q.isFeatured);
  const allClaimed = regularQuests.length > 0 && regularQuests.every((q) => q.claimed);
  if (allClaimed && !_dailyQuestsState.bonusClaimed && tab === 'daily') {
    _dailyQuestsState.bonusClaimed = true;
    _dailyQuestsState.streak = (_dailyQuestsState.streak || 0) + 1;
    _saveDailyQuestsToStorage();
    setTimeout(renderDailyQuests, 50);
  }
}

// ─── Reset countdown timer ─────────────────────────────────────────────────
// Renders "Resets in Xh Ym" inline next to the streak pill. Updates every
// minute via _scheduleQuestsCountdown.

function _msUntilDailyReset() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return tomorrow - now;
}
function _msUntilWeeklyReset() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
  const daysToMonday = (8 - (day === 0 ? 7 : day)) % 7 || 7;
  const nextMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToMonday, 0, 0, 0, 0);
  return nextMonday - now;
}
function _msUntilMonthlyReset() {
  const now = new Date();
  const firstNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return firstNextMonth - now;
}
function _formatCountdown(ms) {
  if (ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
function _renderQuestsCountdown() {
  const el = document.getElementById('questsCountdown');
  if (!el) return;
  const tab = _dailyQuestsState.activeTab;
  const ms = tab === 'monthly' ? _msUntilMonthlyReset() : (tab === 'weekly' ? _msUntilWeeklyReset() : _msUntilDailyReset());
  el.textContent = `Resets in ${_formatCountdown(ms)}`;
}
function _scheduleQuestsCountdown() {
  _renderQuestsCountdown();
  if (_questsCountdownInterval) clearInterval(_questsCountdownInterval);
  _questsCountdownInterval = setInterval(_renderQuestsCountdown, 60 * 1000);
}

// ─── Flying "+N" reward animation ──────────────────────────────────────────
// Spawns a transient absolute-positioned pill at the claim button's
// location, then transitions it toward the matching topbar wallet pill.
function _flyRewardToBalance(originEl, amount, currency) {
  const isCoin = currency === 'coin';
  const balElId = isCoin ? 'topbarCoinBalance' : 'topbarStarBalance';
  const balEl = document.getElementById(balElId) || document.getElementById('topbarCoinPill');
  const glyph = isCoin ? '🪙' : '⭐';
  if (!originEl) return;
  const originRect = originEl.getBoundingClientRect();
  const targetRect = balEl ? balEl.getBoundingClientRect() : { left: window.innerWidth - 60, top: 20, width: 0, height: 0 };
  const fly = document.createElement('div');
  fly.className = `quest-fly-reward ${isCoin ? 'is-coin' : ''}`;
  fly.textContent = `+${amount} ${glyph}`;
  fly.style.left = `${originRect.left + originRect.width / 2}px`;
  fly.style.top  = `${originRect.top  + originRect.height / 2}px`;
  document.body.appendChild(fly);
  requestAnimationFrame(() => {
    fly.classList.add('is-poppin');
    requestAnimationFrame(() => {
      const dx = (targetRect.left + targetRect.width / 2) - (originRect.left + originRect.width / 2);
      const dy = (targetRect.top  + targetRect.height / 2) - (originRect.top  + originRect.height / 2);
      fly.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.55)`;
      fly.style.opacity = '0';
    });
  });
  setTimeout(() => fly.remove(), 950);
  // Codex Round 2 P1 #2: do NOT mutate balEl.textContent here. The
  // claim handler calls loadWalletState() right after the animation
  // fires — that's the authoritative path that pulls real balances
  // from the wallets row and re-renders the pill via the wallet
  // module's existing render hooks. Double-mutating from here causes
  // a double-display race: if loadWalletState lands BEFORE this 700ms
  // timer (typical on a healthy network), the timer reads the already-
  // updated number and adds `amount` on top, over-stating the balance.
  // Keep only the visual "just-bumped" pulse so the user still gets a
  // confirmatory animation cue without us touching the number.
  setTimeout(() => {
    if (balEl) {
      balEl.classList.add('is-just-bumped');
      setTimeout(() => balEl.classList.remove('is-just-bumped'), 600);
    }
  }, 700);
}

// ─── Panel toggle ──────────────────────────────────────────────────────────

function toggleDailyQuestsPanel() {
  const panel = document.getElementById('dailyQuestsPanel');
  if (!panel) return;
  if (_dailyQuestsPanelOpen) {
    panel.style.display = 'none';
    _dailyQuestsPanelOpen = false;
    if (_questsCountdownInterval) {
      clearInterval(_questsCountdownInterval);
      _questsCountdownInterval = null;
    }
  } else {
    panel.style.display = 'flex';
    _dailyQuestsPanelOpen = true;
    // Render once with the local-cache state for an instant open,
    // then fire the server fetch and re-render with authoritative
    // counters. If the server fetch fails (offline) the local cache
    // remains visible — graceful degradation.
    renderDailyQuests();
    _fetchGoalsFromSupabase().then(() => {
      if (_dailyQuestsPanelOpen) renderDailyQuests();
    });
    _scheduleQuestsCountdown();
  }
}

// ─── Module-load boot wires ────────────────────────────────────────────────

// Initial paint with default state. The user-scoped cache load
// happens later inside initGoals (because the v3 key needs userId
// from the bridge). For the brief window between module load and
// initGoals, the panel renders with zeros — acceptable degradation
// (sub-second on a healthy session).
renderDailyQuests();

document.getElementById('btnDailyQuests')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleDailyQuestsPanel();
});

// Tab-bar clicks switch which quest list is rendered.
document.querySelectorAll('.quests-tab').forEach((tab) => {
  tab.addEventListener('click', (e) => {
    e.stopPropagation();
    _dailyQuestsState.activeTab = tab.dataset.questsTab || 'daily';
    _saveDailyQuestsToStorage();
    renderDailyQuests();
  });
});

// Click outside → close
document.addEventListener('click', (e) => {
  if (!_dailyQuestsPanelOpen) return;
  if (e.target.closest('#dailyQuestsPanel') || e.target.closest('#btnDailyQuests')) return;
  const panel = document.getElementById('dailyQuestsPanel');
  if (panel) panel.style.display = 'none';
  _dailyQuestsPanelOpen = false;
});
