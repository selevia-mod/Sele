// ════════════════════════════════════════════════════════════════════════
// Selebox standalone Videos page — extracted from js/app.js as Stage 7A
// of the refactor roadmap (2026-05-15). This module owns:
//   • showVideos() entry point + the personalized grid
//   • Watch-history helpers (getWatchHistory / addToWatchHistory /
//     getInterestProfile) — used by the page for "Up Next"-style scoring
//     and ALSO by playVideo (Stage 7B). They live here because the page's
//     personalized feed is the primary reader; playVideo just records.
//   • fetchSupabaseVideos() — the canonical 100-video pull from `videos`
//   • loadVideos() — hydrate cache + render the grid
//   • getPersonalizedFeed() — score + interleave personalized/trending
//   • renderVideoCard / renderCreatorChannelCard — DOM templates
//   • renderTagPills + getTopTags — adaptive tag chip row
//   • searchVideos / runSearch — client cache filter + server fan-out
//
// NOT moved (stays in app.js, owned by Stage 7B):
//   • playVideo() + paywall + setupVideoMonetGate / teardownVideoMonetGate
//   • setupVideoActions / setupVideoComments / setupCreatorFollow
//   • Up Next sidebar (loadUpNext) — calls fetchSupabaseVideos from here
//   • Resume time helpers (getResumeTime / saveResumeTime) — playback state
//   • formatDuration / formatCompact / normalizeForSearch / sanitizeSearch
//     / escapeIlike — generic utilities used by other features too
//   • Skip controls (vcPrev / vcNext / vcRewind / vcFastForward) +
//     keyboard shortcuts + auto-next checkbox + _videoEventLogging
//   • Sidebar wiring (#btnVideos / #btnBackVideos) — top-level nav stays
//     in app.js, both handlers call our exported showVideos()
//   • Topbar search input listener — writes through us via the
//     setActiveSearchQuery setter and calls our exported runSearch()
//
// CAREFUL: pure code movement. Inward references rewritten to _cfg.X.
// Module-private cache state (allVideosCache, allUploadersCache,
// activeSearchQuery, activeTagFilter) is reached from app.js exclusively
// through the small accessor surface at the bottom of this file. No
// circular imports — we depend on supabase.js + the config injection.
// ════════════════════════════════════════════════════════════════════════

import { supabase, toast, escHTML, initials, timeAgo, REACTIONS } from './supabase.js';
import { logView } from './event-log.js';

// ─── Config-injection dependency surface ─────────────────────────────────
let _cfg = {
  getCurrentUser:         () => null,
  hideAllMainPages:       () => {},
  stopVideoPlayer:        () => {},
  playVideo:              () => {},       // Stage 7B owner — renderVideoCard click target
  openProfile:            () => {},       // creator card / avatar click
  getResumeTime:          () => 0,        // resume-bar overlay on video thumbs
  formatDuration:         (s) => `${s}s`,
  formatCompact:          (n) => String(n || 0),
  normalizeForSearch:     (s) => (s || '').toLowerCase(),
  sanitizeSearchQuery:    (q) => (q || '').trim(),
  escapeIlike:            (s) => s,
  getCurrentProfile:      () => null,
  isUnlocked:             () => false,
  resolveUnlockCost:      () => 0,
  openUnlockDialog:       () => {},
  openVideoMonetThresholdDialog: () => {},
  loadWalletState:        () => {},
  renderTopbarCoinPill:   () => {},
  tickGoal:               () => {},
  loadComments:           () => {},
  loadCommentCount:       () => {},
  loadReactions:          () => {},
  loadVideoBookmarkState: () => {},
  repostPost:             () => {},
  flushReadClose:         () => {},
  openAuthorBookEditor:   () => {},
  openAuthorChapterEditor:() => {},
  openBookDetail:         () => {},
  showAuthor:             () => {},
  showBook:               () => {},
  setSidebarActive:       () => {},
  confirmDialog:          () => Promise.resolve(false),
  closeAllModals:         () => {},
  attachHlsToPostVideo:   () => {},
  getWalletConfig:        () => ({}),
  addUnlock:              () => {},
};

export function initVideos(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// ─── Module-private state ────────────────────────────────────────────────
let allVideosCache = [];
let allUploadersCache = {};
let activeSearchQuery = '';
let activeTagFilter = null;
const WATCH_HISTORY_KEY = 'selebox_watch_history';

// Lazy DOM ref — element exists in index.html, both this module and app.js
// reach for it. Resolved on first access so module load isn't dependent on
// DOMContentLoaded ordering.
let _videosPageEl = null;
function videosPage() {
  if (!_videosPageEl) _videosPageEl = document.getElementById('videosPage');
  return _videosPageEl;
}

// ════════════════════════════════════════════════════════════════════════
// Watch history & smart recommendations
// ════════════════════════════════════════════════════════════════════════
export function getWatchHistory() {
  try {
    const raw = localStorage.getItem(WATCH_HISTORY_KEY);
    if (!raw) return [];
    const history = JSON.parse(raw);
    // Filter out entries older than 30 days
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    return history.filter(h => h.timestamp > cutoff);
  } catch { return []; }
}

export function addToWatchHistory(video, uploader) {
  const history = getWatchHistory();
  // Remove if already exists (we'll add to top)
  const filtered = history.filter(h => h.id !== video.$id);
  filtered.unshift({
    id: video.$id,
    tags: video.tags || [],
    uploader: video.uploader,
    uploaderName: uploader?.username || '',
    timestamp: Date.now()
  });
  // Keep only last 50
  const trimmed = filtered.slice(0, 50);
  try { localStorage.setItem(WATCH_HISTORY_KEY, JSON.stringify(trimmed)); } catch {}
}

export function getInterestProfile() {
  const history = getWatchHistory();
  const recent = history.slice(0, 5); // last 5 videos

  // Weight tags: most recent = highest weight
  const tagWeights = {};
  const weights = [0.4, 0.25, 0.15, 0.1, 0.1];
  recent.forEach((entry, idx) => {
    const w = weights[idx] || 0.05;
    (entry.tags || []).forEach(tag => {
      tagWeights[tag] = (tagWeights[tag] || 0) + w;
    });
  });

  const watchedIds = new Set(history.map(h => h.id));
  const recentUploaders = [...new Set(recent.map(h => h.uploader).filter(Boolean))];

  return { tagWeights, watchedIds, recentUploaders };
}

// ════════════════════════════════════════════════════════════════════════
// Page show + grid load
// ════════════════════════════════════════════════════════════════════════
export function showVideos(forceReload = false) {
  const page = videosPage();
  _cfg.hideAllMainPages();
  page.style.display = 'block';
  document.body.classList.add('on-videos');
  stopVideoPlayer();
  history.pushState(null, '', '#videos');
  // Only reload if cache is empty or forced
  if (forceReload || !allVideosCache.length) {
    loadVideos();
  }
}

// Fetch new videos uploaded via web (from Supabase)
export async function fetchSupabaseVideos() {
  try {
    const { data, error } = await supabase
      .from('videos')
      .select(`
        id,
        bunny_video_id,
        title,
        description,
        tags,
        category,
        video_url,
        thumbnail_url,
        views,
        duration,
        created_at,
        uploader_id,
        is_locked,
        is_monetized,
        unlock_cost_coins,
        unlock_cost_stars,
        profiles!videos_uploader_id_fkey (
          id,
          username,
          avatar_url,
          is_banned
        )
      `)
      .eq('status', 'ready')
      .eq('is_hidden', false)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('Supabase videos fetch error:', error);
      return [];
    }

    // Map to the shape used throughout the app (videoStats, $id, $createdAt, etc.).
    // Filter out videos whose uploader is banned.
    return (data || [])
      .filter(v => !v.profiles?.is_banned)
      .map(v => ({
        $id: 'sb_' + v.id, // prefix so we can tell Supabase videos apart
        _supabase: true,    // flag for special handling
        _supabaseId: v.id,
        title: v.title,
        description: v.description || '',
        tags: v.tags || [],
        uploader: v.uploader_id,
        thumbnail: v.thumbnail_url,
        videoUrl: v.video_url,
        uri: v.video_url,
        videoStats: { views: v.views || 0, duration: v.duration || 0 },
        // Monetization fields (Phase 6) — needed by setupVideoMonetGate to
        // decide whether to set up the time-based unlock listener.
        // Without these the gate silently no-ops, breaking auto-deduct.
        is_locked:          !!v.is_locked,
        is_monetized:       !!v.is_monetized,
        duration:           v.duration || 0,
        unlock_cost_coins:  v.unlock_cost_coins ?? null,
        unlock_cost_stars:  v.unlock_cost_stars ?? null,
        status: 'ready',
        $createdAt: v.created_at,
        // Pre-populated uploader info (saves an extra fetch)
        _uploaderInfo: v.profiles ? {
          $id: v.profiles.id,
          username: v.profiles.username,
          avatar: v.profiles.avatar_url,
        } : null,
      }));
  } catch (err) {
    console.error('Failed to fetch Supabase videos:', err);
    return [];
  }
}

