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

// ─── Theme toggle (light ↔ dark) ──────────────────────────────────────
// Premium polish overhaul 2026-05-14. CSS tokens flip via the
// data-theme attribute on <body>; this module just reads/writes the
// preference + swaps the toggle button icon. Persisted in localStorage
// so the choice survives refreshes.
//
// Why we set the attribute BEFORE gateAccess runs (in the IIFE below):
// without it, the page paints in light theme for a frame on every
// refresh of a dark-mode session. Reading localStorage + applying the
// attribute synchronously at file-load time eliminates the flash.
const ADMIN_THEME_KEY = 'selebox_admin_theme';

function _getStoredAdminTheme() {
  try {
    const stored = localStorage.getItem(ADMIN_THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {}
  // No stored preference — honor the OS default.
  if (typeof matchMedia === 'function'
      && matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function _applyAdminTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  // Mirror in the toggle icon so the user can see at a glance what
  // they're about to switch to (sun shown in dark mode means "switch
  // to light", moon shown in light mode means "switch to dark").
  const btn = document.getElementById('adminThemeToggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀' : '☾';
    btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    btn.setAttribute('title',      theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
}

function _toggleAdminTheme() {
  const current = document.body.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(ADMIN_THEME_KEY, next); } catch {}
  _applyAdminTheme(next);
}

// Apply IMMEDIATELY at module load so the first paint is correct.
// gateAccess runs after this so the loading state already has the
// right theme. No flash-of-wrong-theme on dark-mode sessions.
(function _initAdminTheme() {
  _applyAdminTheme(_getStoredAdminTheme());
  // Bind the click handler once. If the button isn't in the DOM yet
  // (rare — script could load before HTML), retry on DOMContentLoaded.
  const bind = () => {
    const btn = document.getElementById('adminThemeToggle');
    if (btn && !btn.dataset.bound) {
      btn.addEventListener('click', _toggleAdminTheme);
      btn.dataset.bound = '1';
      // Re-apply to refresh the icon now that the button exists.
      _applyAdminTheme(_getStoredAdminTheme());
    }
  };
  bind();
  if (!document.getElementById('adminThemeToggle')) {
    document.addEventListener('DOMContentLoaded', bind);
  }
})();


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
// Valid tabs (used by hash-restoration on page load to validate the
// incoming hash before passing it to switchTab).
const VALID_ADMIN_TABS = new Set([
  'inbox', 'users', 'content', 'bans', 'wallet',
  'earnings', 'payouts', 'broadcasts', 'recovery', 'activity', 'settings',
]);

function switchTab(name) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.admin-tab-content').forEach(s => {
    s.style.display = s.dataset.tabContent === name ? 'block' : 'none';
  });

  // Persist the active tab in the URL hash so:
  //   • Page refresh keeps you on the same tab (annoyance fix —
  //     Charles flagged 2026-05-14 that every refresh dumped you back
  //     to Inbox regardless of where you were).
  //   • You can deep-link to a specific tab (`/admin.html#earnings`).
  //   • Browser back/forward navigates between tabs.
  // We use replaceState rather than location.hash assignment so the
  // change doesn't push a new history entry on every tab click (which
  // would mean N back-presses to escape the admin page).
  if (VALID_ADMIN_TABS.has(name)) {
    const newHash = `#${name}`;
    if (window.location.hash !== newHash) {
      history.replaceState(null, '', window.location.pathname + window.location.search + newHash);
    }
  }
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
  // Earnings tab (May 2026 — moderation system). Two sub-views:
  // 'creators' (rollup table) and 'queue' (flagged earnings stub).
  // Init binds the search input + sub-tab clicks once; load fetches
  // page 1 of the rollup.
  if (name === 'earnings') {
    lazyInit(
      'earningsCreatorsSearch',
      typeof initEarningsTab === 'function' ? initEarningsTab : null,
      null,
    );
    if (typeof switchEarningsSubtab === 'function') switchEarningsSubtab('creators');
  }
  if (name === 'recovery') {
    lazyInit('recoveryFilter', typeof initRecoveryTab === 'function' ? initRecoveryTab : null, typeof loadRecovery === 'function' ? loadRecovery : null);
  }
  if (name === 'broadcasts') {
    lazyInit('btnSendBroadcast', typeof initBroadcastsTab === 'function' ? initBroadcastsTab : null, typeof loadBroadcasts === 'function' ? loadBroadcasts : null);
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

// ════════════════════════════════════════════════════════════════════════════
// EARNINGS TAB (May 2026 — moderation + monitoring system)
// ════════════════════════════════════════════════════════════════════════════
// Phase 2.1: Creators rollup (this section).
// Phase 2.2: Creator detail drill-down + action modals (deferred).
// Phase 2.3: Moderation queue stub UI (deferred — Phase 4 populates flags).
//
// Data flow:
//   • _loadEarningsCreators() calls public.admin_earnings_creators_rollup
//     with limit/offset/search, gets one row per creator with all the
//     aggregate metrics already computed server-side.
//   • _renderEarningsCreators() drops them into #earningsCreatorsList.
//   • Pagination is offset-based; state lives in the module-scoped
//     `_earningsCreatorsPage` so Prev/Next can stay in sync.
//   • Search debounces to 300ms to avoid one RPC per keystroke.
// ════════════════════════════════════════════════════════════════════════════

const EARNINGS_CREATORS_PAGE_SIZE = 50;
let _earningsCreatorsPage = 0;       // zero-indexed; 0 = first page
let _earningsCreatorsSearch = '';
let _earningsCreatorsSearchTimer = null;
let _earningsCreatorsHasMore = false;

function initEarningsTab() {
  // Sub-tab clicks (Creators / Moderation queue).
  document.querySelectorAll('[data-tab-content="earnings"] .admin-subtab').forEach((t) => {
    t.addEventListener('click', () => switchEarningsSubtab(t.dataset.subtab));
  });

  // Search input — debounce + reset to page 0 on every keystroke.
  const searchEl = document.getElementById('earningsCreatorsSearch');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      clearTimeout(_earningsCreatorsSearchTimer);
      _earningsCreatorsSearchTimer = setTimeout(() => {
        _earningsCreatorsSearch = searchEl.value.trim();
        _earningsCreatorsPage = 0;
        loadEarningsCreators();
      }, 300);
    });
  }

  // Pagination buttons.
  document.getElementById('earningsCreatorsPrev')?.addEventListener('click', () => {
    if (_earningsCreatorsPage > 0) {
      _earningsCreatorsPage -= 1;
      loadEarningsCreators();
    }
  });
  document.getElementById('earningsCreatorsNext')?.addEventListener('click', () => {
    if (_earningsCreatorsHasMore) {
      _earningsCreatorsPage += 1;
      loadEarningsCreators();
    }
  });

  // ── Queue sub-tab filters + pagination (Phase 4.4) ──────────────────
  document.getElementById('earningsQueueSeverity')?.addEventListener('change', () => {
    _earningsQueuePage = 0;
    loadEarningsQueue();
  });
  document.getElementById('earningsQueueSignal')?.addEventListener('change', () => {
    _earningsQueuePage = 0;
    loadEarningsQueue();
  });
  document.getElementById('earningsQueuePrev')?.addEventListener('click', () => {
    if (_earningsQueuePage > 0) {
      _earningsQueuePage -= 1;
      loadEarningsQueue();
    }
  });
  document.getElementById('earningsQueueNext')?.addEventListener('click', () => {
    if (_earningsQueueHasMore) {
      _earningsQueuePage += 1;
      loadEarningsQueue();
    }
  });
}

function switchEarningsSubtab(name) {
  document.querySelectorAll('[data-tab-content="earnings"] .admin-subtab').forEach((t) => {
    t.classList.toggle('active', t.dataset.subtab === name);
  });
  document.querySelectorAll('[data-tab-content="earnings"] .admin-subtab-content').forEach((s) => {
    s.style.display = s.dataset.subtabContent === name ? 'block' : 'none';
  });
  if (name === 'creators') {
    // Always exit detail view when (re)entering the Creators tab.
    _exitEarningsCreatorDetail();
    loadEarningsCreators();
  }
  if (name === 'queue') {
    // Phase 4.4 — moderation queue. Loads flagged earnings from the
    // admin_earnings_queue_list RPC + applies any active filters.
    _earningsQueuePage = 0;
    loadEarningsQueue();
  }
}

// "2026-05" → "May 2026". Used by the month picker fallback when the
// server's available_months list doesn't already include the currently
// selected month (e.g. on a fresh deploy with no monthly data yet).
function _formatMonthLabel(yyyyMm) {
  if (!yyyyMm) return '';
  const [y, m] = String(yyyyMm).split('-');
  const month = parseInt(m, 10);
  const names = ['January','February','March','April','May','June',
                 'July','August','September','October','November','December'];
  if (!names[month - 1]) return yyyyMm;
  return `${names[month - 1]} ${y}`;
}

// Hide the detail view and re-show the list view. Called whenever
// admin clicks the back button OR re-enters the Earnings tab. Idempotent.
// Also stops the real-time polling loop so we don't keep hitting the
// RPC after the admin has navigated away.
function _exitEarningsCreatorDetail() {
  const detail = document.getElementById('earningsCreatorDetail');
  const listWrap = document.getElementById('earningsCreatorsListWrap');
  if (detail) detail.style.display = 'none';
  if (detail) detail.innerHTML = '';
  if (listWrap) listWrap.style.display = 'block';
  if (_earningsDetailPollTimer) {
    clearInterval(_earningsDetailPollTimer);
    _earningsDetailPollTimer = null;
  }
}

