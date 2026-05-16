# Stage 8B — Codex Review Brief (Book detail + chapter reader)

## Context

Continuation of the 13-stage refactor that splits monolithic
`js/app.js`. Stage 8A moved Books listing/discovery (charts, search,
recs) into `js/books.js`. Stage 8B (this commit) moves the
**book detail page + chapter reader** — the second half of the books
surface.

Charles has hand-tested 8A in the browser; this brief is the sanity
check on 8B before commit. Bookmarks page (videos + books dispatcher)
stays in app.js — it straddles two domains and gets its own future
module.

## Files in the diff

- `js/books.js` (1,505 → 2,398 lines, +893) — Stage 8B append block at
  the bottom: 9 state vars + 11 functions + `flushReadClose()` (moved
  with its state) + `wireBookReader()` (hand-written DOM wiring)
- `js/app.js` (17,558 → 16,795 lines, −763) — moved code removed,
  import + `initBooks({...})` expanded with the new bridges,
  `wireBookReader()` call added after `wireBooksPage()`
- `scripts/extract-stage8b.js` (NEW) — jscodeshift codemod (handles
  `export async function` wrappers, expanded GLOBAL_GETTERS for
  `currentProfile` and `_walletConfigDefaults`)
- `scripts/scan-books8b-undef.js` (NEW) — pre-flight scan, only false
  positives remain (single-letter arrow params, destructured
  Promise.all bindings, `prompt` browser-global)
