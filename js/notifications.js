// ════════════════════════════════════════════════════════════════════════
// Selebox notifications — extracted from js/app.js as Stage 1 of the
// refactor roadmap (2026-05-15). This module owns:
//   • The bell badge, panel, and list rendering
//   • Realtime subscription to public.notifications inserts/updates
//   • Facebook-style grouping ("Alice and N others...")
//   • Click routing (tap → route to the right surface)
//   • Sound chime + tab-title flash for new arrivals
//
// CAREFUL: this is pure code movement, not a rewrite. If you see something
// you want to "improve while you're here" — DON'T. Open a separate task.
// The whole point of the Stage 1 discipline is "translation, not interpretation."
//
// See REFACTOR_ROADMAP.md and REFACTOR_STAGE1_PLAN.md.
// ════════════════════════════════════════════════════════════════════════

import {
  supabase,
  escHTML,
  initials,
  timeAgo,
} from './supabase.js';

// ─── Config-injection dependency surface ──────────────────────────────────
// Instead of importing _cfg.getCurrentUser() + navigation functions from app.js
// (which creates a circular ES module dependency and triggers the
// `realtime:public-feed cannot add postgres_changes after subscribe()`
// error at module load time), app.js INJECTS them when it calls
// initNotifications(config) on sign-in.
//
//   config.getCurrentUser()  →  returns the live _cfg.getCurrentUser() object
//   config.nav.profile(id)
//   config.nav.post(id)
//   config.nav.video(id)
//   config.nav.book(id)
//   config.nav.conversation(id)
//   config.nav.messages()
//   config.nav.feed()
//   config.nav.home()
//   config.nav.earnings(forceReload)
//   config.nav.sidebarActive(buttonId)
//
// If a navigation method is called before initNotifications() runs, the
// call no-ops (the bell isn't open anyway). Defensive default below.
let _cfg = {
  getCurrentUser: () => null,
  nav: {
    profile:        () => {},
    post:           () => {},
    video:          () => {},
    book:           () => {},
    conversation:   () => {},
    messages:       () => {},
    feed:           () => {},
    home:           () => {},
    earnings:       () => {},
    sidebarActive:  () => {},
  },
};

// Adapter helpers so existing code inside this module can keep reading
// `_cfg.getCurrentUser()` and calling navigation functions with the same names.
// Using getters means the value is re-read on every access (live
// binding) — important for _cfg.getCurrentUser() which gets reassigned on sign-in.
function openProfile(id)            { return _cfg.nav.profile(id); }
function openPostFromSearch(id)     { return _cfg.nav.post(id); }
function playVideo(id)              { return _cfg.nav.video(id); }
function openBookDetail(id)         { return _cfg.nav.book(id); }
function openConversation(id)       { return _cfg.nav.conversation(id); }
function showMessages()             { return _cfg.nav.messages(); }
function showFeed()                 { return _cfg.nav.feed(); }
function showHomeLanding()          { return _cfg.nav.home(); }
function showEarnings(forceReload)  { return _cfg.nav.earnings(forceReload); }
function setSidebarActive(id)       { return _cfg.nav.sidebarActive(id); }


const NOTIF_PAGE_SIZE = 25;
let _notifications = [];
let _notifUnreadCount = 0;
let _notifChannel = null;
let _notifPanelOpen = false;
let _notifFilter = 'all';      // 'all' | 'you' | 'following'
const _notifActorCache = {};   // user_id → { username, avatar_url }
// Resource hydration cache — { "kind:id": { title, thumbnail } }.
// 2-minute TTL via _notifResourceCacheAt so a refresh picks up
// renamed videos / updated book covers without a full reload.
// Mirrors mobile's lib/notifications-supabase.js:227-360.
const _notifResourceCache = new Map();
const _notifResourceCacheAt = new Map();
const NOTIF_RESOURCE_TTL_MS = 2 * 60 * 1000;
// Infinite-scroll cursor: oldest loaded created_at. Pagination is
// cursor-based (`.lt('created_at', _notifCursor)`) — mirrors mobile's
// `lastId`-style pager but keyed on timestamps since our query is
// ordered by created_at desc.
let _notifCursor = null;
let _notifHasMore = false;
let _notifLoadingMore = false;
// Guard: only mark-as-read once per panel-open. Prevents redundant
// UPDATEs if the user opens/closes/opens the panel quickly.
let _notifMarkedReadThisOpen = false;

// ─── Sound chime + tab-title flash (May 2026) ────────────────────────
// Sound state persisted in localStorage so the user's preference
// survives reloads. Tab-title flash uses Visibility API: only mutate
// document.title when the tab is hidden — restore on focus.
let _notifSoundMuted = localStorage.getItem('selebox_notif_muted') === '1';
let _notifTitleFlashTimer = null;
let _notifTitleOriginal   = null;
let _notifTitleFlashCount = 0;

// One-shot WebAudio beep — no asset file required. Tiny envelope so
// it doesn't startle, mid-frequency so it carries on cheap speakers.
let _notifAudioCtx = null;
function _playNotifChime() {
  if (_notifSoundMuted) return;
  try {
    if (!_notifAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      _notifAudioCtx = new Ctx();
    }
    const ctx = _notifAudioCtx;
    // Some browsers suspend the AudioContext until user interaction;
    // try to resume but don't break if it stays suspended.
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const now = ctx.currentTime;
    // Two-tone chime: 880 Hz then 1175 Hz, ~70ms each.
    const make = (freq, start, dur) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      // Quick attack + decay envelope so it sounds like a chime, not a buzz.
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.18, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      o.connect(g).connect(ctx.destination);
      o.start(start);
      o.stop(start + dur);
    };
    make(880,  now,         0.08);
    make(1175, now + 0.075, 0.10);
  } catch (e) {
    // Don't crash the realtime handler on a sound hiccup.
  }
}

// Tab title flasher — when the tab is hidden, swap the title to
// "(N) Selebox" and oscillate the prefix between "(N)" and a bullet
// so the OS tab title flashes the user's attention. Resets on
// visibilitychange.
function _startNotifTitleFlash() {
  if (!document.hidden) return;
  if (!_notifTitleOriginal) _notifTitleOriginal = document.title.replace(/^\(\d+\) /, '').replace(/^[•●] /, '');
  _notifTitleFlashCount = _notifUnreadCount;
  if (_notifTitleFlashTimer) clearInterval(_notifTitleFlashTimer);
  let toggle = false;
  _notifTitleFlashTimer = setInterval(() => {
    toggle = !toggle;
    document.title = toggle
      ? `(${_notifTitleFlashCount}) ${_notifTitleOriginal}`
      : `• ${_notifTitleOriginal}`;
  }, 1100);
}
function _stopNotifTitleFlash() {
  if (_notifTitleFlashTimer) { clearInterval(_notifTitleFlashTimer); _notifTitleFlashTimer = null; }
  if (_notifTitleOriginal)   { document.title = _notifTitleOriginal; _notifTitleOriginal = null; }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) _stopNotifTitleFlash();
});