async function loadEarningsCreators() {
  const listEl = document.getElementById('earningsCreatorsList');
  const subEl  = document.getElementById('earningsCreatorsSub');
  const pager  = document.getElementById('earningsCreatorsPager');
  const pagerStatus = document.getElementById('earningsCreatorsPagerStatus');
  const prevBtn = document.getElementById('earningsCreatorsPrev');
  const nextBtn = document.getElementById('earningsCreatorsNext');
  if (!listEl) return;

  listEl.innerHTML = '<div class="admin-empty">Loading creators…</div>';
  if (pager) pager.style.display = 'none';

  const { data, error } = await supabase.rpc('admin_earnings_creators_rollup', {
    p_limit:  EARNINGS_CREATORS_PAGE_SIZE,
    p_offset: _earningsCreatorsPage * EARNINGS_CREATORS_PAGE_SIZE,
    p_search: _earningsCreatorsSearch || null,
  });

  if (error) {
    listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`;
    if (subEl) subEl.textContent = 'Failed to load';
    return;
  }
  if (!data?.ok) {
    listEl.innerHTML = `<div class="admin-empty admin-error">${esc(data?.error || 'Unknown error')}</div>`;
    if (subEl) subEl.textContent = 'Failed to load';
    return;
  }

  const items = data.items || [];
  const totalCount = data.total_count || 0;
  _earningsCreatorsHasMore = !!data.has_more;

  if (subEl) {
    const matchCopy = _earningsCreatorsSearch ? ` matching "${esc(_earningsCreatorsSearch)}"` : '';
    subEl.textContent = `${totalCount} creator${totalCount === 1 ? '' : 's'}${matchCopy}`;
  }

  if (items.length === 0) {
    listEl.innerHTML = `<div class="admin-empty">No creators with earnings${
      _earningsCreatorsSearch ? ` match "${esc(_earningsCreatorsSearch)}".` : ' yet.'
    }</div>`;
    return;
  }

  _renderEarningsCreators(items);

  // Show pager only when there's more than one page worth of data.
  const showPager = _earningsCreatorsPage > 0 || _earningsCreatorsHasMore;
  if (pager) pager.style.display = showPager ? 'flex' : 'none';
  if (prevBtn) prevBtn.disabled = _earningsCreatorsPage === 0;
  if (nextBtn) nextBtn.disabled = !_earningsCreatorsHasMore;
  if (pagerStatus) {
    const from = _earningsCreatorsPage * EARNINGS_CREATORS_PAGE_SIZE + 1;
    const to   = from + items.length - 1;
    pagerStatus.textContent = `Showing ${from}–${to} of ${totalCount}`;
  }
}

// Render the creators rollup as a table. Each row is clickable —
// click → drill down to creator detail (Phase 2.2). For now the
// click handler shows a placeholder; Phase 2.2 replaces the body.
function _renderEarningsCreators(items) {
  const listEl = document.getElementById('earningsCreatorsList');
  if (!listEl) return;

  // Format pesos from minor units (cents → ₱). Returns a string
  // like "₱1,234.50" or "—" for zero.
  const fmtPhp = (minor) => {
    const n = Number(minor) || 0;
    if (n === 0) return '—';
    return `₱${(n / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  // Time-ago string for the "last activity" column. Falls back to "—".
  const fmtAgo = (iso) => {
    if (!iso) return '—';
    try {
      return timeAgo(iso);
    } catch {
      return '—';
    }
  };

  const rows = items.map((row) => {
    const name = esc(row.display_name || row.username || 'Unknown');
    const handle = row.username ? `@${esc(row.username)}` : '';
    const avatar = row.avatar_url
      ? `<img src="${esc(row.avatar_url)}" alt="" class="admin-avatar" />`
      : `<div class="admin-avatar admin-avatar-fallback">${esc(initials(row.display_name || row.username || '?'))}</div>`;

    // Risk badges — payouts_frozen takes precedence over flagged_count.
    let riskBadge = '';
    if (row.payouts_frozen) {
      const reason = row.payouts_frozen_reason ? `: ${esc(row.payouts_frozen_reason)}` : '';
      riskBadge = `<span class="admin-badge admin-badge-danger" title="Payouts frozen${reason}">Frozen</span>`;
    } else if (row.flagged_count > 0) {
      riskBadge = `<span class="admin-badge admin-badge-warn">${row.flagged_count} flag${row.flagged_count === 1 ? '' : 's'}</span>`;
    }

    // Pioneer / role badge for context (Pioneer creators are fee-exempt
    // for withdrawals so admins reviewing payouts want to see this).
    const roleBadge = row.role && row.role !== 'user'
      ? `<span class="admin-badge admin-badge-neutral">${esc(row.role)}</span>`
      : '';

    return `
      <div class="admin-earnings-row" data-author-id="${esc(row.author_id)}" role="button" tabindex="0">
        <div class="admin-earnings-row-identity">
          ${avatar}
          <div class="admin-earnings-row-name">
            <div class="admin-earnings-row-display">${name} ${roleBadge}</div>
            <div class="admin-earnings-row-handle">${handle}</div>
          </div>
          ${riskBadge}
        </div>
        <div class="admin-earnings-row-metrics">
          <div class="admin-earnings-metric">
            <div class="admin-earnings-metric-label">Verified</div>
            <div class="admin-earnings-metric-value admin-earnings-metric-verified">${fmtPhp(row.verified_php_minor)}</div>
          </div>
          <div class="admin-earnings-metric">
            <div class="admin-earnings-metric-label">Pending</div>
            <div class="admin-earnings-metric-value admin-earnings-metric-pending">${fmtPhp(row.pending_php_minor)}</div>
          </div>
          <div class="admin-earnings-metric">
            <div class="admin-earnings-metric-label">Rejected</div>
            <div class="admin-earnings-metric-value admin-earnings-metric-rejected">${fmtPhp(row.rejected_php_minor)}</div>
          </div>
          <div class="admin-earnings-metric">
            <div class="admin-earnings-metric-label">Withdrawn</div>
            <div class="admin-earnings-metric-value">${fmtPhp(row.total_withdrawn_php_minor)}</div>
          </div>
          <div class="admin-earnings-metric">
            <div class="admin-earnings-metric-label">Content</div>
            <div class="admin-earnings-metric-value">${row.content_count || 0}</div>
          </div>
          <div class="admin-earnings-metric">
            <div class="admin-earnings-metric-label">Last unlock</div>
            <div class="admin-earnings-metric-value admin-earnings-metric-time">${fmtAgo(row.latest_unlock_at)}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  listEl.innerHTML = rows;

  // Click + keyboard handler — drills into the creator detail view.
  // Phase 2.2 wires up the actual detail rendering; for now we show
  // a placeholder so the click feels responsive.
  listEl.querySelectorAll('.admin-earnings-row').forEach((rowEl) => {
    const open = () => {
      const authorId = rowEl.dataset.authorId;
      if (authorId) _openEarningsCreatorDetail(authorId);
    };
    rowEl.addEventListener('click', open);
    rowEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 4.4 — Moderation queue (flagged earnings list)
// ════════════════════════════════════════════════════════════════════════════
// Pulls open flags from admin_earnings_queue_list. Each card shows the
// signal evidence + creator + earning context, with one-click actions:
//   Resolve — clears just this flag, doesn't touch the earning
//   Verify  — verifies the earning (auto-resolves all its flags)
//   Reject  — rejects the earning (auto-resolves all its flags)
//   View    — drills into the Creator detail view (Phase 2.2)
// Verify / Reject reuse the modals from Phase 2.2 since the underlying
// RPCs are the same.

const EARNINGS_QUEUE_PAGE_SIZE = 50;
let _earningsQueuePage = 0;
let _earningsQueueHasMore = false;

async function loadEarningsQueue() {
  const listEl = document.getElementById('earningsQueueList');
  const subEl  = document.getElementById('earningsQueueSub');
  const pager  = document.getElementById('earningsQueuePager');
  const prevBtn = document.getElementById('earningsQueuePrev');
  const nextBtn = document.getElementById('earningsQueueNext');
  if (!listEl) return;

  listEl.innerHTML = '<div class="admin-empty">Loading queue…</div>';
  if (pager) pager.style.display = 'none';

  const severity = document.getElementById('earningsQueueSeverity')?.value || null;
  const signal   = document.getElementById('earningsQueueSignal')?.value || null;

  const { data, error } = await supabase.rpc('admin_earnings_queue_list', {
    p_severity:    severity || null,
    p_signal_type: signal || null,
    p_limit:       EARNINGS_QUEUE_PAGE_SIZE,
    p_offset:      _earningsQueuePage * EARNINGS_QUEUE_PAGE_SIZE,
  });

  if (error) {
    listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`;
    if (subEl) subEl.textContent = 'Failed to load';
    return;
  }
  if (!data?.ok) {
    listEl.innerHTML = `<div class="admin-empty admin-error">${esc(data?.error || 'Unknown error')}</div>`;
    if (subEl) subEl.textContent = 'Failed to load';
    return;
  }

  const items = data.items || [];
  const totalCount = data.total_count || 0;
  const sevCounts = data.severity_counts || {};
  _earningsQueueHasMore = !!data.has_more;

  // Update the tab + sub-tab count badges so the moderator can see
  // queue depth at a glance from anywhere in the admin shell.
  _updateEarningsQueueBadges(totalCount);

  if (subEl) {
    const parts = [];
    if (sevCounts.critical) parts.push(`${sevCounts.critical} critical`);
    if (sevCounts.high)     parts.push(`${sevCounts.high} high`);
    if (sevCounts.normal)   parts.push(`${sevCounts.normal} normal`);
    if (sevCounts.low)      parts.push(`${sevCounts.low} low`);
    subEl.textContent = totalCount === 0
      ? 'No flagged earnings.'
      : `${totalCount} open flag${totalCount === 1 ? '' : 's'}${parts.length ? ' · ' + parts.join(', ') : ''}`;
  }

  if (items.length === 0) {
    listEl.innerHTML = `
      <div class="admin-empty">
        <p><strong>${severity || signal ? 'No flagged earnings match the current filter.' : 'No flagged earnings.'}</strong></p>
        ${severity || signal
          ? `<p>Try clearing the filter to see all open flags.</p>`
          : `<p>The hourly detection job runs at *:05 — flags appear here when it finds suspicious activity. Admins can also add manual flags from the Creators tab.</p>`}
      </div>`;
    return;
  }

  _renderEarningsQueue(items);

  const fromIdx = _earningsQueuePage * EARNINGS_QUEUE_PAGE_SIZE + 1;
  const toIdx   = fromIdx + items.length - 1;
  const showPager = _earningsQueuePage > 0 || _earningsQueueHasMore;
  if (pager) pager.style.display = showPager ? 'flex' : 'none';
  if (prevBtn) prevBtn.disabled = _earningsQueuePage === 0;
  if (nextBtn) nextBtn.disabled = !_earningsQueueHasMore;
  const pagerStatus = document.getElementById('earningsQueuePagerStatus');
  if (pagerStatus) pagerStatus.textContent = `Showing ${fromIdx}–${toIdx} of ${totalCount}`;
}

// Update both the top-level Earnings tab badge AND the Moderation queue
// sub-tab badge with the current open-flag count. Hides the badge at 0
// (CSS rule on :empty selector).
function _updateEarningsQueueBadges(count) {
  const tabBadge    = document.getElementById('earningsFlagCount');
  const subBadge    = document.getElementById('earningsQueueCount');
  const value       = count > 0 ? String(count) : '';
  if (tabBadge) tabBadge.textContent = value;
  if (subBadge) subBadge.textContent = value;
}

// Friendly labels for signal_type — keeps the cards readable instead
// of showing snake_case to admins. Falls back to the raw value for
// unknown signals (e.g. admin-defined custom flag types).
const _SIGNAL_LABELS = {
  low_dwell_unlock:      'Low-dwell unlock',
  same_ip_cluster:       'Same-IP cluster',
  unlock_spike:          'Unlock spike',
  multi_account_device:  'Multi-account device',
  rapid_chapter_switch:  'Rapid chapter switching',
  suspicious_topup:      'Suspicious top-up',
  manual_admin:          'Manual admin flag',
  user_report:           'User report',
  external_complaint:    'External complaint',
};

// Render an evidence object as a list of "key: value" strings. The
// evidence shape varies by signal (low_dwell has watched_seconds,
// same_ip_cluster has ip_hash_short, etc) so we just iterate the
// jsonb. Skips internal fields the admin doesn't care about.
const _EVIDENCE_SKIP_KEYS = new Set(['detected_at', 'flagged_by', 'admin_notes', 'flagged_at']);
function _formatEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return '';
  const lines = [];
  for (const [k, v] of Object.entries(evidence)) {
    if (_EVIDENCE_SKIP_KEYS.has(k)) continue;
    if (v == null || v === '') continue;
    let valStr;
    if (typeof v === 'object') {
      valStr = JSON.stringify(v);
    } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      // ISO timestamp — humanize.
      try { valStr = timeAgo(v); } catch { valStr = v; }
    } else {
      valStr = String(v);
    }
    if (valStr.length > 80) valStr = valStr.slice(0, 77) + '…';
    lines.push(`<span class="admin-queue-evidence-pair"><strong>${esc(k.replace(/_/g, ' '))}:</strong> ${esc(valStr)}</span>`);
  }
  return lines.join(' · ');
}

function _renderEarningsQueue(items) {
  const listEl = document.getElementById('earningsQueueList');
  if (!listEl) return;

  const fmtPhp = (minor) => {
    const n = Number(minor) || 0;
    if (n === 0) return '₱0.00';
    return `₱${(n / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  // Use adjusted_net_php_minor when status='adjusted'; otherwise the
  // original net amount. Same rule as the rest of the earnings reads.
  const effectiveMinor = (it) =>
    it.earning_status === 'adjusted' && Number(it.earning_adjusted_net_php_minor) >= 0
      ? Number(it.earning_adjusted_net_php_minor)
      : Number(it.earning_net_php_minor);

  const cards = items.map((it) => {
    const signalLabel = _SIGNAL_LABELS[it.signal_type] || it.signal_type;
    const sevClass = `admin-queue-sev-${esc(it.severity)}`;

    const creatorName = esc(it.author_display_name || it.author_username || 'Unknown');
    const creatorHandle = it.author_username ? `@${esc(it.author_username)}` : '';
    const avatar = it.author_avatar_url
      ? `<img src="${esc(it.author_avatar_url)}" alt="" class="admin-avatar" />`
      : `<div class="admin-avatar admin-avatar-fallback">${esc(initials(it.author_display_name || it.author_username || '?'))}</div>`;

    const frozenBadge = it.author_payouts_frozen
      ? `<span class="admin-badge admin-badge-danger">Frozen</span>`
      : '';

    const sourceTitle = it.earning_source_title
      ? esc(it.earning_source_title)
      : `<em>Unknown ${esc(it.earning_source_type || 'item')}</em>`;

    const statusPill = `<span class="admin-earnings-status admin-earnings-status-${esc(it.earning_status)}">${esc(it.earning_status)}</span>`;
    const evidenceLine = _formatEvidence(it.evidence);

    // Disable Verify/Reject when the earning is in a terminal state
    // the action RPCs wouldn't accept. Resolve always works.
    const isTerminal = ['rejected', 'adjusted', 'withdrawn', 'reversed'].includes(it.earning_status);
    const actionButtons = isTerminal
      ? `<button class="admin-btn admin-btn-secondary admin-queue-action" data-act="resolve" data-flag-id="${esc(it.flag_id)}">Resolve flag</button>
         <button class="admin-btn admin-btn-secondary admin-queue-action" data-act="view" data-author-id="${esc(it.author_id)}">View creator</button>`
      : `<button class="admin-btn admin-btn-primary admin-queue-action" data-act="verify" data-earning-id="${esc(it.earning_id)}">Verify</button>
         <button class="admin-btn admin-btn-danger-ghost admin-queue-action" data-act="reject" data-earning-id="${esc(it.earning_id)}">Reject</button>
         <button class="admin-btn admin-btn-ghost admin-queue-action" data-act="resolve" data-flag-id="${esc(it.flag_id)}">Resolve flag</button>
         <button class="admin-btn admin-btn-secondary admin-queue-action" data-act="view" data-author-id="${esc(it.author_id)}">View creator</button>`;

    return `
      <div class="admin-queue-card ${sevClass}">
        <div class="admin-queue-card-header">
          <div class="admin-queue-signal">
            <span class="admin-queue-signal-label">${esc(signalLabel)}</span>
            <span class="admin-queue-severity">${esc(it.severity)} · +${it.score_delta}pts</span>
          </div>
          <div class="admin-queue-creator">
            ${avatar}
            <div class="admin-queue-creator-name">
              <div class="admin-queue-creator-display">${creatorName} ${frozenBadge}</div>
              <div class="admin-queue-creator-handle">${creatorHandle}</div>
            </div>
          </div>
        </div>
        <div class="admin-queue-card-body">
          <div class="admin-queue-earning">
            <span class="admin-queue-earning-title">${sourceTitle}</span>
            ${statusPill}
            <span class="admin-queue-earning-amount">${fmtPhp(effectiveMinor(it))}</span>
            <span class="admin-queue-earning-risk">Risk: <strong>${it.earning_risk_score || 0}</strong></span>
          </div>
          ${evidenceLine ? `<div class="admin-queue-evidence">${evidenceLine}</div>` : ''}
        </div>
        <div class="admin-queue-card-actions">
          ${actionButtons}
        </div>
      </div>
    `;
  }).join('');

  listEl.innerHTML = cards;

  // Wire up the action buttons. Verify/Reject reuse the Phase 2.2
  // modals via the same RPC paths; Resolve calls admin_resolve_flag
  // directly. View navigates into the Creator detail.
  listEl.querySelectorAll('.admin-queue-action').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'verify') {
        const earningId = btn.dataset.earningId;
        const item = items.find((it) => it.earning_id === earningId);
        if (item) {
          // Build a stub "earning" object that matches the shape
          // _openVerifyConfirm expects (just needs .id).
          _openVerifyConfirm({ id: earningId });
        }
      } else if (act === 'reject') {
        const earningId = btn.dataset.earningId;
        const item = items.find((it) => it.earning_id === earningId);
        if (item) {
          _openRejectModal({
            id:            earningId,
            currency_used: item.earning_currency_used,
            gross_coins:   item.earning_gross_coins,
          });
        }
      } else if (act === 'resolve') {
        const flagId = btn.dataset.flagId;
        if (flagId) await _resolveQueueFlag(flagId);
      } else if (act === 'view') {
        const authorId = btn.dataset.authorId;
        if (authorId) {
          // Jump to the Creators sub-tab + open the detail view.
          switchEarningsSubtab('creators');
          _openEarningsCreatorDetail(authorId);
        }
      }
    });
  });
}

// Resolve a single flag from the queue. Confirms via modal since
// resolving without admin notes is allowed but discouraged.
async function _resolveQueueFlag(flagId) {
  const modal = document.createElement('div');
  modal.className = 'admin-modal-backdrop';
  modal.innerHTML = `
    <div class="admin-modal">
      <h3>Resolve flag</h3>
      <p class="admin-modal-sub">
        Clear this flag from the queue WITHOUT taking action on the
        earning. The earning's risk score will be recomputed. If this
        was the only open flag, the earning becomes eligible for
        auto-promote again.
      </p>
      <div class="admin-form">
        <label>Resolution note (optional)
          <textarea id="resolveNotes" rows="3" placeholder="Why clearing this flag — e.g. false positive, investigated and benign."></textarea>
        </label>
      </div>
      <div class="admin-modal-actions">
        <button class="admin-btn admin-btn-ghost" data-act="cancel">Cancel</button>
        <button class="admin-btn admin-btn-primary" data-act="confirm">Resolve flag</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('[data-act="cancel"]').onclick = close;
  modal.querySelector('[data-act="confirm"]').onclick = async () => {
    const notes = modal.querySelector('#resolveNotes').value.trim() || null;
    const { data, error } = await supabase.rpc('admin_resolve_flag', {
      p_flag_id: flagId,
      p_notes:   notes,
    });
    if (error) { toast(error.message); return; }
    if (!data?.ok) { toast(data?.error || 'Resolve failed'); return; }
    toast('Flag resolved');
    close();
    loadEarningsQueue();
  };
}


// ════════════════════════════════════════════════════════════════════════════
// PHASE 2.2 — Creator detail drill-down + action modals
// ════════════════════════════════════════════════════════════════════════════
// State: which creator is open, current status filter, current page.
// Refreshes triggered by any action so the UI stays consistent with
// the server after Verify / Reject / Adjust / Freeze / Unfreeze.

const EARNINGS_DETAIL_PAGE_SIZE = 25;
// Charles UX overhaul 2026-05-14 — match creator-facing tile semantics
// (Remaining Balance / Under Review / This Month + per-source breakdown)
// and refresh live so admin numbers don't go stale during a session.
const EARNINGS_DETAIL_POLL_MS = 30000;  // 30s real-time refresh
let _earningsDetailAuthorId = null;
let _earningsDetailStatusFilter = null;  // null = all
let _earningsDetailPage = 0;
let _earningsDetailMonth = null;  // 'YYYY-MM' or null = current month
let _earningsDetailPollTimer = null;

async function _openEarningsCreatorDetail(authorId) {
  _earningsDetailAuthorId = authorId;
  _earningsDetailStatusFilter = null;
  _earningsDetailPage = 0;
  _earningsDetailMonth = null;  // reset to current month on each open
  // Stop any previous poll loop before starting fresh.
  if (_earningsDetailPollTimer) {
    clearInterval(_earningsDetailPollTimer);
    _earningsDetailPollTimer = null;
  }
  await _loadEarningsCreatorDetail();
  // Start polling for real-time updates while the detail view is open.
  // _exitEarningsCreatorDetail clears the timer.
  _earningsDetailPollTimer = setInterval(() => {
    // Silent refresh — same loader path; doesn't show the "Loading…"
    // empty state because we pass silent=true.
    _loadEarningsCreatorDetail({ silent: true }).catch(() => {});
  }, EARNINGS_DETAIL_POLL_MS);
}

async function _loadEarningsCreatorDetail(opts = {}) {
  const { silent = false } = opts;
  if (!_earningsDetailAuthorId) return;
  const detail = document.getElementById('earningsCreatorDetail');
  const listWrap = document.getElementById('earningsCreatorsListWrap');
  if (!detail || !listWrap) return;

  listWrap.style.display = 'none';
  detail.style.display = 'block';
  if (!silent) {
    detail.innerHTML = '<div class="admin-empty">Loading creator details…</div>';
  }

  const { data, error } = await supabase.rpc('admin_earnings_creator_detail', {
    p_author_id:     _earningsDetailAuthorId,
    p_status_filter: _earningsDetailStatusFilter,
    p_limit:         EARNINGS_DETAIL_PAGE_SIZE,
    p_offset:        _earningsDetailPage * EARNINGS_DETAIL_PAGE_SIZE,
    p_month_year:    _earningsDetailMonth,
  });

  if (error) {
    if (!silent) {
      detail.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`;
    }
    return;
  }
  if (!data?.ok) {
    if (!silent) {
      detail.innerHTML = `<div class="admin-empty admin-error">${esc(data?.error || 'Failed to load')}</div>`;
    }
    return;
  }
  _renderEarningsCreatorDetail(data);
}

function _renderEarningsCreatorDetail(data) {
  const detail = document.getElementById('earningsCreatorDetail');
  if (!detail) return;

  const p = data.profile || {};
  const s = data.summary || {};
  const earnings = data.earnings || [];
  const withdrawals = data.withdrawals || [];

  const fmtPhp = (minor) => {
    const n = Number(minor) || 0;
    return `₱${(n / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  const fmtAgo = (iso) => { try { return iso ? timeAgo(iso) : '—'; } catch { return '—'; } };
  const fmtDateTime = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch { return '—'; }
  };

  // ── Header (identity + freeze button) ────────────────────────────────
  const displayName = esc(p.display_name || p.username || 'Unknown');
  const handle = p.username ? `@${esc(p.username)}` : '';
  const avatar = p.avatar_url
    ? `<img src="${esc(p.avatar_url)}" alt="" class="admin-avatar admin-avatar-lg" />`
    : `<div class="admin-avatar admin-avatar-lg admin-avatar-fallback">${esc(initials(p.display_name || p.username || '?'))}</div>`;

  const roleBadge = p.role && p.role !== 'user'
    ? `<span class="admin-badge admin-badge-neutral">${esc(p.role)}</span>`
    : '';

  const frozenBadge = p.payouts_frozen
    ? `<span class="admin-badge admin-badge-danger">Payouts frozen</span>`
    : '';

  const freezeBtn = p.payouts_frozen
    ? `<button class="admin-btn admin-btn-ghost" data-act="unfreeze">Unfreeze payouts</button>`
    : `<button class="admin-btn admin-btn-danger-ghost" data-act="freeze">Freeze payouts</button>`;

  const frozenReasonRow = p.payouts_frozen && p.payouts_frozen_reason
    ? `<div class="admin-earnings-detail-frozen">
         <strong>Frozen reason:</strong> ${esc(p.payouts_frozen_reason)}
         ${p.payouts_frozen_at ? `<span class="admin-earnings-detail-frozen-when">· ${fmtAgo(p.payouts_frozen_at)}</span>` : ''}
       </div>`
    : '';

  // ── Summary tiles — creator-facing layout ────────────────────────────
  // Charles UX 2026-05-14: match the Payments → Earnings screen the
  // creator sees on their own account, plus admin-only context tiles.
  //
  // Row 1: Remaining Balance / Under Review / This Month (with month picker)
  // Row 2: Books / Posts / Videos breakdown for the selected month
  // Row 3 (admin-only context): Rejected / Withdrawn / Total Payouts
  //
  // Numbers come from the server RPC's `summary` jsonb which has been
  // extended with remaining_balance_php_minor, under_review_php_minor,
  // this_month_total_php_minor, this_month_breakdown, available_months,
  // selected_month_year.
  const monthBreakdown = s.this_month_breakdown || {};
  const availableMonths = Array.isArray(s.available_months) ? s.available_months : [];
  const selectedMonth = s.selected_month_year || '';

  // Build month-picker options. Always include the selected month at
  // the top even if no rows exist for it (so the picker doesn't go
  // empty after navigating to an unused month).
  const hasSelectedInList = availableMonths.some((m) => m.value === selectedMonth);
  const monthOptions = (hasSelectedInList
    ? availableMonths
    : [{ value: selectedMonth, label: _formatMonthLabel(selectedMonth) }, ...availableMonths]
  ).map((m) =>
    `<option value="${esc(m.value)}"${m.value === selectedMonth ? ' selected' : ''}>${esc(m.label)}</option>`
  ).join('');

  const tilesHtml = `
    <div class="admin-earnings-tiles admin-earnings-tiles-primary">
      <div class="admin-earnings-tile">
        <div class="admin-earnings-tile-label">Total Earnings</div>
        <div class="admin-earnings-tile-value">${fmtPhp(s.total_earnings_php_minor)}</div>
        <div class="admin-earnings-tile-sub">Lifetime gross (remaining + withdrawn)</div>
      </div>
      <div class="admin-earnings-tile admin-earnings-tile-verified">
        <div class="admin-earnings-tile-label">Remaining Balance</div>
        <div class="admin-earnings-tile-value">${fmtPhp(s.remaining_balance_php_minor)}</div>
        <div class="admin-earnings-tile-sub">Available to withdraw</div>
      </div>
      <div class="admin-earnings-tile admin-earnings-tile-pending">
        <div class="admin-earnings-tile-label">Under Review</div>
        <div class="admin-earnings-tile-value">${fmtPhp(s.under_review_php_minor)}</div>
        <div class="admin-earnings-tile-sub">Pending finalization</div>
      </div>
      <div class="admin-earnings-tile">
        <div class="admin-earnings-tile-label admin-earnings-tile-label-with-picker">
          <span>This Month</span>
          <select class="admin-select admin-select-inline" id="earningsDetailMonthPicker">
            ${monthOptions}
          </select>
        </div>
        <div class="admin-earnings-tile-value">${fmtPhp(s.this_month_total_php_minor)}</div>
        <div class="admin-earnings-tile-sub">Finalized in selected month</div>
      </div>
    </div>

    <div class="admin-earnings-tiles admin-earnings-tiles-breakdown">
      <div class="admin-earnings-tile admin-earnings-tile-compact">
        <div class="admin-earnings-tile-label">Books</div>
        <div class="admin-earnings-tile-value">${fmtPhp(monthBreakdown.books)}</div>
      </div>
      <div class="admin-earnings-tile admin-earnings-tile-compact">
        <div class="admin-earnings-tile-label">Posts</div>
        <div class="admin-earnings-tile-value">${fmtPhp(monthBreakdown.posts)}</div>
      </div>
      <div class="admin-earnings-tile admin-earnings-tile-compact">
        <div class="admin-earnings-tile-label">Videos</div>
        <div class="admin-earnings-tile-value">${fmtPhp(monthBreakdown.videos)}</div>
      </div>
    </div>

    <details class="admin-earnings-tiles-secondary">
      <summary>Admin-only context (lifetime)</summary>
      <div class="admin-earnings-tiles admin-earnings-tiles-context">
        <div class="admin-earnings-tile admin-earnings-tile-compact">
          <div class="admin-earnings-tile-label">Verified (all-time)</div>
          <div class="admin-earnings-tile-value">${fmtPhp(s.verified_php_minor)}</div>
        </div>
        <div class="admin-earnings-tile admin-earnings-tile-compact admin-earnings-tile-adjusted">
          <div class="admin-earnings-tile-label">Adjusted</div>
          <div class="admin-earnings-tile-value">${fmtPhp(s.adjusted_php_minor)}</div>
        </div>
        <div class="admin-earnings-tile admin-earnings-tile-compact admin-earnings-tile-rejected">
          <div class="admin-earnings-tile-label">Rejected</div>
          <div class="admin-earnings-tile-value">${fmtPhp(s.rejected_php_minor)}</div>
        </div>
        <div class="admin-earnings-tile admin-earnings-tile-compact">
          <div class="admin-earnings-tile-label">Withdrawn</div>
          <div class="admin-earnings-tile-value">${fmtPhp(s.withdrawn_php_minor)}</div>
        </div>
        <div class="admin-earnings-tile admin-earnings-tile-compact">
          <div class="admin-earnings-tile-label">Total Payouts</div>
          <div class="admin-earnings-tile-value">${fmtPhp(s.total_withdrawn_php_minor)}</div>
          ${s.in_flight_withdrawals_count > 0
            ? `<div class="admin-earnings-tile-sub">${s.in_flight_withdrawals_count} in flight</div>`
            : ''}
        </div>
      </div>
    </details>
  `;

  // ── Status filter chips ──────────────────────────────────────────────
  const filterChips = ['all', 'pending', 'verified', 'adjusted', 'rejected', 'withdrawn', 'reversed'].map((f) => {
    const isActive = (f === 'all' && _earningsDetailStatusFilter === null) ||
                     (f === _earningsDetailStatusFilter);
    return `<button class="admin-chip${isActive ? ' active' : ''}" data-filter="${esc(f)}">${esc(f.charAt(0).toUpperCase() + f.slice(1))}</button>`;
  }).join('');

  // ── Earnings rows table ──────────────────────────────────────────────
  const earningsRowsHtml = earnings.length === 0
    ? `<div class="admin-empty">No earnings rows for this filter.</div>`
    : earnings.map((e) => _renderEarningsDetailRow(e, fmtPhp, fmtDateTime)).join('');

  // ── Withdrawal history ────────────────────────────────────────────────
  const withdrawalsHtml = withdrawals.length === 0
    ? `<div class="admin-empty admin-empty-tiny">No withdrawals yet.</div>`
    : `<table class="admin-earnings-withdrawals-table">
         <thead>
           <tr>
             <th>Requested</th>
             <th>Amount</th>
             <th>Net</th>
             <th>Method</th>
             <th>Status</th>
           </tr>
         </thead>
         <tbody>
           ${withdrawals.map((w) => `
             <tr>
               <td>${fmtDateTime(w.requested_at)}</td>
               <td>${fmtPhp(w.amount_php_minor)}</td>
               <td>${fmtPhp(w.net_php_minor)}</td>
               <td>${esc(w.payout_method || '—')}</td>
               <td><span class="admin-earnings-status admin-earnings-status-${esc(w.status || 'unknown')}">${esc(w.status || 'unknown')}</span></td>
             </tr>
           `).join('')}
         </tbody>
       </table>`;

  // ── Pagination footer ─────────────────────────────────────────────────
  const totalEarnings = data.earnings_count || 0;
  const hasMore = !!data.earnings_has_more;
  const showPager = _earningsDetailPage > 0 || hasMore;
  const fromIdx = _earningsDetailPage * EARNINGS_DETAIL_PAGE_SIZE + 1;
  const toIdx   = fromIdx + earnings.length - 1;
  const pagerHtml = showPager
    ? `<div class="admin-pager">
         <button class="admin-btn admin-btn-secondary" data-act="prev"
                 ${_earningsDetailPage === 0 ? 'disabled' : ''}>← Previous</button>
         <span class="admin-pager-status">${earnings.length ? `Showing ${fromIdx}–${toIdx} of ${totalEarnings}` : ''}</span>
         <button class="admin-btn admin-btn-secondary" data-act="next"
                 ${!hasMore ? 'disabled' : ''}>Next →</button>
       </div>`
    : '';

  // ── Compose detail view ───────────────────────────────────────────────
  detail.innerHTML = `
    <div class="admin-earnings-detail-header">
      <div class="admin-toolbar-left">
        <button class="admin-btn admin-btn-secondary" id="earningsDetailBackBtn">← Back to creators</button>
      </div>
    </div>

    <div class="admin-earnings-detail-identity">
      ${avatar}
      <div class="admin-earnings-detail-name">
        <div class="admin-earnings-detail-display">
          ${displayName} ${roleBadge} ${frozenBadge}
        </div>
        <div class="admin-earnings-detail-handle">${handle}</div>
        ${p.kyc_status ? `<div class="admin-earnings-detail-kyc">KYC: <strong>${esc(p.kyc_status)}</strong></div>` : ''}
      </div>
      <div class="admin-earnings-detail-actions">
        ${freezeBtn}
      </div>
    </div>
    ${frozenReasonRow}

    ${tilesHtml}

    <div class="admin-earnings-detail-section">
      <div class="admin-toolbar">
        <div class="admin-toolbar-left">
          <h3>Earnings rows</h3>
          <span class="admin-toolbar-sub">${totalEarnings} row${totalEarnings === 1 ? '' : 's'} matching filter</span>
        </div>
      </div>
      <div class="admin-chips-row">${filterChips}</div>
      <div class="admin-earnings-rows-list">${earningsRowsHtml}</div>
      ${pagerHtml}
    </div>

    <div class="admin-earnings-detail-section">
      <h3>Recent withdrawals</h3>
      ${withdrawalsHtml}
    </div>
  `;

  // ── Wire up event handlers ────────────────────────────────────────────
  document.getElementById('earningsDetailBackBtn')?.addEventListener('click', _exitEarningsCreatorDetail);

  // Month picker — change resets to page 0 of the earnings list and
  // re-fetches with the new month. Polling continues with the new month.
  document.getElementById('earningsDetailMonthPicker')?.addEventListener('change', (e) => {
    _earningsDetailMonth = e.target.value || null;
    _earningsDetailPage = 0;
    _loadEarningsCreatorDetail();
  });

  // Freeze / Unfreeze.
  detail.querySelectorAll('.admin-earnings-detail-actions [data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'freeze') _openFreezeModal(p);
      else if (act === 'unfreeze') _openUnfreezeModal(p);
    });
  });

  // Status filter chips.
  detail.querySelectorAll('.admin-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const f = chip.dataset.filter;
      _earningsDetailStatusFilter = f === 'all' ? null : f;
      _earningsDetailPage = 0;
      _loadEarningsCreatorDetail();
    });
  });

  // Pagination.
  detail.querySelectorAll('.admin-pager [data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.act === 'prev' && _earningsDetailPage > 0) {
        _earningsDetailPage -= 1;
        _loadEarningsCreatorDetail();
      } else if (btn.dataset.act === 'next' && hasMore) {
        _earningsDetailPage += 1;
        _loadEarningsCreatorDetail();
      }
    });
  });

  // Per-row action buttons (verify / reject / adjust).
  detail.querySelectorAll('.admin-earnings-row-action').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const earningId = btn.dataset.earningId;
      const act = btn.dataset.act;
      const earning = earnings.find((row) => row.id === earningId);
      if (!earning) return;
      if (act === 'verify')      _openVerifyConfirm(earning);
      else if (act === 'reject') _openRejectModal(earning);
      else if (act === 'adjust') _openAdjustModal(earning);
    });
  });
}

