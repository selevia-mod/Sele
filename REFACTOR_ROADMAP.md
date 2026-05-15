# Selebox Web Refactor Roadmap
## "fixing one thing creates two more issues" — the cure

**Created:** 2026-05-15 (Day 2)
**Owner:** Charles
**Status:** Pre-flight (Stage 0 in progress)

---

## The diagnosis

The Selebox web app is **one 24,000-line `js/app.js` file** with global-scope
state, no tests, no CI, no module boundaries. Every feature can touch every
other feature. That's why:

- A button in the composer collides with a button in the sidebar (`id="btnPost"`)
- A function in the feed code overrides a function in the videos page (`renderVideoCard`)
- A schema rename in one migration breaks four unrelated RPCs (column-name mismatches)
- A realtime handler in notifications forgets to call grouping, and weeks later
  the bell shows ungrouped rows

The senior dev's 10-point plan is the cure. This document is the **route**.

---

## Guiding principles

1. **Small steps, big direction.** Each stage ships independently. If we pause
   for a month between stages, the site still works.
2. **No grand rewrites.** Move code, don't reimagine it. Translation, not
   replacement.
3. **Verify after every stage.** Run the pre-deploy script + manual smoke
   test before merging.
4. **One feature at a time.** Notifications first (lowest coupling), then
   composer, then feed, etc.
5. **Don't break what works.** Every move is a clean refactor — same behavior,
   just in a different file.

---

## Stage 0 — Foundation (this week, ~2 hours total)

The prep work that makes every later stage safer. Zero feature changes; pure
discipline + tooling.