// Wire the sound-mute toggle (button lives in the notif panel header).
// The icon swap (speaker-on / speaker-off) reflects current state.
function _syncNotifSoundIcon() {
  const btn = document.getElementById('notifSoundToggle');
  if (!btn) return;
  const on  = btn.querySelector('.notif-sound-on');
  const off = btn.querySelector('.notif-sound-off');
  if (on)  on.style.display  = _notifSoundMuted ? 'none' : '';
  if (off) off.style.display = _notifSoundMuted ? ''     : 'none';
  btn.setAttribute('aria-pressed', _notifSoundMuted ? 'true' : 'false');
  btn.title = _notifSoundMuted ? 'Unmute notification sounds' : 'Mute notification sounds';
}
document.getElementById('notifSoundToggle')?.addEventListener('click', (e) => {
  e.stopPropagation();
  _notifSoundMuted = !_notifSoundMuted;
  localStorage.setItem('selebox_notif_muted', _notifSoundMuted ? '1' : '0');
  _syncNotifSoundIcon();
});
_syncNotifSoundIcon();

// ─── Time bucketing (May 2026) ───────────────────────────────────────
// Group the rendered list into Today / Yesterday / This week / Older
// section headers. Cheap render-time logic on existing created_at —
// no schema or query changes.
function _notifTimeBucket(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'older';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfThisWeek  = startOfToday - 6 * 86400000; // last 7 calendar days including today
  const t = d.getTime();
  if (t >= startOfToday)     return 'today';
  if (t >= startOfYesterday) return 'yesterday';
  if (t >= startOfThisWeek)  return 'thisweek';
  return 'older';
}
const _NOTIF_BUCKET_LABELS = {
  today:     'Today',
  yesterday: 'Yesterday',
  thisweek:  'This week',
  older:     'Older',
};

// Categorize a notification for the filter tabs.
// Mirrors mobile's `categorizeNotification`
// (app/(notification)/notification.jsx:21-34). Maps to web's
// underscored type strings:
//   "you"       — something happened TO you (your content or your
//                  relationship): likes, comments, replies, mentions,
//                  follow (somebody followed you), dm_message,
//                  reposts of your stuff.
//   "following" — somebody you follow CREATED something new
//                  (follow_new_post/video/book, follow_repost).
//   "all"       — fall-through; only visible in the All tab.
function notifCategory(n) {
  const t = (n?.type || '').toLowerCase();
  if (!t) return 'all';
  if (t === 'follow_new_post' || t === 'follow_new_video'
      || t === 'follow_new_book' || t === 'follow_repost') {
    return 'following';
  }
  if (t === 'follow' || t === 'dm_message') return 'you';
  if (t.includes('comment') || t.includes('reply')
      || t.startsWith('like_') || t.endsWith('_like')
      || t.startsWith('mention_')
      || t === 'post_repost' || t === 'repost_post') {
    return 'you';
  }
  return 'all';
}