export async function loadVideos() {
  const grid = document.getElementById('videoGrid');
  grid.innerHTML = '<div class="loading">Loading videos...</div>';

  // Populate cache from Supabase if empty (post-migration: Supabase is the only source)
  if (!allVideosCache.length) {
    const supabaseVideos = await fetchSupabaseVideos();
    supabaseVideos.forEach(v => {
      if (v._uploaderInfo && !allUploadersCache[v.uploader]) {
        allUploadersCache[v.uploader] = v._uploaderInfo;
      }
    });
    allVideosCache = supabaseVideos;
  }
  window._cache = allVideosCache; // expose for debugging

  if (!allVideosCache.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><h3>No videos yet</h3></div>';
    return;
  }

  renderTagPills();

  // If no search/tag filter, show personalized feed
  if (!activeSearchQuery && !activeTagFilter) {
    const personalized = getPersonalizedFeed();
    renderVideoResults(personalized);
  } else {
    runSearch();
  }
}

export function getPersonalizedFeed() {
  const { tagWeights, watchedIds, recentUploaders } = getInterestProfile();
  const hasHistory = Object.keys(tagWeights).length > 0;
  const myId = _cfg.getCurrentUser()?.id;

  // Filter out already-watched (last 30 days), but always show user's own uploads
  let pool = allVideosCache.filter(v => v.uploader === myId || !watchedIds.has(v.$id));

  // Pin user's own recent uploads (last 7 days) at the top
  const myRecent = pool.filter(v =>
    v.uploader === myId &&
    v.$createdAt &&
    (Date.now() - new Date(v.$createdAt).getTime()) < 7 * 24 * 3600 * 1000
  );
  const myRecentIds = new Set(myRecent.map(v => v.$id));
  const others = pool.filter(v => !myRecentIds.has(v.$id));

  if (!hasHistory) {
    // No watch history → my recent uploads first, then by recency
    return [...myRecent, ...others];
  }

  // Score each remaining video
  others.forEach(v => {
    let score = 0;

    // Tag matching (interest profile)
    (v.tags || []).forEach(tag => {
      if (tagWeights[tag]) score += tagWeights[tag] * 100;
    });

    // Same uploader bonus (creators you've watched before)
    if (recentUploaders.includes(v.uploader)) score += 15;

    // Engagement boost
    const views = v.videoStats?.views || 0;
    score += Math.log10(views + 1) * 2;

    // Recency boost (newer videos slightly preferred)
    const ageHours = (Date.now() - new Date(v.$createdAt).getTime()) / 3600000;
    if (ageHours < 24) score += 8;
    else if (ageHours < 168) score += 4;

    // Random spice (30% chance to boost a random video)
    if (Math.random() < 0.3) score += Math.random() * 20;

    v._feedScore = score;
  });

  // Sort: 70% personalized + 30% trending mixed in
  others.sort((a, b) => b._feedScore - a._feedScore);

  // Take top 70 personalized
  const personalized = others.slice(0, 70);
  // Take 30 trending (high views, not in personalized)
  const personalizedIds = new Set(personalized.map(v => v.$id));
  const trending = others
    .filter(v => !personalizedIds.has(v.$id))
    .sort((a, b) => (b.videoStats?.views || 0) - (a.videoStats?.views || 0))
    .slice(0, 30);

  // Interleave them (every 3rd is trending)
  const result = [];
  const maxLen = Math.max(personalized.length, trending.length);
  for (let i = 0; i < maxLen; i++) {
    if (personalized[i]) result.push(personalized[i]);
    if (i % 2 === 1 && trending[Math.floor(i/2)]) {
      result.push(trending[Math.floor(i/2)]);
    }
  }

  // Pin my recent uploads at the top
  return [...myRecent, ...result];
}

// ════════════════════════════════════════════════════════════════════════
// Search + tag filtering
// ════════════════════════════════════════════════════════════════════════
export function searchVideos(query, tagFilter) {
  query = (query || '').trim();
  if (!query && !tagFilter) return allVideosCache;

  // Detect hashtag search (e.g. "#music")
  const hashtagMatch = query.match(/^#(\w+)/);
  const isHashtag = !!hashtagMatch;
  // Normalize so "café" matches "cafe" and "Mañana" matches "manana"
  const cleanQuery = _cfg.normalizeForSearch(isHashtag ? hashtagMatch[1] : query);

  return allVideosCache.filter(v => {
    // Tag filter (when user clicks a tag pill)
    if (tagFilter) {
      const hasTag = (v.tags || []).some(t => _cfg.normalizeForSearch(t) === _cfg.normalizeForSearch(tagFilter));
      if (!hasTag) return false;
    }
    if (!cleanQuery) return true;

    // Hashtag mode: ONLY match tags
    if (isHashtag) {
      return (v.tags || []).some(t => _cfg.normalizeForSearch(t).includes(cleanQuery));
    }

    // Normal search: match title, description, tags, category, uploader
    const title    = _cfg.normalizeForSearch(v.title);
    const desc     = _cfg.normalizeForSearch(v.description);
    const tags     = _cfg.normalizeForSearch((v.tags || []).join(' '));
    const category = _cfg.normalizeForSearch((v.category || '').replace(/-/g, ' '));
    const uploader = allUploadersCache[v.uploader];
    const uploaderName = _cfg.normalizeForSearch(uploader?.username || v._uploaderInfo?.username || '');

    return title.includes(cleanQuery)
        || desc.includes(cleanQuery)
        || tags.includes(cleanQuery)
        || category.includes(cleanQuery)
        || uploaderName.includes(cleanQuery);
  });
}

// Adaptive tag chips — blends user's watch-history tags with platform-popular tags.
// YouTube-style: chips reflect what YOU'VE been watching, with some discovery sprinkled in.
export function getTopTags(limit = 18) {
  // Platform popularity (counts every tag occurrence across all videos)
  const platformCounts = {};
  allVideosCache.forEach(v => {
    (v.tags || []).forEach(t => {
      if (!t || typeof t !== 'string') return;
      platformCounts[t] = (platformCounts[t] || 0) + 1;
    });
  });
  const platformRanked = Object.entries(platformCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);

  // User's interest profile — tags weighted by their recent watch history
  const { tagWeights } = getInterestProfile();
  const userRanked = Object.entries(tagWeights || {})
    .filter(([t]) => t && platformCounts[t]) // only suggest tags that actually have content
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);

  const hasInterest = userRanked.length > 0;

  if (!hasInterest) {
    // Brand new user → 100% platform-popular
    return platformRanked.slice(0, limit);
  }

  // Returning user → 70% from interest profile, 30% platform discovery
  const userQuota = Math.ceil(limit * 0.7);
  const out = new Set(userRanked.slice(0, userQuota));
  for (const t of platformRanked) {
    if (out.size >= limit) break;
    out.add(t);
  }
  return [...out].slice(0, limit);
}

export function renderTagPills() {
  const wrap = document.getElementById('videoSearchTags');
  const tags = getTopTags(18);

  // First chip = "All" (clears active filter)
  const allActive = !activeTagFilter ? 'active' : '';
  let html = `<button class="search-tag-pill search-tag-pill-all ${allActive}" data-tag="">All</button>`;
  // Then user-adapted + popular tag chips
  html += tags.map(tag =>
    `<button class="search-tag-pill ${tag === activeTagFilter ? 'active' : ''}" data-tag="${escHTML(tag)}">${escHTML(tag)}</button>`
  ).join('');
  wrap.innerHTML = html;

  wrap.querySelectorAll('.search-tag-pill').forEach(pill => {
    pill.onclick = () => {
      const tag = pill.dataset.tag;
      // "All" chip (empty data-tag) clears the filter; clicking the active tag toggles it off
      activeTagFilter = (!tag || activeTagFilter === tag) ? null : tag;
      renderTagPills();
      if (!activeTagFilter && !activeSearchQuery) {
        renderVideoResults(getPersonalizedFeed());
      } else {
        runSearch();
      }
    };
  });
}