// Render one earnings row inside the detail view. Compact horizontal
// card with metadata + per-row action buttons.
function _renderEarningsDetailRow(e, fmtPhp, fmtDateTime) {
  const isTerminal = e.status === 'rejected' || e.status === 'adjusted'
                  || e.status === 'withdrawn' || e.status === 'reversed';

  // Net amount with adjusted overlay when applicable.
  const effectiveMinor = e.status === 'adjusted' && Number(e.adjusted_net_php_minor) >= 0
    ? Number(e.adjusted_net_php_minor)
    : Number(e.net_php_minor);

  const adjustedNote = e.status === 'adjusted' && Number(e.adjusted_net_php_minor) !== Number(e.net_php_minor)
    ? `<span class="admin-earnings-row-strike">${fmtPhp(e.net_php_minor)}</span>`
    : '';

  // Currency icon — coin or star.
  const currIcon = e.currency_used === 'star' ? '⭐' : '🪙';

  // Source title fallback.
  const title = e.source_title
    ? esc(e.source_title)
    : `<em>Unknown ${esc(e.source_type)}</em>`;

  // Status pill.
  const statusPill = `<span class="admin-earnings-status admin-earnings-status-${esc(e.status)}">${esc(e.status)}</span>`;

  // Refund indicator on rejected rows.
  const refundFlag = e.refund_issued
    ? `<span class="admin-badge admin-badge-neutral" title="Unlocker was refunded">Refunded</span>`
    : '';

  // Earmarked-to-withdrawal indicator.
  const earmarkFlag = e.withdrawal_id
    ? `<span class="admin-badge admin-badge-neutral" title="Earmarked to withdrawal ${e.withdrawal_id}">Earmarked</span>`
    : '';

  // Action buttons — only for non-terminal states.
  const actions = isTerminal
    ? `<div class="admin-earnings-row-actions">
         ${e.reviewed_at
           ? `<span class="admin-earnings-row-reviewed">Reviewed ${fmtDateTime(e.reviewed_at)}</span>`
           : ''}
       </div>`
    : `<div class="admin-earnings-row-actions">
         <button class="admin-earnings-row-action admin-btn admin-btn-primary"
                 data-act="verify" data-earning-id="${esc(e.id)}">Verify</button>
         <button class="admin-earnings-row-action admin-btn admin-btn-ghost"
                 data-act="adjust" data-earning-id="${esc(e.id)}">Adjust</button>
         <button class="admin-earnings-row-action admin-btn admin-btn-danger-ghost"
                 data-act="reject" data-earning-id="${esc(e.id)}">Reject</button>
       </div>`;

  // Review notes shown on terminal rows so admins see why the decision was made.
  const notesRow = e.review_notes
    ? `<div class="admin-earnings-row-notes">📝 ${esc(e.review_notes)}</div>`
    : '';

  return `
    <div class="admin-earnings-detail-row">
      <div class="admin-earnings-detail-row-meta">
        <div class="admin-earnings-detail-row-title">
          ${currIcon} ${title}
        </div>
        <div class="admin-earnings-detail-row-sub">
          ${statusPill} ${refundFlag} ${earmarkFlag}
          <span class="admin-earnings-detail-row-time">· created ${fmtDateTime(e.created_at)}</span>
          ${e.status === 'pending' && e.available_at
            ? `<span class="admin-earnings-detail-row-time">· clears ${fmtDateTime(e.available_at)}</span>`
            : ''}
        </div>
        ${notesRow}
      </div>
      <div class="admin-earnings-detail-row-amount">
        <div class="admin-earnings-detail-row-amount-value">
          ${adjustedNote} ${fmtPhp(effectiveMinor)}
        </div>
        <div class="admin-earnings-detail-row-amount-sub">
          ${e.gross_coins} ${e.currency_used === 'star' ? 'star' : 'coin'}${e.gross_coins === 1 ? '' : 's'} gross
        </div>
      </div>
      ${actions}
    </div>
  `;
}

