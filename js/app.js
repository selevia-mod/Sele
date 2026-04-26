import { supabase, REACTIONS, timeAgo, initials, appwriteList, appwriteGet, APPWRITE, callEdgeFunction } from './supabase.js';

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
window.loadFeed = async function() {
  const feed = document.getElementById('feed');
  feed.innerHTML = '<div class="loading">Loading feed...</div>';

  const { data, error } = await supabase
    .from('posts')
    .select(`*, profiles(username, avatar_url, is_guest), videos(id, video_url, thumbnail_url, title, duration), original:reposted_from(*, profiles(username, avatar_url, is_guest), videos(id, video_url, thumbnail_url, title, duration))`)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) { feed.innerHTML = `<div class="empty"><p>${error.message}</p></div>`; return; }

  posts = data || [];
  if (!posts.length) {
    feed.innerHTML = '<div class="empty"><h3>No posts yet</h3><p>Be the first to share something!</p></div>';
    return;
  }

  feed.innerHTML = '';
  posts.forEach((post, i) => {
    const el = renderPost(post);
    el.style.animationDelay = `${i * 0.04}s`;
    feed.appendChild(el);
  });
  attachFeedVideoPlayers();
};

function attachFeedVideoPlayers() {
  document.querySelectorAll('.post-video').forEach(wrap => {
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
  });
}

function renderPost(post) {
  const div = document.createElement('div');
  div.className = 'post-card';
  div.dataset.postid = post.id;

  const profile = post.profiles || {};
  const name = profile.username || 'Unknown';
  const isGuest = profile.is_guest;
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}" alt="${name}"/>` : initials(name);

  div.innerHTML = `
    <div class="post-header">
      <div class="avatar">${avatarHTML}</div>
      <div style="flex:1">
        <div style="display:flex;align-items:center">
          <span class="post-author">${escHTML(name)}</span>
          ${isGuest ? '<span class="post-guest">Guest</span>' : ''}
        </div>
        <div class="post-time">${timeAgo(post.created_at)}</div>
      </div>
      ${currentUser && currentUser.id === post.user_id ? `
        <button class="comment-action-btn" onclick="deletePost('${post.id}')" style="font-size:0.8rem">✕ Delete</button>
      ` : ''}
    </div>

    ${post.reposted_from && post.original ? `
      <div class="reposted-banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        Reposted
      </div>
    ` : ''}

    ${post.body ? `<div class="post-body">${linkify(post.body)}</div>` : ''}
    ${post.image_url ? `<div class="post-image" onclick="openLightbox('${post.image_url}')"><img src="${post.image_url}" alt="post image" loading="lazy"/></div>` : ''}
    ${post.videos ? `
      <div class="post-video" data-video-url="${escHTML(post.videos.video_url || '')}" data-video-id="${escHTML(post.videos.id || '')}">
        <video class="post-video-player" poster="${escHTML(post.videos.thumbnail_url || '')}" muted playsinline preload="none" controls></video>
      </div>
    ` : ''}

    ${post.reposted_from && post.original ? `
      <div class="reposted-card">
        <div class="post-header">
          <div class="avatar">${post.original.profiles?.avatar_url ? `<img src="${post.original.profiles.avatar_url}"/>` : initials(post.original.profiles?.username || 'U')}</div>
          <div>
            <span class="post-author">${escHTML(post.original.profiles?.username || 'Unknown')}</span>
            <div class="post-time">${timeAgo(post.original.created_at)}</div>
          </div>
        </div>
        ${post.original.body ? `<div class="post-body">${linkify(post.original.body)}</div>` : ''}
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

  loadReactions(post.id, 'post');
  loadCommentCount(post.id);
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

async function loadCommentCount(postId) {
  const { count } = await supabase.from('comments').select('*', { count: 'exact', head: true }).eq('post_id', postId);
  const el = document.getElementById(`ccount-${postId}`);
  if (el) el.textContent = count > 0 ? `${count} comment${count !== 1 ? 's' : ''}` : '';
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
  const wrap = document.querySelector(`.reaction-wrap[data-target="${targetId}"][data-type="${targetType}"]`);
  if (!wrap) return;
  const trigger = wrap.querySelector('.reaction-trigger');
  if (!trigger) return;

  const total = Object.values(counts).reduce((a,b) => a+b, 0);
  const activeR = userReaction ? REACTIONS.find(r => r.key === userReaction) : null;

  const iconEl = trigger.querySelector('.r-icon');
  const labelEl = trigger.querySelector('.r-label-text');

  if (activeR) {
    iconEl.innerHTML = `<span style="font-size:17px">${activeR.emoji}</span>`;
    if (labelEl) labelEl.textContent = activeR.label;
    trigger.classList.add('reacted');
  } else {
    iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
    if (labelEl) labelEl.textContent = 'Like';
    trigger.classList.remove('reacted');
  }

  wrap.querySelectorAll('.reaction-option').forEach(btn => btn.classList.toggle('active', btn.dataset.key === userReaction));

  // Summary stats above action bar
  const summary = document.getElementById(`rsummary-${targetId}`);
  if (summary && targetType === 'post') {
    const sortedEmojis = REACTIONS.filter(r => counts[r.key] > 0).sort((a,b) => counts[b.key] - counts[a.key]);
    if (sortedEmojis.length === 0) { summary.innerHTML = ''; }
    else {
      summary.innerHTML = `<span class="rcount-emojis">${sortedEmojis.map(r => r.emoji).join('')}</span> ${total}`;
    }
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
async function loadComments(postId) {
  const section = document.getElementById(`comments-${postId}`);
  section.innerHTML = '<div class="loading" style="padding:1rem">Loading...</div>';
  const { data, error } = await supabase.from('comments').select(`*, profiles(username, avatar_url, is_guest)`).eq('post_id', postId).is('parent_id', null).order('created_at', { ascending: true });
  if (error) { section.innerHTML = `<p style="color:var(--text3);font-size:0.85rem">${error.message}</p>`; return; }
  section.innerHTML = '';
  const comments = data || [];
  for (const c of comments) section.appendChild(await renderComment(c, postId));

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
    <div id="cimgpreview-${postId}" style="margin-left:40px"></div>
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
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(postId, null, ta, `cimgpreview-${postId}`); }});
  inputWrap.querySelector('.btn-send').addEventListener('click', () => submitComment(postId, null, ta, `cimgpreview-${postId}`));
  inputWrap.querySelector('.cimg-input').addEventListener('change', (e) => handleCommentImageSelect(e.target, `cimgpreview-${postId}`));
}