export async function runSearch() {
  const q = (activeSearchQuery || '').trim();

  // Empty query — show personalized feed, or tag-filtered results.
  // For tag filters we must hit the server (not the 100-video in-memory cache),
  // otherwise older videos in that category never show. Without this fix,
  // clicking "Comedy" only surfaced comedy videos that happened to be in the
  // most recent 100 uploads.
  if (!q) {
    if (activeTagFilter) {
      const grid = document.getElementById('videoGrid');
      grid.innerHTML = '<div class="loading" style="grid-column:1/-1">Loading…</div>';
      const tagLower = activeTagFilter.toLowerCase();
      try {
        // Match category OR any tag that equals the filter — covers both
        // schema patterns (category column + tags array).
        const baseSelect = `id, bunny_video_id, title, description, tags, category, video_url, thumbnail_url, views, duration, created_at, uploader_id, is_locked, is_monetized, unlock_cost_coins, unlock_cost_stars, profiles!videos_uploader_id_fkey ( id, username, avatar_url, is_banned )`;
        const [byCat, byTag] = await Promise.all([
          supabase.from('videos').select(baseSelect)
            .eq('status', 'ready').eq('is_hidden', false)
            .ilike('category', tagLower)
            .order('created_at', { ascending: false })
            .limit(100),
          supabase.from('videos').select(baseSelect)
            .eq('status', 'ready').eq('is_hidden', false)
            .contains('tags', [activeTagFilter])
            .order('created_at', { ascending: false })
            .limit(100),
        ]);
        // Merge + dedupe + drop banned uploaders
        const seen = new Set();
        const merged = [];
        [...(byCat.data || []), ...(byTag.data || [])].forEach(v => {
          if (seen.has(v.id) || v.profiles?.is_banned) return;
          seen.add(v.id);
          merged.push(v);
        });
        const formatted = merged.map(v => ({
          $id: 'sb_' + v.id, _supabase: true, _supabaseId: v.id,
          title: v.title, description: v.description || '',
          tags: v.tags || [], uploader: v.uploader_id,
          thumbnail: v.thumbnail_url, videoUrl: v.video_url, uri: v.video_url,
          videoStats: { views: v.views || 0, duration: v.duration || 0 },
          is_locked: !!v.is_locked, is_monetized: !!v.is_monetized,
          duration: v.duration || 0,
          unlock_cost_coins: v.unlock_cost_coins ?? null,
          unlock_cost_stars: v.unlock_cost_stars ?? null,
          status: 'ready', $createdAt: v.created_at,
          _uploaderInfo: v.profiles ? { $id: v.profiles.id, username: v.profiles.username, avatar: v.profiles.avatar_url } : null,
        }));
        // Hydrate cache so playVideo finds these
        formatted.forEach(v => {
          if (!allVideosCache.find(x => x.$id === v.$id)) allVideosCache.push(v);
          if (v._uploaderInfo && !allUploadersCache[v.uploader]) {
            allUploadersCache[v.uploader] = v._uploaderInfo;
          }
        });
        renderVideoResults(formatted);
      } catch (err) {
        console.warn('Tag filter server fetch failed, falling back to cache:', err);
        renderVideoResults(searchVideos('', activeTagFilter));
      }
    } else {
      renderVideoResults(getPersonalizedFeed() || allVideosCache);
    }
    return;
  }

  // Hashtag mode → cache filter is fine (tag is typed, exact field)
  if (q.startsWith('#')) {
    renderVideoResults(searchVideos(q, activeTagFilter));
    return;
  }

  // Real search → query the DB so we find ALL matching videos site-wide,
  // not just the 100 most-recent that live in allVideosCache. This also
  // fixes "Unknown" creator names (the 100-cap cache may miss some uploaders).
  const grid = document.getElementById('videoGrid');
  grid.innerHTML = '<div class="loading" style="grid-column:1/-1">Searching…</div>';

  // Sanitize FIRST (strip , ( ) " — these break .or() / quoting), then ilike-escape.
  const safeQ = _cfg.sanitizeSearchQuery(q);
  // If sanitize stripped everything (e.g. user typed only `,,,` or `()`),
  // fall back to the personalized feed instead of an unbounded `%%` query
  // that would match every video on the platform.
  if (!safeQ) {
    renderVideoResults(getPersonalizedFeed() || allVideosCache);
    return;
  }
  const term = `%${_cfg.escapeIlike(safeQ)}%`;
  const baseSelect = `id, bunny_video_id, title, description, tags, category, video_url, thumbnail_url, views, duration, created_at, uploader_id, is_locked, is_monetized, unlock_cost_coins, unlock_cost_stars, profiles!videos_uploader_id_fkey ( id, username, avatar_url, is_banned )`;
  // Stale-query guard: a slow request mustn't clobber a newer query.
  const savedQuery = activeSearchQuery;

  try {
    // Two parallel queries: title/description match, and creator-name match.
    // Also collect matching CREATOR profiles to surface them as channel cards.
    let matchingCreators = [];
    const [byText, byUploader] = await Promise.all([
      supabase.from('videos').select(baseSelect)
        .eq('status', 'ready').eq('is_hidden', false)
        .or(`title.ilike.${term},description.ilike.${term}`)
        .order('created_at', { ascending: false })
        .limit(60),
      (async () => {
        const { data: profs } = await supabase.from('profiles')
          .select('id, username, avatar_url, bio, is_banned')
          .ilike('username', term)
          .eq('is_banned', false)
          .limit(8);
        if (!profs?.length) return { data: [] };
        matchingCreators = profs;
        const ids = profs.map(p => p.id);
        return await supabase.from('videos').select(baseSelect)
          .eq('status', 'ready').eq('is_hidden', false)
          .in('uploader_id', ids)
          .order('created_at', { ascending: false })
          .limit(60);
      })(),
    ]);

    // Stale-query guard — user kept typing while we awaited; abandon this run.
    if (activeSearchQuery !== savedQuery) return;

    // Merge + dedupe + drop banned uploaders
    const seen = new Set();
    const merged = [];
    [...(byText.data || []), ...(byUploader.data || [])].forEach(v => {
      if (seen.has(v.id) || v.profiles?.is_banned) return;
      seen.add(v.id);
      merged.push(v);
    });

    // Map to canonical shape
    const formatted = merged.map(v => ({
      $id: 'sb_' + v.id,
      _supabase: true,
      _supabaseId: v.id,
      title: v.title,
      description: v.description || '',
      tags: v.tags || [],
      uploader: v.uploader_id,
      thumbnail: v.thumbnail_url,
      videoUrl: v.video_url,
      uri: v.video_url,
      videoStats: { views: v.views || 0, duration: v.duration || 0 },
      // Monetization fields needed by setupVideoMonetGate (auto-deduct at 3:00)
      is_locked:          !!v.is_locked,
      is_monetized:       !!v.is_monetized,
      duration:           v.duration || 0,
      unlock_cost_coins:  v.unlock_cost_coins ?? null,
      unlock_cost_stars:  v.unlock_cost_stars ?? null,
      status: 'ready',
      $createdAt: v.created_at,
      _uploaderInfo: v.profiles ? { $id: v.profiles.id, username: v.profiles.username, avatar: v.profiles.avatar_url } : null,
    }));

    // Hydrate caches so playVideo + repeat searches are instant
    formatted.forEach(v => {
      if (!allVideosCache.find(x => x.$id === v.$id)) allVideosCache.push(v);
      if (v._uploaderInfo && !allUploadersCache[v.uploader]) {
        allUploadersCache[v.uploader] = v._uploaderInfo;
      }
    });

    // Apply optional tag filter client-side (rare path)
    let out = formatted;
    if (activeTagFilter) {
      out = formatted.filter(v => (v.tags || []).some(t => t.toLowerCase() === activeTagFilter.toLowerCase()));
    }

    // Decorate matching creators with video count + total views drawn from
    // the search results we already have in hand. Cheap, no extra round-trip.
    const creatorStats = new Map();
    for (const v of formatted) {
      const s = creatorStats.get(v.uploader) || { videos: 0, views: 0 };
      s.videos += 1;
      s.views  += (v.videoStats?.views || 0);
      creatorStats.set(v.uploader, s);
    }
    const creators = (matchingCreators || []).map(p => ({
      id: p.id,
      username: p.username,
      avatar_url: p.avatar_url,
      bio: p.bio || '',
      videos_count: creatorStats.get(p.id)?.videos || 0,
      views_count:  creatorStats.get(p.id)?.views  || 0,
    }));

    renderVideoResults(out, creators);
  } catch (err) {
    console.error('Search failed:', err);
    // Fallback: cache filter (covers offline / RPC issues)
    if (activeSearchQuery !== savedQuery) return; // stale-guard for fallback path too
    renderVideoResults(searchVideos(q, activeTagFilter));
  }
}

