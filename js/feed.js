// ════════════════════════════════════════════════════════════════════════
// Selebox For You / Following feed — extracted from js/app.js as Stage 5
// of the refactor roadmap. This module owns:
//   • loadFeed (entry point — wired to window for inline onclick handlers)
//   • _buildAndExecFeedQuery + _fetchHybridFeedPage (foryou / following / hybrid)
//   • loadMoreFeed (infinite scroll)
//   • renderPost + _renderHybridBookCarousel + _renderHybridVideoCard
//   • Post action menu (open / close / delete / hide / pin / repost / share)
//   • Stories rail loader (loadStories)
//   • New-posts pill + background poller (_pollForNewPosts, _prependFreshPosts,
//     _applyNewPostsBuffer, _renderNewPostsPill, _wireUpNewPosts)
//   • Video lazy-load (attachHlsToPostVideo, triggerPostLazyLoad, flushPostLazyLoad)
//   • Collapsible bodies (setupCollapsibleBodies)
//   • Post detail modal close (_closePostDetailModal)
//
// NOT moved (stays in app.js):
//   • openPostDetail (modal opener — called by feed + composer)
//   • Reaction / comment / bookmark helpers (cross-feature)
//   • Unlock / paywall / monetization (cross-feature)
//   • Composer (lives in js/composer.js since Stage 3)
//   • Profile page feed reuse (profile.js owns its own renderer)
//
// CAREFUL: pure code movement. Inward references rewritten to _cfg.X via
// the Stage 5 jscodeshift codemod (scripts/extract-stage5.js). Module-
// private state (_feedMode / _feedHybridCursor / _newPostsBuffer / etc.)
// is reached from app.js exclusively through the small accessor surface
// at the bottom of this file (after extraction). No circular imports —
// we depend on supabase.js + the config injection.
// ════════════════════════════════════════════════════════════════════════

import { supabase, toast, escHTML, initials, timeAgo, callEdgeFunction, REACTIONS } from './supabase.js';

// ─── Config-injection dependency surface ─────────────────────────────────
// These are app.js-owned helpers that feed code calls into. The codemod
// rewrites bare `helperName(...)` calls inside extracted functions to
// `_cfg.helperName(...)`. Defaults are no-ops so the module loads cleanly
// even before initFeed() has been called from app.js.
let _cfg = {
  // Identity / session
  getCurrentUser:         () => null,
  getCurrentProfile:      () => null,

  // Navigation / page switching
  hideAllMainPages:       () => {},
  setSidebarActive:       () => {},
  openProfile:            () => {},
  openBookDetail:         () => {},
  openChapterReader:      () => {},
  playVideo:              () => {},
  openPostDetail:         () => {},
  closeAllModals:         () => {},

  // Dialogs / prompts
  confirmDialog:          async () => false,
  uploadImage:            async () => null,
  openUnlockDialog:       () => {},
  showStore:              () => {},

  // Unlock / paywall
  isUnlocked:             () => false,
  resolveUnlockCost:      () => 0,

  // Engagement counters
  tickGoal:               () => {},
  tickGoalUnique:         () => {},
  loadReactions:          () => {},
  loadCommentCount:       () => {},
  loadComments:           () => {},

  // Search / read-close
  flushReadClose:         () => {},
  getActiveSearchQuery:   () => '',

  // Formatters
  formatCompact:          (n) => String(n || 0),
  formatDuration:         (s) => `${s}s`,

  // Shared post array — app.js owns the canonical `posts[]` list because
  // composer.js + profile.js also mutate it. We reach in via accessors so
  // there's exactly one source of truth.
  getPosts:               () => [],
  setPosts:               (_arr) => {},

  // Last-seen-at watermark for the new-posts pill. App.js owns the value
  // because the realtime subscription + the composer's optimistic prepend
  // both bump it.
  getFeedLastSeenAt:      () => null,
  setFeedLastSeenAt:      (_ts) => {},
  _bumpFeedLastSeenAt:    (_posts) => {},

  // Role / verified seal badge renderer — top-level helper in app.js,
  // pasted into post-card template literals here. Keep as a function so
  // both modules render identical markup.
  renderRoleSeal:         (_profile) => '',

  // URL/handle linkifier used inside post body templates. Lives in app.js
  // because comments + DMs use the same patched function (Stage 5+ pulls
  // it in via _cfg so the chat module's later monkey-patch still wins).
  linkify:                (s) => s || '',

  // Profile-tab refresh after we pin/unpin a post. Owned by profile.js
  // (re-exported through app.js); we invoke it after a successful pin.
  refreshProfilePostsIfViewing: (_userId) => {},

  // Pagination constant + filter-aware over-fetch helper. Both live in
  // app.js because the realtime channel handler + composer also need the
  // page size, and the over-fetch math peeks at userContentFilters (an
  // app.js-owned object).
  FEED_PAGE_SIZE:               15,
  _feedFetchLimitWithFilters:   (n) => n,

  // Sets up the IntersectionObserver that triggers loadMoreFeed when the
  // sentinel scrolls into view. Lives in app.js so it stays close to the
  // sentinel DOM lookup; we call it after a fresh loadFeed renders.
  setupFeedInfiniteScroll:      () => {},

  // Post-card lazy-load + view-tracking + feed-row processing helpers.
  // All app.js-internal — they touch wider state (allVideosCache, view
  // observer, content-filter logic) that doesn't belong in feed.js.
  setupFeedLazyLoaders:         (_container) => {},
  _ensureViewObserver:          () => null,
  _processFeedRows:             (_args) => [],
  _feedFriendlyError:           (_e) => 'Something went wrong loading posts.',
  _formatDuration:              (s) => `${s || 0}s`,
  _getWebBookPool:              () => Promise.resolve([]),

  // Visibility-aware poller for the new-posts pill. Lives in app.js with
  // the visibilitychange listener.
  _startFeedPolling:            () => {},
  _stopFeedPolling:             () => {},

  // Per-card bulk loaders (reactions + comment counts). Pulled here so a
  // single network roundtrip serves every visible card in the page.
  bulkLoadReactions:            (_ids, _type) => Promise.resolve(),
  bulkLoadCommentCounts:        (_ids) => Promise.resolve(),

  // Post-card render helpers + author safety actions.
  renderLinkPreview:            (_text) => '',
  renderVideoCard:              (_v, _u) => document.createElement('div'),
  openReportModal:              (_postId) => {},
  blockAuthor:                  (_id, _name) => {},
  snoozeAuthor:                 (_id, _name) => {},

  // Videos cache invalidation + reload (called when a feed post wraps a
  // video and we need the videos page to pick up changes).
  invalidateAllVideosCache:     () => {},
  loadVideos:                   () => {},

  // User-level content filters — three Sets owned by app.js
  // (userContentFilters object). shouldHidePost reads all three.
  getUserContentFilters:        () => ({
    hiddenPostIds:  new Set(),
    snoozedUserIds: new Set(),
    blockedUserIds: new Set(),
  }),

  // True when the videos page is currently the visible main pane. Used
  // by deletePost to decide whether to refresh the videos grid after a
  // video-attached post is removed.
  isVideosPageVisible:          () => false,

  // The post we're currently building a repost of — owned by app.js
  // (the repost-modal submit handler reads it). repostPost is the only
  // writer; setter is enough.
  setRepostTargetId:            (_id) => {},
};

