// ════════════════════════════════════════════════════════════════════════
// Selebox Creator Studio — extracted from js/app.js as Stage 4 of the
// refactor roadmap (2026-05-15). This module owns:
//   • The studio page (your-uploaded-videos grid) — list, search, sort,
//     filter, paginate, bulk-select
//   • The studio edit modal — change title / description / monetization
//     parameters / thumbnail
//   • The studio share-to-feed modal — opened from a row's actions
//   • Monetize toggle, delete (with confirm + Bunny cleanup)
//   • The btnStudioUpload button click → routes to the video uploader
//
// NOT moved (stays in app.js):
//   • showStudio() at line ~9461 — sidebar navigation entry. Same
//     pattern as showFeed / showMessages / etc; nav entries live in
//     app.js. showStudio calls loadStudio() exported from this module.
//   • The btnStudio sidebar nav listener that calls showStudio().
//
// CAREFUL: pure code movement, not a rewrite (one exception — the
// latent `esc` undefined bug in the Share modal got upgraded to
// `escHTML` while we were touching it). Stage 1-3 discipline still
// applies: same lines of code, different file, no creative refactors.
//
// Stage 1 lesson: don't import from app.js — circular ES module
// imports break realtime channel setup at module load. We import ONLY
// from supabase.js (leaf). Everything app.js owns (currentUser, the
// wallet config, the thumbnail uploader, the various format helpers,
// confirmDialog, showEarnings nav, the allVideosCache reset, and the
// feed-refresh-if-visible helper) is INJECTED via initStudio(config).
// ════════════════════════════════════════════════════════════════════════

import { supabase, toast, escHTML, callEdgeFunction } from './supabase.js';

// ─── Config-injection dependency surface ──────────────────────────────────
// 9 injected pieces:
//   getCurrentUser()             → live currentUser or null
//   getWalletConfig()            → app.js _walletConfigDefaults
//   uploadThumbnail(file)        → calls _vuUploadThumbnailFile; returns URL
//   uploadImage(file)            → uploads attached photo to Bunny; returns URL
//                                  (used by share-modal "Add photo" flow)
//   formatPhpFromMinor(minor)    → "₱100.00" style formatter
//   formatDuration(seconds)      → "12:34" style formatter
//   confirmDialog({title, body, confirmLabel}) → bool
//   showEarnings(forceReload)    → nav into earnings page
//   invalidateAllVideosCache()   → resets app.js's allVideosCache
//   refreshFeedIfVisible()       → if feed is open, reload it
let _cfg = {
  getCurrentUser:            () => null,
  getWalletConfig:           () => ({}),
  uploadThumbnail:           async () => null,
  uploadImage:               async () => null,
  formatPhpFromMinor:        () => '',
  formatDuration:            () => '',
  confirmDialog:             async () => false,
  showEarnings:              () => {},
  invalidateAllVideosCache:  () => {},
  refreshFeedIfVisible:      () => {},
};

