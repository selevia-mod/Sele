// ════════════════════════════════════════════════════════════════════════
// Selebox engagement — extracted from js/app.js as Stage 12 of the
// refactor roadmap (2026-05-16). This module owns the polymorphic
// reactions + comments engagement layer that's shared by posts,
// videos, and comments-on-the-above (anything that uses the generic
// `reactions` and `comments` tables with a `target_type` discriminator).
//
// What's here:
//   • Batch loaders — bulkLoadReactions, bulkLoadCommentCounts (used
//     by feed.js when it renders a page of posts).
//   • Reactions — loadReactions, handleReaction (set/clear/swap),
//     the .reaction-trigger + .reaction-option click delegates.
//   • Comments — loadComments, renderComment, submitComment, the
//     "N comments" + .comment-toggle click delegates, the per-section
//     realtime channel (_commentsChannelByContainer).
//   • Reactor list modal — openReactorListModal (the "X others" tap
//     that shows everyone who reacted, grouped by emoji).
//
// What's NOT here:
//   • Book chapter likes (`chapter_likes` table) — lives in books.js
//     because it uses different tables/RPCs.
//   • Book comments — likewise, lives in books.js.
//   • Engagement-goal ticking (`tickGoalUnique`) — still in app.js
//     for now; will move to js/goals.js in Stage 14.
//
// CAREFUL: this is pure code movement, not a rewrite. If you see
// something you want to "improve while you're here" — DON'T. Open a
// separate task. Stage discipline is "translation, not interpretation."
//
// See REFACTOR_ROADMAP.md (Stage 12 section).
// ════════════════════════════════════════════════════════════════════════

import { supabase, REACTIONS, escHTML, initials, timeAgo, toast } from './supabase.js';

// ─── Config-injection dependency surface ──────────────────────────────────
// app.js INJECTS these on sign-in via initEngagement(config). Defaults
// are no-ops so the module loads cleanly even if a caller fires before
// init (delegated DOM click handlers attach at module-load time).
let _cfg = {
  getCurrentUser:           () => null,
  getCurrentProfile:        () => null,
  tickGoalUnique:           () => {},
  openProfile:              () => {},
  closeAllModals:           () => {},
  renderRoleSeal:           () => '',
  uploadImage:              async () => null,
  confirmDialog:            async () => false,
  linkify:                  (s) => s,
  renderLinkPreview:        () => '',
  firstUrlInText:           () => null,
};

export function initEngagement(config) {
  if (config) _cfg = { ..._cfg, ...config };
}


// ─── Batch engagement loaders ──────────────────────────────────────────────
export async function bulkLoadReactions(targetIds, targetType) {
  if (!targetIds.length) return;
  const { data } = await supabase
    .from('reactions')
    .select('target_id, emoji, user_id')
    .in('target_id', targetIds)
    .eq('target_type', targetType);
  if (!data) return;
  const grouped = {};
  data.forEach(r => {
    if (!grouped[r.target_id]) grouped[r.target_id] = { counts: {}, userReaction: null };
    grouped[r.target_id].counts[r.emoji] = (grouped[r.target_id].counts[r.emoji] || 0) + 1;
    if (_cfg.getCurrentUser() && r.user_id === _cfg.getCurrentUser().id) grouped[r.target_id].userReaction = r.emoji;
  });
  // Update each target — empty groups still call updateReactionUI to clear stale state
  for (const id of targetIds) {
    const g = grouped[id] || { counts: {}, userReaction: null };
    updateReactionUI(id, targetType, g.counts, g.userReaction);
  }
}

// Bulk fetch comment counts via single rows-then-group (no count queries).
export async function bulkLoadCommentCounts(postIds) {
  if (!postIds.length) return;
  const { data } = await supabase
    .from('comments')
    .select('post_id')
    .in('post_id', postIds);
  if (!data) return;
  const counts = {};
  data.forEach(c => { counts[c.post_id] = (counts[c.post_id] || 0) + 1; });
  postIds.forEach(id => {
    const count = counts[id] || 0;
    const text = count > 0 ? `${count} comment${count !== 1 ? 's' : ''}` : '';
    document.querySelectorAll(`#ccount-${id}`).forEach(el => { el.textContent = text; });
  });
}

