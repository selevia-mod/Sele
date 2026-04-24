// ── Reactions config ──
const REACTIONS = [
  { key: 'heart',  emoji: '❤️',  label: 'Love' },
  { key: 'laugh',  emoji: '😂',  label: 'Haha' },
  { key: 'sad',    emoji: '😢',  label: 'Sad' },
  { key: 'cry',    emoji: '😭',  label: 'Cry' },
  { key: 'angry',  emoji: '😡',  label: 'Angry' }
];

// ── Storage ──
function getPosts() {
  return JSON.parse(localStorage.getItem('luminary_posts') || '[]');
}
function savePosts(posts) {
  localStorage.setItem('luminary_posts', JSON.stringify(posts));
}

// ── Seed demo posts ──
function seedPosts() {
  if (getPosts().length > 0) return;
  const demos = [
    {
      id: 'demo1',
      author: 'Sofia Reyes',
      title: 'The Art of Slowing Down',
      tag: 'Life',
      body: "We live in a world that celebrates speed. Fast food, fast fashion, fast replies. But I've been learning, slowly and awkwardly, that the most meaningful things in life resist acceleration.\n\nLast month I spent a week without my phone's notifications. Not a digital detox — I still used my phone — but I turned off every ping, buzz, and banner. What I found surprised me: I had opinions again. Quiet, unhurried ones.\n\nSlowing down isn't laziness. It's a radical act of self-possession in an age that profits from your distraction.",
      date: 'April 20, 2026',
      reactions: { heart: 18, laugh: 3, sad: 1, cry: 0, angry: 2 },
      userReaction: null,
      comments: [
        { author: 'James', text: 'This really resonated with me. Beautifully written.' },
        { author: 'Pia', text: 'The part about having opinions again — yes. Exactly this.' }
      ]
    },
    {
      id: 'demo2',
      author: 'Marcus Lin',
      title: 'Why I Started Cooking at Midnight',
      tag: 'Food',
      body: "It started out of insomnia and boredom. Now it's the thing I look forward to most.\n\nThere's something about cooking at midnight that strips away the performance of it. No one's watching. There's no occasion. Just you, a pan, and whatever's left in the fridge.\n\nI've made my best meals at 1am. Pasta carbonara on a Tuesday. A lamb stew that took three hours and was gone in ten minutes. Cooking stopped being a chore when it became a secret.",
      date: 'April 18, 2026',
      reactions: { heart: 31, laugh: 8, sad: 0, cry: 0, angry: 2 },
      userReaction: null,
      comments: [{ author: 'Tara', text: 'Midnight cooking hits different. Totally agree.' }]
    },
    {
      id: 'demo3',
      author: 'Nadia Osei',
      title: 'Notes from a Long Train Ride',
      tag: 'Travel',
      body: "Sixteen hours on a train from Lisbon to Madrid. I brought a book I never opened.\n\nInstead I watched Portugal turn into Spain through a dirty window. I eavesdropped on a grandmother teaching her grandson to play cards. I ate a terrible ham sandwich and thought it was perfect.\n\nTravel doesn't have to be efficient. Sometimes the journey is the destination — not as a cliché, but as a literal, stubborn fact.",
      date: 'April 15, 2026',
      reactions: { heart: 45, laugh: 5, sad: 2, cry: 3, angry: 1 },
      userReaction: null,
      comments: []
    }
  ];
  savePosts(demos);
}

// ── Utilities ──
function initials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}
function excerpt(text, len = 160) {
  return text.length > len ? text.slice(0, len).trimEnd() + '...' : text;
}
function totalReactions(r) { return Object.values(r).reduce((a, b) => a + b, 0); }
function topReactions(r) {
  return REACTIONS.filter(x => r[x.key] > 0).sort((a, b) => r[b.key] - r[a.key]).slice(0, 3).map(x => x.emoji).join('');
}

