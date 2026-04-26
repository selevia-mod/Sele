// ════════════════════════════════════════════════════════════════════════════
// Selebox — Admin / Moderation page
//   • Role-gated (only moderator/admin can use)
//   • Inbox: pending reports → review → action
//   • Activity: append-only audit log
// ════════════════════════════════════════════════════════════════════════════

import { supabase, timeAgo, initials } from './supabase.js';

// ─── tiny escapeHTML helper ──────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));

// ─── auth + role check ───────────────────────────────────────────────────────
let currentMod = null;

async function gateAccess() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) {
    location.href = '/?redirect=admin';
    return false;
  }
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, role, is_banned')
    .eq('id', session.user.id)
    .single();

  if (error || !profile || !['moderator', 'admin'].includes(profile.role) || profile.is_banned) {
    document.getElementById('adminLoading').style.display = 'none';
    document.getElementById('adminDenied').style.display = 'flex';
    return false;
  }
  currentMod = profile;
  document.getElementById('adminLoading').style.display = 'none';
  document.getElementById('adminShell').style.display  = 'block';
  document.getElementById('adminRoleBadge').textContent = profile.role === 'admin' ? 'Admin' : 'Moderator';
  document.getElementById('adminUserName').textContent  = profile.username || 'Mod';
  return true;
}

// ─── tab switching ───────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.admin-tab-content').forEach(s => {
    s.style.display = s.dataset.tabContent === name ? 'block' : 'none';
  });
  if (name === 'activity') loadActivity();
  if (name === 'inbox')    loadInbox();
}

