// ════════════════════════════════════════════════════════════════════════
// Selebox user profile page — extracted from js/app.js as Stage 6 of the
// refactor roadmap (2026-05-15). This module owns:
//   • showProfileView() + the openProfile entry point
//   • Profile header rendering, badges, mutual followers, follow/unfollow
//   • Profile sub-tabs (Posts / Videos / Books / About)
//   • loadProfilePosts / loadProfileVideos / loadProfileBooks
//   • Edit-profile modal — username/display/bio/country/city/avatar/banner
//   • openMyProfile() + topbar avatar click handler
//
// NOT moved (stays in app.js):
//   • Profile action menu (closeProfileActionMenu / openProfileActionMenu
//     / shareProfile) at app.js ~L4597-4748 — more post-card UI than
//     profile-page UI. Defer to a future post-card module.
//   • openCropModal / closeCropModal at app.js ~L7573-7671 — SHARED with
//     book-cover + video-thumbnail upload flows. Injected via config.
//   • The popstate handler at app.js ~L7747-7761 — generic router that
//     handles both #profile/<id> AND the home fallback. It calls openProfile
//     which app.js imports from this module.
//   • The .profile-link click delegate at app.js ~L7979-7989 — generic
//     click handler that calls openProfile, no profile-specific state.
//   • setSidebarActive + sidebar nav listeners (L7715-7744) — core nav.
//
// CAREFUL: pure code movement, applied via a one-pass Python transform.
// All app.js-owned references rewritten to _cfg.X via word-boundary regex.
// Stage 1 lesson: no circular imports. We import ONLY from supabase.js
// and inject everything app.js owns via initProfile(config).
// ════════════════════════════════════════════════════════════════════════

import { supabase, toast, escHTML, initials, timeAgo, callEdgeFunction } from './supabase.js';

// ─── Config-injection dependency surface (24 pieces) ─────────────────────
let _cfg = {
  getCurrentUser:           () => null,
  getCurrentProfile:        () => null,
  setCurrentProfile:        () => {},
  getPosts:                 () => [],
  setPosts:                 () => {},
  PROFILE_DISPLAY_COLS:     '*',
  hideAllMainPages:         () => {},
  stopVideoPlayer:          () => {},
  scrollToTop:              () => {},
  closeAllModals:           () => {},
  closePostActionMenu:      () => {},
  updateTopbarUser:         () => {},
  setSidebarActive:         () => {},
  renderRoleSeal:           () => '',
  renderPost:               () => document.createElement('div'),
  _wireUpNewPosts:          () => {},
  setupCollapsibleBodies:   () => {},
  renderVideoCard:          () => document.createElement('div'),
  renderBookCard:           () => document.createElement('div'),
  triggerPostLazyLoad:      () => {},
  attachHlsToPostVideo:     () => {},
  uploadImage:              async () => null,
  openCropModal:            () => {},
  showMessages:             () => {},
  tickGoalUnique:           () => {},
  getFeedPostObserver:      () => null,
  getFeedVideoObserver:     () => null,
  feedEl:                   null,
  storiesEl:                null,
  composeEl:                null,
};

