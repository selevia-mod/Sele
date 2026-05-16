// ════════════════════════════════════════════════════════════════════════
// Selebox search — extracted from js/app.js as Stage 10 of the refactor
// roadmap (2026-05-16). This module owns:
//   • The 3 pure search helpers (sanitize / escape-ilike / normalize)
//     used by every search-capable feature (feed, videos, books).
//   • The topbar search input — DOM lookups, recent-searches dropdown,
//     context-aware placeholder (feed / videos / books), debounced input
//     handler that fans out to the right runner (runFeedSearch /
//     runSearch / runBookSearch).
//   • runFeedSearch — the People / Videos / Books / Posts dropdown that
//     fronts the home feed search.
//
// What stays in app.js:
//   • _origSearchHandler at ~13396 — that's the DM CONVERSATION search,
//     not the topbar search. It belongs to messages.js (queued for #229
//     wireMessagesPage migration).
//   • openPostFromSearch — exported from app.js for now, search.js calls
//     it via _cfg. Uses feed renderers; could fold into feed.js later.
//
// CAREFUL: this is pure code movement, not a rewrite. If you see
// something you want to "improve while you're here" — DON'T. Open a
// separate task. The whole point of the stage discipline is
// "translation, not interpretation."
//
// See REFACTOR_ROADMAP.md (Stage 10 section).
// ════════════════════════════════════════════════════════════════════════

import { supabase, escHTML, initials } from './supabase.js';

// ─── Config-injection dependency surface ──────────────────────────────────
// app.js INJECTS the live functions when it calls initSearch(config) at
// module load time. Default no-ops keep the page alive if a caller fires
// before init — but in practice initSearch runs synchronously at boot
// (no auth gating, the search bar is visible to anonymous viewers too).
let _cfg = {
  getCurrentUser:           () => null,
  renderRoleSeal:           () => '',
  openProfile:              () => {},
  openPostFromSearch:       () => {},

  // Result-click openers — call these DIRECTLY instead of relying on
  // location.hash assignment (which only fires `hashchange`, not
  // `popstate`, and the app's hash routers only listen to popstate +
  // initial boot). Caught by Stage 10 smoke test — bug #247.
  playVideo:                () => {},
  openBookDetail:           () => {},

  // Videos page search — controlled by videos.js (active query setter +
  // runner). When the topbar is in 'videos' context, the input handler
  // delegates here instead of opening the home-feed dropdown.
  setActiveSearchQuery:     () => {},
  runSearch:                () => {},

  // Books page search — same shape, controlled by books.js.
  setActiveBookSearchQuery: () => {},
  runBookSearch:            () => {},
  getActiveBookTab:         () => null,
};

