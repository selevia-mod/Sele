// ── Reactions config ──
const REACTIONS = [
  { key: 'heart',  emoji: '❤️',  label: 'Love' },
  { key: 'laugh',  emoji: '😂',  label: 'Haha' },
  { key: 'sad',    emoji: '😢',  label: 'Sad' },
  { key: 'cry',    emoji: '😭',  label: 'Cry' },
  { key: 'angry',  emoji: '😡',  label: 'Angry' }
];

// ── Storage helpers ──
function getPosts() {
  return JSON.parse(localStorage.getItem('luminary_posts') || '[]');
}
function savePosts(posts) {
  localStorage.setItem('luminary_posts', JSON.stringify(posts));
}

// ── Seed demo posts if first visit ──
function seedPosts() {
  if (getPosts().length > 0) return;
  const demos = [
    {
      id: 'demo1',
      author: 'Sofia Reyes',
      title: 'The Art of Slowing Down',
      tag: 'Life',
      body: `We live in a world that celebrates speed. Fast food, fast fashion, fast replies. But I've been learning, slowly and awkwardly, that the most meaningful things in life resist acceleration.\n\nLast month I spent a week without my phone's notifications. Not a digital detox — I still used my phone — but I turned off every ping, buzz, and banner. What I found surprised me: I had opinions again. Quiet, unhurried ones.\n\nSlowing down isn't laziness. It's a radical act of self-possession in an age that profits from your distraction.`,
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
      body: `It started out of insomnia and boredom. Now it's the thing I look forward to most.\n\nThere's something about cooking at midnight that strips away the performance of it. No one's watching. There's no occasion. Just you, a pan, and whatever's left in the fridge.\n\nI've made my best meals at 1am. Pasta carbonara on a Tuesday. A lamb stew that took three hours and was gone in ten minutes. Cooking stopped being a chore when it became a secret.`,
      date: 'April 18, 2026',
      reactions: { heart: 31, laugh: 8, sad: 0, cry: 0, angry: 2 },
      userReaction: null,
      comments: [
        { author: 'Tara', text: 'Midnight cooking hits different. Totally agree.' }
      ]
    },
    {
      id: 'demo3',
      author: 'Nadia Osei',
      title: 'Notes from a Long Train Ride',
      tag: 'Travel',
      body: `Sixteen hours on a train from Lisbon to Madrid. I brought a book I never opened.\n\nInstead I watched Portugal turn into Spain through a dirty window. I eavesdropped on a grandmother teaching her grandson to play cards. I ate a terrible ham sandwich and thought it was perfect.\n\nTravel doesn't have to be efficient. Sometimes the journey is the destination — not as a cliché, but as a literal, stubborn fact.`,
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
  return text.length > len ? text.slice(0, len).trimEnd() + '…' : text;
}
function totalReactions(reactions) {
  return Object.values(reactions).reduce((a, b) => a + b, 0);
}
function topReactions(reactions) {
  return REACTIONS
    .filter(r => reactions[r.key] > 0)
    .sort((a, b) => reactions[b.key] - reactions[a.key])
    .slice(0, 3)
    .map(r => r.emoji)
    .join('');
}

// ── Reaction pill HTML ──
function reactionPillHTML(post) {
  const total = totalReactions(post.reactions);
  const top = topReactions(post.reactions);
  const active = post.userReaction;
  const activeEmoji = active ? REACTIONS.find(r => r.key === active)?.emoji : '🤍';
  return `
    <div class="reaction-wrap" data-id="${post.id}">
      <button class="reaction-trigger ${active ? 'reacted' : ''}" title="React">
        <span class="reaction-current">${activeEmoji}</span>
        ${top ? `<span class="reaction-tops">${top}</span>` : ''}
        <span class="reaction-count">${total > 0 ? total : 'React'}</span>
      </button>
      <div class="reaction-picker">
        ${REACTIONS.map(r => `
          <button class="reaction-option ${active === r.key ? 'active' : ''}" data-key="${r.key}" title="${r.label}">
            <span class="r-emoji">${r.emoji}</span>
            <span class="r-label">${r.label}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

// ── Handle reaction click ──
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
  if (activePostId === postId) openModal(postId);
}

// ── Attach reaction events ──
function attachReactionEvents(container) {
  container.querySelectorAll('.reaction-wrap').forEach(wrap => {
    const postId = wrap.dataset.id;
    const picker = wrap.querySelector('.reaction-picker');
    const trigger = wrap.querySelector('.reaction-trigger');
    let hideTimer;

    trigger.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      picker.classList.add('visible');
    });
    wrap.addEventListener('mouseleave', () => {
      hideTimer = setTimeout(() => picker.classList.remove('visible'), 200);
    });
    picker.addEventListener('mouseenter', () => clearTimeout(hideTimer));

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      picker.classList.toggle('visible');
    });

    wrap.querySelectorAll('.reaction-option').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleReaction(postId, btn.dataset.key);
        picker.classList.remove('visible');
      });
    });
  });
}