// ─── Public API ──────────────────────────────────────────────────────────
export function initProfile(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// app.js's showHomeLanding/showFeed reset viewingProfileId when nav'ing
// away. They call this setter rather than reaching for the module-private.
export function setViewingProfileId(id) { viewingProfileId = id; }

// app.js's togglePinPost wants to refresh the Posts tab if the user is
// currently looking at their own profile. We expose this small helper so
// app.js doesn't have to know about viewingProfileId or loadProfilePosts.
// Added 2026-05-15 when the Stage 6 extraction left a stale reference at
// app.js:~L4380 (caught during initial node --check residual sweep).
export function refreshProfilePostsIfViewing(userId) {
  if (viewingProfileId === userId) loadProfilePosts(userId);
}

// ─── Profile-only DOM refs + state (originally app.js L5582, L5586) ──────
const profilePage = document.getElementById('profilePage');
let viewingProfileId = null;

function showProfileView() {
  _cfg.hideAllMainPages();   // also hides feedSentinel (and any future sibling overlays)
  profilePage.style.display = 'block';
  document.body.classList.remove('on-videos');
  _cfg.stopVideoPlayer();
}

export async function openProfile(userId) {
  showProfileView();
  viewingProfileId = userId;
  // Set URL hash so refresh keeps user on profile
  if (window.location.hash !== `#profile/${userId}`) {
    history.pushState(null, '', `#profile/${userId}`);
  }

  // Scroll to top — the previous page's scroll position lingers otherwise.
  _cfg.scrollToTop();

  // Close any modals/menus from a previous profile (rapid-nav safety)
  _cfg.closeAllModals('.modal-backdrop[data-modal="follow-list"], .modal-backdrop[data-modal="share-profile"], .modal-backdrop[data-modal="report-user"]');
  closeProfileActionMenu?.();
  _cfg.closePostActionMenu?.();

  // ── Paint skeleton instantly so the page never feels frozen ──
  paintProfileSkeleton();

  const isOwn = !!(_cfg.getCurrentUser() && _cfg.getCurrentUser().id === userId);

  // ── Fire ALL queries in parallel (was sequential — now ~5x faster) ──
  // Mutuals RPC is included here so it doesn't add a sequential round-trip later.
  // Video/book counts apply the SAME filters as loadProfileVideos/Books for
  // non-owners — otherwise the tab pill ("Videos · 7") disagrees with what
  // the user actually sees in the tab ("No videos yet").
  const profileP   = fetchProfileWithRetry(userId);
  const followersP = supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId);
  const followingP = supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId);
  const postsP     = supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId);

  // Filter to status='ready' for EVERYONE — including the owner.
  // Pre-fix the owner's count included processing/uploading rows,
  // which made the "Videos N" tab count on their own profile
  // disagree with the grid below (which only renders ready ones
  // once we tighten the next query). Creator Studio (the studio
  // grid) is the surface that shows non-ready uploads with proper
  // lifecycle chips; the public profile shouldn't surface them.
  // Match the loadProfileVideos filter — both 'ready' and 'published'
  // count as visible. The previous .eq('status','ready') under-counted
  // the videos badge on profile tabs because fresh uploads land with
  // status='published'.
  const videosP = supabase.from('videos').select('*', { count: 'exact', head: true })
    .eq('uploader_id', userId)
    .in('status', ['ready', 'published']);

  let booksQ = supabase.from('books').select('*', { count: 'exact', head: true }).eq('author_id', userId);
  if (!isOwn) booksQ = booksQ.eq('is_public', true).in('status', ['ongoing', 'completed']);
  const booksP = booksQ;

  const badgesP    = supabase.from('user_badges').select('badge').eq('user_id', userId);
  const followP    = (!isOwn && _cfg.getCurrentUser())
    ? supabase.from('follows').select('follower_id').eq('follower_id', _cfg.getCurrentUser().id).eq('following_id', userId).maybeSingle()
    : Promise.resolve({ data: null });
  const mutualsP   = (!isOwn && _cfg.getCurrentUser())
    ? supabase.rpc('get_mutual_followers', { p_target_id: userId, p_viewer_id: _cfg.getCurrentUser().id, p_limit: 6 })
    : Promise.resolve({ data: null });

  const [profile, fRes, gRes, pRes, vRes, bRes, badgesRes, followRes, mutualsRes] = await Promise.all([
    profileP, followersP, followingP, postsP, videosP, booksP, badgesP, followP, mutualsP
  ]);

  if (!profile) {
    toast('Could not load profile', 'error');
    clearProfileSkeleton();
    return;
  }

  const followers = fRes.count || 0;
  const following = gRes.count || 0;
  const postCount = pRes.count || 0;
  const videoCount = vRes.count || 0;
  const bookCount  = bRes.count || 0;
  const badges    = (badgesRes?.data || []).map(b => b.badge);

  // Banner (preserve the edit button!)
  const banner = document.getElementById('profileBanner');
  const existingBtn = document.getElementById('editBannerBtn');
  banner.innerHTML = profile.banner_url ? `<img src="${profile.banner_url}" alt="banner"/>` : '';
  if (existingBtn) banner.appendChild(existingBtn);

  // Avatar
  const avatarBig = document.getElementById('profileAvatarBig');
  avatarBig.innerHTML = profile.avatar_url ? `<img src="${profile.avatar_url}"/>` : initials(profile.username);

  // Name / badge / bio
  document.getElementById('profileName').innerHTML = `${escHTML(profile.username)}${_cfg.renderRoleSeal(profile, 20)}`;
  renderProfileBadges(profile, badges);
  document.getElementById('profileBio').textContent = profile.bio || '';

  // Joined date
  const joined = new Date(profile.created_at);
  const joinedStr = joined.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  document.getElementById('profileJoined').textContent = joinedStr;

  // Stats
  document.getElementById('statFollowers').innerHTML = `<strong>${followers}</strong> followers`;
  document.getElementById('statFollowing').innerHTML = `<strong>${following}</strong> following`;
  document.getElementById('statPosts').innerHTML     = `<strong>${postCount}</strong> posts`;
  // Wire the followers/following stats to open the list modal
  document.getElementById('statFollowers').onclick = () => openFollowListModal(userId, profile.username, 'followers');
  document.getElementById('statFollowing').onclick = () => openFollowListModal(userId, profile.username, 'following');
  document.getElementById('statPosts').onclick     = () => switchProfileTab('posts');

  // Tab counts
  setProfileTabCount('posts',  postCount);
  setProfileTabCount('videos', videoCount);
  setProfileTabCount('books',  bookCount);

  // About tab
  document.getElementById('aboutUsername').textContent = profile.username;
  document.getElementById('aboutBio').textContent = profile.bio || '—';
  document.getElementById('aboutLocation').textContent = profile.location || '—';
  document.getElementById('aboutWebsite').innerHTML = profile.website ? `<a href="${profile.website}" target="_blank">${profile.website}</a>` : '—';
  document.getElementById('aboutJoined').textContent = joined.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  document.getElementById('aboutType').textContent = profile.is_guest ? 'Guest account' : 'Member';

  // Action button + edit controls (isOwn already computed above)
  const actionBtn = document.getElementById('profileActionBtn');
  const editAvatarBtn = document.getElementById('editAvatarBtn');
  const editBannerBtn = document.getElementById('editBannerBtn');

  // Show "Message" button only on others' profiles
  const messageBtn = document.getElementById('profileMessageBtn');
  if (isOwn) {
    actionBtn.textContent = '⚙️ Edit profile';
    actionBtn.onclick = () => openEditProfile(profile);
    editAvatarBtn.style.display = 'flex';
    editAvatarBtn.style.visibility = 'visible';
    editBannerBtn.style.display = 'flex';
    editBannerBtn.style.visibility = 'visible';
    if (messageBtn) messageBtn.style.display = 'none';
  } else {
    const isFollowing = !!followRes.data;
    actionBtn.textContent = isFollowing ? 'Unfollow' : 'Follow';
    actionBtn.onclick = () => toggleFollow(userId, isFollowing);
    editAvatarBtn.style.display = 'none';
    editBannerBtn.style.display = 'none';
    if (messageBtn) {
      messageBtn.style.display = '';
      messageBtn.onclick = () => _cfg.showMessages(userId);
    }
  }

  // Wire profile menu (kebab) — share / report / snooze / block
  const menuBtn = document.getElementById('profileMenuBtn');
  if (menuBtn) {
    menuBtn.onclick = (e) => openProfileActionMenu(e, menuBtn, {
      isOwn,
      userId,
      username: profile.username || 'this user',
    });
  }

  // Mutual followers strip — render from the RPC result we already fetched
  renderMutualFollowers(userId, isOwn, mutualsRes?.data || null);

  // Reset tab to Posts and load
  document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'posts'));
  ['profilePosts', 'profileVideos', 'profileBooks', 'profileAbout'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === 'profilePosts' ? '' : 'none';
  });
  // Reset the lazy-load markers so a fresh openProfile re-fetches
  ['profileVideos', 'profileBooks'].forEach(id => {
    const el = document.getElementById(id);
    if (el) delete el.dataset.loadedFor;
  });

  loadProfilePosts(userId);
}

// ════════════════════════════════════════════════════════════════════════════
// PROFILE — helpers (skeleton, badges, tab counts, switch, follow list modal)
// ════════════════════════════════════════════════════════════════════════════

// Retry profile fetch up to 3 times — protects against just-created accounts.
// Exponential backoff (200ms → 500ms → 1.2s) so transient misses don't waste
// 600ms in a tight loop; existing accounts return immediately on attempt 1.
async function fetchProfileWithRetry(userId, attempts = 3) {
  const delays = [0, 200, 500];
  for (let i = 0; i < attempts; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    const { data } = await supabase.from('profiles').select(_cfg.PROFILE_DISPLAY_COLS).eq('id', userId).single();
    if (data) return data;
  }
  return null;
}