// ─── Action modals ───────────────────────────────────────────────────────────

// VERIFY — one-click action since it's the safe path. Confirms via
// a minimal modal so the admin doesn't fat-finger it.
function _openVerifyConfirm(earning) {
  const modal = document.createElement('div');
  modal.className = 'admin-modal-backdrop';
  modal.innerHTML = `
    <div class="admin-modal">
      <h3>Verify earning</h3>
      <p class="admin-modal-sub">
        Mark this earning as verified and skip the 7-day hold. The amount
        will become available to the creator's withdrawal balance immediately.
      </p>
      <div class="admin-form">
        <label>Notes (optional)
          <textarea id="verifyNotes" rows="2" placeholder="Why verifying early — e.g. high-confidence creator, manual review passed."></textarea>
        </label>
      </div>
      <div class="admin-modal-actions">
        <button class="admin-btn admin-btn-ghost" data-act="cancel">Cancel</button>
        <button class="admin-btn admin-btn-primary" data-act="confirm">Verify now</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('[data-act="cancel"]').onclick = close;
  modal.querySelector('[data-act="confirm"]').onclick = async () => {
    const notes = modal.querySelector('#verifyNotes').value.trim() || null;
    const { data, error } = await supabase.rpc('admin_verify_earning', {
      p_earning_id: earning.id,
      p_notes:      notes,
    });
    if (error) { toast(error.message); return; }
    if (!data?.ok) { toast(data?.error || 'Verify failed'); return; }
    toast(data.already_verified ? 'Already verified' : 'Earning verified');
    close();
    _loadEarningsCreatorDetail();
  };
}

// REJECT — modal with required notes + refund toggle. The refund
// option credits the unlocker's wallet for the original payment.
function _openRejectModal(earning) {
  const modal = document.createElement('div');
  modal.className = 'admin-modal-backdrop';
  const currencyLabel = earning.currency_used === 'star' ? 'stars' : 'coins';
  modal.innerHTML = `
    <div class="admin-modal">
      <h3>Reject earning</h3>
      <p class="admin-modal-sub">
        Mark this earning as rejected. The creator will NOT receive the credit.
        Optionally refund the unlocker — credits ${esc(earning.gross_coins?.toString() || '0')} ${currencyLabel} back to their wallet.
      </p>
      <div class="admin-form">
        <label>Reason (required)
          <textarea id="rejectNotes" rows="3" placeholder="Why rejecting — e.g. bot-like unlock pattern, same-IP cluster, manual fraud report." required></textarea>
        </label>
        <label class="admin-checkbox">
          <input id="rejectRefund" type="checkbox"/>
          Also refund the unlocker (${esc(earning.gross_coins?.toString() || '0')} ${currencyLabel})
        </label>
      </div>
      <div class="admin-modal-actions">
        <button class="admin-btn admin-btn-ghost" data-act="cancel">Cancel</button>
        <button class="admin-btn admin-btn-danger-ghost" data-act="confirm">Reject earning</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('[data-act="cancel"]').onclick = close;
  modal.querySelector('[data-act="confirm"]').onclick = async () => {
    const notes = modal.querySelector('#rejectNotes').value.trim();
    const refund = modal.querySelector('#rejectRefund').checked;
    if (!notes) { toast('Reason is required'); return; }
    const { data, error } = await supabase.rpc('admin_reject_earning', {
      p_earning_id:      earning.id,
      p_notes:           notes,
      p_refund_unlocker: refund,
    });
    if (error) { toast(error.message); return; }
    if (!data?.ok) { toast(data?.error || 'Reject failed'); return; }
    toast(data.refund_issued ? 'Earning rejected + unlocker refunded' : 'Earning rejected');
    close();
    _loadEarningsCreatorDetail();
  };
}

