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

// ─── birthdate formatter ─────────────────────────────────────────────────────
// Used by the Payouts verification grid to surface the user's date of
// birth in the same readable form the mobile Payment Info screen shows
// it ("January 1, 2000"), instead of the raw ISO date PostgreSQL returns
// ("2000-01-01"). Returns the empty string for null/undefined/invalid
// inputs so the caller can chain `... || '—'` without nesting checks.
const _formatBirthdate = (raw) => {
  if (!raw) return '';
  // Postgres date columns serialize as 'YYYY-MM-DD' (no time component);
  // splitting + rebuilding via Date is timezone-safe (constructing
  // `new Date('2000-01-01')` would parse as UTC midnight and could
  // shift to the previous day in PHT, displaying "December 31, 1999").
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw));
  let d;
  if (m) {
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else {
    d = new Date(raw);
  }
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};

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
  // Tag the body with the active tab so CSS can apply tab-specific layout
  // tweaks without touching the other tabs. Currently only `is-settings` uses
  // this — the Settings tab unlocks a wider main column + denser row styling.
  document.body.classList.toggle('is-settings', name === 'settings');
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
  // Wallet + Payouts both have sub-tabs — re-enter the tab → reset to the
  // default sub-tab and re-render so the user always sees populated content,
  // never a blank panel.
  if (name === 'wallet') {
    lazyInit('btnAddPack', typeof initWalletTab === 'function' ? initWalletTab : null, null);
    if (typeof switchWalletSubtab === 'function') switchWalletSubtab('packs');
  }
  if (name === 'payouts') {
    lazyInit('payoutsFilter', typeof initPayoutsTab === 'function' ? initPayoutsTab : null, null);
    if (typeof switchPayoutsSubtab === 'function') switchPayoutsSubtab('withdrawals');
  }
  if (name === 'recovery') {
    lazyInit('recoveryFilter', typeof initRecoveryTab === 'function' ? initRecoveryTab : null, typeof loadRecovery === 'function' ? loadRecovery : null);
  }
  if (name === 'settings') {
    lazyInit('settingsSearch', typeof initSettingsTab === 'function' ? initSettingsTab : null, typeof loadSettings === 'function' ? loadSettings : null);
  }
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

  // Migrated from `post_reports` → unified `content_reports` table
  // (migration_content_reports_supabase.sql). Now captures reports across
  // posts / videos / books / chapters / comments / users / messages.
  // Existing post_reports rows were backfilled by the migration so the
  // historical queue is preserved.
  //
  // Field mapping vs the old query:
  //   post_id      → content_id (text — UUID for posts/videos/books, Appwrite
  //                               hex for users)
  //   details      → notes
  //   reason       → reason  (unchanged)
  //   status       → status  (unchanged)
  //   created_at   → created_at  (unchanged)
  //   reporter_id  → reporter_id (unchanged, but now text not uuid)
  //   (new)        → content_type ('post' | 'video' | 'book' | 'chapter' |
  //                                'comment' | 'user' | 'message')
  let q = supabase
    .from('content_reports')
    .select('id, reason, notes, status, created_at, reporter_id, content_id, content_type, owner_id')
    .order('created_at', { ascending: true })
    .limit(100);

  if (filter !== 'all') q = q.eq('status', filter);

  const { data: allReports, error } = await q;
  if (error) {
    listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`;
    return;
  }
  if (!allReports.length) {
    listEl.innerHTML = `<div class="admin-empty">No ${filter === 'all' ? '' : filter + ' '}reports.</div>`;
    subEl.textContent = '0 reports';
    document.getElementById('inboxCount').textContent = '0';
    return;
  }

  // Split: post reports get the full rendering with hydrated post body +
  // mod actions. Other content types (video / book / chapter / user / chat)
  // render in a compact list at the bottom — basic info + dismiss action.
  // Full per-type UIs land in follow-ups; right now mods at least SEE
  // every incoming report and can dismiss / track them.
  const reports       = allReports.filter(r => r.content_type === 'post');
  const otherReports  = allReports.filter(r => r.content_type !== 'post');

  // Map content_id → post_id alias for the rest of this function so the
  // existing post-rendering code below doesn't need every reference
  // rewritten. The per-report.details legacy field maps to .notes.
  reports.forEach(r => {
    r.post_id = r.content_id;
    r.details = r.notes;
  });

  // Hydrate with post + reporter context
  const postIds     = [...new Set(reports.map(r => r.post_id).filter(Boolean))];
  // Reporter ids span both Appwrite hex (mobile) and Supabase UUID (web).
  // The profiles lookup uses Supabase UUIDs so for now we just look up
  // whatever subset is UUID-shaped; non-matches just render "Unknown".
  const __UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const reporterIds = [...new Set(allReports.map(r => r.reporter_id).filter(id => id && __UUID_RE.test(id)))];

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

  // Total queue count includes BOTH post reports and other-content reports
  // so the sidebar count chip reflects the full inbox, not just posts.
  document.getElementById('inboxCount').textContent = filter === 'pending' ? allReports.length : '';
  const otherSummary = otherReports.length
    ? ` · ${otherReports.length} non-post (chat/video/book)`
    : '';
  subEl.textContent = `${reports.length} ${filter === 'all' ? 'total' : filter} · across ${Object.keys(groupedByPost).length} posts${otherSummary}`;

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

  // ── Other content types (chat / video / book / chapter / comment) ──
  // Compact list — the per-type rich rendering (preview the video, jump
  // to the chat thread, etc.) is a follow-up. For now mods at least SEE
  // every report and can dismiss them; the full report payload (reason,
  // notes, content_id, reporter) is on the card.
  if (otherReports.length) {
    const sectionHeader = document.createElement('div');
    sectionHeader.className = 'report-section-header';
    sectionHeader.style.cssText = 'margin: 16px 0 8px; padding: 8px 12px; font-size: 0.85rem; font-weight: 600; color: var(--text2); border-top: 1px solid var(--border);';
    sectionHeader.textContent = `Other reports (${otherReports.length}) — chat / video / book / comment`;
    listEl.appendChild(sectionHeader);

    // Group by content_type for visual scanning
    const byType = {};
    for (const r of otherReports) {
      if (!byType[r.content_type]) byType[r.content_type] = [];
      byType[r.content_type].push(r);
    }

    for (const ctype of Object.keys(byType)) {
      const group = byType[ctype];
      for (const r of group) {
        const reporter = reporterMap[r.reporter_id];
        const card = document.createElement('div');
        card.className = 'report-card report-card-compact';
        card.dataset.reportId = r.id;
        card.style.cssText = 'padding: 12px 14px; margin-bottom: 8px;';
        card.innerHTML = `
          <div class="report-card-head">
            <div class="report-card-meta">
              <span class="report-reason-badge" style="text-transform: capitalize">${esc(ctype)}</span>
              <span class="report-reason-badge">${esc(REASON_LABELS[r.reason] || r.reason || 'reported')}</span>
              <span class="report-time">${timeAgo(r.created_at)}</span>
            </div>
          </div>
          <div class="report-card-body" style="padding: 6px 0">
            <div class="report-post-body" style="font-size: 0.85rem">
              <strong>Content:</strong> <code style="font-family: ui-monospace, monospace; font-size: 0.8rem">${esc(r.content_id)}</code>
            </div>
            ${r.notes ? `<div class="report-post-body" style="margin-top: 4px"><i>${esc(String(r.notes).slice(0, 200))}</i></div>` : ''}
          </div>
          <div class="report-card-footer">
            <div class="report-reporter">Reported by ${esc(reporter?.username || r.reporter_id || 'Unknown')}</div>
            <div class="report-actions">
              <button class="report-btn" data-action="dismiss-other">Dismiss</button>
            </div>
          </div>
        `;
        card.querySelector('[data-action="dismiss-other"]').addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await supabase.from('content_reports').update({
              status: 'dismissed',
              reviewed_by: currentMod.id,
              reviewed_at: new Date().toISOString(),
            }).eq('id', r.id);
            card.style.opacity = '0.5';
            toast('Dismissed');
            setTimeout(loadInbox, 600);
          } catch (err) {
            alert('Dismiss failed: ' + (err.message || err));
          }
        });
        listEl.appendChild(card);
      }
    }
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
      // Mark all reports on this post as dismissed.
      // Now writes to `content_reports` (the unified queue). Backfilled
      // legacy rows preserved their original ids so .in('id', ...) still
      // matches them.
      await supabase.from('content_reports').update({
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
  // Migrated to content_reports — backfilled legacy ids match.
  await supabase.from('content_reports').update({
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

// Sub-tab switching inside the Wallet panel.
// CRITICAL: scope all selectors to [data-tab-content="wallet"] — without it,
// these queries also match the Payouts sub-tabs (same .admin-subtab class)
// and toggling one tab strips .active from the other → empty content area.
function switchWalletSubtab(name) {
  document.querySelectorAll('[data-tab-content="wallet"] .admin-subtab').forEach(t => t.classList.toggle('active', t.dataset.subtab === name));
  document.querySelectorAll('[data-tab-content="wallet"] .admin-subtab-content').forEach(s => {
    s.style.display = s.dataset.subtabContent === name ? 'block' : 'none';
  });
  if (name === 'packs')        loadWalletPacks();
  // userwallets is search-driven; nothing to load by default.
  // The legacy 'walletconfig' (Defaults) sub-tab was removed in favor of
  // the top-level Settings tab — see migration_app_config_consolidation.sql.
}

function initWalletTab() {
  document.querySelectorAll('[data-tab-content="wallet"] .admin-subtab').forEach(t => {
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

// ─── DEFAULTS (legacy `loadWalletConfig`) — removed ───────────────────────
// The Defaults sub-tab and its loader were retired. Platform-wide unlock
// prices, limits, and tunables are now managed exclusively from the top-level
// Settings tab (loadSettings / renderSettings / saveSettingValue below),
// which reads/writes the same `app_config` rows but with proper type
// awareness, search, and category grouping. See
// migration_app_config_consolidation.sql for the data backfill that made
// the previously-hotfix-only lowercase keys (default_chapter_unlock_coins,
// author_payout_*, max_bio_*, etc.) editable from Settings.

// ════════════════════════════════════════════════════════════════════════════
// PAYOUTS TAB (Phase 7) — author withdrawal requests + KYC review
// ════════════════════════════════════════════════════════════════════════════

function initPayoutsTab() {
  document.querySelectorAll('[data-tab-content="payouts"] .admin-subtab').forEach(t => {
    t.addEventListener('click', () => switchPayoutsSubtab(t.dataset.subtab));
  });
  // Hidden legacy <select> still drives loadPayouts — listen for
  // both direct change events (no-op now since the select is hidden,
  // but kept for forward compat) and clicks on the new status tabs.
  document.getElementById('payoutsFilter')?.addEventListener('change', loadPayouts);
  document.querySelectorAll('.payouts-status-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const filter = tab.dataset.filter || 'pending';
      // Update the visual active state.
      document.querySelectorAll('.payouts-status-tab').forEach((t) => {
        const isActive = t === tab;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      // Push the value into the hidden select that loadPayouts reads
      // and call it directly. (The select's `change` event doesn't
      // fire on programmatic .value writes, so we trigger the load
      // ourselves.)
      const sel = document.getElementById('payoutsFilter');
      if (sel) sel.value = filter;
      loadPayouts();
    });
  });
  document.getElementById('kycFilter')?.addEventListener('change', loadKycList);
  document.getElementById('changeRequestsFilter')?.addEventListener('change', loadChangeRequests);
}

function switchPayoutsSubtab(name) {
  document.querySelectorAll('[data-tab-content="payouts"] .admin-subtab').forEach(t => t.classList.toggle('active', t.dataset.subtab === name));
  document.querySelectorAll('[data-tab-content="payouts"] .admin-subtab-content').forEach(s => {
    s.style.display = s.dataset.subtabContent === name ? 'block' : 'none';
  });
  if (name === 'withdrawals')    loadPayouts();
  if (name === 'kyc')            loadKycList();
  if (name === 'changerequests') loadChangeRequests();
}

// ─── Payment info change requests ──────────────────────────────────────
async function loadChangeRequests() {
  const listEl = document.getElementById('changeRequestsList');
  const filter = document.getElementById('changeRequestsFilter')?.value || 'pending';
  if (!listEl) return;
  listEl.innerHTML = '<div class="admin-empty">Loading…</div>';

  let q = supabase
    .from('payment_info_change_requests')
    .select('id, user_id, current_data, requested_data, reason, status, rejection_reason, requested_at, reviewed_at')
    .order('requested_at', { ascending: false })
    .limit(100);
  if (filter !== 'all') q = q.eq('status', filter);

  const { data: rows, error } = await q;
  if (error) { listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`; return; }
  if (!rows?.length) {
    listEl.innerHTML = `<div class="admin-empty">No ${filter === 'all' ? '' : filter + ' '}change requests.</div>`;
    return;
  }

  // Hydrate user info AND each user's current author_kyc row so the
  // reviewer sees the full verification context (not just the diff).
  // Approving a change request is the same trust decision as approving
  // a withdrawal or KYC submission — same identity attachments matter.
  const userIds = [...new Set(rows.map(r => r.user_id))];
  const [{ data: users }, { data: kycRows }] = await Promise.all([
    supabase.from('profiles').select('id, username, avatar_url, email').in('id', userIds),
    supabase.from('author_kyc')
      .select('user_id, full_name, date_of_birth, id_type, id_number, id_document_url, payment_qr_url, signature_url, payment_method, phone, email, address, status')
      .in('user_id', userIds),
  ]);
  const userMap = Object.fromEntries((users || []).map(u => [u.id, u]));
  const kycMap  = Object.fromEntries((kycRows || []).map(k => [k.user_id, k]));

  // Pre-sign image URLs (QR / signature / valid-ID) — same recipe as
  // loadPayouts and loadKycList.
  const signTasks = [];
  for (const k of (kycRows || [])) {
    if (k.payment_qr_url && !/^https?:\/\//i.test(k.payment_qr_url)) {
      signTasks.push(_signKycUrl(k.payment_qr_url).then((u) => { k.payment_qr_signed = u; }));
    } else { k.payment_qr_signed = k.payment_qr_url || null; }
    if (k.signature_url && !/^https?:\/\//i.test(k.signature_url)) {
      signTasks.push(_signKycUrl(k.signature_url).then((u) => { k.signature_signed = u; }));
    } else { k.signature_signed = k.signature_url || null; }
    if (k.id_document_url && !/^https?:\/\//i.test(k.id_document_url)) {
      signTasks.push(_signKycUrl(k.id_document_url).then((u) => { k.id_document_signed = u; }));
    } else { k.id_document_signed = k.id_document_url || null; }
  }
  await Promise.all(signTasks);

  listEl.innerHTML = '';
  for (const r of rows) {
    const user = userMap[r.user_id];
    const k = kycMap[r.user_id] || {};
    const card = document.createElement('div');
    card.className = 'kyc-card';

    const diffRows = [];
    const requested = r.requested_data || {};
    const current   = r.current_data || {};
    for (const [key, newVal] of Object.entries(requested)) {
      const oldVal = current[key] || '—';
      diffRows.push(`<div class="cr-diff"><span class="cr-diff-key">${esc(key)}</span><span class="cr-diff-old">${esc(oldVal)}</span><span class="cr-diff-arrow">→</span><span class="cr-diff-new">${esc(newVal)}</span></div>`);
    }

    card.innerHTML = `
      <div class="payout-card-head">
        <div class="payout-author">
          <div class="payout-author-name">${esc(user?.username || 'Unknown')}</div>
          <div class="payout-author-email">${esc(user?.email || '')}</div>
        </div>
        <span class="payout-status-badge payout-status-badge-${r.status}">${r.status}</span>
      </div>

      <!-- Full identity context. Same shape as the Withdrawals + KYC
           review cards so reviewers don't have to context-switch when
           flipping between tabs. -->
      <div class="payout-verify">
        <div class="payout-verify-grid">
          <div class="payout-verify-row"><span class="payout-verify-label">Full name</span><span class="payout-verify-val">${esc(k.full_name || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Birthdate</span><span class="payout-verify-val">${esc(_formatBirthdate(k.date_of_birth) || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Phone</span><span class="payout-verify-val">${esc(k.phone || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Email (user)</span><span class="payout-verify-val">${esc(k.email || user?.email || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Method</span><span class="payout-verify-val">${esc(k.payment_method || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">ID type</span><span class="payout-verify-val">${esc(k.id_type || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">ID number</span><span class="payout-verify-val">${esc(k.id_number || '—')}</span></div>
          <div class="payout-verify-row payout-verify-row-wide"><span class="payout-verify-label">Home address</span><span class="payout-verify-val">${esc(k.address || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Requested</span><span class="payout-verify-val">${timeAgo(r.requested_at)}</span></div>
          ${r.reviewed_at ? `<div class="payout-verify-row"><span class="payout-verify-label">Reviewed</span><span class="payout-verify-val">${timeAgo(r.reviewed_at)}</span></div>` : ''}
        </div>

        <div class="payout-verify-media">
          <div class="payout-verify-media-card">
            <div class="payout-verify-media-label">GCash QR</div>
            ${k.payment_qr_signed
              ? `<a href="${esc(k.payment_qr_signed)}" target="_blank" rel="noopener"><img class="payout-verify-img" src="${esc(k.payment_qr_signed)}" alt="GCash QR" loading="lazy"/></a>`
              : `<div class="payout-verify-media-empty">— not provided —</div>`}
          </div>
          <div class="payout-verify-media-card">
            <div class="payout-verify-media-label">Signature</div>
            ${k.signature_signed
              ? `<a href="${esc(k.signature_signed)}" target="_blank" rel="noopener"><img class="payout-verify-img" src="${esc(k.signature_signed)}" alt="Signature" loading="lazy"/></a>`
              : `<div class="payout-verify-media-empty">— not provided —</div>`}
          </div>
          <div class="payout-verify-media-card">
            <div class="payout-verify-media-label">Valid ID</div>
            ${k.id_document_signed
              ? `<a href="${esc(k.id_document_signed)}" target="_blank" rel="noopener"><img class="payout-verify-img" src="${esc(k.id_document_signed)}" alt="Valid ID" loading="lazy"/></a>`
              : `<div class="payout-verify-media-empty">— not provided —</div>`}
          </div>
        </div>
      </div>

      <div class="cr-reason"><strong>Reason:</strong> ${esc(r.reason || '—')}</div>
      <div class="cr-diff-list">${diffRows.join('') || '<em>No changes captured</em>'}</div>
      ${r.rejection_reason ? `<div class="cr-rejection"><strong>Rejection:</strong> ${esc(r.rejection_reason)}</div>` : ''}
      ${r.status === 'pending' ? `
        <div class="payout-actions">
          <button class="admin-btn admin-btn-primary" data-act="approve">Approve</button>
          <button class="admin-btn admin-btn-danger" data-act="reject">Reject</button>
        </div>
      ` : ''}
    `;

    card.querySelector('[data-act="approve"]')?.addEventListener('click', async () => {
      if (!confirm('Approve this change request? It will be applied to the author\'s Payments Info immediately.')) return;
      const { data, error } = await supabase.rpc('review_payment_info_change', { p_request_id: r.id, p_approve: true });
      if (error || !data?.ok) { toast(error?.message || data?.error || 'Approve failed'); return; }
      toast('Approved');
      loadChangeRequests();
    });
    card.querySelector('[data-act="reject"]')?.addEventListener('click', async () => {
      const reason = prompt('Reason for rejection (will be shown to the author):');
      if (!reason) return;
      const { data, error } = await supabase.rpc('review_payment_info_change', { p_request_id: r.id, p_approve: false, p_rejection_reason: reason });
      if (error || !data?.ok) { toast(error?.message || data?.error || 'Reject failed'); return; }
      toast('Rejected');
      loadChangeRequests();
    });

    listEl.appendChild(card);
  }
}