export async function initNotifications(config) {
  if (config) _cfg = config;
  if (!_cfg.getCurrentUser()) return;

  await loadNotifications();

  // Realtime — subscribe to new notifications for this user only
  if (_notifChannel) {
    try { supabase.removeChannel(_notifChannel); } catch {}
    _notifChannel = null;
  }
  try {
    _notifChannel = supabase
      .channel(`notif:${_cfg.getCurrentUser().id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${_cfg.getCurrentUser().id}`,
      }, async (payload) => {
        const n = payload.new;
        // Fetch the actor profile AND target resource (thumbnail +
        // title) so the bell card paints with full context.
        await Promise.all([
          hydrateActorProfiles([n]),
          hydrateNotifResources([n]),
        ]);
        _notifications.unshift(n);
        if (_notifications.length > 100) _notifications.length = 100;
        _notifUnreadCount += 1;
        updateNotifBadge();
        // Re-run grouping so the new row buckets with existing ones
        // (e.g. follow:any bucket merges all "started following you"
        // notifications). Without this, every realtime INSERT
        // rendered as its own row, breaking the Facebook-style
        // "Alice and 4 others started following you" UX. Grouping is
        // idempotent — safe to re-run over an already-grouped set.
        _notifications = groupNotifications(_notifications);
        renderNotifications();
        // New incoming notification → audible + visual cue. Chime
        // muted via the per-user toggle; title flash only when tab
        // is in the background (no point flashing the visible tab).
        _playNotifChime();
        if (document.hidden) _startNotifTitleFlash();
        // No toast on incoming notifications — the bell badge + dropdown
        // already surfaces them. Toast was too intrusive (especially for DMs
        // where the unread badge on the Messages sidebar entry is enough).
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${_cfg.getCurrentUser().id}`,
      }, async (payload) => {
        // Coalesced DM notifications: an existing unread row is being bumped
        // (preview/timestamp updated). Replace the row in-place — DON'T re-increment
        // the badge (it was already counted on first INSERT).
        const n = payload.new;
        await Promise.all([
          hydrateActorProfiles([n]),
          hydrateNotifResources([n]),
        ]);
        const idx = _notifications.findIndex(x => x.id === n.id);
        if (idx >= 0) {
          _notifications[idx] = n;
        } else {
          _notifications.unshift(n);
        }
        // Re-sort by created_at desc so the bumped row floats to the top
        _notifications.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        // Re-group so the bumped row buckets correctly (same reasoning
        // as the INSERT handler above). Idempotent.
        _notifications = groupNotifications(_notifications);
        renderNotifications();
      })
      .subscribe();
  } catch (err) {
    console.warn('Notifications realtime subscribe failed:', err);
  }
}

async function loadNotifications() {
  const list = document.getElementById('notificationsList');
  if (list) list.innerHTML = _notifSkeletonHTML();

  // Reset pagination state on every cold load.
  _notifCursor = null;
  _notifHasMore = false;
  _notifMarkedReadThisOpen = false;

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('recipient_id', _cfg.getCurrentUser().id)
    .order('created_at', { ascending: false })
    .limit(NOTIF_PAGE_SIZE);

  if (error) {
    if (list) list.innerHTML = `<div class="notifications-empty">Couldn't load notifications</div>`;
    console.warn('Notifications fetch error:', error);
    return;
  }
  let raw = data || [];

  // Suppress dm_message notifications whose conversation is Secret. The
  // user discovers Secret messages by opening the Secret tab; they never
  // appear in the bell. We collect all dm_message conversation IDs and
  // bulk-fetch the is_secret flag in one query, then drop the matching
  // notifications.
  raw = await _filterSecretDmConversations(raw);

  _notifications = raw;
  // Advance cursor + hasMore from the fetched window.
  if (_notifications.length) _notifCursor = _notifications[_notifications.length - 1].created_at;
  _notifHasMore = raw.length === NOTIF_PAGE_SIZE;

  // Resolve actor profiles + target resources (post/video/book/chapter
  // titles + thumbnails) in parallel — both needed for first paint.
  await Promise.all([
    hydrateActorProfiles(_notifications),
    hydrateNotifResources(_notifications),
  ]);

  // Compute unread count from RAW rows BEFORE grouping. Grouping
  // collapses N rows into 1, so counting after grouping would
  // under-report the badge (5 unread comments on the same post would
  // show as "1" instead of "5"). Unread badge mirrors what the user
  // would see if grouping were turned off — every individual unread
  // notification counts.
  _notifUnreadCount = _notifications.filter(n => !n.is_read).length;
  updateNotifBadge();

  // Facebook-style grouping (May 2026) — see groupNotifications below.
  // Mobile (selebox-mobile-main) ships the same pass in
  // lib/notifications-supabase.js. Keeping web + mobile parallel so the
  // bell experience matches across platforms.
  _notifications = groupNotifications(_notifications);
  renderNotifications();
}

// Filter out dm_message notifications whose conversation is Secret.
// Pulled into its own helper so loadMoreNotifications can reuse it.
async function _filterSecretDmConversations(rows) {
  const dmConvIds = Array.from(new Set(
    rows
      .filter(n => n.type === 'dm_message' && n.parent_target_type === 'conversation' && n.parent_target_id)
      .map(n => n.parent_target_id),
  ));
  if (!dmConvIds.length) return rows;
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, is_secret')
    .in('id', dmConvIds);
  const secretSet = new Set((convs || []).filter(c => c.is_secret).map(c => c.id));
  if (secretSet.size === 0) return rows;
  return rows.filter(n => !(n.type === 'dm_message' && secretSet.has(n.parent_target_id)));
}

// Fetch the next page using `.lt('created_at', _notifCursor)`. Called
// from the scroll-near-bottom handler installed by openNotifPanel.
async function loadMoreNotifications() {
  if (!_cfg.getCurrentUser() || !_notifHasMore || _notifLoadingMore || !_notifCursor) return;
  _notifLoadingMore = true;
  // Render a tiny "loading more" footer immediately so the user gets
  // visual feedback before the round-trip resolves.
  _renderNotifLoadMoreFooter(true);

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('recipient_id', _cfg.getCurrentUser().id)
    .lt('created_at', _notifCursor)
    .order('created_at', { ascending: false })
    .limit(NOTIF_PAGE_SIZE);

  _notifLoadingMore = false;
  if (error) {
    console.warn('Notifications loadMore error:', error);
    _renderNotifLoadMoreFooter(false);
    return;
  }
  let raw = data || [];
  raw = await _filterSecretDmConversations(raw);

  if (raw.length === 0) {
    _notifHasMore = false;
    _renderNotifLoadMoreFooter(false);
    return;
  }

  // Merge into the existing list. Re-build _notifications by taking
  // the RAW (pre-grouping) source — we don't have that anymore, so
  // re-run grouping over the appended set. Simpler than maintaining a
  // separate raw cache.
  // Track the raw rows we already have by id to avoid duplicates when
  // a realtime INSERT hit and the row is now also in the loadMore page.
  const seen = new Set(_notifications.map(n => n.id));
  const fresh = raw.filter(n => !seen.has(n.id));

  // Hydrate actors + resources for the new rows.
  await Promise.all([
    hydrateActorProfiles(fresh),
    hydrateNotifResources(fresh),
  ]);

  // Append, advance cursor + hasMore.
  _notifications = _notifications.concat(fresh);
  if (raw.length) _notifCursor = raw[raw.length - 1].created_at;
  _notifHasMore = raw.length === NOTIF_PAGE_SIZE;

  // Re-group the merged set. Grouping is idempotent.
  _notifications = groupNotifications(_notifications);

  // Mobile parity (May 2026) — refresh the unread badge from the
  // just-merged + grouped set. Mirrors mobile's notif fetch chain in
  // selebox-mobile-main/lib/notifications-supabase.js, which calls
  // updateNotifBadge() after every batch so the dot count stays
  // accurate as load-more pages arrive.
  _notifUnreadCount = _notifications.filter(n => !n.is_read).length;
  updateNotifBadge();

  renderNotifications();
}

// Skeleton rows shown during the initial load — same visual mass as
// the real items so the panel doesn't jump when data arrives.
function _notifSkeletonHTML() {
  const skel = `
    <div class="notification-item notification-skeleton">
      <div class="notification-avatar skel-block"></div>
      <div class="notification-body">
        <div class="skel-line skel-line-1"></div>
        <div class="skel-line skel-line-2"></div>
      </div>
      <div class="notification-thumb skel-block"></div>
    </div>`;
  return skel.repeat(5);
}

function _renderNotifLoadMoreFooter(isLoading) {
  const list = document.getElementById('notificationsList');
  if (!list) return;
  let footer = list.querySelector('.notif-loadmore-footer');
  if (!_notifHasMore && !isLoading) {
    if (footer) footer.remove();
    return;
  }
  if (!footer) {
    footer = document.createElement('div');
    footer.className = 'notif-loadmore-footer';
    list.appendChild(footer);
  }
  footer.innerHTML = isLoading
    ? '<div class="notif-loadmore-spinner">Loading more…</div>'
    : '';
}

// Resource hydration — port of mobile's hydrateResources (see
// lib/notifications-supabase.js:227-360). Batches one SELECT per
// resource kind. Hits a 2-minute TTL cache so realtime INSERTs +
// load-more pages don't redundantly re-query. Each cache entry has
// { title, thumbnail }; renderNotifications reads from this map.
async function hydrateNotifResources(rows) {
  if (!rows || !rows.length) return;
  const now = Date.now();

  // Resolve the SURFACE id for each row. Comments target the comment
  // row, but the actual openable resource lives in parent_target_*.
  const buckets = { post: new Set(), video: new Set(), book: new Set(), chapter: new Set() };

  const KIND_MAP = {
    // surface mapping for direct target_type
    post: 'post', video: 'video', book: 'book',
    chapter: 'chapter', 'book-chapter': 'chapter',
  };

  for (const n of rows) {
    // Comment-type rows: hydrate the parent surface (the post/video/
    // chapter the comment was made on) so the bell card gets a
    // thumbnail and clicks land on the openable resource.
    let kind = n.target_type;
    let id   = n.target_id;
    if (kind === 'comment' && n.parent_target_type && n.parent_target_id) {
      kind = n.parent_target_type;
      id   = n.parent_target_id;
    }
    const surface = KIND_MAP[kind];
    if (!surface || !id) continue;
    const cacheKey = `${surface}:${id}`;
    // Skip if cached AND not stale.
    const ts = _notifResourceCacheAt.get(cacheKey);
    if (ts && now - ts < NOTIF_RESOURCE_TTL_MS) continue;
    buckets[surface].add(id);
  }

  const tasks = [];

  if (buckets.post.size) {
    tasks.push((async () => {
      const ids = [...buckets.post];
      const { data, error } = await supabase
        .from('posts')
        .select('id, body, image_url, video_id, videos(id, thumbnail_url)')
        .in('id', ids);
      if (error) { console.warn('[hydrateNotifResources:post]', error.message); return; }
      for (const p of data || []) {
        _notifResourceCache.set(`post:${p.id}`, {
          title: p.body ? p.body.slice(0, 80) : null,
          thumbnail: p.image_url || p.videos?.thumbnail_url || null,
        });
        _notifResourceCacheAt.set(`post:${p.id}`, now);
      }
    })());
  }
  if (buckets.video.size) {
    tasks.push((async () => {
      const { data, error } = await supabase
        .from('videos')
        .select('id, title, thumbnail_url')
        .in('id', [...buckets.video]);
      if (error) { console.warn('[hydrateNotifResources:video]', error.message); return; }
      for (const v of data || []) {
        _notifResourceCache.set(`video:${v.id}`, { title: v.title || null, thumbnail: v.thumbnail_url || null });
        _notifResourceCacheAt.set(`video:${v.id}`, now);
      }
    })());
  }
  if (buckets.book.size) {
    tasks.push((async () => {
      const { data, error } = await supabase
        .from('books')
        .select('id, title, cover_url')
        .in('id', [...buckets.book]);
      if (error) { console.warn('[hydrateNotifResources:book]', error.message); return; }
      for (const b of data || []) {
        _notifResourceCache.set(`book:${b.id}`, { title: b.title || null, thumbnail: b.cover_url || null });
        _notifResourceCacheAt.set(`book:${b.id}`, now);
      }
    })());
  }
  if (buckets.chapter.size) {
    tasks.push((async () => {
      const { data, error } = await supabase
        .from('chapters')
        .select('id, title, cover_url, book_id, books(id, cover_url)')
        .in('id', [...buckets.chapter]);
      if (error) { console.warn('[hydrateNotifResources:chapter]', error.message); return; }
      for (const c of data || []) {
        _notifResourceCache.set(`chapter:${c.id}`, {
          title: c.title || null,
          // Chapter cover may be null — fall back to the parent book's
          // cover so the bell card still renders something.
          thumbnail: c.cover_url || c.books?.cover_url || null,
        });
        _notifResourceCacheAt.set(`chapter:${c.id}`, now);
      }
    })());
  }

  await Promise.all(tasks);
}

// Helper for renderNotifications — looks up the cached resource for
// a notification row (or null). Resolves comment-type rows via their
// parent surface.
function _notifResourceFor(n) {
  let kind = n.target_type;
  let id   = n.target_id;
  if (kind === 'comment' && n.parent_target_type && n.parent_target_id) {
    kind = n.parent_target_type;
    id   = n.parent_target_id;
  }
  const KIND_TO_KEY = { post: 'post', video: 'video', book: 'book', chapter: 'chapter', 'book-chapter': 'chapter' };
  const k = KIND_TO_KEY[kind];
  if (!k || !id) return null;
  return _notifResourceCache.get(`${k}:${id}`) || null;
}

// ─────────────────────────────────────────────────────────────────────────
// Facebook-style notification grouping
// ─────────────────────────────────────────────────────────────────────────
// Collapses same-type-same-target rows into one bell entry so the panel
// stays clean when many users engage with the same post/video/book.
//
// Rules:
//   - All-time window. We don't bucket by recency window — every row in
//     the loaded page that shares (type, target) merges. (Pagination
//     limits how far back we go, but anything in `raw` is fair game.)
//   - Group: comments / replies on the same post / video / chapter,
//     reactions on the same post / video / book / comment, and ALL
//     follow events into one bucket (follows have target_id=NULL — the
//     trigger can't tie them to a resource — so per the product call we
//     collapse them globally per recipient).
//   - Timestamp = most recent action. The newest entry's created_at
//     becomes the head's timestamp, so the grouped row floats up the
//     bell list as new actors join.
//
// Output shape:
//   - head row with `actor_ids` set to the deduplicated list of actors
//     across all buckets entries (the existing notificationLabel
//     renderer already reads `actor_ids` and produces "X, Y and N
//     others" — no renderer change needed).
//   - `_grouped_source_ids` = every row's id in the bucket. Used by
//     onNotificationClick to mark all underlying rows read in one
//     UPDATE round-trip.
//   - is_read = true only when EVERY underlying entry is read.
//
// Anything not bucketable (mention_comment, dm_message, follow_new_post,
// follow_new_video, follow_new_book, follow_repost, default) passes
// through unchanged so it keeps its existing behavior.
function _notifGroupKey(n) {
  const t = n?.type || '';

  // Bare "X started following you" — single global bucket per recipient.
  // No target to key on, but the user explicitly asked to merge them.
  if (t === 'follow') return 'follow:any';

  // Reactions / likes — one bucket per liked target.
  if (t === 'like_post' || t === 'post_like') {
    return n.target_id ? `like-post:${n.target_id}` : null;
  }
  if (t === 'like_video' || t === 'video_like') {
    return n.target_id ? `like-video:${n.target_id}` : null;
  }
  if (t === 'like_book' || t === 'book_like') {
    return n.target_id ? `like-book:${n.target_id}` : null;
  }
  if (t === 'like_comment' || t === 'post_comment_like' || t === 'video_comment_like') {
    return n.target_id ? `like-comment:${n.target_id}` : null;
  }

  // Comments + replies — comments and replies on the same post merge
  // into one bucket because the user-facing verb is the same ("X and Y
  // commented on your post"). If we wanted to split them ("X commented"
  // vs "Y replied to your comment"), we'd add a `:reply` suffix here.
  if (t === 'comment_post' || t === 'post_comment' || t === 'reply_comment'
      || t === 'post_comment_reply' || t === 'video_comment_reply') {
    if (t === 'reply_comment' || t === 'post_comment_reply' || t === 'video_comment_reply') {
      // reply_comment carries parent_target_id = the post/video the
      // parent comment lives on. Group with comment_post / comment_video
      // by that id when present.
      return n.parent_target_id ? `comment-post:${n.parent_target_id}` : (n.target_id ? `reply:${n.target_id}` : null);
    }
    return n.target_id ? `comment-post:${n.target_id}` : null;
  }
  if (t === 'comment_video' || t === 'video_comment') {
    return n.target_id ? `comment-video:${n.target_id}` : null;
  }
  if (t === 'comment_chapter' || t === 'chapter_comment'
      || t === 'reply_chapter_comment' || t === 'chapter_comment_reply') {
    return n.target_id ? `comment-chapter:${n.target_id}` : null;
  }

  return null; // not groupable — passes through
}

export function groupNotifications(rows) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];

  const buckets = new Map();
  const passThrough = [];

  for (const n of rows) {
    const key = _notifGroupKey(n);
    if (!key) { passThrough.push(n); continue; }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(n);
  }

  const grouped = [];
  for (const entries of buckets.values()) {
    if (entries.length === 1) {
      grouped.push(entries[0]);
      continue;
    }
    // Newest first — head's timestamp wins.
    entries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const head = entries[0];

    // Dedupe actors. Same person commenting twice on a post counts
    // once — matches Facebook's behavior where one actor never appears
    // twice in a grouped row's actor list.
    const seen = new Set();
    const actor_ids = [];
    for (const e of entries) {
      const id = e?.actor_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      actor_ids.push(id);
    }

    grouped.push({
      ...head,
      actor_ids,
      _grouped_source_ids: entries.map(e => e?.id).filter(Boolean),
      is_read: entries.every(e => !!e?.is_read),
    });
  }

  // Re-sort everything by created_at desc to keep grouped rows in the
  // right chronological position relative to ungrouped ones.
  const all = [...grouped, ...passThrough];
  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return all;
}

