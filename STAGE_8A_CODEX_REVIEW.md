# Stage 8A — Codex Review Brief (Books listing/discovery extraction)

## Context

We're doing a 13-stage refactor that splits the 800k+ `js/app.js`
monolith into per-feature modules. Stage 8A moves the **Books listing
& discovery** surface into `js/books.js`. The detail page + chapter
reader (with their anti-copy IIFE, theme-toggle watermark sync, and
reader nav-button wiring) stay in `app.js` until Stage 8B.

Charles has hand-tested this in the browser — For You / Discover /
Ranking / Reading List / See-All / search all render. Codex review
is the sanity check before commit.

Stages 1–7 followed this same extract-codemod-then-review pattern and
flagged a recurring class of bugs every time, summarised below.

## Files in the diff

- `js/books.js` (NEW, 1,505 lines) — skeleton header + 34 fns + 30
  state vars/consts + getter/setter accessors + `wireBooksPage()`
- `js/app.js` (18,857 → 17,558 lines, −1,299) — extracted code
  removed, import + `initBooks({...})` + `wireBooksPage()` call
  added, three module-level wiring blocks deleted, five cross-file
  state refs routed through accessors
- `scripts/extract-stage8a.js` (NEW) — the jscodeshift codemod that
  performed the extraction
- `scripts/scan-books-undef.js` (NEW) — pre-flight unbound-identifier
  scanner used to derive the `_cfg` bridge list before the codemod ran
- `js/app.js.before-stage8a` (NEW, .gitignore'd) — backup for diffing

## What moved (full list)

**Functions (34):** showBook, loadBooksTab, _loadForYouTab,
_renderBookSection, _fetchHiddenGems, _fetchQuickReads,
_fetchWeeklyFeaturedWithFallback, _fetchRecommendedForUser,
_loadRankingTab, _renderRankGenreChips, _loadRankingForGenre,
_renderRankCard, _loadDiscoverTab, _loadDiscoverGenreRow,
_loadCollectionTab, _loadReadingListTab, _renderBookCardV2,
_openBookSeeAll, _loadMoreSeeAllBooks, _setupSeeAllInfiniteScroll,
applyBookFilter, searchBooks, runBookSearch, renderWriterChannelCard,
_normalizeBookRow, _normalizeBookRows, fetchSupabaseBooks,
fetchBooksServerSearch, renderBookCard, prettyGenre,
getUserBookTaste, renderBookChips, loadBookRecommendations,
renderBookRecsRail.

**State/consts (30):** allBooksCache, allBooksRaw, bookGenreFilter,
bookSortBy, activeBookSearchQuery, _activeBookTab, _bookTabLoaded,
_booksOffset, _rankingActiveGenre, _rankingSeq, _seeAllSeq,
_seeAllOffset, _seeAllSort, _seeAllGenre, _seeAllFilter,
_seeAllHasMore, _seeAllLoading, _seeAllObserver,
_userBookTasteCache, _userBookTasteAt, _bookRecsCache,
_bookRecsTimestamp, _SECTION_ROW_SIZE, _FORYOU_SECTIONS,
_RANKING_GENRES, _DISCOVER_GENRES, _SEE_ALL_MAP, BOOKS_PAGE_SIZE,
BOOK_LIST_SELECT, BOOK_CARD_SELECT, _BOOK_SORT_PIPELINES,
PRETTY_GENRE, BOOK_RECS_TTL.

**Exports added:** all 34 fns + `wireBooksPage()` + getter/setter
pairs for `_activeBookTab` and `activeBookSearchQuery` (because
`app.js`'s topbar search input reads/writes both).

## `_cfg` bridge surface

These are the app.js-owned helpers that books code calls back into.
The codemod rewrote bare calls to `_cfg.X` inside every moved fn,
defaults are no-ops in the books.js skeleton, app.js's `initBooks({
... })` wires the real implementations:

- Identity: `getCurrentUser` (mapped from `currentUser` global)
- Navigation: `hideAllMainPages`, `stopVideoPlayer`, `openProfile`,
  `openBookDetail` (bridged because detail page is still in app.js
  for Stage 8B; book cards and ranking rows route through this)
- Formatters: `formatCompact`
- Search sanitisers: `sanitizeSearchQuery`, `escapeIlike`,
  `normalizeForSearch`
- CDN URL helpers: `_cleanCdnUrl`, `_supabaseRatioCrop` (used by
  `_renderBookCardV2` to crop covers — top-level const arrows in
  app.js at ~4596 and ~4612)

## What did NOT move (and why)

Intentional exclusions so 8A stays small + reviewable:

- `openBookDetail`, `renderBookDetail`, `openChapterReader`,
  `normalizeChapterContent`, `saveReadingProgress`,
  `getReaderWatermarkLabel`, `applyReaderWatermark` → **Stage 8B**.
  These pair with state app.js still owns (`currentBookDetail`,
  `currentChapterIndex`, `readerFontSize`, `_readMaxScrollPct`,
  `_openBookToken`, `_watermarkLabelCache`) plus three module-level
  side-effects (the `setupReaderAntiCopy` IIFE, the
  `#sidebarThemeToggle` listeners that re-render watermark on theme
  flip, and the reader prev/next/font/back button wiring). Those
  need a hand-written `wireBookReader()` init helper, not a codemod.