// Paint shimmer placeholders so the page looks alive while parallel queries run
function paintProfileSkeleton() {
  const banner = document.getElementById('profileBanner');
  if (banner && !banner.querySelector('img')) banner.classList.add('skeleton-banner');
  const avatarBig = document.getElementById('profileAvatarBig');
  if (avatarBig) { avatarBig.classList.add('skeleton-avatar'); avatarBig.innerHTML = ''; }
  document.getElementById('profileName').textContent = ' ';
  document.getElementById('profileName').classList.add('skeleton-text');
  document.getElementById('profileBio').textContent = ' ';
  document.getElementById('profileBio').classList.add('skeleton-text', 'skeleton-text-wide');
  ['statFollowing','statFollowers','statPosts'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = '&nbsp;'; el.classList.add('skeleton-text'); }
  });
  // Hide stale badges so previous profile's "Member"/Creator/etc. don't flash
  const baseBadge = document.getElementById('profileBadge');
  if (baseBadge) baseBadge.style.visibility = 'hidden';
  const badgeWrap = document.getElementById('profileBadgesExtra');
  if (badgeWrap) badgeWrap.innerHTML = '';
  // Hide stale mutuals strip from previous profile
  const mutuals = document.getElementById('profileMutuals');
  if (mutuals) { mutuals.style.display = 'none'; mutuals.innerHTML = ''; }
}

function clearProfileSkeleton() {
  const banner = document.getElementById('profileBanner');
  if (banner) banner.classList.remove('skeleton-banner');
  const avatarBig = document.getElementById('profileAvatarBig');
  if (avatarBig) avatarBig.classList.remove('skeleton-avatar');
  ['profileName','profileBio','statFollowing','statFollowers','statPosts'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('skeleton-text', 'skeleton-text-wide');
  });
}

// Render the user's badge identification. Replaces the old "Member"
// pill (which was redundant on every signed-up account) with whatever
// badges the user has actually earned (Creator, Verified, Writer,
// Pioneer, Staff). The base pill now only surfaces for guest accounts
// — which IS a meaningful identification distinct from any earned
// badge.
function renderProfileBadges(profile, badges) {
  clearProfileSkeleton();

  const baseBadge = document.getElementById('profileBadge');
  if (profile.is_guest) {
    // Guest is still meaningful — keep the pill.
    baseBadge.textContent     = 'Guest';
    baseBadge.className       = 'profile-badge guest';
    baseBadge.style.visibility = '';
    baseBadge.style.display    = '';
  } else {
    // Regular member — hide the generic "Member" pill entirely. The
    // earned badges below tell the user's real story (Creator,
    // Verified, etc.).
    baseBadge.textContent     = '';
    baseBadge.className       = 'profile-badge';
    baseBadge.style.display    = 'none';
  }

  // Earned badges live in a sibling container so they sit inline with username
  let extra = document.getElementById('profileBadgesExtra');
  if (!extra) {
    extra = document.createElement('span');
    extra.id = 'profileBadgesExtra';
    extra.className = 'profile-badges-extra';
    baseBadge.insertAdjacentElement('afterend', extra);
  }
  extra.innerHTML = '';

  // Badge identification — only show pills for users who have actually
  // earned one of these four roles. Plain "user" accounts (no role)
  // get nothing rendered here, and the generic "Member" pill is hidden
  // for them too (handled above) so the row stays empty rather than
  // showing a meaningless badge.
  const META = {
    creator:   { label: 'Creator',   icon: '🎬', cls: 'badge-creator',   title: 'Creator — earned by sharing original videos' },
    writer:    { label: 'Writer',    icon: '✍️', cls: 'badge-writer',    title: 'Writer — earned by publishing books on Selebox' },
    pioneer:   { label: 'Pioneer',   icon: '⭐', cls: 'badge-pioneer',   title: 'Pioneer — early Selebox community member' },
    moderator: { label: 'Moderator', icon: '🛡', cls: 'badge-moderator', title: 'Moderator — Selebox community team' },
  };

  // Resolve the user's badge set from the SAME source as the inline
  // role seal (profile.role / profile.roles), not from the separate
  // user_badges table the badges parameter reads. The two sources
  // were drifting — the inline seal would show "Creator" while the
  // pills row showed nothing because the badges table was empty.
  // Unifying on profile.role(s) means whatever role makes the gold
  // seal appear also makes the pill appear.
  const rolesArr = Array.isArray(profile.roles) ? profile.roles : [];
  const roleStr  = typeof profile.role === 'string' ? profile.role : '';
  const userRoleSet = new Set([
    ...rolesArr.map(r => String(r).toLowerCase()),
    roleStr ? roleStr.toLowerCase() : null,
    // Keep the legacy `badges` array as a secondary source so accounts
    // that have entries in user_badges but no role column still light up.
    ...(Array.isArray(badges) ? badges.map(b => String(b).toLowerCase()) : []),
  ].filter(Boolean));

  // Stable display order (higher-status first). Picks the FIRST
  // matching role only — mirrors the mobile app's behavior of showing
  // a single text label next to the name (Moderator / Pioneer /
  // Creator / Writer), not a pill stack with icons.
  const order = ['moderator','pioneer','creator','writer'];
  for (const key of order) {
    if (!userRoleSet.has(key)) continue;
    const m = META[key];
    const el = document.createElement('span');
    el.className = 'profile-role-text';
    el.title = m.title;
    el.textContent = m.label;
    extra.appendChild(el);
    break; // only one label, like mobile
  }
}

function setProfileTabCount(tab, n) {
  const btn = document.querySelector(`.profile-tab[data-tab="${tab}"]`);
  if (!btn) return;
  let pill = btn.querySelector('.tab-count');
  if (!pill) {
    pill = document.createElement('span');
    pill.className = 'tab-count';
    btn.appendChild(pill);
  }
  pill.textContent = n > 999 ? `${(n/1000).toFixed(1)}k` : String(n);
}

function switchProfileTab(tab) {
  const btn = document.querySelector(`.profile-tab[data-tab="${tab}"]`);
  if (btn) btn.click();
}