async function hydrateActorProfiles(items) {
  // Collect ALL actor ids (primary + coalesced others) so the
  // "Alice and Bob reacted" label can resolve every name.
  const allIds = new Set();
  items.forEach(n => {
    if (n.actor_id) allIds.add(n.actor_id);
    if (Array.isArray(n.actor_ids)) {
      n.actor_ids.forEach(id => { if (id) allIds.add(id); });
    }
  });
  const ids = [...allIds].filter(id => !_notifActorCache[id]);
  if (!ids.length) return;
  const { data } = await supabase.from('profiles').select('id, username, avatar_url').in('id', ids);
  (data || []).forEach(p => { _notifActorCache[p.id] = p; });
}

function updateNotifBadge() {
  const badge = document.getElementById('notifBadge');
  const bell  = document.getElementById('btnNotifications');
  if (!badge || !bell) return;
  if (_notifUnreadCount > 0) {
    badge.style.display = 'flex';
    badge.textContent = _notifUnreadCount > 99 ? '99+' : String(_notifUnreadCount);
    bell.classList.add('has-unread');
    // Re-trigger animation
    bell.classList.remove('has-unread');
    void bell.offsetWidth;
    bell.classList.add('has-unread');
  } else {
    badge.style.display = 'none';
    bell.classList.remove('has-unread');
  }
}