### 0.1 — Pre-deploy guard script ✅
- [x] `scripts/pre-deploy-check.sh` — catches duplicate IDs, function name
      collisions, syntax errors, stale placeholders. Already shipped (task #156).
- [x] Installed as `.git/hooks/pre-push` — runs on every push automatically.
- [x] Bypass with `git push --no-verify` only in emergencies.

### 0.2 — Branching workflow ✅
- [x] `BRANCHING.md` written at repo root. Documents `main` / `develop` /
      `feature/*` / `fix/*` / `hotfix/*` / `refactor/*` / `chore/*` flow
      with copy-pasteable git commands.
- [ ] **Charles to run** (one-time, ~30 sec):
      ```
      git checkout main && git pull
      git checkout -b develop
      git push -u origin develop
      git config --local init.defaultBranch develop
      ```
- [ ] From now on: feature work happens on `feature/*`, fixes on `fix/*`,
      production patches on `hotfix/*`. Never direct-commit to `main`.

### 0.3 — Manual smoke-test checklist ✅
- [x] `SMOKE_TEST.md` written at repo root. 10 high-value user paths,
      ~10 min to run. Sign-off block to paste into the merge commit.
- [ ] Run this manually before every `develop → main` merge.

### 0.4 — Core-protected file list ✅
- [x] `CORE_PROTECTED.md` written at repo root. Lists Tier-1 (site goes
      black) and Tier-2 (cross-feature cascade) files with rationale.
- [x] Pre-deploy script §6 added — detects core-file changes in the git
      diff vs `origin/main` and prompts the smoke test. Non-blocking
      warning so it doesn't get in the way of legitimate changes.

**Stage 0 done when:** branching is set up, smoke-test doc exists, pre-deploy
script catches core-file changes.

---

## Stage 1 — Extract Notifications (~2–3 hours) ✅

**Status:** Complete (2026-05-15). Notifications now live in `js/notifications.js`,
imported by `app.js` via a single import + a config-injection call site.

**Lessons captured for stages 2–9:**
- The first attempt used a circular ES module import (`notifications.js`
  imported `currentUser` + nav functions from `app.js`, while `app.js`
  imported `initNotifications` from `notifications.js`). At module-load
  time this caused the realtime subscriber to attach `.on(postgres_changes)`
  AFTER `.subscribe()` had already fired, triggering the
  `cannot add postgres_changes after subscribe()` error and breaking sign-out.
- The fix was config injection: `notifications.js` imports ONLY from
  `supabase.js` (which is leaf-level), and `app.js` passes a `{getCurrentUser,
  nav: {...}}` object into `initNotifications(config)` on sign-in.
- **Use config injection as the default pattern for stages 2–9.** Any time
  the extracted module needs to read live `currentUser` or call a navigation
  surface that still lives in `app.js`, inject it instead of importing it.

Notifications is the right first target: low cross-feature coupling, recent
regression source, well-bounded (everything starts at `initNotifications()`).

### What moves
From `js/app.js` into a new file `js/notifications.js`:
- `initNotifications()` (boot + realtime subscribe)
- `loadNotifications()` + `loadMoreNotifications()` + `_filterSecretDmConversations()`
- `groupNotifications()` + `_notifGroupKey()`
- `hydrateActorProfiles()` + `hydrateNotifResources()`
- `renderNotifications()` + `notificationLabel()` + `onNotificationClick()`
- `markAllNotificationsRead()` + `updateNotifBadge()` + `closeNotifPanel()`
- All `_notif*` module-level state vars
- `_notifChannel`, `_notifications`, `_notifUnreadCount`, etc.

### What stays in app.js
- `currentUser` (shared)
- `supabase` client (shared)
- `escHTML`, `toast` utilities (shared)
- The bell button click handler that opens the panel — wires via an
  `import { openNotifPanel } from './notifications.js';`

### How (as executed)
- [x] `js/notifications.js` created with 21 functions + 16 state vars
      moved verbatim from `app.js` lines 18369–19548.
- [x] `escHTML` and `toast` moved into `js/supabase.js` (leaf-level shared module).
- [x] `notifications.js` imports `supabase, escHTML, initials, timeAgo` from
      `./supabase.js` ONLY. No imports from `./app.js`. (This is what broke
      the first attempt.)
- [x] `app.js` adds a single `import { initNotifications } from './notifications.js';`
      and calls it from `onSignedIn` with a config object containing
      `getCurrentUser` + 10 navigation function references.
- [x] `app.js.before-stage1` kept as local-only backup (gitignored via
      "untracked + don't add" — not committed).

### Verify (as executed)
- [x] `node --check` passes on both files.
- [x] Manual: bell opens, shows grouped follows, tap routes correctly.
- [x] Manual: page load → no realtime subscription error in console.
- [x] Manual: sign-out works (was broken in first attempt).
- [ ] Smoke test post-delete delay separately — pre-existing UX issue, not
      a Stage 1 regression. New task `fix/post-delete-optimistic`.

**Stage 1 done when:** zero notification code remains in `app.js` except the
single import line + the bell button click handler. Site works identically.

---

## Stage 2 — Extract Scheduled Posts Modal (~1 hour) ✅

**Status:** Complete (2026-05-15). Confirmed the Stage 1 config-injection
pattern scales down cleanly to small modules.

**Surface:** 3 functions + 5 event wirings (pill click, close button,
backdrop click, Escape keydown, delegated row-action handler). Single
injected dependency: `getCurrentUser`. Compare to Stage 1's 11 injected
nav functions — Stage 2 took a fraction of the time.

### What moved
Into `js/scheduled-posts.js`:
- [x] `refreshScheduledPostsBadge()` (also re-exported so post-submit handler can call it)
- [x] `openScheduledPostsModal()` + `closeScheduledPostsModal()`
- [x] The delegated click handler for `data-sp-act` buttons
- [x] The pill click + close button + backdrop click + escape handlers

### How (as executed)
- [x] Created `js/scheduled-posts.js` (~180 lines).
- [x] Imports `supabase, escHTML, toast` from `./supabase.js` ONLY.
- [x] No imports from `./app.js` — Stage 1 lesson preserved.
- [x] `app.js` adds a single import + replaces the standalone
      `refreshScheduledPostsBadge()` call in `onSignedIn` with
      `initScheduledPosts({getCurrentUser: () => currentUser})`.
- [x] All listeners attached at module-load time in `scheduled-posts.js`
      (NOT inside `initScheduledPosts`) so sign-out/in doesn't accumulate
      duplicate handlers. This matters more here than in Stage 1 because
      the delegated handler is bound to `document` — duplicating it would
      double-fire every click.

### Verify (as executed)
- [x] `node --check` passes on both files.
- [x] `scripts/pre-deploy-check.sh` passes (same 5 advisory warnings).
- [ ] Manual: schedule a post, badge appears.
- [ ] Manual: click pill, modal opens with row + buttons.
- [ ] Manual: "Publish now" + "Cancel" both work, badge refreshes.

---

## Stage 3 — Extract Composer (~2 hours)

Touches more, but well-scoped to the `#composer` DOM.

### What moves
Into `js/composer.js`:
- `composeText` listeners, image preview, schedule UI state
- The submit handler (`btnPostSubmit` click)
- `_updateComposeScheduleUI()`
- The submit_post RPC call

### Verify
- [ ] Pre-deploy passes
- [ ] Text post submits
- [ ] Photo upload + submit
- [ ] Schedule a post → confirm pending row exists in DB

---

## Stage 4 — Extract Studio (~2 hours)

Already has its own conceptual boundary. The Share modal we built today goes
here too.

### What moves
Into `js/studio.js`:
- `showStudio()`, `loadStudio()`, `renderStudioRow()`
- `openStudioEditModal()`, `deleteStudioVideo()`, `toggleStudioMonetize()`
- `openStudioShareModal()` (the share-to-feed modal from today)
- Thumbnail picker helpers
- All `studio*` state vars

---

## Stage 5 — Extract Feed (~3–4 hours, the big one)

Highest blast radius. Do this AFTER 1–4 so we've validated the pattern on
smaller modules first.

### What moves
Into `js/feed.js`:
- `loadFeed()`, `loadMoreFeed()`, `_buildAndExecFeedQuery()`
- `_fetchHybridFeedPage()`, `_renderHybridBookCarousel()`, `_renderHybridVideoCard()`
- `renderPost()` (post card builder)
- `FEED_SELECT`, `_feedMode`, `_feedHybridCursor`, etc.
- Background poller + new-posts pill
- View tracking (post_views RPC)

### Verify (the big checklist)
- [ ] For You loads with carousels injected
- [ ] Following loads chronologically
- [ ] Discover loads
- [ ] Tab switch works
- [ ] Infinite scroll loads more
- [ ] Realtime new-post pill appears + applies
- [ ] Repost still works
- [ ] Like / comment buttons work
- [ ] display_name fallback still works

---

## Stage 6 — Extract Profile (~3 hours)

### What moves
Into `js/profile.js`:
- `openProfile()`, `loadProfileTabs()`, `loadProfileVideos()`, `loadProfileBooks()`
- Profile header + edit profile modal
- Stats counters

---

## Stage 7 — Extract Videos (~2 hours)

The standalone Videos page (not Studio).

### What moves
Into `js/videos.js`:
- `loadVideosTab()`, `renderVideoCard()` (legacy one), video player setup
- `playVideo()`, `_currentVideoCtx`

---

## Stage 8 — Extract Books (~2 hours)

### What moves
Into `js/books.js`:
- `loadBooksTab()`, `openBookDetail()`, book reader chrome
- Reading list + bookmarks

---

## Stage 9 — Extract Messages (~3 hours)

DM code is sprawling. Worth its own stage.

### What moves
Into `js/messages.js`:
- `showMessages()`, `openConversation()`, DM composer
- Realtime DM subscription
- Secret chat code

---

## Stage 10 — Audit `app.js` (~2 hours)

After stages 1–9, what's left in `app.js`?

**Should be only:**
- App boot (`onSignedIn`, `onSignedOut`)
- Sidebar nav + tab switching
- Shared utilities (`escHTML`, `toast`, etc.) — or these move to `js/utils.js`
- `supabase` client init — or moves to `js/supabase.js`
- `currentUser` global + auth helpers — or moves to `js/auth.js`

Target: `app.js` ≤ 1,500 lines, every feature in its own file.

### Verify
- [ ] Pre-deploy passes on a fresh clone
- [ ] Full smoke test (all 10 items)
- [ ] Open one feature file at a time, verify it's self-contained

---

## Stage 11 — Observability (~2 hours)

The senior didn't mention this explicitly but it's the #1 thing missing.

- [ ] Add Sentry breadcrumbs at every feature entry point (`enter:feed`,
      `enter:notifications`, `submit:post`, etc.)
- [ ] Tag errors with `feature: 'feed'` so the Sentry dashboard groups by
      module.
- [ ] Add custom error boundaries on the high-value paths:
      - `loadFeed` failures → toast + retry button (we have this)
      - `submit_post` failures → user-visible error (we have this)
      - `notifications` render failures → fallback empty state
- [ ] Set up a Sentry alert: "errors in feature X > N per hour" → email.

---

## Stage 12 — Decision point: TypeScript? React?

After all features are modularized, you have two big optional moves:

### Option A — TypeScript
- Add `tsconfig.json`, rename files `.js → .ts` one at a time, add types to
  each module's exported functions.
- Cost: ~2 weeks incremental.
- Payoff: half the regressions we've hit (column-name mismatches, undefined
  function calls, wrong arg counts) become compile errors instead of runtime
  black-screens.
