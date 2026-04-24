import { supabase, REACTIONS, timeAgo, initials } from './supabase.js';

// ── State ──
let currentUser = null;
let currentProfile = null;
let posts = [];

// ── Toast ──
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

// ── Image upload helper ──
async function uploadImage(file) {
  if (!file) return null;
  if (!file.type.startsWith('image/')) {
    toast('Please select an image file', 'error');
    return null;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast('Image must be smaller than 5MB', 'error');
    return null;
  }

  const ext = file.name.split('.').pop().toLowerCase();
  const filename = `${currentUser.id}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;

  const { error } = await supabase.storage.from('images').upload(filename, file, {
    cacheControl: '3600',
    upsert: false
  });

  if (error) {
    toast('Upload failed: ' + error.message, 'error');
    return null;
  }

  const { data } = supabase.storage.from('images').getPublicUrl(filename);
  return data.publicUrl;
}

// ── Lightbox ──
window.openLightbox = (url) => {
  document.getElementById('lightboxImg').src = url;
  document.getElementById('lightbox').classList.add('open');
};
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox' || e.target.id === 'lightboxClose') {
    document.getElementById('lightbox').classList.remove('open');
  }
});

// ── Auth ──
async function initAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    await onSignedIn(session.user);
  } else {
    showAuth();
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (session) await onSignedIn(session.user);
    else showAuth();
  });
}

async function onSignedIn(user) {
  currentUser = user;
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  currentProfile = profile;
  updateSidebarUser();
  showApp();
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

function updateSidebarUser() {
  if (!currentProfile) return;
  const name = currentProfile.username || 'User';
  const isGuest = currentProfile.is_guest;

  document.getElementById('sidebarName').textContent = name;
  document.getElementById('sidebarRole').textContent = isGuest ? 'Guest account' : 'Member';

  const avatarEl = document.getElementById('sidebarAvatar');
  const composeAvatarEl = document.getElementById('composeAvatar');
  if (currentProfile.avatar_url) {
    avatarEl.innerHTML = `<img src="${currentProfile.avatar_url}" alt="${name}"/>`;
    composeAvatarEl.innerHTML = `<img src="${currentProfile.avatar_url}" alt="${name}"/>`;
  } else {
    avatarEl.textContent = initials(name);
    composeAvatarEl.textContent = initials(name);
  }
}

// ── Auth buttons ──
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
  currentUser = null;
  currentProfile = null;
  posts = [];
}

document.getElementById('btnSignOut').addEventListener('click', signOut);
document.getElementById('mobileSignOut').addEventListener('click', signOut);

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
      </div>
    `;
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
    if (!imageUrl) {
      btn.disabled = false;
      btn.textContent = 'Post';
      return;
    }
  }

  btn.textContent = 'Posting...';
  const { error } = await supabase.from('posts').insert({
    user_id: currentUser.id,
    body: body || '',
    image_url: imageUrl
  });
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

// ── Load feed ──
async function loadFeed() {
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
    el.style.animationDelay = `${i * 0.05}s`;
    feed.appendChild(el);
  });
}