export function initFeed(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// Lazy DOM refs — elements exist in index.html, both this module and
// app.js reach for them. Resolved on first access so module load isn't
// dependent on DOMContentLoaded ordering.
let _feedEl = null;
function feedEl() {
  if (!_feedEl) _feedEl = document.getElementById('feed');
  return _feedEl;
}

let _storiesRailEl = null;
function storiesRail() {
  if (!_storiesRailEl) _storiesRailEl = document.getElementById('storiesRail');
  return _storiesRailEl;
}

// ════════════════════════════════════════════════════════════════════════
// Extracted state + functions are appended below by the Stage 5 script.
// ════════════════════════════════════════════════════════════════════════

// ─── Module state ────────────────────────────────────────────────
// Pagination + scroll state (moved here from app.js as part of the
// Stage 5 cleanup — they're touched on every loadFeed/loadMoreFeed call
// and used to live alongside the functions that mutated them).
let _feedOffset = 0;
let _hasMoreFeedPosts = true;
let _isLoadingMoreFeed = false;
let _feedScrollObserver = null;

// Stale-query guard. Every loadFeed/loadMoreFeed call increments this;
// results are only applied if their captured seq still matches. Makes
// rapid tab-flicks and overlapping pagination requests safe.
let _feedSeq = 0;

// Cached follow set per loadFeed run — avoids a second fetch when For You
// needs it for the boost AND Discover needed it for the exclusion. Reset
// each loadFeed. App.js reads this from the realtime subscription handler
// through the exported getter.
let _cachedFollowIds = null;

// Dedup set for the new-posts buffer. Pairs with _newPostsBuffer; live
// INSERTs + repeat poll responses go through it before insertion.
let _newPostsBufferIds = new Set();

// Per-session jitter seed for the hybrid-feed RPC. Reset each loadFeed.
let _feedHybridSessionSeed = null;

// DOM ref for the post action menu (the "⋮" popover). Set by
// openPostActionMenu, cleared by closePostActionMenu.
let _postActionMenuEl = null;

// Feed-local UI state for the "See more / See less" collapsible bodies —
// the per-session set of post IDs the user has expanded. Cleared on page
// reload. Local because no other module reads from it.
const _expandedPosts = new Set();

// Batching slot for the post-card lazy-load IntersectionObserver — when
// 30 cards become visible at once we debounce 80ms then flush a single
// bulk reactions + bulk comment-counts pair. Same set is reused across
// lazy-load triggers.
const _pendingLazyPostIds = new Set();
let _pendingLazyPostTimer = null;

let _feedVideoObserver = null;
let _feedPostObserver = null;
// Feed mode — 'foryou' (default), 'following', or 'discover'
let _feedMode = 'foryou';
// Pending debounce timer for realtime-triggered feed refreshes. Declared up
// here so loadFeed can cancel it (a user-initiated load supersedes any
// pending auto-refresh). The function and Supabase channel that USE this
// timer live further down — by the time a realtime WS event actually fires,
// every dependency is initialized.
let _realtimeRefreshTimer = null;
// Buffer of posts found by the background poller but not yet applied
// to the feed. Tapping the "↑ N new posts" pill flushes this into the
// top of the feed without a fresh DB call. Polled every 60s while the
// tab is foregrounded; pauses when hidden.
let _newPostsBuffer = [];          // hydrated post objects
// ════════════════════════════════════════════════════════════════════════
// Hybrid feed (Sprint 2 #1, 2026-05-15) — calls the fetch_hybrid_feed
// RPC mobile uses. Returns mixed items on a 6:1 cadence so the For You
// feed gets discovery items (book carousels, video cards) injected
// alongside posts. Pagination is cursor-based: the RPC returns a
// next_cursor jsonb that we pass back on the next call.
//
// Result shape (consumed by loadFeed/loadMoreFeed):
//   {
//     items: [
//       { kind: 'post',           data: <hydrated post> },
//       { kind: 'book_carousel',  data: { books: [...] } },
//       { kind: 'video_card',     data: { ... } },
//     ],
//     data: <flat list of just posts — for view tracking + buffer dedup>,
//     fetchLimit: <number>,
//     hasMore: <boolean>,
//   }
//
// _feedHybridCursor is the cursor returned from the previous page;
// loadFeed resets it to {} on every fresh load.
// ════════════════════════════════════════════════════════════════════════
let _feedHybridCursor = {};
// Sprint 2 #2 (2026-05-15): added `display_name` to both profile
// joins so the feed renders by the creator's chosen display name with
// @handle as a secondary fallback. Mirrors mobile's POST_SELECT.
// Renderers should use:  profile.display_name || profile.username || 'Unknown'.
const FEED_SELECT = `*, profiles!user_id(id, username, display_name, avatar_url, is_guest, is_banned, role), videos(id, video_url, thumbnail_url, title, duration), original:reposted_from(*, profiles!user_id(id, username, display_name, avatar_url, is_guest, is_banned, role), videos(id, video_url, thumbnail_url, title, duration))`;

// ─── Extracted functions ─────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════
// Composer moved to js/composer.js (Stage 3, 2026-05-15). The original
// block lived here from line ~2268 to ~2575 and owned: composeText,
// composeImageFile, composeScheduledAt state; the schedule popover
// (date + time inputs, Set/Cancel/clear handlers, outside-click +
// Escape dismissers); composeText input listener; composeImageInput
// change listener; and the entire btnPostSubmit click handler.
//
// The pattern: import { initComposer } from ./composer.js at the top,
// and call initComposer({getCurrentUser, uploadImage, feedSelect,
// onPostCreated, onPostCreateFallback}) from onSignedIn. App.js still
// owns the posts[] array + render fns + last-seen bump + loadFeed
// fallback; those are wired in via the two callbacks.
// ════════════════════════════════════════════════════════════════════════

// ── Stories row (users) ──
async function loadStories() {
  const row = document.getElementById('storiesRow');
  // Skip the network round-trip if the row is hidden (saves 1 query per home-tab visit)
  if (!row || row.style.display === 'none') return;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, is_guest')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !data) { row.innerHTML = ''; return; }

  row.innerHTML = data.map(p => {
    const avatarHTML = p.avatar_url ? `<img src="${p.avatar_url}" alt="${p.username}"/>` : initials(p.username);
    return `
      <div class="story-item" onclick="filterByUser('${p.id}','${escHTML(p.username)}')">
        <div class="story-avatar">${avatarHTML}</div>
        <div class="story-name">${escHTML(p.username)}</div>
      </div>
    `;
  }).join('');
}

// Prepend a list of hydrated posts to the feed (state + DOM). Shared
// between the background-poll buffer apply and the additive refresh
// below. Returns the number of rows actually inserted (after dedup).
function _prependFreshPosts(fresh) {
  if (!fresh?.length) return 0;
  const existing = new Set(_cfg.getPosts().map(p => p?.id).filter(Boolean));
  const toInsert = fresh.filter(p => p?.id && !existing.has(p.id));
  if (!toInsert.length) return 0;
  _cfg.setPosts([...toInsert, ..._cfg.getPosts()]);
  const feedEl = document.getElementById('feed');
  if (feedEl) {
    const frag = document.createDocumentFragment();
    toInsert.forEach((post, i) => {
      const el = renderPost(post);
      el.style.animationDelay = `${(i * 0.04).toFixed(3)}s`;
      frag.appendChild(el);
    });
    feedEl.insertBefore(frag, feedEl.firstChild);
    _wireUpNewPosts(feedEl);
  }
  _cfg._bumpFeedLastSeenAt(toInsert);
  return toInsert.length;
}

// Apply the background-polled buffer to the feed. Used by both the pill
// tap and pull-to-refresh-style gestures — same effect, no DB call.
function _applyNewPostsBuffer() {
  if (!_newPostsBuffer.length) return 0;
  const inserted = _prependFreshPosts(_newPostsBuffer);
  _newPostsBuffer = [];
  _newPostsBufferIds = new Set();
  _renderNewPostsPill();
  if (inserted > 0) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  return inserted;
}

// Render / update / hide the "↑ N new posts" pill. Idempotent — safe to
// call after every buffer change. The pill is created lazily once and
// then just toggled visible.
function _renderNewPostsPill() {
  let pill = document.getElementById('feedNewPill');
  if (!_newPostsBuffer.length) {
    if (pill) pill.classList.remove('is-visible');
    return;
  }
  if (!pill) {
    pill = document.createElement('button');
    pill.id = 'feedNewPill';
    pill.className = 'feed-new-pill';
    pill.type = 'button';
    pill.onclick = () => _applyNewPostsBuffer();
    document.body.appendChild(pill);
  }
  const n = _newPostsBuffer.length;
  pill.textContent = n === 1 ? '↑ 1 new post' : `↑ ${n} new posts`;
  pill.classList.add('is-visible');
}

// Background poller — every 60s while the tab is visible, calls
// feed_new_since to discover posts created after _feedLastSeenAt.
// New posts are stashed in _newPostsBuffer; the pill renders/updates
// based on the buffer size. NO mutation of the live feed until the
// user taps the pill (or pull-to-refresh applies the buffer).
async function _pollForNewPosts() {
  if (document.hidden) return;
  if (!_cfg.getCurrentUser()?.id) return;
  if (_feedMode !== 'foryou' || !_cfg.getFeedLastSeenAt()) return;
  try {
    const { data, error } = await supabase.rpc('feed_new_since', {
      p_user_id: _cfg.getCurrentUser().id,
      p_since: _cfg.getFeedLastSeenAt(),
      p_limit: 30,
    });
    if (error) throw error;
    const ids = (data || []).map(r => r.id).filter(Boolean);
    if (!ids.length) return;
    // Skip ids already in the buffer or in the live feed.
    const liveIds = new Set(_cfg.getPosts().map(p => p?.id).filter(Boolean));
    const newIds = ids.filter(id => !_newPostsBufferIds.has(id) && !liveIds.has(id));
    if (!newIds.length) return;
    // Hydrate the new ones through FEED_SELECT.
    const { data: hydrated, error: hydErr } = await supabase
      .from('posts').select(FEED_SELECT).in('id', newIds);
    if (hydErr) throw hydErr;
    const byId = new Map((hydrated || []).map(p => [p.id, p]));
    const ordered = newIds.map(id => byId.get(id)).filter(Boolean);
    const filtered = ordered.filter(p => !shouldHidePost(p));
    if (!filtered.length) return;
    // Buffer (newest first to match feed ordering).
    _newPostsBuffer = [...filtered, ..._newPostsBuffer];
    for (const p of filtered) _newPostsBufferIds.add(p.id);
    _renderNewPostsPill();
  } catch (err) {
    // Polling errors are non-fatal — the next tick will retry.
    console.warn('[feed] poll error:', err?.message);
  }
}

async function _buildAndExecFeedQuery({ offset }) {
  if (!_cfg.getCurrentUser()?.id) return { data: [], scoreClientSide: false, followIds: null };

  // For You + Discover now go through the same Postgres RPCs mobile
  // uses (feed_for_you / feed_discover). The server-side algorithm:
  //   • Reads the viewer's interest profile (likes, comments, follows)
  //   • Excludes posts in the viewer's post_views (last 24h) — the
  //     "always fresh" feed UX shipped May 2
  //   • Returns rows in score order
  // Client-side scoring is preserved as a fallback path in case the
  // RPC is missing (early dev DBs without migration_feed_v2_rpcs.sql)
  // — set RPC_FAIL = true at the bottom of the catch to verify.
  // Cached follow set still drives the Following tab filter.
  if (_cachedFollowIds === null) {
    const { data: f } = await supabase.from('follows')
      .select('following_id').eq('follower_id', _cfg.getCurrentUser().id);
    _cachedFollowIds = (f || []).map(r => r.following_id);
  }
  const followIds = _cachedFollowIds;

  if (_feedMode === 'following') {
    if (!followIds.length) return { data: [], scoreClientSide: false, followIds, emptyReason: 'no-follows' };
    const fetchLimit = _cfg._feedFetchLimitWithFilters(_cfg.FEED_PAGE_SIZE);
    let q = supabase.from('posts').select(FEED_SELECT).eq('is_hidden', false);
    q = q.in('user_id', followIds).order('created_at', { ascending: false });
    const { data, error } = await q.range(offset, offset + fetchLimit - 1);
    if (error) throw error;
    return { data: data || [], scoreClientSide: false, followIds, fetchLimit };
  }

  // For You — Sprint 2 #1 (2026-05-15): switched to fetch_hybrid_feed,
  // the same RPC mobile uses. Returns mixed items (post / book_carousel
  // / video_card) on a 6:1 cadence so the feed gets discovery items
  // injected like mobile. Falls through to legacy feed_for_you on RPC
  // error so a server hiccup doesn't black-screen the home tab.
  if (_feedMode === 'foryou') {
    try {
      const result = await _fetchHybridFeedPage({ offset });
      return { ...result, followIds, scoreClientSide: false, isHybrid: true };
    } catch (err) {
      console.warn('[feed] hybrid feed RPC failed, falling back to legacy:', err?.message);
      // intentional fall-through to the legacy path below
    }
  }

  // discover (and foryou — legacy path): RPC path
  const rpcName = _feedMode === 'discover' ? 'feed_discover' : 'feed_for_you';
  try {
    const fetchLimit = _cfg._feedFetchLimitWithFilters(_cfg.FEED_PAGE_SIZE);
    const { data: ranked, error: rpcErr } = await supabase.rpc(rpcName, {
      p_user_id: _cfg.getCurrentUser().id,
      p_limit: fetchLimit,
      p_offset: offset,
    });
    if (rpcErr) throw rpcErr;
    const orderedIds = (ranked || []).map(r => r.id).filter(Boolean);
    if (!orderedIds.length) return { data: [], scoreClientSide: false, followIds, fetchLimit };
    // Hydrate through FEED_SELECT to get profiles/videos/original join.
    const { data: hydrated, error: hydErr } = await supabase
      .from('posts')
      .select(FEED_SELECT)
      .in('id', orderedIds);
    if (hydErr) throw hydErr;
    // Re-establish RPC ordering — IN-clause query returns arbitrary order.
    const byId = new Map((hydrated || []).map(p => [p.id, p]));
    const ordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
    return { data: ordered, scoreClientSide: false, followIds, fetchLimit };
  } catch (err) {
    // Fallback path — only kicks in if the RPC itself is missing/broken.
    // Logs once and switches the tab to client-side scoring (same code
    // we used before the migration). Future cleanup: drop the fallback
    // once we trust the RPCs in production.
    console.warn('[feed] RPC failed, falling back to client-side scoring:', err?.message);
    let q = supabase.from('posts').select(FEED_SELECT).eq('is_hidden', false);
    if (_feedMode === 'discover') {
      const exclude = [...followIds, _cfg.getCurrentUser().id];
      if (exclude.length) {
        q = q.not('user_id', 'in', `(${exclude.map(id => `"${id}"`).join(',')})`);
      }
    }
    q = q.gt('created_at', new Date(Date.now() - 14 * 86400_000).toISOString())
         .order('created_at', { ascending: false });
    const fetchLimit = _cfg.FEED_PAGE_SIZE * 3;
    const { data, error } = await q.range(offset, offset + fetchLimit - 1);
    if (error) throw error;
    return { data: data || [], scoreClientSide: true, followIds, fetchLimit };
  }
}

async function _fetchHybridFeedPage({ offset }) {
  // offset === 0 means "fresh load" — reset cursor + roll a new
  // session seed so the bucket ordering shuffles between sessions.
  if (offset === 0) {
    _feedHybridCursor = {};
    _feedHybridSessionSeed = String(Math.floor(Math.random() * 0xffffffff));
  }
  const limit = _cfg.FEED_PAGE_SIZE;
  const { data, error } = await supabase.rpc('fetch_hybrid_feed', {
    p_user_id:      _cfg.getCurrentUser().id,
    p_cursor:       _feedHybridCursor || {},
    p_limit:        limit,
    p_session_seed: _feedHybridSessionSeed,
  });
  if (error) throw error;

  const rawItems = Array.isArray(data?.items) ? data.items : [];
  _feedHybridCursor = data?.next_cursor || {};

  // Hydrate posts (FEED_SELECT joins) in one batch. Carousel + video
  // card items pass through as-is (their data payloads are server-built).
  const postIds = rawItems.filter(it => it?.type === 'post' && it.post_id).map(it => it.post_id);
  let postById = new Map();
  if (postIds.length) {
    const { data: hydrated, error: hydErr } = await supabase
      .from('posts').select(FEED_SELECT).in('id', postIds);
    if (hydErr) throw hydErr;
    postById = new Map((hydrated || []).map(p => [p.id, p]));
  }

  // Walk in server order. Drop posts that fail RLS / hide-list / hydration;
  // pass injected items through unchanged.
  const items = [];
  const flatPosts = [];
  for (const it of rawItems) {
    if (it?.type === 'post' && it.post_id) {
      const p = postById.get(it.post_id);
      if (!p) continue;
      if (shouldHidePost(p)) continue;
      items.push({ kind: 'post', data: p });
      flatPosts.push(p);
    } else if (it?.type === 'book_carousel') {
      items.push({ kind: 'book_carousel', data: it.data || it });
    } else if (it?.type === 'video_card') {
      items.push({ kind: 'video_card', data: it.data || it });
    }
  }

  // hasMore — server returns next_cursor with `done: true` when exhausted,
  // OR the items array length is below the requested limit.
  const hasMore = !data?.next_cursor?.done && items.length > 0;

  return {
    items,
    data: flatPosts,           // legacy `data` slot used by view tracking + bumpLastSeenAt
    fetchLimit: limit,
    hasMore,
  };
}

// Fold the post-render setup into one helper. Two callers (initial load and
// load-more) used to call these as separate steps — easy to forget one.
function _wireUpNewPosts(container) {
  _cfg.setupFeedLazyLoaders(container);
  setupCollapsibleBodies(container);
  // Register every freshly-rendered post-card with the view tracker so
  // when the user scrolls past it (≥50% visible for ≥800ms), the id
  // gets queued for the debounced track_post_views RPC flush.
  const observer = _cfg._ensureViewObserver();
  if (observer) {
    container.querySelectorAll('.post-card[data-postid]').forEach(el => observer.observe(el));
  }
}

function setupCollapsibleBodies(root) {
  if (!root) return;
  const bodies = root.querySelectorAll('.collapsible-body:not([data-collapse-checked])');
  bodies.forEach(el => {
    el.dataset.collapseChecked = '1';
    const id = el.dataset.postId;

    // Measure overflow against a cap computed from the element's own line-height,
    // so the threshold automatically adapts if .post-body styling changes later.
    //
    // CRITICAL: idempotent guard at the top. Because we run this in BOTH a
    // requestAnimationFrame AND a document.fonts.ready callback (cached fonts
    // make the latter resolve before rAF), without this guard we'd attach two
    // toggles + two click handlers — and clicks would cancel each other out
    // (toggle state flips twice on the same click), so the post looked frozen.
    const measureAndDecide = () => {
      if (el.dataset.collapseDone === '1') return; // already configured — no-op
      if (el.querySelector('.collapsible-toggle')) {
        el.dataset.collapseDone = '1';
        return;
      }

      const cs = getComputedStyle(el);
      const lineHeight = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.5);
      const cap = lineHeight * 6; // matches the 6-ish lines visible at max-height: 9.9em
      const naturalHeight = el.scrollHeight;
      const overflows = naturalHeight > cap + 4; // small fudge for sub-pixel layout

      if (!overflows) {
        // Short post → no toggle ever needed; mark done so a later font-load
        // pass doesn't second-guess this decision.
        el.dataset.collapseDone = '1';
        return;
      }

      // Default to collapsed; restore previously-expanded state for this session
      if (id && _expandedPosts.has(id)) {
        el.classList.add('is-expanded');
      } else {
        el.classList.add('is-collapsed');
      }

      // Append the See more / See less label inside the body itself
      const more = document.createElement('span');
      more.className = 'collapsible-toggle';
      more.textContent = el.classList.contains('is-expanded') ? 'See less' : 'See more';
      el.appendChild(more);
      el.dataset.collapseDone = '1';

      // Tap anywhere on the body toggles — but ignore real links/buttons/images.
      // stopImmediatePropagation (vs stopPropagation) is belt-and-braces: even
      // if a stray duplicate listener somehow gets attached, only one fires.
      el.addEventListener('click', (e) => {
        const t = e.target;
        if (t.tagName === 'A'      || t.closest('a'))      return;
        if (t.tagName === 'BUTTON' || t.closest('button')) return;
        if (t.tagName === 'IMG'    || t.closest('img'))    return;
        e.stopPropagation();
        e.stopImmediatePropagation();
        const expanded = !el.classList.contains('is-expanded');
        el.classList.toggle('is-expanded', expanded);
        el.classList.toggle('is-collapsed', !expanded);
        more.textContent = expanded ? 'See less' : 'See more';
        if (id) {
          if (expanded) _expandedPosts.add(id);
          else          _expandedPosts.delete(id);
        }
      });
    };

    // Two-stage measure: once now (rAF after layout), once after fonts load.
    // Both paths are safe to call repeatedly thanks to the idempotent guard above.
    requestAnimationFrame(measureAndDecide);
    if (document.fonts && typeof document.fonts.ready?.then === 'function') {
      document.fonts.ready.then(measureAndDecide);
    }
  });
}

