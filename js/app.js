import { supabase, REACTIONS, timeAgo, initials, callEdgeFunction } from './supabase.js';

let currentUser = null;
let currentProfile = null;
let posts = [];

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

async function uploadImage(file) {
  if (!file) return null;
  if (!file.type.startsWith('image/')) { toast('Please select an image file', 'error'); return null; }
  if (file.size > 5 * 1024 * 1024) { toast('Image must be smaller than 5MB', 'error'); return null; }
  const ext = file.name.split('.').pop().toLowerCase();
  const filename = `${currentUser.id}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  const { error } = await supabase.storage.from('images').upload(filename, file, { cacheControl: '3600', upsert: false });
  if (error) { toast('Upload failed: ' + error.message, 'error'); return null; }
  const { data } = supabase.storage.from('images').getPublicUrl(filename);
  return data.publicUrl;
}

window.openLightbox = (url) => {
  document.getElementById('lightboxImg').src = url;
  document.getElementById('lightbox').classList.add('open');
};
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox' || e.target.id === 'lightboxClose') document.getElementById('lightbox').classList.remove('open');
});

// ── Auth ──
async function initAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) await onSignedIn(session.user);
  else showAuth();

  let isFirstAuthEvent = true;
  supabase.auth.onAuthStateChange(async (event, session) => {
    // Skip the initial event — we already handled the session above
    if (isFirstAuthEvent) { isFirstAuthEvent = false; return; }
    if (session) await onSignedIn(session.user);
    else showAuth();
  });
}

async function onSignedIn(user) {
  currentUser = user;
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  currentProfile = profile;
  updateTopbarUser();
  showApp();

  // Load user's content filters (hidden posts, snoozed users, blocked users)
  // — fire-and-forget; loadFeed will refresh them anyway
  loadUserContentFilters();

  // Notifications — fetch initial batch + start realtime subscription
  initNotifications();

  // Check URL hash for routing
  const hash = window.location.hash;
  if (hash.startsWith('#profile/')) {
    loadStories();
    loadFeed();
    openProfile(hash.replace('#profile/', ''));
  } else if (hash === '#videos') {
    setSidebarActive('btnVideos');
    showVideos();
  } else if (hash === '#studio') {
    setSidebarActive('btnStudio');
    showStudio();
  } else if (hash === '#book') {
    setSidebarActive('btnBook');
    showBook();
  } else if (hash.startsWith('#book/')) {
    setSidebarActive('btnBook');
    const bookId = hash.replace('#book/', '').split('/')[0];
    openBookDetail(bookId);
  } else if (hash === '#author') {
    setSidebarActive('btnAuthor');
    showAuthor();
  } else if (hash.startsWith('#author/book/')) {
    setSidebarActive('btnAuthor');
    const parts = hash.replace('#author/book/', '').split('/');
    const bookId = parts[0];
    if (parts[2]) {
      openAuthorChapterEditor(bookId, parts[2] === 'new' ? null : parts[2]);
    } else {
      openAuthorBookEditor(bookId);
    }
  } else if (hash.startsWith('#video/')) {
    setSidebarActive('btnVideos');
    playVideo(hash.replace('#video/', ''));
  } else if (hash === '#bookmarks') {
    setSidebarActive('btnBookmarks');
    showBookmarks();
  } else {
    loadStories();
    loadFeed();
  }
}

function showAuth() {
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('appScreen').style.display = 'none';
}
function showApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = 'block';
}

function updateTopbarUser() {
  if (!currentProfile) return;
  const name = currentProfile.username || 'User';
  const avatarEl = document.getElementById('topbarAvatar');
  const composeAvatarEl = document.getElementById('composeAvatar');
  const avatarHTML = currentProfile.avatar_url ? `<img src="${currentProfile.avatar_url}" alt="${name}"/>` : initials(name);
  avatarEl.innerHTML = avatarHTML;
  composeAvatarEl.innerHTML = avatarHTML;
}

document.getElementById('btnGoogle').addEventListener('click', async () => {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
  if (error) toast(error.message, 'error');
});
document.getElementById('btnGuest').addEventListener('click', async () => {
  const { error } = await supabase.auth.signInAnonymously();
  if (error) toast(error.message, 'error');
});

async function signOut() {
  await supabase.auth.signOut();
  currentUser = null; currentProfile = null; posts = [];
}
document.getElementById('btnSignOut').addEventListener('click', signOut);

// ── Compose ──
const composeText = document.getElementById('composeText');
const charCount = document.getElementById('charCount');
const composeImageInput = document.getElementById('composeImageInput');
const composeImagePreview = document.getElementById('composeImagePreview');
let composeImageFile = null;

composeText.addEventListener('input', () => {
  const len = composeText.value.length;
  charCount.textContent = `${len} / 5000`;
  charCount.className = 'char-count' + (len > 4500 ? ' warn' : '') + (len >= 5000 ? ' over' : '');
  composeText.style.height = 'auto';
  composeText.style.height = composeText.scrollHeight + 'px';
});

composeImageInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  composeImageFile = file;
  const reader = new FileReader();
  reader.onload = (ev) => {
    composeImagePreview.innerHTML = `
      <div class="image-preview">
        <img src="${ev.target.result}" alt="preview"/>
        <button class="image-preview-remove" id="removeComposeImage">×</button>
      </div>`;
    document.getElementById('removeComposeImage').addEventListener('click', () => {
      composeImageFile = null;
      composeImagePreview.innerHTML = '';
      composeImageInput.value = '';
    });
  };
  reader.readAsDataURL(file);
});

document.getElementById('btnPost').addEventListener('click', async () => {
  const body = composeText.value.trim();
  if (!body && !composeImageFile) return;
  if (!currentUser) return toast('Please sign in first', 'error');

  const btn = document.getElementById('btnPost');
  btn.disabled = true;
  btn.textContent = composeImageFile ? 'Uploading...' : 'Posting...';

  let imageUrl = null;
  if (composeImageFile) {
    imageUrl = await uploadImage(composeImageFile);
    if (!imageUrl) { btn.disabled = false; btn.textContent = 'Post'; return; }
  }

  btn.textContent = 'Posting...';
  const { error } = await supabase.from('posts').insert({ user_id: currentUser.id, body: body || '', image_url: imageUrl });
  btn.disabled = false;
  btn.textContent = 'Post';

  if (error) { toast(error.message, 'error'); return; }
  composeText.value = '';
  composeImageFile = null;
  composeImagePreview.innerHTML = '';
  composeImageInput.value = '';
  charCount.textContent = '0 / 5000';
  toast('Posted!', 'success');
  loadFeed();
});

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

// ── Filter by user ──
window.filterByUser = async (userId, username) => {
  openProfile(userId);
};

// ── Feed ──
// ── Feed pagination + lazy loading ──
const FEED_PAGE_SIZE = 15;
let _feedOffset = 0;
let _hasMoreFeedPosts = true;
let _isLoadingMoreFeed = false;
let _feedScrollObserver = null;
let _feedVideoObserver = null;
let _feedPostObserver = null;

const FEED_SELECT = `*, profiles!user_id(id, username, avatar_url, is_guest, is_banned), videos(id, video_url, thumbnail_url, title, duration), original:reposted_from(*, profiles!user_id(id, username, avatar_url, is_guest, is_banned), videos(id, video_url, thumbnail_url, title, duration))`;

window.loadFeed = async function() {
  const feed = document.getElementById('feed');
  const sentinel = document.getElementById('feedSentinel');
  feed.innerHTML = '<div class="loading">Loading feed...</div>';
  if (sentinel) sentinel.style.display = 'none';

  // Reset pagination state
  _feedOffset = 0;
  _hasMoreFeedPosts = true;
  _isLoadingMoreFeed = false;
  if (_feedScrollObserver) { _feedScrollObserver.disconnect(); _feedScrollObserver = null; }
  if (_feedVideoObserver)  { _feedVideoObserver.disconnect();  _feedVideoObserver = null; }
  if (_feedPostObserver)   { _feedPostObserver.disconnect();   _feedPostObserver = null; }

  const { data, error } = await supabase
    .from('posts')
    .select(FEED_SELECT)
    .eq('is_hidden', false)
    .order('created_at', { ascending: false })
    .range(0, FEED_PAGE_SIZE - 1);

  if (error) { feed.innerHTML = `<div class="empty"><p>${error.message}</p></div>`; return; }

  // Filter happens client-side using the cached filter set (loaded once on sign-in).
  // No re-fetch here — keeps feed load fast.
  posts = (data || []).filter(p => !shouldHidePost(p));
  if ((data || []).length < FEED_PAGE_SIZE) _hasMoreFeedPosts = false;
  _feedOffset = (data || []).length;

  if (!posts.length) {
    feed.innerHTML = '<div class="empty"><h3>No posts yet</h3><p>Be the first to share something!</p></div>';
    return;
  }

  feed.innerHTML = '';
  posts.forEach((post, i) => {
    const el = renderPost(post);
    el.style.animationDelay = `${(i * 0.04).toFixed(3)}s`;
    feed.appendChild(el);
  });

  setupFeedLazyLoaders(feed);
  if (_hasMoreFeedPosts) setupFeedInfiniteScroll();
};

async function loadMoreFeed() {
  if (_isLoadingMoreFeed || !_hasMoreFeedPosts) return;
  _isLoadingMoreFeed = true;

  const sentinel = document.getElementById('feedSentinel');
  sentinel.style.display = 'block';
  sentinel.innerHTML = '<div class="book-grid-loadmore">Loading more posts…</div>';

  try {
    const { data, error } = await supabase
      .from('posts')
      .select(FEED_SELECT)
      .eq('is_hidden', false)
      .order('created_at', { ascending: false })
      .range(_feedOffset, _feedOffset + FEED_PAGE_SIZE - 1);

    if (error) throw error;

    const rawMore = data || [];
    const more    = rawMore.filter(p => !shouldHidePost(p));
    if (rawMore.length < FEED_PAGE_SIZE) _hasMoreFeedPosts = false;
    _feedOffset += rawMore.length;

    if (more.length) {
      const feed = document.getElementById('feed');
      const presentIds = new Set(Array.from(feed.querySelectorAll('.post-card')).map(c => c.dataset.postid));
      more.filter(p => !presentIds.has(p.id)).forEach((post, i) => {
        const el = renderPost(post);
        el.style.animationDelay = `${(i * 0.03).toFixed(3)}s`;
        feed.appendChild(el);
        // Re-observe new card for lazy loaders
        if (_feedPostObserver) _feedPostObserver.observe(el);
        el.querySelectorAll('.post-video').forEach(v => _feedVideoObserver?.observe(v));
      });
      posts = posts.concat(more);
    }

    if (_hasMoreFeedPosts) {
      sentinel.innerHTML = '<div class="book-grid-loadmore">Loading more posts…</div>';
    } else {
      sentinel.innerHTML = `<div class="book-grid-end-msg">You\'re all caught up · ${posts.length.toLocaleString()} posts</div>`;
      if (_feedScrollObserver) { _feedScrollObserver.disconnect(); _feedScrollObserver = null; }
    }
  } catch (err) {
    console.error('Failed to load more feed:', err);
    sentinel.innerHTML = '<div class="book-grid-end-msg">Couldn\'t load more — try refreshing</div>';
  } finally {
    _isLoadingMoreFeed = false;
  }
}

function setupFeedInfiniteScroll() {
  const sentinel = document.getElementById('feedSentinel');
  if (!sentinel) return;
  sentinel.style.display = 'block';

  if (_feedScrollObserver) _feedScrollObserver.disconnect();
  if (!('IntersectionObserver' in window)) return;

  _feedScrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) loadMoreFeed();
  }, { root: null, rootMargin: '600px 0px', threshold: 0.01 });
  _feedScrollObserver.observe(sentinel);
}

// One-shot lazy loaders: HLS for videos, reactions/comments per post-card.
// Posts/videos that never scroll into view never trigger an extra query.
function setupFeedLazyLoaders(container) {
  if (!('IntersectionObserver' in window)) {
    // Fallback: load everything eagerly
    container.querySelectorAll('.post-video').forEach(attachHlsToPostVideo);
    container.querySelectorAll('.post-card').forEach(triggerPostLazyLoad);
    return;
  }

  if (_feedVideoObserver) _feedVideoObserver.disconnect();
  _feedVideoObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      attachHlsToPostVideo(e.target);
      _feedVideoObserver.unobserve(e.target);
    }
  }, { root: null, rootMargin: '300px 0px', threshold: 0.01 });

  if (_feedPostObserver) _feedPostObserver.disconnect();
  _feedPostObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      triggerPostLazyLoad(e.target);
      _feedPostObserver.unobserve(e.target);
    }
  }, { root: null, rootMargin: '500px 0px', threshold: 0.01 });

  container.querySelectorAll('.post-video').forEach(v => _feedVideoObserver.observe(v));
  container.querySelectorAll('.post-card').forEach(c => _feedPostObserver.observe(c));
}

function attachHlsToPostVideo(wrap) {
  const url = wrap.dataset.videoUrl;
  const video = wrap.querySelector('.post-video-player');
  if (!url || !video || video.dataset.attached) return;
  video.dataset.attached = '1';
  if (url.endsWith('.m3u8') && window.Hls && Hls.isSupported() && !video.canPlayType('application/vnd.apple.mpegurl')) {
    const hls = new Hls();
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
  loadReactions(id, 'post');
  loadCommentCount(id);
}

// Backwards-compatibility shim — older code still calls this.
function attachFeedVideoPlayers() {
  document.querySelectorAll('.post-video').forEach(attachHlsToPostVideo);
}

function renderPost(post) {
  const div = document.createElement('div');
  div.className = 'post-card' + (post.pinned_at ? ' is-pinned' : '');
  div.dataset.postid  = post.id;
  div.dataset.authorId = post.user_id || '';
  if (post.pinned_at) div.dataset.pinned = '1';

  const profile = post.profiles || {};
  const name = profile.username || 'Unknown';
  const isGuest = profile.is_guest;
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}" alt="${name}"/>` : initials(name);
  const isOwn = currentUser && currentUser.id === post.user_id;

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
          <span class="post-author profile-link" data-user-id="${post.user_id}" title="View profile">${escHTML(name)}</span>
          ${isGuest ? '<span class="post-guest">Guest</span>' : ''}
        </div>
        <div class="post-time">${timeAgo(post.created_at)}</div>
      </div>
      ${currentUser ? `
        <button class="post-menu-btn"
                onclick="openPostActionMenu(event, this)"
                data-post-id="${post.id}"
                data-is-own="${isOwn ? '1' : '0'}"
                data-is-pinned="${post.pinned_at ? '1' : '0'}"
                data-author-id="${post.user_id}"
                data-author-name="${escHTML(name)}"
                title="${isOwn ? 'Post options' : 'Post options'}"
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

    ${post.body ? `<div class="post-body">${linkify(post.body)}</div>` : ''}
    ${post.body ? renderLinkPreview(post.body) : ''}
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
            <span class="post-author profile-link" data-user-id="${post.original.user_id || ''}" title="View profile">${escHTML(post.original.profiles?.username || 'Unknown')}</span>
            <div class="post-time">${timeAgo(post.original.created_at)}</div>
          </div>
        </div>
        ${post.original.body ? `<div class="post-body">${linkify(post.original.body)}</div>` : ''}
        ${post.original.body ? renderLinkPreview(post.original.body) : ''}
        ${post.original.image_url ? `<div class="post-image" onclick="event.stopPropagation();openLightbox('${post.original.image_url}')"><img src="${post.original.image_url}" loading="lazy"/></div>` : ''}
        ${post.original.videos ? `
          <div class="post-video" data-video-url="${escHTML(post.original.videos.video_url || '')}" data-video-id="${escHTML(post.original.videos.id || '')}">
            <video class="post-video-player" poster="${escHTML(post.original.videos.thumbnail_url || '')}" muted playsinline preload="none" controls></video>
          </div>
        ` : ''}
       </div>
      ` : ''}

    <div class="post-stats">
      <div class="rcount" id="rsummary-${post.id}"></div>
      <div id="ccount-${post.id}"></div>
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
        <div class="share-menu" id="sharemenu-${post.id}">
          <button class="share-option" onclick="shareTo('facebook','${post.id}')">📘 Facebook</button>
          <button class="share-option" onclick="shareTo('twitter','${post.id}')">🐦 Twitter / X</button>
          <button class="share-option" onclick="shareTo('whatsapp','${post.id}')">💬 WhatsApp</button>
          <button class="share-option" onclick="shareTo('copy','${post.id}')">🔗 Copy link</button>
        </div>
      </div>
    </div>

    <div class="comments-section" id="comments-${post.id}" style="display:none"></div>
  `;
  // Reactions and comment count are now loaded lazily by setupFeedLazyLoaders
  // when the post-card scrolls into view (saves ~2 queries per off-screen post)
  return div;
}

function escHTML(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}
function linkify(str) {
  const escaped = escHTML(str);
  return escaped.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// Translate vertical mouse-wheel scrolling into horizontal scroll on chip rails
// (Trackpads already do this natively; this fixes mouse-wheel users.)
function enableHorizontalWheelScroll(el) {
  if (!el || el.dataset.wheelBound === '1') return;
  el.dataset.wheelBound = '1';
  el.addEventListener('wheel', (e) => {
    // If user is scrolling more vertically than horizontally, redirect to horizontal scroll
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  }, { passive: false });
}

// Wire it up for both chip rails as soon as DOM is ready
function setupChipRailScrolling() {
  enableHorizontalWheelScroll(document.getElementById('bookGenreChips'));
  enableHorizontalWheelScroll(document.getElementById('videoSearchTags'));
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupChipRailScrolling);
} else {
  setupChipRailScrolling();
}

// ── Link previews (YouTube thumbnail + generic favicon fallback) ──
function youtubeIdFromUrl(url) {
  if (!url) return null;
  // Matches: youtube.com/watch?v=ID  •  youtu.be/ID  •  youtube.com/shorts/ID  •  youtube.com/embed/ID
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function firstUrlInText(str) {
  if (!str) return null;
  const m = str.match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : null;
}

function renderLinkPreview(text) {
  const url = firstUrlInText(text);
  if (!url) return '';

  // YouTube — instant, no API needed (free public thumbnail)
  const ytId = youtubeIdFromUrl(url);
  if (ytId) {
    return `
      <a class="link-preview link-preview-youtube" href="${escHTML(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">
        <div class="link-preview-thumb">
          <img src="https://i.ytimg.com/vi/${ytId}/hqdefault.jpg" alt="YouTube thumbnail" loading="lazy"
               onerror="this.src='https://i.ytimg.com/vi/${ytId}/mqdefault.jpg'"/>
          <div class="link-preview-play-badge" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <div class="link-preview-platform">YouTube</div>
        </div>
      </a>
    `;
  }

  // Generic — favicon + hostname (no thumbnail, but distinguishes link from raw text)
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    return `
      <a class="link-preview link-preview-generic" href="${escHTML(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">
        <div class="link-preview-favicon">
          <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=64" alt="" loading="lazy"/>
        </div>
        <div class="link-preview-meta">
          <div class="link-preview-host">${escHTML(host)}</div>
          <div class="link-preview-url">${escHTML(url.length > 80 ? url.slice(0, 77) + '…' : url)}</div>
        </div>
      </a>
    `;
  } catch { return ''; }
}

// ── Premium confirmation dialog (replaces native confirm()) ──
// Usage: const ok = await confirmDialog({ title, body, confirmLabel, danger });
function confirmDialog({ title = 'Are you sure?', body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmTitle');
    const bodyEl  = document.getElementById('confirmBody');
    const okBtn   = document.getElementById('confirmOk');
    const okLabel = document.getElementById('confirmOkLabel');
    const cancelBtn = document.getElementById('confirmCancel');
    if (!overlay) { resolve(window.confirm(`${title}\n\n${body}`)); return; }

    titleEl.textContent = title;
    bodyEl.textContent  = body;
    okLabel.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.classList.toggle('confirm-btn-danger', !!danger);

    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('open'));

    const cleanup = () => {
      overlay.classList.remove('open');
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onBackdrop = (e) => { if (e.target === overlay) onCancel(); };
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);

    // Focus the cancel button by default for safer UX
    setTimeout(() => cancelBtn.focus(), 50);
  });
}
// Expose globally so any onclick="..." handlers can use it too
window.confirmDialog = confirmDialog;

window.deletePost = async (postId) => {
  const ok = await confirmDialog({
    title: 'Delete this post?',
    body: 'This permanently removes the post from your feed. If it includes a video, the video file will also be deleted from storage. This can\'t be undone.',
    confirmLabel: 'Delete forever',
  });
  if (!ok) return;

  // Check if this post has a video — if so, also delete the video & Bunny file
  const { data: post, error: lookupError } = await supabase
    .from('posts')
    .select('video_id')
    .eq('id', postId)
    .single();

  if (lookupError) {
    toast('Failed to find post: ' + lookupError.message, 'error');
    return;
  }

  if (post?.video_id) {
    try {
      await callEdgeFunction('bunny-delete', { videoId: post.video_id });
    } catch (err) {
      toast('Failed to delete video file: ' + err.message, 'error');
      return;
    }
  }

  const { error } = await supabase.from('posts').delete().eq('id', postId);
  if (error) {
    toast(error.message, 'error');
    return;
  }

  toast('Deleted', 'success');
  loadFeed();

  // Always invalidate videos cache so next visit to videos page is fresh
  allVideosCache = [];
  if (videosPage.style.display === 'block') {
    loadVideos();
  }
};

// Pin/unpin a post to your profile (max 3 enforced server-side)
async function togglePinPost(postId, currentlyPinned) {
  const newPinnedAt = currentlyPinned ? null : new Date().toISOString();
  const { error } = await supabase
    .from('posts')
    .update({ pinned_at: newPinnedAt })
    .eq('id', postId)
    .eq('user_id', currentUser.id); // belt-and-suspenders — RLS already enforces

  if (error) {
    if (/up to 3|max/i.test(error.message)) {
      toast('You can only pin 3 posts. Unpin one first.', 'error');
    } else {
      toast(error.message, 'error');
    }
    return;
  }

  toast(currentlyPinned ? 'Unpinned' : 'Pinned to profile', 'success');

  // If we're on the profile, refresh the posts tab so order updates
  if (viewingProfileId === currentUser.id) {
    loadProfilePosts(currentUser.id);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// POST ACTION MENU — kebab menu on posts (own: Pin/Delete · others: Report/Hide/Snooze/Block)
// ════════════════════════════════════════════════════════════════════════════

// Cache of the current user's content filter sets (refreshed on bootstrap + after actions)
let userContentFilters = {
  hiddenPostIds:    new Set(),
  snoozedUserIds:   new Set(),
  blockedUserIds:   new Set(),
};

async function loadUserContentFilters() {
  if (!currentUser) {
    userContentFilters = { hiddenPostIds: new Set(), snoozedUserIds: new Set(), blockedUserIds: new Set() };
    return;
  }
  try {
    const [hides, snoozes, blocks] = await Promise.all([
      supabase.from('post_hides').select('post_id').eq('user_id', currentUser.id),
      supabase.from('user_snoozes').select('target_user_id').eq('user_id', currentUser.id).gt('expires_at', new Date().toISOString()),
      supabase.from('user_blocks').select('blocked_user_id').eq('user_id', currentUser.id),
    ]);
    userContentFilters.hiddenPostIds  = new Set((hides.data    || []).map(r => r.post_id));
    userContentFilters.snoozedUserIds = new Set((snoozes.data  || []).map(r => r.target_user_id));
    userContentFilters.blockedUserIds = new Set((blocks.data   || []).map(r => r.blocked_user_id));
  } catch (e) {
    console.warn('[filters] load failed (likely tables missing — run migration_post_actions.sql)', e);
  }
}
window.loadUserContentFilters = loadUserContentFilters;

function shouldHidePost(post) {
  if (!post) return false;
  if (post.profiles?.is_banned)                            return true;
  if (userContentFilters.hiddenPostIds.has(post.id))      return true;
  if (userContentFilters.snoozedUserIds.has(post.user_id))return true;
  if (userContentFilters.blockedUserIds.has(post.user_id))return true;
  return false;
}
window.shouldHidePost = shouldHidePost;

let _postActionMenuEl = null;
function closePostActionMenu() {
  if (_postActionMenuEl) { _postActionMenuEl.remove(); _postActionMenuEl = null; }
}

window.openPostActionMenu = (e, btn) => {
  e.stopPropagation();
  e.preventDefault();
  if (!currentUser) { toast('Please sign in', 'error'); return; }

  const postId     = btn.dataset.postId;
  const isOwn      = btn.dataset.isOwn === '1';
  const authorId   = btn.dataset.authorId;
  const authorName = btn.dataset.authorName || 'this user';
  const isPinned   = btn.dataset.isPinned === '1';

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
      if      (action === 'report') openReportModal(postId);
      else if (action === 'hide')   hidePostFromFeed(postId);
      else if (action === 'snooze') snoozeAuthor(authorId, authorName);
      else if (action === 'block')  blockAuthor(authorId, authorName);
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
};

async function hidePostFromFeed(postId) {
  const { error } = await supabase.from('post_hides').upsert({
    user_id: currentUser.id,
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

async function snoozeAuthor(targetId, targetName) {
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);
  const { error } = await supabase.from('user_snoozes').upsert({
    user_id: currentUser.id,
    target_user_id: targetId,
    expires_at: expires.toISOString(),
  }, { onConflict: 'user_id,target_user_id' });
  if (error) { toast(error.message, 'error'); return; }

  userContentFilters.snoozedUserIds.add(targetId);
  toast(`${targetName} snoozed for 30 days`, 'success');

  // Remove all their visible posts from current feed
  document.querySelectorAll(`.post-card[data-author-id="${targetId}"]`).forEach(c => c.remove());
}

async function blockAuthor(targetId, targetName) {
  const ok = await confirmDialog({
    title: `Block ${targetName}?`,
    body: 'You won\'t see their posts and they won\'t see yours. You\'ll also unfollow each other. You can unblock later in settings.',
    confirmLabel: 'Block',
  });
  if (!ok) return;

  const { error } = await supabase.from('user_blocks').upsert({
    user_id: currentUser.id,
    blocked_user_id: targetId,
  }, { onConflict: 'user_id,blocked_user_id' });
  if (error) { toast(error.message, 'error'); return; }

  userContentFilters.blockedUserIds.add(targetId);
  toast(`Blocked ${targetName}`, 'success');

  document.querySelectorAll(`.post-card[data-author-id="${targetId}"]`).forEach(c => c.remove());
}

function openReportModal(postId) {
  // Remove any existing modal
  document.querySelectorAll('.modal-backdrop[data-modal="report"]').forEach(m => m.remove());

  const reasons = [
    ['spam',      'Spam',                'Repetitive, misleading, or scammy'],
    ['harassment','Harassment',          'Bullying or targeting someone'],
    ['hate',      'Hate speech',         'Attacks on identity or group'],
    ['nsfw',      'NSFW / Adult content','Inappropriate for general audiences'],
    ['self_harm', 'Self-harm',           'Suicide, self-injury, or eating disorders'],
    ['other',     'Other',               'Something else'],
  ];

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'report';
  modal.innerHTML = `
    <div class="modal-card report-modal" role="dialog" aria-labelledby="report-title">
      <h2 id="report-title">Report post</h2>
      <p class="modal-sub">Help us keep Selebox safe — pick what's wrong with this post.</p>
      <div class="report-reasons">
        ${reasons.map(([val, label, desc]) => `
          <label class="report-reason">
            <input type="radio" name="reason" value="${val}"/>
            <div class="report-reason-text">
              <div class="report-reason-title">${label}</div>
              <div class="report-reason-desc">${desc}</div>
            </div>
          </label>
        `).join('')}
      </div>
      <textarea class="report-details" placeholder="Optional context (max 500 characters)" maxlength="500"></textarea>
      <div class="modal-actions">
        <button class="btn-ghost"   data-action="cancel">Cancel</button>
        <button class="btn-primary" data-action="submit" disabled>Submit report</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const submitBtn = modal.querySelector('[data-action="submit"]');
  modal.querySelectorAll('input[name="reason"]').forEach(r => {
    r.addEventListener('change', () => {
      submitBtn.disabled = false;
      modal.querySelectorAll('.report-reason').forEach(rr => rr.classList.toggle('checked', rr.querySelector('input').checked));
    });
  });

  const close = () => modal.remove();
  modal.querySelector('[data-action="cancel"]').onclick = close;
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });
  document.addEventListener('keydown', function onKey(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  submitBtn.onclick = async () => {
    const reason  = modal.querySelector('input[name="reason"]:checked')?.value;
    const details = modal.querySelector('.report-details').value.trim();
    if (!reason) return;

    submitBtn.disabled    = true;
    submitBtn.textContent = 'Submitting…';

    const { error } = await supabase.from('post_reports').insert({
      reporter_id: currentUser.id,
      post_id:     postId,
      reason,
      details:     details || null,
    });

    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        toast('You already reported this post', 'success');
        close();
      } else {
        toast(error.message, 'error');
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Submit report';
      }
      return;
    }
    toast('Report submitted — thanks for keeping Selebox safe', 'success');
    close();
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PROFILE ACTION MENU — kebab on profile (Share / Report / Snooze / Block)
// ════════════════════════════════════════════════════════════════════════════
let _profileActionMenuEl = null;
function closeProfileActionMenu() {
  if (_profileActionMenuEl) { _profileActionMenuEl.remove(); _profileActionMenuEl = null; }
}

window.openProfileActionMenu = (e, btn, ctx) => {
  e.stopPropagation();
  e.preventDefault();
  if (!currentUser) { toast('Please sign in', 'error'); return; }

  const { isOwn, userId, username } = ctx;

  // Own profile: just share — single action, no menu
  if (isOwn) {
    shareProfile(userId, username);
    return;
  }

  closeProfileActionMenu();
  _profileActionMenuEl = document.createElement('div');
  _profileActionMenuEl.className = 'post-action-menu profile-action-menu';
  _profileActionMenuEl.innerHTML = `
    <button data-pam-action="share">Share profile</button>
    <button data-pam-action="report">Report user</button>
    <button data-pam-action="snooze">Snooze · 30 days</button>
    <button data-pam-action="block" class="pam-danger">Block</button>
  `;
  document.body.appendChild(_profileActionMenuEl);

  // Position: below button, right-aligned
  const r = btn.getBoundingClientRect();
  _profileActionMenuEl.style.position = 'fixed';
  _profileActionMenuEl.style.top      = `${Math.min(r.bottom + 6, window.innerHeight - 240)}px`;
  _profileActionMenuEl.style.right    = `${Math.max(window.innerWidth - r.right, 12)}px`;

  _profileActionMenuEl.querySelectorAll('[data-pam-action]').forEach(b => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const action = b.dataset.pamAction;
      closeProfileActionMenu();
      if      (action === 'share')  shareProfile(userId, username);
      else if (action === 'report') openReportUserModal(userId, username);
      else if (action === 'snooze') snoozeAuthor(userId, username);
      else if (action === 'block')  blockAuthor(userId, username);
    };
  });

  // Click anywhere else / Escape → close
  setTimeout(() => {
    const onDocClick = (ev) => {
      if (!_profileActionMenuEl?.contains(ev.target)) {
        closeProfileActionMenu();
        document.removeEventListener('click',  onDocClick);
        document.removeEventListener('keydown', onKey);
      }
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { closeProfileActionMenu(); document.removeEventListener('keydown', onKey); document.removeEventListener('click', onDocClick); } };
    document.addEventListener('click',  onDocClick);
    document.addEventListener('keydown', onKey);
  }, 0);
};