// ── Render post ──
function renderPost(post) {
  const div = document.createElement('div');
  div.className = 'post-card';
  div.dataset.postid = post.id;

  const profile = post.profiles || {};
  const name = profile.username || 'Unknown';
  const isGuest = profile.is_guest;
  const avatarHTML = profile.avatar_url
    ? `<img src="${profile.avatar_url}" alt="${name}"/>`
    : initials(name);

  div.innerHTML = `
    <div class="post-header">
      <div class="avatar">${avatarHTML}</div>
      <div>
        <div style="display:flex;align-items:center;gap:0.5rem">
          <span class="post-author">${escHTML(name)}</span>
          ${isGuest ? '<span class="post-guest">Guest</span>' : ''}
        </div>
        <div class="post-time">${timeAgo(post.created_at)}</div>
      </div>
      ${currentUser && currentUser.id === post.user_id ? `
        <button class="comment-action-btn" style="margin-left:auto" onclick="deletePost('${post.id}')">✕ Delete</button>
      ` : ''}
    </div>
    ${post.reposted_from && post.original ? `
      <div class="reposted-banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        ${escHTML(name)} reposted
      </div>
    ` : ''}
    ${post.body ? `<div class="post-body">${linkify(post.body)}</div>` : ''}
    ${post.image_url ? `<div class="post-image" onclick="openLightbox('${post.image_url}')"><img src="${post.image_url}" alt="post image" loading="lazy"/></div>` : ''}
    ${post.reposted_from && post.original ? `
      <div class="reposted-card">
        <div class="post-header">
          <div class="avatar">${post.original.profiles?.avatar_url ? `<img src="${post.original.profiles.avatar_url}"/>` : initials(post.original.profiles?.username || 'U')}</div>
          <div>
            <div style="display:flex;align-items:center;gap:0.5rem"><span class="post-author">${escHTML(post.original.profiles?.username || 'Unknown')}</span></div>
            <div class="post-time">${timeAgo(post.original.created_at)}</div>
          </div>
        </div>
        ${post.original.body ? `<div class="post-body">${linkify(post.original.body)}</div>` : ''}
        ${post.original.image_url ? `<div class="post-image" onclick="event.stopPropagation();openLightbox('${post.original.image_url}')"><img src="${post.original.image_url}" loading="lazy"/></div>` : ''}
      </div>
    ` : ''}
    <div class="post-actions">
      <div class="reaction-wrap" data-target="${post.id}" data-type="post">
        <button class="reaction-trigger" data-target="${post.id}" data-type="post">
          <span class="r-current">♡</span>
          <span class="r-count"></span>
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
      <button class="comment-toggle" data-postid="${post.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span id="ccount-${post.id}">Comment</span>
      </button>
      <button class="comment-toggle" onclick="repostPost('${post.id}')" title="Repost on Sele">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        Repost
      </button>
      <div class="share-wrap">
        <button class="comment-toggle" onclick="toggleShareMenu(event, '${post.id}')" title="Share">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          Share
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
  return div;
}

function escHTML(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function linkify(str) {
  const escaped = escHTML(str);
  return escaped.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:var(--purple2);text-decoration:underline;word-break:break-all;">$1</a>'
  );
}

// ── Delete post ──
window.deletePost = async (postId) => {
  if (!confirm('Delete this post?')) return;
  const { error } = await supabase.from('posts').delete().eq('id', postId);
  if (error) toast(error.message, 'error');
  else { toast('Post deleted', 'success'); loadFeed(); }
};

// ── Reactions ──
async function loadReactions(targetId, targetType) {
  const { data } = await supabase
    .from('reactions')
    .select('emoji, user_id')
    .eq('target_id', targetId)
    .eq('target_type', targetType);

  if (!data) return;

  // Count per emoji
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
  const total = Object.values(counts).reduce((a,b) => a+b, 0);
  const activeR = userReaction ? REACTIONS.find(r => r.key === userReaction) : null;

  const usedEmojis = REACTIONS
    .filter(r => counts[r.key] > 0)
    .sort((a, b) => counts[b.key] - counts[a.key])
    .map(r => r.emoji)
    .join('');
  trigger.querySelector('.r-current').textContent = usedEmojis || '♡';
  trigger.querySelector('.r-count').textContent = total > 0 ? total : '';
  trigger.classList.toggle('reacted', !!userReaction);

  // Mark active option
  wrap.querySelectorAll('.reaction-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.key === userReaction);
  });

}

async function handleReaction(targetId, targetType, emojiKey) {
  if (!currentUser) return toast('Sign in to react', 'error');

  // Get current user reaction
  const { data: existing } = await supabase
    .from('reactions')
    .select('id, emoji')
    .eq('user_id', currentUser.id)
    .eq('target_id', targetId)
    .eq('target_type', targetType)
    .maybeSingle();

  if (existing) {
    if (existing.emoji === emojiKey) {
      // Remove reaction
      await supabase.from('reactions').delete().eq('id', existing.id);
    } else {
      // Change reaction
      await supabase.from('reactions').update({ emoji: emojiKey }).eq('id', existing.id);
    }
  } else {
    // Add reaction
    await supabase.from('reactions').insert({
      user_id: currentUser.id,
      target_id: targetId,
      target_type: targetType,
      emoji: emojiKey
    });
  }

  loadReactions(targetId, targetType);
}

// ── Comments ──
async function loadComments(postId) {
  const section = document.getElementById(`comments-${postId}`);
  section.innerHTML = '<div class="loading" style="padding:1rem">Loading...</div>';

  const { data, error } = await supabase
    .from('comments')
    .select(`*, profiles(username, avatar_url, is_guest)`)
    .eq('post_id', postId)
    .is('parent_id', null)
    .order('created_at', { ascending: true });

  if (error) { section.innerHTML = `<p style="color:var(--text3);font-size:0.85rem">${error.message}</p>`; return; }

  section.innerHTML = '';

  // Top-level comments
  const comments = data || [];
  const countEl = document.getElementById(`ccount-${postId}`);
  if (countEl) countEl.textContent = comments.length ? `${comments.length} comment${comments.length !== 1 ? 's' : ''}` : 'Comment';

  for (const comment of comments) {
    const el = await renderComment(comment, postId);
    section.appendChild(el);
  }

  // Comment input with image support
  const inputWrap = document.createElement('div');
  inputWrap.className = 'comment-input-wrap';
  inputWrap.style.flexDirection = 'column';
  inputWrap.style.gap = '0.5rem';
  inputWrap.innerHTML = `
    <div style="display:flex;gap:0.5rem;align-items:flex-start;width:100%">
      <div class="avatar sm">${currentProfile?.avatar_url ? `<img src="${currentProfile.avatar_url}"/>` : initials(currentProfile?.username || 'G')}</div>
      <textarea class="comment-input" placeholder="Write a comment…" rows="1" id="cinput-${postId}"></textarea>
      <button class="btn-send" id="csend-${postId}">Send</button>
    </div>
    <div id="cimgpreview-${postId}" style="margin-left:38px"></div>
    <div style="margin-left:38px;margin-top:-4px">
      <label class="image-upload-btn" style="padding:4px 8px;font-size:0.72rem">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        Add photo
        <input type="file" accept="image/*" class="cimg-input" data-postid="${postId}" data-parentid=""/>
      </label>
    </div>
  `;
  section.appendChild(inputWrap);

  // Auto-resize textarea
  const ta = inputWrap.querySelector('textarea');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(postId, null, ta, `cimgpreview-${postId}`); }
  });
  inputWrap.querySelector(`#csend-${postId}`).addEventListener('click', () => submitComment(postId, null, ta, `cimgpreview-${postId}`));

  // Image input listener
  inputWrap.querySelector('.cimg-input').addEventListener('change', (e) => {
    handleCommentImageSelect(e.target, `cimgpreview-${postId}`);
  });
}