// ─── Public API ──────────────────────────────────────────────────────────
// initStudio is called from app.js's onSignedIn. It stores the config
// so the event listeners (bound at module load) + the loadStudio
// function (called by app.js's showStudio) can read live state.
export function initStudio(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

let studioVideosCache = [];
let studioSearchQuery = '';
// Lifetime video revenue (PHP minor units = centavos). Populated by
// loadStudio() summing author_earnings.net_php_minor for the current
// user's video earnings. Shown in the 4th stat card.
let studioRevenuePhpMinor = 0;
// Per-video earnings map: Map<videoId, php_minor>. Same source as
// studioRevenuePhpMinor (just bucketed by source_id instead of summed
// globally). Populated by loadStudio. Read by the Earnings column.
const studioEarningsByVideoId = new Map();
// Pagination state. Persisted page-size choice means the user's
// preference (25/50/100) survives reloads; current page resets on
// every filter change so we never end up "stuck" on page 7 of a
// 3-page filtered list.
let studioPageIdx = 1;
const STUDIO_PAGE_SIZE_OPTIONS = [25, 50, 100];
let studioPageSize = (() => {
  const stored = parseInt(localStorage.getItem('selebox_studio_page_size') || '25', 10);
  return STUDIO_PAGE_SIZE_OPTIONS.includes(stored) ? stored : 25;
})();

// Visibility filter — 'all' or one of the buckets returned by
// _studioDeriveVisibility (published, scheduled, processing, private,
// failed). The chip row above the search drives this. We never
// persist it: a creator usually wants to see "all" by default on
// re-entry to Studio.
let studioVisibilityFilter = 'all';

// Sort state. Default mirrors the pre-pagination behavior (newest
// first). Sortable keys: 'created_at', 'views', 'likes', 'title'.
// dir is 'asc' | 'desc'.
let studioSort = { key: 'created_at', dir: 'desc' };

// Bulk-selection state — set of row ids the user has checked. Empty
// = no bulk bar shown. Cleared on every renderStudio() invocation
// that follows a non-selection action (search/filter/sort/page
// change) since stale ids referring to off-screen rows are confusing
// to the user.
let studioSelectedIds = new Set();

// Single source of truth for the visibility bucket a row falls into.
// Used by both the chip-row counts and the per-row visibility pill
// so the two never disagree (e.g. chip says 1 Scheduled but the pill
// reads Processing — that's exactly the kind of drift this helper
// prevents).
function _studioDeriveVisibility(v) {
  const isReadyAndScheduled = v.status === 'ready'
    && !!v.scheduled_publish_at
    && new Date(v.scheduled_publish_at).getTime() > Date.now();
  if (isReadyAndScheduled) return 'scheduled';
  if (v.status === 'ready' || v.status === 'published') return 'published';
  if (v.status === 'uploading' || v.status === 'processing') return 'processing';
  if (v.status === 'unpublished') return 'private';
  if (v.status === 'failed' || v.status === 'error') return 'failed';
  return 'unknown';
}

// Numeric/string accessor for the sortable columns. Keeps the
// comparator in renderStudio one-liner clean.
function _studioGetSortValue(v, key) {
  if (key === 'views')    return (v.views_count ?? v.views ?? 0);
  if (key === 'likes')    return (v.likes_count ?? v.likes ?? 0);
  if (key === 'comments') return (v.comments_count ?? 0);
  if (key === 'earnings') return studioEarningsByVideoId.get(v.id) || 0;
  if (key === 'created_at') return new Date(v.created_at || 0).getTime();
  if (key === 'title')    return (v.title || '').toLowerCase();
  return 0;
}
let studioEditingVideoId = null;

// Lightweight client-side substitute for the scheduled-publish cron.
// Fires `publish_due_scheduled_videos()` at most once per 5 min whenever
// the user opens Studio — covers the case where no real cron is wired yet.
let _lastSchedulePublishCheck = 0;
function maybeFlushDueScheduledVideos() {
  const now = Date.now();
  if (now - _lastSchedulePublishCheck < 5 * 60 * 1000) return; // 5 min throttle
  _lastSchedulePublishCheck = now;
  // Fire-and-forget — never block UI on this.
  supabase.rpc('publish_due_scheduled_videos').then(({ error }) => {
    if (error) console.warn('publish_due_scheduled_videos:', error.message);
  }).catch(() => {});
}

export async function loadStudio() {
  const content = document.getElementById('studioContent');
  content.innerHTML = '<div class="empty"><h3>Loading your videos...</h3></div>';

  if (!_cfg.getCurrentUser()) {
    content.innerHTML = '<div class="empty"><h3>Please sign in</h3></div>';
    return;
  }

  // Background sweep: surface any scheduled videos whose publish time has passed.
  maybeFlushDueScheduledVideos();

  // Fetch videos + per-video earnings rows in parallel. We use the
  // earnings rows for TWO things:
  //   1. Header "Revenue" stat card = sum of net_php_minor.
  //   2. Per-row "Earnings" column = group rows by source_id then
  //      sum, populating a Map<videoId, php_minor>.
  // Net (not gross) so both surfaces reflect money the creator
  // actually keeps after the platform share.
  const earningsP = supabase
    .from('author_earnings')
    .select('source_id, net_php_minor')
    .eq('author_id', _cfg.getCurrentUser().id)
    .eq('source_type', 'video');

  const { data: videos, error } = await supabase
    .from('videos')
    // Engagement counters — read BOTH the canonical trigger-maintained
    // counters (views_count / likes_count / comments_count, kept fresh
    // by migration_videos_engagement_counts.sql, also what mobile's
    // CreatorVideoCard reads via the videoStats adapter) AND the bare
    // legacy columns (views, likes) for older rows that never got the
    // trigger backfill. The render code below prefers _count over the
    // bare column. Without this, Studio shows real views in the
    // legacy `views` column but always-zero likes — because the
    // `likes` bare column isn't maintained anywhere.
    .select('id, title, description, thumbnail_url, video_url, views, likes, views_count, likes_count, comments_count, duration, status, created_at, tags, category, bunny_video_id, is_locked, is_monetized, unlock_cost_coins, unlock_cost_stars, scheduled_publish_at, is_hidden')
    .eq('uploader_id', _cfg.getCurrentUser().id)
    .order('created_at', { ascending: false });
  
  if (error) {
    content.innerHTML = `<div class="empty"><h3>Error loading videos</h3><p>${escHTML(error.message)}</p></div>`;
    return;
  }
  
  studioVideosCache = videos || [];

  // Tally lifetime video revenue + build per-video earnings map.
  // Failure here isn't fatal — we just fall back to empty so the
  // rest of the Studio still renders cleanly.
  studioEarningsByVideoId.clear();
  studioRevenuePhpMinor = 0;
  try {
    const { data: earnRows } = await earningsP;
    for (const r of earnRows || []) {
      const cents = r.net_php_minor || 0;
      studioRevenuePhpMinor += cents;
      if (r.source_id) {
        studioEarningsByVideoId.set(
          r.source_id,
          (studioEarningsByVideoId.get(r.source_id) || 0) + cents,
        );
      }
    }
  } catch {
    // Map already cleared, total already 0 — nothing to do.
  }

  renderStudio();
}

function renderStudio() {
  const content = document.getElementById('studioContent');
  const videos = studioVideosCache;
  
  if (!videos.length) {
    content.innerHTML = `
      <div class="studio-empty">
        <div class="studio-empty-icon">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2"/>
          </svg>
        </div>
        <h3>No videos yet</h3>
        <p>Upload your first video to get started</p>
        <button class="vu-btn vu-btn-primary" onclick="document.getElementById('btnStudioUpload').click()" style="margin-top:1rem">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Upload your first video
        </button>
      </div>
    `;
    return;
  }
  
  const totalVideos = videos.length;
  // Prefer the trigger-maintained _count columns; fall back to the
  // bare legacy columns for older rows that pre-date the trigger
  // backfill. This mirrors how mobile's mapRowToVideo reads engagement.
  const totalViews = videos.reduce((sum, v) => sum + (v.views_count ?? v.views ?? 0), 0);
  const totalLikes = videos.reduce((sum, v) => sum + (v.likes_count ?? v.likes ?? 0), 0);
  // "Published" includes both the web-era 'ready' status and the
  // mobile-era 'published' status — same parity the visibility pill
  // applies below. Without including 'published' the header card
  // undercounts on profiles that have any mobile-uploaded rows.
  const publishedCount = videos.filter(v => {
    const isReadyAndScheduled = v.status === 'ready' && v.scheduled_publish_at && new Date(v.scheduled_publish_at).getTime() > Date.now();
    return (v.status === 'ready' || v.status === 'published') && !isReadyAndScheduled;
  }).length;
  
  // ── 1. Visibility chip counts (always computed on the full cache so
  // counts are stable as the user filters / searches). ──────────────
  const visibilityCounts = { all: videos.length, published: 0, scheduled: 0, processing: 0, private: 0, failed: 0 };
  for (const v of videos) {
    const bucket = _studioDeriveVisibility(v);
    if (visibilityCounts[bucket] != null) visibilityCounts[bucket]++;
  }

  // ── 2. Apply visibility chip filter ──────────────────────────────
  const afterChip = studioVisibilityFilter === 'all'
    ? videos
    : videos.filter(v => _studioDeriveVisibility(v) === studioVisibilityFilter);

  // ── 3. Apply text search ─────────────────────────────────────────
  const q = studioSearchQuery.trim().toLowerCase();
  const afterSearch = q
    ? afterChip.filter(v =>
        (v.title || '').toLowerCase().includes(q) ||
        (v.description || '').toLowerCase().includes(q) ||
        (v.tags || []).some(t => t.toLowerCase().includes(q))
      )
    : afterChip;

  // ── 4. Apply sort ────────────────────────────────────────────────
  // Don't sort in-place — the cache is the source of truth and shared
  // with the edit modal. Spread first.
  const sorted = [...afterSearch].sort((a, b) => {
    const av = _studioGetSortValue(a, studioSort.key);
    const bv = _studioGetSortValue(b, studioSort.key);
    if (av < bv) return studioSort.dir === 'asc' ? -1 : 1;
    if (av > bv) return studioSort.dir === 'asc' ? 1 : -1;
    return 0;
  });
  const filtered = sorted; // alias for downstream references

  // ── 5. Pagination. Clamp defensively. ────────────────────────────
  const totalPages   = Math.max(1, Math.ceil(filtered.length / studioPageSize));
  if (studioPageIdx > totalPages) studioPageIdx = totalPages;
  if (studioPageIdx < 1)          studioPageIdx = 1;
  const pageStart    = (studioPageIdx - 1) * studioPageSize;
  const pageEnd      = Math.min(pageStart + studioPageSize, filtered.length);
  const pageSlice    = filtered.slice(pageStart, pageEnd);
  // Human-readable "1–25 of 412" label for the toolbar.
  const rangeLabel   = filtered.length === 0
    ? '0 videos'
    : `${(pageStart + 1).toLocaleString()}–${pageEnd.toLocaleString()} of ${filtered.length.toLocaleString()}`;

  // ── 6. Bulk-selection helpers ────────────────────────────────────
  // Prune ids that no longer exist in the current visible slice so
  // the "Delete N" copy never lies. The set itself is preserved so a
  // user who filters down to processing, selects 3, then clears the
  // chip filter still has those 3 selected on the broader view.
  const visiblePageIds = new Set(pageSlice.map(v => v.id));
  const selectedOnPage = pageSlice.filter(v => studioSelectedIds.has(v.id));
  const allOnPageSelected = pageSlice.length > 0 && selectedOnPage.length === pageSlice.length;
  const someOnPageSelected = selectedOnPage.length > 0 && !allOnPageSelected;
  
  content.innerHTML = `
    <div class="studio-stats">
      <div class="studio-stat">
        <div class="studio-stat-icon" style="background:linear-gradient(135deg,#a855f7,#6366f1)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
        </div>
        <div>
          <div class="studio-stat-value">${totalVideos.toLocaleString()}</div>
          <div class="studio-stat-label">Total videos</div>
        </div>
      </div>
      <div class="studio-stat">
        <div class="studio-stat-icon" style="background:linear-gradient(135deg,#3b82f6,#06b6d4)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </div>
        <div>
          <div class="studio-stat-value">${totalViews.toLocaleString()}</div>
          <div class="studio-stat-label">Total views</div>
        </div>
      </div>
      <div class="studio-stat">
        <div class="studio-stat-icon" style="background:linear-gradient(135deg,#ec4899,#f43f5e)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </div>
        <div>
          <div class="studio-stat-value">${totalLikes.toLocaleString()}</div>
          <div class="studio-stat-label">Total likes</div>
        </div>
      </div>
      <button type="button" class="studio-stat studio-stat-clickable" id="studioStatRevenueBtn" title="View detailed earnings & withdraw">
        <div class="studio-stat-icon" style="background:linear-gradient(135deg,#22c55e,#10b981)">
          <!-- Peso glyph in a soft circle — same money cue as the
               monetize toggle, in green to keep the "earnings" semantic. -->
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 5h5.5a3.5 3.5 0 0 1 0 7H8"/>
            <line x1="6" y1="9" x2="14" y2="9"/>
            <line x1="6" y1="13" x2="11" y2="13"/>
            <line x1="8" y1="3" x2="8" y2="19"/>
          </svg>
        </div>
        <div class="studio-stat-text">
          <div class="studio-stat-value">${_cfg.formatPhpFromMinor(studioRevenuePhpMinor || 0)}</div>
          <div class="studio-stat-label">
            Revenue
            <span class="studio-stat-cta" aria-hidden="true">View earnings →</span>
          </div>
        </div>
      </button>
    </div>

    <div class="studio-filter-chips" role="tablist" aria-label="Filter and sort">
      ${[
        ['all',        'All'],
        ['published',  'Published'],
        ['scheduled',  'Scheduled'],
        ['processing', 'Processing'],
        ['private',    'Private'],
        ['failed',     'Failed'],
      ].map(([key, label]) => `
        <button type="button" class="studio-filter-chip studio-filter-chip-${key} ${studioVisibilityFilter === key ? 'is-selected' : ''}" data-filter="${key}" role="tab" aria-selected="${studioVisibilityFilter === key ? 'true' : 'false'}">
          ${label}<span class="studio-filter-chip-count">${(visibilityCounts[key] || 0).toLocaleString()}</span>
        </button>
      `).join('')}
    </div>

    <div class="studio-toolbar">
      <div class="studio-search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="studioSearchInput" placeholder="Search your videos..." value="${escHTML(studioSearchQuery)}"/>
      </div>
      <div class="studio-toolbar-info">${rangeLabel}${filtered.length !== totalVideos ? ` (filtered from ${totalVideos.toLocaleString()})` : ''}</div>
    </div>

    ${studioSelectedIds.size > 0 ? `
      <div class="studio-bulk-bar" role="region" aria-label="Bulk actions">
        <div class="studio-bulk-count">
          <strong>${studioSelectedIds.size.toLocaleString()}</strong> selected
        </div>
        <div class="studio-bulk-actions">
          <button type="button" class="studio-bulk-btn studio-bulk-btn-monetize" data-bulk-action="monetize-off" title="Disable monetization on selected">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><circle cx="12" cy="12" r="9"/></svg>
            Disable monetization
          </button>
          <button type="button" class="studio-bulk-btn studio-bulk-btn-delete" data-bulk-action="delete" title="Delete selected">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Delete
          </button>
          <button type="button" class="studio-bulk-btn studio-bulk-btn-clear" data-bulk-action="clear" title="Clear selection">
            Clear
          </button>
        </div>
      </div>
    ` : ''}

    <div class="studio-table-wrap">
      ${filtered.length === 0 ? `
        <div class="studio-empty" style="padding:3rem 1rem">
          <h3>${studioVisibilityFilter === 'all' && !q ? 'No videos' : 'No matches'}</h3>
          <p>${studioVisibilityFilter === 'all' && !q ? '' : 'Try a different filter or search term'}</p>
        </div>
      ` : `
        <table class="studio-table">
          <thead>
            <tr>
              <th class="studio-col-select">
                <input type="checkbox" class="studio-checkbox" id="studioSelectAll" ${allOnPageSelected ? 'checked' : ''} ${someOnPageSelected ? 'data-indeterminate="true"' : ''} aria-label="Select all on this page"/>
              </th>
              <th class="studio-col-num">#</th>
              <th class="studio-col-video studio-sortable ${studioSort.key === 'title' ? 'is-sorted' : ''}" data-sort-key="title">
                Video${studioSort.key === 'title' ? `<span class="studio-sort-icon ${studioSort.dir}">${studioSort.dir === 'asc' ? '↑' : '↓'}</span>` : '<span class="studio-sort-icon dim">↕</span>'}
              </th>
              <th class="studio-col-status">Visibility</th>
              <th class="studio-col-date studio-sortable ${studioSort.key === 'created_at' ? 'is-sorted' : ''}" data-sort-key="created_at">
                Date${studioSort.key === 'created_at' ? `<span class="studio-sort-icon ${studioSort.dir}">${studioSort.dir === 'asc' ? '↑' : '↓'}</span>` : '<span class="studio-sort-icon dim">↕</span>'}
              </th>
              <th class="studio-col-views studio-sortable ${studioSort.key === 'views' ? 'is-sorted' : ''}" data-sort-key="views">
                Views${studioSort.key === 'views' ? `<span class="studio-sort-icon ${studioSort.dir}">${studioSort.dir === 'asc' ? '↑' : '↓'}</span>` : '<span class="studio-sort-icon dim">↕</span>'}
              </th>
              <th class="studio-col-likes studio-sortable ${studioSort.key === 'likes' ? 'is-sorted' : ''}" data-sort-key="likes">
                Likes${studioSort.key === 'likes' ? `<span class="studio-sort-icon ${studioSort.dir}">${studioSort.dir === 'asc' ? '↑' : '↓'}</span>` : '<span class="studio-sort-icon dim">↕</span>'}
              </th>
              <th class="studio-col-comments">Comments</th>
              <th class="studio-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${pageSlice.map((v, i) => renderStudioRow(v, pageStart + i + 1, studioSelectedIds.has(v.id))).join('')}
          </tbody>
        </table>
      `}
    </div>
    ${filtered.length > 0 ? `
      <div class="studio-pagination">
        <div class="studio-pagination-pagesize">
          <span class="studio-pagination-label">Rows per page</span>
          <div class="studio-pagesize-group" role="radiogroup" aria-label="Rows per page">
            ${STUDIO_PAGE_SIZE_OPTIONS.map(n => `
              <button type="button" class="studio-pagesize-option ${n === studioPageSize ? 'is-selected' : ''}" data-pagesize="${n}" role="radio" aria-checked="${n === studioPageSize ? 'true' : 'false'}">${n}</button>
            `).join('')}
          </div>
        </div>
        <div class="studio-pagination-nav">
          <span class="studio-pagination-info">Page ${studioPageIdx} of ${totalPages}</span>
          <button type="button" class="studio-pagination-btn" data-page-action="prev" ${studioPageIdx <= 1 ? 'disabled' : ''} title="Previous page">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button type="button" class="studio-pagination-btn" data-page-action="next" ${studioPageIdx >= totalPages ? 'disabled' : ''} title="Next page">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>
    ` : ''}
  `;

  // Wire up search input
  const searchInput = document.getElementById('studioSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      studioSearchQuery = e.target.value;
      // Filter changed → reset to page 1 so we don't end up stuck on
      // page 7 of a 2-page filtered result set.
      studioPageIdx = 1;
      renderStudio();
      // Re-focus the input after re-render
      const newInput = document.getElementById('studioSearchInput');
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(studioSearchQuery.length, studioSearchQuery.length);
      }
    });
  }

  // Wire up pagination controls
  content.querySelectorAll('[data-pagesize]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = parseInt(btn.dataset.pagesize, 10);
      if (!STUDIO_PAGE_SIZE_OPTIONS.includes(next) || next === studioPageSize) return;
      studioPageSize = next;
      studioPageIdx = 1; // resize collapses page indices — start from the top
      localStorage.setItem('selebox_studio_page_size', String(next));
      renderStudio();
    });
  });
  content.querySelectorAll('[data-page-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.pageAction;
      if (dir === 'prev') studioPageIdx = Math.max(1, studioPageIdx - 1);
      else if (dir === 'next') studioPageIdx = studioPageIdx + 1; // clamp happens inside renderStudio
      renderStudio();
      // Scroll the table back to the top so the new page starts at row 1.
      const wrap = document.querySelector('#studioPage .studio-table-wrap');
      if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Wire the Revenue stat card → opens the dedicated Earnings page.
  // Uses the same _cfg.showEarnings() entry point as the sidebar's
  // Earnings button so the route, breadcrumbs, and sidebar active
  // state stay consistent.
  const revenueBtn = document.getElementById('studioStatRevenueBtn');
  if (revenueBtn) {
    revenueBtn.addEventListener('click', () => _cfg.showEarnings());
  }

  // Wire visibility filter chips
  content.querySelectorAll('[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      const next = chip.dataset.filter;
      if (next === studioVisibilityFilter) return;
      studioVisibilityFilter = next;
      studioPageIdx = 1;            // filter narrowed → start from page 1
      renderStudio();
    });
  });


  // Wire sortable header clicks. Same-key click → flip direction;
  // different-key click → switch key and start descending (default for
  // the visual sort metaphor "most first" — most views, newest date, etc).
  content.querySelectorAll('[data-sort-key]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (studioSort.key === key) {
        studioSort.dir = studioSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        studioSort.key = key;
        studioSort.dir = key === 'title' ? 'asc' : 'desc'; // titles read better A→Z, metrics most-first
      }
      studioPageIdx = 1;
      renderStudio();
    });
  });

  // Wire the page header checkbox: toggle all visible rows.
  const selectAll = document.getElementById('studioSelectAll');
  if (selectAll) {
    // The DOM doesn't accept an indeterminate attribute at parse time;
    // hydrate it imperatively from the data attribute the renderer set.
    if (selectAll.dataset.indeterminate === 'true') selectAll.indeterminate = true;
    selectAll.addEventListener('change', () => {
      if (selectAll.checked) {
        // Add every visible-page id to the selection set.
        pageSlice.forEach(v => studioSelectedIds.add(v.id));
      } else {
        // Drop just the visible-page ids; selections on other pages
        // (in case the user paged then came back) are preserved.
        pageSlice.forEach(v => studioSelectedIds.delete(v.id));
      }
      renderStudio();
    });
  }

  // Wire per-row checkboxes.
  content.querySelectorAll('.studio-row-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const id = cb.dataset.id;
      if (cb.checked) studioSelectedIds.add(id);
      else            studioSelectedIds.delete(id);
      renderStudio();
    });
  });

  // Wire bulk action bar.
  content.querySelectorAll('[data-bulk-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.bulkAction;
      const ids = Array.from(studioSelectedIds);
      if (action === 'clear') {
        studioSelectedIds.clear();
        renderStudio();
        return;
      }
      if (!ids.length) return;

      if (action === 'delete') {
        if (!confirm(`Delete ${ids.length} video${ids.length === 1 ? '' : 's'} forever? This can't be undone.`)) return;
        btn.disabled = true;
        const { error } = await supabase.from('videos').delete().in('id', ids);
        btn.disabled = false;
        if (error) { toast(error.message, 'error'); return; }
        // Prune local cache + clear selection so the UI converges
        // without an extra round-trip.
        studioVideosCache = studioVideosCache.filter(v => !ids.includes(v.id));
        studioSelectedIds.clear();
        toast(`Deleted ${ids.length} video${ids.length === 1 ? '' : 's'}`, 'success');
        renderStudio();
        return;
      }

      if (action === 'monetize-off') {
        btn.disabled = true;
        const { error } = await supabase.from('videos').update({ is_monetized: false }).in('id', ids);
        btn.disabled = false;
        if (error) { toast(error.message, 'error'); return; }
        // Patch the in-memory cache so the next render reflects the change.
        for (const v of studioVideosCache) if (ids.includes(v.id)) v.is_monetized = false;
        toast(`Monetization disabled on ${ids.length} video${ids.length === 1 ? '' : 's'}`, 'success');
        renderStudio();
        return;
      }
    });
  });

  // Wire up monetize/edit/delete buttons via delegation
  content.querySelectorAll('[data-studio-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.studioAction;
      const id = btn.dataset.id;
      if (action === 'edit')          openStudioEditModal(id);
      else if (action === 'delete')   deleteStudioVideo(id);
      else if (action === 'monetize') toggleStudioMonetize(id, btn);
      else if (action === 'share')    openStudioShareModal(id);
    });
  });
}