function renderNotifications() {
  const list = document.getElementById('notificationsList');
  if (!list) return;

  const visible = _notifFilter === 'all'
    ? _notifications
    : _notifications.filter(n => notifCategory(n) === _notifFilter);

  if (!visible.length) {
    const msg = _notifications.length === 0
      ? `<p style="margin:0;font-size:0.85rem">You're all caught up.</p>
         <p style="margin:0.35rem 0 0;font-size:0.75rem;color:var(--text3)">When someone reacts, comments, replies, or someone you follow posts, it'll show up here.</p>`
      : (_notifFilter === 'you'
          ? `<p style="margin:0;font-size:0.85rem">No activity on your content yet.</p>
             <p style="margin:0.35rem 0 0;font-size:0.75rem;color:var(--text3)">Reactions and comments on your posts/books will appear here.</p>`
          : `<p style="margin:0;font-size:0.85rem">Nothing from people you follow yet.</p>
             <p style="margin:0.35rem 0 0;font-size:0.75rem;color:var(--text3)">When someone you follow posts, uploads, or publishes, you'll see it here.</p>`);
    list.innerHTML = `<div class="notifications-empty">${msg}</div>`;
    return;
  }

  // Build the rendered HTML by walking visible in order, inserting
  // a section header whenever the time bucket changes. Visible is
  // already sorted desc by created_at (Today → Older), so a single
  // pass with a "lastBucket" tracker is enough.
  let lastBucket = null;
  list.innerHTML = visible.map(n => {
    const bucket = _notifTimeBucket(n.created_at);
    const headerHTML = bucket !== lastBucket
      ? `<div class="notif-bucket-header">${_NOTIF_BUCKET_LABELS[bucket] || ''}</div>`
      : '';
    lastBucket = bucket;
    const actor = _notifActorCache[n.actor_id] || {};
    // Privacy treatment (lock avatar, "Someone sent you a private
    // message", no preview) is reserved for SECRET-CHAT DMs only. The
    // is_secret flag is written by the chat-bell trigger
    // (migration_notifications_dm_secret_flag.sql) and backfilled for
    // existing rows. Regular DMs render with the real sender, real
    // avatar, and the normal "X sent you a message" label so the bell
    // doesn't lie about who's chatting with you.
    const isPrivateDm = n.type === 'dm_message' && n.metadata?.is_secret === true;
    const avatar = isPrivateDm
      ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
      : (actor.avatar_url
          ? `<img src="${escHTML(actor.avatar_url)}"/>`
          : (actor.username ? initials(actor.username) : '?'));
    const text = isPrivateDm
      ? 'Someone sent you a private message'
      : notificationLabel(n, actor.username);
    // Resource thumbnail + title — pulled from _notifResourceCache,
    // populated by hydrateNotifResources. Skipped for private DMs
    // (their content is the whole point of being private) and for
    // notifications without an openable surface (follow, mention with
    // no parent, etc.). Mirrors mobile's NotificationCard right-side
    // 48px thumbnail.
    const resource = isPrivateDm ? null : _notifResourceFor(n);
    const thumbHTML = resource && resource.thumbnail
      ? `<div class="notification-thumb"><img src="${escHTML(resource.thumbnail)}" alt="" loading="lazy"/></div>`
      : '';
    // Snippets reveal context — also hidden for Secret DMs.
    // Prefer the resolved resource title when it's richer than the
    // metadata snippet; falls back to the metadata for legacy rows
    // where hydration didn't find anything.
    const snippet = isPrivateDm ? '' : (resource?.title || n.metadata?.snippet || n.metadata?.caption || '');
    const snippetHTML = snippet
      ? `<div class="notification-snippet">"${escHTML(snippet.slice(0, 120))}"</div>`
      : '';
    return `${headerHTML}
      <div class="notification-item ${n.is_read ? '' : 'unread'}${isPrivateDm ? ' notification-private' : ''}" data-id="${n.id}">
        <div class="notification-avatar">${avatar}</div>
        <div class="notification-body">
          <div class="notification-text">${text}</div>
          ${snippetHTML}
          <div class="notification-time">${timeAgo(n.created_at)}</div>
        </div>
        ${thumbHTML}
        <span class="notification-dot"></span>
      </div>`;
  }).join('');

  // Re-attach the load-more footer (if there's more to fetch) after
  // the list rebuild, since innerHTML wiped it.
  if (_notifHasMore) _renderNotifLoadMoreFooter(false);

  list.querySelectorAll('.notification-item').forEach(item => {
    item.addEventListener('click', () => onNotificationClick(item.dataset.id));
  });
}