async function renderComment(comment, postId, isReply = false, topLevelId = null) {
  const div = document.createElement('div');
  div.className = isReply ? 'reply-item' : 'comment-item';
  div.dataset.commentid = comment.id;

  const profile = comment.profiles || {};
  const name = profile.username || 'Unknown';
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}"/>` : initials(name);

  // For replies, the "thread root" is the top-level comment id (passed in)
  // All nested replies attach to that root so the thread stays flat-but-readable
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
      ${comment.image_url ? `<div class="comment-image" onclick="openLightbox('${comment.image_url}')"><img src="${comment.image_url}" alt="comment image" loading="lazy"/></div>` : ''}
      <div class="comment-actions">
        <div class="reaction-wrap" data-target="${comment.id}" data-type="comment" style="position:relative">
          <button class="reaction-trigger" data-target="${comment.id}" data-type="comment" style="padding:2px 8px;font-size:0.72rem">
            <span class="r-current">♡</span>
            <span class="r-count"></span>
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

  // Load replies (only top-level comments load their replies)
  if (!isReply) {
    await loadReplies(comment.id, postId, div.querySelector(`#replies-${comment.id}`));
  }

  return div;
}

async function loadReplies(commentId, postId, container) {
  const { data } = await supabase
    .from('comments')
    .select(`*, profiles(username, avatar_url, is_guest)`)
    .eq('parent_id', commentId)
    .order('created_at', { ascending: true });

  if (!data || !data.length) return;
  for (const reply of data) {
    // Pass commentId as topLevelId so nested replies still attach to the top-level thread
    const el = await renderComment(reply, postId, true, commentId);
    container.appendChild(el);
  }
}