// ════════════════════════════════════════════════════════════════════════
// Grid rendering
// ════════════════════════════════════════════════════════════════════════
export function renderVideoResults(videos, creators = []) {
  const grid = document.getElementById('videoGrid');
  // No videos AND no matching creators → empty state
  if (!videos.length && !creators.length) {
    grid.innerHTML = `
      <div class="video-search-empty">
        <h3>No videos found</h3>
        <p>Try a different keyword or tag</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = '';

  // ── Creator channel cards (YouTube-style, top of search results) ──
  if (creators?.length) {
    const header = document.createElement('div');
    header.className = 'video-creators-header';
    header.textContent = creators.length === 1 ? 'Creator' : 'Creators';
    grid.appendChild(header);

    const channelRow = document.createElement('div');
    channelRow.className = 'video-creators-row';
    creators.forEach(c => channelRow.appendChild(renderCreatorChannelCard(c)));
    grid.appendChild(channelRow);

    if (videos.length) {
      const videosHeader = document.createElement('div');
      videosHeader.className = 'video-creators-header';
      videosHeader.textContent = 'Videos';
      grid.appendChild(videosHeader);
    }
  }

  videos.slice(0, 100).forEach((v, i) => {
    const card = renderVideoCard(v, allUploadersCache[v.uploader]);
    card.style.animationDelay = `${i * 0.03}s`;
    grid.appendChild(card);
  });
}

// Creator channel card (search result top row, YouTube-style)
export function renderCreatorChannelCard(creator) {
  const card = document.createElement('button');
  card.className = 'creator-channel-card';
  card.type = 'button';
  card.onclick = () => _cfg.openProfile(creator.id);

  const initial = (creator.username || '?').trim().charAt(0).toUpperCase();
  const avatar = creator.avatar_url
    ? `<img src="${escHTML(creator.avatar_url)}" alt=""/>`
    : `<div class="creator-channel-avatar-placeholder">${initial}</div>`;

  const videosLabel = creator.videos_count === 1 ? '1 video' : `${_cfg.formatCompact(creator.videos_count)} videos`;
  const viewsLabel  = creator.views_count > 0 ? ` · ${_cfg.formatCompact(creator.views_count)} views` : '';

  card.innerHTML = `
    <div class="creator-channel-avatar">${avatar}</div>
    <div class="creator-channel-info">
      <div class="creator-channel-name">${escHTML(creator.username || 'Unknown')}</div>
      <div class="creator-channel-meta">${videosLabel}${viewsLabel}</div>
      ${creator.bio ? `<div class="creator-channel-bio">${escHTML(creator.bio.slice(0, 90))}${creator.bio.length > 90 ? '…' : ''}</div>` : ''}
    </div>
    <div class="creator-channel-cta">View channel →</div>
  `;
  return card;
}

export function renderVideoCard(video, uploader) {
  const div = document.createElement('div');
  div.className = 'video-card';
  div.onclick = () => playVideo(video.$id);

  // Resolve uploader from arg → cache → embedded info, in that order
  uploader = uploader
    || allUploadersCache[video.uploader]
    || video._uploaderInfo
    || null;
  const name = uploader?.username || 'Unknown';
  const uploaderId = uploader?.$id || uploader?.id || video.uploader || null;
  const avatarHTML = uploader?.avatar ? `<img src="${uploader.avatar}" alt="${escHTML(name)}"/>` : initials(name);

  const thumbHTML = video.thumbnail ? `<img src="${video.thumbnail}" loading="lazy" onerror="this.style.display='none'"/>` : '';
  const resumeTime = getResumeTime(video.$id);
  const videoDuration = video.videoStats?.duration || 0;
  const progressPct = (resumeTime && videoDuration) ? Math.min(100, (resumeTime / videoDuration) * 100) : 0;

  // Make creator name + avatar clickable when we have an uploader id
  const clickableClass = uploaderId ? ' video-card-creator-clickable' : '';

  div.innerHTML = `
    <div class="video-thumb">
      ${thumbHTML}
      <video class="preview" muted playsinline preload="none"></video>
      <span class="video-thumb-duration" data-duration></span>
      ${progressPct > 0 ? `<div class="video-thumb-progress"><div class="video-thumb-progress-fill" style="width:${progressPct}%"></div></div>` : ''}
    </div>
    <div class="video-card-info">
      <div class="avatar${clickableClass}" data-uploader-id="${uploaderId || ''}" title="${uploaderId ? 'View profile' : ''}">${avatarHTML}</div>
      <div class="video-card-text">
        <div class="video-card-title">${escHTML(video.title || 'Untitled')}</div>
        <div class="video-card-meta">
          <span class="video-card-creator${clickableClass}" data-uploader-id="${uploaderId || ''}">${escHTML(name)}</span><br>
          ${(video.videoStats?.views || 0).toLocaleString()} views • ${timeAgo(video.$createdAt)}
        </div>
      </div>
    </div>
  `;

  // Wire creator-name + avatar click → open profile (don't bubble to card)
  if (uploaderId) {
    div.querySelectorAll('[data-uploader-id="' + uploaderId + '"]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        _cfg.openProfile(uploaderId);
      });
    });
  }

  // Show duration if available, otherwise fetch from video metadata
  const durationEl = div.querySelector('[data-duration]');
  if (videoDuration) {
    durationEl.textContent = _cfg.formatDuration(videoDuration);
  } else if (video.videoUrl) {
    const tempVid = document.createElement('video');
    tempVid.preload = 'metadata';
    tempVid.muted = true;
    if (video.videoUrl.endsWith('.m3u8') && window.Hls && Hls.isSupported() && !tempVid.canPlayType('application/vnd.apple.mpegurl')) {
      const tempHls = new Hls();
      tempHls.loadSource(video.videoUrl);
      tempHls.attachMedia(tempVid);
      tempHls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (tempVid.duration && !isNaN(tempVid.duration)) {
          durationEl.textContent = _cfg.formatDuration(tempVid.duration);
        }
        setTimeout(() => tempHls.destroy(), 500);
      });
    } else {
      tempVid.src = video.videoUrl;
      tempVid.addEventListener('loadedmetadata', () => {
        durationEl.textContent = _cfg.formatDuration(tempVid.duration);
        tempVid.removeAttribute('src');
      });
    }
  }

  // Hover to play preview
  const previewEl = div.querySelector('video.preview');
  let hoverHls = null;
  let hoverTimeout = null;

  div.addEventListener('mouseenter', () => {
    hoverTimeout = setTimeout(() => {
      if (video.videoUrl && video.videoUrl.endsWith('.m3u8')) {
        if (previewEl.canPlayType('application/vnd.apple.mpegurl')) {
          previewEl.src = video.videoUrl;
        } else if (window.Hls && Hls.isSupported()) {
          hoverHls = new Hls();
          hoverHls.loadSource(video.videoUrl);
          hoverHls.attachMedia(previewEl);
        }
      } else {
        previewEl.src = video.videoUrl;
      }
      previewEl.play().then(() => {
        previewEl.classList.add('playing');
      }).catch(() => {});
    }, 600); // 600ms delay before preview starts (like YouTube)
  });

  div.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimeout);
    previewEl.classList.remove('playing');
    previewEl.pause();
    previewEl.currentTime = 0;
    if (hoverHls) { hoverHls.destroy(); hoverHls = null; }
    previewEl.removeAttribute('src');
    previewEl.load();
  });

  return div;
}

// ════════════════════════════════════════════════════════════════════════
// Cross-module accessor surface
// ────────────────────────────────────────────────────────────────────────
// Stage 7B (playVideo, paywall, monetization) still lives in app.js and
// needs to read/write the caches we own. Rather than re-exporting the
// raw `let` bindings (which ESM can't mutate from outside), we expose a
// small accessor API. app.js's topbar search input also lives outside
// this module and needs to drive activeSearchQuery + activeTagFilter.
// ════════════════════════════════════════════════════════════════════════

export function getAllVideos()       { return allVideosCache; }
export function setAllVideos(arr)    { allVideosCache = Array.isArray(arr) ? arr : []; }
export function findVideoInCache(id) { return allVideosCache.find(v => v.$id === id); }
export function addToVideosCache(video) {
  if (!video || !video.$id) return;
  if (!allVideosCache.find(x => x.$id === video.$id)) allVideosCache.push(video);
}

export function getUploader(uploaderId) { return allUploadersCache[uploaderId] || null; }
export function getUploaderCache()      { return allUploadersCache; }
export function setUploader(uploaderId, info) {
  if (!uploaderId || !info) return;
  if (!allUploadersCache[uploaderId]) allUploadersCache[uploaderId] = info;
}

export function invalidateAllVideosCache() {
  allVideosCache = [];
  allUploadersCache = {};
}

export function getActiveSearchQuery() { return activeSearchQuery; }
export function setActiveSearchQuery(value) { activeSearchQuery = value || ''; }
export function getActiveTagFilter() { return activeTagFilter; }
export function setActiveTagFilter(value) { activeTagFilter = value || null; }



// ─── Stage 7B helpers also moved (small sub-utilities that the extracted
//     player functions reach for: resolveSupabaseVideoId, getResumeKey,
//     renderUpNextItem). Hoisted ahead of the main Stage 7B block so JS
//     function-hoisting doesn't have to do the work.
function resolveSupabaseVideoId(video) {
  if (!video) return null;
  if (video._supabaseId) return video._supabaseId;
  if (video._supabase && video.id) return video.id;
  if (typeof video.$id === 'string' && video.$id.startsWith('sb_')) return video.$id.slice(3);
  return null;
}

function getResumeKey(videoId) { return `video_resume_${videoId}`; }

function renderUpNextItem(video, uploader, currentTags) {
  const div = document.createElement('div');
  div.className = 'upnext-item';
  div.onclick = () => playVideo(video.$id);

  const name = uploader?.username || 'Unknown';
  const views = (video.videoStats?.views || 0).toLocaleString();
  const matchingTag = (video.tags || []).find(t => currentTags.includes(t));

  div.innerHTML = `
    <div class="upnext-thumb">
      ${video.thumbnail ? `<img src="${video.thumbnail}" loading="lazy" onerror="this.style.display='none'"/>` : ''}
      <span class="upnext-thumb-duration" data-duration></span>
    </div>
    <div class="upnext-info">
      <div class="upnext-title-text">${escHTML(video.title || 'Untitled')}</div>
      <div class="upnext-meta">
        ${escHTML(name)}<br>
        ${views} views • ${timeAgo(video.$createdAt)}
      </div>
      ${matchingTag ? `<span class="upnext-tag">${escHTML(matchingTag)}</span>` : ''}
    </div>
  `;

  // Lazy-load duration
  const durationEl = div.querySelector('[data-duration]');
  const videoDuration = video.videoStats?.duration;
  if (videoDuration) {
    durationEl.textContent = _cfg.formatDuration(videoDuration);
  }

  return div;
}

// ════════════════════════════════════════════════════════════════════════
// Stage 7B — Video player half
// ────────────────────────────────────────────────────────────────────────
// Moved from js/app.js (2026-05-15, second attempt with function-by-
// function extraction after the first range-based pass swept in
// non-player code by mistake). Owns: full-screen player UI, paywall
// gate, time-based monetization gate, comments/reactions/bookmark
// wiring, follow-creator, Up Next sidebar, resume helpers, skip
// controls + keyboard shortcuts, _initVideoEventLogging, and the
// player's module state.
//
// External dependencies still owned by app.js are injected via the
// _cfg surface above. Internal dependencies on the Stage 7A page code
// (fetchSupabaseVideos, getInterestProfile, getAllVideos, etc.) are
// direct calls inside this module.
// ════════════════════════════════════════════════════════════════════════

// ─── module-level state ──────────────────────────────────────────────
let _videoEventsInit = false;
let _videoLastWatchedSec = 0;
let _videoMonetGate = null;  // { videoId, listener }
let currentHls = null;
let _currentVideoCtx = null;   // { supabaseId, title, post_id }
const _videoHistoryStack = [];          // IDs of videos we've watched, for the "Previous" button
const SKIP_SECONDS = 10;
const AUTONEXT_KEY = 'selebox_video_autonext';

// ─── extracted functions (order: setup → state-helpers → controls → player) ───

// Local route-id resolver. Originally lived in app.js (still does, for
// the popstate deep-link router), but videos.js now owns _currentVideoCtx
// as module-private state — so reading it directly is faster than
// hopping back through _cfg. The two implementations stay in sync.
function _currentVideoIdForRoute() {
  if (!_currentVideoCtx) return null;
  return _currentVideoCtx.supabaseId ? 'sb_' + _currentVideoCtx.supabaseId : null;
}

function _currentLoggedVideoId() {
  // Reuses the same hash-route extractor the rest of the code uses
  // for #video/<id> deep links. Returns the bare UUID (no 'sb_' prefix).
  const id = _currentVideoIdForRoute();
  if (!id) return null;
  return id.startsWith('sb_') ? id.slice(3) : id;
}

function flushViewEnd() {
  const id = _currentLoggedVideoId();
  if (!id) return;
  logView({
    videoId:        id,
    kind:           'end',
    watchedSeconds: _videoLastWatchedSec,
  });
  _videoLastWatchedSec = 0;
}

function _initVideoEventLogging() {
  if (_videoEventsInit) return;
  const player = document.getElementById('videoPlayer');
  if (!player) return;
  _videoEventsInit = true;

  // play — fired on initial start AND on resume after pause.
  // Phase 4 detection cares about play-starts as a denominator for
  // threshold-crossed events (e.g. "what % of plays cross paywall?").
  player.addEventListener('play', () => {
    const id = _currentLoggedVideoId();
    if (!id) return;
    logView({
      videoId:        id,
      kind:           'play',
      watchedSeconds: Math.floor(player.currentTime || 0),
    });
  });

  // pause — fired on explicit pause + on navigation away (most
  // browsers fire pause before unload). Useful for partial-watch
  // dwell distributions in Phase 4.
  player.addEventListener('pause', () => {
    const id = _currentLoggedVideoId();
    if (!id) return;
    const ws = Math.floor(player.currentTime || 0);
    _videoLastWatchedSec = ws;
    // Don't emit 'pause' on the natural end — 'ended' will fire
    // separately and that's the more meaningful signal.
    if (player.ended) return;
    logView({ videoId: id, kind: 'pause', watchedSeconds: ws });
  });

  // ended — fired when playback reaches the natural end of the
  // video. Combined with the 'end' event in flushViewEnd (fired on
  // nav-away), this gives us both "watched to completion" and
  // "abandoned mid-stream" as distinct signals.
  player.addEventListener('ended', () => {
    const id = _currentLoggedVideoId();
    if (!id) return;
    const ws = Math.floor(player.currentTime || player.duration || 0);
    _videoLastWatchedSec = ws;
    logView({ videoId: id, kind: 'end', watchedSeconds: ws });
  });

  // timeupdate — fires ~4x/sec while playing. We DON'T log on every
  // tick (that'd be hundreds of events per video). Instead, just keep
  // _videoLastWatchedSec fresh so flushViewEnd has accurate dwell on
  // nav-away or hideAllMainPages.
  player.addEventListener('timeupdate', () => {
    _videoLastWatchedSec = Math.floor(player.currentTime || 0);
  });
}

async function setupVideoMonetGate(player, sbId, video) {
  // Tear down any previous listener
  teardownVideoMonetGate(player);

  const initialSec   = _cfg.getWalletConfig().video_initial_unlock_seconds   || 180;
  const recurringSec = _cfg.getWalletConfig().video_recurring_unlock_seconds || 600;

  // Fetch the user's progress for this video. Legacy aw_/sb_ prefixed ids
  // don't have a UUID and aren't tracked in video_progress (the FK target),
  // so we fall back to "no prior progress" — every threshold is fresh.
  let paidThrough = 0;
  const isLegacy = sbId.startsWith('aw_') || sbId.startsWith('sb_');
  if (!isLegacy && _cfg.getCurrentUser()) {
    const { data: prog } = await supabase
      .from('video_progress')
      .select('paid_through_seconds')
      .eq('user_id', _cfg.getCurrentUser().id)
      .eq('video_id', sbId)
      .maybeSingle();
    paidThrough = prog?.paid_through_seconds || 0;
  }

  const computeNext = (paid) => {
    if (paid < initialSec) return initialSec;
    return initialSec + Math.ceil((paid - initialSec + 1) / recurringSec) * recurringSec;
  };
  let nextThreshold = computeNext(paidThrough);
  let modalOpen = false;
  // 2026-05-15 UX fix: once the viewer explicitly dismisses the
  // threshold dialog with X, stop re-prompting on every subsequent
  // play attempt. Old behavior nagged. New behavior: one-and-done
  // per session — the listener short-circuits until the user
  // navigates away or reloads.
  let userDismissed = false;

  const listener = () => {
    // Stale listener guard — if user navigated to a different video, no-op
    if (!_videoMonetGate || _videoMonetGate.videoId !== sbId) return;
    if (userDismissed) return;
    if (modalOpen) return;
    if (player.currentTime < nextThreshold) return;

    modalOpen = true;
    // Note: video keeps playing during the prompt. The 5s auto-coin fallback
    // means most users won't even notice an interruption — they get a brief
    // glance at the choice, then it auto-deducts and dismisses.
    _cfg.openVideoMonetThresholdDialog({
      videoTitle: video.title,
      videoId:    sbId,
      threshold:  nextThreshold,
      onSuccess: (result) => {
        modalOpen = false;
        if (result.mode === 'permanent') {
          // Coin path — never prompt again for this video
          _cfg.addUnlock(`video:${sbId}`);
          nextThreshold = Infinity;
        } else if (result.mode === 'window') {
          // Star path — paid through end of this window; advance to next
          paidThrough = nextThreshold + recurringSec - 1;
          nextThreshold = computeNext(paidThrough);
        }
        _cfg.renderTopbarCoinPill();
        // No need to call play — we never paused
      },
      onCancel: () => {
        // User clicked X. Pause once + flag dismissed so the listener
        // stops re-prompting on every future play attempt this session.
        modalOpen = false;
        userDismissed = true;
        try { player.pause(); } catch {}
      },
    });
  };

  player.addEventListener('timeupdate', listener);
  _videoMonetGate = { videoId: sbId, listener };
}

function teardownVideoMonetGate(player) {
  if (_videoMonetGate?.listener && player) {
    player.removeEventListener('timeupdate', _videoMonetGate.listener);
  }
  _videoMonetGate = null;
}

async function loadUpNext(currentVideo) {
  const list = document.getElementById('upNextList');
  list.innerHTML = '<div class="loading" style="padding:0.5rem">Loading...</div>';

  const { tagWeights, watchedIds, recentUploaders } = getInterestProfile();
  const currentTags = currentVideo.tags || [];

  try {
    // Recommendation pool is sourced from Supabase.
    const sbVideos = await fetchSupabaseVideos().catch(() => []);
    let pool = sbVideos.filter(v =>
      v.$id !== currentVideo.$id && !watchedIds.has(v.$id)
    );

    // Score each video — same algorithm for both sources
    pool.forEach(v => {
      let score = 0;

      // Tag matching: interest profile (long-term) + current video tags (short-term)
      (v.tags || []).forEach(tag => {
        if (tagWeights[tag]) score += tagWeights[tag] * 100;
        if (currentTags.includes(tag)) score += 30;
      });

      // Same uploader bonus (works across sources via uploader field)
      if (v.uploader && currentVideo.uploader && v.uploader === currentVideo.uploader) score += 25;
      if (v.uploader && recentUploaders.includes(v.uploader)) score += 15;

      // Engagement boost (log-scaled views)
      const views = v.videoStats?.views || 0;
      score += Math.log10(views + 1) * 2;

      // Recency boost (last 30 days get a small lift)
      const ageMs = Date.now() - new Date(v.$createdAt || 0).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < 30) score += Math.max(0, 10 - ageDays / 3);

      // Small randomness so feed feels fresh on each visit
      score += Math.random() * 5;

      v._score = score;
    });

    // Sort by score, take top 10
    pool.sort((a, b) => b._score - a._score);
    const suggestions = pool.slice(0, 10);

    // Resolve uploader info — Supabase videos already have _uploaderInfo cached;
    // for any missing, batch-fetch from profiles.
    const uploaders = {};
    for (const v of suggestions) {
      if (v._uploaderInfo) uploaders[v.uploader] = v._uploaderInfo;
    }
    const missingUploaderIds = [...new Set(
      suggestions.map(v => v.uploader).filter(id => id && !uploaders[id])
    )];
    if (missingUploaderIds.length) {
      try {
        const { data: sbProfiles } = await supabase
          .from('profiles')
          .select('id, username, avatar_url')
          .in('id', missingUploaderIds);
        for (const p of (sbProfiles || [])) {
          uploaders[p.id] = { $id: p.id, username: p.username, avatar: p.avatar_url };
        }
      } catch {}
    }

    // Render
    list.innerHTML = '';
    if (!suggestions.length) {
      list.innerHTML = '<div style="color:var(--text3);font-size:0.85rem;padding:0.5rem">No suggestions yet</div>';
      return;
    }

    suggestions.forEach(v => {
      const uploader = uploaders[v.uploader];
      const item = renderUpNextItem(v, uploader, currentTags);
      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = `<div style="color:var(--text3);font-size:0.85rem;padding:0.5rem">Couldn't load: ${e.message}</div>`;
  }
}