- `toggleBookLike`, `toggleBookBookmark`, `loadBookActionState`,
  `setBookActionActive` → Stage 8B (coupled to the detail-page
  action buttons).
- `showBookmarks`, `loadBookmarks`, `loadBookBookmarks` → Stage 8B
  (bookmarks dispatcher pairs with the detail-page toggle).
- `lockBookFromPrompt`, `dismissBookLockPrompt` → Stage 8B.
- `_previewBookBulkUnlock`, `openBulkBookUnlockDialog` → stays in
  app.js. The bulk-unlock modal is shared with the video paywall —
  same markup, same RPC. Moving it would couple books.js to the
  video flow.
- `_replaceBookCoverFromHome`, `_getWebBookPool` → stays in app.js.
  Both are home-page mosaic concerns called by feed.js too.
- Studio territory (`openNewBookModal`, `openAuthorBookEditor`,
  `loadBookEditor`, `saveBookMetadata`, `saveChapter`,
  `openChapterPublishModal`, `openChapterImagePicker`,
  `setBookLockUI`, `recomputeBookCounts`, `renderAuthorBookRow`,
  `deleteAuthorBook`, `createNewBook`) → future Studio extract.
- Video bookmarks (`loadVideoBookmarks`, `loadVideoBookmarkState`,
  `setVideoBookmarkActive`, `toggleVideoBookmark`) → videos.js
  territory.

## Specific concerns to verify

These are the failure patterns that bit us in Stages 5/6/7:

### 1. Unbound identifier reads (the Stage 5 trap)

When `_feedSeq` moved to feed.js but a call-site in app.js still
referenced it bare, we got a "ReferenceError: _feedSeq is not
defined" at runtime. Same risk here for every name we moved.

Already swept: `_activeBookTab`, `_seeAllObserver`,
`activeBookSearchQuery`, `loadBooksTab`, `_openBookSeeAll`,
`runBookSearch`, `showBook`, `fetchSupabaseBooks`,
`fetchBooksServerSearch`, `renderBookCard`, `_renderBookCardV2`,
`prettyGenre`, `renderBookChips`, `loadBookRecommendations`,
`_normalizeBookRow`, `_normalizeBookRows`, `renderWriterChannelCard`.

Please re-grep `js/app.js` for any of the moved names being used
bare without an import — particularly inside large helpers I might
have missed (e.g. the home-page shelf renderer, the deep-link
router on hash change, anywhere `searchBooks(...)` might still be
called for the local-cache fallback).

### 2. Bare `currentUser` reads in moved fns (the Stage 6 trap)