// ── Reaction pill HTML ──
function reactionPillHTML(post) {
  const total = totalReactions(post.reactions);
  const top = topReactions(post.reactions);
  const active = post.userReaction;
  const activeEmoji = active ? REACTIONS.find(r => r.key === active).emoji : '';
  return `
    <div class="reaction-wrap" data-postid="${post.id}">
      <button type="button" class="reaction-trigger ${active ? 'reacted' : ''}" data-postid="${post.id}">
        <span class="reaction-current">${active ? activeEmoji : '♡'}</span>
        ${top && !active ? '<span class="reaction-tops">' + top + '</span>' : ''}
        <span class="reaction-count">${total > 0 ? total : 'React'}</span>
      </button>
      <div class="reaction-picker" data-postid="${post.id}">
        ${REACTIONS.map(r => `
          <button type="button" class="reaction-option ${active === r.key ? 'active' : ''}" data-key="${r.key}" data-postid="${post.id}" title="${r.label}">
            <span class="r-emoji">${r.emoji}</span>
            <span class="r-label">${r.label}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

// ── Handle reaction ──
function handleReaction(postId, key) {
  const posts = getPosts();
  const post = posts.find(p => p.id === postId);
  if (!post) return;
  if (!post.reactions) post.reactions = { heart: 0, laugh: 0, sad: 0, cry: 0, angry: 0 };

  if (post.userReaction === key) {
    post.reactions[key] = Math.max(0, (post.reactions[key] || 0) - 1);
    post.userReaction = null;
  } else {
    if (post.userReaction) {
      post.reactions[post.userReaction] = Math.max(0, (post.reactions[post.userReaction] || 0) - 1);
    }
    post.reactions[key] = (post.reactions[key] || 0) + 1;
    post.userReaction = key;
  }
  savePosts(posts);
  renderFeed();
  if (activePostId === postId) refreshModalActions(post.id);
}

// ── Render feed ──
function renderFeed() {
  const feed = document.getElementById('feed');
  if (!feed) return;

  const posts = getPosts().slice().reverse();
  feed.innerHTML = '';

  if (posts.length === 0) {
    feed.innerHTML = '<div class="empty-state"><h2>No posts yet</h2><p>Be the first to write something.</p></div>';
    return;
  }

  posts.forEach((post, i) => {
    const card = document.createElement('article');
    card.className = 'post-card';
    card.dataset.postid = post.id;
    card.style.animationDelay = `${i * 0.07}s`;
    card.innerHTML = `
      <div class="post-clickable" data-action="open" data-postid="${post.id}">
        <div class="post-meta">
          <div class="post-avatar">${initials(post.author)}</div>
          <span class="post-author">${post.author}</span>
          ${post.tag ? '<span class="post-tag">' + post.tag + '</span>' : ''}
          <span class="post-date">${post.date}</span>
        </div>
        <h2 class="post-title">${post.title}</h2>
        <p class="post-excerpt">${excerpt(post.body)}</p>
      </div>
      <div class="post-footer">
        ${reactionPillHTML(post)}
        <button type="button" class="action-btn comment-btn" data-action="open" data-postid="${post.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          ${post.comments.length}
        </button>
        <span class="read-more" data-action="open" data-postid="${post.id}">Read more →</span>
      </div>
    `;
    feed.appendChild(card);
  });
}

// ── Modal ──
let activePostId = null;

function openModal(id) {
  const posts = getPosts();
  const post = posts.find(p => p.id === id);
  if (!post) return;
  activePostId = id;

  document.getElementById('modalContent').innerHTML = `
    <div class="post-meta">
      <div class="post-avatar">${initials(post.author)}</div>
      <span class="post-author">${post.author}</span>
      ${post.tag ? '<span class="post-tag">' + post.tag + '</span>' : ''}
      <span class="post-date">${post.date}</span>
    </div>
    <h2 class="post-title">${post.title}</h2>
    <p class="modal-body-text">${post.body}</p>
  `;

  refreshModalActions(id);
  renderComments(post);
  document.getElementById('postModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function refreshModalActions(id) {
  const posts = getPosts();
  const post = posts.find(p => p.id === id);
  if (!post) return;
  document.getElementById('modalActions').innerHTML = `
    <div style="display:flex; align-items:center; gap:1rem; flex-wrap:wrap;">
      ${reactionPillHTML(post)}
      <div class="reaction-summary">
        ${REACTIONS.filter(r => post.reactions && post.reactions[r.key] > 0).map(r =>
          '<span class="reaction-stat">' + r.emoji + ' <strong>' + post.reactions[r.key] + '</strong></span>'
        ).join('')}
      </div>
    </div>
  `;
}

function renderComments(post) {
  const list = document.getElementById('commentList');
  list.innerHTML = post.comments.length === 0
    ? '<p style="font-size:0.85rem;color:var(--ink-muted);">No comments yet. Be the first!</p>'
    : post.comments.map(c =>
        '<div class="comment-item"><p class="comment-author">' + escapeHTML(c.author) + '</p><p class="comment-text">' + escapeHTML(c.text) + '</p></div>'
      ).join('');
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function closeModal() {
  document.getElementById('postModal').classList.remove('open');
  document.body.style.overflow = '';
  activePostId = null;
}

// ── GLOBAL delegated click handler — handles everything in one place ──
document.addEventListener('click', (e) => {
  // 1. Reaction option click (emoji picker)
  const option = e.target.closest('.reaction-option');
  if (option) {
    e.preventDefault();
    e.stopPropagation();
    const postId = option.dataset.postid;
    const key = option.dataset.key;
    const picker = option.closest('.reaction-picker');
    if (picker) picker.classList.remove('visible');
    handleReaction(postId, key);
    return;
  }

  // 2. Reaction trigger click (toggle picker on mobile/desktop)
  const trigger = e.target.closest('.reaction-trigger');
  if (trigger) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = trigger.closest('.reaction-wrap');
    const picker = wrap.querySelector('.reaction-picker');
    const wasVisible = picker.classList.contains('visible');
    // Close all other pickers
    document.querySelectorAll('.reaction-picker.visible').forEach(p => {
      if (p !== picker) p.classList.remove('visible');
    });
    picker.classList.toggle('visible', !wasVisible);
    return;
  }

  // 3. Modal close button
  if (e.target.closest('#modalClose')) {
    e.preventDefault();
    closeModal();
    return;
  }

  // 4. Modal overlay click (outside modal box)
  if (e.target.id === 'postModal') {
    closeModal();
    return;
  }

  // 5. Open post (any element with data-action="open")
  const opener = e.target.closest('[data-action="open"]');
  if (opener) {
    const postId = opener.dataset.postid;
    if (postId) openModal(postId);
    return;
  }

  // 6. Close any open reaction pickers on outside click
  document.querySelectorAll('.reaction-picker.visible').forEach(p => p.classList.remove('visible'));
});

// Desktop hover: show picker when hovering trigger
document.addEventListener('mouseover', (e) => {
  const trigger = e.target.closest('.reaction-trigger');
  if (trigger) {
    const wrap = trigger.closest('.reaction-wrap');
    const picker = wrap.querySelector('.reaction-picker');
    picker.classList.add('visible');
  }
});

document.addEventListener('mouseout', (e) => {
  const wrap = e.target.closest('.reaction-wrap');
  if (!wrap) return;
  // Only hide if mouse left the whole wrap
  const to = e.relatedTarget;
  if (wrap.contains(to)) return;
  const picker = wrap.querySelector('.reaction-picker');
  setTimeout(() => {
    if (!wrap.matches(':hover')) picker.classList.remove('visible');
  }, 200);
});

// ── Comment submit ──
function setupCommentSubmit() {
  const btn = document.getElementById('commentSubmit');
  if (!btn) return;
  const submit = () => {
    const input = document.getElementById('commentInput');
    const text = input.value.trim();
    if (!text || !activePostId) return;
    const posts = getPosts();
    const post = posts.find(p => p.id === activePostId);
    if (!post) return;
    const name = prompt('Your name:');
    if (!name || !name.trim()) return;
    post.comments.push({ author: name.trim(), text });
    savePosts(posts);
    input.value = '';
    renderComments(post);
    renderFeed();
  };
  btn.addEventListener('click', submit);
  const input = document.getElementById('commentInput');
  if (input) input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submit();
  });
}

// ── Publish ──
function setupPublish() {
  const btn = document.getElementById('publishBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const author = document.getElementById('postAuthor').value.trim();
    const title = document.getElementById('postTitle').value.trim();
    const tag = document.getElementById('postTag').value.trim();
    const body = document.getElementById('postBody').value.trim();

    if (!author || !title || !body) {
      alert('Please fill in your name, title, and post content.');
      return;
    }

    const post = {
      id: 'post_' + Date.now(),
      author, title, tag, body,
      date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      reactions: { heart: 0, laugh: 0, sad: 0, cry: 0, angry: 0 },
      userReaction: null,
      comments: []
    };

    const posts = getPosts();
    posts.push(post);
    savePosts(posts);

    document.getElementById('postAuthor').value = '';
    document.getElementById('postTitle').value = '';
    document.getElementById('postTag').value = '';
    document.getElementById('postBody').value = '';
    document.getElementById('publishSuccess').style.display = 'block';
  });
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  seedPosts();
  renderFeed();
  setupCommentSubmit();
  setupPublish();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
});