// Share profile — modal with copy link, native share, X/Facebook
async function shareProfile(userId, username) {
  const url = `${window.location.origin}${window.location.pathname}#profile/${userId}`;
  const title = `${username} on Selebox`;
  const text  = `Check out @${username} on Selebox`;
  const safeUser = escHTML(username);

  // Remove any existing modal
  document.querySelectorAll('.modal-backdrop[data-modal="share-profile"]').forEach(m => m.remove());

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'share-profile';
  modal.innerHTML = `
    <div class="modal-card share-modal" role="dialog" aria-labelledby="share-title">
      <h2 id="share-title">Share profile</h2>
      <p class="modal-sub">Share <strong>@${safeUser}</strong>'s profile with friends.</p>

      <div class="share-link-row">
        <input type="text" class="share-link-input" readonly value="${url}"/>
        <button class="btn-primary share-copy-btn" data-action="copy">Copy</button>
      </div>

      <div class="share-options">
        ${navigator.share ? `
        <button class="share-option" data-action="native">
          <span class="share-option-icon">📤</span>
          <span>More…</span>
        </button>` : ''}
        <a class="share-option" target="_blank" rel="noopener"
           href="https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}">
          <span class="share-option-icon">𝕏</span>
          <span>Post</span>
        </a>
        <a class="share-option" target="_blank" rel="noopener"
           href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}">
          <span class="share-option-icon">f</span>
          <span>Facebook</span>
        </a>
        <a class="share-option" target="_blank" rel="noopener"
           href="https://api.whatsapp.com/send?text=${encodeURIComponent(text + ' ' + url)}">
          <span class="share-option-icon">💬</span>
          <span>WhatsApp</span>
        </a>
      </div>

      <div class="modal-actions">
        <button class="btn-ghost" data-action="cancel">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('[data-action="cancel"]').onclick = close;
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });
  document.addEventListener('keydown', function onKey(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  // Copy
  const copyBtn = modal.querySelector('[data-action="copy"]');
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1600);
    } catch {
      // Fallback: select the input
      const inp = modal.querySelector('.share-link-input');
      inp.select();
      document.execCommand?.('copy');
      toast('Link copied', 'success');
    }
  };

  // Native share
  const nativeBtn = modal.querySelector('[data-action="native"]');
  if (nativeBtn) {
    nativeBtn.onclick = async () => {
      try { await navigator.share({ title, text, url }); close(); }
      catch { /* user cancelled */ }
    };
  }
}

// Report user — modal, mirrors openReportModal but writes to user_reports
function openReportUserModal(targetUserId, targetUsername) {
  document.querySelectorAll('.modal-backdrop[data-modal="report-user"]').forEach(m => m.remove());

  const reasons = [
    ['harassment',   'Harassment',           'Bullying, threats, or targeting'],
    ['spam',         'Spam',                 'Repetitive, scammy, or fake account'],
    ['impersonation','Impersonation',        'Pretending to be someone else'],
    ['hate',         'Hate speech',          'Attacks on identity or group'],
    ['nsfw',         'NSFW / Adult content', 'Inappropriate profile content'],
    ['self_harm',    'Self-harm',            'Suicide, self-injury, or eating disorders'],
    ['other',        'Other',                'Something else'],
  ];

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'report-user';
  const safeUser = escHTML(targetUsername);
  modal.innerHTML = `
    <div class="modal-card report-modal" role="dialog" aria-labelledby="report-user-title">
      <h2 id="report-user-title">Report user</h2>
      <p class="modal-sub">Reporting <strong>@${safeUser}</strong> — help us keep Selebox safe.</p>
      <div class="report-reasons">
        ${reasons.map(([val, label, desc]) => `
          <label class="report-reason">
            <input type="radio" name="reason" value="${val}"/>
            <div class="report-reason-text">
              <div class="report-reason-title">${label}</div>
              <div class="report-reason-desc">${desc}</div>
            </div>
          </label>
        `).join('')}
      </div>
      <textarea class="report-details" placeholder="Optional context (max 500 characters)" maxlength="500"></textarea>
      <div class="modal-actions">
        <button class="btn-ghost"   data-action="cancel">Cancel</button>
        <button class="btn-primary" data-action="submit" disabled>Submit report</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const submitBtn = modal.querySelector('[data-action="submit"]');
  modal.querySelectorAll('input[name="reason"]').forEach(r => {
    r.addEventListener('change', () => {
      submitBtn.disabled = false;
      modal.querySelectorAll('.report-reason').forEach(rr => rr.classList.toggle('checked', rr.querySelector('input').checked));
    });
  });

  const close = () => modal.remove();
  modal.querySelector('[data-action="cancel"]').onclick = close;
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });
  document.addEventListener('keydown', function onKey(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  submitBtn.onclick = async () => {
    const reason  = modal.querySelector('input[name="reason"]:checked')?.value;
    const details = modal.querySelector('.report-details').value.trim();
    if (!reason) return;

    submitBtn.disabled    = true;
    submitBtn.textContent = 'Submitting…';

    const { error } = await supabase.from('user_reports').insert({
      reporter_id:      currentUser.id,
      reported_user_id: targetUserId,
      reason,
      details:          details || null,
    });

    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        toast('You already reported this user', 'success');
        close();
      } else {
        toast(error.message, 'error');
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Submit report';
      }
      return;
    }
    toast('Report submitted — thanks for keeping Selebox safe', 'success');
    close();
  };
}

async function loadCommentCount(postId, videoId = null) {
  if (videoId) {
    const { count } = await supabase.from('comments').select('*', { count: 'exact', head: true }).eq('video_id', videoId);
    const el = document.getElementById('videoCommentsCount');
    if (el) el.textContent = count ? `· ${count}` : '';
    return count || 0;
  }
  const { count } = await supabase.from('comments').select('*', { count: 'exact', head: true }).eq('post_id', postId);
  // Update ALL matches — same post can be present in multiple pages (feed + profile)
  const text = count > 0 ? `${count} comment${count !== 1 ? 's' : ''}` : '';
  document.querySelectorAll(`#ccount-${postId}`).forEach(el => { el.textContent = text; });
  return count || 0;
}

// ── Reactions ──
async function loadReactions(targetId, targetType) {
  const { data } = await supabase.from('reactions').select('emoji, user_id').eq('target_id', targetId).eq('target_type', targetType);
  if (!data) return;
  const counts = {};
  let userReaction = null;
  data.forEach(r => {
    counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    if (currentUser && r.user_id === currentUser.id) userReaction = r.emoji;
  });
  updateReactionUI(targetId, targetType, counts, userReaction);
}

function updateReactionUI(targetId, targetType, counts, userReaction) {
  // Update ALL matching wraps — same post may exist in multiple pages
  // (home feed cached as display:none + profile rendering it fresh).
  const wraps = document.querySelectorAll(`.reaction-wrap[data-target="${targetId}"][data-type="${targetType}"]`);
  if (!wraps.length) return;

  const total = Object.values(counts).reduce((a,b) => a+b, 0);
  const activeR = userReaction ? REACTIONS.find(r => r.key === userReaction) : null;
  const heartSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;

  wraps.forEach(wrap => {
    const trigger = wrap.querySelector('.reaction-trigger');
    if (!trigger) return;

    const iconEl = trigger.querySelector('.r-icon');
    const labelEl = trigger.querySelector('.r-label-text');

    if (activeR) {
      iconEl.innerHTML = `<span>${activeR.emoji}</span>`;
      if (labelEl) labelEl.textContent = activeR.label;
      trigger.classList.add('reacted');
    } else {
      iconEl.innerHTML = heartSvg;
      if (labelEl) labelEl.textContent = 'Like';
      trigger.classList.remove('reacted');
    }

    wrap.querySelectorAll('.reaction-option').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.key === userReaction));
  });

  // Summary stats above action bar — also update ALL matches
  if (targetType === 'post') {
    const sortedEmojis = REACTIONS.filter(r => counts[r.key] > 0).sort((a,b) => counts[b.key] - counts[a.key]);
    const summaryHtml = sortedEmojis.length === 0 ? ''
      : `<span class="rcount-emojis">${sortedEmojis.map(r => r.emoji).join('')}</span> ${total}`;
    document.querySelectorAll(`#rsummary-${targetId}`).forEach(el => { el.innerHTML = summaryHtml; });
  }
}

async function handleReaction(targetId, targetType, emojiKey) {
  if (!currentUser) return toast('Sign in to react', 'error');
  const { data: existing } = await supabase.from('reactions').select('id, emoji').eq('user_id', currentUser.id).eq('target_id', targetId).eq('target_type', targetType).maybeSingle();
  if (existing) {
    if (existing.emoji === emojiKey) await supabase.from('reactions').delete().eq('id', existing.id);
    else await supabase.from('reactions').update({ emoji: emojiKey }).eq('id', existing.id);
  } else {
    await supabase.from('reactions').insert({ user_id: currentUser.id, target_id: targetId, target_type: targetType, emoji: emojiKey });
  }
  loadReactions(targetId, targetType);
}

// ── Comments ──
async function loadComments(postId, videoId = null) {
  const containerId = videoId ? 'videoComments' : `comments-${postId}`;
  const section = document.getElementById(containerId);
  if (!section) return;
  section.innerHTML = '<div class="loading" style="padding:1rem">Loading...</div>';
  let q = supabase.from('comments')
    .select(`*, profiles(id, username, avatar_url, is_guest)`)
    .is('parent_id', null)
    .order('created_at', { ascending: true });
  if (videoId) q = q.eq('video_id', videoId);
  else q = q.eq('post_id', postId);
  const { data, error } = await q;
  if (error) { section.innerHTML = `<p style="color:var(--text3);font-size:0.85rem">${error.message}</p>`; return; }
  section.innerHTML = '';
  const comments = data || [];
  for (const c of comments) section.appendChild(await renderComment(c, postId, false, null, videoId));

  const previewKey = videoId ? `cimgpreview-v-${videoId}` : `cimgpreview-${postId}`;
  const inputWrap = document.createElement('div');
  inputWrap.className = 'comment-input-wrap';
  inputWrap.style.flexDirection = 'column';
  inputWrap.style.gap = '0.5rem';
  inputWrap.innerHTML = `
    <div style="display:flex;gap:0.5rem;align-items:flex-start;width:100%">
      <div class="avatar sm">${currentProfile?.avatar_url ? `<img src="${currentProfile.avatar_url}"/>` : initials(currentProfile?.username || 'G')}</div>
      <textarea class="comment-input" placeholder="Write a comment…" rows="1"></textarea>
      <button class="btn-send">Send</button>
    </div>
    <div id="${previewKey}" style="margin-left:40px"></div>
    <div style="margin-left:40px;margin-top:-4px">
      <label class="image-upload-btn" style="padding:4px 8px;font-size:0.72rem">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        Add photo
        <input type="file" accept="image/*" class="cimg-input"/>
      </label>
    </div>
  `;
  section.appendChild(inputWrap);

  const ta = inputWrap.querySelector('textarea');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(postId, null, ta, previewKey, videoId); }});
  inputWrap.querySelector('.btn-send').addEventListener('click', () => submitComment(postId, null, ta, previewKey, videoId));
  inputWrap.querySelector('.cimg-input').addEventListener('change', (e) => handleCommentImageSelect(e.target, previewKey));
}

async function renderComment(comment, postId, isReply = false, topLevelId = null, videoId = null) {
  // Auto-detect video comments by inspecting the row
  if (!videoId && comment.video_id) videoId = comment.video_id;
  const div = document.createElement('div');
  div.className = isReply ? 'reply-item' : 'comment-item';
  const profile = comment.profiles || {};
  const name = profile.username || 'Unknown';
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}"/>` : initials(name);
  const replyTargetId = isReply ? topLevelId : comment.id;
  const replyToName = isReply ? name : null;

  div.innerHTML = `
    <div class="avatar sm">${avatarHTML}</div>
    <div class="comment-body">
      <div class="comment-meta">
        <span class="comment-author">${escHTML(name)}</span>
        <span class="comment-time">${timeAgo(comment.created_at)}</span>
        ${profile.is_guest ? '<span class="post-guest">Guest</span>' : ''}
      </div>
      ${comment.body ? `<div class="comment-bubble">${linkify(comment.body)}</div>` : ''}
      ${comment.body ? renderLinkPreview(comment.body) : ''}
      ${comment.image_url ? `<div class="comment-image" onclick="openLightbox('${comment.image_url}')"><img src="${comment.image_url}" loading="lazy"/></div>` : ''}
      <div class="comment-actions">
        <div class="reaction-wrap" data-target="${comment.id}" data-type="comment" style="position:relative">
          <button class="reaction-trigger comment-action-btn" data-target="${comment.id}" data-type="comment">
            <span class="r-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></span>
            <span class="r-label-text">Like</span>
          </button>
          <div class="reaction-picker">
            ${REACTIONS.map(r => `
              <button class="reaction-option" data-key="${r.key}" data-target="${comment.id}" data-type="comment" title="${r.label}">
                <span class="r-emoji">${r.emoji}</span>
                <span class="r-label">${r.label}</span>
              </button>
            `).join('')}
          </div>
        </div>
        <button class="comment-action-btn reply-btn" data-commentid="${replyTargetId}" data-postid="${postId || ''}" data-videoid="${videoId || ''}" data-replyto="${escHTML(replyToName || '')}">Reply</button>
        ${currentUser && currentUser.id === comment.user_id ? `<button class="comment-action-btn" onclick="deleteComment('${comment.id}','${postId || ''}','${videoId || ''}')">Delete</button>` : ''}
      </div>
      ${!isReply ? `<div class="replies" id="replies-${comment.id}"></div>` : ''}
    </div>
  `;

  loadReactions(comment.id, 'comment');
  if (!isReply) {
    const { data } = await supabase.from('comments').select(`*, profiles(id, username, avatar_url, is_guest)`).eq('parent_id', comment.id).order('created_at', { ascending: true });
    if (data && data.length) {
      const container = div.querySelector(`#replies-${comment.id}`);
      for (const r of data) container.appendChild(await renderComment(r, postId, true, comment.id, videoId));
    }
  }
  return div;
}

const pendingCommentImages = {};
function handleCommentImageSelect(input, previewId) {
  const file = input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please select an image', 'error'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('Image must be smaller than 5MB', 'error'); return; }
  pendingCommentImages[previewId] = file;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const preview = document.getElementById(previewId);
    if (!preview) return;
    preview.innerHTML = `<div class="image-preview" style="max-width:240px"><img src="${ev.target.result}"/><button class="image-preview-remove">×</button></div>`;
    preview.querySelector('.image-preview-remove').addEventListener('click', () => {
      delete pendingCommentImages[previewId];
      preview.innerHTML = '';
      input.value = '';
    });
  };
  reader.readAsDataURL(file);
}

async function submitComment(postId, parentId, textarea, previewId, videoId = null) {
  const body = textarea.value.trim();
  const file = previewId ? pendingCommentImages[previewId] : null;
  if (!body && !file) return;
  if (!currentUser) return toast('Sign in to comment', 'error');
  let imageUrl = null;
  if (file) {
    textarea.disabled = true;
    imageUrl = await uploadImage(file);
    textarea.disabled = false;
    if (!imageUrl) return;
  }
  const insertRow = {
    user_id: currentUser.id,
    parent_id: parentId || null,
    body: body || '',
    image_url: imageUrl,
  };
  if (videoId) insertRow.video_id = videoId;
  else insertRow.post_id = postId;
  const { error } = await supabase.from('comments').insert(insertRow);
  if (error) { toast(error.message, 'error'); return; }
  textarea.value = '';
  textarea.style.height = 'auto';
  if (previewId) {
    delete pendingCommentImages[previewId];
    const preview = document.getElementById(previewId);
    if (preview) preview.innerHTML = '';
  }
  loadComments(postId, videoId);
  loadCommentCount(postId, videoId);
}

window.deleteComment = async (commentId, postId, videoId = null) => {
  const ok = await confirmDialog({
    title: 'Delete this comment?',
    body: 'This comment will be removed permanently and can\'t be recovered.',
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  await supabase.from('comments').delete().eq('id', commentId);
  // postId or videoId may arrive as the empty string from the inline onclick — normalize
  const pid = postId || null;
  const vid = videoId || null;
  loadComments(pid, vid);
  loadCommentCount(pid, vid);
};

function showReplyInput(commentId, postId, replyToName = '', videoId = null) {
  document.querySelectorAll('.reply-input-wrap').forEach(el => el.remove());
  const container = document.getElementById(`replies-${commentId}`);
  if (!container) return;
  const previewId = `rimgpreview-${commentId}-${Date.now()}`;
  const wrap = document.createElement('div');
  wrap.className = 'comment-input-wrap reply-input-wrap';
  wrap.style.marginTop = '0.5rem';
  wrap.style.flexDirection = 'column';
  wrap.style.gap = '0.5rem';
  const placeholder = replyToName ? `Reply to ${replyToName}…` : 'Write a reply…';
  wrap.innerHTML = `
    <div style="display:flex;gap:0.5rem;align-items:flex-start;width:100%">
      <div class="avatar sm">${currentProfile?.avatar_url ? `<img src="${currentProfile.avatar_url}"/>` : initials(currentProfile?.username || 'G')}</div>
      <textarea class="comment-input" placeholder="${placeholder}" rows="1"></textarea>
      <button class="btn-send">Reply</button>
    </div>
    <div id="${previewId}" style="margin-left:40px"></div>
    <div style="margin-left:40px;margin-top:-4px">
      <label class="image-upload-btn" style="padding:4px 8px;font-size:0.72rem">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        Add photo
        <input type="file" accept="image/*" class="rimg-input"/>
      </label>
    </div>
  `;
  const ta = wrap.querySelector('textarea');
  if (replyToName) ta.value = `@${replyToName} `;
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(postId, commentId, ta, previewId, videoId); }});
  wrap.querySelector('.btn-send').addEventListener('click', () => submitComment(postId, commentId, ta, previewId, videoId));
  wrap.querySelector('.rimg-input').addEventListener('change', (e) => handleCommentImageSelect(e.target, previewId));
  container.appendChild(wrap);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ── Global delegated click handlers ──
document.addEventListener('click', (e) => {
  const option = e.target.closest('.reaction-option');
  if (option) {
    e.preventDefault(); e.stopPropagation();
    option.closest('.reaction-picker')?.classList.remove('visible');
    handleReaction(option.dataset.target, option.dataset.type, option.dataset.key);
    return;
  }
  const trigger = e.target.closest('.reaction-trigger');
  if (trigger) {
    e.preventDefault(); e.stopPropagation();
    const picker = trigger.closest('.reaction-wrap')?.querySelector('.reaction-picker');
    document.querySelectorAll('.reaction-picker.visible').forEach(p => { if (p !== picker) p.classList.remove('visible'); });
    picker?.classList.toggle('visible');
    return;
  }
  const ct = e.target.closest('.comment-toggle');
  if (ct) {
    const postId = ct.dataset.postid;
    const section = document.getElementById(`comments-${postId}`);
    if (section.style.display === 'none') { section.style.display = 'block'; loadComments(postId); }
    else section.style.display = 'none';
    return;
  }
  const replyBtn = e.target.closest('.reply-btn');
  if (replyBtn) {
    const pid = replyBtn.dataset.postid || null;
    const vid = replyBtn.dataset.videoid || null;
    showReplyInput(replyBtn.dataset.commentid, pid, replyBtn.dataset.replyto, vid);
    return;
  }
  if (!e.target.closest('.reaction-wrap')) {
    document.querySelectorAll('.reaction-picker.visible').forEach(p => p.classList.remove('visible'));
  }
  if (!e.target.closest('.share-wrap') && !e.target.closest('[onclick*="toggleShareMenu"]')) {
    document.querySelectorAll('.share-menu.visible').forEach(m => m.classList.remove('visible'));
  }
  if (!e.target.closest('.topbar-search')) {
    document.getElementById('searchResults').classList.remove('visible');
  }
});

document.addEventListener('mouseover', (e) => {
  const trigger = e.target.closest('.reaction-trigger');
  if (trigger) trigger.closest('.reaction-wrap')?.querySelector('.reaction-picker')?.classList.add('visible');
});
document.addEventListener('mouseout', (e) => {
  const wrap = e.target.closest('.reaction-wrap');
  if (!wrap || wrap.contains(e.relatedTarget)) return;
  setTimeout(() => { if (!wrap.matches(':hover')) wrap.querySelector('.reaction-picker')?.classList.remove('visible'); }, 200);
});

// ── Repost modal ──
let repostTargetId = null;
window.repostPost = (postId) => {
  if (!currentUser) return toast('Sign in to repost', 'error');
  const post = posts.find(p => p.id === postId);
  if (!post) return;
  repostTargetId = postId;
  const profile = post.profiles || {};
  const name = profile.username || 'Unknown';
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}"/>` : initials(name);
  document.getElementById('repostPreview').innerHTML = `
    <div class="post-header">
      <div class="avatar">${avatarHTML}</div>
      <div><span class="post-author">${escHTML(name)}</span><div class="post-time">${timeAgo(post.created_at)}</div></div>
    </div>
    ${post.body ? `<div class="post-body">${linkify(post.body)}</div>` : ''}
    ${post.body ? renderLinkPreview(post.body) : ''}
    ${post.image_url ? `<div style="border-radius:8px;overflow:hidden;margin-top:0.5rem"><img src="${post.image_url}"/></div>` : ''}
  `;
  document.getElementById('repostCaption').value = '';
  document.getElementById('repostModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('repostCaption').focus(), 100);
};
function closeRepostModal() {
  document.getElementById('repostModal').classList.remove('open');
  document.body.style.overflow = '';
  repostTargetId = null;
}
document.getElementById('repostClose').addEventListener('click', closeRepostModal);
document.getElementById('repostCancel').addEventListener('click', closeRepostModal);
document.getElementById('repostModal').addEventListener('click', (e) => { if (e.target.id === 'repostModal') closeRepostModal(); });
document.getElementById('repostSubmit').addEventListener('click', async () => {
  if (!repostTargetId) return;
  const caption = document.getElementById('repostCaption').value.trim();
  const btn = document.getElementById('repostSubmit');
  btn.disabled = true; btn.textContent = 'Posting...';
  const { error } = await supabase.from('posts').insert({ user_id: currentUser.id, body: caption, reposted_from: repostTargetId });
  btn.disabled = false; btn.textContent = 'Repost';
  if (error) { toast(error.message, 'error'); return; }
  closeRepostModal();
  toast('Reposted!', 'success');
  loadFeed();
});

