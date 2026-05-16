# Home Page — Codex Review Brief

## Context

This isn't a Stage extraction — it's a code-quality + correctness
review of the existing home landing page, as it stands today in
`js/app.js`. The home tab is one of two "main" surfaces (the other
being the Post feed at `showFeed`) and gets a lot of eyeballs but
hasn't had a fresh review since the May 2026 mosaic redesign.

Charles wants a second pair of eyes before we either (a) extract it
into its own `js/home.js` module in a future refactor stage or (b)
ship the next round of polish on it. Either way, fixing whatever
Codex flags here makes both paths smoother.

## What "home" means

`showHomeLanding()` (exported, line 5404) — the curated landing page
that lives parallel to the Post feed. Renders a mosaic into
`#homeLanding`:

- **Hero card** — one random video from the "Dear Jen" channel
- **Trending stack** (right column) — 4 random videos with views ≥ 100
- **Featured Posts column** — up to 20 most-recent visible posts,
  rendered through the shared `renderPost()` from feed.js
- **Trending Books shelf** — top books by `views_count`, 2 pages × 6
- **Recent Update Books shelf** — books that just got new published
  chapters (dedupe by `book_id` from a chapters query), 2 pages × 6

Backed by one orchestrator: `loadHomeVideos({ force })` at line 5052
(misnamed — it loads videos AND posts AND books). Six parallel
queries, 60-second TTL cache via `_homeDataLoadedAt` + a single-flight
guard via `_homeDataInFlight`.

## Files in scope

- `js/app.js` lines 4555-5398 — all the home page code:
  - State + consts (4557-4574): `HOME_DATA_TTL_MS`, `_homeDataLoadedAt`,
    `_homeDataInFlight`, `_dearJenUploaderId`, `_dearJenLookupAttempted`,
    `_bookShelfPools`, `_bookShelfPages`, `_BOOKS_PER_PAGE`
  - Helpers (4575-4671): `_resolveDearJenUploaderId`,
    `_formatHomeViews`, `_formatHomeDuration`, `_escHtml`,
    `_cleanCdnUrl`, `_supabaseRatioCrop`
  - Render: `_renderHomeVideoCard` (4677), `_renderBookShelfPage`
    (4775), `_renderBookShelf` (4894), `_wireHomeVideoCard` (4995),
    `_wireBookShelfArrowsOnce` (4794), `_replaceBookCoverFromHome`
    (4831), `_shuffle` (5043)
  - Orchestrator: `loadHomeVideos` (5052)
  - Entry: `showHomeLanding` (5404)
  - Height sync: `_syncHomeTopHeights` (5375), `_wireHomeTopHeightSync` (5390)
- `index.html` lines 472-650 — the home landing markup:
  `#homeLanding`, `#homeHeroVideo`, `#homeVideoSide`,
  `#homeFeaturedPost`, `#homeBooksTrending`, `#homeBooksRecent`,
  `#homeVideoMediumRow`

## Specific concerns to look at

These are the things that I (Claude) noticed while surveying the
home code. Asking Codex to confirm severity + spot additional issues.

### 1. Stale `console.log` debug spam

Lines 5182-5187 log six `[home] hero pool / trending pool / recent
pool / featured post pool / trending books pool / recent-chapter rows
pool` to the console on every home tab open. The comment right above
them says:

> Quick visibility — strip these logs once the home page is observed
> populating reliably across browsers.

We're past that point. These should come out (or move behind a
`DEBUG_HOME` flag). Also, line 4587 logs `[home] Dear Jen uploader
resolved: "${data.username}" id=${data.id}` — also stale debug.

### 2. Hardcoded "Dear Jen" hero channel

`_resolveDearJenUploaderId()` does `ilike('username', '%Dear Jen%')`.
This is a business decision baked into code, and it'll silently break
if:
- The Dear Jen channel changes its username
- An impersonator registers a username containing "Dear Jen"
- We want to feature a different channel in the hero

Should this be moved to `app_config` (an admin-settable
`home_hero_uploader_id` field) so it can change without a deploy?

### 3. Hero never returns the same video twice — actually, it can