- `js/app.js.before-stage8b` (NEW, .gitignore'd) — backup

## What moved

**Functions (11):** openBookDetail, renderBookDetail,
loadBookActionState, setBookActionActive, toggleBookLike,
toggleBookBookmark, openChapterReader, normalizeChapterContent,
saveReadingProgress, getReaderWatermarkLabel, applyReaderWatermark.

**State (9):** currentBookDetail, currentChapterIndex, readerFontSize,
_openBookToken, _watermarkLabelCache, _readMaxScrollPct,
_readChapterOpenTs, _readChapterOpenId, _readChapterOpenBookId.

**Hand-moved (in addition to codemod):**
- `flushReadClose()` — pairs with the 4 `_readChapter…` state vars
  it reads. Moved from app.js to books.js, exported, re-imported by
  app.js (hideAllMainPages still calls it on nav-out). The intra-module
  call from `openChapterReader` was rewritten from `_cfg.flushReadClose()`
  back to the bare `flushReadClose()` since both live in books.js now.
- `wireBookReader()` — 6 module-level wiring blocks the codemod can't
  touch: btnBackBooks, #sidebarThemeToggle watermark sync, the
  setupReaderAntiCopy IIFE, btnReaderPrev/Next, btnBackBookDetail,
  btnReaderFontSmaller/Larger.

## `_cfg` bridge surface (additions in 8B)

Bridges that target.js-owned helpers books.js calls back into for
detail-page/reader logic:

- **Identity getters:** `getCurrentProfile` (Editor's-Pick admin gate)
- **Wallet config:** `getWalletConfig` — read as an object via `.X` from
  app.js's top-level `_walletConfigDefaults`. The codemod rewrites every
  bare `_walletConfigDefaults.X` to `_cfg.getWalletConfig().X`. The
  app.js side passes `() => _walletConfigDefaults` so the live object
  comes through (and stays in sync with the realtime app_config sub).
- **Paywall:** `openUnlockDialog`, `openBulkBookUnlockDialog`,
  `isUnlocked`, `resolveUnlockCost` (same surface as feed/videos)
- **Engagement:** `tickGoalUnique`, `logRead`

`flushReadClose` was REMOVED from `_cfg` (no bridge needed — it lives
inside books.js).

## What's intentionally NOT moved

- `showBookmarks`, `loadBookmarks`, `loadBookBookmarks`,
  `loadVideoBookmarks` → stays in app.js. The bookmarks page is a
  videos+books dispatcher; moving half of it would force books.js to
  export a function the dispatcher calls alongside a videos.js
  function. Cleaner cut once the bookmarks page gets its own module.
- `lockBookFromPrompt`, `dismissBookLockPrompt` → stays in app.js. They
  reference Studio state (`_authorBookLockPromptDismissed`,
  `editingBookId`, `setBookLockUI`, `loadAuthorDashboard`) — Studio
  territory, not reader.
- `_pendingChapterFromUrl` → stays in app.js. Set by boot router and
  popstate handler. **Note for Codex: this var appears to be set but
  never read. May be dead code from a half-finished deep-link auto-open
  feature. Please flag if so — out of scope to delete here.**
- `bookDetailPage`, `chapterReaderPage` consts stay in app.js (hideAllMainPages
  reads them directly) but are also re-resolved in books.js via the
  same `document.getElementById(...)` pattern. Two copies of an
  always-the-same DOM element ref. Matches the `bookPage` pattern from 8A.

## Specific concerns to verify

The 10 failure patterns I want second eyes on. Items 1-7 mirror the 8A
brief; items 8-10 are new to 8B.

### 1. Export-wrapper handling

`openBookDetail` was defined as `export async function openBookDetail`
in app.js (a leftover from when it was app.js-exported for the
notification routing imports). The codemod's `EXTRACT_FNS` loop has a
new path that detects ExportNamedDeclaration wrappers and removes the
WHOLE wrapper — otherwise we'd be left with an empty `export ;` and a
parse error. Please confirm:
- `openBookDetail` is now a plain `async function` (no `export`) inside
  books.js
- The Stage 8A bridge `openBookDetail: () => {}` default in the `_cfg`
  block can stay no-op (intra-module calls reach it directly now), but
  if you spot any consumer in app.js still trying to call
  `_cfg.openBookDetail` from books.js code, that's a bug.

### 2. wallet config getter rewrites

Every `_walletConfigDefaults.X` read in moved code became
`_cfg.getWalletConfig().X`. There were ~5 such sites in renderBookDetail
(bulk-unlock discount + cost summation). Please scan books.js for any
lingering bare `_walletConfigDefaults` reference — should be 0.

### 3. flushReadClose ownership swap

`flushReadClose` moved from app.js to books.js along with its 4 state
vars. App.js imports it now and `hideAllMainPages` calls it directly.
`openChapterReader` (in books.js) calls it as a sibling function, not
through `_cfg`. Please confirm:
- No remaining `_cfg.flushReadClose` calls in books.js
- The `flushReadClose` initBooks default + bridge entry are GONE from
  books.js's `_cfg` block + app.js's `initBooks({...})`
- Inline `try { flushReadClose(); } catch {}` in app.js's
  hideAllMainPages still resolves (via the import)

### 4. Anti-copy IIFE scoping

The IIFE was lifted as-is into `wireBookReader()`. It registers a
document-level keydown listener that checks `isReaderVisible()` (which
reads books.js's `chapterReaderPage` ref). Please confirm the closure
captures the books.js copy of `chapterReaderPage`, not app.js's. (They
both point to the same element so functionally identical, but worth a
mental check.)

### 5. Duplicate DOM refs (`bookDetailPage`, `chapterReaderPage`)

Both modules declare `const bookDetailPage = document.getElementById(...)`
at the top. Lifecycle is once-at-module-load; the element doesn't get
swapped. As long as the script tag has `type="module"` or is at end of
body, both lookups resolve to the same node. Please flag if you see any
code path that swaps `#bookDetailPage` (none expected).

### 6. wireBookReader idempotency

`wireBookReader()` is called once at boot, immediately after
`wireBooksPage()`. Like its sibling, it has no `removeEventListener`
companion — if app.js ever re-mounts the books page on auth change,
listeners would leak. Please check whether app.js does any such
re-mount; if not, leave as-is.

### 7. currentProfile read in renderBookDetail (Editor's-Pick gate)

The Editor's-Pick button is rendered only if
`currentProfile?.role === 'admin' || currentProfile?.role === 'moderator'`.
The codemod rewrote this to `_cfg.getCurrentProfile()?.role`. App.js
passes `getCurrentProfile: () => currentProfile`. Two reads in the same
template literal → two `_cfg.getCurrentProfile()` calls. Cheap, but if
you notice the rendered HTML showing the button for non-admins (or
hiding it for admins), that's the symptom.

### 8. NEW — paywall round-trip

`openChapterReader` renders an inline paywall (the
`<div class="reader-paywall">` block) when the chapter is locked. The
"Unlock chapter" button click handler calls `_cfg.openUnlockDialog`
with `onUnlocked: () => openChapterReader(chapterIndex)`. After
unlocking, openChapterReader re-runs and should now see
`_cfg.isUnlocked('chapter', resolvedChapterId)` return `true`. This
plumbing (Stage 7B already taught us `key:value` shape mismatches
break unlock state) — please confirm the bridged `isUnlocked` /
`openUnlockDialog` calls match the same key shape app.js writes.

### 9. NEW — reading progress writes

`saveReadingProgress(bookId, chapterId, chapterNumber)` does an upsert
into `book_reads` AND an insert-then-update-on-conflict into
`chapter_reads`. The function doesn't read app.js state — pure DB write
behind `supabase.auth.getUser()`. Please confirm:
- No bare `currentUser` references remain (codemod should have caught
  these; if any survived, the user.id read would fall back to the
  inline `auth.getUser()` call — that's actually fine but the codemod
  shouldn't have left a bare `currentUser` either)
- The trigger that bumps `chapters.views_count` and `books.views_count`
  on `chapter_reads` insert/update still fires (no code change here,
  just verifying nothing in the moved function would prevent it)

### 10. NEW — watermark cache lifetime

`_watermarkLabelCache` is module-private to books.js. It caches the
username string used in the SVG watermark. The cache never clears on
sign-out — same behavior as before the move (app.js had the same
issue). If a user signs out and a different user signs in within the
same browser session, they'd see the previous user's watermark.

**This is pre-existing behavior**, not something introduced by 8B —
please confirm the move didn't introduce a NEW cache-invalidation
problem. (If you think it's worth fixing in this commit, flag it; I'd
rather queue a follow-up so the extraction stays pure code movement.)

## How to run / verify

```bash
node --check js/app.js && node --check js/books.js     # both pass
bash scripts/pre-deploy-check.sh                        # passes (5 advisory warnings, same as 8A)
node scripts/scan-books8b-undef.js                      # only false-positives
```

Then in the browser:

1. Tap a book card → detail page renders (cover, meta, chapters, like/bookmark/Editor's Pick)
2. Click "Start reading" → chapter 1 opens in reader
3. Reader: prev/next chapter buttons, font smaller/larger (size persists across re-open via localStorage), back to detail, back to book listing
4. Anti-copy: Cmd-A inside reader is blocked + shows a (throttled) toast; right-click also blocked
5. Watermark visible behind chapter text; toggle theme (Light↔Dark) in sidebar → watermark colour updates after ~50ms
6. Locked chapter → paywall card shows; tap Unlock → unlock dialog → after success, chapter re-opens with content
7. Like / Bookmark toggle: optimistic flip, persists via DB, reverts on error
8. Sign-out mid-read: hideAllMainPages flushes the chapter close event (via the imported `flushReadClose`)
9. Editor's Pick button visible only when signed in as admin/moderator
10. Bulk-unlock CTA shows when ≥1 chapter locked; cost = sum of per-chapter prices minus bulk discount (from `_walletConfigDefaults.book_bulk_unlock_discount_pct`)

## Pre-existing things I'd love a sanity check on

(Not introduced by this commit — but if you're already reading the
moved code, easy to opine on.)

- `_pendingChapterFromUrl` set but never read (see "Intentionally NOT moved" above)
- `_watermarkLabelCache` never invalidates on sign-out (see #10)
- The Editor's-Pick `prompt(...)` for the optional editorial note — uses the browser-native `prompt`, which is a poor UX. Maybe queue a polish task to replace with a styled modal.