// Inline monetize toggle from the studio list — no need to open the edit modal.
// Same gate as the modal: video duration must be ≥ 3 min (else show why).
async function toggleStudioMonetize(videoId, btn) {
  const v = studioVideosCache.find(x => x.id === videoId);
  if (!v) return;
  const minSec = _cfg.getWalletConfig().video_initial_unlock_seconds || 180;

  // Already monetized → just turn it off (no gate needed)
  if (v.is_monetized) {
    btn.disabled = true;
    const { error } = await supabase.from('videos').update({ is_monetized: false }).eq('id', videoId);
    btn.disabled = false;
    if (error) { toast(error.message, 'error'); return; }
    v.is_monetized = false;
    btn.classList.remove('is-on');
    btn.title = 'Toggle monetization';
    toast('Monetization disabled', 'success');
    return;
  }

  // Turning on → check duration.
  //
  // If 0 (legacy/migrated rows that never had duration persisted), we
  // used to bounce the user into the Edit modal so it could auto-probe
  // the file. That's a friction tax for a one-tap action. Instead we
  // do the same client-side probe inline here, persist the discovered
  // duration back to the DB, then re-evaluate the gate and flip the
  // toggle without any modal in between. Mirrors the helper at
  // openStudioEditModal's auto-probe block.
  if (!v.duration || v.duration === 0) {
    if (!(v.video_url || v.videoUrl)) {
      toast('Missing video URL — cannot read duration.', 'error');
      return;
    }
    btn.disabled = true;
    const prevHTML = btn.querySelector('.studio-btn-peso')?.textContent;
    const peso = btn.querySelector('.studio-btn-peso');
    if (peso) peso.textContent = '…'; // small visual cue while we probe
    try {
      const real = await new Promise((resolve) => {
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.muted = true;
        probe.crossOrigin = 'anonymous';
        probe.style.display = 'none';
        probe.src = v.video_url || v.videoUrl;
        const done = (val) => { probe.remove(); resolve(val); };
        probe.onloadedmetadata = () => done(Math.round(probe.duration || 0));
        probe.onerror = () => done(0);
        document.body.appendChild(probe);
      });
      if (peso && prevHTML !== undefined) peso.textContent = prevHTML;
      btn.disabled = false;
      if (real > 0) {
        v.duration = real;
        // Persist so we never need to probe again for this row.
        try { await supabase.from('videos').update({ duration: real }).eq('id', videoId); } catch {}
      } else {
        toast('Could not read video duration. Try again in a moment.', 'error');
        return;
      }
    } catch {
      if (peso && prevHTML !== undefined) peso.textContent = prevHTML;
      btn.disabled = false;
      toast('Could not read video duration.', 'error');
      return;
    }
  }
  if (v.duration < minSec) {
    const mins = Math.floor(v.duration / 60);
    const secs = Math.floor(v.duration % 60);
    toast(`Video must be at least ${minSec/60} min to monetize. This one is ${mins}m ${secs}s.`, 'error');
    return;
  }

  // Eligible — flip it on
  btn.disabled = true;
  const { error } = await supabase.from('videos').update({ is_monetized: true }).eq('id', videoId);
  btn.disabled = false;
  if (error) { toast(error.message, 'error'); return; }
  v.is_monetized = true;
  btn.classList.add('is-on');
  btn.title = 'Monetized — click to disable';
  toast('Monetization enabled 💰', 'success');
}