- Recommendation: **yes, after Stage 10.**

### Option B — React/Vue migration
- Cost: 2–3 months running both stacks side-by-side.
- Payoff: real component isolation (the senior's #3), shared UI primitives,
  proper state management.
- Recommendation: **defer indefinitely.** Vanilla JS modules + TypeScript get
  you 80% of the benefit at 10% of the cost. Revisit only if the team grows
  to 3+ devs.

---

## Stage 13 — Steady state

Every new feature lives in its own file. Every push runs the pre-deploy
script. Every `develop → main` merge requires the smoke test. Sentry tells
you about breakage before users do.

Regressions don't stop entirely — but they stop *spreading*. A bug in
notifications stays in notifications.

---

## Progress tracking

| Stage | Status | Date | Notes |
|-------|--------|------|-------|
| 0     | 🟢 Complete | 2026-05-15 | Pre-deploy script, BRANCHING.md, SMOKE_TEST.md, CORE_PROTECTED.md all shipped. Charles to run the one-time `git checkout -b develop` command. |
| 1     | ⚪ Not started | — | Notifications extraction |
| 2     | ⚪ Not started | — | Scheduled posts modal |
| 3     | ⚪ Not started | — | Composer |
| 4     | ⚪ Not started | — | Studio |
| 5     | ⚪ Not started | — | Feed |
| 6     | ⚪ Not started | — | Profile |
| 7     | ⚪ Not started | — | Videos page |
| 8     | ⚪ Not started | — | Books page |
| 9     | ⚪ Not started | — | Messages |
| 10    | ⚪ Not started | — | app.js audit |
| 11    | ⚪ Not started | — | Sentry per-feature tagging |
| 12    | ⚪ Not started | — | TypeScript migration |

---

## How to start the next stage

1. Update this doc — mark the previous stage 🟢 Complete with date + notes.
2. Create a `feature/refactor-stage-N-NAME` branch off `develop`.
3. Do the move. **Don't rewrite logic — just relocate it.** Use grep + cut +
   paste, not "improve while you're there."
4. Run `./scripts/pre-deploy-check.sh` after the move.
5. Run the manual smoke test for the affected feature (and the adjacent ones).
6. Open a PR `feature/* → develop`. If you're solo, self-review by reading
   the diff end-to-end one more time before merging.
7. After merging to `develop`, run the FULL smoke test (`SMOKE_TEST.md`)
   before merging `develop → main`.

---

## Anti-patterns to avoid

- **Drive-by refactors during a feature task.** If you're moving notifications,
  don't also "improve" the avatar component. Separate PRs.
- **Touching `app.js` directly during a stage.** Every change in a stage
  should be in the new feature file or in a tiny `app.js` import line.
- **Skipping the smoke test.** "It looks fine" is what got us here.
- **Combining stages.** Stage 1 + 2 together is twice the regression surface
  in one PR. Even if you finish Stage 1 in 30 min, ship it. Then start 2.

---

*This document is a living roadmap. Update the progress table as we go. If
the order changes, change it here too — but always finish a stage before
starting the next.*