// ─── Withdrawals ───────────────────────────────────────────────────────
//
// Sign a Supabase Storage path so admin previews work for KYC images
// (qr code + signature). Author KYC files live in a private bucket;
// without a signed URL the <img> 403s. 1-hour signed URLs are plenty
// for a single moderator session — they expire well before a payout
// queue review takes long enough to matter.
async function _signKycUrl(rawUrl) {
  if (!rawUrl) return null;
  // Already an https URL (e.g. legacy Appwrite asset) — pass through.
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  // Otherwise treat it as a path inside the kyc-uploads bucket. Bucket
  // name MUST match what mobile (lib/user-documents.js) and web (the
  // creator-side KYC form) use; previously this read 'user_documents'
  // which silently broke admin previews for every mobile submission —
  // the path landed in kyc-uploads, the sign call asked user_documents,
  // and createSignedUrl returned a not-found error so the admin
  // rendered "— not provided —" for every field even though the DB
  // had valid paths. Caught 2026-05-10 with the form-open OTA when
  // creators started re-saving and the discrepancy became visible.
  try {
    const { data, error } = await supabase
      .storage
      .from('kyc-uploads')
      .createSignedUrl(rawUrl, 60 * 60);
    if (error) return null;
    return data?.signedUrl || null;
  } catch {
    return null;
  }
}