// ─── loadCommentCount helper ──────────────────────────────────────────────
export async function loadCommentCount(postId, videoId = null) {
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

// ─── Reactions block ──────────────────────────────────────────────
// ── Reactions ──
export async function loadReactions(targetId, targetType) {
  const { data } = await supabase.from('reactions').select('emoji, user_id').eq('target_id', targetId).eq('target_type', targetType);
  if (!data) return;
  const counts = {};
  let userReaction = null;
  data.forEach(r => {
    counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    if (_cfg.getCurrentUser() && r.user_id === _cfg.getCurrentUser().id) userReaction = r.emoji;
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
      // Use the custom FB-style SVG badge (ported from mobile assets/
      // reactions/) instead of the system emoji glyph — avoids the
      // half-pixel descender shimmy when switching reactions, and
      // matches mobile's PostReactionIcon visually.
      iconEl.innerHTML = `<img class="r-emoji-svg" src="${activeR.svg}" alt="${activeR.label}" width="18" height="18">`;
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
    // Stack up to 2 top-reaction SVGs (matches mobile's PostReactionStack
    // — 2 icons max with negative margin overlap). The .rcount-emojis
    // class still anchors the wrapper for CSS theming.
    const stackedSvgs = sortedEmojis.slice(0, 2)
      .map((r, i) => `<img class="rcount-svg" src="${r.svg}" alt="${r.label}" width="15" height="15"${i > 0 ? ' style="margin-left:-4px"' : ''}>`)
      .join('');
    const summaryHtml = sortedEmojis.length === 0 ? ''
      : `<span class="rcount-emojis">${stackedSvgs}</span> ${total}`;
    document.querySelectorAll(`#rsummary-${targetId}`).forEach(el => { el.innerHTML = summaryHtml; });
  }
}

export async function handleReaction(targetId, targetType, emojiKey) {
  if (!_cfg.getCurrentUser()) return toast('Sign in to react', 'error');

  // Optimistic UI update: flip the trigger label/icon immediately so the
  // user sees their reaction land instantly. loadReactions() reconciles
  // with the server result a moment later.
  try {
    const wraps = document.querySelectorAll(`.reaction-wrap[data-target="${targetId}"][data-type="${targetType}"]`);
    const r = REACTIONS.find(x => x.key === emojiKey);
    wraps.forEach(wrap => {
      const trigger = wrap.querySelector('.reaction-trigger');
      if (!trigger || !r) return;
      const icon = trigger.querySelector('.r-icon');
      const label = trigger.querySelector('.r-label-text');
      if (icon)  icon.innerHTML = `<img class="r-emoji-svg" src="${r.svg}" alt="${r.label}" width="18" height="18">`;
      if (label) label.textContent = r.label;
      trigger.classList.add('reacted');
    });
  } catch {}

  // Read existing reaction to decide add vs change vs remove. SELECT is
  // RLS-permitted (true), so this works under any session state.
  const { data: existing, error: lookupErr } = await supabase
    .from('reactions')
    .select('id, emoji')
    .eq('user_id', _cfg.getCurrentUser().id)
    .eq('target_id', targetId)
    .eq('target_type', targetType)
    .maybeSingle();

  if (lookupErr) {
    toast('Reaction failed: ' + lookupErr.message, 'error');
    loadReactions(targetId, targetType);
    return;
  }

  // Route through SECURITY DEFINER RPCs — same path mobile uses. Direct
  // `.insert/.update/.delete` was rejected by RLS whenever auth.uid()
  // was null (stale session / not yet bootstrapped), which made likes
  // silently never land in the database. The RPC validates the actor
  // parameter against profiles and bypasses RLS internally.
  let mutErr = null;
  if (existing && existing.emoji === emojiKey) {
    // Toggle off — remove the reaction.
    const { error } = await supabase.rpc('submit_unreaction', {
      p_actor_id: _cfg.getCurrentUser().id,
      p_target_type: targetType,
      p_target_id: String(targetId),
    });
    mutErr = error;
  } else {
    // Add or change emoji — submit_reaction handles both atomically.
    const { error } = await supabase.rpc('submit_reaction', {
      p_actor_id: _cfg.getCurrentUser().id,
      p_target_type: targetType,
      p_target_id: String(targetId),
      p_emoji: emojiKey,
    });
    mutErr = error;
  }

  if (mutErr) {
    toast('Reaction failed: ' + mutErr.message, 'error');
  } else if (targetType === 'post' && !(existing && existing.emoji === emojiKey)) {
    // Daily-goal: tick "Like & comment N posts". Dedup key is per-post
    // so like + comment on the same post still counts as ONE engagement
    // (mirrors mobile's PostInformation.jsx:249, PostCommentModal:1982).
    // Toggle-off branch skipped — only ADDS count toward the goal.
    try { _cfg.tickGoalUnique('like_comment', `like_comment:${targetId}`); } catch {}
  }
  loadReactions(targetId, targetType);
}


// ─── Comments block ──────────────────────────────────────────────
// ── Comments ──
// Facebook-style truncation. Showing every parent comment expanded made
// long threads (200+ comments on a popular post) unscrollable — the
// reactions row at the bottom of the post effectively never reached
// the viewport. Now we show only the most recent N parents plus a
// "View N previous comments" link that expands the older ones.
const INITIAL_PARENTS_VISIBLE = 2;

export async function loadComments(postId, videoId = null) {
  const containerId = videoId ? 'videoComments' : `comments-${postId}`;
  const section = document.getElementById(containerId);
  if (!section) return;
  section.innerHTML = '<div class="loading" style="padding:1rem">Loading...</div>';
  // Fetch BOTH parents AND replies in a single query to eliminate the N+1
  // pattern where each parent triggered its own reply lookup. We group
  // client-side and pass replies down to renderComment so it doesn't refetch.
  let q = supabase.from('comments')
    .select(`*, profiles(id, username, avatar_url, is_guest)`)
    .order('created_at', { ascending: true });
  if (videoId) q = q.eq('video_id', videoId);
  else q = q.eq('post_id', postId);
  const { data, error } = await q;
  if (error) { section.innerHTML = `<p style="color:var(--text3);font-size:0.85rem">${error.message}</p>`; return; }
  // Split into parents + group replies by parent_id
  const parents = [];
  const repliesByParent = {};
  (data || []).forEach(c => {
    if (c.parent_id) {
      if (!repliesByParent[c.parent_id]) repliesByParent[c.parent_id] = [];
      repliesByParent[c.parent_id].push(c);
    } else {
      parents.push(c);
    }
  });
  section.innerHTML = '';

  // UX fix: comment input lives at the TOP of the section so users don't
  // have to scroll past every comment to reply. Earlier layout appended
  // the input after the parents list, which made replying on long threads
  // genuinely painful — especially on the video player where the comments
  // section can run hundreds of rows. Build the input first, append it,
  // then add the comments below.
  const previewKey = videoId ? `cimgpreview-v-${videoId}` : `cimgpreview-${postId}`;
  const inputWrap = document.createElement('div');
  inputWrap.className = 'comment-input-wrap';
  inputWrap.style.flexDirection = 'column';
  inputWrap.style.gap = '0.5rem';
  // Sticky position so the input stays in view while the user scrolls
  // through long comment threads. `--bg-card` matches the surrounding
  // card so it doesn't appear to float.
  inputWrap.style.position = 'sticky';
  inputWrap.style.top = '0';
  inputWrap.style.zIndex = '5';
  inputWrap.style.background = 'var(--bg-card, #fff)';
  inputWrap.style.paddingBottom = '0.5rem';
  inputWrap.style.borderBottom = '1px solid var(--border, #eee)';
  inputWrap.style.marginBottom = '0.75rem';
  // FB-style single-row input: [avatar][textarea][photo icon][Send]
  // Photo trigger collapsed to an icon-only button inside the input
  // strip (was a separate row with "Add photo" text — pushed the section
  // taller without adding info). Preview reveals below when a file is
  // chosen. 2026-05-17 polish.
  inputWrap.innerHTML = `
    <div class="comment-input-row">
      <div class="avatar sm">${_cfg.getCurrentProfile()?.avatar_url ? `<img src="${_cfg.getCurrentProfile().avatar_url}"/>` : initials(_cfg.getCurrentProfile()?.username || 'G')}</div>
      <textarea class="comment-input" placeholder="Write a comment…" rows="1"></textarea>
      <label class="comment-photo-btn" title="Add photo" aria-label="Add photo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        <input type="file" accept="image/*" class="cimg-input" hidden/>
      </label>
      <button class="btn-send">Send</button>
    </div>
    <div id="${previewKey}" class="comment-input-preview"></div>
  `;
  section.appendChild(inputWrap);

  // Facebook-style truncation. Order is oldest→newest already (matches the
  // query above), so the "tail" of the array is the most recent N parents.
  // Show only those by default; expose a "View N previous comments" link
  // that fills in the rest.
  const visibleParents = parents.length > INITIAL_PARENTS_VISIBLE
    ? parents.slice(parents.length - INITIAL_PARENTS_VISIBLE)
    : parents;
  const hiddenParents = parents.length > INITIAL_PARENTS_VISIBLE
    ? parents.slice(0, parents.length - INITIAL_PARENTS_VISIBLE)
    : [];

  if (hiddenParents.length > 0) {
    const viewMoreBtn = document.createElement('button');
    viewMoreBtn.className = 'comment-view-more';
    viewMoreBtn.type = 'button';
    // True toggle (2026-05-17 polish): first click expands the hidden
    // parents inline; second click removes just those nodes and the
    // button reverts to its "View N previous…" label. Earlier version
    // removed itself on first click so there was no way back without a
    // full reload.
    const expandLabel = `View ${hiddenParents.length} previous comment${hiddenParents.length === 1 ? '' : 's'}`;
    const collapseLabel = `Hide previous comment${hiddenParents.length === 1 ? '' : 's'}`;
    let expanded = false;
    let insertedNodes = [];
    viewMoreBtn.textContent = expandLabel;
    viewMoreBtn.addEventListener('click', async () => {
      if (viewMoreBtn.disabled) return;
      viewMoreBtn.disabled = true;
      if (expanded) {
        // Collapse — drop just the nodes we inserted, leave the rest of
        // the section intact.
        for (const node of insertedNodes) node.remove();
        insertedNodes = [];
        expanded = false;
        viewMoreBtn.textContent = expandLabel;
        viewMoreBtn.classList.remove('expanded');
      } else {
        // Expand — insert hidden parents in oldest-first order BEFORE
        // the first currently-visible comment. Capture the anchor first
        // so the inserts don't drift relative to one another.
        const anchor = viewMoreBtn.nextSibling;
        for (const c of hiddenParents) {
          const el = await renderComment(c, postId, false, null, videoId, repliesByParent);
          section.insertBefore(el, anchor);
          insertedNodes.push(el);
        }
        expanded = true;
        viewMoreBtn.textContent = collapseLabel;
        viewMoreBtn.classList.add('expanded');
      }
      viewMoreBtn.disabled = false;
    });
    section.appendChild(viewMoreBtn);
  }

  for (const c of visibleParents) {
    section.appendChild(await renderComment(c, postId, false, null, videoId, repliesByParent));
  }

  const ta = inputWrap.querySelector('textarea');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(postId, null, ta, previewKey, videoId); }});
  inputWrap.querySelector('.btn-send').addEventListener('click', () => submitComment(postId, null, ta, previewKey, videoId));
  inputWrap.querySelector('.cimg-input').addEventListener('change', (e) => handleCommentImageSelect(e.target, previewKey));

  // Realtime — subscribe to comments INSERT / UPDATE / DELETE for this
  // post or video so the section updates live when someone else
  // (mobile or web) comments. The subscribe is idempotent — calling
  // ensureCommentsRealtime for an already-subscribed container is a
  // no-op, so the loadComments → channel-event → loadComments cycle
  // doesn't tear down and re-create channels (which would open a
  // small window where new events go unheard).
  ensureCommentsRealtime({ postId, videoId, section });
}