async function loadMoreFeed() {
  if (_isLoadingMoreFeed || !_hasMoreFeedPosts) return;
  // Guard: only run when the feed is the current page. Without this, an
  // IntersectionObserver fire during navigation (or any leftover scroll
  // observer between page changes) re-shows the sentinel and re-fetches
  // posts even when the user is on /profile, /videos, /books, etc. The
  // visible symptom is a "Loading more posts…" pill stuck on top of an
  // unrelated page.
  // `feedEl` is a lazy-resolver function in this module — call it to get
  // the actual DOM node before reading style/offsetParent.
  const feedNode = feedEl();
  const feedIsVisible = feedNode && feedNode.style.display !== 'none' && feedNode.offsetParent !== null;
  if (!feedIsVisible) return;
  _isLoadingMoreFeed = true;

  // Capture the seq at the START. If a tab switch (or fresh loadFeed) bumps
  // the seq while we're awaiting, the response is stale and we discard it
  // instead of appending posts from the wrong mode to the new feed.
  const seq = _feedSeq;

  const sentinel = document.getElementById('feedSentinel');
  if (sentinel) {
    sentinel.style.display = 'block';
    sentinel.innerHTML = '<div class="book-grid-loadmore">Loading more posts…</div>';
  }

  try {
    // Reuse the same query-builder loadFeed uses. Pagination now respects the
    // active mode — Following stays Following, For You keeps its scoring, etc.
    const queryResult = await _buildAndExecFeedQuery({ offset: _feedOffset });

    if (seq !== _feedSeq) return; // user switched tabs while we were waiting

    if (queryResult.isHybrid) {
      // Hybrid feed pagination — server returns mixed items; walk in
      // order and dispatch to the right renderer. Pagination key is
      // _feedHybridCursor (mutated inside _fetchHybridFeedPage), not
      // _feedOffset, so don't bump _feedOffset here.
      _hasMoreFeedPosts = !!queryResult.hasMore;
      const feed = document.getElementById('feed');
      const presentIds = new Set(Array.from(feed.querySelectorAll('.post-card')).map(c => c.dataset.postid));
      const freshPosts = [];
      let postIdx = 0;
      (queryResult.items || []).forEach((it) => {
        let el = null;
        if (it.kind === 'post') {
          if (presentIds.has(it.data?.id)) return;     // dedup against already-rendered posts
          el = renderPost(it.data);
          if (el) {
            el.style.animationDelay = `${(postIdx * 0.03).toFixed(3)}s`;
            postIdx += 1;
            freshPosts.push(it.data);
            if (_feedPostObserver) _feedPostObserver.observe(el);
            el.querySelectorAll('.post-video').forEach(v => _feedVideoObserver?.observe(v));
          }
        } else if (it.kind === 'book_carousel') {
          el = _renderHybridBookCarousel(it.data);
        } else if (it.kind === 'video_card') {
          el = _renderHybridVideoCard(it.data);
        }
        if (el) feed.appendChild(el);
      });
      if (freshPosts.length) {
        setupCollapsibleBodies(feed);
        _cfg.setPosts(_cfg.getPosts().concat(freshPosts));
      }
    } else {
      const rawMore = queryResult.data;
      const more = _cfg._processFeedRows(queryResult);
      const advance = rawMore.length;
      if (advance < (queryResult.fetchLimit || _cfg.FEED_PAGE_SIZE)) _hasMoreFeedPosts = false;
      _feedOffset += advance;

      if (more.length) {
        const feed = document.getElementById('feed');
        const presentIds = new Set(Array.from(feed.querySelectorAll('.post-card')).map(c => c.dataset.postid));
        const fresh = more.filter(p => !presentIds.has(p.id));
        fresh.forEach((post, i) => {
          const el = renderPost(post);
          el.style.animationDelay = `${(i * 0.03).toFixed(3)}s`;
          feed.appendChild(el);
          // Hand off to the existing observers so the new cards lazy-load too
          if (_feedPostObserver) _feedPostObserver.observe(el);
          el.querySelectorAll('.post-video').forEach(v => _feedVideoObserver?.observe(v));
        });
        setupCollapsibleBodies(feed);
        _cfg.setPosts(_cfg.getPosts().concat(fresh));
      }
    }

    if (sentinel) {
      if (_hasMoreFeedPosts) {
        sentinel.innerHTML = '<div class="book-grid-loadmore">Loading more posts…</div>';
      } else {
        sentinel.innerHTML = `<div class="book-grid-end-msg">You're all caught up · ${_cfg.getPosts().length.toLocaleString()} posts</div>`;
        if (_feedScrollObserver) { _feedScrollObserver.disconnect(); _feedScrollObserver = null; }
      }
    }
  } catch (err) {
    if (seq !== _feedSeq) return;
    console.error('Failed to load more feed:', err);
    if (sentinel) sentinel.innerHTML = '<div class="book-grid-end-msg">Couldn\'t load more — try refreshing</div>';
  } finally {
    _isLoadingMoreFeed = false;
  }
}