// ADJUST — modal accepting a new ₱ amount lower than the original.
// Server validates the cap; we pre-validate client-side for UX.
function _openAdjustModal(earning) {
  const modal = document.createElement('div');
  modal.className = 'admin-modal-backdrop';
  const originalPesos = (Number(earning.net_php_minor) || 0) / 100;
  modal.innerHTML = `
    <div class="admin-modal">
      <h3>Adjust earning</h3>
      <p class="admin-modal-sub">
        Reduce the credited amount. The creator's balance will reflect the new
        value; the original amount stays for the audit trail. Cannot adjust upward —
        use Reject + re-credit if the original was too low.
      </p>
      <div class="admin-form">
        <div class="admin-form-row">
          <label>Original
            <input type="text" value="₱${originalPesos.toFixed(2)}" disabled/>
          </label>
          <label>New amount (₱)
            <input id="adjustAmount" type="number" step="0.01" min="0" max="${originalPesos}" placeholder="0.00"/>
          </label>
        </div>
        <label>Reason (required)
          <textarea id="adjustNotes" rows="3" placeholder="Why adjusting — e.g. partial fraud confirmed, partial chargeback." required></textarea>
        </label>
      </div>
      <div class="admin-modal-actions">
        <button class="admin-btn admin-btn-ghost" data-act="cancel">Cancel</button>
        <button class="admin-btn admin-btn-primary" data-act="confirm">Adjust earning</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('[data-act="cancel"]').onclick = close;
  modal.querySelector('[data-act="confirm"]').onclick = async () => {
    const newPesos = parseFloat(modal.querySelector('#adjustAmount').value);
    const notes = modal.querySelector('#adjustNotes').value.trim();
    if (!notes) { toast('Reason is required'); return; }
    if (!Number.isFinite(newPesos) || newPesos < 0) { toast('Enter a valid amount'); return; }
    if (newPesos > originalPesos) { toast(`Cannot adjust above original (₱${originalPesos.toFixed(2)})`); return; }
    const newMinor = Math.round(newPesos * 100);
    const { data, error } = await supabase.rpc('admin_adjust_earning', {
      p_earning_id:        earning.id,
      p_new_net_php_minor: newMinor,
      p_notes:             notes,
    });
    if (error) { toast(error.message); return; }
    if (!data?.ok) { toast(data?.error || 'Adjust failed'); return; }
    toast(`Adjusted to ₱${(newMinor / 100).toFixed(2)}`);
    close();
    _loadEarningsCreatorDetail();
  };
}

// FREEZE — modal asking for a reason. Mirrors the unfreeze flow but
// requires a reason so the freeze is auditable.
function _openFreezeModal(profile) {
  const modal = document.createElement('div');
  modal.className = 'admin-modal-backdrop';
  modal.innerHTML = `
    <div class="admin-modal">
      <h3>Freeze payouts</h3>
      <p class="admin-modal-sub">
        Suspend withdrawals for <strong>${esc(profile.display_name || profile.username || 'this creator')}</strong>.
        They'll see a "payouts on hold" error when attempting a withdrawal.
        Existing approved/paid withdrawals are NOT affected — this is a
        forward-looking gate only.
      </p>
      <div class="admin-form">
        <label>Reason (required, shown to the creator)
          <textarea id="freezeReason" rows="3" placeholder="e.g. Pending fraud review — please contact support."></textarea>
        </label>
      </div>
      <div class="admin-modal-actions">
        <button class="admin-btn admin-btn-ghost" data-act="cancel">Cancel</button>
        <button class="admin-btn admin-btn-danger-ghost" data-act="confirm">Freeze payouts</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('[data-act="cancel"]').onclick = close;
  modal.querySelector('[data-act="confirm"]').onclick = async () => {
    const reason = modal.querySelector('#freezeReason').value.trim();
    if (!reason) { toast('Reason is required'); return; }
    const { data, error } = await supabase.rpc('admin_freeze_payouts', {
      p_user_id: profile.id,
      p_reason:  reason,
    });
    if (error) { toast(error.message); return; }
    if (!data?.ok) { toast(data?.error || 'Freeze failed'); return; }
    toast('Payouts frozen');
    close();
    _loadEarningsCreatorDetail();
  };
}