async function renderComment(comment, postId, isReply = false, topLevelId = null) {
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
      ${comment.image_url ? `<div class="comment-image" onclick="openLightbox('${comment.image_url}')"><img src="${comment.image_url}" loading="lazy"/></div>` : ''}
      <div class="comment-actions">
        <div class="reaction-wrap" data-target="${comment.id}" data-type="comment" style="position:relative">
          <button class="reaction-trigger comment-action-btn" data-target="${comment.id}" data-type="comment">
            <span class="r-icon">♡</span>
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
        <button class="comment-action-btn reply-btn" data-commentid="${replyTargetId}" data-postid="${postId}" data-replyto="${escHTML(replyToName || '')}">Reply</button>
        ${currentUser && currentUser.id === comment.user_id ? `<button class="comment-action-btn" onclick="deleteComment('${comment.id}','${postId}')">Delete</button>` : ''}
      </div>
      ${!isReply ? `<div class="replies" id="replies-${comment.id}"></div>` : ''}
    </div>
  `;

  loadReactions(comment.id, 'comment');
  if (!isReply) {
    const { data } = await supabase.from('comments').select(`*, profiles(username, avatar_url, is_guest)`).eq('parent_id', comment.id).order('created_at', { ascending: true });
    if (data && data.length) {
      const container = div.querySelector(`#replies-${comment.id}`);
      for (const r of data) container.appendChild(await renderComment(r, postId, true, comment.id));
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

async function submitComment(postId, parentId, textarea, previewId) {
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
  const { error } = await supabase.from('comments').insert({ post_id: postId, user_id: currentUser.id, parent_id: parentId || null, body: body || '', image_url: imageUrl });
  if (error) { toast(error.message, 'error'); return; }
  textarea.value = '';
  textarea.style.height = 'auto';
  if (previewId) {
    delete pendingCommentImages[previewId];
    const preview = document.getElementById(previewId);
    if (preview) preview.innerHTML = '';
  }
  loadComments(postId);
  loadCommentCount(postId);
}

window.deleteComment = async (commentId, postId) => {
  const ok = await confirmDialog({
    title: 'Delete this comment?',
    body: 'This comment will be removed permanently and can\'t be recovered.',
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  await supabase.from('comments').delete().eq('id', commentId);
  loadComments(postId);
  loadCommentCount(postId);
};

function showReplyInput(commentId, postId, replyToName = '') {
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
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(postId, commentId, ta, previewId); }});
  wrap.querySelector('.btn-send').addEventListener('click', () => submitComment(postId, commentId, ta, previewId));
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
    showReplyInput(replyBtn.dataset.commentid, replyBtn.dataset.postid, replyBtn.dataset.replyto);
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
  storiesEl.style.display = '';
  composeEl.style.display = '';
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
  feedEl.style.display = 'none';
  storiesEl.style.display = 'none';
  composeEl.style.display = 'none';
  profilePage.style.display = 'block';
  videosPage.style.display = 'none';
  studioPage.style.display = 'none';
  bookPage.style.display = 'none';
  authorPage.style.display = 'none';
  videoPlayerPage.style.display = 'none';
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

  // Retry up to 3 times in case profile isn't ready yet
  let profile = null;
  for (let i = 0; i < 3; i++) {
    const result = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (result.data) { profile = result.data; break; }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!profile) {
    toast('Could not load profile', 'error');
    return;
  }
  
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
  const badge = document.getElementById('profileBadge');
  badge.textContent = profile.is_guest ? 'Guest' : 'Member';
  badge.className = 'profile-badge' + (profile.is_guest ? ' guest' : '');
  document.getElementById('profileBio').textContent = profile.bio || '';

  // Joined date
  const joined = new Date(profile.created_at);
  const joinedStr = joined.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  document.getElementById('profileJoined').textContent = joinedStr;

  // Counts
  const [{ count: followers }, { count: following }, { count: postCount }] = await Promise.all([
    supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId),
    supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId),
    supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId)
  ]);
  document.getElementById('statFollowers').innerHTML = `<strong>${followers || 0}</strong> followers`;
  document.getElementById('statFollowing').innerHTML = `<strong>${following || 0}</strong> following`;
  document.getElementById('statPosts').innerHTML = `<strong>${postCount || 0}</strong> posts`;

  // About tab
  document.getElementById('aboutUsername').textContent = profile.username;
  document.getElementById('aboutBio').textContent = profile.bio || '—';
  document.getElementById('aboutLocation').textContent = profile.location || '—';
  document.getElementById('aboutWebsite').innerHTML = profile.website ? `<a href="${profile.website}" target="_blank">${profile.website}</a>` : '—';
  document.getElementById('aboutJoined').textContent = joined.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  document.getElementById('aboutType').textContent = profile.is_guest ? 'Guest account' : 'Member';

  // Action button + edit controls
  const isOwn = currentUser && currentUser.id === userId;
  const actionBtn = document.getElementById('profileActionBtn');
  const editAvatarBtn = document.getElementById('editAvatarBtn');
  const editBannerBtn = document.getElementById('editBannerBtn');

  if (isOwn) {
    actionBtn.textContent = '⚙️ Edit profile';
    actionBtn.onclick = () => openEditProfile(profile);
    editAvatarBtn.style.display = 'flex';
    editAvatarBtn.style.visibility = 'visible';
    editBannerBtn.style.display = 'flex';
    editBannerBtn.style.visibility = 'visible';
  } else {
    const { data: existing } = await supabase.from('follows').select('*').eq('follower_id', currentUser.id).eq('following_id', userId).maybeSingle();
    actionBtn.textContent = existing ? 'Unfollow' : 'Follow';
    actionBtn.onclick = () => toggleFollow(userId, !!existing);
    editAvatarBtn.style.display = 'none';
    editBannerBtn.style.display = 'none';
  }

  // Load user's posts
  loadProfilePosts(userId);

  // Reset tab
  document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'posts'));
  document.getElementById('profilePosts').style.display = '';
  document.getElementById('profileAbout').style.display = 'none';
}