function renderStudioRow(v, rowNumber, isSelected = false) {
  const thumb = v.thumbnail_url 
    ? `<img src="${escHTML(v.thumbnail_url)}" alt="" loading="lazy"/>` 
    : '<div class="studio-thumb-placeholder"></div>';
  const date = new Date(v.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const desc = v.description 
    ? `<div class="studio-row-desc">${escHTML(v.description.slice(0, 100))}${v.description.length > 100 ? '…' : ''}</div>` 
    : '<div class="studio-row-desc" style="color:#aaa;font-style:italic">No description</div>';
  // Visibility pill — derives from the shared _studioDeriveVisibility
  // helper so the chip-row counts and the per-row pill can never
  // disagree. Mirrors mobile's CreatorVideoCard mapping.
  const _bucket = _studioDeriveVisibility(v);
  const _badgeMap = {
    published:  { cls: 'studio-badge-published',  dot: 'studio-dot-green',  label: 'Published' },
    scheduled:  { cls: 'studio-badge-scheduled',  dot: 'studio-dot-purple', label: 'Scheduled' },
    processing: { cls: 'studio-badge-processing', dot: 'studio-dot-yellow', label: v.status === 'uploading' ? 'Uploading' : 'Processing' },
    private:    { cls: 'studio-badge-private',    dot: 'studio-dot-red',    label: 'Private' },
    failed:     { cls: 'studio-badge-failed',     dot: 'studio-dot-red',    label: v.status === 'failed' ? 'Failed' : 'Error' },
    unknown:    { cls: 'studio-badge-processing', dot: 'studio-dot-yellow', label: v.status || 'Unknown' },
  };
  const _b = _badgeMap[_bucket] || _badgeMap.unknown;
  const statusBadge = `<span class="studio-badge ${_b.cls}"><span class="studio-dot ${_b.dot}"></span>${_b.label}</span>`;
  const duration = v.duration ? _cfg.formatDuration(v.duration) : '';
  
  return `
    <tr data-video-id="${v.id}" class="${isSelected ? 'is-selected' : ''}">
      <td class="studio-col-select-cell">
        <input type="checkbox" class="studio-checkbox studio-row-checkbox" data-id="${v.id}" ${isSelected ? 'checked' : ''} aria-label="Select video"/>
      </td>
      <td class="studio-col-num-cell">${rowNumber != null ? rowNumber.toLocaleString() : ''}</td>
      <td>
        <div class="studio-row-video">
          <div class="studio-thumb">
            ${thumb}
            ${duration ? `<span class="studio-thumb-duration">${duration}</span>` : ''}
          </div>
          <div class="studio-row-text">
            <div class="studio-row-title">${escHTML(v.title || 'Untitled')}</div>
            ${desc}
          </div>
        </div>
      </td>
      <td class="studio-col-status">${statusBadge}</td>
      <td class="studio-col-date"><span class="studio-cell-muted">${date}</span></td>
      <td class="studio-col-views">${((v.views_count ?? v.views) || 0).toLocaleString()}</td>
      <td class="studio-col-likes">${((v.likes_count ?? v.likes) || 0).toLocaleString()}</td>
      <td class="studio-col-comments">${(v.comments_count || 0).toLocaleString()}</td>
      <td class="studio-col-actions">
        <div class="studio-actions">
          <button class="studio-btn studio-btn-monetize ${v.is_monetized ? 'is-on' : ''}" data-studio-action="monetize" data-id="${v.id}" title="${v.is_monetized ? 'Monetized — click to disable' : 'Toggle monetization'}">
            <span class="studio-btn-peso" aria-hidden="true">₱</span>
          </button>
          <button class="studio-btn" data-studio-action="edit" data-id="${v.id}" title="Edit details">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <!-- Share to feed — drafts a post (with or without schedule)
               that embeds this video. Useful for announcing scheduled
               videos: pick the same publish time for the post and the
               video, both go live together. See openStudioShareModal(). -->
          <button class="studio-btn" data-studio-action="share" data-id="${v.id}" title="Share to feed / schedule a post">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          </button>
          <button class="studio-btn studio-btn-danger" data-studio-action="delete" data-id="${v.id}" title="Delete forever">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `;
}

// Custom thumbnail state for the studio edit modal (May 2026). When
// the author picks a new image we upload it immediately so by the time
// they hit Save, the only DB write needed is the videos row update.
// `null` means "no pending change" — the existing thumbnail_url stays.
let studioEditPendingThumbnailUrl = null;
let _studioEditThumbUploadToken = 0;

function _renderStudioEditThumb(currentUrl) {
  const tile    = document.getElementById('studioEditThumbTile');
  const picker  = document.getElementById('studioEditThumbPicker');
  const img     = document.getElementById('studioEditThumb');
  const empty   = document.getElementById('studioEditThumbEmpty');
  const overlay = document.getElementById('studioEditThumbOverlay');
  const title   = document.getElementById('studioEditThumbMetaTitle');
  const sub     = document.getElementById('studioEditThumbMetaSub');
  const replace = document.getElementById('studioEditThumbReplace');
  if (!tile || !img || !empty) return;
  const url = studioEditPendingThumbnailUrl || currentUrl || null;
  if (url) {
    img.src = url;
    img.style.display = '';
    empty.style.display = 'none';
    if (overlay) overlay.style.display = '';
    if (title) title.textContent = studioEditPendingThumbnailUrl ? 'New thumbnail (unsaved)' : 'Current thumbnail';
    if (sub)   sub.textContent   = 'Click the tile to upload a new cover. JPG/PNG/WebP, up to 5 MB.';
    if (replace) replace.textContent = studioEditPendingThumbnailUrl ? 'Replace image' : 'Change image';
  } else {
    img.src = '';
    img.style.display = 'none';
    empty.style.display = '';
    if (overlay) overlay.style.display = 'none';
    if (title) title.textContent = 'No thumbnail set';
    if (sub)   sub.textContent   = 'Add a cover so your video stands out on the home feed.';
    if (replace) replace.textContent = 'Choose image';
  }
  if (picker) picker.classList.remove('is-uploading');
}

async function _studioEditHandleThumbPick(file) {
  if (!file) return;
  const myToken = ++_studioEditThumbUploadToken;
  const picker = document.getElementById('studioEditThumbPicker');
  const sub    = document.getElementById('studioEditThumbMetaSub');
  picker?.classList.add('is-uploading');
  if (sub) sub.textContent = 'Uploading thumbnail…';
  try {
    const url = await _cfg.uploadThumbnail(file);
    if (myToken !== _studioEditThumbUploadToken) return;
    if (url) {
      studioEditPendingThumbnailUrl = url;
      toast('Thumbnail uploaded — click Save to apply', 'success');
    }
  } finally {
    if (myToken === _studioEditThumbUploadToken) {
      const v = studioVideosCache.find(x => x.id === studioEditingVideoId);
      _renderStudioEditThumb(v?.thumbnail_url || null);
    }
  }
}

document.getElementById('studioEditThumbFile')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  _studioEditHandleThumbPick(file);
});
document.getElementById('studioEditThumbReplace')?.addEventListener('click', () => {
  document.getElementById('studioEditThumbFile')?.click();
});