// Refresh the count badges on the status tabs so a moderator can see
// at a glance how many pending / approved / paid / rejected requests
// are in the queue without flipping between tabs.
async function _refreshPayoutStatusCounts() {
  const counts = { pending: 0, approved: 0, paid: 0, rejected: 0 };
  try {
    const { data } = await supabase
      .from('author_withdrawals')
      .select('status', { count: 'exact', head: false })
      .in('status', ['pending', 'approved', 'paid', 'rejected']);
    for (const row of data || []) {
      if (counts.hasOwnProperty(row.status)) counts[row.status] += 1;
    }
  } catch {
    /* swallow — badges fall back to "·" */
  }
  const setTxt = (id, n) => {
    const el = document.getElementById(id);
    if (el) el.textContent = n > 0 ? String(n) : '·';
  };
  setTxt('payoutsCountPending',  counts.pending);
  setTxt('payoutsCountApproved', counts.approved);
  setTxt('payoutsCountPaid',     counts.paid);
  setTxt('payoutsCountRejected', counts.rejected);
}

async function loadPayouts() {
  const listEl = document.getElementById('payoutsList');
  const subEl  = document.getElementById('payoutsSub');
  const filter = document.getElementById('payoutsFilter')?.value || 'pending';
  if (!listEl) return;
  listEl.innerHTML = '<div class="admin-empty">Loading…</div>';

  // Refresh the tab count badges in parallel — purely informational,
  // not on the critical render path so failures here don't block the
  // list from rendering.
  _refreshPayoutStatusCounts().catch(() => {});

  let q = supabase
    .from('author_withdrawals')
    .select('id, author_id, amount_coins, amount_php_minor, status, payout_method, payout_details, rejection_reason, hitpay_payout_ref, requested_at, approved_at, paid_at')
    .order('requested_at', { ascending: false })
    .limit(200);

  if (filter !== 'all') q = q.eq('status', filter);

  const { data: rows, error } = await q;
  if (error) { listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`; return; }
  if (!rows?.length) {
    listEl.innerHTML = `<div class="admin-empty">No ${filter === 'all' ? '' : filter + ' '}withdrawals.</div>`;
    if (subEl) subEl.textContent = '0 requests';
    return;
  }

  // Hydrate author info AND author_kyc in one shot per author. KYC
  // carries the verification details a moderator needs to confirm
  // before sending money — full name, address, the user's own
  // contact email (separate from auth email), payment_qr_url, and
  // signature_url. Without this, the admin had no way to verify
  // who they were paying without flipping to a different tab.
  const authorIds = [...new Set(rows.map(r => r.author_id))];
  const [{ data: authors }, { data: kycRows }] = await Promise.all([
    supabase.from('profiles')
      .select('id, username, email, avatar_url, role')
      .in('id', authorIds),
    supabase.from('author_kyc')
      // date_of_birth added 2026-05-10 so the admin verification grid
      // can show it alongside phone — finance needs to confirm the
      // recipient's identity matches the GCash account before paying.
      .select('user_id, full_name, address, email, phone, date_of_birth, payment_method, payment_qr_url, signature_url, id_document_url, status, submitted_at')
      .in('user_id', authorIds),
  ]);
  const aMap = Object.fromEntries((authors || []).map(a => [a.id, a]));
  const kMap = Object.fromEntries((kycRows || []).map(k => [k.user_id, k]));

  // Pre-sign the storage paths for the QR + signature in parallel so
  // the cards render with usable <img src> attrs in one paint, not as
  // a flicker after each card mounts.
  const signTasks = [];
  for (const k of (kycRows || [])) {
    if (k.payment_qr_url && !/^https?:\/\//i.test(k.payment_qr_url)) {
      signTasks.push(
        _signKycUrl(k.payment_qr_url).then((u) => { k.payment_qr_signed = u; }),
      );
    } else {
      k.payment_qr_signed = k.payment_qr_url || null;
    }
    if (k.signature_url && !/^https?:\/\//i.test(k.signature_url)) {
      signTasks.push(
        _signKycUrl(k.signature_url).then((u) => { k.signature_signed = u; }),
      );
    } else {
      k.signature_signed = k.signature_url || null;
    }
    // Valid-ID document — same sign-or-pass-through pattern as QR
    // and signature so the third media card renders without a flicker.
    if (k.id_document_url && !/^https?:\/\//i.test(k.id_document_url)) {
      signTasks.push(
        _signKycUrl(k.id_document_url).then((u) => { k.id_document_signed = u; }),
      );
    } else {
      k.id_document_signed = k.id_document_url || null;
    }
  }
  await Promise.all(signTasks);

  if (subEl) subEl.textContent = `${rows.length} ${filter} request${rows.length === 1 ? '' : 's'}`;
  listEl.innerHTML = '';

  for (const w of rows) {
    const a = aMap[w.author_id];
    const k = kMap[w.author_id] || {};
    const detailsObj = w.payout_details || {};
    const phpFmt = '₱' + (w.amount_php_minor / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 });
    // Source-of-truth resolution for the verification fields. The
    // user-entered email + address from KYC win over the auth email
    // (which the user can't change). Account name falls back from
    // payout_details to KYC full_name. Account number lives only on
    // payout_details.
    const accountName  = detailsObj.account_name || k.full_name || '';
    const accountNumber = detailsObj.account_number || '';
    const homeAddress  = k.address || '';
    const userEmail    = k.email || a?.email || '';
    const card = document.createElement('div');
    card.className = `payout-card payout-status-${w.status}`;
    card.innerHTML = `
      <div class="payout-card-head">
        <div class="payout-author">
          <div class="user-row-avatar">${a?.avatar_url ? `<img src="${esc(a.avatar_url)}"/>` : esc(initials(a?.username || 'A'))}</div>
          <div>
            <div class="payout-author-name">${esc(a?.username || '(unknown)')}</div>
            <div class="payout-author-email">${esc(a?.email || '')}</div>
          </div>
        </div>
        <!-- Removed the "0 coins" line — withdrawals are denominated
             in pesos for the moderator's purposes; coin units add
             noise. The peso amount is now the prominent figure. -->
        <div class="payout-amount">
          <div class="payout-amount-php payout-amount-php-lg">${phpFmt}</div>
        </div>
        <span class="payout-status-badge payout-status-badge-${w.status}">${esc(w.status)}</span>
      </div>

      <!-- Verification grid — what the moderator must check before
           pressing Approve / Mark as paid. Account name + #, the
           user-entered email + home address, and visual previews of
           the GCash QR code and signature so the moderator can match
           against the destination account. -->
      <div class="payout-verify">
        <div class="payout-verify-grid">
          <div class="payout-verify-row"><span class="payout-verify-label">Method</span><span class="payout-verify-val">${esc(w.payout_method || k.payment_method || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Account name</span><span class="payout-verify-val">${esc(accountName || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Account #</span><span class="payout-verify-val">${esc(accountNumber || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Birthdate</span><span class="payout-verify-val">${esc(_formatBirthdate(k.date_of_birth) || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Phone</span><span class="payout-verify-val">${esc(k.phone || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Email (user)</span><span class="payout-verify-val">${esc(userEmail || '—')}</span></div>
          <div class="payout-verify-row payout-verify-row-wide"><span class="payout-verify-label">Home address</span><span class="payout-verify-val">${esc(homeAddress || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Requested</span><span class="payout-verify-val">${timeAgo(w.requested_at)}</span></div>
          ${w.approved_at ? `<div class="payout-verify-row"><span class="payout-verify-label">Approved</span><span class="payout-verify-val">${timeAgo(w.approved_at)}</span></div>` : ''}
          ${w.paid_at ? `<div class="payout-verify-row"><span class="payout-verify-label">Paid</span><span class="payout-verify-val">${timeAgo(w.paid_at)}${w.hitpay_payout_ref ? ' · ref ' + esc(w.hitpay_payout_ref) : ''}</span></div>` : ''}
          ${w.rejection_reason ? `<div class="payout-verify-row payout-verify-row-wide"><span class="payout-verify-label">Rejection reason</span><span class="payout-verify-val">${esc(w.rejection_reason)}</span></div>` : ''}
        </div>

        <div class="payout-verify-media">
          <div class="payout-verify-media-card">
            <div class="payout-verify-media-label">GCash QR</div>
            ${k.payment_qr_signed
              ? `<a href="${esc(k.payment_qr_signed)}" target="_blank" rel="noopener"><img class="payout-verify-img" src="${esc(k.payment_qr_signed)}" alt="GCash QR" loading="lazy"/></a>`
              : `<div class="payout-verify-media-empty">— not provided —</div>`}
          </div>
          <div class="payout-verify-media-card">
            <div class="payout-verify-media-label">Signature</div>
            ${k.signature_signed
              ? `<a href="${esc(k.signature_signed)}" target="_blank" rel="noopener"><img class="payout-verify-img" src="${esc(k.signature_signed)}" alt="Signature" loading="lazy"/></a>`
              : `<div class="payout-verify-media-empty">— not provided —</div>`}
          </div>
          <!-- Valid ID — added 2026-05-10. Finance verifies the
               recipient's government-issued ID matches the account
               name + birthdate before processing the payout. Same
               sign-on-load pattern as QR + Signature. -->
          <div class="payout-verify-media-card">
            <div class="payout-verify-media-label">Valid ID</div>
            ${k.id_document_signed
              ? `<a href="${esc(k.id_document_signed)}" target="_blank" rel="noopener"><img class="payout-verify-img" src="${esc(k.id_document_signed)}" alt="Valid ID" loading="lazy"/></a>`
              : `<div class="payout-verify-media-empty">— not provided —</div>`}
          </div>
        </div>
      </div>

      <div class="payout-actions">
        ${w.status === 'pending'
          ? `<button class="admin-btn admin-btn-primary" data-act="approve">Approve</button>
             <button class="admin-btn admin-btn-danger-ghost" data-act="reject">Reject</button>`
          : ''}
        ${w.status === 'approved' || w.status === 'pending'
          ? `<button class="admin-btn admin-btn-primary" data-act="mark-paid">Mark as paid</button>`
          : ''}
      </div>
    `;
    card.querySelector('[data-act="approve"]')?.addEventListener('click', async () => {
      if (!confirm(`Approve ${w.amount_coins} coins (${phpFmt}) payout to ${a?.username || 'this author'}? You'll mark as paid after sending the money.`)) return;
      const { data, error } = await supabase.rpc('admin_approve_withdrawal', { p_withdrawal_id: w.id });
      if (error || data?.ok === false) { toast(error?.message || data?.error || 'Failed'); return; }
      toast('Approved.');
      loadPayouts();
    });
    card.querySelector('[data-act="reject"]')?.addEventListener('click', async () => {
      const reason = prompt('Reject reason (visible to author):');
      if (!reason) return;
      const { data, error } = await supabase.rpc('admin_reject_withdrawal', {
        p_withdrawal_id: w.id, p_reason: reason,
      });
      if (error || data?.ok === false) { toast(error?.message || data?.error || 'Failed'); return; }
      toast('Rejected.');
      loadPayouts();
    });
    card.querySelector('[data-act="mark-paid"]')?.addEventListener('click', async () => {
      const ref = prompt('Optional external reference (e.g. GCash transaction ID, bank ref):') || null;
      if (!confirm(`Confirm: ${a?.username || 'author'} has been sent ${phpFmt} via ${w.payout_method}?`)) return;
      const { data, error } = await supabase.rpc('admin_mark_withdrawal_paid', {
        p_withdrawal_id: w.id, p_external_ref: ref,
      });
      if (error || data?.ok === false) { toast(error?.message || data?.error || 'Failed'); return; }
      toast('Marked as paid.');
      loadPayouts();
    });
    listEl.appendChild(card);
  }
}

// ─── Balance recovery (Recovery tab) ───────────────────────────────────
//
// Where mobile-app reports of missing coins / stars / earnings / account
// access land. Mobile submits via submit_balance_recovery_request; this
// queue lets a moderator review each one, see the user's screenshot
// (when attached), and either approve (writing a coin/star restore tx
// for kind=coin/star, or stamping a manual approval for kind=earnings/
// account) or reject with a reason. Both actions go through admin-only
// RPCs that enforce role check + idempotency server-side.
function initRecoveryTab() {
  // Hidden status select still drives loadRecovery — listen for both
  // direct change events (no-op now since the select is hidden but
  // kept for forward compat) and clicks on the new status tabs.
  document.getElementById('recoveryFilter')?.addEventListener('change', loadRecovery);
  document.getElementById('recoveryKind')?.addEventListener('change', loadRecovery);
  // Wire the 4-stage tabs (For Review / Approved / Resolved /
  // Rejected / All). Each tab pushes its data-filter value into the
  // hidden select and triggers a fresh load. Mirrors the Withdrawals
  // status-tab pattern.
  document
    .querySelectorAll('[data-tab-content="recovery"] .payouts-status-tab')
    .forEach((tab) => {
      tab.addEventListener('click', () => {
        const filter = tab.dataset.filter || 'pending';
        document
          .querySelectorAll('[data-tab-content="recovery"] .payouts-status-tab')
          .forEach((t) => {
            const isActive = t === tab;
            t.classList.toggle('active', isActive);
            t.setAttribute('aria-selected', isActive ? 'true' : 'false');
          });
        const sel = document.getElementById('recoveryFilter');
        if (sel) sel.value = filter;
        loadRecovery();
      });
    });
}

// Refresh the count badges on the recovery tabs so a moderator can
// see at a glance how many requests are in each state.
async function _refreshRecoveryStatusCounts() {
  const counts = { pending: 0, approved: 0, resolved: 0, rejected: 0 };
  try {
    const { data } = await supabase
      .from('balance_recovery_requests')
      .select('status')
      .in('status', ['pending', 'needs_info', 'approved', 'resolved', 'rejected']);
    for (const row of data || []) {
      // Bucket needs_info under pending so the For Review tab shows
      // both pending AND needs-info as one combined queue.
      const bucket = row.status === 'needs_info' ? 'pending' : row.status;
      if (counts.hasOwnProperty(bucket)) counts[bucket] += 1;
    }
  } catch {
    /* badges fall back to "·" */
  }
  const setTxt = (id, n) => {
    const el = document.getElementById(id);
    if (el) el.textContent = n > 0 ? String(n) : '·';
  };
  setTxt('recoveryCountPending',  counts.pending);
  setTxt('recoveryCountApproved', counts.approved);
  setTxt('recoveryCountResolved', counts.resolved);
  setTxt('recoveryCountRejected', counts.rejected);
}

const RECOVERY_KIND_LABEL = {
  coin: 'Missing coins',
  star: 'Missing stars',
  earnings: 'Missing earnings',
  account: 'Account recovery',
};
const RECOVERY_KIND_ICON = {
  coin: '🪙',
  star: '⭐',
  earnings: '₱',
  account: '👤',
};

async function loadRecovery() {
  const listEl = document.getElementById('recoveryList');
  const subEl  = document.getElementById('recoverySub');
  const countBadge = document.getElementById('recoveryCount');
  const filter = document.getElementById('recoveryFilter')?.value || 'pending';
  const kindFilter = document.getElementById('recoveryKind')?.value || 'all';
  if (!listEl) return;
  listEl.innerHTML = '<div class="admin-empty">Loading…</div>';

  // Refresh the per-status tab count badges in parallel — best-effort,
  // not on the critical render path so failures don't block the list.
  _refreshRecoveryStatusCounts().catch(() => {});

  let q = supabase
    .from('balance_recovery_requests')
    .select('id, user_id, kind, reported_amount, approved_amount, status, reason, context, admin_notes, reviewed_by, reviewed_at, created_at')
    .order('created_at', { ascending: false })
    .limit(200);

  // "pending" tab actually means For Review = pending + needs_info,
  // since needs_info is a sub-state of "still being reviewed."
  if (filter === 'pending')      q = q.in('status', ['pending', 'needs_info']);
  else if (filter !== 'all')     q = q.eq('status', filter);
  if (kindFilter !== 'all')      q = q.eq('kind', kindFilter);

  const { data: rows, error } = await q;
  if (error) { listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`; return; }

  // Always update the tab-nav badge with the count of OPEN requests
  // (pending + needs_info) regardless of the current filter — that's
  // the actionable backlog the moderator cares about at a glance.
  try {
    const { count } = await supabase
      .from('balance_recovery_requests')
      .select('id', { head: true, count: 'exact' })
      .in('status', ['pending', 'needs_info']);
    if (countBadge) countBadge.textContent = String(count ?? 0);
  } catch (_) { /* badge is best-effort */ }

  if (!rows?.length) {
    listEl.innerHTML = `<div class="admin-empty">No ${filter === 'all' ? '' : filter + ' '}requests${kindFilter === 'all' ? '' : ' for ' + RECOVERY_KIND_LABEL[kindFilter]}.</div>`;
    if (subEl) subEl.textContent = '0 reports';
    return;
  }

  // Hydrate requester + reviewer profiles in two batches.
  const userIds = [...new Set(rows.map(r => r.user_id))];
  const reviewerIds = [...new Set(rows.map(r => r.reviewed_by).filter(Boolean))];
  const allIds = [...new Set([...userIds, ...reviewerIds])];
  const { data: profiles } = await supabase.from('profiles')
    .select('id, username, email, avatar_url, role')
    .in('id', allIds);
  const pMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

  if (subEl) subEl.textContent = `${rows.length} ${filter === 'open' ? 'open' : filter} report${rows.length === 1 ? '' : 's'}${kindFilter === 'all' ? '' : ' · ' + RECOVERY_KIND_LABEL[kindFilter]}`;
  listEl.innerHTML = '';

  for (const r of rows) {
    const u = pMap[r.user_id];
    const reviewer = r.reviewed_by ? pMap[r.reviewed_by] : null;
    const ctx = r.context || {};
    const screenshot = ctx.screenshot_url || null;
    const amountLabel = r.kind === 'account'
      ? '—'
      : r.kind === 'earnings'
        ? `₱${Number(r.reported_amount).toLocaleString('en-PH')}`
        : `${Number(r.reported_amount).toLocaleString()} ${r.kind === 'coin' ? 'coins' : 'stars'}`;
    const approvedLabel = r.approved_amount && r.kind !== 'account'
      ? (r.kind === 'earnings'
          ? `₱${Number(r.approved_amount).toLocaleString('en-PH')}`
          : `${Number(r.approved_amount).toLocaleString()} ${r.kind === 'coin' ? 'coins' : 'stars'}`)
      : null;

    const card = document.createElement('div');
    card.className = `payout-card payout-status-${r.status}`;
    card.innerHTML = `
      <div class="payout-card-head">
        <div class="payout-author">
          <div class="user-row-avatar">${u?.avatar_url ? `<img src="${esc(u.avatar_url)}"/>` : esc(initials(u?.username || 'U'))}</div>
          <div>
            <div class="payout-author-name">${esc(u?.username || '(unknown)')}</div>
            <div class="payout-author-email">${esc(u?.email || '')}</div>
          </div>
        </div>
        <div class="payout-amount">
          <div class="payout-amount-coins">${esc(RECOVERY_KIND_ICON[r.kind] || '•')} ${esc(RECOVERY_KIND_LABEL[r.kind] || r.kind)}</div>
          <div class="payout-amount-php">Reported: ${esc(amountLabel)}</div>
        </div>
        <span class="payout-status-badge payout-status-badge-${r.status}">${esc(r.status)}</span>
      </div>
      <div class="payout-details">
        ${r.reason ? `<div><strong>Reason:</strong> ${esc(r.reason)}</div>` : ''}
        <div><strong>Submitted:</strong> ${timeAgo(r.created_at)}</div>
        ${r.reviewed_at ? `<div><strong>Reviewed:</strong> ${timeAgo(r.reviewed_at)}${reviewer ? ' by ' + esc(reviewer.username || reviewer.email) : ''}</div>` : ''}
        ${approvedLabel ? `<div><strong>Approved amount:</strong> ${esc(approvedLabel)}</div>` : ''}
        ${r.admin_notes ? `<div><strong>Admin note:</strong> ${esc(r.admin_notes)}</div>` : ''}
        ${screenshot ? `<div style="margin-top:8px"><a href="${esc(screenshot)}" target="_blank" rel="noopener"><img src="${esc(screenshot)}" alt="Screenshot" style="max-width:240px;max-height:320px;border-radius:8px;border:1px solid rgba(0,0,0,0.08)"/></a></div>` : ''}
      </div>
      <div class="payout-actions">
        ${(r.status === 'pending' || r.status === 'needs_info')
          ? `<button class="admin-btn admin-btn-primary" data-act="approve">Approve</button>
             <button class="admin-btn admin-btn-danger-ghost" data-act="reject">Reject</button>`
          : r.status === 'approved'
            ? `<button class="admin-btn admin-btn-primary" data-act="mark-resolved">Mark as Resolved</button>
               <button class="admin-btn admin-btn-danger-ghost" data-act="reject">Reject (revert)</button>`
            : ''}
      </div>
    `;
    card.querySelector('[data-act="approve"]')?.addEventListener('click', async () => {
      // For coin/star/earnings kinds, ask the admin to confirm the
      // amount they're approving — defaults to whatever the user
      // reported. For account recovery the amount is just a stamp
      // (the actual restore happens via support channel) so we use 1.
      let approvedAmount = 1;
      if (r.kind !== 'account') {
        const promptDefault = String(r.reported_amount ?? '');
        const promptLabel = r.kind === 'earnings'
          ? `Approved amount in PHP (user reported ₱${promptDefault}):`
          : `Approved ${r.kind === 'coin' ? 'coins' : 'stars'} (user reported ${promptDefault}):`;
        const raw = prompt(promptLabel, promptDefault);
        if (raw === null) return; // cancelled
        const n = parseInt(String(raw).trim(), 10);
        if (!Number.isFinite(n) || n <= 0) { toast('Amount must be a positive integer.'); return; }
        approvedAmount = n;
      }
      const note = prompt('Optional admin note (visible to user):') || null;
      // All kinds now follow the same flow: Approve flips status to
      // 'approved'; the actual credit is done manually by the admin
      // (SQL insert into author_earnings / coin_transactions /
      // star_transactions). Once credited, click "Mark as Resolved".
      const valueLabel = r.kind === 'account'
        ? 'account recovery'
        : r.kind === 'earnings'
          ? `₱${approvedAmount}`
          : `${approvedAmount} ${r.kind === 'coin' ? 'coins' : 'stars'}`;
      const confirmMsg = `Approve ${valueLabel} for ${u?.username || 'this user'}?\n\nNo wallet/ledger changes happen yet — credit them manually, then come back and click "Mark as Resolved".`;
      if (!confirm(confirmMsg)) return;

      const { data, error } = await supabase.rpc('approve_balance_recovery_request', {
        p_request_id: r.id,
        p_approved_amount: approvedAmount,
        p_admin_notes: note,
      });
      if (error || data?.ok === false) { toast(error?.message || data?.error || 'Failed'); return; }
      toast(data?.note || 'Approved. Credit manually then mark resolved.');
      loadRecovery();
    });
    card.querySelector('[data-act="mark-resolved"]')?.addEventListener('click', async () => {
      const note = prompt(
        'Optional resolution note (e.g. "Credited via author_earnings row id <uuid>"):',
        '',
      );
      if (note === null) return; // user cancelled the prompt
      if (!confirm(`Mark this ${r.kind} recovery as Resolved for ${u?.username || 'this user'}?\n\nThis records that the credit has actually landed in their account.`)) return;
      const { data, error } = await supabase.rpc('resolve_balance_recovery_request', {
        p_request_id: r.id,
        p_admin_notes: note && note.trim() ? note.trim() : null,
      });
      if (error || data?.ok === false) { toast(error?.message || data?.error || 'Failed'); return; }
      toast('Resolved.');
      loadRecovery();
    });
    card.querySelector('[data-act="reject"]')?.addEventListener('click', async () => {
      const reason = prompt('Reject reason (visible to user — they\'ll see this in the app):');
      if (!reason || !reason.trim()) return;
      const { data, error } = await supabase.rpc('reject_balance_recovery_request', {
        p_request_id: r.id,
        p_reason: reason.trim(),
      });
      if (error || data?.ok === false) { toast(error?.message || data?.error || 'Failed'); return; }
      toast('Rejected.');
      loadRecovery();
    });
    listEl.appendChild(card);
  }
}

// ─── KYC review ─────────────────────────────────────────────────────────
async function loadKycList() {
  const listEl = document.getElementById('kycList');
  const filter = document.getElementById('kycFilter')?.value || 'pending';
  if (!listEl) return;
  listEl.innerHTML = '<div class="admin-empty">Loading…</div>';

  // Match the Withdrawals card's selection so KYC reviewers see the
  // full verification context (phone, address, payment method + the
  // three image attachments) before approving. Reviewing identity
  // without the QR / signature / valid-ID side-by-side is essentially
  // approving blind.
  let q = supabase
    .from('author_kyc')
    .select('user_id, full_name, date_of_birth, id_type, id_number, id_document_url, selfie_url, payment_qr_url, signature_url, payment_method, phone, email, address, status, rejection_reason, submitted_at, reviewed_at')
    .order('submitted_at', { ascending: false })
    .limit(200);
  if (filter !== 'all') q = q.eq('status', filter);

  const { data: rows, error } = await q;
  if (error) { listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`; return; }
  if (!rows?.length) {
    listEl.innerHTML = `<div class="admin-empty">No ${filter} KYC submissions.</div>`;
    return;
  }

  const userIds = [...new Set(rows.map(r => r.user_id))];
  const { data: users } = await supabase.from('profiles')
    .select('id, username, email, avatar_url')
    .in('id', userIds);
  const uMap = Object.fromEntries((users || []).map(u => [u.id, u]));

  // Pre-sign the three image URLs (QR / signature / valid-ID) in
  // parallel. Same pattern as loadPayouts so cards render with usable
  // <img src> in one paint instead of flickering after each card mounts.
  const signTasks = [];
  for (const r of rows) {
    if (r.payment_qr_url && !/^https?:\/\//i.test(r.payment_qr_url)) {
      signTasks.push(_signKycUrl(r.payment_qr_url).then((u) => { r.payment_qr_signed = u; }));
    } else { r.payment_qr_signed = r.payment_qr_url || null; }
    if (r.signature_url && !/^https?:\/\//i.test(r.signature_url)) {
      signTasks.push(_signKycUrl(r.signature_url).then((u) => { r.signature_signed = u; }));
    } else { r.signature_signed = r.signature_url || null; }
    if (r.id_document_url && !/^https?:\/\//i.test(r.id_document_url)) {
      signTasks.push(_signKycUrl(r.id_document_url).then((u) => { r.id_document_signed = u; }));
    } else { r.id_document_signed = r.id_document_url || null; }
  }
  await Promise.all(signTasks);

  listEl.innerHTML = '';
  for (const r of rows) {
    const u = uMap[r.user_id];
    const card = document.createElement('div');
    card.className = `kyc-card kyc-status-${r.status}`;
    // Reuses the .payout-* CSS classes so both cards share the visual
    // language (verify grid + verify-media row of three image cards).
    // Same structure as the loadPayouts card, minus the amount/currency
    // header (KYC review isn't tied to a specific withdrawal amount).
    card.innerHTML = `
      <div class="payout-card-head">
        <div class="payout-author">
          <div class="user-row-avatar">${u?.avatar_url ? `<img src="${esc(u.avatar_url)}"/>` : esc(initials(u?.username || 'U'))}</div>
          <div>
            <div class="payout-author-name">${esc(u?.username || '(unknown)')}</div>
            <div class="payout-author-email">${esc(u?.email || '')}</div>
          </div>
        </div>
        <span class="payout-status-badge payout-status-badge-${r.status}">${esc(r.status)}</span>
      </div>

      <div class="payout-verify">
        <div class="payout-verify-grid">
          <div class="payout-verify-row"><span class="payout-verify-label">Full name</span><span class="payout-verify-val">${esc(r.full_name || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Birthdate</span><span class="payout-verify-val">${esc(_formatBirthdate(r.date_of_birth) || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Phone</span><span class="payout-verify-val">${esc(r.phone || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Email (user)</span><span class="payout-verify-val">${esc(r.email || u?.email || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Method</span><span class="payout-verify-val">${esc(r.payment_method || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">ID type</span><span class="payout-verify-val">${esc(r.id_type || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">ID number</span><span class="payout-verify-val">${esc(r.id_number || '—')}</span></div>
          <div class="payout-verify-row payout-verify-row-wide"><span class="payout-verify-label">Home address</span><span class="payout-verify-val">${esc(r.address || '—')}</span></div>
          <div class="payout-verify-row"><span class="payout-verify-label">Submitted</span><span class="payout-verify-val">${timeAgo(r.submitted_at)}</span></div>
          ${r.reviewed_at ? `<div class="payout-verify-row"><span class="payout-verify-label">Reviewed</span><span class="payout-verify-val">${timeAgo(r.reviewed_at)}</span></div>` : ''}
          ${r.rejection_reason ? `<div class="payout-verify-row payout-verify-row-wide"><span class="payout-verify-label">Rejection reason</span><span class="payout-verify-val">${esc(r.rejection_reason)}</span></div>` : ''}
        </div>

        <div class="payout-verify-media">
          <div class="payout-verify-media-card">
            <div class="payout-verify-media-label">GCash QR</div>
            ${r.payment_qr_signed
              ? `<a href="${esc(r.payment_qr_signed)}" target="_blank" rel="noopener"><img class="payout-verify-img" src="${esc(r.payment_qr_signed)}" alt="GCash QR" loading="lazy"/></a>`
              : `<div class="payout-verify-media-empty">— not provided —</div>`}
          </div>
          <div class="payout-verify-media-card">
            <div class="payout-verify-media-label">Signature</div>
            ${r.signature_signed
              ? `<a href="${esc(r.signature_signed)}" target="_blank" rel="noopener"><img class="payout-verify-img" src="${esc(r.signature_signed)}" alt="Signature" loading="lazy"/></a>`
              : `<div class="payout-verify-media-empty">— not provided —</div>`}
          </div>
          <div class="payout-verify-media-card">
            <div class="payout-verify-media-label">Valid ID</div>
            ${r.id_document_signed
              ? `<a href="${esc(r.id_document_signed)}" target="_blank" rel="noopener"><img class="payout-verify-img" src="${esc(r.id_document_signed)}" alt="Valid ID" loading="lazy"/></a>`
              : `<div class="payout-verify-media-empty">— not provided —</div>`}
          </div>
        </div>
      </div>

      <div class="payout-actions">
        ${r.status === 'pending'
          ? `<button class="admin-btn admin-btn-primary" data-act="kyc-approve">Approve</button>
             <button class="admin-btn admin-btn-danger-ghost" data-act="kyc-reject">Reject</button>`
          : r.status === 'rejected'
            ? `<button class="admin-btn admin-btn-primary" data-act="kyc-approve">Approve anyway</button>`
            : ''}
      </div>
    `;
    card.querySelector('[data-act="kyc-approve"]')?.addEventListener('click', async () => {
      if (!confirm(`Approve KYC for ${u?.username || 'this user'}?`)) return;
      const { data, error } = await supabase.rpc('admin_set_kyc_status', {
        p_user_id: r.user_id, p_status: 'approved', p_reason: null,
      });
      if (error || data?.ok === false) { toast(error?.message || data?.error || 'Failed'); return; }
      toast('KYC approved.');
      loadKycList();
    });
    card.querySelector('[data-act="kyc-reject"]')?.addEventListener('click', async () => {
      const reason = prompt('Reject reason (visible to user):');
      if (!reason) return;
      const { data, error } = await supabase.rpc('admin_set_kyc_status', {
        p_user_id: r.user_id, p_status: 'rejected', p_reason: reason,
      });
      if (error || data?.ok === false) { toast(error?.message || data?.error || 'Failed'); return; }
      toast('KYC rejected.');
      loadKycList();
    });
    listEl.appendChild(card);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SETTINGS — app_config maintenance
// ════════════════════════════════════════════════════════════════════════════
// CRUD over public.app_config. Reads are public (anyone can SELECT) but
// writes require role = 'admin' on profiles. Search filters across keys +
// descriptions; category filter narrows by group. Edits happen inline per
// row and persist with optimistic UI on save.
//
// The key list is the canonical source of truth — mobile + web read this
// same table at session bootstrap. Mobile's lib/global-settings-supabase.js
// (still to be written, Task #63 follow-up) will hit this same table once
// the auth flag flips.

let _settingsRows = [];        // cached after first fetch — supports client-side search
let _settingsDirty = new Map(); // key → { newValue, oldValue } pending save
let _settingsActiveCategory = 'general'; // landing tab; updated when user clicks a sidebar item

// Canonical sidebar order (per product spec). Categories not in this list
// fall through to the end alphabetically. Display labels override the raw
// data values where the casing should differ from the lowercase DB form.
const SETTINGS_CATEGORY_ORDER = [
  'general', 'ads', 'books', 'videos', 'clips', 'earnings',
  'comments', 'engagement', 'misc', 'permissions', 'posts', 'stories',
];
const SETTINGS_CATEGORY_LABELS = {
  general:     'General',
  ads:         'Ads',
  books:       'Books',
  videos:      'Videos',
  clips:       'Clips',
  earnings:    'Earnings',
  comments:    'Comments',
  engagement:  'Engagement',
  misc:        'Misc',
  permissions: 'Permissions',
  posts:       'Posts',
  stories:     'Stories',
  profile:     'Profile',
  wallet:      'Wallet',
};

function initSettingsTab() {
  const search = document.getElementById('settingsSearch');
  if (search) {
    // Re-render on every keystroke. When search has text it overrides the
    // category filter and shows matches across every category; when cleared
    // we drop back to the active category.
    search.addEventListener('input', () => renderSettings());
  }
}

async function loadSettings() {
  const listEl = document.getElementById('settingsList');
  const subEl  = document.getElementById('settingsSubtitle');
  listEl.innerHTML = '<div class="admin-empty">Loading settings…</div>';
  _settingsDirty.clear();

  const { data, error } = await supabase
    .from('app_config')
    .select('key, value, value_type, category, description, updated_at')
    .order('category', { ascending: true })
    .order('key', { ascending: true });

  if (error) {
    listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`;
    if (subEl) subEl.textContent = 'Failed to load';
    return;
  }

  _settingsRows = data || [];
  if (subEl) subEl.textContent = `${_settingsRows.length} keys`;

  // If the previously-active category isn't present in the data, fall back
  // to the first category in CATEGORY_ORDER that exists. Stops the UI from
  // landing on an empty panel when categories get renamed or deleted.
  const presentCats = new Set(_settingsRows.map(r => r.category || 'general'));
  if (!presentCats.has(_settingsActiveCategory)) {
    _settingsActiveCategory = SETTINGS_CATEGORY_ORDER.find(c => presentCats.has(c)) || [...presentCats][0] || 'general';
  }

  renderSettingsSidebar();
  renderSettings();
}

// Build the left-side category sidebar from the distinct categories present
// in _settingsRows. Order is: SETTINGS_CATEGORY_ORDER first (in spec order),
// then any extras alphabetically. Each item shows its key count as a small
// pill; the active one gets the purple gradient treatment.
function renderSettingsSidebar() {
  const sidebar = document.getElementById('settingsSidebar');
  if (!sidebar) return;

  // Count keys per category so the pill matches the actual content.
  const counts = new Map();
  for (const row of _settingsRows) {
    const c = row.category || 'general';
    counts.set(c, (counts.get(c) || 0) + 1);
  }

  // Spec order first, then any unlisted categories alphabetically.
  const ordered = SETTINGS_CATEGORY_ORDER.filter(c => counts.has(c));
  const extras = [...counts.keys()].filter(c => !SETTINGS_CATEGORY_ORDER.includes(c)).sort();
  const allCats = [...ordered, ...extras];

  if (allCats.length === 0) {
    sidebar.innerHTML = '<div class="settings-sidebar-loading">No categories</div>';
    return;
  }

  sidebar.innerHTML = allCats.map(c => {
    const label = SETTINGS_CATEGORY_LABELS[c] || (c.charAt(0).toUpperCase() + c.slice(1));
    const isActive = c === _settingsActiveCategory ? ' is-active' : '';
    return `
      <button class="settings-sidebar-item${isActive}" data-cat="${esc(c)}" type="button">
        <span class="settings-sidebar-label">${esc(label)}</span>
        <span class="settings-sidebar-count">${counts.get(c)}</span>
      </button>
    `;
  }).join('');

  sidebar.querySelectorAll('.settings-sidebar-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.cat;
      if (!next || next === _settingsActiveCategory) return;
      _settingsActiveCategory = next;
      // Clear any lingering search text so the user lands cleanly on the
      // chosen category. Without this, switching categories with stale
      // search text would still show search results, which is confusing.
      const searchEl = document.getElementById('settingsSearch');
      if (searchEl && searchEl.value) searchEl.value = '';
      renderSettingsSidebar();
      renderSettings();
    });
  });
}

function renderSettings() {
  const listEl = document.getElementById('settingsList');
  const search = (document.getElementById('settingsSearch')?.value || '').trim().toLowerCase();

  // Two filtering modes:
  //   • Search mode (text in input): match across ALL categories, ignoring
  //     the sidebar selection. Each match renders with a small purple chip
  //     showing which category it came from.
  //   • Category mode (no search text): show only rows whose category
  //     matches the active sidebar item. No category labels rendered (the
  //     sidebar already shows where you are).
  const inSearchMode = !!search;
  const filtered = _settingsRows.filter(row => {
    const c = row.category || 'general';
    if (inSearchMode) {
      return (
        (row.key || '').toLowerCase().includes(search) ||
        (row.description || '').toLowerCase().includes(search)
      );
    }
    return c === _settingsActiveCategory;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = inSearchMode
      ? `<div class="admin-empty">No settings match "${esc(search)}".</div>`
      : `<div class="admin-empty">No settings in this category yet.</div>`;
    return;
  }

  // Render. Search mode shows category chips inline; single-category mode
  // renders rows flat without any section headers.
  if (inSearchMode) {
    const html = filtered.map(row => {
      const c = row.category || 'general';
      const label = SETTINGS_CATEGORY_LABELS[c] || (c.charAt(0).toUpperCase() + c.slice(1));
      return rowHtml(row, label);
    }).join('');
    listEl.innerHTML = `<div class="settings-rows">${html}</div>`;
  } else {
    listEl.innerHTML = `<div class="settings-rows">${filtered.map(row => rowHtml(row)).join('')}</div>`;
  }

  // Wire inline edit handlers per row.
  listEl.querySelectorAll('[data-setting-key]').forEach(rowEl => {
    const key = rowEl.dataset.settingKey;
    const input = rowEl.querySelector('.settings-input');
    const saveBtn = rowEl.querySelector('[data-act="save"]');
    const resetBtn = rowEl.querySelector('[data-act="reset"]');
    const original = rowEl.dataset.originalValue;

    const markDirty = () => {
      const dirty = input.value !== original;
      rowEl.classList.toggle('settings-row-dirty', dirty);
      if (dirty) {
        _settingsDirty.set(key, { newValue: input.value, oldValue: original });
      } else {
        _settingsDirty.delete(key);
      }
    };

    input.addEventListener('input', markDirty);

    saveBtn?.addEventListener('click', async () => {
      if (input.value === original) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      const ok = await saveSettingValue(key, input.value);
      if (ok) {
        // Reflect persisted value in our cache so re-renders don't undo it.
        const cached = _settingsRows.find(r => r.key === key);
        if (cached) cached.value = input.value;
        rowEl.dataset.originalValue = input.value;
        rowEl.classList.remove('settings-row-dirty');
        _settingsDirty.delete(key);
        toast('Saved.');
      }
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    });

    resetBtn?.addEventListener('click', () => {
      input.value = original;
      markDirty();
    });
  });
}

// Ultra-dense single-line layout. Meta = inline {key, type-chip}, input flex-
// grows in the middle, pinned Reset/Save on the right. The description is no
// longer printed visibly — it's moved into the row's `title=` so hovering the
// row surfaces it as a tooltip. That trade buys us a single ~32px line per
// row instead of the previous two-line stack.
//
// Textareas are still used for arrays, JSON, and long values (>80 chars), but
// their min-height is 1.8rem so the row stays compact on first render and
// only grows when the admin manually drags the resize handle.
//
// `categoryLabel` is optional. When provided (search mode), the row renders
// a small purple chip after the key so the admin can see which category the
// match came from. Omit in single-category mode — the sidebar already
// communicates where they are.
function rowHtml(row, categoryLabel) {
  const valueEsc = esc(row.value ?? '');
  const descEsc = esc(row.description || '');
  const useTextarea = (row.value_type === 'array' || row.value_type === 'json' || (row.value || '').length > 80);
  const inputEl = useTextarea
    ? `<textarea class="settings-input" rows="1">${valueEsc}</textarea>`
    : `<input type="text" class="settings-input" value="${valueEsc}"/>`;
  // Tooltip text combines key + description so hovering the row in any spot
  // surfaces the full context, including the full description that we
  // intentionally don't render to keep the row compact.
  const tipEsc = descEsc ? `${esc(row.key)} — ${descEsc}` : esc(row.key);
  const catChip = categoryLabel ? `<span class="settings-search-cat">${esc(categoryLabel)}</span>` : '';
  return `
    <div class="settings-row" data-setting-key="${esc(row.key)}" data-original-value="${valueEsc}" title="${tipEsc}">
      <div class="settings-row-meta">
        <code class="settings-key">${esc(row.key)}</code>
        <span class="settings-type">${esc(row.value_type)}</span>${catChip}
      </div>
      ${inputEl}
      <div class="settings-row-actions">
        <button class="admin-btn" data-act="reset">Reset</button>
        <button class="admin-btn admin-btn-primary" data-act="save">Save</button>
      </div>
    </div>
  `;
}

// Validate and persist a single setting. Returns true on success, false on
// failure (and toasts the error). Validation is intentionally permissive —
// we trust the admin to know what they're typing. The mobile / web clients
// parse based on value_type, so an invalid value just means clients will
// fall back to defaults.
async function saveSettingValue(key, newValue) {
  const cached = _settingsRows.find(r => r.key === key);
  if (!cached) {
    toast('Unknown setting key.');
    return false;
  }
  // Light type validation — catches the obvious typos (e.g., letters in a
  // number field). Doesn't try to validate JSON / arrays exhaustively.
  if (cached.value_type === 'number' && newValue !== '' && Number.isNaN(Number(newValue))) {
    toast('Value must be a number.');
    return false;
  }
  if (cached.value_type === 'boolean' && !['true', 'false'].includes(newValue.trim().toLowerCase())) {
    toast('Value must be "true" or "false".');
    return false;
  }
  if (cached.value_type === 'array' || cached.value_type === 'json') {
    try {
      JSON.parse(newValue);
    } catch {
      toast(`Value must be valid JSON ${cached.value_type === 'array' ? 'array' : ''}.`);
      return false;
    }
  }

  // Dual-write: write the canonical text `value` AND the matching typed
  // column (value_int / value_bool / value_json) so consumers reading either
  // shape keep working. The hotfix migration added the typed columns
  // because some legacy callers (lib/wallet-supabase.js, lib/earnings-supabase.js
  // on mobile, _walletConfigDefaults bootstrap on web) read value_int directly
  // instead of parsing `value`. Until those callers migrate, the safest behavior
  // is to keep both columns in sync on every save.
  const update = { value: newValue };
  if (cached.value_type === 'number') {
    const n = Number(newValue);
    update.value_int = Number.isFinite(n) ? Math.trunc(n) : null;
  } else if (cached.value_type === 'boolean') {
    update.value_bool = newValue.trim().toLowerCase() === 'true';
  } else if (cached.value_type === 'array' || cached.value_type === 'json') {
    try {
      update.value_json = JSON.parse(newValue);
    } catch {
      // Validation above already toasted; keep value_json untouched on parse error.
    }
  } else {
    update.value_text = newValue;
  }

  const { error } = await supabase
    .from('app_config')
    .update(update)
    .eq('key', key);
  if (error) {
    toast(`Save failed: ${error.message}`);
    return false;
  }

  // Audit log — record the change so /Activity tab shows who changed what.
  // Best-effort; if the insert fails (e.g., admin_actions schema differs in
  // your env), the setting save still succeeds.
  try {
    await supabase.from('admin_actions').insert({
      action: 'app_config_update',
      reason: null,
      note: `Updated app_config[${key}]`,
      admin_id: currentMod?.id,
      metadata: { key, new_value: newValue, value_type: cached.value_type },
    });
  } catch (_) { /* swallow — audit log isn't critical */ }

  return true;
}


// ─── boot ────────────────────────────────────────────────────────────────────
(async () => {
  const ok = await gateAccess();
  if (ok) loadInbox();
})();