// "Followed by alice, bob, +12 others you follow" social-proof strip
// Data is pre-fetched in openProfile's Promise.all — this just renders it.
function renderMutualFollowers(userId, isOwn, data) {
  const wrap = document.getElementById('profileMutuals');
  if (!wrap) return;
  if (isOwn || !_cfg.getCurrentUser() || !data || !data.length) {
    // Hide silently — no mutuals, viewing own, signed-out, or RPC missing
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  wrap.style.display = '';

  const total = Number(data[0]?.total_count || data.length);
  const shown = data.slice(0, 3);
  const extra = Math.max(0, total - shown.length);

  // Stacked avatars
  const avatars = shown.map(p => {
    const safeName = escHTML(p.username || '');
    const safeAvatar = p.avatar_url ? escHTML(p.avatar_url) : '';
    return `
    <button class="mutual-avatar" data-uid="${p.id}" title="@${safeName}" aria-label="View @${safeName}">
      ${safeAvatar ? `<img src="${safeAvatar}" alt="@${safeName}"/>` : `<span>${initials(p.username)}</span>`}
    </button>
  `;}).join('');

  // Names line
  const nameStrs = shown.map(p =>
    `<button class="mutual-name" data-uid="${p.id}">@${escHTML(p.username || '')}</button>`
  );
  let namesPart;
  if (nameStrs.length === 1) namesPart = nameStrs[0];
  else if (nameStrs.length === 2) namesPart = `${nameStrs[0]} and ${nameStrs[1]}`;
  else namesPart = `${nameStrs[0]}, ${nameStrs[1]}, and ${nameStrs[2]}`;

  const tail = extra > 0
    ? ` <button class="mutual-more">+${extra} other${extra === 1 ? '' : 's'} you follow</button>`
    : ' you follow';

  wrap.innerHTML = `
    <div class="mutual-avatars">${avatars}</div>
    <div class="mutual-text">Followed by ${namesPart}${tail}</div>
  `;

  // Click handlers — avatars + names → that profile; "+N others" → followers modal
  wrap.querySelectorAll('[data-uid]').forEach(el => {
    el.onclick = () => openProfile(el.dataset.uid);
  });
  const moreBtn = wrap.querySelector('.mutual-more');
  if (moreBtn) {
    moreBtn.onclick = () => {
      const uname = document.getElementById('profileName')?.textContent || 'user';
      openFollowListModal(userId, uname, 'followers');
    };
  }
}

// ── Followers/Following list modal ──────────────────────────────────────────
async function openFollowListModal(userId, username, mode) {
  if (!_cfg.getCurrentUser()) { toast('Please sign in', 'error'); return; }
  // mode: 'followers' (people who follow userId) | 'following' (people userId follows)

  _cfg.closeAllModals('.modal-backdrop[data-modal="follow-list"]');

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'follow-list';
  const safeUser = escHTML(username);
  modal.innerHTML = `
    <div class="modal-card follow-list-modal" role="dialog" aria-labelledby="follow-list-title">
      <div class="follow-list-header">
        <h2 id="follow-list-title">${mode === 'followers' ? 'Followers' : 'Following'}</h2>
        <p class="modal-sub">@${safeUser} · ${mode === 'followers' ? 'people who follow' : 'people followed by'}</p>
      </div>
      <input type="text" class="follow-list-search" placeholder="Search by username…" />
      <div class="follow-list-body" id="followListBody">
        ${'<div class="follow-list-row skeleton-row"></div>'.repeat(6)}
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

  // Fetch the relevant follows + each side's profile, then who *I* follow (for follow-back state)
  const followsCol = mode === 'followers' ? 'follower_id' : 'following_id';
  const matchCol   = mode === 'followers' ? 'following_id' : 'follower_id';

  // Get the list of user ids
  const { data: edges, error: edgeErr } = await supabase
    .from('follows')
    .select(`${followsCol}, created_at`)
    .eq(matchCol, userId)
    .order('created_at', { ascending: false })
    .limit(500);

  if (edgeErr) { toast(edgeErr.message, 'error'); return; }
  const ids = (edges || []).map(e => e[followsCol]).filter(Boolean);

  if (!ids.length) {
    document.getElementById('followListBody').innerHTML = `
      <div class="follow-list-empty">
        <div class="follow-list-empty-icon">👥</div>
        <div>${mode === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}</div>
      </div>`;
    return;
  }

  // Hydrate profiles + my own follows in parallel
  const [{ data: profiles }, { data: myFollows }] = await Promise.all([
    supabase.from('profiles').select('id, username, avatar_url, is_guest, bio').in('id', ids),
    supabase.from('follows').select('following_id').eq('follower_id', _cfg.getCurrentUser().id).in('following_id', ids),
  ]);

  const myFollowSet = new Set((myFollows || []).map(f => f.following_id));
  const profileMap  = new Map((profiles || []).map(p => [p.id, p]));

  // Render in the original follow order (most recent first)
  const rows = ids.map(id => profileMap.get(id)).filter(Boolean);
  const body = document.getElementById('followListBody');
  body.innerHTML = rows.map(p => {
    const safeName = escHTML(p.username || '');
    const safeBio  = escHTML((p.bio || '').slice(0, 80));
    const safeAvatar = p.avatar_url ? escHTML(p.avatar_url) : '';
    return `
    <div class="follow-list-row" data-username="${(p.username || '').toLowerCase().replace(/"/g, '')}">
      <button class="follow-list-avatar" data-uid="${p.id}">
        ${safeAvatar ? `<img src="${safeAvatar}"/>` : initials(p.username)}
      </button>
      <div class="follow-list-info">
        <button class="follow-list-name" data-uid="${p.id}">@${safeName}</button>
        <div class="follow-list-bio">${safeBio}</div>
      </div>
      ${p.id === _cfg.getCurrentUser().id ? '<span class="follow-list-you">You</span>' :
        `<button class="follow-list-btn ${myFollowSet.has(p.id) ? 'is-following' : ''}" data-uid="${p.id}">
          ${myFollowSet.has(p.id) ? 'Following' : 'Follow'}
        </button>`}
    </div>
  `;}).join('');

  // Click avatar/name → open profile
  body.querySelectorAll('[data-uid]').forEach(el => {
    if (el.classList.contains('follow-list-btn')) return;
    el.onclick = () => { close(); openProfile(el.dataset.uid); };
  });

  // Follow toggle
  body.querySelectorAll('.follow-list-btn').forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const uid = btn.dataset.uid;
      const wasFollowing = btn.classList.contains('is-following');
      btn.disabled = true;
      btn.textContent = wasFollowing ? 'Unfollowing…' : 'Following…';
      let error;
      if (wasFollowing) {
        ({ error } = await supabase.from('follows').delete().eq('follower_id', _cfg.getCurrentUser().id).eq('following_id', uid));
      } else {
        ({ error } = await supabase.from('follows').insert({ follower_id: _cfg.getCurrentUser().id, following_id: uid }));
      }
      btn.disabled = false;
      if (error) {
        toast(error.message, 'error');
        btn.textContent = wasFollowing ? 'Following' : 'Follow';
        return;
      }
      btn.classList.toggle('is-following', !wasFollowing);
      btn.textContent = wasFollowing ? 'Follow' : 'Following';
    };
  });

  // Search filter
  const search = modal.querySelector('.follow-list-search');
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    body.querySelectorAll('.follow-list-row').forEach(row => {
      row.style.display = !q || row.dataset.username.includes(q) ? '' : 'none';
    });
  };
  search.focus();
}

async function loadProfilePosts(userId) {
  const wrap = document.getElementById('profilePosts');
  wrap.innerHTML = '<div class="loading">Loading _cfg.getPosts()...</div>';
  // Fetch by created_at; sort pinned-first client-side. Bulletproof if pinned_at
  // column doesn't exist yet (works pre-migration, just won't have pinning).
  const { data } = await supabase
    .from('posts')
    .select(`*, profiles!user_id(id, username, avatar_url, is_guest, role), videos(id, video_url, thumbnail_url, title, duration), original:reposted_from(*, profiles!user_id(id, username, avatar_url, is_guest, role), videos(id, video_url, thumbnail_url, title, duration))`)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(40);
  posts = (data || []).slice().sort((a, b) => {
    if (a.pinned_at && !b.pinned_at) return -1;
    if (!a.pinned_at && b.pinned_at) return 1;
    if (a.pinned_at && b.pinned_at) return new Date(b.pinned_at) - new Date(a.pinned_at);
    return new Date(b.created_at) - new Date(a.created_at);
  });
  wrap.innerHTML = '';
  if (!_cfg.getPosts().length) {
    wrap.innerHTML = `
      <div class="profile-empty">
        <div class="profile-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
        </div>
        <h3>No posts yet</h3>
        <p>When this user shares something, it will appear here.</p>
      </div>`;
    return;
  }

  // Inject "Pinned" + "Posts" section dividers when the pinned/unpinned boundary is crossed
  let pinnedShown = false, postsShown = false;
  const hasAnyPinned = _cfg.getPosts().some(p => p.pinned_at);
  _cfg.getPosts().forEach(p => {
    if (p.pinned_at && !pinnedShown) {
      const hdr = document.createElement('div');
      hdr.className = 'profile-section-header';
      hdr.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 2l-1.4 1.4 1.6 1.6-5.4 5.4-3-1.5L6 11.3l3.7 3.7L4 21l1.4 1.4 5.7-5.7 3.7 3.7 1.4-1.4-1.5-3 5.4-5.4 1.6 1.6L23 9l-7-7z"/></svg> <span>Pinned</span>`;
      wrap.appendChild(hdr);
      pinnedShown = true;
    }
    if (!p.pinned_at && !postsShown && hasAnyPinned) {
      const hdr = document.createElement('div');
      hdr.className = 'profile-section-header';
      hdr.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg> <span>Posts</span>`;
      wrap.appendChild(hdr);
      postsShown = true;
    }
    const el = _cfg.renderPost(p);
    wrap.appendChild(el);
    // Lazy-load reactions/comments for these too
    if (_cfg.getFeedPostObserver()) _cfg.getFeedPostObserver().observe(el);
    el.querySelectorAll('.post-video').forEach(v => _cfg.getFeedVideoObserver()?.observe(v));
  });
  // Apply Facebook-style collapsing to long post bodies
  _cfg.setupCollapsibleBodies(wrap);
  // Fall back: if no observers (first time), load eagerly
  if (!_cfg.getFeedPostObserver()) {
    wrap.querySelectorAll('.post-card').forEach(c => _cfg.triggerPostLazyLoad(c));
    wrap.querySelectorAll('.post-video').forEach(v => _cfg.attachHlsToPostVideo(v));
  }
}

// ── Profile: Videos tab ──
async function loadProfileVideos(userId) {
  const wrap = document.getElementById('profileVideos');
  if (!wrap) return;
  if (wrap.dataset.loadedFor === userId) return;       // already loaded for this user
  wrap.innerHTML = '<div class="loading">Loading videos...</div>';

  const isOwn = _cfg.getCurrentUser() && _cfg.getCurrentUser().id === userId;

  // Supabase videos uploaded by this user
  let q = supabase
    .from('videos')
    .select(`id, title, description, thumbnail_url, video_url, views, likes, duration, created_at, status, tags, category, uploader_id, is_locked, is_monetized, unlock_cost_coins, unlock_cost_stars, profiles!videos_uploader_id_fkey ( id, username, avatar_url )`)
    .eq('uploader_id', userId)
    .order('created_at', { ascending: false });
  // Filter to status='ready' for EVERYONE — owner included. The
  // earlier `if (!isOwn)` carve-out let processing/uploading rows
  // leak into the owner's own profile grid, where they rendered as
  // black-thumbnail cards (Bunny hadn't generated the still image
  // yet). The creator's "see my pending uploads" need is owned by
  // the Studio surface (studioGrid in this file), which loads
  // without a status filter and renders proper lifecycle chips.
  //
  // Accept BOTH 'ready' and 'published' — the canonical
  // post-upload status. Server-side fetch_video_card uses
  // coalesce(status, 'published')='published' and recent uploads
  // are landing with status='published' directly. Filtering only
  // 'ready' made fresh uploads invisible on profile pages even
  // though they showed as Published in the Studio. Same defensive
  // filter the mobile fetchVideos uses.
  q = q.in('status', ['ready', 'published']);

  const { data, error } = await q.limit(60);

  if (error) {
    wrap.innerHTML = `<div class="profile-empty"><h3>Couldn't load videos</h3><p>${escHTML(error.message || '')}</p></div>`;
    return;
  }

  const list = data || [];
  if (!list.length) {
    wrap.innerHTML = `
      <div class="profile-empty">
        <div class="profile-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="M16 10.5l5-2.5v8l-5-2.5z" fill="currentColor" stroke="none"/></svg>
        </div>
        <h3>No videos yet</h3>
        <p>${isOwn ? 'Upload your first video from the home feed or Studio.' : 'When this creator uploads, videos will appear here.'}</p>
      </div>`;
    wrap.dataset.loadedFor = userId;
    return;
  }

  wrap.innerHTML = '<div class="profile-video-grid"></div>';
  const grid = wrap.querySelector('.profile-video-grid');
  list.forEach((v, i) => {
    // Adapt to the existing _cfg.renderVideoCard shape (mirrors fetchSupabaseVideos)
    const formatted = {
      $id: 'sb_' + v.id,
      _supabase: true,
      _supabaseId: v.id,
      title: v.title,
      description: v.description || '',
      tags: v.tags || [],
      uploader: v.uploader_id,
      thumbnail: v.thumbnail_url,
      videoUrl: v.video_url,
      uri: v.video_url,
      videoStats: { views: v.views || 0, duration: v.duration || 0 },
      // Monetization fields — without these, clicking a video from a user's
      // wall doesn't trigger setupVideoMonetGate (auto-deduct at 3:00 fails).
      is_locked:          !!v.is_locked,
      is_monetized:       !!v.is_monetized,
      duration:           v.duration || 0,
      unlock_cost_coins:  v.unlock_cost_coins ?? null,
      unlock_cost_stars:  v.unlock_cost_stars ?? null,
      status: v.status || 'ready',
      $createdAt: v.created_at,
      _uploaderInfo: v.profiles ? { $id: v.profiles.id, username: v.profiles.username, avatar: v.profiles.avatar_url } : null,
    };
    const uploader = v.profiles ? { username: v.profiles.username, avatar: v.profiles.avatar_url } : null;
    const card = _cfg.renderVideoCard(formatted, uploader);
    card.style.animationDelay = `${(i * 0.03).toFixed(3)}s`;
    grid.appendChild(card);
  });
  wrap.dataset.loadedFor = userId;
}