function openStudioEditModal(videoId) {
  const v = studioVideosCache.find(x => x.id === videoId);
  if (!v) return;

  studioEditingVideoId = videoId;
  // Clear any leftover pending thumbnail from a previous edit session.
  studioEditPendingThumbnailUrl = null;
  _studioEditThumbUploadToken++;

  document.getElementById('studioEditTitle').value = v.title || '';
  document.getElementById('studioEditDescription').value = v.description || '';
  document.getElementById('studioEditTags').value = (v.tags || []).join(', ');
  // Category dropdown removed — see videoUploadCategory comment above.

  // Render the thumbnail tile in its starting state. The new
  // .vu-thumb-picker component (defined alongside the upload-wizard
  // picker) replaces the static .vu-preview-box that used to sit here.
  _renderStudioEditThumb(v.thumbnail_url || null);

  document.getElementById('studioEditTitleCount').textContent = `${(v.title || '').length} / 100`;
  document.getElementById('studioEditDescCount').textContent = `${(v.description || '').length} / 2000`;

  // Monetization toggle (Phase 6: time-based, not gated-from-start).
  // Gate: monetize requires duration >= 3 min, since the first paid threshold
  // is the 3:00 mark — a 2-min video could never trigger an unlock.
  const monCb     = document.getElementById('studioEditMonetized');
  const monLabel  = monCb?.closest('.lock-toggle');
  const minSec    = _cfg.getWalletConfig().video_initial_unlock_seconds || 180;

  // Helper: render the gate state given a duration in seconds.
  const applyGate = (duration) => {
    const eligible = (duration || 0) >= minSec;
    if (!monCb) return;
    monCb.checked  = !!v.is_monetized && eligible;
    monCb.disabled = !eligible;
    if (monLabel) monLabel.classList.toggle('is-disabled', !eligible);
    const subEl = monLabel?.querySelector('.lock-toggle-sub');
    if (!subEl) return;
    if (duration == null) {
      subEl.textContent = 'Reading video duration…';
    } else if (eligible) {
      subEl.innerHTML = 'Free for the first 3 minutes. After that, viewers pay <strong>1 coin</strong> for permanent access, or <strong>1 star every 10 minutes</strong> they keep watching.';
    } else {
      subEl.textContent = `Video must be at least ${Math.floor(minSec/60)} minute${minSec/60 === 1 ? '' : 's'} long to monetize. This one is ${Math.floor((duration||0)/60)}m ${Math.floor((duration||0)%60)}s.`;
    }
  };

  // Initial render with whatever the DB has (may be 0 for legacy/migrated videos)
  applyGate(v.duration || 0);

  // Backfill from the actual video file if duration is missing or zero.
  // Reads metadata client-side, then UPDATEs the videos row so the gate works
  // immediately and stays correct on future opens.
  if (!v.duration && (v.video_url || v.videoUrl)) {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted   = true;
    probe.crossOrigin = 'anonymous';
    probe.style.display = 'none';
    probe.src = v.video_url || v.videoUrl;
    const cleanup = () => probe.remove();
    probe.onloadedmetadata = async () => {
      const real = Math.round(probe.duration || 0);
      if (real > 0) {
        v.duration = real;       // patch in-memory cache so save sees the right value
        applyGate(real);
        // Persist back to DB so we don't probe again on next open
        try {
          await supabase.from('videos').update({ duration: real }).eq('id', studioEditingVideoId);
        } catch {}
      }
      cleanup();
    };
    probe.onerror = () => { applyGate(0); cleanup(); };
    document.body.appendChild(probe);
  }

  document.getElementById('studioEditModal').style.display = 'flex';
}