// Persistent comment-realtime subscriber. One channel per container,
// kept alive until something removes the listener entry. The earlier
// version recreated the channel on every loadComments() call, which:
//   1. Wasted bandwidth subscribing+unsubscribing
//   2. Opened a ~100ms window where events were lost during the
//      tear-down → resubscribe handoff
// Now: idempotent. Same containerId → reuse the existing channel.
//
// Refresh trigger is debounced (250ms) so a burst of comments doesn't
// fire N round-trips of loadComments for the same data.
let __commentsChannelSeq = 0;
const _commentsChannelByContainer = new Map();   // containerId → { channel, postId, videoId, refreshTimer }

function ensureCommentsRealtime({ postId, videoId, section }) {
  if (!section) return;
  const containerId = section.id;
  const filterCol = videoId ? 'video_id' : 'post_id';
  const filterId = videoId || postId;

  const existing = _commentsChannelByContainer.get(containerId);
  if (existing && existing.postId === postId && existing.videoId === videoId) {
    // Already subscribed for the same target — nothing to do.
    return;
  }
  if (existing) {
    // Container was repurposed for a different post/video. Tear down.
    try { supabase.removeChannel(existing.channel); } catch (_) { /* swallow */ }
    if (existing.refreshTimer) clearTimeout(existing.refreshTimer);
    _commentsChannelByContainer.delete(containerId);
  }

  const state = { postId, videoId, channel: null, refreshTimer: null };
  const scheduleRefresh = () => {
    if (state.refreshTimer) return; // a refresh is already pending
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      // Only refresh if the section is still in the DOM. The original
      // section reference may be stale (innerHTML replacement keeps
      // the same node, but a removal would orphan it).
      if (document.getElementById(containerId)) loadComments(postId, videoId);
    }, 250);
  };

  const channelName = `comments-${filterCol}:${filterId}:${++__commentsChannelSeq}`;
  const channel = supabase
    .channel(channelName)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'comments', filter: `${filterCol}=eq.${filterId}` },
      scheduleRefresh,
    )
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'comments', filter: `${filterCol}=eq.${filterId}` },
      scheduleRefresh,
    )
    .on('postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'comments', filter: `${filterCol}=eq.${filterId}` },
      scheduleRefresh,
    )
    .subscribe();

  state.channel = channel;
  _commentsChannelByContainer.set(containerId, state);
}

