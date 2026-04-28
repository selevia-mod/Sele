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
  // Tabs that just need a single load call
  if (name === 'activity') loadActivity();
  if (name === 'inbox')    loadInbox();
  // Tabs that have init-once + load wiring (Users / Bans / Content). The init
  // functions are declared later in the file but we only call them when the
  // tab is opened, so the binding works whatever order the code runs in.
  const lazyInit = (rootElId, initFn, loadFn) => {
    const el = document.getElementById(rootElId);
    if (!el) return;
    if (!el.dataset.bound && typeof initFn === 'function') {
      initFn();
      el.dataset.bound = '1';
    }
    if (typeof loadFn === 'function') loadFn();
  };
  if (name === 'users')   lazyInit('usersSearch',   typeof initUsersTab   === 'function' ? initUsersTab   : null, typeof loadUsers          === 'function' ? loadUsers          : null);
  if (name === 'bans')    lazyInit('bansFilter',    typeof initBansTab    === 'function' ? initBansTab    : null, typeof loadBans           === 'function' ? loadBans           : null);
  if (name === 'content') lazyInit('contentFilter', typeof initContentTab === 'function' ? initContentTab : null, typeof loadHiddenContent  === 'function' ? loadHiddenContent  : null);
  if (name === 'wallet')  lazyInit('btnAddPack',    typeof initWalletTab  === 'function' ? initWalletTab  : null, typeof loadWalletPacks    === 'function' ? loadWalletPacks    : null);
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

// ─── USERS TAB ───────────────────────────────────────────────────────────────

let _usersSearchTimer = null;

function initUsersTab() {
  const searchEl = document.getElementById('usersSearch');
  const statusEl = document.getElementById('usersStatusFilter');
  const roleEl   = document.getElementById('usersRoleFilter');

  const debounced = () => {
    clearTimeout(_usersSearchTimer);
    _usersSearchTimer = setTimeout(loadUsers, 280);
  };
  searchEl?.addEventListener('input',  debounced);
  statusEl?.addEventListener('change', loadUsers);
  roleEl?.addEventListener('change',   loadUsers);
}

