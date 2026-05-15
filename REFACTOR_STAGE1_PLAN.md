# Stage 1 — Extract Notifications: Execution Plan

**Status:** Inventory complete, execution pending
**Branch:** `refactor/stage-1-notifications`
**Estimated time:** 2–3 hours of careful work
**Risk:** Medium-high — notifications is core UX. Breaking it = visible regression.

---

## What we're moving

**21 functions** (lines 18413–19519 in app.js, ~1100 lines):

| Function | Line | Purpose |
|----------|------|---------|
| `_playNotifChime()` | 18413 | Audible cue on new notif |
| `_startNotifTitleFlash()` | 18451 | Tab title flash when bg |
| `notifCategory(n)` | 18527 | All/You/Following bucket |
| `initNotifications()` | 18544 | Boot + realtime subscribe |
| `loadNotifications()` | 18624 | Initial fetch + render |
| `_filterSecretDmConversations(rows)` | 18685 | Drop Secret DMs |
| `loadMoreNotifications()` | 18703 | Pagination |
| `_notifSkeletonHTML()` | 18769 | Loading skeleton |
| `_renderNotifLoadMoreFooter(isLoading)` | 18782 | "Loading more…" footer |
| `hydrateNotifResources(rows)` | 18805 | Fetch post/video titles |
| `_notifGroupKey(n)` | 18953 | Grouping bucket key |
| `groupNotifications(rows)` | 18999 | Facebook-style grouping |
| `hydrateActorProfiles(items)` | 19049 | Fetch actor usernames |
| `updateNotifBadge()` | 19065 | Unread count badge |
| `renderNotifications()` | 19083 | Build DOM |
| `notificationLabel(n)` | 19172 | "Alice and 4 others…" |
| `onNotificationClick(notifId)` | 19314 | Tap routing |
| `markAllNotificationsRead()` | 19449 | Bulk-clear unread |
| `openNotifPanel()` | 19485 | Open bell dropdown |
| `closeNotifPanel()` | 19519 | Close bell dropdown |

**16 state vars** (lines 18376–18412):

```js
const NOTIF_PAGE_SIZE = 25;
let _notifications = [];
let _notifUnreadCount = 0;
let _notifChannel = null;
let _notifPanelOpen = false;
let _notifFilter = 'all';
const _notifActorCache = {};
const _notifResourceCache = new Map();
const _notifResourceCacheAt = new Map();
const NOTIF_RESOURCE_TTL_MS = 2 * 60 * 1000;
let _notifCursor = null;
let _notifHasMore = false;
let _notifLoadingMore = false;
let _notifMarkedReadThisOpen = false;
let _notifSoundMuted = localStorage.getItem('selebox_notif_muted') === '1';
let _notifTitleFlashTimer = null;
let _notifTitleOriginal   = null;
let _notifTitleFlashCount = 0;
let _notifAudioCtx = null;
```

---

## Dependencies (the import surface)

These are referenced by notification code but defined elsewhere in app.js.
All 15 need to be either:
- Exported from app.js (or wherever they live) for notifications.js to import, OR
- Moved into a shared `js/utils.js` / `js/core.js` that both files import

### From app.js core (the "shared infra"):
| Symbol | Type | Notes |
|--------|------|-------|
| `supabase` | const | Supabase client — used in every fetch + the realtime channel |
| `currentUser` | let | Live binding — needs to remain reassignable after sign-in/out |
| `escHTML` | function | HTML escape utility |
| `initials` | function | Avatar fallback "AB" from "Alice Bob" |
| `timeAgo` | function | "5m ago", "yesterday", etc. |

### From app.js navigation surfaces (each is one feature that notifications routes INTO):
| Symbol | Used by | Routes to |
|--------|---------|-----------|
| `openProfile(userId)` | onNotificationClick | profile page (follow notif) |
| `openPostFromSearch(postId)` | onNotificationClick | post detail (post comment/like) |
| `playVideo(sbVideoId)` | onNotificationClick | video player |
| `openBookDetail(bookId)` | onNotificationClick | book detail (chapter comment/inline) |
| `openConversation(convId)` | onNotificationClick | DM thread |
| `showMessages()` | onNotificationClick | DM inbox |
| `showFeed()` | (fallback) | home feed |
| `showHomeLanding()` | (fallback) | curated home |
| `showEarnings(forceReload)` | onNotificationClick | earnings page (withdrawal notif) |
| `setSidebarActive(elemId)` | onNotificationClick | sidebar highlight state |

---

## What gets exported from notifications.js

App.js needs to call these:
- `initNotifications()` — from `onSignedIn`
- `openNotifPanel()` — from the bell button click (currently inline in app.js)
- (maybe) `closeNotifPanel()` — currently called from outside? Need to check

That's it. Everything else is internal to the notifications module.

---

## Migration approach (chosen path)

### Step A — Create `js/core.js` (a tiny shared utilities module)

Move these into a NEW file `js/core.js`:
- `escHTML`
- `initials`
- `timeAgo`
- `toast` (used everywhere, may as well move now)

Export each with `export function ...`.

