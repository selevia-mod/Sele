// ════════════════════════════════════════════════════════════════════════
// Selebox Books listing + discovery — extracted from js/app.js as Stage 8A
// of the refactor roadmap. This module owns the READ side of the books
// surface — everything that paints lists or fetches collections of books.
// The detail page + chapter reader live in Stage 8B (deferred so the
// IIFE / DOM-wiring there can get its own dedicated init helper without
// gating this commit).
//
// In this module:
//   • showBook + loadBooksTab — page entry + tab dispatcher
//   • For You tab: _loadForYouTab + 4 rail-specific fetchers
//     (_fetchWeeklyFeaturedWithFallback, _fetchRecommendedForUser,
//      _fetchHiddenGems, _fetchQuickReads) + the _FORYOU_SECTIONS table
//   • Discover tab: _loadDiscoverTab + _loadDiscoverGenreRow
//   • Ranking tab: _loadRankingTab + _renderRankGenreChips +
//     _loadRankingForGenre + _renderRankCard
//   • Reading List tab: _loadCollectionTab + _loadReadingListTab
//   • See All sub-view: _openBookSeeAll + _loadMoreSeeAllBooks +
//     _setupSeeAllInfiniteScroll + _SEE_ALL_MAP
//   • Search: runBookSearch + searchBooks + renderWriterChannelCard
//   • Filter / normalisation: applyBookFilter, _normalizeBookRow/Rows
//   • Data fetchers: fetchSupabaseBooks, fetchBooksServerSearch
//   • Card renderers: renderBookCard, _renderBookCardV2, _renderBookSection
//   • Recommendation rail: getUserBookTaste, renderBookChips,
//     loadBookRecommendations, renderBookRecsRail
//   • Genre helpers: prettyGenre + PRETTY_GENRE table
//
// NOT moved here (deferred to Stage 8B):
//   • openBookDetail + renderBookDetail (book detail page)
//   • openChapterReader + reader helpers (chapter reader page)
//   • toggleBookLike + toggleBookBookmark + loadBookActionState (book
//     detail action buttons — coupled to the detail page lifecycle)
//   • showBookmarks + loadBookmarks + loadBookBookmarks (bookmarks
//     dispatcher — stays paired with the detail-page toggle)
//   • Reader watermark, anti-copy IIFE, font controls, prev/next wiring
//
// NOT moved at all (stays in app.js by design):
//   • _previewBookBulkUnlock + openBulkBookUnlockDialog (bulk-unlock
//     dialog is shared with the video paywall — same modal markup)
//   • _replaceBookCoverFromHome (home page mosaic territory)
//   • _getWebBookPool (home feed concern, called by feed.js too)
//   • Studio book editor: openNewBookModal / openAuthorBookEditor /
//     loadBookEditor / saveBookMetadata / saveChapter etc. — those
//     belong in a future Studio extract
//
// CAREFUL: pure code movement. Inward references rewritten to _cfg.X via
// the Stage 8A jscodeshift codemod (scripts/extract-stage8a.js). Module-
// private state lives at the bottom of this file. Page-level wiring
// (tab click delegation, See-All click delegation, See-All back button)
// stays in app.js because it has to run after the bookPage DOM exists —
// app.js loads first and already owns that timing concern.
// ════════════════════════════════════════════════════════════════════════

import { supabase, toast, escHTML, initials } from './supabase.js';

// ─── Config-injection dependency surface ─────────────────────────────────
// These are app.js-owned helpers that books code calls into. The codemod
// rewrites bare `helperName(...)` calls inside extracted functions to
// `_cfg.helperName(...)`. Defaults are no-ops so the module loads cleanly
// even before initBooks() has been called from app.js.
let _cfg = {
  // Identity / session
  getCurrentUser:        () => null,

  // Navigation / page switching
  hideAllMainPages:      () => {},
  stopVideoPlayer:       () => {},
  openProfile:           () => {},

  // (openBookDetail used to be bridged here — removed in Stage 8B Codex
  // review. The function lives in this module now; book cards / ranking
  // rows / writer-channel cards call it directly as a sibling instead of
  // routing through _cfg, which used to silently no-op against the
  // default and break every "tap a book" surface.)

  // Formatters (shared with feed/videos)
  formatCompact:         (n) => String(n || 0),

  // Search-input sanitisers from app.js
  sanitizeSearchQuery:   (s) => s || '',
  escapeIlike:           (s) => s || '',
  normalizeForSearch:    (s) => (s || '').toString().toLowerCase().trim(),

  // CDN URL helpers (live in app.js as top-level const arrows). Bridged
  // because _renderBookCardV2 composes the cover URL through them.
  _cleanCdnUrl:          (u) => u,
  _supabaseRatioCrop:    (u, _opts) => u,

  // ─── Stage 8B bridges (book detail page + chapter reader) ────────────
  // Identity getter for currentProfile — read by the Editor's-Pick btn
  // visibility check in renderBookDetail.
  getCurrentProfile:     () => null,

  // Wallet config — read as an object via `.field` from app.js's
  // top-level `_walletConfigDefaults`. The codemod rewrites every bare
  // `_walletConfigDefaults.X` read to `_cfg.getWalletConfig().X`.
  getWalletConfig:       () => ({}),

  // Unlock / paywall (shared with feed + videos — app.js owns).
  openUnlockDialog:      () => {},
  openBulkBookUnlockDialog: () => {},
  isUnlocked:            () => false,
  resolveUnlockCost:     () => 0,

  // Engagement counters + anti-fraud telemetry. (flushReadClose lives
  // in this module since Stage 8B — it pairs with the four open-state
  // vars below. No bridge needed.)
  tickGoalUnique:        () => {},
  logRead:               () => {},
};

