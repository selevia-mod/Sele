// ════════════════════════════════════════════════════════════════════════
// Selebox scheduled posts — extracted from js/app.js as Stage 2 of the
// refactor roadmap (2026-05-15). This module owns:
//   • The "X scheduled" pill next to the composer's Post button
//   • The modal listing all of the user's future-scheduled, still-hidden
//     posts, with Publish-now and Cancel actions on each row
//   • All listeners: pill click, modal close button, backdrop click,
//     Escape keydown, and the delegated row-action click handler
//
// CAREFUL: pure code movement, not a rewrite. Same lines of code,
// different file. The discipline rule from Stage 1 still applies.
//
// Stage 1 lesson: don't import from app.js — that creates a circular ES
// module dependency and can break realtime channel setup at module load.
// Instead, app.js injects what we need (currentUser getter) via
// initScheduledPosts(config). We import ONLY from supabase.js (leaf).
//
// See REFACTOR_ROADMAP.md Stage 2 and REFACTOR_STAGE1_PLAN.md for the
// pattern rationale.
// ════════════════════════════════════════════════════════════════════════

import { supabase, escHTML, toast } from './supabase.js';

// ─── Config-injection dependency surface ──────────────────────────────────
// Only one dependency this time: a getter for currentUser. App.js calls
// initScheduledPosts({getCurrentUser: () => currentUser}) on sign-in, and
// the functions below read live state through _cfg.getCurrentUser().
let _cfg = {
  getCurrentUser: () => null,
};

// ─── Public API ──────────────────────────────────────────────────────────
// initScheduledPosts is called from app.js's onSignedIn. It stores the
// config + does an initial badge refresh so returning users see their
// scheduled count on load.
//
// refreshScheduledPostsBadge is also exported so app.js's post-submit
// handler can call it after queueing a new scheduled post.
export function initScheduledPosts(config) {
  if (config) _cfg = config;
  // Fire-and-forget — same call site behavior as the original line 385.
  refreshScheduledPostsBadge();
}

// ─── Badge: count of my future-scheduled, still-hidden posts ─────────────
// Pill is shown only when count > 0 to avoid clutter for casual users
// who never schedule. Count refreshes after every schedule (called from
// app.js's submit handler) and after every action inside the modal.
export async function refreshScheduledPostsBadge() {
  const btn = document.getElementById('btnScheduledPosts');
  const label = document.getElementById('scheduledPostsBadgeLabel');
  const u = _cfg.getCurrentUser();
  if (!btn || !u?.id) return;
  const { count, error } = await supabase
    .from('posts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', u.id)
    .eq('is_hidden', true)
    .gt('scheduled_publish_at', new Date().toISOString());
  if (error) { console.warn('[scheduled-posts] badge count failed:', error.message); return; }
  if ((count || 0) > 0) {
    btn.style.display = 'inline-flex';
    if (label) label.textContent = `${count} scheduled`;
  } else {
    btn.style.display = 'none';
  }
}