export async function renderComment(comment, postId, isReply = false, topLevelId = null, videoId = null, repliesByParent = null) {
  // Auto-detect video comments by inspecting the row
  if (!videoId && comment.video_id) videoId = comment.video_id;
  const div = document.createElement('div');
  div.className = isReply ? 'reply-item' : 'comment-item';
  const profile = comment.profiles || {};
  // display_name preferred; falls back to @handle. Sprint 2 #2.
  const name = profile.display_name || profile.username || 'Unknown';
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}"/>` : initials(name);
  const replyTargetId = isReply ? topLevelId : comment.id;
  const replyToName = isReply ? name : null;

  // Avatar + author both carry .profile-link + data-user-id so the
  // global delegated handler at app.js (~L3691) routes clicks to
  // openProfile(userId). Without these attributes (the prior version
  // lacked them entirely), tapping a commenter's name/avatar did
  // nothing. Pattern mirrors renderPost in feed.js. (2026-05-17 fix)
  const commenterId = comment.user_id || '';
  div.innerHTML = `
    <div class="avatar sm profile-link" data-user-id="${commenterId}" title="View profile">${avatarHTML}</div>
    <div class="comment-body">
      <div class="comment-meta">
        <span class="comment-author profile-link" data-user-id="${commenterId}" title="View profile">${escHTML(name)}${_cfg.renderRoleSeal(profile)}</span>
        <span class="comment-time">${timeAgo(comment.created_at)}</span>
        ${profile.is_guest ? '<span class="post-guest">Guest</span>' : ''}
      </div>
      ${comment.body ? `<div class="comment-bubble">${_cfg.linkify(comment.body)}</div>` : ''}
      ${comment.body ? _cfg.renderLinkPreview(comment.body) : ''}
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
                <img class="r-emoji" src="${r.svg}" alt="${r.label}" width="26" height="26">
                <span class="r-label">${r.label}</span>
              </button>
            `).join('')}
          </div>
        </div>
        <button class="comment-action-btn reply-btn" data-commentid="${replyTargetId}" data-postid="${postId || ''}" data-videoid="${videoId || ''}" data-replyto="${escHTML(replyToName || '')}">Reply</button>
        ${_cfg.getCurrentUser() && _cfg.getCurrentUser().id === comment.user_id ? `<button class="comment-action-btn" onclick="deleteComment('${comment.id}','${postId || ''}','${videoId || ''}')">Delete</button>` : ''}
      </div>
      ${!isReply ? `<div class="replies" id="replies-${comment.id}"></div>` : ''}
    </div>
  `;

  loadReactions(comment.id, 'comment');
  if (!isReply) {
    let replies;
    if (repliesByParent) {
      // Use the pre-grouped replies from loadComments (no extra fetch — N+1 fixed)
      replies = repliesByParent[comment.id] || [];
    } else {
      // Fallback for callers that don't pre-group (e.g. realtime add)
      const { data } = await supabase
        .from('comments')
        .select(`*, profiles(id, username, avatar_url, is_guest)`)
        .eq('parent_id', comment.id)
        .order('created_at', { ascending: true });
      replies = data || [];
    }
    if (replies.length) {
      const container = div.querySelector(`#replies-${comment.id}`);
      // Facebook-style: replies hidden by default behind a "View N replies"
      // toggle. Big threads on web were rendering hundreds of nested
      // reply rows on every parent — visually overwhelming and slow.
      // Click to expand, click again on the rendered toggle (now "Hide
      // replies") to collapse. New replies you post yourself auto-expand
      // on the next loadComments cycle (realtime triggers a refresh).
      const viewBtn = document.createElement('button');
      viewBtn.className = 'comment-view-replies';
      viewBtn.type = 'button';
      viewBtn.textContent = `View ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`;
      let expanded = false;
      const renderedReplies = [];
      viewBtn.addEventListener('click', async () => {
        if (expanded) {
          // Collapse — remove the rendered reply nodes.
          renderedReplies.forEach((node) => node.remove());
          renderedReplies.length = 0;
          viewBtn.textContent = `View ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`;
          expanded = false;
          return;
        }
        viewBtn.disabled = true;
        for (const r of replies) {
          const el = await renderComment(r, postId, true, comment.id, videoId, repliesByParent);
          container.appendChild(el);
          renderedReplies.push(el);
        }
        viewBtn.disabled = false;
        viewBtn.textContent = 'Hide replies';
        expanded = true;
      });
      container.appendChild(viewBtn);
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