// ── Comment image helpers ──
const pendingCommentImages = {}; // previewId -> File

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
    preview.innerHTML = `
      <div class="image-preview" style="max-width:240px">
        <img src="${ev.target.result}"/>
        <button class="image-preview-remove" data-previewid="${previewId}">×</button>
      </div>
    `;
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

  const { error } = await supabase.from('comments').insert({
    post_id: postId,
    user_id: currentUser.id,
    parent_id: parentId || null,
    body: body || '',
    image_url: imageUrl
  });

  if (error) { toast(error.message, 'error'); return; }
  textarea.value = '';
  textarea.style.height = 'auto';
  if (previewId) {
    delete pendingCommentImages[previewId];
    const preview = document.getElementById(previewId);
    if (preview) preview.innerHTML = '';
  }
  loadComments(postId);
}

window.deleteComment = async (commentId, postId) => {
  if (!confirm('Delete this comment?')) return;
  await supabase.from('comments').delete().eq('id', commentId);
  loadComments(postId);
};

// ── Global event delegation ──
document.addEventListener('click', (e) => {
  // Reaction option
  const option = e.target.closest('.reaction-option');
  if (option) {
    e.preventDefault(); e.stopPropagation();
    const { key, target, type } = option.dataset;
    option.closest('.reaction-picker')?.classList.remove('visible');
    handleReaction(target, type, key);
    return;
  }

  // Reaction trigger
  const trigger = e.target.closest('.reaction-trigger');
  if (trigger) {
    e.preventDefault(); e.stopPropagation();
    const picker = trigger.closest('.reaction-wrap')?.querySelector('.reaction-picker');
    document.querySelectorAll('.reaction-picker.visible').forEach(p => { if (p !== picker) p.classList.remove('visible'); });
    picker?.classList.toggle('visible');
    return;
  }

  // Comment toggle
  const ct = e.target.closest('.comment-toggle');
  if (ct) {
    const postId = ct.dataset.postid;
    const section = document.getElementById(`comments-${postId}`);
    if (section.style.display === 'none') {
      section.style.display = 'block';
      loadComments(postId);
    } else {
      section.style.display = 'none';
    }
    return;
  }

  // Reply button
  const replyBtn = e.target.closest('.reply-btn');
  if (replyBtn) {
    const { commentid, postid, replyto } = replyBtn.dataset;
    showReplyInput(commentid, postid, replyto);
    return;
  }

  // Close pickers on outside click
  if (!e.target.closest('.reaction-wrap')) {
    document.querySelectorAll('.reaction-picker.visible').forEach(p => p.classList.remove('visible'));
  }
});

// Hover to show picker (desktop)
document.addEventListener('mouseover', (e) => {
  const trigger = e.target.closest('.reaction-trigger');
  if (trigger) {
    const picker = trigger.closest('.reaction-wrap')?.querySelector('.reaction-picker');
    picker?.classList.add('visible');
  }
});
document.addEventListener('mouseout', (e) => {
  const wrap = e.target.closest('.reaction-wrap');
  if (!wrap || wrap.contains(e.relatedTarget)) return;
  setTimeout(() => { if (!wrap.matches(':hover')) wrap.querySelector('.reaction-picker')?.classList.remove('visible'); }, 200);
});