function attachHlsToPostVideo(wrap) {
  const url = wrap.dataset.videoUrl;
  const video = wrap.querySelector('.post-video-player');
  if (!url || !video || video.dataset.attached) return;
  video.dataset.attached = '1';
  const HlsCtor = window.Hls;
  if (url.endsWith('.m3u8') && HlsCtor && HlsCtor.isSupported() && !video.canPlayType('application/vnd.apple.mpegurl')) {
    const hls = new HlsCtor();
    hls.loadSource(url);
    hls.attachMedia(video);
  } else {
    video.src = url;
  }
}

function triggerPostLazyLoad(card) {
  if (card.dataset.lazyLoaded === '1') return;
  card.dataset.lazyLoaded = '1';
  const id = card.dataset.postid;
  if (!id) return;
  _pendingLazyPostIds.add(id);
  if (_pendingLazyPostTimer) clearTimeout(_pendingLazyPostTimer);
  _pendingLazyPostTimer = setTimeout(flushPostLazyLoad, 80);
}

async function flushPostLazyLoad() {
  const ids = [..._pendingLazyPostIds];
  _pendingLazyPostIds.clear();
  _pendingLazyPostTimer = null;
  if (!ids.length) return;
  // Both fetches can run in parallel.
  await Promise.all([
    _cfg.bulkLoadReactions(ids, 'post'),
    _cfg.bulkLoadCommentCounts(ids),
  ]);
}

// `idScope` is an optional namespace prepended to every DOM id this
// function stamps (rsummary, ccount, sharemenu, comments). When the same
// post is rendered in two places at once (e.g. the home featured-post
// column + the Discover feed), unscoped IDs collide and
// document.getElementById picks the first match — usually the wrong copy.
// Callers like the home featured-post block pass idScope='home' so its
// IDs become e.g. 'home-comments-XYZ' and feed lookups land on the feed
// copy unambiguously. Empty string keeps the legacy unscoped IDs for
// every other call site, so no behavior change for the Discover feed.
function renderPost(post, idScope = '') {
  const _ns = (id) => idScope ? `${idScope}-${id}` : id;
  const div = document.createElement('div');
  div.className = 'post-card' + (post.pinned_at ? ' is-pinned' : '');
  div.dataset.postid  = post.id;
  div.dataset.authorId = post.user_id || '';
  if (idScope) div.dataset.idScope = idScope;
  if (post.pinned_at) div.dataset.pinned = '1';

  const profile = post.profiles || {};
  // Display name (Sprint 2 #2). Show the creator's chosen display
  // name if they set one; otherwise fall back to @username; otherwise
  // 'Unknown' for orphaned posts whose author row went missing.
  const name = profile.display_name || profile.username || 'Unknown';
  const isGuest = profile.is_guest;
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}" alt="${name}"/>` : initials(name);
  const isOwn = _cfg.getCurrentUser() && _cfg.getCurrentUser().id === post.user_id;

  div.innerHTML = `
    ${post.pinned_at ? `
      <div class="post-pinned-tag" title="Pinned to profile">
        <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M16 2l-1.4 1.4 1.6 1.6-5.4 5.4-3-1.5L6 11.3l3.7 3.7L4 21l1.4 1.4 5.7-5.7 3.7 3.7 1.4-1.4-1.5-3 5.4-5.4 1.6 1.6L23 9l-7-7z"/></svg>
        Pinned
      </div>
    ` : ''}
    <div class="post-header">
      <div class="avatar profile-link" data-user-id="${post.user_id}" title="View profile">${avatarHTML}</div>
      <div style="flex:1">
        <div style="display:flex;align-items:center">
          <span class="post-author profile-link" data-user-id="${post.user_id}" title="View profile">${escHTML(name)}${_cfg.renderRoleSeal(post.profiles)}</span>
          ${isGuest ? '<span class="post-guest">Guest</span>' : ''}
        </div>
        <div class="post-time">${timeAgo(post.created_at)}</div>
      </div>
      ${_cfg.getCurrentUser() ? `
        <button class="post-menu-btn"
                onclick="openPostActionMenu(event, this)"
                data-post-id="${post.id}"
                data-is-own="${isOwn ? 'true' : 'false'}"
                data-is-pinned="${post.pinned_at ? 'true' : 'false'}"
                data-author-id="${post.user_id}"
                data-author-name="${escHTML(name)}"
                title="${isOwn ? 'Manage post' : 'Post options'}"
                aria-label="Post options">
          <span class="post-menu-glyph">⋮</span>
        </button>
      ` : ''}
    </div>

    ${post.reposted_from && post.original ? `
      <div class="reposted-banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        Reposted
      </div>
    ` : ''}

    ${post.body ? `<div class="post-body collapsible-body" data-post-id="${post.id}">${_cfg.linkify(post.body)}</div>` : ''}
    ${post.body ? _cfg.renderLinkPreview(post.body) : ''}
    ${post.image_url ? `<div class="post-image" onclick="openLightbox('${post.image_url}')"><img src="${post.image_url}" alt="post image" loading="lazy"/></div>` : ''}
    ${post.videos ? `
      <div class="post-video" data-video-url="${escHTML(post.videos.video_url || '')}" data-video-id="${escHTML(post.videos.id || '')}">
        <video class="post-video-player" poster="${escHTML(post.videos.thumbnail_url || '')}" muted playsinline preload="none" controls></video>
      </div>
    ` : ''}

    ${post.reposted_from && post.original ? `
      <div class="reposted-card">
        <div class="post-header">
          <div class="avatar profile-link" data-user-id="${post.original.user_id || ''}" title="View profile">${post.original.profiles?.avatar_url ? `<img src="${post.original.profiles.avatar_url}"/>` : initials(post.original.profiles?.username || 'U')}</div>
          <div>
            <span class="post-author profile-link" data-user-id="${post.original.user_id || ''}" title="View profile">${escHTML(post.original.profiles?.username || 'Unknown')}${_cfg.renderRoleSeal(post.original.profiles)}</span>
            <div class="post-time">${timeAgo(post.original.created_at)}</div>
          </div>
        </div>
        ${post.original.body ? `<div class="post-body collapsible-body" data-post-id="${post.original.id}">${_cfg.linkify(post.original.body)}</div>` : ''}
        ${post.original.body ? _cfg.renderLinkPreview(post.original.body) : ''}
        ${post.original.image_url ? `<div class="post-image" onclick="event.stopPropagation();openLightbox('${post.original.image_url}')"><img src="${post.original.image_url}" loading="lazy"/></div>` : ''}
        ${post.original.videos ? `
          <div class="post-video" data-video-url="${escHTML(post.original.videos.video_url || '')}" data-video-id="${escHTML(post.original.videos.id || '')}">
            <video class="post-video-player" poster="${escHTML(post.original.videos.thumbnail_url || '')}" muted playsinline preload="none" controls></video>
          </div>
        ` : ''}
       </div>
      ` : ''}

    <div class="post-stats">
      <div class="rcount" id="${_ns(`rsummary-${post.id}`)}" data-target="${post.id}" data-type="post"></div>
      <div class="ccount" id="${_ns(`ccount-${post.id}`)}" data-postid="${post.id}"></div>
    </div>

    <div class="post-actions">
      <div class="reaction-wrap" data-target="${post.id}" data-type="post">
        <button class="action-btn reaction-trigger" data-target="${post.id}" data-type="post">
          <span class="r-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </span>
          <span class="r-label-text">Like</span>
        </button>
        <div class="reaction-picker">
          ${REACTIONS.map(r => `
            <button class="reaction-option" data-key="${r.key}" data-target="${post.id}" data-type="post" title="${r.label}">
              <span class="r-emoji">${r.emoji}</span>
              <span class="r-label">${r.label}</span>
            </button>
          `).join('')}
        </div>
      </div>

      <button class="action-btn comment-toggle" data-postid="${post.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>Comments</span>
      </button>

      <button class="action-btn" onclick="repostPost('${post.id}')" title="Repost">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        <span>Repost</span>
      </button>

      <div class="reaction-wrap" style="position:relative">
        <button class="action-btn" onclick="toggleShareMenu(event, '${post.id}')" title="Share">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          <span>Share</span>
        </button>
        <div class="share-menu" id="${_ns(`sharemenu-${post.id}`)}">
          <button class="share-option" onclick="shareTo('facebook','${post.id}')">📘 Facebook</button>
          <button class="share-option" onclick="shareTo('twitter','${post.id}')">🐦 Twitter / X</button>
          <button class="share-option" onclick="shareTo('whatsapp','${post.id}')">💬 WhatsApp</button>
          <button class="share-option" onclick="shareTo('copy','${post.id}')">🔗 Copy link</button>
        </div>
      </div>
    </div>

    <div class="comments-section" id="${_ns(`comments-${post.id}`)}" style="display:none"></div>
  `;
  // Reactions and comment count are now loaded lazily by setupFeedLazyLoaders
  // when the post-card scrolls into view (saves ~2 queries per off-screen post)
  return div;
}