function getResumeTime(videoId) {
  const t = localStorage.getItem(getResumeKey(videoId));
  return t ? parseFloat(t) : 0;
}

function saveResumeTime(videoId, time, duration) {
  if (!time || time < 5) return; // ignore very early
  if (duration && time > duration - 10) {
    localStorage.removeItem(getResumeKey(videoId));
    return;
  }
  localStorage.setItem(getResumeKey(videoId), time);
}

function stopVideoPlayer() {
  const player = document.getElementById('videoPlayer');
  if (player) {
    if (player._saveInterval) { clearInterval(player._saveInterval); player._saveInterval = null; }
    player.pause();
    player.removeAttribute('src');
    player.load();
  }
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }
}

function vcRewind() {
  const v = document.getElementById('videoPlayer');
  if (!v) return;
  v.currentTime = Math.max(0, (v.currentTime || 0) - SKIP_SECONDS);
  _flashSkipBadge('back');
}

function vcFastForward() {
  const v = document.getElementById('videoPlayer');
  if (!v) return;
  const dur = isFinite(v.duration) ? v.duration : 0;
  v.currentTime = Math.min(dur || (v.currentTime + SKIP_SECONDS), (v.currentTime || 0) + SKIP_SECONDS);
  _flashSkipBadge('forward');
}