function notificationLabel(n, knownUsername) {
  // Build the actor display: 1 = "Alice", 2 = "Alice and Bob",
  // 3+ = "Alice and N others". Uses actor_ids when present (coalesced
  // engagement notifications), otherwise falls back to the single actor_id.
  const ids = (Array.isArray(n.actor_ids) && n.actor_ids.length)
    ? n.actor_ids
    : (n.actor_id ? [n.actor_id] : []);
  const names = ids
    .map(id => _notifActorCache[id]?.username)
    .filter(Boolean);
  const fallbackName = knownUsername || _notifActorCache[n.actor_id]?.username || 'Someone';
  let actorTag;
  if (names.length === 0) {
    actorTag = `<strong>${escHTML(fallbackName)}</strong>`;
  } else if (names.length === 1) {
    actorTag = `<strong>${escHTML(names[0])}</strong>`;
  } else if (names.length === 2) {
    actorTag = `<strong>${escHTML(names[0])}</strong> and <strong>${escHTML(names[1])}</strong>`;
  } else {
    actorTag = `<strong>${escHTML(names[0])}</strong> and <strong>${names.length - 1} others</strong>`;
  }
  const titleHint = n.metadata?.title ? ` <em style="color:var(--text2)">"${escHTML(n.metadata.title)}"</em>` : '';
  switch (n.type) {
    // ── You: engagement on your stuff ──
    case 'like_post':
    case 'post_like':              // legacy noun_verb, pre-rename migration
      return `${actorTag} reacted to your post`;
    case 'like_video':
    case 'video_like':             // legacy
      return `${actorTag} reacted to your video`;
    case 'like_comment':
    case 'post_comment_like':      // legacy
    case 'video_comment_like':     // legacy
      return `${actorTag} reacted to your comment`;
    case 'like_book':
    case 'book_like':              // legacy
      return `${actorTag} liked your book${titleHint}`;
    case 'comment_post':
    case 'post_comment':           // legacy
      return `${actorTag} commented on your post`;
    case 'comment_video':
    case 'video_comment':          // legacy
      return `${actorTag} commented on your video`;
    case 'reply_comment':
    case 'post_comment_reply':     // legacy
    case 'video_comment_reply':    // legacy
      return `${actorTag} replied to your comment`;
    case 'comment_chapter':
    case 'chapter_comment':        // legacy
      return `${actorTag} commented on your chapter`;
    case 'reply_chapter_comment':
    case 'chapter_comment_reply':  // legacy
      return `${actorTag} replied to your chapter comment`;
    // Book-level comments (the conversation thread on the book itself,
    // not a chapter). Mobile renders these distinctly via the
    // `book-comment` / `book-comment-reply` keys; web previously fell
    // through to the "did something on Selebox" default. Both
    // verb_noun and legacy noun_verb shapes covered.
    case 'comment_book':
    case 'book_comment':
      return `${actorTag} commented on your book${titleHint}`;
    case 'reply_book_comment':
    case 'book_comment_reply':
      return `${actorTag} replied to your book comment`;
    // Inline-comment notifications — annotations attached to a
    // specific passage inside a chapter (highlighted-text comments).
    // Mobile routes these to /book-reading with anchorKey to scroll
    // to the passage; web doesn't have a chapter anchor yet, so the
    // click handler routes to the book detail as an acceptable
    // degradation. Three legacy variants covered for safety.
    case 'book_chapter_inline_comment':
    case 'book_chapter_inline_comment_reply':
    case 'book_chapter_inline_comment_mention':
      return `${actorTag} commented on a passage in your chapter`;
    case 'repost_post':
    case 'post_repost':            // legacy
      return `${actorTag} reposted your post`;
    // ── Follows ──
    // The notify_on_follow trigger fires this on every new row in
    // public.follows. Earlier we keyed off 'follow_new_post' /
    // 'follow_new_video' / 'follow_new_book' for the more specialized
    // "person you follow just published X" notifications, but the
    // raw "X started following you" event gets the bare 'follow' type.
    case 'follow':                 return `${actorTag} started following you`;

    // ── Following: people you follow doing things ──
    case 'follow_new_post':        return `${actorTag} posted something new`;
    case 'follow_new_video':       return `${actorTag} uploaded a new video`;
    case 'follow_new_book':        return `${actorTag} published a new book${titleHint}`;
    case 'follow_repost':          return `${actorTag} shared a post`;

    // ── Direct content publish events (Supabase triggers fire these
    //    with type='video'/'book'/'chapter' when a scheduled post
    //    goes live or a creator publishes directly. The video title
    //    arrives in the `message` column from the trigger.) Different
    //    from the follow_new_* fanout above which targets followers
    //    specifically; these can also arrive on the bell.
    case 'video': {
      const titleSnip = n.message
        ? ` <em style="color:var(--text2)">"${escHTML(String(n.message).slice(0, 80))}${String(n.message).length > 80 ? '…' : ''}"</em>`
        : '';
      return `${actorTag} uploaded a new video${titleSnip}`;
    }
    case 'book':
    case 'chapter': {
      const titleSnip = n.message
        ? ` <em style="color:var(--text2)">"${escHTML(String(n.message).slice(0, 80))}${String(n.message).length > 80 ? '…' : ''}"</em>`
        : '';
      const verb = n.type === 'chapter' ? 'published a new chapter' : 'published a new book';
      return `${actorTag} ${verb}${titleSnip}`;
    }

    // ── Mentions ──
    case 'mention_comment':        return `${actorTag} mentioned you in a comment`;
    case 'mention_chapter_comment':return `${actorTag} mentioned you in a chapter comment`;

    // ── Direct messages ──
    case 'dm_message': {
      const preview = n.metadata?.preview ? ` <em style="color:var(--text2)">"${escHTML(String(n.metadata.preview).slice(0, 80))}"</em>` : '';
      return `${actorTag} sent you a message${preview}`;
    }

    // ── System announcements (2026-05-15) ──
    // Withdrawal status changes (approved / rejected / paid) are the
    // first user of the announcement type. The
    // _notify_withdrawal_status_change trigger writes the human-readable
    // status line into notifications.message itself ("Your withdrawal
    // request has been approved.", "Payment sent.", etc) so we render
    // the message verbatim and skip the actor-name prefix that the
    // other branches emit. The actor on these rows is the admin who
    // performed the action, but creators see them as "Selebox" updates.
    // If a future announcement type has no message text, fall through
    // to the actor-prefix default rather than render an empty card.
    case 'announcement':
      if (n.target_type === 'withdrawal' && n.message) return escHTML(n.message);
      if (n.message) return escHTML(n.message);
      return `${actorTag} sent you an update`;

    default:                       return `${actorTag} did something on Selebox`;
  }
}