// ── Render helpers for injected hybrid-feed items ─────────────────────
//
// Book carousel — premium desktop card carousel with prev/next arrows.
// Server returns data.books as an array of { id, title, cover_url,
// author_display_name, ... }. Tap a cover → open book detail. Mobile
// has its own touch-scroll version (BookCarousel.jsx); this is the
// web-only desktop pattern (arrow paginated, no horizontal scrollbar).
//
// Prefixed with `_renderHybrid` to avoid colliding with any existing
// renderBookCarousel/renderVideoCard in the codebase (the video one
// already collided once and black-screened the site).
function _renderHybridBookCarousel(payload) {
  const books = Array.isArray(payload?.books) ? payload.books : [];
  if (!books.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'feed-hybrid-carousel feed-hybrid-book-carousel';
  // Inline CSS is here intentionally so this carousel ships as a
  // self-contained unit — we don't have to touch css/styles.css to
  // get the look right. The :hover effects are wired via a one-time
  // injected <style> below (idempotent — `data-hbc-style` guard).
  wrap.style.cssText = [
    'margin:12px 0',
    'padding:18px 0 18px',
    'background:linear-gradient(135deg, rgba(121,117,212,0.06) 0%, rgba(121,117,212,0.02) 100%)',
    'border-radius:16px',
    'border:1px solid rgba(121,117,212,0.20)',
    'position:relative',
    'overflow:hidden',
  ].join(';');

  const headerHtml = `
    <div class="hbc-header" style="display:flex;align-items:center;justify-content:space-between;padding:0 20px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:16px">📚</span>
        <span style="font-size:13px;font-weight:700;color:var(--accent,#7975D4);text-transform:uppercase;letter-spacing:0.08em">Books worth reading</span>
      </div>
      <div style="display:flex;gap:8px">
        <button type="button" class="hbc-arrow hbc-prev" aria-label="Previous">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <button type="button" class="hbc-arrow hbc-next" aria-label="Next">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
    </div>`;

  // Each tile is a fixed 144px wide so we can math the page size off
  // the viewport width below. Cover is 2:3 aspect. Title clamped to a
  // single line + ellipsis (Charles's preference for desktop — keeps
  // every row in the carousel the exact same height). Author single
  // line. Rating row shows ★ + numeric only when a rating field is
  // present + non-zero. Hover lifts the tile with a shadow.
  const tilesHtml = books.map(b => {
    const cover  = b.cover_url || b.thumbnail_url || '';
    const title  = escHTML(b.title || 'Untitled');
    const author = escHTML(b.author_display_name || b.author_name || b.author_username || '');
    // Rating — server may put it on any of these fields depending on
    // which fetch path emitted the card. Fall through gracefully.
    const ratingRaw = Number(b.rating ?? b.average_rating ?? b.avg_rating ?? 0);
    const hasRating = ratingRaw > 0;
    const ratingStr = hasRating ? ratingRaw.toFixed(1) : '';
    const ratingCount = Number(b.rating_count ?? b.ratings_count ?? 0);
    return `
      <div class="hbc-tile" data-book-id="${escHTML(b.id || '')}">
        <div class="hbc-cover">
          ${cover ? `<img src="${escHTML(cover)}" alt="" loading="lazy"/>` : ''}
          <div class="hbc-cover-overlay"></div>
        </div>
        <div class="hbc-title" title="${title}">${title}</div>
        ${author ? `<div class="hbc-author">${author}</div>` : ''}
        ${hasRating
          ? `<div class="hbc-rating">
               <svg viewBox="0 0 24 24" width="11" height="11" style="fill:#f5b50a"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/></svg>
               <span class="hbc-rating-val">${ratingStr}</span>
               ${ratingCount > 0 ? `<span class="hbc-rating-count">(${ratingCount.toLocaleString()})</span>` : ''}
             </div>`
          : ''}
      </div>`;
  }).join('');

  wrap.innerHTML = `
    ${headerHtml}
    <div class="hbc-viewport" style="overflow:hidden;padding:4px 20px">
      <div class="hbc-track" style="display:flex;gap:16px;transition:transform 0.32s cubic-bezier(0.22, 0.61, 0.36, 1);will-change:transform">
        ${tilesHtml}
      </div>
    </div>`;

  // Inject the supporting styles once. Idempotent guard: a data attr
  // on <head> means subsequent carousels skip the duplicate <style>
  // injection. Doing it this way avoids touching css/styles.css.
  if (!document.documentElement.dataset.hbcStyle) {
    const s = document.createElement('style');
    s.textContent = `
      /* Glass-style navigation arrows — frosted background with
         backdrop blur. Picks up whatever colour is behind them so the
         arrows are visible against light AND dark page backgrounds.
         The icon uses the accent purple so it's never washed out. */
      .feed-hybrid-book-carousel .hbc-arrow {
        width: 38px; height: 38px;
        border-radius: 50%;
        border: 1px solid rgba(121, 117, 212, 0.35);
        background: rgba(255, 255, 255, 0.55);
        -webkit-backdrop-filter: blur(14px) saturate(180%);
        backdrop-filter: blur(14px) saturate(180%);
        color: var(--accent, #7975D4);
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: all 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
        box-shadow: 0 2px 10px rgba(121, 117, 212, 0.12),
                    inset 0 0 0 1px rgba(255, 255, 255, 0.5);
      }
      body[data-theme="dark"] .feed-hybrid-book-carousel .hbc-arrow {
        background: rgba(30, 30, 45, 0.55);
        border-color: rgba(121, 117, 212, 0.45);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3),
                    inset 0 0 0 1px rgba(255, 255, 255, 0.08);
      }
      .feed-hybrid-book-carousel .hbc-arrow:hover:not([disabled]) {
        background: var(--accent, #7975D4);
        border-color: var(--accent, #7975D4);
        color: #fff;
        transform: translateY(-1px) scale(1.04);
        box-shadow: 0 6px 18px rgba(121, 117, 212, 0.40);
      }
      .feed-hybrid-book-carousel .hbc-arrow:active:not([disabled]) {
        transform: translateY(0) scale(0.98);
      }
      .feed-hybrid-book-carousel .hbc-arrow[disabled] {
        opacity: 0.35; cursor: not-allowed;
        transform: none !important;
        box-shadow: none !important;
      }

      /* Tile — 144px wide, hover lifts it up with a deeper shadow */
      .feed-hybrid-book-carousel .hbc-tile {
        flex: 0 0 144px;
        cursor: pointer;
        transition: transform 0.22s ease;
      }
      .feed-hybrid-book-carousel .hbc-tile:hover {
        transform: translateY(-3px);
      }
      .feed-hybrid-book-carousel .hbc-tile:hover .hbc-cover {
        box-shadow: 0 10px 28px rgba(121, 117, 212, 0.28),
                    0 2px 6px rgba(0, 0, 0, 0.18);
      }
      .feed-hybrid-book-carousel .hbc-cover {
        aspect-ratio: 2/3;
        border-radius: 10px;
        overflow: hidden;
        background: var(--surface-2, #222);
        position: relative;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        transition: box-shadow 0.22s ease;
      }
      .feed-hybrid-book-carousel .hbc-cover img {
        width: 100%; height: 100%; object-fit: cover; display: block;
      }
      .feed-hybrid-book-carousel .hbc-cover-overlay {
        position: absolute; inset: 0;
        background: linear-gradient(180deg, transparent 60%, rgba(0, 0, 0, 0.35) 100%);
        pointer-events: none;
      }

      /* Text rows — single-line title + author + rating */
      .feed-hybrid-book-carousel .hbc-title {
        font-size: 13px;
        font-weight: 600;
        line-height: 1.35;
        color: var(--text, #fff);
        margin-top: 10px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .feed-hybrid-book-carousel .hbc-author {
        font-size: 11.5px;
        color: var(--text2, #aaa);
        margin-top: 3px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .feed-hybrid-book-carousel .hbc-rating {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-top: 5px;
        font-size: 11px;
        color: var(--text, #fff);
      }
      .feed-hybrid-book-carousel .hbc-rating-val {
        font-weight: 600;
      }
      .feed-hybrid-book-carousel .hbc-rating-count {
        color: var(--text2, #aaa);
        font-weight: 400;
      }
    `;
    document.head.appendChild(s);
    document.documentElement.dataset.hbcStyle = '1';
  }

  // Pagination — translate the track by N tiles per click. Tile width
  // (144px) + gap (16px) = 160px per slot. Page size = floor(viewport
  // width / 160), measured after the carousel mounts so the count
  // adapts to the actual rendered width (sidebar collapsed vs not).
  const track = wrap.querySelector('.hbc-track');
  const viewport = wrap.querySelector('.hbc-viewport');
  const prevBtn = wrap.querySelector('.hbc-prev');
  const nextBtn = wrap.querySelector('.hbc-next');
  const SLOT = 160;             // 144px tile + 16px gap
  let offset = 0;

  function _updateArrows() {
    const maxOffset = Math.max(0, books.length * SLOT - viewport.clientWidth);
    prevBtn.disabled = offset <= 0;
    nextBtn.disabled = offset >= maxOffset - 1;
  }
  function _stepBy(direction) {
    const pageSize = Math.max(1, Math.floor((viewport.clientWidth - 40) / SLOT));
    const maxOffset = Math.max(0, books.length * SLOT - viewport.clientWidth);
    offset = Math.max(0, Math.min(maxOffset, offset + direction * pageSize * SLOT));
    track.style.transform = `translateX(-${offset}px)`;
    _updateArrows();
  }
  prevBtn.addEventListener('click', () => _stepBy(-1));
  nextBtn.addEventListener('click', () => _stepBy(1));

  // Initial arrow state — needs viewport.clientWidth, which is 0 until
  // the element is attached to the DOM. Defer the first update to next
  // tick (microtask) when loadFeed has appended the wrap into #feed.
  Promise.resolve().then(_updateArrows);

  // Tile click → openBookDetail (delegated so it survives re-renders).
  track.addEventListener('click', (e) => {
    const tile = e.target.closest('.hbc-tile[data-book-id]');
    if (tile) _cfg.openBookDetail(tile.dataset.bookId);
  });

  // Pad up to 30 books from the session-cached trending pool. The
  // initial 5 books (with role labels) render immediately; the rest
  // arrive after the pool fetch resolves and get appended to the track.
  // Re-runs _updateArrows so prev/next correctly reflect the new
  // length. Deduped by id against the books already rendered.
  const TARGET_COUNT = 30;
  if (books.length < TARGET_COUNT) {
    const existingIds = new Set(books.map(b => b.id).filter(Boolean));
    _cfg._getWebBookPool().then((pool) => {
      const extras = pool.filter(b => b.id && !existingIds.has(b.id)).slice(0, TARGET_COUNT - books.length);
      if (!extras.length) return;
      // Build the HTML for the new tiles using the same template as
      // the inline tilesHtml block above. Extracted to a tiny helper
      // here so we don't duplicate the markup.
      const extraHtml = extras.map(b => {
        const cover  = b.cover_url || b.thumbnail_url || '';
        const title  = escHTML(b.title || 'Untitled');
        const author = escHTML(b.author_display_name || b.author_name || b.author_username || '');
        const ratingRaw = Number(b.rating ?? b.average_rating ?? b.avg_rating ?? 0);
        const hasRating = ratingRaw > 0;
        const ratingStr = hasRating ? ratingRaw.toFixed(1) : '';
        const ratingCount = Number(b.rating_count ?? b.ratings_count ?? 0);
        return `
          <div class="hbc-tile" data-book-id="${escHTML(b.id || '')}">
            <div class="hbc-cover">
              ${cover ? `<img src="${escHTML(cover)}" alt="" loading="lazy"/>` : ''}
              <div class="hbc-cover-overlay"></div>
            </div>
            <div class="hbc-title" title="${title}">${title}</div>
            ${author ? `<div class="hbc-author">${author}</div>` : ''}
            ${hasRating
              ? `<div class="hbc-rating">
                   <svg viewBox="0 0 24 24" width="11" height="11" style="fill:#f5b50a"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/></svg>
                   <span class="hbc-rating-val">${ratingStr}</span>
                   ${ratingCount > 0 ? `<span class="hbc-rating-count">(${ratingCount.toLocaleString()})</span>` : ''}
                 </div>`
              : ''}
          </div>`;
      }).join('');
      track.insertAdjacentHTML('beforeend', extraHtml);
      // Recompute arrow state since track is wider now.
      _updateArrows();
    });
  }

  return wrap;
}

// Video card — single featured video tile, larger than a thumbnail.
// Server returns one video per card with id, title, thumbnail_url,
// duration, creator info. Tap → open the video player.
//
// Named with the `_renderHybridVideoCard` prefix to avoid colliding
// with the legacy `renderVideoCard(video, uploader)` at line ~17370
// which renders a different surface (videos tab tile). The naming
// collision broke the whole script with "Identifier already declared".
function _renderHybridVideoCard(payload) {
  const v = payload?.video || payload || {};
  if (!v.id) return null;
  const wrap = document.createElement('div');
  wrap.className = 'feed-video-card';
  wrap.style.cssText = 'margin:12px 0;border-radius:12px;overflow:hidden;background:var(--surface,#1a1a24);border:1px solid var(--border,#2a2a3a);cursor:pointer';
  const thumb = v.thumbnail_url || '';
  const title = escHTML(v.title || 'Untitled video');
  const creator = escHTML(v.creator_display_name || v.creator_name || v.creator_username || '');
  const dur = v.duration ? _cfg._formatDuration(v.duration) : '';
  wrap.innerHTML = `
    <div style="position:relative;aspect-ratio:16/9;background:#000">
      ${thumb ? `<img src="${escHTML(thumb)}" alt="" style="width:100%;height:100%;object-fit:cover" loading="lazy"/>` : ''}
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
        <div style="background:rgba(0,0,0,0.55);border-radius:50%;width:64px;height:64px;display:flex;align-items:center;justify-content:center">
          <svg viewBox="0 0 24 24" width="28" height="28" style="fill:white;margin-left:3px"><polygon points="8 5 19 12 8 19 8 5"/></svg>
        </div>
      </div>
      ${dur ? `<div style="position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,0.75);color:white;font-size:12px;font-weight:600;padding:2px 6px;border-radius:4px">${dur}</div>` : ''}
      <div style="position:absolute;top:10px;left:10px;background:var(--accent,#7975D4);color:white;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.04em">▶ Featured video</div>
    </div>
    <div style="padding:12px 14px">
      <div style="font-size:14px;font-weight:600;color:var(--text,#fff);margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${title}</div>
      ${creator ? `<div style="font-size:12px;color:var(--text2,#aaa)">${creator}</div>` : ''}
    </div>`;
  wrap.addEventListener('click', () => {
    _cfg.playVideo('sb_' + v.id);
  });
  return wrap;
}

// Pin/unpin a post to your profile (max 3 enforced server-side)
async function togglePinPost(postId, currentlyPinned) {
  const newPinnedAt = currentlyPinned ? null : new Date().toISOString();
  const { error } = await supabase
    .from('posts')
    .update({ pinned_at: newPinnedAt })
    .eq('id', postId)
    .eq('user_id', _cfg.getCurrentUser().id); // belt-and-suspenders — RLS already enforces

  if (error) {
    if (/up to 3|max/i.test(error.message)) {
      toast('You can only pin 3 posts. Unpin one first.', 'error');
    } else {
      toast(error.message, 'error');
    }
    return;
  }

  toast(currentlyPinned ? 'Unpinned' : 'Pinned to profile', 'success');

  // If we're on the profile, refresh the posts tab so order updates.
  // viewingProfileId + loadProfilePosts both moved to profile.js (Stage 6),
  // so we use the exported helper that encapsulates both.
  _cfg.refreshProfilePostsIfViewing(_cfg.getCurrentUser().id);
}

function shouldHidePost(post) {
  if (!post) return false;
  if (post.profiles?.is_banned) return true;
  const filters = _cfg.getUserContentFilters();
  if (filters.hiddenPostIds.has(post.id))       return true;
  if (filters.snoozedUserIds.has(post.user_id)) return true;
  if (filters.blockedUserIds.has(post.user_id)) return true;
  return false;
}

function closePostActionMenu() {
  if (_postActionMenuEl) { _postActionMenuEl.remove(); _postActionMenuEl = null; }
}

async function hidePostFromFeed(postId) {
  const { error } = await supabase.from('post_hides').upsert({
    user_id: _cfg.getCurrentUser().id,
    post_id: postId,
  }, { onConflict: 'user_id,post_id' });
  if (error) { toast(error.message, 'error'); return; }

  userContentFilters.hiddenPostIds.add(postId);

  // Smooth fade out, then remove from DOM
  const card = document.querySelector(`.post-card[data-postid="${postId}"]`);
  if (card) {
    card.style.transition = 'opacity 0.25s, transform 0.25s, max-height 0.3s';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.97)';
    setTimeout(() => card.remove(), 280);
  }
  toast('Post hidden', 'success');
}

