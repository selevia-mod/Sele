# Stage 13 — Coin Shop + Wallet extraction plan

> **Status: Revised after Codex audit (2026-05-17).** All P0/P1 findings folded in below.
> Original plan kept for context; revisions called out with **[Codex]** tags.

---

**Goal:** Move ~500-600 lines of Coin Shop, Wallet, Unlocks, and Video Monetization Gate logic out of `js/app.js` into a new owner module `js/wallet.js`. Same pattern as prior stages (notifications, composer, profile, feed, books, messages, search, earnings, engagement, studio, videos, scheduled-posts).

**Status:** Plan only — NOT yet implemented. Audit this before we write any code so we can fix the bridge contract / risk surface before locking in.

---

## Why split into 13A + 13B

Total extraction is ~500 lines + 60+ functions + 5 cross-module callers + 1 realtime channel + 1 in-flight guard + 1 sign-out cleanup site. Too big for one safe commit. Same pattern as Stage 11A/B/C and Stage 8A/B.

### Stage 13A — Foundation (~250 lines)

Wallet state + unlocks + paywall dialogs + video monet gate. **Other modules depend on these bridges**, so this MUST land first.

### Stage 13B — Store + History (~350 lines)

Self-contained UI: Store page, HitPay payment flow, wallet history modal, ad-reward stub, migration banner. Nothing else in the codebase imports from these.

Each phase is its own commit + smoke test before the next.

---

## Stage 13A — Surface to extract

### Module-scoped state (currently in app.js around lines 390-410)

| State | Type | Purpose | Ownership after |
|---|---|---|---|
| `_wallet` | `{coin_balance, star_balance}` | Live balance, mutated by realtime + unlock RPCs | wallet.js owns; bridge `getWallet()` returns it for sign-out reset |
| `_userUnlocks` | `Set<string>` | Keys like `chapter:<id>`, `video:<id>` | wallet.js owns; cleared via `resetWalletState()` on sign-out |
| `_walletConfigDefaults` | `object` | app_config overrides (default unlock costs, monet windows, etc.) | wallet.js owns; `getWalletConfig()` bridge exposes it to books.js |
| `_walletChannel` | Realtime channel | Subscribes to my wallets row UPDATE | wallet.js owns; `teardownWallet()` called from sign-out |
| `_unlockInFlight` | `boolean` | Guards double-tap on unlock dialogs | wallet.js owns (internal-only) |

### Functions to move (with current line ranges)

| Function | Lines | Purpose |
|---|---|---|
| `loadWalletState()` | 1244-1279 | Parallel fetch wallet + unlocks + app_config + subscribe to realtime |
| `renderTopbarCoinPill()` | 1281-1286 | Update topbar coin + star spans |
| `formatBalance()` | 1288-1293 | 1234 → "1,234", 12.3M, etc. |
| `normalizeUnlockTargetId()` | 1303-1307 | Strip `sb_` prefix from video ids before _userUnlocks lookup |
| `markUnlocked()` | 1311-1314 | Add to `_userUnlocks` Set |
| `isUnlocked()` | 1317-1320 | Lookup in `_userUnlocks` Set |
| `resolveUnlockCost()` | 1323-1333 | Per-row override → app_config default |
| `openUnlockDialog()` | 1338-1453 | Premium unlock modal (coin / star) for chapters + videos |
| `setupVideoMonetGate()` | 1466-1550 | Attach time-based paywall listener to player |
| `teardownVideoMonetGate()` | 1551-1560 | Cleanup listener |
| `openVideoMonetThresholdDialog()` | 1561-1700 | Time-threshold paywall modal (1 coin permanent / 1 star 10-min window) |
| `openBulkBookUnlockDialog()` | 1906-2075 | Whole-book unlock modal |
| `_handleUnlockFailure()` | TBD (needs grep) | Toast handler for unlock RPC errors — called by both openUnlockDialog + openBulkBookUnlockDialog |
| `_videoMonetGate` (state var) | 1464 | Active listener registry; one per player at a time |

### Functions to KEEP in app.js (out of scope for 13A)

- `showStore()`, `loadStorePacks()`, `purchasePack()`, `handleStoreReturn()` → **Stage 13B**
- `openWalletHistory()`, `loadWalletHistory()`, `closeWalletHistory()` + helpers (_walletHistoryClaimTitle, _formatWalletHistoryTime, _walletHistoryDateKey, _walletCurrencyIconSvg, _walletHistoryIconFor) → **Stage 13B**
- `refreshMigrateBanner()`, `renderStoreBalances()` → **Stage 13B**
- `renderStoreAdProgress()`, `playRewardedAd()` → **Stage 13B**