export function initBooks(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// Eager DOM refs — these elements exist in index.html. Books.js is loaded
// as an ES module via app.js's import graph, which executes after the HTML
// parser has built the body, so getElementById here is safe. App.js holds
// its own copies of `bookDetailPage` + `chapterReaderPage` because
// hideAllMainPages reads them directly — duplicating the lookup here keeps
// each module self-contained without a cross-import dependency on those
// const exports.
const bookPage         = document.getElementById('bookPage');
const bookDetailPage   = document.getElementById('bookDetailPage');
const chapterReaderPage = document.getElementById('chapterReaderPage');

// ════════════════════════════════════════════════════════════════════════
// Extracted state + functions are appended below by the Stage 8A script.
// ════════════════════════════════════════════════════════════════════════


// ─── Module state ─────────────────────────────────────────────────
// ════════════════════════════════════════
// BOOK / READER
// ════════════════════════════════════════
let allBooksCache = [];     // filtered + sorted view (what's rendered)
let allBooksRaw   = [];     // unfiltered raw books fetched from server (for fast tab switching)
let bookGenreFilter = '';
let bookSortBy = 'trending';
let activeBookSearchQuery = '';
// ── Books page (mirrors mobile-app shape: tabbed sections of curated rows) ──
//
// Tabs:
//   foryou      → Weekly Featured (editor's picks) / Fresh Reads / Completed & Excellent
//   discover    → Genre-grouped rows of top books
//   ranking     → Most Loved / Most Read / Trending This Week
//   readinglist → User's bookmarks
//
// (Library was dropped from web — the sidebar's existing Bookmarks page
// already plays that role; mobile app's "Library" maps to web's Bookmarks.)
//
// Each section has a See All link that opens an in-page list view with
// infinite scroll, sorted/filtered the same way that section was populated.
// ────────────────────────────────────────────────────────────────────────────
let _activeBookTab = 'foryou';
const _bookTabLoaded = { foryou: false, discover: false, ranking: false, readinglist: false };
let _booksOffset = 0;
let _rankingActiveGenre = '';
let _rankingSeq = 0;
// ── See All sub-view ───────────────────────────────────────────────────────
let _seeAllSeq = 0;
let _seeAllOffset = 0;
let _seeAllSort = '';
let _seeAllGenre = null;
// Optional custom predicate for See-All — set when the section had a `filter`
// in _SEE_ALL_MAP (Hidden Gems, Quick Reads). Threaded through to fetchSupabaseBooks.
let _seeAllFilter = null;
let _seeAllHasMore = false;
let _seeAllLoading = false;
let _seeAllObserver = null;
// Cache for user's book reading taste (reads + likes) — used by both
// renderBookChips() and loadBookRecommendations() in the same page load.
// 60-second TTL so stale-but-fresh-enough data doesn't trigger 2 round-trips.
let _userBookTasteCache = null;
let _userBookTasteAt = 0;
let _bookRecsCache = null;
let _bookRecsTimestamp = 0;
// (The old fire-and-render `_loadBookSection` was removed when For You and
// Ranking moved to the parallel-fetch + claim-by-priority pattern below.
// `_renderBookSection` is the new render-only helper.)

// ── For You tab — 10 Wattpad-inspired rails ────────────────────────────────
//
// Strategy: fetch all rails in parallel (each overfetches 2× for dedup
// headroom), then walk them in priority order and CLAIM books — once a
// book lands in an earlier rail, later rails skip it. This guarantees
// every book appears at most once across the whole For You tab, while
// keeping the parallel speed (no sequential wait between waves).
//
// Order is the priority order: curated → personal → fresh activity →
// discovery → format → all-time → completed. Edit this array to reorder.
const _SECTION_ROW_SIZE = 7;
const _FORYOU_SECTIONS = [
  { key: 'weeklyFeatured',     fetch: (n) => _fetchWeeklyFeaturedWithFallback(n),                       empty: 'No featured books yet' },
  { key: 'recommended',        fetch: (n) => _fetchRecommendedForUser(n),                               empty: 'Read a few books to get personalised picks' },
  { key: 'trending',           fetch: (n) => fetchSupabaseBooks(0, n, 'trending'),                      empty: 'Nothing trending yet' },
  { key: 'freshReads',         fetch: (n) => fetchSupabaseBooks(0, n, 'recent'),                        empty: 'No fresh reads' },
  { key: 'justUpdated',        fetch: (n) => fetchSupabaseBooks(0, n, 'just-updated'),                  empty: 'No recent updates' },
  { key: 'hiddenGems',         fetch: (n) => _fetchHiddenGems(n),                                       empty: 'No hidden gems found' },
  { key: 'quickReads',         fetch: (n) => _fetchQuickReads(n),                                       empty: 'No quick reads yet' },
  { key: 'mostLoved',          fetch: (n) => fetchSupabaseBooks(0, n, 'most-liked'),                    empty: 'Nothing here yet' },
  { key: 'mostRead',           fetch: (n) => fetchSupabaseBooks(0, n, 'most-read'),                     empty: 'Nothing here yet' },
  { key: 'completedExcellent', fetch: (n) => fetchSupabaseBooks(0, n, 'completed'),                     empty: 'No completed books yet' },
];
// ── Ranking tab — Top-100 leaderboard with genre filter (App-aligned) ──────
// One ranked vertical list per genre, numbered ribbons on each row. The
// chip rail at the top filters by genre; "All" shows the platform-wide Top 100.
// Sort is by likes_count (the canonical "Most Loved" axis) — the same axis
// the mobile app uses for its single ranking score.
const _RANKING_GENRES = [
  { slug: '',                  label: 'All' },
  { slug: 'dark-romance',      label: 'Dark Romance' },
  { slug: 'mafia-boss',        label: 'Mafia Boss' },
  { slug: 'billionaire',       label: 'Billionaire' },
  { slug: 'enemies-to-lovers', label: 'Enemies to Lovers' },
  { slug: 'forbidden-love',    label: 'Forbidden Love' },
  { slug: 'hot-romance',       label: 'Hot Romance' },
  { slug: 'sci-fi',            label: 'Sci-fi' },
  { slug: 'teen-fiction',      label: 'Teen Fiction' },
  { slug: 'general-fiction',   label: 'General Fiction' },
];
// ── Discover tab — genre-grouped rows ──────────────────────────────────────
const _DISCOVER_GENRES = [
  'hot-romance', 'dark-romance', 'mafia-boss', 'enemies-to-lovers',
  'forbidden-love', 'sci-fi', 'teen-fiction', 'general-fiction',
];
const _SEE_ALL_MAP = {
  weeklyFeatured:     { sort: 'editors-pick',  title: 'Weekly Featured' },
  recommended:        { sort: 'most-liked',    title: 'Recommended for You' },
  trending:           { sort: 'trending',      title: 'Trending This Week' },
  freshReads:         { sort: 'recent',        title: 'Fresh Reads' },
  justUpdated:        { sort: 'just-updated',  title: 'Just Updated' },
  hiddenGems:         { sort: 'most-liked',    title: 'Hidden Gems',
                        filter: q => q.gte('likes_count', 3).lt('views_count', 500) },
  quickReads:         { sort: 'most-liked',    title: 'Quick Reads',
                        filter: q => q.gte('chapters_count', 1).lte('chapters_count', 5) },
  mostLoved:          { sort: 'most-liked',    title: 'Most Loved' },
  mostRead:           { sort: 'most-read',     title: 'Most Read' },
  completedExcellent: { sort: 'completed',     title: 'Completed & Excellent Works' },
};
// ── Pagination state for the See All sub-view (back-compat shims kept for
// any older code paths that still reference these names) ──
const BOOKS_PAGE_SIZE = 80;
// ── Book row helpers ──────────────────────────────────────────────────────
// One source of truth for the columns the UI needs from the books table.
// Used by every fetcher so adding/removing a column is a one-line change.
const BOOK_LIST_SELECT = `
  id, title, description, cover_url, genre, tags, status,
  views_count, likes_count, chapters_count, word_count,
  views_last_7d, likes_last_7d, trending_score,
  is_editors_pick, editors_pick_at, editors_pick_note,
  lock_from_chapter, published_at, created_at, author_id,
  profiles!books_author_id_fkey ( id, username, avatar_url, is_banned )
`;
// Slimmer projection — used by the home-feed dropdown and other places where
// only cover/title/author are needed.
const BOOK_CARD_SELECT = `
  id, title, cover_url, genre, status, views_count, likes_count,
  chapters_count, lock_from_chapter, published_at, created_at, author_id,
  profiles!books_author_id_fkey ( id, username, avatar_url, is_banned )
`;
// Server-side sort matrix. Each entry returns the chained query so callers
// can range() it. Keeping the per-sort logic centralised here means
// every code path that lists books paginates the same axis as page 1.
const _BOOK_SORT_PIPELINES = {
  // Trending: precomputed by refresh_book_trending_stats() (indexed).
  trending:      (q) => q.order('trending_score', { ascending: false, nullsFirst: false })
                          .order('likes_count',  { ascending: false })
                          .order('created_at',   { ascending: false }),
  recent:        (q) => q.order('published_at', { ascending: false, nullsFirst: false })
                          .order('created_at',  { ascending: false }),
  'most-liked':  (q) => q.order('likes_count', { ascending: false })
                          .order('created_at', { ascending: false }),
  'most-read':   (q) => q.order('views_count', { ascending: false })
                          .order('created_at', { ascending: false }),
  // Completed: filter then sort (likes_count index covers exactly this case).
  completed:     (q) => q.eq('status', 'completed').order('likes_count', { ascending: false }),
  // Editor's Pick: filter then sort by editors_pick_at (indexed).
  'editors-pick':(q) => q.eq('is_editors_pick', true).order('editors_pick_at', { ascending: false, nullsFirst: false }),
  // Just Updated: surfaces ongoing series with recent chapter drops.
  'just-updated':(q) => q.order('updated_at', { ascending: false, nullsFirst: false })
                          .order('created_at', { ascending: false }),
};
// (setupBooksInfiniteScroll removed — the See-All sub-view uses
// _setupSeeAllInfiniteScroll instead. Other tabs render fixed-size sections.)

// ── Supabase books ──
// ────────────────────────────────────────────────────────────────────────
// Adaptive book chip rail — YouTube-style: tags from user's reads + platform popular
// Re-renders on each books-page open so it adapts as reading habits evolve.
// ────────────────────────────────────────────────────────────────────────
const PRETTY_GENRE = {
  'hot-romance':         'Hot Romance',
  'dark-romance':        'Dark Romance',
  'mafia-boss':          'Mafia Boss',
  'enemies-to-lovers':   'Enemies to Lovers',
  'forbidden-love':      'Forbidden Love',
  'arranged-marriage':   'Arranged Marriage',
  'contract-marriage':   'Contract Marriage',
  'second-chance':       'Second Chance',
  'boy-love-bl':         'Boy Love',
  'girl-love-gl':        'Girl Love',
  'sci-fi':              'Sci-fi',
  'teen-fiction':        'Teen Fiction',
  'general-fiction':     'General Fiction',
  'slice-of-life':       'Slice of Life',
  'one-shot-story':      'One Shot Story',
  'valentines-special':  'Valentines Special',
};
const BOOK_RECS_TTL = 5 * 60 * 1000; // 5 min

// ─── Extracted functions ──────────────────────────────────────────

function showBook(force = false) {
  _cfg.hideAllMainPages();
  bookPage.style.display = 'block';
  // Wider canvas: 7 covers per row needs the full viewport, not the 900px
  // home-feed column. The body class is removed by hideAllMainPages on nav.
  document.body.classList.add('on-books');
  _cfg.stopVideoPlayer();
  history.pushState(null, '', '#book');
  // Hide See-All sub-view if it was open from a previous visit.
  const seeAll = document.getElementById('bookSeeAllView');
  if (seeAll) seeAll.style.display = 'none';
  // Show the active tab's panel; hide the rest.
  document.querySelectorAll('.book-tab-panel').forEach(p => {
    const isActive = p.dataset.bookPanel === _activeBookTab;
    p.style.display = isActive ? '' : 'none';
    p.classList.toggle('active', isActive);
  });
  loadBooksTab(_activeBookTab, force);
}

function loadBooksTab(tab, force = false) {
  _activeBookTab = tab;
  if (!force && _bookTabLoaded[tab]) return;
  _bookTabLoaded[tab] = true;
  if (tab === 'foryou')      return _loadForYouTab();
  if (tab === 'discover')    return _loadDiscoverTab();
  if (tab === 'ranking')     return _loadRankingTab();
  if (tab === 'readinglist') return _loadReadingListTab();
}

async function _loadForYouTab() {
  // Scope all DOM queries to this panel. Several keys (mostLoved / mostRead /
  // trending) are reused by the Ranking tab — without this scope, querySelector
  // would write to whichever copy comes first in the DOM.
  const panel = document.getElementById('bookTabForYou');
  if (!panel) return;
  // Show a loading state on every track immediately so the page never looks empty.
  for (const s of _FORYOU_SECTIONS) {
    const track = panel.querySelector(`.book-section-track[data-track="${s.key}"]`);
    if (track) track.innerHTML = '<div class="loading">Loading…</div>';
  }

  // Overfetch 3× — gives the dedup pass plenty of headroom even when later
  // rails get most of their top picks claimed by earlier rails.
  const FETCH = _SECTION_ROW_SIZE * 3;
  const results = await Promise.all(
    _FORYOU_SECTIONS.map(s =>
      s.fetch(FETCH).catch(err => {
        console.warn(`[For You] section "${s.key}" failed:`, err);
        return [];
      })
    )
  );

  // Claim books in priority order with SOFT dedup:
  //   1. First pass: take un-claimed books only (the strict dedup).
  //   2. If a rail ends up too sparse to be useful (< MIN_PER_RAIL), top it
  //      up with its own already-claimed books — better to repeat a great
  //      book in a category showcase than to leave the rail empty.
  // This is the right trade for "category" rails like Most Loved / Completed,
  // where the rail's whole job is "show me the best of this slice", and dies
  // visually if dedup steals all its top picks.
  const seen = new Set();
  const MIN_PER_RAIL = 4;
  results.forEach((books, i) => {
    const pool = books || [];
    const claimed = [];
    const claimedIds = new Set();
    // Pass 1 — strict dedup
    for (const b of pool) {
      if (!b || seen.has(b.id) || claimedIds.has(b.id)) continue;
      claimed.push(b);
      claimedIds.add(b.id);
      seen.add(b.id);
      if (claimed.length >= _SECTION_ROW_SIZE) break;
    }
    // Pass 2 — soft fill if the rail came up short
    if (claimed.length < MIN_PER_RAIL) {
      for (const b of pool) {
        if (!b || claimedIds.has(b.id)) continue;
        claimed.push(b);
        claimedIds.add(b.id);
        if (claimed.length >= _SECTION_ROW_SIZE) break;
      }
    }
    _renderBookSection(_FORYOU_SECTIONS[i].key, claimed, _FORYOU_SECTIONS[i].empty, panel);
  });
}

// Render-only helper — paints already-fetched books into a section track.
// `scope` defaults to `document` but should be the parent tab panel when
// the same section key exists in multiple tabs (For You and Ranking both
// use mostLoved / mostRead / trending). Without scoping, the loaders write
// to the first matching track in DOM order — usually the wrong tab.
function _renderBookSection(sectionKey, books, emptyMsg, scope) {
  const root = scope || document;
  const track = root.querySelector(`.book-section-track[data-track="${sectionKey}"]`);
  if (!track) return;
  if (!books || !books.length) {
    track.innerHTML = `<div class="book-section-empty">${escHTML(emptyMsg || 'Nothing here yet')}</div>`;
    return;
  }
  track.innerHTML = '';
  books.forEach(b => track.appendChild(_renderBookCardV2(b)));
}

// Hidden Gems: high engagement RATE, not absolute likes. A book with 8 likes
// and 12 views is more of a "gem" than one with 50 likes and 600 views — the
// first signals "almost everyone who reads it loves it". Server filter is
// the same (low-views floor), but we re-rank client-side by likes/views ratio
// to pick the *true* gems out of that pool.
async function _fetchHiddenGems(limit = _SECTION_ROW_SIZE) {
  // Overfetch — we need headroom because we re-rank below.
  const raw = await fetchSupabaseBooks(0, Math.max(limit * 3, 24), 'most-liked', {
    filter: q => q.gte('likes_count', 3).lt('views_count', 500),
  });
  return [...raw].sort((a, b) => {
    // Smoothed ratio: floor views at 10 so a 5-view, 5-like fluke doesn't
    // win over a 50-view, 40-like consistent favourite.
    const rateA = (a.likes_count || 0) / Math.max(a.views_count || 0, 10);
    const rateB = (b.likes_count || 0) / Math.max(b.views_count || 0, 10);
    if (rateB !== rateA) return rateB - rateA;
    return (b.likes_count || 0) - (a.likes_count || 0);
  }).slice(0, limit);
}

// Quick Reads: short stories ranked by likes-PER-CHAPTER so a 1-chapter
// masterpiece beats a 5-chapter draft. Density of love > sheer count.
async function _fetchQuickReads(limit = _SECTION_ROW_SIZE) {
  const raw = await fetchSupabaseBooks(0, Math.max(limit * 3, 24), 'most-liked', {
    filter: q => q.gte('chapters_count', 1).lte('chapters_count', 5),
  });
  return [...raw].sort((a, b) => {
    const densityA = (a.likes_count || 0) / Math.max(a.chapters_count || 0, 1);
    const densityB = (b.likes_count || 0) / Math.max(b.chapters_count || 0, 1);
    if (densityB !== densityA) return densityB - densityA;
    return (b.likes_count || 0) - (a.likes_count || 0);
  }).slice(0, limit);
}

// Weekly Featured = editor's picks first; if too few, top up with trending
// (last-7-day hot) and finally with high-likes recent books, so the row
// always feels alive even before a moderator curates anything.
async function _fetchWeeklyFeaturedWithFallback(limit = _SECTION_ROW_SIZE) {
  const target = limit;
  const picks = await fetchSupabaseBooks(0, target, 'editors-pick');
  if (picks.length >= target) return picks;

  // Top up with trending (most likely to feel "weekly featured" without curation)
  const fillers = await fetchSupabaseBooks(0, target, 'trending');
  const seen = new Set(picks.map(b => b.id));
  for (const b of fillers) {
    if (picks.length >= target) break;
    if (!seen.has(b.id)) { picks.push(b); seen.add(b.id); }
  }
  if (picks.length >= 3) return picks;

  // Final fallback: most-loved books overall — guarantees a populated row.
  const safetyNet = await fetchSupabaseBooks(0, target, 'most-liked');
  for (const b of safetyNet) {
    if (picks.length >= target) break;
    if (!seen.has(b.id)) { picks.push(b); seen.add(b.id); }
  }
  return picks;
}

// "Recommended for You" — picks books matching the tags/genres the user has
// previously read or liked. For brand-new users (no signal), gracefully
// falls back to trending so the rail is always populated.
async function _fetchRecommendedForUser(limit = _SECTION_ROW_SIZE) {
  if (!_cfg.getCurrentUser()?.id) {
    return await fetchSupabaseBooks(0, limit, 'most-liked');
  }
  try {
    // Pull a small sample of the user's recent reads + likes to derive their taste.
    const [{ data: reads }, { data: likes }] = await Promise.all([
      // book_reads' timestamp column is `last_read_at` (composite PK
       // user_id+book_id, no created_at — Codex P2 catch). Ordering by
       // created_at silently returned rows in arbitrary order, which
       // skewed the seedlist toward random history rather than recent.
       supabase.from('book_reads').select('book_id').eq('user_id', _cfg.getCurrentUser().id).order('last_read_at', { ascending: false }).limit(20),
      supabase.from('book_likes').select('book_id').eq('user_id', _cfg.getCurrentUser().id).order('created_at', { ascending: false }).limit(20),
    ]);
    const seedIds = [...new Set([...(reads || []), ...(likes || [])].map(r => r.book_id))];
    if (!seedIds.length) {
      return await fetchSupabaseBooks(0, limit, 'trending');
    }
    // Build a tag-weight map from those books.
    const { data: seedBooks } = await supabase.from('books')
      .select('genre, tags').in('id', seedIds);
    const tagWeights = {};
    for (const b of (seedBooks || [])) {
      if (b.genre) tagWeights[b.genre] = (tagWeights[b.genre] || 0) + 2;
      for (const t of (b.tags || [])) {
        if (t) tagWeights[t] = (tagWeights[t] || 0) + 1;
      }
    }
    const topTag = Object.entries(tagWeights).sort((a,b) => b[1] - a[1])[0]?.[0];
    if (!topTag) return await fetchSupabaseBooks(0, limit, 'trending');

    // Fetch top books in that taste, excluding ones the user already read/liked.
    // Overfetch so we have headroom after excluding their seedlist.
    const exclude = new Set(seedIds);
    const candidates = await fetchSupabaseBooks(0, Math.max(limit * 2, 14), 'most-liked', { genre: topTag });
    const fresh = candidates.filter(b => !exclude.has(b.id)).slice(0, limit);
    if (fresh.length >= 3) return fresh;
    return await fetchSupabaseBooks(0, limit, 'trending');
  } catch (err) {
    console.warn('Recommended-for-you failed, falling back:', err);
    return await fetchSupabaseBooks(0, _SECTION_ROW_SIZE, 'trending');
  }
}

async function _loadRankingTab() {
  const panel = document.getElementById('bookTabRanking');
  if (!panel) return;
  _renderRankGenreChips();
  await _loadRankingForGenre(_rankingActiveGenre);
}

function _renderRankGenreChips() {
  const wrap = document.getElementById('rankGenreChips');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const g of _RANKING_GENRES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rank-genre-chip' + (g.slug === _rankingActiveGenre ? ' active' : '');
    btn.dataset.genre = g.slug;
    btn.textContent = g.label;
    btn.addEventListener('click', () => {
      if (g.slug === _rankingActiveGenre) return;
      _rankingActiveGenre = g.slug;
      // Update active chip styling without a full chip-rail rebuild
      wrap.querySelectorAll('.rank-genre-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.genre === g.slug);
      });
      _loadRankingForGenre(g.slug);
    });
    wrap.appendChild(btn);
  }
}

async function _loadRankingForGenre(genreSlug) {
  const list = document.getElementById('rankList');
  if (!list) return;
  const seq = ++_rankingSeq;
  list.innerHTML = '<div class="loading">Loading rankings…</div>';

  let books;
  try {
    // Top 100 by all-time VIEWS — highest read count wins #1, matching the
    // mobile App. Genre filter is optional (empty string = All).
    books = await fetchSupabaseBooks(0, 100, 'most-read', genreSlug ? { genre: genreSlug } : {});
  } catch (err) {
    if (seq !== _rankingSeq) return;
    console.warn('[Ranking] load failed:', err);
    list.innerHTML = '<div class="rank-empty">Couldn\'t load rankings. Try again.</div>';
    return;
  }
  if (seq !== _rankingSeq) return; // user switched genre mid-flight

  if (!books.length) {
    list.innerHTML = '<div class="rank-empty">No books in this category yet.</div>';
    return;
  }

  list.innerHTML = '';
  books.forEach((book, idx) => {
    list.appendChild(_renderRankCard(book, idx + 1));
  });
}