function closeStudioEditModal() {
  document.getElementById('studioEditModal').style.display = 'none';
  studioEditingVideoId = null;
  // Drop any unsaved thumbnail upload — the file already lives in
  // Supabase Storage but isn't pointed at by any row, so it'll be
  // garbage-collected by the bucket-cleanup job.
  studioEditPendingThumbnailUrl = null;
  _studioEditThumbUploadToken++;
}

async function saveStudioEdit() {
  if (!studioEditingVideoId) return;

  const saveBtn = document.getElementById('studioEditSave');
  const originalLabel = saveBtn.textContent;

  const setSaving = (saving) => {
    if (saving) {
      saveBtn.classList.add('is-saving');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving';
    } else {
      saveBtn.classList.remove('is-saving');
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  };

  const title = document.getElementById('studioEditTitle').value.trim();
  const description = document.getElementById('studioEditDescription').value.trim();
  const tagsRaw = document.getElementById('studioEditTags').value;
  // Category dropdown removed — see videoUploadCategory comment.

  if (!title) {
    toast('Title is required', 'error');
    return;
  }

  setSaving(true);

  const tags = tagsRaw.split(',').map(t => t.trim()).filter(t => t);

  // Monetization toggle (Phase 6 replaces is_locked for new videos)
  const isMonetized = document.getElementById('studioEditMonetized')?.checked || false;

  // Only write thumbnail_url when the author actually picked a new
  // image. Including it unconditionally would overwrite the current
  // value with the same string — harmless but pointless DB write — and
  // would conflict with any in-flight bunny-video-ready webhook that's
  // updating other columns on the same row.
  const updatePayload = {
    title, description, tags,
    is_monetized: isMonetized,
    updated_at: new Date().toISOString(),
  };
  if (studioEditPendingThumbnailUrl) {
    updatePayload.thumbnail_url = studioEditPendingThumbnailUrl;
  }

  const { error } = await supabase
    .from('videos')
    .update(updatePayload)
    .eq('id', studioEditingVideoId);

  setSaving(false);

  if (error) {
    toast('Failed to save: ' + error.message, 'error');
    return;
  }

  toast('Saved', 'success');
  closeStudioEditModal();

  // Invalidate caches and reload
  _cfg.invalidateAllVideosCache();
  loadStudio();
}

// ════════════════════════════════════════════════════════════════════════
// Share-to-feed modal — opened from the Creator Studio actions column.
// Lets the creator post a feed announcement with the video attached as
// an embedded card. The post can be scheduled for the same time as the
// video (Charles's typical workflow: schedule the video, then schedule
// the announcement post to drop at the same moment).
//
// Uses the existing submit_post RPC mobile uses, so the feed rendering
// stays consistent across web + mobile. Attaching the video via
// p_video_id makes the feed card show the video thumbnail + title
// rather than a bare URL.
// ════════════════════════════════════════════════════════════════════════
function openStudioShareModal(videoId) {
  const v = studioVideosCache.find(x => x.id === videoId);
  if (!v) { toast('Video not found in cache', 'error'); return; }
  if (!_cfg.getCurrentUser()?.id) { toast('Please sign in first', 'error'); return; }

  // Build the public URL using the same format the in-app share menu uses
  // (see line ~17271): /#video/sb_<uuid>. Kept here only for display in
  // the modal — the actual post attaches the video via p_video_id so
  // the feed renders a rich embed, not a bare URL.
  const shareUrl = `${window.location.origin}/#video/sb_${v.id}`;
  const thumbUrl = v.thumbnail_url || '';
  const title    = v.title || '(untitled video)';

  // Default schedule input: 1 hour from now, rounded down to the
  // minute. <input type="datetime-local"> wants 'YYYY-MM-DDTHH:mm' in
  // LOCAL time (no timezone suffix); we convert back to UTC at submit.
  const oneHourLater = new Date(Date.now() + 60 * 60 * 1000);
  oneHourLater.setSeconds(0, 0);
  const tzOffMs   = oneHourLater.getTimezoneOffset() * 60 * 1000;
  const defaultLocal = new Date(oneHourLater.getTime() - tzOffMs).toISOString().slice(0, 16);

  // Build modal DOM. 2026-05-15: the original implementation reused
  // .admin-modal-backdrop + .admin-modal classes from admin.css. That
  // stylesheet isn't loaded on index.html (only admin.html), so the
  // modal rendered as flat inline HTML at the bottom of the page.
  // Inlining the overlay + card styles here so the modal works
  // regardless of which stylesheets the host page has loaded.
  //
  // Premium pass (2026-05-15): purple accent on Share button (matches
  // the brand's --purple token), purple-tinted shadow, larger radius,
  // gradient on the active row, photo-attach affordance alongside the
  // video tile.
  const backdrop = document.createElement('div');
  backdrop.className = 'admin-modal-backdrop';
  backdrop.style.cssText = `
    position: fixed; inset: 0; z-index: 1100;
    background: rgba(10, 10, 31, 0.7);
    display: flex; align-items: center; justify-content: center;
    padding: 1rem; backdrop-filter: blur(6px);
    animation: studioShareFadeIn 180ms ease-out;
  `;
  // One-time keyframes injection (cheap; re-injecting is idempotent in
  // browsers — the duplicate <style> tag has no effect).
  if (!document.getElementById('studioShareModalKeyframes')) {
    const kf = document.createElement('style');
    kf.id = 'studioShareModalKeyframes';
    kf.textContent = `
      @keyframes studioShareFadeIn { from { opacity: 0 } to { opacity: 1 } }
      @keyframes studioShareSlideUp {
        from { opacity: 0; transform: translateY(12px) scale(0.98) }
        to   { opacity: 1; transform: translateY(0) scale(1) }
      }
      #studioShareSubmit:hover {
        transform: translateY(-1px);
        box-shadow: 0 6px 20px rgba(139, 92, 246, 0.45) !important;
      }
      #studioShareSubmit:active { transform: translateY(0); }
      .studio-share-photo-btn:hover {
        border-color: var(--purple) !important;
        color: var(--purple) !important;
      }
    `;
    document.head.appendChild(kf);
  }
  backdrop.innerHTML = `
    <div class="admin-modal" role="dialog" aria-modal="true"
         style="max-width:560px;width:100%;padding:1.6rem 1.75rem 1.5rem;
                position:relative;background:var(--bg2);color:var(--text);
                border:1px solid var(--border2);border-radius:18px;
                box-shadow:0 25px 60px rgba(139, 92, 246, 0.18),
                           0 12px 28px rgba(0, 0, 0, 0.35);
                max-height:90vh;overflow-y:auto;
                animation: studioShareSlideUp 220ms cubic-bezier(0.16, 1, 0.3, 1)">
      <button type="button" aria-label="Close" id="studioShareClose"
              style="position:absolute;top:1rem;right:1.1rem;background:transparent;border:none;cursor:pointer;color:var(--text2);font-size:1.5rem;line-height:1;padding:0.25rem 0.5rem;border-radius:8px;transition:color 120ms,background 120ms">×</button>

      <!-- Premium header with subtle purple accent bar -->
      <div style="display:flex;align-items:center;gap:0.6rem;margin-bottom:0.35rem">
        <div style="width:3px;height:18px;border-radius:2px;background:linear-gradient(180deg, var(--purple-lt) 0%, var(--purple) 100%)"></div>
        <h3 style="margin:0;font-size:1.18rem;font-weight:700;letter-spacing:-0.01em;color:var(--text)">Share to feed</h3>
      </div>
      <p style="margin:0 0 1.1rem;color:var(--text2);font-size:0.87rem;line-height:1.45">Draft a post that links to this video. Add a photo, then publish now or schedule it.</p>

      <!-- Video preview tile (purple-tinted top border for premium feel) -->
      <div style="display:flex;gap:0.85rem;align-items:flex-start;padding:0.85rem;border:1px solid var(--border2);border-top:2px solid var(--purple);border-radius:12px;background:var(--bg3);margin-bottom:1rem">
        ${thumbUrl
          ? `<img src="${escHTML(thumbUrl)}" alt="" style="width:88px;height:88px;border-radius:10px;object-fit:cover;flex-shrink:0"/>`
          : `<div style="width:88px;height:88px;border-radius:10px;background:var(--bg4);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text2);font-size:11px">No thumb</div>`}
        <div style="min-width:0;flex:1">
          <div style="font-weight:600;color:var(--text);margin-bottom:0.3rem;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.35">${escHTML(title)}</div>
          <div style="font-size:0.74rem;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace" title="${escHTML(shareUrl)}">${escHTML(shareUrl)}</div>
        </div>
      </div>

      <!-- Caption -->
      <label style="display:block;font-size:0.74rem;font-weight:600;color:var(--text2);margin-bottom:0.4rem;text-transform:uppercase;letter-spacing:0.04em">Caption (optional)</label>
      <textarea id="studioShareCaption" rows="3"
                placeholder="What should the post say?"
                maxlength="2000"
                style="width:100%;resize:vertical;font-family:inherit;padding:10px 12px;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:10px;font-size:14px;line-height:1.5;transition:border-color 140ms"></textarea>

      <!-- Photo attach (2026-05-15) — optional supplementary image -->
      <div style="margin-top:1rem">
        <label style="display:block;font-size:0.74rem;font-weight:600;color:var(--text2);margin-bottom:0.45rem;text-transform:uppercase;letter-spacing:0.04em">Photo (optional)</label>
        <div id="studioSharePhotoSlot">
          <button type="button" class="studio-share-photo-btn" id="studioSharePhotoBtn"
                  style="display:inline-flex;align-items:center;gap:0.5rem;padding:8px 14px;background:transparent;color:var(--text2);border:1px dashed var(--border2);border-radius:10px;font-size:13px;cursor:pointer;font-family:inherit;transition:border-color 140ms,color 140ms">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            Add photo
          </button>
          <input type="file" accept="image/*" id="studioSharePhotoInput" style="display:none"/>
        </div>
      </div>

      <!-- When to publish -->
      <!-- When to publish -->
      <div style="margin-top:1.15rem">
        <label style="display:block;font-size:0.74rem;font-weight:600;color:var(--text2);margin-bottom:0.55rem;text-transform:uppercase;letter-spacing:0.04em">When</label>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.9rem;color:var(--text);margin-bottom:0.55rem;cursor:pointer">
          <input type="radio" name="studioSharePublishWhen" value="now" checked style="accent-color:var(--purple)"/>
          Publish now
        </label>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.9rem;color:var(--text);cursor:pointer">
          <input type="radio" name="studioSharePublishWhen" value="schedule" style="accent-color:var(--purple)"/>
          Schedule for later
        </label>
        <div id="studioShareScheduleRow" style="display:none;margin-top:0.7rem;padding-left:1.5rem">
          <input type="datetime-local" id="studioShareScheduleAt"
                 value="${defaultLocal}" min="${defaultLocal}"
                 style="font-family:inherit;padding:8px 12px;background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:10px;font-size:14px"/>
          <div style="font-size:0.72rem;color:var(--text2);margin-top:0.4rem;line-height:1.4">Post will go live at the chosen time. Pair with your video's schedule for a coordinated drop.</div>
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:0.6rem;margin-top:1.5rem;padding-top:1.1rem;border-top:1px solid var(--border2)">
        <button type="button" id="studioShareCancel"
                style="background:transparent;color:var(--text2);border:1px solid var(--border2);border-radius:10px;padding:9px 18px;font-size:14px;cursor:pointer;font-family:inherit;font-weight:500;transition:border-color 120ms,color 120ms">Cancel</button>
        <button type="button" id="studioShareSubmit"
                style="background:linear-gradient(135deg, var(--purple-lt) 0%, var(--purple) 50%, var(--purple-dk) 100%);color:#fff;border:none;border-radius:10px;padding:9px 22px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:0 3px 14px rgba(139, 92, 246, 0.35);transition:transform 120ms,box-shadow 120ms;letter-spacing:0.01em">Share</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector('#studioShareClose').addEventListener('click', close);
  backdrop.querySelector('#studioShareCancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  // ─── Photo attach (2026-05-15) ─────────────────────────────────────────
  // The picker stays hidden; the "Add photo" button triggers it. After a
  // file is picked, the slot swaps to a preview tile with a × remove.
  // The actual upload happens on Share submit (so we don't pollute Bunny
  // storage with photos for shares the user ultimately cancels).
  let attachedPhotoFile = null;
  const photoBtn   = backdrop.querySelector('#studioSharePhotoBtn');
  const photoInput = backdrop.querySelector('#studioSharePhotoInput');
  const photoSlot  = backdrop.querySelector('#studioSharePhotoSlot');
  photoBtn.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    attachedPhotoFile = file;
    const reader = new FileReader();
    reader.onload = (ev) => {
      photoSlot.innerHTML = `
        <div style="display:inline-flex;align-items:center;gap:0.6rem;padding:6px 6px 6px 6px;background:var(--bg3);border:1px solid var(--purple);border-radius:10px">
          <img src="${ev.target.result}" alt="" style="width:48px;height:48px;border-radius:7px;object-fit:cover"/>
          <span style="font-size:13px;color:var(--text);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHTML(file.name)}">${escHTML(file.name)}</span>
          <button type="button" id="studioSharePhotoRemove" aria-label="Remove photo"
                  style="background:transparent;border:none;cursor:pointer;color:var(--text2);font-size:1.2rem;line-height:1;padding:0 0.4rem;border-radius:6px">×</button>
        </div>
      `;
      photoSlot.querySelector('#studioSharePhotoRemove').addEventListener('click', () => {
        attachedPhotoFile = null;
        photoInput.value = '';
        // Restore the "Add photo" button.
        photoSlot.innerHTML = '';
        photoSlot.appendChild(photoBtn);
        photoSlot.appendChild(photoInput);
      });
    };
    reader.readAsDataURL(file);
  });

  // ESC handler scoped to this modal — remove on close.
  const onEsc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);

  // Toggle the datetime row when the radio changes.
  backdrop.querySelectorAll('input[name="studioSharePublishWhen"]').forEach(r => {
    r.addEventListener('change', () => {
      const isScheduled = backdrop.querySelector('input[name="studioSharePublishWhen"]:checked').value === 'schedule';
      backdrop.querySelector('#studioShareScheduleRow').style.display = isScheduled ? '' : 'none';
    });
  });

  // Submit handler.
  backdrop.querySelector('#studioShareSubmit').addEventListener('click', async () => {
    const submitBtn = backdrop.querySelector('#studioShareSubmit');
    const caption   = backdrop.querySelector('#studioShareCaption').value.trim();
    const when      = backdrop.querySelector('input[name="studioSharePublishWhen"]:checked').value;
    const schedAt   = backdrop.querySelector('#studioShareScheduleAt').value;

    let scheduledIso = null;
    if (when === 'schedule') {
      if (!schedAt) { toast('Pick a date/time to schedule', 'error'); return; }
      // datetime-local input gives 'YYYY-MM-DDTHH:mm' in local time;
      // new Date(...) interprets that as local, then toISOString() emits UTC.
      const d = new Date(schedAt);
      if (Number.isNaN(d.getTime())) { toast('Invalid date/time', 'error'); return; }
      if (d.getTime() <= Date.now()) { toast('Schedule time must be in the future', 'error'); return; }
      scheduledIso = d.toISOString();
    }

    submitBtn.disabled = true;
    submitBtn.textContent = attachedPhotoFile
      ? 'Uploading photo…'
      : (when === 'schedule' ? 'Scheduling…' : 'Posting…');

    // Upload the optional photo first (only when attached). We do this
    // here rather than on file-pick so cancelling the modal doesn't
    // leak files into Bunny.
    let attachedImageUrl = null;
    if (attachedPhotoFile) {
      try {
        attachedImageUrl = await _cfg.uploadImage(attachedPhotoFile);
      } catch (err) {
        toast(`Photo upload failed: ${err?.message || err}`, 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Share';
        return;
      }
      if (!attachedImageUrl) {
        toast('Photo upload failed', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Share';
        return;
      }
      submitBtn.textContent = when === 'schedule' ? 'Scheduling…' : 'Posting…';
    }

    // Call the same RPC the mobile composer uses. p_video_id attaches
    // the video so the feed renders a rich card (thumbnail + title)
    // rather than a bare URL in the body. p_image_url is the optional
    // supplementary photo (uploaded just above). p_is_hidden +
    // p_scheduled_publish_at implement the scheduled-publish flow —
    // a pg_cron job flips is_hidden=false at scheduled_publish_at time.
    try {
      const { data, error } = await supabase.rpc('submit_post', {
        p_actor_id:            _cfg.getCurrentUser().id,
        p_body:                caption,
        p_image_url:           attachedImageUrl,
        p_video_id:            v.id,
        p_book_id:             null,
        p_reposted_from:       null,
        p_legacy_appwrite_id:  null,
        p_is_hidden:           when === 'schedule',
        p_scheduled_publish_at: scheduledIso,
      });
      if (error) { toast(`Share failed: ${error.message}`, 'error'); return; }
      if (data?.error) { toast(`Share failed: ${data.error}`, 'error'); return; }
      toast(when === 'schedule' ? 'Post scheduled' : 'Posted!', 'success');
      close();
    } catch (err) {
      toast(`Share threw: ${err?.message || err}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Share';
    }
  });
}