// ── Profile: Books tab ──
async function loadProfileBooks(userId) {
  const wrap = document.getElementById('profileBooks');
  if (!wrap) return;
  if (wrap.dataset.loadedFor === userId) return;
  wrap.innerHTML = '<div class="loading">Loading books...</div>';

  const isOwn = _cfg.getCurrentUser() && _cfg.getCurrentUser().id === userId;

  let q = supabase
    .from('books')
    .select(`id, title, description, cover_url, genre, tags, views_count, likes_count, chapters_count, word_count, status, is_public, published_at, created_at, updated_at, author_id, profiles!books_author_id_fkey ( id, username, avatar_url )`)
    .eq('author_id', userId)
    .order('updated_at', { ascending: false });
  // Non-owners only see public, non-draft books
  if (!isOwn) {
    q = q.eq('is_public', true).in('status', ['ongoing', 'completed']);
  }

  const { data, error } = await q.limit(60);

  if (error) {
    wrap.innerHTML = `<div class="profile-empty"><h3>Couldn't load books</h3><p>${escHTML(error.message || '')}</p></div>`;
    return;
  }

  const list = data || [];
  if (!list.length) {
    wrap.innerHTML = `
      <div class="profile-empty">
        <div class="profile-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A2.5 2.5 0 0 1 4.5 2H12v18H4.5A2.5 2.5 0 0 1 2 17.5v-13z"/><path d="M22 4.5A2.5 2.5 0 0 0 19.5 2H12v18h7.5a2.5 2.5 0 0 0 2.5-2.5v-13z"/></svg>
        </div>
        <h3>No books yet</h3>
        <p>${isOwn ? 'Head to Author to publish your first manuscript.' : 'When this writer publishes, their books will appear here.'}</p>
      </div>`;
    wrap.dataset.loadedFor = userId;
    return;
  }

  wrap.innerHTML = '<div class="profile-book-grid"></div>';
  const grid = wrap.querySelector('.profile-book-grid');
  list.forEach((b, i) => {
    const formatted = {
      ...b,
      id: b.id,
      $id: 'sb_' + b.id,
      _supabase: true,
      author: b.profiles ? { id: b.profiles.id, username: b.profiles.username, avatar: b.profiles.avatar_url } : null,
    };
    const card = _cfg.renderBookCard(formatted);
    card.style.animationDelay = `${(i * 0.025).toFixed(3)}s`;
    grid.appendChild(card);
  });
  wrap.dataset.loadedFor = userId;
}