// Single ranked-list row — cover left with numbered ribbon, info right.
// Mirrors the mobile app's leaderboard card: title, description, status
// badge, paid/free badge, and an icon-stats row.
function _renderRankCard(book, rank) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'rank-card';
  card.dataset.rank = String(rank);
  card.dataset.bookId = book.id;
  card.onclick = () => openBookDetail(book.id);

  const initial = (book.title || '?').trim().charAt(0).toUpperCase();
  // Pre-crop the source to 2:3 via _supabaseRatioCrop (same path the For
  // You tab + home shelves use). For Supabase-hosted covers this rewrites
  // the URL to /storage/v1/render/image/public/ + width=400&height=600
  // &resize=cover so the source ARRIVES at the right ratio and CSS doesn't
  // have to fight to zoom/letterbox it. For Bunny/external hosts it's a
  // pass-through (the CSS object-fit/object-position then carries the load
  // for those legacy covers).
  const croppedCover = book.cover_url
    ? _cfg._supabaseRatioCrop(_cfg._cleanCdnUrl(book.cover_url), { width: 400, height: 600 })
    : '';
  const cover = book.cover_url
    ? `<img src="${escHTML(croppedCover)}" alt="" loading="lazy"/>`
    : `<div class="rank-card-cover-placeholder">${escHTML(initial)}</div>`;

  const isCompleted = (book.status || '').toLowerCase() === 'completed';
  const isPaid = (book.lock_from_chapter || 0) > 0;

  // Synthesised rating (same scale as the v2 card so numbers stay consistent).
  const rating = Math.min(5, (book.likes_count || 0) / 5).toFixed(2);
  const views  = _cfg.formatCompact(book.views_count || 0);
  const likes  = _cfg.formatCompact(book.likes_count || 0);
  const chapters = book.chapters_count || 0;

  const desc = (book.description || '').trim() || 'No description yet.';

  card.innerHTML = `
    <div class="rank-card-ribbon">${rank}</div>
    <div class="rank-card-cover">${cover}</div>
    <div class="rank-card-body">
      <h3 class="rank-card-title">${escHTML(book.title || 'Untitled')}</h3>
      <p class="rank-card-desc">${escHTML(desc)}</p>
      <div class="rank-card-badges">
        ${isCompleted
          ? '<span class="rank-card-badge rank-card-badge-completed">Completed</span>'
          : '<span class="rank-card-badge rank-card-badge-ongoing">Ongoing</span>'}
        ${isPaid ? '<span class="rank-card-badge rank-card-badge-paid">Paid</span>' : ''}
      </div>
      <div class="rank-card-stats">
        <span class="rank-card-stat rank-card-stat-rating"><span class="rank-card-stat-icon">★</span>${rating}</span>
        <span class="rank-card-stat rank-card-stat-views"><span class="rank-card-stat-icon">👁</span>${views}</span>
        <span class="rank-card-stat rank-card-stat-likes"><span class="rank-card-stat-icon">♥</span>${likes}</span>
        <span class="rank-card-stat"><span class="rank-card-stat-icon">📋</span>${chapters}</span>
      </div>
    </div>`;
  return card;
}

async function _loadDiscoverTab() {
  const wrap = document.getElementById('bookDiscoverGenres');
  if (!wrap) return;
  // Build the section skeletons so each row gets its own loading state.
  wrap.innerHTML = '';
  _DISCOVER_GENRES.forEach(g => {
    const sec = document.createElement('div');
    sec.className = 'book-section';
    const safeG = escHTML(g);
    const pretty = escHTML(prettyGenre(g));
    // Same head markup as For You / Ranking — keeps "See All" right-aligned
    // and the title styling consistent across every tab.
    sec.innerHTML = `
      <div class="book-section-head">
        <h2 class="book-section-title">${pretty}</h2>
        <button class="book-section-see-all" data-see-all="genre:${safeG}" type="button">See All</button>
      </div>
      <div class="book-section-track" data-track="genre:${safeG}"><div class="loading">Loading…</div></div>`;
    wrap.appendChild(sec);
  });
  // Hydrate each row in parallel.
  await Promise.all(_DISCOVER_GENRES.map(g => _loadDiscoverGenreRow(g)));
}

async function _loadDiscoverGenreRow(genre) {
  // Find the entire section (not just the track) so we can hide it if empty —
  // mobile-app parity: a genre with zero books shouldn't take up space.
  const section = document.querySelector(`.book-section-track[data-track="genre:${genre}"]`)?.closest('.book-section');
  const track = section?.querySelector(`.book-section-track[data-track="genre:${genre}"]`);
  if (!track) return;
  try {
    const books = await fetchSupabaseBooks(0, _SECTION_ROW_SIZE, 'most-liked', { genre });
    if (!books.length) {
      // Hide the section entirely — cleaner than an empty-state placeholder.
      if (section) section.style.display = 'none';
      return;
    }
    track.innerHTML = '';
    books.forEach(b => track.appendChild(_renderBookCardV2(b)));
  } catch (err) {
    console.warn(`Discover genre "${genre}" failed:`, err);
    track.innerHTML = '<div class="book-section-empty">Couldn\'t load.</div>';
  }
}

// ── Reading List tab (user-scoped collection grid) ────────────────────────
async function _loadCollectionTab({ table, fkName, gridId, emptyId, signedOutMsg, orderColumn }) {
  const grid = document.getElementById(gridId);
  const empty = document.getElementById(emptyId);
  if (!grid) return;
  if (!_cfg.getCurrentUser()?.id) {
    grid.innerHTML = `<div class="book-collection-empty"><h3>${escHTML(signedOutMsg)}</h3></div>`;
    if (empty) empty.style.display = 'none';
    return;
  }
  grid.innerHTML = '<div class="loading">Loading…</div>';
  if (empty) empty.style.display = 'none';
  try {
    // Join through the user's pivot table (book_reads / book_bookmarks) so we
    // both fetch the book row AND keep the user's own "latest first" order.
    //
    // CRITICAL: book_reads's timestamp column is `last_read_at`, NOT
    // `created_at` — ordering by created_at on book_reads throws "column
    // does not exist" and the whole tab errors out. The orderColumn arg
    // lets each caller name its own.
    const col = orderColumn || 'created_at';
    const { data, error } = await supabase.from(table)
      .select(`book_id, ${col}, books!${fkName}(${BOOK_CARD_SELECT})`)
      .eq('user_id', _cfg.getCurrentUser().id)
      .order(col, { ascending: false })
      .limit(60);
    if (error) throw error;
    const books = _normalizeBookRows((data || []).map(r => r.books));
    if (!books.length) {
      grid.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    // v2 cards (corner ribbon + rating + views) so Reading List looks
    // identical to every other rail across the books page.
    grid.innerHTML = '';
    books.forEach((b, i) => {
      const card = _renderBookCardV2(b);
      card.style.animationDelay = `${(i * 0.025).toFixed(3)}s`;
      grid.appendChild(card);
    });
  } catch (err) {
    console.error(`${table} load failed:`, err);
    grid.innerHTML = '<div class="book-collection-empty"><p>Couldn\'t load. Try again.</p></div>';
  }
}

// (Library tab loader was removed alongside its DOM. The web's existing
// sidebar Bookmarks page is the canonical "Library" experience here.)
function _loadReadingListTab() {
  return _loadCollectionTab({
    table: 'book_bookmarks',
    fkName: 'book_bookmarks_book_id_fkey',
    gridId: 'bookReadingListGrid',
    emptyId: 'bookReadingListEmpty',
    signedOutMsg: 'Sign in to see your reading list',
    orderColumn: 'created_at',
  });
}

// ── v2 book card (matches mobile look: cover + corner badge + stats) ───────
function _renderBookCardV2(b) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'book-card-v2';
  card.dataset.bookId = b.id;
  card.onclick = () => openBookDetail(b.id);

  const initialLetter = (b.title || '?').trim().charAt(0).toUpperCase();
  // Use Supabase's server-side image transform to crop the cover to a
  // clean 2:3 (400x600 px) — same trick the home shelves use. Without
  // this, 9:16 video-shaped source covers would render in their
  // native tall aspect inside our 2:3 container, looking stretched.
  // Pass-through for non-Supabase URLs (Appwrite/Bunny).
  const croppedCover = b.cover_url
    ? _cfg._supabaseRatioCrop(_cfg._cleanCdnUrl(b.cover_url), { width: 400, height: 600 })
    : null;
  const cover = croppedCover
    ? `<img src="${escHTML(croppedCover)}" alt="" loading="lazy" onerror="this.style.display='none'"/>`
    : `<div class="book-card-v2-cover-placeholder">${escHTML(initialLetter)}</div>`;
  const isPaid = (b.lock_from_chapter || 0) > 0;
  const author = b.author?.username || b.profiles?.username || 'Unknown';
  // Visual rating that mirrors the mobile-app card. We don't have a real
  // ratings table yet, so we synthesise a 0-5 star from likes_count using
  // the same scale the mobile UI seems to apply: ~25 likes → 5.0 stars.
  const rating = Math.min(5, (b.likes_count || 0) / 5).toFixed(1);
  const views = _cfg.formatCompact(b.views_count || 0);

  card.innerHTML = `
    <div class="book-card-v2-cover">
      ${cover}
      <div class="book-card-v2-badge ${isPaid ? 'book-card-v2-badge-paid' : 'book-card-v2-badge-free'}">${isPaid ? 'Paid' : 'Free'}</div>
    </div>
    <div class="book-card-v2-body">
      <h3 class="book-card-v2-title">${escHTML(b.title || 'Untitled')}</h3>
      <p class="book-card-v2-author">by ${escHTML(author)}</p>
      <div class="book-card-v2-stats">
        <span class="book-card-v2-stat book-card-v2-stat-rating">★ ${rating}</span>
        <span class="book-card-v2-stat book-card-v2-stat-views">👁 ${views}</span>
      </div>
    </div>`;
  return card;
}

async function _openBookSeeAll(key) {
  let cfg = _SEE_ALL_MAP[key];
  let genre = null;
  if (!cfg && key && key.startsWith('genre:')) {
    genre = key.slice('genre:'.length).replace(/[^a-z0-9-]/gi, '');
    cfg = { sort: 'most-liked', title: prettyGenre(genre) };
  }
  // Charles caught a "See All shows nothing" bug — when the click target's
  // data-see-all key didn't match any _SEE_ALL_MAP entry AND didn't start
  // with `genre:`, this `return` left the user in a broken state (the
  // button click did nothing, no loading, no error). Log it so we notice
  // any new section keys we forget to register in _SEE_ALL_MAP.
  if (!cfg) {
    console.warn(`[see-all] unknown data-see-all key: "${key}" — add it to _SEE_ALL_MAP or use a genre: prefix`);
    return;
  }

  _seeAllSeq++;
  _seeAllSort = cfg.sort;
  _seeAllGenre = genre;
  _seeAllFilter = cfg.filter || null;
  _seeAllOffset = 0;
  _seeAllHasMore = true;
  if (_seeAllObserver) { _seeAllObserver.disconnect(); _seeAllObserver = null; }

  document.querySelectorAll('.book-tab-panel').forEach(p => p.style.display = 'none');
  const seeAll = document.getElementById('bookSeeAllView');
  if (!seeAll) return;
  seeAll.style.display = 'block';
  document.getElementById('bookSeeAllTitle').textContent = cfg.title;
  document.getElementById('bookSeeAllGrid').innerHTML = '<div class="loading">Loading…</div>';
  const sentinel = document.getElementById('bookSeeAllSentinel');
  if (sentinel) sentinel.style.display = 'none';

  window.scrollTo({ top: 0, behavior: 'instant' });
  await _loadMoreSeeAllBooks(true);
}

async function _loadMoreSeeAllBooks(initial = false) {
  if (_seeAllLoading || (!_seeAllHasMore && !initial)) return;
  _seeAllLoading = true;
  const seq = _seeAllSeq;
  const grid = document.getElementById('bookSeeAllGrid');
  const sentinel = document.getElementById('bookSeeAllSentinel');
  const limit = 40;

  try {
    // One fetcher path, three optional shapes — sort-only, genre-filtered, or
    // predicate-filtered (Hidden Gems / Quick Reads). All three combine cleanly.
    const opts = {};
    if (_seeAllGenre)  opts.genre  = _seeAllGenre;
    if (_seeAllFilter) opts.filter = _seeAllFilter;
    const books = await fetchSupabaseBooks(_seeAllOffset, limit, _seeAllSort, opts);

    if (seq !== _seeAllSeq) return; // user opened a different See-All

    if (initial) grid.innerHTML = '';
    if (initial && !books.length) {
      grid.innerHTML = '<div class="book-collection-empty"><p>Nothing here yet.</p></div>';
      _seeAllHasMore = false;
      if (sentinel) sentinel.style.display = 'none';
      return;
    }

    books.forEach((b, i) => {
      const card = renderBookCard(b);
      card.style.animationDelay = `${(i * 0.02).toFixed(3)}s`;
      grid.appendChild(card);
    });
    _seeAllOffset += books.length;

    if (books.length < limit) {
      _seeAllHasMore = false;
      if (sentinel) {
        sentinel.style.display = 'block';
        sentinel.innerHTML = `<div class="book-grid-end-msg">You've reached the end · ${_seeAllOffset.toLocaleString()} books</div>`;
      }
      if (_seeAllObserver) { _seeAllObserver.disconnect(); _seeAllObserver = null; }
    } else {
      if (sentinel) {
        sentinel.style.display = 'block';
        sentinel.innerHTML = '<div class="book-grid-loadmore">Loading more books…</div>';
      }
      _setupSeeAllInfiniteScroll();
    }
  } catch (err) {
    if (seq !== _seeAllSeq) return;
    console.error('See-all load failed:', err);
    if (initial) grid.innerHTML = '<div class="book-collection-empty"><p>Couldn\'t load. Try again.</p></div>';
    if (sentinel) sentinel.innerHTML = '<div class="book-grid-end-msg">Couldn\'t load more.</div>';
  } finally {
    _seeAllLoading = false;
  }
}

function _setupSeeAllInfiniteScroll() {
  if (_seeAllObserver || !('IntersectionObserver' in window)) return;
  const sentinel = document.getElementById('bookSeeAllSentinel');
  if (!sentinel) return;
  _seeAllObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) _loadMoreSeeAllBooks(false);
  }, { root: null, rootMargin: '600px 0px', threshold: 0.01 });
  _seeAllObserver.observe(sentinel);
}