// ── Render feed ──
function renderFeed() {
  const feed = document.getElementById('feed');
  if (!feed) return;

  const posts = getPosts().slice().reverse();
  feed.innerHTML = '';

  if (posts.length === 0) {
    feed.innerHTML = `<div class="empty-state"><h2>No posts yet</h2><p>Be the first to write something.</p></div>`;
    return;
  }

  posts.forEach((post, i) => {
    const card = document.createElement('div');
    card.className = 'post-card';
    card.style.animationDelay = `${i * 0.07}s`;
    card.innerHTML = `
      <div class="post-meta">
        <div class="post-avatar">${initials(post.author)}</div>
        <span class="post-author">${post.author}</span>
        ${post.tag ? `<span class="post-tag">${post.tag}</span>` : ''}
        <span class="post-date">${post.date}</span>
      </div>
      <h2 class="post-title">${post.title}</h2>
      <p class="post-excerpt">${excerpt(post.body)}</p>
      <div class="post-footer">
        ${reactionPillHTML(post)}
        <button class="action-btn comment-btn" data-id="${post.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          ${post.comments.length}
        </button>
        <span class="read-more">Read more →</span>
      </div>
    `;
    card.addEventListener('click', (e) => {
      if (!e.target.closest('.reaction-wrap')) openModal(post.id);
    });
    feed.appendChild(card);
  });

  attachReactionEvents(feed);
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
      ${post.tag ? `<span class="post-tag">${post.tag}</span>` : ''}
      <span class="post-date">${post.date}</span>
    </div>
    <h2 class="post-title">${post.title}</h2>
    <p class="modal-body-text">${post.body}</p>
  `;

  document.getElementById('modalActions').innerHTML = `
    <div style="display:flex; align-items:center; gap:1rem; flex-wrap:wrap;">
      ${reactionPillHTML(post)}
      <div class="reaction-summary">
        ${REACTIONS.filter(r => (post.reactions?.[r.key] || 0) > 0).map(r => `
          <span class="reaction-stat">${r.emoji} <strong>${post.reactions[r.key]}</strong></span>
        `).join('')}
      </div>
    </div>
  `;

  attachReactionEvents(document.getElementById('modalActions'));
  renderComments(post);
  document.getElementById('postModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function renderComments(post) {
  const list = document.getElementById('commentList');
  list.innerHTML = post.comments.length === 0
    ? `<p style="font-size:0.85rem;color:var(--ink-muted);">No comments yet. Be the first!</p>`
    : post.comments.map(c => `
        <div class="comment-item">
          <p class="comment-author">${c.author}</p>
          <p class="comment-text">${c.text}</p>
        </div>
      `).join('');
}

function closeModal() {
  document.getElementById('postModal').classList.remove('open');
  document.body.style.overflow = '';
  activePostId = null;
}

// ── Comment submit ──
function setupCommentSubmit() {
  const btn = document.getElementById('commentSubmit');
  if (!btn) return;
  btn.addEventListener('click', () => {
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
  });
}

// ── Write / Publish ──
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

  const closeBtn = document.getElementById('modalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);

  const overlay = document.getElementById('postModal');
  if (overlay) overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
});