// UNFREEZE — minimal modal. Note optional but recorded if entered.
function _openUnfreezeModal(profile) {
  const modal = document.createElement('div');
  modal.className = 'admin-modal-backdrop';
  modal.innerHTML = `
    <div class="admin-modal">
      <h3>Unfreeze payouts</h3>
      <p class="admin-modal-sub">
        Restore withdrawal access for <strong>${esc(profile.display_name || profile.username || 'this creator')}</strong>.
      </p>
      <div class="admin-form">
        <label>Note (optional)
          <textarea id="unfreezeNote" rows="2" placeholder="Why clearing the freeze — e.g. review concluded, no action needed."></textarea>
        </label>
      </div>
      <div class="admin-modal-actions">
        <button class="admin-btn admin-btn-ghost" data-act="cancel">Cancel</button>
        <button class="admin-btn admin-btn-primary" data-act="confirm">Unfreeze payouts</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('[data-act="cancel"]').onclick = close;
  modal.querySelector('[data-act="confirm"]').onclick = async () => {
    const note = modal.querySelector('#unfreezeNote').value.trim() || null;
    const { data, error } = await supabase.rpc('admin_unfreeze_payouts', {
      p_user_id: profile.id,
      p_note:    note,
    });
    if (error) { toast(error.message); return; }
    if (!data?.ok) { toast(data?.error || 'Unfreeze failed'); return; }
    toast('Payouts unfrozen');
    close();
    _loadEarningsCreatorDetail();
  };
}


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

  // KYC list (compact directory) search input — debounced 300ms so each
  // keystroke doesn't fire its own server round-trip. Reads its value
  // from the DOM at call time so we don't need to thread state through.
  let _kycListSearchTimer = null;
  document.getElementById('kycListSearch')?.addEventListener('input', () => {
    clearTimeout(_kycListSearchTimer);
    _kycListSearchTimer = setTimeout(() => loadKycListSimple(), 300);
  });
}

function switchPayoutsSubtab(name) {
  document.querySelectorAll('[data-tab-content="payouts"] .admin-subtab').forEach(t => t.classList.toggle('active', t.dataset.subtab === name));
  document.querySelectorAll('[data-tab-content="payouts"] .admin-subtab-content').forEach(s => {
    s.style.display = s.dataset.subtabContent === name ? 'block' : 'none';
  });
  if (name === 'withdrawals')    loadPayouts();
  if (name === 'kyc')            loadKycList();
  if (name === 'changerequests') loadChangeRequests();
  // Compact "KYC list" subtab — approved-only directory. See
  // loadKycListSimple() below; same admin_kyc_list RPC as the
  // full KYC review surface, just rendered as one-line rows.
  if (name === 'kyclist')        loadKycListSimple();
}

// ════════════════════════════════════════════════════════════════════════
// KYC list (compact directory) — approved-only, single-line rows.
//
// The "KYC review" subtab is for reviewers verifying documents on
// pending submissions. This one's for the everyday "who's approved
// already?" lookup. Uses the same admin_kyc_list RPC, scoped to
// status='approved', and reads the search box server-side so very
// long lists stay fast (admin_kyc_list runs the ILIKE filter against
// username + display_name + full_name + email in one query).
//
// No row-level actions on this view — it's read-only by design.
// Admins who need to freeze/ban/revoke from here can switch over to
// the KYC review tab and pull up the same user there.
// ════════════════════════════════════════════════════════════════════════
async function loadKycListSimple() {
  const rowsEl  = document.getElementById('kycListRows');
  const countEl = document.getElementById('kycListCount');
  const search  = document.getElementById('kycListSearch')?.value?.trim() || '';
  if (!rowsEl) return;

  rowsEl.innerHTML = `<div class="kyc-list-empty">Loading…</div>`;
  if (countEl) countEl.textContent = '';

  const { data: rows, error } = await supabase.rpc('admin_kyc_list', {
    p_status: 'approved',
    p_search: search || null,
    p_limit:  200,
    p_offset: 0,
  });

  if (error) {
    rowsEl.innerHTML = `<div class="kyc-list-empty admin-error">${esc(error.message)}</div>`;
    return;
  }
  if (!rows?.length) {
    rowsEl.innerHTML = `<div class="kyc-list-empty">${search ? 'No approved KYCs match your search.' : 'No approved KYCs yet.'}</div>`;
    if (countEl) countEl.textContent = '0 results';
    return;
  }

  // total_count is the same on every row (window function over the
  // filtered set). Use it for the toolbar counter so the user can see
  // when their search matched a subset of a much larger directory.
  const total = Number(rows[0].total_count || rows.length);
  if (countEl) {
    countEl.textContent = total > rows.length
      ? `Showing ${rows.length} of ${total}`
      : `${total} approved`;
  }

  rowsEl.innerHTML = rows.map(r => {
    const display  = esc(r.display_name || r.full_name || r.username || 'unnamed');
    const handle   = r.username ? `@${esc(r.username)}` : '';
    const email    = esc(r.email || '—');
    // Approved date — small meta on the right so reviewers can sort
    // mentally without an extra column. Locale set to en-PH to match
    // the rest of the admin shell's date formatting.
    const approvedAt = r.approved_at
      ? new Date(r.approved_at).toLocaleDateString('en-PH', { dateStyle: 'medium' })
      : '—';
    // data-uid carries the author_id so the row click handler below
    // (delegated, attached at module load) can open the detail modal
    // without rebinding listeners on every reload.
    return `
      <div class="kyc-list-row" data-uid="${esc(r.author_id)}" role="button" tabindex="0">
        <div class="kyc-list-name">${display}</div>
        <div class="kyc-list-handle">${handle}</div>
        <div class="kyc-list-email" title="${email}">${email}</div>
        <div class="kyc-list-meta">${esc(approvedAt)}</div>
      </div>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════════════════
// KYC detail modal — opened when a row in the KYC list is clicked.
// Fetches the single user's full record + docs, signs the three image
// URLs, and renders the same verification card the KYC review tab uses.
// All security-action buttons inside the card use data-act="kyc-..."
// which the global delegated handler (broadened below) catches whether
// the button is in #kycList or in #kycDetailBody.
// ════════════════════════════════════════════════════════════════════════
async function openKycDetailModal(authorId) {
  const backdrop = document.getElementById('kycDetailBackdrop');
  const body     = document.getElementById('kycDetailBody');
  if (!backdrop || !body) return;

  // Show the modal immediately with a loading state so the user gets
  // visual feedback even if the network is slow. Backdrop alone is
  // already styled as the overlay; body holds the populated card.
  body.innerHTML = `<div class="admin-empty" style="padding:3rem;text-align:center">Loading details…</div>`;
  backdrop.style.display = 'grid';

  try {
    // Two parallel reads: the admin_kyc_list row (with role + freeze +
    // ban + viewer_is_super_admin), and the author_kyc raw row (with
    // doc URLs + phone + address). admin_kyc_list filters by status,
    // so search by username/email instead — but since we're targeting
    // a specific author_id, fetch the full approved page and pick the
    // matching row. (Cheaper than adding a per-uuid RPC.)
    const [{ data: rows, error: listErr }, { data: docs, error: docsErr }, { data: avatarRow }] = await Promise.all([
      supabase.rpc('admin_kyc_list', { p_status: 'all', p_search: null, p_limit: 200, p_offset: 0 }),
      supabase.from('author_kyc')
        .select('user_id, date_of_birth, id_type, id_number, id_document_url, selfie_url, payment_qr_url, signature_url, payment_method, phone, address, submitted_at')
        .eq('user_id', authorId)
        .maybeSingle(),
      supabase.from('profiles').select('avatar_url').eq('id', authorId).maybeSingle(),
    ]);

    if (listErr) { body.innerHTML = `<div class="admin-empty admin-error">${esc(listErr.message)}</div>`; return; }
    const r = (rows || []).find(x => x.author_id === authorId);
    if (!r) { body.innerHTML = `<div class="admin-empty">User not found in KYC list.</div>`; return; }

    const viewerIsSuperAdmin = Boolean(r.viewer_is_super_admin);
    const avatar = avatarRow?.avatar_url || null;

    // Stash docs + sign image URLs on r — same shape as loadKycList
    // pre-processes for its row loop. _renderKycCardInnerHTML expects
    // r._docs + r.payment_qr_signed + r.signature_signed +
    // r.id_document_signed.
    r._docs = docs || {};
    const signTasks = [];
    const d = r._docs;
    if (d.payment_qr_url && !/^https?:\/\//i.test(d.payment_qr_url)) {
      signTasks.push(_signKycUrl(d.payment_qr_url).then((u) => { r.payment_qr_signed = u; }));
    } else { r.payment_qr_signed = d.payment_qr_url || null; }
    if (d.signature_url && !/^https?:\/\//i.test(d.signature_url)) {
      signTasks.push(_signKycUrl(d.signature_url).then((u) => { r.signature_signed = u; }));
    } else { r.signature_signed = d.signature_url || null; }
    if (d.id_document_url && !/^https?:\/\//i.test(d.id_document_url)) {
      signTasks.push(_signKycUrl(d.id_document_url).then((u) => { r.id_document_signed = u; }));
    } else { r.id_document_signed = d.id_document_url || null; }
    await Promise.all(signTasks);

    body.innerHTML = _renderKycCardInnerHTML(r, viewerIsSuperAdmin, avatar);
  } catch (err) {
    body.innerHTML = `<div class="admin-empty admin-error">${esc(err?.message || String(err))}</div>`;
  }
}

function closeKycDetailModal() {
  const backdrop = document.getElementById('kycDetailBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}

// One-time wiring (module load): row clicks → open modal; close
// button + backdrop click + Escape → close modal. Delegated so it
// survives rowsEl.innerHTML re-renders on every search keystroke.
document.addEventListener('click', (e) => {
  // Row click (inside the KYC list directory)
  const row = e.target.closest('#kycListRows .kyc-list-row[data-uid]');
  if (row) {
    openKycDetailModal(row.dataset.uid);
    return;
  }
  // Close button (× in the modal corner)
  if (e.target.closest('#kycDetailClose')) {
    closeKycDetailModal();
    return;
  }
  // Backdrop click — only if the click landed on the backdrop itself,
  // not on the modal card inside it. closest('.admin-modal') being
  // null means the click went through the empty area.
  if (e.target.id === 'kycDetailBackdrop') {
    closeKycDetailModal();
  }
});

// Keyboard: Escape closes the modal when it's visible.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const bd = document.getElementById('kycDetailBackdrop');
  if (bd && bd.style.display !== 'none') closeKycDetailModal();
});

// Row click via keyboard (Enter/Space when role=button row is focused)
// for accessibility. Same destination as the click path.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest?.('#kycListRows .kyc-list-row[data-uid]');
  if (row) { e.preventDefault(); openKycDetailModal(row.dataset.uid); }
});

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

  // Pull the bulk metadata via admin_kyc_list RPC (gated by
  // is_earnings_admin server-side). This gives us role + freeze + ban
  // flags + viewer_is_super_admin in one round-trip — exactly what
  // the security-actions buttons need. We also read directly from
  // author_kyc for the document URLs / phone / address that the
  // pending-review card displays, since admin_kyc_list deliberately
  // doesn't expose private images for non-pending rows. Both calls
  // run in parallel.
  const listPromise = supabase.rpc('admin_kyc_list', {
    p_status: filter, p_search: null, p_limit: 200, p_offset: 0,
  });
  const docsPromise = (async () => {
    // Real schema uses user_id (not author_id) and status (not kyc_status).
    // We alias user_id → author_id below so the rest of the render code
    // can keep using r.author_id consistently with what admin_kyc_list
    // returns.
    let q = supabase.from('author_kyc')
      .select('user_id, date_of_birth, id_type, id_number, id_document_url, selfie_url, payment_qr_url, signature_url, payment_method, phone, address, submitted_at')
      .order('submitted_at', { ascending: false })
      .limit(200);
    if (filter !== 'all') q = q.eq('status', filter);
    return q;
  })();

  const [{ data: rows, error }, { data: docs }] = await Promise.all([listPromise, docsPromise]);
  if (error) { listEl.innerHTML = `<div class="admin-empty admin-error">${esc(error.message)}</div>`; return; }
  if (!rows?.length) {
    listEl.innerHTML = `<div class="admin-empty">No ${filter} KYC submissions.</div>`;
    return;
  }

  // Index docs by user_id (the real column name) for O(1) lookup
  // during the row loop. The keys map to admin_kyc_list's r.author_id
  // alias because both reference the same uuid (the author's profile id).
  // Fall back to an empty object if the secondary fetch failed — the
  // row still renders with no document images.
  const docsMap = Object.fromEntries((docs || []).map(d => [d.user_id, d]));

  // Capture the viewer's super-admin flag once (it's the same on every
  // row). Drives whether the "Change role" button renders. Server-side
  // admin_set_user_role re-checks via is_super_admin, so DOM tampering
  // by a moderator still hits 42501.
  const viewerIsSuperAdmin = Boolean(rows[0]?.viewer_is_super_admin);

  // No need for the per-author profiles fetch any more — admin_kyc_list
  // already joins username/display_name/email/role/freeze/ban into the
  // returned shape. Keep an avatar fetch since we still want avatars
  // in the card head (admin_kyc_list doesn't return avatar_url).
  const userIds = [...new Set(rows.map(r => r.author_id))];
  const { data: avatars } = await supabase.from('profiles')
    .select('id, avatar_url')
    .in('id', userIds);
  const aMap = Object.fromEntries((avatars || []).map(a => [a.id, a.avatar_url]));

  // Pre-sign the three image URLs (QR / signature / valid-ID) in
  // parallel. Same pattern as loadPayouts so cards render with usable
  // <img src> in one paint instead of flickering after each card mounts.
  // Doc URLs come from docsMap (the secondary author_kyc fetch).
  const signTasks = [];
  for (const r of rows) {
    const d = docsMap[r.author_id] || {};
    r._docs = d;
    if (d.payment_qr_url && !/^https?:\/\//i.test(d.payment_qr_url)) {
      signTasks.push(_signKycUrl(d.payment_qr_url).then((u) => { r.payment_qr_signed = u; }));
    } else { r.payment_qr_signed = d.payment_qr_url || null; }
    if (d.signature_url && !/^https?:\/\//i.test(d.signature_url)) {
      signTasks.push(_signKycUrl(d.signature_url).then((u) => { r.signature_signed = u; }));
    } else { r.signature_signed = d.signature_url || null; }
    if (d.id_document_url && !/^https?:\/\//i.test(d.id_document_url)) {
      signTasks.push(_signKycUrl(d.id_document_url).then((u) => { r.id_document_signed = u; }));
    } else { r.id_document_signed = d.id_document_url || null; }
  }
  await Promise.all(signTasks);

  listEl.innerHTML = '';
  for (const r of rows) {
    const card = document.createElement('div');
    card.className = `kyc-card kyc-status-${r.kyc_status}`;
    card.innerHTML = _renderKycCardInnerHTML(r, viewerIsSuperAdmin, aMap[r.author_id]);
    listEl.appendChild(card);
  }
}