// (loadBooks / loadMoreBooks removed — the books page is now tabbed, with
// curated sections rendered by _loadForYouTab / _loadDiscoverTab / etc., and
// the See-All sub-view's pagination is handled by _loadMoreSeeAllBooks.)

// applyBookFilter — kept as a small helper. Currently unused by the v2 flow
// (server-side genre filter handles it for the See-All view), but cheap to
// keep around for future call sites.
function applyBookFilter(list, genre) {
  const filter = genre || '';
  if (!filter) return [...list];
  const filterLower = filter.toLowerCase();
  const filterWords = filterLower.replace(/-/g, ' ');
  return list.filter(b => {
    if (b.genre === filter) return true;
    return (b.tags || []).some(t => {
      const tagLower = (t || '').toLowerCase();
      return tagLower === filterLower || tagLower === filterWords;
    });
  });
}

// ── Book search (filters the currently-loaded book cache) ──
// Searches: title, description, tags, genre, author/uploader name.
// `#tag` prefix restricts to tag-only matches. Suspends infinite scroll while active.
function searchBooks(query) {
  query = (query || '').trim();
  if (!query) return allBooksCache;

  const hashtagMatch = query.match(/^#(\w+)/);
  const isHashtag = !!hashtagMatch;
  const cleanQuery = _cfg.normalizeForSearch(isHashtag ? hashtagMatch[1] : query);

  return allBooksCache.filter(b => {
    if (isHashtag) {
      return (b.tags || []).some(t => _cfg.normalizeForSearch(t).includes(cleanQuery));
    }

    const title  = _cfg.normalizeForSearch(b.title);
    const desc   = _cfg.normalizeForSearch(b.description);
    const tags   = _cfg.normalizeForSearch((b.tags || []).join(' '));
    const genre  = _cfg.normalizeForSearch((b.genre || '').replace(/-/g, ' '));
    const author = _cfg.normalizeForSearch(b.profiles?.username || b.author?.username || '');

    return title.includes(cleanQuery)
        || desc.includes(cleanQuery)
        || tags.includes(cleanQuery)
        || genre.includes(cleanQuery)
        || author.includes(cleanQuery);
  });
}

async function runBookSearch() {
  // The v2 books page has no flat grid — search results render into the
  // See-All sub-view, which already has its own grid + infinite scroll.
  const grid = document.getElementById('bookSeeAllGrid');
  const seeAllRoot = document.getElementById('bookSeeAllView');
  const titleEl = document.getElementById('bookSeeAllTitle');
  if (!grid || !seeAllRoot || !titleEl) return;

  // Defensive: only render into the books page when it's actually visible.
  // (getSearchContext now restricts books-context to the listing page, but
  // this is a belt-and-braces check in case future code changes that.)
  if (bookPage && bookPage.style.display === 'none') return;

  if (!activeBookSearchQuery.trim()) {
    // Empty query → close the search view and return to the active tab panel
    seeAllRoot.style.display = 'none';
    document.querySelectorAll('.book-tab-panel').forEach(p => {
      const isActive = p.dataset.bookPanel === _activeBookTab;
      p.style.display = isActive ? '' : 'none';
      p.classList.toggle('active', isActive);
    });
    return;
  }

  // Show the See-All view and treat search as its own kind of "list"
  document.querySelectorAll('.book-tab-panel').forEach(p => p.style.display = 'none');
  seeAllRoot.style.display = 'block';
  titleEl.textContent = `Search: "${activeBookSearchQuery}"`;
  // Disable any pending see-all infinite scroll — search isn't paginated here
  if (_seeAllObserver) { _seeAllObserver.disconnect(); _seeAllObserver = null; }
  _seeAllHasMore = false;
  const sentinel = document.getElementById('bookSeeAllSentinel');
  if (sentinel) sentinel.style.display = 'none';
  grid.innerHTML = '<div class="loading">Searching books…</div>';

  const savedQuery = activeBookSearchQuery;
  const { books: serverHits, writers } = await fetchBooksServerSearch(savedQuery)
    .catch(() => ({ books: [], writers: [] }));

  // Stale-query guard: ignore if user kept typing
  if (activeBookSearchQuery !== savedQuery) return;

  grid.innerHTML = '';

  // ── Writer channel cards (YouTube-style, above the books) ──
  if (writers && writers.length) {
    const header = document.createElement('div');
    header.className = 'video-creators-header';
    header.style.gridColumn = '1 / -1';
    header.textContent = writers.length === 1 ? 'Writer' : 'Writers';
    grid.appendChild(header);

    const row = document.createElement('div');
    row.className = 'video-creators-row';
    row.style.gridColumn = '1 / -1';
    writers.forEach(w => row.appendChild(renderWriterChannelCard(w)));
    grid.appendChild(row);

    if (serverHits.length) {
      const booksHeader = document.createElement('div');
      booksHeader.className = 'video-creators-header';
      booksHeader.style.gridColumn = '1 / -1';
      booksHeader.textContent = 'Books';
      grid.appendChild(booksHeader);
    }
  }

  if (!serverHits.length) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'book-collection-empty';
    emptyEl.style.gridColumn = '1 / -1';
    emptyEl.innerHTML = (writers && writers.length)
      ? '<h3>No books found</h3><p>The writers above match — open one of their pages to see their work.</p>'
      : '<h3>No books found</h3><p>Try a different keyword, author, or #tag.</p>';
    grid.appendChild(emptyEl);
    return;
  }

  serverHits.forEach((b, i) => {
    const card = renderBookCard(b);
    card.style.animationDelay = `${(i * 0.02).toFixed(3)}s`;
    grid.appendChild(card);
  });
}

// Writer channel card — same shape as the video creator card so the books
// page reuses the existing .creator-channel-card styling.
function renderWriterChannelCard(writer) {
  const card = document.createElement('button');
  card.className = 'creator-channel-card';
  card.type = 'button';
  card.onclick = () => _cfg.openProfile(writer.id);

  const initial = (writer.username || '?').trim().charAt(0).toUpperCase();
  const avatar = writer.avatar_url
    ? `<img src="${escHTML(writer.avatar_url)}" alt=""/>`
    : `<div class="creator-channel-avatar-placeholder">${initial}</div>`;

  const booksLabel = writer.books_count === 1 ? '1 book' : `${(writer.books_count || 0).toLocaleString()} books`;

  card.innerHTML = `
    <div class="creator-channel-avatar">${avatar}</div>
    <div class="creator-channel-info">
      <div class="creator-channel-name">${escHTML(writer.username || 'Unknown')}</div>
      <div class="creator-channel-meta">${booksLabel}</div>
      ${writer.bio ? `<div class="creator-channel-bio">${escHTML(writer.bio.slice(0, 90))}${writer.bio.length > 90 ? '…' : ''}</div>` : ''}
    </div>
    <div class="creator-channel-cta">View profile →</div>
  `;
  return card;
}

// Normalise a raw row into the shape the rest of the app expects.
// Filters out banned-author rows; returns null for those (caller filters).
function _normalizeBookRow(row) {
  if (!row) return null;
  if (row.profiles?.is_banned) return null;
  return {
    ...row,
    $id: 'sb_' + row.id,
    author: row.profiles
      ? { id: row.profiles.id, username: row.profiles.username, avatar: row.profiles.avatar_url }
      : null,
  };
}

function _normalizeBookRows(rows) {
  return (rows || []).map(_normalizeBookRow).filter(Boolean);
}

// Single fetcher for every browse-style book list. Supports server-side
// sort (via _BOOK_SORT_PIPELINES) and an optional genre filter that matches
// against either the genre column or the tags array.
//
//   fetchSupabaseBooks(0, 12, 'most-liked')                  → top 12 by likes
//   fetchSupabaseBooks(0, 12, 'most-liked', { genre: 'sci-fi' }) → top 12 sci-fi
async function fetchSupabaseBooks(offset = 0, limit = 80, sortBy = bookSortBy, opts = {}) {
  try {
    let q = supabase.from('books').select(BOOK_LIST_SELECT)
      .eq('is_public', true).eq('is_hidden', false);

    // The Completed and Editor's-Pick pipelines apply their own status filter,
    // so only add the public-status filter for the OTHER sorts (otherwise
    // .in('status', [...]) would override .eq('status', 'completed')).
    if (sortBy !== 'completed' && sortBy !== 'editors-pick') {
      q = q.in('status', ['ongoing', 'completed']);
    }

    // Optional genre filter — matches the dedicated `genre` column AND
    // any of the common shapes that show up in the `tags` array. The
    // slug ("hot-romance") is what genres are stored as on the `genre`
    // column, but authors typically tag books with the display form
    // ("Hot Romance" / "hot romance"). Pre-fix this only matched the
    // hyphenated slug in tags, so a book genre-tagged "Hot Romance"
    // would slip through every Discover/See-All row because:
    //   - genre.eq.hot-romance     → only the explicit slug
    //   - tags.cs.{hot-romance}    → only tag-with-hyphen
    // (Charles flagged Hot Romance rows showing 2 of N expected books.)
    // We now also match the spaced-display form (both casings) by
    // expanding the .or() clause to cover the realistic shapes.
    //
    // Strip anything but [a-z0-9-] from the slug defensively so a
    // malformed input can't break the .or() clause syntax. We derive
    // the display variants from the cleaned slug so they stay in sync.
    if (opts.genre) {
      const safeG = String(opts.genre).toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (safeG) {
        const spaced = safeG.replace(/-/g, ' ');                    // "hot romance"
        const titled = spaced.replace(/\b\w/g, c => c.toUpperCase());// "Hot Romance"
        // tags.cs.{...} requires literal text in the array; we pass
        // both the lowercased + Title-Cased variants because authors
        // shape-shift between them. genre.eq matches the canonical
        // slug column. PostgREST allows a comma-separated list inside
        // .or() — each clause is an independent match.
        q = q.or(
          `genre.eq.${safeG},` +
          `tags.cs.{${safeG}},` +
          `tags.cs.{${spaced}},` +
          `tags.cs.{${titled}}`
        );
      }
    }

    // Optional custom predicate — caller-supplied function that adds extra
    // filters before the sort + range are applied. Used by Hidden Gems
    // (low-views + min-likes) and Quick Reads (short chapter count) so
    // those callers don't need their own duplicated query function.
    if (typeof opts.filter === 'function') q = opts.filter(q);

    const pipeline = _BOOK_SORT_PIPELINES[sortBy] || _BOOK_SORT_PIPELINES.trending;
    const { data, error } = await pipeline(q).range(offset, offset + limit - 1);
    if (error) {
      console.error('Supabase books fetch error:', error);
      return [];
    }
    return _normalizeBookRows(data);
  } catch (err) {
    console.error('fetchSupabaseBooks failed:', err);
    return [];
  }
}

// Server-side book search — hits both content (title/description) AND
// matching author usernames. Used as a fallback when the local cache misses
// because pagination only loaded the first 80 books.
async function fetchBooksServerSearch(query) {
  // Sanitize FIRST — strips comma/parens/quotes that break PostgREST .or() —
  // THEN escape ilike wildcards. Without sanitize, queries like `Romeo, Juliet`
  // or `What's next?` returned 0 rows because the OR clause was malformed.
  const safeQ = _cfg.sanitizeSearchQuery(query);
  if (!safeQ) return { books: [], writers: [] };
  const q = _cfg.escapeIlike(safeQ);
  try {
    // Two parallel queries: content match + author username match
    const [contentRes, authorRes] = await Promise.all([
      supabase.from('books').select(BOOK_LIST_SELECT)
        .eq('is_public', true).eq('is_hidden', false)
        .in('status', ['ongoing', 'completed'])
        .or(`title.ilike.%${q}%,description.ilike.%${q}%`)
        .limit(40),
      // Find matching author profiles (also surfaced as the YouTube-style writers row)
      supabase.from('profiles')
        .select('id, username, avatar_url, bio, is_banned')
        .ilike('username', `%${q}%`).eq('is_banned', false)
        .limit(8)
    ]);

    let authorBooks = [];
    const matchingWriters = authorRes.data || [];
    if (matchingWriters.length) {
      const ids = matchingWriters.map(p => p.id);
      const { data } = await supabase.from('books').select(BOOK_LIST_SELECT)
        .in('author_id', ids)
        .eq('is_public', true).eq('is_hidden', false)
        .in('status', ['ongoing', 'completed'])
        .limit(40);
      authorBooks = data || [];
    }

    // Merge + dedupe + normalise (drops banned-author rows along the way).
    const seen = new Set();
    const merged = [...(contentRes.data || []), ...authorBooks].filter(b => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });
    const books = _normalizeBookRows(merged);

    // Decorate writers with their book count from the returned set
    const writerStats = new Map();
    for (const b of books) {
      if (!b.author?.id) continue;
      writerStats.set(b.author.id, (writerStats.get(b.author.id) || 0) + 1);
    }
    const writers = matchingWriters.map(p => ({
      id: p.id,
      username: p.username,
      avatar_url: p.avatar_url,
      bio: p.bio || '',
      books_count: writerStats.get(p.id) || 0,
    }));
    return { books, writers };
  } catch (err) {
    console.warn('fetchBooksServerSearch failed:', err);
    return { books: [], writers: [] };
  }
}

// (renderBooks removed — the v2 books page renders into per-tab DOM targets:
// section tracks for For You/Discover/Ranking, a dedicated grid for the
// Reading List collection, and bookSeeAllGrid for the See-All sub-view.)