// Wire close handlers for the post detail modal
function _closePostDetailModal() {
  const m = document.getElementById('postDetailModal');
  if (!m) return;
  m.classList.remove('open');
  m.style.display = 'none';
  document.body.style.overflow = '';
  // Clear the body so the next open shows the loading state, not stale content
  const body = document.getElementById('postDetailBody');
  if (body) body.innerHTML = '<div class="loading">Loading post…</div>';
}


// ─── Functions previously attached to window (inline onclick handlers) ───

async function loadFeed() {
  const feed = document.getElementById('feed');
  const sentinel = document.getElementById('feedSentinel');
  if (!feed) return;

  // Bump the seq — any in-flight loadFeed/loadMoreFeed from a previous tap
  // will see its captured seq no longer matches and bail out before touching
  // the DOM. Eliminates the "fast tab-flick shows wrong tab" race.
  const seq = ++_feedSeq;

  // Cancel any pending realtime debounce — a user-triggered load supersedes
  // a "platform got a new post" auto-refresh. Saves one redundant DB round-trip.
  if (_realtimeRefreshTimer) {
    clearTimeout(_realtimeRefreshTimer);
    _realtimeRefreshTimer = null;
  }

  feed.innerHTML = '<div class="loading">Loading feed...</div>';
  if (sentinel) sentinel.style.display = 'none';

  // Reset pagination state
  _feedOffset = 0;
  _hasMoreFeedPosts = true;
  _isLoadingMoreFeed = false;
  _cachedFollowIds = null;
  if (_feedScrollObserver) { _feedScrollObserver.disconnect(); _feedScrollObserver = null; }
  if (_feedVideoObserver)  { _feedVideoObserver.disconnect();  _feedVideoObserver = null; }
  if (_feedPostObserver)   { _feedPostObserver.disconnect();   _feedPostObserver = null; }

  // Guard: feed needs an authenticated user (the follow query depends on it).
  // Without this, an early-firing realtime listener could call loadFeed before
  // sign-in resolves and crash on `currentUser.id`.
  if (!_cfg.getCurrentUser()?.id) {
    feed.innerHTML = '<div class="empty"><h3>Sign in to see your feed</h3></div>';
    return;
  }

  let queryResult;
  try {
    queryResult = await _buildAndExecFeedQuery({ offset: 0 });
  } catch (err) {
    if (seq !== _feedSeq) return;
    console.error('Feed query failed:', err);
    const msg = _cfg._feedFriendlyError(err);
    feed.innerHTML = `<div class="empty" id="feedRetry" style="cursor:pointer"><p>${escHTML(msg)}</p></div>`;
    document.getElementById('feedRetry')?.addEventListener('click', () => loadFeed());
    return;
  }

  // Stale-query guard — user switched tabs / refreshed mid-flight.
  if (seq !== _feedSeq) return;
  // Sign-out mid-flight — currentUser may have flipped to null while we awaited.
  if (!_cfg.getCurrentUser()?.id) {
    feed.innerHTML = '<div class="empty"><h3>Sign in to see your feed</h3></div>';
    return;
  }

  // Following tab with no follows → friendly empty state (special-case)
  if (queryResult.emptyReason === 'no-follows') {
    feed.innerHTML = `
      <div class="empty">
        <h3>You're not following anyone yet</h3>
        <p>Switch to <strong>Discover</strong> or <strong>For You</strong> to find creators worth following.</p>
      </div>`;
    return;
  }

  // Hybrid feed (For You) — items array contains mixed kinds. Skip
  // _processFeedRows (no client-side scoring; server handles ordering).
  // Walk items in server order and dispatch to the right renderer.
  // Posts still go into the `posts` array so view tracking + the
  // background poller + the buffer-pill all keep working.
  let result;
  if (queryResult.isHybrid) {
    result = queryResult.data;                      // already filtered + post-only
    _cfg.setPosts(result);
    _hasMoreFeedPosts = !!queryResult.hasMore;
    _feedOffset = result.length;                    // soft-tracked; cursor is the real pagination key
    if (!queryResult.items?.length) {
      feed.innerHTML = `<div class="empty"><h3>No posts yet</h3><p>Check back soon — new content drops daily.</p></div>`;
      return;
    }
    feed.innerHTML = '';
    let postIdx = 0;
    queryResult.items.forEach((it, i) => {
      let el = null;
      if (it.kind === 'post') {
        el = renderPost(it.data);
        if (el) el.style.animationDelay = `${(postIdx * 0.04).toFixed(3)}s`;
        postIdx += 1;
      } else if (it.kind === 'book_carousel') {
        el = _renderHybridBookCarousel(it.data);
      } else if (it.kind === 'video_card') {
        el = _renderHybridVideoCard(it.data);
      }
      if (el) feed.appendChild(el);
    });
  } else {
    result = _cfg._processFeedRows(queryResult);
    _cfg.setPosts(result);
    // Pagination state — for scored modes, _feedOffset advances by the WIDER
    // fetch so we don't refetch the same rows we just trimmed away.
    const advance = queryResult.data.length;
    if (advance < (queryResult.fetchLimit || _cfg.FEED_PAGE_SIZE)) _hasMoreFeedPosts = false;
    _feedOffset = advance;

    if (!_cfg.getPosts().length) {
      const emptyMsg = _feedMode === 'discover'
        ? '<h3>No fresh posts to discover</h3><p>Check back soon — new content drops daily.</p>'
        : '<h3>No posts yet</h3><p>Be the first to share something!</p>';
      feed.innerHTML = `<div class="empty">${emptyMsg}</div>`;
      return;
    }

    feed.innerHTML = '';
    _cfg.getPosts().forEach((post, i) => {
      const el = renderPost(post);
      el.style.animationDelay = `${(i * 0.04).toFixed(3)}s`;
      feed.appendChild(el);
    });
  }

  // Facebook-pattern feed: track the newest created_at across this initial
  // page so refreshFeedAdditive / the background poller can fetch only
  // posts since then. Reset to null first so an old session's lastSeenAt
  // doesn't bleed into a different user's session. Also drop the "↑ N
  // new posts" buffer + hide the pill — a full reload absorbs them.
  _cfg.setFeedLastSeenAt(null);
  _cfg._bumpFeedLastSeenAt(_cfg.getPosts());
  _newPostsBuffer = [];
  _newPostsBufferIds = new Set();
  _renderNewPostsPill();

  _wireUpNewPosts(feed);
  if (_hasMoreFeedPosts) _cfg.setupFeedInfiniteScroll();

  // Kick off the background poller for the For You tab. Other tabs
  // don't need it — they're chronological and the user pulls to refresh.
  if (_feedMode === 'foryou') _cfg._startFeedPolling();
  else _cfg._stopFeedPolling();
}

