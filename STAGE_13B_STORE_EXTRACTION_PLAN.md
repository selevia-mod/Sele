# Stage 13B — Coin Shop + Wallet History extraction plan

**Goal:** Move the Coin Shop page (showStore + pack rendering + HitPay purchase flow), the Appwrite migration banner, the rewarded-ad stub, the wallet history modal, and the HitPay return handler out of `js/app.js` into a new owner module `js/store.js`.

**Net app.js cut:** ~800 lines (1297-2095 minus the topbar pill listener and `_openSignOutModal/_closeSignOutModal` which stay).

**Why a new module instead of extending wallet.js:** `js/wallet.js` is now 1,154 lines focused on coin/star state, unlock dialogs, and the video monet gate — pure logic. The Store + history surface is UI-heavy (pack grid HTML, modal rendering, HitPay redirect, ad-stub modal) and ~800 lines. Splitting keeps both modules bite-sized and lets Stage 14 (Goals) follow the same pattern.

---

## Surface map (what's moving)

### Functions (16)

| App.js line | Function | Notes |
|---|---|---|
| 1297 | `showStore()` | Page nav entry — calls hideAllMainPages, renders pill, loads packs, refreshes migrate banner |
| 1318 | `refreshMigrateBanner()` | Hide if already-migrated row exists OR localStorage dismissed |
| 1382 | `renderStoreBalances()` | Reads getWallet(), paints `#storeCoinBalance` + `#storeStarBalance` |
| 1412 | `loadWalletHistory(currency)` | Pulls coin_transactions / star_transactions ledger rows |
| 1537 | `_walletHistoryClaimTitle(period)` | Helper: "Daily streak claim" etc. |
| 1550 | `_formatWalletHistoryTime(iso)` | Helper: "2h ago" / "3 May 14:32" |
| 1574 | `_walletHistoryDateKey(iso)` | Helper: "Today" / "Yesterday" / "13 May" group key |
| 1607 | `openWalletHistory(currency)` | Opens modal, renders summary + grouped list |
| 1746 | `_walletCurrencyIconSvg(currency, size)` | Inline SVG renderer for coin/star glyph |
| 1768 | `_walletHistoryIconFor(e)` | Picks per-row category icon |
| 1792 | `closeWalletHistory()` | Modal teardown |
| 1821 | `loadStorePacks()` | Fetches coin_packages, renders the pack grid, wires per-card click |
| 1875 | `purchasePack(packId, btn)` | Calls hitpay-create-payment edge fn, redirects to HitPay |
| 1924 | `renderStoreAdProgress()` | Mobile-only mode (web doesn't host rewarded ads) |
| 1965 | `playRewardedAd()` | 5-sec countdown stub modal — kept for future SDK swap-in |
| 2042 | `handleStoreReturn()` | Reads ?store=success&ref=… on init, verifies coin_purchases row, shows store |

### Boot-level wires moving from app.js to store.js (5)

1. `document.getElementById('btnMigrateDismiss').addEventListener('click', …)` — lines 1336-1340
2. `document.getElementById('btnMigrateFromAppwrite').addEventListener('click', …)` — lines 1342-1380
3. `document.getElementById('btnWatchAd').addEventListener('click', …)` — line 1941
4. `setTimeout(handleStoreReturn, 800)` — line 2097
5. `onWalletChange(() => { if (storePage.visible) renderStoreBalances(); })` — currently in app.js (added during Stage 13A as the monkey-patch replacement, but its real owner is store.js)

### Topbar pill listener — moving per user decision

`document.getElementById('topbarCoinPill').addEventListener('click', () => showStore())` — currently in app.js (preserved during Stage 13A). Moves into store.js. App.js drops the listener entirely.

### NOT moving (intentionally left in app.js)

- `_openSignOutModal()` / `_closeSignOutModal()` and their listeners (lines 2100-2121) — auth-adjacent, not wallet/store.
- `const storePage = document.getElementById('storePage')` — DOM ref defined among the other page refs around line 6404 of current app.js. Store.js will query its own ref at module load instead of relying on the app.js global.

---

## Bridge contract

Following the Stage 13A pattern (`initWallet({ ... })` config injection).

```js
// app.js
initStore({
  getCurrentUser:     () => currentUser,
  hideAllMainPages,
  setSidebarActive,
  signOut,
});
```

### What each bridge is for

| Bridge | Why | What goes wrong without it |
|---|---|---|
| `getCurrentUser` | refreshMigrateBanner + purchasePack + handleStoreReturn check `currentUser` | Captures auth-bound user inside module-local state; same getter pattern as Stage 13A so sign-out is observed |
| `hideAllMainPages` | showStore calls it first to clear other pages | showStore would overlay other pages instead of replacing them |
| `setSidebarActive` | showStore calls `setSidebarActive(null)` to deactivate sidebar items | Sidebar shows a stale "active" highlight on the previous page |
| `signOut` | NOT actually needed — no Store/history code calls signOut today | (intentionally omitted; only listed here for completeness — if a future migration error wants to force re-auth, add it then) |

**Final bridge surface: 3 functions.** (`getCurrentUser`, `hideAllMainPages`, `setSidebarActive`)

### Direct imports (no bridge — store.js imports straight from owner modules)

```js
// store.js
import { supabase, toast, escHTML, callEdgeFunction } from './supabase.js';
import { getWallet, loadWalletState, onWalletChange } from './wallet.js';
```

`callEdgeFunction` is already exported from `js/supabase.js:68`.

---

## App.js wiring (final state)

```js
// Imports near other module imports
import {
  initStore,
  showStore,           // imported because app.js's notification routing
                       // calls showStore(); keeping the symbol callable
                       // from app.js even though the topbar pill listener
                       // moved into store.js
} from './store.js';

// Inside onSignedIn, BEFORE loadWalletState() (we want store.js to
// observe auth, including the boot setTimeout handleStoreReturn that
// fires 800ms after module load):
initStore({
  getCurrentUser: () => currentUser,
  hideAllMainPages,
  setSidebarActive,
});
```

**Net app.js delta:** ~800 lines deleted (Store section), ~10 lines added (import + initStore call + tombstone comment block).

**Final app.js after 13A+13B:** Currently 10,184. After 13B: ~9,400.

---

## Hazards (P0/P1)

### H1 (P0) — topbarCoinPill listener attaches BEFORE store.js loads

The topbar pill is rendered in static HTML (`index.html`). The listener in store.js fires at module load time. ES modules execute in dependency-resolution order; if some other module imports store.js late, the listener might attach AFTER the user has had a chance to click the pill (unlikely in practice — first click takes a human ~1s+ minimum, module load is sub-100ms).

**Mitigation:** store.js attaches the listener inside a `DOMContentLoaded` check (fallback if already loaded). Same pattern wallet.js uses for its own boot wires. Verified pattern in `js/notifications.js`, `js/messages-dock.js` etc.

### H2 (P0) — handleStoreReturn fires before initStore is called

The `setTimeout(handleStoreReturn, 800)` runs at module load. If the user lands on `/?store=success&ref=…`, handleStoreReturn fires, calls `showStore()`, which calls `hideAllMainPages()` — but that bridge is null until `initStore()` is called.

App.js calls `initStore()` inside `onSignedIn` which runs after Supabase resolves the session (variable timing, typically 100-500ms). 800ms is a safety buffer but not a guarantee.

**Mitigation:** Either:
- A. Bump the setTimeout to 1500ms.
- B. Have handleStoreReturn defer itself if bridges aren't wired yet (poll every 200ms up to 5s, then bail with console.warn).
- C. Have store.js fall back to a no-op closure for unwired bridges so handleStoreReturn becomes a partial no-op (renders the migration toast but skips the showStore page nav).

**Decision:** B. Poll-then-bail. Clean failure mode: if auth never lands in 5s, the post-payment toast still fires (it's pure DOM + supabase, no bridge needed); only the page-nav portion skips.

### H3 (P1) — onWalletChange subscriber moves but storePage ref doesn't

The Stage 13A subscriber `onWalletChange(() => { if (storePage.visible) renderStoreBalances(); })` reads `storePage` (the DOM ref defined in app.js). When the subscriber moves into store.js, store.js needs its own ref.

**Mitigation:** `const storePageEl = document.getElementById('storePage')` at module load inside store.js. Cleaner than a bridge — DOM refs don't need to be shared across modules.

### H4 (P1) — handleStoreReturn races wallet loading on cold start

User lands on `/?store=success&ref=…`. Sequence:
1. Page loads, modules import.
2. handleStoreReturn setTimeout starts.
3. supabase.auth.getSession() resolves, onSignedIn fires.
4. initWallet + loadWalletState fire (wallet.js).
5. initStore fires (after wallet.js).
6. handleStoreReturn fires (~800ms after page load).
7. showStore() → renderStoreBalances() reads getWallet() — may be `{coin_balance:0, star_balance:0}` if wallet hasn't loaded yet.

If 5 happens before 7 but 4 hasn't completed (network slow), the user sees `0 Coins / 0 Stars` momentarily, then the wallet realtime tick + onWalletChange subscriber refresh. Visual flash but not a correctness bug.

**Mitigation:** Acceptable. The onWalletChange subscriber will refresh once loadWalletState completes. Add a comment noting the visible-flash possibility.

### H5 (P2) — `escHTML` vs `escapeHtml` naming

App.js uses `escHTML` (imported from supabase.js). The Store/history code uses the same. No naming conflict; just confirming the import is correct.

### H6 (P2) — `loadWalletHistory` returns from `currentUser` check with `[]`

Line 1413: `if (!currentUser) return [];`. After bridge: `if (!_cfg.getCurrentUser()) return [];`. The early-return value is consumed by `openWalletHistory` which iterates. Keep behavior identical.

### H7 (P2) — `playRewardedAd` is dead code on web

Per the comment at lines 1907-1923, web does NOT credit stars from the ad stub. The button is rewired to show a "use mobile app" toast. `playRewardedAd` is kept in the codebase for future SDK integration but is currently uncallable from the web UI.

**Decision:** Move it anyway. Same as today — uncalled but exported (or kept module-private with an export comment "reserved for Phase 3 ad SDK"). Cleaner to keep store-adjacent code together than scatter it.

---

## Codex audit checkpoints

Per the Stage 13A pattern: I'll loop Codex three times.

1. **Round 1: plan audit** (this doc) — catches H-class hazards before I write code.
2. **Round 2-N: store.js code audit** — bug catches like Round 2-5 found in wallet.js.
3. **Round N+1: app.js wiring diff audit** — like Round 6 found.

---

## Estimated cuts

- `js/app.js`: 10,184 → ~9,400 lines (–784)
- `js/store.js`: 0 → ~850 lines (new file, includes module-load wiring + bridge plumbing + tombstone-comment blocks for clarity)
- `js/wallet.js`: 1,154 lines (unchanged)

---

## Open questions for Codex

1. Is the H2 mitigation (poll-then-bail handleStoreReturn) correct, or should it use a Promise-based signal from initStore?
2. Is there any caller of `loadStorePacks` / `purchasePack` / `loadWalletHistory` outside the Store section I missed? (My grep showed they're all callee-side, only called by `showStore` and `openWalletHistory`.)
3. Should the `loadWalletState()` call inside the migration success handler (line 1368) be replaced with the wallet.js exported `loadWalletState()` directly imported into store.js? (Yes — already in the import plan.)
4. The `setTimeout(handleStoreReturn, 800)` at module load — was 800ms chosen by measurement, or is it folklore? (Worth asking; if folklore, the H2 poll-then-bail approach is fine.)