// ── Reply input ──
function showReplyInput(commentId, postId, replyToName = '') {
  // Remove any existing reply inputs
  document.querySelectorAll('.reply-input-wrap').forEach(el => el.remove());

  const repliesContainer = document.getElementById(`replies-${commentId}`);
  if (!repliesContainer) return;

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
    <div id="${previewId}" style="margin-left:38px"></div>
    <div style="margin-left:38px;margin-top:-4px">
      <label class="image-upload-btn" style="padding:4px 8px;font-size:0.72rem">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        Add photo
        <input type="file" accept="image/*" class="rimg-input"/>
      </label>
    </div>
  `;

  const ta = wrap.querySelector('textarea');
  // Prefill @mention if replying to a specific person
  if (replyToName) {
    ta.value = `@${replyToName} `;
  }
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(postId, commentId, ta, previewId); } });
  wrap.querySelector('.btn-send').addEventListener('click', () => submitComment(postId, commentId, ta, previewId));
  wrap.querySelector('.rimg-input').addEventListener('change', (e) => {
    handleCommentImageSelect(e.target, previewId);
  });

  repliesContainer.appendChild(wrap);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ── Realtime updates ──
function setupRealtime() {
  supabase.channel('public-feed')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, () => loadFeed())
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, () => loadFeed())
    .subscribe();
}

// ── Repost Modal ──
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
      <div>
        <div style="display:flex;align-items:center;gap:0.5rem">
          <span class="post-author">${escHTML(name)}</span>
          ${profile.is_guest ? '<span class="post-guest">Guest</span>' : ''}
        </div>
        <div class="post-time">${timeAgo(post.created_at)}</div>
      </div>
    </div>
    ${post.body ? `<div class="post-body">${linkify(post.body)}</div>` : ''}
    ${post.image_url ? `<div style="border-radius:8px;overflow:hidden;margin-top:0.5rem"><img src="${post.image_url}" style="width:100%"/></div>` : ''}
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
document.getElementById('repostModal').addEventListener('click', (e) => {
  if (e.target.id === 'repostModal') closeRepostModal();
});

document.getElementById('repostSubmit').addEventListener('click', async () => {
  if (!repostTargetId) return;
  const caption = document.getElementById('repostCaption').value.trim();
  const btn = document.getElementById('repostSubmit');
  btn.disabled = true;
  btn.textContent = 'Posting...';

  const { error } = await supabase.from('posts').insert({
    user_id: currentUser.id,
    body: caption,
    reposted_from: repostTargetId
  });

  btn.disabled = false;
  btn.textContent = 'Repost';

  if (error) { toast(error.message, 'error'); return; }
  closeRepostModal();
  toast('Reposted!', 'success');
  loadFeed();
});

window.toggleShareMenu = (e, postId) => {
  e.stopPropagation();
  document.querySelectorAll('.share-menu.visible').forEach(m => {
    if (m.id !== `sharemenu-${postId}`) m.classList.remove('visible');
  });
  document.getElementById(`sharemenu-${postId}`).classList.toggle('visible');
};

window.shareTo = (platform, postId) => {
  const url = `${window.location.origin}?post=${postId}`;
  const text = 'Check out this post on Sele';
  const urls = {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    twitter:  `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`
  };
  if (platform === 'copy') {
    navigator.clipboard.writeText(url).then(() => toast('Link copied!', 'success'));
  } else if (urls[platform]) {
    window.open(urls[platform], '_blank');
  }
  document.getElementById(`sharemenu-${postId}`).classList.remove('visible');
};

// Close share menu on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.share-wrap')) {
    document.querySelectorAll('.share-menu.visible').forEach(m => m.classList.remove('visible'));
  }
});

// ── Init ──
initAuth();
setupRealtime();