export function initSearch(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// ─── Pure helpers ─────────────────────────────────────────────────────────
// PostgREST's .or() filter splits on commas and uses parens for grouping.
// If those characters end up inside the user's query, the entire OR clause
// breaks (causing "no results" for searches like `Romeo, Juliet` or
// `What's up?`). Strip them defensively — users still get matches on the
// remaining tokens.
export function sanitizeSearchQuery(raw) {
  return (raw || '')
    .replace(/[,\(\)"]/g, ' ')   // PostgREST or() splitters / quote chars
    .replace(/\s+/g, ' ')
    .trim();
}

// Escape ilike wildcards (% _ \) so a literal underscore doesn't match
// every char.
export function escapeIlike(s) {
  return (s || '').replace(/[\\%_]/g, m => '\\' + m);
}

// Strip diacritics + lowercase, so "café" matches "cafe" on local cache
// filters. (Server-side ilike is bytewise; full diacritic-insensitive
// search would need a Postgres `unaccent` index — tracked as a future
// improvement.)
export function normalizeForSearch(s) {
  return (s || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// ─── Topbar search UI ─────────────────────────────────────────────────────
// DOM lookups — these elements live in index.html's #topbar and are
// guaranteed to exist at module-load time (the script tag for app.js +
// search.js is at the end of <body>, after index.html's static markup).
// Cached at module scope because the input handler fires on every
// keystroke.
const searchInput       = document.getElementById('searchInput');
const searchResultsEl   = document.getElementById('searchResults');
const topbarSearchClear = document.getElementById('topbarSearchClear');
let searchDebounce = null;

// ─── Recent searches (web parity with mobile lib/recent-searches.js) ──
// Local-only history of recent search queries. Capped at 10 entries.
// Persists in localStorage across sessions; wiped only when the user
// taps Clear all in the dropdown. Per-user keying so signing in/out
// doesn't show another user's history.
const RECENT_SEARCHES_LIMIT = 10;
const recentSearchesKey = () => {
  const uid = _cfg.getCurrentUser()?.id || 'anon';
  return `selebox.recentSearches.${uid}`;
};
function getRecentSearches() {
  try {
    const raw = localStorage.getItem(recentSearchesKey());
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((q) => typeof q === 'string' && q.trim()) : [];
  } catch (_) {
    return [];
  }
}
function addRecentSearch(q) {
  const trimmed = (q || '').trim();
  if (!trimmed) return;
  const existing = getRecentSearches();
  // Move-to-front semantics: drop any existing match (case-insensitive)
  // then prepend, so the same term searched twice doesn't duplicate.
  const filtered = existing.filter((x) => x.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...filtered].slice(0, RECENT_SEARCHES_LIMIT);
  try { localStorage.setItem(recentSearchesKey(), JSON.stringify(next)); } catch (_) { /* swallow */ }
}
function removeRecentSearch(q) {
  const trimmed = (q || '').trim();
  if (!trimmed) return;
  const existing = getRecentSearches();
  const next = existing.filter((x) => x.toLowerCase() !== trimmed.toLowerCase());
  try { localStorage.setItem(recentSearchesKey(), JSON.stringify(next)); } catch (_) { /* swallow */ }
}
function clearRecentSearches() {
  try { localStorage.removeItem(recentSearchesKey()); } catch (_) { /* swallow */ }
}

// Render the recent-searches dropdown when the input is focused with
// empty value. Tapping a recent re-runs the search; tapping the X
// removes that entry.
function renderRecentSearchesPanel() {
  if (!searchResultsEl) return;
  const recents = getRecentSearches();
  if (!recents.length) {
    searchResultsEl.classList.remove('open');
    return;
  }
  const html = `
    <div class="search-result-section" style="display:flex;align-items:center;justify-content:space-between">
      <span>Recent searches</span>
      <button class="search-recent-clear" type="button" style="font-size:0.75rem;background:none;border:none;color:var(--text3);cursor:pointer">Clear all</button>
    </div>
    ${recents.map((q) => `
      <div class="search-result-item search-recent-item" data-recent="${escHTML(q)}">
        <div class="search-result-info" style="display:flex;align-items:center;gap:8px;flex:1">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text3);flex-shrink:0">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <div class="search-result-title" style="flex:1">${escHTML(q)}</div>
        </div>
        <button class="search-recent-remove" data-remove="${escHTML(q)}" type="button" aria-label="Remove" style="background:none;border:none;color:var(--text3);cursor:pointer;padding:4px">×</button>
      </div>
    `).join('')}
  `;
  searchResultsEl.innerHTML = html;
  searchResultsEl.classList.add('open');

  searchResultsEl.querySelector('.search-recent-clear')?.addEventListener('click', () => {
    clearRecentSearches();
    searchResultsEl.classList.remove('open');
  });
  searchResultsEl.querySelectorAll('.search-recent-item').forEach((el) => {
    el.addEventListener('click', (ev) => {
      // X button propagates here too — ignore if the click target is
      // the remove control, since its own handler runs first.
      if (ev.target.closest('.search-recent-remove')) return;
      const q = el.dataset.recent;
      if (!q) return;
      searchInput.value = q;
      if (topbarSearchClear) topbarSearchClear.style.display = 'flex';
      runFeedSearch(q);
    });
  });
  searchResultsEl.querySelectorAll('.search-recent-remove').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeRecentSearch(btn.dataset.remove);
      renderRecentSearchesPanel();
    });
  });
}