In app.js, replace the original declarations with `import { escHTML, initials, timeAgo, toast } from './core.js';` at the top.

**Verify:** site still loads, post button still works, smoke test passes.

### Step B — Export shared state from app.js

Add `export` keyword to the existing declarations:
```js
export let currentUser = null;
export const supabase = createClient(...);   // wherever this is now
```

**Critical:** `currentUser` is reassigned in `onSignedIn` and `onSignedOut`. An exported `let` gives importers a live binding — when app.js reassigns, importers see the new value. This is exactly what we need. **Do not change the reassignment site.**

**Verify:** site still loads, sign-in still works.

### Step C — Create `js/notifications.js`

```js
// js/notifications.js
import { supabase, currentUser } from './app.js';
import { escHTML, initials, timeAgo, toast } from './core.js';
import {
  openProfile, openPostFromSearch, playVideo, openBookDetail,
  openConversation, showMessages, showFeed, showHomeLanding,
  showEarnings, setSidebarActive,
} from './app.js';

// All notification state vars (originally in app.js lines 18376–18412)
const NOTIF_PAGE_SIZE = 25;
let _notifications = [];
// ... etc

// All 21 functions, copied verbatim
export async function initNotifications() { ... }
export function openNotifPanel() { ... }
export function closeNotifPanel() { ... }
async function loadNotifications() { ... }
function groupNotifications(rows) { ... }
// ... etc
```

The navigation functions (openProfile, etc.) need to be exported from app.js. Add `export` to each declaration.

### Step D — Modify app.js

- Delete the 1100 lines of notification code
- Add at the top: `import { initNotifications, openNotifPanel } from './notifications.js';`
- Wire `initNotifications()` into `onSignedIn` (replacing the existing call)
- Wire `openNotifPanel()` into the bell button click handler

### Step E — Verify

1. Run `./scripts/pre-deploy-check.sh` — should pass clean
2. Open the live-server site
3. Walk through every notification scenario:
   - Sign in → bell badge shows correct count
   - Open bell → list shows grouped notifications
   - New follow arrives via realtime → appears at top, badge ticks
   - Tap a follow → routes to profile
   - Tap a post comment → routes to post
   - Tap a withdrawal notif → routes to earnings
   - Tap "Mark all read" → all marked, badge clears
   - Scroll to bottom → load-more triggers
4. Run the full SMOKE_TEST.md (notification grouping is item #4)

### Step F — Commit + merge

Only after Step E passes:

```bash
git add js/app.js js/core.js js/notifications.js index.html REFACTOR_ROADMAP.md
git commit -m "Stage 1: extract notifications into js/notifications.js + create js/core.js for shared utils"
git push   # pre-deploy hook runs

# Update REFACTOR_ROADMAP.md progress table: Stage 1 → 🟢 Complete
# Merge to develop, run smoke test, then to main:
git checkout develop && git merge --no-ff refactor/stage-1-notifications && git push
# Full SMOKE_TEST.md run
git checkout main && git merge --ff-only develop && git push
```

---

## Rollback plan

If anything goes wrong at any step, return to the last known good state:

```bash
git checkout refactor/stage-1-notifications
git reset --hard origin/develop   # discard local changes, back to develop's tip
```

The branch is isolated from `main`, so this is safe. Main stays untouched until the final merge.

---

## Why we're doing inventory before move

Today (Day 2) we hit FIVE preventable bugs:
1. Duplicate `id="btnPost"` (mechanical — pre-deploy now catches)
2. Function name collision `renderVideoCard` (mechanical — pre-deploy catches)
3. Column name `author_id` vs `user_id` (logical — needs schema docs)
4. Missing columns `banned_reason` etc. (logical)
5. Realtime handler forgot to call `groupNotifications` after unshift (logical)

A blind cut-and-paste of 1100 lines without first mapping the import surface
would absolutely introduce regression #6. The inventory takes 20 minutes,
saves 2 hours of debugging.

---

## When to execute

**Recommended:** Tomorrow morning, fresh head, ~2 hours.

**Why not tonight:** Charles is at ~2:30am after a 16-hour session. The
pre-deploy script catches mechanical errors but not "you forgot to add
openProfile to the export list and now follow notifications don't route."
The smoke test catches that too, but you have to actually run it. Tired
people skip the smoke test. Fresh people don't.

**When ready, the execution order is:**
1. Step A (core.js) — 30 min
2. Smoke test
3. Step B (export shared state) — 15 min
4. Smoke test
5. Step C (create notifications.js) — 45 min
6. Step D (delete from app.js + wire imports) — 20 min
7. Step E (full smoke test) — 15 min
8. Step F (commit + merge) — 5 min

Total: ~2h 10min with smoke tests between each.

---

## What you should NOT do during execution

- Drive-by improvements ("while I'm here, let me also fix this typo")
- Renames ("let me rename `_notifChannel` to `notifSubscription` since that's clearer")
- Behavior changes ("let me also bump the page size to 50 while I'm at it")
- Skipping any smoke test step

**The discipline rule for Stage 1: same lines of code, different file. Translation, not interpretation.**
