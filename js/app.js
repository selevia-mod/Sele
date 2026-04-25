import { supabase, REACTIONS, timeAgo, initials, appwriteList, appwriteGet, APPWRITE } from './supabase.js';

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

  supabase.auth.onAuthStateChange(async (_, session) => {
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

  // Check URL hash for routing FIRST
  const hash = window.location.hash;
  if (hash.startsWith('#profile/')) {
    loadStories();
    loadFeed();
    openProfile(hash.replace('#profile/', ''));
  } else if (hash === '#videos') {
    showVideos();
  } else if (hash.startsWith('#video/')) {
    playVideo(hash.replace('#video/', ''));
  } else {
    loadStories();
    loadFeed();
  }
}

  // Check URL hash for routing
  const hash = window.location.hash;
  if (hash.startsWith('#profile/')) {
    openProfile(hash.replace('#profile/', ''));
  } else if (hash === '#videos') {
    showVideos();
  } else if (hash.startsWith('#video/')) {
    playVideo(hash.replace('#video/', ''));
  } else {
    loadFeed();
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
    .select(`*, profiles(username, avatar_url, is_guest), original:reposted_from(*, profiles(username, avatar_url, is_guest))`)
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
};

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

window.deletePost = async (postId) => {
  if (!confirm('Delete this post?')) return;
  const { error } = await supabase.from('posts').delete().eq('id', postId);
  if (error) toast(error.message, 'error');
  else { toast('Deleted', 'success'); loadFeed(); }
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
  if (!confirm('Delete this comment?')) return;
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

// ── Search ──
let searchTimer = null;
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) { searchResults.classList.remove('visible'); return; }
  searchTimer = setTimeout(() => doSearch(q), 300);
});
searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim()) searchResults.classList.add('visible');
});

async function doSearch(q) {
  searchResults.innerHTML = '<div style="padding:1rem;color:var(--text3);font-size:0.85rem">Searching...</div>';
  searchResults.classList.add('visible');

  const [profilesRes, postsRes] = await Promise.all([
    supabase.from('profiles').select('id, username, avatar_url, is_guest').ilike('username', `%${q}%`).limit(5),
    supabase.from('posts').select('id, body, user_id, profiles(username, avatar_url)').ilike('body', `%${q}%`).limit(5)
  ]);

  const profiles = profilesRes.data || [];
  const postResults = postsRes.data || [];

  let html = '';
  if (profiles.length) {
    html += '<div class="search-section-title">People</div>';
    html += profiles.map(p => `
      <div class="search-result-item" onclick="filterByUser('${p.id}','${escHTML(p.username)}');document.getElementById('searchResults').classList.remove('visible');document.getElementById('searchInput').value='';">
        <div class="avatar">${p.avatar_url ? `<img src="${p.avatar_url}"/>` : initials(p.username)}</div>
        <div class="srtext">
          <div class="srtitle">${escHTML(p.username)}</div>
          <div class="srsub">${p.is_guest ? 'Guest' : 'Member'}</div>
        </div>
      </div>
    `).join('');
  }
  if (postResults.length) {
    html += '<div class="search-section-title">Posts</div>';
    html += postResults.map(p => {
      const prof = p.profiles || {};
      const body = p.body ? p.body.slice(0, 80) + (p.body.length > 80 ? '...' : '') : '(no text)';
      return `
        <div class="search-result-item" onclick="document.getElementById('searchResults').classList.remove('visible');document.getElementById('searchInput').value='';">
          <div class="avatar">${prof.avatar_url ? `<img src="${prof.avatar_url}"/>` : initials(prof.username)}</div>
          <div class="srtext">
            <div class="srtitle">${escHTML(prof.username || 'Unknown')}</div>
            <div class="srsub">${escHTML(body)}</div>
          </div>
        </div>
      `;
    }).join('');
  }
  if (!html) html = '<div style="padding:1rem;color:var(--text3);font-size:0.85rem">No results found</div>';
  searchResults.innerHTML = html;
}

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
  feedEl.style.display = '';
  storiesEl.style.display = '';
  composeEl.style.display = '';
  profilePage.style.display = 'none';
  videosPage.style.display = 'none';
  videoPlayerPage.style.display = 'none';
  document.body.classList.remove('on-videos');
  viewingProfileId = null;
  stopVideoPlayer();
  if (window.location.hash) history.pushState(null, '', window.location.pathname);
}

function showProfileView() {
  feedEl.style.display = 'none';
  storiesEl.style.display = 'none';
  composeEl.style.display = 'none';
  profilePage.style.display = 'block';
  videosPage.style.display = 'none';
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
    .select(`*, profiles(username, avatar_url, is_guest), original:reposted_from(*, profiles(username, avatar_url, is_guest))`)
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
document.getElementById('btnProfile').addEventListener('click', openMyProfile);
document.getElementById('topbarAvatar').addEventListener('click', openMyProfile);

// Add Home button functionality — the first sidebar item
document.querySelector('.sidebar-item.active')?.addEventListener('click', showFeed);

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

initAuth();

// ── Videos (from Appwrite) ──
const videosPage = document.getElementById('videosPage');
const videoPlayerPage = document.getElementById('videoPlayerPage');
let currentHls = null;

function stopVideoPlayer() {
  const player = document.getElementById('videoPlayer');
  if (player) {
    player.pause();
    player.removeAttribute('src');
    player.load();
  }
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }
}