// Search context decides which renderer the topbar search input feeds.
//   'videos' → renders into the videos page grid
//   'books'  → renders into the books page See-All view
//   default  → home-feed dropdown (People / Videos / Books / Posts)
//
// Important: book DETAIL pages (#book/<uuid>) used to be 'books' too, which
// meant typing in search tried to render into a hidden bookPage and the
// search results vanished into the void. We now route detail pages to the
// feed dropdown, so users can find another book without leaving the reader.
function getSearchContext() {
  const hash = window.location.hash;
  if (hash === '#videos' || hash.startsWith('#video/')) return 'videos';
  if (hash === '#book') return 'books'; // listing only — detail pages use the feed dropdown
  return 'feed';
}

let _lastSearchContext = null;
function updateSearchPlaceholder() {
  if (!searchInput) return;
  const ctx = getSearchContext();
  if (ctx === 'videos')      searchInput.placeholder = 'Search videos · creator · tags · category…';
  else if (ctx === 'books')  searchInput.placeholder = 'Search books · author · tags · genre…';
  else                       searchInput.placeholder = 'Search posts and people…';

  // Reset any active query when moving between contexts (videos ↔ books ↔ feed)
  if (_lastSearchContext && _lastSearchContext !== ctx) {
    searchInput.value = '';
    if (topbarSearchClear) topbarSearchClear.style.display = 'none';
    _cfg.setActiveSearchQuery('');
    _cfg.setActiveBookSearchQuery('');
    if (searchResultsEl) searchResultsEl.classList.remove('open');
  }
  _lastSearchContext = ctx;
}

// Wire all the listeners ONCE at module load. Putting them inside
// initSearch() would re-attach on every sign-in/out, doubling every
// keystroke (same bug Stage 2 captured for scheduled-posts). The
// listeners read live values via _cfg.getCurrentUser() so the per-user
// recent-search key updates correctly across auth flips without
// re-binding.
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    const value = e.target.value;
    if (topbarSearchClear) topbarSearchClear.style.display = value ? 'flex' : 'none';

    const ctx = getSearchContext();

    if (ctx === 'videos') {
      _cfg.setActiveSearchQuery(value);
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => _cfg.runSearch(), 200);
      if (searchResultsEl) searchResultsEl.classList.remove('open');
      return;
    }

    if (ctx === 'books') {
      _cfg.setActiveBookSearchQuery(value);
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => _cfg.runBookSearch(), 200);
      if (searchResultsEl) searchResultsEl.classList.remove('open');
      return;
    }

    // Feed (default): show dropdown of matching people + posts
    clearTimeout(searchDebounce);
    if (!value.trim()) {
      // Empty value while focused → show recent-searches dropdown so the
      // user can re-run a previous query without retyping.
      if (document.activeElement === searchInput) {
        renderRecentSearchesPanel();
      } else if (searchResultsEl) {
        searchResultsEl.classList.remove('open');
      }
      return;
    }
    searchDebounce = setTimeout(() => runFeedSearch(value), 250);
  });

  // On focus with empty input, surface recent searches.
  searchInput.addEventListener('focus', () => {
    if (!searchInput.value.trim() && getSearchContext() === 'feed') {
      renderRecentSearchesPanel();
    }
  });

  // On Enter, persist the term as a recent search. Same trigger on
  // clicking a result handled below.
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = searchInput.value.trim();
    if (v) addRecentSearch(v);
  });
}

if (topbarSearchClear) {
  topbarSearchClear.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    topbarSearchClear.style.display = 'none';
    if (searchResultsEl) searchResultsEl.classList.remove('open');
    const ctx = getSearchContext();
    if (ctx === 'videos') {
      _cfg.setActiveSearchQuery('');
      _cfg.runSearch();
    } else if (ctx === 'books') {
      _cfg.setActiveBookSearchQuery('');
      // Close the See-All search view and return to the active tab panel.
      // (No "restore the cached grid" step — the v2 books page is tabbed.)
      const seeAll = document.getElementById('bookSeeAllView');
      if (seeAll) seeAll.style.display = 'none';
      const activeTab = _cfg.getActiveBookTab();
      document.querySelectorAll('.book-tab-panel').forEach(p => {
        const isActive = p.dataset.bookPanel === activeTab;
        p.style.display = isActive ? '' : 'none';
        p.classList.toggle('active', isActive);
      });
    }
  });
}

