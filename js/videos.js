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

import { supabase, toast, escHTML, initials, timeAgo } from './supabase.js';

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
  _cfg.stopVideoPlayer();
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
        // Codex audit (2026-05-16): `category` is fetched from Supabase but
        // was never copied into the normalized object. searchVideos checks
        // v.category — without this, category search silently fails for
        // every cached video.
        category: v.category || '',
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
          tags: v.tags || [], category: v.category || '', uploader: v.uploader_id,
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
      category: v.category || '',
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
  div.onclick = () => _cfg.playVideo(video.$id);

  // Resolve uploader from arg → cache → embedded info, in that order
  uploader = uploader
    || allUploadersCache[video.uploader]
    || video._uploaderInfo
    || null;
  const name = uploader?.username || 'Unknown';
  const uploaderId = uploader?.$id || uploader?.id || video.uploader || null;
  const avatarHTML = uploader?.avatar ? `<img src="${uploader.avatar}" alt="${escHTML(name)}"/>` : initials(name);

  const thumbHTML = video.thumbnail ? `<img src="${video.thumbnail}" loading="lazy" onerror="this.style.display='none'"/>` : '';
  const resumeTime = _cfg.getResumeTime(video.$id);
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
    const HlsCtor = window.Hls;
    if (video.videoUrl.endsWith('.m3u8') && HlsCtor && HlsCtor.isSupported() && !tempVid.canPlayType('application/vnd.apple.mpegurl')) {
      const tempHls = new HlsCtor();
      tempHls.loadSource(video.videoUrl);
      tempHls.attachMedia(tempVid);
      tempHls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
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
        } else {
          const HlsCtor = window.Hls;
          if (HlsCtor && HlsCtor.isSupported()) {
            hoverHls = new HlsCtor();
            hoverHls.loadSource(video.videoUrl);
            hoverHls.attachMedia(previewEl);
          }
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