// ── Share menu ──
window.toggleShareMenu = (e, postId) => {
  e.stopPropagation();
  document.querySelectorAll('.share-menu.visible').forEach(m => { if (m.id !== `sharemenu-${postId}`) m.classList.remove('visible'); });
  document.getElementById(`sharemenu-${postId}`).classList.toggle('visible');
};
window.shareTo = (platform, postId) => {
  const url = `${window.location.origin}?post=${postId}`;
  const text = 'Check out this post on Selebox';
  const urls = {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`
  };
  if (platform === 'copy') navigator.clipboard.writeText(url).then(() => toast('Link copied!', 'success'));
  else if (urls[platform]) window.open(urls[platform], '_blank');
  document.getElementById(`sharemenu-${postId}`).classList.remove('visible');
};

// ── Realtime ──
supabase.channel('public-feed')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, () => loadFeed())
  .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, () => loadFeed())
  .subscribe();

// ── Profile page ──
const profilePage = document.getElementById('profilePage');
const feedEl = document.getElementById('feed');
const storiesEl = document.getElementById('storiesRow');
const composeEl = document.querySelector('.compose');
let viewingProfileId = null;

function showFeed() {
  hideAllMainPages();
  feedEl.style.display = '';
  // storiesEl intentionally untouched — inline display:none in HTML keeps it hidden.
  // To bring stories back, remove `style="display:none"` from #storiesRow in index.html.
  composeEl.style.display = '';
  // Restore the feed sentinel only when there's actually more to load and posts already rendered
  const feedSentinel = document.getElementById('feedSentinel');
  if (feedSentinel && _hasMoreFeedPosts && feedEl.querySelector('.post-card')) {
    feedSentinel.style.display = 'block';
  }
  document.body.classList.remove('on-videos');
  viewingProfileId = null;
  stopVideoPlayer();
  if (window.location.hash) history.pushState(null, '', window.location.pathname);

  // Reload feed if it's empty or stuck
  if (!feedEl.querySelector('.post-card') || feedEl.querySelector('.loading')) {
    loadFeed();
  }
}

function showProfileView() {
  hideAllMainPages();   // also hides feedSentinel (and any future sibling overlays)
  profilePage.style.display = 'block';
  document.body.classList.remove('on-videos');
  stopVideoPlayer();
}

async function openProfile(userId) {
  showProfileView();
  viewingProfileId = userId;
  // Set URL hash so refresh keeps user on profile
  if (window.location.hash !== `#profile/${userId}`) {
    history.pushState(null, '', `#profile/${userId}`);
  }

  // Scroll to top — the previous page's scroll position lingers otherwise,
  // so users land on the bottom of someone's posts instead of the header.
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;

  // Close any modals/menus from a previous profile (rapid-nav safety)
  document.querySelectorAll('.modal-backdrop[data-modal="follow-list"], .modal-backdrop[data-modal="share-profile"], .modal-backdrop[data-modal="report-user"]').forEach(m => m.remove());
  closeProfileActionMenu?.();
  closePostActionMenu?.();

  // ── Paint skeleton instantly so the page never feels frozen ──
  paintProfileSkeleton();

  const isOwn = !!(currentUser && currentUser.id === userId);

  // ── Fire ALL queries in parallel (was sequential — now ~5x faster) ──
  // Mutuals RPC is included here so it doesn't add a sequential round-trip later.
  // Video/book counts apply the SAME filters as loadProfileVideos/Books for
  // non-owners — otherwise the tab pill ("Videos · 7") disagrees with what
  // the user actually sees in the tab ("No videos yet").
  const profileP   = fetchProfileWithRetry(userId);
  const followersP = supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId);
  const followingP = supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId);
  const postsP     = supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId);

  let videosQ = supabase.from('videos').select('*', { count: 'exact', head: true }).eq('uploader_id', userId);
  if (!isOwn) videosQ = videosQ.eq('status', 'ready');
  const videosP = videosQ;

  let booksQ = supabase.from('books').select('*', { count: 'exact', head: true }).eq('author_id', userId);
  if (!isOwn) booksQ = booksQ.eq('is_public', true).in('status', ['ongoing', 'completed']);
  const booksP = booksQ;

  const badgesP    = supabase.from('user_badges').select('badge').eq('user_id', userId);
  const followP    = (!isOwn && currentUser)
    ? supabase.from('follows').select('follower_id').eq('follower_id', currentUser.id).eq('following_id', userId).maybeSingle()
    : Promise.resolve({ data: null });
  const mutualsP   = (!isOwn && currentUser)
    ? supabase.rpc('get_mutual_followers', { p_target_id: userId, p_viewer_id: currentUser.id, p_limit: 6 })
    : Promise.resolve({ data: null });

  const [profile, fRes, gRes, pRes, vRes, bRes, badgesRes, followRes, mutualsRes] = await Promise.all([
    profileP, followersP, followingP, postsP, videosP, booksP, badgesP, followP, mutualsP
  ]);

  if (!profile) {
    toast('Could not load profile', 'error');
    clearProfileSkeleton();
    return;
  }

  const followers = fRes.count || 0;
  const following = gRes.count || 0;
  const postCount = pRes.count || 0;
  const videoCount = vRes.count || 0;
  const bookCount  = bRes.count || 0;
  const badges    = (badgesRes?.data || []).map(b => b.badge);

  // Banner (preserve the edit button!)
  const banner = document.getElementById('profileBanner');
  const existingBtn = document.getElementById('editBannerBtn');
  banner.innerHTML = profile.banner_url ? `<img src="${profile.banner_url}" alt="banner"/>` : '';
  if (existingBtn) banner.appendChild(existingBtn);

  // Avatar
  const avatarBig = document.getElementById('profileAvatarBig');
  avatarBig.innerHTML = profile.avatar_url ? `<img src="${profile.avatar_url}"/>` : initials(profile.username);

  // Name / badge / bio
  document.getElementById('profileName').textContent = profile.username;
  renderProfileBadges(profile, badges);
  document.getElementById('profileBio').textContent = profile.bio || '';

  // Joined date
  const joined = new Date(profile.created_at);
  const joinedStr = joined.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  document.getElementById('profileJoined').textContent = joinedStr;

  // Stats
  document.getElementById('statFollowers').innerHTML = `<strong>${followers}</strong> followers`;
  document.getElementById('statFollowing').innerHTML = `<strong>${following}</strong> following`;
  document.getElementById('statPosts').innerHTML     = `<strong>${postCount}</strong> posts`;
  // Wire the followers/following stats to open the list modal
  document.getElementById('statFollowers').onclick = () => openFollowListModal(userId, profile.username, 'followers');
  document.getElementById('statFollowing').onclick = () => openFollowListModal(userId, profile.username, 'following');
  document.getElementById('statPosts').onclick     = () => switchProfileTab('posts');

  // Tab counts
  setProfileTabCount('posts',  postCount);
  setProfileTabCount('videos', videoCount);
  setProfileTabCount('books',  bookCount);

  // About tab
  document.getElementById('aboutUsername').textContent = profile.username;
  document.getElementById('aboutBio').textContent = profile.bio || '—';
  document.getElementById('aboutLocation').textContent = profile.location || '—';
  document.getElementById('aboutWebsite').innerHTML = profile.website ? `<a href="${profile.website}" target="_blank">${profile.website}</a>` : '—';
  document.getElementById('aboutJoined').textContent = joined.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  document.getElementById('aboutType').textContent = profile.is_guest ? 'Guest account' : 'Member';

  // Action button + edit controls (isOwn already computed above)
  const actionBtn = document.getElementById('profileActionBtn');
  const editAvatarBtn = document.getElementById('editAvatarBtn');
  const editBannerBtn = document.getElementById('editBannerBtn');

  // Show "Message" button only on others' profiles
  const messageBtn = document.getElementById('profileMessageBtn');
  if (isOwn) {
    actionBtn.textContent = '⚙️ Edit profile';
    actionBtn.onclick = () => openEditProfile(profile);
    editAvatarBtn.style.display = 'flex';
    editAvatarBtn.style.visibility = 'visible';
    editBannerBtn.style.display = 'flex';
    editBannerBtn.style.visibility = 'visible';
    if (messageBtn) messageBtn.style.display = 'none';
  } else {
    const isFollowing = !!followRes.data;
    actionBtn.textContent = isFollowing ? 'Unfollow' : 'Follow';
    actionBtn.onclick = () => toggleFollow(userId, isFollowing);
    editAvatarBtn.style.display = 'none';
    editBannerBtn.style.display = 'none';
    if (messageBtn) {
      messageBtn.style.display = '';
      messageBtn.onclick = () => showMessages(userId);
    }
  }

  // Wire profile menu (kebab) — share / report / snooze / block
  const menuBtn = document.getElementById('profileMenuBtn');
  if (menuBtn) {
    menuBtn.onclick = (e) => openProfileActionMenu(e, menuBtn, {
      isOwn,
      userId,
      username: profile.username || 'this user',
    });
  }

  // Mutual followers strip — render from the RPC result we already fetched
  renderMutualFollowers(userId, isOwn, mutualsRes?.data || null);

  // Reset tab to Posts and load
  document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'posts'));
  ['profilePosts', 'profileVideos', 'profileBooks', 'profileAbout'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === 'profilePosts' ? '' : 'none';
  });
  // Reset the lazy-load markers so a fresh openProfile re-fetches
  ['profileVideos', 'profileBooks'].forEach(id => {
    const el = document.getElementById(id);
    if (el) delete el.dataset.loadedFor;
  });

  loadProfilePosts(userId);
}

// ════════════════════════════════════════════════════════════════════════════
// PROFILE — helpers (skeleton, badges, tab counts, switch, follow list modal)
// ════════════════════════════════════════════════════════════════════════════

// Retry profile fetch up to 3 times — protects against just-created accounts
async function fetchProfileWithRetry(userId, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (data) return data;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

// Paint shimmer placeholders so the page looks alive while parallel queries run
function paintProfileSkeleton() {
  const banner = document.getElementById('profileBanner');
  if (banner && !banner.querySelector('img')) banner.classList.add('skeleton-banner');
  const avatarBig = document.getElementById('profileAvatarBig');
  if (avatarBig) { avatarBig.classList.add('skeleton-avatar'); avatarBig.innerHTML = ''; }
  document.getElementById('profileName').textContent = ' ';
  document.getElementById('profileName').classList.add('skeleton-text');
  document.getElementById('profileBio').textContent = ' ';
  document.getElementById('profileBio').classList.add('skeleton-text', 'skeleton-text-wide');
  ['statFollowing','statFollowers','statPosts'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = '&nbsp;'; el.classList.add('skeleton-text'); }
  });
  // Hide stale badges so previous profile's "Member"/Creator/etc. don't flash
  const baseBadge = document.getElementById('profileBadge');
  if (baseBadge) baseBadge.style.visibility = 'hidden';
  const badgeWrap = document.getElementById('profileBadgesExtra');
  if (badgeWrap) badgeWrap.innerHTML = '';
  // Hide stale mutuals strip from previous profile
  const mutuals = document.getElementById('profileMutuals');
  if (mutuals) { mutuals.style.display = 'none'; mutuals.innerHTML = ''; }
}

function clearProfileSkeleton() {
  const banner = document.getElementById('profileBanner');
  if (banner) banner.classList.remove('skeleton-banner');
  const avatarBig = document.getElementById('profileAvatarBig');
  if (avatarBig) avatarBig.classList.remove('skeleton-avatar');
  ['profileName','profileBio','statFollowing','statFollowers','statPosts'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('skeleton-text', 'skeleton-text-wide');
  });
}

// Render Member/Guest pill + Creator/Writer/Pioneer/etc. earned badges
function renderProfileBadges(profile, badges) {
  clearProfileSkeleton();

  const baseBadge = document.getElementById('profileBadge');
  baseBadge.textContent     = profile.is_guest ? 'Guest' : 'Member';
  baseBadge.className       = 'profile-badge' + (profile.is_guest ? ' guest' : '');
  baseBadge.style.visibility = ''; // un-hide after skeleton

  // Earned badges live in a sibling container so they sit inline with username
  let extra = document.getElementById('profileBadgesExtra');
  if (!extra) {
    extra = document.createElement('span');
    extra.id = 'profileBadgesExtra';
    extra.className = 'profile-badges-extra';
    baseBadge.insertAdjacentElement('afterend', extra);
  }
  extra.innerHTML = '';

  const META = {
    creator:  { label: 'Creator',  icon: '🎬', cls: 'badge-creator',  title: 'Creator — earned by sharing original videos' },
    writer:   { label: 'Writer',   icon: '✍️', cls: 'badge-writer',   title: 'Writer — earned by publishing books on Selebox' },
    pioneer:  { label: 'Pioneer',  icon: '⭐', cls: 'badge-pioneer',  title: 'Pioneer — early Selebox community member' },
    verified: { label: 'Verified', icon: '✓',  cls: 'badge-verified', title: 'Verified account' },
    staff:    { label: 'Staff',    icon: '🛡', cls: 'badge-staff',    title: 'Selebox team member' },
  };

  // Stable display order
  const order = ['staff','verified','pioneer','creator','writer'];
  order.forEach(key => {
    if (!badges.includes(key)) return;
    const m = META[key];
    const el = document.createElement('span');
    el.className = `earned-badge ${m.cls}`;
    el.title = m.title;
    el.innerHTML = `<span class="earned-badge-icon">${m.icon}</span><span>${m.label}</span>`;
    extra.appendChild(el);
  });
}

function setProfileTabCount(tab, n) {
  const btn = document.querySelector(`.profile-tab[data-tab="${tab}"]`);
  if (!btn) return;
  let pill = btn.querySelector('.tab-count');
  if (!pill) {
    pill = document.createElement('span');
    pill.className = 'tab-count';
    btn.appendChild(pill);
  }
  pill.textContent = n > 999 ? `${(n/1000).toFixed(1)}k` : String(n);
}

function switchProfileTab(tab) {
  const btn = document.querySelector(`.profile-tab[data-tab="${tab}"]`);
  if (btn) btn.click();
}

// "Followed by alice, bob, +12 others you follow" social-proof strip
// Data is pre-fetched in openProfile's Promise.all — this just renders it.
function renderMutualFollowers(userId, isOwn, data) {
  const wrap = document.getElementById('profileMutuals');
  if (!wrap) return;
  if (isOwn || !currentUser || !data || !data.length) {
    // Hide silently — no mutuals, viewing own, signed-out, or RPC missing
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  wrap.style.display = '';

  const total = Number(data[0]?.total_count || data.length);
  const shown = data.slice(0, 3);
  const extra = Math.max(0, total - shown.length);

  // Stacked avatars
  const avatars = shown.map(p => {
    const safeName = escHTML(p.username || '');
    const safeAvatar = p.avatar_url ? escHTML(p.avatar_url) : '';
    return `
    <button class="mutual-avatar" data-uid="${p.id}" title="@${safeName}" aria-label="View @${safeName}">
      ${safeAvatar ? `<img src="${safeAvatar}" alt="@${safeName}"/>` : `<span>${initials(p.username)}</span>`}
    </button>
  `;}).join('');

  // Names line
  const nameStrs = shown.map(p =>
    `<button class="mutual-name" data-uid="${p.id}">@${escHTML(p.username || '')}</button>`
  );
  let namesPart;
  if (nameStrs.length === 1) namesPart = nameStrs[0];
  else if (nameStrs.length === 2) namesPart = `${nameStrs[0]} and ${nameStrs[1]}`;
  else namesPart = `${nameStrs[0]}, ${nameStrs[1]}, and ${nameStrs[2]}`;

  const tail = extra > 0
    ? ` <button class="mutual-more">+${extra} other${extra === 1 ? '' : 's'} you follow</button>`
    : ' you follow';

  wrap.innerHTML = `
    <div class="mutual-avatars">${avatars}</div>
    <div class="mutual-text">Followed by ${namesPart}${tail}</div>
  `;

  // Click handlers — avatars + names → that profile; "+N others" → followers modal
  wrap.querySelectorAll('[data-uid]').forEach(el => {
    el.onclick = () => openProfile(el.dataset.uid);
  });
  const moreBtn = wrap.querySelector('.mutual-more');
  if (moreBtn) {
    moreBtn.onclick = () => {
      const uname = document.getElementById('profileName')?.textContent || 'user';
      openFollowListModal(userId, uname, 'followers');
    };
  }
}

// ── Followers/Following list modal ──────────────────────────────────────────
async function openFollowListModal(userId, username, mode) {
  if (!currentUser) { toast('Please sign in', 'error'); return; }
  // mode: 'followers' (people who follow userId) | 'following' (people userId follows)

  document.querySelectorAll('.modal-backdrop[data-modal="follow-list"]').forEach(m => m.remove());

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'follow-list';
  const safeUser = escHTML(username);
  modal.innerHTML = `
    <div class="modal-card follow-list-modal" role="dialog" aria-labelledby="follow-list-title">
      <div class="follow-list-header">
        <h2 id="follow-list-title">${mode === 'followers' ? 'Followers' : 'Following'}</h2>
        <p class="modal-sub">@${safeUser} · ${mode === 'followers' ? 'people who follow' : 'people followed by'}</p>
      </div>
      <input type="text" class="follow-list-search" placeholder="Search by username…" />
      <div class="follow-list-body" id="followListBody">
        ${'<div class="follow-list-row skeleton-row"></div>'.repeat(6)}
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" data-action="cancel">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('[data-action="cancel"]').onclick = close;
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });
  document.addEventListener('keydown', function onKey(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  // Fetch the relevant follows + each side's profile, then who *I* follow (for follow-back state)
  const followsCol = mode === 'followers' ? 'follower_id' : 'following_id';
  const matchCol   = mode === 'followers' ? 'following_id' : 'follower_id';

  // Get the list of user ids
  const { data: edges, error: edgeErr } = await supabase
    .from('follows')
    .select(`${followsCol}, created_at`)
    .eq(matchCol, userId)
    .order('created_at', { ascending: false })
    .limit(500);

  if (edgeErr) { toast(edgeErr.message, 'error'); return; }
  const ids = (edges || []).map(e => e[followsCol]).filter(Boolean);

  if (!ids.length) {
    document.getElementById('followListBody').innerHTML = `
      <div class="follow-list-empty">
        <div class="follow-list-empty-icon">👥</div>
        <div>${mode === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}</div>
      </div>`;
    return;
  }

  // Hydrate profiles + my own follows in parallel
  const [{ data: profiles }, { data: myFollows }] = await Promise.all([
    supabase.from('profiles').select('id, username, avatar_url, is_guest, bio').in('id', ids),
    supabase.from('follows').select('following_id').eq('follower_id', currentUser.id).in('following_id', ids),
  ]);

  const myFollowSet = new Set((myFollows || []).map(f => f.following_id));
  const profileMap  = new Map((profiles || []).map(p => [p.id, p]));

  // Render in the original follow order (most recent first)
  const rows = ids.map(id => profileMap.get(id)).filter(Boolean);
  const body = document.getElementById('followListBody');
  body.innerHTML = rows.map(p => {
    const safeName = escHTML(p.username || '');
    const safeBio  = escHTML((p.bio || '').slice(0, 80));
    const safeAvatar = p.avatar_url ? escHTML(p.avatar_url) : '';
    return `
    <div class="follow-list-row" data-username="${(p.username || '').toLowerCase().replace(/"/g, '')}">
      <button class="follow-list-avatar" data-uid="${p.id}">
        ${safeAvatar ? `<img src="${safeAvatar}"/>` : initials(p.username)}
      </button>
      <div class="follow-list-info">
        <button class="follow-list-name" data-uid="${p.id}">@${safeName}</button>
        <div class="follow-list-bio">${safeBio}</div>
      </div>
      ${p.id === currentUser.id ? '<span class="follow-list-you">You</span>' :
        `<button class="follow-list-btn ${myFollowSet.has(p.id) ? 'is-following' : ''}" data-uid="${p.id}">
          ${myFollowSet.has(p.id) ? 'Following' : 'Follow'}
        </button>`}
    </div>
  `;}).join('');

  // Click avatar/name → open profile
  body.querySelectorAll('[data-uid]').forEach(el => {
    if (el.classList.contains('follow-list-btn')) return;
    el.onclick = () => { close(); openProfile(el.dataset.uid); };
  });

  // Follow toggle
  body.querySelectorAll('.follow-list-btn').forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const uid = btn.dataset.uid;
      const wasFollowing = btn.classList.contains('is-following');
      btn.disabled = true;
      btn.textContent = wasFollowing ? 'Unfollowing…' : 'Following…';
      let error;
      if (wasFollowing) {
        ({ error } = await supabase.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', uid));
      } else {
        ({ error } = await supabase.from('follows').insert({ follower_id: currentUser.id, following_id: uid }));
      }
      btn.disabled = false;
      if (error) {
        toast(error.message, 'error');
        btn.textContent = wasFollowing ? 'Following' : 'Follow';
        return;
      }
      btn.classList.toggle('is-following', !wasFollowing);
      btn.textContent = wasFollowing ? 'Follow' : 'Following';
    };
  });

  // Search filter
  const search = modal.querySelector('.follow-list-search');
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    body.querySelectorAll('.follow-list-row').forEach(row => {
      row.style.display = !q || row.dataset.username.includes(q) ? '' : 'none';
    });
  };
  search.focus();
}

async function loadProfilePosts(userId) {
  const wrap = document.getElementById('profilePosts');
  wrap.innerHTML = '<div class="loading">Loading posts...</div>';
  // Fetch by created_at; sort pinned-first client-side. Bulletproof if pinned_at
  // column doesn't exist yet (works pre-migration, just won't have pinning).
  const { data } = await supabase
    .from('posts')
    .select(`*, profiles!user_id(id, username, avatar_url, is_guest), videos(id, video_url, thumbnail_url, title, duration), original:reposted_from(*, profiles!user_id(id, username, avatar_url, is_guest), videos(id, video_url, thumbnail_url, title, duration))`)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(40);
  posts = (data || []).slice().sort((a, b) => {
    if (a.pinned_at && !b.pinned_at) return -1;
    if (!a.pinned_at && b.pinned_at) return 1;
    if (a.pinned_at && b.pinned_at) return new Date(b.pinned_at) - new Date(a.pinned_at);
    return new Date(b.created_at) - new Date(a.created_at);
  });
  wrap.innerHTML = '';
  if (!posts.length) {
    wrap.innerHTML = `
      <div class="profile-empty">
        <div class="profile-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
        </div>
        <h3>No posts yet</h3>
        <p>When this user shares something, it will appear here.</p>
      </div>`;
    return;
  }

  // Inject "Pinned" + "Posts" section dividers when the pinned/unpinned boundary is crossed
  let pinnedShown = false, postsShown = false;
  const hasAnyPinned = posts.some(p => p.pinned_at);
  posts.forEach(p => {
    if (p.pinned_at && !pinnedShown) {
      const hdr = document.createElement('div');
      hdr.className = 'profile-section-header';
      hdr.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 2l-1.4 1.4 1.6 1.6-5.4 5.4-3-1.5L6 11.3l3.7 3.7L4 21l1.4 1.4 5.7-5.7 3.7 3.7 1.4-1.4-1.5-3 5.4-5.4 1.6 1.6L23 9l-7-7z"/></svg> <span>Pinned</span>`;
      wrap.appendChild(hdr);
      pinnedShown = true;
    }
    if (!p.pinned_at && !postsShown && hasAnyPinned) {
      const hdr = document.createElement('div');
      hdr.className = 'profile-section-header';
      hdr.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg> <span>Posts</span>`;
      wrap.appendChild(hdr);
      postsShown = true;
    }
    const el = renderPost(p);
    wrap.appendChild(el);
    // Lazy-load reactions/comments for these too
    if (_feedPostObserver) _feedPostObserver.observe(el);
    el.querySelectorAll('.post-video').forEach(v => _feedVideoObserver?.observe(v));
  });
  // Fall back: if no observers (first time), load eagerly
  if (!_feedPostObserver) {
    wrap.querySelectorAll('.post-card').forEach(c => triggerPostLazyLoad(c));
    wrap.querySelectorAll('.post-video').forEach(v => attachHlsToPostVideo(v));
  }
}

// ── Profile: Videos tab ──
async function loadProfileVideos(userId) {
  const wrap = document.getElementById('profileVideos');
  if (!wrap) return;
  if (wrap.dataset.loadedFor === userId) return;       // already loaded for this user
  wrap.innerHTML = '<div class="loading">Loading videos...</div>';

  const isOwn = currentUser && currentUser.id === userId;

  // Supabase videos uploaded by this user
  let q = supabase
    .from('videos')
    .select(`id, title, description, thumbnail_url, video_url, views, likes, duration, created_at, status, tags, category, uploader_id, profiles!videos_uploader_id_fkey ( id, username, avatar_url )`)
    .eq('uploader_id', userId)
    .order('created_at', { ascending: false });
  // Non-owners only see ready videos
  if (!isOwn) q = q.eq('status', 'ready');

  const { data, error } = await q.limit(60);

  if (error) {
    wrap.innerHTML = `<div class="profile-empty"><h3>Couldn't load videos</h3><p>${escHTML(error.message || '')}</p></div>`;
    return;
  }

  const list = data || [];
  if (!list.length) {
    wrap.innerHTML = `
      <div class="profile-empty">
        <div class="profile-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="M16 10.5l5-2.5v8l-5-2.5z" fill="currentColor" stroke="none"/></svg>
        </div>
        <h3>No videos yet</h3>
        <p>${isOwn ? 'Upload your first video from the home feed or Studio.' : 'When this creator uploads, videos will appear here.'}</p>
      </div>`;
    wrap.dataset.loadedFor = userId;
    return;
  }

  wrap.innerHTML = '<div class="profile-video-grid"></div>';
  const grid = wrap.querySelector('.profile-video-grid');
  list.forEach((v, i) => {
    // Adapt to the existing renderVideoCard shape (mirrors fetchSupabaseVideos)
    const formatted = {
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
      status: v.status || 'ready',
      $createdAt: v.created_at,
      _uploaderInfo: v.profiles ? { $id: v.profiles.id, username: v.profiles.username, avatar: v.profiles.avatar_url } : null,
    };
    const uploader = v.profiles ? { username: v.profiles.username, avatar: v.profiles.avatar_url } : null;
    const card = renderVideoCard(formatted, uploader);
    card.style.animationDelay = `${(i * 0.03).toFixed(3)}s`;
    grid.appendChild(card);
  });
  wrap.dataset.loadedFor = userId;
}