function _flashSkipBadge(direction) {
  const el = document.querySelector(direction === 'back' ? '#vcRewind' : '#vcFastForward');
  if (!el) return;
  el.classList.add('vc-flash');
  setTimeout(() => el.classList.remove('vc-flash'), 360);
}

function vcPrev() {
  const prevId = _videoHistoryStack.pop();
  if (!prevId) { toast('No previous video', 'error'); return; }
  // Don't push current onto history — that would create a loop
  playVideo(prevId);
}

function vcNext() {
  const list = document.getElementById('upNextList');
  const firstItem = list?.querySelector('.upnext-item');
  if (!firstItem) { toast('No related video to play next', 'error'); return; }
  // Push current onto history before navigating
  const cur = _currentVideoIdForRoute();
  if (cur) _videoHistoryStack.push(cur);
  firstItem.click(); // existing handler calls playVideo(video.$id)
}

function vcInitControls() {
  // Wire buttons (idempotent — won't re-bind)
  const wire = (id, fn) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', fn);
  };
  wire('vcRewind',      vcRewind);
  wire('vcFastForward', vcFastForward);
  wire('vcPrev',        vcPrev);
  wire('vcNext',        vcNext);

  // Autoplay toggle — restore from localStorage
  const autoEl = document.getElementById('vcAutoNext');
  if (autoEl && autoEl.dataset.bound !== '1') {
    autoEl.dataset.bound = '1';
    autoEl.checked = localStorage.getItem(AUTONEXT_KEY) !== '0';  // default ON
    autoEl.addEventListener('change', (e) => {
      localStorage.setItem(AUTONEXT_KEY, e.target.checked ? '1' : '0');
    });
  }

  // Hook into the video element's `ended` event for auto-next
  const video = document.getElementById('videoPlayer');
  if (video && video.dataset.autoNextBound !== '1') {
    video.dataset.autoNextBound = '1';
    video.addEventListener('ended', () => {
      const auto = document.getElementById('vcAutoNext');
      if (auto?.checked) vcNext();
    });
  }

  // Keyboard shortcuts (only when video page is visible and not typing in input/textarea)
  if (!window._videoKbBound) {
    window._videoKbBound = true;
    document.addEventListener('keydown', (e) => {
      const playerVisible = document.getElementById('videoPlayerPage')?.style.display === 'block';
      if (!playerVisible) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); vcRewind(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); vcFastForward(); }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); vcNext(); }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); vcPrev(); }
    });
  }
}

function showVideoPlayer() {
  _cfg.hideAllMainPages();
  videoPlayerPage.style.display = 'block';
  // CRITICAL: enables full-bleed layout (body.on-videos .main-wrap rule).
  // Without this the player gets the default narrow main-wrap width when
  // navigating from a user's wall (skipping showVideos), leaving big empty
  // gutters left/right of the video.
  document.body.classList.add('on-videos');
  // Idempotent — attaches native play/pause/ended/timeupdate listeners
  // ONCE on first show. Subsequent calls are no-ops thanks to the
  // _videoEventsInit flag inside the helper.
  _initVideoEventLogging();
}