export async function submitComment(postId, parentId, textarea, previewId, videoId = null) {
  const body = textarea.value.trim();
  const file = previewId ? pendingCommentImages[previewId] : null;
  if (!body && !file) return;
  if (!_cfg.getCurrentUser()) return toast('Sign in to comment', 'error');
  let imageUrl = null;
  if (file) {
    textarea.disabled = true;
    imageUrl = await _cfg.uploadImage(file);
    textarea.disabled = false;
    if (!imageUrl) return;
  }
  const insertRow = {
    user_id: _cfg.getCurrentUser().id,
    parent_id: parentId || null,
    body: body || '',
    image_url: imageUrl,
  };
  if (videoId) insertRow.video_id = videoId;
  else insertRow.post_id = postId;
  const { error } = await supabase.from('comments').insert(insertRow);
  if (error) { toast(error.message, 'error'); return; }
  // Daily-goal: tick "Like & comment N posts". Same dedup key as the
  // reaction path so commenting + liking the same post counts ONCE.
  // Skipped for video comments (videoId set) since the daily quest is
  // post-specific per the spec.
  if (!videoId) {
    try { _cfg.tickGoalUnique('like_comment', `like_comment:${postId}`); } catch {}
  }
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
  const ok = await _cfg.confirmDialog({
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
  // Same inline-icon layout as the top input + a cancel ✕ so users can
  // back out of the reply mode (previously the wrap could only be
  // dismissed by submitting or scrolling away). Escape key also closes.
  wrap.innerHTML = `
    <div class="comment-input-row">
      <div class="avatar sm">${_cfg.getCurrentProfile()?.avatar_url ? `<img src="${_cfg.getCurrentProfile().avatar_url}"/>` : initials(_cfg.getCurrentProfile()?.username || 'G')}</div>
      <textarea class="comment-input" placeholder="${placeholder}" rows="1"></textarea>
      <label class="comment-photo-btn" title="Add photo" aria-label="Add photo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        <input type="file" accept="image/*" class="rimg-input" hidden/>
      </label>
      <button class="btn-send">Reply</button>
      <button class="reply-cancel-btn" type="button" title="Cancel reply" aria-label="Cancel reply">✕</button>
    </div>
    <div id="${previewId}" class="comment-input-preview"></div>
  `;
  const ta = wrap.querySelector('textarea');
  if (replyToName) ta.value = `@${replyToName} `;
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(postId, commentId, ta, previewId, videoId); }
    if (e.key === 'Escape') { e.preventDefault(); wrap.remove(); }
  });
  wrap.querySelector('.btn-send').addEventListener('click', () => submitComment(postId, commentId, ta, previewId, videoId));
  wrap.querySelector('.rimg-input').addEventListener('change', (e) => handleCommentImageSelect(e.target, previewId));
  wrap.querySelector('.reply-cancel-btn').addEventListener('click', () => wrap.remove());
  container.appendChild(wrap);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}