// ── Profile: Books tab ──
async function loadProfileBooks(userId) {
  const wrap = document.getElementById('profileBooks');
  if (!wrap) return;
  if (wrap.dataset.loadedFor === userId) return;
  wrap.innerHTML = '<div class="loading">Loading books...</div>';

  const isOwn = currentUser && currentUser.id === userId;

  let q = supabase
    .from('books')
    .select(`id, title, description, cover_url, genre, tags, views_count, likes_count, chapters_count, word_count, status, is_public, published_at, created_at, updated_at, author_id, profiles!books_author_id_fkey ( id, username, avatar_url )`)
    .eq('author_id', userId)
    .order('updated_at', { ascending: false });
  // Non-owners only see public, non-draft books
  if (!isOwn) {
    q = q.eq('is_public', true).in('status', ['ongoing', 'completed']);
  }

  const { data, error } = await q.limit(60);

  if (error) {
    wrap.innerHTML = `<div class="profile-empty"><h3>Couldn't load books</h3><p>${escHTML(error.message || '')}</p></div>`;
    return;
  }

  const list = data || [];
  if (!list.length) {
    wrap.innerHTML = `
      <div class="profile-empty">
        <div class="profile-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A2.5 2.5 0 0 1 4.5 2H12v18H4.5A2.5 2.5 0 0 1 2 17.5v-13z"/><path d="M22 4.5A2.5 2.5 0 0 0 19.5 2H12v18h7.5a2.5 2.5 0 0 0 2.5-2.5v-13z"/></svg>
        </div>
        <h3>No books yet</h3>
        <p>${isOwn ? 'Head to Author to publish your first manuscript.' : 'When this writer publishes, their books will appear here.'}</p>
      </div>`;
    wrap.dataset.loadedFor = userId;
    return;
  }

  wrap.innerHTML = '<div class="profile-book-grid"></div>';
  const grid = wrap.querySelector('.profile-book-grid');
  list.forEach((b, i) => {
    const formatted = {
      ...b,
      id: b.id,
      $id: 'sb_' + b.id,
      _supabase: true,
      author: b.profiles ? { id: b.profiles.id, username: b.profiles.username, avatar: b.profiles.avatar_url } : null,
    };
    const card = renderBookCard(formatted);
    card.style.animationDelay = `${(i * 0.025).toFixed(3)}s`;
    grid.appendChild(card);
  });
  wrap.dataset.loadedFor = userId;
}

async function toggleFollow(userId, currentlyFollowing) {
  if (currentlyFollowing) {
    await supabase.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', userId);
    toast('Unfollowed', 'success');
  } else {
    await supabase.from('follows').insert({ follower_id: currentUser.id, following_id: userId });
    toast('Following!', 'success');
  }
  openProfile(userId);
}

// Profile tabs (Posts / Videos / Books / About)
document.querySelectorAll('.profile-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t === tab));

    const ids = { posts: 'profilePosts', videos: 'profileVideos', books: 'profileBooks', about: 'profileAbout' };
    Object.entries(ids).forEach(([key, id]) => {
      const el = document.getElementById(id);
      if (el) el.style.display = key === tabName ? '' : 'none';
    });

    // Lazy-load the heavy tabs only when first opened
    if (tabName === 'videos' && viewingProfileId) loadProfileVideos(viewingProfileId);
    else if (tabName === 'books' && viewingProfileId) loadProfileBooks(viewingProfileId);
  });
});

// Edit profile modal
function openEditProfile(profile) {
  document.getElementById('editUsername').value = profile.username || '';
  document.getElementById('editBio').value = profile.bio || '';
  document.getElementById('editLocation').value = profile.location || '';
  document.getElementById('editWebsite').value = profile.website || '';
  document.getElementById('editProfileModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeEditProfile() {
  document.getElementById('editProfileModal').classList.remove('open');
  document.body.style.overflow = '';
}
document.getElementById('editProfileClose').addEventListener('click', closeEditProfile);
document.getElementById('editProfileCancel').addEventListener('click', closeEditProfile);
document.getElementById('editProfileModal').addEventListener('click', (e) => { if (e.target.id === 'editProfileModal') closeEditProfile(); });

document.getElementById('editProfileSave').addEventListener('click', async () => {
  const btn = document.getElementById('editProfileSave');
  btn.disabled = true; btn.textContent = 'Saving...';
  const { error } = await supabase.from('profiles').update({
    username: document.getElementById('editUsername').value.trim() || 'User',
    bio: document.getElementById('editBio').value.trim(),
    location: document.getElementById('editLocation').value.trim(),
    website: document.getElementById('editWebsite').value.trim()
  }).eq('id', currentUser.id);
  btn.disabled = false; btn.textContent = 'Save';
  if (error) { toast(error.message, 'error'); return; }
  toast('Profile updated!', 'success');
  closeEditProfile();
  const { data: updated } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
  currentProfile = updated;
  updateTopbarUser();
  openProfile(currentUser.id);
});

// ── Image cropper ──
let cropperInstance = null;
let cropField = null; // 'avatar_url' or 'banner_url'

function openCropModal(file, aspectRatio, field, title) {
  cropField = field;
  document.getElementById('cropTitle').textContent = title;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = document.getElementById('cropImage');
    img.src = ev.target.result;
    document.getElementById('cropModal').classList.add('open');
    document.body.style.overflow = 'hidden';

    setTimeout(() => {
      if (cropperInstance) cropperInstance.destroy();
      cropperInstance = new Cropper(img, {
        aspectRatio: aspectRatio,
        viewMode: 1,
        autoCropArea: 1,
        background: false,
        movable: true,
        zoomable: true,
        scalable: false,
        rotatable: true
      });
    }, 150);
  };
  reader.readAsDataURL(file);
}

function closeCropModal() {
  document.getElementById('cropModal').classList.remove('open');
  document.body.style.overflow = '';
  if (cropperInstance) { cropperInstance.destroy(); cropperInstance = null; }
}

document.getElementById('cropClose').addEventListener('click', closeCropModal);
document.getElementById('cropCancel').addEventListener('click', closeCropModal);

document.getElementById('cropSave').addEventListener('click', async () => {
  if (!cropperInstance) return;
  const btn = document.getElementById('cropSave');
  btn.disabled = true; btn.textContent = 'Saving...';

  const canvas = cropperInstance.getCroppedCanvas({
    maxWidth: 1600, maxHeight: 1600,
    imageSmoothingQuality: 'high'
  });

  canvas.toBlob(async (blob) => {
    const file = new File([blob], `crop-${Date.now()}.jpg`, { type: 'image/jpeg' });
    const url = await uploadImage(file);
    if (!url) { btn.disabled = false; btn.textContent = 'Save'; return; }

    await supabase.from('profiles').update({ [cropField]: url }).eq('id', currentUser.id);
    if (cropField === 'avatar_url') {
      currentProfile.avatar_url = url;
      updateTopbarUser();
      toast('Avatar updated!', 'success');
    } else {
      toast('Cover updated!', 'success');
    }
    btn.disabled = false; btn.textContent = 'Save';
    closeCropModal();
    openProfile(currentUser.id);
  }, 'image/jpeg', 0.92);
});

// Avatar upload
document.getElementById('editAvatarBtn').addEventListener('click', () => document.getElementById('avatarInput').click());
document.getElementById('avatarInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  openCropModal(file, 1, 'avatar_url', 'Crop your avatar');
  e.target.value = '';
});

// Banner upload
document.getElementById('editBannerBtn').addEventListener('click', () => document.getElementById('bannerInput').click());
document.getElementById('bannerInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  openCropModal(file, 3, 'banner_url', 'Crop your cover photo');
  e.target.value = '';
});
// Open own profile from sidebar
async function openMyProfile() {
  if (!currentUser) {
    toast('Loading your profile...', '');
    return;
  }
  // Make sure profile is loaded before opening
  if (!currentProfile) {
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', currentUser.id).single();
    currentProfile = profile;
  }
  openProfile(currentUser.id);
}
document.getElementById('btnProfile').addEventListener('click', () => {
  setSidebarActive('btnProfile');
  openMyProfile();
});
document.getElementById('topbarAvatar').addEventListener('click', () => {
  setSidebarActive('btnProfile');
  openMyProfile();
});

// ── Sidebar active state syncing ──
function setSidebarActive(buttonId) {
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(buttonId);
  if (btn) btn.classList.add('active');
}

// Wire Home button → goes to feed + sets active
document.getElementById('btnHome')?.addEventListener('click', () => {
  setSidebarActive('btnHome');
  showFeed();
});

// Logo click → home + scroll to top (whether already on feed or elsewhere)
document.getElementById('topbarLogoBtn')?.addEventListener('click', () => {
  setSidebarActive('btnHome');
  showFeed();
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
});

// Handle browser back/forward
window.addEventListener('popstate', () => {
  const hash = window.location.hash;
  if (hash.startsWith('#profile/')) {
    const userId = hash.replace('#profile/', '');
    openProfile(userId);
  } else {
    showFeed();
    loadFeed();
  }
});

// ── Smart context-aware search ──
const searchInput = document.getElementById('searchInput');
const searchResultsEl = document.getElementById('searchResults');
const topbarSearchClear = document.getElementById('topbarSearchClear');
let searchDebounce = null;

function getSearchContext() {
  const hash = window.location.hash;
  if (hash === '#videos' || hash.startsWith('#video/')) return 'videos';
  if (hash === '#book'   || hash.startsWith('#book/'))   return 'books';
  return 'feed';
}

let _lastSearchContext = null;
function updateSearchPlaceholder() {
  const ctx = getSearchContext();
  if (ctx === 'videos')      searchInput.placeholder = 'Search videos · creator · tags · category…';
  else if (ctx === 'books')  searchInput.placeholder = 'Search books · author · tags · genre…';
  else                       searchInput.placeholder = 'Search posts and people…';

  // Reset any active query when moving between contexts (videos ↔ books ↔ feed)
  if (_lastSearchContext && _lastSearchContext !== ctx) {
    searchInput.value = '';
    if (topbarSearchClear) topbarSearchClear.style.display = 'none';
    activeSearchQuery = '';
    activeBookSearchQuery = '';
    searchResultsEl.classList.remove('open');
  }
  _lastSearchContext = ctx;
}

searchInput.addEventListener('input', (e) => {
  const value = e.target.value;
  if (topbarSearchClear) topbarSearchClear.style.display = value ? 'flex' : 'none';

  const ctx = getSearchContext();

  if (ctx === 'videos') {
    activeSearchQuery = value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(), 200);
    searchResultsEl.classList.remove('open');
    return;
  }

  if (ctx === 'books') {
    activeBookSearchQuery = value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runBookSearch(), 200);
    searchResultsEl.classList.remove('open');
    return;
  }

  // Feed (default): show dropdown of matching people + posts
  clearTimeout(searchDebounce);
  if (!value.trim()) {
    searchResultsEl.classList.remove('open');
    return;
  }
  searchDebounce = setTimeout(() => runFeedSearch(value), 250);
});

if (topbarSearchClear) {
  topbarSearchClear.addEventListener('click', () => {
    searchInput.value = '';
    topbarSearchClear.style.display = 'none';
    searchResultsEl.classList.remove('open');
    const ctx = getSearchContext();
    if (ctx === 'videos') {
      activeSearchQuery = '';
      runSearch();
    } else if (ctx === 'books') {
      activeBookSearchQuery = '';
      // Restore the original (filter+sort) view
      const grid = document.getElementById('bookGrid');
      grid.innerHTML = '';
      allBooksCache.forEach((b, i) => {
        const card = renderBookCard(b);
        card.style.animationDelay = `${i * 0.025}s`;
        grid.appendChild(card);
      });
      // Resume infinite scroll if there's more to load
      const sentinel = document.getElementById('bookGridSentinel');
      if (sentinel && _hasMoreBooks) {
        sentinel.style.display = 'block';
        setupBooksInfiniteScroll();
      }
    }
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#topbarSearch') && !e.target.closest('.search-results')) {
    searchResultsEl.classList.remove('open');
  }
});

// Document-level delegation: clicking any profile avatar/name in the feed
// (or future cards) opens that user's profile.
document.addEventListener('click', (e) => {
  const link = e.target.closest('.profile-link');
  if (!link) return;
  const uid = link.dataset.userId;
  if (!uid) return;
  e.stopPropagation();
  e.preventDefault();
  openProfile(uid);
});

async function runFeedSearch(query) {
  query = query.trim().toLowerCase();
  if (!query) { searchResultsEl.classList.remove('open'); return; }

  searchResultsEl.classList.add('open');
  searchResultsEl.innerHTML = '<div style="padding:1rem;color:var(--text3)">Searching...</div>';

  const [{ data: profiles }, { data: posts }] = await Promise.all([
    supabase.from('profiles').select('*').ilike('username', `%${query}%`).limit(5),
    supabase.from('posts').select('*, profiles!user_id(username, avatar_url, is_guest)').ilike('body', `%${query}%`).order('created_at', { ascending: false }).limit(8)
  ]);

  let html = '';
  if (profiles?.length) {
    html += `<div class="search-result-section">People</div>`;
    profiles.forEach(p => {
      const avatar = p.avatar_url ? `<img src="${p.avatar_url}"/>` : initials(p.username);
      html += `
        <div class="search-result-item" data-type="profile" data-id="${p.id}">
          <div class="avatar">${avatar}</div>
          <div class="search-result-info">
            <div class="search-result-title">${escHTML(p.username)}</div>
            <div class="search-result-meta">${p.is_guest ? 'Guest' : 'Member'}</div>
          </div>
        </div>
      `;
    });
  }
  if (posts?.length) {
    html += `<div class="search-result-section">Posts</div>`;
    posts.forEach(p => {
      const author = p.profiles || {};
      const avatar = author.avatar_url ? `<img src="${author.avatar_url}"/>` : initials(author.username || 'U');
      const snippet = (p.body || '').slice(0, 80);
      html += `
        <div class="search-result-item" data-type="post" data-id="${p.id}">
          <div class="avatar">${avatar}</div>
          <div class="search-result-info">
            <div class="search-result-title">${escHTML(snippet)}${p.body && p.body.length > 80 ? '...' : ''}</div>
            <div class="search-result-meta">by ${escHTML(author.username || 'Unknown')}</div>
          </div>
        </div>
      `;
    });
  }
  if (!html) html = '<div style="padding:1rem;color:var(--text3);text-align:center">No results found</div>';

  searchResultsEl.innerHTML = html;

  searchResultsEl.querySelectorAll('.search-result-item').forEach(item => {
    item.onclick = () => {
      const type = item.dataset.type;
      const id = item.dataset.id;
      searchResultsEl.classList.remove('open');
      searchInput.value = '';
      
      if (type === 'profile') openProfile(id);
    };
  });
}

window.addEventListener('hashchange', updateSearchPlaceholder);
updateSearchPlaceholder();

// ── Videos title click behavior ──
const videosTitle = document.querySelector('.videos-title');
if (videosTitle) {
  videosTitle.style.cursor = 'pointer';
  videosTitle.title = 'Click to scroll top • Double-click to refresh';

  let clickTimer = null;
  videosTitle.addEventListener('click', (e) => {
    if (clickTimer) {
      // Double click detected
      clearTimeout(clickTimer);
      clickTimer = null;
      // Refresh: clear cache and reload
      allVideosCache = [];
      allUploadersCache = {};
      activeSearchQuery = '';
      activeTagFilter = null;
      const searchInput = document.getElementById('searchInput');
      if (searchInput) searchInput.value = '';
      loadVideos();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast('Videos refreshed', 'success');
    } else {
      // Single click: wait to confirm it's not a double click
      clickTimer = setTimeout(() => {
        clickTimer = null;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }, 250);
    }
  });
}

// ════════════════════════════════════════
// VIDEO UPLOAD
// ════════════════════════════════════════

let pendingVideoFile = null;

// Open modal when "Video" button clicked
document.getElementById('btnOpenVideoUpload')?.addEventListener('click', () => {
  if (!currentUser) {
    toast('Please log in to upload videos', 'error');
    return;
  }
  document.getElementById('videoUploadModal').style.display = 'flex';
  resetVideoUploadModal();
});

// Videos page Upload button → opens same modal
document.getElementById('btnUploadVideo')?.addEventListener('click', () => {
  if (!currentUser) {
    toast('Please log in to upload videos', 'error');
    return;
  }
  document.getElementById('videoUploadModal').style.display = 'flex';
  resetVideoUploadModal();
});

// Close modal
document.getElementById('closeVideoUploadModal')?.addEventListener('click', closeVideoUploadModal);
document.getElementById('cancelVideoUpload')?.addEventListener('click', closeVideoUploadModal);

function closeVideoUploadModal() {
  document.getElementById('videoUploadModal').style.display = 'none';
  resetVideoUploadModal();
}

function resetVideoUploadModal() {
  pendingVideoFile = null;
  document.getElementById('videoUploadStep1').style.display = 'block';
  document.getElementById('videoUploadStep2').style.display = 'none';
  document.getElementById('videoUploadFile').value = '';
  document.getElementById('videoUploadTitle').value = '';
  document.getElementById('videoUploadDescription').value = '';
  document.getElementById('videoUploadTags').value = '';
  document.getElementById('videoUploadCategory').value = 'general';
  document.getElementById('videoUploadProgress').classList.remove('active');
  document.getElementById('videoUploadFill').style.width = '0%';
  document.getElementById('confirmVideoUpload').disabled = true;
  document.getElementById('confirmVideoUpload').textContent = 'Upload';
  document.getElementById('titleCharCount').textContent = '0';
  document.getElementById('descCharCount').textContent = '0';
}

// Handle file selection
document.getElementById('videoUploadFile')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  
  // 2GB limit
  if (file.size > 2 * 1024 * 1024 * 1024) {
    toast('Video too large (max 2GB)', 'error');
    return;
  }
  
  pendingVideoFile = file;
  
  // Show preview + form
  const preview = document.getElementById('videoUploadPreview');
  preview.src = URL.createObjectURL(file);
  
  document.getElementById('videoUploadStep1').style.display = 'none';
  document.getElementById('videoUploadStep2').style.display = 'block';
  
  // Auto-fill title with filename (without extension)
  const titleInput = document.getElementById('videoUploadTitle');
  titleInput.value = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
  document.getElementById('titleCharCount').textContent = titleInput.value.length;
  document.getElementById('confirmVideoUpload').disabled = false;
});

// Char counters
document.getElementById('videoUploadTitle')?.addEventListener('input', (e) => {
  document.getElementById('titleCharCount').textContent = e.target.value.length;
  document.getElementById('confirmVideoUpload').disabled = !e.target.value.trim();
});
document.getElementById('videoUploadDescription')?.addEventListener('input', (e) => {
  document.getElementById('descCharCount').textContent = e.target.value.length;
});

// Handle upload
document.getElementById('confirmVideoUpload')?.addEventListener('click', async () => {
  if (!pendingVideoFile) return;
  
  const title = document.getElementById('videoUploadTitle').value.trim();
  if (!title) {
    toast('Please add a title', 'error');
    return;
  }
  
  const description = document.getElementById('videoUploadDescription').value.trim();
  const tagsRaw = document.getElementById('videoUploadTags').value.trim();
  const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
  const category = document.getElementById('videoUploadCategory').value;
  
  const confirmBtn = document.getElementById('confirmVideoUpload');
  const cancelBtn = document.getElementById('cancelVideoUpload');
  const progress = document.getElementById('videoUploadProgress');
  const fill = document.getElementById('videoUploadFill');
  const percent = document.getElementById('videoUploadPercent');
  const status = document.getElementById('videoUploadStatus');
  
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  confirmBtn.textContent = 'Uploading...';
  progress.classList.add('active');
  
  try {
    // 1. Get upload URL from Edge Function
    status.textContent = 'Preparing upload...';
    const uploadInfo = await callEdgeFunction('bunny-upload', { title });
    
    // 2. Upload file to Bunny via PUT with progress tracking
    status.textContent = 'Uploading video...';
    await uploadFileToBunny(pendingVideoFile, uploadInfo, (pct) => {
      fill.style.width = pct + '%';
      percent.textContent = pct + '%';
    });
    
    // 3. Save metadata to Supabase (return the new row so we can link a post to it)
    status.textContent = 'Saving...';
    const { data: newVideo, error } = await supabase.from('videos').insert({
      bunny_video_id: uploadInfo.videoId,
      bunny_library_id: uploadInfo.libraryId,
      video_url: uploadInfo.videoUrl,
      thumbnail_url: uploadInfo.thumbnailUrl,
      title,
      description,
      tags,
      category,
      uploader_id: currentUser.id,
      status: 'processing',
    }).select().single();
    
    if (error) throw error;
    
    // 4. Also create a post in the home feed linking to this video
    const postBody = description?.trim() || title;
    const { error: postError } = await supabase.from('posts').insert({
      user_id: currentUser.id,
      body: postBody,
      video_id: newVideo.id,
    });
    if (postError) console.error('Failed to create feed post:', postError);
    
    status.textContent = 'Done!';
    fill.style.width = '100%';
    percent.textContent = '100%';
    
    toast('Video uploaded! Processing in the background...', 'success');
    setTimeout(() => {
      closeVideoUploadModal();
      // Refresh video page if open
      if (videosPage.style.display === 'block') {
        allVideosCache = [];
        loadVideos();
      }
      // Refresh home feed if open
      if (feedEl.style.display !== 'none') {
        window.loadFeed();
      }
    }, 1500);
    
  } catch (err) {
    console.error('Upload failed:', err);
    toast('Upload failed: ' + err.message, 'error');
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    confirmBtn.textContent = 'Try again';
    progress.classList.remove('active');
  }
});

// Helper: Upload file to Bunny with progress
function uploadFileToBunny(file, info, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', info.uploadUrl);
    xhr.setRequestHeader('AccessKey', info.accessKey);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        onProgress(pct);
      }
    });
    
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error('Bunny upload failed: ' + xhr.status));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
    
    xhr.send(file);
  });
}

initAuth();

// ── Watch history & smart recommendations ──
const WATCH_HISTORY_KEY = 'selebox_watch_history';

function getWatchHistory() {
  try {
    const raw = localStorage.getItem(WATCH_HISTORY_KEY);
    if (!raw) return [];
    const history = JSON.parse(raw);
    // Filter out entries older than 30 days
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    return history.filter(h => h.timestamp > cutoff);
  } catch { return []; }
}

function addToWatchHistory(video, uploader) {
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

function getInterestProfile() {
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
    durationEl.textContent = formatDuration(videoDuration);
  }

  return div;
}

// ── Videos ──
const videosPage = document.getElementById('videosPage');
const videoPlayerPage = document.getElementById('videoPlayerPage');
const studioPage = document.getElementById('studioPage');
const bookPage = document.getElementById('bookPage');
const authorPage = document.getElementById('authorPage');
const bookDetailPage = document.getElementById('bookDetailPage');
const chapterReaderPage = document.getElementById('chapterReaderPage');
const bookmarksPage = document.getElementById('bookmarksPage');  // Hoisted here (used by hideAllMainPages)
const messagesPage = document.getElementById('messagesPage');

// Hide every main content page; show functions call this first then set their own page to block.
function hideAllMainPages() {
  feedEl.style.display = 'none';
  storiesEl.style.display = 'none';
  composeEl.style.display = 'none';
  if (profilePage) profilePage.style.display = 'none';
  if (videosPage) videosPage.style.display = 'none';
  if (videoPlayerPage) videoPlayerPage.style.display = 'none';
  if (studioPage) studioPage.style.display = 'none';
  if (bookPage) bookPage.style.display = 'none';
  if (authorPage) authorPage.style.display = 'none';
  if (bookDetailPage) bookDetailPage.style.display = 'none';
  if (chapterReaderPage) chapterReaderPage.style.display = 'none';
  if (bookmarksPage) bookmarksPage.style.display = 'none';
  if (messagesPage) messagesPage.style.display = 'none';
  // Sibling sentinels (live outside the page divs) — also hide
  const feedSentinel = document.getElementById('feedSentinel');
  if (feedSentinel) feedSentinel.style.display = 'none';
}
let currentHls = null;

// Resume playback storage
function getResumeKey(videoId) { return `video_resume_${videoId}`; }
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
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  return `${m}:${s.toString().padStart(2,'0')}`;
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

function showVideos(forceReload = false) {
  const wasOnVideosPage = videosPage.style.display === 'block';
  hideAllMainPages();
  videosPage.style.display = 'block';
  document.body.classList.add('on-videos');
  stopVideoPlayer();
  history.pushState(null, '', '#videos');
  // Only reload if cache is empty or forced
  if (forceReload || !allVideosCache.length) {
    loadVideos();
  }
}

function showStudio() {
  hideAllMainPages();
  studioPage.style.display = 'block';
  document.body.classList.remove('on-videos');
  stopVideoPlayer();
  history.pushState(null, '', '#studio');
  loadStudio();
}

// ════════════════════════════════════════
// BOOK / READER
// ════════════════════════════════════════
let allBooksCache = [];
let bookGenreFilter = '';
let bookSortBy = 'trending';
let activeBookSearchQuery = '';
let currentBookDetail = null;       // { book, chapters }
let currentChapterIndex = 0;
let readerFontSize = parseFloat(localStorage.getItem('selebox_reader_font') || '1.05');

// ── Book (Reader) page ──
function showBook() {
  hideAllMainPages();
  bookPage.style.display = 'block';
  document.body.classList.remove('on-videos');
  stopVideoPlayer();
  history.pushState(null, '', '#book');
  loadBooks();
}

// ── Pagination state for the public Book browse page ──
const BOOKS_PAGE_SIZE = 80;
let _booksOffset = 0;
let _hasMoreBooks = true;
let _isLoadingMoreBooks = false;
let _bookScrollObserver = null;

async function loadBooks() {
  const grid = document.getElementById('bookGrid');
  const empty = document.getElementById('bookEmpty');
  const sentinel = document.getElementById('bookGridSentinel');
  empty.style.display = 'none';
  sentinel.style.display = 'none';
  grid.style.display = 'grid';
  grid.innerHTML = '<div class="loading">Loading books...</div>';

  // Reset pagination state on every fresh load (filter/sort/page open)
  _booksOffset = 0;
  _hasMoreBooks = true;
  _isLoadingMoreBooks = false;

  // Kick off recommendation rail + adaptive chip render in parallel (don't block grid)
  loadBookRecommendations().catch(e => console.warn('[recs] failed', e));
  renderBookChips().catch(e => console.warn('[chips] failed', e));

  try {
    const books = await fetchSupabaseBooks(0, BOOKS_PAGE_SIZE);
    if (books.length < BOOKS_PAGE_SIZE) _hasMoreBooks = false;
    _booksOffset = books.length;

    let merged = applyBookFilterAndSort(books);
    allBooksCache = merged;

    if (!merged.length) {
      grid.style.display = 'none';
      empty.style.display = 'flex';
      return;
    }

    renderBooks();
    if (_hasMoreBooks) setupBooksInfiniteScroll();
  } catch (err) {
    console.error('Failed to load books:', err);
    grid.innerHTML = '<div class="loading">Couldn\'t load books</div>';
  }
}