async function toggleFollow(userId, currentlyFollowing) {
  // Earlier draft fired the supabase call without checking the result, so
  // RLS rejections / dupe-key errors silently produced "nothing happens"
  // even though the toast claimed success. Capture + surface the error.
  if (!_cfg.getCurrentUser()?.id) {
    toast('Sign in first', 'error');
    return;
  }
  if (userId === _cfg.getCurrentUser().id) {
    toast("You can't follow yourself", 'error');
    return;
  }
  try {
    if (currentlyFollowing) {
      const { error } = await supabase.from('follows')
        .delete()
        .eq('follower_id', _cfg.getCurrentUser().id)
        .eq('following_id', userId);
      if (error) throw error;
      toast('Unfollowed', 'success');
    } else {
      const { error } = await supabase.from('follows')
        .insert({ follower_id: _cfg.getCurrentUser().id, following_id: userId });
      // 23505 = unique_violation. Treat as already-following → no-op success.
      if (error && error.code !== '23505') throw error;
      toast('Following!', 'success');
      // Daily-goal: tick "Follow N new users". Deduped by target id so
      // follow → unfollow → re-follow within a day counts ONCE. Mirrors
      // mobile at components/Profile.jsx:199 + user-connections:365.
      try { _cfg.tickGoalUnique('follow_user', `follow:${userId}`); } catch {}
    }
  } catch (err) {
    console.error('[toggleFollow]', err);
    toast(err?.message || 'Could not update follow', 'error');
    return;
  }
  openProfile(userId);
}

// Profile tabs (Posts / Videos / Books / About)
document.querySelectorAll('.profile-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t === tab));

    const ids = { posts: 'profilePosts', videos: 'profileVideos', books: 'profileBooks', about: 'profileAbout' };
    Object.entries(ids).forEach(([key, id]) => {
      const el = document.getElementById(id);
      if (el) el.style.display = key === tabName ? '' : 'none';
    });

    // Lazy-load the heavy tabs only when first opened
    if (tabName === 'videos' && viewingProfileId) loadProfileVideos(viewingProfileId);
    else if (tabName === 'books' && viewingProfileId) loadProfileBooks(viewingProfileId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Edit profile modal — display-name cooldown, emoji-free, bio char/line limits
// ═══════════════════════════════════════════════════════════════════════════

// Tunables loaded from app_config — falls back to sensible defaults so the
// modal works even if the migration hasn't been applied yet.
const _profileEditDefaults = {
  max_bio_characters: 200,
  max_bio_lines: 5,
  display_name_change_cooldown_days: 60,
};
async function loadProfileEditDefaults() {
  try {
    const { data } = await supabase.from('app_config')
      .select('key, value_int')
      .in('key', Object.keys(_profileEditDefaults));
    for (const r of (data || [])) {
      if (r.value_int != null) _profileEditDefaults[r.key] = Number(r.value_int);
    }
  } catch {}
  return _profileEditDefaults;
}

// Reject anything in pictographic/emoji Unicode blocks. Allows accented letters,
// digits, and common punctuation — international names work fine.
function stripEmoji(s) {
  return (s || '').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}]/gu, '');
}
function hasEmoji(s) {
  return /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}]/u.test(s || '');
}