document.querySelectorAll('.admin-tab').forEach(t => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

// ─── INBOX: list pending reports ─────────────────────────────────────────────

const REASON_LABELS = {
  spam: 'Spam',
  harassment: 'Harassment',
  hate: 'Hate speech',
  nsfw: 'NSFW',
  self_harm: 'Self-harm',
  other: 'Other',
};

async function loadInbox() {
  const filter = document.getElementById('inboxFilter').value;
  const listEl = document.getElementById('inboxList');
  const subEl  = document.getElementById('inboxSubtitle');
  listEl.innerHTML = '<div class="admin-empty">Loading…</div>';

  let q = supabase
    .from('post_reports')
    .select('id, reason, details, status, created_at, reporter_id, post_id')
    .order('created_at', { ascending: true })
    .limit(100);

  if (filter !== 'all') q = q.eq('status', filter);

  const { data: reports, error } = await q;
  if (error) {
    listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`;
    return;
  }
  if (!reports.length) {
    listEl.innerHTML = `<div class="admin-empty">No ${filter === 'all' ? '' : filter + ' '}reports.</div>`;
    subEl.textContent = '0 reports';
    document.getElementById('inboxCount').textContent = '0';
    return;
  }

  // Hydrate with post + reporter context
  const postIds     = [...new Set(reports.map(r => r.post_id).filter(Boolean))];
  const reporterIds = [...new Set(reports.map(r => r.reporter_id).filter(Boolean))];

  const [{ data: posts }, { data: reporters }] = await Promise.all([
    postIds.length
      ? supabase.from('posts').select('id, body, image_url, user_id, created_at, is_hidden, profiles!user_id(id, username, avatar_url, is_banned)').in('id', postIds)
      : Promise.resolve({ data: [] }),
    reporterIds.length
      ? supabase.from('profiles').select('id, username, avatar_url').in('id', reporterIds)
      : Promise.resolve({ data: [] }),
  ]);
  const postMap     = Object.fromEntries((posts || []).map(p => [p.id, p]));
  const reporterMap = Object.fromEntries((reporters || []).map(r => [r.id, r]));

  // Group reports by post (multiple reports on the same post = stronger signal)
  const groupedByPost = {};
  for (const r of reports) {
    if (!groupedByPost[r.post_id]) groupedByPost[r.post_id] = [];
    groupedByPost[r.post_id].push(r);
  }

  document.getElementById('inboxCount').textContent = filter === 'pending' ? reports.length : '';
  subEl.textContent = `${reports.length} ${filter === 'all' ? 'total' : filter} · across ${Object.keys(groupedByPost).length} posts`;

  listEl.innerHTML = '';
  for (const postId of Object.keys(groupedByPost)) {
    const reportGroup = groupedByPost[postId];
    const post = postMap[postId];
    const author = post?.profiles;
    const headline = reportGroup[0]; // primary report
    const reporter = reporterMap[headline.reporter_id];

    const card = document.createElement('div');
    card.className = 'report-card';
    card.dataset.postId = postId;
    if (post?.is_hidden) card.classList.add('report-card-hidden');

    card.innerHTML = `
      <div class="report-card-head">
        <div class="report-card-meta">
          <span class="report-reason-badge">${esc(REASON_LABELS[headline.reason] || headline.reason)}</span>
          ${reportGroup.length > 1 ? `<span class="report-count-badge">${reportGroup.length} reports</span>` : ''}
          ${post?.is_hidden ? `<span class="report-hidden-badge">Hidden</span>` : ''}
          <span class="report-time">${timeAgo(headline.created_at)}</span>
        </div>
      </div>
      <div class="report-card-body">
        <div class="report-author">
          <div class="report-avatar">${author?.avatar_url ? `<img src="${esc(author.avatar_url)}" alt=""/>` : esc(initials(author?.username))}</div>
          <div>
            <div class="report-author-name">${esc(author?.username || 'Unknown')}${author?.is_banned ? ' <span class="report-banned-tag">Banned</span>' : ''}</div>
            <div class="report-author-time">Posted ${timeAgo(post?.created_at)}</div>
          </div>
        </div>
        <div class="report-post-body">${esc(post?.body || '').slice(0, 280) || '<i>(no text)</i>'}</div>
        ${post?.image_url ? `<div class="report-post-image"><img src="${esc(post.image_url)}" loading="lazy"/></div>` : ''}
      </div>
      <div class="report-card-footer">
        <div class="report-reporter">Reported by ${esc(reporter?.username || 'Unknown')}${headline.details ? ` · "<i>${esc(headline.details).slice(0, 120)}</i>"` : ''}</div>
        <div class="report-actions">
          <button class="report-btn" data-action="dismiss">Dismiss</button>
          <button class="report-btn" data-action="warn">Warn</button>
          <button class="report-btn ${post?.is_hidden ? 'report-btn-active' : ''}" data-action="${post?.is_hidden ? 'unhide' : 'hide'}">${post?.is_hidden ? 'Unhide' : 'Hide post'}</button>
          <button class="report-btn report-btn-danger" data-action="suspend">Suspend</button>
          <button class="report-btn report-btn-danger" data-action="ban">Ban</button>
        </div>
      </div>
    `;

    card.querySelectorAll('[data-action]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        handleAction(b.dataset.action, { post, author, reportGroup });
      });
    });

    listEl.appendChild(card);
  }
}

document.getElementById('inboxFilter').addEventListener('change', loadInbox);

// ─── ACTIONS: dismiss / warn / hide / suspend / ban ──────────────────────────

async function handleAction(action, ctx) {
  const { post, author, reportGroup } = ctx;
  if (!post || !author) return alert('Missing post/author context');

  // Most actions need a reason + optional note
  const reasonAndNote = await openReasonModal(action, author);
  if (!reasonAndNote) return; // cancelled

  const { reason, note, suspendDays } = reasonAndNote;

  try {
    if (action === 'dismiss') {
      // Mark all reports on this post as dismissed
      await supabase.from('post_reports').update({
        status: 'dismissed',
        reviewed_by: currentMod.id,
        reviewed_at: new Date().toISOString(),
      }).in('id', reportGroup.map(r => r.id));

      await logAction({ action: 'dismiss_report', target_user_id: author.id, target_post_id: post.id, target_report_id: reportGroup[0].id, reason, note });
      toast('Report dismissed');
    }

    else if (action === 'warn') {
      // Send a notification to the user (uses existing notifications table)
      await supabase.from('notifications').insert({
        user_id: author.id,
        actor_id: currentMod.id,
        type: 'mod_warning',
        post_id: post.id,
        body: `Your post was reviewed by moderators. Reason: ${REASON_LABELS[reason] || reason}.${note ? ' Note: ' + note : ''} Please review the community guidelines.`,
      }).then(() => {}, () => {}); // best effort; ignore if notifications schema differs
      await markReportsResolved(reportGroup, post.id);
      await logAction({ action: 'warn', target_user_id: author.id, target_post_id: post.id, target_report_id: reportGroup[0].id, reason, note });
      toast(`${author.username || 'User'} warned`);
    }

    else if (action === 'hide') {
      await supabase.from('posts').update({
        is_hidden: true, hidden_by: currentMod.id, hidden_at: new Date().toISOString(),
        hidden_reason: reason,
      }).eq('id', post.id);
      await markReportsResolved(reportGroup, post.id);
      await logAction({ action: 'hide_post', target_user_id: author.id, target_post_id: post.id, target_report_id: reportGroup[0].id, reason, note });
      toast('Post hidden');
    }

    else if (action === 'unhide') {
      await supabase.from('posts').update({
        is_hidden: false, hidden_by: null, hidden_at: null, hidden_reason: null,
      }).eq('id', post.id);
      await logAction({ action: 'unhide_post', target_user_id: author.id, target_post_id: post.id, reason, note });
      toast('Post unhidden');
    }

    else if (action === 'suspend') {
      const days = suspendDays || 7;
      const until = new Date(); until.setDate(until.getDate() + days);
      await supabase.from('profiles').update({
        suspended_until: until.toISOString(),
      }).eq('id', author.id);
      await markReportsResolved(reportGroup, post.id);
      await logAction({ action: 'suspend', target_user_id: author.id, target_post_id: post.id, target_report_id: reportGroup[0].id, reason, note, metadata: { days } });
      toast(`${author.username || 'User'} suspended for ${days} days`);
    }

    else if (action === 'ban') {
      const ok = confirm(`Permanently ban ${author.username || 'this user'}?\n\nThis hides all their content globally and blocks sign-in. Reversible by another admin.`);
      if (!ok) return;
      await supabase.from('profiles').update({
        is_banned: true, ban_reason: reason, banned_at: new Date().toISOString(), banned_by: currentMod.id,
      }).eq('id', author.id);
      await markReportsResolved(reportGroup, post.id);
      await logAction({ action: 'ban', target_user_id: author.id, target_post_id: post.id, target_report_id: reportGroup[0].id, reason, note });
      toast(`${author.username || 'User'} banned`);
    }

    loadInbox();
  } catch (e) {
    alert('Action failed: ' + (e.message || e));
  }
}

async function markReportsResolved(reportGroup, postId) {
  await supabase.from('post_reports').update({
    status: 'resolved',
    reviewed_by: currentMod.id,
    reviewed_at: new Date().toISOString(),
  }).in('id', reportGroup.map(r => r.id));
}

async function logAction({ action, target_user_id, target_post_id, target_report_id, reason, note, metadata }) {
  await supabase.from('admin_actions').insert({
    admin_id: currentMod.id,
    target_user_id, target_post_id, target_report_id,
    action, reason: reason || null, note: note || null, metadata: metadata || null,
  });
}

// ─── REASON MODAL ────────────────────────────────────────────────────────────

const ACTION_REASONS = {
  dismiss: ['no_violation', 'reporter_error', 'context_ok', 'other'],
  warn:    ['spam', 'harassment', 'misleading', 'other'],
  hide:    ['spam', 'harassment', 'hate', 'nsfw', 'self_harm', 'other'],
  unhide:  ['no_violation', 'context_ok', 'mistake', 'other'],
  suspend: ['repeated', 'harassment', 'hate', 'nsfw', 'self_harm', 'other'],
  ban:     ['severe_harassment', 'hate', 'nsfw', 'illegal', 'spam_account', 'evading_ban', 'other'],
};

const REASON_TEXT = {
  no_violation: 'No violation found',
  reporter_error: 'Reporter error / spam',
  context_ok: 'Context clarifies it',
  mistake: 'Previously hidden by mistake',
  spam: 'Spam',
  harassment: 'Harassment',
  misleading: 'Misleading',
  hate: 'Hate speech',
  nsfw: 'NSFW / Adult content',
  self_harm: 'Self-harm',
  repeated: 'Repeated violations',
  severe_harassment: 'Severe harassment',
  illegal: 'Illegal content',
  spam_account: 'Spam account',
  evading_ban: 'Evading prior ban',
  other: 'Other',
};

const ACTION_TITLES = {
  dismiss: 'Dismiss reports',
  warn:    'Send warning',
  hide:    'Hide post',
  unhide:  'Unhide post',
  suspend: 'Suspend user',
  ban:     'Ban user',
};

function openReasonModal(action, author) {
  return new Promise((resolve) => {
    const root = document.getElementById('adminModalRoot');
    const reasons = ACTION_REASONS[action] || ['other'];

    root.innerHTML = `
      <div class="modal-backdrop" data-modal="reason">
        <div class="modal-card admin-reason-modal" role="dialog">
          <h2>${esc(ACTION_TITLES[action])}</h2>
          <p class="modal-sub">${action === 'ban' || action === 'suspend' ? esc(`Affecting ${author.username || 'this user'}`) : 'Pick a reason for the audit log.'}</p>
          ${action === 'suspend' ? `
            <div class="admin-suspend-days">
              <label class="admin-suspend-day"><input type="radio" name="days" value="1"/><span>1 day</span></label>
              <label class="admin-suspend-day"><input type="radio" name="days" value="7" checked/><span>7 days</span></label>
              <label class="admin-suspend-day"><input type="radio" name="days" value="30"/><span>30 days</span></label>
            </div>
          ` : ''}
          <div class="admin-reasons">
            ${reasons.map((r, i) => `
              <label class="admin-reason ${i === 0 ? 'checked' : ''}">
                <input type="radio" name="reason" value="${r}" ${i === 0 ? 'checked' : ''}/>
                <span>${esc(REASON_TEXT[r] || r)}</span>
              </label>
            `).join('')}
          </div>
          <textarea class="admin-note" placeholder="Optional internal note (visible to mods only)" maxlength="500"></textarea>
          <div class="modal-actions">
            <button class="btn-ghost" data-action="cancel">Cancel</button>
            <button class="btn-primary" data-action="confirm">${esc(ACTION_TITLES[action])}</button>
          </div>
        </div>
      </div>
    `;

    const modal = root.querySelector('.modal-backdrop');
    const close = (val) => { root.innerHTML = ''; resolve(val); };

    modal.querySelectorAll('input[name="reason"]').forEach(r => {
      r.addEventListener('change', () => {
        modal.querySelectorAll('.admin-reason').forEach(rr => rr.classList.toggle('checked', rr.querySelector('input').checked));
      });
    });

    modal.querySelector('[data-action="cancel"]').onclick = () => close(null);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(null); });

    modal.querySelector('[data-action="confirm"]').onclick = () => {
      const reason = modal.querySelector('input[name="reason"]:checked')?.value;
      const note   = modal.querySelector('.admin-note').value.trim();
      const days   = modal.querySelector('input[name="days"]:checked')?.value;
      close({ reason, note, suspendDays: days ? parseInt(days, 10) : null });
    };
  });
}

// ─── ACTIVITY LOG ────────────────────────────────────────────────────────────

const ACTION_LABEL = {
  dismiss_report: 'Dismissed report',
  warn:           'Warned user',
  hide_post:      'Hid post',
  unhide_post:    'Unhid post',
  suspend:        'Suspended user',
  unsuspend:      'Unsuspended user',
  ban:            'Banned user',
  unban:          'Unbanned user',
  grant_role:     'Granted role',
  revoke_role:    'Revoked role',
};

async function loadActivity() {
  const listEl = document.getElementById('activityList');
  listEl.innerHTML = '<div class="admin-empty">Loading…</div>';

  const { data: actions, error } = await supabase
    .from('admin_actions')
    .select('id, action, reason, note, created_at, admin_id, target_user_id, target_post_id, metadata')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) { listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`; return; }
  if (!actions.length) { listEl.innerHTML = '<div class="admin-empty">No activity yet.</div>'; return; }

  // Hydrate admin + target user names
  const userIds = [...new Set([...actions.map(a => a.admin_id), ...actions.map(a => a.target_user_id)].filter(Boolean))];
  const { data: users } = userIds.length
    ? await supabase.from('profiles').select('id, username').in('id', userIds)
    : { data: [] };
  const uMap = Object.fromEntries((users || []).map(u => [u.id, u]));

  listEl.innerHTML = '';
  for (const a of actions) {
    const row = document.createElement('div');
    row.className = 'activity-row';
    row.innerHTML = `
      <div class="activity-head">
        <span class="activity-action">${esc(ACTION_LABEL[a.action] || a.action)}</span>
        <span class="activity-time">${timeAgo(a.created_at)}</span>
      </div>
      <div class="activity-meta">
        <span><b>${esc(uMap[a.admin_id]?.username || 'Unknown')}</b> ${a.target_user_id ? `→ ${esc(uMap[a.target_user_id]?.username || '?')}` : ''}</span>
        ${a.reason ? `<span class="activity-reason">${esc(REASON_TEXT[a.reason] || a.reason)}</span>` : ''}
      </div>
      ${a.note ? `<div class="activity-note">${esc(a.note)}</div>` : ''}
    `;
    listEl.appendChild(row);
  }
}

// ─── tiny toast (no full app context needed) ─────────────────────────────────
function toast(msg) {
  let el = document.getElementById('adminToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'adminToast';
    el.className = 'admin-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ─── boot ────────────────────────────────────────────────────────────────────
(async () => {
  const ok = await gateAccess();
  if (ok) loadInbox();
})();