// Shared filter+sort so loadMoreBooks can reuse the same predicate
function applyBookFilterAndSort(list) {
  let merged = list;

  if (bookGenreFilter) {
    const filterLower = bookGenreFilter.toLowerCase();
    const filterWords = filterLower.replace(/-/g, ' ');
    merged = merged.filter(b => {
      if (b.genre === bookGenreFilter) return true;
      return (b.tags || []).some(t => {
        const tagLower = (t || '').toLowerCase();
        return tagLower === filterLower || tagLower === filterWords;
      });
    });
  }

  const dateOf = b => new Date(b.published_at || b.created_at || 0);
  if (bookSortBy === 'recent') {
    merged.sort((a, b) => dateOf(b) - dateOf(a));
  } else if (bookSortBy === 'most-liked') {
    merged.sort((a, b) => (b.likes_count || 0) - (a.likes_count || 0));
  } else if (bookSortBy === 'most-read') {
    merged.sort((a, b) => (b.views_count || 0) - (a.views_count || 0));
  } else { // trending
    merged.sort((a, b) => {
      const diff = (b.likes_count || 0) - (a.likes_count || 0);
      if (diff !== 0) return diff;
      return dateOf(b) - dateOf(a);
    });
  }
  return merged;
}

async function loadMoreBooks() {
  if (_isLoadingMoreBooks || !_hasMoreBooks) return;
  _isLoadingMoreBooks = true;

  const sentinel = document.getElementById('bookGridSentinel');
  sentinel.style.display = 'block';
  sentinel.innerHTML = '<div class="book-grid-loadmore">Loading more books…</div>';

  try {
    const more = await fetchSupabaseBooks(_booksOffset, BOOKS_PAGE_SIZE);
    if (more.length < BOOKS_PAGE_SIZE) _hasMoreBooks = false;
    _booksOffset += more.length;

    if (more.length) {
      // Merge into cache, re-apply current filter/sort to keep order consistent
      const allMerged = applyBookFilterAndSort([...allBooksCache, ...more]);
      allBooksCache = allMerged;
      // For appended cards we just append rendering — don't re-render entire grid (jank)
      const grid = document.getElementById('bookGrid');
      // Only render the cards that aren't already in the DOM
      const presentIds = new Set(Array.from(grid.querySelectorAll('.book-card')).map(c => c.dataset.bookId));
      more
        .filter(b => !presentIds.has(b.id))
        // Reapply filter to the new batch only (don't show filtered-out cards)
        .filter(b => allBooksCache.includes(b))
        .forEach((b, i) => {
          const card = renderBookCard(b);
          card.style.animationDelay = `${(i * 0.025).toFixed(3)}s`;
          grid.appendChild(card);
        });
    }

    if (_hasMoreBooks) {
      sentinel.innerHTML = '<div class="book-grid-loadmore">Loading more books…</div>';
    } else {
      sentinel.innerHTML = '<div class="book-grid-end-msg">You\'ve reached the end · ' + allBooksCache.length.toLocaleString() + ' books</div>';
      // Stop observing
      if (_bookScrollObserver) { _bookScrollObserver.disconnect(); _bookScrollObserver = null; }
    }
  } catch (err) {
    console.error('Failed to load more books:', err);
    sentinel.innerHTML = '<div class="book-grid-end-msg">Couldn\'t load more — try refreshing</div>';
  } finally {
    _isLoadingMoreBooks = false;
  }
}