async function loadProfilePosts(userId) {
  const wrap = document.getElementById('profilePosts');
  wrap.innerHTML = '<div class="loading">Loading posts...</div>';
  const { data } = await supabase
    .from('posts')
    .select(`*, profiles(username, avatar_url, is_guest), videos(id, video_url, thumbnail_url, title, duration), original:reposted_from(*, profiles(username, avatar_url, is_guest), videos(id, video_url, thumbnail_url, title, duration))`)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  posts = data || [];
  wrap.innerHTML = '';
  if (!posts.length) wrap.innerHTML = '<div class="empty"><h3>No posts yet</h3></div>';
  else posts.forEach(p => wrap.appendChild(renderPost(p)));
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

// Profile tabs
document.querySelectorAll('.profile-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('profilePosts').style.display = tab.dataset.tab === 'posts' ? '' : 'none';
    document.getElementById('profileAbout').style.display = tab.dataset.tab === 'about' ? '' : 'none';
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
      setupAppwriteStatsLazyLoad(grid);
      // Resume infinite scroll if there's more to load
      const sentinel = document.getElementById('bookGridSentinel');
      if (sentinel && _hasMoreAppwriteBooks) {
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

async function runFeedSearch(query) {
  query = query.trim().toLowerCase();
  if (!query) { searchResultsEl.classList.remove('open'); return; }

  searchResultsEl.classList.add('open');
  searchResultsEl.innerHTML = '<div style="padding:1rem;color:var(--text3)">Searching...</div>';

  const [{ data: profiles }, { data: posts }] = await Promise.all([
    supabase.from('profiles').select('*').ilike('username', `%${query}%`).limit(5),
    supabase.from('posts').select('*, profiles(username, avatar_url, is_guest)').ilike('body', `%${query}%`).order('created_at', { ascending: false }).limit(8)
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
    // Fetch a larger pool to pick from
    const result = await appwriteList(APPWRITE.videosCollection, [
      JSON.stringify({ method: 'orderDesc', attribute: '$createdAt' }),
      JSON.stringify({ method: 'limit', values: [200] })
    ]);

    let pool = result.documents.filter(v =>
      v.$id !== currentVideo.$id && !watchedIds.has(v.$id)
    );

    // Score each video
    pool.forEach(v => {
      let score = 0;

      // Tag matching (40% from interest profile + boost for current video tags)
      (v.tags || []).forEach(tag => {
        if (tagWeights[tag]) score += tagWeights[tag] * 100;
        if (currentTags.includes(tag)) score += 30;
      });

      // Same uploader bonus
      if (v.uploader === currentVideo.uploader) score += 25;
      if (recentUploaders.includes(v.uploader)) score += 15;

      // Engagement boost (views)
      const views = v.videoStats?.views || 0;
      score += Math.log10(views + 1) * 2;

      // Small randomness so it doesn't feel static
      score += Math.random() * 5;

      v._score = score;
    });

    // Sort by score, take top 10
    pool.sort((a, b) => b._score - a._score);
    const suggestions = pool.slice(0, 10);

    // Fetch uploaders for these
    const uploaderIds = [...new Set(suggestions.map(v => v.uploader).filter(Boolean))];
    const uploaders = {};
    if (uploaderIds.length) {
      try {
        const userResult = await appwriteList(APPWRITE.usersCollection, [
          JSON.stringify({ method: 'equal', attribute: '$id', values: uploaderIds }),
          JSON.stringify({ method: 'limit', values: [100] })
        ]);
        userResult.documents.forEach(u => { uploaders[u.$id] = u; });
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

// ── Videos (from Appwrite) ──
const videosPage = document.getElementById('videosPage');
const videoPlayerPage = document.getElementById('videoPlayerPage');
const studioPage = document.getElementById('studioPage');
const bookPage = document.getElementById('bookPage');
const authorPage = document.getElementById('authorPage');
const bookDetailPage = document.getElementById('bookDetailPage');
const chapterReaderPage = document.getElementById('chapterReaderPage');

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
const APPWRITE_BOOKS_PAGE_SIZE = 40;
let _appwriteOffset = 0;
let _hasMoreAppwriteBooks = true;
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
  _appwriteOffset = 0;
  _hasMoreAppwriteBooks = true;
  _isLoadingMoreBooks = false;
  _allAppwriteStatsFetched = false;

  try {
    // First-page Appwrite fetch + full Supabase fetch (Supabase is small and shouldn't paginate)
    const [supabaseBooks, appwriteBooks] = await Promise.all([
      fetchSupabaseBooks(),
      fetchAppwriteBooks(0),
    ]);

    if (appwriteBooks.length < APPWRITE_BOOKS_PAGE_SIZE) _hasMoreAppwriteBooks = false;
    _appwriteOffset = appwriteBooks.length;

    let merged = [...(supabaseBooks || []), ...(appwriteBooks || [])];

    merged = applyBookFilterAndSort(merged);
    allBooksCache = merged;

    if (!merged.length) {
      grid.style.display = 'none';
      empty.style.display = 'flex';
      return;
    }

    renderBooks();
    if (_hasMoreAppwriteBooks) setupBooksInfiniteScroll();
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
  if (_isLoadingMoreBooks || !_hasMoreAppwriteBooks) return;
  _isLoadingMoreBooks = true;

  const sentinel = document.getElementById('bookGridSentinel');
  sentinel.style.display = 'block';
  sentinel.innerHTML = '<div class="loading book-grid-loadmore">Loading more books…</div>';

  try {
    const more = await fetchAppwriteBooks(_appwriteOffset);
    if (more.length < APPWRITE_BOOKS_PAGE_SIZE) _hasMoreAppwriteBooks = false;
    _appwriteOffset += more.length;

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
      // Re-observe new cards for stats
      setupAppwriteStatsLazyLoad(grid);
    }

    if (_hasMoreAppwriteBooks) {
      sentinel.innerHTML = '<div class="loading book-grid-loadmore">Loading more books…</div>';
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
    setupAppwriteStatsLazyLoad(grid);
    if (sentinel && _hasMoreAppwriteBooks) {
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
  setupAppwriteStatsLazyLoad(grid);
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
async function fetchSupabaseBooks() {
  try {
    const { data, error } = await supabase
      .from('books')
      .select(`
        id, title, description, cover_url, genre, tags,
        views_count, likes_count, chapters_count, word_count,
        published_at, created_at,
        author_id,
        profiles!books_author_id_fkey ( id, username, avatar_url )
      `)
      .eq('is_public', true)
      .in('status', ['ongoing', 'completed'])
      .limit(80);

    if (error) {
      console.error('Supabase books fetch error:', error);
      // Don't break the whole page — return empty so Appwrite still renders
      if (error.code === '42P01') {
        // migration not run; show friendly state via the calling page
      }
      return [];
    }

    return (data || []).map(b => ({
      ...b,
      id: b.id,                                    // raw UUID, no prefix needed (FK shape used elsewhere)
      $id: 'sb_' + b.id,
      _supabase: true,
      author: b.profiles ? { id: b.profiles.id, username: b.profiles.username, avatar: b.profiles.avatar_url } : null,
    }));
  } catch (err) {
    console.error('fetchSupabaseBooks failed:', err);
    return [];
  }
}

// ── Appwrite books (legacy mobile) ──
// Stats (views/likes/chapter counts) are loaded lazily per-card after render.
// Pagination via offset keeps initial load fast even with thousands of legacy books.
async function fetchAppwriteBooks(offset = 0) {
  if (!APPWRITE.booksCollection) return [];
  try {
    const result = await appwriteList(APPWRITE.booksCollection, [
      JSON.stringify({ method: 'orderDesc', attribute: '$createdAt' }),
      JSON.stringify({ method: 'limit',  values: [APPWRITE_BOOKS_PAGE_SIZE] }),
      JSON.stringify({ method: 'offset', values: [offset] }),
    ]);
    const books = result.documents || [];
    const userMap = await fetchAppwriteUsers(collectAppwriteUploaderIds(books));

    return books.map(b => {
      const mapped = mapAppwriteBookToBook(b, userMap);
      // Pre-fill from cache if available (otherwise stays 0; lazy fetch will update later)
      const cached = getCachedAppwriteStats(b.$id);
      if (cached) {
        mapped.views_count    = cached.views;
        mapped.likes_count    = cached.likes;
        mapped.chapters_count = cached.chaptersCount;
        mapped._statsLoaded   = true;     // skip lazy fetch for this one
      }
      return mapped;
    });
  } catch (err) {
    console.error('Failed to fetch Appwrite books:', err);
    return [];
  }
}

// Helper: get an ID from any possible shape Appwrite returns for a relationship field.
// Could be a string, an object with $id, an array of strings, or an array of objects.
function pluckRefId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return pluckRefId(value[0]);
  if (typeof value === 'object') return value.$id || null;
  return null;
}

// Aggregate views/likes/chapter counts for a SPECIFIC list of book IDs.
// Uses Appwrite server-side `equal` filter on the `book` relationship attribute so
// only relevant rows come back — critical when there are thousands of books.
// Falls back gracefully (returns zeros) on any error.
async function fetchAppwriteBookStats(bookIds) {
  const empty = { views: {}, likes: {}, chaptersCount: {} };
  if (!bookIds || !bookIds.length) return empty;

  // Appwrite caps `equal values` at 100. Batch if larger.
  if (bookIds.length > 100) {
    const merged = { views: {}, likes: {}, chaptersCount: {} };
    for (let i = 0; i < bookIds.length; i += 100) {
      const part = await fetchAppwriteBookStats(bookIds.slice(i, i + 100));
      Object.assign(merged.views, part.views);
      Object.assign(merged.likes, part.likes);
      Object.assign(merged.chaptersCount, part.chaptersCount);
    }
    return merged;
  }

  try {
    const views = {};
    const likes = {};
    const chaptersCount = {};

    // Reads + chapters in parallel, both server-side filtered
    const settled = await Promise.allSettled([
      APPWRITE.chapterReadsCollection
        ? appwriteList(APPWRITE.chapterReadsCollection, [
            JSON.stringify({ method: 'equal', attribute: 'book', values: bookIds }),
            JSON.stringify({ method: 'limit', values: [5000] }),
          ])
        : Promise.resolve({ documents: [] }),
      APPWRITE.chaptersCollection
        ? appwriteList(APPWRITE.chaptersCollection, [
            JSON.stringify({ method: 'equal', attribute: 'book', values: bookIds }),
            JSON.stringify({ method: 'limit', values: [2000] }),
          ])
        : Promise.resolve({ documents: [] }),
    ]);
    const readDocs    = settled[0].status === 'fulfilled' ? (settled[0].value.documents || []) : [];
    const chapterDocs = settled[1].status === 'fulfilled' ? (settled[1].value.documents || []) : [];

    // Reads → views (sum readCount per book)
    for (const row of readDocs) {
      const bookId = pluckRefId(row.book);
      if (!bookId) continue;
      views[bookId] = (views[bookId] || 0) + (Number(row.readCount) || 0);
    }

    // Build chapter → book map + chapter counts
    const chapterBookMap = {};
    for (const c of chapterDocs) {
      const bookId = pluckRefId(c.book);
      if (!bookId) continue;
      chapterBookMap[c.$id] = bookId;
      const isPublished = (c.status || '').toLowerCase() !== 'draft';
      if (isPublished) chaptersCount[bookId] = (chaptersCount[bookId] || 0) + 1;
    }

    // Likes → count, mapped chapter → book
    const chapterIds = Object.keys(chapterBookMap);
    if (APPWRITE.chapterLikesCollection && chapterIds.length) {
      // Same 100-id cap on equal values
      for (let i = 0; i < chapterIds.length; i += 100) {
        const batch = chapterIds.slice(i, i + 100);
        try {
          const r = await appwriteList(APPWRITE.chapterLikesCollection, [
            JSON.stringify({ method: 'equal', attribute: 'booksChapter', values: batch }),
            JSON.stringify({ method: 'limit', values: [5000] }),
          ]);
          for (const l of (r.documents || [])) {
            const cid = pluckRefId(l.booksChapter);
            if (!cid) continue;
            const bid = chapterBookMap[cid];
            if (bid) likes[bid] = (likes[bid] || 0) + 1;
          }
        } catch (e) { /* swallowed */ }
      }
    }

    return { views, likes, chaptersCount };
  } catch (err) {
    console.warn('fetchAppwriteBookStats failed:', err);
    return empty;
  }
}

// Page through an Appwrite collection until empty, returning all documents.
// Caps at ~10k to avoid runaway loops on misconfigured collections.
async function fetchAllAppwrite(collectionId) {
  const all = [];
  const PAGE = 100;
  let offset = 0;
  for (let safety = 0; safety < 100; safety++) {  // up to 10000 docs
    try {
      const r = await appwriteList(collectionId, [
        JSON.stringify({ method: 'limit',  values: [PAGE] }),
        JSON.stringify({ method: 'offset', values: [offset] }),
      ]);
      const docs = r.documents || [];
      all.push(...docs);
      if (docs.length < PAGE) break;
      offset += PAGE;
    } catch (err) {
      console.warn(`fetchAllAppwrite(${collectionId}) failed at offset ${offset}:`, err);
      break;
    }
  }
  return all;
}

// Pull uploader IDs out of an Appwrite books list.
// `uploader` may come back as: a string ID, an object with $id, or already-embedded with username.
function collectAppwriteUploaderIds(items) {
  const ids = new Set();
  for (const item of items) {
    const u = item?.uploader;
    if (!u) continue;
    if (typeof u === 'string') {
      ids.add(u);
    } else if (typeof u === 'object') {
      // Already-embedded (has username) → no fetch needed
      if (u.username) continue;
      if (u.$id) ids.add(u.$id);
    }
  }
  return ids;
}

async function fetchAppwriteUsers(idSet) {
  if (!idSet || !idSet.size) return {};
  const out = {};
  const ids = [...idSet];
  // Appwrite caps `equal $id values` at 100 per query; batch just in case.
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try {
      const userResult = await appwriteList(APPWRITE.usersCollection, [
        JSON.stringify({ method: 'equal', attribute: '$id', values: batch }),
        JSON.stringify({ method: 'limit', values: [100] }),
      ]);
      (userResult.documents || []).forEach(u => { out[u.$id] = u; });
    } catch (err) {
      console.warn('User batch lookup failed:', err);
    }
  }
  return out;
}

// Resolve the uploader from any of: embedded object, just-ID string, or partial object
function resolveAppwriteUploader(rawUploader, userMap = {}) {
  if (!rawUploader) return null;
  if (typeof rawUploader === 'string') return userMap[rawUploader] || null;
  if (typeof rawUploader === 'object') {
    if (rawUploader.username) return rawUploader;       // already expanded
    if (rawUploader.$id) return userMap[rawUploader.$id] || rawUploader;
  }
  return null;
}

function mapAppwriteBookToBook(b, userMap = {}) {
  const firstTag = (b.tags || [])[0] || '';
  const genreSlug = firstTag.toLowerCase().replace(/\s+/g, '-');
  const uploader = resolveAppwriteUploader(b.uploader, userMap);
  return {
    id: 'aw_' + b.$id,
    $id: 'aw_' + b.$id,
    _appwrite: true,
    _appwriteId: b.$id,
    title: b.title || 'Untitled',
    description: b.synopsis || '',
    cover_url: b.thumbnail || null,
    genre: genreSlug || null,
    tags: b.tags || [],
    status: (b.status || 'ongoing').toLowerCase(),
    is_public: !b.isLocked,
    isLocked: !!b.isLocked,
    contentRating: b.contentRating || null,
    views_count: 0,
    likes_count: 0,
    chapters_count: 0,
    word_count: 0,
    published_at: b.$createdAt,
    created_at: b.$createdAt,
    author_id: uploader?.$id || null,
    // Match the shape Supabase profiles join produces, so renderBookDetail/renderBookCard work uniformly
    profiles: uploader ? {
      id: uploader.$id,
      username: uploader.username || 'Unknown',
      avatar_url: uploader.avatar || null,
    } : null,
    author: uploader ? {
      id: uploader.$id,
      username: uploader.username || 'Unknown',
      avatar: uploader.avatar || null,
    } : null,
  };
}

async function fetchAppwriteChaptersForBook(appwriteBookId) {
  if (!APPWRITE.chaptersCollection) return [];
  try {
    const result = await appwriteList(APPWRITE.chaptersCollection, [
      JSON.stringify({ method: 'equal', attribute: 'book', values: [appwriteBookId] }),
      JSON.stringify({ method: 'orderAsc', attribute: 'order' }),
      JSON.stringify({ method: 'limit', values: [200] }),
    ]);
    return (result.documents || []).map(c => ({
      id: 'aw_' + c.$id,
      _appwrite: true,
      _appwriteId: c.$id,
      chapter_number: typeof c.order === 'number' ? c.order : 0,
      title: c.title || `Chapter ${c.order || ''}`.trim(),
      word_count: 0,
      views_count: 0,
      // Treat anything that isn't explicitly a draft as published (mobile typically only stores published ones in this collection)
      is_published: (c.status || '').toLowerCase() !== 'draft',
      created_at: c.$createdAt,
      _content: c.content || '',         // some renderers use it directly without a follow-up GET
    }));
  } catch (err) {
    console.error('Failed to fetch Appwrite chapters:', err);
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

  // Set up lazy stats loading for Appwrite cards that don't have cached values yet
  setupAppwriteStatsLazyLoad(grid);
}

// ════════════════════════════════════════
// LAZY STATS LOADING (Appwrite books)
// ════════════════════════════════════════

const STATS_CACHE_KEY = 'selebox_book_stats_v1';
const STATS_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes

function getCachedAppwriteStats(appwriteBookId) {
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    const e = cache[appwriteBookId];
    if (!e) return null;
    if (Date.now() - (e.ts || 0) > STATS_CACHE_TTL_MS) return null;
    return { views: e.views || 0, likes: e.likes || 0, chaptersCount: e.chaptersCount || 0 };
  } catch { return null; }
}

function setCachedAppwriteStats(appwriteBookId, stats) {
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    // Light pruning: drop entries older than 1 hour to bound size
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const k of Object.keys(cache)) {
      if ((cache[k]?.ts || 0) < cutoff) delete cache[k];
    }
    cache[appwriteBookId] = { ...stats, ts: Date.now() };
    localStorage.setItem(STATS_CACHE_KEY, JSON.stringify(cache));
  } catch { /* localStorage full or disabled */ }
}

let _statsObserver = null;
let _statsBatchQueue = new Set();
let _statsBatchTimer = null;

function setupAppwriteStatsLazyLoad(grid) {
  // Tear down any previous observer (e.g. when filter changes)
  if (_statsObserver) _statsObserver.disconnect();
  _statsObserver = null;
  _statsBatchQueue.clear();
  if (_statsBatchTimer) { clearTimeout(_statsBatchTimer); _statsBatchTimer = null; }

  if (!('IntersectionObserver' in window)) {
    // Old browser: just kick off all pending stats at once
    const ids = Array.from(grid.querySelectorAll('.book-card[data-appwrite-id]:not([data-stats-loaded="true"])'))
      .map(el => el.dataset.appwriteId);
    if (ids.length) flushAppwriteStatsBatch(ids);
    return;
  }

  _statsObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      const awId = card.dataset.appwriteId;
      if (!awId || card.dataset.statsLoaded === 'true' || card.dataset.statsPending === 'true') continue;
      card.dataset.statsPending = 'true';
      _statsBatchQueue.add(awId);
      _statsObserver.unobserve(card);
    }
    if (_statsBatchTimer) clearTimeout(_statsBatchTimer);
    // Coalesce IDs that show up in the same scroll burst
    _statsBatchTimer = setTimeout(() => {
      const ids = Array.from(_statsBatchQueue);
      _statsBatchQueue.clear();
      _statsBatchTimer = null;
      if (ids.length) flushAppwriteStatsBatch(ids);
    }, 120);
  }, {
    root: null,
    rootMargin: '200px 0px',           // start fetching slightly before card enters viewport
    threshold: 0.01,
  });

  grid.querySelectorAll('.book-card[data-appwrite-id]:not([data-stats-loaded="true"])').forEach(c => {
    _statsObserver.observe(c);
  });
}

// Stats are fetched per visible-card batch — at 4000+ books "fetch all" isn't viable.
// Used to track session-level state if we want to skip refetching across navigations.
let _allAppwriteStatsFetched = false;        // kept for compatibility; no longer triggers prefetch

async function flushAppwriteStatsBatch(appwriteBookIds) {
  if (!appwriteBookIds || !appwriteBookIds.length) return;

  // Cache check first — pull anything fresh from cache so we don't refetch
  const fromCache = {};
  const needsFetch = [];
  for (const id of appwriteBookIds) {
    const c = getCachedAppwriteStats(id);
    if (c) fromCache[id] = c;
    else needsFetch.push(id);
  }
  Object.entries(fromCache).forEach(([id, s]) => updateBookCardStats(id, s));

  if (!needsFetch.length) return;

  let stats = { views: {}, likes: {}, chaptersCount: {} };
  try {
    stats = await fetchAppwriteBookStats(needsFetch);
  } catch (e) { /* swallowed; cards keep dashes */ }

  for (const id of needsFetch) {
    const s = {
      views: stats.views[id] || 0,
      likes: stats.likes[id] || 0,
      chaptersCount: stats.chaptersCount[id] || 0,
    };
    setCachedAppwriteStats(id, s);
    updateBookCardStats(id, s);
  }
}

function updateBookCardStats(appwriteBookId, stats) {
  const card = document.querySelector(`.book-card[data-appwrite-id="${appwriteBookId}"]`);
  if (!card) return;
  const v = card.querySelector('[data-stat="views"]');
  const l = card.querySelector('[data-stat="likes"]');
  if (v) v.textContent = `👁 ${formatCompact(stats.views || 0)}`;
  if (l) l.textContent = `❤ ${formatCompact(stats.likes || 0)}`;
  card.dataset.statsLoaded = 'true';
  card.dataset.statsPending = '';
  // Keep the in-memory book object in sync so sorting / detail page reflects the truth
  const cached = allBooksCache.find(b => b._appwriteId === appwriteBookId);
  if (cached) {
    cached.views_count = stats.views || 0;
    cached.likes_count = stats.likes || 0;
    cached.chapters_count = stats.chaptersCount || 0;
    cached._statsLoaded = true;
  }
}

function renderBookCard(b) {
  const card = document.createElement('button');
  card.className = 'book-card';
  card.dataset.bookId = b.id;                // for IntersectionObserver lookup
  if (b._appwrite) card.dataset.appwriteId = b._appwriteId;
  if (b._statsLoaded) card.dataset.statsLoaded = 'true';
  card.onclick = () => openBookDetail(b.id);

  const authorName = b.author?.username || 'Unknown author';
  const initialLetter = (b.title || '?').trim().charAt(0).toUpperCase();
  const cover = b.cover_url
    ? `<img src="${escHTML(b.cover_url)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=&quot;book-cover-placeholder&quot;>${initialLetter}</div>'"/>`
    : `<div class="book-cover-placeholder">${initialLetter}</div>`;
  const legacyBadge = b._appwrite ? '<span class="book-cover-badge legacy">Legacy</span>' : '';
  const genreLabel = b.genre ? b.genre.replace(/-/g, ' ') : '';

  // For Appwrite books without cached stats, show a dash placeholder
  // (Supabase books already have correct inline counts on the row)
  const statsLoaded = !b._appwrite || b._statsLoaded;
  const viewsText = statsLoaded ? formatCompact(b.views_count || 0) : '—';
  const likesText = statsLoaded ? formatCompact(b.likes_count || 0) : '—';

  card.innerHTML = `
    <div class="book-cover">
      ${cover}
      ${legacyBadge}
      <div class="book-stats">
        <span title="Views" data-stat="views">👁 ${viewsText}</span>
        <span title="Likes" data-stat="likes">❤ ${likesText}</span>
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
  document.querySelectorAll('#bookGenreChips .book-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  bookGenreFilter = chip.dataset.genre || '';
  loadBooks();
});
document.getElementById('bookSortSelect')?.addEventListener('change', (e) => {
  bookSortBy = e.target.value;
  loadBooks();
});

// ── Book detail page ──
async function openBookDetail(bookId) {
  hideAllMainPages();
  bookDetailPage.style.display = 'block';

  history.pushState(null, '', `#book/${bookId}`);

  const content = document.getElementById('bookDetailContent');
  content.innerHTML = '<div class="loading">Loading book...</div>';

  try {
    let book, chapters;

    if (bookId.startsWith('aw_')) {
      // ── Appwrite book ──
      const appwriteId = bookId.slice(3);
      // Always need book doc + chapters; stats come from cache if fresh, else aggregated
      const cachedStats = getCachedAppwriteStats(appwriteId);
      const [appwriteBookDoc, awChapters, statsResult] = await Promise.all([
        appwriteGet(APPWRITE.booksCollection, appwriteId),
        fetchAppwriteChaptersForBook(appwriteId),
        cachedStats ? Promise.resolve(null) : fetchAppwriteBookStats([appwriteId]),
      ]);
      // If the uploader didn't come back expanded, fetch the user record
      const uploaderIds = collectAppwriteUploaderIds([appwriteBookDoc]);
      const userMap = await fetchAppwriteUsers(uploaderIds);
      book = mapAppwriteBookToBook(appwriteBookDoc, userMap);

      const resolvedStats = cachedStats || {
        views: statsResult?.views?.[appwriteId] || 0,
        likes: statsResult?.likes?.[appwriteId] || 0,
        chaptersCount: awChapters.filter(c => c.is_published).length,
      };
      // Persist to cache when fresh
      if (!cachedStats) setCachedAppwriteStats(appwriteId, resolvedStats);

      book.views_count    = resolvedStats.views;
      book.likes_count    = resolvedStats.likes;
      book.chapters_count = awChapters.filter(c => c.is_published).length;
      chapters = awChapters.filter(c => c.is_published);
    } else {
      // ── Supabase book (UUID, possibly bare) ──
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

      book = supBook;
      chapters = supChapters || [];
    }

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
          ${book._appwrite ? `
            <span class="book-cover-badge legacy" style="position:static;display:inline-flex;align-items:center;gap:0.35rem;padding:0.35rem 0.75rem;font-size:0.7rem">
              📱 From mobile (read-only on web)
            </span>
          ` : `
            <button class="btn btn-ghost btn-sm" id="btnLikeBook">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              Like
            </button>
            <button class="btn btn-ghost btn-sm" id="btnBookmarkBook">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
              Bookmark
            </button>
          `}
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
  document.getElementById('btnLikeBook')?.addEventListener('click', () => toggleBookLike(book.id));
  document.getElementById('btnBookmarkBook')?.addEventListener('click', () => toggleBookBookmark(book.id));
}

async function toggleBookLike(bookId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { toast('Sign in to like books', 'error'); return; }
  // Try delete first; if no row, insert.
  const { count } = await supabase.from('book_likes').delete()
    .eq('user_id', user.id).eq('book_id', bookId).select('*', { count: 'exact', head: true });
  if (count) { toast('Removed like', 'success'); return; }
  const { error } = await supabase.from('book_likes').insert({ user_id: user.id, book_id: bookId });
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  toast('Liked', 'success');
}
async function toggleBookBookmark(bookId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { toast('Sign in to bookmark books', 'error'); return; }
  const { count } = await supabase.from('book_bookmarks').delete()
    .eq('user_id', user.id).eq('book_id', bookId).select('*', { count: 'exact', head: true });
  if (count) { toast('Removed bookmark', 'success'); return; }
  const { error } = await supabase.from('book_bookmarks').insert({ user_id: user.id, book_id: bookId });
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  toast('Bookmarked', 'success');
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
    if (chapter._appwrite) {
      // Appwrite chapter — we may already have content from the list call
      if (chapter._content) {
        chapterContent = chapter._content;
      } else {
        const doc = await appwriteGet(APPWRITE.chaptersCollection, chapter._appwriteId);
        chapterContent = doc?.content || '';
      }
    } else {
      const realChapterId = chapter.id.startsWith('sb_') ? chapter.id.slice(3) : chapter.id;
      const { data, error } = await supabase
        .from('chapters')
        .select('id, chapter_number, title, content')
        .eq('id', realChapterId)
        .single();
      if (error || !data) throw new Error(error?.message || 'Chapter not found');
      chapterContent = data.content || '';
      resolvedChapterId = data.id;
    }
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

  // Save reading progress (Supabase only — `book_reads` is a Supabase table)
  if (!chapter._appwrite && !currentBookDetail.book._appwrite) {
    saveReadingProgress(currentBookDetail.book.id, resolvedChapterId, chapter.chapter_number);
  }
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
  document.getElementById('newBookGenre').value = '';
  document.getElementById('newBookDescription').value = '';
  newBookModal.style.display = 'flex';
  setTimeout(() => document.getElementById('newBookTitle').focus(), 50);
}
function closeNewBookModal() { newBookModal.style.display = 'none'; }
async function createNewBook() {
  const title = document.getElementById('newBookTitle').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }
  const genre = document.getElementById('newBookGenre').value || null;
  const description = document.getElementById('newBookDescription').value.trim();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { toast('Sign in first', 'error'); return; }

  const btn = document.getElementById('newBookCreate');
  btn.disabled = true; btn.textContent = 'Creating…';

  const { data, error } = await supabase.from('books').insert({
    author_id: user.id,
    title, description, genre,
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
  document.getElementById('bookEditorGenre').value = book.genre || '';
  document.getElementById('bookEditorTags').value = (book.tags || []).join(', ');
  document.getElementById('bookEditorBookStatus').value = book.status || 'draft';
  document.getElementById('bookEditorPublic').checked = !!book.is_public;
  document.getElementById('bookEditorStatusBadge').textContent = book.is_public ? 'Visible to readers' : 'Hidden draft';

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

  const tags = document.getElementById('bookEditorTags').value.split(',').map(t => t.trim()).filter(Boolean);
  const description = document.getElementById('bookEditorDescription').value.trim();
  const genre = document.getElementById('bookEditorGenre').value || null;
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
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['blockquote', 'link'],
          [{ align: [] }],
          ['clean'],
        ],
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
  }

  // Reset state
  chapterQuill.setText('');
  document.getElementById('chapterEditorTitle').value = '';
  document.getElementById('chapterEditorPublished').checked = false;
  setChapterSaveStatus('idle');
  chapterDirty = false;

  if (chapterId) {
    const { data, error } = await supabase
      .from('chapters')
      .select('id, chapter_number, title, content, is_published')
      .eq('id', chapterId)
      .single();
    if (error || !data) { toast('Chapter not found', 'error'); openAuthorBookEditor(bookId); return; }
    document.getElementById('chapterEditorTitle').value = data.title || '';
    document.getElementById('chapterEditorPublished').checked = !!data.is_published;
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

  let result;
  if (editingChapterId) {
    result = await supabase.from('chapters').update({
      title, content, word_count: wordCount,
      is_published: isPublished,
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
          avatar_url
        )
      `)
      .order('created_at', { ascending: false })
      .limit(100);
    
    if (error) {
      console.error('Supabase videos fetch error:', error);
      return [];
    }
    
    // Transform to match Appwrite video format so the rest of the code works
    return (data || []).map(v => ({
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

  await ensureVideoCache();

// Merge in new Supabase uploads
const supabaseVideos = await fetchSupabaseVideos();
if (supabaseVideos.length) {
  supabaseVideos.forEach(v => {
    if (v._uploaderInfo && !allUploadersCache[v.uploader]) {
      allUploadersCache[v.uploader] = v._uploaderInfo;
    }
  });
  const existingIds = new Set(allVideosCache.map(v => v.$id));
  const newOnes = supabaseVideos.filter(v => !existingIds.has(v.$id));
  allVideosCache = [...newOnes, ...allVideosCache];
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

async function ensureVideoCache() {
  if (allVideosCache.length) return;
  try {
    const result = await appwriteList(APPWRITE.videosCollection, [
      JSON.stringify({ method: 'orderDesc', attribute: '$createdAt' }),
      JSON.stringify({ method: 'limit', values: [200] })
    ]);
    allVideosCache = result.documents || [];

    // Fetch all unique uploaders
    const uploaderIds = [...new Set(allVideosCache.map(v => v.uploader).filter(Boolean))];
    if (uploaderIds.length) {
      // Appwrite has a 100 limit on equal() values, so we batch
      for (let i = 0; i < uploaderIds.length; i += 100) {
        const batch = uploaderIds.slice(i, i + 100);
        try {
          const res = await appwriteList(APPWRITE.usersCollection, [
            JSON.stringify({ method: 'equal', attribute: '$id', values: batch }),
            JSON.stringify({ method: 'limit', values: [100] })
          ]);
          res.documents.forEach(u => { allUploadersCache[u.$id] = u; });
        } catch {}
      }
    }
  } catch (e) {
    console.error('Failed to load video cache:', e);
  }
}

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

function getTopTags(limit = 12) {
  const tagCounts = {};
  allVideosCache.forEach(v => {
    (v.tags || []).forEach(t => {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    });
  });
  return Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}

function renderTagPills() {
  const wrap = document.getElementById('videoSearchTags');
  const tags = getTopTags(12);
  wrap.innerHTML = tags.map(tag => 
    `<button class="search-tag-pill ${tag === activeTagFilter ? 'active' : ''}" data-tag="${escHTML(tag)}">${escHTML(tag)}</button>`
  ).join('');

  wrap.querySelectorAll('.search-tag-pill').forEach(pill => {
    pill.onclick = () => {
      const tag = pill.dataset.tag;
      activeTagFilter = (activeTagFilter === tag) ? null : tag;
      renderTagPills();
      // If no tag selected, show personalized feed; else show filtered
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
  console.log('[playVideo] called with videoId:', videoId, '| starts with sb_?', videoId?.startsWith('sb_'));
  try {
    let video = null;
    let uploader = null;

    // Supabase videos are prefixed with 'sb_' and live in allVideosCache
    // — never call Appwrite for them, that's why we were getting 400s.
    if (videoId && videoId.startsWith('sb_')) {
      console.log('[playVideo] taking SUPABASE branch — no Appwrite call');
      // Make sure the cache is populated (in case the user navigated directly to #video/sb_...)
      if (!allVideosCache.length) {
        await ensureVideoCache();
        const fresh = await fetchSupabaseVideos();
        const existingIds = new Set(allVideosCache.map(v => v.$id));
        fresh.forEach(v => { if (!existingIds.has(v.$id)) allVideosCache.push(v); });
      }
      const cached = allVideosCache.find(v => v.$id === videoId);
      if (!cached) {
        toast('Video not found', 'error');
        return;
      }
      video = cached;
      uploader = cached._uploaderInfo || null;
    } else {
      // Appwrite (mobile) video — fetch from Appwrite as before
      console.log('[playVideo] taking APPWRITE branch for videoId:', videoId);
      video = await appwriteGet(APPWRITE.videosCollection, videoId);
      if (!video) return;
      if (video.uploader) {
        try { uploader = await appwriteGet(APPWRITE.usersCollection, video.uploader); } catch {}
      }
    }

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
  } catch (error) {
    toast('Couldn\'t load video: ' + error.message, 'error');
  }
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