async function loadUsers() {
  const listEl   = document.getElementById('usersList');
  const subEl    = document.getElementById('usersSubtitle');
  const query    = document.getElementById('usersSearch').value.trim();
  const status   = document.getElementById('usersStatusFilter').value;
  const roleFlt  = document.getElementById('usersRoleFilter').value;

  listEl.innerHTML = '<div class="admin-empty">Loading…</div>';

  let q = supabase
    .from('profiles')
    .select('id, username, email, avatar_url, role, is_banned, suspended_until, ban_reason, banned_at, created_at')
    .order('created_at', { ascending: false })
    .limit(50);

  // Search across username + email
  if (query) {
    const safe = query.replace(/[%_\\]/g, '\\$&');
    q = q.or(`username.ilike.%${safe}%,email.ilike.%${safe}%`);
  }

  // Role filter
  if (roleFlt !== 'all') q = q.eq('role', roleFlt);

  // Status filter
  const nowIso = new Date().toISOString();
  if (status === 'banned')    q = q.eq('is_banned', true);
  if (status === 'suspended') q = q.eq('is_banned', false).gt('suspended_until', nowIso);
  if (status === 'active')    q = q.eq('is_banned', false).or(`suspended_until.is.null,suspended_until.lt.${nowIso}`);

  const { data: users, error } = await q;
  if (error) { listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`; return; }
  if (!users.length) {
    listEl.innerHTML = `<div class="admin-empty">${query ? 'No matches.' : 'No users.'}</div>`;
    subEl.textContent = '0 users';
    return;
  }

  subEl.textContent = `${users.length} ${users.length === 50 ? 'shown · refine search to narrow down' : 'matched'}`;
  listEl.innerHTML = '';

  for (const u of users) {
    const isSuspended = !u.is_banned && u.suspended_until && new Date(u.suspended_until) > new Date();
    const status = u.is_banned ? 'banned' : isSuspended ? 'suspended' : 'active';

    const row = document.createElement('div');
    row.className = 'user-row';
    row.dataset.userId = u.id;
    row.innerHTML = `
      <div class="user-row-head">
        <div class="user-row-avatar">${u.avatar_url ? `<img src="${esc(u.avatar_url)}" alt=""/>` : esc(initials(u.username))}</div>
        <div class="user-row-meta">
          <div class="user-row-name">
            ${esc(u.username || '(no username)')}
            ${u.role !== 'user' ? `<span class="user-role-badge user-role-${u.role}">${esc(u.role)}</span>` : ''}
            ${status === 'banned'    ? '<span class="user-status-badge user-status-banned">Banned</span>'    : ''}
            ${status === 'suspended' ? '<span class="user-status-badge user-status-suspended">Suspended</span>' : ''}
          </div>
          <div class="user-row-email">${esc(u.email || '—')} · joined ${esc((u.created_at || '').slice(0,10))}</div>
        </div>
        <button class="user-row-toggle" aria-label="Expand">▾</button>
      </div>
      <div class="user-row-panel" style="display:none">
        ${status === 'suspended' ? `<div class="user-status-detail">Suspended until <b>${esc(new Date(u.suspended_until).toLocaleString())}</b></div>` : ''}
        ${status === 'banned'    ? `<div class="user-status-detail">Banned${u.ban_reason ? ` for <b>${esc(u.ban_reason)}</b>` : ''}${u.banned_at ? ` · ${esc(new Date(u.banned_at).toLocaleDateString())}` : ''}</div>` : ''}
        <div class="user-actions">
          ${status === 'banned'    ? '<button class="user-act-btn" data-act="unban">Unban</button>' : ''}
          ${status === 'suspended' ? '<button class="user-act-btn" data-act="unsuspend">Lift suspension</button>' : ''}
          ${status === 'active'    ? '<button class="user-act-btn" data-act="suspend">Suspend</button>' : ''}
          ${status !== 'banned'    ? '<button class="user-act-btn user-act-btn-danger" data-act="ban">Ban</button>' : ''}
          <span class="user-actions-divider"></span>
          ${u.role === 'user'      ? '<button class="user-act-btn" data-act="make_mod">Make moderator</button>' : ''}
          ${u.role === 'moderator' ? '<button class="user-act-btn" data-act="make_admin">Promote to admin</button>' : ''}
          ${u.role === 'moderator' ? '<button class="user-act-btn" data-act="demote">Revoke moderator</button>' : ''}
          ${u.role === 'admin' && u.id !== currentMod.id ? '<button class="user-act-btn" data-act="demote">Revoke admin</button>' : ''}
        </div>
      </div>
    `;

    // Toggle expand
    const head    = row.querySelector('.user-row-head');
    const panel   = row.querySelector('.user-row-panel');
    const toggle  = row.querySelector('.user-row-toggle');
    head.addEventListener('click', (e) => {
      if (e.target.closest('.user-act-btn')) return;
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      toggle.textContent  = open ? '▾' : '▴';
      row.classList.toggle('user-row-open', !open);
    });

    // Action buttons
    row.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        handleUserAction(b.dataset.act, u);
      });
    });

    listEl.appendChild(row);
  }
}

async function handleUserAction(act, u) {
  const reasonAndNote = await openReasonModal(
    act === 'make_mod' || act === 'make_admin' || act === 'demote' ? 'role_change' : act,
    u
  );
  if (!reasonAndNote) return;

  const { reason, note, suspendDays } = reasonAndNote;

  try {
    if (act === 'suspend') {
      const days = suspendDays || 7;
      const until = new Date(); until.setDate(until.getDate() + days);
      await supabase.from('profiles').update({ suspended_until: until.toISOString() }).eq('id', u.id);
      await logAction({ action: 'suspend', target_user_id: u.id, reason, note, metadata: { days } });
      toast(`${u.username || 'User'} suspended ${days}d`);
    }
    else if (act === 'unsuspend') {
      await supabase.from('profiles').update({ suspended_until: null }).eq('id', u.id);
      await logAction({ action: 'unsuspend', target_user_id: u.id, reason, note });
      toast('Suspension lifted');
    }
    else if (act === 'ban') {
      const ok = confirm(`Permanently ban ${u.username || 'this user'}?\n\nThis hides all their content globally and prevents them from posting.`);
      if (!ok) return;
      await supabase.from('profiles').update({
        is_banned: true, ban_reason: reason, banned_at: new Date().toISOString(), banned_by: currentMod.id,
      }).eq('id', u.id);
      await logAction({ action: 'ban', target_user_id: u.id, reason, note });
      toast(`${u.username || 'User'} banned`);
    }
    else if (act === 'unban') {
      await supabase.from('profiles').update({
        is_banned: false, ban_reason: null, banned_at: null, banned_by: null,
      }).eq('id', u.id);
      await logAction({ action: 'unban', target_user_id: u.id, reason, note });
      toast(`${u.username || 'User'} unbanned`);
    }
    else if (act === 'make_mod') {
      if (currentMod.role !== 'admin') return alert('Only admins can grant moderator role');
      await supabase.from('profiles').update({ role: 'moderator' }).eq('id', u.id);
      await logAction({ action: 'grant_role', target_user_id: u.id, reason, note, metadata: { role: 'moderator' } });
      toast(`${u.username || 'User'} promoted to moderator`);
    }
    else if (act === 'make_admin') {
      if (currentMod.role !== 'admin') return alert('Only admins can grant admin role');
      const ok = confirm(`Promote ${u.username || 'this user'} to admin? They'll have full mod powers including the ability to ban/unban anyone.`);
      if (!ok) return;
      await supabase.from('profiles').update({ role: 'admin' }).eq('id', u.id);
      await logAction({ action: 'grant_role', target_user_id: u.id, reason, note, metadata: { role: 'admin' } });
      toast(`${u.username || 'User'} promoted to admin`);
    }
    else if (act === 'demote') {
      if (currentMod.role !== 'admin') return alert('Only admins can revoke roles');
      await supabase.from('profiles').update({ role: 'user' }).eq('id', u.id);
      await logAction({ action: 'revoke_role', target_user_id: u.id, reason, note, metadata: { from: u.role } });
      toast(`${u.username || 'User'} demoted to user`);
    }
    loadUsers();
  } catch (e) {
    alert('Action failed: ' + (e.message || e));
  }
}