// ── Book search (filters the currently-loaded book cache) ──
// Searches: title, description, tags, genre, author/uploader name.
// `#tag` prefix restricts to tag-only matches. Suspends infinite scroll while active.
function searchBooks(query) {
  query = (query || '').trim().toLowerCase();
  if (!query) return allBooksCache;

  const hashtagMatch = query.match(/^#(\w+)/);
  const isHashtag = !!hashtagMatch;
  const cleanQuery = isHashtag ? hashtagMatch[1].toLowerCase() : query;

  return allBooksCache.filter(b => {
    if (isHashtag) {
      return (b.tags || []).some(t => (t || '').toLowerCase().includes(cleanQuery));
    }

    const title  = (b.title || '').toLowerCase();
    const desc   = (b.description || '').toLowerCase();
    const tags   = (b.tags || []).join(' ').toLowerCase();
    const genre  = (b.genre || '').replace(/-/g, ' ').toLowerCase();
    const author = (b.profiles?.username || b.author?.username || '').toLowerCase();

    return title.includes(cleanQuery)
        || desc.includes(cleanQuery)
        || tags.includes(cleanQuery)
        || genre.includes(cleanQuery)
        || author.includes(cleanQuery);
  });
}

function runBookSearch() {
  const grid = document.getElementById('bookGrid');
  const sentinel = document.getElementById('bookGridSentinel');
  const empty = document.getElementById('bookEmpty');

  // While search is active, hide the infinite-scroll sentinel so we don't
  // append off-results books underneath.
  if (sentinel) sentinel.style.display = 'none';
  if (_bookScrollObserver) { _bookScrollObserver.disconnect(); _bookScrollObserver = null; }

  if (!activeBookSearchQuery.trim()) {
    // Empty query → restore full view
    empty.style.display = 'none';
    grid.style.display = 'grid';
    grid.innerHTML = '';
    allBooksCache.forEach((b, i) => {
      const card = renderBookCard(b);
      card.style.animationDelay = `${i * 0.025}s`;
      grid.appendChild(card);
    });
    if (sentinel && _hasMoreBooks) {
      sentinel.style.display = 'block';
      setupBooksInfiniteScroll();
    }
    return;
  }

  const filtered = searchBooks(activeBookSearchQuery);
  empty.style.display = 'none';
  grid.style.display = 'grid';

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="video-search-empty" style="grid-column:1/-1">
        <h3>No books found</h3>
        <p>Try a different keyword, author, or #tag — or scroll the full list to load more books first.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = '';
  filtered.forEach((b, i) => {
    const card = renderBookCard(b);
    card.style.animationDelay = `${(i * 0.02).toFixed(3)}s`;
    grid.appendChild(card);
  });
}

function setupBooksInfiniteScroll() {
  const sentinel = document.getElementById('bookGridSentinel');
  if (!sentinel) return;
  sentinel.style.display = 'block';

  if (_bookScrollObserver) _bookScrollObserver.disconnect();
  if (!('IntersectionObserver' in window)) return;

  _bookScrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) loadMoreBooks();
  }, {
    root: null,
    rootMargin: '600px 0px',   // pre-fetch a bit before the sentinel reaches the viewport
    threshold: 0.01,
  });
  _bookScrollObserver.observe(sentinel);
}

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
function prettyGenre(slug) {
  if (!slug) return '';
  if (PRETTY_GENRE[slug]) return PRETTY_GENRE[slug];
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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
  if (currentUser) {
    try {
      const [{ data: reads }, { data: likes }] = await Promise.all([
        supabase.from('book_reads').select('book_id').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(30),
        supabase.from('book_likes').select('book_id').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(30),
      ]);
      const seedIds = [...new Set([...(reads || []), ...(likes || [])].map(r => r.book_id))].slice(0, 30);
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

let _bookRecsCache = null;
let _bookRecsTimestamp = 0;
const BOOK_RECS_TTL = 5 * 60 * 1000; // 5 min

async function loadBookRecommendations() {
  const rail = document.getElementById('bookRecommendRail');
  const track = document.getElementById('bookRecommendTrack');
  const sub   = document.getElementById('bookRecommendSub');
  if (!rail || !track) return;

  // Only show for signed-in users
  if (!currentUser) { rail.style.display = 'none'; return; }

  // Use cache if fresh
  if (_bookRecsCache && (Date.now() - _bookRecsTimestamp) < BOOK_RECS_TTL) {
    renderBookRecsRail(_bookRecsCache);
    return;
  }

  try {
    // Pull user's recent reads + likes for the interest signal
    const [{ data: reads }, { data: likes }] = await Promise.all([
      supabase.from('book_reads').select('book_id').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('book_likes').select('book_id').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(50),
    ]);

    const readIds  = new Set((reads || []).map(r => r.book_id));
    const likedIds = new Set((likes || []).map(l => l.book_id));
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

async function fetchSupabaseBooks(offset = 0, limit = 80) {
  try {
    const { data, error } = await supabase
      .from('books')
      .select(`
        id, title, description, cover_url, genre, tags,
        views_count, likes_count, chapters_count, word_count,
        published_at, created_at,
        author_id,
        profiles!books_author_id_fkey ( id, username, avatar_url, is_banned )
      `)
      .eq('is_public', true)
      .eq('is_hidden', false)
      .in('status', ['ongoing', 'completed'])
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Supabase books fetch error:', error);
      return [];
    }

    // Filter out books whose author is banned
    return (data || [])
      .filter(b => !b.profiles?.is_banned)
      .map(b => ({
        ...b,
        id: b.id,                                    // raw UUID, no prefix needed (FK shape used elsewhere)
        $id: 'sb_' + b.id,
        author: b.profiles ? { id: b.profiles.id, username: b.profiles.username, avatar: b.profiles.avatar_url } : null,
      }));
  } catch (err) {
    console.error('fetchSupabaseBooks failed:', err);
    return [];
  }
}

function renderBooks() {
  const grid = document.getElementById('bookGrid');
  const empty = document.getElementById('bookEmpty');

  if (!allBooksCache.length) {
    grid.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  grid.style.display = 'grid';
  empty.style.display = 'none';

  grid.innerHTML = '';
  allBooksCache.forEach((b, i) => {
    const card = renderBookCard(b);
    card.style.animationDelay = `${i * 0.025}s`;
    grid.appendChild(card);
  });
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

  card.innerHTML = `
    <div class="book-cover">
      ${cover}
      <div class="book-stats">
        <span title="Views" data-stat="views">👁 ${formatCompact(b.views_count || 0)}</span>
        <span title="Likes" data-stat="likes">❤ ${formatCompact(b.likes_count || 0)}</span>
      </div>
    </div>
    ${genreLabel ? `<div class="book-card-genre">${escHTML(genreLabel)}</div>` : ''}
    <h3 class="book-card-title">${escHTML(b.title || 'Untitled')}</h3>
    <p class="book-card-author">by ${escHTML(authorName)}</p>
  `;
  return card;
}

// Format a number compactly: 1234 → "1.2k", 1500000 → "1.5M"
function formatCompact(n) {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

// Wire up genre chips + sort
document.getElementById('bookGenreChips')?.addEventListener('click', (e) => {
  const chip = e.target.closest('.book-chip');
  if (!chip) return;
  // Prevent default focus-scroll-into-view behavior that snaps the page to the chip rail
  e.preventDefault();
  chip.blur();

  document.querySelectorAll('#bookGenreChips .book-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  bookGenreFilter = chip.dataset.genre || '';

  // Preserve scroll position across the re-render (loadBooks resets grid → page collapses → browser jumps)
  const savedY = window.scrollY;
  loadBooks().then(() => {
    // Restore scroll on next tick (after layout settles)
    requestAnimationFrame(() => window.scrollTo({ top: savedY, behavior: 'instant' }));
  });
});
document.getElementById('bookSortSelect')?.addEventListener('change', (e) => {
  bookSortBy = e.target.value;
  const savedY = window.scrollY;
  loadBooks().then(() => {
    requestAnimationFrame(() => window.scrollTo({ top: savedY, behavior: 'instant' }));
  });
});

// ── Book detail page ──
async function openBookDetail(bookId) {
  hideAllMainPages();
  bookDetailPage.style.display = 'block';

  history.pushState(null, '', `#book/${bookId}`);

  const content = document.getElementById('bookDetailContent');
  content.innerHTML = '<div class="loading">Loading book...</div>';

  try {
    // All books are now Supabase. Bare UUID or "sb_<uuid>" — strip the prefix if present.
    const realId = bookId.startsWith('sb_') ? bookId.slice(3) : bookId;
    const [{ data: supBook, error: bookErr }, { data: supChapters, error: chErr }] = await Promise.all([
      supabase.from('books')
        .select(`
          id, title, description, cover_url, genre, tags,
          views_count, likes_count, chapters_count, word_count, status,
          published_at, created_at,
          author_id, profiles!books_author_id_fkey ( id, username, avatar_url )
        `)
        .eq('id', realId)
        .single(),
      supabase.from('chapters')
        .select('id, chapter_number, title, word_count, views_count, is_published, created_at')
        .eq('book_id', realId)
        .eq('is_published', true)
        .order('chapter_number', { ascending: true })
    ]);

    if (bookErr || !supBook) throw new Error(bookErr?.message || 'Book not found');
    if (chErr) console.warn('Failed to load chapters:', chErr);

    const book = supBook;
    const chapters = supChapters || [];

    currentBookDetail = { book, chapters };
    renderBookDetail();
  } catch (err) {
    content.innerHTML = `<div class="loading">Couldn't load book: ${escHTML(err.message)}</div>`;
  }
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

  const chaptersHtml = chapters.length
    ? chapters.map(c => `
        <div class="chapter-row" data-chapter-id="${c.id}">
          <span class="chapter-row-num">Ch ${c.chapter_number}</span>
          <span class="chapter-row-title">${escHTML(c.title || `Chapter ${c.chapter_number}`)}</span>
          <span class="chapter-row-meta">${(c.word_count || 0).toLocaleString()} words</span>
        </div>
      `).join('')
    : '<div style="color:var(--text2);padding:1rem 0">No chapters published yet.</div>';

  content.innerHTML = `
    <div class="book-detail">
      <div class="book-detail-cover">${cover}</div>
      <div class="book-detail-info">
        <h1>${escHTML(book.title || 'Untitled')}</h1>
        <div class="book-detail-author">
          <div class="avatar">${authorAvatar ? `<img src="${escHTML(authorAvatar)}"/>` : initials(authorName)}</div>
          <span>by <strong>${escHTML(authorName)}</strong></span>
        </div>
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
        </div>
        <div class="book-detail-description">${escHTML(book.description || 'No description provided.')}</div>
        <div class="chapter-list">
          <div class="chapter-list-title">Chapters</div>
          ${chaptersHtml}
        </div>
      </div>
    </div>
  `;

  // Wire chapter rows
  content.querySelectorAll('.chapter-row').forEach((row, i) => {
    row.addEventListener('click', () => openChapterReader(i));
  });
  // Start reading → first unread chapter (or chapter 1)
  document.getElementById('btnStartReading')?.addEventListener('click', () => openChapterReader(0));

  // Wire like + bookmark
  const likeBtn = document.getElementById('btnLikeBook');
  const bookmarkBtn = document.getElementById('btnBookmarkBook');
  likeBtn?.addEventListener('click', () => toggleBookLike(book.id));
  bookmarkBtn?.addEventListener('click', () => toggleBookBookmark(book.id));
  // Load initial state (whether the user has already liked/bookmarked)
  loadBookActionState(book.id);
}

// ────────────────────────────────────────────────────────────────────────
// Load initial like/bookmark state for the current book + render visual
// ────────────────────────────────────────────────────────────────────────
async function loadBookActionState(bookId) {
  if (!currentUser) return;
  try {
    const [{ data: like }, { data: bm }] = await Promise.all([
      supabase.from('book_likes').select('book_id').eq('user_id', currentUser.id).eq('book_id', bookId).maybeSingle(),
      supabase.from('book_bookmarks').select('book_id').eq('user_id', currentUser.id).eq('book_id', bookId).maybeSingle(),
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
  if (!currentUser) { toast('Sign in to like books', 'error'); return; }
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
        .eq('user_id', currentUser.id)
        .eq('book_id', bookId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('book_likes')
        .insert({ user_id: currentUser.id, book_id: bookId });
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
  if (!currentUser) { toast('Sign in to bookmark books', 'error'); return; }
  const btn = document.getElementById('btnBookmarkBook');
  const wasActive = btn?.dataset.active === '1';

  // Optimistic UI
  setBookActionActive('btnBookmarkBook', !wasActive);

  try {
    if (wasActive) {
      const { error } = await supabase.from('book_bookmarks')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('book_id', bookId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('book_bookmarks')
        .insert({ user_id: currentUser.id, book_id: bookId });
      if (error && !/duplicate|unique/i.test(error.message)) throw error;
    }
  } catch (e) {
    setBookActionActive('btnBookmarkBook', wasActive);
    toast('Failed: ' + (e.message || e), 'error');
  }
}

// Back to book list
document.getElementById('btnBackBooks')?.addEventListener('click', () => showBook());

// ── Chapter reader ──
async function openChapterReader(chapterIndex) {
  if (!currentBookDetail || !currentBookDetail.chapters[chapterIndex]) return;
  currentChapterIndex = chapterIndex;
  const chapter = currentBookDetail.chapters[chapterIndex];

  hideAllMainPages();
  chapterReaderPage.style.display = 'block';

  document.getElementById('readerBookTitle').textContent = currentBookDetail.book.title || 'Book';
  document.getElementById('readerChapterTitle').textContent = chapter.title || `Chapter ${chapter.chapter_number}`;
  document.getElementById('readerProgress').textContent = `Chapter ${chapter.chapter_number} of ${currentBookDetail.chapters.length}`;
  document.getElementById('btnReaderPrev').disabled = chapterIndex <= 0;
  document.getElementById('btnReaderNext').disabled = chapterIndex >= currentBookDetail.chapters.length - 1;

  history.pushState(null, '', `#book/${currentBookDetail.book.id}/chapter/${chapter.chapter_number}`);

  const content = document.getElementById('readerContent');
  content.innerHTML = '<div class="loading">Loading chapter...</div>';

  // Fetch full chapter content from the right source
  let chapterContent = '';
  let resolvedChapterId = chapter.id;
  try {
    const realChapterId = chapter.id.startsWith('sb_') ? chapter.id.slice(3) : chapter.id;
    const { data, error } = await supabase
      .from('chapters')
      .select('id, chapter_number, title, content')
      .eq('id', realChapterId)
      .single();
    if (error || !data) throw new Error(error?.message || 'Chapter not found');
    chapterContent = data.content || '';
    resolvedChapterId = data.id;
  } catch (err) {
    content.innerHTML = `<div class="loading">Couldn't load chapter: ${escHTML(err.message)}</div>`;
    return;
  }

  // Apply current font size and inject normalized content (HTML or plain text)
  content.style.fontSize = `${readerFontSize}rem`;
  content.innerHTML = normalizeChapterContent(chapterContent);
  content.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Apply username watermark (re-run in case the user logged in/out since last read)
  applyReaderWatermark();

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
    await supabase.from('book_reads').upsert({
      user_id: user.id,
      book_id: bookId,
      last_chapter_id: chapterId,
      last_chapter_number: chapterNumber,
      last_read_at: new Date().toISOString(),
    }, { onConflict: 'user_id,book_id' });
  } catch (e) { /* ignore */ }
}

// ── Reader watermark (deterrent: leaked screenshots reveal the source) ──
let _watermarkLabelCache = null;
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

// Re-render watermark when theme toggles (so colour matches background)
document.getElementById('btnTheme')?.addEventListener('click', () => {
  // Run after the body class actually flips
  setTimeout(() => {
    if (chapterReaderPage?.style.display === 'block') applyReaderWatermark();
  }, 50);
});

// ── Anti-copy protection on the reader ──
// Discourages casual copy-paste. Not bulletproof against DevTools/view-source,
// but blocks selection, right-click, and Cmd/Ctrl+C / Cmd/Ctrl+A inside the reader.
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
  el.addEventListener('selectstart', (e) => {
    e.preventDefault();
    return false;
  });

  // Block native copy (Cmd/Ctrl+C, right-click → Copy)
  el.addEventListener('copy', (e) => {
    e.preventDefault();
    e.clipboardData?.setData('text/plain', '');
    showAntiCopyToast();
    return false;
  });

  // Block cut + paste too, just in case the reader ever becomes editable somehow
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

// Reader controls
document.getElementById('btnReaderPrev')?.addEventListener('click', () => {
  if (currentChapterIndex > 0) openChapterReader(currentChapterIndex - 1);
});
document.getElementById('btnReaderNext')?.addEventListener('click', () => {
  if (currentBookDetail && currentChapterIndex < currentBookDetail.chapters.length - 1) {
    openChapterReader(currentChapterIndex + 1);
  }
});
document.getElementById('btnBackBookDetail')?.addEventListener('click', () => {
  if (currentBookDetail) openBookDetail(currentBookDetail.book.id);
});
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

// ── Author (Manuscript Studio) page ──
function showAuthor() {
  hideAllMainPages();
  authorPage.style.display = 'block';
  setAuthorView('dashboard');
  document.body.classList.remove('on-videos');
  stopVideoPlayer();
  history.pushState(null, '', '#author');
  loadAuthorDashboard();
}

// ════════════════════════════════════════════════════════════════════════════
// VIDEO PLAYER — premium nav controls (prev / rewind / fast-forward / next + autoplay)
// ════════════════════════════════════════════════════════════════════════════
const _videoHistoryStack = [];          // IDs of videos we've watched, for the "Previous" button
const SKIP_SECONDS = 10;
const AUTONEXT_KEY = 'selebox_video_autonext';

function _currentVideoIdForRoute() {
  if (!_currentVideoCtx) return null;
  return _currentVideoCtx.supabaseId ? 'sb_' + _currentVideoCtx.supabaseId : null;
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
// Init when DOM is ready
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', vcInitControls);
else vcInitControls();

// ════════════════════════════════════════════════════════════════════════════
// BOOKMARKS — saved videos + saved books for the current user
// (bookmarksPage const hoisted with other page consts at top — see line ~2489)
// ════════════════════════════════════════════════════════════════════════════
let _bookmarksActiveTab = 'videos';

function showBookmarks() {
  hideAllMainPages();
  if (bookmarksPage) bookmarksPage.style.display = 'block';
  document.body.classList.remove('on-videos');
  stopVideoPlayer();
  history.pushState(null, '', '#bookmarks');
  loadBookmarks();
}

async function loadBookmarks() {
  if (!currentUser) {
    document.getElementById('bookmarksContent').innerHTML = `
      <div class="bookmarks-empty">
        <p>Sign in to see your saved videos and books.</p>
      </div>
    `;
    return;
  }

  // Pre-load both counts so the tab badges show instantly
  const [vidCountRes, bookCountRes] = await Promise.all([
    supabase.from('video_bookmarks').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.id),
    supabase.from('book_bookmarks').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.id),
  ]);
  document.getElementById('bookmarkVideoCount').textContent = vidCountRes.count != null ? vidCountRes.count : '';
  document.getElementById('bookmarkBookCount').textContent  = bookCountRes.count != null ? bookCountRes.count : '';

  if (_bookmarksActiveTab === 'videos') await loadVideoBookmarks();
  else                                  await loadBookBookmarks();
}

async function loadVideoBookmarks() {
  const wrap = document.getElementById('bookmarksContent');
  wrap.innerHTML = '<div class="loading">Loading saved videos…</div>';
  const { data, error } = await supabase
    .from('video_bookmarks')
    .select(`
      created_at,
      videos (
        id, bunny_video_id, title, description, tags, video_url, thumbnail_url,
        views, duration, created_at, uploader_id,
        profiles!videos_uploader_id_fkey ( id, username, avatar_url )
      )
    `)
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  if (error) { wrap.innerHTML = `<div class="bookmarks-empty"><p>${escHTML(error.message)}</p></div>`; return; }

  const items = (data || []).filter(r => r.videos);
  if (!items.length) {
    wrap.innerHTML = `
      <div class="bookmarks-empty">
        <div class="bookmarks-empty-icon">🎬</div>
        <h3>No saved videos yet</h3>
        <p>Tap the <strong>Bookmark</strong> button on any video to save it here.</p>
        <button class="btn btn-purple btn-sm" onclick="setSidebarActive('btnVideos');showVideos();">Browse videos</button>
      </div>`;
    return;
  }

  wrap.innerHTML = `<div class="video-grid bookmarks-video-grid"></div>`;
  const grid = wrap.querySelector('.bookmarks-video-grid');
  for (const row of items) {
    const v = row.videos;
    const card = document.createElement('div');
    card.className = 'video-card';
    card.onclick = () => playVideo('sb_' + v.id);
    const name = v.profiles?.username || 'Unknown';
    const avatar = v.profiles?.avatar_url ? `<img src="${escHTML(v.profiles.avatar_url)}" alt=""/>` : initials(name);
    card.innerHTML = `
      <div class="video-thumb">
        ${v.thumbnail_url ? `<img src="${escHTML(v.thumbnail_url)}" loading="lazy"/>` : '<div class="video-thumb-placeholder">▶</div>'}
        ${v.duration ? `<span class="video-duration">${formatDuration(v.duration)}</span>` : ''}
      </div>
      <div class="video-card-meta">
        <div class="avatar">${avatar}</div>
        <div style="min-width:0;flex:1">
          <div class="video-card-title">${escHTML(v.title || 'Untitled')}</div>
          <div class="video-card-uploader">${escHTML(name)}</div>
          <div class="video-card-stats">${(v.views || 0).toLocaleString()} views</div>
        </div>
      </div>
    `;
    grid.appendChild(card);
  }
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
    .eq('user_id', currentUser.id)
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

// Tab switching
document.querySelectorAll('.bookmarks-tab').forEach(t => {
  t.addEventListener('click', () => {
    _bookmarksActiveTab = t.dataset.tab;
    document.querySelectorAll('.bookmarks-tab').forEach(x => x.classList.toggle('active', x === t));
    if (_bookmarksActiveTab === 'videos') loadVideoBookmarks();
    else                                   loadBookBookmarks();
  });
});

// Sidebar wire-up
document.getElementById('btnBookmarks')?.addEventListener('click', () => {
  setSidebarActive('btnBookmarks');
  showBookmarks();
});

// ════════════════════════════════════════════════════════════════════════════
// VIDEO BOOKMARK — wire the new button in the player action bar
// ════════════════════════════════════════════════════════════════════════════
async function loadVideoBookmarkState(videoSupabaseId) {
  if (!currentUser || !videoSupabaseId) return;
  const btn = document.getElementById('videoBookmarkBtn');
  if (!btn) return;
  const { data } = await supabase.from('video_bookmarks')
    .select('video_id')
    .eq('user_id', currentUser.id)
    .eq('video_id', videoSupabaseId)
    .maybeSingle();
  setVideoBookmarkActive(!!data);
}

function setVideoBookmarkActive(active) {
  const btn = document.getElementById('videoBookmarkBtn');
  if (!btn) return;
  btn.dataset.active = active ? '1' : '0';
  const icon = btn.querySelector('svg');
  if (icon) icon.setAttribute('fill', active ? 'currentColor' : 'none');
  const label = btn.querySelector('span');
  if (label) label.textContent = active ? 'Saved' : 'Bookmark';
}

async function toggleVideoBookmark(videoSupabaseId) {
  if (!currentUser) { toast('Sign in to bookmark videos', 'error'); return; }
  if (!videoSupabaseId) { toast('Bookmarking only works on new videos for now', 'error'); return; }
  const btn = document.getElementById('videoBookmarkBtn');
  const wasActive = btn?.dataset.active === '1';
  setVideoBookmarkActive(!wasActive); // optimistic
  try {
    if (wasActive) {
      const { error } = await supabase.from('video_bookmarks')
        .delete().eq('user_id', currentUser.id).eq('video_id', videoSupabaseId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('video_bookmarks')
        .insert({ user_id: currentUser.id, video_id: videoSupabaseId });
      if (error && !/duplicate|unique/i.test(error.message)) throw error;
    }
  } catch (e) {
    setVideoBookmarkActive(wasActive);
    toast('Failed: ' + (e.message || e), 'error');
  }
}

document.getElementById('videoBookmarkBtn')?.addEventListener('click', () => {
  const videoId = window._currentVideoCtx?.supabaseId;
  toggleVideoBookmark(videoId);
});

// ════════════════════════════════════════
// AUTHOR — DASHBOARD + BOOK EDITOR + CHAPTER EDITOR
// ════════════════════════════════════════
const authorDashboard       = document.getElementById('authorDashboard');
const authorBookEditor      = document.getElementById('authorBookEditor');
const authorChapterEditor   = document.getElementById('authorChapterEditor');

let authorBooksCache = [];
let editingBookId = null;        // null = new book in editor
let editingChapterId = null;     // null = new chapter
let chapterQuill = null;
let chapterAutosaveTimer = null;
let chapterDirty = false;

// ──────────────────────────────────────────────────────────────────────────
// Curated genre picker — up to 5 selections, premium chip UI
// ──────────────────────────────────────────────────────────────────────────
const SELEBOX_GENRES = [
  'Dark Romance', 'Mafia Boss', 'Billionaire', 'Enemies to Lovers', 'Spicy', 'Contract Marriage',
  'CEO', 'Possession', 'Obsession', 'Alpha', 'Forbidden Love', 'Hot Romance',
  'Arranged Marriage', 'Revenge', 'Twisted Fate', 'Cold', 'Elite', 'Second Chance',
  'Substitute Bride', 'New Adult', 'Contemporary', 'Sweet Love', 'Romance', 'Teen Fiction',
  'Boy Love (BL)', 'Girl Love (GL)', 'Werewolf', 'Vampire', 'Fantasy', 'Mystery', 'Thriller', 'Horror',
  'Action', 'Sci-fi', 'Adventure', 'Mythology', 'Historical', 'Tragic', 'General Fiction',
  'Slice of Life', 'Divorce', 'Poor', 'Secretary', 'Maid', 'Nurse', 'Doctor', 'Professor',
  'Engineer', 'Attorney', 'Pilot', 'Architect', 'Haciendero', 'Wild', 'Comedy',
  'Escape While Pregnant', 'One Shot Story', 'Erotic', 'Valentines Special',
];

function genreSlug(label) {
  return String(label || '').toLowerCase().trim()
    .replace(/\([^)]*\)/g, '')      // drop parenthetical e.g. "(BL)"
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Build a chip picker. Returns { getSelected(), setSelected(arr) }
function buildGenrePicker(containerId, initialSelected = [], max = 5) {
  const root = document.getElementById(containerId);
  if (!root) return null;
  const chipsEl   = root.querySelector('.genre-picker-chips');
  const counterEl = root.querySelector('.genre-picker-count');
  const selected  = new Set();

  // Normalise initial: accept slugs, lowercase strings, or original labels
  const initialSet = new Set();
  for (const v of initialSelected) {
    if (!v) continue;
    const s = String(v).trim();
    // Match against SELEBOX_GENRES by either label or slug
    const hit = SELEBOX_GENRES.find(g => g === s || g.toLowerCase() === s.toLowerCase() || genreSlug(g) === genreSlug(s));
    if (hit) initialSet.add(hit);
  }

  function render() {
    chipsEl.innerHTML = SELEBOX_GENRES.map(g => `
      <button type="button" class="genre-chip ${selected.has(g) ? 'genre-chip-active' : ''}" data-genre="${escHTML(g)}">
        ${escHTML(g)}
      </button>
    `).join('');
    counterEl.textContent = selected.size;
    root.classList.toggle('genre-picker-full', selected.size >= max);
  }

  function toggle(g) {
    if (selected.has(g)) {
      selected.delete(g);
    } else {
      if (selected.size >= max) {
        toast(`Pick up to ${max} genres — remove one to add another`, 'error');
        return;
      }
      selected.add(g);
    }
    render();
  }

  // Seed initial
  for (const g of initialSet) selected.add(g);
  render();

  // Delegate clicks
  chipsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-genre]');
    if (!btn) return;
    toggle(btn.dataset.genre);
  });

  return {
    getSelected: () => [...selected],
    setSelected: (arr) => { selected.clear(); for (const v of (arr || [])) {
      const hit = SELEBOX_GENRES.find(g => g === v || g.toLowerCase() === String(v).toLowerCase());
      if (hit) selected.add(hit);
    } render(); },
    clear: () => { selected.clear(); render(); },
  };
}

// Singletons — populated lazily when their containers exist on screen
let _bookEditorGenrePicker = null;
let _newBookGenrePicker    = null;

function setAuthorView(view) {
  authorDashboard.style.display     = view === 'dashboard' ? 'block' : 'none';
  authorBookEditor.style.display    = view === 'book'      ? 'block' : 'none';
  authorChapterEditor.style.display = view === 'chapter'   ? 'block' : 'none';
}

// ── Dashboard ──
async function loadAuthorDashboard() {
  const content = document.getElementById('authorBooksContent');
  content.innerHTML = '<div class="loading">Loading your books...</div>';

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    content.innerHTML = '<div class="loading">Sign in to start writing.</div>';
    return;
  }

  const { data, error } = await supabase
    .from('books')
    .select('id, title, description, cover_url, genre, status, is_public, views_count, likes_count, chapters_count, word_count, created_at, updated_at, published_at')
    .eq('author_id', user.id)
    .order('updated_at', { ascending: false });

  if (error) {
    content.innerHTML = `<div class="loading">Couldn't load books: ${escHTML(error.message)}</div>`;
    return;
  }

  authorBooksCache = data || [];

  // Stats
  document.getElementById('statMyBooks').textContent = authorBooksCache.length.toLocaleString();
  document.getElementById('statMyChapters').textContent = authorBooksCache.reduce((s, b) => s + (b.chapters_count || 0), 0).toLocaleString();
  document.getElementById('statMyReads').textContent = authorBooksCache.reduce((s, b) => s + (b.views_count || 0), 0).toLocaleString();
  document.getElementById('statMyLikes').textContent = authorBooksCache.reduce((s, b) => s + (b.likes_count || 0), 0).toLocaleString();

  if (!authorBooksCache.length) {
    content.innerHTML = `
      <div class="page-empty">
        <div class="page-empty-icon">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>
        </div>
        <h2 class="page-empty-title">No manuscripts yet</h2>
        <p class="page-empty-body">Click <strong>New book</strong> above to start your first story.</p>
      </div>
    `;
    return;
  }

  content.innerHTML = `
    <div class="author-books-table">
      ${authorBooksCache.map(b => renderAuthorBookRow(b)).join('')}
    </div>
  `;

  content.querySelectorAll('[data-author-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.authorAction;
      const id = btn.dataset.id;
      if (action === 'edit')   openAuthorBookEditor(id);
      else if (action === 'delete') deleteAuthorBook(id);
    });
  });
  content.querySelectorAll('.author-book-row').forEach(row => {
    row.addEventListener('click', () => openAuthorBookEditor(row.dataset.id));
  });
}

function renderAuthorBookRow(b) {
  const initialLetter = (b.title || '?').trim().charAt(0).toUpperCase();
  const cover = b.cover_url
    ? `<img src="${escHTML(b.cover_url)}" alt="" loading="lazy"/>`
    : `<div class="book-cover-placeholder">${initialLetter}</div>`;
  const statusClass = `author-book-status-${b.status || 'draft'}`;
  const visBadge = b.is_public ? '' : ' • Hidden';
  return `
    <div class="author-book-row" data-id="${b.id}">
      <div class="author-book-row-cover">${cover}</div>
      <div class="author-book-row-text">
        <div class="author-book-row-title">${escHTML(b.title || 'Untitled')}</div>
        <div class="author-book-row-genre">${escHTML((b.genre || '—').replace(/-/g, ' '))}${visBadge}</div>
      </div>
      <div><span class="author-book-status-badge ${statusClass}">${b.status || 'draft'}</span></div>
      <div class="author-book-row-stat">${(b.chapters_count || 0)} ch</div>
      <div class="author-book-row-stat">${(b.views_count || 0).toLocaleString()} 👁</div>
      <div class="author-book-row-actions">
        <button class="author-book-action-btn" data-author-action="edit" data-id="${b.id}" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="author-book-action-btn author-book-action-btn-danger" data-author-action="delete" data-id="${b.id}" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
      </div>
    </div>
  `;
}

async function deleteAuthorBook(bookId) {
  const b = authorBooksCache.find(x => x.id === bookId);
  if (!b) return;
  const ok = await confirmDialog({
    title: `Delete "${b.title || 'this book'}"?`,
    body: 'This permanently removes the book and all its chapters. This can\'t be undone.',
    confirmLabel: 'Delete forever',
  });
  if (!ok) return;
  const { error } = await supabase.from('books').delete().eq('id', bookId);
  if (error) { toast('Failed to delete: ' + error.message, 'error'); return; }
  toast('Book deleted', 'success');
  loadAuthorDashboard();
}

// ── New book modal ──
const newBookModal = document.getElementById('newBookModal');
function openNewBookModal() {
  document.getElementById('newBookTitle').value = '';
  document.getElementById('newBookDescription').value = '';
  // Build / reset the new-book genre picker
  if (!_newBookGenrePicker) {
    _newBookGenrePicker = buildGenrePicker('newBookGenrePicker', [], 5);
  } else {
    _newBookGenrePicker.clear();
  }
  newBookModal.style.display = 'flex';
  setTimeout(() => document.getElementById('newBookTitle').focus(), 50);
}
function closeNewBookModal() { newBookModal.style.display = 'none'; }
async function createNewBook() {
  const title = document.getElementById('newBookTitle').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }
  const description = document.getElementById('newBookDescription').value.trim();

  const curated = _newBookGenrePicker?.getSelected() || [];
  const genre = curated.length ? genreSlug(curated[0]) : null;
  const tags  = curated;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { toast('Sign in first', 'error'); return; }

  const btn = document.getElementById('newBookCreate');
  btn.disabled = true; btn.textContent = 'Creating…';

  const { data, error } = await supabase.from('books').insert({
    author_id: user.id,
    title, description, genre, tags,
    status: 'draft',
    is_public: false,
  }).select().single();

  btn.disabled = false; btn.textContent = 'Create book';

  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  closeNewBookModal();
  toast('Book created', 'success');
  openAuthorBookEditor(data.id);
}

document.getElementById('btnNewBook')?.addEventListener('click', openNewBookModal);
// Compose-area Book button (opens the same New Book modal)
document.getElementById('btnOpenBookUpload')?.addEventListener('click', () => {
  openNewBookModal();
});
document.getElementById('newBookClose')?.addEventListener('click', closeNewBookModal);
document.getElementById('newBookCancel')?.addEventListener('click', closeNewBookModal);
document.getElementById('newBookCreate')?.addEventListener('click', createNewBook);
newBookModal?.addEventListener('click', (e) => { if (e.target === newBookModal) closeNewBookModal(); });

// ── Book editor (metadata + chapter list) ──
async function openAuthorBookEditor(bookId) {
  editingBookId = bookId;
  hideAllMainPages();
  authorPage.style.display = 'block';
  setAuthorView('book');
  history.pushState(null, '', `#author/book/${bookId}`);
  await loadBookEditor(bookId);
}

async function loadBookEditor(bookId) {
  const { data: book, error } = await supabase
    .from('books')
    .select('*')
    .eq('id', bookId)
    .single();
  if (error || !book) { toast('Book not found', 'error'); showAuthor(); return; }

  document.getElementById('bookEditorTitle').value = book.title || '';
  document.getElementById('bookEditorDescription').value = book.description || '';
  document.getElementById('bookEditorBookStatus').value = book.status || 'draft';
  document.getElementById('bookEditorPublic').checked = !!book.is_public;
  document.getElementById('bookEditorStatusBadge').textContent = book.is_public ? 'Visible to readers' : 'Hidden draft';

  // Build / refresh genre picker. Seed from book.tags first (where curated genres live),
  // fall back to book.genre (single legacy slug). Unknown freeform tags go to the Custom tags input.
  const allTags = Array.isArray(book.tags) ? book.tags : [];
  const knownLabels    = new Set(SELEBOX_GENRES.map(g => g.toLowerCase()));
  const knownSlugs     = new Set(SELEBOX_GENRES.map(g => genreSlug(g)));
  const curatedSeeded  = allTags.filter(t => knownLabels.has(String(t).toLowerCase()) || knownSlugs.has(genreSlug(t)));
  const customTagsLeft = allTags.filter(t => !curatedSeeded.includes(t));

  // If the picker doesn't exist yet (first open), build it; else just reset selection
  if (!_bookEditorGenrePicker) {
    _bookEditorGenrePicker = buildGenrePicker('bookEditorGenrePicker', curatedSeeded.length ? curatedSeeded : (book.genre ? [book.genre] : []), 5);
  } else {
    _bookEditorGenrePicker.setSelected(curatedSeeded.length ? curatedSeeded : (book.genre ? [book.genre] : []));
  }

  document.getElementById('bookEditorTags').value = customTagsLeft.join(', ');

  const coverWrap = document.getElementById('bookEditorCover');
  const initialLetter = (book.title || '?').trim().charAt(0).toUpperCase();
  coverWrap.innerHTML = book.cover_url
    ? `<img src="${escHTML(book.cover_url)}" alt=""/>`
    : `<div class="book-cover-placeholder">${initialLetter}</div>`;

  // Load chapters
  const { data: chapters, error: chErr } = await supabase
    .from('chapters')
    .select('id, chapter_number, title, word_count, is_published, updated_at')
    .eq('book_id', bookId)
    .order('chapter_number', { ascending: true });

  const chList = document.getElementById('bookEditorChapters');
  if (chErr) {
    chList.innerHTML = `<div class="loading">Couldn't load chapters: ${escHTML(chErr.message)}</div>`;
    return;
  }
  if (!chapters?.length) {
    chList.innerHTML = '<div style="color:var(--text2);padding:1rem 0">No chapters yet. Click <strong>Add chapter</strong> to write the first one.</div>';
    return;
  }
  chList.innerHTML = chapters.map(c => `
    <div class="author-chapter-row" data-chapter-id="${c.id}">
      <span class="author-chapter-num">Ch ${c.chapter_number}</span>
      <span class="author-chapter-title">${escHTML(c.title || `Chapter ${c.chapter_number}`)}</span>
      <span class="author-chapter-meta">${(c.word_count || 0).toLocaleString()} words</span>
      <span class="author-chapter-pub-pill ${c.is_published ? 'author-chapter-pub-published' : 'author-chapter-pub-draft'}">${c.is_published ? 'Published' : 'Draft'}</span>
      <div class="author-chapter-actions">
        <button class="author-book-action-btn" data-chapter-action="edit" data-id="${c.id}" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="author-book-action-btn author-book-action-btn-danger" data-chapter-action="delete" data-id="${c.id}" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  chList.querySelectorAll('[data-chapter-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.chapterAction;
      const chapterId = btn.dataset.id;
      if (action === 'edit') openAuthorChapterEditor(bookId, chapterId);
      else if (action === 'delete') deleteAuthorChapter(chapterId, bookId);
    });
  });
  chList.querySelectorAll('.author-chapter-row').forEach(row => {
    row.addEventListener('click', () => openAuthorChapterEditor(bookId, row.dataset.chapterId));
  });
}

async function saveBookMetadata() {
  if (!editingBookId) return;
  const btn = document.getElementById('btnSaveBook');
  const title = document.getElementById('bookEditorTitle').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }

  btn.disabled = true; btn.textContent = 'Saving…';

  // Combine curated genres (from picker) + free-form custom tags
  const curated = _bookEditorGenrePicker?.getSelected() || [];
  const customTags = document.getElementById('bookEditorTags').value.split(',').map(t => t.trim()).filter(Boolean);
  // De-dupe — case-insensitive
  const seen = new Set();
  const tags = [...curated, ...customTags].filter(t => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  // Browse filter still uses single `genre` field — slug of first selected curated genre
  const genre = curated.length ? genreSlug(curated[0]) : null;
  const description = document.getElementById('bookEditorDescription').value.trim();
  const status = document.getElementById('bookEditorBookStatus').value;
  const isPublic = document.getElementById('bookEditorPublic').checked;

  const update = {
    title, description, genre, tags, status, is_public: isPublic,
    updated_at: new Date().toISOString(),
  };
  // Set published_at the first time the book becomes public
  if (isPublic) {
    const { data: existing } = await supabase.from('books').select('published_at').eq('id', editingBookId).single();
    if (!existing?.published_at) update.published_at = new Date().toISOString();
  }

  const { error } = await supabase.from('books').update(update).eq('id', editingBookId);
  btn.disabled = false; btn.textContent = 'Save';

  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  toast('Saved', 'success');
  document.getElementById('bookEditorStatusBadge').textContent = isPublic ? 'Visible to readers' : 'Hidden draft';
}
document.getElementById('btnSaveBook')?.addEventListener('click', saveBookMetadata);
document.getElementById('btnBackToDashboard')?.addEventListener('click', showAuthor);

// Cover upload
document.getElementById('btnUploadCover')?.addEventListener('click', () => {
  document.getElementById('bookCoverFile').click();
});
document.getElementById('bookCoverFile')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !editingBookId) return;
  if (!file.type.startsWith('image/')) { toast('Pick an image file', 'error'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('Cover must be under 5MB', 'error'); return; }

  toast('Uploading cover…', '');
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { toast('Sign in first', 'error'); return; }

  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${user.id}/${editingBookId}-${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage.from('book-covers').upload(path, file, { upsert: true, contentType: file.type });
  if (upErr) { toast('Upload failed: ' + upErr.message, 'error'); return; }

  const { data: { publicUrl } } = supabase.storage.from('book-covers').getPublicUrl(path);
  const { error: updErr } = await supabase.from('books').update({ cover_url: publicUrl, updated_at: new Date().toISOString() }).eq('id', editingBookId);
  if (updErr) { toast('Saved file but DB update failed: ' + updErr.message, 'error'); return; }

  document.getElementById('bookEditorCover').innerHTML = `<img src="${escHTML(publicUrl)}" alt=""/>`;
  toast('Cover updated', 'success');
});

// New chapter
document.getElementById('btnNewChapter')?.addEventListener('click', () => {
  if (!editingBookId) return;
  openAuthorChapterEditor(editingBookId, null);
});

async function deleteAuthorChapter(chapterId, bookId) {
  const ok = await confirmDialog({
    title: 'Delete this chapter?',
    body: 'The chapter and its content will be permanently removed. This can\'t be undone.',
    confirmLabel: 'Delete forever',
  });
  if (!ok) return;
  const { error } = await supabase.from('chapters').delete().eq('id', chapterId);
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  // Recompute denormalized counts
  await recomputeBookCounts(bookId);
  toast('Chapter deleted', 'success');
  loadBookEditor(bookId);
}

async function recomputeBookCounts(bookId) {
  const { data: rows } = await supabase
    .from('chapters')
    .select('word_count, is_published')
    .eq('book_id', bookId);
  if (!rows) return;
  const chaptersCount = rows.filter(r => r.is_published).length;
  const wordCount = rows.reduce((s, r) => s + (r.word_count || 0), 0);
  await supabase.from('books').update({ chapters_count: chaptersCount, word_count: wordCount, updated_at: new Date().toISOString() }).eq('id', bookId);
}

// ── Chapter editor (Quill) ──
async function openAuthorChapterEditor(bookId, chapterId) {
  editingBookId = bookId;
  editingChapterId = chapterId;
  hideAllMainPages();
  authorPage.style.display = 'block';
  setAuthorView('chapter');
  history.pushState(null, '', `#author/book/${bookId}/chapter/${chapterId || 'new'}`);

  // Init Quill on first use
  if (!chapterQuill) {
    chapterQuill = new Quill('#chapterEditorQuill', {
      theme: 'snow',
      placeholder: 'Start writing your chapter…',
      modules: {
        toolbar: {
          container: [
            [{ header: [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ list: 'ordered' }, { list: 'bullet' }],
            ['blockquote', 'link', 'image'],
            [{ align: [] }],
            ['clean'],
          ],
          handlers: {
            image: openChapterImagePicker,
          },
        },
      },
    });
    chapterQuill.on('text-change', () => {
      chapterDirty = true;
      updateChapterWordCount();
      scheduleChapterAutosave();
    });
    document.getElementById('chapterEditorTitle').addEventListener('input', () => {
      chapterDirty = true;
      scheduleChapterAutosave();
    });
    document.getElementById('chapterEditorPublished').addEventListener('change', () => {
      chapterDirty = true;
      scheduleChapterAutosave();
    });

    // ─── Chapter cover upload ───
    document.getElementById('btnUploadChapterCover')?.addEventListener('click', () => {
      document.getElementById('chapterCoverFile').click();
    });
    document.getElementById('btnReplaceChapterCover')?.addEventListener('click', () => {
      document.getElementById('chapterCoverFile').click();
    });
    document.getElementById('btnRemoveChapterCover')?.addEventListener('click', removeChapterCover);
    document.getElementById('chapterCoverFile')?.addEventListener('change', uploadChapterCover);

    // ─── Inline content image upload ───
    document.getElementById('chapterContentImageFile')?.addEventListener('change', uploadChapterInlineImage);
  }

  // Reset state
  chapterQuill.setText('');
  document.getElementById('chapterEditorTitle').value = '';
  document.getElementById('chapterEditorPublished').checked = false;
  setChapterCoverPreview(null);
  setChapterSaveStatus('idle');
  chapterDirty = false;

  if (chapterId) {
    const { data, error } = await supabase
      .from('chapters')
      .select('id, chapter_number, title, content, is_published, cover_url')
      .eq('id', chapterId)
      .single();
    if (error || !data) { toast('Chapter not found', 'error'); openAuthorBookEditor(bookId); return; }
    document.getElementById('chapterEditorTitle').value = data.title || '';
    document.getElementById('chapterEditorPublished').checked = !!data.is_published;
    setChapterCoverPreview(data.cover_url || null);
    if (data.content) chapterQuill.clipboard.dangerouslyPasteHTML(data.content);
    chapterDirty = false;
  }

  updateChapterWordCount();
  setTimeout(() => chapterQuill.focus(), 100);
}

function updateChapterWordCount() {
  if (!chapterQuill) return;
  const text = chapterQuill.getText().trim();
  const words = text.length ? text.split(/\s+/).length : 0;
  document.getElementById('chapterWordCount').textContent = words.toLocaleString();
}

function setChapterSaveStatus(state) {
  const el = document.getElementById('chapterSaveStatus');
  el.classList.remove('saving', 'saved', 'error');
  if (state === 'saving')      { el.classList.add('saving'); el.textContent = 'Saving…'; }
  else if (state === 'saved')  { el.classList.add('saved');  el.textContent = 'Saved'; }
  else if (state === 'error')  { el.classList.add('error');  el.textContent = 'Save failed'; }
  else                          el.textContent = 'Idle';
}

function scheduleChapterAutosave() {
  if (chapterAutosaveTimer) clearTimeout(chapterAutosaveTimer);
  chapterAutosaveTimer = setTimeout(saveChapter, 1500);
}

async function saveChapter() {
  if (!editingBookId || !chapterQuill) return;
  setChapterSaveStatus('saving');
  const title = document.getElementById('chapterEditorTitle').value.trim();
  const isPublished = document.getElementById('chapterEditorPublished').checked;
  const content = chapterQuill.root.innerHTML;
  const text = chapterQuill.getText().trim();
  const wordCount = text.length ? text.split(/\s+/).length : 0;

  // Cover URL — null if no cover, otherwise the public URL of uploaded image
  const coverUrl = document.getElementById('chapterCoverImg')?.dataset?.url || null;

  let result;
  if (editingChapterId) {
    result = await supabase.from('chapters').update({
      title, content, word_count: wordCount,
      is_published: isPublished,
      cover_url: coverUrl,
      updated_at: new Date().toISOString(),
    }).eq('id', editingChapterId).select().single();
  } else {
    // Determine next chapter number
    const { data: existing } = await supabase.from('chapters').select('chapter_number').eq('book_id', editingBookId).order('chapter_number', { ascending: false }).limit(1);
    const nextNum = (existing?.[0]?.chapter_number || 0) + 1;
    result = await supabase.from('chapters').insert({
      book_id: editingBookId,
      chapter_number: nextNum,
      title, content, word_count: wordCount,
      is_published: isPublished,
      cover_url: coverUrl,
    }).select().single();
    if (result.data) {
      editingChapterId = result.data.id;
      // Update URL with the real chapter id
      history.replaceState(null, '', `#author/book/${editingBookId}/chapter/${editingChapterId}`);
    }
  }

  if (result.error) {
    setChapterSaveStatus('error');
    return;
  }
  await recomputeBookCounts(editingBookId);
  setChapterSaveStatus('saved');
  chapterDirty = false;
}

// ════════════════════════════════════════════════════════════════════════════
// Chapter cover + inline images
// ════════════════════════════════════════════════════════════════════════════

function setChapterCoverPreview(url) {
  const empty   = document.getElementById('btnUploadChapterCover');
  const img     = document.getElementById('chapterCoverImg');
  const actions = document.getElementById('chapterCoverActions');
  if (!empty || !img || !actions) return;
  if (url) {
    img.src = url;
    img.dataset.url = url;
    img.style.display     = 'block';
    actions.style.display = 'flex';
    empty.style.display   = 'none';
  } else {
    img.removeAttribute('src');
    delete img.dataset.url;
    img.style.display     = 'none';
    actions.style.display = 'none';
    empty.style.display   = 'flex';
  }
}

async function uploadChapterCover(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/'))   { toast('Pick an image file', 'error'); return; }
  if (file.size > 8 * 1024 * 1024)        { toast('Cover must be under 8MB', 'error'); return; }

  toast('Uploading cover…', '');
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { toast('Sign in first', 'error'); return; }

  const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `chapters/${user.id}/${editingBookId || 'unsaved'}-${editingChapterId || 'new'}-${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage.from('book-covers').upload(path, file, { upsert: true, contentType: file.type });
  if (upErr) { toast('Upload failed: ' + upErr.message, 'error'); return; }

  const { data: { publicUrl } } = supabase.storage.from('book-covers').getPublicUrl(path);
  setChapterCoverPreview(publicUrl);

  // If chapter already exists, persist immediately. Otherwise it'll go in via saveChapter.
  if (editingChapterId) {
    await supabase.from('chapters').update({ cover_url: publicUrl, updated_at: new Date().toISOString() }).eq('id', editingChapterId);
  }
  chapterDirty = true;
  scheduleChapterAutosave();
  toast('Cover updated', 'success');
}

async function removeChapterCover() {
  setChapterCoverPreview(null);
  if (editingChapterId) {
    await supabase.from('chapters').update({ cover_url: null, updated_at: new Date().toISOString() }).eq('id', editingChapterId);
  }
  chapterDirty = true;
  scheduleChapterAutosave();
  toast('Cover removed', 'success');
}

// Quill image button → triggers our hidden file input
function openChapterImagePicker() {
  document.getElementById('chapterContentImageFile').click();
}

async function uploadChapterInlineImage(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !chapterQuill) return;
  if (!file.type.startsWith('image/')) { toast('Pick an image file', 'error'); return; }
  if (file.size > 12 * 1024 * 1024)     { toast('Image must be under 12MB', 'error'); return; }

  toast('Uploading image…', '');
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { toast('Sign in first', 'error'); return; }

  const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `chapter-content/${user.id}/${editingChapterId || 'new'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error: upErr } = await supabase.storage.from('book-covers').upload(path, file, { upsert: false, contentType: file.type });
  if (upErr) { toast('Upload failed: ' + upErr.message, 'error'); return; }

  const { data: { publicUrl } } = supabase.storage.from('book-covers').getPublicUrl(path);

  // Insert image at current cursor position. Quill keeps it as <img class="ql-image">
  const range = chapterQuill.getSelection(true);
  chapterQuill.insertEmbed(range.index, 'image', publicUrl, 'user');
  chapterQuill.setSelection(range.index + 1);

  toast('Image inserted', 'success');
  chapterDirty = true;
  scheduleChapterAutosave();
}

document.getElementById('btnSaveChapter')?.addEventListener('click', saveChapter);
document.getElementById('btnBackToBookEditor')?.addEventListener('click', () => {
  if (editingBookId) openAuthorBookEditor(editingBookId);
  else showAuthor();
});

// Warn before leaving while dirty
window.addEventListener('beforeunload', (e) => {
  if (chapterDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ════════════════════════════════════════
// CREATOR STUDIO
// ════════════════════════════════════════

let studioVideosCache = [];
let studioSearchQuery = '';
let studioEditingVideoId = null;

async function loadStudio() {
  const content = document.getElementById('studioContent');
  content.innerHTML = '<div class="empty"><h3>Loading your videos...</h3></div>';
  
  if (!currentUser) {
    content.innerHTML = '<div class="empty"><h3>Please sign in</h3></div>';
    return;
  }
  
  const { data: videos, error } = await supabase
    .from('videos')
    .select('id, title, description, thumbnail_url, video_url, views, likes, duration, status, created_at, tags, category, bunny_video_id')
    .eq('uploader_id', currentUser.id)
    .order('created_at', { ascending: false });
  
  if (error) {
    content.innerHTML = `<div class="empty"><h3>Error loading videos</h3><p>${escHTML(error.message)}</p></div>`;
    return;
  }
  
  studioVideosCache = videos || [];
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
  const totalViews = videos.reduce((sum, v) => sum + (v.views || 0), 0);
  const totalLikes = videos.reduce((sum, v) => sum + (v.likes || 0), 0);
  const publishedCount = videos.filter(v => v.status === 'ready').length;
  
  // Filter by search
  const q = studioSearchQuery.trim().toLowerCase();
  const filtered = q
    ? videos.filter(v => 
        (v.title || '').toLowerCase().includes(q) ||
        (v.description || '').toLowerCase().includes(q) ||
        (v.tags || []).some(t => t.toLowerCase().includes(q))
      )
    : videos;
  
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
      <div class="studio-stat">
        <div class="studio-stat-icon" style="background:linear-gradient(135deg,#22c55e,#10b981)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div>
          <div class="studio-stat-value">${publishedCount.toLocaleString()}</div>
          <div class="studio-stat-label">Published</div>
        </div>
      </div>
    </div>

    <div class="studio-toolbar">
      <div class="studio-search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="studioSearchInput" placeholder="Search your videos..." value="${escHTML(studioSearchQuery)}"/>
      </div>
      <div class="studio-toolbar-info">${filtered.length} of ${totalVideos} ${totalVideos === 1 ? 'video' : 'videos'}</div>
    </div>

    <div class="studio-table-wrap">
      ${filtered.length === 0 ? `
        <div class="studio-empty" style="padding:3rem 1rem">
          <h3>No matches</h3>
          <p>Try a different search term</p>
        </div>
      ` : `
        <table class="studio-table">
          <thead>
            <tr>
              <th class="studio-col-video">Video</th>
              <th class="studio-col-status">Visibility</th>
              <th class="studio-col-date">Date</th>
              <th class="studio-col-views">Views</th>
              <th class="studio-col-likes">Likes</th>
              <th class="studio-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(v => renderStudioRow(v)).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
  
  // Wire up search input
  const searchInput = document.getElementById('studioSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      studioSearchQuery = e.target.value;
      renderStudio();
      // Re-focus the input after re-render
      const newInput = document.getElementById('studioSearchInput');
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(studioSearchQuery.length, studioSearchQuery.length);
      }
    });
  }
  
  // Wire up edit/delete buttons via delegation
  content.querySelectorAll('[data-studio-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.studioAction;
      const id = btn.dataset.id;
      if (action === 'edit') openStudioEditModal(id);
      else if (action === 'delete') deleteStudioVideo(id);
    });
  });
}

function renderStudioRow(v) {
  const thumb = v.thumbnail_url 
    ? `<img src="${escHTML(v.thumbnail_url)}" alt="" loading="lazy"/>` 
    : '<div class="studio-thumb-placeholder"></div>';
  const date = new Date(v.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const desc = v.description 
    ? `<div class="studio-row-desc">${escHTML(v.description.slice(0, 100))}${v.description.length > 100 ? '…' : ''}</div>` 
    : '<div class="studio-row-desc" style="color:#aaa;font-style:italic">No description</div>';
  const statusBadge = v.status === 'ready' 
    ? '<span class="studio-badge studio-badge-ready"><span class="studio-dot studio-dot-green"></span>Public</span>' 
    : `<span class="studio-badge studio-badge-processing"><span class="studio-dot studio-dot-yellow"></span>Processing</span>`;
  const duration = v.duration ? formatDuration(v.duration) : '';
  
  return `
    <tr data-video-id="${v.id}">
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
      <td>${statusBadge}</td>
      <td><span class="studio-cell-muted">${date}</span></td>
      <td>${(v.views || 0).toLocaleString()}</td>
      <td>${(v.likes || 0).toLocaleString()}</td>
      <td>
        <div class="studio-actions">
          <button class="studio-btn" data-studio-action="edit" data-id="${v.id}" title="Edit details">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button class="studio-btn studio-btn-danger" data-studio-action="delete" data-id="${v.id}" title="Delete forever">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `;
}

function openStudioEditModal(videoId) {
  const v = studioVideosCache.find(x => x.id === videoId);
  if (!v) return;
  
  studioEditingVideoId = videoId;
  
  document.getElementById('studioEditTitle').value = v.title || '';
  document.getElementById('studioEditDescription').value = v.description || '';
  document.getElementById('studioEditTags').value = (v.tags || []).join(', ');
  document.getElementById('studioEditCategory').value = v.category || 'general';
  
  const preview = document.getElementById('studioEditPreview');
  const thumb = document.getElementById('studioEditThumb');
  if (v.thumbnail_url) {
    thumb.src = v.thumbnail_url;
    preview.style.display = '';
  } else {
    preview.style.display = 'none';
  }
  
  document.getElementById('studioEditTitleCount').textContent = `${(v.title || '').length} / 100`;
  document.getElementById('studioEditDescCount').textContent = `${(v.description || '').length} / 2000`;
  
  document.getElementById('studioEditModal').style.display = 'flex';
}

function closeStudioEditModal() {
  document.getElementById('studioEditModal').style.display = 'none';
  studioEditingVideoId = null;
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
  const category = document.getElementById('studioEditCategory').value;

  if (!title) {
    toast('Title is required', 'error');
    return;
  }

  setSaving(true);

  const tags = tagsRaw.split(',').map(t => t.trim()).filter(t => t);

  const { error } = await supabase
    .from('videos')
    .update({ title, description, tags, category, updated_at: new Date().toISOString() })
    .eq('id', studioEditingVideoId);

  setSaving(false);

  if (error) {
    toast('Failed to save: ' + error.message, 'error');
    return;
  }

  toast('Saved', 'success');
  closeStudioEditModal();

  // Invalidate caches and reload
  allVideosCache = [];
  loadStudio();
}

async function deleteStudioVideo(videoId) {
  const v = studioVideosCache.find(x => x.id === videoId);
  if (!v) return;

  const ok = await confirmDialog({
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
    allVideosCache = [];
    
    toast('Video deleted', 'success');
    renderStudio();
    
    // 5. Refresh feed if it's open
    if (feedEl.style.display !== 'none') {
      loadFeed();
    }
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

function showVideoPlayer() {
  hideAllMainPages();
  videoPlayerPage.style.display = 'block';
}

document.getElementById('btnVideos').addEventListener('click', () => {
  setSidebarActive('btnVideos');
  if (videosPage.style.display === 'block') {
    // Scroll the actual scrolling element to the very top
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  showVideos();
});
document.getElementById('btnStudio').addEventListener('click', () => {
  setSidebarActive('btnStudio');
  showStudio();
});
document.getElementById('btnBook')?.addEventListener('click', () => {
  setSidebarActive('btnBook');
  showBook();
});
document.getElementById('btnAuthor')?.addEventListener('click', () => {
  setSidebarActive('btnAuthor');
  showAuthor();
});

// "Become an author" CTA inside Book empty state
document.getElementById('btnGoToAuthor')?.addEventListener('click', () => {
  setSidebarActive('btnAuthor');
  showAuthor();
});
document.getElementById('btnBackVideos').addEventListener('click', () => {
  if (currentHls) { currentHls.destroy(); currentHls = null; }
  document.getElementById('videoPlayer').pause();
  showVideos();
});

// Fetch new videos uploaded via web (from Supabase)
async function fetchSupabaseVideos() {
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

async function loadVideos() {
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

function getPersonalizedFeed() {
  const { tagWeights, watchedIds, recentUploaders } = getInterestProfile();
  const hasHistory = Object.keys(tagWeights).length > 0;
  const myId = currentUser?.id;

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

// ── Video search ──
let allVideosCache = [];
let allUploadersCache = {};
let activeSearchQuery = '';
let activeTagFilter = null;

function searchVideos(query, tagFilter) {
  query = (query || '').trim().toLowerCase();
  if (!query && !tagFilter) return allVideosCache;

  // Detect hashtag search (e.g. "#music")
  const hashtagMatch = query.match(/^#(\w+)/);
  const isHashtag = !!hashtagMatch;
  const cleanQuery = isHashtag ? hashtagMatch[1].toLowerCase() : query;

  return allVideosCache.filter(v => {
    // Tag filter (when user clicks a tag pill)
    if (tagFilter) {
      const hasTag = (v.tags || []).some(t => t.toLowerCase() === tagFilter.toLowerCase());
      if (!hasTag) return false;
    }
    if (!cleanQuery) return true;

    // Hashtag mode: ONLY match tags
    if (isHashtag) {
      return (v.tags || []).some(t => t.toLowerCase().includes(cleanQuery));
    }

    // Normal search: match title, description, tags, category, uploader
    const title    = (v.title || '').toLowerCase();
    const desc     = (v.description || '').toLowerCase();
    const tags     = (v.tags || []).join(' ').toLowerCase();
    const category = (v.category || '').replace(/-/g, ' ').toLowerCase();
    const uploader = allUploadersCache[v.uploader];
    const uploaderName = (uploader?.username || v._uploaderInfo?.username || '').toLowerCase();

    return title.includes(cleanQuery)
        || desc.includes(cleanQuery)
        || tags.includes(cleanQuery)
        || category.includes(cleanQuery)
        || uploaderName.includes(cleanQuery);
  });
}

// Adaptive tag chips — blends user's watch-history tags with platform-popular tags.
// YouTube-style: chips reflect what YOU'VE been watching, with some discovery sprinkled in.
function getTopTags(limit = 18) {
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
  const { tagWeights } = (typeof getInterestProfile === 'function')
    ? getInterestProfile()
    : { tagWeights: {} };
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

function renderTagPills() {
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

function runSearch() {
  const filtered = searchVideos(activeSearchQuery, activeTagFilter);
  renderVideoResults(filtered);
}

function renderVideoResults(videos) {
  const grid = document.getElementById('videoGrid');
  if (!videos.length) {
    grid.innerHTML = `
      <div class="video-search-empty">
        <h3>No videos found</h3>
        <p>Try a different keyword or tag</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = '';
  videos.slice(0, 100).forEach((v, i) => {
    const card = renderVideoCard(v, allUploadersCache[v.uploader]);
    card.style.animationDelay = `${i * 0.03}s`;
    grid.appendChild(card);
  });
}

function renderVideoCard(video, uploader) {
  const div = document.createElement('div');
  div.className = 'video-card';
  div.onclick = () => playVideo(video.$id);

  const name = uploader?.username || 'Unknown';
  const avatarHTML = uploader?.avatar ? `<img src="${uploader.avatar}" alt="${name}"/>` : initials(name);

  const thumbHTML = video.thumbnail ? `<img src="${video.thumbnail}" loading="lazy" onerror="this.style.display='none'"/>` : '';
  const resumeTime = getResumeTime(video.$id);
  const videoDuration = video.videoStats?.duration || 0;
  const progressPct = (resumeTime && videoDuration) ? Math.min(100, (resumeTime / videoDuration) * 100) : 0;

  div.innerHTML = `
    <div class="video-thumb">
      ${thumbHTML}
      <video class="preview" muted playsinline preload="none"></video>
      <span class="video-thumb-duration" data-duration></span>
      ${progressPct > 0 ? `<div class="video-thumb-progress"><div class="video-thumb-progress-fill" style="width:${progressPct}%"></div></div>` : ''}
    </div>
    <div class="video-card-info">
      <div class="avatar">${avatarHTML}</div>
      <div class="video-card-text">
        <div class="video-card-title">${escHTML(video.title || 'Untitled')}</div>
        <div class="video-card-meta">
          ${escHTML(name)}<br>
          ${(video.videoStats?.views || 0).toLocaleString()} views • ${timeAgo(video.$createdAt)}
        </div>
      </div>
    </div>
  `;

  // Show duration if available, otherwise fetch from video metadata
  const durationEl = div.querySelector('[data-duration]');
  if (videoDuration) {
    durationEl.textContent = formatDuration(videoDuration);
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
          durationEl.textContent = formatDuration(tempVid.duration);
        }
        setTimeout(() => tempHls.destroy(), 500);
      });
    } else {
      tempVid.src = video.videoUrl;
      tempVid.addEventListener('loadedmetadata', () => {
        durationEl.textContent = formatDuration(tempVid.duration);
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

async function playVideo(videoId) {
  try {
    let video = null;
    let uploader = null;

    // All videos are now Supabase. Cache may be empty if the user navigated
    // directly to #video/sb_... — populate it on demand.
    if (!allVideosCache.length) {
      const fresh = await fetchSupabaseVideos();
      allVideosCache = fresh;
    }
    const cached = allVideosCache.find(v => v.$id === videoId);
    if (!cached) {
      toast('Video not found', 'error');
      return;
    }
    video = cached;
    uploader = cached._uploaderInfo || null;

    showVideoPlayer();
    history.pushState(null, '', `#video/${videoId}`);

    const player = document.getElementById('videoPlayer');
    if (currentHls) { currentHls.destroy(); currentHls = null; }

    const resumeFrom = getResumeTime(videoId);

    const startPlayback = () => {
      if (resumeFrom > 0) {
        player.currentTime = resumeFrom;
        toast(`Resumed at ${formatDuration(resumeFrom)}`, '');
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

    // Save position every 3 seconds
    let saveInterval = setInterval(() => {
      if (!player.paused && player.currentTime > 0) {
        saveResumeTime(videoId, player.currentTime, player.duration);
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

// ── Follow-the-creator button on the video player ──
// Always visible (except on your own video). Falls back to a friendly toast
// when the creator is mobile-only (no matching Supabase profile).
async function setupCreatorFollow(video, uploader) {
  const btn = document.getElementById('btnFollowCreator');
  if (!btn) return;
  btn.style.display = 'none';
  btn.disabled = false;
  btn.classList.remove('following');
  btn.onclick = null;
  if (!currentUser) return;

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

  if (creatorId === currentUser.id) return;   // your own video → hide

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
      .eq('follower_id', currentUser.id)
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
          .eq('follower_id', currentUser.id).eq('following_id', creatorId));
      } else {
        ({ error } = await supabase.from('follows').insert({
          follower_id: currentUser.id, following_id: creatorId,
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
    .eq('follower_id', currentUser.id)
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
        .eq('follower_id', currentUser.id).eq('following_id', creatorId));
    } else {
      ({ error } = await supabase.from('follows').insert({
        follower_id: currentUser.id, following_id: creatorId,
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

// ── Description "Show more" toggle (4-line clamp) ──
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

// Resolve the Supabase video ID from whatever shape `video` happens to be
function resolveSupabaseVideoId(video) {
  if (!video) return null;
  if (video._supabaseId) return video._supabaseId;
  if (video._supabase && video.id) return video.id;
  if (typeof video.$id === 'string' && video.$id.startsWith('sb_')) return video.$id.slice(3);
  return null;
}

// Wire up the comment section on the video player page.
// `video_id` in the comments table is a text column to support legacy
// pre-migration formats; new comments always use the Supabase video UUID.
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
  loadComments(null, videoIdForComments);
  loadCommentCount(null, videoIdForComments);
}

// ── VIDEO ACTIONS: Like / Repost / Share ──
let _currentVideoCtx = null;   // { supabaseId, title, post_id }

async function setupVideoActions(video) {
  const actionsBar = document.getElementById('videoActions');
  if (!actionsBar) return;

  const supabaseVideoId = resolveSupabaseVideoId(video);
  const legacyVideoId   = !supabaseVideoId ? (video?.$id || null) : null;
  const isLegacy        = !supabaseVideoId;
  // Polymorphic id used for the reactions table — works for both Supabase and legacy now
  const videoIdForActions = supabaseVideoId || legacyVideoId;

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
    loadReactions(videoIdForActions, 'video');
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
    repostBtn.onclick = () => repostPost(postIdForRepost);
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
  if (supabaseVideoId) loadVideoBookmarkState(supabaseVideoId);
}

// Update popstate to handle videos
window.addEventListener('popstate', () => {
  const hash = window.location.hash;
  if (hash.startsWith('#profile/')) {
    setSidebarActive('btnProfile');
    openProfile(hash.replace('#profile/', ''));
  } else if (hash === '#videos') {
    setSidebarActive('btnVideos');
    showVideos();
  } else if (hash === '#studio') {
    setSidebarActive('btnStudio');
    showStudio();
  } else if (hash === '#book') {
    setSidebarActive('btnBook');
    showBook();
  } else if (hash.startsWith('#book/')) {
    setSidebarActive('btnBook');
    const bookId = hash.replace('#book/', '').split('/')[0];
    openBookDetail(bookId);
  } else if (hash === '#author') {
    setSidebarActive('btnAuthor');
    showAuthor();
  } else if (hash.startsWith('#author/book/')) {
    setSidebarActive('btnAuthor');
    const parts = hash.replace('#author/book/', '').split('/');
    const bookId = parts[0];
    if (parts[2]) {
      // chapter editor — parts[1] === 'chapter', parts[2] === id or 'new'
      openAuthorChapterEditor(bookId, parts[2] === 'new' ? null : parts[2]);
    } else {
      openAuthorBookEditor(bookId);
    }
  } else if (hash.startsWith('#video/')) {
    setSidebarActive('btnVideos');
    playVideo(hash.replace('#video/', ''));
  } else {
    setSidebarActive('btnHome');
    showFeed();
    loadFeed();
  }
});

// ── Theme toggle ──
function applyTheme(theme) {
  if (theme === 'light') document.body.classList.add('light');
  else document.body.classList.remove('light');
}
applyTheme(localStorage.getItem('selebox_theme') || 'dark');

document.getElementById('btnTheme').addEventListener('click', () => {
  const isLight = document.body.classList.contains('light');
  const newTheme = isLight ? 'dark' : 'light';
  applyTheme(newTheme);
  localStorage.setItem('selebox_theme', newTheme);
});

// ════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════
const NOTIF_PAGE_SIZE = 25;
let _notifications = [];
let _notifUnreadCount = 0;
let _notifChannel = null;
let _notifPanelOpen = false;
let _notifFilter = 'all';      // 'all' | 'you' | 'following'
const _notifActorCache = {};   // user_id → { username, avatar_url }

// Categorize a notification for the filter tabs
function notifCategory(n) {
  return (n?.type || '').startsWith('follow_') ? 'following' : 'you';
}

async function initNotifications() {
  if (!currentUser) return;

  await loadNotifications();

  // Realtime — subscribe to new notifications for this user only
  if (_notifChannel) {
    try { supabase.removeChannel(_notifChannel); } catch {}
    _notifChannel = null;
  }
  try {
    _notifChannel = supabase
      .channel(`notif:${currentUser.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${currentUser.id}`,
      }, async (payload) => {
        const n = payload.new;
        // Fetch the actor profile for nicer rendering
        await hydrateActorProfiles([n]);
        _notifications.unshift(n);
        if (_notifications.length > 100) _notifications.length = 100;
        _notifUnreadCount += 1;
        updateNotifBadge();
        renderNotifications();
        // Subtle toast so the user knows something happened
        toast(notificationLabel(n), 'success');
      })
      .subscribe();
  } catch (err) {
    console.warn('Notifications realtime subscribe failed:', err);
  }
}

async function loadNotifications() {
  const list = document.getElementById('notificationsList');
  if (list) list.innerHTML = '<div class="notifications-empty">Loading…</div>';

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('recipient_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(NOTIF_PAGE_SIZE);

  if (error) {
    if (list) list.innerHTML = `<div class="notifications-empty">Couldn't load notifications</div>`;
    console.warn('Notifications fetch error:', error);
    return;
  }
  _notifications = data || [];
  await hydrateActorProfiles(_notifications);

  _notifUnreadCount = _notifications.filter(n => !n.is_read).length;
  updateNotifBadge();
  renderNotifications();
}

async function hydrateActorProfiles(items) {
  const ids = [...new Set(items.map(n => n.actor_id).filter(Boolean).filter(id => !_notifActorCache[id]))];
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

  list.innerHTML = visible.map(n => {
    const actor = _notifActorCache[n.actor_id] || {};
    const avatar = actor.avatar_url
      ? `<img src="${escHTML(actor.avatar_url)}"/>`
      : (actor.username ? initials(actor.username) : '?');
    const text = notificationLabel(n, actor.username);
    const snippet = n.metadata?.snippet || n.metadata?.caption || '';
    const snippetHTML = snippet
      ? `<div class="notification-snippet">"${escHTML(snippet)}"</div>`
      : '';
    return `
      <div class="notification-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}">
        <div class="notification-avatar">${avatar}</div>
        <div class="notification-body">
          <div class="notification-text">${text}</div>
          ${snippetHTML}
          <div class="notification-time">${timeAgo(n.created_at)}</div>
        </div>
        <span class="notification-dot"></span>
      </div>`;
  }).join('');

  list.querySelectorAll('.notification-item').forEach(item => {
    item.addEventListener('click', () => onNotificationClick(item.dataset.id));
  });
}

function notificationLabel(n, knownUsername) {
  const username = knownUsername || _notifActorCache[n.actor_id]?.username || 'Someone';
  const actorTag = `<strong>${escHTML(username)}</strong>`;
  const titleHint = n.metadata?.title ? ` <em style="color:var(--text2)">"${escHTML(n.metadata.title)}"</em>` : '';
  switch (n.type) {
    // ── You: engagement on your stuff ──
    case 'like_post':              return `${actorTag} reacted to your post`;
    case 'like_comment':           return `${actorTag} reacted to your comment`;
    case 'like_book':              return `${actorTag} liked your book${titleHint}`;
    case 'comment_post':           return `${actorTag} commented on your post`;
    case 'comment_video':          return `${actorTag} commented on your video`;
    case 'reply_comment':          return `${actorTag} replied to your comment`;
    case 'comment_chapter':        return `${actorTag} commented on your chapter`;
    case 'reply_chapter_comment':  return `${actorTag} replied to your chapter comment`;
    case 'repost_post':            return `${actorTag} reposted your post`;

    // ── Following: people you follow doing things ──
    case 'follow_new_post':        return `${actorTag} posted something new`;
    case 'follow_new_video':       return `${actorTag} uploaded a new video`;
    case 'follow_new_book':        return `${actorTag} published a new book${titleHint}`;
    case 'follow_repost':          return `${actorTag} shared a post`;

    // ── Mentions ──
    case 'mention_comment':        return `${actorTag} mentioned you in a comment`;
    case 'mention_chapter_comment':return `${actorTag} mentioned you in a chapter comment`;

    default:                       return `${actorTag} did something on Selebox`;
  }
}

async function onNotificationClick(notifId) {
  const n = _notifications.find(x => x.id === notifId);
  if (!n) return;

  // Mark as read locally + in DB (optimistic)
  if (!n.is_read) {
    n.is_read = true;
    _notifUnreadCount = Math.max(0, _notifUnreadCount - 1);
    updateNotifBadge();
    renderNotifications();
    supabase.from('notifications').update({ is_read: true }).eq('id', notifId)
      .then(({ error }) => { if (error) console.warn('Mark read failed:', error); });
  }

  closeNotifPanel();

  // Navigate to a sensible target
  if (n.target_type === 'book' || n.parent_target_type === 'book') {
    const bookId = (n.target_type === 'book') ? n.target_id : n.parent_target_id;
    if (bookId) openBookDetail(bookId);
  } else if (n.target_type === 'chapter' || n.parent_target_type === 'chapter') {
    const bookId = n.parent_target_type === 'book' ? n.parent_target_id : null;
    if (bookId) openBookDetail(bookId);
  } else if (n.target_type === 'video' || n.parent_target_type === 'video') {
    // target_id / parent_target_id is a video UUID → prefix "sb_" for playVideo.
    const supabaseUuid = n.target_type === 'video' ? n.target_id : n.parent_target_id;
    if (supabaseUuid) playVideo('sb_' + supabaseUuid);
  } else if (n.parent_target_type === 'post' || n.target_type === 'post') {
    // We don't have post-detail pages yet — drop them on Home so they can find it
    setSidebarActive('btnHome');
    showFeed();
  } else {
    setSidebarActive('btnHome');
    showFeed();
  }
}

async function markAllNotificationsRead() {
  if (!_notifUnreadCount) return;
  const unread = _notifications.filter(n => !n.is_read).map(n => n.id);
  _notifications.forEach(n => { n.is_read = true; });
  _notifUnreadCount = 0;
  updateNotifBadge();
  renderNotifications();
  if (unread.length) {
    const { error } = await supabase.from('notifications').update({ is_read: true }).in('id', unread);
    if (error) console.warn('Mark all read failed:', error);
  }
}

function toggleNotifPanel() {
  if (_notifPanelOpen) closeNotifPanel();
  else openNotifPanel();
}
function openNotifPanel() {
  const panel = document.getElementById('notificationsPanel');
  if (!panel) return;
  panel.style.display = 'flex';
  _notifPanelOpen = true;
}
function closeNotifPanel() {
  const panel = document.getElementById('notificationsPanel');
  if (!panel) return;
  panel.style.display = 'none';
  _notifPanelOpen = false;
}

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

// ════════════════════════════════════════
// @MENTION AUTOCOMPLETE
// Type @ in any .comment-input → dropdown with matching usernames.
// Arrow keys navigate, Enter/Tab inserts, Esc closes.
// ════════════════════════════════════════
let _mentionDropdown = null;
let _mentionTextarea = null;
let _mentionResults  = [];
let _mentionIdx      = 0;
let _mentionDebounce = null;

function getMentionDropdown() {
  if (_mentionDropdown) return _mentionDropdown;
  const el = document.createElement('div');
  el.className = 'mention-dropdown';
  el.style.display = 'none';
  document.body.appendChild(el);
  _mentionDropdown = el;
  return el;
}

function closeMentionDropdown() {
  if (_mentionDropdown) _mentionDropdown.style.display = 'none';
  _mentionTextarea = null;
  _mentionResults = [];
  _mentionIdx = 0;
}

function positionMentionDropdown(textarea) {
  const dd = getMentionDropdown();
  const rect = textarea.getBoundingClientRect();
  dd.style.position = 'fixed';
  // Place below the textarea by default; flip above if it would clip the viewport
  const wantTop = rect.bottom + 6;
  const ddH = dd.offsetHeight || 220;
  const flipAbove = wantTop + ddH > window.innerHeight - 12;
  dd.style.top  = `${flipAbove ? Math.max(8, rect.top - ddH - 6) : wantTop}px`;
  dd.style.left = `${Math.max(8, rect.left)}px`;
  dd.style.minWidth = `${Math.min(260, Math.max(220, rect.width * 0.7))}px`;
}

async function maybeShowMentionDropdown(textarea) {
  if (!textarea) return;
  const cursor = textarea.selectionStart ?? textarea.value.length;
  const before = textarea.value.slice(0, cursor);
  // Match @<word> at end of `before`. Allow underscores and digits.
  const match = before.match(/(?:^|\s)@([A-Za-z0-9_]{0,24})$/);
  if (!match) {
    closeMentionDropdown();
    return;
  }
  _mentionTextarea = textarea;
  const query = match[1] || '';
  _mentionIdx = 0;

  // Debounced profile search
  clearTimeout(_mentionDebounce);
  _mentionDebounce = setTimeout(async () => {
    let q = supabase.from('profiles').select('id, username, avatar_url').limit(6);
    if (query) q = q.ilike('username', `${query}%`);
    else q = q.order('username', { ascending: true }).limit(6);
    const { data } = await q;
    _mentionResults = (data || []).filter(p => p.id !== currentUser?.id);
    renderMentionDropdown();
  }, 120);
}

function renderMentionDropdown() {
  const dd = getMentionDropdown();
  if (!_mentionResults.length || !_mentionTextarea) {
    dd.style.display = 'none';
    return;
  }
  dd.innerHTML = _mentionResults.map((p, i) => `
    <div class="mention-item ${i === _mentionIdx ? 'active' : ''}" data-idx="${i}">
      <div class="mention-avatar">${p.avatar_url ? `<img src="${escHTML(p.avatar_url)}"/>` : escHTML((p.username || '?').slice(0,2).toUpperCase())}</div>
      <div class="mention-name"><strong>@${escHTML(p.username || '')}</strong></div>
    </div>
  `).join('');
  dd.querySelectorAll('.mention-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();    // keep textarea focus
      e.stopPropagation();
      selectMention(parseInt(item.dataset.idx, 10));
    });
  });
  dd.style.display = 'block';
  positionMentionDropdown(_mentionTextarea);
}

function selectMention(index) {
  const profile = _mentionResults[index];
  const textarea = _mentionTextarea;
  if (!profile || !textarea) return;
  const cursor = textarea.selectionStart ?? textarea.value.length;
  const before = textarea.value.slice(0, cursor);
  const after  = textarea.value.slice(cursor);
  // Replace the @<typed> at end of `before` with @username + space
  const newBefore = before.replace(/(^|\s)@([A-Za-z0-9_]{0,24})$/, `$1@${profile.username} `);
  textarea.value = newBefore + after;
  const newCursor = newBefore.length;
  textarea.setSelectionRange(newCursor, newCursor);
  // Bubble an input event so any auto-resize textareas re-measure
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  closeMentionDropdown();
}

// Document-level event delegation — works for dynamically created comment textareas
document.addEventListener('input', (e) => {
  const ta = e.target;
  if (!ta || ta.tagName !== 'TEXTAREA') return;
  if (!ta.classList.contains('comment-input')) return;
  maybeShowMentionDropdown(ta);
});

document.addEventListener('keydown', (e) => {
  if (!_mentionTextarea || !_mentionResults.length) return;
  if (_mentionDropdown?.style.display !== 'block') return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _mentionIdx = (_mentionIdx + 1) % _mentionResults.length;
    renderMentionDropdown();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _mentionIdx = (_mentionIdx - 1 + _mentionResults.length) % _mentionResults.length;
    renderMentionDropdown();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    selectMention(_mentionIdx);
  } else if (e.key === 'Escape') {
    closeMentionDropdown();
  }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('.mention-dropdown')) return;
  if (e.target.closest('.comment-input')) return;
  closeMentionDropdown();
});
window.addEventListener('scroll', closeMentionDropdown, true);
window.addEventListener('resize', closeMentionDropdown);

// Render @mentions inside posted comment bodies as clickable links.
// Hooks into the existing linkify pipeline by post-processing its output.
const _origLinkify = typeof linkify === 'function' ? linkify : null;
if (_origLinkify) {
  // Re-define linkify globally (the original was a const-declared function;
  // we override behavior via the same name through the module scope).
  // eslint-disable-next-line no-func-assign
  linkify = function patchedLinkify(str) {
    const html = _origLinkify(str || '');
    return html.replace(/(^|[\s>])@([A-Za-z0-9_]{1,24})\b/g,
      (_, lead, name) => `${lead}<span class="mention-token" data-mention="${escHTML(name)}">@${escHTML(name)}</span>`);
  };
}
// Clicking a rendered @mention → navigate to that user's profile
document.addEventListener('click', async (e) => {
  const tok = e.target.closest('.mention-token');
  if (!tok) return;
  e.stopPropagation();
  const username = tok.dataset.mention;
  if (!username) return;
  const { data } = await supabase.from('profiles').select('id').ilike('username', username).maybeSingle();
  if (data?.id) openProfile(data.id);
  else toast(`User @${username} not found`, 'error');
});

// ════════════════════════════════════════════════════════════════════════════
// DIRECT MESSAGES — Phase 1 (FB Messenger-style with purple)
// Two-pane layout: conversation list on left, active thread on right.
// Realtime via Supabase channel on `messages` table.
// ════════════════════════════════════════════════════════════════════════════

let dmState = {
  conversations: [],            // [{ id, otherUser, lastMessageAt, lastMessagePreview, unread }]
  activeConvId: null,           // currently-open conversation id
  activeOther: null,            // { id, username, avatar_url, ... }
  messages: [],                 // current thread's messages
  realtimeChannel: null,        // active Realtime subscription
  totalUnread: 0,
  inboxChannel: null,           // realtime subscription for unread badge
};

async function showMessages(targetUserId = null) {
  if (!currentUser) { toast('Please sign in', 'error'); return; }
  hideAllMainPages();
  if (messagesPage) messagesPage.style.display = 'block';
  document.body.classList.remove('on-videos');
  history.pushState(null, '', '#messages');
  setSidebarActive('btnMessages');

  await loadConversationList();

  if (targetUserId) {
    // Open or create conversation with this user
    await openConversationWithUser(targetUserId);
  }
}

// ── Conversation list ─────────────────────────────────────────────────────
async function loadConversationList() {
  const wrap = document.getElementById('dmConvList');
  const empty = document.getElementById('dmEmptyList');
  if (!wrap || !currentUser) return;

  // Skeleton while loading
  if (!dmState.conversations.length) {
    wrap.innerHTML = `
      <div class="dm-conv-skel"></div>
      <div class="dm-conv-skel"></div>
      <div class="dm-conv-skel"></div>
    `;
  }

  // Fetch all conversations involving me
  const { data: convs, error } = await supabase
    .from('conversations')
    .select('id, user_a, user_b, last_message_at, last_message_preview, last_message_sender, created_at')
    .or(`user_a.eq.${currentUser.id},user_b.eq.${currentUser.id}`)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(100);

  if (error) {
    wrap.innerHTML = `<div class="dm-error">Couldn't load chats: ${escHTML(error.message)}</div>`;
    return;
  }

  if (!convs || !convs.length) {
    wrap.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  // Hydrate the "other user" profile for each + count unread per convo
  const otherIds = convs.map(c => c.user_a === currentUser.id ? c.user_b : c.user_a);
  const [{ data: profiles }, unreadByConv] = await Promise.all([
    supabase.from('profiles').select('id, username, avatar_url, is_guest').in('id', otherIds),
    fetchUnreadCounts(convs.map(c => c.id)),
  ]);

  const profileMap = new Map((profiles || []).map(p => [p.id, p]));
  let totalUnread = 0;
  dmState.conversations = convs.map(c => {
    const otherId = c.user_a === currentUser.id ? c.user_b : c.user_a;
    const unread = unreadByConv[c.id] || 0;
    totalUnread += unread;
    return {
      id: c.id,
      otherUser: profileMap.get(otherId) || { id: otherId, username: 'Unknown', avatar_url: null },
      lastMessageAt: c.last_message_at,
      lastMessagePreview: c.last_message_preview || '',
      lastMessageSender: c.last_message_sender,
      unread,
    };
  });

  renderConversationList();
  updateUnreadBadge(totalUnread);
}

async function fetchUnreadCounts(conversationIds) {
  if (!conversationIds.length) return {};
  // Pull only unread messages where I'm NOT the sender, group client-side
  const { data } = await supabase
    .from('messages')
    .select('conversation_id, sender_id')
    .in('conversation_id', conversationIds)
    .is('read_at', null)
    .is('deleted_at', null)
    .neq('sender_id', currentUser.id);
  const counts = {};
  (data || []).forEach(m => {
    counts[m.conversation_id] = (counts[m.conversation_id] || 0) + 1;
  });
  return counts;
}

function renderConversationList() {
  const wrap = document.getElementById('dmConvList');
  const empty = document.getElementById('dmEmptyList');
  if (!wrap) return;

  if (!dmState.conversations.length) {
    wrap.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  wrap.innerHTML = dmState.conversations.map(c => renderConvItemHtml(c)).join('');
  // Wire clicks
  wrap.querySelectorAll('.dm-conv-item').forEach(el => {
    el.onclick = () => openConversation(el.dataset.convId);
  });
}

function renderConvItemHtml(c) {
  const { otherUser } = c;
  const safeName = escHTML(otherUser.username || 'Unknown');
  const avatar = otherUser.avatar_url
    ? `<img src="${escHTML(otherUser.avatar_url)}" alt=""/>`
    : `<span class="dm-avatar-initials">${initials(otherUser.username)}</span>`;
  const isMine = c.lastMessageSender === currentUser.id;
  const previewPrefix = isMine ? 'You: ' : '';
  const preview = c.lastMessagePreview ? previewPrefix + escHTML(c.lastMessagePreview) : '<em>No messages yet</em>';
  const time = c.lastMessageAt ? timeAgo(c.lastMessageAt) : '';
  const isActive = c.id === dmState.activeConvId;
  const unreadCls = c.unread > 0 ? ' has-unread' : '';
  return `
    <button class="dm-conv-item${isActive ? ' active' : ''}${unreadCls}" data-conv-id="${c.id}">
      <div class="dm-conv-avatar">${avatar}</div>
      <div class="dm-conv-meta">
        <div class="dm-conv-row">
          <span class="dm-conv-name">${safeName}</span>
          <span class="dm-conv-time">${time}</span>
        </div>
        <div class="dm-conv-preview">${preview}</div>
      </div>
      ${c.unread > 0 ? `<span class="dm-conv-unread">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
    </button>
  `;
}

// ── Open a thread ─────────────────────────────────────────────────────────
async function openConversationWithUser(otherUserId) {
  // Resolve / create the conversation, then open it
  const { data: convId, error } = await supabase
    .rpc('get_or_create_conversation', { p_other_user_id: otherUserId });

  if (error) {
    if (/blocked/i.test(error.message)) toast('Cannot message blocked user', 'error');
    else toast(error.message, 'error');
    return;
  }
  await loadConversationList();
  await openConversation(convId);
}

async function openConversation(convId) {
  if (!convId || !currentUser) return;
  dmState.activeConvId = convId;

  // Find conversation in cache (or refetch)
  let conv = dmState.conversations.find(c => c.id === convId);
  if (!conv) {
    // Fetch directly
    const { data } = await supabase.from('conversations').select('*').eq('id', convId).single();
    if (!data) { toast('Conversation not found', 'error'); return; }
    const otherId = data.user_a === currentUser.id ? data.user_b : data.user_a;
    const { data: prof } = await supabase.from('profiles').select('id, username, avatar_url, is_guest').eq('id', otherId).single();
    conv = {
      id: data.id,
      otherUser: prof || { id: otherId, username: 'Unknown', avatar_url: null },
      lastMessageAt: data.last_message_at,
      lastMessagePreview: data.last_message_preview || '',
      unread: 0,
    };
  }
  dmState.activeOther = conv.otherUser;

  // Show active panel, hide empty placeholder
  document.getElementById('dmThreadEmpty').style.display = 'none';
  document.getElementById('dmThreadActive').style.display = 'flex';

  // Header
  const av = document.getElementById('dmThreadAvatar');
  const u = conv.otherUser;
  av.innerHTML = (u.avatar_url
    ? `<img src="${escHTML(u.avatar_url)}" alt=""/>`
    : `<span class="dm-avatar-initials">${initials(u.username)}</span>`) +
    `<span class="dm-online-dot" id="dmOnlineDot" style="display:none"></span>`;
  av.onclick = () => openProfile(u.id);
  const nameBtn = document.getElementById('dmThreadName');
  nameBtn.textContent = u.username || 'Unknown';
  nameBtn.onclick = () => openProfile(u.id);
  document.getElementById('dmThreadStatus').textContent = '';

  // Highlight in list
  document.querySelectorAll('.dm-conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.convId === convId);
  });

  // Mobile: collapse list, show thread
  document.querySelector('.dm-shell')?.classList.add('thread-open');

  // Load messages
  await loadMessages(convId);

  // Mark as read (server-side) — fire-and-forget
  supabase.rpc('mark_conversation_read', { p_conversation_id: convId }).then(() => {
    // Refresh local unread count
    const c = dmState.conversations.find(x => x.id === convId);
    if (c) c.unread = 0;
    renderConversationList();
    const total = dmState.conversations.reduce((sum, x) => sum + (x.unread || 0), 0);
    updateUnreadBadge(total);
  });

  // Subscribe to realtime updates for this conversation
  subscribeToThread(convId);
}

async function loadMessages(convId) {
  const wrap = document.getElementById('dmMessages');
  if (!wrap) return;
  wrap.innerHTML = '<div class="dm-loading">Loading messages…</div>';

  const { data, error } = await supabase
    .from('messages')
    .select('id, conversation_id, sender_id, body, created_at, read_at, edited_at, deleted_at')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) {
    wrap.innerHTML = `<div class="dm-error">Couldn't load messages: ${escHTML(error.message)}</div>`;
    return;
  }
  dmState.messages = data || [];
  renderMessages();
  scrollMessagesToBottom();
}

// ── Render messages with FB-style grouping ────────────────────────────────
function renderMessages() {
  const wrap = document.getElementById('dmMessages');
  if (!wrap) return;

  if (!dmState.messages.length) {
    wrap.innerHTML = `
      <div class="dm-thread-intro">
        <div class="dm-thread-intro-avatar">${dmState.activeOther?.avatar_url
          ? `<img src="${escHTML(dmState.activeOther.avatar_url)}"/>`
          : initials(dmState.activeOther?.username)}</div>
        <h3>${escHTML(dmState.activeOther?.username || '')}</h3>
        <p>Say hello — your first message starts the conversation.</p>
      </div>
    `;
    return;
  }

  // Identify the LAST message sent by ME that the OTHER has already read,
  // so we can stick the read avatar to it (FB pattern).
  let lastReadOfMine = null;
  for (let i = dmState.messages.length - 1; i >= 0; i--) {
    const m = dmState.messages[i];
    if (m.sender_id === currentUser.id && m.read_at) { lastReadOfMine = m.id; break; }
  }

  let lastDateStamp = '';
  let html = '';
  for (let i = 0; i < dmState.messages.length; i++) {
    const m = dmState.messages[i];
    const prev = dmState.messages[i - 1];
    const next = dmState.messages[i + 1];
    const mine = m.sender_id === currentUser.id;

    // Date separator (every ~30 min gap or new day)
    const stamp = formatMessageDateStamp(m.created_at, prev?.created_at);
    if (stamp && stamp !== lastDateStamp) {
      html += `<div class="dm-date-sep">${stamp}</div>`;
      lastDateStamp = stamp;
    }

    // Grouping: this message belongs to the same "burst" if same sender as prev/next AND within 5 min
    const isFirstInGroup = !prev || prev.sender_id !== m.sender_id || (new Date(m.created_at) - new Date(prev.created_at)) > 5 * 60000;
    const isLastInGroup  = !next || next.sender_id !== m.sender_id || (new Date(next.created_at) - new Date(m.created_at)) > 5 * 60000;

    const bubbleCls = `dm-bubble ${mine ? 'mine' : 'theirs'}` +
      (isFirstInGroup ? ' first-in-group' : '') +
      (isLastInGroup  ? ' last-in-group'  : '');

    const showAvatar = !mine && isLastInGroup;
    const avatarHtml = showAvatar
      ? `<div class="dm-bubble-avatar">${dmState.activeOther?.avatar_url
          ? `<img src="${escHTML(dmState.activeOther.avatar_url)}"/>`
          : initials(dmState.activeOther?.username)}</div>`
      : '<div class="dm-bubble-avatar-spacer"></div>';

    const body = m.deleted_at
      ? `<em class="dm-bubble-deleted">Message deleted</em>`
      : escHTML(m.body || '').replace(/\n/g, '<br>');

    const readBadge = mine && m.id === lastReadOfMine
      ? `<div class="dm-bubble-read" title="Seen ${timeAgo(m.read_at)}">
          ${dmState.activeOther?.avatar_url
            ? `<img src="${escHTML(dmState.activeOther.avatar_url)}"/>`
            : `<span>${initials(dmState.activeOther?.username)}</span>`}
        </div>`
      : '';

    html += `
      <div class="dm-bubble-row ${mine ? 'mine' : 'theirs'}" data-msg-id="${m.id}">
        ${!mine ? avatarHtml : ''}
        <div class="${bubbleCls}" title="${new Date(m.created_at).toLocaleString()}">
          ${linkify(body)}
        </div>
        ${mine ? readBadge : ''}
      </div>
    `;
  }
  wrap.innerHTML = html;
}

function formatMessageDateStamp(current, previous) {
  const cur = new Date(current);
  if (!previous) {
    // Always show stamp for the first message
    return formatStampLabel(cur);
  }
  const prev = new Date(previous);
  const gapMs = cur - prev;
  if (gapMs > 30 * 60 * 1000 || cur.toDateString() !== prev.toDateString()) {
    return formatStampLabel(cur);
  }
  return null;
}

function formatStampLabel(d) {
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const dayStart = new Date(d); dayStart.setHours(0,0,0,0);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (dayStart.getTime() === today.getTime())     return `Today at ${t}`;
  if (dayStart.getTime() === yesterday.getTime()) return `Yesterday at ${t}`;
  // older
  const dateStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `${dateStr} at ${t}`;
}

function scrollMessagesToBottom() {
  const wrap = document.getElementById('dmMessages');
  if (wrap) requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
}

// ── Send a message ────────────────────────────────────────────────────────
async function sendDmMessage() {
  const input = document.getElementById('dmInput');
  if (!input || !dmState.activeConvId) return;
  const body = input.value.trim();
  if (!body) {
    // Empty composer + send click = thumbs-up emoji (FB classic)
    return sendDmThumbsUp();
  }

  // Optimistic render
  const tempId = 'temp-' + Date.now();
  const optimistic = {
    id: tempId,
    conversation_id: dmState.activeConvId,
    sender_id: currentUser.id,
    body,
    created_at: new Date().toISOString(),
    read_at: null,
    _pending: true,
  };
  dmState.messages.push(optimistic);
  renderMessages();
  scrollMessagesToBottom();
  input.value = '';
  resizeDmInput();
  updateSendButton();

  const { data, error } = await supabase.from('messages').insert({
    conversation_id: dmState.activeConvId,
    sender_id: currentUser.id,
    body,
  }).select().single();

  if (error) {
    // Rollback optimistic
    dmState.messages = dmState.messages.filter(m => m.id !== tempId);
    renderMessages();
    toast(error.message, 'error');
    return;
  }
  // Replace temp with real
  const idx = dmState.messages.findIndex(m => m.id === tempId);
  if (idx >= 0) dmState.messages[idx] = data;
  renderMessages();
}

async function sendDmThumbsUp() {
  if (!dmState.activeConvId) return;
  const { data, error } = await supabase.from('messages').insert({
    conversation_id: dmState.activeConvId,
    sender_id: currentUser.id,
    body: '👍',
  }).select().single();
  if (error) { toast(error.message, 'error'); return; }
  dmState.messages.push(data);
  renderMessages();
  scrollMessagesToBottom();
}

function updateSendButton() {
  const btn = document.getElementById('dmSendBtn');
  const input = document.getElementById('dmInput');
  if (!btn || !input) return;
  const hasText = input.value.trim().length > 0;
  btn.classList.toggle('has-text', hasText);
}

function resizeDmInput() {
  const input = document.getElementById('dmInput');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

// ── Realtime ──────────────────────────────────────────────────────────────
function subscribeToThread(convId) {
  // Tear down previous channel
  if (dmState.realtimeChannel) {
    supabase.removeChannel(dmState.realtimeChannel);
    dmState.realtimeChannel = null;
  }
  dmState.realtimeChannel = supabase
    .channel(`dm-thread-${convId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
      filter: `conversation_id=eq.${convId}`,
    }, (payload) => {
      const newMsg = payload.new;
      // Ignore if it's already in our list (we just inserted it locally)
      if (dmState.messages.some(m => m.id === newMsg.id)) return;
      dmState.messages.push(newMsg);
      renderMessages();
      scrollMessagesToBottom();
      // If the new message isn't from me, mark conversation read immediately
      if (newMsg.sender_id !== currentUser.id) {
        supabase.rpc('mark_conversation_read', { p_conversation_id: convId });
      }
    })
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'messages',
      filter: `conversation_id=eq.${convId}`,
    }, (payload) => {
      // Read receipts / deletes / edits
      const idx = dmState.messages.findIndex(m => m.id === payload.new.id);
      if (idx >= 0) {
        dmState.messages[idx] = payload.new;
        renderMessages();
      }
    })
    .subscribe();
}

// Inbox-wide subscription so the unread badge updates even when DMs page is closed
function subscribeToInbox() {
  if (!currentUser) return;
  if (dmState.inboxChannel) supabase.removeChannel(dmState.inboxChannel);
  dmState.inboxChannel = supabase
    .channel(`dm-inbox-${currentUser.id}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
    }, async (payload) => {
      const m = payload.new;
      if (m.sender_id === currentUser.id) return; // my own message
      // Quick lookup: is this one of MY conversations?
      const { data: c } = await supabase
        .from('conversations')
        .select('user_a, user_b')
        .eq('id', m.conversation_id)
        .single();
      if (!c) return;
      if (c.user_a !== currentUser.id && c.user_b !== currentUser.id) return;
      // If we're already viewing this thread, the thread channel will mark it read.
      if (dmState.activeConvId === m.conversation_id && messagesPage?.style.display === 'block') return;
      // Otherwise bump unread
      dmState.totalUnread++;
      updateUnreadBadge(dmState.totalUnread);
    })
    .subscribe();
}

function updateUnreadBadge(total) {
  dmState.totalUnread = total;
  const badge = document.getElementById('messagesUnreadBadge');
  if (!badge) return;
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// ── Wire up sidebar + composer + back button ─────────────────────────────
document.getElementById('btnMessages')?.addEventListener('click', () => showMessages());

document.getElementById('dmBackBtn')?.addEventListener('click', () => {
  document.querySelector('.dm-shell')?.classList.remove('thread-open');
  document.getElementById('dmThreadActive').style.display = 'none';
  document.getElementById('dmThreadEmpty').style.display = 'flex';
  if (dmState.realtimeChannel) {
    supabase.removeChannel(dmState.realtimeChannel);
    dmState.realtimeChannel = null;
  }
  dmState.activeConvId = null;
  dmState.activeOther = null;
});

const dmInputEl = document.getElementById('dmInput');
if (dmInputEl) {
  dmInputEl.addEventListener('input', () => { resizeDmInput(); updateSendButton(); });
  dmInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendDmMessage();
    }
  });
}
document.getElementById('dmSendBtn')?.addEventListener('click', () => sendDmMessage());

// Conversation list search filter
document.getElementById('dmSearchInput')?.addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.dm-conv-item').forEach(el => {
    const name = el.querySelector('.dm-conv-name')?.textContent.toLowerCase() || '';
    const preview = el.querySelector('.dm-conv-preview')?.textContent.toLowerCase() || '';
    el.style.display = (!q || name.includes(q) || preview.includes(q)) ? '' : 'none';
  });
});

// Initial badge load + inbox subscription on app boot
async function bootstrapDmBadge() {
  if (!currentUser) return;
  const { data: convs } = await supabase
    .from('conversations')
    .select('id')
    .or(`user_a.eq.${currentUser.id},user_b.eq.${currentUser.id}`);
  if (!convs?.length) { updateUnreadBadge(0); return; }
  const counts = await fetchUnreadCounts(convs.map(c => c.id));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  updateUnreadBadge(total);
  subscribeToInbox();
}

// Run on initial sign-in (delayed so currentUser is set)
setTimeout(() => bootstrapDmBadge(), 1500);

// Hash routing
window.addEventListener('hashchange', () => {
  if (window.location.hash === '#messages') showMessages();
});
if (window.location.hash === '#messages') {
  setTimeout(() => showMessages(), 600);
}