// ════════════════════════════════════════════════════════════════════════
// Shared card builder — used by both the KYC review tab (full list) AND
// the KYC list directory's per-row click modal. Centralizing the HTML
// here means one source of truth for the verification card layout +
// the security action button row. Caller must have already signed the
// three document URLs (payment_qr_signed, signature_signed,
// id_document_signed) and attached them to `r`, plus stashed the
// secondary author_kyc record at `r._docs`.
// ════════════════════════════════════════════════════════════════════════
function _renderKycCardInnerHTML(r, viewerIsSuperAdmin, avatar) {
  const username = r.username || '(unknown)';
  const d        = r._docs || {};
  const uid      = r.author_id;

  const secBtns = [];
  if (r.kyc_status === 'pending' || r.kyc_status === 'rejected') {
    secBtns.push(`<button class="admin-btn admin-btn-primary" data-act="kyc-approve" data-uid="${uid}">Approve KYC</button>`);
  }
  if (r.kyc_status === 'pending' || r.kyc_status === 'approved') {
    secBtns.push(`<button class="admin-btn admin-btn-danger-ghost" data-act="kyc-reject" data-uid="${uid}">Reject</button>`);
  }
  if (r.kyc_status === 'approved') {
    secBtns.push(`<button class="admin-btn admin-btn-danger-ghost" data-act="kyc-revoke" data-uid="${uid}">Revoke</button>`);
  }
  if (r.payouts_frozen) {
    secBtns.push(`<button class="admin-btn" data-act="kyc-unfreeze" data-uid="${uid}">Unfreeze payouts</button>`);
  } else {
    secBtns.push(`<button class="admin-btn admin-btn-danger-ghost" data-act="kyc-freeze" data-uid="${uid}">Freeze payouts</button>`);
  }
  if (r.is_banned) {
    secBtns.push(`<button class="admin-btn" data-act="kyc-unban" data-uid="${uid}">Unban</button>`);
  } else {
    secBtns.push(`<button class="admin-btn admin-btn-danger-ghost" data-act="kyc-ban" data-uid="${uid}">Ban</button>`);
  }
  if (viewerIsSuperAdmin) {
    secBtns.push(`<button class="admin-btn" data-act="kyc-setrole" data-uid="${uid}">Change role</button>`);
  }

  const flagPills = [
    r.payouts_frozen ? `<span class="payout-status-badge payout-status-badge-rejected" title="${esc(r.payouts_frozen_reason || '')}">Frozen</span>` : '',
    r.is_banned     ? `<span class="payout-status-badge payout-status-badge-rejected" title="${esc(r.banned_reason || '')}">Banned</span>` : '',
  ].join('');

  return `
    <div class="payout-card-head">
      <div class="payout-author">
        <div class="user-row-avatar">${avatar ? `<img src="${esc(avatar)}"/>` : esc(initials(username))}</div>
        <div>
          <div class="payout-author-name">${esc(r.display_name || username)} <span style="color:var(--text2,#aaa);font-weight:400">@${esc(username)}</span></div>
          <div class="payout-author-email">${esc(r.email || '')}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span class="payout-status-badge" style="background:rgba(155,89,182,0.18);color:#b07ee8">${esc(r.user_role || 'user')}</span>
        ${flagPills}
        <span class="payout-status-badge payout-status-badge-${r.kyc_status}">${esc(r.kyc_status)}</span>
      </div>
    </div>

    <div class="payout-verify">
      <div class="payout-verify-grid">
        <div class="payout-verify-row"><span class="payout-verify-label">Full name</span><span class="payout-verify-val">${esc(r.full_name || '—')}</span></div>
        <div class="payout-verify-row"><span class="payout-verify-label">Birthdate</span><span class="payout-verify-val">${esc(_formatBirthdate(d.date_of_birth) || '—')}</span></div>
        <div class="payout-verify-row"><span class="payout-verify-label">Phone</span><span class="payout-verify-val">${esc(d.phone || '—')}</span></div>
        <div class="payout-verify-row"><span class="payout-verify-label">Email</span><span class="payout-verify-val">${esc(r.email || '—')}</span></div>
        <div class="payout-verify-row"><span class="payout-verify-label">Method</span><span class="payout-verify-val">${esc(d.payment_method || '—')}</span></div>
        <div class="payout-verify-row"><span class="payout-verify-label">ID type</span><span class="payout-verify-val">${esc(d.id_type || '—')}</span></div>
        <div class="payout-verify-row"><span class="payout-verify-label">ID number</span><span class="payout-verify-val">${esc(d.id_number || '—')}</span></div>
        <div class="payout-verify-row payout-verify-row-wide"><span class="payout-verify-label">Home address</span><span class="payout-verify-val">${esc(d.address || '—')}</span></div>
        ${d.submitted_at ? `<div class="payout-verify-row"><span class="payout-verify-label">Submitted</span><span class="payout-verify-val">${timeAgo(d.submitted_at)}</span></div>` : ''}
        ${r.approved_at ? `<div class="payout-verify-row"><span class="payout-verify-label">Approved</span><span class="payout-verify-val">${timeAgo(r.approved_at)}</span></div>` : ''}
        ${r.rejection_reason ? `<div class="payout-verify-row payout-verify-row-wide"><span class="payout-verify-label">Rejection reason</span><span class="payout-verify-val">${esc(r.rejection_reason)}</span></div>` : ''}
        ${r.payouts_frozen_reason ? `<div class="payout-verify-row payout-verify-row-wide"><span class="payout-verify-label">Freeze reason</span><span class="payout-verify-val">${esc(r.payouts_frozen_reason)}</span></div>` : ''}
        ${r.banned_reason ? `<div class="payout-verify-row payout-verify-row-wide"><span class="payout-verify-label">Ban reason</span><span class="payout-verify-val">${esc(r.banned_reason)}</span></div>` : ''}
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

    <div class="payout-actions" style="flex-wrap:wrap;gap:6px">
      ${secBtns.join('')}
    </div>
  `;
}