---

## Proposed `initWallet({...})` bridge contract

What app.js will pass to wallet.js's `initWallet` at boot:

```js
initWallet({
  // Identity (read-only, called per-render so wallet.js always sees live value)
  getCurrentUser:          () => currentUser,

  // Engagement counter (Goals module; openUnlockDialog ticks 'unlock' on success)
  tickGoalUnique,

  // Confirm dialog (used by openBulkBookUnlockDialog for the "are you sure?" step)
  confirmDialog,
});
```

**Notes on the bridge:**

- `supabase` is imported directly in wallet.js (same as books.js, feed.js, etc. — it's a top-level import from `./supabase.js`, not a bridge)
- `toast` same as above (top-level import)
- `escHTML` same — top-level import
- `_handleUnlockFailure` — internal to wallet.js, NOT a bridge

### What wallet.js exports (for app.js + other modules)

```js
export function initWallet(config) { ... }                  // Boot wiring
export async function loadWalletState() { ... }             // Called by app.js on signin
export function teardownWallet() { ... }                    // Called by app.js sign-out
export function resetWalletState() { ... }                  // Called by app.js sign-out (after teardown)
export function renderTopbarCoinPill() { ... }              // Called by Stage 13B (renderStoreBalances patches it)
export function getWallet() { ... }                         // Read-only accessor for Stage 13B + admin debugging
export function getWalletConfig() { ... }                   // Bridge target for books.js + others
export function isUnlocked(targetType, targetId) { ... }    // Bridge target for feed.js + videos.js + books.js
export function markUnlocked(targetType, targetId) { ... }  // Bridge target for caller-driven updates (rare)
export function resolveUnlockCost(...) { ... }              // Bridge target for feed.js + videos.js + books.js
export function openUnlockDialog({...}) { ... }             // Bridge target for feed.js + videos.js + books.js
export function openBulkBookUnlockDialog({...}) { ... }     // Bridge target for books.js
export function setupVideoMonetGate(player, sbId, video) { ... }    // Bridge target for videos.js
export function teardownVideoMonetGate(player) { ... }              // Bridge target for videos.js
```

---

## Cross-module wiring updates (in app.js)

Each `init*` call in app.js currently passes wallet bridges as inline closures or direct function refs. After Stage 13A, these change from referring to local app.js functions → referring to the wallet.js exports.

| Module | What changes |
|---|---|
| `initBooks({...})` line 753-793 | `getWalletConfig`, `openUnlockDialog`, `openBulkBookUnlockDialog`, `isUnlocked`, `resolveUnlockCost` — all reference wallet.js exports now |
| `initFeed({...})` | Same 4 bridges + `getWalletConfig` |
| `initVideos({...})` | Same 4 + `setupVideoMonetGate`, `teardownVideoMonetGate` |
| `initEngagement({...})` | Whatever wallet bridges it uses (TBD: grep `_cfg.openUnlockDialog`, `_cfg.isUnlocked`, etc. in engagement.js) |
| `initEarnings({...})` | `getWalletConfig` — earnings reads `_walletConfigDefaults` for hold-days copy |
| `initBooks` bridge `tickGoalUnique` | unchanged (still owned by app.js since Goals is Stage 14) |

**Action:** the imports at the top of app.js gain:

```js
import {
  initWallet, loadWalletState, teardownWallet, resetWalletState,
  renderTopbarCoinPill, getWallet, getWalletConfig,
  isUnlocked, markUnlocked, resolveUnlockCost,
  openUnlockDialog, openBulkBookUnlockDialog,
  setupVideoMonetGate, teardownVideoMonetGate,
} from './wallet.js';
```

And every `initX({...})` block that previously passed `() => _walletConfigDefaults` now passes `getWalletConfig` directly (since it's an exported function, no closure needed).

---

## Sign-out cleanup (line 1198)

**Before:**
```js
teardown(_walletChannel);
_walletChannel = null;
// ...
_wallet = { coin_balance: 0, star_balance: 0 };
_userUnlocks.clear();
```

**After:**
```js
teardownWallet();    // tears down channel
resetWalletState();  // clears _wallet, _userUnlocks
```

Both exported from wallet.js. This mirrors Stage 1's `teardownNotifications()` pattern.

---

## Hazards & mitigations

### H1: `_walletChannel` leak across signin/signout (P0)

Same shape as the Stage 1 `_notifChannel` leak. If sign-out runs but wallet.js still has a live channel, callbacks fire into stale state and the next user briefly sees the previous user's balance.

**Mitigation:** `teardownWallet()` is exported and called from app.js's sign-out BEFORE `auth.signOut()`. Codex should verify this ordering matches the existing pattern at line 1192-1213.

### H2: `_handleUnlockFailure` is shared internal helper (P1)

Currently in app.js, called by both `openUnlockDialog` AND `openBulkBookUnlockDialog`. Must move WITH the dialogs to wallet.js as a module-private function. If we move only one dialog, the other will fail to find the helper.

**Mitigation:** Move both dialogs in the same commit. Grep for `_handleUnlockFailure` to confirm it's not called from anywhere else.

### H3: `renderStoreBalances` patches `renderTopbarCoinPill` via function replacement (P1)

Line 2607 (Stage 13B territory) does:
```js
const _origRenderTopbar = renderTopbarCoinPill;
renderTopbarCoinPill = function() { _origRenderTopbar(); /* + store cards */ };
```

After 13A, `renderTopbarCoinPill` is an immutable ES module export — can't be re-assigned. The Store balance cards won't auto-update on realtime.

**Mitigation:** In 13B (when we extract `renderStoreBalances`), switch to a registration pattern: wallet.js exports `onWalletChange(callback)`, Store-page code registers a callback. Document this in 13B plan.

### H4: `_unlockInFlight` is a guard, not a state ownership concern (P2)

Module-private boolean. No bridge needed. Just move with the dialogs.

### H5: Video monet gate has timer + listener cleanup (P2)

`_videoMonetGate` is a `{videoId, listener}` registry. `teardownVideoMonetGate(player)` removes the listener AND clears the registry. Must be called from videos.js's player teardown path. If we forget to call it on player nav-away, the listener leaks and the next video's `timeupdate` events fire the WRONG video's threshold check.

**Mitigation:** Confirm videos.js still calls `teardownVideoMonetGate(player)` on its existing player teardown path. Verify by grepping `teardownVideoMonetGate` in videos.js after extraction.

### H6: `loadWalletState` is called from app.js boot (P2)

After extraction, app.js still needs to call `loadWalletState()` after signin completes. The import is straightforward but the call site (somewhere around the auth state listener) must be updated.

**Mitigation:** Codex should verify the call site survives the import switch.

### H7: Realtime subscription `filter` interpolation (P3)

`filter: \`user_id=eq.${currentUser.id}\`` — uses `currentUser` directly. After extraction, wallet.js will read this via `_cfg.getCurrentUser()` inside `loadWalletState`. Verify the filter string captures the value at subscribe time, not later.

**Mitigation:** Standard pattern — already done in notifications.js and messages.js. Just verify visually.

### H8: `formatBalance` is internal-only (P3)

Only `renderTopbarCoinPill` calls it. Doesn't need to be exported. Keep as module-private.

---

## Cross-module callers — verification queries Codex should run

Codex: run these greps after extraction to verify no caller is left dangling:

```bash
# Should return ONLY the export inside js/wallet.js — no other refs
grep -rn "openUnlockDialog" js/
grep -rn "openBulkBookUnlockDialog" js/
grep -rn "setupVideoMonetGate" js/
grep -rn "isUnlocked" js/
grep -rn "resolveUnlockCost" js/

# Should NOT appear in app.js (the state belongs to wallet.js now)
grep -n "_wallet\b" js/app.js
grep -n "_userUnlocks" js/app.js
grep -n "_walletConfigDefaults" js/app.js
grep -n "_walletChannel" js/app.js
grep -n "_unlockInFlight" js/app.js
grep -n "_videoMonetGate" js/app.js

# In other modules, should reference the bridge object (_cfg.X) OR
# import from wallet.js directly
grep -n "openUnlockDialog\|isUnlocked\|resolveUnlockCost" js/books.js js/feed.js js/videos.js js/engagement.js
```

---

## What we're NOT changing in 13A

- The unlock RPC payload shape (`unlock_content` server function — unchanged)
- The bulk-unlock RPC payload shape (`unlock_book_bulk` — unchanged)
- The video monet RPCs (unchanged)
- The realtime channel name (`wallet-${user.id}`) — unchanged
- The CSS classes (`.unlock-modal`, `.unlock-option`, `.unlock-modal-backdrop`) — unchanged
- DOM IDs (`#topbarCoinBalance`, `#topbarStarBalance`) — unchanged

So no DB, no HTML, no CSS edits — pure JS refactor.

---

## Open questions for Codex

1. **Should `renderTopbarCoinPill` be an export, or should wallet.js notify subscribers via a `onWalletChange()` registration?** Stage 13B's `renderStoreBalances` needs to chain on top. Picking the wrong abstraction in 13A means refactoring it again in 13B.

2. **Is `_handleUnlockFailure` ONLY called by the two dialogs, or also by lower-level unlock code (e.g. an inline unlock from a "1-tap unlock" button somewhere)?** If yes, those callers need updating too.

3. **Does engagement.js currently call any wallet bridge?** If yes, the engagement.js `initEngagement({...})` bridge in app.js needs updating. If no, no change needed.

4. **Where does `loadWalletState()` get called from at boot?** Grep `loadWalletState` in app.js — needs to be either auth-state listener or post-signin handler. The call site must survive the import switch.

5. **The bulk-unlock dialog (line 1906) — does it have any dependencies on Stage 13B Store code?** (e.g. does it open the Store on "not enough coins"?) If yes, 13A needs to keep the navigation surface intact via a bridge to `showStore()`.

6. **Realtime channel filter — `user_id=eq.${currentUser.id}`. If currentUser changes between subscribe and message, do we leak the old subscription?** loadWalletState already calls `removeChannel(_walletChannel)` before re-subscribing — confirm this still works correctly when called from wallet.js.

---

## After Stage 13A lands

1. Hard-refresh selebox.com → confirm topbar coin/star pill shows correct balance
2. Open any chapter that's locked → confirm paywall modal appears, both currency buttons work, unlock RPC fires
3. Open any video that's paid past 180s → confirm threshold modal appears at 180s
4. Open a book with mixed locked/unlocked chapters → confirm bulk unlock dialog shows correct count + price
5. Sign out + sign in as a different user → confirm topbar shows the NEW user's balance (no leak from H1)
6. Sign out + check console for any `_walletChannel` warnings

If all 6 smoke pass, Stage 13B can start.

---

## Codex: please audit

- The `initWallet` bridge contract (above)
- The H1-H8 hazards + mitigations
- The 6 open questions
- Whether the 13A/13B split is correctly drawn

After your sign-off we'll write the actual js/wallet.js + app.js edits.

---

# REVISIONS AFTER CODEX AUDIT (2026-05-17)

## P0-fix-1 — `onWalletChange(callback)` must be in 13A, NOT 13B

H3 was wrong to defer. After 13A, `renderTopbarCoinPill` becomes an ES module import — those are immutable read-only bindings. The existing monkey-patch at `js/app.js:2607` (`renderTopbarCoinPill = function() { ... }`) will throw `TypeError: Assignment to constant variable` AT MODULE EXECUTION TIME. Site fails to boot.

**Mitigation:**
- `js/wallet.js` exports a `onWalletChange(callback)` registration API in 13A. Internal subscribers list; `renderTopbarCoinPill` and any other internal renderer push first, then iterate registered callbacks.
- `js/app.js:2607` (which is part of 13B's Store code but living in app.js today) gets refactored IN THIS 13A COMMIT to use `onWalletChange(() => renderStoreBalances())` instead of monkey-patching. `renderStoreBalances` itself stays in app.js for now, only the wiring changes.

## P0-fix-2 — Move the WHOLE unlock helper cluster

In addition to `_handleUnlockFailure`, these MUST move to wallet.js with the dialogs:

| Helper | Line | What |
|---|---|---|
| `_UNLOCK_ERROR_REGISTRY` | 1694 | Mapping of server error codes → user-facing copy + recovery path |
| `_interpretUnlockError` | 1729 | Turns RPC error/data into a UI decision (toast, modal, retry) |
| `_submitUnlockRecoveryRequest` | 1769 | Files an admin recovery request when unlock charges fail post-RPC |
| `_verifyBulkUnlockPersistence` | 1821 | Post-bulk-unlock sanity check that the rows actually landed |
| `_previewBookBulkUnlock` | 1881 | Computes the bulk-unlock cost preview shown in the bulk dialog header |

All five are dialog-internal. None are called from any other module — so they stay module-private in wallet.js (no exports).

## P0-fix-3 — `_walletConfigDefaults` is also read DIRECTLY in app.js

Codex flagged three sites in app.js (lines 5835, 8083, 8381) that read `_walletConfigDefaults.X` directly — likely for chapter-publish word-count gates (`min_chapter_words`, `max_chapter_words`). After extraction these will be ReferenceErrors.

**Mitigation in 13A:**
- Add `getWalletConfig()` to app.js's local scope as `const getWalletConfig = (await import('./wallet.js')).getWalletConfig;` — but actually no, ES imports are top-level.
- The cleanest fix: at the top of app.js (alongside the other wallet.js imports), keep a thin local alias:
  ```js
  import { ..., getWalletConfig } from './wallet.js';
  ```
- Then those three direct-reader sites become `getWalletConfig().min_chapter_words` etc.
- This is a 3-line touch-up inside this same commit.

## P1-fix-1 — Cross-module wiring table (corrected)

| Module | Wallet bridges it needs |
|---|---|
| `initBooks({...})` | `getWalletConfig`, `openUnlockDialog`, `openBulkBookUnlockDialog`, `isUnlocked`, `resolveUnlockCost` |
| `initFeed({...})` | `getWalletConfig`, `isUnlocked`, `resolveUnlockCost`, `openUnlockDialog` ← need to verify per file |
| `initStudio({...})` (line 612) | `getWalletConfig` — chapter editor reads min/max word counts |
| `initEarnings({...})` | `getWalletConfig` — `.author_earnings_hold_days` for hold-day copy |
| ~~`initVideos({...})`~~ | **No wallet bridges currently.** `playVideo` + paywall live in app.js still. Don't add bridges here in 13A. |
| ~~`initEngagement({...})`~~ | **No wallet bridges.** Don't add. |

`setupVideoMonetGate` / `teardownVideoMonetGate` are NOT bridges into videos.js — they're called from app.js directly (`stopVideoPlayer` etc.). videos.js never sees them.

## P1-fix-2 — `initWallet({...})` call placement

Must call `initWallet({...})` BEFORE the first call to `loadWalletState()`. Current call sites for `loadWalletState`:

1. `js/app.js:577` — signin path
2. Migration success handler
3. Goal-claim refresh

**Action:** put `initWallet({...})` immediately after the wallet.js import block at the top of app.js, before any auth wiring. Mirror the order used by `initNotifications` (which is at app.js:~340 today).

## P1-fix-3 — Async stale-user guard in `loadWalletState`

If user signs out while `loadWalletState` is mid-await, the late completion writes the OLD user's wallet + unlocks into module state, then sets up a realtime channel filtered for the OLD user. Next signin sees ghost state.

**Mitigation (inside wallet.js):**
```js
async function loadWalletState() {
  const me = _cfg.getCurrentUser();
  if (!me) return;
  const userId = me.id;  // capture at start

  const [walletRes, unlocksRes, configRes] = await Promise.all([...]);

  // ── Stale-user guard ──
  // If sign-out fired during the await, _cfg.getCurrentUser() now
  // returns null OR a different user. Drop the write entirely; the
  // new user's loadWalletState (if any) will run separately.
  const stillMe = _cfg.getCurrentUser();
  if (!stillMe || stillMe.id !== userId) {
    return;
  }

  // ... rest of the writes + channel subscribe
}
```

## P2-fix — `stopVideoPlayer` calls teardownVideoMonetGate

Codex caught: app.js:6475's `stopVideoPlayer()` is currently NOT calling `teardownVideoMonetGate`. So the listener leaks across nav. (Pre-existing bug — but extraction is the right time to fix.)

**Action in 13A:**
- Add `teardownVideoMonetGate(player)` call inside `stopVideoPlayer()` in app.js.
- Import `teardownVideoMonetGate` from wallet.js alongside the others.

## REVISED 13A surface (final)

**In `js/wallet.js`:**

Module-private state:
- `_wallet`, `_userUnlocks`, `_walletConfigDefaults`, `_walletChannel`, `_unlockInFlight`, `_videoMonetGate`
- `_walletChangeSubscribers` — new, for `onWalletChange` API
- `_UNLOCK_ERROR_REGISTRY` — moved from app.js:1694

Module-private functions:
- `formatBalance`
- `normalizeUnlockTargetId`
- `_handleUnlockFailure`, `_interpretUnlockError`, `_submitUnlockRecoveryRequest`
- `_verifyBulkUnlockPersistence`, `_previewBookBulkUnlock`
- `_notifyWalletChange` — fires subscribers after balance/unlock state changes

Exports:
- `initWallet(config)` — bridge wiring
- `loadWalletState()` — public, called from app.js auth path
- `teardownWallet()`, `resetWalletState()` — sign-out cleanup
- `renderTopbarCoinPill()` — stays exported for direct render-after-import scenarios
- `onWalletChange(callback) → unsubscribeFn` — registration API
- `getWallet()` — read-only snapshot
- `getWalletConfig()` — bridge target
- `isUnlocked`, `markUnlocked`, `resolveUnlockCost`
- `openUnlockDialog`, `openBulkBookUnlockDialog`
- `setupVideoMonetGate`, `teardownVideoMonetGate`

**In `js/app.js`:**

1. Add wallet.js imports at top
2. Add `initWallet({...})` call before any auth/load wiring
3. Delete state vars `_wallet`, `_userUnlocks`, `_walletConfigDefaults`, `_walletChannel`, `_unlockInFlight`, `_videoMonetGate`
4. Delete extracted functions (state, unlocks, dialogs, video monet, error helpers, registry)
5. Sign-out (line 1198): swap `teardown(_walletChannel)` + state clear for `teardownWallet()` + `resetWalletState()`
6. Update `initBooks`, `initFeed`, `initStudio`, `initEarnings` bridges to use imported wallet.js functions directly (no closure wrappers)
7. Patch app.js:2607 monkey-patch → `onWalletChange(() => renderStoreBalances())`
8. Patch app.js:5835, 8083, 8381 direct `_walletConfigDefaults` reads → `getWalletConfig()`
9. Patch `stopVideoPlayer()` (app.js:6475) → call `teardownVideoMonetGate(player)`

**Verification greps after 13A:**
```bash
grep -n "_wallet\b\|_userUnlocks\|_walletConfigDefaults\|_walletChannel\|_unlockInFlight\|_videoMonetGate\|_UNLOCK_ERROR_REGISTRY" js/app.js
# Expect: zero matches
grep -n "renderTopbarCoinPill\s*=" js/app.js
# Expect: zero matches (no reassignment)
```

## Updated commit message draft

```
Stage 13A: Extract Coin Shop + Wallet foundation into js/wallet.js

Moves wallet state, unlocks, paywall dialogs, video monetization gate,
and the unlock error/recovery cluster out of app.js into a new owner
module. ~500 lines extracted; app.js shrinks accordingly.

What's in this commit:
  * js/wallet.js (new)
    - State: _wallet, _userUnlocks, _walletConfigDefaults,
      _walletChannel, _unlockInFlight, _videoMonetGate, plus
      _walletChangeSubscribers for the onWalletChange API.
    - Exports: initWallet, loadWalletState, teardownWallet,
      resetWalletState, renderTopbarCoinPill, onWalletChange,
      getWallet, getWalletConfig, isUnlocked, markUnlocked,
      resolveUnlockCost, openUnlockDialog, openBulkBookUnlockDialog,
      setupVideoMonetGate, teardownVideoMonetGate.
    - Async stale-user guard in loadWalletState (Codex P1).

  * js/app.js
    - Imports from wallet.js + initWallet({...}) call.
    - sign-out swapped to teardownWallet() + resetWalletState().
    - Store-balance render monkey-patch (line 2607) refactored to
      onWalletChange(...) registration (Codex P0).
    - Direct _walletConfigDefaults reads (3 sites) → getWalletConfig().
    - stopVideoPlayer() now calls teardownVideoMonetGate(player)
      (fixes pre-existing listener leak — Codex P2).
    - initBooks / initFeed / initStudio / initEarnings bridges
      switched from local closures to direct wallet.js imports.

Codex audit findings folded in: P0-1 (monkey-patch), P0-2 (helper
cluster), P0-3 (config readers), P1-1 (wiring table), P1-2 (init
placement), P1-3 (stale-user guard), P2 (stopVideoPlayer teardown).

Stage 13B (Store page + HitPay + history modal + ad reward stub)
to follow.
```