async function playVideo(videoId) {
  try {
    let video = null;
    let uploader = null;

    // All videos are now Supabase. Cache holds the most recent ~100 platform-wide,
    // but profiles can list older uploads — so a cache miss is normal and not an error.
    // Try the cache first, then fall back to a direct fetch by ID.
    if (!getAllVideos().length) {
      const fresh = await fetchSupabaseVideos();
      setAllVideos(fresh);
    }
    let cached = findVideoInCache(videoId);
    if (!cached) {
      // Cache miss — fetch this specific video by ID (works for older videos
      // outside the top-100 window, deep links, and shared URLs).
      const rawId = videoId.startsWith('sb_') ? videoId.slice(3) : videoId;
      const { data, error } = await supabase
        .from('videos')
        .select(`id, bunny_video_id, title, description, tags, category, video_url, thumbnail_url, views, duration, created_at, uploader_id, status, is_hidden, is_locked, is_monetized, unlock_cost_coins, unlock_cost_stars, profiles!videos_uploader_id_fkey ( id, username, avatar_url, is_banned )`)
        .eq('id', rawId)
        .maybeSingle();
      if (error || !data) {
        toast('Video not found', 'error');
        return;
      }
      // Block playback for banned uploaders or unready/hidden videos (unless owner).
      const isOwner = _cfg.getCurrentUser() && _cfg.getCurrentUser().id === data.uploader_id;
      if (data.profiles?.is_banned) { toast('Video unavailable', 'error'); return; }
      if (!isOwner && (data.status !== 'ready' || data.is_hidden)) {
        toast('Video unavailable', 'error');
        return;
      }
      cached = {
        $id: 'sb_' + data.id,
        _supabase: true,
        _supabaseId: data.id,
        title: data.title,
        description: data.description || '',
        tags: data.tags || [],
        uploader: data.uploader_id,
        thumbnail: data.thumbnail_url,
        videoUrl: data.video_url,
        uri: data.video_url,
        videoStats: { views: data.views || 0, duration: data.duration || 0 },
        status: data.status || 'ready',
        $createdAt: data.created_at,
        is_locked:         data.is_locked,
        is_monetized:      data.is_monetized,
        unlock_cost_coins: data.unlock_cost_coins,
        unlock_cost_stars: data.unlock_cost_stars,
        _uploaderInfo: data.profiles ? { $id: data.profiles.id, username: data.profiles.username, avatar: data.profiles.avatar_url } : null,
      };
      // Cache it so revisits are instant + Prev/Next nav has it.
      addToVideosCache(cached);
    }
    video = cached;
    uploader = cached._uploaderInfo || null;

    showVideoPlayer();
    history.pushState(null, '', `#video/${videoId}`);

    const player = document.getElementById('videoPlayer');
    if (currentHls) { currentHls.destroy(); currentHls = null; }

    // PAYWALL: locked videos that the viewer hasn't unlocked AND don't own.
    // Owner (the uploader) can always preview their own video.
    const sbId = video._supabaseId || (videoId.startsWith('sb_') ? videoId.slice(3) : videoId);
    const isOwner = _cfg.getCurrentUser() && _cfg.getCurrentUser().id === video.uploader;
    const paywallEl = document.getElementById('videoPaywall');
    if (video.is_locked && !isOwner && !_cfg.isUnlocked('video', sbId)) {
      const coinCost = _cfg.resolveUnlockCost('video', 'coin', { unlock_cost_coins: video.unlock_cost_coins, unlock_cost_stars: video.unlock_cost_stars });
      const starCost = _cfg.resolveUnlockCost('video', 'star', { unlock_cost_coins: video.unlock_cost_coins, unlock_cost_stars: video.unlock_cost_stars });
      // Stop playback + hide controls until unlock.
      player.pause();
      player.removeAttribute('src');
      player.load();
      document.getElementById('videoPaywallTitle').textContent = video.title || 'This video is locked';
      document.getElementById('videoPaywallCoins').textContent = coinCost;
      document.getElementById('videoPaywallStars').textContent = starCost;
      paywallEl.style.display = '';
      const unlockBtn = document.getElementById('btnVideoUnlock');
      unlockBtn.onclick = () => {
        _cfg.openUnlockDialog({
          targetType: 'video',
          targetId:   sbId,
          row:        { unlock_cost_coins: video.unlock_cost_coins, unlock_cost_stars: video.unlock_cost_stars },
          title:      video.title,
          onUnlocked: () => { paywallEl.style.display = 'none'; playVideo(videoId); },
        });
      };
      return;
    }
    if (paywallEl) paywallEl.style.display = 'none';

    // PHASE 6 — time-based monetization. Independent of the legacy is_locked
    // gated-from-start paywall above. If video.is_monetized is true and the
    // viewer has NOT permanently unlocked (no `unlocks` row), set up a
    // timeupdate listener that pauses + prompts at thresholds (180, 780,
    // 1380, 1980, …). Coin = permanent. Star = 10-min window only.
    if (video.is_monetized && !isOwner && !_cfg.isUnlocked('video', sbId)) {
      // sbId may be 'aw_xxx' for legacy videos; setupVideoMonetGate handles
      // both UUID and legacy ids by skipping video_progress writes for legacy.
      await setupVideoMonetGate(player, sbId, video);
    } else {
      teardownVideoMonetGate(player);
    }

    const resumeFrom = getResumeTime(videoId);

    const startPlayback = () => {
      if (resumeFrom > 0) {
        player.currentTime = resumeFrom;
        toast(`Resumed at ${_cfg.formatDuration(resumeFrom)}`, '');
      }
      player.play().catch(() => {});
    };

    if (video.videoUrl && video.videoUrl.endsWith('.m3u8')) {
      if (player.canPlayType('application/vnd.apple.mpegurl')) {
        player.src = video.videoUrl;
        player.addEventListener('loadedmetadata', startPlayback, { once: true });
      } else if (window.Hls && Hls.isSupported()) {
        currentHls = new Hls();
        currentHls.loadSource(video.videoUrl);
        currentHls.attachMedia(player);
        currentHls.on(Hls.Events.MANIFEST_PARSED, startPlayback);
      } else {
        toast('HLS not supported in this browser', 'error');
      }
    } else {
      player.src = video.videoUrl || '';
      player.addEventListener('loadedmetadata', startPlayback, { once: true });
    }

    // Save position every 3 seconds + accumulate watch-time toward
    // the "Watch N mins of video" daily goal. _cfg.tickGoal('watch_video',
    // 1) fires once per full minute of actual playback (paused time
    // doesn't count). Mirrors mobile at app/(video)/video-player.jsx.
    // _accumWatchSec lives on the player element so we don't pollute
    // module scope and so it resets cleanly when the player is reused.
    player._accumWatchSec = player._accumWatchSec || 0;
    player._lastTickSec   = (player.currentTime > 0) ? player.currentTime : 0;
    let saveInterval = setInterval(() => {
      if (!player.paused && player.currentTime > 0) {
        saveResumeTime(videoId, player.currentTime, player.duration);

        // Watch-time accumulator. Use the *delta* between samples so
        // seeking forward doesn't farm the counter (a 30-second skip
        // only adds 3 seconds — the interval tick width — to the
        // accumulator). On backward seek the delta goes negative,
        // which we clamp to zero so a rewind doesn't reduce credit.
        const delta = Math.max(0, Math.min(3, player.currentTime - player._lastTickSec));
        player._lastTickSec   = player.currentTime;
        player._accumWatchSec = (player._accumWatchSec || 0) + delta;
        // Fire ONE minute-tick per 60s crossed. Loop in case the
        // interval was paused (browser tab background throttling) and
        // we accumulated multiple minutes at once.
        while (player._accumWatchSec >= 60) {
          _cfg.tickGoal('watch_video', 1);
          player._accumWatchSec -= 60;
        }
      } else if (!player.paused && player.currentTime > 0) {
        // Player resumed after a pause — update the baseline so the
        // first delta after resume doesn't credit paused time.
        player._lastTickSec = player.currentTime;
      }
    }, 3000);

    // Clean up interval when video changes
    player._saveInterval && clearInterval(player._saveInterval);
    player._saveInterval = saveInterval;

    // Save when paused
    player.onpause = () => saveResumeTime(videoId, player.currentTime, player.duration);

    document.getElementById('videoTitle').textContent = video.title || 'Untitled';
    document.getElementById('videoViews').textContent = '';
    document.getElementById('videoDate').textContent = timeAgo(video.$createdAt);
    document.getElementById('videoDescription').textContent = video.description || '';

    const name = uploader?.username || 'Unknown';
    const avatarEl = document.getElementById('videoUploaderAvatar');
    avatarEl.innerHTML = uploader?.avatar ? `<img src="${uploader.avatar}"/>` : initials(name);
    document.getElementById('videoUploaderName').textContent = name;
    document.getElementById('videoUploaderBadge').textContent = video.tags?.length ? video.tags.join(' • ') : '';
    
    // Track watch history & load suggestions
    addToWatchHistory(video, uploader);
    loadUpNext(video);

    // Each setup is independent — wrap so one failing path doesn't kill the others
    try { setupVideoActions(video); }       catch (e) { console.warn('setupVideoActions failed:', e); }
    try { setupVideoComments(video); }      catch (e) { console.warn('setupVideoComments failed:', e); }
    try { setupCreatorFollow(video, uploader); } catch (e) { console.warn('setupCreatorFollow failed:', e); }
    try { setupDescriptionToggle(); }       catch (e) { console.warn('setupDescriptionToggle failed:', e); }
  } catch (error) {
    toast('Couldn\'t load video: ' + error.message, 'error');
  }
}

async function setupCreatorFollow(video, uploader) {
  const btn = document.getElementById('btnFollowCreator');
  if (!btn) return;
  btn.style.display = 'none';
  btn.disabled = false;
  btn.classList.remove('following');
  btn.onclick = null;
  if (!_cfg.getCurrentUser()) return;

  const isSupabaseVideo = !!resolveSupabaseVideoId(video);
  const username = uploader?.username || video?.uploader?.username || null;
  let creatorId = null;

  if (isSupabaseVideo) {
    creatorId =
         uploader?.id
      || uploader?.$id
      || video?.author_id
      || video?.uploader
      || video?._uploaderInfo?.$id
      || video?._uploaderInfo?.id
      || null;
    if (creatorId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(creatorId)) {
      creatorId = null;
    }
  } else if (username) {
    const { data: matchingProfile } = await supabase
      .from('profiles')
      .select('id')
      .ilike('username', username)
      .maybeSingle();
    creatorId = matchingProfile?.id || null;
  }

  if (creatorId === _cfg.getCurrentUser().id) return;   // your own video → hide

  // Always show the button. Behavior depends on whether we resolved a profile.
  btn.style.display = 'inline-flex';

  // CASE A: creator has a Supabase profile → full follow flow
  if (creatorId) {
    const setFollowingState = (isFollowing) => {
      if (isFollowing) {
        btn.classList.add('following');
        btn.textContent = '✓ Following';
      } else {
        btn.classList.remove('following');
        btn.textContent = '+ Follow';
      }
    };

    const { data: existing } = await supabase
      .from('follows')
      .select('follower_id')
      .eq('follower_id', _cfg.getCurrentUser().id)
      .eq('following_id', creatorId)
      .maybeSingle();
    setFollowingState(!!existing);

    btn.onclick = async () => {
      btn.disabled = true;
      const wasFollowing = btn.classList.contains('following');
      setFollowingState(!wasFollowing);   // optimistic
      let error = null;
      if (wasFollowing) {
        ({ error } = await supabase.from('follows').delete()
          .eq('follower_id', _cfg.getCurrentUser().id).eq('following_id', creatorId));
      } else {
        ({ error } = await supabase.from('follows').insert({
          follower_id: _cfg.getCurrentUser().id, following_id: creatorId,
        }));
      }
      btn.disabled = false;
      if (error) {
        setFollowingState(wasFollowing);
        toast('Couldn\'t update follow: ' + error.message, 'error');
      } else {
        toast(wasFollowing ? 'Unfollowed' : 'Following!', 'success');
      }
    };
    return;
  }

  // CASE B: legacy creator without a Supabase profile → show button, friendly toast
  btn.textContent = '+ Follow';
  btn.classList.remove('following');
  btn.onclick = () => {
    const who = username ? `@${username}` : 'this creator';
    toast(`${who} is on the mobile app — follow them there for now.`, 'error');
  };
  return;

  const setFollowingState = (isFollowing) => {
    if (isFollowing) {
      btn.classList.add('following');
      btn.textContent = '✓ Following';
    } else {
      btn.classList.remove('following');
      btn.textContent = '+ Follow';
    }
  };

  // Initial state lookup
  const { data: existing } = await supabase
    .from('follows')
    .select('follower_id')
    .eq('follower_id', _cfg.getCurrentUser().id)
    .eq('following_id', creatorId)
    .maybeSingle();
  setFollowingState(!!existing);

  btn.onclick = async () => {
    btn.disabled = true;
    const wasFollowing = btn.classList.contains('following');
    setFollowingState(!wasFollowing);   // optimistic
    let error = null;
    if (wasFollowing) {
      ({ error } = await supabase.from('follows').delete()
        .eq('follower_id', _cfg.getCurrentUser().id).eq('following_id', creatorId));
    } else {
      ({ error } = await supabase.from('follows').insert({
        follower_id: _cfg.getCurrentUser().id, following_id: creatorId,
      }));
    }
    btn.disabled = false;
    if (error) {
      // Revert on failure
      setFollowingState(wasFollowing);
      toast('Couldn\'t update follow: ' + error.message, 'error');
    } else {
      toast(wasFollowing ? 'Unfollowed' : 'Following!', 'success');
    }
  };
}