// Delegated click handler — one place to dispatch every per-row admin
// action. Lives outside loadKycList so it isn't re-bound on every
// reload (which would stack listeners and fire each action N times).
// Looks at data-act + data-uid; prompts for reason where the RPC
// requires one; calls the matching SECURITY DEFINER RPC; then re-loads
// the list to reflect the new state.
document.addEventListener('click', async (e) => {
  // Catch buttons inside the KYC review tab (#kycList) AND inside the
  // detail modal (#kycDetailBody) — both render via
  // _renderKycCardInnerHTML and emit the same data-act/data-uid pair.
  const btn = e.target.closest('#kycList button[data-act^="kyc-"], #kycDetailBody button[data-act^="kyc-"]');
  if (!btn) return;
  const act = btn.dataset.act;
  const uid = btn.dataset.uid;
  if (!act || !uid) return;

  // Reason prompts. Only triggered for the destructive / state-change
  // actions; approve/unfreeze/unban don't need a reason.
  const needsReason = ['kyc-reject', 'kyc-revoke', 'kyc-freeze', 'kyc-ban'];
  let reason = null;
  if (needsReason.includes(act)) {
    reason = prompt(`Reason for ${act.replace('kyc-', '')}? (visible in audit log)`);
    if (reason === null) return;
    if (!reason.trim()) { toast('Reason is required.'); return; }
  }

  // Belt-and-suspenders confirm for the most destructive ops.
  if (act === 'kyc-ban' || act === 'kyc-revoke') {
    if (!confirm(`Confirm ${act.replace('kyc-', '')} for this user?`)) return;
  }

  // Role-change is super-admin only. Server-side admin_set_user_role
  // re-checks via is_super_admin so a moderator who tampers with the
  // DOM still hits 42501.
  let newRole = null;
  if (act === 'kyc-setrole') {
    newRole = prompt('New role? (user / moderator / admin)');
    if (newRole === null) return;
    newRole = newRole.trim().toLowerCase();
    if (!['user', 'moderator', 'admin'].includes(newRole)) {
      toast('Role must be: user, moderator, or admin.');
      return;
    }
    if (newRole === 'admin' && !confirm('Promote this user to ADMIN? Admins can promote/demote other users.')) return;
  }

  // UI action → RPC name + arg shape. Each RPC returns { ok, ... } on
  // success and raises on failure. admin_freeze_payouts / unfreeze
  // are reused from the earlier 2026-05-14 earnings moderation
  // migration; the rest are new in 2026-05-15.
  const rpcMap = {
    'kyc-approve':  ['admin_approve_kyc',      { p_user_id: uid, p_notes: null }],
    'kyc-reject':   ['admin_reject_kyc',       { p_user_id: uid, p_reason: reason }],
    'kyc-revoke':   ['admin_revoke_kyc',       { p_user_id: uid, p_reason: reason }],
    'kyc-ban':      ['admin_ban_user',         { p_user_id: uid, p_reason: reason }],
    'kyc-unban':    ['admin_unban_user',       { p_user_id: uid, p_reason: null }],
    'kyc-freeze':   ['admin_freeze_payouts',   { p_user_id: uid, p_reason: reason }],
    'kyc-unfreeze': ['admin_unfreeze_payouts', { p_user_id: uid }],
    'kyc-setrole':  ['admin_set_user_role',    { p_user_id: uid, p_role: newRole }],
  };
  const [rpcName, rpcArgs] = rpcMap[act] || [];
  if (!rpcName) { toast(`Unknown action: ${act}`); return; }

  // If the action came from the modal (button is inside #kycDetailBody),
  // close the modal on success and refresh the directory; otherwise
  // refresh the inline KYC review list. Either way, the freshly-loaded
  // data reflects the post-action state.
  const fromModal = !!btn.closest('#kycDetailBody');

  btn.disabled = true;
  try {
    const { data, error } = await supabase.rpc(rpcName, rpcArgs);
    if (error) { toast(`${act}: ${error.message}`); return; }
    if (data?.noop) toast(`${act}: no change (${data.reason || 'already in target state'}).`);
    else            toast(`${act.replace('kyc-', '')} applied.`);
    if (fromModal) {
      closeKycDetailModal();
      // The KYC list directory only shows approved users — after
      // Reject / Revoke / Ban etc. the row may legitimately disappear,
      // which is the expected feedback.
      if (typeof loadKycListSimple === 'function') await loadKycListSimple();
    } else {
      await loadKycList();
    }
  } catch (err) {
    toast(`${act} threw: ${err?.message || err}`);
  } finally {
    btn.disabled = false;
  }
});

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
// Tab restoration from URL hash. On refresh / direct deep-link load,
// read `#tabname` from the URL and open that tab instead of always
// dropping the admin onto Inbox.
//
// Falls back to 'inbox' when:
//   • the URL has no hash
//   • the hash isn't a known tab name
// Both cases keep the historical default behavior intact.
function _restoreTabFromHash() {
  const raw = (window.location.hash || '').replace(/^#/, '').toLowerCase();
  const target = VALID_ADMIN_TABS.has(raw) ? raw : 'inbox';
  switchTab(target);
}

// Browser back/forward should also navigate between tabs. Without this
// listener, hitting Back after switching from Inbox → Earnings would
// update the URL but not actually re-render the tab.
window.addEventListener('hashchange', _restoreTabFromHash);

(async () => {
  const ok = await gateAccess();
  if (ok) _restoreTabFromHash();
})();


// ════════════════════════════════════════════════════════════════════════
// BROADCASTS — admin push + in-app composer with optional scheduling
// ════════════════════════════════════════════════════════════════════════
// Flow:
//   1. Admin fills in audience / title / body / cta_url / channels.
//   2. Optionally toggles "Schedule for later" and picks a datetime.
//   3. Hits Send. Calls admin_send_blast RPC (security definer).
//      • If immediate: RPC dispatches synchronously (in-app insert +
//        Expo push fan-out via net.http_post). Returns counts.
//      • If scheduled: RPC just stores the row. pg_cron's
//        process_due_admin_blasts job picks it up at fire time.
//   4. History list refreshes.
// ════════════════════════════════════════════════════════════════════════

function initBroadcastsTab() {
  const scheduleToggle = document.getElementById('bcSchedule');
  const scheduleInput  = document.getElementById('bcScheduledFor');
  const sendBtn        = document.getElementById('btnSendBroadcast');

  if (scheduleToggle && scheduleInput) {
    scheduleToggle.addEventListener('change', () => {
      scheduleInput.disabled = !scheduleToggle.checked;
      sendBtn.textContent = scheduleToggle.checked ? 'Schedule blast' : 'Send now';
      if (scheduleToggle.checked && !scheduleInput.value) {
        // Default to 1 hour from now in the user's local time, formatted
        // for the <input type="datetime-local"> field (YYYY-MM-DDTHH:mm).
        const d = new Date(Date.now() + 60 * 60 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        scheduleInput.value =
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
          `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', _sendBroadcast);
  }
}

async function _sendBroadcast() {
  const statusEl   = document.getElementById('bcStatus');
  const sendBtn    = document.getElementById('btnSendBroadcast');
  const audience   = (document.querySelector('input[name="bcAudience"]:checked') || {}).value;
  const title      = (document.getElementById('bcTitle').value || '').trim();
  const body       = (document.getElementById('bcBody').value || '').trim();
  const ctaUrl     = (document.getElementById('bcCtaUrl').value || '').trim();
  const inApp      = document.getElementById('bcChannelInApp').checked;
  const push       = document.getElementById('bcChannelPush').checked;
  const scheduled  = document.getElementById('bcSchedule').checked;
  const schedVal   = document.getElementById('bcScheduledFor').value;

  // Build channels array — at least one must be checked.
  const channels = [];
  if (inApp) channels.push('in_app');
  if (push)  channels.push('push');

  // Client-side validation. Mirrors the server RPC's validation so we
  // can give a friendlier error before the round-trip.
  const setStatus = (msg, kind) => {
    statusEl.textContent = msg;
    statusEl.className = `admin-broadcast-status is-${kind}`;
  };
  if (!audience)            return setStatus('Pick an audience.', 'error');
  if (!title)               return setStatus('Title is required.', 'error');
  if (!body)                return setStatus('Message is required.', 'error');
  if (channels.length === 0) return setStatus('Pick at least one channel.', 'error');
  if (ctaUrl && !/^https?:\/\//i.test(ctaUrl)) {
    return setStatus('CTA URL must start with http:// or https://', 'error');
  }

  // datetime-local gives us a local-time string with no timezone — we
  // send it as an ISO string in the user's local tz so the server
  // interprets it correctly.
  let scheduledFor = null;
  if (scheduled) {
    if (!schedVal) return setStatus('Pick a date + time, or uncheck Schedule.', 'error');
    const localDate = new Date(schedVal);
    if (isNaN(localDate.getTime())) return setStatus('Invalid date/time.', 'error');
    if (localDate.getTime() < Date.now() - 60 * 1000) {
      return setStatus('Scheduled time must be in the future.', 'error');
    }
    scheduledFor = localDate.toISOString();
  }

  // Confirmation — broadcasts can hit thousands of users; one accidental
  // click shouldn't be enough.
  const audienceLabel = {
    all_users: 'All users',
    pioneers:  'Pioneers',
    creators:  'Creators',
    writers:   'Writers',
  }[audience] || audience;
  const verb = scheduled ? 'Schedule' : 'Send';
  if (!confirm(`${verb} this broadcast to "${audienceLabel}"?\n\n${title}\n${body}\n\nThis cannot be undone once delivered.`)) {
    return;
  }

  sendBtn.disabled = true;
  setStatus(scheduled ? 'Scheduling…' : 'Sending…', 'pending');

  try {
    const { data, error } = await supabase.rpc('admin_send_blast', {
      p_audience:      audience,
      p_title:         title,
      p_body:          body,
      p_cta_url:       ctaUrl || null,
      p_channels:      channels,
      p_scheduled_for: scheduledFor,
    });
    if (error) {
      setStatus(`Failed: ${error.message}`, 'error');
      return;
    }
    if (!data?.ok) {
      setStatus(`Failed: ${data?.error || 'unknown'}`, 'error');
      return;
    }
    if (data.status === 'scheduled') {
      setStatus(
        `Scheduled for ${new Date(data.scheduled_for).toLocaleString()}.`,
        'ok',
      );
    } else {
      setStatus(
        `Sent. In-app: ${data.in_app_count}. Push dispatched: ${data.push_dispatched}.`,
        'ok',
      );
    }
    // Reset the composer (keep audience selection so admin can quickly
    // send a follow-up to the same group).
    document.getElementById('bcTitle').value = '';
    document.getElementById('bcBody').value  = '';
    document.getElementById('bcCtaUrl').value = '';
    document.getElementById('bcSchedule').checked = false;
    document.getElementById('bcScheduledFor').value = '';
    document.getElementById('bcScheduledFor').disabled = true;
    sendBtn.textContent = 'Send now';
    // Refresh history so the new row appears.
    loadBroadcasts();
  } catch (e) {
    setStatus(`Failed: ${e.message || e}`, 'error');
  } finally {
    sendBtn.disabled = false;
  }
}

async function loadBroadcasts() {
  const listEl = document.getElementById('bcHistoryList');
  if (!listEl) return;
  listEl.innerHTML = '<div class="admin-empty">Loading…</div>';

  const { data, error } = await supabase.rpc('admin_list_blasts', {
    p_limit:  50,
    p_offset: 0,
  });

  if (error) {
    listEl.innerHTML = `<div class="admin-empty">Couldn't load history: ${error.message}</div>`;
    return;
  }
  if (!data || data.length === 0) {
    listEl.innerHTML = '<div class="admin-empty">No broadcasts yet.</div>';
    return;
  }

  const escHTML = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);

  const audienceLabel = {
    all_users: 'All users',
    pioneers:  'Pioneers',
    creators:  'Creators',
    writers:   'Writers',
  };

  const statusBadge = (status) => {
    const map = {
      pending:   ['Pending',   'pending'],
      scheduled: ['Scheduled', 'pending'],
      sending:   ['Sending',   'pending'],
      sent:      ['Sent',      'ok'],
      failed:    ['Failed',    'error'],
      cancelled: ['Cancelled', 'muted'],
    };
    const [label, kind] = map[status] || [status, 'muted'];
    return `<span class="admin-broadcast-badge is-${kind}">${label}</span>`;
  };

  listEl.innerHTML = data.map((b) => {
    const when = b.scheduled_for
      ? `Scheduled ${new Date(b.scheduled_for).toLocaleString()}`
      : (b.sent_at
          ? `Sent ${new Date(b.sent_at).toLocaleString()}`
          : `Created ${new Date(b.created_at).toLocaleString()}`);
    const counts = (b.status === 'sent')
      ? `<div class="admin-broadcast-row-counts">In-app: <strong>${b.in_app_count}</strong> · Push: <strong>${b.push_dispatched}</strong></div>`
      : '';
    const err = b.error_message
      ? `<div class="admin-broadcast-row-error">${escHTML(b.error_message)}</div>`
      : '';
    const cancelBtn = (b.status === 'scheduled')
      ? `<button class="admin-btn admin-btn-danger-ghost" data-act="cancel-broadcast" data-id="${escHTML(b.id)}">Cancel</button>`
      : '';
    return `
      <div class="admin-broadcast-row" data-id="${escHTML(b.id)}">
        <div class="admin-broadcast-row-top">
          <div class="admin-broadcast-row-meta">
            ${statusBadge(b.status)}
            <span class="admin-broadcast-row-audience">${escHTML(audienceLabel[b.audience] || b.audience)}</span>
            <span class="admin-broadcast-row-when">${escHTML(when)}</span>
          </div>
          ${cancelBtn}
        </div>
        <div class="admin-broadcast-row-title">${escHTML(b.title)}</div>
        <div class="admin-broadcast-row-body">${escHTML(b.body)}</div>
        ${counts}
        ${err}
      </div>
    `;
  }).join('');

  // Wire cancel buttons (event delegation would also work but the
  // history list is small enough that a direct listener per row is
  // fine and keeps the code inline).
  listEl.querySelectorAll('[data-act="cancel-broadcast"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('Cancel this scheduled broadcast? It will not be sent.')) return;
      btn.disabled = true;
      const { data, error } = await supabase.rpc('admin_cancel_blast', { p_blast_id: id });
      if (error || !data?.ok) {
        alert(`Couldn't cancel: ${error?.message || data?.error || 'unknown'}`);
        btn.disabled = false;
        return;
      }
      loadBroadcasts();
    });
  });
}