// ─── Global delegated click handlers ──────────────────────────────────────────────
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
    // Scope the lookup to the card the user actually clicked. The same
    // post may be rendered in multiple places at once (e.g., it's the
    // user's most recent post so it shows on their profile AND in the
    // hidden-but-still-in-DOM For You feed). document.getElementById
    // returns the FIRST match document-wide, so on a profile click the
    // toggle was firing on the feed's hidden section while the visible
    // profile section never opened — classic 2026-05-16 symptom: "1st
    // post card on profile doesn't open comments, the others do."
    // querySelector with an id selector IS scoped to the subtree.
    const card = ct.closest('.post-card');
    const section = card?.querySelector(`#comments-${CSS.escape(postId)}`)
                 || document.getElementById(`comments-${postId}`);
    // Defensive: if the section element is missing (post recently
    // re-rendered, dataset typo, etc.), bail loudly instead of
    // throwing on `section.style` and silently dropping the click.
    if (!section) {
      console.warn('[comment-toggle] comments section not found for post', postId);
      return;
    }
    if (section.style.display === 'none' || section.style.display === '') {
      section.style.display = 'block';
      // Scroll the comment input into view after the layout settles.
      // Without this, the section opens BELOW the post and the user
      // doesn't see the input — looks like "nothing happened".
      loadComments(postId).then(() => {
        const inputEl = section.querySelector('.comment-input');
        if (inputEl && typeof inputEl.scrollIntoView === 'function') {
          inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }).catch((err) => {
        console.error('[comment-toggle] loadComments failed', err);
      });
    } else {
      section.style.display = 'none';
    }
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


// ─── Reactor list modal + tap handlers ──────────────────────────────────────────────
// ── Reaction summary tap → modal listing who reacted ──────────────────────
document.addEventListener('click', (e) => {
  const summary = e.target.closest('.rcount');
  if (!summary || !summary.textContent.trim()) return;   // empty summary = no reactions yet, ignore
  if (e.target.closest('.reaction-trigger')) return;     // safety: don't hijack the trigger button
  e.stopPropagation();
  const targetId = summary.dataset.target;
  const targetType = summary.dataset.type || 'post';
  if (targetId) openReactorListModal(targetId, targetType);
});

// ── "N comments" tap → toggle the comment section open (same as the icon button) ──
document.addEventListener('click', (e) => {
  const counter = e.target.closest('.ccount');
  if (!counter || !counter.textContent.trim()) return;   // empty = no comments yet, ignore
  e.stopPropagation();
  const postId = counter.dataset.postid;
  if (!postId) return;
  const section = document.getElementById(`comments-${postId}`);
  if (!section) return;
  if (section.style.display === 'none' || section.style.display === '') {
    section.style.display = 'block';
    loadComments(postId);
  } else {
    section.style.display = 'none';
  }
});

// Map a raw `reactions.emoji` value (which the DB might store as either
// the key 'heart'/'laugh'/etc. or the literal '❤️'/'😂') to the actual
// emoji glyph for display. Falls back to the raw value so legacy or
// unknown entries still render something. (2026-05-17)
function _reactionEmoji(raw) {
  if (!raw) return '';
  const r = REACTIONS.find(x => x.key === raw || x.emoji === raw);
  return r ? r.emoji : raw;
}

// ── Reactor list modal ────────────────────────────────────────────────────
export async function openReactorListModal(targetId, targetType = 'post') {
  _cfg.closeAllModals('.modal-backdrop[data-modal="reactor-list"]');

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'reactor-list';
  // .reactor-list-modal scopes the compact FB-style overrides (defined
  // in css/style.css). Keeps the follow-list-modal usage elsewhere
  // untouched while letting this surface be denser.
  modal.innerHTML = `
    <div class="modal-card follow-list-modal reactor-list-modal" role="dialog" aria-labelledby="reactor-list-title">
      <div class="follow-list-header">
        <h2 id="reactor-list-title">Reactions</h2>
      </div>
      <div class="reactor-tabs" id="reactorTabs"></div>
      <div class="follow-list-body" id="reactorListBody">
        <div class="loading">Loading…</div>
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

  // Fetch reactions + reactor profiles
  const { data: rxs, error } = await supabase
    .from('reactions')
    .select('emoji, user_id, created_at')
    .eq('target_id', targetId)
    .eq('target_type', targetType)
    .order('created_at', { ascending: false })
    .limit(500);
  const body = modal.querySelector('#reactorListBody');
  if (error) {
    body.innerHTML = `<div class="dm-error">Couldn't load: ${escHTML(error.message)}</div>`;
    return;
  }
  if (!rxs || !rxs.length) {
    body.innerHTML = `<div class="follow-list-empty"><div class="follow-list-empty-icon">🤍</div><div>No reactions yet.</div></div>`;
    return;
  }

  const userIds = [...new Set(rxs.map(r => r.user_id))];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, is_guest')
    .in('id', userIds);
  const profileMap = new Map((profiles || []).map(p => [p.id, p]));

  // Build emoji tabs (All, then per-emoji with counts). The DB column
  // may store either the key ('heart') or the glyph ('❤️') depending on
  // when the row was written; _reactionEmoji() normalizes both to the
  // displayable glyph. We keep the raw value as the filter key (data-
  // emoji-filter) so renderRows can compare against rxs[].emoji.
  const counts = {};
  rxs.forEach(r => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
  const sortedEmojis = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const tabsEl = modal.querySelector('#reactorTabs');
  tabsEl.innerHTML = `
    <button class="reactor-tab active" data-emoji-filter="">
      <span class="reactor-tab-label">All</span>
      <span class="reactor-tab-count">${rxs.length}</span>
    </button>
    ${sortedEmojis.map(([raw, c]) => {
      const glyph = _reactionEmoji(raw);
      return `<button class="reactor-tab" data-emoji-filter="${escHTML(raw)}">
        <span class="reactor-tab-glyph">${escHTML(glyph)}</span>
        <span class="reactor-tab-count">${c}</span>
      </button>`;
    }).join('')}
  `;

  function renderRows(filterEmoji) {
    const rows = filterEmoji ? rxs.filter(r => r.emoji === filterEmoji) : rxs;
    body.innerHTML = rows.map(r => {
      const p = profileMap.get(r.user_id) || { id: r.user_id, username: 'Unknown', avatar_url: null };
      const safeName = escHTML(p.username || '');
      const safeAvatar = p.avatar_url ? escHTML(p.avatar_url) : '';
      const glyph = _reactionEmoji(r.emoji);
      return `
        <div class="follow-list-row">
          <button class="follow-list-avatar" data-uid="${p.id}">
            ${safeAvatar ? `<img src="${safeAvatar}"/>` : initials(p.username)}
          </button>
          <div class="follow-list-info">
            <button class="follow-list-name" data-uid="${p.id}">@${safeName}</button>
          </div>
          <span class="reactor-emoji" title="${escHTML(r.emoji)}">${escHTML(glyph)}</span>
        </div>
      `;
    }).join('');
    body.querySelectorAll('[data-uid]').forEach(el => {
      el.onclick = () => { close(); _cfg.openProfile(el.dataset.uid); };
    });
  }

  renderRows('');
  tabsEl.querySelectorAll('.reactor-tab').forEach(t => {
    t.onclick = () => {
      tabsEl.querySelectorAll('.reactor-tab').forEach(x => x.classList.toggle('active', x === t));
      renderRows(t.dataset.emojiFilter);
    };
  });
}