// ── Country / City lists ─────────────────────────────────────────────
// Philippines is the primary market — its cities are pre-listed for a clean
// dropdown UX. Other countries fall back to a free-text city input.
const COUNTRY_LIST = [
  'Philippines','United States','Canada','United Kingdom','Australia','Singapore','Malaysia','Indonesia','Thailand','Vietnam','Japan','South Korea','China','Hong Kong','Taiwan','India','Pakistan','Bangladesh','United Arab Emirates','Saudi Arabia','Qatar','Kuwait','Bahrain','Oman','Israel','Turkey','Germany','France','Spain','Italy','Portugal','Netherlands','Belgium','Switzerland','Sweden','Norway','Denmark','Finland','Ireland','Poland','Russia','Ukraine','Greece','Czechia','Austria','Hungary','Romania','New Zealand','Mexico','Brazil','Argentina','Chile','Colombia','Peru','South Africa','Egypt','Nigeria','Kenya','Morocco','Other'
];
const PH_CITIES = [
  'Manila','Quezon City','Caloocan','Pasig','Taguig','Makati','Parañaque','Las Piñas','Muntinlupa','Mandaluyong','San Juan','Marikina','Pasay','Valenzuela','Malabon','Navotas','Pateros',
  'Cebu City','Mandaue','Lapu-Lapu','Davao City','Iloilo City','Bacolod','Cagayan de Oro','Zamboanga City','General Santos','Baguio','Antipolo','Dasmariñas','Bacoor','Imus','Calamba','Santa Rosa','Lipa','Batangas City','Tarlac City','Angeles','San Fernando (Pampanga)','Olongapo','Naga','Legazpi','Tacloban','Butuan','Cotabato City','Iligan','Tagum','Puerto Princesa','Malolos','Meycauayan','San Jose del Monte','Other'
];

function populateCountryDropdown() {
  const sel = document.getElementById('editCountry');
  if (!sel || sel.dataset.populated === '1') return;
  for (const c of COUNTRY_LIST) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  }
  sel.dataset.populated = '1';
}
function populatePhCityDropdown() {
  const sel = document.getElementById('editCity');
  if (!sel || sel.dataset.populated === '1') return;
  for (const c of PH_CITIES) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  }
  sel.dataset.populated = '1';
}

function applyCountryUI(country) {
  // Country = Philippines → show city dropdown. Anything else → show city text input.
  const citySel  = document.getElementById('editCity');
  const cityInp  = document.getElementById('editCityInput');
  if (!citySel || !cityInp) return;
  if (country === 'Philippines') {
    citySel.style.display = '';
    cityInp.style.display = 'none';
  } else {
    citySel.style.display = 'none';
    cityInp.style.display = '';
  }
}

function getCurrentCity() {
  const country = document.getElementById('editCountry').value || '';
  if (country === 'Philippines') {
    const v = document.getElementById('editCity').value || '';
    return v === 'Other' ? '' : v;
  }
  return (document.getElementById('editCityInput').value || '').trim();
}

// Parse a stored location string ("City, Country") into {country, city}.
// Tolerates older free-form values — falls back to dumping the whole string
// into city if we can't match the country.
function parseLocation(loc) {
  if (!loc) return { country: '', city: '' };
  const parts = loc.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1];
    const matchedCountry = COUNTRY_LIST.find(c => c.toLowerCase() === tail.toLowerCase());
    if (matchedCountry) {
      const city = parts.slice(0, -1).join(', ');
      return { country: matchedCountry, city };
    }
  }
  // Fallback — country unknown
  return { country: '', city: loc };
}

async function openEditProfile(profile) {
  const cfg = await loadProfileEditDefaults();
  const usernameEl = document.getElementById('editUsername');
  const bioEl      = document.getElementById('editBio');
  const hintEl     = document.getElementById('editUsernameHint');

  // Strip emoji on initial load too — old saved values (from before the emoji
  // rule shipped) would otherwise re-display in the input.
  usernameEl.value = stripEmoji(profile.username || '');
  // Clamp bio on initial load to the line limit (in case it was saved before
  // the limit existed)
  bioEl.value      = clampBioLines(profile.bio || '');
  document.getElementById('editWebsite').value  = profile.website  || '';

  // ── Country + City ──
  populateCountryDropdown();
  populatePhCityDropdown();
  const { country, city } = parseLocation(profile.location);
  document.getElementById('editCountry').value = country;
  applyCountryUI(country);
  if (country === 'Philippines') {
    const phMatch = PH_CITIES.find(c => c.toLowerCase() === (city || '').toLowerCase());
    document.getElementById('editCity').value = phMatch || '';
    document.getElementById('editCityInput').value = '';
  } else {
    document.getElementById('editCityInput').value = city || '';
    document.getElementById('editCity').value = '';
  }

  // ── Display-name cooldown UI ──
  // Fetch the cooldown timestamp on-demand. Tolerates the column being absent
  // (returns null) so the rest of the app still works before the migration runs.
  let dnChangedAt = profile.display_name_changed_at || null;
  if (!dnChangedAt) {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('display_name_changed_at')
        .eq('id', _cfg.getCurrentUser().id)
        .single();
      if (!error && data) dnChangedAt = data.display_name_changed_at || null;
    } catch {} // column doesn't exist yet — treat as never-changed
  }
  const lastChange = dnChangedAt ? new Date(dnChangedAt) : null;
  const cooldownMs = (cfg.display_name_change_cooldown_days || 60) * 86400 * 1000;
  const nextAllowed = lastChange ? new Date(lastChange.getTime() + cooldownMs) : null;
  const onCooldown = nextAllowed && nextAllowed > new Date();

  if (onCooldown) {
    usernameEl.disabled = true;
    hintEl.classList.add('is-locked');
    const dateStr = nextAllowed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const days = Math.ceil((nextAllowed - new Date()) / 86400000);
    hintEl.textContent = `Display name is locked. You can change it again on ${dateStr} (${days} day${days===1?'':'s'} from now).`;
  } else {
    usernameEl.disabled = false;
    hintEl.classList.remove('is-locked');
    hintEl.textContent = `Letters, numbers and basic punctuation only — no emoji. You can change this once every ${cfg.display_name_change_cooldown_days || 60} days.`;
  }

  // ── Bio counters ──
  updateBioCounter();

  document.getElementById('editProfileModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeEditProfile() {
  document.getElementById('editProfileModal').classList.remove('open');
  document.body.style.overflow = '';
}

function updateBioCounter() {
  const el = document.getElementById('editBio');
  const countEl = document.getElementById('editBioCount');
  const linesEl = document.getElementById('editBioLines');
  if (!el || !countEl || !linesEl) return;
  const v = el.value || '';
  const maxC = _profileEditDefaults.max_bio_characters || 200;
  const maxL = _profileEditDefaults.max_bio_lines || 5;
  const lines = v ? (v.split('\n').length) : 1;
  countEl.textContent = `${v.length} / ${maxC}`;
  linesEl.textContent = `${lines} / ${maxL} lines`;
  countEl.classList.remove('is-warn','is-bad');
  linesEl.classList.remove('is-warn','is-bad');
  if (v.length > maxC) countEl.classList.add('is-bad');
  else if (v.length > maxC * 0.9) countEl.classList.add('is-warn');
  if (lines > maxL) linesEl.classList.add('is-bad');
  else if (lines === maxL) linesEl.classList.add('is-warn');
}