function showVideos() {
  feedEl.style.display = 'none';
  storiesEl.style.display = 'none';
  composeEl.style.display = 'none';
  profilePage.style.display = 'none';
  videoPlayerPage.style.display = 'none';
  videosPage.style.display = 'block';
  document.body.classList.add('on-videos');
  stopVideoPlayer();
  history.pushState(null, '', '#videos');
  loadVideos();
}

function showVideoPlayer() {
  feedEl.style.display = 'none';
  storiesEl.style.display = 'none';
  composeEl.style.display = 'none';
  profilePage.style.display = 'none';
  videosPage.style.display = 'none';
  videoPlayerPage.style.display = 'block';
}

document.getElementById('btnVideos').addEventListener('click', showVideos);
document.getElementById('btnBackVideos').addEventListener('click', () => {
  if (currentHls) { currentHls.destroy(); currentHls = null; }
  document.getElementById('videoPlayer').pause();
  showVideos();
});

// Hide upload button (uploads managed elsewhere)
const btnUploadVideo = document.getElementById('btnUploadVideo');
if (btnUploadVideo) btnUploadVideo.style.display = 'none';

async function loadVideos() {
  const grid = document.getElementById('videoGrid');
  grid.innerHTML = '<div class="loading">Loading videos...</div>';

  try {
    const result = await appwriteList(APPWRITE.videosCollection, [
      JSON.stringify({ method: 'orderDesc', attribute: '$createdAt' }),
      JSON.stringify({ method: 'limit', values: [50] })
    ]);

    if (!result.documents || !result.documents.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><h3>No videos yet</h3></div>';
      return;
    }

    const uploaderIds = [...new Set(result.documents.map(v => v.uploader).filter(Boolean))];
    const uploaders = {};

    if (uploaderIds.length) {
      try {
        const userResult = await appwriteList(APPWRITE.usersCollection, [
          JSON.stringify({ method: 'equal', attribute: '$id', values: uploaderIds }),
          JSON.stringify({ method: 'limit', values: [100] })
        ]);
        userResult.documents.forEach(u => { uploaders[u.$id] = u; });
      } catch (e) {
        console.warn('Could not fetch uploaders:', e);
      }
    }

    grid.innerHTML = '';
    result.documents.forEach((v, i) => {
      const card = renderVideoCard(v, uploaders[v.uploader]);
      card.style.animationDelay = `${i * 0.04}s`;
      grid.appendChild(card);
    });
  } catch (error) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>Couldn't load videos</h3><p>${error.message}</p></div>`;
  }
}

function renderVideoCard(video, uploader) {
  const div = document.createElement('div');
  div.className = 'video-card';
  div.onclick = () => playVideo(video.$id);

  const name = uploader?.username || 'Unknown';
  const avatarHTML = uploader?.avatar ? `<img src="${uploader.avatar}" alt="${name}"/>` : initials(name);

  div.innerHTML = `
    <div class="video-thumb">
      ${video.thumbnail ? `<img src="${video.thumbnail}" loading="lazy" onerror="this.style.display='none'"/>` : ''}
      <video class="preview" muted playsinline preload="none"></video>
      <div class="video-thumb-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
    </div>
    <div class="video-card-info">
      <div class="avatar">${avatarHTML}</div>
      <div class="video-card-text">
        <div class="video-card-title">${escHTML(video.title || 'Untitled')}</div>
        <div class="video-card-meta">
          ${escHTML(name)}<br>
          ${timeAgo(video.$createdAt)}
        </div>
      </div>
    </div>
  `;

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
    const video = await appwriteGet(APPWRITE.videosCollection, videoId);
    if (!video) return;

    let uploader = null;
    if (video.uploader) {
      try { uploader = await appwriteGet(APPWRITE.usersCollection, video.uploader); } catch {}
    }

    showVideoPlayer();
    history.pushState(null, '', `#video/${videoId}`);

    const player = document.getElementById('videoPlayer');
    if (currentHls) { currentHls.destroy(); currentHls = null; }

    if (video.videoUrl && video.videoUrl.endsWith('.m3u8')) {
      if (player.canPlayType('application/vnd.apple.mpegurl')) {
        player.src = video.videoUrl;
      } else if (window.Hls && Hls.isSupported()) {
        currentHls = new Hls();
        currentHls.loadSource(video.videoUrl);
        currentHls.attachMedia(player);
      } else {
        toast('HLS not supported in this browser', 'error');
      }
    } else {
      player.src = video.videoUrl || '';
    }
    player.play().catch(() => {});

    document.getElementById('videoTitle').textContent = video.title || 'Untitled';
    document.getElementById('videoViews').textContent = '';
    document.getElementById('videoDate').textContent = timeAgo(video.$createdAt);
    document.getElementById('videoDescription').textContent = video.description || '';

    const name = uploader?.username || 'Unknown';
    const avatarEl = document.getElementById('videoUploaderAvatar');
    avatarEl.innerHTML = uploader?.avatar ? `<img src="${uploader.avatar}"/>` : initials(name);
    document.getElementById('videoUploaderName').textContent = name;
    document.getElementById('videoUploaderBadge').textContent = video.tags?.length ? video.tags.join(' • ') : '';
  } catch (error) {
    toast('Couldn\'t load video: ' + error.message, 'error');
  }
}

// Update popstate to handle videos
window.addEventListener('popstate', () => {
  const hash = window.location.hash;
  if (hash.startsWith('#profile/')) openProfile(hash.replace('#profile/', ''));
  else if (hash === '#videos') showVideos();
  else if (hash.startsWith('#video/')) playVideo(hash.replace('#video/', ''));
  else { showFeed(); loadFeed(); }
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