// Extend ACTION_REASONS for the new user-tab actions
ACTION_REASONS.unsuspend    = ['mistake', 'time_served', 'context_ok', 'other'];
ACTION_REASONS.unban        = ['mistake', 'appeal_accepted', 'context_ok', 'other'];
ACTION_REASONS.role_change  = ['promotion', 'rotation', 'inactive', 'misconduct', 'other'];

REASON_TEXT.time_served      = 'Time served / served punishment';
REASON_TEXT.appeal_accepted  = 'Appeal accepted';
REASON_TEXT.promotion        = 'Promotion / earned trust';
REASON_TEXT.rotation         = 'Routine rotation';
REASON_TEXT.inactive         = 'Inactive moderator';
REASON_TEXT.misconduct       = 'Misconduct';

ACTION_TITLES.unsuspend   = 'Lift suspension';
ACTION_TITLES.unban       = 'Unban user';
ACTION_TITLES.role_change = 'Change role';

// (Users / Bans / Content tab wiring is now handled inline in switchTab.)

// ─── BANS TAB ────────────────────────────────────────────────────────────────

function initBansTab() {
  document.getElementById('bansFilter').addEventListener('change', loadBans);
}

// Pretty relative-time-ago that handles future + past
function timeRel(date) {
  const ms = new Date(date) - Date.now();
  const abs = Math.abs(ms);
  const sec = Math.floor(abs / 1000);
  const fmt = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  let str;
  if      (sec < 60)        str = fmt(sec, 'sec');
  else if (sec < 3600)      str = fmt(Math.floor(sec / 60), 'min');
  else if (sec < 86400)     str = fmt(Math.floor(sec / 3600), 'hr');
  else if (sec < 86400*30)  str = fmt(Math.floor(sec / 86400), 'day');
  else if (sec < 86400*365) str = fmt(Math.floor(sec / 86400 / 30), 'month');
  else                      str = fmt(Math.floor(sec / 86400 / 365), 'year');
  return ms < 0 ? `${str} ago` : `in ${str}`;
}

async function loadBans() {
  const listEl = document.getElementById('bansList');
  const subEl  = document.getElementById('bansSubtitle');
  const filter = document.getElementById('bansFilter').value;

  listEl.innerHTML = '<div class="admin-empty">Loading…</div>';
  const nowIso = new Date().toISOString();

  // Fetch banned + suspended in parallel
  const [bannedRes, suspendedRes] = await Promise.all([
    (filter === 'suspended') ? Promise.resolve({ data: [] }) : supabase
      .from('profiles')
      .select('id, username, email, avatar_url, role, ban_reason, banned_at, banned_by')
      .eq('is_banned', true)
      .order('banned_at', { ascending: false })
      .limit(200),
    (filter === 'banned') ? Promise.resolve({ data: [] }) : supabase
      .from('profiles')
      .select('id, username, email, avatar_url, role, suspended_until')
      .eq('is_banned', false)
      .gt('suspended_until', nowIso)
      .order('suspended_until', { ascending: true })
      .limit(200),
  ]);

  if (bannedRes.error)    { listEl.innerHTML = `<div class="admin-empty admin-error">${esc(bannedRes.error.message)}</div>`; return; }
  if (suspendedRes.error) { listEl.innerHTML = `<div class="admin-empty admin-error">${esc(suspendedRes.error.message)}</div>`; return; }

  const banned    = bannedRes.data    || [];
  const suspended = suspendedRes.data || [];
  const total     = banned.length + suspended.length;

  // Resolve "banned_by" usernames in one query
  const byIds = [...new Set(banned.map(b => b.banned_by).filter(Boolean))];
  const { data: actors } = byIds.length
    ? await supabase.from('profiles').select('id, username').in('id', byIds)
    : { data: [] };
  const actorMap = Object.fromEntries((actors || []).map(a => [a.id, a]));

  // For suspended users, look up most-recent suspend admin_action to attribute who did it
  let suspendActorMap = {};
  if (suspended.length) {
    const susIds = suspended.map(s => s.id);
    const { data: actions } = await supabase
      .from('admin_actions')
      .select('admin_id, target_user_id, created_at')
      .eq('action', 'suspend')
      .in('target_user_id', susIds)
      .order('created_at', { ascending: false });
    for (const a of (actions || [])) {
      if (!suspendActorMap[a.target_user_id]) suspendActorMap[a.target_user_id] = a.admin_id;
    }
    const sIds = [...new Set(Object.values(suspendActorMap))];
    const newOnes = sIds.filter(id => !actorMap[id]);
    if (newOnes.length) {
      const { data: more } = await supabase.from('profiles').select('id, username').in('id', newOnes);
      for (const u of (more || [])) actorMap[u.id] = u;
    }
  }

  subEl.textContent = total
    ? `${banned.length} banned · ${suspended.length} suspended`
    : 'No active enforcement';

  if (!total) {
    listEl.innerHTML = `<div class="admin-empty">Nobody is currently banned or suspended.</div>`;
    return;
  }

  listEl.innerHTML = '';

  // Render banned first (more severe), then suspended
  for (const u of banned) {
    const who    = actorMap[u.banned_by]?.username || 'a moderator';
    const detail = `Banned${u.ban_reason ? ` for <b>${esc(REASON_TEXT[u.ban_reason] || u.ban_reason)}</b>` : ''}${u.banned_at ? ` · ${esc(timeRel(u.banned_at))}` : ''} by <b>${esc(who)}</b>`;
    listEl.appendChild(renderBanRow(u, 'banned', detail));
  }
  for (const u of suspended) {
    const who    = actorMap[suspendActorMap[u.id]]?.username || 'a moderator';
    const detail = `Suspended · expires <b>${esc(timeRel(u.suspended_until))}</b> (${esc(new Date(u.suspended_until).toLocaleDateString())}) by <b>${esc(who)}</b>`;
    listEl.appendChild(renderBanRow(u, 'suspended', detail));
  }
}