async function deletePost(postId) {
  const ok = await _cfg.confirmDialog({
    title: 'Delete this post?',
    body: 'This permanently removes the post from your feed. If it includes a video, the video file will also be deleted from storage. This can\'t be undone.',
    confirmLabel: 'Delete forever',
  });
  if (!ok) return;

  // ── Optimistic update (2026-05-15) ────────────────────────────────────
  // Pre-fix: this function awaited 3 sequential network round trips
  // (lookup → bunny-delete → posts.delete) plus a full loadFeed() refetch
  // before the card visibly disappeared. That's 1-2 seconds of "did my
  // click register?" UI freeze.
  //
  // Now: we fade the card out immediately + splice it from the in-memory
  // feed array, then run the backend work in the background. If anything
  // fails, we restore the card and surface the error via toast.
  //
  // We DON'T reorder the backend chain (lookup → bunny → posts.delete) —
  // the latent orphan-Bunny-on-DB-fail edge case is its own task.
  const cards = document.querySelectorAll(`.post-card[data-postid="${postId}"]`);
  const cardSnapshots = [];
  cards.forEach(el => {
    const prev = {
      el,
      display:    el.style.display,
      opacity:    el.style.opacity,
      transition: el.style.transition,
      hideTimer:  null,
    };
    el.style.transition = 'opacity 120ms ease-out';
    el.style.opacity = '0';
    // After the fade, fully collapse the layout. Tracked so we can cancel
    // the timeout if the backend errors and we restore the card.
    prev.hideTimer = setTimeout(() => { el.style.display = 'none'; }, 140);
    cardSnapshots.push(prev);
  });

  // Also remove from the in-memory feed array so a re-render (tab switch
  // back to home, scroll-up, etc.) doesn't repaint the row.
  const feedIndex = _cfg.getPosts().findIndex(p => p.id === postId);
  const feedSnapshot = feedIndex >= 0 ? _cfg.getPosts().splice(feedIndex, 1)[0] : null;

  const restoreCard = () => {
    cardSnapshots.forEach(s => {
      clearTimeout(s.hideTimer);
      s.el.style.display    = s.display;
      s.el.style.opacity    = s.opacity;
      s.el.style.transition = s.transition;
    });
    if (feedSnapshot && feedIndex >= 0) _cfg.getPosts().splice(feedIndex, 0, feedSnapshot);
  };

  // ── Backend work (now non-blocking from the UI's POV) ─────────────────
  try {
    // Check if this post has a video — if so, also delete the video & Bunny file
    const { data: post, error: lookupError } = await supabase
      .from('posts')
      .select('video_id')
      .eq('id', postId)
      .single();
    if (lookupError) throw new Error('Failed to find post: ' + lookupError.message);

    if (post?.video_id) {
      try {
        await callEdgeFunction('bunny-delete', { videoId: post.video_id });
      } catch (err) {
        throw new Error('Failed to delete video file: ' + err.message);
      }
    }

    const { error } = await supabase.from('posts').delete().eq('id', postId);
    if (error) throw error;

    toast('Deleted', 'success');

    // Always invalidate videos cache so next visit to videos page is fresh.
    // Note: we deliberately DON'T call loadFeed() anymore — the optimistic
    // DOM removal + array splice already reflect the deletion, and the
    // full refetch was the single largest contributor to the old delay.
    _cfg.invalidateAllVideosCache();
    if (_cfg.isVideosPageVisible()) {
      _cfg.loadVideos();
    }
  } catch (err) {
    restoreCard();
    toast(err.message || 'Delete failed', 'error');
  }
}