// Outside-click closes the dropdown. Bound to document because the
// topbar input is outside the .search-results panel itself.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#topbarSearch') && !e.target.closest('.search-results')) {
    if (searchResultsEl) searchResultsEl.classList.remove('open');
  }
});

// Hashchange refreshes the placeholder + clears stale queries when the
// user navigates between feed / videos / books / book detail.
window.addEventListener('hashchange', updateSearchPlaceholder);
updateSearchPlaceholder();

// ─── runFeedSearch — the People/Videos/Books/Posts dropdown ───────────────
async function runFeedSearch(query) {
  if (!searchResultsEl) return;
  const raw = (query || '').trim();
  if (!raw) { searchResultsEl.classList.remove('open'); return; }

  // Sanitize FIRST so commas / parens / quotes in the user's query don't
  // break the PostgREST .or() filter (the silent root cause behind
  // "search returns nothing" reports).
  const safeQ = sanitizeSearchQuery(raw);
  if (!safeQ) { searchResultsEl.classList.remove('open'); return; }
  const term = `%${escapeIlike(safeQ)}%`;

  searchResultsEl.classList.add('open');
  searchResultsEl.innerHTML = '<div style="padding:1rem;color:var(--text3)">Searching...</div>';

  // ── Phase 1: fetch matching profiles ──
  // Overfetched (20) so substring matches like "Ligaya" pull users like
  // "LIGAYA_ba1f" too — explicit username ordering for predictability.
  // We also need the matching profile IDs as a foreign key list for
  // phase 2 (videos/books/posts by these creators).
  const profilesRes = await supabase.from('profiles')
    .select('id, username, avatar_url, bio, is_guest, is_banned, role')
    .ilike('username', term)
    .eq('is_banned', false)
    .order('username', { ascending: true })
    .limit(20);

  // Stale-query guard — user kept typing, abandon this run.
  if ((searchInput.value || '').trim() !== raw) return;

  const profiles       = profilesRes?.data || [];
  const matchedUserIds = profiles.map(p => p.id);

  // ── Phase 2: fetch Videos / Books / Posts in parallel, body OR creator ──
  // Per Stage 10 smoke test feedback (#248): users typing a creator's
  // name want her CONTENT, not unrelated rows whose description happens
  // to mention her. Drop description matches from books/videos; keep
  // title match + add creator match. Posts get the same treatment:
  // body-substring match (legacy — catches @mentions, replies, etc.) OR
  // authored by a matching user.
  // Status filter for videos: ['ready', 'published'] (NOT just 'ready').
  // profile.js + the Videos page query both accept both statuses; using
  // only 'ready' here hid creators like Dear Jen whose 112 videos are
  // mostly 'published' (Stage 10 smoke test feedback). Same fix queued
  // separately as #205 for code-wide alignment.
  const VIDEO_STATUSES = ['ready', 'published'];

  // Per-section cap (Stage 10 smoke test feedback) — 3 each keeps the
  // dropdown compact and forces the user to "See all" for more depth.
  const SECTION_CAP = 3;

  const videoByCreatorQ = matchedUserIds.length
    ? supabase.from('videos')
        .select('id, title, thumbnail_url, uploader_id, profiles!videos_uploader_id_fkey(username, avatar_url, is_banned, role), created_at')
        .in('status', VIDEO_STATUSES).eq('is_hidden', false)
        .in('uploader_id', matchedUserIds)
        .order('created_at', { ascending: false })
        .limit(SECTION_CAP)
    : Promise.resolve({ data: [] });
  const bookByAuthorQ = matchedUserIds.length
    ? supabase.from('books')
        .select('id, title, cover_url, author_id, profiles!books_author_id_fkey(username, avatar_url, is_banned, role), created_at')
        .eq('is_public', true).eq('is_hidden', false).in('status', ['ongoing', 'completed'])
        .in('author_id', matchedUserIds)
        .order('created_at', { ascending: false })
        .limit(SECTION_CAP)
    : Promise.resolve({ data: [] });
  const postByAuthorQ = matchedUserIds.length
    ? supabase.from('posts')
        .select('*, profiles!user_id(username, avatar_url, is_guest, is_banned, role)')
        .eq('is_hidden', false)
        .in('user_id', matchedUserIds)
        .order('created_at', { ascending: false })
        .limit(SECTION_CAP)
    : Promise.resolve({ data: [] });

  const [videosTitleRes, videosCreatorRes, booksTitleRes, booksAuthorRes, postsBodyRes, postsAuthorRes] = await Promise.all([
    supabase.from('videos')
      .select('id, title, thumbnail_url, uploader_id, profiles!videos_uploader_id_fkey(username, avatar_url, is_banned, role), created_at')
      .in('status', VIDEO_STATUSES).eq('is_hidden', false)
      .ilike('title', term)
      .order('created_at', { ascending: false })
      .limit(SECTION_CAP),
    videoByCreatorQ,
    supabase.from('books')
      .select('id, title, cover_url, author_id, profiles!books_author_id_fkey(username, avatar_url, is_banned, role), created_at')
      .eq('is_public', true).eq('is_hidden', false).in('status', ['ongoing', 'completed'])
      .ilike('title', term)
      .order('created_at', { ascending: false })
      .limit(SECTION_CAP),
    bookByAuthorQ,
    supabase.from('posts')
      .select('*, profiles!user_id(username, avatar_url, is_guest, is_banned, role)')
      .eq('is_hidden', false)
      .ilike('body', term)
      .order('created_at', { ascending: false })
      .limit(SECTION_CAP),
    postByAuthorQ,
  ]);

  // Stale-query guard again (phase 2 has its own awaits).
  if ((searchInput.value || '').trim() !== raw) return;

  // Merge title-match + creator-match results, dedupe by id, drop banned
  // authors, cap at SECTION_CAP. Creator matches surface first because if
  // the user typed a username, they're most likely looking for that
  // creator's content.
  const _mergeById = (a = [], b = []) => {
    const seen = new Set();
    const out  = [];
    [...b, ...a].forEach(row => {  // creator matches first (b before a)
      if (!row || seen.has(row.id)) return;
      seen.add(row.id);
      out.push(row);
    });
    return out;
  };
  const videos = _mergeById(videosTitleRes?.data, videosCreatorRes?.data)
    .filter(v => !v.profiles?.is_banned)
    .slice(0, SECTION_CAP);
  const books  = _mergeById(booksTitleRes?.data, booksAuthorRes?.data)
    .filter(b => !b.profiles?.is_banned)
    .slice(0, SECTION_CAP);
  const posts  = _mergeById(postsBodyRes?.data, postsAuthorRes?.data)
    .filter(p => !p.profiles?.is_banned)
    .slice(0, SECTION_CAP);

  let html = '';
  if (profiles.length) {
    html += `<div class="search-result-section">People</div>`;
    profiles.forEach(p => {
      const avatar = p.avatar_url ? `<img src="${escHTML(p.avatar_url)}"/>` : initials(p.username);
      html += `
        <div class="search-result-item" data-type="profile" data-id="${p.id}">
          <div class="avatar">${avatar}</div>
          <div class="search-result-info">
            <div class="search-result-title">${escHTML(p.username)}${_cfg.renderRoleSeal(p)}</div>
            <div class="search-result-meta">${p.is_guest ? 'Guest' : 'Member'}</div>
          </div>
        </div>`;
    });
  }
  // Render order: People → Posts → Videos → Books (Stage 10 smoke test
  // feedback). Typing a creator's name surfaces (1) the creator
  // themselves, (2) their latest posts (most frequent content), (3)
  // their videos, (4) their books. Empty sections are skipped, so a
  // creator with no books simply won't get a Books header.
  if (posts.length) {
    html += `<div class="search-result-section">Posts</div>`;
    posts.forEach(p => {
      const author = p.profiles || {};
      const avatar = author.avatar_url ? `<img src="${escHTML(author.avatar_url)}"/>` : initials(author.username || 'U');
      const snippet = (p.body || '').slice(0, 80);
      html += `
        <div class="search-result-item" data-type="post" data-id="${p.id}">
          <div class="avatar">${avatar}</div>
          <div class="search-result-info">
            <div class="search-result-title">${escHTML(snippet)}${p.body && p.body.length > 80 ? '...' : ''}</div>
            <div class="search-result-meta">by ${escHTML(author.username || 'Unknown')}${_cfg.renderRoleSeal(author)}</div>
          </div>
        </div>`;
    });
  }
  if (videos.length) {
    html += `<div class="search-result-section">Videos</div>`;
    videos.forEach(v => {
      const thumb = v.thumbnail_url
        ? `<img src="${escHTML(v.thumbnail_url)}" alt="" loading="lazy"/>`
        : '';
      html += `
        <div class="search-result-item" data-type="video" data-id="${v.id}">
          <div class="search-result-thumb">${thumb}</div>
          <div class="search-result-info">
            <div class="search-result-title">${escHTML(v.title || 'Untitled')}</div>
            <div class="search-result-meta">by ${escHTML(v.profiles?.username || 'Unknown')}${_cfg.renderRoleSeal(v.profiles)}</div>
          </div>
        </div>`;
    });
  }
  if (books.length) {
    html += `<div class="search-result-section">Books</div>`;
    books.forEach(b => {
      const cover = b.cover_url
        ? `<img src="${escHTML(b.cover_url)}" alt="" loading="lazy"/>`
        : `<span class="search-creator-initials">${escHTML((b.title || '?').charAt(0).toUpperCase())}</span>`;
      html += `
        <div class="search-result-item" data-type="book" data-id="${b.id}">
          <div class="search-result-thumb search-result-thumb-book">${cover}</div>
          <div class="search-result-info">
            <div class="search-result-title">${escHTML(b.title || 'Untitled')}</div>
            <div class="search-result-meta">by ${escHTML(b.profiles?.username || 'Unknown')}${_cfg.renderRoleSeal(b.profiles)}</div>
          </div>
        </div>`;
    });
  }
  if (!html) html = '<div style="padding:1rem;color:var(--text3);text-align:center">No results found</div>';

  searchResultsEl.innerHTML = html;

  searchResultsEl.querySelectorAll('.search-result-item').forEach(item => {
    item.onclick = () => {
      const type = item.dataset.type;
      const id = item.dataset.id;
      // Persist the term that produced this result. Successful clicks
      // (the user found what they wanted) are the strongest signal
      // for "remember this query."
      const termAtClick = (searchInput.value || '').trim();
      if (termAtClick) addRecentSearch(termAtClick);

      searchResultsEl.classList.remove('open');
      searchInput.value = '';
      if (topbarSearchClear) topbarSearchClear.style.display = 'none';

      if (type === 'profile')      _cfg.openProfile(id);
      else if (type === 'post')    _cfg.openPostFromSearch(id);
      else if (type === 'video') {
        // Update the URL bar AND call the opener — setting location.hash
        // alone fires only `hashchange`, and the app's hash routers only
        // listen to popstate + initial boot, so the page never navigated
        // (Stage 10 smoke test #247). Mirrors the existing post-action
        // menu handler at app.js:3360.
        try { history.pushState(null, '', `#video/sb_${id}`); } catch {}
        _cfg.playVideo(`sb_${id}`);
      }
      else if (type === 'book') {
        try { history.pushState(null, '', `#book/${id}`); } catch {}
        _cfg.openBookDetail(id);
      }
    };
  });
}

// Exported so app.js can call it directly if it wants to programmatically
// trigger a search (currently unused outside this module, but matches
// the runSearch / runBookSearch export shape from videos.js / books.js).
export { runFeedSearch };