function renderBookCard(b) {
  const card = document.createElement('button');
  card.className = 'book-card';
  card.dataset.bookId = b.id;
  card.onclick = () => openBookDetail(b.id);

  const authorName = b.author?.username || 'Unknown author';
  const initialLetter = (b.title || '?').trim().charAt(0).toUpperCase();
  // Pre-crop the cover to 2:3 via _supabaseRatioCrop (matches the For You
  // tab + home shelves + Ranking card). Supabase covers get the
  // /render/image/public/ rewrite with width=400&height=600&resize=cover.
  // Non-Supabase covers (Bunny, external) pass through and rely on
  // .book-cover img CSS (object-fit: cover + object-position: top).
  const croppedCover = b.cover_url
    ? _cfg._supabaseRatioCrop(_cfg._cleanCdnUrl(b.cover_url), { width: 400, height: 600 })
    : '';
  const cover = b.cover_url
    ? `<img src="${escHTML(croppedCover)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=&quot;book-cover-placeholder&quot;>${initialLetter}</div>'"/>`
    : `<div class="book-cover-placeholder">${initialLetter}</div>`;
  const genreLabel = b.genre ? b.genre.replace(/-/g, ' ') : '';

  const editorsPickBadge = b.is_editors_pick
    ? `<div class="book-editors-pick-badge" title="${escHTML(b.editors_pick_note || 'Editor\'s Pick')}">
         <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
         Editor's Pick
       </div>`
    : '';

  card.innerHTML = `
    <div class="book-cover">
      ${cover}
      ${editorsPickBadge}
      <div class="book-stats">
        <span title="Views" data-stat="views">👁 ${_cfg.formatCompact(b.views_count || 0)}</span>
        <span title="Likes" data-stat="likes">❤ ${_cfg.formatCompact(b.likes_count || 0)}</span>
      </div>
    </div>
    ${genreLabel ? `<div class="book-card-genre">${escHTML(genreLabel)}</div>` : ''}
    <h3 class="book-card-title">${escHTML(b.title || 'Untitled')}</h3>
    <p class="book-card-author">by ${escHTML(authorName)}</p>
  `;
  return card;
}