function renderBanRow(u, kind, detail) {
  const row = document.createElement('div');
  row.className = 'ban-row';
  row.innerHTML = `
    <div class="ban-row-avatar">${u.avatar_url ? `<img src="${esc(u.avatar_url)}" alt=""/>` : esc(initials(u.username))}</div>
    <div class="ban-row-meta">
      <div class="ban-row-name">
        ${esc(u.username || '(no username)')}
        ${u.role !== 'user' ? `<span class="user-role-badge user-role-${u.role}">${esc(u.role)}</span>` : ''}
        <span class="user-status-badge user-status-${kind}">${kind === 'banned' ? 'Banned' : 'Suspended'}</span>
      </div>
      <div class="ban-row-email">${esc(u.email || '—')}</div>
      <div class="ban-row-detail">${detail}</div>
    </div>
    <div class="ban-row-actions">
      ${kind === 'banned'    ? '<button class="user-act-btn" data-act="unban">Unban</button>'        : ''}
      ${kind === 'suspended' ? '<button class="user-act-btn" data-act="unsuspend">Lift</button>'     : ''}
    </div>
  `;
  row.querySelectorAll('[data-act]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      handleUserAction(b.dataset.act, u);
    });
  });
  return row;
}

// ─── CONTENT TAB (hidden posts) ──────────────────────────────────────────────

function initContentTab() {
  document.getElementById('contentFilter').addEventListener('change', loadHiddenContent);
}