// ─── Modal: list + row actions ───────────────────────────────────────────
export async function openScheduledPostsModal() {
  const backdrop = document.getElementById('scheduledPostsBackdrop');
  const listEl   = document.getElementById('scheduledPostsList');
  if (!backdrop || !listEl) return;
  const u = _cfg.getCurrentUser();
  if (!u?.id) { toast('Please sign in first', 'error'); return; }

  listEl.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--text2,#aaa)">Loading…</div>`;
  backdrop.style.display = 'grid';

  const { data, error } = await supabase
    .from('posts')
    .select('id, body, image_url, scheduled_publish_at, video_id, videos(id, title, thumbnail_url)')
    .eq('user_id', u.id)
    .eq('is_hidden', true)
    .gt('scheduled_publish_at', new Date().toISOString())
    .order('scheduled_publish_at', { ascending: true })
    .limit(100);

  if (error) {
    listEl.innerHTML = `<div style="text-align:center;padding:2rem;color:#e74c3c">${escHTML(error.message)}</div>`;
    return;
  }
  if (!data?.length) {
    listEl.innerHTML = `<div style="text-align:center;padding:2.5rem 1rem;color:var(--text2,#aaa);font-size:14px">No scheduled posts. Use the Schedule button on the composer to queue one.</div>`;
    return;
  }

  // Per-row card. `data-post-id` carries the row id so the delegated
  // click handler below knows which post to act on without rebinding
  // per-row listeners.
  listEl.innerHTML = data.map(p => {
    const when = new Date(p.scheduled_publish_at);
    const whenStr = when.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
    const bodySnip = p.body ? escHTML(p.body.length > 140 ? p.body.slice(0, 140) + '…' : p.body) : '<em style="color:var(--text2,#aaa)">(no caption)</em>';
    // Media preview — image OR attached video thumbnail.
    let media = '';
    if (p.image_url) {
      media = `<img src="${escHTML(p.image_url)}" alt="" style="width:64px;height:64px;border-radius:8px;object-fit:cover;flex-shrink:0"/>`;
    } else if (p.videos?.thumbnail_url) {
      media = `<div style="position:relative;flex-shrink:0">
        <img src="${escHTML(p.videos.thumbnail_url)}" alt="" style="width:64px;height:64px;border-radius:8px;object-fit:cover"/>
        <svg viewBox="0 0 24 24" width="20" height="20" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);fill:white;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5))"><polygon points="8 5 19 12 8 19 8 5"/></svg>
      </div>`;
    }
    return `
      <div style="display:flex;gap:0.85rem;padding:0.85rem;border:1px solid var(--admin-border,#2a2a3a);border-radius:10px;margin-bottom:0.6rem;align-items:flex-start">
        ${media || ''}
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;color:var(--accent,#7975D4);font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">${escHTML(whenStr)}</div>
          <div style="font-size:14px;color:var(--text,#fff);line-height:1.4;margin-bottom:8px;overflow-wrap:break-word">${bodySnip}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button type="button" data-sp-act="publish-now" data-post-id="${p.id}"
                    style="background:var(--accent,#7975D4);color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:600">Publish now</button>
            <button type="button" data-sp-act="cancel" data-post-id="${p.id}"
                    style="background:transparent;color:#e74c3c;border:1px solid rgba(231,76,60,0.4);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:600">Cancel</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

export function closeScheduledPostsModal() {
  const bd = document.getElementById('scheduledPostsBackdrop');
  if (bd) bd.style.display = 'none';
}

// ─── Event wiring (runs ONCE at module load) ─────────────────────────────
// These attach listeners to elements in the static DOM (composer area +
// modal). They run when this module is first imported by app.js, which
// happens after the body has parsed — same timing as the original code
// at line 2403+ in app.js. Per the Stage 1 lesson, we deliberately keep
// listener attachment OUTSIDE initScheduledPosts() so that signing
// in/out doesn't accumulate duplicate handlers across sessions.
document.getElementById('btnScheduledPosts')?.addEventListener('click', openScheduledPostsModal);
document.getElementById('scheduledPostsClose')?.addEventListener('click', closeScheduledPostsModal);
document.getElementById('scheduledPostsBackdrop')?.addEventListener('click', (e) => {
  if (e.target.id === 'scheduledPostsBackdrop') closeScheduledPostsModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const bd = document.getElementById('scheduledPostsBackdrop');
  if (bd && bd.style.display !== 'none') closeScheduledPostsModal();
});

// Delegated row actions — Publish now + Cancel. Both update the row
// server-side, then refresh the modal + the composer badge.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('#scheduledPostsList button[data-sp-act]');
  if (!btn) return;
  const act = btn.dataset.spAct;
  const id  = btn.dataset.postId;
  if (!act || !id) return;

  if (act === 'cancel' && !confirm('Cancel this scheduled post? It will be deleted permanently.')) return;

  btn.disabled = true;
  try {
    const u = _cfg.getCurrentUser();
    if (!u?.id) { toast('Please sign in first', 'error'); return; }

    if (act === 'publish-now') {
      // Flip is_hidden=false + clear schedule. The AFTER UPDATE
      // trigger doesn't fanout (that's gated to AFTER INSERT), but
      // the post becomes visible in the feed immediately.
      const { error } = await supabase
        .from('posts')
        .update({ is_hidden: false, scheduled_publish_at: null })
        .eq('id', id)
        .eq('user_id', u.id);              // belt + suspenders — RLS already restricts
      if (error) { toast(`Publish failed: ${error.message}`, 'error'); return; }
      toast('Published.', 'success');
    } else if (act === 'cancel') {
      const { error } = await supabase
        .from('posts')
        .delete()
        .eq('id', id)
        .eq('user_id', u.id);
      if (error) { toast(`Cancel failed: ${error.message}`, 'error'); return; }
      toast('Scheduled post deleted.', 'success');
    }
    // Refresh the modal contents + the composer badge in parallel.
    await Promise.all([openScheduledPostsModal(), refreshScheduledPostsBadge()]);
  } catch (err) {
    toast(`${act} threw: ${err?.message || err}`, 'error');
  } finally {
    btn.disabled = false;
  }
});
