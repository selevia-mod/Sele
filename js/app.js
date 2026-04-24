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

composeText.addEventListener('input', () => {
  const len = composeText.value.length;
  charCount.textContent = `${len} / 5000`;
  charCount.className = 'char-count' + (len > 4500 ? ' warn' : '') + (len >= 5000 ? ' over' : '');
  composeText.style.height = 'auto';
  composeText.style.height = composeText.scrollHeight + 'px';
});

document.getElementById('btnPost').addEventListener('click', async () => {
  const body = composeText.value.trim();
  if (!body) return;
  if (!currentUser) return toast('Please sign in first', 'error');

  const btn = document.getElementById('btnPost');
  btn.disabled = true;
  btn.textContent = 'Posting...';

  const { error } = await supabase.from('posts').insert({ user_id: currentUser.id, body });
  btn.disabled = false;
  btn.textContent = 'Post';

  if (error) { toast(error.message, 'error'); return; }
  composeText.value = '';
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
    .select(`*, profiles(username, avatar_url, is_guest)`)
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
    <div class="post-body">${escHTML(post.body)}</div>
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
      <div class="reaction-summary" id="rsummary-${post.id}"></div>
      <button class="comment-toggle" data-postid="${post.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span id="ccount-${post.id}">Comment</span>
      </button>
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

  trigger.querySelector('.r-current').textContent = activeR ? activeR.emoji : '♡';
  trigger.querySelector('.r-count').textContent = total > 0 ? total : '';
  trigger.classList.toggle('reacted', !!userReaction);

  // Mark active option
  wrap.querySelectorAll('.reaction-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.key === userReaction);
  });

  // Summary (only for posts)
  if (targetType === 'post') {
    const summary = document.getElementById(`rsummary-${targetId}`);
    if (summary) {
      summary.innerHTML = REACTIONS
        .filter(r => counts[r.key] > 0)
        .sort((a,b) => counts[b.key] - counts[a.key])
        .slice(0,3)
        .map(r => `<span class="reaction-stat">${r.emoji} ${counts[r.key]}</span>`)
        .join('');
    }
  }
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

  // Comment input
  const inputWrap = document.createElement('div');
  inputWrap.className = 'comment-input-wrap';
  inputWrap.innerHTML = `
    <div class="avatar sm">${currentProfile?.avatar_url ? `<img src="${currentProfile.avatar_url}"/>` : initials(currentProfile?.username || 'G')}</div>
    <textarea class="comment-input" placeholder="Write a comment…" rows="1" id="cinput-${postId}"></textarea>
    <button class="btn-send" id="csend-${postId}">Send</button>
  `;
  section.appendChild(inputWrap);

  // Auto-resize textarea
  const ta = inputWrap.querySelector('textarea');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(postId, null, ta); }
  });
  inputWrap.querySelector(`#csend-${postId}`).addEventListener('click', () => submitComment(postId, null, ta));
}

async function renderComment(comment, postId, isReply = false) {
  const div = document.createElement('div');
  div.className = isReply ? 'reply-item' : 'comment-item';
  div.dataset.commentid = comment.id;

  const profile = comment.profiles || {};
  const name = profile.username || 'Unknown';
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}"/>` : initials(name);

  div.innerHTML = `
    <div class="avatar sm">${avatarHTML}</div>
    <div class="comment-body">
      <div class="comment-meta">
        <span class="comment-author">${escHTML(name)}</span>
        <span class="comment-time">${timeAgo(comment.created_at)}</span>
        ${profile.is_guest ? '<span class="post-guest">Guest</span>' : ''}
      </div>
      <div class="comment-bubble">${escHTML(comment.body)}</div>
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
        ${!isReply ? `<button class="comment-action-btn reply-btn" data-commentid="${comment.id}" data-postid="${postId}">Reply</button>` : ''}
        ${currentUser && currentUser.id === comment.user_id ? `<button class="comment-action-btn" onclick="deleteComment('${comment.id}','${postId}')">Delete</button>` : ''}
      </div>
      ${!isReply ? `<div class="replies" id="replies-${comment.id}"></div>` : ''}
    </div>
  `;

  loadReactions(comment.id, 'comment');

  // Load replies
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
    const el = await renderComment(reply, postId, true);
    container.appendChild(el);
  }
}

async function submitComment(postId, parentId, textarea) {
  const body = textarea.value.trim();
  if (!body) return;
  if (!currentUser) return toast('Sign in to comment', 'error');

  const { error } = await supabase.from('comments').insert({
    post_id: postId,
    user_id: currentUser.id,
    parent_id: parentId || null,
    body
  });

  if (error) { toast(error.message, 'error'); return; }
  textarea.value = '';
  textarea.style.height = 'auto';
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
    const { commentid, postid } = replyBtn.dataset;
    showReplyInput(commentid, postid);
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
function showReplyInput(commentId, postId) {
  // Remove any existing reply inputs
  document.querySelectorAll('.reply-input-wrap').forEach(el => el.remove());

  const repliesContainer = document.getElementById(`replies-${commentId}`);
  if (!repliesContainer) return;

  const wrap = document.createElement('div');
  wrap.className = 'comment-input-wrap reply-input-wrap';
  wrap.style.marginTop = '0.5rem';
  wrap.innerHTML = `
    <div class="avatar sm">${currentProfile?.avatar_url ? `<img src="${currentProfile.avatar_url}"/>` : initials(currentProfile?.username || 'G')}</div>
    <textarea class="comment-input" placeholder="Write a reply…" rows="1"></textarea>
    <button class="btn-send">Reply</button>
  `;

  const ta = wrap.querySelector('textarea');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(postId, commentId, ta); } });
  wrap.querySelector('.btn-send').addEventListener('click', () => submitComment(postId, commentId, ta));

  repliesContainer.appendChild(wrap);
  ta.focus();
}

// ── Realtime updates ──
function setupRealtime() {
  supabase.channel('public-feed')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, () => loadFeed())
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, () => loadFeed())
    .subscribe();
}

// ── Init ──
initAuth();
setupRealtime();