Line 5195: `const hero = heroPool.length > 0 ? _shuffle(heroPool)[0]
: null;` — picks index 0 of a freshly-shuffled 60-item pool.
Probability of the same hero on two consecutive home opens within the
60s TTL window: 0 (cache hits). Outside the TTL window: 1/60. Over
the course of a long browsing session a user might see the same hero
repeatedly. Worth a "last shown" memo to skip the previous pick?

### 4. Duplicate helpers (`_cleanCdnUrl`, `_supabaseRatioCrop`, `_escHtml`)

The home area has its own copies of:
- `_cleanCdnUrl` at line 4637 — versus `_cleanCdnUrl` used at line
  4596 and earlier… wait, that's actually the same const. Let me
  re-verify: the home-area `_cleanCdnUrl` at 4637 is the ONLY one in
  app.js. Books.js bridges to it as `_cfg._cleanCdnUrl` so this is
  shared.
- `_supabaseRatioCrop` at 4653 — same; only definition, bridged into books.js
- `_escHtml` at 4620 — DIFFERENT from `escHTML` imported from
  supabase.js. The home-area `_escHtml` is a private snake-case
  variant. **This should probably just use `escHTML` directly.** Why
  two escapes?

### 5. Removed `Recent` row leaves dead code

Line 5109-5112:

```js
// Recent row was removed from the home layout (May 2026). Keep a
// minimal stub here so the destructure below doesn't break — the
// resolved data is never used.
const recentPromise = Promise.resolve({ data: [], error: null });
```

Plus lines 5199-5201 (`const recent = [];`) and 5226-5236 (the whole
"Render Recent row" block that iterates over an array that's always
empty).

This is dead code by the author's own admission. Should be pruned:
remove `recentPromise` from `Promise.all`, drop the destructure slot,
delete the unused render block.

### 6. Wire-once flags don't reset on sign-out/sign-in

Three flags gate one-time module-level wiring:
- `_bookShelfArrowsWired` (line 4793)
- `_homeTopResizeWired` (line 5389)
- `_dearJenLookupAttempted` (line 4566)

`_dearJenLookupAttempted` is correct — the channel ID is the same
across sessions, no reason to re-lookup.