The codemod rewrites `currentUser` → `_cfg.getCurrentUser()`. If
any function escaped the rewrite (e.g. because it was nested inside
something the codemod didn't enter), it'll silently look at
`undefined` instead of the actual user.

Please scan books.js for any bare `currentUser` reference that isn't
part of a property name. The expected count is 0.

### 3. Bare cross-feature helper calls (the Stage 5 trap)

Same risk for `hideAllMainPages`, `stopVideoPlayer`, `openProfile`,
`openBookDetail`, `formatCompact`, `sanitizeSearchQuery`,
`escapeIlike`, `normalizeForSearch`, `_cleanCdnUrl`,
`_supabaseRatioCrop`. The codemod rewrites only CallExpression
callees — if any of these are passed as values (e.g.
`somethingThatTakesACallback(openBookDetail)`), the rewrite won't
fire and the call will reference the now-undefined name.

I don't think any books fn passes these as values, but please
confirm by greping books.js for bare uses of those names.

### 4. Accessor symmetry (`_activeBookTab`, `activeBookSearchQuery`)

These two now live in books.js but app.js still reads + writes both
via `getActiveBookTab/setActiveBookTab` and
`getActiveBookSearchQuery/setActiveBookSearchQuery`. The four
cross-file sites are:

- `app.js` line ~5687: `setActiveBookSearchQuery('')` (context-switch reset)
- `app.js` line ~5708: `setActiveBookSearchQuery(value)` (input handler)
- `app.js` line ~5755: `setActiveBookSearchQuery('')` (search-clear)
- `app.js` line ~5761: `getActiveBookTab()` (panel restore after clear)

Please verify these are the only such sites and that no path skips
the accessor (which would write to an undefined module-scope var
and silently no-op).

### 5. `bookPage` const lifetime

`books.js` declares `const bookPage = document.getElementById('bookPage')`
at module load — mirroring `app.js`'s pattern at line 7116. Books.js
is loaded as an ES module via app.js's import graph. ES modules
defer execution past HTML parse, so `getElementById` should resolve.
But: if `app.js` is loaded via `<script src=… type="module">` at the
top of `<head>`, the import chain might fire **before** `<body>` is
parsed, in which case `bookPage` would be `null`. Please confirm
the `<script>` tag in `index.html` is at end-of-body OR has `defer` /
`type="module"` (which implies defer), and that books.js doesn't
crash at module load on a fresh page-load.

### 6. wireBooksPage idempotency / boot order

`wireBooksPage()` is called from app.js exactly once, immediately
after `initBooks({...})`. It attaches three event listeners:

- `#bookTabs` click → tab switch
- `#bookPage` click → See-All delegation
- `#btnBookSeeAllBack` click → return to tab

If app.js sign-out + sign-in tears down + re-mounts the page, these
listeners will leak (no `removeEventListener` pair). Please confirm
whether app.js re-mounts the books page on auth change — if yes,
we need a `teardownBooksPage()` companion. If no, fine as-is.

### 7. Codemod string-literal collisions

The codemod only rewrites Identifier AST nodes — it cannot touch
string literals. But please spot-check for any rewriter overreach,
particularly in template literals where `openBookDetail` or
`currentUser` could appear as text (e.g.
`'data-handler="openBookDetail"'` in an HTML string).

### 8. _bookTabLoaded behavior

`_bookTabLoaded` is an object literal that's mutated in place. The
codemod moved it as a state declaration, but please confirm that
`force=true` still resets the gate on subsequent
`loadBooksTab('foryou', true)` calls — that's the path used by the
sign-in success handler to force-refresh after the user logs in.

### 9. _SEE_ALL_MAP filter closures

`_SEE_ALL_MAP` has two entries (`hiddenGems`, `quickReads`) whose
`filter` value is an arrow function that closes over `q`. Those
arrows reference no outer scope from app.js, but please confirm by
reading the moved definition that they still work standalone in
books.js.

### 10. Pre-deploy guards

`bash scripts/pre-deploy-check.sh` passes all 6 blocking checks
(duplicate IDs, duplicate fn names, syntax check, orphan-call sweep,
placeholder sweep, core-protected file warning). The orphan-call
sweep flags `showBook`, `renderBookCard`, `loadStories`,
`loadMoreFeed`, `renderPost`, `loadVideos`, `loadStudio`,
`showVideos` as possibly-undefined — these are all false positives
because the sweep doesn't follow ES module imports.

## What I'd love a second pair of eyes on

1. Anything I missed in the bridge list — particularly cross-feature
   helpers called from inside the rec-rail scorer
   (`loadBookRecommendations`), the search dispatcher
   (`runBookSearch`), or the Reading List loader (`_loadCollectionTab`).
2. The `_cleanCdnUrl` + `_supabaseRatioCrop` bridge — these are
   used by `_renderBookCardV2` only. If they're also called from
   other moved fns, my bridge list misses it.
3. The boot order: `import books.js` → top-level `const bookPage =
   document.getElementById('bookPage')` → `initBooks({...})` →
   `wireBooksPage()`. If any of these fire before the bookPage DOM
   exists, we get silent breakage.
4. Whether the `searchBooks(query)` local-cache fallback is still
   reachable. The function moved to books.js but I don't see any
   call site for it in app.js post-extraction. It may be a dead
   path now — if so, fine to leave for the Stage 8B audit; please
   just flag it so we know.

## How to run / verify

```bash
node --check js/app.js && node --check js/books.js     # both pass
bash scripts/pre-deploy-check.sh                        # passes (5 advisory warnings)
node scripts/scan-books-undef.js                        # only false-positives remain
```

Then in the browser:

1. Hard-reload, click sidebar Books → For You tab populates 10 rails
2. Switch Discover → 8 genre rows load in parallel
3. Switch Ranking → chip rail + leaderboard, switch genre chip
4. Switch Reading List → bookmarks grid (signed-in) / sign-in CTA (signed-out)
5. Click any "See All" → opens sub-view, infinite scroll fires
6. Click See All back button → returns to active tab
7. Type in topbar search while books page is visible → See-All grid
   shows writer cards + book results
8. Switch to home page mid-search → search input clears
9. Tap a book card → openBookDetail still renders (bridged via _cfg
   until 8B re-homes it)