async function onNotificationClick(notifId) {
  const n = _notifications.find(x => x.id === notifId);
  if (!n) return;

  // Mark as read locally + in DB (optimistic).
  //
  // Grouped rows expand into all their underlying source ids — without
  // this the bell badge would tick down by 1 even when 5 individual
  // unread rows were collapsed into the row that was tapped. We also
  // need to count how many of those sources were ACTUALLY unread before
  // adjusting the badge (some entries in a bucket may have been read
  // independently before the user tapped the grouped representation).
  if (!n.is_read) {
    n.is_read = true;
    const sourceIds = Array.isArray(n._grouped_source_ids) && n._grouped_source_ids.length
      ? n._grouped_source_ids
      : [notifId];
    // Decrement the badge by the count of underlying unread rows.
    // _notifUnreadCount was computed from the raw (pre-grouping) set,
    // so we need the same granularity here.
    _notifUnreadCount = Math.max(0, _notifUnreadCount - sourceIds.length);
    updateNotifBadge();
    renderNotifications();
    supabase.from('notifications').update({ is_read: true }).in('id', sourceIds)
      .then(({ error }) => { if (error) console.warn('Mark read failed:', error); });
  }

  closeNotifPanel();

  // ── DM short-circuit ──────────────────────────────────────────────────
  // Always land in the inbox/thread for chat notifications, even if the
  // legacy row predates the parent_target_type backfill and would
  // otherwise miss the dispatch table below.
  if (n.type === 'dm_message' || n.target_type === 'message' || n.parent_target_type === 'conversation') {
    const convId = n.parent_target_type === 'conversation' ? n.parent_target_id : null;
    if (convId) { showMessages(); setTimeout(() => openConversation(convId), 50); }
    else        { showMessages(); }
    return;
  }

  // ── Data-driven dispatch ──────────────────────────────────────────────
  // Bell notifications carry a (kind, id) routing pair. Prefer the parent
  // (the openable surface — post / video / book / profile) over the
  // immediate target (which for a comment is the comment row itself,
  // never directly openable). Falls back to target_type when the parent
  // wasn't populated by the trigger (true for some legacy rows and for
  // the repost / follow_new_post fanout triggers whose source isn't
  // versioned in this repo).
  //
  // The kind→opener table is the single place to add a new notification
  // surface. New notification types just need their write-side trigger
  // to set parent_target_type / parent_target_id correctly — no edits
  // needed here.
  //
  // See migration_notifications_parent_target_type.sql for the matching
  // server-side change and historical-row backfill.
  let kind = n.parent_target_type || n.target_type || null;
  let id   = n.parent_target_id   || n.target_id   || null;

  // 'follow' notifications carry target_type='profile' but target_id IS
  // NULL (the row's actor_id is the followed-from user). Route to that
  // profile directly.
  if (n.type === 'follow') {
    kind = 'profile';
    id = n.actor_id || id;
  }

  // A bare 'comment' kind can survive on legacy reply rows where the
  // parent comment had no post/video link at backfill time. Land the
  // user on Home rather than open a non-openable target.
  if (kind === 'comment') {
    kind = null;
  }

  // Inline-comment notifications (annotations attached to a specific
  // passage inside a chapter). Mobile routes to /book-reading with
  // an `anchorKey` so the reader scrolls to the highlighted passage;
  // web doesn't have a chapter anchor yet, so we land on the book
  // detail page (acceptable degradation — user can navigate to the
  // chapter themselves). Three variants handled.
  //
  // The bell row carries target_type='inline_comment' (or similar)
  // and target_id pointing at the comment. parent_target_type may be
  // 'book-chapter' or 'chapter', parent_target_id is the chapter id.
  // If we have a chapter id, that's our routing key; fall back to
  // any book id if the chapter info is missing.
  const isInlineComment = (n.type === 'book_chapter_inline_comment'
    || n.type === 'book_chapter_inline_comment_reply'
    || n.type === 'book_chapter_inline_comment_mention');
  if (isInlineComment) {
    // Force kind=chapter (which the routes map points at openBookDetail
    // anyway) so we land in the right place even if the trigger
    // populated an unrecognized kebab-case parent_target_type.
    kind = 'chapter';
    id = n.parent_target_id || n.target_id || id;
  }

  const ROUTES = {
    post:           (postId)    => openPostFromSearch(postId),
    video:          (videoUuid) => playVideo('sb_' + videoUuid),
    book:           (bookId)    => openBookDetail(bookId),
    chapter:        (bookId)    => openBookDetail(bookId),
    // Mobile uses kebab 'book-chapter' for the chapter kind on its
    // adapter side; some trigger paths may write that token instead
    // of the underscored 'chapter'. Alias both.
    'book-chapter': (bookId)    => openBookDetail(bookId),
    profile:        (userId)    => openProfile(userId),
    // Withdrawal-status announcements (2026-05-15). The trigger writes
    // target_type='withdrawal' + target_id=<author_withdrawals.id>.
    // There's no per-withdrawal detail surface on web — land the
    // creator on the Earnings page (the dashboard with balances +
    // withdrawal history). showEarnings() already switches to the
    // 'earnings' tab by default; we DON'T want to flip to 'payments'
    // because that's the KYC/Payments-Info form, not the withdrawal
    // status view. forceReload=true so the table reflects the very
    // change they were just notified about (default 30s cache would
    // show stale data after admin approval).
    withdrawal:     ()          => { showEarnings(true); },
  };

  const opener = kind ? ROUTES[kind] : null;
  if (opener && id) {
    opener(id);
    return;
  }

  // ── Final fallback ──
  // App boot landed without a specific deep link — show the curated home
  // landing as the default surface. Pre-May-2026 this called showFeed(),
  // but Home now points at the curated landing while the social feed
  // lives behind the Post tab.
  setSidebarActive('btnHome');
  showHomeLanding();
}