async function deleteStudioVideo(videoId) {
  const v = studioVideosCache.find(x => x.id === videoId);
  if (!v) return;

  const ok = await _cfg.confirmDialog({
    title: `Delete "${v.title || 'this video'}"?`,
    body: 'This permanently removes the video from your feed and Bunny storage. This can\'t be undone.',
    confirmLabel: 'Delete forever',
  });
  if (!ok) return;
  
  // Show loading state on the row
  const row = document.querySelector(`tr[data-video-id="${videoId}"]`);
  if (row) row.style.opacity = '0.4';
  
  try {
    // 1. Call Edge Function to delete from Bunny + Supabase videos table
    await callEdgeFunction('bunny-delete', { videoId });
    
    // 2. Also delete any post that links to this video
    await supabase.from('posts').delete().eq('video_id', videoId);
    
    // 3. Update local cache
    studioVideosCache = studioVideosCache.filter(x => x.id !== videoId);
    
    // 4. Invalidate other caches
    _cfg.invalidateAllVideosCache();
    
    toast('Video deleted', 'success');
    renderStudio();
    
    // 5. Refresh feed if it's open
    _cfg.refreshFeedIfVisible();
  } catch (err) {
    console.error('Delete failed:', err);
    toast('Failed to delete: ' + err.message, 'error');
    if (row) row.style.opacity = '1';
  }
}

// Wire up edit modal events
document.getElementById('studioEditClose')?.addEventListener('click', closeStudioEditModal);
document.getElementById('studioEditCancel')?.addEventListener('click', closeStudioEditModal);
document.getElementById('studioEditSave')?.addEventListener('click', saveStudioEdit);
document.getElementById('studioEditModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'studioEditModal') closeStudioEditModal();
});

// Live char counters in edit modal
document.getElementById('studioEditTitle')?.addEventListener('input', (e) => {
  document.getElementById('studioEditTitleCount').textContent = `${e.target.value.length} / 100`;
});
document.getElementById('studioEditDescription')?.addEventListener('input', (e) => {
  document.getElementById('studioEditDescCount').textContent = `${e.target.value.length} / 2000`;
});

// Studio upload button → trigger same upload modal as Videos page
document.getElementById('btnStudioUpload')?.addEventListener('click', () => {
  document.getElementById('btnUploadVideo')?.click();
});
