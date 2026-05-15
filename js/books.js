// ════════════════════════════════════════════════════════════════════════
// Selebox books page (reader side) — extracted from js/app.js as Stage 8
// of the refactor roadmap (2026-05-16). This module owns the reader half
// of the books surface: showBook + tabs, search, card/detail/chapter
// renderers, bookmarks page. Author/creator tooling (book editor,
// chapter editor, dashboard) stays in app.js for a later stage.
//
// Pattern: function-by-function extraction with a paren-aware brace
// matcher (v1's matcher fired on default-param `opts = {}` and broke
// fetchSupabaseBooks silently — caught before any commit).
//
// External app.js dependencies arrive via initBooks(config). Direct
// imports limited to supabase.js + event-log.js helpers.
// ════════════════════════════════════════════════════════════════════════

import { supabase, toast, escHTML, initials, timeAgo, callEdgeFunction } from './supabase.js';
import { logRead } from './event-log.js';

// ─── Config-injection dependency surface ─────────────────────────────────
let _cfg = {
  getCurrentUser:           () => null,
  hideAllMainPages:         () => {},
  stopVideoPlayer:          () => {},
  isUnlocked:               () => false,
  resolveUnlockCost:        () => 0,
  openUnlockDialog:         () => {},
  openBulkBookUnlockDialog: () => {},
  flushReadClose:           () => {},
  normalizeForSearch:       (s) => (s || '').toLowerCase(),
  sanitizeSearchQuery:      (q) => (q || '').trim(),
  escapeIlike:              (s) => s,
  isChapterLockedForReader: () => false,
  isReaderVisible:          () => false,
  setupReaderAntiCopy:      () => {},
  showAntiCopyToast:        () => {},
  tickGoalUnique:           () => {},
  playVideo:                () => {},
  loadAuthorDashboard:      async () => {},
  setAuthorView:            () => {},
  formatPhpFromMinor:       (n) => String(n || 0),
  confirmDialog:            () => Promise.resolve(false),
  closeAllModals:           () => {},
  applyReaderWatermark:     () => {},
  fetchBooksServerSearch:   async () => ({ books: [], writers: [] }),
  formatCompact:            (n) => String(n || 0),
  getUserBookTaste:         async () => ({ reads: [], likes: [] }),
  loadBookActionState:      () => {},
  loadVideoBookmarks:       async () => {},
  normalizeChapterContent:  (html) => html || '',
  prettyGenre:              (g) => g || '',
  renderWriterChannelCard:  () => document.createElement('div'),
  saveReadingProgress:      () => {},
  setBookActionActive:      () => {},
  toggleBookLike:           () => {},
  _loadCollectionTab: async () => {},
  _normalizeBookRows: (arr) => arr || [],
  _renderRankCard: () => document.createElement('div'),
  _renderRankGenreChips: () => document.createElement('div'),
  _cleanCdnUrl:          (url) => url || '',
  _supabaseRatioCrop:    (url) => url || '',
  getDISCOVER_GENRES:                 () => undefined,
  getOpenBookToken:                 () => undefined,
  setOpenBookToken:                 () => {},
  getRankingActiveGenre:                 () => undefined,
  getRankingSeq:                 () => undefined,
  bumpRankingSeq:                () => 0,
  getReadChapterOpenBookId:                 () => undefined,
  setReadChapterOpenBookId:                 () => {},
  getReadChapterOpenId:                 () => undefined,
  setReadChapterOpenId:                 () => {},
  getReadChapterOpenTs:                 () => undefined,
  setReadChapterOpenTs:                 () => {},
  getReadMaxScrollPct:                 () => undefined,
  setReadMaxScrollPct:                 () => {},
  getSeeAllHasMore:                 () => undefined,
  setSeeAllHasMore:                 () => {},
  getSeeAllObserver:                 () => undefined,
  setSeeAllObserver:                 () => {},
  getWalletConfigDefaults:                 () => undefined,
  getBookGenreFilter:                 () => undefined,
  getCurrentChapterIndex:                 () => undefined,
  setCurrentChapterIndex:                 () => {},
  getCurrentProfile:                 () => undefined,
  getReaderFontSize:                 () => undefined,
  getSearchContext:    () => 'feed',
};