document.getElementById('editProfileClose').addEventListener('click', closeEditProfile);
document.getElementById('editProfileCancel').addEventListener('click', closeEditProfile);
document.getElementById('editProfileModal').addEventListener('click', (e) => { if (e.target.id === 'editProfileModal') closeEditProfile(); });

// Live: strip emoji as user types into display name
document.getElementById('editUsername').addEventListener('input', (e) => {
  const cleaned = stripEmoji(e.target.value);
  if (cleaned !== e.target.value) e.target.value = cleaned;
});

// Hard-cap bio at the configured line count. Blocks Enter past the limit and
// trims pasted multi-line text down to N lines.
function clampBioLines(text) {
  const max = _profileEditDefaults.max_bio_lines || 5;
  const lines = (text || '').split('\n');
  if (lines.length <= max) return text || '';
  return lines.slice(0, max).join('\n');
}

const _bioEl = document.getElementById('editBio');
_bioEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const max = _profileEditDefaults.max_bio_lines || 5;
  const lines = (e.target.value || '').split('\n').length;
  if (lines >= max) e.preventDefault();   // refuse new line at the cap
});
_bioEl.addEventListener('paste', (e) => {
  // Re-clamp after paste so pasting a 12-line block gets trimmed to 5
  setTimeout(() => {
    const clamped = clampBioLines(e.target.value);
    if (clamped !== e.target.value) e.target.value = clamped;
    updateBioCounter();
  }, 0);
});

// Live: bio counter updates
_bioEl.addEventListener('input', updateBioCounter);

// Country change: swap city UI between dropdown (PH) and free-text input
document.getElementById('editCountry').addEventListener('change', (e) => {
  applyCountryUI(e.target.value);
  // Clear stale city value on country swap
  document.getElementById('editCity').value = '';
  document.getElementById('editCityInput').value = '';
});

document.getElementById('editProfileSave').addEventListener('click', async () => {
  const btn = document.getElementById('editProfileSave');
  const usernameEl = document.getElementById('editUsername');

  // Client-side guards — server still re-validates as source of truth
  let username = stripEmoji(usernameEl.value).trim();
  const bio    = (document.getElementById('editBio').value || '').trim();
  const country = (document.getElementById('editCountry').value || '').trim();
  const city   = getCurrentCity();
  // Compose location: "City, Country" if both present, just country if no city,
  // empty string to clear.
  const loc = (city && country) ? `${city}, ${country}` : (country || '');
  // Website field removed from the form — pass null to preserve any existing
  // value in the DB (the RPC's coalesce-style update won't overwrite when null).
  const web    = null;

  if (!username) { toast('Display name is required', 'error'); return; }
  if (hasEmoji(username)) { toast('Display name cannot contain emoji', 'error'); return; }

  const maxC = _profileEditDefaults.max_bio_characters || 200;
  const maxL = _profileEditDefaults.max_bio_lines || 5;
  if (bio.length > maxC) { toast(`Bio is too long (max ${maxC} characters)`, 'error'); return; }
  if (bio && bio.split('\n').length > maxL) { toast(`Bio has too many lines (max ${maxL})`, 'error'); return; }

  btn.disabled = true; btn.textContent = 'Saving...';

  // If display name field is disabled (cooldown), don't try to send it
  const sendUsername = usernameEl.disabled ? null : username;

  const { data, error } = await supabase.rpc('update_profile', {
    p_username: sendUsername,
    p_bio: bio,
    p_location: loc,
    p_website: web,
  });

  btn.disabled = false; btn.textContent = 'Save';

  if (error) { toast(error.message, 'error'); return; }
  if (!data || data.ok === false) {
    const code = data?.error;
    const msg = {
      not_authenticated:    'Please sign in again',
      username_required:    'Display name is required',
      emoji_not_allowed:    'Display name cannot contain emoji',
      name_change_cooldown: data?.next_allowed_at
        ? `You can change your name again on ${new Date(data.next_allowed_at).toLocaleDateString()}`
        : `Display name is locked for ${data?.cooldown_days || 60} days between changes`,
      bio_too_long:         `Bio is too long (max ${data?.max_chars || maxC} characters)`,
      bio_too_many_lines:   `Bio has too many lines (max ${data?.max_lines || maxL})`,
    }[code] || (code || 'Could not save profile');
    toast(msg, 'error');
    return;
  }

  toast('Profile updated!', 'success');
  closeEditProfile();
  const { data: updated } = await supabase.from('profiles').select(_cfg.PROFILE_DISPLAY_COLS).eq('id', _cfg.getCurrentUser().id).single();
  if (updated) _cfg.setCurrentProfile(updated);   // keep stale on fetch fail rather than nulling
  _cfg.updateTopbarUser();
  openProfile(_cfg.getCurrentUser().id);
});

// ── Image cropper ──


// Avatar upload
document.getElementById('editAvatarBtn').addEventListener('click', () => document.getElementById('avatarInput').click());
document.getElementById('avatarInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  _cfg.openCropModal(file, 1, 'avatar_url', 'Crop your avatar');
  e.target.value = '';
});

// Banner upload
document.getElementById('editBannerBtn').addEventListener('click', () => document.getElementById('bannerInput').click());
document.getElementById('bannerInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  _cfg.openCropModal(file, 3, 'banner_url', 'Crop your cover photo');
  e.target.value = '';
});
// Open own profile from sidebar
async function openMyProfile() {
  if (!_cfg.getCurrentUser()) {
    toast('Loading your profile...', '');
    return;
  }
  // Make sure profile is loaded before opening
  if (!_cfg.getCurrentProfile()) {
    const { data: profile, error } = await supabase.from('profiles').select(_cfg.PROFILE_DISPLAY_COLS).eq('id', _cfg.getCurrentUser().id).single();
    if (error) { toast('Could not load your profile', 'error'); return; }
    _cfg.setCurrentProfile(profile || null);
    if (!_cfg.getCurrentProfile()) { toast('Profile not found', 'error'); return; }
  }
  openProfile(_cfg.getCurrentUser().id);
}
document.getElementById('btnProfile').addEventListener('click', () => {
  _cfg.setSidebarActive('btnProfile');
  openMyProfile();
});
document.getElementById('topbarAvatar').addEventListener('click', () => {
  _cfg.setSidebarActive('btnProfile');
  openMyProfile();
});