function openPostActionMenu(e, btn) {
  e.stopPropagation();
  e.preventDefault();
  if (!_cfg.getCurrentUser()) { toast('Please sign in', 'error'); return; }

  const postId     = btn.dataset.postId;
  // dataset values are written as 'true'/'false' strings in the post template
  // (see the `<button class="post-menu-btn" ... data-is-own=...>` block in
  // renderPost). Compare to 'true' here rather than '1'.
  const isOwn      = btn.dataset.isOwn === 'true';
  const authorId   = btn.dataset.authorId;
  const authorName = btn.dataset.authorName || 'this user';
  const isPinned   = btn.dataset.isPinned === 'true';

  closePostActionMenu();
  _postActionMenuEl = document.createElement('div');
  _postActionMenuEl.className = 'post-action-menu';
  _postActionMenuEl.innerHTML = isOwn ? `
    <button data-pam-action="${isPinned ? 'unpin' : 'pin'}">${isPinned ? 'Unpin from profile' : 'Pin to profile'}</button>
    <button data-pam-action="delete" class="pam-danger">Delete post</button>
  ` : `
    <button data-pam-action="report">Report</button>
    <button data-pam-action="hide">Hide post</button>
    <button data-pam-action="snooze">Snooze · 30 days</button>
    <button data-pam-action="block" class="pam-danger">Block</button>
  `;
  document.body.appendChild(_postActionMenuEl);

  // Position: below button, right-aligned to button's right edge
  const r = btn.getBoundingClientRect();
  _postActionMenuEl.style.position = 'fixed';
  _postActionMenuEl.style.top      = `${Math.min(r.bottom + 6, window.innerHeight - 240)}px`;
  _postActionMenuEl.style.right    = `${Math.max(window.innerWidth - r.right, 12)}px`;

  _postActionMenuEl.querySelectorAll('[data-pam-action]').forEach(b => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const action = b.dataset.pamAction;
      closePostActionMenu();
      if      (action === 'report') _cfg.openReportModal(postId);
      else if (action === 'hide')   hidePostFromFeed(postId);
      else if (action === 'snooze') _cfg.snoozeAuthor(authorId, authorName);
      else if (action === 'block')  _cfg.blockAuthor(authorId, authorName);
      else if (action === 'pin')    togglePinPost(postId, false);
      else if (action === 'unpin')  togglePinPost(postId, true);
      else if (action === 'delete') window.deletePost(postId);
    };
  });

  // Click anywhere else / Escape → close
  setTimeout(() => {
    const onDocClick = (ev) => {
      if (!_postActionMenuEl?.contains(ev.target)) {
        closePostActionMenu();
        document.removeEventListener('click',  onDocClick);
        document.removeEventListener('keydown', onKey);
      }
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { closePostActionMenu(); document.removeEventListener('keydown', onKey); document.removeEventListener('click', onDocClick); } };
    document.addEventListener('click',  onDocClick);
    document.addEventListener('keydown', onKey);
  }, 0);
}

function repostPost(postId) {
  if (!_cfg.getCurrentUser()) return toast('Sign in to repost', 'error');
  const post = _cfg.getPosts().find(p => p.id === postId);
  if (!post) return;
  _cfg.setRepostTargetId(postId);
  const profile = post.profiles || {};
  // display_name preferred; falls back to @handle. Sprint 2 #2.
  const name = profile.display_name || profile.username || 'Unknown';
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}"/>` : initials(name);
  document.getElementById('repostPreview').innerHTML = `
    <div class="post-header">
      <div class="avatar">${avatarHTML}</div>
      <div><span class="post-author">${escHTML(name)}${_cfg.renderRoleSeal(profile)}</span><div class="post-time">${timeAgo(post.created_at)}</div></div>
    </div>
    ${post.body ? `<div class="post-body collapsible-body" data-post-id="${post.id || post.$id || ''}">${_cfg.linkify(post.body)}</div>` : ''}
    ${post.body ? _cfg.renderLinkPreview(post.body) : ''}
    ${post.image_url ? `<div style="border-radius:8px;overflow:hidden;margin-top:0.5rem"><img src="${post.image_url}"/></div>` : ''}
  `;
  document.getElementById('repostCaption').value = '';
  document.getElementById('repostModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('repostCaption').focus(), 100);
}

// Scope #sharemenu-<id> lookups to the post-card the button lives in.
// Same id-collision pattern as comment-toggle (2026-05-16): if the same
// post is rendered in two locations at once (e.g. profile + hidden For
// You feed), document.getElementById picks the first match — usually the
// invisible one — so the visible share button looks dead. closest +
// querySelector restricts the lookup to the user-clicked card.
function _findShareMenu(triggerEl, postId) {
  const card = triggerEl?.closest?.('.post-card');
  return card?.querySelector(`#sharemenu-${CSS.escape(postId)}`)
      || document.getElementById(`sharemenu-${postId}`);
}

function toggleShareMenu(e, postId) {
  e.stopPropagation();
  const menu = _findShareMenu(e.currentTarget || e.target, postId);
  if (!menu) return;
  document.querySelectorAll('.share-menu.visible').forEach(m => { if (m !== menu) m.classList.remove('visible'); });
  menu.classList.toggle('visible');
}

function shareTo(platform, postId) {
  const url = `${window.location.origin}?post=${postId}`;
  const text = 'Check out this post on Selebox';
  const urls = {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`
  };
  if (platform === 'copy') navigator.clipboard.writeText(url).then(() => toast('Link copied!', 'success'));
  else if (urls[platform]) window.open(urls[platform], '_blank');
  // Close whichever menu is currently visible for this postId — there
  // may be more than one in the document, but only one can be visible
  // at a time (toggleShareMenu enforces that). Close them all defensively.
  document.querySelectorAll(`.share-menu#sharemenu-${CSS.escape(postId)}`).forEach(m => m.classList.remove('visible'));
}


// ─── Stage 5 exports ─────────────────────────────────────────────
export {
  loadStories,
  _prependFreshPosts,
  _applyNewPostsBuffer,
  _renderNewPostsPill,
  _pollForNewPosts,
  _buildAndExecFeedQuery,
  _fetchHybridFeedPage,
  _wireUpNewPosts,
  setupCollapsibleBodies,
  loadMoreFeed,
  attachHlsToPostVideo,
  triggerPostLazyLoad,
  flushPostLazyLoad,
  renderPost,
  _renderHybridBookCarousel,
  _renderHybridVideoCard,
  togglePinPost,
  shouldHidePost,
  closePostActionMenu,
  hidePostFromFeed,
  _closePostDetailModal,
  loadFeed,
  deletePost,
  openPostActionMenu,
  repostPost,
  toggleShareMenu,
  shareTo,
};

// ─── State accessor surface ──────────────────────────────────────
// App.js still touches these state vars in a handful of spots (realtime
// debounce timer, IntersectionObserver setup, feed-mode tab switch).
// ESM exports are read-only bindings, so we expose getters/setters
// instead of the raw `let` slots. Internal feed.js code references the
// state vars directly — these are purely an outward bridge.
export function getFeedMode()              { return _feedMode; }
export function setFeedMode(m)             { _feedMode = m; }
export function getFeedVideoObserver()     { return _feedVideoObserver; }
export function setFeedVideoObserver(o)    { _feedVideoObserver = o; }
export function getFeedPostObserver()      { return _feedPostObserver; }
export function setFeedPostObserver(o)     { _feedPostObserver = o; }
export function getNewPostsBuffer()        { return _newPostsBuffer; }
export function getRealtimeRefreshTimer()  { return _realtimeRefreshTimer; }
export function setRealtimeRefreshTimer(t) { _realtimeRefreshTimer = t; }

// These three state vars were previously declared in app.js but only used
// by feed code (now extracted here). App.js still touches them in a couple
// of out-of-band spots (the realtime channel handler reads
// _cachedFollowIds; setupFeedInfiniteScroll reads/writes _feedScrollObserver;
// the scroll-restore on home reads _hasMoreFeedPosts). Bridge via accessors.
export function getHasMoreFeedPosts()      { return _hasMoreFeedPosts; }
export function setHasMoreFeedPosts(v)     { _hasMoreFeedPosts = v; }
export function getCachedFollowIds()       { return _cachedFollowIds; }
export function setCachedFollowIds(arr)    { _cachedFollowIds = arr; }
export function getFeedScrollObserver()    { return _feedScrollObserver; }
export function setFeedScrollObserver(o)   { _feedScrollObserver = o; }

// FEED_SELECT is the canonical posts-table column list with profile + video
// joins. Re-exported so composer.js (via app.js init) and app.js's realtime
// subscription handler can use the same projection.
export { FEED_SELECT };
