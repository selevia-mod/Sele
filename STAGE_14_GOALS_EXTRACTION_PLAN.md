# Stage 14 — Goals + Pool-Claim extraction plan

**Goal:** Move the daily/weekly/monthly quest system (tickGoal API, panel render, pool-claim flow, goal RPCs) out of `js/app.js` into a new owner module `js/goals.js`.

**Net app.js cut:** ~1,010 lines (7979-8989 minus the small set of app.js-resident callers that import the API back).

**Why a new module:** Goals is a self-contained system — its own state shape (`_dailyQuestsState`), its own RPCs (`tick_user_goal`, `claim_user_goal_pool`), its own panel UI, its own localStorage cache. `wallet.js` keeps its existing `tickGoalUnique` bridge (it receives the imported goals function via `app.js`'s `initWallet({ tickGoalUnique })` call — no change to wallet.js in this commit, see H1 for the rationale).

---

## Surface map (what's moving)

### State (4 module-private)

| App.js line | Symbol | Notes |
|---|---|---|
| 8017-8245 | `_dailyQuestsState` | Big object — streak, dayHistory (dead — see H7), daily[], weekly[], monthly[], the 3 pool configs, activeTab, featuredQuest, `_persistKey`, etc. |
| 8533 | `let _dailyQuestsPanelOpen` | UI toggle flag |
| 8880 | `let _questsCountdownInterval` | setInterval handle for the "Resets in N:NN:NN" header |
| 8397 | `const _QUEST_ID_MAP` | Maps category name → server quest_id per period |
| 8447 | `const _GOAL_SEEN_PREFIX` | localStorage key prefix used by tickGoalUnique's per-key dedupe set |

### Period-key helpers (3 + 1 lookup map)

| App.js line | Symbol |
|---|---|
| 8308 | `_periodKeyDaily` |
| 8310 | `_periodKeyWeekly` (ISO week — shared with mobile) |
| 8322 | `_periodKeyMonthly` |
| 8325 | `_PERIOD_KEY_FN` (period name → key fn) |

### Server I/O (5)

| App.js line | Symbol |
|---|---|
| 8330 | `async _fetchGoalsFromSupabase()` |
| 8465 | `async _fireTickGoalRpc(period, questId, delta)` — server side of tickGoal/tickGoalUnique |
| 8487 | `async _fireClaimGoalPoolRpc(period, reward)` |
| 8249 | `_loadDailyQuestsFromStorage()` |
| 8282 | `_saveDailyQuestsToStorage()` |
| 8413 | `_optimisticBumpGoal(period, questId, delta)` — local-state bump that wraps the RPC fire |

### Public API (2)

| App.js line | Symbol | Exported |
|---|---|---|
| 8424 | `function tickGoal(category, delta=1)` | ✓ (app.js + 5 other modules call this) |
| 8448 | `function tickGoalUnique(category, uniqueKey, delta=1)` | ✓ (same) |

### Render + UI (8)

| App.js line | Symbol |
|---|---|
| 8209 | `const QUEST_TAB_META` — tab labels / aria text per period |
| 8215 | `const QUEST_ICONS` — icon → inline-SVG mapping |
| 8231 | `function _featuredQuestForToday()` — picks the rotating featured quest |
| 8542 | `function _renderQuestsDayStrip()` — 7-day pip strip in the panel header |
| 8608 | `function renderDailyQuests()` |
| 8881 | `function _scheduleQuestsCountdown()` |
| 8892 | `function _flyRewardToBalance(originEl, amount, currency)` — animation helper |
| 8926 | `function toggleDailyQuestsPanel()` |

### Countdown helpers (4)

| App.js line | Symbol |
|---|---|
| 8846 | `function _msUntilDailyReset()` |
| 8851 | `function _msUntilWeeklyReset()` |
| 8858 | `function _msUntilMonthlyReset()` |
| 8863 | `function _formatCountdown(ms)` |
| 8873 | `function _renderQuestsCountdown()` |

### Other helpers (1)

| App.js line | Symbol |
|---|---|
| 8517 | `function _friendlyGoalClaimError(code)` |

### Boot wires (moving to goals.js module-load)

1. Line 8757-8818: `wirePoolClaim` + 3 bindings (`dailyPoolClaimBtn`, `weeklyPoolClaimBtn`, `monthlyPoolClaimBtn`)
2. Line 8963: `_loadDailyQuestsFromStorage()` initial load
3. Line 8964: `renderDailyQuests()` initial paint
4. Line 8966: `btnDailyQuests` click → `toggleDailyQuestsPanel`
5. Line 8974: `.quests-tab` clicks (3 tabs: daily/weekly/monthly)
6. Line 8983: document-level click-outside-to-close

---

## What stays in app.js (intentionally not moving)

| App.js line | What | Why |
|---|---|---|
| 1075-1076 | `tickDailyLogin();` | onSignedIn caller — replaces the 2-line dedupe-key construction with a semantic wrapper exported from goals.js (Codex R1 P1 #5) |
| 7523-7546 | `tickGoal('watch_video', 1);` (×2 sites) | Video player engagement ticks |
| 599 | bridge config: `tickGoalUnique` → wallet.js | Cross-module bridge |
| 699 | bridge config → engagement.js | Same |
| 718 | bridge config → books.js | Same |
| 829 | bridge config → feed.js | Same |
| 925-926 | bridge configs → profile.js (`tickGoal` + `tickGoalUnique`) | Same |

App.js imports `tickGoal` + `tickGoalUnique` + `tickDailyLogin` + `resetGoalsState` back from goals.js so all 7 sites above still work without code changes, plus signOut() gets a state-reset hook (see H8 below).

**Design choice:** `tickDailyLogin()` is exported as a thin convenience wrapper that internally constructs the dedupe key. App.js calls `tickDailyLogin()` instead of `tickGoalUnique('login', \`daily-login:${periodKeyDaily()}\`)`. Smaller external surface, no `periodKeyDaily` export needed, and the dedupe semantics live with the goals owner module instead of being duplicated at the call site.

---

## Bridge contract (1 function, simplest yet)

```js
// app.js (inside onSignedIn)
initGoals({ getCurrentUser: () => currentUser });
```

That's it. Goals doesn't need `hideAllMainPages` (no full-page nav), doesn't need `setSidebarActive` (no sidebar entry), doesn't need `signOut`. The only thing it can't observe directly is the current user — and it needs that for every RPC call.

### Direct imports (no bridge)

```js
// goals.js
import { supabase, toast } from './supabase.js';
import { loadWalletState } from './wallet.js';
```

`loadWalletState` is called from the pool-claim handler so the topbar balance pill refreshes immediately after a successful claim (not waiting for Realtime).

---

## App.js wiring (final state)

```js
// Imports near other module imports
import {
  initGoals,
  tickGoal, tickGoalUnique,
  tickDailyLogin,
  resetGoalsState,
} from './goals.js';

// Inside onSignedIn, AFTER initWallet + initStore (Goals doesn't depend
// on either, but order is consistent: init-then-use modules first):
initGoals({ getCurrentUser: () => currentUser });

// Inside signOut, alongside resetWalletState (Codex R1 P1 #2 — user-
// scoped quest progress was leaking across same-browser session
// changes because the localStorage key was global and _dailyQuestsState
// was never reset on sign-out):
resetGoalsState();
```

**Net app.js delta:** ~1,010 lines deleted, ~15 added (import block + initGoals call + resetGoalsState call + tombstone comment).

**Wallet.js: UNCHANGED in this commit.** Codex R1 P1 #1 confirmed: keep the existing `_cfg.tickGoalUnique` bridge in `initWallet`. App.js passes the imported `tickGoalUnique` from goals.js into the bridge config — wallet.js code at lines 657 + 1205 keeps calling `_cfg.tickGoalUnique(...)` with zero changes. This avoids coupling wallet.js to goals.js with a circular import. The bridge is functionally redundant but the cleanup is deferred to a follow-up commit.

**Final app.js after 13B + 14:** Currently 9,422. After 14: ~8,420.

---

## Hazards (P0/P1)

### H1 (P0) — Avoid the wallet.js ↔ goals.js circular import

**Decision (locked by Codex R1 P1 #1):** Wallet.js is **NOT touched in this commit**. The existing `_cfg.tickGoalUnique` bridge stays. App.js continues to pass the imported `tickGoalUnique` (now from goals.js instead of being defined inline) into `initWallet({tickGoalUnique})`. Goals.js imports `loadWalletState` from wallet.js — this is a one-way dependency, no cycle.

Codex confirmed the cycle would be technically safe (both directions are call-time-only), but flagged that coupling wallet.js to goals.js in this commit isn't worth the risk. The "direct import + dead bridge" belt-and-suspenders option from earlier drafts is explicitly rejected. If we want to retire the wallet bridge later, that's a separate Stage 14-cleanup commit with its own audit.

### H2 (P0) — Boot ordering: `_loadDailyQuestsFromStorage` + `renderDailyQuests` at module load

App.js currently runs these at line 8963-8964 (module-load time, after auth is mounted). Goals.js will run them at its own module-load time.

`_loadDailyQuestsFromStorage` reads localStorage (no user dep). `renderDailyQuests` reads the in-memory `_dailyQuestsState` (no user dep). Both are safe pre-`initGoals`.

**Mitigation:** None needed. Document in comment.

### H3 (P0) — `_fetchGoalsFromSupabase` race with auth

The panel-open handler (`toggleDailyQuestsPanel`) calls `_fetchGoalsFromSupabase` which needs `getCurrentUser`. If the user clicks `btnDailyQuests` before `initGoals` is called, the fetch silently bails (no-op getter returns null). Acceptable degradation.

**Mitigation:** None needed. The local-cache render still happens; only the server-counter refresh is skipped.

### H4 (P1) — `_flyRewardToBalance` reads from the DOM (topbar pill ids)

The animation helper picks the destination based on `topbarCoinBalance` / `topbarStarBalance` DOM ids. These are static HTML, always present. No risk.

### H5 (P1) — `tickGoal` / `tickGoalUnique` are called from 5 other modules via bridge

Wallet, books, engagement, feed, profile all receive `tickGoalUnique` as part of their initX bridge config. After Stage 14:
- App.js imports `tickGoalUnique` from goals.js
- App.js passes it into the 5 init bridges (no change to the init calls)
- Each module continues calling `_cfg.tickGoalUnique(...)` (no change to call sites)

Confirm by grep that all 5 modules access tickGoalUnique only through `_cfg.tickGoalUnique` (not directly). Stage 13 survey already verified this.

### H6 (P1) — `_periodKeyDaily` exported under a public name

I'm renaming it `periodKeyDaily` on export (dropping the underscore — the underscore convention is for module-private functions). The import in app.js becomes `periodKeyDaily`. Inside goals.js, the local function stays `_periodKeyDaily`. ES modules let you do `export { _periodKeyDaily as periodKeyDaily };` cleanly.

### H7 (P2) — `_dailyQuestsState.dayHistory` is dead legacy

Codex R1 P2 #6 verified: `dayHistory` (lines 8184-8189) is no longer read by the renderer. `_renderQuestsDayStrip` (line 8542) derives the strip from `_dailyQuestsState.streak` directly, and `streak` itself is hardcoded to 0 (line 8024 + load/save deliberately skip persisting it). The hand-seeded streak comment is stale.

**Action:** Drop `dayHistory` from `_dailyQuestsState` entirely during the extraction. The day-strip render path is unaffected. One less thing to carry forward.

### H8 (P0) — User-scoped state reset on sign-out (Codex R1 P1 #2)

`_dailyQuestsState` is module-private and the localStorage key (`_persistKey: 'daily_quests_demo_state_v2'`, line 8197) is **global**, not user-scoped. Today on the same browser, signing out as User A and signing in as User B leaks A's quest progress into B's first panel open (until `_fetchGoalsFromSupabase` overwrites). Worse, B's localStorage save then OVERWRITES the global key with B's state, corrupting A's cache for later.

**Two fixes, both in goals.js:**

1. **Export `resetGoalsState()`** that zeros `_dailyQuestsState` to defaults (re-initializing the daily/weekly/monthly arrays, clearing claim flags, clearing `_questsCountdownInterval`). App.js calls it from `signOut()` immediately after `resetWalletState()`.

2. **Make localStorage user-scoped.** `_loadDailyQuestsFromStorage` / `_saveDailyQuestsToStorage` switch to `daily_quests_state_v3:${userId}` (note: v3 to invalidate the old global cache, since v2 entries can't be safely attributed). `initGoals()` calls `_loadDailyQuestsFromStorage` AFTER the getter is wired (so we have the userId) and triggers a render.

   **Tradeoff:** the current code does `_loadDailyQuestsFromStorage()` at module load (line 8963), pre-auth. With user-scoped keys, that load now waits for `initGoals` to fire. Panel-open before initGoals would render with defaults instead of cached state. Acceptable — that window is sub-second on a healthy session.

### H9 (P1) — Async stale-user guard on every state mutation after an await (Codex R1 P1 #4)

`_fetchGoalsFromSupabase` and the pool-claim handler both `await` server calls and then mutate `_dailyQuestsState`, write localStorage, animate rewards, and re-render. After H8 lands, the same race the migration handler had in store.js (Codex R2 P1) applies here: user signs out / switches mid-call, the old user's response lands in the new user's state.

**Implementation requirement:** capture `userId = _cfg.getCurrentUser()?.id` BEFORE every await. After each await, before any state mutation, re-check `_cfg.getCurrentUser()?.id === userId` and bail if not. Covers:
- `_fetchGoalsFromSupabase`: 1 await (the parallel `supabase.rpc/from` call).
- `wirePoolClaim` handler: 2 awaits (`_fireClaimGoalPoolRpc`, `loadWalletState`).
- `_fireTickGoalRpc`: 1 await — but it's fire-and-forget and doesn't mutate state on response (just logs on error), so no guard needed.

---

## Codex audit checkpoints

Same pattern as 13A/13B:

1. **Round 1: plan audit** (this doc) — optional, user's call.
2. **Round 2: goals.js code audit** — required.
3. **Round 3: app.js wiring diff audit** — user's call.

---

## Estimated cuts

- `js/app.js`: 9,422 → ~8,420 lines (–1,002)
- `js/goals.js`: 0 → ~1,030 lines (new file, includes header comment + initGoals + bridge plumbing + tombstone-comment-friendly structure)
- `js/wallet.js`: 1,211 lines (unchanged — Hazard H1 fallback decision)

---

## Codex Round 1 audit — answers folded into the plan above

All 7 findings addressed:

| # | Severity | Resolution |
|---|---|---|
| 1 | P1 | Locked H1: wallet.js stays unchanged; bridge stays; rewrote "Why" + H1 to remove the contradiction. |
| 2 | P1 | Added H8 — `resetGoalsState()` export + user-scoped localStorage key (`v3:${userId}`). Wired into signOut next to `resetWalletState`. |
| 3 | P1 | Surface map now includes `QUEST_TAB_META`, `QUEST_ICONS`, `_featuredQuestForToday`, `_optimisticBumpGoal`, `_GOAL_SEEN_PREFIX`, `_fireTickGoalRpc`, `_renderQuestsDayStrip`, `_msUntilDailyReset` × weekly × monthly, `_formatCountdown`, `_renderQuestsCountdown`. |
| 4 | P1 | Added H9 — capture `userId` before every await, bail before mutating state on stale-user. |
| 5 | P1 | Switched to `tickDailyLogin()` semantic wrapper. No `periodKeyDaily` export needed. |
| 6 | P2 | Rewrote H7 — `dayHistory` is dead code; drop it during extraction. |
| 7 | P2 | Module name stays `js/goals.js` (Codex agreed). |