export function initBooks(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// Lazy DOM refs — page elements live in index.html and app.js also
// holds const references. Lazy lookup keeps module load order flexible.
let _bookPageEl = null;
let _bookDetailPageEl = null;
let _chapterReaderPageEl = null;
let _bookmarksPageEl = null;
function bookPage()          { if (!_bookPageEl)          _bookPageEl          = document.getElementById('bookPage');          return _bookPageEl; }
function bookDetailPage()    { if (!_bookDetailPageEl)    _bookDetailPageEl    = document.getElementById('bookDetailPage');    return _bookDetailPageEl; }
function chapterReaderPage() { if (!_chapterReaderPageEl) _chapterReaderPageEl = document.getElementById('chapterReaderPage'); return _chapterReaderPageEl; }
function bookmarksPage()     { if (!_bookmarksPageEl)     _bookmarksPageEl     = document.getElementById('bookmarksPage');     return _bookmarksPageEl; }


// ─── module state ───────────────────────────────────────────────────
const _BOOKS_PER_PAGE = 6;
let bookSortBy = 'trending';
let activeBookSearchQuery = '';
let currentBookDetail = null;       // { book, chapters }
let _activeBookTab = 'foryou';
const _bookTabLoaded = { foryou: false, discover: false, ranking: false, readinglist: false };
const _SECTION_ROW_SIZE = 7;
const BOOK_RECS_TTL = 5 * 60 * 1000; // 5 min
let _bookmarksActiveTab = 'videos';

// ─── module constants ───────────────────────────────────────────────
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
const BOOK_LIST_SELECT = `
  id, title, description, cover_url, genre, tags, status,
  views_count, likes_count, chapters_count, word_count,
  views_last_7d, likes_last_7d, trending_score,
  is_editors_pick, editors_pick_at, editors_pick_note,
  lock_from_chapter, published_at, created_at, author_id,
  profiles!books_author_id_fkey ( id, username, avatar_url, is_banned )
`;
const BOOK_CARD_SELECT = `
  id, title, cover_url, genre, status, views_count, likes_count,
  chapters_count, lock_from_chapter, published_at, created_at, author_id,
  profiles!books_author_id_fkey ( id, username, avatar_url, is_banned )
`;
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

// ─── extracted functions ────────────────────────────────────────────

function showBook(force = false) {
  _cfg.hideAllMainPages();
  bookPage().style.display = 'block';
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

async function _fetchRecommendedForUser(limit = _SECTION_ROW_SIZE) {
  if (!_cfg.getCurrentUser()?.id) {
    return await fetchSupabaseBooks(0, limit, 'most-liked');
  }
  try {
    // Pull a small sample of the user's recent reads + likes to derive their taste.
    const [{ data: reads }, { data: likes }] = await Promise.all([
      supabase.from('book_reads').select('book_id').eq('user_id', _cfg.getCurrentUser().id).order('created_at', { ascending: false }).limit(20),
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
  _cfg._renderRankGenreChips();
  await _loadRankingForGenre(_cfg.getRankingActiveGenre());
}

async function _loadRankingForGenre(genreSlug) {
  const list = document.getElementById('rankList');
  if (!list) return;
  const seq = _cfg.bumpRankingSeq();
  list.innerHTML = '<div class="loading">Loading rankings…</div>';

  let books;
  try {
    // Top 100 by all-time VIEWS — highest read count wins #1, matching the
    // mobile App. Genre filter is optional (empty string = All).
    books = await fetchSupabaseBooks(0, 100, 'most-read', genreSlug ? { genre: genreSlug } : {});
  } catch (err) {
    if (seq !== _cfg.getRankingSeq()) return;
    console.warn('[Ranking] load failed:', err);
    list.innerHTML = '<div class="rank-empty">Couldn\'t load rankings. Try again.</div>';
    return;
  }
  if (seq !== _cfg.getRankingSeq()) return; // user switched genre mid-flight

  if (!books.length) {
    list.innerHTML = '<div class="rank-empty">No books in this category yet.</div>';
    return;
  }

  list.innerHTML = '';
  books.forEach((book, idx) => {
    list.appendChild(_cfg._renderRankCard(book, idx + 1));
  });
}

async function _loadDiscoverTab() {
  const wrap = document.getElementById('bookDiscoverGenres');
  if (!wrap) return;
  // Build the section skeletons so each row gets its own loading state.
  wrap.innerHTML = '';
  _cfg.getDISCOVER_GENRES().forEach(g => {
    const sec = document.createElement('div');
    sec.className = 'book-section';
    const safeG = escHTML(g);
    const pretty = escHTML(_cfg.prettyGenre(g));
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
  await Promise.all(_cfg.getDISCOVER_GENRES().map(g => _loadDiscoverGenreRow(g)));
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

function _loadReadingListTab() {
  return _cfg._loadCollectionTab({
    table: 'book_bookmarks',
    fkName: 'book_bookmarks_book_id_fkey',
    gridId: 'bookReadingListGrid',
    emptyId: 'bookReadingListEmpty',
    signedOutMsg: 'Sign in to see your reading list',
    orderColumn: 'created_at',
  });
}

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
  if (bookPage() && bookPage().style.display === 'none') return;

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
  if (_cfg.getSeeAllObserver()) { _cfg.getSeeAllObserver().disconnect(); _cfg.setSeeAllObserver(null); }
  _cfg.setSeeAllHasMore(false);
  const sentinel = document.getElementById('bookSeeAllSentinel');
  if (sentinel) sentinel.style.display = 'none';
  grid.innerHTML = '<div class="loading">Searching books…</div>';

  const savedQuery = activeBookSearchQuery;
  const { books: serverHits, writers } = await _cfg.fetchBooksServerSearch(savedQuery)
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
    writers.forEach(w => row.appendChild(_cfg.renderWriterChannelCard(w)));
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

async function renderBookChips() {
  const wrap = document.getElementById('bookGenreChips');
  if (!wrap) return;

  // Build a candidate set from BOTH platform popularity + user's reading taste
  let userTags = {};
  let platformGenres = {};

  // Platform popularity — count genres + tags across the books we already loaded
  const allLoadedBooks = (typeof allBooks !== 'undefined' && Array.isArray(allBooks))
    ? allBooks
    : (Array.isArray(window._latestBooksList) ? window._latestBooksList : []);
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
      const { reads, likes } = await _cfg.getUserBookTaste();
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
  const activeAll = !_cfg.getBookGenreFilter() ? 'active' : '';
  let html = `<button class="book-chip ${activeAll}" data-genre="">All</button>`;
  html += chips.map(g =>
    `<button class="book-chip ${g === _cfg.getBookGenreFilter() ? 'active' : ''}" data-genre="${escHTML(g)}">${escHTML(_cfg.prettyGenre(g))}</button>`
  ).join('');
  wrap.innerHTML = html;
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
    a.innerHTML = `
      <div class="recommend-card-cover">
        ${b.cover_url
          ? `<img src="${escHTML(b.cover_url)}" alt="" loading="lazy"/>`
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

    // Optional genre filter — matches either the dedicated `genre` column or
    // a tag in the `tags` array. Strip anything but [a-z0-9-] defensively so
    // a malformed genre slug can't break the .or() clause.
    if (opts.genre) {
      const safeG = String(opts.genre).toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (safeG) q = q.or(`genre.eq.${safeG},tags.cs.{${safeG}}`);
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
    return _cfg._normalizeBookRows(data);
  } catch (err) {
    console.error('fetchSupabaseBooks failed:', err);
    return [];
  }
}

function renderBookCard(b) {
  const card = document.createElement('button');
  card.className = 'book-card';
  card.dataset.bookId = b.id;
  card.onclick = () => openBookDetail(b.id);

  const authorName = b.author?.username || 'Unknown author';
  const initialLetter = (b.title || '?').trim().charAt(0).toUpperCase();
  const cover = b.cover_url
    ? `<img src="${escHTML(b.cover_url)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=&quot;book-cover-placeholder&quot;>${initialLetter}</div>'"/>`
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

async function openBookDetail(bookId) {
  _cfg.hideAllMainPages();
  bookDetailPage().style.display = 'block';

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
  _cfg.setOpenBookToken(token);

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
    if (_cfg.getOpenBookToken() !== token) return; // user already tapped a different book
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

  if (_cfg.getOpenBookToken() !== token) return; // stale — user tapped a different book

  currentBookDetail = { book: supBook, chapters: supChapters || [] };
  renderBookDetail();
}

function renderBookDetail() {
  if (!currentBookDetail) return;
  const { book, chapters } = currentBookDetail;
  const content = document.getElementById('bookDetailContent');

  const authorName = book.profiles?.username || 'Unknown';
  const authorAvatar = book.profiles?.avatar_url;
  const initialLetter = (book.title || '?').trim().charAt(0).toUpperCase();
  const cover = book.cover_url
    ? `<img src="${escHTML(book.cover_url)}" alt=""/>`
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
  const bulkDiscount = _cfg.getWalletConfigDefaults().book_bulk_unlock_discount_pct ?? 15;
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
  // The `_cfg.getWalletConfigDefaults()` and lock detection both live in this
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
    if (authorId) openProfile(authorId);
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
  likeBtn?.addEventListener('click', () => _cfg.toggleBookLike(book.id));
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
  _cfg.loadBookActionState(book.id);
}

async function toggleBookBookmark(bookId) {
  if (!_cfg.getCurrentUser()) { toast('Sign in to bookmark books', 'error'); return; }
  const btn = document.getElementById('btnBookmarkBook');
  const wasActive = btn?.dataset.active === '1';

  // Optimistic UI
  _cfg.setBookActionActive('btnBookmarkBook', !wasActive);

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
    _cfg.setBookActionActive('btnBookmarkBook', wasActive);
    toast('Failed: ' + (e.message || e), 'error');
  }
}

async function openChapterReader(chapterIndex) {
  if (!currentBookDetail || !currentBookDetail.chapters[chapterIndex]) return;
  // Flush any in-progress chapter dwell BEFORE we mutate the
  // module-scoped open-state below. Without this, navigating
  // chapter-to-chapter would lose the previous chapter's close event.
  _cfg.flushReadClose();
  _cfg.setCurrentChapterIndex(chapterIndex);
  const chapter = currentBookDetail.chapters[chapterIndex];

  _cfg.hideAllMainPages();
  chapterReaderPage().style.display = 'block';

  // Daily-goal: "Read N chapters" tick. Dedupe by chapter id (strip
  // the 'sb_' prefix if present) so re-opening the same chapter
  // mid-session doesn't farm. Fire-and-forget — the RPC is best-
  // effort and never gates the reader render. Mirrors mobile at
  // app/(book)/book-reading.jsx:444.
  try {
    const ckey = String(chapter.id || '').replace(/^sb_/, '');
    if (ckey) _cfg.tickGoalUnique('read_chapters', ckey);
  } catch {}

  // Anti-fraud telemetry — log chapter open (dwell_ms=0, scroll_pct=0).
  // The matching close event fires from the "previous chapter" / "next
  // chapter" / back-out handlers a few hundred lines down with the
  // actual dwell + scroll values. Two-event pattern lets Phase 4's
  // detection job compute dwell distributions and flag bot-like reads
  // (open → immediate close with no scroll).
  const realChapterIdForLog = String(chapter.id || '').replace(/^sb_/, '');
  if (realChapterIdForLog) {
    _cfg.setReadChapterOpenTs(Date.now());
    _cfg.setReadChapterOpenId(realChapterIdForLog);
    _cfg.setReadChapterOpenBookId(currentBookDetail?.book?.id || null);
    _cfg.setReadMaxScrollPct(0);
    logRead({
      chapterId: realChapterIdForLog,
      bookId:    _cfg.getReadChapterOpenBookId(),
      dwellMs:   0,
      scrollPct: 0,
    });
  }

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
  content.style.fontSize = `${_cfg.getReaderFontSize()}rem`;
  content.innerHTML = _cfg.normalizeChapterContent(chapterContent);
  content.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Apply username watermark (re-run in case the user logged in/out since last read)
  _cfg.applyReaderWatermark();

  _cfg.saveReadingProgress(currentBookDetail.book.id, resolvedChapterId, chapter.chapter_number);
}

function showBookmarks(forceReload = false) {
  _cfg.hideAllMainPages();
  if (bookmarksPage()) bookmarksPage().style.display = 'block';
  document.body.classList.remove('on-videos');
  _cfg.stopVideoPlayer();
  history.pushState(null, '', '#bookmarks');
  // Reload on first visit or after 60 seconds (bookmarks change rarely
  // but the user expects them to be current).
  const now = Date.now();
  const stale = !window._bookmarksLoadedAt || (now - window._bookmarksLoadedAt) > 60_000;
  if (forceReload || stale) {
    loadBookmarks();
    window._bookmarksLoadedAt = now;
  }
}

async function loadBookmarks() {
  if (!_cfg.getCurrentUser()) {
    document.getElementById('bookmarksContent').innerHTML = `
      <div class="bookmarks-empty">
        <p>Sign in to see your saved videos and books.</p>
      </div>
    `;
    return;
  }

  // Pre-load both counts so the tab badges show instantly
  const [vidCountRes, bookCountRes] = await Promise.all([
    supabase.from('video_bookmarks').select('*', { count: 'exact', head: true }).eq('user_id', _cfg.getCurrentUser().id),
    supabase.from('book_bookmarks').select('*', { count: 'exact', head: true }).eq('user_id', _cfg.getCurrentUser().id),
  ]);
  document.getElementById('bookmarkVideoCount').textContent = vidCountRes.count != null ? vidCountRes.count : '';
  document.getElementById('bookmarkBookCount').textContent  = bookCountRes.count != null ? bookCountRes.count : '';

  if (_bookmarksActiveTab === 'videos') await _cfg.loadVideoBookmarks();
  else                                  await loadBookBookmarks();
}

async function loadBookBookmarks() {
  const wrap = document.getElementById('bookmarksContent');
  wrap.innerHTML = '<div class="loading">Loading saved books…</div>';
  const { data, error } = await supabase
    .from('book_bookmarks')
    .select(`
      created_at,
      books (
        id, title, cover_url, genre, tags,
        views_count, likes_count, chapters_count, word_count,
        author_id, created_at,
        profiles!books_author_id_fkey ( id, username, avatar_url )
      )
    `)
    .eq('user_id', _cfg.getCurrentUser().id)
    .order('created_at', { ascending: false });

  if (error) { wrap.innerHTML = `<div class="bookmarks-empty"><p>${escHTML(error.message)}</p></div>`; return; }

  const items = (data || []).filter(r => r.books);
  if (!items.length) {
    wrap.innerHTML = `
      <div class="bookmarks-empty">
        <div class="bookmarks-empty-icon">📚</div>
        <h3>No saved books yet</h3>
        <p>Tap the <strong>Bookmark</strong> button on any book to save it for later.</p>
        <button class="btn btn-purple btn-sm" onclick="setSidebarActive('btnBook');showBook();">Browse books</button>
      </div>`;
    return;
  }

  wrap.innerHTML = `<div class="book-grid bookmarks-book-grid"></div>`;
  const grid = wrap.querySelector('.bookmarks-book-grid');
  for (const row of items) {
    const b = row.books;
    const card = renderBookCard(b);
    grid.appendChild(card);
  }
}


// ─── Stage 8 exports — app.js still calls into these from sidebar
//     wirings, post-card click handlers, deep-link router, page show
//     entry points, etc.

// ─── Constants exported so app.js code that still queries `books`
//     directly (See All view, recommendations, author editor) can
//     reuse the same SELECT shapes and tuning constants.
export {
  BOOK_LIST_SELECT, BOOK_CARD_SELECT,
  _BOOKS_PER_PAGE, BOOK_RECS_TTL,
};

// ─── State setters. Module-private `let` bindings can't be mutated via
//     ESM exports, so we expose narrow setters for the few app.js sites
//     that still write to them (topbar search wiring, sidebar auth
//     flow, tab click handlers).
export function setActiveBookTab(t)         { _activeBookTab = t; }
export function markBookTabLoaded(key, val) {
  if (Object.prototype.hasOwnProperty.call(_bookTabLoaded, key)) _bookTabLoaded[key] = !!val;
}
export function resetBookTabsLoaded() {
  for (const k of Object.keys(_bookTabLoaded)) _bookTabLoaded[k] = false;
}
export function setBookmarksActiveTab(t)    { _bookmarksActiveTab = t; }
export function getBookmarksActiveTab()     { return _bookmarksActiveTab; }

export {
  showBook, loadBooksTab,
  _loadRankingForGenre,
  runBookSearch, renderBookChips, renderBookRecsRail, renderBookCard, _renderBookCardV2,
  fetchSupabaseBooks,
  openBookDetail, renderBookDetail,
  openChapterReader,
  showBookmarks, loadBookmarks,
  toggleBookBookmark, loadBookBookmarks,
};

// Read accessors for state that app.js's router/editors still want to peek at
export function getCurrentBookDetail() { return currentBookDetail; }
export function getActiveBookTab()     { return _activeBookTab; }
export function setActiveBookSearchQuery(v) { activeBookSearchQuery = v || ''; }
export function getActiveBookSearchQuery()  { return activeBookSearchQuery; }