function setupDescriptionToggle() {
  const desc   = document.getElementById('videoDescription');
  const toggle = document.getElementById('videoDescriptionToggle');
  if (!desc || !toggle) return;

  // Reset state so navigating between videos doesn't carry over
  desc.classList.remove('expanded');
  toggle.style.display = 'none';
  toggle.textContent = 'Show more';

  // Wait one frame for the new text to lay out, then check overflow
  requestAnimationFrame(() => {
    if (desc.scrollHeight > desc.clientHeight + 2) {
      toggle.style.display = 'inline-block';
    }
  });

  toggle.onclick = () => {
    const expanded = desc.classList.toggle('expanded');
    toggle.textContent = expanded ? 'Show less' : 'Show more';
  };
}

function setupVideoComments(video) {
  const wrap = document.getElementById('videoCommentsWrap');
  if (!wrap) {
    console.warn('[video] videoCommentsWrap missing from the DOM — index.html may be stale');
    return;
  }
  const supabaseId = resolveSupabaseVideoId(video);
  // Pick whichever id this video has. Supabase ID wins if present.
  const videoIdForComments = supabaseId || video?.$id || null;

  if (!videoIdForComments) {
    wrap.style.display = 'none';
    return;
  }

  // Make sure the wrap is visible (override any stale inline display:none)
  wrap.style.display = 'block';
  const countEl = document.getElementById('videoCommentsCount');
  if (countEl) countEl.textContent = '';
  _cfg.loadComments(null, videoIdForComments);
  _cfg.loadCommentCount(null, videoIdForComments);
}

async function setupVideoActions(video) {
  const actionsBar = document.getElementById('videoActions');
  if (!actionsBar) return;

  const supabaseVideoId = resolveSupabaseVideoId(video);
  const legacyVideoId   = !supabaseVideoId ? (video?.$id || null) : null;
  const isLegacy        = !supabaseVideoId;
  // Polymorphic id used for the reactions table — works for both Supabase and legacy now
  const videoIdForActions = supabaseVideoId || legacyVideoId;

  // ── Record a unique view (May 2026 parity fix) ──────────────────────
  // Mobile inserts into public.video_views on open; web previously had
  // no view-recording path at all, so videos.views_count never advanced
  // from web traffic. Composite PK (video_id, viewer_id) makes this
  // idempotent — a returning viewer hits ON CONFLICT and the trigger
  // doesn't double-count. We deliberately don't await this; the player
  // shouldn't block on analytics.
  if (supabaseVideoId && _cfg.getCurrentUser()?.id) {
    // Strip the 'sb_' prefix that resolveSupabaseVideoId prepends for
    // cache lookups. The DB column is the bare UUID.
    const rawVideoId = supabaseVideoId.startsWith('sb_')
      ? supabaseVideoId.slice(3)
      : supabaseVideoId;
    // Fire-and-forget. Swallow errors silently — RLS or transient
    // network blips here must never interrupt playback.
    supabase
      .from('video_views')
      .upsert({ video_id: rawVideoId, viewer_id: _cfg.getCurrentUser().id }, { onConflict: 'video_id,viewer_id', ignoreDuplicates: true })
      .then(({ error }) => {
        if (error) console.warn('[recordVideoView] failed (non-fatal):', error.message);
      });
  }

  const reactionWrap = actionsBar.querySelector('.reaction-wrap[data-type="video"]');
  const reactionBtn  = actionsBar.querySelector('.reaction-trigger[data-type="video"]');
  const picker       = actionsBar.querySelector('.reaction-picker');

  // Like button — works for both Supabase and legacy videos via the polymorphic
  // reactions.target_id (now text after migration_reactions_legacy.sql).
  if (videoIdForActions) {
    reactionWrap.style.display = '';
    reactionWrap.dataset.target = videoIdForActions;
    reactionBtn.dataset.target  = videoIdForActions;
    reactionBtn.onclick = null;     // restore default reaction-picker behavior
    picker.style.display = '';
    picker.innerHTML = REACTIONS.map(r => `
      <button class="reaction-option" data-key="${r.key}" data-target="${videoIdForActions}" data-type="video" title="${r.label}">
        <span class="r-emoji">${r.emoji}</span>
        <span class="r-label">${r.label}</span>
      </button>
    `).join('');
    _cfg.loadReactions(videoIdForActions, 'video');
  } else {
    reactionWrap.style.display = 'none';
  }

  // Repost — always show. Supabase: real repost via the auto-created post.
  // Legacy: friendly toast (we can't repost into the posts table without a video_id FK).
  const repostBtn = document.getElementById('videoRepostBtn');
  repostBtn.style.display = '';
  let postIdForRepost = null;
  if (supabaseVideoId) {
    const { data: postRow } = await supabase
      .from('posts')
      .select('id')
      .eq('video_id', supabaseVideoId)
      .maybeSingle();
    postIdForRepost = postRow?.id || null;
  }
  if (postIdForRepost) {
    repostBtn.onclick = () => _cfg.repostPost(postIdForRepost);
  } else if (isLegacy) {
    repostBtn.onclick = () => toast('Reposting legacy videos is coming soon — share the link instead.', 'error');
  } else {
    repostBtn.onclick = () => toast('This video has no original post to repost.', 'error');
  }

  // Share — always works. Opens the menu, options pick the platform.
  const shareBtn  = document.getElementById('videoShareBtn');
  const shareMenu = document.getElementById('videoShareMenu');
  shareBtn.onclick = (e) => {
    e.stopPropagation();
    shareMenu.classList.toggle('visible');
  };
  shareMenu.querySelectorAll('.share-option').forEach(opt => {
    opt.onclick = (e) => {
      e.stopPropagation();
      shareMenu.classList.remove('visible');
      const platform = opt.dataset.platform;
      const fragId = supabaseVideoId ? 'sb_' + supabaseVideoId : (video.$id || '');
      const url = `${window.location.origin}/#video/${fragId}`;
      const text = encodeURIComponent(video.title || 'Check out this video on Selebox');
      const shareUrl = encodeURIComponent(url);
      if (platform === 'copy') {
        navigator.clipboard?.writeText(url).then(
          () => toast('Link copied', 'success'),
          () => toast('Could not copy link', 'error')
        );
      } else if (platform === 'facebook') {
        window.open(`https://www.facebook.com/sharer/sharer.php?u=${shareUrl}`, '_blank');
      } else if (platform === 'twitter') {
        window.open(`https://twitter.com/intent/tweet?text=${text}&url=${shareUrl}`, '_blank');
      } else if (platform === 'whatsapp') {
        window.open(`https://wa.me/?text=${text}%20${shareUrl}`, '_blank');
      }
    };
  });

  _currentVideoCtx = { supabaseId: supabaseVideoId, title: video?.title || '' };

  // Defensive: hide bookmark button if the video has no Supabase row (shouldn't happen post-migration)
  const bmBtn = document.getElementById('videoBookmarkBtn');
  if (bmBtn) bmBtn.style.display = supabaseVideoId ? 'inline-flex' : 'none';
  if (supabaseVideoId) _cfg.loadVideoBookmarkState(supabaseVideoId);
}


// Cross-module read accessor for _currentVideoCtx — app.js's
// _currentVideoIdForRoute helper + the deep-link routing in popstate
// need to know which video is in the player at any given moment.
// Module-private state isn't accessible across ESM boundaries, so we
// expose a getter rather than the binding itself.
export function getCurrentVideoCtx() { return _currentVideoCtx; }

// ─── Stage 7B exports — app.js still calls these from sidebar wirings,
//     router/popstate, post-card click handlers, etc.
export {
  playVideo,
  showVideoPlayer,
  stopVideoPlayer,
  getResumeTime,
  saveResumeTime,
  setupVideoMonetGate,
  teardownVideoMonetGate,
  vcInitControls,
  _initVideoEventLogging,
  loadUpNext,
};