async function loadHiddenContent() {
  const listEl = document.getElementById('contentList');
  const subEl  = document.getElementById('contentSubtitle');
  const filter = document.getElementById('contentFilter').value;

  listEl.innerHTML = '<div class="admin-empty">Loading…</div>';

  let q = supabase
    .from('posts')
    .select('id, body, image_url, hidden_at, hidden_reason, hidden_by, user_id, created_at, profiles!user_id(id, username, avatar_url, is_banned)')
    .eq('is_hidden', true)
    .order('hidden_at', { ascending: false })
    .limit(100);

  if (filter !== 'all') q = q.eq('hidden_reason', filter);

  const { data: posts, error } = await q;
  if (error) { listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`; return; }
  if (!posts.length) {
    listEl.innerHTML = `<div class="admin-empty">No hidden posts${filter !== 'all' ? ` for "${esc(REASON_TEXT[filter] || filter)}"` : ''}.</div>`;
    subEl.textContent = '0 hidden';
    return;
  }

  // Resolve "hidden_by" admin usernames in one query
  const byIds = [...new Set(posts.map(p => p.hidden_by).filter(Boolean))];
  const { data: actors } = byIds.length
    ? await supabase.from('profiles').select('id, username').in('id', byIds)
    : { data: [] };
  const actorMap = Object.fromEntries((actors || []).map(a => [a.id, a]));

  subEl.textContent = `${posts.length}${posts.length === 100 ? ' shown · refine filter to narrow' : ' hidden'}`;
  listEl.innerHTML = '';

  for (const p of posts) {
    const author  = p.profiles;
    const adminBy = actorMap[p.hidden_by]?.username || 'a moderator';

    const card = document.createElement('div');
    card.className = 'content-card';
    card.dataset.postId = p.id;
    card.innerHTML = `
      <div class="content-card-head">
        <div class="content-card-meta">
          <span class="report-reason-badge">${esc(REASON_TEXT[p.hidden_reason] || p.hidden_reason || 'No reason')}</span>
          <span class="report-time">Hidden ${esc(timeRel(p.hidden_at))} by <b>${esc(adminBy)}</b></span>
        </div>
      </div>
      <div class="content-card-body">
        <div class="report-author">
          <div class="report-avatar">${author?.avatar_url ? `<img src="${esc(author.avatar_url)}" alt=""/>` : esc(initials(author?.username))}</div>
          <div>
            <div class="report-author-name">${esc(author?.username || 'Unknown')}${author?.is_banned ? ' <span class="report-banned-tag">Banned</span>' : ''}</div>
            <div class="report-author-time">Posted ${esc(timeRel(p.created_at))}</div>
          </div>
        </div>
        <div class="report-post-body">${esc(p.body || '').slice(0, 280) || '<i>(no text)</i>'}</div>
        ${p.image_url ? `<div class="report-post-image"><img src="${esc(p.image_url)}" loading="lazy"/></div>` : ''}
      </div>
      <div class="content-card-footer">
        <span class="content-footer-hint">Currently invisible to everyone except mods.</span>
        <div class="report-actions">
          <button class="report-btn" data-act="unhide">Unhide</button>
        </div>
      </div>
    `;

    card.querySelector('[data-act="unhide"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const reasonAndNote = await openReasonModal('unhide', author);
      if (!reasonAndNote) return;
      const { reason, note } = reasonAndNote;
      try {
        await supabase.from('posts').update({
          is_hidden: false, hidden_by: null, hidden_at: null, hidden_reason: null,
        }).eq('id', p.id);
        await logAction({ action: 'unhide_post', target_user_id: author?.id, target_post_id: p.id, reason, note });
        toast('Post unhidden');
        loadHiddenContent();
      } catch (e) {
        alert('Action failed: ' + (e.message || e));
      }
    });

    listEl.appendChild(card);
  }
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

// ════════════════════════════════════════════════════════════════════════════
// WALLET TAB — coin packs CRUD, user wallet lookup + adjust, default config
// ════════════════════════════════════════════════════════════════════════════

// Sub-tab switching inside the Wallet panel
function switchWalletSubtab(name) {
  document.querySelectorAll('.admin-subtab').forEach(t => t.classList.toggle('active', t.dataset.subtab === name));
  document.querySelectorAll('.admin-subtab-content').forEach(s => {
    s.style.display = s.dataset.subtabContent === name ? 'block' : 'none';
  });
  if (name === 'packs')        loadWalletPacks();
  if (name === 'walletconfig') loadWalletConfig();
  // userwallets is search-driven; nothing to load by default
}

function initWalletTab() {
  document.querySelectorAll('.admin-subtab').forEach(t => {
    t.addEventListener('click', () => switchWalletSubtab(t.dataset.subtab));
  });
  document.getElementById('btnAddPack')?.addEventListener('click', () => openPackEditor(null));
  // Wallet search wiring (debounced)
  const search = document.getElementById('walletSearch');
  let t = null;
  search?.addEventListener('input', () => {
    clearTimeout(t);
    const q = search.value.trim();
    if (!q) {
      document.getElementById('walletSearchResults').style.display = 'none';
      document.getElementById('walletDetail').style.display = 'none';
      document.getElementById('walletEmpty').style.display = '';
      return;
    }
    t = setTimeout(() => searchUsersForWallet(q), 220);
  });
}

// ─── PACKS ──────────────────────────────────────────────────────────────────
async function loadWalletPacks() {
  const listEl = document.getElementById('packsList');
  if (!listEl) return;
  listEl.innerHTML = '<div class="admin-empty">Loading packs…</div>';
  const { data: packs, error } = await supabase
    .from('coin_packages')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) {
    listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`;
    return;
  }
  if (!packs?.length) {
    listEl.innerHTML = '<div class="admin-empty">No packs yet — click "Add pack" to create one.</div>';
    return;
  }
  listEl.innerHTML = '';
  for (const p of packs) {
    const total = p.base_coins + p.bonus_coins;
    const bonusPct = p.base_coins > 0 ? Math.round((p.bonus_coins / p.base_coins) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'admin-pack-row' + (p.is_active ? '' : ' is-inactive');
    row.innerHTML = `
      <div class="admin-pack-icon">🪙</div>
      <div class="admin-pack-meta">
        <div class="admin-pack-name">
          ${esc(p.name)}
          ${p.is_best_value ? '<span class="admin-pack-tag admin-pack-tag-best">Best Value</span>' : ''}
          ${p.is_active ? '' : '<span class="admin-pack-tag admin-pack-tag-off">Hidden</span>'}
        </div>
        <div class="admin-pack-sub">
          ${p.base_coins} + ${p.bonus_coins} bonus = <b>${total} coins</b>
          ${bonusPct > 0 ? ` · BONUS ${bonusPct}%` : ''}
          · sort ${p.sort_order}
        </div>
      </div>
      <div class="admin-pack-price">${formatPrice(p.price_minor, p.currency)}</div>
      <div class="admin-pack-actions">
        <button class="admin-btn admin-btn-ghost" data-act="edit">Edit</button>
        <button class="admin-btn admin-btn-ghost" data-act="toggle">${p.is_active ? 'Hide' : 'Show'}</button>
        <button class="admin-btn admin-btn-danger-ghost" data-act="delete">Delete</button>
      </div>
    `;
    row.querySelector('[data-act="edit"]').onclick   = () => openPackEditor(p);
    row.querySelector('[data-act="toggle"]').onclick = () => togglePackActive(p);
    row.querySelector('[data-act="delete"]').onclick = () => deletePack(p);
    listEl.appendChild(row);
  }
}

function formatPrice(minor, currency = 'PHP') {
  const major = (minor / 100).toFixed(2);
  const symbol = currency === 'PHP' ? '₱' : (currency + ' ');
  return `${symbol}${Number(major).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
}

function openPackEditor(pack) {
  const isNew = !pack;
  const modal = document.createElement('div');
  modal.className = 'admin-modal-backdrop';
  modal.innerHTML = `
    <div class="admin-modal">
      <h3>${isNew ? 'Add coin pack' : 'Edit pack'}</h3>
      <div class="admin-form">
        <label>Name <input id="pkName" type="text" value="${esc(pack?.name || '')}"/></label>
        <div class="admin-form-row">
          <label>Base coins <input id="pkBase" type="number" min="1" value="${pack?.base_coins ?? ''}"/></label>
          <label>Bonus coins <input id="pkBonus" type="number" min="0" value="${pack?.bonus_coins ?? 0}"/></label>
        </div>
        <div class="admin-form-row">
          <label>Price (₱) <input id="pkPrice" type="number" step="0.01" min="0.01" value="${pack ? (pack.price_minor / 100).toFixed(2) : ''}"/></label>
          <label>Sort order <input id="pkSort" type="number" value="${pack?.sort_order ?? 0}"/></label>
        </div>
        <div class="admin-form-row admin-form-toggles">
          <label class="admin-checkbox"><input id="pkActive" type="checkbox" ${pack?.is_active !== false ? 'checked' : ''}/> Active</label>
          <label class="admin-checkbox"><input id="pkBest" type="checkbox" ${pack?.is_best_value ? 'checked' : ''}/> Best value</label>
        </div>
      </div>
      <div class="admin-modal-actions">
        <button class="admin-btn admin-btn-ghost" data-act="cancel">Cancel</button>
        <button class="admin-btn admin-btn-primary" data-act="save">${isNew ? 'Create' : 'Save'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('[data-act="cancel"]').onclick = close;
  modal.querySelector('[data-act="save"]').onclick = async () => {
    const name  = modal.querySelector('#pkName').value.trim();
    const base  = parseInt(modal.querySelector('#pkBase').value, 10);
    const bonus = parseInt(modal.querySelector('#pkBonus').value, 10) || 0;
    const price = parseFloat(modal.querySelector('#pkPrice').value);
    const sort  = parseInt(modal.querySelector('#pkSort').value, 10) || 0;
    const active = modal.querySelector('#pkActive').checked;
    const best   = modal.querySelector('#pkBest').checked;
    if (!name || !(base > 0) || !(price > 0)) {
      toast('Name, base coins, and price are required');
      return;
    }
    const payload = {
      name, base_coins: base, bonus_coins: bonus,
      price_minor: Math.round(price * 100), currency: 'PHP',
      sort_order: sort, is_active: active, is_best_value: best,
      updated_at: new Date().toISOString(),
    };
    let result;
    if (isNew) {
      result = await supabase.from('coin_packages').insert(payload).select().single();
    } else {
      result = await supabase.from('coin_packages').update(payload).eq('id', pack.id).select().single();
    }
    if (result.error) { toast(result.error.message); return; }
    close();
    loadWalletPacks();
    toast(isNew ? 'Pack created' : 'Pack updated');
  };
}

async function togglePackActive(pack) {
  const { error } = await supabase.from('coin_packages')
    .update({ is_active: !pack.is_active, updated_at: new Date().toISOString() })
    .eq('id', pack.id);
  if (error) { toast(error.message); return; }
  loadWalletPacks();
}

async function deletePack(pack) {
  if (!confirm(`Delete "${pack.name}"? This is permanent.`)) return;
  const { error } = await supabase.from('coin_packages').delete().eq('id', pack.id);
  if (error) { toast(error.message); return; }
  loadWalletPacks();
  toast('Pack deleted');
}

// ─── USER WALLETS ──────────────────────────────────────────────────────────
let _walletRealtimeChannel = null;

async function searchUsersForWallet(q) {
  const resultsEl = document.getElementById('walletSearchResults');
  resultsEl.style.display = '';
  resultsEl.innerHTML = '<div class="admin-empty">Searching…</div>';
  document.getElementById('walletDetail').style.display = 'none';
  document.getElementById('walletEmpty').style.display = 'none';

  // Search by username OR email
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, email, avatar_url, role')
    .or(`username.ilike.%${q}%,email.ilike.%${q}%`)
    .limit(20);

  if (error) {
    resultsEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`;
    return;
  }
  if (!data?.length) {
    resultsEl.innerHTML = '<div class="admin-empty">No users found.</div>';
    return;
  }
  resultsEl.innerHTML = '';
  for (const u of data) {
    const row = document.createElement('div');
    row.className = 'admin-user-row admin-user-row-compact';
    row.innerHTML = `
      <div class="admin-user-avatar">${u.avatar_url ? `<img src="${esc(u.avatar_url)}"/>` : esc(initials(u.username || 'U'))}</div>
      <div class="admin-user-meta">
        <div class="admin-user-name">${esc(u.username || '(no username)')}</div>
        <div class="admin-user-sub">${esc(u.email || '')} · ${esc(u.role)}</div>
      </div>
      <button class="admin-btn admin-btn-ghost">View wallet →</button>
    `;
    row.onclick = () => openWalletDetail(u);
    resultsEl.appendChild(row);
  }
}

async function openWalletDetail(user) {
  document.getElementById('walletSearchResults').style.display = 'none';
  document.getElementById('walletEmpty').style.display = 'none';
  const detailEl = document.getElementById('walletDetail');
  detailEl.style.display = '';
  detailEl.innerHTML = '<div class="admin-empty">Loading wallet…</div>';

  const [{ data: wallet }, { data: coinTx }, { data: starTx }] = await Promise.all([
    supabase.from('wallets').select('*').eq('user_id', user.id).maybeSingle(),
    supabase.from('coin_transactions').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
    supabase.from('star_transactions').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
  ]);

  const w = wallet || { coin_balance: 0, star_balance: 0 };
  detailEl.innerHTML = `
    <div class="admin-wallet-header">
      <div class="admin-user-avatar admin-user-avatar-lg">${user.avatar_url ? `<img src="${esc(user.avatar_url)}"/>` : esc(initials(user.username || 'U'))}</div>
      <div class="admin-wallet-user">
        <div class="admin-wallet-username">${esc(user.username || '(no username)')}</div>
        <div class="admin-wallet-email">${esc(user.email || '')} · ${esc(user.role)}</div>
      </div>
      <button class="admin-btn admin-btn-ghost" data-act="back">← Back to search</button>
    </div>
    <div class="admin-wallet-balances">
      <div class="admin-wallet-balance-card">
        <div class="admin-wallet-balance-label">Coins</div>
        <div class="admin-wallet-balance-value" id="walletCoinValue">${w.coin_balance.toLocaleString()}</div>
        <button class="admin-btn admin-btn-primary" data-adjust="coin">Adjust coins</button>
      </div>
      <div class="admin-wallet-balance-card">
        <div class="admin-wallet-balance-label">Stars</div>
        <div class="admin-wallet-balance-value" id="walletStarValue">${w.star_balance.toLocaleString()}</div>
        <button class="admin-btn admin-btn-primary" data-adjust="star">Adjust stars</button>
      </div>
    </div>
    <div class="admin-wallet-tx-cols">
      <div class="admin-wallet-tx-col">
        <h4>Recent coin transactions</h4>
        ${renderTxList(coinTx, 'coin')}
      </div>
      <div class="admin-wallet-tx-col">
        <h4>Recent star transactions</h4>
        ${renderTxList(starTx, 'star')}
      </div>
    </div>
  `;
  detailEl.querySelector('[data-act="back"]').onclick = () => {
    teardownWalletRealtime();
    detailEl.style.display = 'none';
    document.getElementById('walletEmpty').style.display = '';
    document.getElementById('walletSearch').value = '';
  };
  detailEl.querySelector('[data-adjust="coin"]').onclick = () => openAdjustModal(user, 'coin');
  detailEl.querySelector('[data-adjust="star"]').onclick = () => openAdjustModal(user, 'star');

  // Live updates: subscribe to wallet changes for this user only
  setupWalletRealtime(user.id);
}

function renderTxList(rows, currency) {
  if (!rows?.length) return '<div class="admin-empty admin-empty-tiny">No transactions yet.</div>';
  return `<div class="admin-wallet-tx">${rows.map(r => `
    <div class="admin-wallet-tx-row ${r.delta > 0 ? 'is-credit' : 'is-debit'}">
      <div class="admin-wallet-tx-meta">
        <div class="admin-wallet-tx-type">${esc(r.type.replaceAll('_', ' '))}</div>
        <div class="admin-wallet-tx-sub">${timeAgo(r.created_at)}${r.reference_type ? ' · ' + esc(r.reference_type) : ''}${r.metadata?.reason ? ' · ' + esc(r.metadata.reason) : ''}</div>
      </div>
      <div class="admin-wallet-tx-delta">${r.delta > 0 ? '+' : ''}${r.delta}</div>
      <div class="admin-wallet-tx-balance">→ ${r.balance_after}</div>
    </div>
  `).join('')}</div>`;
}

function setupWalletRealtime(userId) {
  teardownWalletRealtime();
  _walletRealtimeChannel = supabase
    .channel(`admin-wallet-${userId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'wallets', filter: `user_id=eq.${userId}` },
      (payload) => {
        const w = payload.new;
        const c = document.getElementById('walletCoinValue');
        const s = document.getElementById('walletStarValue');
        if (c) { c.textContent = w.coin_balance.toLocaleString(); c.classList.add('is-pulse'); setTimeout(() => c.classList.remove('is-pulse'), 600); }
        if (s) { s.textContent = w.star_balance.toLocaleString(); s.classList.add('is-pulse'); setTimeout(() => s.classList.remove('is-pulse'), 600); }
      })
    .subscribe();
}
function teardownWalletRealtime() {
  if (_walletRealtimeChannel) {
    supabase.removeChannel(_walletRealtimeChannel);
    _walletRealtimeChannel = null;
  }
}

function openAdjustModal(user, currency) {
  const modal = document.createElement('div');
  modal.className = 'admin-modal-backdrop';
  modal.innerHTML = `
    <div class="admin-modal">
      <h3>Adjust ${currency === 'coin' ? 'coins' : 'stars'} — ${esc(user.username || user.email)}</h3>
      <p class="admin-modal-sub">Use a positive number to credit, negative to debit. Reason is logged in the audit trail.</p>
      <div class="admin-form">
        <label>Delta (signed)
          <input id="adjDelta" type="number" placeholder="e.g. -50 to debit, 100 to credit"/>
        </label>
        <label>Reason (required)
          <textarea id="adjReason" rows="3" placeholder="e.g. Refund for failed transaction xyz / Investigated suspected scam #42 / Compensation for outage"></textarea>
        </label>
      </div>
      <div class="admin-modal-actions">
        <button class="admin-btn admin-btn-ghost" data-act="cancel">Cancel</button>
        <button class="admin-btn admin-btn-primary" data-act="save">Apply adjustment</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('[data-act="cancel"]').onclick = close;
  modal.querySelector('[data-act="save"]').onclick = async () => {
    const delta  = parseInt(modal.querySelector('#adjDelta').value, 10);
    const reason = modal.querySelector('#adjReason').value.trim();
    if (!Number.isFinite(delta) || delta === 0) { toast('Enter a non-zero delta'); return; }
    if (!reason) { toast('Reason is required'); return; }
    const { data, error } = await supabase.rpc('admin_adjust_balance', {
      p_target_user_id: user.id,
      p_currency: currency,
      p_delta: delta,
      p_reason: reason,
    });
    if (error) { toast(error.message); return; }
    if (data?.ok === false) { toast(data.error || 'Adjustment failed'); return; }
    close();
    toast(`Adjusted ${currency} by ${delta > 0 ? '+' : ''}${delta}. New balance: ${data.balance_after}`);
    // Reload tx list so the new entry appears immediately
    openWalletDetail(user);
  };
}

// ─── DEFAULTS (app_config) ─────────────────────────────────────────────────
async function loadWalletConfig() {
  const listEl = document.getElementById('walletConfigList');
  if (!listEl) return;
  listEl.innerHTML = '<div class="admin-empty">Loading defaults…</div>';
  const { data: cfg, error } = await supabase
    .from('app_config')
    .select('*')
    .order('key', { ascending: true });
  if (error) {
    listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`;
    return;
  }
  if (!cfg?.length) {
    listEl.innerHTML = '<div class="admin-empty">No config rows yet.</div>';
    return;
  }
  listEl.innerHTML = '';
  for (const c of cfg) {
    const row = document.createElement('div');
    row.className = 'admin-config-row';
    row.innerHTML = `
      <div class="admin-config-meta">
        <div class="admin-config-key">${esc(c.key)}</div>
        <div class="admin-config-desc">${esc(c.description || '')}</div>
      </div>
      <input class="admin-input admin-config-input" type="number" value="${c.value_int}" data-key="${esc(c.key)}"/>
      <button class="admin-btn admin-btn-ghost" data-save="${esc(c.key)}">Save</button>
    `;
    row.querySelector(`[data-save="${c.key}"]`).onclick = async () => {
      const v = parseInt(row.querySelector('input').value, 10);
      if (!Number.isFinite(v) || v < 0) { toast('Value must be a non-negative integer'); return; }
      const { error: e2 } = await supabase
        .from('app_config')
        .update({ value_int: v, updated_at: new Date().toISOString(), updated_by: currentMod.id })
        .eq('key', c.key);
      if (e2) { toast(e2.message); return; }
      toast(`Updated ${c.key} → ${v}`);
    };
    listEl.appendChild(row);
  }
}

// ─── boot ────────────────────────────────────────────────────────────────────
(async () => {
  const ok = await gateAccess();
  if (ok) loadInbox();
})();