The other two: if the user signs out and back in as a different user,
the cached state stays. The shelf arrow listeners persist (fine,
they're idempotent reads of module state). The resize-wire flag also
persists (fine).

But `_homeDataLoadedAt` + `_dearJenUploaderId` should probably get
invalidated on sign-out. Currently a signed-out user's cached home
pool (which may include hidden / unlisted videos if their role gave
them visibility) could leak into a new sign-in's first paint.

### 7. TTL cache only covers 60s; "force" path unclear

`HOME_DATA_TTL_MS = 60 * 1000`. The `loadHomeVideos({ force = false })`
signature suggests there's a force-refresh path, but I can't find any
call site that passes `{ force: true }`. So the cache is purely
time-based; user-initiated refresh is "switch tabs and come back
after 60s".

If a creator uploads a new video, the home tab won't show it for up
to 60s after the upload. Probably fine, but worth confirming this
matches expectations.

### 8. Pool size + page-count assumptions

`_BOOKS_PER_PAGE = 6`. Pools are sliced to `_BOOKS_PER_PAGE * 2 = 12`.
The right-arrow cycles `0 → 1 → 0`. Hardcoded 2-page assumption: if
we ever bump `_BOOKS_PER_PAGE` or the slice multiplier, the cycle
math (`page >= maxPage ? 0 : page + 1` with `maxPage = ceil(pool / per
page) - 1`) handles 3+ pages correctly — only the UI affordance is
the "single right arrow that wraps" rather than prev/next pair. So
the math is fine but the UX assumption is 2 pages.

### 9. Banned-author filtering happens post-fetch on every shelf

Every query overfetches (60 videos for hero+trending, 30 for featured
posts, 20 for trending books, etc.) so the post-fetch `.filter(b =>
!b.profiles?.is_banned)` can drop banned rows without making the
shelf go empty. This is the canonical pattern — call out as a
positive, but: is there a RLS policy that should be hiding these
server-side? If so we could fetch tighter pools and drop the client
filter. (Same question applies in feed.js / books.js too.)

### 10. `loadHomeVideos` misnamed

It loads videos AND posts AND books. The name suggests just videos.
Rename to `loadHomeData` for clarity. Low priority.

### 11. `setSidebarActive('btnBook'); if (typeof showBook === 'function') showBook()`

Line 4815-4820 wires the "See all" buttons on book shelves to navigate
to the Books page. The `typeof showBook === 'function'` guard is
useless after Stage 8A — `showBook` is now an imported binding from
books.js (top of file). The guard could be `undefined` against a
hoisted import only if the import failed entirely, in which case the
sidebar nav button is also broken.

Drop the typeof guard:
```js
btn.addEventListener('click', () => {
  setSidebarActive('btnBook');
  showBook();
});
```

### 12. Admin pencil edit button has no permission check on the server side

`_replaceBookCoverFromHome` (line 4831) is gated UI-side by
`currentProfile?.role === 'admin' || 'moderator'` at line 4936 (the
pencil button only renders for admins/mods). But the function itself
does a direct `supabase.from('books').update({ cover_url: publicUrl }
).eq('id', bookId)` — relies on RLS to actually enforce the
permission.

**Action**: verify the `books` table UPDATE policy actually rejects
non-admin/mod authenticated users. If not, a regular user could
discover this code path and update any book's cover_url by inventing
a `bookId`. (Also calls out a broader audit item: every
admin-gated UI button needs a matching server-side check.)

### 13. `_homeDataInFlight` never clears on error?

Looking at lines 5168-5358: the `.then(...)` resolves, the
`.catch(...)` swallows errors, and `.finally(...)` clears
`_homeDataInFlight = null`. So that's fine — error path is covered.
But the comment "Skeleton stays — no destructive UI change on
failure" leaves the user with permanent loading skeletons if the
queries silently fail. There's no retry CTA, no error toast. The user
just sees skeletons forever until they navigate away.

### 14. Each card uses `_escHtml(book.id)` to interpolate into a data attribute

Line 4938: `<button class="home-book-edit" data-book-id="${_escHtml(book.id)}" ...>`. Book IDs are UUIDs (no escape needed), but the
`_escHtml` is defensive. Fine.

But the click handler at 4986 reads `editEl.dataset.bookId` — which
`dataset` returns already-unescaped. So the round-trip is consistent.
Worth noting that the same pattern (escape on write, unescape on read
via `dataset`) is the right way to do this everywhere; flag any place
that doesn't follow it.

## What to opine on

Hand-pick — you don't need to cover all 14. The highest-value items
are probably:

- **#1** (debug log strip — easy P3)
- **#5** (dead Recent-row code — easy P3, clarity win)
- **#12** (RLS check on admin pencil — security P1 if it fails)
- **#11** (typeof showBook guard is now meaningless — P3)
- **#6** (home cache should invalidate on auth change — P2)

The rest are observations Codex can confirm or dismiss.

## How to run / verify

```bash
node --check js/app.js                   # passes
bash scripts/pre-deploy-check.sh         # same advisory warnings as Stage 8
```

Then in the browser:

1. Click Home in sidebar → mosaic populates (hero + trending stack +
   featured posts + 2 book shelves)
2. Click the right-arrow on a book shelf → flips to page 2 → click
   again → wraps back to page 1
3. As admin, hover a book cover → pencil edit appears → click → file
   picker → cropper → upload → shelf re-renders with new cover
4. Click any video card → playVideo opens it
5. Click any book card → openBookDetail opens it
6. Click any featured post → openPostFromSearch opens it
7. Sign out → sign back in → home tab should NOT show previous user's
   cached state (currently it might — see #6)

## Pre-existing notes

These aren't bugs but context Codex should know:

- The home page is loaded as part of `js/app.js`, not a separate
  module. Any future extraction would be `js/home.js` following the
  Stage 5-8 pattern (config injection via `_cfg`, exported
  `initHome({...})` + `wireHomePage()`).
- The hero's height drives the layout — `_syncHomeTopHeights` (line
  5375) used to math out column heights to match. As of May 2026
  it's been simplified to just clear inline heights and let CSS own
  sizing. The function name is now misleading; could be removed.
- `_wireHomeTopHeightSync` (line 5390) wires a debounced window
  resize listener that calls the now-defunct sync. Probably can be
  removed entirely.