function prettyGenre(slug) {
  if (!slug) return '';
  if (PRETTY_GENRE[slug]) return PRETTY_GENRE[slug];
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function getUserBookTaste() {
  if (!_cfg.getCurrentUser()) return { reads: [], likes: [] };
  const now = Date.now();
  if (_userBookTasteCache && (now - _userBookTasteAt) < 60_000) {
    return _userBookTasteCache;
  }
  const [{ data: reads }, { data: likes }] = await Promise.all([
    supabase.from('book_reads').select('book_id').eq('user_id', _cfg.getCurrentUser().id).order('last_read_at', { ascending: false }).limit(50),
    supabase.from('book_likes').select('book_id').eq('user_id', _cfg.getCurrentUser().id).order('created_at', { ascending: false }).limit(50),
  ]);
  _userBookTasteCache = { reads: reads || [], likes: likes || [] };
  _userBookTasteAt = now;
  return _userBookTasteCache;
}

async function renderBookChips() {
  const wrap = document.getElementById('bookGenreChips');
  if (!wrap) return;

  // Build a candidate set from BOTH platform popularity + user's reading taste
  let userTags = {};
  let platformGenres = {};

  // Platform popularity — count genres + tags across what we've cached.
  // Pre-Codex used `typeof allBooks !== 'undefined'` then fell back to
  // `window._latestBooksList` — both names are dead (allBooks never
  // existed in app.js, _latestBooksList is never written). Codex P2.
  //
  // The right pool is our own listing cache: `allBooksRaw` is the
  // unfiltered server fetch + `allBooksCache` is the filtered/sorted
  // view. Prefer Raw because chip seeding wants the full genre/tag mix,
  // not a filtered subset. Empty array fallback when no listing has
  // been opened yet (first page-load before showBook fires); the chips
  // function then falls through to the hardcoded romance/fantasy seed
  // list at the bottom of renderBookChips, which is what we want.
  const allLoadedBooks = Array.isArray(allBooksRaw) && allBooksRaw.length
    ? allBooksRaw
    : (Array.isArray(allBooksCache) ? allBooksCache : []);
  for (const b of allLoadedBooks) {
    if (b.genre) platformGenres[b.genre] = (platformGenres[b.genre] || 0) + 1;
    for (const t of (b.tags || [])) {
      const slug = String(t).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (slug) platformGenres[slug] = (platformGenres[slug] || 0) + 1;
    }
  }

  // User reading taste (only for signed-in users)
  if (_cfg.getCurrentUser()) {
    try {
      const { reads, likes } = await getUserBookTaste();
      const seedIds = [...new Set([...reads, ...likes].map(r => r.book_id))].slice(0, 30);
      if (seedIds.length) {
        const { data: seedBooks } = await supabase
          .from('books').select('id, genre, tags').in('id', seedIds);
        for (const b of (seedBooks || [])) {
          if (b.genre) userTags[b.genre] = (userTags[b.genre] || 0) + 2;
          for (const t of (b.tags || [])) {
            const slug = String(t).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            if (slug) userTags[slug] = (userTags[slug] || 0) + 1;
          }
        }
      }
    } catch {}
  }

  const userRanked = Object.entries(userTags)
    .filter(([t]) => platformGenres[t]) // only show tags that have content
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  const platformRanked = Object.entries(platformGenres)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  // Blend: 70% from interest, 30% platform discovery (or 100% platform for new users)
  const limit = 22;
  let chips = [];
  if (userRanked.length) {
    const userQuota = Math.ceil(limit * 0.7);
    const seen = new Set(userRanked.slice(0, userQuota));
    for (const t of platformRanked) { if (seen.size >= limit) break; seen.add(t); }
    chips = [...seen].slice(0, limit);
  } else {
    chips = platformRanked.slice(0, limit);
  }

  // Fallback if we still have nothing (e.g. on first page open before any books load)
  if (!chips.length) {
    chips = ['romance', 'hot-romance', 'dark-romance', 'mafia-boss', 'billionaire', 'werewolf', 'vampire', 'thriller', 'horror', 'fantasy', 'comedy', 'drama'];
  }

  // Render — "All" chip first, then adaptive list
  const activeAll = !bookGenreFilter ? 'active' : '';
  let html = `<button class="book-chip ${activeAll}" data-genre="">All</button>`;
  html += chips.map(g =>
    `<button class="book-chip ${g === bookGenreFilter ? 'active' : ''}" data-genre="${escHTML(g)}">${escHTML(prettyGenre(g))}</button>`
  ).join('');
  wrap.innerHTML = html;
}

async function loadBookRecommendations() {
  const rail = document.getElementById('bookRecommendRail');
  const track = document.getElementById('bookRecommendTrack');
  const sub   = document.getElementById('bookRecommendSub');
  if (!rail || !track) return;

  // Only show for signed-in users
  if (!_cfg.getCurrentUser()) { rail.style.display = 'none'; return; }

  // Use cache if fresh
  if (_bookRecsCache && (Date.now() - _bookRecsTimestamp) < BOOK_RECS_TTL) {
    renderBookRecsRail(_bookRecsCache);
    return;
  }

  try {
    // Pull user's reading taste from shared cache (avoids duplicate fetch
    // since renderBookChips() already pulled this seconds ago)
    const { reads, likes } = await getUserBookTaste();
    const readIds  = new Set(reads.map(r => r.book_id));
    const likedIds = new Set(likes.map(l => l.book_id));
    const seedIds  = [...new Set([...readIds, ...likedIds])].slice(0, 30);

    // Fetch a candidate pool (most recent public books)
    const { data: pool } = await supabase
      .from('books')
      .select(`
        id, title, cover_url, genre, tags,
        views_count, likes_count, chapters_count,
        author_id, created_at,
        profiles!books_author_id_fkey ( id, username, avatar_url, is_banned )
      `)
      .eq('is_public', true)
      .eq('is_hidden', false)
      .order('created_at', { ascending: false })
      .limit(200);

    if (!pool || !pool.length) { rail.style.display = 'none'; return; }

    // Build interest profile from seed books (tags + authors)
    let tagWeights = {};
    let authorWeights = {};
    if (seedIds.length) {
      const { data: seedBooks } = await supabase
        .from('books')
        .select('id, genre, tags, author_id')
        .in('id', seedIds);
      for (const sb of (seedBooks || [])) {
        for (const t of (sb.tags || [])) tagWeights[t] = (tagWeights[t] || 0) + 1;
        if (sb.genre) tagWeights[sb.genre] = (tagWeights[sb.genre] || 0) + 1;
        if (sb.author_id) authorWeights[sb.author_id] = (authorWeights[sb.author_id] || 0) + 1;
      }
    }

    const hasInterest = Object.keys(tagWeights).length > 0;

    // Score each candidate
    const scored = pool
      .filter(b => !readIds.has(b.id))                  // skip already-read
      .filter(b => !b.profiles?.is_banned)              // skip banned authors
      .map(b => {
        let score = 0;
        // Tag overlap with user's interests
        for (const t of (b.tags || [])) {
          if (tagWeights[t]) score += tagWeights[t] * 12;
        }
        // Genre match
        if (b.genre && tagWeights[b.genre]) score += tagWeights[b.genre] * 10;
        // Same-author bonus
        if (authorWeights[b.author_id]) score += authorWeights[b.author_id] * 18;
        // Engagement boost
        score += Math.log10((b.views_count || 0) + 1) * 1.5;
        score += Math.log10((b.likes_count || 0) + 1) * 2;
        // Recency boost (last 60 days)
        const ageDays = (Date.now() - new Date(b.created_at).getTime()) / 86400000;
        if (ageDays < 60) score += Math.max(0, 6 - ageDays / 10);
        // Random freshness
        score += Math.random() * 4;
        return { book: b, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(x => x.book);

    _bookRecsCache = scored;
    _bookRecsTimestamp = Date.now();

    if (sub) sub.textContent = hasInterest ? 'Based on your reading taste' : 'Trending this week';
    renderBookRecsRail(scored);
  } catch (e) {
    console.warn('[recs] failed', e);
    rail.style.display = 'none';
  }
}

function renderBookRecsRail(books) {
  const rail = document.getElementById('bookRecommendRail');
  const track = document.getElementById('bookRecommendTrack');
  if (!rail || !track) return;
  if (!books || !books.length) { rail.style.display = 'none'; return; }

  track.innerHTML = '';
  for (const b of books) {
    const a = document.createElement('a');
    a.href = `#book/${b.id}`;
    a.className = 'recommend-card';
    a.onclick = (e) => { e.preventDefault(); openBookDetail(b.id, b); };

    const initial = (b.title || '?').trim().charAt(0).toUpperCase();
    // Pre-crop to 2:3 server-side (Supabase) so the rec rail covers
    // arrive at the right ratio instead of getting CSS-forced.
    const croppedCover = b.cover_url
      ? _cfg._supabaseRatioCrop(_cfg._cleanCdnUrl(b.cover_url), { width: 400, height: 600 })
      : '';
    a.innerHTML = `
      <div class="recommend-card-cover">
        ${b.cover_url
          ? `<img src="${escHTML(croppedCover)}" alt="" loading="lazy"/>`
          : `<div class="recommend-card-cover-empty">${escHTML(initial)}</div>`}
      </div>
      <div class="recommend-card-title">${escHTML(b.title || 'Untitled')}</div>
      <div class="recommend-card-author">${escHTML(b.profiles?.username || 'Unknown')}</div>
      <div class="recommend-card-meta">${(b.views_count || 0).toLocaleString()} reads · ${(b.likes_count || 0).toLocaleString()} ♥</div>
    `;
    track.appendChild(a);
  }
  rail.style.display = 'block';
}



// ════════════════════════════════════════════════════════════════════════
// Stage 8B — Book detail page + chapter reader (appended by extract-stage8b.js)
// ════════════════════════════════════════════════════════════════════════

// ─── Module state (8B) ─────────────────────────────────────────────
let currentBookDetail = null;       // { book, chapters }
let currentChapterIndex = 0;
let readerFontSize = parseFloat(localStorage.getItem('selebox_reader_font') || '1.05');
// (Old genre-chip + sort-select handlers removed alongside their DOM. The v2
// books page expresses the same intent through tabs and curated sections —
// "trending", "recent", "most-liked" etc. live in _SEE_ALL_MAP for the See-All
// list view.)

// ── Book detail page ──
// Stale-fetch guard so rapid taps (open A → tap B before A loads) don't
// render whichever happens to resolve last. Captures the bookId in a token
// and only renders if it still matches when the queries return.
let _openBookToken = null;
// ── Reader watermark (deterrent: leaked screenshots reveal the source) ──
let _watermarkLabelCache = null;
let _readMaxScrollPct = 0;
// ── Anti-fraud telemetry state for the book reader ───────────────────────
// Tracks the currently-open chapter so the close event can include
// real dwell_ms + max scroll_pct. _readChapterOpenTs is 0 when no
// chapter is open. flushReadClose() drains + resets the state and
// emits the matching close record_read_event. Called from anywhere
// that exits a chapter (next/prev nav, back button, route change).
let _readChapterOpenTs = 0;
let _readChapterOpenId = null;
let _readChapterOpenBookId = null;

// ─── Extracted functions (8B) ──────────────────────────────────────

async function openBookDetail(bookId, opts = {}) {
  // Stage 8B Codex P1 — accept an `opts.chapter` chapter-number hint
  // for deep-link auto-open. When the inbound URL is /books/<id>/chapter/<n>
  // the boot router (or popstate handler) passes the chapter number
  // here; after the chapters list lands we find the matching index and
  // call openChapterReader directly. Pre-fix this lived as
  // _pendingChapterFromUrl in app.js but was set-only — nothing read
  // it, so deep-linked chapters loaded only the detail page.
  const pendingChapterNumber = opts.chapter != null ? Number(opts.chapter) : null;

  _cfg.hideAllMainPages();
  bookDetailPage.style.display = 'block';

  // Path-based, shareable, deep-link-friendly URL. Use replaceState when
  // the URL bar already shows the same book (e.g. boot-time inbound) so
  // we don't add a duplicate history entry; pushState otherwise. Either
  // way the result is `/books/<id>`, which mobile's Universal Links /
  // App Links pick up correctly. The legacy hash form (#book/<id>) only
  // appears as an inbound rewrite from old links — once we hit
  // openBookDetail we always upgrade to the canonical path form.
  const targetPath = `/books/${bookId}`;
  const samePath = (location.pathname || '') === targetPath;
  if (samePath) {
    history.replaceState(null, '', targetPath);
  } else {
    history.pushState(null, '', targetPath);
  }

  const content = document.getElementById('bookDetailContent');
  content.innerHTML = '<div class="loading">Loading book...</div>';

  // Only the LATEST openBookDetail call gets to render. Earlier ones bail
  // when their token no longer matches — fixes the "open A, tap B quickly,
  // see A's cover with B's chapters" race.
  const token = bookId;
  _openBookToken = token;

  // All books are now Supabase. Bare UUID or "sb_<uuid>" — strip the prefix if present.
  const realId = bookId.startsWith('sb_') ? bookId.slice(3) : bookId;

  // Detect ID shape — Supabase UUIDs are 36 chars with dashes
  // (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx); Appwrite hex IDs are 20 hex
  // chars with no dashes. Mobile users share Appwrite-shaped IDs via
  // WhatsApp/SMS because the mobile app still has books on Appwrite.
  // Web migrated books to Supabase but kept legacy_appwrite_id, so we
  // query the right column for whichever shape we see.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(realId);
  const bookFilterColumn = isUuid ? 'id' : 'legacy_appwrite_id';

  let supBook, supChapters;
  try {
    const bookRes = await supabase.from('books')
      .select(`
        id, title, description, cover_url, genre, tags,
        views_count, likes_count, chapters_count, word_count, status,
        published_at, created_at, lock_from_chapter, locked_at,
        author_id, profiles!books_author_id_fkey ( id, username, avatar_url )
      `)
      .eq(bookFilterColumn, realId)
      .single();
    if (bookRes.error || !bookRes.data) throw new Error(bookRes.error?.message || 'Book not found');
    supBook = bookRes.data;

    // Chapters are always keyed by the book's Supabase UUID, regardless
    // of which shape we used to find the book.
    const chRes = await supabase.from('chapters')
      .select('id, chapter_number, title, word_count, views_count, is_published, is_locked, unlock_cost_coins, unlock_cost_stars, created_at')
      .eq('book_id', supBook.id)
      .eq('is_published', true)
      .order('chapter_number', { ascending: true });
    if (chRes.error) console.warn('Failed to load chapters:', chRes.error);
    supChapters = chRes.data;
  } catch (err) {
    if (_openBookToken !== token) return; // user already tapped a different book
    console.error('openBookDetail failed:', err);
    const friendly = /timeout|canceling statement/i.test(err.message || '')
      ? 'This book is taking too long to load. Tap to retry.'
      : /not found/i.test(err.message || '')
      ? 'This book isn\'t available — it may have been unpublished.'
      : 'Couldn\'t load this book. Tap to retry.';
    content.innerHTML = `<div class="loading" id="bookRetry" style="cursor:pointer">${escHTML(friendly)}</div>`;
    document.getElementById('bookRetry')?.addEventListener('click', () => openBookDetail(bookId));
    return;
  }

  if (_openBookToken !== token) return; // stale — user tapped a different book

  currentBookDetail = { book: supBook, chapters: supChapters || [] };
  renderBookDetail();

  // Deep-link chapter auto-open. Find the chapter whose chapter_number
  // matches the URL fragment; bail quietly if it's locked-and-not-unlocked
  // (openChapterReader would just render the paywall anyway, but jumping
  // there from a shared link without the user expecting a paywall is
  // worse UX than landing on the detail page where they can see the
  // bulk-unlock CTA in context).
  if (Number.isFinite(pendingChapterNumber)) {
    const idx = (supChapters || []).findIndex(c => Number(c.chapter_number) === pendingChapterNumber);
    if (idx >= 0) openChapterReader(idx);
  }
}

function renderBookDetail() {
  if (!currentBookDetail) return;
  const { book, chapters } = currentBookDetail;
  const content = document.getElementById('bookDetailContent');

  const authorName = book.profiles?.username || 'Unknown';
  const authorAvatar = book.profiles?.avatar_url;
  const initialLetter = (book.title || '?').trim().charAt(0).toUpperCase();
  // Detail page is the biggest cover in the app — pre-crop to a larger
  // 2:3 (600×900) so the rendered image stays sharp. Supabase will serve
  // the optimised image; Bunny/external pass through and rely on CSS.
  const croppedCover = book.cover_url
    ? _cfg._supabaseRatioCrop(_cfg._cleanCdnUrl(book.cover_url), { width: 600, height: 900 })
    : '';
  const cover = book.cover_url
    ? `<img src="${escHTML(croppedCover)}" alt=""/>`
    : `<div class="book-cover-placeholder" style="width:100%;height:100%">${initialLetter}</div>`;

  const tagsHtml = (book.tags || []).map(t =>
    `<button class="book-chip" data-tag="${escHTML(t)}" type="button">${escHTML(t)}</button>`
  ).join('');

  // Single-source lock-detection helper. Used by both the per-row lock badge
  // AND the bulk-unlock CTA cost calculation, so the row icons and the
  // "Unlock all N chapters" count CANNOT diverge by construction. Two-signal
  // logic mirrors mobile's BookUnlocksService.isChapterLockedForDisplay:
  //
  //   • Book-level threshold: book.lock_from_chapter is set AND
  //     chapter.chapter_number >= lock_from_chapter
  //   • Per-chapter override:  chapter.is_locked === true
  //
  // …minus already-unlocked chapters (the user has already paid for them, no
  // lock should display). No owner-bypass here — author + reader both see
  // locks, matching what mobile now does too.
  const lockFrom = book.lock_from_chapter || null;
  const isChapterLockedForReader = (c) => {
    if (!lockFrom && !c.is_locked) return false;
    const isAtOrAfterLockPoint = lockFrom != null && c.chapter_number >= lockFrom;
    if (!isAtOrAfterLockPoint && !c.is_locked) return false;
    const realId = c.id.startsWith('sb_') ? c.id.slice(3) : c.id;
    return !_cfg.isUnlocked('chapter', realId);
  };

  const stillLockedChapters = chapters.filter(isChapterLockedForReader);
  const lockedChapterCount = stillLockedChapters.length;

  const chaptersHtml = chapters.length
    ? chapters.map(c => {
        const locked = isChapterLockedForReader(c);
        const lockBadge = locked
          ? `<span class="chapter-row-lock" title="Locked — tap to unlock">
               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
             </span>`
          : '';
        return `
          <div class="chapter-row${locked ? ' is-locked' : ''}" data-chapter-id="${c.id}">
            <span class="chapter-row-num">#${c.chapter_number}</span>
            <span class="chapter-row-title">${escHTML(c.title || `#${c.chapter_number}`)}</span>
            ${lockBadge}
            <span class="chapter-row-meta">${(c.word_count || 0).toLocaleString()} words</span>
          </div>
        `;
      }).join('')
    : '<div style="color:var(--text2);padding:1rem 0">No chapters published yet.</div>';

  // Bulk unlock CTA — shown only when at least 1 chapter is currently locked.
  //
  // Cost is the SUM of each still-locked chapter's resolved price (per-chapter
  // override OR global default), then the bulk discount applied. This mirrors
  // what mobile does in BookChaptersUnlockModal.jsx (sumLockedChaptersCost).
  // The previous implementation multiplied the global default by lockedChapterCount,
  // which ignored the per-chapter overrides entirely — an author who set
  // 3 coins per chapter saw a bulk price computed off the 25-coin global default.
  const bulkDiscount = _cfg.getWalletConfig().book_bulk_unlock_discount_pct ?? 15;
  const bulkBefore = stillLockedChapters.reduce(
    (sum, c) => sum + (_cfg.resolveUnlockCost('chapter', 'coin', c) || 0),
    0,
  );
  const bulkStarBefore = stillLockedChapters.reduce(
    (sum, c) => sum + (_cfg.resolveUnlockCost('chapter', 'star', c) || 0),
    0,
  );
  const bulkCoin = Math.max(1, bulkBefore - Math.floor((bulkBefore * bulkDiscount) / 100));
  const bulkStar = Math.max(1, bulkStarBefore - Math.floor((bulkStarBefore * bulkDiscount) / 100));
  const bulkUnlockCard = lockedChapterCount > 0 ? `
    <div class="book-bulk-unlock">
      <div class="book-bulk-unlock-icon">📚</div>
      <div class="book-bulk-unlock-meta">
        <div class="book-bulk-unlock-title">Unlock all <strong>${lockedChapterCount}</strong> locked chapter${lockedChapterCount === 1 ? '' : 's'}</div>
        <div class="book-bulk-unlock-sub">Save ${bulkDiscount}% vs unlocking one by one</div>
      </div>
      <button class="btn btn-purple" id="btnBulkUnlockBook" data-locked-count="${lockedChapterCount}" data-coin="${bulkCoin}" data-star="${bulkStar}">
        ${bulkCoin} coin${bulkCoin === 1 ? '' : 's'} or ${bulkStar} star${bulkStar === 1 ? '' : 's'}
      </button>
    </div>
  ` : '';

  content.innerHTML = `
    <div class="book-detail">
      <div class="book-detail-cover">${cover}</div>
      <div class="book-detail-info">
        <h1>${escHTML(book.title || 'Untitled')}</h1>
        <button class="book-detail-author book-detail-author-link" data-author-id="${escHTML(book.profiles?.id || book.author_id || '')}" type="button" title="View author profile">
          <div class="avatar">${authorAvatar ? `<img src="${escHTML(authorAvatar)}"/>` : initials(authorName)}</div>
          <span>by <strong>${escHTML(authorName)}</strong></span>
        </button>
        <div class="book-detail-meta">
          <span><strong>${(book.chapters_count || chapters.length).toLocaleString()}</strong> chapters</span>
          <span><strong>${(book.word_count || 0).toLocaleString()}</strong> words</span>
          <span><strong>${(book.views_count || 0).toLocaleString()}</strong> views</span>
          <span><strong>${(book.likes_count || 0).toLocaleString()}</strong> likes</span>
        </div>
        <div class="book-detail-genre-row">
          ${book.genre ? `<button class="book-chip active" type="button">${escHTML(book.genre.replace(/-/g, ' '))}</button>` : ''}
          ${tagsHtml}
        </div>
        <div class="book-detail-actions">
          <button class="btn btn-purple btn-sm" id="btnStartReading" ${chapters.length ? '' : 'disabled style="opacity:0.5;cursor:not-allowed"'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Start reading
          </button>
          <button class="btn btn-ghost btn-sm book-action-btn" id="btnLikeBook" data-active="0">
            <svg class="book-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <span class="book-action-label">Like</span>
            <span class="book-action-count" id="btnLikeBookCount">${(book.likes_count || 0).toLocaleString()}</span>
          </button>
          <button class="btn btn-ghost btn-sm book-action-btn" id="btnBookmarkBook" data-active="0">
            <svg class="book-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
            <span class="book-action-label">Bookmark</span>
          </button>
          ${(_cfg.getCurrentProfile()?.role === 'admin' || _cfg.getCurrentProfile()?.role === 'moderator') ? `
            <button class="btn btn-sm book-action-btn book-editors-pick-btn ${book.is_editors_pick ? 'is-picked' : ''}" id="btnEditorsPick" data-picked="${book.is_editors_pick ? '1' : '0'}" title="${book.is_editors_pick ? "Remove Editor's Pick" : "Mark as Editor's Pick"}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="${book.is_editors_pick ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
              <span class="book-action-label">${book.is_editors_pick ? "Editor's Pick" : 'Pick'}</span>
            </button>
          ` : ''}
        </div>
        <div class="book-detail-description">${escHTML(book.description || 'No description provided.')}</div>
        ${bulkUnlockCard}
        <div class="chapter-list">
          <div class="chapter-list-title">Chapters</div>
          ${chaptersHtml}
        </div>
      </div>
    </div>
  `;

  // Sanity check: the count of `.chapter-row.is-locked` DOM nodes must
  // equal `lockedChapterCount` (the number used by the bulk-unlock CTA).
  // If the two ever disagree, the bulk button will charge for a different
  // set of chapters than the user can see locked — exactly the kind of
  // bug we just fixed (and want a guard against re-introducing).
  //
  // We log a console warning rather than throwing so a divergence in
  // production surfaces in dev tools without breaking the user's flow.
  // The `_walletConfigDefaults` and lock detection both live in this
  // function, so any future logic change touching either will be caught
  // here on the next render.
  const renderedLockCount = content.querySelectorAll('.chapter-row.is-locked').length;
  if (renderedLockCount !== lockedChapterCount) {
    console.warn(
      `[lock-count-mismatch] book ${book.id}: rendered ${renderedLockCount} lock icons but bulk CTA says ${lockedChapterCount}. ` +
      `Lock detection has diverged between row render and stillLockedChapters filter — check isChapterLockedForReader callers.`
    );
  }

  // Wire chapter rows
  content.querySelectorAll('.chapter-row').forEach((row, i) => {
    row.addEventListener('click', () => openChapterReader(i));
  });

  // Wire clickable author → opens their profile
  content.querySelector('.book-detail-author-link')?.addEventListener('click', (e) => {
    const authorId = e.currentTarget.dataset.authorId;
    if (authorId) _cfg.openProfile(authorId);
  });

  // Bulk-unlock button — opens a modal with coin/star choice + final price
  document.getElementById('btnBulkUnlockBook')?.addEventListener('click', () => {
    _cfg.openBulkBookUnlockDialog({
      bookId:        book.id,
      bookTitle:     book.title || 'this book',
      lockedCount:   parseInt(document.getElementById('btnBulkUnlockBook').dataset.lockedCount, 10) || lockedChapterCount,
      coinCost:      parseInt(document.getElementById('btnBulkUnlockBook').dataset.coin, 10) || bulkCoin,
      starCost:      parseInt(document.getElementById('btnBulkUnlockBook').dataset.star, 10) || bulkStar,
      discountPct:   bulkDiscount,
      onUnlocked:    () => openBookDetail(book.id),
    });
  });
  // Start reading → first unread chapter (or chapter 1)
  document.getElementById('btnStartReading')?.addEventListener('click', () => openChapterReader(0));

  // Wire like + bookmark
  const likeBtn = document.getElementById('btnLikeBook');
  const bookmarkBtn = document.getElementById('btnBookmarkBook');
  likeBtn?.addEventListener('click', () => toggleBookLike(book.id));
  bookmarkBtn?.addEventListener('click', () => toggleBookBookmark(book.id));

  // Editor's Pick toggle (mods/admins only — button is gated server-side too)
  document.getElementById('btnEditorsPick')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const currentlyPicked = btn.dataset.picked === '1';
    const willPick = !currentlyPicked;
    btn.disabled = true;
    let note = null;
    if (willPick) {
      // Optional editorial note — short blurb that shows up in tooltips/lists
      note = prompt('Optional — short editorial note (why is this an Editor\'s Pick?):', '') || null;
    }
    try {
      const { data, error } = await supabase.rpc('set_editors_pick', {
        p_book_id: book.id,
        p_pick: willPick,
        p_note: note,
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Failed to update Editor\'s Pick');
      // Update UI inline
      btn.dataset.picked = willPick ? '1' : '0';
      btn.classList.toggle('is-picked', willPick);
      btn.querySelector('.book-action-label').textContent = willPick ? "Editor's Pick" : 'Pick';
      btn.querySelector('svg').setAttribute('fill', willPick ? 'currentColor' : 'none');
      btn.title = willPick ? "Remove Editor's Pick" : "Mark as Editor's Pick";
      // Mutate cached book so re-renders stay in sync
      if (currentBookDetail?.book) {
        currentBookDetail.book.is_editors_pick = willPick;
        currentBookDetail.book.editors_pick_at = willPick ? new Date().toISOString() : null;
        currentBookDetail.book.editors_pick_note = willPick ? note : null;
      }
      toast(willPick ? 'Marked as Editor\'s Pick ⭐' : 'Removed from Editor\'s Pick', 'success');
    } catch (err) {
      toast(err.message || String(err), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Load initial state (whether the user has already liked/bookmarked)
  loadBookActionState(book.id);
}

// ────────────────────────────────────────────────────────────────────────
// Load initial like/bookmark state for the current book + render visual
// ────────────────────────────────────────────────────────────────────────
async function loadBookActionState(bookId) {
  if (!_cfg.getCurrentUser()) return;
  try {
    const [{ data: like }, { data: bm }] = await Promise.all([
      supabase.from('book_likes').select('book_id').eq('user_id', _cfg.getCurrentUser().id).eq('book_id', bookId).maybeSingle(),
      supabase.from('book_bookmarks').select('book_id').eq('user_id', _cfg.getCurrentUser().id).eq('book_id', bookId).maybeSingle(),
    ]);
    setBookActionActive('btnLikeBook',     !!like);
    setBookActionActive('btnBookmarkBook', !!bm);
  } catch (e) { /* non-fatal */ }
}

function setBookActionActive(buttonId, active) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  btn.dataset.active = active ? '1' : '0';
  // Fill the SVG icon when active (heart filled, bookmark filled)
  const icon = btn.querySelector('.book-action-icon');
  if (icon) icon.setAttribute('fill', active ? 'currentColor' : 'none');
  // Update label
  const label = btn.querySelector('.book-action-label');
  if (label) {
    if (buttonId === 'btnLikeBook')      label.textContent = active ? 'Liked' : 'Like';
    if (buttonId === 'btnBookmarkBook')  label.textContent = active ? 'Saved' : 'Bookmark';
  }
}

async function toggleBookLike(bookId) {
  if (!_cfg.getCurrentUser()) { toast('Sign in to like books', 'error'); return; }
  const btn  = document.getElementById('btnLikeBook');
  const wasActive = btn?.dataset.active === '1';
  const countEl   = document.getElementById('btnLikeBookCount');

  // Optimistic UI — flip immediately
  setBookActionActive('btnLikeBook', !wasActive);
  if (countEl) {
    const cur = parseInt(countEl.textContent.replace(/[^\d]/g, ''), 10) || 0;
    const next = wasActive ? Math.max(0, cur - 1) : cur + 1;
    countEl.textContent = next.toLocaleString();
    if (currentBookDetail?.book) currentBookDetail.book.likes_count = next;
  }

  try {
    if (wasActive) {
      const { error } = await supabase.from('book_likes')
        .delete()
        .eq('user_id', _cfg.getCurrentUser().id)
        .eq('book_id', bookId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('book_likes')
        .insert({ user_id: _cfg.getCurrentUser().id, book_id: bookId });
      // Ignore duplicate-key (already liked from another tab); other errors throw
      if (error && !/duplicate|unique/i.test(error.message)) throw error;
    }
  } catch (e) {
    // Revert optimistic UI on error
    setBookActionActive('btnLikeBook', wasActive);
    if (countEl) {
      const cur = parseInt(countEl.textContent.replace(/[^\d]/g, ''), 10) || 0;
      countEl.textContent = (wasActive ? cur + 1 : Math.max(0, cur - 1)).toLocaleString();
    }
    toast('Failed: ' + (e.message || e), 'error');
  }
}

async function toggleBookBookmark(bookId) {
  if (!_cfg.getCurrentUser()) { toast('Sign in to bookmark books', 'error'); return; }
  const btn = document.getElementById('btnBookmarkBook');
  const wasActive = btn?.dataset.active === '1';

  // Optimistic UI
  setBookActionActive('btnBookmarkBook', !wasActive);

  try {
    if (wasActive) {
      const { error } = await supabase.from('book_bookmarks')
        .delete()
        .eq('user_id', _cfg.getCurrentUser().id)
        .eq('book_id', bookId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('book_bookmarks')
        .insert({ user_id: _cfg.getCurrentUser().id, book_id: bookId });
      if (error && !/duplicate|unique/i.test(error.message)) throw error;
    }
  } catch (e) {
    setBookActionActive('btnBookmarkBook', wasActive);
    toast('Failed: ' + (e.message || e), 'error');
  }
}

// ── Chapter reader ──
async function openChapterReader(chapterIndex) {
  if (!currentBookDetail || !currentBookDetail.chapters[chapterIndex]) return;
  // Flush any in-progress chapter dwell BEFORE we mutate the
  // module-scoped open-state below. Without this, navigating
  // chapter-to-chapter would lose the previous chapter's close event.
  flushReadClose();
  currentChapterIndex = chapterIndex;
  const chapter = currentBookDetail.chapters[chapterIndex];

  _cfg.hideAllMainPages();
  chapterReaderPage.style.display = 'block';

  // (Engagement counters + anti-fraud telemetry used to fire here, BEFORE
  // the paywall check. That counted a paywall view as a "read" for both
  // the daily goal AND the dwell-distribution telemetry — a user who only
  // saw the lock CTA got farmed as if they read the chapter. Moved to
  // after the paywall check below — Codex P1.)

  document.getElementById('readerBookTitle').textContent = currentBookDetail.book.title || 'Book';
  document.getElementById('readerChapterTitle').textContent = chapter.title || `Chapter ${chapter.chapter_number}`;
  document.getElementById('readerProgress').textContent = `Chapter ${chapter.chapter_number} of ${currentBookDetail.chapters.length}`;
  document.getElementById('btnReaderPrev').disabled = chapterIndex <= 0;
  document.getElementById('btnReaderNext').disabled = chapterIndex >= currentBookDetail.chapters.length - 1;

  // Path-based deep-link-friendly chapter URL — keeps mobile Universal
  // Links / App Links able to pick this URL up if shared.
  history.pushState(null, '', `/books/${currentBookDetail.book.id}/chapter/${chapter.chapter_number}`);

  const content = document.getElementById('readerContent');
  content.innerHTML = '<div class="loading">Loading chapter...</div>';

  // Fetch full chapter content + lock fields from the right source
  let chapterContent = '';
  let resolvedChapterId = chapter.id;
  let chapterRow = null;
  try {
    const realChapterId = chapter.id.startsWith('sb_') ? chapter.id.slice(3) : chapter.id;
    const { data, error } = await supabase
      .from('chapters')
      .select('id, chapter_number, title, content, is_locked, unlock_cost_coins, unlock_cost_stars')
      .eq('id', realChapterId)
      .single();
    if (error || !data) throw new Error(error?.message || 'Chapter not found');
    chapterContent = data.content || '';
    resolvedChapterId = data.id;
    chapterRow = data;
  } catch (err) {
    console.error('openChapterReader failed:', err);
    const friendly = /timeout|canceling statement/i.test(err.message || '')
      ? 'This chapter is taking too long to load. Tap to retry.'
      : /not found/i.test(err.message || '')
      ? 'This chapter isn\'t available — it may have been unpublished.'
      : 'Couldn\'t load this chapter. Tap to retry.';
    content.innerHTML = `<div class="loading" id="chapterRetry" style="cursor:pointer">${escHTML(friendly)}</div>`;
    document.getElementById('chapterRetry')?.addEventListener('click', () => openChapterReader(chapterIndex));
    return;
  }

  // PAYWALL: locked + not unlocked → render the lock CTA instead of content.
  //
  // Two-signal lock check, matching the row-rendering logic above and mobile's
  // isAuthorChapterLocked / isChapterLocked helpers. A chapter is locked when:
  //   • chapter.is_locked === true (per-chapter explicit override), OR
  //   • book.lock_from_chapter is set AND chapter_number >= lock_from_chapter
  //     (book-level paywall threshold cascade).
  //
  // The previous version only honored chapter.is_locked, so any chapter that
  // was only locked via the book-level threshold (the common case for writers
  // using the picker) silently rendered for free even though the TOC row
  // showed a lock badge — a real revenue-leak bug.
  const bookLockFrom = currentBookDetail?.book?.lock_from_chapter;
  const isThresholdLocked = bookLockFrom != null && Number(chapterRow.chapter_number) >= Number(bookLockFrom);
  const chapterIsLocked = !!chapterRow.is_locked || isThresholdLocked;
  if (chapterIsLocked && !_cfg.isUnlocked('chapter', resolvedChapterId)) {
    const coinCost = _cfg.resolveUnlockCost('chapter', 'coin', chapterRow);
    const starCost = _cfg.resolveUnlockCost('chapter', 'star', chapterRow);
    content.style.fontSize = '';
    content.innerHTML = `
      <div class="reader-paywall">
        <div class="reader-paywall-icon">🔒</div>
        <h2>This chapter is locked</h2>
        <p>Unlock once to read as many times as you like.</p>
        <div class="reader-paywall-pricing">
          <span><b>${coinCost}</b> coin${coinCost === 1 ? '' : 's'}</span>
          <span class="reader-paywall-or">or</span>
          <span><b>${starCost}</b> star${starCost === 1 ? '' : 's'}</span>
        </div>
        <button class="btn btn-purple" id="btnReaderUnlock">Unlock chapter</button>
      </div>
    `;
    document.getElementById('btnReaderUnlock')?.addEventListener('click', () => {
      _cfg.openUnlockDialog({
        targetType: 'chapter',
        targetId:   resolvedChapterId,
        row:        chapterRow,
        title:      chapterRow.title || `Chapter ${chapterRow.chapter_number}`,
        onUnlocked: () => openChapterReader(chapterIndex),  // re-open after unlock
      });
    });
    return;
  }

  // Apply current font size and inject normalized content (HTML or plain text)
  content.style.fontSize = `${readerFontSize}rem`;
  content.innerHTML = normalizeChapterContent(chapterContent);
  content.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Apply username watermark (re-run in case the user logged in/out since last read)
  applyReaderWatermark();

  // ─── Telemetry + counters fire HERE — past the paywall check, only
  // when the reader actually sees content. (Pre-Codex this ran at the
  // top of openChapterReader, which farmed read-goal ticks + dwell
  // telemetry from users who only saw the lock CTA — Codex P1.)

  // Daily-goal: "Read N chapters" tick. Dedupe by chapter id (strip
  // the 'sb_' prefix if present) so re-opening the same chapter
  // mid-session doesn't farm. Fire-and-forget — the RPC is best-
  // effort and never gates the reader render. Mirrors mobile at
  // app/(book)/book-reading.jsx:444.
  try {
    const ckey = String(resolvedChapterId || '').replace(/^sb_/, '');
    if (ckey) _cfg.tickGoalUnique('read_chapters', ckey);
  } catch {}

  // Anti-fraud telemetry — log chapter open (dwell_ms=0, scroll_pct=0).
  // The matching close event fires from the "previous chapter" / "next
  // chapter" / back-out handlers via flushReadClose with the actual
  // dwell + scroll values. Two-event pattern lets Phase 4's detection
  // job compute dwell distributions and flag bot-like reads (open →
  // immediate close with no scroll).
  const realChapterIdForLog = String(resolvedChapterId || '').replace(/^sb_/, '');
  if (realChapterIdForLog) {
    _readChapterOpenTs = Date.now();
    _readChapterOpenId = realChapterIdForLog;
    _readChapterOpenBookId = currentBookDetail?.book?.id || null;
    _readMaxScrollPct = 0;
    _cfg.logRead({
      chapterId: realChapterIdForLog,
      bookId:    _readChapterOpenBookId,
      dwellMs:   0,
      scrollPct: 0,
    });
  }

  // Bump the chapter views counter via the canonical RPC. Pre-Codex
  // the saveReadingProgress() path wrote directly to `chapter_reads`,
  // relying on a trigger to bump chapters.views_count + books.views_count.
  // That trigger was dropped in 2026-05-09_simple_views_no_cooldown.sql
  // (replaced with the record_chapter_view RPC). Without this call,
  // web chapter reads stopped feeding the aggregate counter while
  // mobile kept incrementing it — writers' view totals would drift
  // mobile-only. (Codex P1.)
  try {
    supabase.rpc('record_chapter_view', { p_chapter_id: resolvedChapterId });
  } catch (e) {
    console.warn('[reader] record_chapter_view failed (non-fatal):', e?.message || e);
  }

  saveReadingProgress(currentBookDetail.book.id, resolvedChapterId, chapter.chapter_number);
}

// Normalize chapter content: if HTML-ish, render as-is; if plain text, wrap in <p>
function normalizeChapterContent(content) {
  if (!content) return '<p><em>(No content)</em></p>';
  // Detect common HTML tags to decide
  if (/<\/?(p|div|br|h[1-6]|blockquote|ul|ol|li|strong|em|b|i|a|img|span)\b/i.test(content)) {
    return content;
  }
  // Treat as plain text — split by blank lines into paragraphs, preserve single newlines as <br>
  return content
    .split(/\n\s*\n/)
    .filter(p => p.trim())
    .map(p => `<p>${escHTML(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

async function saveReadingProgress(bookId, chapterId, chapterNumber) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const nowIso = new Date().toISOString();

    // 1) book_reads — per-user reading progress (continue-reading rail).
    //    Composite PK (user_id, book_id), one row per user per book ever.
    await supabase.from('book_reads').upsert({
      user_id: user.id,
      book_id: bookId,
      last_chapter_id: chapterId,
      last_chapter_number: chapterNumber,
      last_read_at: nowIso,
    }, { onConflict: 'user_id,book_id' });

    // (The direct `chapter_reads` insert + 23505-fallback used to live
    // here, relying on the old bump_views_on_chapter_read trigger.
    // That trigger was dropped in 2026-05-09_simple_views_no_cooldown.sql
    // — views are now bumped by `record_chapter_view` RPC, which
    // openChapterReader calls after the paywall check. Removing this
    // block prevents a double-bump and matches mobile's path.)
  } catch (e) { /* ignore */ }
}

async function getReaderWatermarkLabel() {
  if (_watermarkLabelCache) return _watermarkLabelCache;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { _watermarkLabelCache = 'Guest'; return _watermarkLabelCache; }
    // Try profile.username, then email local part, then user id prefix
    const { data: profile } = await supabase
      .from('profiles').select('username').eq('id', user.id).maybeSingle();
    const username = profile?.username
      || (user.email ? user.email.split('@')[0] : null)
      || (user.id ? user.id.slice(0, 8) : 'User');
    _watermarkLabelCache = `${username} · ${(user.id || '').slice(0, 6)}`;
  } catch {
    _watermarkLabelCache = 'Reader';
  }
  return _watermarkLabelCache;
}

async function applyReaderWatermark() {
  const el = document.getElementById('readerContent');
  if (!el) return;
  const label = await getReaderWatermarkLabel();
  const isLight = document.body.classList.contains('light');
  const fillColor = isLight ? '%237c3aed' : '%23a78bfa'; // %23 = encoded "#"
  // Encode for safe data URI use
  const safeLabel = String(label).replace(/[<>&'"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' }[c]));
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">' +
      '<text x="160" y="100" text-anchor="middle"' +
        ' transform="rotate(-25 160 100)"' +
        ` fill="${isLight ? '#7c3aed' : '#a78bfa'}" fill-opacity="0.09"` +
        ' font-family="system-ui, -apple-system, sans-serif"' +
        ' font-size="13" font-weight="500" letter-spacing="0.04em">' +
        safeLabel +
      '</text>' +
    '</svg>';
  const dataUri = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  el.style.setProperty('--reader-watermark-bg', dataUri);
}


// ─── Stage 8B exports ─────────────────────────────────────────────
export {
  openBookDetail,
  renderBookDetail,
  loadBookActionState,
  setBookActionActive,
  toggleBookLike,
  toggleBookBookmark,
  openChapterReader,
  normalizeChapterContent,
  saveReadingProgress,
  getReaderWatermarkLabel,
  applyReaderWatermark,
};

// ─── Stage 8A exports ─────────────────────────────────────────────
export {
  showBook,
  loadBooksTab,
  _loadForYouTab,
  _renderBookSection,
  _fetchHiddenGems,
  _fetchQuickReads,
  _fetchWeeklyFeaturedWithFallback,
  _fetchRecommendedForUser,
  _loadRankingTab,
  _renderRankGenreChips,
  _loadRankingForGenre,
  _renderRankCard,
  _loadDiscoverTab,
  _loadDiscoverGenreRow,
  _loadCollectionTab,
  _loadReadingListTab,
  _renderBookCardV2,
  _openBookSeeAll,
  _loadMoreSeeAllBooks,
  _setupSeeAllInfiniteScroll,
  applyBookFilter,
  searchBooks,
  runBookSearch,
  renderWriterChannelCard,
  _normalizeBookRow,
  _normalizeBookRows,
  fetchSupabaseBooks,
  fetchBooksServerSearch,
  renderBookCard,
  prettyGenre,
  getUserBookTaste,
  renderBookChips,
  loadBookRecommendations,
  renderBookRecsRail,
};

// ─── Session-state reset (called from app.js sign-in/sign-out paths) ─────
// Reaches into module-private state that's user-scoped — the per-tab
// "first visit" gates, the user-taste cache, and the personalised recs
// cache. Stage 8A pre-Codex left these as `typeof X !== 'undefined'`
// guards in app.js, which silently returned `undefined` in an ES module
// and never ran the reset. Result: a user signing out then a different
// user signing in could briefly see the previous user's reading list
// gate + cached taste + cached recs. (Codex P1 catch.)
//
// `clearPublic: true` ALSO drops the unfiltered book pool — used at
// sign-out so we don't keep the previous browsing context in memory.
// Sign-in does NOT pass clearPublic because the listing data isn't
// user-scoped (everyone sees the same trending/recent set).
export function resetBooksSessionState({ clearPublic = false } = {}) {
  // Per-tab first-visit gates — forces Reading List (and the rest) to
  // re-fetch on the next showBook() / loadBooksTab() call.
  _bookTabLoaded.foryou      = false;
  _bookTabLoaded.discover    = false;
  _bookTabLoaded.ranking     = false;
  _bookTabLoaded.readinglist = false;

  // User-taste cache (book_reads + book_likes seedlist).
  _userBookTasteCache = null;
  _userBookTasteAt    = 0;

  // Personalised recommendation rail cache.
  _bookRecsCache     = null;
  _bookRecsTimestamp = 0;

  if (clearPublic) {
    // Drop the cached public listing too. Mostly cosmetic — the next
    // showBook() will repopulate — but keeps "previous user's session"
    // out of memory entirely.
    allBooksCache = [];
    allBooksRaw   = [];
  }
}

// ─── Accessors for module-private state that app.js still touches ─────────
// These are the only state vars the search bar handler and (legacy) tab
// reader at line ~5760 of app.js still need to read/write. Exporting
// getter/setter pairs keeps the source of truth here in books.js while
// letting the topbar search input stay in app.js (it's not books-only —
// the same input also runs video search and post search).
export function getActiveBookTab()           { return _activeBookTab; }
export function setActiveBookTab(t)          { _activeBookTab = t; }
export function getActiveBookSearchQuery()   { return activeBookSearchQuery; }
export function setActiveBookSearchQuery(v)  { activeBookSearchQuery = v; }

// ─── wireBooksPage — module-level DOM wiring, called from app.js ──────────
// Three event listeners that previously lived as top-level side-effects in
// app.js. They mutate module-private state (_activeBookTab, _seeAllObserver),
// so they belong here rather than reaching across modules through getters.
//
// Guarded so re-calling at sign-in (app.js's onSignedIn invokes it again)
// doesn't double-bind. Without this guard the See-All grid could stick on
// "Loading…" because two delegated click handlers race: the first sets
// _seeAllLoading=true, the second increments _seeAllSeq but bails on the
// loading check, then the first response gets discarded as stale.
// (Codex P1 catch — only matters once auth flips re-call this function.)
let _booksPageWired = false;
export function wireBooksPage() {
  if (_booksPageWired) return;
  _booksPageWired = true;
  // Tab switching — one delegated listener on the tab bar.
  document.getElementById('bookTabs')?.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.book-tab');
    if (!tabBtn) return;
    const t = tabBtn.dataset.bookTab;
    if (!t || t === _activeBookTab) return;
    _activeBookTab = t;
    document.querySelectorAll('#bookTabs .book-tab').forEach(x => {
      const isActive = x === tabBtn;
      x.classList.toggle('active', isActive);
      x.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    document.querySelectorAll('.book-tab-panel').forEach(p => {
      const isActive = p.dataset.bookPanel === t;
      p.style.display = isActive ? '' : 'none';
      p.classList.toggle('active', isActive);
    });
    // Close any open See-All sub-view when switching tabs.
    const seeAll = document.getElementById('bookSeeAllView');
    if (seeAll) seeAll.style.display = 'none';
    if (_seeAllObserver) { _seeAllObserver.disconnect(); _seeAllObserver = null; }
    loadBooksTab(t);
    window.scrollTo({ top: 0, behavior: 'instant' });
  });

  // "See All" link — event-delegated from the bookPage container so we
  // pick up section rows even after Discover/Ranking lazy-render.
  document.getElementById('bookPage')?.addEventListener('click', (e) => {
    const seeAllBtn = e.target.closest('.book-section-see-all');
    if (!seeAllBtn) return;
    e.preventDefault();
    _openBookSeeAll(seeAllBtn.dataset.seeAll);
  });

  // See-All back button — restores the active tab panel and tears down
  // the infinite-scroll observer for the sub-view.
  document.getElementById('btnBookSeeAllBack')?.addEventListener('click', () => {
    const seeAll = document.getElementById('bookSeeAllView');
    if (seeAll) seeAll.style.display = 'none';
    document.querySelectorAll('.book-tab-panel').forEach(p => {
      const isActive = p.dataset.bookPanel === _activeBookTab;
      p.style.display = isActive ? '' : 'none';
      p.classList.toggle('active', isActive);
    });
    if (_seeAllObserver) { _seeAllObserver.disconnect(); _seeAllObserver = null; }
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
}

// ─── flushReadClose — Stage 8B (moved from app.js with its state) ──────────
// Emits the matching "close" event for the most recent logRead({open})
// fired by openChapterReader. Called from app.js's hideAllMainPages when
// the chapter reader is leaving the screen (back-button, sidebar nav,
// deep-link to another route), and called from openChapterReader itself
// before opening a new chapter so the previous chapter's dwell isn't
// lost. All four module-private state vars (_readChapterOpenTs/Id/BookId
// + _readMaxScrollPct) get reset here so a re-open starts fresh.
export function flushReadClose(completed = null) {
  if (!_readChapterOpenTs || !_readChapterOpenId) return;
  const dwellMs = Date.now() - _readChapterOpenTs;
  _cfg.logRead({
    chapterId: _readChapterOpenId,
    bookId:    _readChapterOpenBookId,
    dwellMs,
    scrollPct: _readMaxScrollPct,
    completed,
  });
  _readChapterOpenTs = 0;
  _readChapterOpenId = null;
  _readChapterOpenBookId = null;
  _readMaxScrollPct = 0;
}

// ─── wireBookReader — Stage 8B module-level DOM wiring ─────────────────────
// Five things that previously lived as top-level side-effects in app.js.
// They all reach into book-detail / chapter-reader state (currentBookDetail,
// currentChapterIndex, readerFontSize, applyReaderWatermark) so they belong
// here rather than across modules through accessors. App.js calls this
// once at boot, right after wireBooksPage().
//
//   1. btnBackBooks → showBook (return from detail page to listing)
//   2. #sidebarThemeToggle .sidebar-theme-option → re-render watermark on
//      theme flip so the muted purple stays legible in both modes
//   3. setupReaderAntiCopy IIFE → selectstart / copy / cut / contextmenu /
//      dragstart / Cmd-A·C·X blockers on the reader content
//   4. btnReaderPrev / btnReaderNext → chapter navigation
//   5. btnBackBookDetail → return to detail page from reader
//   6. btnReaderFontSmaller / btnReaderFontLarger → font-size adjust + persist
//
// `?.addEventListener` no-ops on missing elements, so wireBookReader is
// safe to call before the full reader DOM exists (it doesn't, but the
// guard means a future hot-reload that swaps out elements won't crash).
//
// Same idempotency guard as wireBooksPage — anti-copy + nav listeners
// would double-fire if re-called at sign-in (Codex P1 sibling catch).
let _bookReaderWired = false;
export function wireBookReader() {
  if (_bookReaderWired) return;
  _bookReaderWired = true;
  // (1) Back to books listing.
  document.getElementById('btnBackBooks')?.addEventListener('click', () => showBook());

  // (2) Theme-toggle → re-render watermark. The watermark uses different
  // fill colours in light vs dark mode (purple muted to ~9% alpha either
  // way) — re-rendering after the body class flips keeps the SVG visible.
  // Deferred 50ms so the body class swap actually lands first.
  document.querySelectorAll('#sidebarThemeToggle .sidebar-theme-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTimeout(() => {
        if (chapterReaderPage?.style.display === 'block') applyReaderWatermark();
      }, 50);
    });
  });

  // (3) Anti-copy guard on the reader. Discourages casual copy-paste —
  // not bulletproof against DevTools/view-source, but blocks selection,
  // right-click, Cmd/Ctrl+C/X/A inside the reader content.
  (function setupReaderAntiCopy() {
    const el = document.getElementById('readerContent');
    if (!el) return;

    const isReaderVisible = () =>
      chapterReaderPage && chapterReaderPage.style.display === 'block';

    let antiCopyToastTimer = null;
    const showAntiCopyToast = () => {
      if (antiCopyToastTimer) return;          // throttle so we don't spam
      toast('Copying is disabled to protect the author\'s work', 'error');
      antiCopyToastTimer = setTimeout(() => { antiCopyToastTimer = null; }, 1500);
    };

    // Block selection-start (covers click-and-drag)
    el.addEventListener('selectstart', (e) => { e.preventDefault(); return false; });

    // Block native copy (Cmd/Ctrl+C, right-click → Copy)
    el.addEventListener('copy', (e) => {
      e.preventDefault();
      e.clipboardData?.setData('text/plain', '');
      showAntiCopyToast();
      return false;
    });

    // Block cut + paste too, just in case the reader ever becomes editable
    el.addEventListener('cut', (e) => { e.preventDefault(); return false; });

    // Block right-click context menu inside the reader
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showAntiCopyToast();
      return false;
    });

    // Block drag (so users can't drag-out a text fragment)
    el.addEventListener('dragstart', (e) => { e.preventDefault(); return false; });

    // Block Cmd/Ctrl+A so a user can't quickly select-all then copy
    document.addEventListener('keydown', (e) => {
      if (!isReaderVisible()) return;
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;
      const k = e.key.toLowerCase();
      if (k === 'a' || k === 'c' || k === 'x') {
        // Only block if the focus is in/over the reader content, not in form inputs
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
        e.preventDefault();
        showAntiCopyToast();
      }
    });
  })();

  // (4) Reader prev/next chapter buttons.
  document.getElementById('btnReaderPrev')?.addEventListener('click', () => {
    if (currentChapterIndex > 0) openChapterReader(currentChapterIndex - 1);
  });
  document.getElementById('btnReaderNext')?.addEventListener('click', () => {
    if (currentBookDetail && currentChapterIndex < currentBookDetail.chapters.length - 1) {
      openChapterReader(currentChapterIndex + 1);
    }
  });

  // (5) Back to book detail from reader.
  document.getElementById('btnBackBookDetail')?.addEventListener('click', () => {
    if (currentBookDetail) openBookDetail(currentBookDetail.book.id);
  });

  // (6) Font-size adjust + persist. Bounded 0.85–1.6 rem.
  document.getElementById('btnReaderFontSmaller')?.addEventListener('click', () => {
    readerFontSize = Math.max(0.85, readerFontSize - 0.05);
    localStorage.setItem('selebox_reader_font', readerFontSize);
    document.getElementById('readerContent').style.fontSize = `${readerFontSize}rem`;
  });
  document.getElementById('btnReaderFontLarger')?.addEventListener('click', () => {
    readerFontSize = Math.min(1.6, readerFontSize + 0.05);
    localStorage.setItem('selebox_reader_font', readerFontSize);
    document.getElementById('readerContent').style.fontSize = `${readerFontSize}rem`;
  });
}