async function markAllNotificationsRead() {
  if (!_cfg.getCurrentUser()) return;
  // Optimistic local update first so the UI doesn't lag the network.
  _notifications.forEach((n) => { n.is_read = true; });
  _notifUnreadCount = 0;
  updateNotifBadge();
  renderNotifications();

  // Single sweeping UPDATE — covers EVERY unread row owned by the
  // current user, not just the currently-loaded page. Two reasons
  // the previous implementation was wrong:
  //
  //   1. `_notifications` after grouping holds only HEAD rows. A
  //      grouped row collapses N raw rows into one — using its `id`
  //      in the UPDATE only marks 1 of the N. The remaining N-1 stay
  //      unread, so the badge resurrects the next time the panel
  //      opens.
  //   2. Loaded rows are paginated (page size 25). Anything past the
  //      first page wasn't being touched at all.
  //
  // The `eq('recipient_id', me).eq('is_read', false)` filter scopes
  // the UPDATE server-side — RLS already restricts to the user's
  // own rows, but the explicit recipient_id keeps the query plan
  // sane and the intent obvious. No round-trip per row.
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('recipient_id', _cfg.getCurrentUser().id)
    .eq('is_read', false);
  if (error) console.warn('Mark all read failed:', error);
}

function toggleNotifPanel() {
  if (_notifPanelOpen) closeNotifPanel();
  else openNotifPanel();
}
export function openNotifPanel() {
  const panel = document.getElementById('notificationsPanel');
  if (!panel) return;
  panel.style.display = 'flex';
  _notifPanelOpen = true;

  // Mark-as-read on open — mirrors mobile's behavior (clears the
  // badge the moment the bell opens). Only fires once per
  // panel-open session so opening / closing / re-opening doesn't
  // hammer the DB with redundant UPDATEs. Soft: only marks the
  // currently-loaded rows; load-more pages stay unread until
  // explicitly clicked or marked. mark-all-read button still works
  // for the explicit "I want a clean slate" intent.
  if (!_notifMarkedReadThisOpen && _notifUnreadCount > 0) {
    _notifMarkedReadThisOpen = true;
    markAllNotificationsRead();
  }

  // Install scroll handler for infinite-scroll. Idempotent — only
  // attaches once per page lifetime (guard via dataset flag).
  const list = document.getElementById('notificationsList');
  if (list && !list.dataset.scrollWired) {
    list.dataset.scrollWired = 'true';
    list.addEventListener('scroll', () => {
      // Fire when the user is within 80px of the bottom — gives the
      // network request time to land before the user runs out of
      // content. Threshold chosen to match the typical card height.
      const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 80;
      if (nearBottom && _notifHasMore && !_notifLoadingMore) {
        loadMoreNotifications();
      }
    });
  }
}
// Teardown — call from app.js signOut() before supabase.auth.signOut().
// Removes the notif realtime channel + clears the in-memory list so the
// next signed-in user doesn't briefly see the previous user's bell state.
// 2026-05-15: added when sign-out broke post-Stage-1 — the original
// signOut() reached for _notifChannel which had moved into this module
// and was no longer in app.js's scope (ReferenceError killed signOut
// before supabase.auth.signOut() could run).
export function teardownNotifications() {
  if (_notifChannel) {
    try { supabase.removeChannel(_notifChannel); } catch {}
    _notifChannel = null;
  }
  _notifications.length = 0;
  _notifUnreadCount = 0;
  updateNotifBadge();
}

export function closeNotifPanel() {
  const panel = document.getElementById('notificationsPanel');
  if (!panel) return;
  panel.style.display = 'none';
  _notifPanelOpen = false;
  // Reset the per-open guard so the NEXT open will mark-as-read
  // again if any new unread arrived in the meantime (e.g. from
  // realtime INSERT while the panel was closed).
  _notifMarkedReadThisOpen = false;
}

// ── DOM event wirings (moved from end of notification block in app.js) ──
// These attach listeners to bell button, mark-all-read button, filter tabs,
// and a click-outside-to-close handler. They run at module load time, which
// is fine — the ?. on getElementById handles cases where index.html hasn't
// declared the elements yet.


document.getElementById('btnNotifications')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleNotifPanel();
});
document.getElementById('notifMarkAll')?.addEventListener('click', (e) => {
  e.stopPropagation();
  markAllNotificationsRead();
});
// Filter tabs
document.querySelectorAll('.notif-filter-tab').forEach(tab => {
  tab.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.notif-filter-tab').forEach(t => t.classList.toggle('active', t === tab));
    _notifFilter = tab.dataset.filter || 'all';
    renderNotifications();
  });
});
// Click outside the panel → close
document.addEventListener('click', (e) => {
  if (!_notifPanelOpen) return;
  if (e.target.closest('#notificationsPanel') || e.target.closest('#btnNotifications')) return;
  closeNotifPanel();
});
