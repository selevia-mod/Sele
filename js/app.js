import { supabase, REACTIONS, timeAgo, initials, callEdgeFunction } from './supabase.js';

// Columns we actually use from the profiles table — explicit list cuts payload
// vs SELECT * (which pulls email, legacy ids, server-only fields, etc.).
const PROFILE_DISPLAY_COLS = 'id, username, avatar_url, bio, banner_url, location, website, is_guest, is_banned, role, pioneer_at, created_at';

// ─── Role-verified seal badge (Facebook-style) ──────────────────────────────────
// Renders a 12-bump scalloped seal SVG with per-role colors (outer circle, inner
// circle fill, white checkmark). Matches mobile RoleVerifiedBadge design.

const ROLE_VERIFIED_PALETTE = {
  Creator:  { outer: '#D4A017', inner: '#F5C84B' },
  Writer:   { outer: '#1d4ed8', inner: '#60a5fa' },
  Pioneer:  { outer: '#7c3aed', inner: '#a78bfa' },
  Moderator: { outer: '#9f1239', inner: '#e11d48' },
  Auditor:  { outer: '#0369a1', inner: '#38bdf8' },
  User:     { outer: '#475569', inner: '#94a3b8' },
};

// One-time module-scope path: 12 bumps, peak radius 48, valley radius 39, center (50,50).
// Identical for every render — only fill colors change. Quadratic Beziers produce smooth
// scalloped silhouette.
const SCALLOPED_OUTLINE_D = (() => {
  const cx = 50, cy = 50, rOuter = 48, rInner = 39, bumps = 12;
  const segments = [];
  for (let i = 0; i < bumps; i++) {
    const aStart = (i / bumps) * Math.PI * 2 - Math.PI / 2;
    const aEnd = ((i + 1) / bumps) * Math.PI * 2 - Math.PI / 2;
    const aPeak = ((i + 0.5) / bumps) * Math.PI * 2 - Math.PI / 2;

    const sx = (cx + rInner * Math.cos(aStart)).toFixed(2);
    const sy = (cy + rInner * Math.sin(aStart)).toFixed(2);
    const ex = (cx + rInner * Math.cos(aEnd)).toFixed(2);
    const ey = (cy + rInner * Math.sin(aEnd)).toFixed(2);
    const px = (cx + rOuter * Math.cos(aPeak)).toFixed(2);
    const py = (cy + rOuter * Math.sin(aPeak)).toFixed(2);

    if (i === 0) segments.push(`M${sx},${sy}`);
    segments.push(`Q${px},${py} ${ex},${ey}`);
  }
  segments.push('Z');
  return segments.join(' ');
})();

// renderRoleSeal(profile, sizePx) → HTML string (inline SVG or '')
//
// Reads roles from EITHER profile.role (legacy single string column) OR
// profile.roles (newer text[] column). Both are stored lowercase
// ("creator","writer","pioneer","moderator","auditor"); we normalize
// to the capitalized palette keys here so the seal colors match
// regardless of which storage form a given profile has.
//
// Role priority when a user has multiple: Pioneer > Moderator > Creator
// > Writer > Auditor. Returns '' when no role applies — safe to drop
// inline anywhere without a wrapper check.
function renderRoleSeal(profile, sizePx = 16) {
  if (!profile) return '';

  const rolesArray = Array.isArray(profile.roles) ? profile.roles : [];
  const roleString = typeof profile.role === 'string' ? profile.role : '';
  const has = (key) => rolesArray.includes(key) || roleString === key;

  // Priority order (high → low): moderator > pioneer > creator >
  // writer > auditor. One badge per user — first match wins. Matches
  // backfill-roles.js resolveRole() and mobile UserRoleBadgeIcons so
  // the same user shows the same seal everywhere.
  let role = null;
  if (has('moderator')) role = 'Moderator';
  else if (has('pioneer')) role = 'Pioneer';
  else if (has('creator')) role = 'Creator';
  else if (has('writer')) role = 'Writer';
  else if (has('auditor')) role = 'Auditor';
  if (!role) return '';

  const colors = ROLE_VERIFIED_PALETTE[role];
  return `<svg width="${sizePx}" height="${sizePx}" viewBox="0 0 100 100" style="vertical-align:-3px;margin-left:4px" aria-label="${role}"><title>${role}</title>
    <path d="${SCALLOPED_OUTLINE_D}" fill="${colors.outer}"/>
    <circle cx="50" cy="50" r="30" fill="${colors.inner}"/>
    <path d="M35.5 51.5 L45.5 61.5 L65 41" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;
}

// Set footer copyright year dynamically — never goes stale across new years
{
  const y = document.getElementById('footerYear');
  if (y) y.textContent = new Date().getFullYear();
}

// ─── Sentry helper ────────────────────────────────────────────────────────
// Wraps Sentry calls so the app keeps working if Sentry isn't loaded
// (no DSN configured yet). Use everywhere we want to log a real error.
function captureError(err, context = {}) {
  if (typeof window.Sentry !== 'undefined' && Sentry.captureException) {
    try {
      Sentry.captureException(err, { extra: context });
    } catch {}
  }
  // Always also log locally so DevTools shows it during dev
  console.error(err, context);
}

// Catch unhandled errors that escape try/catch blocks. Sentry already does
// this on its own, but having a fallback means logs reach the console even
// when Sentry isn't initialized yet.
window.addEventListener('error', (e) => captureError(e.error || new Error(e.message), { source: 'window.onerror', filename: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => captureError(e.reason || new Error('Unhandled promise rejection'), { source: 'unhandledrejection' }));

// Reset window scroll across all common scroll containers (covers Safari edge
// cases where `body` vs `documentElement` is the scrolling element).
function scrollToTop() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

// Remove any open modal-backdrop matching `selector` (default: all of them).
function closeAllModals(selector = '.modal-backdrop') {
  document.querySelectorAll(selector).forEach(m => m.remove());
}

let currentUser = null;
let currentProfile = null;
let posts = [];

// ── Wallet state (coins + stars + unlocks) ──────────────────────────────────
// Maintained by loadWalletState() on signin and refreshed via Realtime
// subscription on the wallets row. Other modules (chapter reader, video
// player, lock modals) read from these and call refreshWalletAfterUnlock()
// after a successful unlock_content RPC.
let _wallet = { coin_balance: 0, star_balance: 0 };
const _userUnlocks = new Set();   // keys like "video:UUID" or "chapter:aw_xyz"
let _walletConfigDefaults = {     // mirrors app_config; loaded once on signin
  default_chapter_unlock_coins:    3,
  default_chapter_unlock_stars:    3,
  default_video_unlock_coins:      1,
  default_video_unlock_stars:      1,
  star_daily_cap:                  20,
  book_bulk_unlock_discount_pct:   15,   // Phase 6
  video_initial_unlock_seconds:    180,  // Phase 6 — 3 min before first video unlock
  video_recurring_unlock_seconds:  600,  // Phase 6 — 10 min star window
  min_chapter_words:               100,  // chapter publish floor
  max_chapter_words:               10000, // chapter publish ceiling
};
let _walletChannel = null;

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

async function uploadImage(file) {
  if (!file) return null;
  if (!file.type.startsWith('image/')) { toast('Please select an image file', 'error'); return null; }
  if (file.size > 5 * 1024 * 1024) { toast('Image must be smaller than 5MB', 'error'); return null; }
  const ext = file.name.split('.').pop().toLowerCase();
  const filename = `${currentUser.id}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  const { error } = await supabase.storage.from('images').upload(filename, file, { cacheControl: '3600', upsert: false });
  if (error) { toast('Upload failed: ' + error.message, 'error'); return null; }
  const { data } = supabase.storage.from('images').getPublicUrl(filename);
  return data.publicUrl;
}

window.openLightbox = (url) => {
  document.getElementById('lightboxImg').src = url;
  document.getElementById('lightbox').classList.add('open');
};
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox' || e.target.id === 'lightboxClose') document.getElementById('lightbox').classList.remove('open');
});

// ── Auth ──
async function initAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) await onSignedIn(session.user);
  else showAuth();

  let isFirstAuthEvent = true;
  // CRITICAL: this callback must NOT be async and must NOT await any Supabase
  // calls. Supabase holds an internal auth lock while this runs; awaiting
  // queries here deadlocks the whole client (every subsequent query hangs
  // forever). The symptom is "every page stuck on Loading…, fixed by a hard
  // refresh, returns ~1h later when the token refreshes". See:
  // https://github.com/supabase/auth-js/issues/762
  //
  // We defer real work with setTimeout(0) so the callback returns and the
  // lock releases before any query runs. We also only re-init on actual
  // sign-in / sign-out — TOKEN_REFRESHED and USER_UPDATED fire periodically
  // and don't need full re-init (Supabase already swapped the token
  // internally; re-running onSignedIn would just re-fetch profile + reroute).
  //
  // Tab visibility note: when the user switches away and back, Supabase
  // re-validates the session and may fire SIGNED_IN even though the user
  // hasn't changed. We guard against that with the same-user check so we
  // don't repaint the whole app's loading state on every tab focus.
  supabase.auth.onAuthStateChange((event, session) => {
    if (isFirstAuthEvent) { isFirstAuthEvent = false; return; }
    if (event === 'SIGNED_IN' && session) {
      // Same user as before? This is a session re-validation (tab focus,
      // cross-tab sync, etc.), not a fresh sign-in. Skip re-init.
      if (currentUser && currentUser.id === session.user.id) return;
      setTimeout(() => { onSignedIn(session.user); }, 0);
    } else if (event === 'SIGNED_OUT') {
      // showAuth() touches DOM only — safe to call directly.
      showAuth();
    }
    // TOKEN_REFRESHED / USER_UPDATED / PASSWORD_RECOVERY: intentional no-op.
  });
}

async function onSignedIn(user) {
  currentUser = user;
  // Books page: invalidate the user-scoped tab cache (Reading List) so a
  // fresh sign-in re-fetches it instead of reusing the previous user's
  // (or the signed-out) state.
  if (typeof _bookTabLoaded !== 'undefined') {
    _bookTabLoaded.readinglist = false;
  }
  // Defensive: if the profile row doesn't exist yet (rare race on first sign-in),
  // keep currentProfile null so downstream code can short-circuit cleanly.
  const { data: profile, error: profileErr } = await supabase.from('profiles').select(PROFILE_DISPLAY_COLS).eq('id', user.id).single();
  if (profileErr) console.warn('Profile fetch failed on sign-in:', profileErr.message);
  currentProfile = profile || null;
  updateTopbarUser();
  showApp();

  // Load user's content filters (hidden posts, snoozed users, blocked users)
  // — fire-and-forget; loadFeed will refresh them anyway
  loadUserContentFilters();

  // Wallet (coins + stars + unlock map) — fire-and-forget; topbar pill renders
  // when ready.
  loadWalletState();

  // Notifications — fetch initial batch + start realtime subscription
  initNotifications();

  // Path-based book deep links. Two acceptable inbound shapes:
  //   /books/<id>               → book detail
  //   /books/<id>/chapter/<n>   → book + chapter open
  // openBookDetail handles both UUID and legacy Appwrite hex ids
  // (resolves via the `legacy_appwrite_id` column when not a UUID), so a
  // single match works for both new and old shareable URLs. Mobile's
  // Universal Links / App Links also key off `/books/<id>` paths, which
  // is why we standardize the URL bar on path-based — hash fragments
  // (#book/<id>) are stripped by iOS / Android before deep-link match
  // and can never open the app.
  const path = window.location.pathname || '';
  const bookChapterPath = path.match(/^\/books?\/([^\/?#]+)\/chapter\/([^\/?#]+)/);
  const bookOnlyPath = !bookChapterPath ? path.match(/^\/books?\/([^\/?#]+)$/) : null;
  if (bookChapterPath || bookOnlyPath) {
    // We render via the SPA's existing entry points instead of redirecting
    // to a hash form. This keeps the URL bar clean and shareable.
    setSidebarActive('btnBook');
    const bookId = (bookChapterPath || bookOnlyPath)[1];
    // openBookDetail will canonicalize the URL via replaceState so it
    // matches whatever path shape it loaded under.
    openBookDetail(bookId);
    if (bookChapterPath) {
      // Chapter restoration is best-effort — _openChapterFromUrl reads
      // the path again once the book's chapter list has loaded.
      _pendingChapterFromUrl = bookChapterPath[2];
    }
    // Fall through still loads the home shell (sidebar / header / etc.).
  }

  // Check URL hash for routing
  const hash = window.location.hash;
  if (hash.startsWith('#profile/')) {
    loadStories();
    loadFeed();
    openProfile(hash.replace('#profile/', ''));
  } else if (hash === '#videos') {
    setSidebarActive('btnVideos');
    showVideos();
  } else if (hash === '#studio') {
    setSidebarActive('btnStudio');
    showStudio();
  } else if (hash === '#book') {
    setSidebarActive('btnBook');
    showBook();
  } else if (hash.startsWith('#book/')) {
    setSidebarActive('btnBook');
    const bookId = hash.replace('#book/', '').split('/')[0];
    openBookDetail(bookId);
  } else if (hash === '#author') {
    setSidebarActive('btnAuthor');
    showAuthor();
  } else if (hash.startsWith('#author/book/')) {
    setSidebarActive('btnAuthor');
    const parts = hash.replace('#author/book/', '').split('/');
    const bookId = parts[0];
    if (parts[2]) {
      openAuthorChapterEditor(bookId, parts[2] === 'new' ? null : parts[2]);
    } else {
      openAuthorBookEditor(bookId);
    }
  } else if (hash.startsWith('#video/')) {
    setSidebarActive('btnVideos');
    playVideo(hash.replace('#video/', ''));
  } else if (hash === '#bookmarks') {
    setSidebarActive('btnBookmarks');
    showBookmarks();
  } else if (hash === '#store') {
    showStore();
  } else if (hash === '#earnings') {
    showEarnings();
  } else {
    loadStories();
    loadFeed();
  }
}

function showAuth() {
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('appScreen').style.display = 'none';
  document.body.classList.add('is-auth');
}
function showApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = 'block';
  document.body.classList.remove('is-auth');
}

function updateTopbarUser() {
  if (!currentProfile) return;
  const name = currentProfile.username || 'User';
  const avatarEl = document.getElementById('topbarAvatar');
  const composeAvatarEl = document.getElementById('composeAvatar');
  const avatarHTML = currentProfile.avatar_url ? `<img src="${currentProfile.avatar_url}" alt="${name}"/>` : initials(name);
  avatarEl.innerHTML = avatarHTML;
  composeAvatarEl.innerHTML = avatarHTML;
}

// ── Auth-screen consent gate ─────────────────────────────────────────────
// Both sign-in buttons stay disabled until the user checks the "I agree to
// Terms / Privacy / Refund + I'm 16 or older" checkbox. We don't persist the
// state across sessions on purpose — every fresh sign-in re-acknowledges,
// which is the most defensible posture under PH DPA + Terms case-law.
function syncAuthConsentGate() {
  const cb        = document.getElementById('authConsentCheck');
  const googleBtn = document.getElementById('btnGoogle');
  const guestBtn  = document.getElementById('btnGuest');
  const label     = document.getElementById('authConsentLabel');
  const checked   = !!cb?.checked;
  if (googleBtn) googleBtn.disabled = !checked;
  if (guestBtn)  guestBtn.disabled  = !checked;
  if (label)     label.classList.toggle('is-checked', checked);
}
document.getElementById('authConsentCheck')?.addEventListener('change', syncAuthConsentGate);
syncAuthConsentGate();

document.getElementById('btnGoogle').addEventListener('click', async () => {
  if (!document.getElementById('authConsentCheck')?.checked) {
    toast('Please agree to the Terms and Privacy Policy first.', 'error');
    return;
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
  if (error) toast(error.message, 'error');
});
document.getElementById('btnGuest').addEventListener('click', async () => {
  if (!document.getElementById('authConsentCheck')?.checked) {
    toast('Please agree to the Terms and Privacy Policy first.', 'error');
    return;
  }
  const { error } = await supabase.auth.signInAnonymously();
  if (error) toast(error.message, 'error');
});

async function signOut() {
  // Tear down ALL user-scoped realtime channels BEFORE auth.signOut() so we
  // don't leak callbacks that try to write into stale state for the next
  // session. Public broadcast channels (e.g. 'public-feed') stay subscribed.
  const teardown = (ch) => { try { if (ch) supabase.removeChannel(ch); } catch {} };

  // Wallet
  teardown(_walletChannel);              _walletChannel = null;
  // Notifications
  teardown(_notifChannel);               _notifChannel = null;
  // DMs (inbox + per-thread + presence)
  if (typeof dmState !== 'undefined' && dmState) {
    teardown(dmState.inboxChannel);      dmState.inboxChannel = null;
    teardown(dmState.realtimeChannel);   dmState.realtimeChannel = null;
    teardown(dmState.presenceChannel);   dmState.presenceChannel = null;
  }

  await supabase.auth.signOut();

  // Reset all user-scoped state — leaving stale data in memory was causing
  // the next signed-in user to briefly see the previous user's wallet/profile.
  currentUser = null;
  currentProfile = null;
  posts = [];
  _wallet = { coin_balance: 0, star_balance: 0 };
  _userUnlocks.clear();
  // Reset book caches so the next user doesn't see prior browsing state.
  if (typeof allBooksCache !== 'undefined') allBooksCache = [];
  if (typeof allBooksRaw   !== 'undefined') allBooksRaw   = [];
  if (typeof _booksLoadedSort  !== 'undefined') _booksLoadedSort  = null;
  if (typeof _booksLoadedGenre !== 'undefined') _booksLoadedGenre = null;
  // Reset the v2 tabbed-books "first-visit" flags so the personal tab
  // (Reading List) re-fetches when the user signs back in. Otherwise it'd
  // stay stuck showing "Sign in to see your reading list" until a hard reload.
  if (typeof _bookTabLoaded !== 'undefined') {
    _bookTabLoaded.foryou      = false;
    _bookTabLoaded.discover    = false;
    _bookTabLoaded.ranking     = false;
    _bookTabLoaded.readinglist = false;
  }
  // Reset user-taste cache (book reads + likes) — would otherwise show
  // previous user's reading interests in the Discover ribbon.
  if (typeof _userBookTasteCache !== 'undefined') {
    _userBookTasteCache = null;
    _userBookTasteAt = 0;
  }
  // Personalised book recs cache is also user-scoped
  if (typeof _bookRecsCache !== 'undefined') {
    _bookRecsCache = null;
    _bookRecsTimestamp = 0;
  }
  // Earnings/withdrawal/bookmarks page-load timestamps so the next user
  // doesn't inherit "we already loaded this" stale gates.
  ['_earningsLoadedAt', '_authorLoadedAt', '_bookmarksLoadedAt', '_dmListLoadedAt'].forEach(k => {
    if (k in window) window[k] = 0;
  });
}

// ════════════════════════════════════════════════════════════════════════════
// WALLET — coins + stars + unlocks (Phase 5 — user-facing)
// ════════════════════════════════════════════════════════════════════════════

async function loadWalletState() {
  if (!currentUser) return;

  // Wallet row + unlocks + app_config defaults — three queries in parallel.
  const [walletRes, unlocksRes, configRes] = await Promise.all([
    supabase.from('wallets').select('coin_balance, star_balance').eq('user_id', currentUser.id).maybeSingle(),
    supabase.from('unlocks').select('target_type, target_id').eq('user_id', currentUser.id),
    supabase.from('app_config').select('key, value_int'),
  ]);

  if (walletRes.data) _wallet = walletRes.data;
  // No row yet (e.g. brand new account before trigger fires) → start at zero.
  else _wallet = { coin_balance: 0, star_balance: 0 };

  _userUnlocks.clear();
  for (const u of (unlocksRes.data || [])) {
    _userUnlocks.add(`${u.target_type}:${u.target_id}`);
  }

  for (const c of (configRes.data || [])) {
    if (c.key in _walletConfigDefaults) _walletConfigDefaults[c.key] = c.value_int;
  }

  renderTopbarCoinPill();

  // Live updates: re-render on any change to my wallet row
  if (_walletChannel) supabase.removeChannel(_walletChannel);
  _walletChannel = supabase
    .channel(`wallet-${currentUser.id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'wallets', filter: `user_id=eq.${currentUser.id}` },
      (payload) => {
        _wallet = { coin_balance: payload.new.coin_balance, star_balance: payload.new.star_balance };
        renderTopbarCoinPill();
      })
    .subscribe();
}

function renderTopbarCoinPill() {
  const coinEl = document.getElementById('topbarCoinBalance');
  const starEl = document.getElementById('topbarStarBalance');
  if (coinEl) coinEl.textContent = formatBalance(_wallet.coin_balance);
  if (starEl) starEl.textContent = formatBalance(_wallet.star_balance);
}

function formatBalance(n) {
  // 1234 → "1,234"; 12345678 → "12.3M"; keeps the pill compact.
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 10_000)    return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

// Has the current user unlocked this content?
function isUnlocked(targetType, targetId) {
  return _userUnlocks.has(`${targetType}:${targetId}`);
}

// Resolve cost: per-row override → app_config default
function resolveUnlockCost(targetType, currency, row) {
  const colCoins = row?.unlock_cost_coins;
  const colStars = row?.unlock_cost_stars;
  if (currency === 'coin') {
    if (Number.isFinite(colCoins) && colCoins > 0) return colCoins;
    return _walletConfigDefaults[targetType === 'video' ? 'default_video_unlock_coins' : 'default_chapter_unlock_coins'];
  } else {
    if (Number.isFinite(colStars) && colStars > 0) return colStars;
    return _walletConfigDefaults[targetType === 'video' ? 'default_video_unlock_stars' : 'default_chapter_unlock_stars'];
  }
}

// Premium unlock modal — two big buttons (coins or stars), insufficient
// balance disables the button with a hint. On success, updates _wallet,
// adds to _userUnlocks, fires onUnlocked() so the caller can re-render.
function openUnlockDialog({ targetType, targetId, row, title, onUnlocked }) {
  const costCoins = resolveUnlockCost(targetType, 'coin', row);
  const costStars = resolveUnlockCost(targetType, 'star', row);
  const canCoin = _wallet.coin_balance >= costCoins;
  const canStar = _wallet.star_balance >= costStars;

  // Remove any prior modal (defensive)
  document.querySelector('.unlock-modal-backdrop')?.remove();

  const modal = document.createElement('div');
  modal.className = 'unlock-modal-backdrop';
  modal.innerHTML = `
    <div class="unlock-modal" role="dialog" aria-modal="true">
      <button class="unlock-modal-close" aria-label="Close">×</button>
      <div class="unlock-modal-icon">🔒</div>
      <h2>Unlock this ${targetType}</h2>
      ${title ? `<p class="unlock-modal-title">${escHTML(title)}</p>` : ''}
      <p class="unlock-modal-sub">Pay once and read/watch as many times as you like.</p>
      <div class="unlock-options">
        <button class="unlock-option unlock-option-coin ${canCoin ? '' : 'is-disabled'}" data-cur="coin" ${canCoin ? '' : 'disabled'}>
          <span class="unlock-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3" fill="#fbbf24" stroke="#b45309" stroke-width="1"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" fill="#fde68a" stroke="#b45309" stroke-width="1"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" fill="#fbbf24" stroke="#b45309" stroke-width="1"/></svg>
          </span>
          <span class="unlock-option-cost">${costCoins}</span>
          <span class="unlock-option-label">Coin${costCoins === 1 ? '' : 's'}</span>
          <span class="unlock-option-hint">${canCoin ? 'Tap to unlock' : `You have ${_wallet.coin_balance}`}</span>
        </button>
        <div class="unlock-or">or</div>
        <button class="unlock-option unlock-option-star ${canStar ? '' : 'is-disabled'}" data-cur="star" ${canStar ? '' : 'disabled'}>
          <span class="unlock-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 2l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16l-5.6 3.2 1.5-6.3L3 8.7l6.4-.5z" fill="#a855f7"/></svg>
          </span>
          <span class="unlock-option-cost">${costStars}</span>
          <span class="unlock-option-label">Star${costStars === 1 ? '' : 's'}</span>
          <span class="unlock-option-hint">${canStar ? 'Tap to unlock' : `You have ${_wallet.star_balance}`}</span>
        </button>
      </div>
      ${(!canCoin && !canStar) ? '<p class="unlock-need-more">Not enough coins or stars yet. Open the Store to top up, or watch ads to earn stars.</p>' : ''}
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('open'));

  const close = () => { modal.classList.remove('open'); setTimeout(() => modal.remove(), 180); };
  modal.querySelector('.unlock-modal-close').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelectorAll('.unlock-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const currency = btn.dataset.cur;
      btn.classList.add('is-loading');
      const { data, error } = await supabase.rpc('unlock_content', {
        p_target_type: targetType,
        p_target_id:   targetId,
        p_currency:    currency,
      });
      btn.classList.remove('is-loading');
      if (error) { toast(error.message, 'error'); return; }
      if (!data?.ok) {
        toast(data?.error === 'insufficient_balance' ? 'Insufficient balance' : (data?.error || 'Unlock failed'), 'error');
        return;
      }
      // Local state update (Realtime will also push, but this avoids the flicker)
      if (currency === 'coin') _wallet.coin_balance = data.balance_after;
      else                     _wallet.star_balance = data.balance_after;
      _userUnlocks.add(`${targetType}:${targetId}`);
      renderTopbarCoinPill();
      close();
      toast(data.already_unlocked ? 'Already unlocked' : `Unlocked! −${data.cost} ${currency}${data.cost === 1 ? '' : 's'}`, 'success');
      if (typeof onUnlocked === 'function') onUnlocked();
    });
  });
}

// ── Phase 6: time-based video monetization gate ─────────────────────────
//
// Attaches a `timeupdate` listener to the video player. When the user crosses
// the next paid threshold (180s initially, then every 600s), pauses the
// video and prompts: "1 coin to unlock forever, or 1 star for the next 10
// minutes." Coin path → permanent unlock recorded in `unlocks` table; the
// listener's nextThreshold is set to Infinity so it never fires again. Star
// path → bumps nextThreshold by `recurring_window` and waits for the next
// crossing. Re-watching below paid_through_seconds is always free.
let _videoMonetGate = null;  // { videoId, listener }

async function setupVideoMonetGate(player, sbId, video) {
  // Tear down any previous listener
  teardownVideoMonetGate(player);

  const initialSec   = _walletConfigDefaults.video_initial_unlock_seconds   || 180;
  const recurringSec = _walletConfigDefaults.video_recurring_unlock_seconds || 600;

  // Fetch the user's progress for this video. Legacy aw_/sb_ prefixed ids
  // don't have a UUID and aren't tracked in video_progress (the FK target),
  // so we fall back to "no prior progress" — every threshold is fresh.
  let paidThrough = 0;
  const isLegacy = sbId.startsWith('aw_') || sbId.startsWith('sb_');
  if (!isLegacy && currentUser) {
    const { data: prog } = await supabase
      .from('video_progress')
      .select('paid_through_seconds')
      .eq('user_id', currentUser.id)
      .eq('video_id', sbId)
      .maybeSingle();
    paidThrough = prog?.paid_through_seconds || 0;
  }

  const computeNext = (paid) => {
    if (paid < initialSec) return initialSec;
    return initialSec + Math.ceil((paid - initialSec + 1) / recurringSec) * recurringSec;
  };
  let nextThreshold = computeNext(paidThrough);
  let modalOpen = false;

  const listener = () => {
    // Stale listener guard — if user navigated to a different video, no-op
    if (!_videoMonetGate || _videoMonetGate.videoId !== sbId) return;
    if (modalOpen) return;
    if (player.currentTime < nextThreshold) return;

    modalOpen = true;
    // Note: video keeps playing during the prompt. The 5s auto-coin fallback
    // means most users won't even notice an interruption — they get a brief
    // glance at the choice, then it auto-deducts and dismisses.
    openVideoMonetThresholdDialog({
      videoTitle: video.title,
      videoId:    sbId,
      threshold:  nextThreshold,
      onSuccess: (result) => {
        modalOpen = false;
        if (result.mode === 'permanent') {
          // Coin path — never prompt again for this video
          _userUnlocks.add(`video:${sbId}`);
          nextThreshold = Infinity;
        } else if (result.mode === 'window') {
          // Star path — paid through end of this window; advance to next
          paidThrough = nextThreshold + recurringSec - 1;
          nextThreshold = computeNext(paidThrough);
        }
        renderTopbarCoinPill();
        // No need to call play — we never paused
      },
      onCancel: () => {
        // Modal closed without payment. Pause now so the user has to
        // re-engage; on next play, listener re-fires and re-prompts.
        modalOpen = false;
        try { player.pause(); } catch {}
      },
    });
  };

  player.addEventListener('timeupdate', listener);
  _videoMonetGate = { videoId: sbId, listener };
}

function teardownVideoMonetGate(player) {
  if (_videoMonetGate?.listener && player) {
    player.removeEventListener('timeupdate', _videoMonetGate.listener);
  }
  _videoMonetGate = null;
}

// Threshold-crossing dialog — visually distinct from the one-time unlock
// modal because the choice has different consequences (one-time forever vs
// pay-as-you-go window).
function openVideoMonetThresholdDialog({ videoTitle, videoId, threshold, onSuccess, onCancel }) {
  const coinCost = _walletConfigDefaults.default_video_unlock_coins || 1;
  const starCost = _walletConfigDefaults.default_video_unlock_stars || 1;
  const canCoin = _wallet.coin_balance >= coinCost;
  const canStar = _wallet.star_balance >= starCost;
  const recurringMin = Math.round((_walletConfigDefaults.video_recurring_unlock_seconds || 600) / 60);

  document.querySelector('.unlock-modal-backdrop')?.remove();
  const modal = document.createElement('div');
  modal.className = 'unlock-modal-backdrop video-monet-backdrop';
  modal.innerHTML = `
    <div class="unlock-modal video-monet-modal" role="dialog" aria-modal="true">
      <button class="unlock-modal-close" aria-label="Close">×</button>
      <div class="video-monet-icon-wrap">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </div>
      <h2>Keep watching</h2>
      ${videoTitle ? `<p class="unlock-modal-title">${escHTML(videoTitle)}</p>` : ''}
      <p class="unlock-modal-sub">First ${Math.floor(threshold / 60)} minutes done — pick how to continue:</p>
      <div class="video-monet-options">
        <button class="video-monet-option video-monet-option-coin ${canCoin ? '' : 'is-disabled'}" data-cur="coin" ${canCoin ? '' : 'disabled'}>
          <div class="video-monet-option-icon">
            <svg viewBox="0 0 24 24" width="28" height="28"><ellipse cx="12" cy="6" rx="8" ry="3" fill="#fbbf24" stroke="#b45309" stroke-width="1"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" fill="#fde68a" stroke="#b45309" stroke-width="1"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" fill="#fbbf24" stroke="#b45309" stroke-width="1"/></svg>
          </div>
          <div class="video-monet-option-cost">${coinCost} <small>coin${coinCost === 1 ? '' : 's'}</small></div>
          <div class="video-monet-option-mode">Forever</div>
        </button>
        <button class="video-monet-option video-monet-option-star ${canStar ? '' : 'is-disabled'}" data-cur="star" ${canStar ? '' : 'disabled'}>
          <div class="video-monet-option-icon">
            <svg viewBox="0 0 24 24" width="28" height="28"><path d="M12 2l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16l-5.6 3.2 1.5-6.3L3 8.7l6.4-.5z" fill="#a855f7"/></svg>
          </div>
          <div class="video-monet-option-cost">${starCost} <small>star${starCost === 1 ? '' : 's'}</small></div>
          <div class="video-monet-option-mode">${recurringMin}-min window</div>
        </button>
      </div>
      ${(!canCoin && !canStar) ? '<p class="unlock-need-more">Out of coins and stars. Top up in the Store.</p>' : `
        <div class="video-monet-countdown" id="vmCountdown">
          <span class="video-monet-countdown-bar"><span class="video-monet-countdown-fill" id="vmCountdownFill"></span></span>
          <span class="video-monet-countdown-text">Auto-paying with <strong>${coinCost} coin</strong> in <span id="vmCountdownNum">5</span>s · tap to choose differently</span>
        </div>`}
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('open'));

  // ── 5-second auto-coin countdown ──────────────────────────────────
  // If user does nothing, we silently deduct a coin and dismiss the dialog
  // so the video keeps playing without interruption. Any click cancels.
  let countdownTimer = null;
  let countdownInterval = null;
  let cancelCountdown = () => {
    if (countdownTimer)    { clearTimeout(countdownTimer);    countdownTimer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    const cd = modal.querySelector('#vmCountdown');
    if (cd) cd.classList.add('is-cancelled');
  };

  const close = (cancelled) => {
    cancelCountdown();
    modal.classList.remove('open');
    setTimeout(() => modal.remove(), 180);
    if (cancelled && typeof onCancel === 'function') onCancel();
  };
  modal.querySelector('.unlock-modal-close').onclick = () => close(true);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(true); });

  const tryUnlock = async (currency, btn) => {
    if (btn?.disabled) return;
    cancelCountdown();
    if (btn) btn.classList.add('is-loading');
    const { data, error } = await supabase.rpc('unlock_video_threshold', {
      p_video_id:          videoId,
      p_currency:          currency,
      p_threshold_seconds: threshold,
    });
    if (btn) btn.classList.remove('is-loading');
    if (error) { toast(error.message, 'error'); return false; }
    if (!data?.ok) {
      toast(data?.error === 'insufficient_balance' ? 'Insufficient balance' : (data?.error || 'Unlock failed'), 'error');
      return false;
    }
    if (currency === 'coin') _wallet.coin_balance = data.balance_after;
    else                     _wallet.star_balance = data.balance_after;
    renderTopbarCoinPill();
    close(false);
    toast(data.mode === 'permanent' ? `Unlocked forever! −${data.cost} coin` : `Continuing ${recurringMin} more min · −${data.cost} star`, 'success');
    onSuccess({ mode: data.mode || (currency === 'coin' ? 'permanent' : 'window') });
    return true;
  };

  modal.querySelectorAll('.video-monet-option').forEach(btn => {
    btn.addEventListener('click', () => tryUnlock(btn.dataset.cur, btn));
  });

  // Start countdown only if the user can actually afford coin auto-pay.
  // If they're out of coins but have stars, they need to choose manually.
  if (canCoin) {
    let secsLeft = 5;
    const fill = modal.querySelector('#vmCountdownFill');
    const num  = modal.querySelector('#vmCountdownNum');
    if (fill) fill.style.width = '0%';
    requestAnimationFrame(() => { if (fill) fill.style.width = '100%'; });
    countdownInterval = setInterval(() => {
      secsLeft--;
      if (num) num.textContent = secsLeft;
      if (secsLeft <= 0) clearInterval(countdownInterval);
    }, 1000);
    countdownTimer = setTimeout(() => {
      // Auto-deduct silently. tryUnlock handles success + cleanup.
      tryUnlock('coin', modal.querySelector('.video-monet-option-coin'));
    }, 5000);
  }
}

// ── Bulk book unlock dialog (Phase 6) ─────────────────────────────────────
function openBulkBookUnlockDialog({ bookId, bookTitle, lockedCount, coinCost, starCost, discountPct, onUnlocked }) {
  const canCoin = _wallet.coin_balance >= coinCost;
  const canStar = _wallet.star_balance >= starCost;

  document.querySelector('.unlock-modal-backdrop')?.remove();
  const modal = document.createElement('div');
  modal.className = 'unlock-modal-backdrop';
  modal.innerHTML = `
    <div class="unlock-modal" role="dialog" aria-modal="true">
      <button class="unlock-modal-close" aria-label="Close">×</button>
      <div class="unlock-modal-icon">📚</div>
      <h2>Unlock the whole book</h2>
      <p class="unlock-modal-title">${escHTML(bookTitle)}</p>
      <p class="unlock-modal-sub">${lockedCount} locked chapter${lockedCount === 1 ? '' : 's'} · ${discountPct}% off vs unlocking individually</p>
      <div class="unlock-options">
        <button class="unlock-option unlock-option-coin ${canCoin ? '' : 'is-disabled'}" data-cur="coin" ${canCoin ? '' : 'disabled'}>
          <span class="unlock-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3" fill="#fbbf24" stroke="#b45309" stroke-width="1"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" fill="#fde68a" stroke="#b45309" stroke-width="1"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" fill="#fbbf24" stroke="#b45309" stroke-width="1"/></svg>
          </span>
          <span class="unlock-option-cost">${coinCost}</span>
          <span class="unlock-option-label">Coin${coinCost === 1 ? '' : 's'}</span>
          <span class="unlock-option-hint">${canCoin ? 'Tap to unlock all' : `You have ${_wallet.coin_balance}`}</span>
        </button>
        <div class="unlock-or">or</div>
        <button class="unlock-option unlock-option-star ${canStar ? '' : 'is-disabled'}" data-cur="star" ${canStar ? '' : 'disabled'}>
          <span class="unlock-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 2l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16l-5.6 3.2 1.5-6.3L3 8.7l6.4-.5z" fill="#a855f7"/></svg>
          </span>
          <span class="unlock-option-cost">${starCost}</span>
          <span class="unlock-option-label">Star${starCost === 1 ? '' : 's'}</span>
          <span class="unlock-option-hint">${canStar ? 'Tap to unlock all' : `You have ${_wallet.star_balance}`}</span>
        </button>
      </div>
      ${(!canCoin && !canStar) ? '<p class="unlock-need-more">Not enough coins or stars yet. Open the Store to top up.</p>' : ''}
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('open'));

  const close = () => { modal.classList.remove('open'); setTimeout(() => modal.remove(), 180); };
  modal.querySelector('.unlock-modal-close').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelectorAll('.unlock-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const currency = btn.dataset.cur;
      btn.classList.add('is-loading');
      const { data, error } = await supabase.rpc('unlock_book_bulk', {
        p_book_id:  bookId,
        p_currency: currency,
      });
      btn.classList.remove('is-loading');
      if (error) { toast(error.message, 'error'); return; }
      if (!data?.ok) {
        toast(data?.error === 'insufficient_balance' ? 'Insufficient balance' : (data?.error || 'Unlock failed'), 'error');
        return;
      }
      // Update local state — Realtime will push too, but avoid flicker.
      if (currency === 'coin') _wallet.coin_balance = data.balance_after;
      else                     _wallet.star_balance = data.balance_after;
      // Refresh unlocks set from server (cheaper than refetching all)
      const { data: unlocks } = await supabase.from('unlocks')
        .select('target_type, target_id').eq('user_id', currentUser.id);
      _userUnlocks.clear();
      for (const u of (unlocks || [])) _userUnlocks.add(`${u.target_type}:${u.target_id}`);
      renderTopbarCoinPill();
      close();
      const saved = data.cost_before_discount - data.cost;
      toast(`Unlocked ${data.chapters_unlocked} chapter${data.chapters_unlocked === 1 ? '' : 's'} — saved ${saved} ${currency}${saved === 1 ? '' : 's'}`, 'success');
      if (typeof onUnlocked === 'function') onUnlocked();
    });
  });
}

// Topbar pill click → open Store
document.getElementById('topbarCoinPill')?.addEventListener('click', () => showStore());

// ── Earnings page (Phase 7 — own sidebar entry, tabs) ────────────────────
function showEarnings(forceReload = false) {
  hideAllMainPages();
  if (!earningsPage) return;
  earningsPage.style.display = 'block';
  history.pushState(null, '', '#earnings');
  setSidebarActive('btnEarnings');
  // Default to the Earnings tab on every open
  switchEarningsTab('earnings');
  // Earnings reloads on every visit by default — withdrawal status changes
  // matter and the user expects the most recent figures. But if it's a quick
  // tab-flick (reload < 30 seconds ago), skip the network call.
  const now = Date.now();
  const stale = !window._earningsLoadedAt || (now - window._earningsLoadedAt) > 30_000;
  if (forceReload || stale) {
    loadAuthorEarnings();
    window._earningsLoadedAt = now;
  }
}

function switchEarningsTab(name) {
  document.querySelectorAll('.earnings-tab').forEach(t => t.classList.toggle('active', t.dataset.etab === name));
  document.querySelectorAll('.earnings-tab-content').forEach(s => {
    s.style.display = s.dataset.etabContent === name ? 'block' : 'none';
  });
  // Pre-fill the Payments Info form when switched to (uses _authorKyc snapshot)
  if (name === 'payments') fillPaymentsInfoForm();
}

document.querySelectorAll('.earnings-tab').forEach(t => {
  t.addEventListener('click', () => switchEarningsTab(t.dataset.etab));
});

// Sidebar entry point
document.getElementById('btnEarnings')?.addEventListener('click', () => showEarnings());

// ── Store page ──────────────────────────────────────────────────────────────
async function showStore() {
  hideAllMainPages();
  if (!storePage) return;
  storePage.style.display = 'block';
  history.pushState(null, '', '#store');
  setSidebarActive(null);
  renderStoreBalances();
  loadStorePacks();
  renderStoreAdProgress(); // Phase 3 will populate; placeholder for now
  refreshMigrateBanner();
}

// ── "Bring my balance over" banner (Phase 4) ───────────────────────────────
//
// Visibility rules:
//   • Hidden if the user has already migrated (coin_transactions row of type
//     'migration_grant' exists).
//   • Hidden if the user explicitly dismissed it (localStorage flag).
//   • Otherwise shown — we let the user decide whether they have a mobile
//     balance to bring over. We don't pre-check Appwrite to avoid an extra
//     server round-trip on every Store open.
async function refreshMigrateBanner() {
  const banner = document.getElementById('storeMigrateBanner');
  if (!banner || !currentUser) return;

  // Local dismissal — survives across sessions
  const dismissKey = `selebox_migrate_dismiss_${currentUser.id}`;
  if (localStorage.getItem(dismissKey)) { banner.style.display = 'none'; return; }

  // Server check: did we already grant?
  const { count, error } = await supabase
    .from('coin_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', currentUser.id)
    .eq('type', 'migration_grant');
  if (error) { /* on error, just show — better safe than miss */ banner.style.display = 'flex'; return; }
  banner.style.display = (count && count > 0) ? 'none' : 'flex';
}

document.getElementById('btnMigrateDismiss')?.addEventListener('click', () => {
  if (!currentUser) return;
  localStorage.setItem(`selebox_migrate_dismiss_${currentUser.id}`, '1');
  document.getElementById('storeMigrateBanner').style.display = 'none';
});

document.getElementById('btnMigrateFromAppwrite')?.addEventListener('click', async () => {
  if (!currentUser) { toast('Sign in first', 'error'); return; }
  const btn = document.getElementById('btnMigrateFromAppwrite');
  const originalLabel = btn.textContent;
  btn.disabled = true; btn.textContent = 'Checking your mobile account…';
  try {
    const data = await callEdgeFunction('migrate-from-appwrite', {});
    if (data?.nothing_to_import) {
      toast('Checked your mobile account — nothing to import.', '');
      // Hide the banner permanently for this user
      localStorage.setItem(`selebox_migrate_dismiss_${currentUser.id}`, '1');
      document.getElementById('storeMigrateBanner').style.display = 'none';
      return;
    }
    if (data?.ok === false) {
      // Most common: already_migrated — be friendly about it
      if (data.error === 'already_migrated') {
        toast('Looks like you already brought your balance over.', '');
        document.getElementById('storeMigrateBanner').style.display = 'none';
        return;
      }
      toast(data.error || 'Migration failed', 'error');
      return;
    }
    // Success — Realtime on wallet will auto-update the pill, but force a
    // refresh here so the Store balance shows immediately.
    await loadWalletState();
    document.getElementById('storeMigrateBanner').style.display = 'none';
    const parts = [];
    if (data?.coins_credited)  parts.push(`${data.coins_credited.toLocaleString()} coins`);
    if (data?.stars_credited)  parts.push(`${data.stars_credited.toLocaleString()} stars`);
    if (data?.unlocks_imported) parts.push(`${data.unlocks_imported} unlocked`);
    toast(parts.length ? `Imported: ${parts.join(' · ')}` : 'Migration complete.', 'success');
  } catch (err) {
    toast(err.message || 'Migration failed', 'error');
  } finally {
    btn.disabled = false; btn.textContent = originalLabel;
  }
});

function renderStoreBalances() {
  const c = document.getElementById('storeCoinBalance');
  const s = document.getElementById('storeStarBalance');
  if (c) c.textContent = `${_wallet.coin_balance.toLocaleString()} Coin${_wallet.coin_balance === 1 ? '' : 's'}`;
  if (s) s.textContent = `${_wallet.star_balance.toLocaleString()} Star${_wallet.star_balance === 1 ? '' : 's'}`;
}

// Re-render store balances on Realtime wallet change too.
// (renderTopbarCoinPill is called by the wallet realtime; we hook the store
//  card render off the same callback path by patching it.)
const _origRenderTopbarCoinPill = renderTopbarCoinPill;
renderTopbarCoinPill = function () {
  _origRenderTopbarCoinPill();
  if (storePage && storePage.style.display === 'block') renderStoreBalances();
};

async function loadStorePacks() {
  const grid = document.getElementById('storePacks');
  if (!grid) return;
  grid.innerHTML = '<div class="loading">Loading packs…</div>';
  const { data: packs, error } = await supabase
    .from('coin_packages')
    .select('id, name, base_coins, bonus_coins, price_minor, currency, is_best_value, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) {
    grid.innerHTML = `<div class="loading">Couldn't load packs: ${escHTML(error.message)}</div>`;
    return;
  }
  if (!packs?.length) {
    grid.innerHTML = '<div class="loading">No packs available right now.</div>';
    return;
  }
  grid.innerHTML = packs.map(p => {
    const total    = p.base_coins + p.bonus_coins;
    const bonusPct = p.base_coins > 0 ? Math.round((p.bonus_coins / p.base_coins) * 100) : 0;
    const priceMaj = (p.price_minor / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 });
    const symbol   = p.currency === 'PHP' ? '₱' : (p.currency + ' ');
    return `
      <button class="store-pack ${p.is_best_value ? 'is-best-value' : ''}" data-pack-id="${escHTML(p.id)}" type="button">
        <div class="store-pack-icon">
          <svg viewBox="0 0 24 24" width="36" height="36">
            <ellipse cx="12" cy="6" rx="8" ry="3" fill="#fbbf24" stroke="#b45309" stroke-width="1"/>
            <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" fill="#fde68a" stroke="#b45309" stroke-width="1"/>
            <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" fill="#fbbf24" stroke="#b45309" stroke-width="1"/>
          </svg>
        </div>
        <div class="store-pack-meta">
          <div class="store-pack-name">${p.base_coins} Coins</div>
          <div class="store-pack-bonus">+${p.bonus_coins} free coins</div>
          <div class="store-pack-tags">
            ${bonusPct > 0 ? `<span class="store-pack-bonus-pill">BONUS ${bonusPct}%</span>` : ''}
            ${p.is_best_value ? '<span class="store-pack-best-pill">BEST VALUE</span>' : ''}
          </div>
          <div class="store-pack-total">Total ${total.toLocaleString()} coins delivered instantly</div>
        </div>
        <div class="store-pack-cta">
          <div class="store-pack-price">${symbol}${priceMaj}</div>
          <div class="store-pack-buy">TAP TO BUY</div>
        </div>
      </button>
    `;
  }).join('');

  // Wire click handlers
  grid.querySelectorAll('.store-pack').forEach(btn => {
    btn.addEventListener('click', () => purchasePack(btn.dataset.packId, btn));
  });
}

async function purchasePack(packId, btnEl) {
  if (!currentUser) { toast('Sign in to buy coins', 'error'); return; }
  if (btnEl) { btnEl.classList.add('is-loading'); btnEl.disabled = true; }
  try {
    const data = await callEdgeFunction('hitpay-create-payment', { package_id: packId });
    if (!data?.url) { toast('Could not start checkout', 'error'); return; }
    // Redirect the whole page to HitPay checkout
    window.location.href = data.url;
  } catch (err) {
    toast(err.message || 'Checkout failed', 'error');
  } finally {
    if (btnEl) { btnEl.classList.remove('is-loading'); btnEl.disabled = false; }
  }
}

// ── Phase 3: rewarded ads for stars ────────────────────────────────────────
//
// Decision (April 2026): web does NOT host rewarded ads. AdMob's mobile units
// don't render in browsers; AdSense forbids incentivized ad views; GAM
// rewarded requires 100k+ users we don't have yet. So stars are
// **mobile-only earnings** — users watch ads in the Selebox mobile app and
// the wallet (which is unified across both surfaces) shows the balance.
// Spending stars works on either platform.
//
// The "Watch ad" button on the Store stays clickable but only shows a
// friendly redirect toast — it doesn't credit any stars on web.
//
// The credit_star_for_ad RPC, ad_watches table, and the playRewardedAd()
// helper are intentionally kept in the codebase. When/if we add a real web
// ad provider (e.g. self-served promo videos), only this section needs to
// change.

function renderStoreAdProgress() {
  // Mobile-only mode: hide the progress bar (X/20 isn't tracked on web) and
  // swap the messaging to point at the mobile app.
  const sub  = document.getElementById('storeAdSub');
  const bar  = document.querySelector('#storePage .store-ad-progress');
  const text = document.getElementById('storeAdProgressText');
  const btn  = document.getElementById('btnWatchAd');

  if (sub)  sub.textContent  = 'Watch ads in the Selebox mobile app to earn stars. Your balance works in both apps.';
  if (bar)  bar.style.display = 'none';
  if (text) text.style.display = 'none';
  if (btn)  {
    btn.disabled    = false;
    btn.textContent = 'Open mobile app';
  }
}

document.getElementById('btnWatchAd')?.addEventListener('click', () => {
  // Web is intentionally not crediting stars. Friendly redirect message.
  toast('Use the Selebox mobile app to watch ads and earn stars.', '');
});

// ─────────────────────────────────────────────────────────────────────────
// Rewarded-ad player — STUB FOR NOW.
//
// This function is the integration point. Today it shows a 5-second
// countdown placeholder so the rest of the flow (RPC, balance update, daily
// cap enforcement) can be tested end-to-end. When the real ad SDK lands
// (AdMob H5, AdSense rewarded video, or Google Ad Manager), replace the
// body of this function with the real SDK call. It must:
//   • Resolve with { completed: true, provider, adId } only after the user
//     watched the ad to completion.
//   • Resolve with { completed: false } if the user skipped/closed early.
// The provider and adId fields land in ad_watches.ad_provider / ad_id, used
// for fraud auditing in the admin Wallet panel.
//
// HEADS-UP: today the only abuse-prevention is the 20/day server cap. When
// you wire AdMob, also enable Server-Side Verification (SSV) so the ad
// network calls a Supabase Edge Function on completion — that gives you a
// signed reward-token instead of the client self-reporting completion.
// ─────────────────────────────────────────────────────────────────────────
function playRewardedAd() {
  return new Promise((resolve) => {
    const adId    = 'stub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const seconds = 5;

    // Modal with a countdown bar — no skip allowed during playback.
    const modal = document.createElement('div');
    modal.className = 'ad-modal-backdrop';
    modal.innerHTML = `
      <div class="ad-modal" role="dialog" aria-modal="true">
        <div class="ad-modal-tag">Test ad</div>
        <div class="ad-modal-icon">
          <svg viewBox="0 0 24 24" width="64" height="64" fill="#a855f7"><path d="M12 2l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16l-5.6 3.2 1.5-6.3L3 8.7l6.4-.5z"/></svg>
        </div>
        <h2>Watch to earn 1 Star</h2>
        <p class="ad-modal-sub">Real ads via AdMob / AdSense will replace this stub when integrated. For now, it's a 5-second placeholder.</p>
        <div class="ad-modal-progress">
          <div class="ad-modal-progress-fill" id="adProgressFill"></div>
        </div>
        <div class="ad-modal-countdown" id="adCountdown">${seconds}s remaining</div>
        <button class="ad-modal-cancel" id="adCancelBtn">Cancel — no reward</button>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('open'));

    const fill      = modal.querySelector('#adProgressFill');
    const countdown = modal.querySelector('#adCountdown');
    const cancelBtn = modal.querySelector('#adCancelBtn');
    let remaining   = seconds;
    let timer       = null;

    const cleanup = (result) => {
      if (timer) clearInterval(timer);
      modal.classList.remove('open');
      setTimeout(() => modal.remove(), 180);
      resolve(result);
    };

    cancelBtn.onclick = () => cleanup({ completed: false });

    // Tick every 100ms for smooth progress bar
    let elapsedMs = 0;
    const totalMs = seconds * 1000;
    timer = setInterval(() => {
      elapsedMs += 100;
      const pct = Math.min(100, (elapsedMs / totalMs) * 100);
      fill.style.width = pct + '%';
      remaining = Math.max(0, Math.ceil((totalMs - elapsedMs) / 1000));
      countdown.textContent = remaining > 0 ? `${remaining}s remaining` : 'Almost there…';
      if (elapsedMs >= totalMs) {
        cleanup({ completed: true, provider: 'stub', adId });
      }
    }, 100);
  });
}

// ── Return-from-HitPay handler ──
// HitPay redirects users back to /?store=success&ref=<purchase_id> after
// payment. We detect that on load, show a friendly toast, and clean the URL.
function handleStoreReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('store');
  if (!status) return;
  if (status === 'success') {
    toast('Payment received! Your coins will land any moment.', 'success');
    // Realtime on wallets will auto-update the pill once the webhook lands.
    // Open the Store page so the user sees the balance update.
    setTimeout(() => showStore(), 50);
  } else if (status === 'cancelled' || status === 'cancel') {
    toast('Payment cancelled.', 'error');
  }
  // Strip the param so a refresh doesn't re-trigger the toast
  params.delete('store');
  params.delete('ref');
  const newQuery = params.toString();
  history.replaceState(null, '', window.location.pathname + (newQuery ? '?' + newQuery : '') + window.location.hash);
}
// Run on initial load (after auth has had a chance to mount).
setTimeout(handleStoreReturn, 800);
// Sign-out confirmation: show a modal, only sign out on explicit confirm.
// Prevents the awkward case where someone misclicks the sidebar Logout entry.
function _openSignOutModal() {
  const m = document.getElementById('signOutModal');
  if (!m) { signOut(); return; }   // graceful fallback if modal HTML is missing
  m.style.display = 'flex';
  m.classList.add('open');
}
function _closeSignOutModal() {
  const m = document.getElementById('signOutModal');
  if (!m) return;
  m.style.display = 'none';
  m.classList.remove('open');
}
document.getElementById('btnSignOut')?.addEventListener('click', _openSignOutModal);
document.getElementById('signOutClose')?.addEventListener('click', _closeSignOutModal);
document.getElementById('signOutCancel')?.addEventListener('click', _closeSignOutModal);
document.getElementById('signOutConfirm')?.addEventListener('click', () => {
  _closeSignOutModal();
  signOut();
});
document.getElementById('signOutModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'signOutModal') _closeSignOutModal();
});

// ── Compose ──
const composeText = document.getElementById('composeText');
const charCount = document.getElementById('charCount');
const composeImageInput = document.getElementById('composeImageInput');
const composeImagePreview = document.getElementById('composeImagePreview');
let composeImageFile = null;

composeText.addEventListener('input', () => {
  const len = composeText.value.length;
  charCount.textContent = `${len} / 5000`;
  charCount.className = 'char-count' + (len > 4500 ? ' warn' : '') + (len >= 5000 ? ' over' : '');
  composeText.style.height = 'auto';
  composeText.style.height = composeText.scrollHeight + 'px';
});

composeImageInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  composeImageFile = file;
  const reader = new FileReader();
  reader.onload = (ev) => {
    composeImagePreview.innerHTML = `
      <div class="image-preview">
        <img src="${ev.target.result}" alt="preview"/>
        <button class="image-preview-remove" id="removeComposeImage">×</button>
      </div>`;
    document.getElementById('removeComposeImage').addEventListener('click', () => {
      composeImageFile = null;
      composeImagePreview.innerHTML = '';
      composeImageInput.value = '';
    });
  };
  reader.readAsDataURL(file);
});

document.getElementById('btnPost').addEventListener('click', async () => {
  const body = composeText.value.trim();
  if (!body && !composeImageFile) return;
  if (!currentUser) return toast('Please sign in first', 'error');

  const btn = document.getElementById('btnPost');
  btn.disabled = true;
  btn.textContent = composeImageFile ? 'Uploading...' : 'Posting...';

  let imageUrl = null;
  if (composeImageFile) {
    imageUrl = await uploadImage(composeImageFile);
    if (!imageUrl) { btn.disabled = false; btn.textContent = 'Post'; return; }
  }

  btn.textContent = 'Posting...';
  // Facebook-pattern: ask for the inserted row WITH joins so we can
  // prepend it locally instead of re-running loadFeed (which would
  // call feed_for_you, and that RPC excludes the viewer's own posts —
  // the new post would vanish from the feed immediately even though
  // it landed in the DB). Returning the row also gives us the canonical
  // id + created_at for the local prepend.
  const { data: created, error } = await supabase
    .from('posts')
    .insert({ user_id: currentUser.id, body: body || '', image_url: imageUrl })
    .select(FEED_SELECT)
    .single();
  btn.disabled = false;
  btn.textContent = 'Post';

  if (error) { toast(error.message, 'error'); return; }
  composeText.value = '';
  composeImageFile = null;
  composeImagePreview.innerHTML = '';
  composeImageInput.value = '';
  charCount.textContent = '0 / 5000';
  toast('Posted!', 'success');

  // Prepend the new post locally so the user sees it at the top of the
  // feed immediately (Facebook-style "you posted!" affordance). On the
  // next manual refresh, feed_for_you will correctly exclude it from
  // the For You ranking — by design — and it'll vanish from this list,
  // but it lives forever on the user's profile/timeline.
  if (created) {
    posts = [created, ...posts];
    const feedEl = document.getElementById('feed');
    if (feedEl) {
      const el = renderPost(created);
      el.style.animationDelay = '0s';
      feedEl.insertBefore(el, feedEl.firstChild);
      _wireUpNewPosts(feedEl);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    _bumpFeedLastSeenAt([created]);
  } else {
    // Safety net — if the SELECT returned nothing for some reason
    // (RLS / shape), fall back to the legacy behavior so the user's
    // post isn't completely invisible.
    loadFeed();
  }
});

// ── Stories row (users) ──
async function loadStories() {
  const row = document.getElementById('storiesRow');
  // Skip the network round-trip if the row is hidden (saves 1 query per home-tab visit)
  if (!row || row.style.display === 'none') return;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, is_guest')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !data) { row.innerHTML = ''; return; }

  row.innerHTML = data.map(p => {
    const avatarHTML = p.avatar_url ? `<img src="${p.avatar_url}" alt="${p.username}"/>` : initials(p.username);
    return `
      <div class="story-item" onclick="filterByUser('${p.id}','${escHTML(p.username)}')">
        <div class="story-avatar">${avatarHTML}</div>
        <div class="story-name">${escHTML(p.username)}</div>
      </div>
    `;
  }).join('');
}

// ── Filter by user ──
window.filterByUser = async (userId, username) => {
  openProfile(userId);
};

// ── Feed ──
// ── Feed pagination + lazy loading ──
const FEED_PAGE_SIZE = 15;
let _feedOffset = 0;
let _hasMoreFeedPosts = true;
let _isLoadingMoreFeed = false;
let _feedScrollObserver = null;
let _feedVideoObserver = null;
let _feedPostObserver = null;

const FEED_SELECT = `*, profiles!user_id(id, username, avatar_url, is_guest, is_banned, role), videos(id, video_url, thumbnail_url, title, duration), original:reposted_from(*, profiles!user_id(id, username, avatar_url, is_guest, is_banned, role), videos(id, video_url, thumbnail_url, title, duration))`;

// Feed mode — 'foryou' (default), 'following', or 'discover'
let _feedMode = 'foryou';

// Stale-query guard. Every loadFeed/loadMoreFeed call increments this; results
// are only applied if their captured seq still matches. Makes rapid tab-flicks
// and overlapping pagination requests safe.
let _feedSeq = 0;

// Cached follow set per loadFeed run — avoids a second fetch when For You needs
// it for the boost AND Discover needed it for the exclusion. Reset each loadFeed.
let _cachedFollowIds = null;

// Pending debounce timer for realtime-triggered feed refreshes. Declared up
// here so loadFeed can cancel it (a user-initiated load supersedes any
// pending auto-refresh). The function and Supabase channel that USE this
// timer live further down — by the time a realtime WS event actually fires,
// every dependency is initialized.
let _realtimeRefreshTimer = null;

// Facebook-pattern feed delta. `_feedLastSeenAt` is the newest
// created_at across the rendered feed. refreshFeedAdditive() fetches
// only posts created after this timestamp and prepends them to the
// top, instead of re-running the expensive feed_for_you ranker on
// every refresh. Set by loadFeed/loadMoreFeed when fresh rows arrive,
// updated again on each successful additive refresh.
let _feedLastSeenAt = null;

// Buffer of posts found by the background poller but not yet applied
// to the feed. Tapping the "↑ N new posts" pill flushes this into the
// top of the feed without a fresh DB call. Polled every 60s while the
// tab is foregrounded; pauses when hidden.
let _newPostsBuffer = [];          // hydrated post objects
let _newPostsBufferIds = new Set(); // dedup against live + repeat polls
let _feedPollTimer = null;

// Update _feedLastSeenAt to the max created_at across an array of posts.
// Idempotent — only moves forward, never backward (so a stale page
// from a slow tab can't overwrite a fresher value).
function _bumpFeedLastSeenAt(rows) {
  if (!rows?.length) return;
  let newest = _feedLastSeenAt;
  for (const p of rows) {
    const t = p?.created_at;
    if (t && (!newest || t > newest)) newest = t;
  }
  if (newest && newest !== _feedLastSeenAt) _feedLastSeenAt = newest;
}

// Prepend a list of hydrated posts to the feed (state + DOM). Shared
// between the background-poll buffer apply and the additive refresh
// below. Returns the number of rows actually inserted (after dedup).
function _prependFreshPosts(fresh) {
  if (!fresh?.length) return 0;
  const existing = new Set(posts.map(p => p?.id).filter(Boolean));
  const toInsert = fresh.filter(p => p?.id && !existing.has(p.id));
  if (!toInsert.length) return 0;
  posts = [...toInsert, ...posts];
  const feedEl = document.getElementById('feed');
  if (feedEl) {
    const frag = document.createDocumentFragment();
    toInsert.forEach((post, i) => {
      const el = renderPost(post);
      el.style.animationDelay = `${(i * 0.04).toFixed(3)}s`;
      frag.appendChild(el);
    });
    feedEl.insertBefore(frag, feedEl.firstChild);
    _wireUpNewPosts(feedEl);
  }
  _bumpFeedLastSeenAt(toInsert);
  return toInsert.length;
}

// Apply the background-polled buffer to the feed. Used by both the pill
// tap and pull-to-refresh-style gestures — same effect, no DB call.
function _applyNewPostsBuffer() {
  if (!_newPostsBuffer.length) return 0;
  const inserted = _prependFreshPosts(_newPostsBuffer);
  _newPostsBuffer = [];
  _newPostsBufferIds = new Set();
  _renderNewPostsPill();
  if (inserted > 0) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  return inserted;
}

// Render / update / hide the "↑ N new posts" pill. Idempotent — safe to
// call after every buffer change. The pill is created lazily once and
// then just toggled visible.
function _renderNewPostsPill() {
  let pill = document.getElementById('feedNewPill');
  if (!_newPostsBuffer.length) {
    if (pill) pill.classList.remove('is-visible');
    return;
  }
  if (!pill) {
    pill = document.createElement('button');
    pill.id = 'feedNewPill';
    pill.className = 'feed-new-pill';
    pill.type = 'button';
    pill.onclick = () => _applyNewPostsBuffer();
    document.body.appendChild(pill);
  }
  const n = _newPostsBuffer.length;
  pill.textContent = n === 1 ? '↑ 1 new post' : `↑ ${n} new posts`;
  pill.classList.add('is-visible');
}

// Background poller — every 60s while the tab is visible, calls
// feed_new_since to discover posts created after _feedLastSeenAt.
// New posts are stashed in _newPostsBuffer; the pill renders/updates
// based on the buffer size. NO mutation of the live feed until the
// user taps the pill (or pull-to-refresh applies the buffer).
async function _pollForNewPosts() {
  if (document.hidden) return;
  if (!currentUser?.id) return;
  if (_feedMode !== 'foryou' || !_feedLastSeenAt) return;
  try {
    const { data, error } = await supabase.rpc('feed_new_since', {
      p_user_id: currentUser.id,
      p_since: _feedLastSeenAt,
      p_limit: 30,
    });
    if (error) throw error;
    const ids = (data || []).map(r => r.id).filter(Boolean);
    if (!ids.length) return;
    // Skip ids already in the buffer or in the live feed.
    const liveIds = new Set(posts.map(p => p?.id).filter(Boolean));
    const newIds = ids.filter(id => !_newPostsBufferIds.has(id) && !liveIds.has(id));
    if (!newIds.length) return;
    // Hydrate the new ones through FEED_SELECT.
    const { data: hydrated, error: hydErr } = await supabase
      .from('posts').select(FEED_SELECT).in('id', newIds);
    if (hydErr) throw hydErr;
    const byId = new Map((hydrated || []).map(p => [p.id, p]));
    const ordered = newIds.map(id => byId.get(id)).filter(Boolean);
    const filtered = ordered.filter(p => !shouldHidePost(p));
    if (!filtered.length) return;
    // Buffer (newest first to match feed ordering).
    _newPostsBuffer = [...filtered, ..._newPostsBuffer];
    for (const p of filtered) _newPostsBufferIds.add(p.id);
    _renderNewPostsPill();
  } catch (err) {
    // Polling errors are non-fatal — the next tick will retry.
    console.warn('[feed] poll error:', err?.message);
  }
}

// Start / restart the polling timer. Safe to call many times — clears
// any existing timer before scheduling. Pauses when the tab hides
// (visibilitychange handler below restarts it on reshow).
function _startFeedPolling() {
  if (_feedPollTimer) clearInterval(_feedPollTimer);
  _feedPollTimer = setInterval(_pollForNewPosts, 60_000);
}
function _stopFeedPolling() {
  if (_feedPollTimer) { clearInterval(_feedPollTimer); _feedPollTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _stopFeedPolling();
  } else {
    _startFeedPolling();
    // Recount immediately on tab return — gives instant feedback if
    // the user comes back after a while.
    _pollForNewPosts();
  }
});

// Additive refresh — when buffer already has buffered posts (from
// background poll), apply them WITHOUT another DB call. Otherwise
// trigger a fresh delta fetch + apply. Falls back to a full
// loadFeed() when:
//   • we don't have a baseline timestamp yet (first session)
//   • we're not on the For You tab (Following / Discover are already
//     cheap enough that a full reload is fine)
//   • the delta query itself errors
//
// Web equivalent of mobile's onRefresh logic in app/(tabs)/home.jsx.
async function refreshFeedAdditive() {
  if (!currentUser?.id) return;
  if (_feedMode !== 'foryou' || !_feedLastSeenAt) {
    return loadFeed();
  }
  // Fast path — buffer has new posts from the poller, just apply them.
  if (_newPostsBuffer.length > 0) {
    _applyNewPostsBuffer();
    return;
  }
  try {
    const { data, error } = await supabase.rpc('feed_new_since', {
      p_user_id: currentUser.id,
      p_since: _feedLastSeenAt,
      p_limit: 30,
    });
    if (error) throw error;
    const newIds = (data || []).map(r => r.id).filter(Boolean);
    if (!newIds.length) return; // up to date
    const { data: hydrated, error: hydErr } = await supabase
      .from('posts').select(FEED_SELECT).in('id', newIds);
    if (hydErr) throw hydErr;
    const byId = new Map((hydrated || []).map(p => [p.id, p]));
    const ordered = newIds.map(id => byId.get(id)).filter(Boolean);
    const filtered = ordered.filter(p => !shouldHidePost(p));
    const inserted = _prependFreshPosts(filtered);
    if (inserted > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    console.warn('[feed] additive refresh failed, falling back to full reload:', err?.message);
    return loadFeed();
  }
}
window.refreshFeedAdditive = refreshFeedAdditive;

// One reusable query+score+filter pipeline so loadFeed and loadMoreFeed produce
// the SAME shape of results — no more "Following tab silently shows everyone
// after page 1" or "For You loses velocity scoring on scroll".
// Over-fetch multiplier. When the user has any client-side filters
// (hidden posts / snoozed users / blocked users), shouldHidePost can
// drop a meaningful chunk of each page. Without compensating, the user
// sees a feed that looks half-empty — which was the "I only see 4
// posts" complaint. We over-fetch 1.5× when filters exist so the
// trimmed result is still close to the page size. Mirrors the same
// trick mobile uses in lib/posts-supabase.js → _filterPageSize.
function _feedFetchLimitWithFilters(logicalLimit) {
  const hasFilters =
    userContentFilters.hiddenPostIds.size > 0 ||
    userContentFilters.snoozedUserIds.size > 0 ||
    userContentFilters.blockedUserIds.size > 0;
  return hasFilters ? Math.ceil(logicalLimit * 1.5) : logicalLimit;
}

async function _buildAndExecFeedQuery({ offset }) {
  if (!currentUser?.id) return { data: [], scoreClientSide: false, followIds: null };

  // For You + Discover now go through the same Postgres RPCs mobile
  // uses (feed_for_you / feed_discover). The server-side algorithm:
  //   • Reads the viewer's interest profile (likes, comments, follows)
  //   • Excludes posts in the viewer's post_views (last 24h) — the
  //     "always fresh" feed UX shipped May 2
  //   • Returns rows in score order
  // Client-side scoring is preserved as a fallback path in case the
  // RPC is missing (early dev DBs without migration_feed_v2_rpcs.sql)
  // — set RPC_FAIL = true at the bottom of the catch to verify.
  // Cached follow set still drives the Following tab filter.
  if (_cachedFollowIds === null) {
    const { data: f } = await supabase.from('follows')
      .select('following_id').eq('follower_id', currentUser.id);
    _cachedFollowIds = (f || []).map(r => r.following_id);
  }
  const followIds = _cachedFollowIds;

  if (_feedMode === 'following') {
    if (!followIds.length) return { data: [], scoreClientSide: false, followIds, emptyReason: 'no-follows' };
    const fetchLimit = _feedFetchLimitWithFilters(FEED_PAGE_SIZE);
    let q = supabase.from('posts').select(FEED_SELECT).eq('is_hidden', false);
    q = q.in('user_id', followIds).order('created_at', { ascending: false });
    const { data, error } = await q.range(offset, offset + fetchLimit - 1);
    if (error) throw error;
    return { data: data || [], scoreClientSide: false, followIds, fetchLimit };
  }

  // foryou / discover: RPC path
  const rpcName = _feedMode === 'discover' ? 'feed_discover' : 'feed_for_you';
  try {
    const fetchLimit = _feedFetchLimitWithFilters(FEED_PAGE_SIZE);
    const { data: ranked, error: rpcErr } = await supabase.rpc(rpcName, {
      p_user_id: currentUser.id,
      p_limit: fetchLimit,
      p_offset: offset,
    });
    if (rpcErr) throw rpcErr;
    const orderedIds = (ranked || []).map(r => r.id).filter(Boolean);
    if (!orderedIds.length) return { data: [], scoreClientSide: false, followIds, fetchLimit };
    // Hydrate through FEED_SELECT to get profiles/videos/original join.
    const { data: hydrated, error: hydErr } = await supabase
      .from('posts')
      .select(FEED_SELECT)
      .in('id', orderedIds);
    if (hydErr) throw hydErr;
    // Re-establish RPC ordering — IN-clause query returns arbitrary order.
    const byId = new Map((hydrated || []).map(p => [p.id, p]));
    const ordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
    return { data: ordered, scoreClientSide: false, followIds, fetchLimit };
  } catch (err) {
    // Fallback path — only kicks in if the RPC itself is missing/broken.
    // Logs once and switches the tab to client-side scoring (same code
    // we used before the migration). Future cleanup: drop the fallback
    // once we trust the RPCs in production.
    console.warn('[feed] RPC failed, falling back to client-side scoring:', err?.message);
    let q = supabase.from('posts').select(FEED_SELECT).eq('is_hidden', false);
    if (_feedMode === 'discover') {
      const exclude = [...followIds, currentUser.id];
      if (exclude.length) {
        q = q.not('user_id', 'in', `(${exclude.map(id => `"${id}"`).join(',')})`);
      }
    }
    q = q.gt('created_at', new Date(Date.now() - 14 * 86400_000).toISOString())
         .order('created_at', { ascending: false });
    const fetchLimit = FEED_PAGE_SIZE * 3;
    const { data, error } = await q.range(offset, offset + fetchLimit - 1);
    if (error) throw error;
    return { data: data || [], scoreClientSide: true, followIds, fetchLimit };
  }
}

// Apply hide-list filter, scoring (For You / Discover), and diversity penalty.
// Returns the page-sized result. Always slices to FEED_PAGE_SIZE at the end
// because callers may have over-fetched (1.5× when filters exist) so the
// hide pass leaves enough rows to still fill the page.
function _processFeedRows({ data, scoreClientSide, followIds }) {
  let result = data.filter(p => !shouldHidePost(p));
  if (scoreClientSide) {
    const followSet = new Set(followIds || []);
    result.forEach(p => {
      p._score = _feedVelocity(p) * (followSet.has(p.user_id) ? 1.5 : 1.0);
    });
    result.sort((a, b) => (b._score || 0) - (a._score || 0));
    result = _feedDiversify(result);
  }
  return result.slice(0, FEED_PAGE_SIZE);
}

// Friendly user-facing message instead of leaking raw Postgres errors.
function _feedFriendlyError(err) {
  const raw = (err && err.message) || '';
  if (/timeout|canceling statement/i.test(raw)) {
    return 'Feed is taking longer than usual. Tap to retry.';
  }
  if (/Failed to fetch|NetworkError/i.test(raw)) {
    return 'Network hiccup. Check your connection and tap to retry.';
  }
  return 'Couldn\'t load the feed. Tap to retry.';
}

// Velocity score for ranking — recent engagement per hour, weighted.
// likes×1, comments×2, reposts×3 (stronger signals weighted heavier).
function _feedVelocity(p) {
  const created = new Date(p.created_at || Date.now()).getTime();
  const hours   = Math.max(1, (Date.now() - created) / 3600_000);
  const eng     = (p.likes_count || 0)
                + (p.comments_count || 0) * 2
                + (p.reposts_count  || 0) * 3;
  return eng / hours;
}

// Apply diversity penalty: skip showing the same author twice in a row.
// Pushes those posts down rather than removing them.
function _feedDiversify(arr) {
  const out = [];
  const queue = [...arr];
  let lastAuthor = null;
  while (queue.length) {
    // Find next post whose author differs from lastAuthor; if none, take the head.
    let i = queue.findIndex(p => p.user_id !== lastAuthor);
    if (i === -1) i = 0;
    const p = queue.splice(i, 1)[0];
    out.push(p);
    lastAuthor = p.user_id;
  }
  return out;
}

window.loadFeed = async function() {
  const feed = document.getElementById('feed');
  const sentinel = document.getElementById('feedSentinel');
  if (!feed) return;

  // Bump the seq — any in-flight loadFeed/loadMoreFeed from a previous tap
  // will see its captured seq no longer matches and bail out before touching
  // the DOM. Eliminates the "fast tab-flick shows wrong tab" race.
  const seq = ++_feedSeq;

  // Cancel any pending realtime debounce — a user-triggered load supersedes
  // a "platform got a new post" auto-refresh. Saves one redundant DB round-trip.
  if (_realtimeRefreshTimer) {
    clearTimeout(_realtimeRefreshTimer);
    _realtimeRefreshTimer = null;
  }

  feed.innerHTML = '<div class="loading">Loading feed...</div>';
  if (sentinel) sentinel.style.display = 'none';

  // Reset pagination state
  _feedOffset = 0;
  _hasMoreFeedPosts = true;
  _isLoadingMoreFeed = false;
  _cachedFollowIds = null;
  if (_feedScrollObserver) { _feedScrollObserver.disconnect(); _feedScrollObserver = null; }
  if (_feedVideoObserver)  { _feedVideoObserver.disconnect();  _feedVideoObserver = null; }
  if (_feedPostObserver)   { _feedPostObserver.disconnect();   _feedPostObserver = null; }

  // Guard: feed needs an authenticated user (the follow query depends on it).
  // Without this, an early-firing realtime listener could call loadFeed before
  // sign-in resolves and crash on `currentUser.id`.
  if (!currentUser?.id) {
    feed.innerHTML = '<div class="empty"><h3>Sign in to see your feed</h3></div>';
    return;
  }

  let queryResult;
  try {
    queryResult = await _buildAndExecFeedQuery({ offset: 0 });
  } catch (err) {
    if (seq !== _feedSeq) return;
    console.error('Feed query failed:', err);
    const msg = _feedFriendlyError(err);
    feed.innerHTML = `<div class="empty" id="feedRetry" style="cursor:pointer"><p>${escHTML(msg)}</p></div>`;
    document.getElementById('feedRetry')?.addEventListener('click', () => loadFeed());
    return;
  }

  // Stale-query guard — user switched tabs / refreshed mid-flight.
  if (seq !== _feedSeq) return;
  // Sign-out mid-flight — currentUser may have flipped to null while we awaited.
  if (!currentUser?.id) {
    feed.innerHTML = '<div class="empty"><h3>Sign in to see your feed</h3></div>';
    return;
  }

  // Following tab with no follows → friendly empty state (special-case)
  if (queryResult.emptyReason === 'no-follows') {
    feed.innerHTML = `
      <div class="empty">
        <h3>You're not following anyone yet</h3>
        <p>Switch to <strong>Discover</strong> or <strong>For You</strong> to find creators worth following.</p>
      </div>`;
    return;
  }

  const result = _processFeedRows(queryResult);
  posts = result;

  // Pagination state — for scored modes, _feedOffset advances by the WIDER
  // fetch so we don't refetch the same rows we just trimmed away.
  const advance = queryResult.data.length;
  if (advance < (queryResult.fetchLimit || FEED_PAGE_SIZE)) _hasMoreFeedPosts = false;
  _feedOffset = advance;

  if (!posts.length) {
    const emptyMsg = _feedMode === 'discover'
      ? '<h3>No fresh posts to discover</h3><p>Check back soon — new content drops daily.</p>'
      : '<h3>No posts yet</h3><p>Be the first to share something!</p>';
    feed.innerHTML = `<div class="empty">${emptyMsg}</div>`;
    return;
  }

  feed.innerHTML = '';
  posts.forEach((post, i) => {
    const el = renderPost(post);
    el.style.animationDelay = `${(i * 0.04).toFixed(3)}s`;
    feed.appendChild(el);
  });

  // Facebook-pattern feed: track the newest created_at across this initial
  // page so refreshFeedAdditive / the background poller can fetch only
  // posts since then. Reset to null first so an old session's lastSeenAt
  // doesn't bleed into a different user's session. Also drop the "↑ N
  // new posts" buffer + hide the pill — a full reload absorbs them.
  _feedLastSeenAt = null;
  _bumpFeedLastSeenAt(posts);
  _newPostsBuffer = [];
  _newPostsBufferIds = new Set();
  _renderNewPostsPill();

  _wireUpNewPosts(feed);
  if (_hasMoreFeedPosts) setupFeedInfiniteScroll();

  // Kick off the background poller for the For You tab. Other tabs
  // don't need it — they're chronological and the user pulls to refresh.
  if (_feedMode === 'foryou') _startFeedPolling();
  else _stopFeedPolling();
};

// ── Post-view tracking — feeds Supabase `post_views` so feed_for_you
//    can dedupe seen posts on next refresh. Mirrors mobile's
//    trackPostViews + onViewableItemsChanged debounce. Without this,
//    web users would see the same posts repeatedly and the algorithm
//    on the server side would have less signal.
//
// Pattern: IntersectionObserver per post-card. When ≥ 50% visible
// for ≥ 800ms, the post is marked "seen" and its id is queued. Every
// 1.5s, the queue is flushed in one RPC call. Tab-leave flushes the
// remainder so we don't lose ids on navigation.
const _viewTrackingState = {
  observer: null,
  pendingIds: new Set(),
  recordedIds: new Set(),       // already flushed — don't re-send
  // postId → setTimeout handle. The handle is created when the post
  // first becomes visible above the threshold, fires after
  // VIEW_MIN_VISIBLE_MS, and is cleared if the post leaves view before
  // then. This replaces an earlier `visibleSince` Map that only worked
  // when the user scrolled across the threshold repeatedly — the
  // IntersectionObserver fires on threshold transitions, not on a
  // continuous "still visible" basis, so the time-based gating must be
  // implemented with timers.
  pendingTimers: new Map(),
  flushTimer: null,
};
const VIEW_FLUSH_DEBOUNCE_MS = 1500;
const VIEW_MIN_VISIBLE_MS = 800;
const VIEW_VISIBLE_THRESHOLD = 0.5;

function _flushPendingViews() {
  _viewTrackingState.flushTimer = null;
  if (!currentUser?.id || _viewTrackingState.pendingIds.size === 0) return;
  const ids = [...(_viewTrackingState.pendingIds)];
  _viewTrackingState.pendingIds.clear();
  ids.forEach(id => _viewTrackingState.recordedIds.add(id));
  // Fire-and-forget — view tracking is best-effort. Failures don't
  // block the user; logging is enough for debugging if the RPC ever
  // regresses.
  supabase.rpc('track_post_views', {
    p_user_id: currentUser.id,
    p_post_ids: ids,
  }).then(({ error }) => {
    if (error) console.warn('[feed] track_post_views failed:', error.message);
  });
}

function _scheduleViewFlush() {
  if (_viewTrackingState.flushTimer) return;
  _viewTrackingState.flushTimer = setTimeout(_flushPendingViews, VIEW_FLUSH_DEBOUNCE_MS);
}

// Set up the observer once. Re-used by every _wireUpNewPosts call —
// observe is idempotent on the same element.
function _ensureViewObserver() {
  if (_viewTrackingState.observer) return _viewTrackingState.observer;
  if (typeof IntersectionObserver === 'undefined') return null;
  _viewTrackingState.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = entry.target?.dataset?.postid;
      if (!id || _viewTrackingState.recordedIds.has(id)) continue;
      const isVisibleEnough = entry.isIntersecting && entry.intersectionRatio >= VIEW_VISIBLE_THRESHOLD;
      if (isVisibleEnough) {
        // Already counting down for this post — leave the existing timer.
        if (_viewTrackingState.pendingTimers.has(id)) continue;
        // Schedule the queue insertion after VIEW_MIN_VISIBLE_MS. If the
        // post leaves view first, the else branch below clears it.
        const handle = setTimeout(() => {
          _viewTrackingState.pendingTimers.delete(id);
          if (_viewTrackingState.recordedIds.has(id)) return;
          _viewTrackingState.pendingIds.add(id);
          _scheduleViewFlush();
        }, VIEW_MIN_VISIBLE_MS);
        _viewTrackingState.pendingTimers.set(id, handle);
      } else {
        // Post left the visible window before the timer fired — cancel.
        const existing = _viewTrackingState.pendingTimers.get(id);
        if (existing) {
          clearTimeout(existing);
          _viewTrackingState.pendingTimers.delete(id);
        }
      }
    }
  }, { threshold: [0, VIEW_VISIBLE_THRESHOLD] });
  return _viewTrackingState.observer;
}

// Flush remaining views when the user leaves the tab — sendBeacon would
// be fancier, but the RPC is light and the typical exit path gives us
// enough time for fetch.
window.addEventListener('beforeunload', () => {
  _flushPendingViews();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) _flushPendingViews();
});

// Fold the post-render setup into one helper. Two callers (initial load and
// load-more) used to call these as separate steps — easy to forget one.
function _wireUpNewPosts(container) {
  setupFeedLazyLoaders(container);
  setupCollapsibleBodies(container);
  // Register every freshly-rendered post-card with the view tracker so
  // when the user scrolls past it (≥50% visible for ≥800ms), the id
  // gets queued for the debounced track_post_views RPC flush.
  const observer = _ensureViewObserver();
  if (observer) {
    container.querySelectorAll('.post-card[data-postid]').forEach(el => observer.observe(el));
  }
}

// ── Collapsible post bodies (Facebook-style "See more / less") ──
// Auto-detects bodies that overflow ~6 lines and lets users tap the text
// itself to expand/collapse. Short posts get no toggle. Per-session state
// in `_expandedPosts` so toggle persists while scrolling but resets on refresh.
const _expandedPosts = new Set();
function setupCollapsibleBodies(root) {
  if (!root) return;
  const bodies = root.querySelectorAll('.collapsible-body:not([data-collapse-checked])');
  bodies.forEach(el => {
    el.dataset.collapseChecked = '1';
    const id = el.dataset.postId;

    // Measure overflow against a cap computed from the element's own line-height,
    // so the threshold automatically adapts if .post-body styling changes later.
    //
    // CRITICAL: idempotent guard at the top. Because we run this in BOTH a
    // requestAnimationFrame AND a document.fonts.ready callback (cached fonts
    // make the latter resolve before rAF), without this guard we'd attach two
    // toggles + two click handlers — and clicks would cancel each other out
    // (toggle state flips twice on the same click), so the post looked frozen.
    const measureAndDecide = () => {
      if (el.dataset.collapseDone === '1') return; // already configured — no-op
      if (el.querySelector('.collapsible-toggle')) {
        el.dataset.collapseDone = '1';
        return;
      }

      const cs = getComputedStyle(el);
      const lineHeight = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.5);
      const cap = lineHeight * 6; // matches the 6-ish lines visible at max-height: 9.9em
      const naturalHeight = el.scrollHeight;
      const overflows = naturalHeight > cap + 4; // small fudge for sub-pixel layout

      if (!overflows) {
        // Short post → no toggle ever needed; mark done so a later font-load
        // pass doesn't second-guess this decision.
        el.dataset.collapseDone = '1';
        return;
      }

      // Default to collapsed; restore previously-expanded state for this session
      if (id && _expandedPosts.has(id)) {
        el.classList.add('is-expanded');
      } else {
        el.classList.add('is-collapsed');
      }

      // Append the See more / See less label inside the body itself
      const more = document.createElement('span');
      more.className = 'collapsible-toggle';
      more.textContent = el.classList.contains('is-expanded') ? 'See less' : 'See more';
      el.appendChild(more);
      el.dataset.collapseDone = '1';

      // Tap anywhere on the body toggles — but ignore real links/buttons/images.
      // stopImmediatePropagation (vs stopPropagation) is belt-and-braces: even
      // if a stray duplicate listener somehow gets attached, only one fires.
      el.addEventListener('click', (e) => {
        const t = e.target;
        if (t.tagName === 'A'      || t.closest('a'))      return;
        if (t.tagName === 'BUTTON' || t.closest('button')) return;
        if (t.tagName === 'IMG'    || t.closest('img'))    return;
        e.stopPropagation();
        e.stopImmediatePropagation();
        const expanded = !el.classList.contains('is-expanded');
        el.classList.toggle('is-expanded', expanded);
        el.classList.toggle('is-collapsed', !expanded);
        more.textContent = expanded ? 'See less' : 'See more';
        if (id) {
          if (expanded) _expandedPosts.add(id);
          else          _expandedPosts.delete(id);
        }
      });
    };

    // Two-stage measure: once now (rAF after layout), once after fonts load.
    // Both paths are safe to call repeatedly thanks to the idempotent guard above.
    requestAnimationFrame(measureAndDecide);
    if (document.fonts && typeof document.fonts.ready?.then === 'function') {
      document.fonts.ready.then(measureAndDecide);
    }
  });
}

// Wire feed mode tabs (For You / Following / Discover)
document.querySelectorAll('#feedTabs .feed-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.feed;
    if (mode === _feedMode) return;
    document.querySelectorAll('#feedTabs .feed-tab').forEach(t => t.classList.toggle('active', t === tab));
    _feedMode = mode;
    loadFeed();
  });
});

async function loadMoreFeed() {
  if (_isLoadingMoreFeed || !_hasMoreFeedPosts) return;
  // Guard: only run when the feed is the current page. Without this, an
  // IntersectionObserver fire during navigation (or any leftover scroll
  // observer between page changes) re-shows the sentinel and re-fetches
  // posts even when the user is on /profile, /videos, /books, etc. The
  // visible symptom is a "Loading more posts…" pill stuck on top of an
  // unrelated page.
  const feedIsVisible = feedEl && feedEl.style.display !== 'none' && feedEl.offsetParent !== null;
  if (!feedIsVisible) return;
  _isLoadingMoreFeed = true;

  // Capture the seq at the START. If a tab switch (or fresh loadFeed) bumps
  // the seq while we're awaiting, the response is stale and we discard it
  // instead of appending posts from the wrong mode to the new feed.
  const seq = _feedSeq;

  const sentinel = document.getElementById('feedSentinel');
  if (sentinel) {
    sentinel.style.display = 'block';
    sentinel.innerHTML = '<div class="book-grid-loadmore">Loading more posts…</div>';
  }

  try {
    // Reuse the same query-builder loadFeed uses. Pagination now respects the
    // active mode — Following stays Following, For You keeps its scoring, etc.
    const queryResult = await _buildAndExecFeedQuery({ offset: _feedOffset });

    if (seq !== _feedSeq) return; // user switched tabs while we were waiting

    const rawMore = queryResult.data;
    const more = _processFeedRows(queryResult);
    const advance = rawMore.length;
    if (advance < (queryResult.fetchLimit || FEED_PAGE_SIZE)) _hasMoreFeedPosts = false;
    _feedOffset += advance;

    if (more.length) {
      const feed = document.getElementById('feed');
      const presentIds = new Set(Array.from(feed.querySelectorAll('.post-card')).map(c => c.dataset.postid));
      const fresh = more.filter(p => !presentIds.has(p.id));
      fresh.forEach((post, i) => {
        const el = renderPost(post);
        el.style.animationDelay = `${(i * 0.03).toFixed(3)}s`;
        feed.appendChild(el);
        // Hand off to the existing observers so the new cards lazy-load too
        if (_feedPostObserver) _feedPostObserver.observe(el);
        el.querySelectorAll('.post-video').forEach(v => _feedVideoObserver?.observe(v));
      });
      setupCollapsibleBodies(feed);
      posts = posts.concat(fresh);
    }

    if (sentinel) {
      if (_hasMoreFeedPosts) {
        sentinel.innerHTML = '<div class="book-grid-loadmore">Loading more posts…</div>';
      } else {
        sentinel.innerHTML = `<div class="book-grid-end-msg">You're all caught up · ${posts.length.toLocaleString()} posts</div>`;
        if (_feedScrollObserver) { _feedScrollObserver.disconnect(); _feedScrollObserver = null; }
      }
    }
  } catch (err) {
    if (seq !== _feedSeq) return;
    console.error('Failed to load more feed:', err);
    if (sentinel) sentinel.innerHTML = '<div class="book-grid-end-msg">Couldn\'t load more — try refreshing</div>';
  } finally {
    _isLoadingMoreFeed = false;
  }
}

function setupFeedInfiniteScroll() {
  const sentinel = document.getElementById('feedSentinel');
  if (!sentinel) return;
  sentinel.style.display = 'block';

  if (_feedScrollObserver) _feedScrollObserver.disconnect();
  if (!('IntersectionObserver' in window)) return;

  _feedScrollObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) loadMoreFeed();
  }, { root: null, rootMargin: '600px 0px', threshold: 0.01 });
  _feedScrollObserver.observe(sentinel);
}

// One-shot lazy loaders: HLS for videos, reactions/comments per post-card.
// Posts/videos that never scroll into view never trigger an extra query.
function setupFeedLazyLoaders(container) {
  if (!('IntersectionObserver' in window)) {
    // Fallback: load everything eagerly
    container.querySelectorAll('.post-video').forEach(attachHlsToPostVideo);
    container.querySelectorAll('.post-card').forEach(triggerPostLazyLoad);
    return;
  }

  if (_feedVideoObserver) _feedVideoObserver.disconnect();
  _feedVideoObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      attachHlsToPostVideo(e.target);
      _feedVideoObserver.unobserve(e.target);
    }
  }, { root: null, rootMargin: '300px 0px', threshold: 0.01 });

  if (_feedPostObserver) _feedPostObserver.disconnect();
  _feedPostObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      triggerPostLazyLoad(e.target);
      _feedPostObserver.unobserve(e.target);
    }
  }, { root: null, rootMargin: '500px 0px', threshold: 0.01 });

  container.querySelectorAll('.post-video').forEach(v => _feedVideoObserver.observe(v));
  container.querySelectorAll('.post-card').forEach(c => _feedPostObserver.observe(c));
}

function attachHlsToPostVideo(wrap) {
  const url = wrap.dataset.videoUrl;
  const video = wrap.querySelector('.post-video-player');
  if (!url || !video || video.dataset.attached) return;
  video.dataset.attached = '1';
  if (url.endsWith('.m3u8') && window.Hls && Hls.isSupported() && !video.canPlayType('application/vnd.apple.mpegurl')) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(video);
  } else {
    video.src = url;
  }
}

// Batch lazy-loads via a short debounce so 30 visible cards = 2 queries
// (one for reactions, one for comment counts) instead of 60 round-trips.
const _pendingLazyPostIds = new Set();
let _pendingLazyPostTimer = null;
function triggerPostLazyLoad(card) {
  if (card.dataset.lazyLoaded === '1') return;
  card.dataset.lazyLoaded = '1';
  const id = card.dataset.postid;
  if (!id) return;
  _pendingLazyPostIds.add(id);
  if (_pendingLazyPostTimer) clearTimeout(_pendingLazyPostTimer);
  _pendingLazyPostTimer = setTimeout(flushPostLazyLoad, 80);
}
async function flushPostLazyLoad() {
  const ids = [..._pendingLazyPostIds];
  _pendingLazyPostIds.clear();
  _pendingLazyPostTimer = null;
  if (!ids.length) return;
  // Both fetches can run in parallel.
  await Promise.all([
    bulkLoadReactions(ids, 'post'),
    bulkLoadCommentCounts(ids),
  ]);
}

// Bulk fetch reactions for many targets in one query, then update each row's UI.
async function bulkLoadReactions(targetIds, targetType) {
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
    if (currentUser && r.user_id === currentUser.id) grouped[r.target_id].userReaction = r.emoji;
  });
  // Update each target — empty groups still call updateReactionUI to clear stale state
  for (const id of targetIds) {
    const g = grouped[id] || { counts: {}, userReaction: null };
    updateReactionUI(id, targetType, g.counts, g.userReaction);
  }
}

// Bulk fetch comment counts via single rows-then-group (no count queries).
async function bulkLoadCommentCounts(postIds) {
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

// Backwards-compatibility shim — older code still calls this.
function attachFeedVideoPlayers() {
  document.querySelectorAll('.post-video').forEach(attachHlsToPostVideo);
}

function renderPost(post) {
  const div = document.createElement('div');
  div.className = 'post-card' + (post.pinned_at ? ' is-pinned' : '');
  div.dataset.postid  = post.id;
  div.dataset.authorId = post.user_id || '';
  if (post.pinned_at) div.dataset.pinned = '1';

  const profile = post.profiles || {};
  const name = profile.username || 'Unknown';
  const isGuest = profile.is_guest;
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}" alt="${name}"/>` : initials(name);
  const isOwn = currentUser && currentUser.id === post.user_id;

  div.innerHTML = `
    ${post.pinned_at ? `
      <div class="post-pinned-tag" title="Pinned to profile">
        <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M16 2l-1.4 1.4 1.6 1.6-5.4 5.4-3-1.5L6 11.3l3.7 3.7L4 21l1.4 1.4 5.7-5.7 3.7 3.7 1.4-1.4-1.5-3 5.4-5.4 1.6 1.6L23 9l-7-7z"/></svg>
        Pinned
      </div>
    ` : ''}
    <div class="post-header">
      <div class="avatar profile-link" data-user-id="${post.user_id}" title="View profile">${avatarHTML}</div>
      <div style="flex:1">
        <div style="display:flex;align-items:center">
          <span class="post-author profile-link" data-user-id="${post.user_id}" title="View profile">${escHTML(name)}${renderRoleSeal(post.profiles)}</span>
          ${isGuest ? '<span class="post-guest">Guest</span>' : ''}
        </div>
        <div class="post-time">${timeAgo(post.created_at)}</div>
      </div>
      ${currentUser ? `
        <button class="post-menu-btn"
                onclick="openPostActionMenu(event, this)"
                data-post-id="${post.id}"
                data-is-own="${isOwn ? '1' : '0'}"
                data-is-pinned="${post.pinned_at ? '1' : '0'}"
                data-author-id="${post.user_id}"
                data-author-name="${escHTML(name)}"
                title="${isOwn ? 'Post options' : 'Post options'}"
                aria-label="Post options">
          <span class="post-menu-glyph">⋮</span>
        </button>
      ` : ''}
    </div>

    ${post.reposted_from && post.original ? `
      <div class="reposted-banner">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        Reposted
      </div>
    ` : ''}

    ${post.body ? `<div class="post-body collapsible-body" data-post-id="${post.id}">${linkify(post.body)}</div>` : ''}
    ${post.body ? renderLinkPreview(post.body) : ''}
    ${post.image_url ? `<div class="post-image" onclick="openLightbox('${post.image_url}')"><img src="${post.image_url}" alt="post image" loading="lazy"/></div>` : ''}
    ${post.videos ? `
      <div class="post-video" data-video-url="${escHTML(post.videos.video_url || '')}" data-video-id="${escHTML(post.videos.id || '')}">
        <video class="post-video-player" poster="${escHTML(post.videos.thumbnail_url || '')}" muted playsinline preload="none" controls></video>
      </div>
    ` : ''}

    ${post.reposted_from && post.original ? `
      <div class="reposted-card">
        <div class="post-header">
          <div class="avatar profile-link" data-user-id="${post.original.user_id || ''}" title="View profile">${post.original.profiles?.avatar_url ? `<img src="${post.original.profiles.avatar_url}"/>` : initials(post.original.profiles?.username || 'U')}</div>
          <div>
            <span class="post-author profile-link" data-user-id="${post.original.user_id || ''}" title="View profile">${escHTML(post.original.profiles?.username || 'Unknown')}${renderRoleSeal(post.original.profiles)}</span>
            <div class="post-time">${timeAgo(post.original.created_at)}</div>
          </div>
        </div>
        ${post.original.body ? `<div class="post-body collapsible-body" data-post-id="${post.original.id}">${linkify(post.original.body)}</div>` : ''}
        ${post.original.body ? renderLinkPreview(post.original.body) : ''}
        ${post.original.image_url ? `<div class="post-image" onclick="event.stopPropagation();openLightbox('${post.original.image_url}')"><img src="${post.original.image_url}" loading="lazy"/></div>` : ''}
        ${post.original.videos ? `
          <div class="post-video" data-video-url="${escHTML(post.original.videos.video_url || '')}" data-video-id="${escHTML(post.original.videos.id || '')}">
            <video class="post-video-player" poster="${escHTML(post.original.videos.thumbnail_url || '')}" muted playsinline preload="none" controls></video>
          </div>
        ` : ''}
       </div>
      ` : ''}

    <div class="post-stats">
      <div class="rcount" id="rsummary-${post.id}" data-target="${post.id}" data-type="post"></div>
      <div class="ccount" id="ccount-${post.id}" data-postid="${post.id}"></div>
    </div>

    <div class="post-actions">
      <div class="reaction-wrap" data-target="${post.id}" data-type="post">
        <button class="action-btn reaction-trigger" data-target="${post.id}" data-type="post">
          <span class="r-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </span>
          <span class="r-label-text">Like</span>
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

      <button class="action-btn comment-toggle" data-postid="${post.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>Comments</span>
      </button>

      <button class="action-btn" onclick="repostPost('${post.id}')" title="Repost">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        <span>Repost</span>
      </button>

      <div class="reaction-wrap" style="position:relative">
        <button class="action-btn" onclick="toggleShareMenu(event, '${post.id}')" title="Share">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          <span>Share</span>
        </button>
        <div class="share-menu" id="sharemenu-${post.id}">
          <button class="share-option" onclick="shareTo('facebook','${post.id}')">📘 Facebook</button>
          <button class="share-option" onclick="shareTo('twitter','${post.id}')">🐦 Twitter / X</button>
          <button class="share-option" onclick="shareTo('whatsapp','${post.id}')">💬 WhatsApp</button>
          <button class="share-option" onclick="shareTo('copy','${post.id}')">🔗 Copy link</button>
        </div>
      </div>
    </div>

    <div class="comments-section" id="comments-${post.id}" style="display:none"></div>
  `;
  // Reactions and comment count are now loaded lazily by setupFeedLazyLoaders
  // when the post-card scrolls into view (saves ~2 queries per off-screen post)
  return div;
}

function escHTML(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}
function linkify(str) {
  const escaped = escHTML(str);
  return escaped.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// ── Search helpers ────────────────────────────────────────────────────────────
// PostgREST's .or() filter splits on commas and uses parens for grouping.
// If those characters end up inside the user's query, the entire OR clause
// breaks (causing "no results" for searches like `Romeo, Juliet` or `What's up?`).
// Strip them defensively — users still get matches on the remaining tokens.
function sanitizeSearchQuery(raw) {
  return (raw || '')
    .replace(/[,\(\)"]/g, ' ')   // PostgREST or() splitters / quote chars
    .replace(/\s+/g, ' ')
    .trim();
}
// Escape ilike wildcards (% _ \) so a literal underscore doesn't match every char.
function escapeIlike(s) {
  return (s || '').replace(/[\\%_]/g, m => '\\' + m);
}
// Strip diacritics + lowercase, so "café" matches "cafe" on local cache filters.
// (Server-side ilike is bytewise; full diacritic-insensitive search would need
// a Postgres `unaccent` index — tracked as a future improvement.)
function normalizeForSearch(s) {
  return (s || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// Translate vertical mouse-wheel scrolling into horizontal scroll on chip rails
// (Trackpads already do this natively; this fixes mouse-wheel users.)
function enableHorizontalWheelScroll(el) {
  if (!el || el.dataset.wheelBound === '1') return;
  el.dataset.wheelBound = '1';
  el.addEventListener('wheel', (e) => {
    // If user is scrolling more vertically than horizontally, redirect to horizontal scroll
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  }, { passive: false });
}

// Wire it up for both chip rails as soon as DOM is ready
function setupChipRailScrolling() {
  enableHorizontalWheelScroll(document.getElementById('bookGenreChips'));
  enableHorizontalWheelScroll(document.getElementById('videoSearchTags'));
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupChipRailScrolling);
} else {
  setupChipRailScrolling();
}

// ── Link previews (YouTube thumbnail + generic favicon fallback) ──
function youtubeIdFromUrl(url) {
  if (!url) return null;
  // Matches: youtube.com/watch?v=ID  •  youtu.be/ID  •  youtube.com/shorts/ID  •  youtube.com/embed/ID
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function firstUrlInText(str) {
  if (!str) return null;
  const m = str.match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : null;
}

function renderLinkPreview(text) {
  const url = firstUrlInText(text);
  if (!url) return '';

  // YouTube — instant, no API needed (free public thumbnail)
  const ytId = youtubeIdFromUrl(url);
  if (ytId) {
    return `
      <a class="link-preview link-preview-youtube" href="${escHTML(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">
        <div class="link-preview-thumb">
          <img src="https://i.ytimg.com/vi/${ytId}/hqdefault.jpg" alt="YouTube thumbnail" loading="lazy"
               onerror="this.src='https://i.ytimg.com/vi/${ytId}/mqdefault.jpg'"/>
          <div class="link-preview-play-badge" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <div class="link-preview-platform">YouTube</div>
        </div>
      </a>
    `;
  }

  // Generic — favicon + hostname (no thumbnail, but distinguishes link from raw text)
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    return `
      <a class="link-preview link-preview-generic" href="${escHTML(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">
        <div class="link-preview-favicon">
          <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=64" alt="" loading="lazy"/>
        </div>
        <div class="link-preview-meta">
          <div class="link-preview-host">${escHTML(host)}</div>
          <div class="link-preview-url">${escHTML(url.length > 80 ? url.slice(0, 77) + '…' : url)}</div>
        </div>
      </a>
    `;
  } catch { return ''; }
}

// ── DM-specific link preview: Selebox-internal links get rich cards ──
// Detects URLs of the form `…#video/UUID`, `…#book/UUID`, `…#profile/UUID`
// and renders an in-app card with thumbnail/title/author. Async hydration
// runs after renderMessages via hydrateDmInternalPreviews().
function parseSeleboxInternalUrl(url) {
  if (!url) return null;
  const m = url.match(/#(video|book|profile)\/([a-z0-9-]+)/i);
  if (!m) return null;
  return { type: m[1].toLowerCase(), id: m[2] };
}

// In-memory cache so we don't refetch the same item on every render
const _dmInternalPreviewCache = new Map(); // key = type:id, value = {title, thumb, sub}

function renderDmLinkPreview(body) {
  const url = firstUrlInText(body);
  if (!url) return '';

  // Selebox-internal: render placeholder, hydrator fills it in
  const internal = parseSeleboxInternalUrl(url);
  if (internal) {
    const cacheKey = `${internal.type}:${internal.id}`;
    const cached = _dmInternalPreviewCache.get(cacheKey);
    return renderInternalPreviewCard(internal, cached);
  }

  // External: existing YouTube/generic preview (just wrap in dm-link-preview class for spacing)
  const html = renderLinkPreview(body);
  return html ? `<div class="dm-link-preview-wrap">${html}</div>` : '';
}

function renderInternalPreviewCard(internal, data) {
  const { type, id } = internal;
  const typeLabel = type === 'video' ? '🎬 Video' : type === 'book' ? '📖 Book' : '👤 Profile';
  if (data) {
    const thumb = data.thumb
      ? `<img src="${escHTML(data.thumb)}" alt="" loading="lazy"/>`
      : `<div class="dm-internal-placeholder">${type === 'profile' ? initials(data.title || '?') : (type === 'book' ? '📖' : '🎬')}</div>`;
    const sub = data.sub ? `<div class="dm-internal-sub">${escHTML(data.sub)}</div>` : '';
    return `
      <button class="dm-internal-preview" data-internal-type="${type}" data-internal-id="${escHTML(id)}" type="button">
        <div class="dm-internal-thumb">${thumb}</div>
        <div class="dm-internal-meta">
          <div class="dm-internal-platform">${typeLabel} on Selebox</div>
          <div class="dm-internal-title">${escHTML(data.title || 'Untitled')}</div>
          ${sub}
        </div>
        <div class="dm-internal-arrow">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </button>
    `;
  }
  // Placeholder skeleton — gets filled in by hydrateDmInternalPreviews
  return `
    <button class="dm-internal-preview is-loading" data-internal-type="${type}" data-internal-id="${escHTML(id)}" data-pending="1" type="button">
      <div class="dm-internal-thumb dm-internal-skel"></div>
      <div class="dm-internal-meta">
        <div class="dm-internal-platform">${typeLabel} on Selebox</div>
        <div class="dm-internal-title dm-internal-skel-line"></div>
        <div class="dm-internal-sub dm-internal-skel-line dm-internal-skel-line-short"></div>
      </div>
    </button>
  `;
}

// Async fetch the actual content for any pending preview cards in the DOM.
// Called after each renderMessages — only hits the network for unhydrated cards.
async function hydrateDmInternalPreviews() {
  const pending = document.querySelectorAll('.dm-internal-preview[data-pending="1"]');
  if (!pending.length) return;

  // Group by type for batched fetch
  const byType = { video: new Set(), book: new Set(), profile: new Set() };
  pending.forEach(el => {
    const t = el.dataset.internalType;
    const id = el.dataset.internalId;
    if (byType[t]) byType[t].add(id);
  });

  // Fetch in parallel
  const tasks = [];
  if (byType.video.size) tasks.push(
    supabase.from('videos')
      .select('id, title, thumbnail_url, profiles!videos_uploader_id_fkey(username)')
      .in('id', [...byType.video])
      .then(({ data }) => (data || []).forEach(v => {
        _dmInternalPreviewCache.set(`video:${v.id}`, {
          title: v.title || 'Untitled video',
          thumb: v.thumbnail_url,
          sub: v.profiles?.username ? `by @${v.profiles.username}` : '',
        });
      }))
  );
  if (byType.book.size) tasks.push(
    supabase.from('books')
      .select('id, title, cover_url, profiles!books_author_id_fkey(username)')
      .in('id', [...byType.book])
      .then(({ data }) => (data || []).forEach(b => {
        _dmInternalPreviewCache.set(`book:${b.id}`, {
          title: b.title || 'Untitled book',
          thumb: b.cover_url,
          sub: b.profiles?.username ? `by @${b.profiles.username}` : '',
        });
      }))
  );
  if (byType.profile.size) tasks.push(
    supabase.from('profiles')
      .select('id, username, avatar_url, bio')
      .in('id', [...byType.profile])
      .then(({ data }) => (data || []).forEach(p => {
        _dmInternalPreviewCache.set(`profile:${p.id}`, {
          title: '@' + (p.username || 'unknown'),
          thumb: p.avatar_url,
          sub: (p.bio || '').slice(0, 60),
        });
      }))
  );

  await Promise.all(tasks);

  // Snapshot scroll position BEFORE we mutate — if the user was at the bottom,
  // we re-pin AFTER the swap so the latest message stays in view (the
  // skeleton→full-card replacement can grow each bubble by a few px).
  const wrap = document.getElementById('dmMessages');
  const wasAtBottom = wrap ? isDmAtBottom(wrap) : false;

  // Now swap each pending placeholder with the real card
  pending.forEach(el => {
    const t = el.dataset.internalType;
    const id = el.dataset.internalId;
    const data = _dmInternalPreviewCache.get(`${t}:${id}`);
    if (!data) return;
    const replacement = document.createElement('div');
    replacement.innerHTML = renderInternalPreviewCard({ type: t, id }, data).trim();
    el.parentNode.replaceChild(replacement.firstChild, el);
  });

  if (wasAtBottom) scrollMessagesToBottom();
}

// Click handler for internal preview cards (delegated)
document.addEventListener('click', (e) => {
  const card = e.target.closest('.dm-internal-preview');
  if (!card || card.dataset.pending === '1') return;
  e.stopPropagation();
  const type = card.dataset.internalType;
  const id = card.dataset.internalId;
  if (type === 'video')   playVideo('sb_' + id);
  else if (type === 'book')    openBookDetail(id);
  else if (type === 'profile') openProfile(id);
});

// ── Premium confirmation dialog (replaces native confirm()) ──
// Usage: const ok = await confirmDialog({ title, body, confirmLabel, danger });
function confirmDialog({ title = 'Are you sure?', body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmTitle');
    const bodyEl  = document.getElementById('confirmBody');
    const okBtn   = document.getElementById('confirmOk');
    const okLabel = document.getElementById('confirmOkLabel');
    const cancelBtn = document.getElementById('confirmCancel');
    if (!overlay) { resolve(window.confirm(`${title}\n\n${body}`)); return; }

    titleEl.textContent = title;
    bodyEl.textContent  = body;
    okLabel.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.classList.toggle('confirm-btn-danger', !!danger);

    overlay.style.display = 'flex';
    requestAnimationFrame(() => overlay.classList.add('open'));

    const cleanup = () => {
      overlay.classList.remove('open');
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onBackdrop = (e) => { if (e.target === overlay) onCancel(); };
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);

    // Focus the cancel button by default for safer UX
    setTimeout(() => cancelBtn.focus(), 50);
  });
}
// Expose globally so any onclick="..." handlers can use it too
window.confirmDialog = confirmDialog;

window.deletePost = async (postId) => {
  const ok = await confirmDialog({
    title: 'Delete this post?',
    body: 'This permanently removes the post from your feed. If it includes a video, the video file will also be deleted from storage. This can\'t be undone.',
    confirmLabel: 'Delete forever',
  });
  if (!ok) return;

  // Check if this post has a video — if so, also delete the video & Bunny file
  const { data: post, error: lookupError } = await supabase
    .from('posts')
    .select('video_id')
    .eq('id', postId)
    .single();

  if (lookupError) {
    toast('Failed to find post: ' + lookupError.message, 'error');
    return;
  }

  if (post?.video_id) {
    try {
      await callEdgeFunction('bunny-delete', { videoId: post.video_id });
    } catch (err) {
      toast('Failed to delete video file: ' + err.message, 'error');
      return;
    }
  }

  const { error } = await supabase.from('posts').delete().eq('id', postId);
  if (error) {
    toast(error.message, 'error');
    return;
  }

  toast('Deleted', 'success');
  loadFeed();

  // Always invalidate videos cache so next visit to videos page is fresh
  allVideosCache = [];
  if (videosPage.style.display === 'block') {
    loadVideos();
  }
};

// Pin/unpin a post to your profile (max 3 enforced server-side)
async function togglePinPost(postId, currentlyPinned) {
  const newPinnedAt = currentlyPinned ? null : new Date().toISOString();
  const { error } = await supabase
    .from('posts')
    .update({ pinned_at: newPinnedAt })
    .eq('id', postId)
    .eq('user_id', currentUser.id); // belt-and-suspenders — RLS already enforces

  if (error) {
    if (/up to 3|max/i.test(error.message)) {
      toast('You can only pin 3 posts. Unpin one first.', 'error');
    } else {
      toast(error.message, 'error');
    }
    return;
  }

  toast(currentlyPinned ? 'Unpinned' : 'Pinned to profile', 'success');

  // If we're on the profile, refresh the posts tab so order updates
  if (viewingProfileId === currentUser.id) {
    loadProfilePosts(currentUser.id);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// POST ACTION MENU — kebab menu on posts (own: Pin/Delete · others: Report/Hide/Snooze/Block)
// ════════════════════════════════════════════════════════════════════════════

// Cache of the current user's content filter sets (refreshed on bootstrap + after actions)
let userContentFilters = {
  hiddenPostIds:    new Set(),
  snoozedUserIds:   new Set(),
  blockedUserIds:   new Set(),
};

async function loadUserContentFilters() {
  if (!currentUser) {
    userContentFilters = { hiddenPostIds: new Set(), snoozedUserIds: new Set(), blockedUserIds: new Set() };
    return;
  }
  try {
    const [hides, snoozes, blocks] = await Promise.all([
      supabase.from('post_hides').select('post_id').eq('user_id', currentUser.id),
      supabase.from('user_snoozes').select('target_user_id').eq('user_id', currentUser.id).gt('expires_at', new Date().toISOString()),
      supabase.from('user_blocks').select('blocked_user_id').eq('user_id', currentUser.id),
    ]);
    userContentFilters.hiddenPostIds  = new Set((hides.data    || []).map(r => r.post_id));
    userContentFilters.snoozedUserIds = new Set((snoozes.data  || []).map(r => r.target_user_id));
    userContentFilters.blockedUserIds = new Set((blocks.data   || []).map(r => r.blocked_user_id));
  } catch (e) {
    console.warn('[filters] load failed (likely tables missing — run migration_post_actions.sql)', e);
  }
}
window.loadUserContentFilters = loadUserContentFilters;

function shouldHidePost(post) {
  if (!post) return false;
  if (post.profiles?.is_banned)                            return true;
  if (userContentFilters.hiddenPostIds.has(post.id))      return true;
  if (userContentFilters.snoozedUserIds.has(post.user_id))return true;
  if (userContentFilters.blockedUserIds.has(post.user_id))return true;
  return false;
}
window.shouldHidePost = shouldHidePost;

let _postActionMenuEl = null;
function closePostActionMenu() {
  if (_postActionMenuEl) { _postActionMenuEl.remove(); _postActionMenuEl = null; }
}

window.openPostActionMenu = (e, btn) => {
  e.stopPropagation();
  e.preventDefault();
  if (!currentUser) { toast('Please sign in', 'error'); return; }

  const postId     = btn.dataset.postId;
  const isOwn      = btn.dataset.isOwn === '1';
  const authorId   = btn.dataset.authorId;
  const authorName = btn.dataset.authorName || 'this user';
  const isPinned   = btn.dataset.isPinned === '1';

  closePostActionMenu();
  _postActionMenuEl = document.createElement('div');
  _postActionMenuEl.className = 'post-action-menu';
  _postActionMenuEl.innerHTML = isOwn ? `
    <button data-pam-action="${isPinned ? 'unpin' : 'pin'}">${isPinned ? 'Unpin from profile' : 'Pin to profile'}</button>
    <button data-pam-action="delete" class="pam-danger">Delete post</button>
  ` : `
    <button data-pam-action="report">Report</button>
    <button data-pam-action="hide">Hide post</button>
    <button data-pam-action="snooze">Snooze · 30 days</button>
    <button data-pam-action="block" class="pam-danger">Block</button>
  `;
  document.body.appendChild(_postActionMenuEl);

  // Position: below button, right-aligned to button's right edge
  const r = btn.getBoundingClientRect();
  _postActionMenuEl.style.position = 'fixed';
  _postActionMenuEl.style.top      = `${Math.min(r.bottom + 6, window.innerHeight - 240)}px`;
  _postActionMenuEl.style.right    = `${Math.max(window.innerWidth - r.right, 12)}px`;

  _postActionMenuEl.querySelectorAll('[data-pam-action]').forEach(b => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const action = b.dataset.pamAction;
      closePostActionMenu();
      if      (action === 'report') openReportModal(postId);
      else if (action === 'hide')   hidePostFromFeed(postId);
      else if (action === 'snooze') snoozeAuthor(authorId, authorName);
      else if (action === 'block')  blockAuthor(authorId, authorName);
      else if (action === 'pin')    togglePinPost(postId, false);
      else if (action === 'unpin')  togglePinPost(postId, true);
      else if (action === 'delete') window.deletePost(postId);
    };
  });

  // Click anywhere else / Escape → close
  setTimeout(() => {
    const onDocClick = (ev) => {
      if (!_postActionMenuEl?.contains(ev.target)) {
        closePostActionMenu();
        document.removeEventListener('click',  onDocClick);
        document.removeEventListener('keydown', onKey);
      }
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { closePostActionMenu(); document.removeEventListener('keydown', onKey); document.removeEventListener('click', onDocClick); } };
    document.addEventListener('click',  onDocClick);
    document.addEventListener('keydown', onKey);
  }, 0);
};

async function hidePostFromFeed(postId) {
  const { error } = await supabase.from('post_hides').upsert({
    user_id: currentUser.id,
    post_id: postId,
  }, { onConflict: 'user_id,post_id' });
  if (error) { toast(error.message, 'error'); return; }

  userContentFilters.hiddenPostIds.add(postId);

  // Smooth fade out, then remove from DOM
  const card = document.querySelector(`.post-card[data-postid="${postId}"]`);
  if (card) {
    card.style.transition = 'opacity 0.25s, transform 0.25s, max-height 0.3s';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.97)';
    setTimeout(() => card.remove(), 280);
  }
  toast('Post hidden', 'success');
}

async function snoozeAuthor(targetId, targetName) {
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);
  const { error } = await supabase.from('user_snoozes').upsert({
    user_id: currentUser.id,
    target_user_id: targetId,
    expires_at: expires.toISOString(),
  }, { onConflict: 'user_id,target_user_id' });
  if (error) { toast(error.message, 'error'); return; }

  userContentFilters.snoozedUserIds.add(targetId);
  toast(`${targetName} snoozed for 30 days`, 'success');

  // Remove all their visible posts from current feed
  document.querySelectorAll(`.post-card[data-author-id="${targetId}"]`).forEach(c => c.remove());
}

async function blockAuthor(targetId, targetName) {
  const ok = await confirmDialog({
    title: `Block ${targetName}?`,
    body: 'You won\'t see their posts and they won\'t see yours. You\'ll also unfollow each other. You can unblock later in settings.',
    confirmLabel: 'Block',
  });
  if (!ok) return;

  const { error } = await supabase.from('user_blocks').upsert({
    user_id: currentUser.id,
    blocked_user_id: targetId,
  }, { onConflict: 'user_id,blocked_user_id' });
  if (error) { toast(error.message, 'error'); return; }

  userContentFilters.blockedUserIds.add(targetId);
  toast(`Blocked ${targetName}`, 'success');

  document.querySelectorAll(`.post-card[data-author-id="${targetId}"]`).forEach(c => c.remove());
}

function openReportModal(postId) {
  // Remove any existing modal
  closeAllModals('.modal-backdrop[data-modal="report"]');

  const reasons = [
    ['spam',      'Spam',                'Repetitive, misleading, or scammy'],
    ['harassment','Harassment',          'Bullying or targeting someone'],
    ['hate',      'Hate speech',         'Attacks on identity or group'],
    ['nsfw',      'NSFW / Adult content','Inappropriate for general audiences'],
    ['self_harm', 'Self-harm',           'Suicide, self-injury, or eating disorders'],
    ['other',     'Other',               'Something else'],
  ];

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'report';
  modal.innerHTML = `
    <div class="modal-card report-modal" role="dialog" aria-labelledby="report-title">
      <h2 id="report-title">Report post</h2>
      <p class="modal-sub">Help us keep Selebox safe — pick what's wrong with this post.</p>
      <div class="report-reasons">
        ${reasons.map(([val, label, desc]) => `
          <label class="report-reason">
            <input type="radio" name="reason" value="${val}"/>
            <div class="report-reason-text">
              <div class="report-reason-title">${label}</div>
              <div class="report-reason-desc">${desc}</div>
            </div>
          </label>
        `).join('')}
      </div>
      <textarea class="report-details" placeholder="Optional context (max 500 characters)" maxlength="500"></textarea>
      <div class="modal-actions">
        <button class="btn-ghost"   data-action="cancel">Cancel</button>
        <button class="btn-primary" data-action="submit" disabled>Submit report</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const submitBtn = modal.querySelector('[data-action="submit"]');
  modal.querySelectorAll('input[name="reason"]').forEach(r => {
    r.addEventListener('change', () => {
      submitBtn.disabled = false;
      modal.querySelectorAll('.report-reason').forEach(rr => rr.classList.toggle('checked', rr.querySelector('input').checked));
    });
  });

  const close = () => modal.remove();
  modal.querySelector('[data-action="cancel"]').onclick = close;
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });
  document.addEventListener('keydown', function onKey(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  submitBtn.onclick = async () => {
    const reason  = modal.querySelector('input[name="reason"]:checked')?.value;
    const details = modal.querySelector('.report-details').value.trim();
    if (!reason) return;

    submitBtn.disabled    = true;
    submitBtn.textContent = 'Submitting…';

    const { error } = await supabase.from('post_reports').insert({
      reporter_id: currentUser.id,
      post_id:     postId,
      reason,
      details:     details || null,
    });

    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        toast('You already reported this post', 'success');
        close();
      } else {
        toast(error.message, 'error');
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Submit report';
      }
      return;
    }
    toast('Report submitted — thanks for keeping Selebox safe', 'success');
    close();
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PROFILE ACTION MENU — kebab on profile (Share / Report / Snooze / Block)
// ════════════════════════════════════════════════════════════════════════════
let _profileActionMenuEl = null;
function closeProfileActionMenu() {
  if (_profileActionMenuEl) { _profileActionMenuEl.remove(); _profileActionMenuEl = null; }
}

window.openProfileActionMenu = (e, btn, ctx) => {
  e.stopPropagation();
  e.preventDefault();
  if (!currentUser) { toast('Please sign in', 'error'); return; }

  const { isOwn, userId, username } = ctx;

  // Own profile: just share — single action, no menu
  if (isOwn) {
    shareProfile(userId, username);
    return;
  }

  closeProfileActionMenu();
  _profileActionMenuEl = document.createElement('div');
  _profileActionMenuEl.className = 'post-action-menu profile-action-menu';
  _profileActionMenuEl.innerHTML = `
    <button data-pam-action="share">Share profile</button>
    <button data-pam-action="report">Report user</button>
    <button data-pam-action="snooze">Snooze · 30 days</button>
    <button data-pam-action="block" class="pam-danger">Block</button>
  `;
  document.body.appendChild(_profileActionMenuEl);

  // Position: below button, right-aligned
  const r = btn.getBoundingClientRect();
  _profileActionMenuEl.style.position = 'fixed';
  _profileActionMenuEl.style.top      = `${Math.min(r.bottom + 6, window.innerHeight - 240)}px`;
  _profileActionMenuEl.style.right    = `${Math.max(window.innerWidth - r.right, 12)}px`;

  _profileActionMenuEl.querySelectorAll('[data-pam-action]').forEach(b => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const action = b.dataset.pamAction;
      closeProfileActionMenu();
      if      (action === 'share')  shareProfile(userId, username);
      else if (action === 'report') openReportUserModal(userId, username);
      else if (action === 'snooze') snoozeAuthor(userId, username);
      else if (action === 'block')  blockAuthor(userId, username);
    };
  });

  // Click anywhere else / Escape → close
  setTimeout(() => {
    const onDocClick = (ev) => {
      if (!_profileActionMenuEl?.contains(ev.target)) {
        closeProfileActionMenu();
        document.removeEventListener('click',  onDocClick);
        document.removeEventListener('keydown', onKey);
      }
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { closeProfileActionMenu(); document.removeEventListener('keydown', onKey); document.removeEventListener('click', onDocClick); } };
    document.addEventListener('click',  onDocClick);
    document.addEventListener('keydown', onKey);
  }, 0);
};

// Share profile — modal with copy link, native share, X/Facebook
async function shareProfile(userId, username) {
  const url = `${window.location.origin}${window.location.pathname}#profile/${userId}`;
  const title = `${username} on Selebox`;
  const text  = `Check out @${username} on Selebox`;
  const safeUser = escHTML(username);

  // Remove any existing modal
  closeAllModals('.modal-backdrop[data-modal="share-profile"]');

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'share-profile';
  modal.innerHTML = `
    <div class="modal-card share-modal" role="dialog" aria-labelledby="share-title">
      <h2 id="share-title">Share profile</h2>
      <p class="modal-sub">Share <strong>@${safeUser}</strong>'s profile with friends.</p>

      <div class="share-link-row">
        <input type="text" class="share-link-input" readonly value="${url}"/>
        <button class="btn-primary share-copy-btn" data-action="copy">Copy</button>
      </div>

      <div class="share-options">
        ${navigator.share ? `
        <button class="share-option" data-action="native">
          <span class="share-option-icon">📤</span>
          <span>More…</span>
        </button>` : ''}
        <a class="share-option" target="_blank" rel="noopener"
           href="https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}">
          <span class="share-option-icon">𝕏</span>
          <span>Post</span>
        </a>
        <a class="share-option" target="_blank" rel="noopener"
           href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}">
          <span class="share-option-icon">f</span>
          <span>Facebook</span>
        </a>
        <a class="share-option" target="_blank" rel="noopener"
           href="https://api.whatsapp.com/send?text=${encodeURIComponent(text + ' ' + url)}">
          <span class="share-option-icon">💬</span>
          <span>WhatsApp</span>
        </a>
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

  // Copy
  const copyBtn = modal.querySelector('[data-action="copy"]');
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1600);
    } catch {
      // Fallback: select the input
      const inp = modal.querySelector('.share-link-input');
      inp.select();
      document.execCommand?.('copy');
      toast('Link copied', 'success');
    }
  };

  // Native share
  const nativeBtn = modal.querySelector('[data-action="native"]');
  if (nativeBtn) {
    nativeBtn.onclick = async () => {
      try { await navigator.share({ title, text, url }); close(); }
      catch { /* user cancelled */ }
    };
  }
}

// Report user — modal, mirrors openReportModal but writes to user_reports
function openReportUserModal(targetUserId, targetUsername) {
  closeAllModals('.modal-backdrop[data-modal="report-user"]');

  const reasons = [
    ['harassment',   'Harassment',           'Bullying, threats, or targeting'],
    ['spam',         'Spam',                 'Repetitive, scammy, or fake account'],
    ['impersonation','Impersonation',        'Pretending to be someone else'],
    ['hate',         'Hate speech',          'Attacks on identity or group'],
    ['nsfw',         'NSFW / Adult content', 'Inappropriate profile content'],
    ['self_harm',    'Self-harm',            'Suicide, self-injury, or eating disorders'],
    ['other',        'Other',                'Something else'],
  ];

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'report-user';
  const safeUser = escHTML(targetUsername);
  modal.innerHTML = `
    <div class="modal-card report-modal" role="dialog" aria-labelledby="report-user-title">
      <h2 id="report-user-title">Report user</h2>
      <p class="modal-sub">Reporting <strong>@${safeUser}</strong> — help us keep Selebox safe.</p>
      <div class="report-reasons">
        ${reasons.map(([val, label, desc]) => `
          <label class="report-reason">
            <input type="radio" name="reason" value="${val}"/>
            <div class="report-reason-text">
              <div class="report-reason-title">${label}</div>
              <div class="report-reason-desc">${desc}</div>
            </div>
          </label>
        `).join('')}
      </div>
      <textarea class="report-details" placeholder="Optional context (max 500 characters)" maxlength="500"></textarea>
      <div class="modal-actions">
        <button class="btn-ghost"   data-action="cancel">Cancel</button>
        <button class="btn-primary" data-action="submit" disabled>Submit report</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const submitBtn = modal.querySelector('[data-action="submit"]');
  modal.querySelectorAll('input[name="reason"]').forEach(r => {
    r.addEventListener('change', () => {
      submitBtn.disabled = false;
      modal.querySelectorAll('.report-reason').forEach(rr => rr.classList.toggle('checked', rr.querySelector('input').checked));
    });
  });

  const close = () => modal.remove();
  modal.querySelector('[data-action="cancel"]').onclick = close;
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });
  document.addEventListener('keydown', function onKey(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  submitBtn.onclick = async () => {
    const reason  = modal.querySelector('input[name="reason"]:checked')?.value;
    const details = modal.querySelector('.report-details').value.trim();
    if (!reason) return;

    submitBtn.disabled    = true;
    submitBtn.textContent = 'Submitting…';

    const { error } = await supabase.from('user_reports').insert({
      reporter_id:      currentUser.id,
      reported_user_id: targetUserId,
      reason,
      details:          details || null,
    });

    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        toast('You already reported this user', 'success');
        close();
      } else {
        toast(error.message, 'error');
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Submit report';
      }
      return;
    }
    toast('Report submitted — thanks for keeping Selebox safe', 'success');
    close();
  };
}

async function loadCommentCount(postId, videoId = null) {
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

// ── Reactions ──
async function loadReactions(targetId, targetType) {
  const { data } = await supabase.from('reactions').select('emoji, user_id').eq('target_id', targetId).eq('target_type', targetType);
  if (!data) return;
  const counts = {};
  let userReaction = null;
  data.forEach(r => {
    counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    if (currentUser && r.user_id === currentUser.id) userReaction = r.emoji;
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
      iconEl.innerHTML = `<span>${activeR.emoji}</span>`;
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
    const summaryHtml = sortedEmojis.length === 0 ? ''
      : `<span class="rcount-emojis">${sortedEmojis.map(r => r.emoji).join('')}</span> ${total}`;
    document.querySelectorAll(`#rsummary-${targetId}`).forEach(el => { el.innerHTML = summaryHtml; });
  }
}

async function handleReaction(targetId, targetType, emojiKey) {
  if (!currentUser) return toast('Sign in to react', 'error');

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
      if (icon)  icon.innerHTML = `<span>${r.emoji}</span>`;
      if (label) label.textContent = r.label;
      trigger.classList.add('reacted');
    });
  } catch {}

  // Read existing reaction to decide add vs change vs remove. SELECT is
  // RLS-permitted (true), so this works under any session state.
  const { data: existing, error: lookupErr } = await supabase
    .from('reactions')
    .select('id, emoji')
    .eq('user_id', currentUser.id)
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
      p_actor_id: currentUser.id,
      p_target_type: targetType,
      p_target_id: String(targetId),
    });
    mutErr = error;
  } else {
    // Add or change emoji — submit_reaction handles both atomically.
    const { error } = await supabase.rpc('submit_reaction', {
      p_actor_id: currentUser.id,
      p_target_type: targetType,
      p_target_id: String(targetId),
      p_emoji: emojiKey,
    });
    mutErr = error;
  }

  if (mutErr) {
    toast('Reaction failed: ' + mutErr.message, 'error');
  }
  loadReactions(targetId, targetType);
}

// ── Comments ──
// Facebook-style truncation. Showing every parent comment expanded made
// long threads (200+ comments on a popular post) unscrollable — the
// reactions row at the bottom of the post effectively never reached
// the viewport. Now we show only the most recent N parents plus a
// "View N previous comments" link that expands the older ones.
const INITIAL_PARENTS_VISIBLE = 2;

async function loadComments(postId, videoId = null) {
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
  inputWrap.innerHTML = `
    <div style="display:flex;gap:0.5rem;align-items:flex-start;width:100%">
      <div class="avatar sm">${currentProfile?.avatar_url ? `<img src="${currentProfile.avatar_url}"/>` : initials(currentProfile?.username || 'G')}</div>
      <textarea class="comment-input" placeholder="Write a comment…" rows="1"></textarea>
      <button class="btn-send">Send</button>
    </div>
    <div id="${previewKey}" style="margin-left:40px"></div>
    <div style="margin-left:40px;margin-top:-4px">
      <label class="image-upload-btn" style="padding:4px 8px;font-size:0.72rem">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        Add photo
        <input type="file" accept="image/*" class="cimg-input"/>
      </label>
    </div>
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
    viewMoreBtn.textContent = `View ${hiddenParents.length} previous comment${hiddenParents.length === 1 ? '' : 's'}`;
    viewMoreBtn.addEventListener('click', async () => {
      viewMoreBtn.disabled = true;
      // Insert hidden parents in their original (oldest-first) order
      // BEFORE the first currently-visible comment. We have to capture
      // the anchor node first because appendChild on the button itself
      // would push them out of order.
      const anchor = viewMoreBtn.nextSibling;
      for (const c of hiddenParents) {
        const el = await renderComment(c, postId, false, null, videoId, repliesByParent);
        section.insertBefore(el, anchor);
      }
      viewMoreBtn.remove();
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

async function renderComment(comment, postId, isReply = false, topLevelId = null, videoId = null, repliesByParent = null) {
  // Auto-detect video comments by inspecting the row
  if (!videoId && comment.video_id) videoId = comment.video_id;
  const div = document.createElement('div');
  div.className = isReply ? 'reply-item' : 'comment-item';
  const profile = comment.profiles || {};
  const name = profile.username || 'Unknown';
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}"/>` : initials(name);
  const replyTargetId = isReply ? topLevelId : comment.id;
  const replyToName = isReply ? name : null;

  div.innerHTML = `
    <div class="avatar sm">${avatarHTML}</div>
    <div class="comment-body">
      <div class="comment-meta">
        <span class="comment-author">${escHTML(name)}${renderRoleSeal(profile)}</span>
        <span class="comment-time">${timeAgo(comment.created_at)}</span>
        ${profile.is_guest ? '<span class="post-guest">Guest</span>' : ''}
      </div>
      ${comment.body ? `<div class="comment-bubble">${linkify(comment.body)}</div>` : ''}
      ${comment.body ? renderLinkPreview(comment.body) : ''}
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
                <span class="r-emoji">${r.emoji}</span>
                <span class="r-label">${r.label}</span>
              </button>
            `).join('')}
          </div>
        </div>
        <button class="comment-action-btn reply-btn" data-commentid="${replyTargetId}" data-postid="${postId || ''}" data-videoid="${videoId || ''}" data-replyto="${escHTML(replyToName || '')}">Reply</button>
        ${currentUser && currentUser.id === comment.user_id ? `<button class="comment-action-btn" onclick="deleteComment('${comment.id}','${postId || ''}','${videoId || ''}')">Delete</button>` : ''}
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

async function submitComment(postId, parentId, textarea, previewId, videoId = null) {
  const body = textarea.value.trim();
  const file = previewId ? pendingCommentImages[previewId] : null;
  if (!body && !file) return;
  if (!currentUser) return toast('Sign in to comment', 'error');
  let imageUrl = null;
  if (file) {
    textarea.disabled = true;
    imageUrl = await uploadImage(file);
    textarea.disabled = false;
    if (!imageUrl) return;
  }
  const insertRow = {
    user_id: currentUser.id,
    parent_id: parentId || null,
    body: body || '',
    image_url: imageUrl,
  };
  if (videoId) insertRow.video_id = videoId;
  else insertRow.post_id = postId;
  const { error } = await supabase.from('comments').insert(insertRow);
  if (error) { toast(error.message, 'error'); return; }
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
  const ok = await confirmDialog({
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
  wrap.innerHTML = `
    <div style="display:flex;gap:0.5rem;align-items:flex-start;width:100%">
      <div class="avatar sm">${currentProfile?.avatar_url ? `<img src="${currentProfile.avatar_url}"/>` : initials(currentProfile?.username || 'G')}</div>
      <textarea class="comment-input" placeholder="${placeholder}" rows="1"></textarea>
      <button class="btn-send">Reply</button>
    </div>
    <div id="${previewId}" style="margin-left:40px"></div>
    <div style="margin-left:40px;margin-top:-4px">
      <label class="image-upload-btn" style="padding:4px 8px;font-size:0.72rem">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        Add photo
        <input type="file" accept="image/*" class="rimg-input"/>
      </label>
    </div>
  `;
  const ta = wrap.querySelector('textarea');
  if (replyToName) ta.value = `@${replyToName} `;
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(postId, commentId, ta, previewId, videoId); }});
  wrap.querySelector('.btn-send').addEventListener('click', () => submitComment(postId, commentId, ta, previewId, videoId));
  wrap.querySelector('.rimg-input').addEventListener('change', (e) => handleCommentImageSelect(e.target, previewId));
  container.appendChild(wrap);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

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
    const section = document.getElementById(`comments-${postId}`);
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

// ── Repost modal ──
let repostTargetId = null;
window.repostPost = (postId) => {
  if (!currentUser) return toast('Sign in to repost', 'error');
  const post = posts.find(p => p.id === postId);
  if (!post) return;
  repostTargetId = postId;
  const profile = post.profiles || {};
  const name = profile.username || 'Unknown';
  const avatarHTML = profile.avatar_url ? `<img src="${profile.avatar_url}"/>` : initials(name);
  document.getElementById('repostPreview').innerHTML = `
    <div class="post-header">
      <div class="avatar">${avatarHTML}</div>
      <div><span class="post-author">${escHTML(name)}${renderRoleSeal(profile)}</span><div class="post-time">${timeAgo(post.created_at)}</div></div>
    </div>
    ${post.body ? `<div class="post-body collapsible-body" data-post-id="${post.id || post.$id || ''}">${linkify(post.body)}</div>` : ''}
    ${post.body ? renderLinkPreview(post.body) : ''}
    ${post.image_url ? `<div style="border-radius:8px;overflow:hidden;margin-top:0.5rem"><img src="${post.image_url}"/></div>` : ''}
  `;
  document.getElementById('repostCaption').value = '';
  document.getElementById('repostModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('repostCaption').focus(), 100);
};
function closeRepostModal() {
  document.getElementById('repostModal').classList.remove('open');
  document.body.style.overflow = '';
  repostTargetId = null;
}
document.getElementById('repostClose').addEventListener('click', closeRepostModal);
document.getElementById('repostCancel').addEventListener('click', closeRepostModal);
document.getElementById('repostModal').addEventListener('click', (e) => { if (e.target.id === 'repostModal') closeRepostModal(); });
document.getElementById('repostSubmit').addEventListener('click', async () => {
  if (!repostTargetId) return;
  if (!currentUser?.id) { toast('Sign in to repost', 'error'); return; }
  const caption = document.getElementById('repostCaption').value.trim();
  const btn = document.getElementById('repostSubmit');
  btn.disabled = true; btn.textContent = 'Posting...';
  // Route through submit_post RPC so the path matches mobile + survives
  // intermittent auth.uid() nulls (e.g., session expired but currentUser
  // still cached). The RPC validates the actor parameter against the
  // profiles table internally — same security guarantee, fewer auth
  // race conditions. The earlier direct insert failed under the same
  // RLS check that bites mobile.
  const { data, error } = await supabase.rpc('submit_post', {
    p_actor_id: currentUser.id,
    p_body: caption || null,
    p_image_url: null,
    p_video_id: null,
    p_book_id: null,
    p_reposted_from: repostTargetId,
    p_legacy_appwrite_id: null,
  });
  btn.disabled = false; btn.textContent = 'Repost';
  if (error) { toast(error.message, 'error'); return; }
  if (!data?.ok) { toast(data?.error || 'Repost failed', 'error'); return; }
  closeRepostModal();
  toast('Reposted!', 'success');
  loadFeed();
});

// ── Share menu ──
window.toggleShareMenu = (e, postId) => {
  e.stopPropagation();
  document.querySelectorAll('.share-menu.visible').forEach(m => { if (m.id !== `sharemenu-${postId}`) m.classList.remove('visible'); });
  document.getElementById(`sharemenu-${postId}`).classList.toggle('visible');
};
window.shareTo = (platform, postId) => {
  const url = `${window.location.origin}?post=${postId}`;
  const text = 'Check out this post on Selebox';
  const urls = {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`
  };
  if (platform === 'copy') navigator.clipboard.writeText(url).then(() => toast('Link copied!', 'success'));
  else if (urls[platform]) window.open(urls[platform], '_blank');
  document.getElementById(`sharemenu-${postId}`).classList.remove('visible');
};

// ── Realtime ──
// Debounced + scoped feed refresh. The old version reloaded the WHOLE feed on
// every INSERT or DELETE platform-wide — which on a busy site meant constant
// re-renders, broken scroll position, and DB hammering. Now:
//   • DELETEs are filtered to posts the viewer is actually showing.
//   • INSERTs only refresh if they're from someone the viewer follows
//     (Following tab) or themselves (so their own new post appears).
//   • Both go through a debounce so a burst of changes coalesces into one reload.
//   • Reload only fires when the home feed is the active page.
//
// The `_realtimeRefreshTimer` itself is declared up top with the other feed
// state so loadFeed can cancel it cleanly.
function _scheduleRealtimeFeedRefresh() {
  if (_realtimeRefreshTimer) return; // already pending
  _realtimeRefreshTimer = setTimeout(() => {
    _realtimeRefreshTimer = null;
    const feedVisible = feedEl && feedEl.style.display !== 'none' && !document.hidden;
    if (feedVisible && currentUser?.id) loadFeed();
  }, 800);
}

supabase.channel('public-feed')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, (payload) => {
    const newPost = payload?.new;
    if (!newPost || !currentUser?.id) return;
    // Always refresh on the viewer's own posts
    if (newPost.user_id === currentUser.id) return _scheduleRealtimeFeedRefresh();
    // For Following tab, only refresh if the author is one the viewer follows
    if (_feedMode === 'following') {
      if (_cachedFollowIds && _cachedFollowIds.includes(newPost.user_id)) {
        _scheduleRealtimeFeedRefresh();
      }
      return;
    }
    // For You / Discover — refresh, but the debounce prevents storms
    _scheduleRealtimeFeedRefresh();
  })
  .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, (payload) => {
    const deletedId = payload?.old?.id;
    if (!deletedId) return;
    // Only react if the deleted post is currently rendered
    if (Array.isArray(posts) && posts.some(p => p.id === deletedId)) {
      _scheduleRealtimeFeedRefresh();
    }
  })
  .subscribe();

// ── Profile page ──
const profilePage = document.getElementById('profilePage');
const feedEl = document.getElementById('feed');
const storiesEl = document.getElementById('storiesRow');
const composeEl = document.querySelector('.compose');
let viewingProfileId = null;

function showFeed() {
  hideAllMainPages();
  feedEl.style.display = '';
  // storiesEl intentionally untouched — inline display:none in HTML keeps it hidden.
  // To bring stories back, remove `style="display:none"` from #storiesRow in index.html.
  composeEl.style.display = '';
  // Restore feed mode tabs (For You / Following / Discover) — Home only
  const feedTabs = document.getElementById('feedTabs');
  if (feedTabs) feedTabs.style.display = '';
  // Restore the feed sentinel only when there's actually more to load and posts already rendered
  const feedSentinel = document.getElementById('feedSentinel');
  if (feedSentinel && _hasMoreFeedPosts && feedEl.querySelector('.post-card')) {
    feedSentinel.style.display = 'block';
  }
  document.body.classList.remove('on-videos');
  viewingProfileId = null;
  stopVideoPlayer();
  if (window.location.hash) history.pushState(null, '', window.location.pathname);

  // Reload feed if it's empty or stuck
  if (!feedEl.querySelector('.post-card') || feedEl.querySelector('.loading')) {
    loadFeed();
  }
}

function showProfileView() {
  hideAllMainPages();   // also hides feedSentinel (and any future sibling overlays)
  profilePage.style.display = 'block';
  document.body.classList.remove('on-videos');
  stopVideoPlayer();
}

async function openProfile(userId) {
  showProfileView();
  viewingProfileId = userId;
  // Set URL hash so refresh keeps user on profile
  if (window.location.hash !== `#profile/${userId}`) {
    history.pushState(null, '', `#profile/${userId}`);
  }

  // Scroll to top — the previous page's scroll position lingers otherwise.
  scrollToTop();

  // Close any modals/menus from a previous profile (rapid-nav safety)
  closeAllModals('.modal-backdrop[data-modal="follow-list"], .modal-backdrop[data-modal="share-profile"], .modal-backdrop[data-modal="report-user"]');
  closeProfileActionMenu?.();
  closePostActionMenu?.();

  // ── Paint skeleton instantly so the page never feels frozen ──
  paintProfileSkeleton();

  const isOwn = !!(currentUser && currentUser.id === userId);

  // ── Fire ALL queries in parallel (was sequential — now ~5x faster) ──
  // Mutuals RPC is included here so it doesn't add a sequential round-trip later.
  // Video/book counts apply the SAME filters as loadProfileVideos/Books for
  // non-owners — otherwise the tab pill ("Videos · 7") disagrees with what
  // the user actually sees in the tab ("No videos yet").
  const profileP   = fetchProfileWithRetry(userId);
  const followersP = supabase.from('follows').select('*', { count: 'exact', head: true }).eq('following_id', userId);
  const followingP = supabase.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId);
  const postsP     = supabase.from('posts').select('*', { count: 'exact', head: true }).eq('user_id', userId);

  let videosQ = supabase.from('videos').select('*', { count: 'exact', head: true }).eq('uploader_id', userId);
  if (!isOwn) videosQ = videosQ.eq('status', 'ready');
  const videosP = videosQ;

  let booksQ = supabase.from('books').select('*', { count: 'exact', head: true }).eq('author_id', userId);
  if (!isOwn) booksQ = booksQ.eq('is_public', true).in('status', ['ongoing', 'completed']);
  const booksP = booksQ;

  const badgesP    = supabase.from('user_badges').select('badge').eq('user_id', userId);
  const followP    = (!isOwn && currentUser)
    ? supabase.from('follows').select('follower_id').eq('follower_id', currentUser.id).eq('following_id', userId).maybeSingle()
    : Promise.resolve({ data: null });
  const mutualsP   = (!isOwn && currentUser)
    ? supabase.rpc('get_mutual_followers', { p_target_id: userId, p_viewer_id: currentUser.id, p_limit: 6 })
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
  document.getElementById('profileName').innerHTML = `${escHTML(profile.username)}${renderRoleSeal(profile, 20)}`;
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
      messageBtn.onclick = () => showMessages(userId);
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
    const { data } = await supabase.from('profiles').select(PROFILE_DISPLAY_COLS).eq('id', userId).single();
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

// Render Member/Guest pill + Creator/Writer/Pioneer/etc. earned badges
function renderProfileBadges(profile, badges) {
  clearProfileSkeleton();

  const baseBadge = document.getElementById('profileBadge');
  baseBadge.textContent     = profile.is_guest ? 'Guest' : 'Member';
  baseBadge.className       = 'profile-badge' + (profile.is_guest ? ' guest' : '');
  baseBadge.style.visibility = ''; // un-hide after skeleton

  // Earned badges live in a sibling container so they sit inline with username
  let extra = document.getElementById('profileBadgesExtra');
  if (!extra) {
    extra = document.createElement('span');
    extra.id = 'profileBadgesExtra';
    extra.className = 'profile-badges-extra';
    baseBadge.insertAdjacentElement('afterend', extra);
  }
  extra.innerHTML = '';

  const META = {
    creator:  { label: 'Creator',  icon: '🎬', cls: 'badge-creator',  title: 'Creator — earned by sharing original videos' },
    writer:   { label: 'Writer',   icon: '✍️', cls: 'badge-writer',   title: 'Writer — earned by publishing books on Selebox' },
    pioneer:  { label: 'Pioneer',  icon: '⭐', cls: 'badge-pioneer',  title: 'Pioneer — early Selebox community member' },
    verified: { label: 'Verified', icon: '✓',  cls: 'badge-verified', title: 'Verified account' },
    staff:    { label: 'Staff',    icon: '🛡', cls: 'badge-staff',    title: 'Selebox team member' },
  };

  // Stable display order
  const order = ['staff','verified','pioneer','creator','writer'];
  order.forEach(key => {
    if (!badges.includes(key)) return;
    const m = META[key];
    const el = document.createElement('span');
    el.className = `earned-badge ${m.cls}`;
    el.title = m.title;
    el.innerHTML = `<span class="earned-badge-icon">${m.icon}</span><span>${m.label}</span>`;
    extra.appendChild(el);
  });
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
  if (isOwn || !currentUser || !data || !data.length) {
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
  if (!currentUser) { toast('Please sign in', 'error'); return; }
  // mode: 'followers' (people who follow userId) | 'following' (people userId follows)

  closeAllModals('.modal-backdrop[data-modal="follow-list"]');

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
    supabase.from('follows').select('following_id').eq('follower_id', currentUser.id).in('following_id', ids),
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
      ${p.id === currentUser.id ? '<span class="follow-list-you">You</span>' :
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
        ({ error } = await supabase.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', uid));
      } else {
        ({ error } = await supabase.from('follows').insert({ follower_id: currentUser.id, following_id: uid }));
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
  wrap.innerHTML = '<div class="loading">Loading posts...</div>';
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
  if (!posts.length) {
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
  const hasAnyPinned = posts.some(p => p.pinned_at);
  posts.forEach(p => {
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
    const el = renderPost(p);
    wrap.appendChild(el);
    // Lazy-load reactions/comments for these too
    if (_feedPostObserver) _feedPostObserver.observe(el);
    el.querySelectorAll('.post-video').forEach(v => _feedVideoObserver?.observe(v));
  });
  // Apply Facebook-style collapsing to long post bodies
  setupCollapsibleBodies(wrap);
  // Fall back: if no observers (first time), load eagerly
  if (!_feedPostObserver) {
    wrap.querySelectorAll('.post-card').forEach(c => triggerPostLazyLoad(c));
    wrap.querySelectorAll('.post-video').forEach(v => attachHlsToPostVideo(v));
  }
}

// ── Profile: Videos tab ──
async function loadProfileVideos(userId) {
  const wrap = document.getElementById('profileVideos');
  if (!wrap) return;
  if (wrap.dataset.loadedFor === userId) return;       // already loaded for this user
  wrap.innerHTML = '<div class="loading">Loading videos...</div>';

  const isOwn = currentUser && currentUser.id === userId;

  // Supabase videos uploaded by this user
  let q = supabase
    .from('videos')
    .select(`id, title, description, thumbnail_url, video_url, views, likes, duration, created_at, status, tags, category, uploader_id, is_locked, is_monetized, unlock_cost_coins, unlock_cost_stars, profiles!videos_uploader_id_fkey ( id, username, avatar_url )`)
    .eq('uploader_id', userId)
    .order('created_at', { ascending: false });
  // Non-owners only see ready videos
  if (!isOwn) q = q.eq('status', 'ready');

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
    // Adapt to the existing renderVideoCard shape (mirrors fetchSupabaseVideos)
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
    const card = renderVideoCard(formatted, uploader);
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

  const isOwn = currentUser && currentUser.id === userId;

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
    const card = renderBookCard(formatted);
    card.style.animationDelay = `${(i * 0.025).toFixed(3)}s`;
    grid.appendChild(card);
  });
  wrap.dataset.loadedFor = userId;
}

async function toggleFollow(userId, currentlyFollowing) {
  // Earlier draft fired the supabase call without checking the result, so
  // RLS rejections / dupe-key errors silently produced "nothing happens"
  // even though the toast claimed success. Capture + surface the error.
  if (!currentUser?.id) {
    toast('Sign in first', 'error');
    return;
  }
  if (userId === currentUser.id) {
    toast("You can't follow yourself", 'error');
    return;
  }
  try {
    if (currentlyFollowing) {
      const { error } = await supabase.from('follows')
        .delete()
        .eq('follower_id', currentUser.id)
        .eq('following_id', userId);
      if (error) throw error;
      toast('Unfollowed', 'success');
    } else {
      const { error } = await supabase.from('follows')
        .insert({ follower_id: currentUser.id, following_id: userId });
      // 23505 = unique_violation. Treat as already-following → no-op success.
      if (error && error.code !== '23505') throw error;
      toast('Following!', 'success');
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
        .eq('id', currentUser.id)
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
  const { data: updated } = await supabase.from('profiles').select(PROFILE_DISPLAY_COLS).eq('id', currentUser.id).single();
  if (updated) currentProfile = updated;   // keep stale on fetch fail rather than nulling
  updateTopbarUser();
  openProfile(currentUser.id);
});

// ── Image cropper ──
let cropperInstance = null;
let cropField = null; // 'avatar_url' or 'banner_url'

// onSave receives a File of the cropped JPEG. Caller decides storage + DB update.
let _cropOnSave = null;

function openCropModal(file, optsOrAspect, fieldLegacy, titleLegacy) {
  let aspectRatio, title, onSave;
  if (typeof optsOrAspect === 'object' && optsOrAspect !== null) {
    // New-style: openCropModal(file, { aspectRatio, title, onSave })
    aspectRatio = optsOrAspect.aspectRatio;
    title       = optsOrAspect.title || 'Crop image';
    onSave      = optsOrAspect.onSave || null;
    cropField   = null;
  } else {
    // Legacy: openCropModal(file, aspectRatio, fieldName, title) — used by
    // avatar / banner. Falls through to the profiles.{field} update path.
    aspectRatio = optsOrAspect;
    title       = titleLegacy || 'Crop image';
    cropField   = fieldLegacy;
    onSave      = null;
  }
  _cropOnSave = onSave;
  document.getElementById('cropTitle').textContent = title;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = document.getElementById('cropImage');
    img.src = ev.target.result;
    document.getElementById('cropModal').classList.add('open');
    document.body.style.overflow = 'hidden';

    setTimeout(() => {
      if (cropperInstance) cropperInstance.destroy();
      cropperInstance = new Cropper(img, {
        aspectRatio: aspectRatio,
        viewMode: 1,
        autoCropArea: 1,
        background: false,
        movable: true,
        zoomable: true,
        scalable: false,
        rotatable: true
      });
    }, 150);
  };
  reader.readAsDataURL(file);
}

function closeCropModal() {
  document.getElementById('cropModal').classList.remove('open');
  document.body.style.overflow = '';
  if (cropperInstance) { cropperInstance.destroy(); cropperInstance = null; }
}

document.getElementById('cropClose').addEventListener('click', closeCropModal);
document.getElementById('cropCancel').addEventListener('click', closeCropModal);

document.getElementById('cropSave').addEventListener('click', async () => {
  if (!cropperInstance) return;
  const btn = document.getElementById('cropSave');
  btn.disabled = true; btn.textContent = 'Saving...';

  const canvas = cropperInstance.getCroppedCanvas({
    maxWidth: 1600, maxHeight: 1600,
    imageSmoothingQuality: 'high'
  });

  canvas.toBlob(async (blob) => {
    const file = new File([blob], `crop-${Date.now()}.jpg`, { type: 'image/jpeg' });

    // New callback path — used by book covers, video thumbs, etc.
    if (typeof _cropOnSave === 'function') {
      try {
        await _cropOnSave(file);
      } catch (err) {
        toast('Crop save failed: ' + (err?.message || err), 'error');
      }
      btn.disabled = false; btn.textContent = 'Save';
      closeCropModal();
      return;
    }

    // Legacy path: profiles.{cropField}
    const url = await uploadImage(file);
    if (!url) { btn.disabled = false; btn.textContent = 'Save'; return; }
    await supabase.from('profiles').update({ [cropField]: url }).eq('id', currentUser.id);
    if (cropField === 'avatar_url') {
      currentProfile.avatar_url = url;
      updateTopbarUser();
      toast('Avatar updated!', 'success');
    } else {
      toast('Cover updated!', 'success');
    }
    btn.disabled = false; btn.textContent = 'Save';
    closeCropModal();
    openProfile(currentUser.id);
  }, 'image/jpeg', 0.92);
});

// Avatar upload
document.getElementById('editAvatarBtn').addEventListener('click', () => document.getElementById('avatarInput').click());
document.getElementById('avatarInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  openCropModal(file, 1, 'avatar_url', 'Crop your avatar');
  e.target.value = '';
});

// Banner upload
document.getElementById('editBannerBtn').addEventListener('click', () => document.getElementById('bannerInput').click());
document.getElementById('bannerInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  openCropModal(file, 3, 'banner_url', 'Crop your cover photo');
  e.target.value = '';
});
// Open own profile from sidebar
async function openMyProfile() {
  if (!currentUser) {
    toast('Loading your profile...', '');
    return;
  }
  // Make sure profile is loaded before opening
  if (!currentProfile) {
    const { data: profile, error } = await supabase.from('profiles').select(PROFILE_DISPLAY_COLS).eq('id', currentUser.id).single();
    if (error) { toast('Could not load your profile', 'error'); return; }
    currentProfile = profile || null;
    if (!currentProfile) { toast('Profile not found', 'error'); return; }
  }
  openProfile(currentUser.id);
}
document.getElementById('btnProfile').addEventListener('click', () => {
  setSidebarActive('btnProfile');
  openMyProfile();
});
document.getElementById('topbarAvatar').addEventListener('click', () => {
  setSidebarActive('btnProfile');
  openMyProfile();
});

// ── Sidebar active state syncing ──
function setSidebarActive(buttonId) {
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(buttonId);
  if (btn) btn.classList.add('active');
}

// Wire Home button → goes to feed + sets active
document.getElementById('btnHome')?.addEventListener('click', () => {
  setSidebarActive('btnHome');
  showFeed();
});

// Logo click → home + scroll to top (whether already on feed or elsewhere)
document.getElementById('topbarLogoBtn')?.addEventListener('click', () => {
  setSidebarActive('btnHome');
  showFeed();
  scrollToTop();
});

// Handle browser back/forward
window.addEventListener('popstate', () => {
  const hash = window.location.hash;
  if (hash.startsWith('#profile/')) {
    const userId = hash.replace('#profile/', '');
    openProfile(userId);
  } else {
    showFeed();
    loadFeed();
  }
});

// ── Smart context-aware search ──
const searchInput = document.getElementById('searchInput');
const searchResultsEl = document.getElementById('searchResults');
const topbarSearchClear = document.getElementById('topbarSearchClear');
let searchDebounce = null;

// ── Recent searches (web parity with mobile lib/recent-searches.js) ──
// Local-only history of recent search queries. Capped at 10 entries.
// Persists in localStorage across sessions; wiped only when the user
// taps Clear all in the dropdown. Per-user keying so signing in/out
// doesn't show another user's history.
const RECENT_SEARCHES_LIMIT = 10;
const recentSearchesKey = () => {
  const uid = currentUser?.id || 'anon';
  return `selebox.recentSearches.${uid}`;
};
function getRecentSearches() {
  try {
    const raw = localStorage.getItem(recentSearchesKey());
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((q) => typeof q === 'string' && q.trim()) : [];
  } catch (_) {
    return [];
  }
}
function addRecentSearch(q) {
  const trimmed = (q || '').trim();
  if (!trimmed) return;
  const existing = getRecentSearches();
  // Move-to-front semantics: drop any existing match (case-insensitive)
  // then prepend, so the same term searched twice doesn't duplicate.
  const filtered = existing.filter((x) => x.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...filtered].slice(0, RECENT_SEARCHES_LIMIT);
  try { localStorage.setItem(recentSearchesKey(), JSON.stringify(next)); } catch (_) { /* swallow */ }
}
function removeRecentSearch(q) {
  const trimmed = (q || '').trim();
  if (!trimmed) return;
  const existing = getRecentSearches();
  const next = existing.filter((x) => x.toLowerCase() !== trimmed.toLowerCase());
  try { localStorage.setItem(recentSearchesKey(), JSON.stringify(next)); } catch (_) { /* swallow */ }
}
function clearRecentSearches() {
  try { localStorage.removeItem(recentSearchesKey()); } catch (_) { /* swallow */ }
}

// Render the recent-searches dropdown when the input is focused with
// empty value. Tapping a recent re-runs the search; tapping the X
// removes that entry.
function renderRecentSearchesPanel() {
  const recents = getRecentSearches();
  if (!recents.length) {
    searchResultsEl.classList.remove('open');
    return;
  }
  const html = `
    <div class="search-result-section" style="display:flex;align-items:center;justify-content:space-between">
      <span>Recent searches</span>
      <button class="search-recent-clear" type="button" style="font-size:0.75rem;background:none;border:none;color:var(--text3);cursor:pointer">Clear all</button>
    </div>
    ${recents.map((q) => `
      <div class="search-result-item search-recent-item" data-recent="${escHTML(q)}">
        <div class="search-result-info" style="display:flex;align-items:center;gap:8px;flex:1">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text3);flex-shrink:0">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <div class="search-result-title" style="flex:1">${escHTML(q)}</div>
        </div>
        <button class="search-recent-remove" data-remove="${escHTML(q)}" type="button" aria-label="Remove" style="background:none;border:none;color:var(--text3);cursor:pointer;padding:4px">×</button>
      </div>
    `).join('')}
  `;
  searchResultsEl.innerHTML = html;
  searchResultsEl.classList.add('open');

  searchResultsEl.querySelector('.search-recent-clear')?.addEventListener('click', () => {
    clearRecentSearches();
    searchResultsEl.classList.remove('open');
  });
  searchResultsEl.querySelectorAll('.search-recent-item').forEach((el) => {
    el.addEventListener('click', (ev) => {
      // X button propagates here too — ignore if the click target is
      // the remove control, since its own handler runs first.
      if (ev.target.closest('.search-recent-remove')) return;
      const q = el.dataset.recent;
      if (!q) return;
      searchInput.value = q;
      if (topbarSearchClear) topbarSearchClear.style.display = 'flex';
      runFeedSearch(q);
    });
  });
  searchResultsEl.querySelectorAll('.search-recent-remove').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeRecentSearch(btn.dataset.remove);
      renderRecentSearchesPanel();
    });
  });
}

// Search context decides which renderer the topbar search input feeds.
//   'videos' → renders into the videos page grid
//   'books'  → renders into the books page See-All view
//   default  → home-feed dropdown (People / Videos / Books / Posts)
//
// Important: book DETAIL pages (#book/<uuid>) used to be 'books' too, which
// meant typing in search tried to render into a hidden bookPage and the
// search results vanished into the void. We now route detail pages to the
// feed dropdown, so users can find another book without leaving the reader.
function getSearchContext() {
  const hash = window.location.hash;
  if (hash === '#videos' || hash.startsWith('#video/')) return 'videos';
  if (hash === '#book') return 'books'; // listing only — detail pages use the feed dropdown
  return 'feed';
}

let _lastSearchContext = null;
function updateSearchPlaceholder() {
  const ctx = getSearchContext();
  if (ctx === 'videos')      searchInput.placeholder = 'Search videos · creator · tags · category…';
  else if (ctx === 'books')  searchInput.placeholder = 'Search books · author · tags · genre…';
  else                       searchInput.placeholder = 'Search posts and people…';

  // Reset any active query when moving between contexts (videos ↔ books ↔ feed)
  if (_lastSearchContext && _lastSearchContext !== ctx) {
    searchInput.value = '';
    if (topbarSearchClear) topbarSearchClear.style.display = 'none';
    activeSearchQuery = '';
    activeBookSearchQuery = '';
    searchResultsEl.classList.remove('open');
  }
  _lastSearchContext = ctx;
}

searchInput.addEventListener('input', (e) => {
  const value = e.target.value;
  if (topbarSearchClear) topbarSearchClear.style.display = value ? 'flex' : 'none';

  const ctx = getSearchContext();

  if (ctx === 'videos') {
    activeSearchQuery = value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(), 200);
    searchResultsEl.classList.remove('open');
    return;
  }

  if (ctx === 'books') {
    activeBookSearchQuery = value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runBookSearch(), 200);
    searchResultsEl.classList.remove('open');
    return;
  }

  // Feed (default): show dropdown of matching people + posts
  clearTimeout(searchDebounce);
  if (!value.trim()) {
    // Empty value while focused → show recent-searches dropdown so the
    // user can re-run a previous query without retyping.
    if (document.activeElement === searchInput) {
      renderRecentSearchesPanel();
    } else {
      searchResultsEl.classList.remove('open');
    }
    return;
  }
  searchDebounce = setTimeout(() => runFeedSearch(value), 250);
});

// On focus with empty input, surface recent searches.
searchInput.addEventListener('focus', () => {
  if (!searchInput.value.trim() && getSearchContext() === 'feed') {
    renderRecentSearchesPanel();
  }
});

// On Enter, persist the term as a recent search. Same trigger on
// clicking a result handled below.
searchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = searchInput.value.trim();
  if (v) addRecentSearch(v);
});

if (topbarSearchClear) {
  topbarSearchClear.addEventListener('click', () => {
    searchInput.value = '';
    topbarSearchClear.style.display = 'none';
    searchResultsEl.classList.remove('open');
    const ctx = getSearchContext();
    if (ctx === 'videos') {
      activeSearchQuery = '';
      runSearch();
    } else if (ctx === 'books') {
      activeBookSearchQuery = '';
      // Close the See-All search view and return to the active tab panel.
      // (No "restore the cached grid" step — the v2 books page is tabbed.)
      const seeAll = document.getElementById('bookSeeAllView');
      if (seeAll) seeAll.style.display = 'none';
      document.querySelectorAll('.book-tab-panel').forEach(p => {
        const isActive = p.dataset.bookPanel === _activeBookTab;
        p.style.display = isActive ? '' : 'none';
        p.classList.toggle('active', isActive);
      });
    }
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#topbarSearch') && !e.target.closest('.search-results')) {
    searchResultsEl.classList.remove('open');
  }
});

// Document-level delegation: clicking any profile avatar/name in the feed
// (or future cards) opens that user's profile.
document.addEventListener('click', (e) => {
  const link = e.target.closest('.profile-link');
  if (!link) return;
  const uid = link.dataset.userId;
  if (!uid) return;
  e.stopPropagation();
  e.preventDefault();
  openProfile(uid);
});

async function runFeedSearch(query) {
  const raw = (query || '').trim();
  if (!raw) { searchResultsEl.classList.remove('open'); return; }

  // Sanitize FIRST so commas / parens / quotes in the user's query don't
  // break the PostgREST .or() filter (the silent root cause behind
  // "search returns nothing" reports).
  const safeQ = sanitizeSearchQuery(raw);
  if (!safeQ) { searchResultsEl.classList.remove('open'); return; }
  const term = `%${escapeIlike(safeQ)}%`;

  searchResultsEl.classList.add('open');
  searchResultsEl.innerHTML = '<div style="padding:1rem;color:var(--text3)">Searching...</div>';

  // YouTube-style: a single search bar reaches People, Posts, Videos, AND Books.
  // Profiles overfetched (20) so substring matches like "Ligaya" pull users like
  // "LIGAYA_ba1f" too — explicit username ordering for predictability.
  const [profilesRes, postsRes, videosRes, booksRes] = await Promise.all([
    supabase.from('profiles')
      .select('id, username, avatar_url, bio, is_guest, is_banned, role')
      .ilike('username', term)
      .eq('is_banned', false)
      .order('username', { ascending: true })
      .limit(20),
    supabase.from('posts')
      .select('*, profiles!user_id(username, avatar_url, is_guest, is_banned, role)')
      .eq('is_hidden', false)
      .ilike('body', term)
      .order('created_at', { ascending: false })
      .limit(6),
    supabase.from('videos')
      .select('id, title, thumbnail_url, uploader_id, profiles!videos_uploader_id_fkey(username, avatar_url, is_banned, role)')
      .eq('status', 'ready').eq('is_hidden', false)
      .or(`title.ilike.${term},description.ilike.${term}`)
      .order('created_at', { ascending: false })
      .limit(5),
    supabase.from('books')
      .select('id, title, cover_url, author_id, profiles!books_author_id_fkey(username, avatar_url, is_banned, role)')
      .eq('is_public', true).eq('is_hidden', false).in('status', ['ongoing', 'completed'])
      .or(`title.ilike.${term},description.ilike.${term}`)
      .limit(5),
  ]);

  // Stale-query guard — user kept typing, abandon this run.
  if ((searchInput.value || '').trim() !== raw) return;

  const profiles = profilesRes?.data || [];
  const posts    = (postsRes?.data || []).filter(p => !p.profiles?.is_banned);
  const videos   = (videosRes?.data || []).filter(v => !v.profiles?.is_banned);
  const books    = (booksRes?.data || []).filter(b => !b.profiles?.is_banned);

  let html = '';
  if (profiles.length) {
    html += `<div class="search-result-section">People</div>`;
    profiles.forEach(p => {
      const avatar = p.avatar_url ? `<img src="${escHTML(p.avatar_url)}"/>` : initials(p.username);
      html += `
        <div class="search-result-item" data-type="profile" data-id="${p.id}">
          <div class="avatar">${avatar}</div>
          <div class="search-result-info">
            <div class="search-result-title">${escHTML(p.username)}${renderRoleSeal(p)}</div>
            <div class="search-result-meta">${p.is_guest ? 'Guest' : 'Member'}</div>
          </div>
        </div>`;
    });
  }
  if (videos.length) {
    html += `<div class="search-result-section">Videos</div>`;
    videos.forEach(v => {
      const thumb = v.thumbnail_url
        ? `<img src="${escHTML(v.thumbnail_url)}" alt="" loading="lazy"/>`
        : '';
      html += `
        <div class="search-result-item" data-type="video" data-id="${v.id}">
          <div class="search-result-thumb">${thumb}</div>
          <div class="search-result-info">
            <div class="search-result-title">${escHTML(v.title || 'Untitled')}</div>
            <div class="search-result-meta">by ${escHTML(v.profiles?.username || 'Unknown')}${renderRoleSeal(v.profiles)}</div>
          </div>
        </div>`;
    });
  }
  if (books.length) {
    html += `<div class="search-result-section">Books</div>`;
    books.forEach(b => {
      const cover = b.cover_url
        ? `<img src="${escHTML(b.cover_url)}" alt="" loading="lazy"/>`
        : `<span class="search-creator-initials">${escHTML((b.title || '?').charAt(0).toUpperCase())}</span>`;
      html += `
        <div class="search-result-item" data-type="book" data-id="${b.id}">
          <div class="search-result-thumb search-result-thumb-book">${cover}</div>
          <div class="search-result-info">
            <div class="search-result-title">${escHTML(b.title || 'Untitled')}</div>
            <div class="search-result-meta">by ${escHTML(b.profiles?.username || 'Unknown')}${renderRoleSeal(b.profiles)}</div>
          </div>
        </div>`;
    });
  }
  if (posts.length) {
    html += `<div class="search-result-section">Posts</div>`;
    posts.forEach(p => {
      const author = p.profiles || {};
      const avatar = author.avatar_url ? `<img src="${escHTML(author.avatar_url)}"/>` : initials(author.username || 'U');
      const snippet = (p.body || '').slice(0, 80);
      html += `
        <div class="search-result-item" data-type="post" data-id="${p.id}">
          <div class="avatar">${avatar}</div>
          <div class="search-result-info">
            <div class="search-result-title">${escHTML(snippet)}${p.body && p.body.length > 80 ? '...' : ''}</div>
            <div class="search-result-meta">by ${escHTML(author.username || 'Unknown')}${renderRoleSeal(author)}</div>
          </div>
        </div>`;
    });
  }
  if (!html) html = '<div style="padding:1rem;color:var(--text3);text-align:center">No results found</div>';

  searchResultsEl.innerHTML = html;

  searchResultsEl.querySelectorAll('.search-result-item').forEach(item => {
    item.onclick = () => {
      const type = item.dataset.type;
      const id = item.dataset.id;
      // Persist the term that produced this result. Successful clicks
      // (the user found what they wanted) are the strongest signal
      // for "remember this query."
      const termAtClick = (searchInput.value || '').trim();
      if (termAtClick) addRecentSearch(termAtClick);

      searchResultsEl.classList.remove('open');
      searchInput.value = '';
      if (topbarSearchClear) topbarSearchClear.style.display = 'none';

      if (type === 'profile')      openProfile(id);
      else if (type === 'post')    openPostFromSearch(id);
      else if (type === 'video')   { location.hash = `#video/sb_${id}`; }
      else if (type === 'book')    { location.hash = `#book/${id}`; }
    };
  });
}

// Open a focused post detail modal — works for ANY post, even old ones not
// in the loaded feed. Reuses renderPost so the post stays visually identical
// to the feed version (same actions, same comments, same look).
async function openPostFromSearch(postId) {
  const modal = document.getElementById('postDetailModal');
  const body  = document.getElementById('postDetailBody');
  if (!modal || !body) return;
  body.innerHTML = '<div class="loading">Loading post…</div>';
  modal.classList.add('open');
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  try {
    const { data: post, error } = await supabase
      .from('posts')
      .select(FEED_SELECT)
      .eq('id', postId)
      .maybeSingle();
    if (error) throw error;
    if (!post) {
      body.innerHTML = '<div class="empty"><h3>Post not found</h3><p>It may have been deleted or hidden.</p></div>';
      return;
    }
    if (shouldHidePost(post)) {
      body.innerHTML = '<div class="empty"><h3>Post unavailable</h3><p>You\'ve hidden this post or its author.</p></div>';
      return;
    }

    body.innerHTML = '';
    const card = renderPost(post);
    body.appendChild(card);
    // Activate "See more" collapsing for long bodies (same as feed)
    if (typeof setupCollapsibleBodies === 'function') setupCollapsibleBodies(body);
    // Lazy-load reactions/comments (same observer pattern as feed)
    if (typeof triggerPostLazyLoad === 'function') triggerPostLazyLoad(card);
    // Hook up post-video lazy attachment
    card.querySelectorAll('.post-video').forEach(v => {
      if (typeof attachHlsToPostVideo === 'function') attachHlsToPostVideo(v);
    });
  } catch (err) {
    body.innerHTML = `<div class="empty"><h3>Couldn't load post</h3><p>${escHTML(err.message || 'Network error')}</p></div>`;
  }
}

// Wire close handlers for the post detail modal
function _closePostDetailModal() {
  const m = document.getElementById('postDetailModal');
  if (!m) return;
  m.classList.remove('open');
  m.style.display = 'none';
  document.body.style.overflow = '';
  // Clear the body so the next open shows the loading state, not stale content
  const body = document.getElementById('postDetailBody');
  if (body) body.innerHTML = '<div class="loading">Loading post…</div>';
}
document.getElementById('postDetailClose')?.addEventListener('click', _closePostDetailModal);
document.getElementById('postDetailModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'postDetailModal') _closePostDetailModal();
});

window.addEventListener('hashchange', updateSearchPlaceholder);
updateSearchPlaceholder();

// ── Videos title click behavior ──
const videosTitle = document.querySelector('.videos-title');
if (videosTitle) {
  videosTitle.style.cursor = 'pointer';
  videosTitle.title = 'Click to scroll top • Double-click to refresh';

  let clickTimer = null;
  videosTitle.addEventListener('click', (e) => {
    if (clickTimer) {
      // Double click detected
      clearTimeout(clickTimer);
      clickTimer = null;
      // Refresh: clear cache and reload
      allVideosCache = [];
      allUploadersCache = {};
      activeSearchQuery = '';
      activeTagFilter = null;
      const searchInput = document.getElementById('searchInput');
      if (searchInput) searchInput.value = '';
      loadVideos();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast('Videos refreshed', 'success');
    } else {
      // Single click: wait to confirm it's not a double click
      clickTimer = setTimeout(() => {
        clickTimer = null;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }, 250);
    }
  });
}

// ════════════════════════════════════════
// VIDEO UPLOAD
// ════════════════════════════════════════

let pendingVideoFile = null;

// Open modal when "Video" button clicked
document.getElementById('btnOpenVideoUpload')?.addEventListener('click', () => {
  if (!currentUser) {
    toast('Please log in to upload videos', 'error');
    return;
  }
  document.getElementById('videoUploadModal').style.display = 'flex';
  resetVideoUploadModal();
});

// Videos page Upload button → opens same modal
document.getElementById('btnUploadVideo')?.addEventListener('click', () => {
  if (!currentUser) {
    toast('Please log in to upload videos', 'error');
    return;
  }
  document.getElementById('videoUploadModal').style.display = 'flex';
  resetVideoUploadModal();
});

// Close modal
document.getElementById('closeVideoUploadModal')?.addEventListener('click', closeVideoUploadModal);
document.getElementById('cancelVideoUpload')?.addEventListener('click', closeVideoUploadModal);

// ════════════════════════════════════════════════════════════════════════════
// VIDEO UPLOAD WIZARD — 4 phases (File → Details → Visibility → Upload)
// ════════════════════════════════════════════════════════════════════════════

let vuStep = 1;
const VU_STEP_TITLES = {
  1: { title: 'Upload video',         sub: 'Pick the file you want to share.' },
  2: { title: 'Tell us about it',     sub: 'A great title helps people find your video.' },
  3: { title: 'Visibility & schedule',sub: 'Choose when it goes public.' },
  4: { title: 'Uploading…',           sub: 'Stay on this screen until it finishes.' },
};

function vuGotoStep(n) {
  if (n < 1 || n > 4) return;
  vuStep = n;
  // Panels
  document.querySelectorAll('.vu-panel').forEach(p => {
    p.style.display = (Number(p.dataset.panel) === n) ? '' : 'none';
  });
  // Stepper highlights — past steps "done", current "active"
  document.querySelectorAll('.vu-step-pill').forEach(s => {
    const sn = Number(s.dataset.step);
    s.classList.toggle('active', sn === n);
    s.classList.toggle('done',   sn <  n);
  });
  document.querySelectorAll('.vu-step-line').forEach((l, i) => {
    l.classList.toggle('done', (i + 1) < n);
  });
  // Header
  const meta = VU_STEP_TITLES[n];
  document.getElementById('vuTitle').textContent = meta.title;
  document.getElementById('vuSubtitle').textContent = meta.sub;
  // Footer buttons
  vuRefreshFooter();
}

function vuRefreshFooter() {
  const back = document.getElementById('vuFooterBack');
  const next = document.getElementById('vuFooterNext');
  const cancel = document.getElementById('cancelVideoUpload');
  // Back: hidden on step 1; hidden during upload (step 4)
  back.style.display = (vuStep === 1 || vuStep === 4) ? 'none' : '';
  // Cancel: visible on steps 1-3, hidden during upload
  cancel.style.display = (vuStep === 4) ? 'none' : '';

  if (vuStep === 1) {
    next.textContent = 'Continue';
    next.disabled = !pendingVideoFile;
  } else if (vuStep === 2) {
    const title = document.getElementById('videoUploadTitle').value.trim();
    next.textContent = 'Continue';
    next.disabled = !title;
  } else if (vuStep === 3) {
    next.textContent = 'Upload';
    next.disabled = false;
  } else if (vuStep === 4) {
    // During upload, the "next" slot becomes a Done/Close (filled in after success)
    next.textContent = 'Uploading…';
    next.disabled = true;
  }
}

function closeVideoUploadModal() {
  document.getElementById('videoUploadModal').style.display = 'none';
  resetVideoUploadModal();
}

function resetVideoUploadModal() {
  pendingVideoFile = null;
  document.getElementById('videoUploadFile').value = '';
  document.getElementById('vuFileSummary').style.display = 'none';
  document.getElementById('vuFileName').textContent = '';
  document.getElementById('vuFileSize').textContent = '';
  document.getElementById('videoUploadTitle').value = '';
  document.getElementById('videoUploadDescription').value = '';
  document.getElementById('videoUploadTags').value = '';
  document.getElementById('titleCharCount').textContent = '0';
  document.getElementById('descCharCount').textContent = '0';
  document.getElementById('videoUploadFill').style.width = '0%';
  document.getElementById('videoUploadPercent').textContent = '0%';
  document.getElementById('videoUploadStatus').textContent = 'Preparing…';
  document.getElementById('vuUploadBytes').style.display = 'none';
  document.getElementById('vuUploadHeroTitle').textContent = 'Uploading your video';
  document.getElementById('vuUploadHeroSub').textContent = "Hang tight — we're sending it to our servers.";
  // Reset visibility radio
  document.querySelectorAll('input[name="vuVisibility"]').forEach(r => { r.checked = (r.value === 'now'); });
  document.querySelectorAll('.vu-radio').forEach(r => r.classList.toggle('active', r.dataset.vis === 'now'));
  document.getElementById('vuScheduleInput').style.display = 'none';
  document.getElementById('vuScheduleDatetime').value = '';
  vuGotoStep(1);
}

// ── Phase 1: File picker ─────────────────────────────────────────────────
function vuHandleFile(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024 * 1024) {
    toast('Video too large (max 2GB)', 'error');
    return;
  }
  pendingVideoFile = file;
  const preview = document.getElementById('videoUploadPreview');
  preview.src = URL.createObjectURL(file);
  document.getElementById('vuFileName').textContent = file.name;
  document.getElementById('vuFileSize').textContent = formatBytes(file.size);
  document.getElementById('vuFileSummary').style.display = '';
  // Auto-fill title with filename (no extension)
  const titleInput = document.getElementById('videoUploadTitle');
  titleInput.value = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
  document.getElementById('titleCharCount').textContent = titleInput.value.length;
  vuRefreshFooter();

  // Read the video's duration via the preview element so we can gate the
  // monetize toggle on step 3. <video> fires 'loadedmetadata' once .duration
  // is available. We snapshot the value into pendingVideoDurationSec.
  preview.addEventListener('loadedmetadata', () => {
    pendingVideoDurationSec = Number.isFinite(preview.duration) ? preview.duration : 0;
    syncVuMonetizeGate();
  }, { once: true });
}

// Pending file's duration (filled in by vuHandleFile via loadedmetadata)
let pendingVideoDurationSec = 0;

// Disable monetize toggle for videos shorter than the first unlock threshold.
function syncVuMonetizeGate() {
  const cb     = document.getElementById('vuMonetized');
  const card   = cb?.closest('.vu-card');
  if (!cb) return;
  const minSec = _walletConfigDefaults.video_initial_unlock_seconds || 180;
  const eligible = pendingVideoDurationSec >= minSec;
  cb.disabled = !eligible;
  if (!eligible) cb.checked = false;
  if (card) {
    card.classList.toggle('is-ineligible', !eligible);
    const sub = card.querySelector('.vu-card-sub');
    if (sub) {
      sub.innerHTML = eligible
        ? 'Free for the first 3 minutes. After that, viewers pay <strong>1 coin</strong> for permanent access, or <strong>1 star every 10 minutes</strong> they keep watching.'
        : `Video must be at least ${Math.floor(minSec/60)} minute${minSec/60 === 1 ? '' : 's'} long to monetize. This one is ${Math.floor(pendingVideoDurationSec/60)}m ${Math.floor(pendingVideoDurationSec%60)}s.`;
    }
  }
}
document.getElementById('videoUploadFile')?.addEventListener('change', (e) => {
  vuHandleFile(e.target.files[0]);
});
document.getElementById('vuReplaceFile')?.addEventListener('click', () => {
  document.getElementById('videoUploadFile').click();
});
// Drag & drop on the dropzone
const vuDropzone = document.getElementById('videoFilePicker');
if (vuDropzone) {
  ['dragover', 'dragenter'].forEach(ev => vuDropzone.addEventListener(ev, (e) => {
    e.preventDefault(); vuDropzone.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach(ev => vuDropzone.addEventListener(ev, (e) => {
    e.preventDefault(); vuDropzone.classList.remove('drag-over');
  }));
  vuDropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type.startsWith('video/')) vuHandleFile(f);
  });
}

// ── Phase 2: Details (live char counters) ────────────────────────────────
document.getElementById('videoUploadTitle')?.addEventListener('input', (e) => {
  document.getElementById('titleCharCount').textContent = e.target.value.length;
  if (vuStep === 2) vuRefreshFooter();
});
document.getElementById('videoUploadDescription')?.addEventListener('input', (e) => {
  document.getElementById('descCharCount').textContent = e.target.value.length;
});

// ── Phase 3: Visibility radios ───────────────────────────────────────────
document.querySelectorAll('input[name="vuVisibility"]').forEach(input => {
  input.addEventListener('change', () => {
    document.querySelectorAll('.vu-radio').forEach(r => r.classList.toggle('active', r.dataset.vis === input.value));
    document.getElementById('vuScheduleInput').style.display = (input.value === 'schedule') ? '' : 'none';
    if (input.value === 'schedule' && !document.getElementById('vuScheduleDatetime').value) {
      // Default to 1 hour from now (rounded to nearest 15 min)
      const d = new Date(Date.now() + 60 * 60 * 1000);
      d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
      const pad = n => String(n).padStart(2, '0');
      const localStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      document.getElementById('vuScheduleDatetime').value = localStr;
    }
  });
});

// ── Footer button wiring (Back / Continue / Upload) ──────────────────────
document.getElementById('vuFooterBack')?.addEventListener('click', () => {
  if (vuStep > 1 && vuStep < 4) vuGotoStep(vuStep - 1);
});
document.getElementById('vuFooterNext')?.addEventListener('click', async () => {
  if (vuStep === 1) {
    if (!pendingVideoFile) return;
    vuGotoStep(2);
  } else if (vuStep === 2) {
    const title = document.getElementById('videoUploadTitle').value.trim();
    if (!title) { toast('Please add a title', 'error'); return; }
    vuGotoStep(3);
  } else if (vuStep === 3) {
    vuGotoStep(4);
    await vuStartUpload();
  }
});

async function vuStartUpload() {
  if (!pendingVideoFile) return;
  const title       = document.getElementById('videoUploadTitle').value.trim();
  const description = document.getElementById('videoUploadDescription').value.trim();
  const tagsRaw     = document.getElementById('videoUploadTags').value.trim();
  const tags        = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
  // Category dropdown removed (May 2026) — superseded by tags. The
  // `category` column on `videos` is still present in the DB for
  // legacy data + future use; new uploads omit it (defaults / null).
  // Visibility
  const visibility = document.querySelector('input[name="vuVisibility"]:checked')?.value || 'now';
  let scheduledPublishAt = null;
  if (visibility === 'schedule') {
    const dtStr = document.getElementById('vuScheduleDatetime').value;
    if (dtStr) {
      const dt = new Date(dtStr);
      if (!isNaN(dt.getTime()) && dt.getTime() > Date.now()) {
        scheduledPublishAt = dt.toISOString();
      }
    }
  }

  const fill   = document.getElementById('videoUploadFill');
  const pctEl  = document.getElementById('videoUploadPercent');
  const status = document.getElementById('videoUploadStatus');
  const bytesWrap = document.getElementById('vuUploadBytes');
  const bytesSent = document.getElementById('vuBytesSent');
  const bytesTotal= document.getElementById('vuBytesTotal');
  const speedEl   = document.getElementById('vuUploadSpeed');
  const heroIcon  = document.getElementById('vuUploadIcon');
  const heroTitle = document.getElementById('vuUploadHeroTitle');
  const heroSub   = document.getElementById('vuUploadHeroSub');
  const next      = document.getElementById('vuFooterNext');

  bytesTotal.textContent = formatBytes(pendingVideoFile.size);
  bytesWrap.style.display = '';

  let lastBytes = 0;
  let lastTs = Date.now();

  try {
    status.textContent = 'Preparing upload…';
    const uploadInfo = await callEdgeFunction('bunny-upload', { title });

    status.textContent = 'Uploading video…';
    await uploadFileToBunny(pendingVideoFile, uploadInfo, (pct, loaded, total) => {
      fill.style.width = pct + '%';
      pctEl.textContent = pct + '%';
      bytesSent.textContent = formatBytes(loaded || 0);
      // Speed (rolling, sampled every 500ms)
      const now = Date.now();
      if (now - lastTs > 500) {
        const dBytes = (loaded || 0) - lastBytes;
        const dSec = (now - lastTs) / 1000;
        if (dSec > 0 && dBytes >= 0) {
          const speed = dBytes / dSec;
          speedEl.textContent = `· ${formatBytes(speed)}/s`;
        }
        lastBytes = loaded || 0;
        lastTs = now;
      }
    });

    status.textContent = 'Saving…';
    const isMonetized = document.getElementById('vuMonetized')?.checked || false;
    const { data: newVideo, error } = await supabase.from('videos').insert({
      bunny_video_id: uploadInfo.videoId,
      bunny_library_id: uploadInfo.libraryId,
      video_url: uploadInfo.videoUrl,
      thumbnail_url: uploadInfo.thumbnailUrl,
      title, description, tags,
      uploader_id: currentUser.id,
      status: 'processing',
      scheduled_publish_at: scheduledPublishAt,
      is_monetized: isMonetized,
    }).select().single();
    if (error) throw error;

    // Create the home-feed post but keep it hidden until the bunny webhook
    // flips video.status to 'ready' (trigger flips post.is_hidden then).
    const postBody = description || title;
    const { error: postError } = await supabase.from('posts').insert({
      user_id: currentUser.id,
      body: postBody,
      video_id: newVideo.id,
      is_hidden: true,
    });
    if (postError) console.error('Failed to create feed post:', postError);

    fill.style.width = '100%';
    pctEl.textContent = '100%';
    status.textContent = 'Upload complete';
    speedEl.textContent = '';

    // Switch hero to the "now processing" state (FB-style)
    heroIcon.outerHTML = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" id="vuUploadIcon"><polyline points="20 6 9 17 4 12"/></svg>`;
    heroTitle.textContent = scheduledPublishAt ? 'Scheduled — processing in the background' : 'Done — processing in the background';
    heroSub.textContent   = scheduledPublishAt
      ? `It'll go live on ${new Date(scheduledPublishAt).toLocaleString()} once processing finishes.`
      : 'Your video will appear publicly the moment Selebox finishes encoding it.';

    // Footer becomes "Done"
    next.disabled = false;
    next.textContent = 'Done';
    next.onclick = () => {
      closeVideoUploadModal();
      if (videosPage.style.display === 'block') { allVideosCache = []; loadVideos(); }
      if (feedEl.style.display !== 'none') window.loadFeed?.();
    };

    toast(scheduledPublishAt ? 'Scheduled — processing now' : 'Uploaded — processing now', 'success');
  } catch (err) {
    console.error('Upload failed:', err);
    status.textContent = 'Upload failed';
    speedEl.textContent = '';
    heroIcon.outerHTML = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" id="vuUploadIcon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    heroTitle.textContent = 'Upload failed';
    heroSub.textContent = err.message || 'Something went wrong. Try again.';
    next.disabled = false;
    next.textContent = 'Try again';
    next.onclick = () => { vuGotoStep(3); next.onclick = null; vuRefreshFooter(); };
    toast('Upload failed: ' + err.message, 'error');
  }
}

// Helper: Upload file to Bunny with progress
function uploadFileToBunny(file, info, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', info.uploadUrl);
    xhr.setRequestHeader('AccessKey', info.accessKey);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        onProgress(pct, e.loaded, e.total);
      }
    });
    
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error('Bunny upload failed: ' + xhr.status));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));
    
    xhr.send(file);
  });
}

initAuth();

// ── Watch history & smart recommendations ──
const WATCH_HISTORY_KEY = 'selebox_watch_history';

function getWatchHistory() {
  try {
    const raw = localStorage.getItem(WATCH_HISTORY_KEY);
    if (!raw) return [];
    const history = JSON.parse(raw);
    // Filter out entries older than 30 days
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    return history.filter(h => h.timestamp > cutoff);
  } catch { return []; }
}

function addToWatchHistory(video, uploader) {
  const history = getWatchHistory();
  // Remove if already exists (we'll add to top)
  const filtered = history.filter(h => h.id !== video.$id);
  filtered.unshift({
    id: video.$id,
    tags: video.tags || [],
    uploader: video.uploader,
    uploaderName: uploader?.username || '',
    timestamp: Date.now()
  });
  // Keep only last 50
  const trimmed = filtered.slice(0, 50);
  try { localStorage.setItem(WATCH_HISTORY_KEY, JSON.stringify(trimmed)); } catch {}
}

function getInterestProfile() {
  const history = getWatchHistory();
  const recent = history.slice(0, 5); // last 5 videos

  // Weight tags: most recent = highest weight
  const tagWeights = {};
  const weights = [0.4, 0.25, 0.15, 0.1, 0.1];
  recent.forEach((entry, idx) => {
    const w = weights[idx] || 0.05;
    (entry.tags || []).forEach(tag => {
      tagWeights[tag] = (tagWeights[tag] || 0) + w;
    });
  });

  const watchedIds = new Set(history.map(h => h.id));
  const recentUploaders = [...new Set(recent.map(h => h.uploader).filter(Boolean))];

  return { tagWeights, watchedIds, recentUploaders };
}

async function loadUpNext(currentVideo) {
  const list = document.getElementById('upNextList');
  list.innerHTML = '<div class="loading" style="padding:0.5rem">Loading...</div>';

  const { tagWeights, watchedIds, recentUploaders } = getInterestProfile();
  const currentTags = currentVideo.tags || [];

  try {
    // Recommendation pool is sourced from Supabase.
    const sbVideos = await fetchSupabaseVideos().catch(() => []);
    let pool = sbVideos.filter(v =>
      v.$id !== currentVideo.$id && !watchedIds.has(v.$id)
    );

    // Score each video — same algorithm for both sources
    pool.forEach(v => {
      let score = 0;

      // Tag matching: interest profile (long-term) + current video tags (short-term)
      (v.tags || []).forEach(tag => {
        if (tagWeights[tag]) score += tagWeights[tag] * 100;
        if (currentTags.includes(tag)) score += 30;
      });

      // Same uploader bonus (works across sources via uploader field)
      if (v.uploader && currentVideo.uploader && v.uploader === currentVideo.uploader) score += 25;
      if (v.uploader && recentUploaders.includes(v.uploader)) score += 15;

      // Engagement boost (log-scaled views)
      const views = v.videoStats?.views || 0;
      score += Math.log10(views + 1) * 2;

      // Recency boost (last 30 days get a small lift)
      const ageMs = Date.now() - new Date(v.$createdAt || 0).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < 30) score += Math.max(0, 10 - ageDays / 3);

      // Small randomness so feed feels fresh on each visit
      score += Math.random() * 5;

      v._score = score;
    });

    // Sort by score, take top 10
    pool.sort((a, b) => b._score - a._score);
    const suggestions = pool.slice(0, 10);

    // Resolve uploader info — Supabase videos already have _uploaderInfo cached;
    // for any missing, batch-fetch from profiles.
    const uploaders = {};
    for (const v of suggestions) {
      if (v._uploaderInfo) uploaders[v.uploader] = v._uploaderInfo;
    }
    const missingUploaderIds = [...new Set(
      suggestions.map(v => v.uploader).filter(id => id && !uploaders[id])
    )];
    if (missingUploaderIds.length) {
      try {
        const { data: sbProfiles } = await supabase
          .from('profiles')
          .select('id, username, avatar_url')
          .in('id', missingUploaderIds);
        for (const p of (sbProfiles || [])) {
          uploaders[p.id] = { $id: p.id, username: p.username, avatar: p.avatar_url };
        }
      } catch {}
    }

    // Render
    list.innerHTML = '';
    if (!suggestions.length) {
      list.innerHTML = '<div style="color:var(--text3);font-size:0.85rem;padding:0.5rem">No suggestions yet</div>';
      return;
    }

    suggestions.forEach(v => {
      const uploader = uploaders[v.uploader];
      const item = renderUpNextItem(v, uploader, currentTags);
      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = `<div style="color:var(--text3);font-size:0.85rem;padding:0.5rem">Couldn't load: ${e.message}</div>`;
  }
}

function renderUpNextItem(video, uploader, currentTags) {
  const div = document.createElement('div');
  div.className = 'upnext-item';
  div.onclick = () => playVideo(video.$id);

  const name = uploader?.username || 'Unknown';
  const views = (video.videoStats?.views || 0).toLocaleString();
  const matchingTag = (video.tags || []).find(t => currentTags.includes(t));

  div.innerHTML = `
    <div class="upnext-thumb">
      ${video.thumbnail ? `<img src="${video.thumbnail}" loading="lazy" onerror="this.style.display='none'"/>` : ''}
      <span class="upnext-thumb-duration" data-duration></span>
    </div>
    <div class="upnext-info">
      <div class="upnext-title-text">${escHTML(video.title || 'Untitled')}</div>
      <div class="upnext-meta">
        ${escHTML(name)}<br>
        ${views} views • ${timeAgo(video.$createdAt)}
      </div>
      ${matchingTag ? `<span class="upnext-tag">${escHTML(matchingTag)}</span>` : ''}
    </div>
  `;

  // Lazy-load duration
  const durationEl = div.querySelector('[data-duration]');
  const videoDuration = video.videoStats?.duration;
  if (videoDuration) {
    durationEl.textContent = formatDuration(videoDuration);
  }

  return div;
}

// ── Videos ──
const videosPage = document.getElementById('videosPage');
const videoPlayerPage = document.getElementById('videoPlayerPage');
const studioPage = document.getElementById('studioPage');
const bookPage = document.getElementById('bookPage');
const authorPage = document.getElementById('authorPage');
const bookDetailPage = document.getElementById('bookDetailPage');
const chapterReaderPage = document.getElementById('chapterReaderPage');
const bookmarksPage = document.getElementById('bookmarksPage');  // Hoisted here (used by hideAllMainPages)
const messagesPage = document.getElementById('messagesPage');
const storePage = document.getElementById('storePage');
const earningsPage = document.getElementById('earningsPage');

// Hide every main content page; show functions call this first then set their own page to block.
function hideAllMainPages() {
  // Drop layout-mode body classes — each show* opts back in if it needs a
  // wider canvas. (Currently used by the videos and books pages.)
  document.body.classList.remove('on-videos', 'on-books');
  feedEl.style.display = 'none';
  storiesEl.style.display = 'none';
  composeEl.style.display = 'none';
  // Feed mode tabs (For You / Following / Discover) — only on Home
  const feedTabs = document.getElementById('feedTabs');
  if (feedTabs) feedTabs.style.display = 'none';
  if (profilePage) profilePage.style.display = 'none';
  if (videosPage) videosPage.style.display = 'none';
  if (videoPlayerPage) videoPlayerPage.style.display = 'none';
  if (studioPage) studioPage.style.display = 'none';
  if (bookPage) bookPage.style.display = 'none';
  if (authorPage) authorPage.style.display = 'none';
  if (bookDetailPage) bookDetailPage.style.display = 'none';
  if (chapterReaderPage) chapterReaderPage.style.display = 'none';
  if (bookmarksPage) bookmarksPage.style.display = 'none';
  if (messagesPage) messagesPage.style.display = 'none';
  if (storePage) storePage.style.display = 'none';
  if (earningsPage) earningsPage.style.display = 'none';
  // Sibling sentinels (live outside the page divs) — also hide
  const feedSentinel = document.getElementById('feedSentinel');
  if (feedSentinel) feedSentinel.style.display = 'none';
  // Reset scroll on every page nav so tabs always start at the top.
  scrollToTop();
}
let currentHls = null;

// Resume playback storage
function getResumeKey(videoId) { return `video_resume_${videoId}`; }
function getResumeTime(videoId) {
  const t = localStorage.getItem(getResumeKey(videoId));
  return t ? parseFloat(t) : 0;
}
function saveResumeTime(videoId, time, duration) {
  if (!time || time < 5) return; // ignore very early
  if (duration && time > duration - 10) {
    localStorage.removeItem(getResumeKey(videoId));
    return;
  }
  localStorage.setItem(getResumeKey(videoId), time);
}
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  return `${m}:${s.toString().padStart(2,'0')}`;
}

function stopVideoPlayer() {
  const player = document.getElementById('videoPlayer');
  if (player) {
    if (player._saveInterval) { clearInterval(player._saveInterval); player._saveInterval = null; }
    player.pause();
    player.removeAttribute('src');
    player.load();
  }
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }
}

function showVideos(forceReload = false) {
  const wasOnVideosPage = videosPage.style.display === 'block';
  hideAllMainPages();
  videosPage.style.display = 'block';
  document.body.classList.add('on-videos');
  stopVideoPlayer();
  history.pushState(null, '', '#videos');
  // Only reload if cache is empty or forced
  if (forceReload || !allVideosCache.length) {
    loadVideos();
  }
}

function showStudio(forceReload = false) {
  hideAllMainPages();
  studioPage.style.display = 'block';
  document.body.classList.remove('on-videos');
  stopVideoPlayer();
  history.pushState(null, '', '#studio');
  // Studio shows the user's own uploads — those don't change unless they
  // upload something new, so skip reload if we already rendered.
  const grid = document.getElementById('studioGrid') || studioPage.querySelector('.video-grid, .studio-grid');
  const alreadyRendered = grid && grid.children.length > 0 && !grid.querySelector('.loading');
  if (forceReload || !alreadyRendered) {
    loadStudio();
  }
}

// ════════════════════════════════════════
// BOOK / READER
// ════════════════════════════════════════
let allBooksCache = [];     // filtered + sorted view (what's rendered)
let allBooksRaw   = [];     // unfiltered raw books fetched from server (for fast tab switching)
let bookGenreFilter = '';
let bookSortBy = 'trending';
let activeBookSearchQuery = '';
let currentBookDetail = null;       // { book, chapters }
let currentChapterIndex = 0;
let readerFontSize = parseFloat(localStorage.getItem('selebox_reader_font') || '1.05');

// ── Books page (mirrors mobile-app shape: tabbed sections of curated rows) ──
//
// Tabs:
//   foryou      → Weekly Featured (editor's picks) / Fresh Reads / Completed & Excellent
//   discover    → Genre-grouped rows of top books
//   ranking     → Most Loved / Most Read / Trending This Week
//   readinglist → User's bookmarks
//
// (Library was dropped from web — the sidebar's existing Bookmarks page
// already plays that role; mobile app's "Library" maps to web's Bookmarks.)
//
// Each section has a See All link that opens an in-page list view with
// infinite scroll, sorted/filtered the same way that section was populated.
// ────────────────────────────────────────────────────────────────────────────
let _activeBookTab = 'foryou';
const _bookTabLoaded = { foryou: false, discover: false, ranking: false, readinglist: false };

function showBook(force = false) {
  hideAllMainPages();
  bookPage.style.display = 'block';
  // Wider canvas: 7 covers per row needs the full viewport, not the 900px
  // home-feed column. The body class is removed by hideAllMainPages on nav.
  document.body.classList.add('on-books');
  stopVideoPlayer();
  history.pushState(null, '', '#book');
  // Hide See-All sub-view if it was open from a previous visit.
  const seeAll = document.getElementById('bookSeeAllView');
  if (seeAll) seeAll.style.display = 'none';
  // Show the active tab's panel; hide the rest.
  document.querySelectorAll('.book-tab-panel').forEach(p => {
    const isActive = p.dataset.bookPanel === _activeBookTab;
    p.style.display = isActive ? '' : 'none';
    p.classList.toggle('active', isActive);
  });
  loadBooksTab(_activeBookTab, force);
}

function loadBooksTab(tab, force = false) {
  _activeBookTab = tab;
  if (!force && _bookTabLoaded[tab]) return;
  _bookTabLoaded[tab] = true;
  if (tab === 'foryou')      return _loadForYouTab();
  if (tab === 'discover')    return _loadDiscoverTab();
  if (tab === 'ranking')     return _loadRankingTab();
  if (tab === 'readinglist') return _loadReadingListTab();
}

// (The old fire-and-render `_loadBookSection` was removed when For You and
// Ranking moved to the parallel-fetch + claim-by-priority pattern below.
// `_renderBookSection` is the new render-only helper.)

// ── For You tab — 10 Wattpad-inspired rails ────────────────────────────────
//
// Strategy: fetch all rails in parallel (each overfetches 2× for dedup
// headroom), then walk them in priority order and CLAIM books — once a
// book lands in an earlier rail, later rails skip it. This guarantees
// every book appears at most once across the whole For You tab, while
// keeping the parallel speed (no sequential wait between waves).
//
// Order is the priority order: curated → personal → fresh activity →
// discovery → format → all-time → completed. Edit this array to reorder.
const _SECTION_ROW_SIZE = 7;
const _FORYOU_SECTIONS = [
  { key: 'weeklyFeatured',     fetch: (n) => _fetchWeeklyFeaturedWithFallback(n),                       empty: 'No featured books yet' },
  { key: 'recommended',        fetch: (n) => _fetchRecommendedForUser(n),                               empty: 'Read a few books to get personalised picks' },
  { key: 'trending',           fetch: (n) => fetchSupabaseBooks(0, n, 'trending'),                      empty: 'Nothing trending yet' },
  { key: 'freshReads',         fetch: (n) => fetchSupabaseBooks(0, n, 'recent'),                        empty: 'No fresh reads' },
  { key: 'justUpdated',        fetch: (n) => fetchSupabaseBooks(0, n, 'just-updated'),                  empty: 'No recent updates' },
  { key: 'hiddenGems',         fetch: (n) => _fetchHiddenGems(n),                                       empty: 'No hidden gems found' },
  { key: 'quickReads',         fetch: (n) => _fetchQuickReads(n),                                       empty: 'No quick reads yet' },
  { key: 'mostLoved',          fetch: (n) => fetchSupabaseBooks(0, n, 'most-liked'),                    empty: 'Nothing here yet' },
  { key: 'mostRead',           fetch: (n) => fetchSupabaseBooks(0, n, 'most-read'),                     empty: 'Nothing here yet' },
  { key: 'completedExcellent', fetch: (n) => fetchSupabaseBooks(0, n, 'completed'),                     empty: 'No completed books yet' },
];

async function _loadForYouTab() {
  // Scope all DOM queries to this panel. Several keys (mostLoved / mostRead /
  // trending) are reused by the Ranking tab — without this scope, querySelector
  // would write to whichever copy comes first in the DOM.
  const panel = document.getElementById('bookTabForYou');
  if (!panel) return;
  // Show a loading state on every track immediately so the page never looks empty.
  for (const s of _FORYOU_SECTIONS) {
    const track = panel.querySelector(`.book-section-track[data-track="${s.key}"]`);
    if (track) track.innerHTML = '<div class="loading">Loading…</div>';
  }

  // Overfetch 3× — gives the dedup pass plenty of headroom even when later
  // rails get most of their top picks claimed by earlier rails.
  const FETCH = _SECTION_ROW_SIZE * 3;
  const results = await Promise.all(
    _FORYOU_SECTIONS.map(s =>
      s.fetch(FETCH).catch(err => {
        console.warn(`[For You] section "${s.key}" failed:`, err);
        return [];
      })
    )
  );

  // Claim books in priority order with SOFT dedup:
  //   1. First pass: take un-claimed books only (the strict dedup).
  //   2. If a rail ends up too sparse to be useful (< MIN_PER_RAIL), top it
  //      up with its own already-claimed books — better to repeat a great
  //      book in a category showcase than to leave the rail empty.
  // This is the right trade for "category" rails like Most Loved / Completed,
  // where the rail's whole job is "show me the best of this slice", and dies
  // visually if dedup steals all its top picks.
  const seen = new Set();
  const MIN_PER_RAIL = 4;
  results.forEach((books, i) => {
    const pool = books || [];
    const claimed = [];
    const claimedIds = new Set();
    // Pass 1 — strict dedup
    for (const b of pool) {
      if (!b || seen.has(b.id) || claimedIds.has(b.id)) continue;
      claimed.push(b);
      claimedIds.add(b.id);
      seen.add(b.id);
      if (claimed.length >= _SECTION_ROW_SIZE) break;
    }
    // Pass 2 — soft fill if the rail came up short
    if (claimed.length < MIN_PER_RAIL) {
      for (const b of pool) {
        if (!b || claimedIds.has(b.id)) continue;
        claimed.push(b);
        claimedIds.add(b.id);
        if (claimed.length >= _SECTION_ROW_SIZE) break;
      }
    }
    _renderBookSection(_FORYOU_SECTIONS[i].key, claimed, _FORYOU_SECTIONS[i].empty, panel);
  });
}

// Render-only helper — paints already-fetched books into a section track.
// `scope` defaults to `document` but should be the parent tab panel when
// the same section key exists in multiple tabs (For You and Ranking both
// use mostLoved / mostRead / trending). Without scoping, the loaders write
// to the first matching track in DOM order — usually the wrong tab.
function _renderBookSection(sectionKey, books, emptyMsg, scope) {
  const root = scope || document;
  const track = root.querySelector(`.book-section-track[data-track="${sectionKey}"]`);
  if (!track) return;
  if (!books || !books.length) {
    track.innerHTML = `<div class="book-section-empty">${escHTML(emptyMsg || 'Nothing here yet')}</div>`;
    return;
  }
  track.innerHTML = '';
  books.forEach(b => track.appendChild(_renderBookCardV2(b)));
}

// Hidden Gems: high engagement RATE, not absolute likes. A book with 8 likes
// and 12 views is more of a "gem" than one with 50 likes and 600 views — the
// first signals "almost everyone who reads it loves it". Server filter is
// the same (low-views floor), but we re-rank client-side by likes/views ratio
// to pick the *true* gems out of that pool.
async function _fetchHiddenGems(limit = _SECTION_ROW_SIZE) {
  // Overfetch — we need headroom because we re-rank below.
  const raw = await fetchSupabaseBooks(0, Math.max(limit * 3, 24), 'most-liked', {
    filter: q => q.gte('likes_count', 3).lt('views_count', 500),
  });
  return [...raw].sort((a, b) => {
    // Smoothed ratio: floor views at 10 so a 5-view, 5-like fluke doesn't
    // win over a 50-view, 40-like consistent favourite.
    const rateA = (a.likes_count || 0) / Math.max(a.views_count || 0, 10);
    const rateB = (b.likes_count || 0) / Math.max(b.views_count || 0, 10);
    if (rateB !== rateA) return rateB - rateA;
    return (b.likes_count || 0) - (a.likes_count || 0);
  }).slice(0, limit);
}

// Quick Reads: short stories ranked by likes-PER-CHAPTER so a 1-chapter
// masterpiece beats a 5-chapter draft. Density of love > sheer count.
async function _fetchQuickReads(limit = _SECTION_ROW_SIZE) {
  const raw = await fetchSupabaseBooks(0, Math.max(limit * 3, 24), 'most-liked', {
    filter: q => q.gte('chapters_count', 1).lte('chapters_count', 5),
  });
  return [...raw].sort((a, b) => {
    const densityA = (a.likes_count || 0) / Math.max(a.chapters_count || 0, 1);
    const densityB = (b.likes_count || 0) / Math.max(b.chapters_count || 0, 1);
    if (densityB !== densityA) return densityB - densityA;
    return (b.likes_count || 0) - (a.likes_count || 0);
  }).slice(0, limit);
}

// Weekly Featured = editor's picks first; if too few, top up with trending
// (last-7-day hot) and finally with high-likes recent books, so the row
// always feels alive even before a moderator curates anything.
async function _fetchWeeklyFeaturedWithFallback(limit = _SECTION_ROW_SIZE) {
  const target = limit;
  const picks = await fetchSupabaseBooks(0, target, 'editors-pick');
  if (picks.length >= target) return picks;

  // Top up with trending (most likely to feel "weekly featured" without curation)
  const fillers = await fetchSupabaseBooks(0, target, 'trending');
  const seen = new Set(picks.map(b => b.id));
  for (const b of fillers) {
    if (picks.length >= target) break;
    if (!seen.has(b.id)) { picks.push(b); seen.add(b.id); }
  }
  if (picks.length >= 3) return picks;

  // Final fallback: most-loved books overall — guarantees a populated row.
  const safetyNet = await fetchSupabaseBooks(0, target, 'most-liked');
  for (const b of safetyNet) {
    if (picks.length >= target) break;
    if (!seen.has(b.id)) { picks.push(b); seen.add(b.id); }
  }
  return picks;
}

// "Recommended for You" — picks books matching the tags/genres the user has
// previously read or liked. For brand-new users (no signal), gracefully
// falls back to trending so the rail is always populated.
async function _fetchRecommendedForUser(limit = _SECTION_ROW_SIZE) {
  if (!currentUser?.id) {
    return await fetchSupabaseBooks(0, limit, 'most-liked');
  }
  try {
    // Pull a small sample of the user's recent reads + likes to derive their taste.
    const [{ data: reads }, { data: likes }] = await Promise.all([
      supabase.from('book_reads').select('book_id').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(20),
      supabase.from('book_likes').select('book_id').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(20),
    ]);
    const seedIds = [...new Set([...(reads || []), ...(likes || [])].map(r => r.book_id))];
    if (!seedIds.length) {
      return await fetchSupabaseBooks(0, limit, 'trending');
    }
    // Build a tag-weight map from those books.
    const { data: seedBooks } = await supabase.from('books')
      .select('genre, tags').in('id', seedIds);
    const tagWeights = {};
    for (const b of (seedBooks || [])) {
      if (b.genre) tagWeights[b.genre] = (tagWeights[b.genre] || 0) + 2;
      for (const t of (b.tags || [])) {
        if (t) tagWeights[t] = (tagWeights[t] || 0) + 1;
      }
    }
    const topTag = Object.entries(tagWeights).sort((a,b) => b[1] - a[1])[0]?.[0];
    if (!topTag) return await fetchSupabaseBooks(0, limit, 'trending');

    // Fetch top books in that taste, excluding ones the user already read/liked.
    // Overfetch so we have headroom after excluding their seedlist.
    const exclude = new Set(seedIds);
    const candidates = await fetchSupabaseBooks(0, Math.max(limit * 2, 14), 'most-liked', { genre: topTag });
    const fresh = candidates.filter(b => !exclude.has(b.id)).slice(0, limit);
    if (fresh.length >= 3) return fresh;
    return await fetchSupabaseBooks(0, limit, 'trending');
  } catch (err) {
    console.warn('Recommended-for-you failed, falling back:', err);
    return await fetchSupabaseBooks(0, _SECTION_ROW_SIZE, 'trending');
  }
}

// ── Ranking tab — Top-100 leaderboard with genre filter (App-aligned) ──────
// One ranked vertical list per genre, numbered ribbons on each row. The
// chip rail at the top filters by genre; "All" shows the platform-wide Top 100.
// Sort is by likes_count (the canonical "Most Loved" axis) — the same axis
// the mobile app uses for its single ranking score.
const _RANKING_GENRES = [
  { slug: '',                  label: 'All' },
  { slug: 'dark-romance',      label: 'Dark Romance' },
  { slug: 'mafia-boss',        label: 'Mafia Boss' },
  { slug: 'billionaire',       label: 'Billionaire' },
  { slug: 'enemies-to-lovers', label: 'Enemies to Lovers' },
  { slug: 'forbidden-love',    label: 'Forbidden Love' },
  { slug: 'hot-romance',       label: 'Hot Romance' },
  { slug: 'sci-fi',            label: 'Sci-fi' },
  { slug: 'teen-fiction',      label: 'Teen Fiction' },
  { slug: 'general-fiction',   label: 'General Fiction' },
];
let _rankingActiveGenre = '';
let _rankingSeq = 0;

async function _loadRankingTab() {
  const panel = document.getElementById('bookTabRanking');
  if (!panel) return;
  _renderRankGenreChips();
  await _loadRankingForGenre(_rankingActiveGenre);
}

function _renderRankGenreChips() {
  const wrap = document.getElementById('rankGenreChips');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const g of _RANKING_GENRES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rank-genre-chip' + (g.slug === _rankingActiveGenre ? ' active' : '');
    btn.dataset.genre = g.slug;
    btn.textContent = g.label;
    btn.addEventListener('click', () => {
      if (g.slug === _rankingActiveGenre) return;
      _rankingActiveGenre = g.slug;
      // Update active chip styling without a full chip-rail rebuild
      wrap.querySelectorAll('.rank-genre-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.genre === g.slug);
      });
      _loadRankingForGenre(g.slug);
    });
    wrap.appendChild(btn);
  }
}

async function _loadRankingForGenre(genreSlug) {
  const list = document.getElementById('rankList');
  if (!list) return;
  const seq = ++_rankingSeq;
  list.innerHTML = '<div class="loading">Loading rankings…</div>';

  let books;
  try {
    // Top 100 by all-time VIEWS — highest read count wins #1, matching the
    // mobile App. Genre filter is optional (empty string = All).
    books = await fetchSupabaseBooks(0, 100, 'most-read', genreSlug ? { genre: genreSlug } : {});
  } catch (err) {
    if (seq !== _rankingSeq) return;
    console.warn('[Ranking] load failed:', err);
    list.innerHTML = '<div class="rank-empty">Couldn\'t load rankings. Try again.</div>';
    return;
  }
  if (seq !== _rankingSeq) return; // user switched genre mid-flight

  if (!books.length) {
    list.innerHTML = '<div class="rank-empty">No books in this category yet.</div>';
    return;
  }

  list.innerHTML = '';
  books.forEach((book, idx) => {
    list.appendChild(_renderRankCard(book, idx + 1));
  });
}

// Single ranked-list row — cover left with numbered ribbon, info right.
// Mirrors the mobile app's leaderboard card: title, description, status
// badge, paid/free badge, and an icon-stats row.
function _renderRankCard(book, rank) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'rank-card';
  card.dataset.rank = String(rank);
  card.dataset.bookId = book.id;
  card.onclick = () => openBookDetail(book.id);

  const initial = (book.title || '?').trim().charAt(0).toUpperCase();
  const cover = book.cover_url
    ? `<img src="${escHTML(book.cover_url)}" alt="" loading="lazy"/>`
    : `<div class="rank-card-cover-placeholder">${escHTML(initial)}</div>`;

  const isCompleted = (book.status || '').toLowerCase() === 'completed';
  const isPaid = (book.lock_from_chapter || 0) > 0;

  // Synthesised rating (same scale as the v2 card so numbers stay consistent).
  const rating = Math.min(5, (book.likes_count || 0) / 5).toFixed(2);
  const views  = formatCompact(book.views_count || 0);
  const likes  = formatCompact(book.likes_count || 0);
  const chapters = book.chapters_count || 0;

  const desc = (book.description || '').trim() || 'No description yet.';

  card.innerHTML = `
    <div class="rank-card-ribbon">${rank}</div>
    <div class="rank-card-cover">${cover}</div>
    <div class="rank-card-body">
      <h3 class="rank-card-title">${escHTML(book.title || 'Untitled')}</h3>
      <p class="rank-card-desc">${escHTML(desc)}</p>
      <div class="rank-card-badges">
        ${isCompleted
          ? '<span class="rank-card-badge rank-card-badge-completed">Completed</span>'
          : '<span class="rank-card-badge rank-card-badge-ongoing">Ongoing</span>'}
        ${isPaid ? '<span class="rank-card-badge rank-card-badge-paid">Paid</span>' : ''}
      </div>
      <div class="rank-card-stats">
        <span class="rank-card-stat rank-card-stat-rating"><span class="rank-card-stat-icon">★</span>${rating}</span>
        <span class="rank-card-stat rank-card-stat-views"><span class="rank-card-stat-icon">👁</span>${views}</span>
        <span class="rank-card-stat rank-card-stat-likes"><span class="rank-card-stat-icon">♥</span>${likes}</span>
        <span class="rank-card-stat"><span class="rank-card-stat-icon">📋</span>${chapters}</span>
      </div>
    </div>`;
  return card;
}

// ── Discover tab — genre-grouped rows ──────────────────────────────────────
const _DISCOVER_GENRES = [
  'hot-romance', 'dark-romance', 'mafia-boss', 'enemies-to-lovers',
  'forbidden-love', 'sci-fi', 'teen-fiction', 'general-fiction',
];
async function _loadDiscoverTab() {
  const wrap = document.getElementById('bookDiscoverGenres');
  if (!wrap) return;
  // Build the section skeletons so each row gets its own loading state.
  wrap.innerHTML = '';
  _DISCOVER_GENRES.forEach(g => {
    const sec = document.createElement('div');
    sec.className = 'book-section';
    const safeG = escHTML(g);
    const pretty = escHTML(prettyGenre(g));
    // Same head markup as For You / Ranking — keeps "See All" right-aligned
    // and the title styling consistent across every tab.
    sec.innerHTML = `
      <div class="book-section-head">
        <h2 class="book-section-title">${pretty}</h2>
        <button class="book-section-see-all" data-see-all="genre:${safeG}" type="button">See All</button>
      </div>
      <div class="book-section-track" data-track="genre:${safeG}"><div class="loading">Loading…</div></div>`;
    wrap.appendChild(sec);
  });
  // Hydrate each row in parallel.
  await Promise.all(_DISCOVER_GENRES.map(g => _loadDiscoverGenreRow(g)));
}

async function _loadDiscoverGenreRow(genre) {
  // Find the entire section (not just the track) so we can hide it if empty —
  // mobile-app parity: a genre with zero books shouldn't take up space.
  const section = document.querySelector(`.book-section-track[data-track="genre:${genre}"]`)?.closest('.book-section');
  const track = section?.querySelector(`.book-section-track[data-track="genre:${genre}"]`);
  if (!track) return;
  try {
    const books = await fetchSupabaseBooks(0, _SECTION_ROW_SIZE, 'most-liked', { genre });
    if (!books.length) {
      // Hide the section entirely — cleaner than an empty-state placeholder.
      if (section) section.style.display = 'none';
      return;
    }
    track.innerHTML = '';
    books.forEach(b => track.appendChild(_renderBookCardV2(b)));
  } catch (err) {
    console.warn(`Discover genre "${genre}" failed:`, err);
    track.innerHTML = '<div class="book-section-empty">Couldn\'t load.</div>';
  }
}

// ── Reading List tab (user-scoped collection grid) ────────────────────────
async function _loadCollectionTab({ table, fkName, gridId, emptyId, signedOutMsg, orderColumn }) {
  const grid = document.getElementById(gridId);
  const empty = document.getElementById(emptyId);
  if (!grid) return;
  if (!currentUser?.id) {
    grid.innerHTML = `<div class="book-collection-empty"><h3>${escHTML(signedOutMsg)}</h3></div>`;
    if (empty) empty.style.display = 'none';
    return;
  }
  grid.innerHTML = '<div class="loading">Loading…</div>';
  if (empty) empty.style.display = 'none';
  try {
    // Join through the user's pivot table (book_reads / book_bookmarks) so we
    // both fetch the book row AND keep the user's own "latest first" order.
    //
    // CRITICAL: book_reads's timestamp column is `last_read_at`, NOT
    // `created_at` — ordering by created_at on book_reads throws "column
    // does not exist" and the whole tab errors out. The orderColumn arg
    // lets each caller name its own.
    const col = orderColumn || 'created_at';
    const { data, error } = await supabase.from(table)
      .select(`book_id, ${col}, books!${fkName}(${BOOK_CARD_SELECT})`)
      .eq('user_id', currentUser.id)
      .order(col, { ascending: false })
      .limit(60);
    if (error) throw error;
    const books = _normalizeBookRows((data || []).map(r => r.books));
    if (!books.length) {
      grid.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    // v2 cards (corner ribbon + rating + views) so Reading List looks
    // identical to every other rail across the books page.
    grid.innerHTML = '';
    books.forEach((b, i) => {
      const card = _renderBookCardV2(b);
      card.style.animationDelay = `${(i * 0.025).toFixed(3)}s`;
      grid.appendChild(card);
    });
  } catch (err) {
    console.error(`${table} load failed:`, err);
    grid.innerHTML = '<div class="book-collection-empty"><p>Couldn\'t load. Try again.</p></div>';
  }
}
// (Library tab loader was removed alongside its DOM. The web's existing
// sidebar Bookmarks page is the canonical "Library" experience here.)
function _loadReadingListTab() {
  return _loadCollectionTab({
    table: 'book_bookmarks',
    fkName: 'book_bookmarks_book_id_fkey',
    gridId: 'bookReadingListGrid',
    emptyId: 'bookReadingListEmpty',
    signedOutMsg: 'Sign in to see your reading list',
    orderColumn: 'created_at',
  });
}

// ── v2 book card (matches mobile look: cover + corner badge + stats) ───────
function _renderBookCardV2(b) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'book-card-v2';
  card.dataset.bookId = b.id;
  card.onclick = () => openBookDetail(b.id);

  const initialLetter = (b.title || '?').trim().charAt(0).toUpperCase();
  const cover = b.cover_url
    ? `<img src="${escHTML(b.cover_url)}" alt="" loading="lazy" onerror="this.style.display='none'"/>`
    : `<div class="book-card-v2-cover-placeholder">${escHTML(initialLetter)}</div>`;
  const isPaid = (b.lock_from_chapter || 0) > 0;
  const author = b.author?.username || b.profiles?.username || 'Unknown';
  // Visual rating that mirrors the mobile-app card. We don't have a real
  // ratings table yet, so we synthesise a 0-5 star from likes_count using
  // the same scale the mobile UI seems to apply: ~25 likes → 5.0 stars.
  const rating = Math.min(5, (b.likes_count || 0) / 5).toFixed(1);
  const views = formatCompact(b.views_count || 0);

  card.innerHTML = `
    <div class="book-card-v2-cover">
      ${cover}
      <div class="book-card-v2-badge ${isPaid ? 'book-card-v2-badge-paid' : 'book-card-v2-badge-free'}">${isPaid ? 'Paid' : 'Free'}</div>
    </div>
    <div class="book-card-v2-body">
      <h3 class="book-card-v2-title">${escHTML(b.title || 'Untitled')}</h3>
      <p class="book-card-v2-author">by ${escHTML(author)}</p>
      <div class="book-card-v2-stats">
        <span class="book-card-v2-stat book-card-v2-stat-rating">★ ${rating}</span>
        <span class="book-card-v2-stat book-card-v2-stat-views">👁 ${views}</span>
      </div>
    </div>`;
  return card;
}

// ── Tab switching (event delegation) ───────────────────────────────────────
// One listener on the tab bar instead of one-per-button — robust if the bar
// is ever rebuilt (e.g., by a future feature flag) and one less DOM walk.
document.getElementById('bookTabs')?.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('.book-tab');
  if (!tabBtn) return;
  const t = tabBtn.dataset.bookTab;
  if (!t || t === _activeBookTab) return;
  _activeBookTab = t;
  document.querySelectorAll('#bookTabs .book-tab').forEach(x => {
    const isActive = x === tabBtn;
    x.classList.toggle('active', isActive);
    x.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('.book-tab-panel').forEach(p => {
    const isActive = p.dataset.bookPanel === t;
    p.style.display = isActive ? '' : 'none';
    p.classList.toggle('active', isActive);
  });
  // Close any open See-All sub-view when switching tabs.
  const seeAll = document.getElementById('bookSeeAllView');
  if (seeAll) seeAll.style.display = 'none';
  if (_seeAllObserver) { _seeAllObserver.disconnect(); _seeAllObserver = null; }
  loadBooksTab(t);
  window.scrollTo({ top: 0, behavior: 'instant' });
});

// ── See All sub-view ───────────────────────────────────────────────────────
let _seeAllSeq = 0;
let _seeAllOffset = 0;
let _seeAllSort = '';
let _seeAllGenre = null;
// Optional custom predicate for See-All — set when the section had a `filter`
// in _SEE_ALL_MAP (Hidden Gems, Quick Reads). Threaded through to fetchSupabaseBooks.
let _seeAllFilter = null;
let _seeAllHasMore = false;
let _seeAllLoading = false;
let _seeAllObserver = null;

const _SEE_ALL_MAP = {
  weeklyFeatured:     { sort: 'editors-pick',  title: 'Weekly Featured' },
  recommended:        { sort: 'most-liked',    title: 'Recommended for You' },
  trending:           { sort: 'trending',      title: 'Trending This Week' },
  freshReads:         { sort: 'recent',        title: 'Fresh Reads' },
  justUpdated:        { sort: 'just-updated',  title: 'Just Updated' },
  hiddenGems:         { sort: 'most-liked',    title: 'Hidden Gems',
                        filter: q => q.gte('likes_count', 3).lt('views_count', 500) },
  quickReads:         { sort: 'most-liked',    title: 'Quick Reads',
                        filter: q => q.gte('chapters_count', 1).lte('chapters_count', 5) },
  mostLoved:          { sort: 'most-liked',    title: 'Most Loved' },
  mostRead:           { sort: 'most-read',     title: 'Most Read' },
  completedExcellent: { sort: 'completed',     title: 'Completed & Excellent Works' },
};

document.getElementById('bookPage')?.addEventListener('click', (e) => {
  const seeAllBtn = e.target.closest('.book-section-see-all');
  if (!seeAllBtn) return;
  e.preventDefault();
  _openBookSeeAll(seeAllBtn.dataset.seeAll);
});

document.getElementById('btnBookSeeAllBack')?.addEventListener('click', () => {
  const seeAll = document.getElementById('bookSeeAllView');
  if (seeAll) seeAll.style.display = 'none';
  document.querySelectorAll('.book-tab-panel').forEach(p => {
    const isActive = p.dataset.bookPanel === _activeBookTab;
    p.style.display = isActive ? '' : 'none';
    p.classList.toggle('active', isActive);
  });
  if (_seeAllObserver) { _seeAllObserver.disconnect(); _seeAllObserver = null; }
  window.scrollTo({ top: 0, behavior: 'instant' });
});

async function _openBookSeeAll(key) {
  let cfg = _SEE_ALL_MAP[key];
  let genre = null;
  if (!cfg && key && key.startsWith('genre:')) {
    genre = key.slice('genre:'.length).replace(/[^a-z0-9-]/gi, '');
    cfg = { sort: 'most-liked', title: prettyGenre(genre) };
  }
  if (!cfg) return;

  _seeAllSeq++;
  _seeAllSort = cfg.sort;
  _seeAllGenre = genre;
  _seeAllFilter = cfg.filter || null;
  _seeAllOffset = 0;
  _seeAllHasMore = true;
  if (_seeAllObserver) { _seeAllObserver.disconnect(); _seeAllObserver = null; }

  document.querySelectorAll('.book-tab-panel').forEach(p => p.style.display = 'none');
  const seeAll = document.getElementById('bookSeeAllView');
  if (!seeAll) return;
  seeAll.style.display = 'block';
  document.getElementById('bookSeeAllTitle').textContent = cfg.title;
  document.getElementById('bookSeeAllGrid').innerHTML = '<div class="loading">Loading…</div>';
  const sentinel = document.getElementById('bookSeeAllSentinel');
  if (sentinel) sentinel.style.display = 'none';

  window.scrollTo({ top: 0, behavior: 'instant' });
  await _loadMoreSeeAllBooks(true);
}

async function _loadMoreSeeAllBooks(initial = false) {
  if (_seeAllLoading || (!_seeAllHasMore && !initial)) return;
  _seeAllLoading = true;
  const seq = _seeAllSeq;
  const grid = document.getElementById('bookSeeAllGrid');
  const sentinel = document.getElementById('bookSeeAllSentinel');
  const limit = 40;

  try {
    // One fetcher path, three optional shapes — sort-only, genre-filtered, or
    // predicate-filtered (Hidden Gems / Quick Reads). All three combine cleanly.
    const opts = {};
    if (_seeAllGenre)  opts.genre  = _seeAllGenre;
    if (_seeAllFilter) opts.filter = _seeAllFilter;
    const books = await fetchSupabaseBooks(_seeAllOffset, limit, _seeAllSort, opts);

    if (seq !== _seeAllSeq) return; // user opened a different See-All

    if (initial) grid.innerHTML = '';
    if (initial && !books.length) {
      grid.innerHTML = '<div class="book-collection-empty"><p>Nothing here yet.</p></div>';
      _seeAllHasMore = false;
      if (sentinel) sentinel.style.display = 'none';
      return;
    }

    books.forEach((b, i) => {
      const card = renderBookCard(b);
      card.style.animationDelay = `${(i * 0.02).toFixed(3)}s`;
      grid.appendChild(card);
    });
    _seeAllOffset += books.length;

    if (books.length < limit) {
      _seeAllHasMore = false;
      if (sentinel) {
        sentinel.style.display = 'block';
        sentinel.innerHTML = `<div class="book-grid-end-msg">You've reached the end · ${_seeAllOffset.toLocaleString()} books</div>`;
      }
      if (_seeAllObserver) { _seeAllObserver.disconnect(); _seeAllObserver = null; }
    } else {
      if (sentinel) {
        sentinel.style.display = 'block';
        sentinel.innerHTML = '<div class="book-grid-loadmore">Loading more books…</div>';
      }
      _setupSeeAllInfiniteScroll();
    }
  } catch (err) {
    if (seq !== _seeAllSeq) return;
    console.error('See-all load failed:', err);
    if (initial) grid.innerHTML = '<div class="book-collection-empty"><p>Couldn\'t load. Try again.</p></div>';
    if (sentinel) sentinel.innerHTML = '<div class="book-grid-end-msg">Couldn\'t load more.</div>';
  } finally {
    _seeAllLoading = false;
  }
}

function _setupSeeAllInfiniteScroll() {
  if (_seeAllObserver || !('IntersectionObserver' in window)) return;
  const sentinel = document.getElementById('bookSeeAllSentinel');
  if (!sentinel) return;
  _seeAllObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) _loadMoreSeeAllBooks(false);
  }, { root: null, rootMargin: '600px 0px', threshold: 0.01 });
  _seeAllObserver.observe(sentinel);
}

// ── Pagination state for the See All sub-view (back-compat shims kept for
// any older code paths that still reference these names) ──
const BOOKS_PAGE_SIZE = 80;
let _booksOffset = 0;
let _hasMoreBooks = true;
let _isLoadingMoreBooks = false;
let _bookScrollObserver = null;
let _booksSeq = 0;
let _booksLoadedSort = null;
let _booksLoadedGenre = null;

// (loadBooks / loadMoreBooks removed — the books page is now tabbed, with
// curated sections rendered by _loadForYouTab / _loadDiscoverTab / etc., and
// the See-All sub-view's pagination is handled by _loadMoreSeeAllBooks.)

// applyBookFilter — kept as a small helper. Currently unused by the v2 flow
// (server-side genre filter handles it for the See-All view), but cheap to
// keep around for future call sites.
function applyBookFilter(list, genre) {
  const filter = genre || '';
  if (!filter) return [...list];
  const filterLower = filter.toLowerCase();
  const filterWords = filterLower.replace(/-/g, ' ');
  return list.filter(b => {
    if (b.genre === filter) return true;
    return (b.tags || []).some(t => {
      const tagLower = (t || '').toLowerCase();
      return tagLower === filterLower || tagLower === filterWords;
    });
  });
}

// ── Book search (filters the currently-loaded book cache) ──
// Searches: title, description, tags, genre, author/uploader name.
// `#tag` prefix restricts to tag-only matches. Suspends infinite scroll while active.
function searchBooks(query) {
  query = (query || '').trim();
  if (!query) return allBooksCache;

  const hashtagMatch = query.match(/^#(\w+)/);
  const isHashtag = !!hashtagMatch;
  const cleanQuery = normalizeForSearch(isHashtag ? hashtagMatch[1] : query);

  return allBooksCache.filter(b => {
    if (isHashtag) {
      return (b.tags || []).some(t => normalizeForSearch(t).includes(cleanQuery));
    }

    const title  = normalizeForSearch(b.title);
    const desc   = normalizeForSearch(b.description);
    const tags   = normalizeForSearch((b.tags || []).join(' '));
    const genre  = normalizeForSearch((b.genre || '').replace(/-/g, ' '));
    const author = normalizeForSearch(b.profiles?.username || b.author?.username || '');

    return title.includes(cleanQuery)
        || desc.includes(cleanQuery)
        || tags.includes(cleanQuery)
        || genre.includes(cleanQuery)
        || author.includes(cleanQuery);
  });
}

async function runBookSearch() {
  // The v2 books page has no flat grid — search results render into the
  // See-All sub-view, which already has its own grid + infinite scroll.
  const grid = document.getElementById('bookSeeAllGrid');
  const seeAllRoot = document.getElementById('bookSeeAllView');
  const titleEl = document.getElementById('bookSeeAllTitle');
  if (!grid || !seeAllRoot || !titleEl) return;

  // Defensive: only render into the books page when it's actually visible.
  // (getSearchContext now restricts books-context to the listing page, but
  // this is a belt-and-braces check in case future code changes that.)
  if (bookPage && bookPage.style.display === 'none') return;

  if (!activeBookSearchQuery.trim()) {
    // Empty query → close the search view and return to the active tab panel
    seeAllRoot.style.display = 'none';
    document.querySelectorAll('.book-tab-panel').forEach(p => {
      const isActive = p.dataset.bookPanel === _activeBookTab;
      p.style.display = isActive ? '' : 'none';
      p.classList.toggle('active', isActive);
    });
    return;
  }

  // Show the See-All view and treat search as its own kind of "list"
  document.querySelectorAll('.book-tab-panel').forEach(p => p.style.display = 'none');
  seeAllRoot.style.display = 'block';
  titleEl.textContent = `Search: "${activeBookSearchQuery}"`;
  // Disable any pending see-all infinite scroll — search isn't paginated here
  if (_seeAllObserver) { _seeAllObserver.disconnect(); _seeAllObserver = null; }
  _seeAllHasMore = false;
  const sentinel = document.getElementById('bookSeeAllSentinel');
  if (sentinel) sentinel.style.display = 'none';
  grid.innerHTML = '<div class="loading">Searching books…</div>';

  const savedQuery = activeBookSearchQuery;
  const { books: serverHits, writers } = await fetchBooksServerSearch(savedQuery)
    .catch(() => ({ books: [], writers: [] }));

  // Stale-query guard: ignore if user kept typing
  if (activeBookSearchQuery !== savedQuery) return;

  grid.innerHTML = '';

  // ── Writer channel cards (YouTube-style, above the books) ──
  if (writers && writers.length) {
    const header = document.createElement('div');
    header.className = 'video-creators-header';
    header.style.gridColumn = '1 / -1';
    header.textContent = writers.length === 1 ? 'Writer' : 'Writers';
    grid.appendChild(header);

    const row = document.createElement('div');
    row.className = 'video-creators-row';
    row.style.gridColumn = '1 / -1';
    writers.forEach(w => row.appendChild(renderWriterChannelCard(w)));
    grid.appendChild(row);

    if (serverHits.length) {
      const booksHeader = document.createElement('div');
      booksHeader.className = 'video-creators-header';
      booksHeader.style.gridColumn = '1 / -1';
      booksHeader.textContent = 'Books';
      grid.appendChild(booksHeader);
    }
  }

  if (!serverHits.length) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'book-collection-empty';
    emptyEl.style.gridColumn = '1 / -1';
    emptyEl.innerHTML = (writers && writers.length)
      ? '<h3>No books found</h3><p>The writers above match — open one of their pages to see their work.</p>'
      : '<h3>No books found</h3><p>Try a different keyword, author, or #tag.</p>';
    grid.appendChild(emptyEl);
    return;
  }

  serverHits.forEach((b, i) => {
    const card = renderBookCard(b);
    card.style.animationDelay = `${(i * 0.02).toFixed(3)}s`;
    grid.appendChild(card);
  });
}

// Writer channel card — same shape as the video creator card so the books
// page reuses the existing .creator-channel-card styling.
function renderWriterChannelCard(writer) {
  const card = document.createElement('button');
  card.className = 'creator-channel-card';
  card.type = 'button';
  card.onclick = () => openProfile(writer.id);

  const initial = (writer.username || '?').trim().charAt(0).toUpperCase();
  const avatar = writer.avatar_url
    ? `<img src="${escHTML(writer.avatar_url)}" alt=""/>`
    : `<div class="creator-channel-avatar-placeholder">${initial}</div>`;

  const booksLabel = writer.books_count === 1 ? '1 book' : `${(writer.books_count || 0).toLocaleString()} books`;

  card.innerHTML = `
    <div class="creator-channel-avatar">${avatar}</div>
    <div class="creator-channel-info">
      <div class="creator-channel-name">${escHTML(writer.username || 'Unknown')}</div>
      <div class="creator-channel-meta">${booksLabel}</div>
      ${writer.bio ? `<div class="creator-channel-bio">${escHTML(writer.bio.slice(0, 90))}${writer.bio.length > 90 ? '…' : ''}</div>` : ''}
    </div>
    <div class="creator-channel-cta">View profile →</div>
  `;
  return card;
}

// (setupBooksInfiniteScroll removed — the See-All sub-view uses
// _setupSeeAllInfiniteScroll instead. Other tabs render fixed-size sections.)

// ── Supabase books ──
// ────────────────────────────────────────────────────────────────────────
// Adaptive book chip rail — YouTube-style: tags from user's reads + platform popular
// Re-renders on each books-page open so it adapts as reading habits evolve.
// ────────────────────────────────────────────────────────────────────────
const PRETTY_GENRE = {
  'hot-romance':         'Hot Romance',
  'dark-romance':        'Dark Romance',
  'mafia-boss':          'Mafia Boss',
  'enemies-to-lovers':   'Enemies to Lovers',
  'forbidden-love':      'Forbidden Love',
  'arranged-marriage':   'Arranged Marriage',
  'contract-marriage':   'Contract Marriage',
  'second-chance':       'Second Chance',
  'boy-love-bl':         'Boy Love',
  'girl-love-gl':        'Girl Love',
  'sci-fi':              'Sci-fi',
  'teen-fiction':        'Teen Fiction',
  'general-fiction':     'General Fiction',
  'slice-of-life':       'Slice of Life',
  'one-shot-story':      'One Shot Story',
  'valentines-special':  'Valentines Special',
};
function prettyGenre(slug) {
  if (!slug) return '';
  if (PRETTY_GENRE[slug]) return PRETTY_GENRE[slug];
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Cache for user's book reading taste (reads + likes) — used by both
// renderBookChips() and loadBookRecommendations() in the same page load.
// 60-second TTL so stale-but-fresh-enough data doesn't trigger 2 round-trips.
let _userBookTasteCache = null;
let _userBookTasteAt = 0;
async function getUserBookTaste() {
  if (!currentUser) return { reads: [], likes: [] };
  const now = Date.now();
  if (_userBookTasteCache && (now - _userBookTasteAt) < 60_000) {
    return _userBookTasteCache;
  }
  const [{ data: reads }, { data: likes }] = await Promise.all([
    supabase.from('book_reads').select('book_id').eq('user_id', currentUser.id).order('last_read_at', { ascending: false }).limit(50),
    supabase.from('book_likes').select('book_id').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(50),
  ]);
  _userBookTasteCache = { reads: reads || [], likes: likes || [] };
  _userBookTasteAt = now;
  return _userBookTasteCache;
}

async function renderBookChips() {
  const wrap = document.getElementById('bookGenreChips');
  if (!wrap) return;

  // Build a candidate set from BOTH platform popularity + user's reading taste
  let userTags = {};
  let platformGenres = {};

  // Platform popularity — count genres + tags across the books we already loaded
  const allLoadedBooks = (typeof allBooks !== 'undefined' && Array.isArray(allBooks))
    ? allBooks
    : (Array.isArray(window._latestBooksList) ? window._latestBooksList : []);
  for (const b of allLoadedBooks) {
    if (b.genre) platformGenres[b.genre] = (platformGenres[b.genre] || 0) + 1;
    for (const t of (b.tags || [])) {
      const slug = String(t).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (slug) platformGenres[slug] = (platformGenres[slug] || 0) + 1;
    }
  }

  // User reading taste (only for signed-in users)
  if (currentUser) {
    try {
      const { reads, likes } = await getUserBookTaste();
      const seedIds = [...new Set([...reads, ...likes].map(r => r.book_id))].slice(0, 30);
      if (seedIds.length) {
        const { data: seedBooks } = await supabase
          .from('books').select('id, genre, tags').in('id', seedIds);
        for (const b of (seedBooks || [])) {
          if (b.genre) userTags[b.genre] = (userTags[b.genre] || 0) + 2;
          for (const t of (b.tags || [])) {
            const slug = String(t).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            if (slug) userTags[slug] = (userTags[slug] || 0) + 1;
          }
        }
      }
    } catch {}
  }

  const userRanked = Object.entries(userTags)
    .filter(([t]) => platformGenres[t]) // only show tags that have content
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  const platformRanked = Object.entries(platformGenres)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  // Blend: 70% from interest, 30% platform discovery (or 100% platform for new users)
  const limit = 22;
  let chips = [];
  if (userRanked.length) {
    const userQuota = Math.ceil(limit * 0.7);
    const seen = new Set(userRanked.slice(0, userQuota));
    for (const t of platformRanked) { if (seen.size >= limit) break; seen.add(t); }
    chips = [...seen].slice(0, limit);
  } else {
    chips = platformRanked.slice(0, limit);
  }

  // Fallback if we still have nothing (e.g. on first page open before any books load)
  if (!chips.length) {
    chips = ['romance', 'hot-romance', 'dark-romance', 'mafia-boss', 'billionaire', 'werewolf', 'vampire', 'thriller', 'horror', 'fantasy', 'comedy', 'drama'];
  }

  // Render — "All" chip first, then adaptive list
  const activeAll = !bookGenreFilter ? 'active' : '';
  let html = `<button class="book-chip ${activeAll}" data-genre="">All</button>`;
  html += chips.map(g =>
    `<button class="book-chip ${g === bookGenreFilter ? 'active' : ''}" data-genre="${escHTML(g)}">${escHTML(prettyGenre(g))}</button>`
  ).join('');
  wrap.innerHTML = html;
}

let _bookRecsCache = null;
let _bookRecsTimestamp = 0;
const BOOK_RECS_TTL = 5 * 60 * 1000; // 5 min

async function loadBookRecommendations() {
  const rail = document.getElementById('bookRecommendRail');
  const track = document.getElementById('bookRecommendTrack');
  const sub   = document.getElementById('bookRecommendSub');
  if (!rail || !track) return;

  // Only show for signed-in users
  if (!currentUser) { rail.style.display = 'none'; return; }

  // Use cache if fresh
  if (_bookRecsCache && (Date.now() - _bookRecsTimestamp) < BOOK_RECS_TTL) {
    renderBookRecsRail(_bookRecsCache);
    return;
  }

  try {
    // Pull user's reading taste from shared cache (avoids duplicate fetch
    // since renderBookChips() already pulled this seconds ago)
    const { reads, likes } = await getUserBookTaste();
    const readIds  = new Set(reads.map(r => r.book_id));
    const likedIds = new Set(likes.map(l => l.book_id));
    const seedIds  = [...new Set([...readIds, ...likedIds])].slice(0, 30);

    // Fetch a candidate pool (most recent public books)
    const { data: pool } = await supabase
      .from('books')
      .select(`
        id, title, cover_url, genre, tags,
        views_count, likes_count, chapters_count,
        author_id, created_at,
        profiles!books_author_id_fkey ( id, username, avatar_url, is_banned )
      `)
      .eq('is_public', true)
      .eq('is_hidden', false)
      .order('created_at', { ascending: false })
      .limit(200);

    if (!pool || !pool.length) { rail.style.display = 'none'; return; }

    // Build interest profile from seed books (tags + authors)
    let tagWeights = {};
    let authorWeights = {};
    if (seedIds.length) {
      const { data: seedBooks } = await supabase
        .from('books')
        .select('id, genre, tags, author_id')
        .in('id', seedIds);
      for (const sb of (seedBooks || [])) {
        for (const t of (sb.tags || [])) tagWeights[t] = (tagWeights[t] || 0) + 1;
        if (sb.genre) tagWeights[sb.genre] = (tagWeights[sb.genre] || 0) + 1;
        if (sb.author_id) authorWeights[sb.author_id] = (authorWeights[sb.author_id] || 0) + 1;
      }
    }

    const hasInterest = Object.keys(tagWeights).length > 0;

    // Score each candidate
    const scored = pool
      .filter(b => !readIds.has(b.id))                  // skip already-read
      .filter(b => !b.profiles?.is_banned)              // skip banned authors
      .map(b => {
        let score = 0;
        // Tag overlap with user's interests
        for (const t of (b.tags || [])) {
          if (tagWeights[t]) score += tagWeights[t] * 12;
        }
        // Genre match
        if (b.genre && tagWeights[b.genre]) score += tagWeights[b.genre] * 10;
        // Same-author bonus
        if (authorWeights[b.author_id]) score += authorWeights[b.author_id] * 18;
        // Engagement boost
        score += Math.log10((b.views_count || 0) + 1) * 1.5;
        score += Math.log10((b.likes_count || 0) + 1) * 2;
        // Recency boost (last 60 days)
        const ageDays = (Date.now() - new Date(b.created_at).getTime()) / 86400000;
        if (ageDays < 60) score += Math.max(0, 6 - ageDays / 10);
        // Random freshness
        score += Math.random() * 4;
        return { book: b, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(x => x.book);

    _bookRecsCache = scored;
    _bookRecsTimestamp = Date.now();

    if (sub) sub.textContent = hasInterest ? 'Based on your reading taste' : 'Trending this week';
    renderBookRecsRail(scored);
  } catch (e) {
    console.warn('[recs] failed', e);
    rail.style.display = 'none';
  }
}

function renderBookRecsRail(books) {
  const rail = document.getElementById('bookRecommendRail');
  const track = document.getElementById('bookRecommendTrack');
  if (!rail || !track) return;
  if (!books || !books.length) { rail.style.display = 'none'; return; }

  track.innerHTML = '';
  for (const b of books) {
    const a = document.createElement('a');
    a.href = `#book/${b.id}`;
    a.className = 'recommend-card';
    a.onclick = (e) => { e.preventDefault(); openBookDetail(b.id, b); };

    const initial = (b.title || '?').trim().charAt(0).toUpperCase();
    a.innerHTML = `
      <div class="recommend-card-cover">
        ${b.cover_url
          ? `<img src="${escHTML(b.cover_url)}" alt="" loading="lazy"/>`
          : `<div class="recommend-card-cover-empty">${escHTML(initial)}</div>`}
      </div>
      <div class="recommend-card-title">${escHTML(b.title || 'Untitled')}</div>
      <div class="recommend-card-author">${escHTML(b.profiles?.username || 'Unknown')}</div>
      <div class="recommend-card-meta">${(b.views_count || 0).toLocaleString()} reads · ${(b.likes_count || 0).toLocaleString()} ♥</div>
    `;
    track.appendChild(a);
  }
  rail.style.display = 'block';
}

// ── Book row helpers ──────────────────────────────────────────────────────
// One source of truth for the columns the UI needs from the books table.
// Used by every fetcher so adding/removing a column is a one-line change.
const BOOK_LIST_SELECT = `
  id, title, description, cover_url, genre, tags, status,
  views_count, likes_count, chapters_count, word_count,
  views_last_7d, likes_last_7d, trending_score,
  is_editors_pick, editors_pick_at, editors_pick_note,
  lock_from_chapter, published_at, created_at, author_id,
  profiles!books_author_id_fkey ( id, username, avatar_url, is_banned )
`;
// Slimmer projection — used by the home-feed dropdown and other places where
// only cover/title/author are needed.
const BOOK_CARD_SELECT = `
  id, title, cover_url, genre, status, views_count, likes_count,
  chapters_count, lock_from_chapter, published_at, created_at, author_id,
  profiles!books_author_id_fkey ( id, username, avatar_url, is_banned )
`;

// Normalise a raw row into the shape the rest of the app expects.
// Filters out banned-author rows; returns null for those (caller filters).
function _normalizeBookRow(row) {
  if (!row) return null;
  if (row.profiles?.is_banned) return null;
  return {
    ...row,
    $id: 'sb_' + row.id,
    author: row.profiles
      ? { id: row.profiles.id, username: row.profiles.username, avatar: row.profiles.avatar_url }
      : null,
  };
}
function _normalizeBookRows(rows) {
  return (rows || []).map(_normalizeBookRow).filter(Boolean);
}

// Server-side sort matrix. Each entry returns the chained query so callers
// can range() it. Keeping the per-sort logic centralised here means
// every code path that lists books paginates the same axis as page 1.
const _BOOK_SORT_PIPELINES = {
  // Trending: precomputed by refresh_book_trending_stats() (indexed).
  trending:      (q) => q.order('trending_score', { ascending: false, nullsFirst: false })
                          .order('likes_count',  { ascending: false })
                          .order('created_at',   { ascending: false }),
  recent:        (q) => q.order('published_at', { ascending: false, nullsFirst: false })
                          .order('created_at',  { ascending: false }),
  'most-liked':  (q) => q.order('likes_count', { ascending: false })
                          .order('created_at', { ascending: false }),
  'most-read':   (q) => q.order('views_count', { ascending: false })
                          .order('created_at', { ascending: false }),
  // Completed: filter then sort (likes_count index covers exactly this case).
  completed:     (q) => q.eq('status', 'completed').order('likes_count', { ascending: false }),
  // Editor's Pick: filter then sort by editors_pick_at (indexed).
  'editors-pick':(q) => q.eq('is_editors_pick', true).order('editors_pick_at', { ascending: false, nullsFirst: false }),
  // Just Updated: surfaces ongoing series with recent chapter drops.
  'just-updated':(q) => q.order('updated_at', { ascending: false, nullsFirst: false })
                          .order('created_at', { ascending: false }),
};

// Single fetcher for every browse-style book list. Supports server-side
// sort (via _BOOK_SORT_PIPELINES) and an optional genre filter that matches
// against either the genre column or the tags array.
//
//   fetchSupabaseBooks(0, 12, 'most-liked')                  → top 12 by likes
//   fetchSupabaseBooks(0, 12, 'most-liked', { genre: 'sci-fi' }) → top 12 sci-fi
async function fetchSupabaseBooks(offset = 0, limit = 80, sortBy = bookSortBy, opts = {}) {
  try {
    let q = supabase.from('books').select(BOOK_LIST_SELECT)
      .eq('is_public', true).eq('is_hidden', false);

    // The Completed and Editor's-Pick pipelines apply their own status filter,
    // so only add the public-status filter for the OTHER sorts (otherwise
    // .in('status', [...]) would override .eq('status', 'completed')).
    if (sortBy !== 'completed' && sortBy !== 'editors-pick') {
      q = q.in('status', ['ongoing', 'completed']);
    }

    // Optional genre filter — matches either the dedicated `genre` column or
    // a tag in the `tags` array. Strip anything but [a-z0-9-] defensively so
    // a malformed genre slug can't break the .or() clause.
    if (opts.genre) {
      const safeG = String(opts.genre).toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (safeG) q = q.or(`genre.eq.${safeG},tags.cs.{${safeG}}`);
    }

    // Optional custom predicate — caller-supplied function that adds extra
    // filters before the sort + range are applied. Used by Hidden Gems
    // (low-views + min-likes) and Quick Reads (short chapter count) so
    // those callers don't need their own duplicated query function.
    if (typeof opts.filter === 'function') q = opts.filter(q);

    const pipeline = _BOOK_SORT_PIPELINES[sortBy] || _BOOK_SORT_PIPELINES.trending;
    const { data, error } = await pipeline(q).range(offset, offset + limit - 1);
    if (error) {
      console.error('Supabase books fetch error:', error);
      return [];
    }
    return _normalizeBookRows(data);
  } catch (err) {
    console.error('fetchSupabaseBooks failed:', err);
    return [];
  }
}

// Server-side book search — hits both content (title/description) AND
// matching author usernames. Used as a fallback when the local cache misses
// because pagination only loaded the first 80 books.
async function fetchBooksServerSearch(query) {
  // Sanitize FIRST — strips comma/parens/quotes that break PostgREST .or() —
  // THEN escape ilike wildcards. Without sanitize, queries like `Romeo, Juliet`
  // or `What's next?` returned 0 rows because the OR clause was malformed.
  const safeQ = sanitizeSearchQuery(query);
  if (!safeQ) return { books: [], writers: [] };
  const q = escapeIlike(safeQ);
  try {
    // Two parallel queries: content match + author username match
    const [contentRes, authorRes] = await Promise.all([
      supabase.from('books').select(BOOK_LIST_SELECT)
        .eq('is_public', true).eq('is_hidden', false)
        .in('status', ['ongoing', 'completed'])
        .or(`title.ilike.%${q}%,description.ilike.%${q}%`)
        .limit(40),
      // Find matching author profiles (also surfaced as the YouTube-style writers row)
      supabase.from('profiles')
        .select('id, username, avatar_url, bio, is_banned')
        .ilike('username', `%${q}%`).eq('is_banned', false)
        .limit(8)
    ]);

    let authorBooks = [];
    const matchingWriters = authorRes.data || [];
    if (matchingWriters.length) {
      const ids = matchingWriters.map(p => p.id);
      const { data } = await supabase.from('books').select(BOOK_LIST_SELECT)
        .in('author_id', ids)
        .eq('is_public', true).eq('is_hidden', false)
        .in('status', ['ongoing', 'completed'])
        .limit(40);
      authorBooks = data || [];
    }

    // Merge + dedupe + normalise (drops banned-author rows along the way).
    const seen = new Set();
    const merged = [...(contentRes.data || []), ...authorBooks].filter(b => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });
    const books = _normalizeBookRows(merged);

    // Decorate writers with their book count from the returned set
    const writerStats = new Map();
    for (const b of books) {
      if (!b.author?.id) continue;
      writerStats.set(b.author.id, (writerStats.get(b.author.id) || 0) + 1);
    }
    const writers = matchingWriters.map(p => ({
      id: p.id,
      username: p.username,
      avatar_url: p.avatar_url,
      bio: p.bio || '',
      books_count: writerStats.get(p.id) || 0,
    }));
    return { books, writers };
  } catch (err) {
    console.warn('fetchBooksServerSearch failed:', err);
    return { books: [], writers: [] };
  }
}

// (renderBooks removed — the v2 books page renders into per-tab DOM targets:
// section tracks for For You/Discover/Ranking, a dedicated grid for the
// Reading List collection, and bookSeeAllGrid for the See-All sub-view.)

function renderBookCard(b) {
  const card = document.createElement('button');
  card.className = 'book-card';
  card.dataset.bookId = b.id;
  card.onclick = () => openBookDetail(b.id);

  const authorName = b.author?.username || 'Unknown author';
  const initialLetter = (b.title || '?').trim().charAt(0).toUpperCase();
  const cover = b.cover_url
    ? `<img src="${escHTML(b.cover_url)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=&quot;book-cover-placeholder&quot;>${initialLetter}</div>'"/>`
    : `<div class="book-cover-placeholder">${initialLetter}</div>`;
  const genreLabel = b.genre ? b.genre.replace(/-/g, ' ') : '';

  const editorsPickBadge = b.is_editors_pick
    ? `<div class="book-editors-pick-badge" title="${escHTML(b.editors_pick_note || 'Editor\'s Pick')}">
         <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
         Editor's Pick
       </div>`
    : '';

  card.innerHTML = `
    <div class="book-cover">
      ${cover}
      ${editorsPickBadge}
      <div class="book-stats">
        <span title="Views" data-stat="views">👁 ${formatCompact(b.views_count || 0)}</span>
        <span title="Likes" data-stat="likes">❤ ${formatCompact(b.likes_count || 0)}</span>
      </div>
    </div>
    ${genreLabel ? `<div class="book-card-genre">${escHTML(genreLabel)}</div>` : ''}
    <h3 class="book-card-title">${escHTML(b.title || 'Untitled')}</h3>
    <p class="book-card-author">by ${escHTML(authorName)}</p>
  `;
  return card;
}

// Format a number compactly: 1234 → "1.2k", 1500000 → "1.5M"
function formatCompact(n) {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

// (Old genre-chip + sort-select handlers removed alongside their DOM. The v2
// books page expresses the same intent through tabs and curated sections —
// "trending", "recent", "most-liked" etc. live in _SEE_ALL_MAP for the See-All
// list view.)

// ── Book detail page ──
// Stale-fetch guard so rapid taps (open A → tap B before A loads) don't
// render whichever happens to resolve last. Captures the bookId in a token
// and only renders if it still matches when the queries return.
let _openBookToken = null;
// Set by the boot-time router when the inbound URL was
// /books/<id>/chapter/<n>. Read once the chapter list has loaded so the
// chapter is auto-opened. Cleared after use.
let _pendingChapterFromUrl = null;
async function openBookDetail(bookId) {
  hideAllMainPages();
  bookDetailPage.style.display = 'block';

  // Path-based, shareable, deep-link-friendly URL. Use replaceState when
  // the URL bar already shows the same book (e.g. boot-time inbound) so
  // we don't add a duplicate history entry; pushState otherwise. Either
  // way the result is `/books/<id>`, which mobile's Universal Links /
  // App Links pick up correctly. The legacy hash form (#book/<id>) only
  // appears as an inbound rewrite from old links — once we hit
  // openBookDetail we always upgrade to the canonical path form.
  const targetPath = `/books/${bookId}`;
  const samePath = (location.pathname || '') === targetPath;
  if (samePath) {
    history.replaceState(null, '', targetPath);
  } else {
    history.pushState(null, '', targetPath);
  }

  const content = document.getElementById('bookDetailContent');
  content.innerHTML = '<div class="loading">Loading book...</div>';

  // Only the LATEST openBookDetail call gets to render. Earlier ones bail
  // when their token no longer matches — fixes the "open A, tap B quickly,
  // see A's cover with B's chapters" race.
  const token = bookId;
  _openBookToken = token;

  // All books are now Supabase. Bare UUID or "sb_<uuid>" — strip the prefix if present.
  const realId = bookId.startsWith('sb_') ? bookId.slice(3) : bookId;

  // Detect ID shape — Supabase UUIDs are 36 chars with dashes
  // (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx); Appwrite hex IDs are 20 hex
  // chars with no dashes. Mobile users share Appwrite-shaped IDs via
  // WhatsApp/SMS because the mobile app still has books on Appwrite.
  // Web migrated books to Supabase but kept legacy_appwrite_id, so we
  // query the right column for whichever shape we see.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(realId);
  const bookFilterColumn = isUuid ? 'id' : 'legacy_appwrite_id';

  let supBook, supChapters;
  try {
    const bookRes = await supabase.from('books')
      .select(`
        id, title, description, cover_url, genre, tags,
        views_count, likes_count, chapters_count, word_count, status,
        published_at, created_at, lock_from_chapter, locked_at,
        author_id, profiles!books_author_id_fkey ( id, username, avatar_url )
      `)
      .eq(bookFilterColumn, realId)
      .single();
    if (bookRes.error || !bookRes.data) throw new Error(bookRes.error?.message || 'Book not found');
    supBook = bookRes.data;

    // Chapters are always keyed by the book's Supabase UUID, regardless
    // of which shape we used to find the book.
    const chRes = await supabase.from('chapters')
      .select('id, chapter_number, title, word_count, views_count, is_published, is_locked, unlock_cost_coins, unlock_cost_stars, created_at')
      .eq('book_id', supBook.id)
      .eq('is_published', true)
      .order('chapter_number', { ascending: true });
    if (chRes.error) console.warn('Failed to load chapters:', chRes.error);
    supChapters = chRes.data;
  } catch (err) {
    if (_openBookToken !== token) return; // user already tapped a different book
    console.error('openBookDetail failed:', err);
    const friendly = /timeout|canceling statement/i.test(err.message || '')
      ? 'This book is taking too long to load. Tap to retry.'
      : /not found/i.test(err.message || '')
      ? 'This book isn\'t available — it may have been unpublished.'
      : 'Couldn\'t load this book. Tap to retry.';
    content.innerHTML = `<div class="loading" id="bookRetry" style="cursor:pointer">${escHTML(friendly)}</div>`;
    document.getElementById('bookRetry')?.addEventListener('click', () => openBookDetail(bookId));
    return;
  }

  if (_openBookToken !== token) return; // stale — user tapped a different book

  currentBookDetail = { book: supBook, chapters: supChapters || [] };
  renderBookDetail();
}

function renderBookDetail() {
  if (!currentBookDetail) return;
  const { book, chapters } = currentBookDetail;
  const content = document.getElementById('bookDetailContent');

  const authorName = book.profiles?.username || 'Unknown';
  const authorAvatar = book.profiles?.avatar_url;
  const initialLetter = (book.title || '?').trim().charAt(0).toUpperCase();
  const cover = book.cover_url
    ? `<img src="${escHTML(book.cover_url)}" alt=""/>`
    : `<div class="book-cover-placeholder" style="width:100%;height:100%">${initialLetter}</div>`;

  const tagsHtml = (book.tags || []).map(t =>
    `<button class="book-chip" data-tag="${escHTML(t)}" type="button">${escHTML(t)}</button>`
  ).join('');

  // Single-source lock-detection helper. Used by both the per-row lock badge
  // AND the bulk-unlock CTA cost calculation, so the row icons and the
  // "Unlock all N chapters" count CANNOT diverge by construction. Two-signal
  // logic mirrors mobile's BookUnlocksService.isChapterLockedForDisplay:
  //
  //   • Book-level threshold: book.lock_from_chapter is set AND
  //     chapter.chapter_number >= lock_from_chapter
  //   • Per-chapter override:  chapter.is_locked === true
  //
  // …minus already-unlocked chapters (the user has already paid for them, no
  // lock should display). No owner-bypass here — author + reader both see
  // locks, matching what mobile now does too.
  const lockFrom = book.lock_from_chapter || null;
  const isChapterLockedForReader = (c) => {
    if (!lockFrom && !c.is_locked) return false;
    const isAtOrAfterLockPoint = lockFrom != null && c.chapter_number >= lockFrom;
    if (!isAtOrAfterLockPoint && !c.is_locked) return false;
    const realId = c.id.startsWith('sb_') ? c.id.slice(3) : c.id;
    return !isUnlocked('chapter', realId);
  };

  const stillLockedChapters = chapters.filter(isChapterLockedForReader);
  const lockedChapterCount = stillLockedChapters.length;

  const chaptersHtml = chapters.length
    ? chapters.map(c => {
        const locked = isChapterLockedForReader(c);
        const lockBadge = locked
          ? `<span class="chapter-row-lock" title="Locked — tap to unlock">
               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
             </span>`
          : '';
        return `
          <div class="chapter-row${locked ? ' is-locked' : ''}" data-chapter-id="${c.id}">
            <span class="chapter-row-num">#${c.chapter_number}</span>
            <span class="chapter-row-title">${escHTML(c.title || `#${c.chapter_number}`)}</span>
            ${lockBadge}
            <span class="chapter-row-meta">${(c.word_count || 0).toLocaleString()} words</span>
          </div>
        `;
      }).join('')
    : '<div style="color:var(--text2);padding:1rem 0">No chapters published yet.</div>';

  // Bulk unlock CTA — shown only when at least 1 chapter is currently locked.
  //
  // Cost is the SUM of each still-locked chapter's resolved price (per-chapter
  // override OR global default), then the bulk discount applied. This mirrors
  // what mobile does in BookChaptersUnlockModal.jsx (sumLockedChaptersCost).
  // The previous implementation multiplied the global default by lockedChapterCount,
  // which ignored the per-chapter overrides entirely — an author who set
  // 3 coins per chapter saw a bulk price computed off the 25-coin global default.
  const bulkDiscount = _walletConfigDefaults.book_bulk_unlock_discount_pct ?? 15;
  const bulkBefore = stillLockedChapters.reduce(
    (sum, c) => sum + (resolveUnlockCost('chapter', 'coin', c) || 0),
    0,
  );
  const bulkStarBefore = stillLockedChapters.reduce(
    (sum, c) => sum + (resolveUnlockCost('chapter', 'star', c) || 0),
    0,
  );
  const bulkCoin = Math.max(1, bulkBefore - Math.floor((bulkBefore * bulkDiscount) / 100));
  const bulkStar = Math.max(1, bulkStarBefore - Math.floor((bulkStarBefore * bulkDiscount) / 100));
  const bulkUnlockCard = lockedChapterCount > 0 ? `
    <div class="book-bulk-unlock">
      <div class="book-bulk-unlock-icon">📚</div>
      <div class="book-bulk-unlock-meta">
        <div class="book-bulk-unlock-title">Unlock all <strong>${lockedChapterCount}</strong> locked chapter${lockedChapterCount === 1 ? '' : 's'}</div>
        <div class="book-bulk-unlock-sub">Save ${bulkDiscount}% vs unlocking one by one</div>
      </div>
      <button class="btn btn-purple" id="btnBulkUnlockBook" data-locked-count="${lockedChapterCount}" data-coin="${bulkCoin}" data-star="${bulkStar}">
        ${bulkCoin} coin${bulkCoin === 1 ? '' : 's'} or ${bulkStar} star${bulkStar === 1 ? '' : 's'}
      </button>
    </div>
  ` : '';

  content.innerHTML = `
    <div class="book-detail">
      <div class="book-detail-cover">${cover}</div>
      <div class="book-detail-info">
        <h1>${escHTML(book.title || 'Untitled')}</h1>
        <button class="book-detail-author book-detail-author-link" data-author-id="${escHTML(book.profiles?.id || book.author_id || '')}" type="button" title="View author profile">
          <div class="avatar">${authorAvatar ? `<img src="${escHTML(authorAvatar)}"/>` : initials(authorName)}</div>
          <span>by <strong>${escHTML(authorName)}</strong></span>
        </button>
        <div class="book-detail-meta">
          <span><strong>${(book.chapters_count || chapters.length).toLocaleString()}</strong> chapters</span>
          <span><strong>${(book.word_count || 0).toLocaleString()}</strong> words</span>
          <span><strong>${(book.views_count || 0).toLocaleString()}</strong> views</span>
          <span><strong>${(book.likes_count || 0).toLocaleString()}</strong> likes</span>
        </div>
        <div class="book-detail-genre-row">
          ${book.genre ? `<button class="book-chip active" type="button">${escHTML(book.genre.replace(/-/g, ' '))}</button>` : ''}
          ${tagsHtml}
        </div>
        <div class="book-detail-actions">
          <button class="btn btn-purple btn-sm" id="btnStartReading" ${chapters.length ? '' : 'disabled style="opacity:0.5;cursor:not-allowed"'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Start reading
          </button>
          <button class="btn btn-ghost btn-sm book-action-btn" id="btnLikeBook" data-active="0">
            <svg class="book-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <span class="book-action-label">Like</span>
            <span class="book-action-count" id="btnLikeBookCount">${(book.likes_count || 0).toLocaleString()}</span>
          </button>
          <button class="btn btn-ghost btn-sm book-action-btn" id="btnBookmarkBook" data-active="0">
            <svg class="book-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
            <span class="book-action-label">Bookmark</span>
          </button>
          ${(currentProfile?.role === 'admin' || currentProfile?.role === 'moderator') ? `
            <button class="btn btn-sm book-action-btn book-editors-pick-btn ${book.is_editors_pick ? 'is-picked' : ''}" id="btnEditorsPick" data-picked="${book.is_editors_pick ? '1' : '0'}" title="${book.is_editors_pick ? "Remove Editor's Pick" : "Mark as Editor's Pick"}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="${book.is_editors_pick ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
              <span class="book-action-label">${book.is_editors_pick ? "Editor's Pick" : 'Pick'}</span>
            </button>
          ` : ''}
        </div>
        <div class="book-detail-description">${escHTML(book.description || 'No description provided.')}</div>
        ${bulkUnlockCard}
        <div class="chapter-list">
          <div class="chapter-list-title">Chapters</div>
          ${chaptersHtml}
        </div>
      </div>
    </div>
  `;

  // Sanity check: the count of `.chapter-row.is-locked` DOM nodes must
  // equal `lockedChapterCount` (the number used by the bulk-unlock CTA).
  // If the two ever disagree, the bulk button will charge for a different
  // set of chapters than the user can see locked — exactly the kind of
  // bug we just fixed (and want a guard against re-introducing).
  //
  // We log a console warning rather than throwing so a divergence in
  // production surfaces in dev tools without breaking the user's flow.
  // The `_walletConfigDefaults` and lock detection both live in this
  // function, so any future logic change touching either will be caught
  // here on the next render.
  const renderedLockCount = content.querySelectorAll('.chapter-row.is-locked').length;
  if (renderedLockCount !== lockedChapterCount) {
    console.warn(
      `[lock-count-mismatch] book ${book.id}: rendered ${renderedLockCount} lock icons but bulk CTA says ${lockedChapterCount}. ` +
      `Lock detection has diverged between row render and stillLockedChapters filter — check isChapterLockedForReader callers.`
    );
  }

  // Wire chapter rows
  content.querySelectorAll('.chapter-row').forEach((row, i) => {
    row.addEventListener('click', () => openChapterReader(i));
  });

  // Wire clickable author → opens their profile
  content.querySelector('.book-detail-author-link')?.addEventListener('click', (e) => {
    const authorId = e.currentTarget.dataset.authorId;
    if (authorId) openProfile(authorId);
  });

  // Bulk-unlock button — opens a modal with coin/star choice + final price
  document.getElementById('btnBulkUnlockBook')?.addEventListener('click', () => {
    openBulkBookUnlockDialog({
      bookId:        book.id,
      bookTitle:     book.title || 'this book',
      lockedCount:   parseInt(document.getElementById('btnBulkUnlockBook').dataset.lockedCount, 10) || lockedChapterCount,
      coinCost:      parseInt(document.getElementById('btnBulkUnlockBook').dataset.coin, 10) || bulkCoin,
      starCost:      parseInt(document.getElementById('btnBulkUnlockBook').dataset.star, 10) || bulkStar,
      discountPct:   bulkDiscount,
      onUnlocked:    () => openBookDetail(book.id),
    });
  });
  // Start reading → first unread chapter (or chapter 1)
  document.getElementById('btnStartReading')?.addEventListener('click', () => openChapterReader(0));

  // Wire like + bookmark
  const likeBtn = document.getElementById('btnLikeBook');
  const bookmarkBtn = document.getElementById('btnBookmarkBook');
  likeBtn?.addEventListener('click', () => toggleBookLike(book.id));
  bookmarkBtn?.addEventListener('click', () => toggleBookBookmark(book.id));

  // Editor's Pick toggle (mods/admins only — button is gated server-side too)
  document.getElementById('btnEditorsPick')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const currentlyPicked = btn.dataset.picked === '1';
    const willPick = !currentlyPicked;
    btn.disabled = true;
    let note = null;
    if (willPick) {
      // Optional editorial note — short blurb that shows up in tooltips/lists
      note = prompt('Optional — short editorial note (why is this an Editor\'s Pick?):', '') || null;
    }
    try {
      const { data, error } = await supabase.rpc('set_editors_pick', {
        p_book_id: book.id,
        p_pick: willPick,
        p_note: note,
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Failed to update Editor\'s Pick');
      // Update UI inline
      btn.dataset.picked = willPick ? '1' : '0';
      btn.classList.toggle('is-picked', willPick);
      btn.querySelector('.book-action-label').textContent = willPick ? "Editor's Pick" : 'Pick';
      btn.querySelector('svg').setAttribute('fill', willPick ? 'currentColor' : 'none');
      btn.title = willPick ? "Remove Editor's Pick" : "Mark as Editor's Pick";
      // Mutate cached book so re-renders stay in sync
      if (currentBookDetail?.book) {
        currentBookDetail.book.is_editors_pick = willPick;
        currentBookDetail.book.editors_pick_at = willPick ? new Date().toISOString() : null;
        currentBookDetail.book.editors_pick_note = willPick ? note : null;
      }
      toast(willPick ? 'Marked as Editor\'s Pick ⭐' : 'Removed from Editor\'s Pick', 'success');
    } catch (err) {
      toast(err.message || String(err), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Load initial state (whether the user has already liked/bookmarked)
  loadBookActionState(book.id);
}

// ────────────────────────────────────────────────────────────────────────
// Load initial like/bookmark state for the current book + render visual
// ────────────────────────────────────────────────────────────────────────
async function loadBookActionState(bookId) {
  if (!currentUser) return;
  try {
    const [{ data: like }, { data: bm }] = await Promise.all([
      supabase.from('book_likes').select('book_id').eq('user_id', currentUser.id).eq('book_id', bookId).maybeSingle(),
      supabase.from('book_bookmarks').select('book_id').eq('user_id', currentUser.id).eq('book_id', bookId).maybeSingle(),
    ]);
    setBookActionActive('btnLikeBook',     !!like);
    setBookActionActive('btnBookmarkBook', !!bm);
  } catch (e) { /* non-fatal */ }
}

function setBookActionActive(buttonId, active) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  btn.dataset.active = active ? '1' : '0';
  // Fill the SVG icon when active (heart filled, bookmark filled)
  const icon = btn.querySelector('.book-action-icon');
  if (icon) icon.setAttribute('fill', active ? 'currentColor' : 'none');
  // Update label
  const label = btn.querySelector('.book-action-label');
  if (label) {
    if (buttonId === 'btnLikeBook')      label.textContent = active ? 'Liked' : 'Like';
    if (buttonId === 'btnBookmarkBook')  label.textContent = active ? 'Saved' : 'Bookmark';
  }
}

async function toggleBookLike(bookId) {
  if (!currentUser) { toast('Sign in to like books', 'error'); return; }
  const btn  = document.getElementById('btnLikeBook');
  const wasActive = btn?.dataset.active === '1';
  const countEl   = document.getElementById('btnLikeBookCount');

  // Optimistic UI — flip immediately
  setBookActionActive('btnLikeBook', !wasActive);
  if (countEl) {
    const cur = parseInt(countEl.textContent.replace(/[^\d]/g, ''), 10) || 0;
    const next = wasActive ? Math.max(0, cur - 1) : cur + 1;
    countEl.textContent = next.toLocaleString();
    if (currentBookDetail?.book) currentBookDetail.book.likes_count = next;
  }

  try {
    if (wasActive) {
      const { error } = await supabase.from('book_likes')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('book_id', bookId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('book_likes')
        .insert({ user_id: currentUser.id, book_id: bookId });
      // Ignore duplicate-key (already liked from another tab); other errors throw
      if (error && !/duplicate|unique/i.test(error.message)) throw error;
    }
  } catch (e) {
    // Revert optimistic UI on error
    setBookActionActive('btnLikeBook', wasActive);
    if (countEl) {
      const cur = parseInt(countEl.textContent.replace(/[^\d]/g, ''), 10) || 0;
      countEl.textContent = (wasActive ? cur + 1 : Math.max(0, cur - 1)).toLocaleString();
    }
    toast('Failed: ' + (e.message || e), 'error');
  }
}

async function toggleBookBookmark(bookId) {
  if (!currentUser) { toast('Sign in to bookmark books', 'error'); return; }
  const btn = document.getElementById('btnBookmarkBook');
  const wasActive = btn?.dataset.active === '1';

  // Optimistic UI
  setBookActionActive('btnBookmarkBook', !wasActive);

  try {
    if (wasActive) {
      const { error } = await supabase.from('book_bookmarks')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('book_id', bookId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('book_bookmarks')
        .insert({ user_id: currentUser.id, book_id: bookId });
      if (error && !/duplicate|unique/i.test(error.message)) throw error;
    }
  } catch (e) {
    setBookActionActive('btnBookmarkBook', wasActive);
    toast('Failed: ' + (e.message || e), 'error');
  }
}

// Back to book list
document.getElementById('btnBackBooks')?.addEventListener('click', () => showBook());

// ── Chapter reader ──
async function openChapterReader(chapterIndex) {
  if (!currentBookDetail || !currentBookDetail.chapters[chapterIndex]) return;
  currentChapterIndex = chapterIndex;
  const chapter = currentBookDetail.chapters[chapterIndex];

  hideAllMainPages();
  chapterReaderPage.style.display = 'block';

  document.getElementById('readerBookTitle').textContent = currentBookDetail.book.title || 'Book';
  document.getElementById('readerChapterTitle').textContent = chapter.title || `Chapter ${chapter.chapter_number}`;
  document.getElementById('readerProgress').textContent = `Chapter ${chapter.chapter_number} of ${currentBookDetail.chapters.length}`;
  document.getElementById('btnReaderPrev').disabled = chapterIndex <= 0;
  document.getElementById('btnReaderNext').disabled = chapterIndex >= currentBookDetail.chapters.length - 1;

  // Path-based deep-link-friendly chapter URL — keeps mobile Universal
  // Links / App Links able to pick this URL up if shared.
  history.pushState(null, '', `/books/${currentBookDetail.book.id}/chapter/${chapter.chapter_number}`);

  const content = document.getElementById('readerContent');
  content.innerHTML = '<div class="loading">Loading chapter...</div>';

  // Fetch full chapter content + lock fields from the right source
  let chapterContent = '';
  let resolvedChapterId = chapter.id;
  let chapterRow = null;
  try {
    const realChapterId = chapter.id.startsWith('sb_') ? chapter.id.slice(3) : chapter.id;
    const { data, error } = await supabase
      .from('chapters')
      .select('id, chapter_number, title, content, is_locked, unlock_cost_coins, unlock_cost_stars')
      .eq('id', realChapterId)
      .single();
    if (error || !data) throw new Error(error?.message || 'Chapter not found');
    chapterContent = data.content || '';
    resolvedChapterId = data.id;
    chapterRow = data;
  } catch (err) {
    console.error('openChapterReader failed:', err);
    const friendly = /timeout|canceling statement/i.test(err.message || '')
      ? 'This chapter is taking too long to load. Tap to retry.'
      : /not found/i.test(err.message || '')
      ? 'This chapter isn\'t available — it may have been unpublished.'
      : 'Couldn\'t load this chapter. Tap to retry.';
    content.innerHTML = `<div class="loading" id="chapterRetry" style="cursor:pointer">${escHTML(friendly)}</div>`;
    document.getElementById('chapterRetry')?.addEventListener('click', () => openChapterReader(chapterIndex));
    return;
  }

  // PAYWALL: locked + not unlocked → render the lock CTA instead of content.
  //
  // Two-signal lock check, matching the row-rendering logic above and mobile's
  // isAuthorChapterLocked / isChapterLocked helpers. A chapter is locked when:
  //   • chapter.is_locked === true (per-chapter explicit override), OR
  //   • book.lock_from_chapter is set AND chapter_number >= lock_from_chapter
  //     (book-level paywall threshold cascade).
  //
  // The previous version only honored chapter.is_locked, so any chapter that
  // was only locked via the book-level threshold (the common case for writers
  // using the picker) silently rendered for free even though the TOC row
  // showed a lock badge — a real revenue-leak bug.
  const bookLockFrom = currentBookDetail?.book?.lock_from_chapter;
  const isThresholdLocked = bookLockFrom != null && Number(chapterRow.chapter_number) >= Number(bookLockFrom);
  const chapterIsLocked = !!chapterRow.is_locked || isThresholdLocked;
  if (chapterIsLocked && !isUnlocked('chapter', resolvedChapterId)) {
    const coinCost = resolveUnlockCost('chapter', 'coin', chapterRow);
    const starCost = resolveUnlockCost('chapter', 'star', chapterRow);
    content.style.fontSize = '';
    content.innerHTML = `
      <div class="reader-paywall">
        <div class="reader-paywall-icon">🔒</div>
        <h2>This chapter is locked</h2>
        <p>Unlock once to read as many times as you like.</p>
        <div class="reader-paywall-pricing">
          <span><b>${coinCost}</b> coin${coinCost === 1 ? '' : 's'}</span>
          <span class="reader-paywall-or">or</span>
          <span><b>${starCost}</b> star${starCost === 1 ? '' : 's'}</span>
        </div>
        <button class="btn btn-purple" id="btnReaderUnlock">Unlock chapter</button>
      </div>
    `;
    document.getElementById('btnReaderUnlock')?.addEventListener('click', () => {
      openUnlockDialog({
        targetType: 'chapter',
        targetId:   resolvedChapterId,
        row:        chapterRow,
        title:      chapterRow.title || `Chapter ${chapterRow.chapter_number}`,
        onUnlocked: () => openChapterReader(chapterIndex),  // re-open after unlock
      });
    });
    return;
  }

  // Apply current font size and inject normalized content (HTML or plain text)
  content.style.fontSize = `${readerFontSize}rem`;
  content.innerHTML = normalizeChapterContent(chapterContent);
  content.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Apply username watermark (re-run in case the user logged in/out since last read)
  applyReaderWatermark();

  saveReadingProgress(currentBookDetail.book.id, resolvedChapterId, chapter.chapter_number);
}

// Normalize chapter content: if HTML-ish, render as-is; if plain text, wrap in <p>
function normalizeChapterContent(content) {
  if (!content) return '<p><em>(No content)</em></p>';
  // Detect common HTML tags to decide
  if (/<\/?(p|div|br|h[1-6]|blockquote|ul|ol|li|strong|em|b|i|a|img|span)\b/i.test(content)) {
    return content;
  }
  // Treat as plain text — split by blank lines into paragraphs, preserve single newlines as <br>
  return content
    .split(/\n\s*\n/)
    .filter(p => p.trim())
    .map(p => `<p>${escHTML(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

async function saveReadingProgress(bookId, chapterId, chapterNumber) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from('book_reads').upsert({
      user_id: user.id,
      book_id: bookId,
      last_chapter_id: chapterId,
      last_chapter_number: chapterNumber,
      last_read_at: new Date().toISOString(),
    }, { onConflict: 'user_id,book_id' });
  } catch (e) { /* ignore */ }
}

// ── Reader watermark (deterrent: leaked screenshots reveal the source) ──
let _watermarkLabelCache = null;
async function getReaderWatermarkLabel() {
  if (_watermarkLabelCache) return _watermarkLabelCache;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { _watermarkLabelCache = 'Guest'; return _watermarkLabelCache; }
    // Try profile.username, then email local part, then user id prefix
    const { data: profile } = await supabase
      .from('profiles').select('username').eq('id', user.id).maybeSingle();
    const username = profile?.username
      || (user.email ? user.email.split('@')[0] : null)
      || (user.id ? user.id.slice(0, 8) : 'User');
    _watermarkLabelCache = `${username} · ${(user.id || '').slice(0, 6)}`;
  } catch {
    _watermarkLabelCache = 'Reader';
  }
  return _watermarkLabelCache;
}

async function applyReaderWatermark() {
  const el = document.getElementById('readerContent');
  if (!el) return;
  const label = await getReaderWatermarkLabel();
  const isLight = document.body.classList.contains('light');
  const fillColor = isLight ? '%237c3aed' : '%23a78bfa'; // %23 = encoded "#"
  // Encode for safe data URI use
  const safeLabel = String(label).replace(/[<>&'"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' }[c]));
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">' +
      '<text x="160" y="100" text-anchor="middle"' +
        ' transform="rotate(-25 160 100)"' +
        ` fill="${isLight ? '#7c3aed' : '#a78bfa'}" fill-opacity="0.09"` +
        ' font-family="system-ui, -apple-system, sans-serif"' +
        ' font-size="13" font-weight="500" letter-spacing="0.04em">' +
        safeLabel +
      '</text>' +
    '</svg>';
  const dataUri = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  el.style.setProperty('--reader-watermark-bg', dataUri);
}

// Re-render watermark when theme toggles (so colour matches background)
document.getElementById('btnTheme')?.addEventListener('click', () => {
  // Run after the body class actually flips
  setTimeout(() => {
    if (chapterReaderPage?.style.display === 'block') applyReaderWatermark();
  }, 50);
});

// ── Anti-copy protection on the reader ──
// Discourages casual copy-paste. Not bulletproof against DevTools/view-source,
// but blocks selection, right-click, and Cmd/Ctrl+C / Cmd/Ctrl+A inside the reader.
(function setupReaderAntiCopy() {
  const el = document.getElementById('readerContent');
  if (!el) return;

  const isReaderVisible = () =>
    chapterReaderPage && chapterReaderPage.style.display === 'block';

  let antiCopyToastTimer = null;
  const showAntiCopyToast = () => {
    if (antiCopyToastTimer) return;          // throttle so we don't spam
    toast('Copying is disabled to protect the author\'s work', 'error');
    antiCopyToastTimer = setTimeout(() => { antiCopyToastTimer = null; }, 1500);
  };

  // Block selection-start (covers click-and-drag)
  el.addEventListener('selectstart', (e) => {
    e.preventDefault();
    return false;
  });

  // Block native copy (Cmd/Ctrl+C, right-click → Copy)
  el.addEventListener('copy', (e) => {
    e.preventDefault();
    e.clipboardData?.setData('text/plain', '');
    showAntiCopyToast();
    return false;
  });

  // Block cut + paste too, just in case the reader ever becomes editable somehow
  el.addEventListener('cut', (e) => { e.preventDefault(); return false; });

  // Block right-click context menu inside the reader
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showAntiCopyToast();
    return false;
  });

  // Block drag (so users can't drag-out a text fragment)
  el.addEventListener('dragstart', (e) => { e.preventDefault(); return false; });

  // Block Cmd/Ctrl+A so a user can't quickly select-all then copy
  document.addEventListener('keydown', (e) => {
    if (!isReaderVisible()) return;
    const isMod = e.metaKey || e.ctrlKey;
    if (!isMod) return;
    const k = e.key.toLowerCase();
    if (k === 'a' || k === 'c' || k === 'x') {
      // Only block if the focus is in/over the reader content, not in form inputs
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      e.preventDefault();
      showAntiCopyToast();
    }
  });
})();

// Reader controls
document.getElementById('btnReaderPrev')?.addEventListener('click', () => {
  if (currentChapterIndex > 0) openChapterReader(currentChapterIndex - 1);
});
document.getElementById('btnReaderNext')?.addEventListener('click', () => {
  if (currentBookDetail && currentChapterIndex < currentBookDetail.chapters.length - 1) {
    openChapterReader(currentChapterIndex + 1);
  }
});
document.getElementById('btnBackBookDetail')?.addEventListener('click', () => {
  if (currentBookDetail) openBookDetail(currentBookDetail.book.id);
});
document.getElementById('btnReaderFontSmaller')?.addEventListener('click', () => {
  readerFontSize = Math.max(0.85, readerFontSize - 0.05);
  localStorage.setItem('selebox_reader_font', readerFontSize);
  document.getElementById('readerContent').style.fontSize = `${readerFontSize}rem`;
});
document.getElementById('btnReaderFontLarger')?.addEventListener('click', () => {
  readerFontSize = Math.min(1.6, readerFontSize + 0.05);
  localStorage.setItem('selebox_reader_font', readerFontSize);
  document.getElementById('readerContent').style.fontSize = `${readerFontSize}rem`;
});

// ── Author (Manuscript Studio) page ──
function showAuthor(forceReload = false) {
  hideAllMainPages();
  authorPage.style.display = 'block';
  setAuthorView('dashboard');
  document.body.classList.remove('on-videos');
  stopVideoPlayer();
  history.pushState(null, '', '#author');
  // Author dashboard shows their books — reload on first visit, or after
  // 60 seconds for freshness. Quick tab-flicks reuse the rendered DOM.
  const now = Date.now();
  const stale = !window._authorLoadedAt || (now - window._authorLoadedAt) > 60_000;
  if (forceReload || stale) {
    loadAuthorDashboard();
    window._authorLoadedAt = now;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// VIDEO PLAYER — premium nav controls (prev / rewind / fast-forward / next + autoplay)
// ════════════════════════════════════════════════════════════════════════════
const _videoHistoryStack = [];          // IDs of videos we've watched, for the "Previous" button
const SKIP_SECONDS = 10;
const AUTONEXT_KEY = 'selebox_video_autonext';

function _currentVideoIdForRoute() {
  if (!_currentVideoCtx) return null;
  return _currentVideoCtx.supabaseId ? 'sb_' + _currentVideoCtx.supabaseId : null;
}

function vcRewind() {
  const v = document.getElementById('videoPlayer');
  if (!v) return;
  v.currentTime = Math.max(0, (v.currentTime || 0) - SKIP_SECONDS);
  _flashSkipBadge('back');
}

function vcFastForward() {
  const v = document.getElementById('videoPlayer');
  if (!v) return;
  const dur = isFinite(v.duration) ? v.duration : 0;
  v.currentTime = Math.min(dur || (v.currentTime + SKIP_SECONDS), (v.currentTime || 0) + SKIP_SECONDS);
  _flashSkipBadge('forward');
}

function _flashSkipBadge(direction) {
  const el = document.querySelector(direction === 'back' ? '#vcRewind' : '#vcFastForward');
  if (!el) return;
  el.classList.add('vc-flash');
  setTimeout(() => el.classList.remove('vc-flash'), 360);
}

function vcPrev() {
  const prevId = _videoHistoryStack.pop();
  if (!prevId) { toast('No previous video', 'error'); return; }
  // Don't push current onto history — that would create a loop
  playVideo(prevId);
}

function vcNext() {
  const list = document.getElementById('upNextList');
  const firstItem = list?.querySelector('.upnext-item');
  if (!firstItem) { toast('No related video to play next', 'error'); return; }
  // Push current onto history before navigating
  const cur = _currentVideoIdForRoute();
  if (cur) _videoHistoryStack.push(cur);
  firstItem.click(); // existing handler calls playVideo(video.$id)
}

function vcInitControls() {
  // Wire buttons (idempotent — won't re-bind)
  const wire = (id, fn) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', fn);
  };
  wire('vcRewind',      vcRewind);
  wire('vcFastForward', vcFastForward);
  wire('vcPrev',        vcPrev);
  wire('vcNext',        vcNext);

  // Autoplay toggle — restore from localStorage
  const autoEl = document.getElementById('vcAutoNext');
  if (autoEl && autoEl.dataset.bound !== '1') {
    autoEl.dataset.bound = '1';
    autoEl.checked = localStorage.getItem(AUTONEXT_KEY) !== '0';  // default ON
    autoEl.addEventListener('change', (e) => {
      localStorage.setItem(AUTONEXT_KEY, e.target.checked ? '1' : '0');
    });
  }

  // Hook into the video element's `ended` event for auto-next
  const video = document.getElementById('videoPlayer');
  if (video && video.dataset.autoNextBound !== '1') {
    video.dataset.autoNextBound = '1';
    video.addEventListener('ended', () => {
      const auto = document.getElementById('vcAutoNext');
      if (auto?.checked) vcNext();
    });
  }

  // Keyboard shortcuts (only when video page is visible and not typing in input/textarea)
  if (!window._videoKbBound) {
    window._videoKbBound = true;
    document.addEventListener('keydown', (e) => {
      const playerVisible = document.getElementById('videoPlayerPage')?.style.display === 'block';
      if (!playerVisible) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); vcRewind(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); vcFastForward(); }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); vcNext(); }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); vcPrev(); }
    });
  }
}
// Init when DOM is ready
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', vcInitControls);
else vcInitControls();

// ════════════════════════════════════════════════════════════════════════════
// BOOKMARKS — saved videos + saved books for the current user
// (bookmarksPage const hoisted with other page consts at top — see line ~2489)
// ════════════════════════════════════════════════════════════════════════════
let _bookmarksActiveTab = 'videos';

function showBookmarks(forceReload = false) {
  hideAllMainPages();
  if (bookmarksPage) bookmarksPage.style.display = 'block';
  document.body.classList.remove('on-videos');
  stopVideoPlayer();
  history.pushState(null, '', '#bookmarks');
  // Reload on first visit or after 60 seconds (bookmarks change rarely
  // but the user expects them to be current).
  const now = Date.now();
  const stale = !window._bookmarksLoadedAt || (now - window._bookmarksLoadedAt) > 60_000;
  if (forceReload || stale) {
    loadBookmarks();
    window._bookmarksLoadedAt = now;
  }
}

async function loadBookmarks() {
  if (!currentUser) {
    document.getElementById('bookmarksContent').innerHTML = `
      <div class="bookmarks-empty">
        <p>Sign in to see your saved videos and books.</p>
      </div>
    `;
    return;
  }

  // Pre-load both counts so the tab badges show instantly
  const [vidCountRes, bookCountRes] = await Promise.all([
    supabase.from('video_bookmarks').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.id),
    supabase.from('book_bookmarks').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.id),
  ]);
  document.getElementById('bookmarkVideoCount').textContent = vidCountRes.count != null ? vidCountRes.count : '';
  document.getElementById('bookmarkBookCount').textContent  = bookCountRes.count != null ? bookCountRes.count : '';

  if (_bookmarksActiveTab === 'videos') await loadVideoBookmarks();
  else                                  await loadBookBookmarks();
}

async function loadVideoBookmarks() {
  const wrap = document.getElementById('bookmarksContent');
  wrap.innerHTML = '<div class="loading">Loading saved videos…</div>';
  const { data, error } = await supabase
    .from('video_bookmarks')
    .select(`
      created_at,
      videos (
        id, bunny_video_id, title, description, tags, video_url, thumbnail_url,
        views, duration, created_at, uploader_id,
        profiles!videos_uploader_id_fkey ( id, username, avatar_url )
      )
    `)
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  if (error) { wrap.innerHTML = `<div class="bookmarks-empty"><p>${escHTML(error.message)}</p></div>`; return; }

  const items = (data || []).filter(r => r.videos);
  if (!items.length) {
    wrap.innerHTML = `
      <div class="bookmarks-empty">
        <div class="bookmarks-empty-icon">🎬</div>
        <h3>No saved videos yet</h3>
        <p>Tap the <strong>Bookmark</strong> button on any video to save it here.</p>
        <button class="btn btn-purple btn-sm" onclick="setSidebarActive('btnVideos');showVideos();">Browse videos</button>
      </div>`;
    return;
  }

  wrap.innerHTML = `<div class="video-grid bookmarks-video-grid"></div>`;
  const grid = wrap.querySelector('.bookmarks-video-grid');
  for (const row of items) {
    const v = row.videos;
    const card = document.createElement('div');
    card.className = 'video-card';
    card.onclick = () => playVideo('sb_' + v.id);
    const name = v.profiles?.username || 'Unknown';
    const avatar = v.profiles?.avatar_url ? `<img src="${escHTML(v.profiles.avatar_url)}" alt=""/>` : initials(name);
    card.innerHTML = `
      <div class="video-thumb">
        ${v.thumbnail_url ? `<img src="${escHTML(v.thumbnail_url)}" loading="lazy"/>` : '<div class="video-thumb-placeholder">▶</div>'}
        ${v.duration ? `<span class="video-duration">${formatDuration(v.duration)}</span>` : ''}
      </div>
      <div class="video-card-meta">
        <div class="avatar">${avatar}</div>
        <div style="min-width:0;flex:1">
          <div class="video-card-title">${escHTML(v.title || 'Untitled')}</div>
          <div class="video-card-uploader">${escHTML(name)}</div>
          <div class="video-card-stats">${(v.views || 0).toLocaleString()} views</div>
        </div>
      </div>
    `;
    grid.appendChild(card);
  }
}

async function loadBookBookmarks() {
  const wrap = document.getElementById('bookmarksContent');
  wrap.innerHTML = '<div class="loading">Loading saved books…</div>';
  const { data, error } = await supabase
    .from('book_bookmarks')
    .select(`
      created_at,
      books (
        id, title, cover_url, genre, tags,
        views_count, likes_count, chapters_count, word_count,
        author_id, created_at,
        profiles!books_author_id_fkey ( id, username, avatar_url )
      )
    `)
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  if (error) { wrap.innerHTML = `<div class="bookmarks-empty"><p>${escHTML(error.message)}</p></div>`; return; }

  const items = (data || []).filter(r => r.books);
  if (!items.length) {
    wrap.innerHTML = `
      <div class="bookmarks-empty">
        <div class="bookmarks-empty-icon">📚</div>
        <h3>No saved books yet</h3>
        <p>Tap the <strong>Bookmark</strong> button on any book to save it for later.</p>
        <button class="btn btn-purple btn-sm" onclick="setSidebarActive('btnBook');showBook();">Browse books</button>
      </div>`;
    return;
  }

  wrap.innerHTML = `<div class="book-grid bookmarks-book-grid"></div>`;
  const grid = wrap.querySelector('.bookmarks-book-grid');
  for (const row of items) {
    const b = row.books;
    const card = renderBookCard(b);
    grid.appendChild(card);
  }
}

// Tab switching
document.querySelectorAll('.bookmarks-tab').forEach(t => {
  t.addEventListener('click', () => {
    _bookmarksActiveTab = t.dataset.tab;
    document.querySelectorAll('.bookmarks-tab').forEach(x => x.classList.toggle('active', x === t));
    if (_bookmarksActiveTab === 'videos') loadVideoBookmarks();
    else                                   loadBookBookmarks();
  });
});

// Sidebar wire-up
document.getElementById('btnBookmarks')?.addEventListener('click', () => {
  setSidebarActive('btnBookmarks');
  showBookmarks();
});

// ════════════════════════════════════════════════════════════════════════════
// VIDEO BOOKMARK — wire the new button in the player action bar
// ════════════════════════════════════════════════════════════════════════════
async function loadVideoBookmarkState(videoSupabaseId) {
  if (!currentUser || !videoSupabaseId) return;
  const btn = document.getElementById('videoBookmarkBtn');
  if (!btn) return;
  const { data } = await supabase.from('video_bookmarks')
    .select('video_id')
    .eq('user_id', currentUser.id)
    .eq('video_id', videoSupabaseId)
    .maybeSingle();
  setVideoBookmarkActive(!!data);
}

function setVideoBookmarkActive(active) {
  const btn = document.getElementById('videoBookmarkBtn');
  if (!btn) return;
  btn.dataset.active = active ? '1' : '0';
  const icon = btn.querySelector('svg');
  if (icon) icon.setAttribute('fill', active ? 'currentColor' : 'none');
  const label = btn.querySelector('span');
  if (label) label.textContent = active ? 'Saved' : 'Bookmark';
}

async function toggleVideoBookmark(videoSupabaseId) {
  if (!currentUser) { toast('Sign in to bookmark videos', 'error'); return; }
  if (!videoSupabaseId) { toast('Bookmarking only works on new videos for now', 'error'); return; }
  const btn = document.getElementById('videoBookmarkBtn');
  const wasActive = btn?.dataset.active === '1';
  setVideoBookmarkActive(!wasActive); // optimistic
  try {
    if (wasActive) {
      const { error } = await supabase.from('video_bookmarks')
        .delete().eq('user_id', currentUser.id).eq('video_id', videoSupabaseId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('video_bookmarks')
        .insert({ user_id: currentUser.id, video_id: videoSupabaseId });
      if (error && !/duplicate|unique/i.test(error.message)) throw error;
    }
  } catch (e) {
    setVideoBookmarkActive(wasActive);
    toast('Failed: ' + (e.message || e), 'error');
  }
}

document.getElementById('videoBookmarkBtn')?.addEventListener('click', () => {
  const videoId = window._currentVideoCtx?.supabaseId;
  toggleVideoBookmark(videoId);
});

// ════════════════════════════════════════
// AUTHOR — DASHBOARD + BOOK EDITOR + CHAPTER EDITOR
// ════════════════════════════════════════
const authorDashboard       = document.getElementById('authorDashboard');
const authorBookEditor      = document.getElementById('authorBookEditor');
const authorChapterEditor   = document.getElementById('authorChapterEditor');

let authorBooksCache = [];
// Module-level qualifier for the lock-prompt banner. True when the
// signed-in author has at least one book with lock_from_chapter set.
// Recomputed in loadAuthorDashboard from the cached book set; reused
// by both the dashboard list and the per-book editor's banner.
let _authorHasPaidBooks = false;
// In-session optimistic dismissal Set — keyed by book id. Mirrors the
// mobile dismissedBookIds state; lets the banner disappear instantly
// when the author taps Lock or Dismiss without waiting for the next
// dashboard refetch to drop the row's dismissed_at column read.
const _authorBookLockPromptDismissed = new Set();
let editingBookId = null;        // null = new book in editor
let editingChapterId = null;     // null = new chapter
let chapterQuill = null;
let chapterAutosaveTimer = null;
let chapterDirty = false;

// ──────────────────────────────────────────────────────────────────────────
// Curated genre picker — up to 5 selections, premium chip UI
// ──────────────────────────────────────────────────────────────────────────
const SELEBOX_GENRES = [
  'Dark Romance', 'Mafia Boss', 'Billionaire', 'Enemies to Lovers', 'Spicy', 'Contract Marriage',
  'CEO', 'Possession', 'Obsession', 'Alpha', 'Forbidden Love', 'Hot Romance',
  'Arranged Marriage', 'Revenge', 'Twisted Fate', 'Cold', 'Elite', 'Second Chance',
  'Substitute Bride', 'New Adult', 'Contemporary', 'Sweet Love', 'Romance', 'Teen Fiction',
  'Boy Love (BL)', 'Girl Love (GL)', 'Werewolf', 'Vampire', 'Fantasy', 'Mystery', 'Thriller', 'Horror',
  'Action', 'Sci-fi', 'Adventure', 'Mythology', 'Historical', 'Tragic', 'General Fiction',
  'Slice of Life', 'Divorce', 'Poor', 'Secretary', 'Maid', 'Nurse', 'Doctor', 'Professor',
  'Engineer', 'Attorney', 'Pilot', 'Architect', 'Haciendero', 'Wild', 'Comedy',
  'Escape While Pregnant', 'One Shot Story', 'Erotic', 'Valentines Special',
];

function genreSlug(label) {
  return String(label || '').toLowerCase().trim()
    .replace(/\([^)]*\)/g, '')      // drop parenthetical e.g. "(BL)"
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Build a chip picker. Returns { getSelected(), setSelected(arr) }
function buildGenrePicker(containerId, initialSelected = [], max = 5) {
  const root = document.getElementById(containerId);
  if (!root) return null;
  const chipsEl   = root.querySelector('.genre-picker-chips');
  const counterEl = root.querySelector('.genre-picker-count');
  const selected  = new Set();

  // Normalise initial: accept slugs, lowercase strings, or original labels
  const initialSet = new Set();
  for (const v of initialSelected) {
    if (!v) continue;
    const s = String(v).trim();
    // Match against SELEBOX_GENRES by either label or slug
    const hit = SELEBOX_GENRES.find(g => g === s || g.toLowerCase() === s.toLowerCase() || genreSlug(g) === genreSlug(s));
    if (hit) initialSet.add(hit);
  }

  function render() {
    chipsEl.innerHTML = SELEBOX_GENRES.map(g => `
      <button type="button" class="genre-chip ${selected.has(g) ? 'genre-chip-active' : ''}" data-genre="${escHTML(g)}">
        ${escHTML(g)}
      </button>
    `).join('');
    counterEl.textContent = selected.size;
    root.classList.toggle('genre-picker-full', selected.size >= max);
  }

  function toggle(g) {
    if (selected.has(g)) {
      selected.delete(g);
    } else {
      if (selected.size >= max) {
        toast(`Pick up to ${max} genres — remove one to add another`, 'error');
        return;
      }
      selected.add(g);
    }
    render();
  }

  // Seed initial
  for (const g of initialSet) selected.add(g);
  render();

  // Delegate clicks
  chipsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-genre]');
    if (!btn) return;
    toggle(btn.dataset.genre);
  });

  return {
    getSelected: () => [...selected],
    setSelected: (arr) => { selected.clear(); for (const v of (arr || [])) {
      const hit = SELEBOX_GENRES.find(g => g === v || g.toLowerCase() === String(v).toLowerCase());
      if (hit) selected.add(hit);
    } render(); },
    clear: () => { selected.clear(); render(); },
  };
}

// Singletons — populated lazily when their containers exist on screen
let _bookEditorGenrePicker = null;
let _newBookGenrePicker    = null;

function setAuthorView(view) {
  authorDashboard.style.display     = view === 'dashboard' ? 'block' : 'none';
  authorBookEditor.style.display    = view === 'book'      ? 'block' : 'none';
  authorChapterEditor.style.display = view === 'chapter'   ? 'block' : 'none';
}

// ── Dashboard ──
async function loadAuthorDashboard() {
  const content = document.getElementById('authorBooksContent');
  content.innerHTML = '<div class="loading">Loading your books...</div>';

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    content.innerHTML = '<div class="loading">Sign in to start writing.</div>';
    return;
  }

  // (Phase 7 earnings now lives in its own #earnings page — sidebar entry.)

  // lock_prompt_dismissed_at is the per-book "this author told us they
  // meant for it to be free" sentinel. When set, the lock-prompt
  // banner stays hidden for that book even if it's still Free. The
  // server-side trigger (see migration_book_lock_prompt_dismissal.sql)
  // auto-clears it on lock, so a future unlock re-arms the prompt.
  const { data, error } = await supabase
    .from('books')
    .select('id, title, description, cover_url, genre, status, is_public, views_count, likes_count, chapters_count, word_count, lock_from_chapter, locked_at, lock_prompt_dismissed_at, created_at, updated_at, published_at')
    .eq('author_id', user.id)
    .order('updated_at', { ascending: false });

  if (error) {
    content.innerHTML = `<div class="loading">Couldn't load books: ${escHTML(error.message)}</div>`;
    return;
  }

  authorBooksCache = data || [];

  // Qualifier flag for the lock-prompt banner — does this author
  // already monetize at least one book? We avoid an extra RPC by
  // deriving from the book set we just fetched. The mobile app uses
  // has_paid_books_for_author RPC for the same answer; both paths
  // feed the same banner-visibility gate downstream.
  _authorHasPaidBooks = authorBooksCache.some(b => (b.lock_from_chapter || 0) > 0);

  // Stats
  document.getElementById('statMyBooks').textContent = authorBooksCache.length.toLocaleString();
  document.getElementById('statMyChapters').textContent = authorBooksCache.reduce((s, b) => s + (b.chapters_count || 0), 0).toLocaleString();
  document.getElementById('statMyReads').textContent = authorBooksCache.reduce((s, b) => s + (b.views_count || 0), 0).toLocaleString();
  document.getElementById('statMyLikes').textContent = authorBooksCache.reduce((s, b) => s + (b.likes_count || 0), 0).toLocaleString();

  if (!authorBooksCache.length) {
    content.innerHTML = `
      <div class="page-empty">
        <div class="page-empty-icon">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>
        </div>
        <h2 class="page-empty-title">No manuscripts yet</h2>
        <p class="page-empty-body">Click <strong>New book</strong> above to start your first story.</p>
      </div>
    `;
    return;
  }

  // Render each row with an optional lock-prompt banner above it.
  // Banner is its own sibling block inside .author-books-table so the
  // existing grid layout for .author-book-row stays untouched. The
  // banner only emits HTML for books that pass shouldShowLockPromptBanner;
  // free-content authors (no other paid books) never see it.
  content.innerHTML = `
    <div class="author-books-table">
      ${authorBooksCache
        .map((b) => renderLockPromptBanner(b, { compact: true }) + renderAuthorBookRow(b))
        .join('')}
    </div>
  `;
  ensureLockPromptHandler();

  content.querySelectorAll('[data-author-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.authorAction;
      const id = btn.dataset.id;
      if (action === 'edit')   openAuthorBookEditor(id);
      else if (action === 'delete') deleteAuthorBook(id);
    });
  });
  content.querySelectorAll('.author-book-row').forEach(row => {
    row.addEventListener('click', () => openAuthorBookEditor(row.dataset.id));
  });
}

function renderAuthorBookRow(b) {
  const initialLetter = (b.title || '?').trim().charAt(0).toUpperCase();
  const cover = b.cover_url
    ? `<img src="${escHTML(b.cover_url)}" alt="" loading="lazy"/>`
    : `<div class="book-cover-placeholder">${initialLetter}</div>`;
  const statusClass = `author-book-status-${b.status || 'draft'}`;
  const visBadge = b.is_public ? '' : ' • Hidden';
  return `
    <div class="author-book-row" data-id="${b.id}">
      <div class="author-book-row-cover">${cover}</div>
      <div class="author-book-row-text">
        <div class="author-book-row-title">${escHTML(b.title || 'Untitled')}</div>
        <div class="author-book-row-genre">${escHTML((b.genre || '—').replace(/-/g, ' '))}${visBadge}</div>
      </div>
      <div><span class="author-book-status-badge ${statusClass}">${b.status || 'draft'}</span></div>
      <div class="author-book-row-stat">${(b.chapters_count || 0)} ch</div>
      <div class="author-book-row-stat">${(b.views_count || 0).toLocaleString()} 👁</div>
      <div class="author-book-row-actions">
        ${b.lock_from_chapter ? `<span class="author-book-pro-tag" title="Premium book — locked from chapter ${b.lock_from_chapter}">PRO</span>` : ''}
        <button class="author-book-action-btn" data-author-action="edit" data-id="${b.id}" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="author-book-action-btn author-book-action-btn-danger" data-author-action="delete" data-id="${b.id}" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
      </div>
    </div>
  `;
}

async function deleteAuthorBook(bookId) {
  const b = authorBooksCache.find(x => x.id === bookId);
  if (!b) return;
  const ok = await confirmDialog({
    title: `Delete "${b.title || 'this book'}"?`,
    body: 'This permanently removes the book and all its chapters. This can\'t be undone.',
    confirmLabel: 'Delete forever',
  });
  if (!ok) return;
  const { error } = await supabase.from('books').delete().eq('id', bookId);
  if (error) { toast('Failed to delete: ' + error.message, 'error'); return; }
  toast('Book deleted', 'success');
  loadAuthorDashboard();
}

// ════════════════════════════════════════════════════════════════════════════
// Lock prompt banner — soft notice for legacy Free books.
//
// When the old "Lock Book" toggle on mobile silently dropped the
// author's lock setting (the broken updateBook path before the
// picker-and-RPC fix landed), every affected book stayed Free in
// the database with no signal that it was ever supposed to be paid.
// Authors with at least one OTHER paid book are the highest-likelihood
// recovery candidates — same writer, same monetization habit, only
// difference is the row never got the threshold written.
//
// We surface a soft prompt on those Free books:
//   • Inside the book editor (above the form)
//   • On the dashboard book list (above each qualifying row)
// Tapping a number 5–10 locks the book at that threshold via the
// existing submit_book_update RPC; tapping Dismiss writes
// books.lock_prompt_dismissed_at so the banner stays hidden for that
// book until the author re-unlocks it.
//
// Visibility gate (must all be true):
//   1. Book is currently Free                  (lock_from_chapter IS NULL)
//   2. Banner not previously dismissed         (lock_prompt_dismissed_at IS NULL)
//   3. Author has at least one other paid book (_authorHasPaidBooks)
//   4. Not optimistically dismissed this session
// ════════════════════════════════════════════════════════════════════════════
function shouldShowLockPromptBanner(book) {
  if (!book) return false;
  if (!_authorHasPaidBooks) return false;
  if (book.lock_from_chapter) return false;
  if (book.lock_prompt_dismissed_at) return false;
  if (_authorBookLockPromptDismissed.has(book.id)) return false;
  return true;
}

function renderLockPromptBanner(book, opts = {}) {
  if (!shouldShowLockPromptBanner(book)) return '';
  const compact = opts.compact ? ' lock-prompt-banner-compact' : '';
  const titleSafe = escHTML(book.title || 'this book');
  const bookId = escHTML(book.id);
  // The picker buttons emit data-lock-pick + data-id so a single
  // delegated handler in wireLockPromptBanners() can claim both
  // surfaces (dashboard + editor) without per-banner listeners.
  const buttons = [5, 6, 7, 8, 9, 10]
    .map((n) => `<button type="button" class="lock-prompt-banner-pick" data-lock-pick="${n}" data-id="${bookId}">${n}</button>`)
    .join('');
  return `
    <div class="lock-prompt-banner${compact}" data-lock-banner-id="${bookId}">
      <div class="lock-prompt-banner-body">
        <p class="lock-prompt-banner-title">"${titleSafe}" is currently free</p>
        <p class="lock-prompt-banner-sub">
          You have other books with a paywall set. If you meant to lock this one too, pick where the
          paywall starts — chapters before that stay free as a teaser.
        </p>
        <div class="lock-prompt-banner-picker">${buttons}</div>
        <div class="lock-prompt-banner-foot">
          <button type="button" class="lock-prompt-banner-dismiss" data-lock-dismiss="${bookId}">
            Already free on purpose? Dismiss
          </button>
        </div>
      </div>
    </div>
  `;
}

async function lockBookFromPrompt(bookId, threshold) {
  const n = Number(threshold);
  if (!Number.isFinite(n) || n < 5 || n > 10) return;
  const banner = document.querySelector(`[data-lock-banner-id="${bookId}"]`);
  if (banner) {
    banner.querySelectorAll('.lock-prompt-banner-pick').forEach((b) => (b.disabled = true));
    banner.querySelector('.lock-prompt-banner-dismiss')?.setAttribute('disabled', 'true');
    const foot = banner.querySelector('.lock-prompt-banner-foot');
    if (foot && !foot.querySelector('.lock-prompt-banner-spin')) {
      const spin = document.createElement('span');
      spin.className = 'lock-prompt-banner-spin';
      foot.prepend(spin);
    }
  }
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Sign in required');
    const { data, error } = await supabase.rpc('submit_book_update', {
      p_actor_id: user.id,
      p_book_id: bookId,
      p_lock_from_chapter: n,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'lock failed');

    _authorBookLockPromptDismissed.add(bookId);
    if (banner) banner.remove();
    toast(`Locked from chapter ${n}`, 'success');

    // Refresh the dashboard so the row's PRO tag appears and the
    // editor (if open for the same book) sees the new lock state.
    if (typeof loadAuthorDashboard === 'function') loadAuthorDashboard();
    if (editingBookId === bookId && typeof setBookLockUI === 'function') {
      setBookLockUI(n, new Date().toISOString());
    }
  } catch (err) {
    toast('Could not lock: ' + (err?.message || 'try again'), 'error');
    if (banner) {
      banner.querySelectorAll('.lock-prompt-banner-pick').forEach((b) => (b.disabled = false));
      banner.querySelector('.lock-prompt-banner-dismiss')?.removeAttribute('disabled');
      banner.querySelector('.lock-prompt-banner-spin')?.remove();
    }
  }
}

async function dismissBookLockPrompt(bookId) {
  const ok = await confirmDialog({
    title: 'Keep this book free?',
    body: "We won't show this prompt again for this book. You can still lock it later from the book editor.",
    confirmLabel: 'Yes, keep free',
  });
  if (!ok) return;

  const banner = document.querySelector(`[data-lock-banner-id="${bookId}"]`);
  if (banner) {
    banner.querySelectorAll('.lock-prompt-banner-pick').forEach((b) => (b.disabled = true));
    banner.querySelector('.lock-prompt-banner-dismiss')?.setAttribute('disabled', 'true');
  }
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Sign in required');
    const { data, error } = await supabase.rpc('submit_book_lock_prompt_dismiss', {
      p_actor_id: user.id,
      p_book_id: bookId,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'dismiss failed');

    _authorBookLockPromptDismissed.add(bookId);
    if (banner) banner.remove();
  } catch (err) {
    toast('Could not save: ' + (err?.message || 'try again'), 'error');
    if (banner) {
      banner.querySelectorAll('.lock-prompt-banner-pick').forEach((b) => (b.disabled = false));
      banner.querySelector('.lock-prompt-banner-dismiss')?.removeAttribute('disabled');
    }
  }
}

// Single delegated click handler — installs once on the document so
// every banner (current + future, dashboard + editor) is wired without
// per-element addEventListener calls.
function ensureLockPromptHandler() {
  if (window.__lockPromptHandlerInstalled) return;
  window.__lockPromptHandlerInstalled = true;
  document.addEventListener('click', (e) => {
    const pickBtn = e.target.closest('.lock-prompt-banner-pick');
    if (pickBtn) {
      const id = pickBtn.dataset.id;
      const n = pickBtn.dataset.lockPick;
      if (id && n) lockBookFromPrompt(id, n);
      return;
    }
    const dismissBtn = e.target.closest('.lock-prompt-banner-dismiss');
    if (dismissBtn) {
      const id = dismissBtn.dataset.lockDismiss;
      if (id) dismissBookLockPrompt(id);
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 7 — Author Earnings, KYC, Withdrawals
// ════════════════════════════════════════════════════════════════════════════

let _authorBalance = null;
let _authorKyc     = null;

async function loadAuthorEarnings() {
  if (!currentUser) return;
  // Note: the legacy #authorEarningsSection lives in the Author dashboard
  // and was removed. Earnings now lives in the dedicated #earningsPage.

  // Fire all four reads in parallel — pulls all earnings rows for the
  // breakdown calculation (small per-author dataset, fine to fetch in full).
  const [balanceRes, earningsRes, withdrawalsRes, kycRes] = await Promise.all([
    supabase.rpc('author_balance_for', { p_author_id: currentUser.id }),
    supabase.from('author_earnings')
      .select('id, source_type, source_id, gross_coins, share_pct, net_coins, net_php_minor, currency_used, status, available_at, created_at')
      .eq('author_id', currentUser.id)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase.from('author_withdrawals')
      .select('id, amount_coins, amount_php_minor, status, payout_method, requested_at, approved_at, paid_at, rejection_reason')
      .eq('author_id', currentUser.id)
      .order('requested_at', { ascending: false })
      .limit(20),
    supabase.from('author_kyc')
      .select('status, rejection_reason, submitted_at, reviewed_at')
      .eq('user_id', currentUser.id)
      .maybeSingle(),
  ]);

  _authorBalance = balanceRes.data || { available_coins: 0, pending_coins: 0, available_php_minor: 0, pending_php_minor: 0 };
  _authorKyc     = kycRes.data || null;

  const earnings = earningsRes.data || [];
  renderAuthorEarningsBalance();
  renderEarningsBreakdown(earnings);
  renderAuthorEarningsList(earnings.slice(0, 50));
  renderAuthorWithdrawalsList(withdrawalsRes.data || []);
  renderAuthorKycBanner();
  syncAuthorPayoutButton();
}

// Breakdown by source_type — Posts / Videos / Books (Books = chapter + book_bulk)
function renderEarningsBreakdown(rows) {
  const totals = { posts: 0, videos: 0, books: 0 };
  const phpTotals = { posts: 0, videos: 0, books: 0 };
  for (const r of rows) {
    if (r.source_type === 'video')                                        { totals.videos += r.net_coins; phpTotals.videos += r.net_php_minor; }
    else if (r.source_type === 'chapter' || r.source_type === 'book_bulk'){ totals.books  += r.net_coins; phpTotals.books  += r.net_php_minor; }
    else if (r.source_type === 'post')                                    { totals.posts  += r.net_coins; phpTotals.posts  += r.net_php_minor; }
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('breakdownPostsCoins',  totals.posts.toLocaleString());
  set('breakdownVideosCoins', totals.videos.toLocaleString());
  set('breakdownBooksCoins',  totals.books.toLocaleString());
  set('breakdownPostsPhp',    formatPhpFromMinor(phpTotals.posts));
  set('breakdownVideosPhp',   formatPhpFromMinor(phpTotals.videos));
  set('breakdownBooksPhp',    formatPhpFromMinor(phpTotals.books));
}

function renderAuthorEarningsBalance() {
  const b = _authorBalance || {};
  // ── Rate-locked at earning time ─────────────────────────────────────
  // available_php_minor and pending_php_minor are summed from author_earnings
  // rows, each of which snapshotted its coin_to_php_minor at the moment the
  // reader paid. So when admin changes the rate from ₱0.20 → ₱0.25, only
  // FUTURE earnings use the new rate. Existing balances are immune.
  const availMinor = b.available_php_minor || 0;
  const pendMinor  = b.pending_php_minor   || 0;

  document.getElementById('earningsAvailablePhp').textContent = formatPhpFromMinor(availMinor);
  document.getElementById('earningsPendingPhp').textContent   = formatPhpFromMinor(pendMinor);

  // Hold copy — kept as "1–3 days" range regardless of underlying config
  const foot = document.getElementById('earningsHoldFootnote');
  if (foot) foot.textContent = "Earnings become available 1–3 days after they're earned.";

  // Minimum payout hint — show admin-configured floor, or ₱100 by default
  const minPayoutMinor = _walletConfigDefaults.min_payout_php_minor || 10000;
  const minHint = document.getElementById('earningsMinPayoutHint');
  if (minHint) minHint.textContent = `Minimum payout: ${formatPhpFromMinor(minPayoutMinor)}`;

  // Cache for the payout-button gate
  _authorBalance._computed_available_minor = availMinor;
  _authorBalance._computed_pending_minor   = pendMinor;
}

function formatPhpFromMinor(m) {
  return '₱' + (m / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderAuthorEarningsList(rows) {
  const el = document.getElementById('authorEarningsList');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="page-empty-soft">No earnings yet. Once readers unlock your work with coins, you\'ll see entries here.</div>';
    return;
  }
  // currency_used was added with the May 2026 stars-earn-for-authors
  // overhaul. Older rows pre-migration default to 'coin' (the column has
  // a server-side default), so the fallback below is just defensive
  // against a row that somehow comes back with currency_used=null.
  el.innerHTML = rows.map(r => {
    const cur   = (r.currency_used || 'coin').toLowerCase();
    const label = cur === 'star' ? 'star' : 'coin';
    return `
    <div class="earnings-row">
      <div class="earnings-row-meta">
        <div class="earnings-row-type">${escHTML(r.source_type.replace('_', ' '))}</div>
        <div class="earnings-row-sub">${timeAgo(r.created_at)} · ${r.share_pct}% share of ${r.gross_coins} ${label}${r.gross_coins === 1 ? '' : 's'}</div>
      </div>
      <div class="earnings-row-amount">+${r.net_coins} <small>${label}${r.net_coins === 1 ? '' : 's'}</small></div>
      <div class="earnings-row-php">${formatPhpFromMinor(r.net_php_minor)}</div>
      <div class="earnings-row-status earnings-row-status-${r.status}">${earningsStatusLabel(r)}</div>
    </div>`;
  }).join('');
}

function earningsStatusLabel(r) {
  if (r.status === 'pending') {
    const ms = new Date(r.available_at) - Date.now();
    if (ms <= 0) return 'Available';
    const days = Math.ceil(ms / 86400000);
    return `Pending · ${days}d`;
  }
  if (r.status === 'available') return 'Available';
  if (r.status === 'withdrawn') return 'Withdrawn';
  if (r.status === 'reversed')  return 'Reversed';
  return r.status;
}

function renderAuthorWithdrawalsList(rows) {
  const el = document.getElementById('authorWithdrawalsList');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="page-empty-soft">No withdrawals yet.</div>';
    return;
  }
  el.innerHTML = rows.map(r => `
    <div class="earnings-row earnings-row-withdrawal">
      <div class="earnings-row-meta">
        <div class="earnings-row-type">Payout · ${escHTML(r.payout_method)}</div>
        <div class="earnings-row-sub">Requested ${timeAgo(r.requested_at)}${r.paid_at ? ' · Paid ' + timeAgo(r.paid_at) : ''}${r.rejection_reason ? ' · Reason: ' + escHTML(r.rejection_reason) : ''}</div>
      </div>
      <div class="earnings-row-amount">${r.amount_coins.toLocaleString()} <small>coins</small></div>
      <div class="earnings-row-php">${formatPhpFromMinor(r.amount_php_minor)}</div>
      <div class="earnings-row-status earnings-row-status-w-${r.status}">${escHTML(r.status)}</div>
    </div>
  `).join('');
}

function renderAuthorKycBanner() {
  const banner  = document.getElementById('authorKycBanner');
  const titleEl = document.getElementById('authorKycTitle');
  const subEl   = document.getElementById('authorKycSub');
  // btnSubmitKyc was removed from HTML when Payments Info became inline —
  // kept a defensive null check so rendering doesn't crash if the element
  // is ever missing again. The "Submit Payments Info" CTA now lives in the
  // Payments Info tab button itself.
  const btn     = document.getElementById('btnSubmitKyc');
  const setBtn = (txt, show) => { if (!btn) return; if (txt != null) btn.textContent = txt; btn.style.display = show ? '' : 'none'; };
  const setText = (el, txt) => { if (el) el.textContent = txt; };

  if (!banner) return;

  const k = _authorKyc;
  if (!k) {
    setText(titleEl, 'Complete Payments Info to enable payouts');
    setText(subEl, 'We need to verify your identity before sending you money. One-time step required by Philippine law.');
    setBtn('Submit Payments Info', true);
    banner.style.display = '';
    banner.className = 'author-kyc-banner is-required';
    return;
  }
  if (k.status === 'pending') {
    setText(titleEl, 'Payments Info under review');
    setText(subEl, 'Submitted ' + timeAgo(k.submitted_at) + '. Usually approved within 1-2 business days.');
    setBtn(null, false);
    banner.className = 'author-kyc-banner is-pending';
    banner.style.display = '';
    return;
  }
  if (k.status === 'approved') {
    setText(titleEl, 'Payments Info approved ✓');
    setText(subEl, 'You\'re cleared for payouts. You can request a withdrawal whenever your available balance hits the minimum.');
    setBtn(null, false);
    banner.className = 'author-kyc-banner is-approved';
    banner.style.display = '';
    return;
  }
  if (k.status === 'rejected') {
    setText(titleEl, 'Payments Info rejected');
    setText(subEl, 'Reason: ' + (k.rejection_reason || 'unspecified') + '. Open Payments Info to update your details.');
    setBtn('Update Payments Info', true);
    banner.className = 'author-kyc-banner is-rejected';
    banner.style.display = '';
    return;
  }
}

function syncAuthorPayoutButton() {
  const btn = document.getElementById('btnRequestPayout');
  if (!btn) return;
  // Always keep the button ENABLED — when the user can't withdraw, the click
  // handler shows a friendly popup explaining why (need to fill Payments Info,
  // or below ₱100 minimum). A silently-disabled button just confuses people.
  btn.disabled = false;

  const minPhpMinor   = _walletConfigDefaults.min_payout_php_minor || 10000;
  const availPhpMinor = _authorBalance?._computed_available_minor ?? (_authorBalance?.available_php_minor || 0);
  const kycOk = !_walletConfigDefaults.author_payout_kyc_required ||
                _authorKyc?.status === 'approved';
  // Tooltip is just a hint — actual blocking happens in the click handler
  if (!_authorKyc?.payment_method)  btn.title = 'Fill in your Payments Info first';
  else if (availPhpMinor < minPhpMinor) btn.title = `Need at least ${formatPhpFromMinor(minPhpMinor)} available`;
  else if (!kycOk)                 btn.title = 'KYC must be approved first';
  else                             btn.title = '';
}

// ── Payments Info form (inline, replaces the old modal) ─────────────────
//
// Click on the "Submit info" banner in the Earnings tab → switch to the
// Payments Info tab where the full form lives.
document.getElementById('btnSubmitKyc')?.addEventListener('click', () => {
  switchEarningsTab('payments');
});

// File picker → upload to private kyc-uploads bucket → preview thumbnail
async function uploadKycImage(file, kind /* 'qr' | 'id' | 'sig' */) {
  if (!file || !currentUser) return null;
  if (file.size > 5 * 1024 * 1024) { toast('File too large (max 5 MB)', 'error'); return null; }
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${currentUser.id}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  const { error } = await supabase.storage.from('kyc-uploads').upload(path, file, { upsert: false });
  if (error) { toast('Upload failed: ' + error.message, 'error'); return null; }
  return path;  // private bucket — store the path, not a public URL
}

// Wire each upload box: clicking it opens the file picker; on file pick,
// upload + show preview.
function wireKycUpload(boxId, fileId, textId, previewId, kind, urlSetter) {
  const box     = document.getElementById(boxId);
  const fileInp = document.getElementById(fileId);
  const textEl  = document.getElementById(textId);
  const prevEl  = document.getElementById(previewId);
  if (!box || !fileInp) return;
  // The label wraps the input so click is automatic.
  fileInp.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    box.classList.add('is-uploading');
    if (textEl) textEl.textContent = 'Uploading…';
    const path = await uploadKycImage(file, kind);
    box.classList.remove('is-uploading');
    if (!path) {
      if (textEl) textEl.textContent = `Tap to upload ${kind === 'qr' ? 'qr code' : kind === 'id' ? 'valid id' : 'signature'}`;
      return;
    }
    urlSetter(path);
    if (file.type.startsWith('image/')) {
      // Local preview (from the file blob — server URL is private)
      const reader = new FileReader();
      reader.onload = () => { if (prevEl) { prevEl.src = reader.result; prevEl.style.display = ''; } };
      reader.readAsDataURL(file);
    }
    if (textEl) textEl.textContent = 'Replace';
  });
}

// State for the in-flight form (paths only; uploaded immediately on file pick)
const _piUploads = { qr: null, id: null, sig: null };

// Pre-fill the form when the Payments Info tab loads (idempotent — safe to
// call any time _authorKyc is fresh).
async function fillPaymentsInfoForm() {
  const k = _authorKyc;
  document.getElementById('piFullName').value = k?.full_name || '';
  document.getElementById('piPhone').value    = k?.phone || '';
  document.getElementById('piEmail').value    = k?.email || currentUser?.email || '';
  document.getElementById('piDob').value      = k?.date_of_birth ? String(k.date_of_birth).slice(0, 10) : '';
  document.getElementById('piAddress').value  = k?.address || '';
  // Method
  document.querySelectorAll('input[name="piMethod"]').forEach(r => {
    r.checked = (k?.payment_method === r.value);
  });
  // Existing uploads — show "Uploaded ✓" but no preview (file is private)
  const hint = (id, has, kindLabel) => {
    const t = document.getElementById(id);
    if (t) t.textContent = has ? `Uploaded — tap to replace ${kindLabel}` : `Tap to upload ${kindLabel}`;
  };
  hint('piQrText',  !!k?.payment_qr_url,  'qr code');
  hint('piIdText',  !!k?.id_document_url, 'valid id');
  hint('piSigText', !!k?.signature_url,   'signature');
  // Reset uploads buffer so a fresh edit starts clean
  _piUploads.qr  = null;
  _piUploads.id  = null;
  _piUploads.sig = null;

  // ── Lock-after-first-save logic ──
  // If the user has already saved their info (record exists), the form goes
  // read-only and they have to use the "Request changes" flow which routes
  // through admin review. Prevents impulse edits / fraud.
  const hasRecord = !!(k && k.full_name);

  // Check for any pending change request to surface the "awaiting review" banner
  let pendingRequest = null;
  if (hasRecord) {
    try {
      const { data } = await supabase
        .from('payment_info_change_requests')
        .select('id, requested_at, status')
        .eq('user_id', currentUser.id)
        .eq('status', 'pending')
        .order('requested_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) pendingRequest = data;
    } catch {}
  }

  applyPaymentsInfoLockState(hasRecord, pendingRequest);
}

// Toggle the form between editable (first-time) and read-only (post-save).
// In read-only mode, all inputs/uploads are disabled and the save button is
// replaced with "Request changes" — which opens a modal that submits a request
// for admin approval (see payment_info_change_requests table).
function applyPaymentsInfoLockState(hasRecord, pendingRequest) {
  const inputs = [
    document.getElementById('piFullName'),
    document.getElementById('piPhone'),
    document.getElementById('piEmail'),
    document.getElementById('piDob'),
    document.getElementById('piAddress'),
  ];
  const radios = document.querySelectorAll('input[name="piMethod"]');
  const uploadBoxes = document.querySelectorAll('.pi-upload, #piQrUploadBox, #piIdUploadBox, #piSigUploadBox');

  inputs.forEach(el => { if (el) el.readOnly = hasRecord; });
  radios.forEach(r => { r.disabled = hasRecord; });
  uploadBoxes.forEach(box => {
    if (hasRecord) box.classList.add('pi-locked');
    else           box.classList.remove('pi-locked');
  });

  // Swap action buttons
  const saveBtn      = document.getElementById('piSaveBtn');
  const requestBtn   = document.getElementById('piRequestChangeBtn');
  const pendingBanner = document.getElementById('piPendingBanner');

  if (saveBtn) saveBtn.style.display = hasRecord ? 'none' : '';

  // Lazily inject the "Request changes" button + pending banner if missing
  if (hasRecord && !requestBtn) {
    const saveContainer = saveBtn?.parentElement;
    if (saveContainer) {
      const btn = document.createElement('button');
      btn.id = 'piRequestChangeBtn';
      btn.className = 'pi-save-btn';
      btn.style.background = 'linear-gradient(135deg, #7c3aed, #a78bfa)';
      btn.innerHTML = '<span>Request changes</span>';
      btn.onclick = openPaymentInfoChangeModal;
      saveContainer.appendChild(btn);
    }
  } else if (!hasRecord && requestBtn) {
    requestBtn.remove();
  }

  // Pending banner
  let banner = document.getElementById('piPendingBanner');
  if (pendingRequest) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'piPendingBanner';
      banner.className = 'pi-pending-banner';
      const formContainer = document.querySelector('.pi-card')?.parentElement;
      if (formContainer) formContainer.insertBefore(banner, formContainer.firstChild);
    }
    const requestedAt = new Date(pendingRequest.requested_at).toLocaleDateString();
    banner.innerHTML = `<span>⏳</span><span>Change request pending admin review (submitted ${requestedAt}). You'll be notified when it's reviewed.</span>`;
  } else if (banner) {
    banner.remove();
  }
}

async function openPaymentInfoChangeModal() {
  const k = _authorKyc || {};
  const modal = document.getElementById('piChangeModal') || createPaymentInfoChangeModal();
  // Pre-fill with current values so the user only edits what's changing
  modal.querySelector('#piChangeFullName').value = k.full_name || '';
  modal.querySelector('#piChangePhone').value    = k.phone || '';
  modal.querySelector('#piChangeEmail').value    = k.email || '';
  modal.querySelector('#piChangeAddress').value  = k.address || '';
  modal.querySelector('#piChangeMethod').value   = k.payment_method || '';
  modal.querySelector('#piChangeReason').value   = '';
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closePaymentInfoChangeModal() {
  document.getElementById('piChangeModal')?.classList.remove('open');
  document.body.style.overflow = '';
}

function createPaymentInfoChangeModal() {
  const m = document.createElement('div');
  m.id = 'piChangeModal';
  m.className = 'modal-overlay';
  m.innerHTML = `
    <div class="modal-box" style="max-width:520px">
      <div class="modal-header">
        <div class="modal-title">Request changes to Payments Info</div>
        <button class="modal-close-btn" id="piChangeClose">×</button>
      </div>
      <p style="font-size:0.86rem; color:var(--text2); margin-bottom:1rem; line-height:1.5">
        Edit only the fields you want to change. An admin will review your request — you'll get a notification when approved or rejected.
      </p>
      <label class="form-label">Full name</label>
      <input class="form-input" id="piChangeFullName" maxlength="100"/>
      <label class="form-label">Phone</label>
      <input class="form-input" id="piChangePhone" maxlength="30"/>
      <label class="form-label">Email</label>
      <input class="form-input" id="piChangeEmail" maxlength="120"/>
      <label class="form-label">Address</label>
      <input class="form-input" id="piChangeAddress" maxlength="200"/>
      <label class="form-label">Payment method</label>
      <select class="form-input" id="piChangeMethod">
        <option value="">— Select —</option>
        <option value="gcash">GCash</option>
        <option value="maya">Maya</option>
        <option value="bank">Bank transfer</option>
        <option value="gotyme">GoTyme</option>
      </select>
      <label class="form-label">Why are you making this change? (required)</label>
      <textarea class="form-input" id="piChangeReason" rows="3" maxlength="500" placeholder="e.g. I switched to a new bank, my address changed…"></textarea>
      <div class="modal-footer">
        <button class="btn btn-ghost btn-sm" id="piChangeCancel">Cancel</button>
        <button class="btn btn-purple btn-sm" id="piChangeSubmit">Submit request</button>
      </div>
    </div>
  `;
  document.body.appendChild(m);
  m.querySelector('#piChangeClose').onclick = closePaymentInfoChangeModal;
  m.querySelector('#piChangeCancel').onclick = closePaymentInfoChangeModal;
  m.addEventListener('click', (e) => { if (e.target === m) closePaymentInfoChangeModal(); });
  m.querySelector('#piChangeSubmit').onclick = submitPaymentInfoChange;
  return m;
}

async function submitPaymentInfoChange() {
  const reason = document.getElementById('piChangeReason').value.trim();
  if (!reason) { toast('Please explain why you need this change', 'error'); return; }

  const k = _authorKyc || {};
  // Only include fields that actually changed — keeps the diff focused
  const changed = {};
  const fields = [
    ['piChangeFullName', 'full_name',      k.full_name],
    ['piChangePhone',    'phone',          k.phone],
    ['piChangeEmail',    'email',          k.email],
    ['piChangeAddress',  'address',        k.address],
    ['piChangeMethod',   'payment_method', k.payment_method],
  ];
  for (const [id, key, current] of fields) {
    const v = document.getElementById(id).value.trim();
    if (v && v !== (current || '')) changed[key] = v;
  }
  if (Object.keys(changed).length === 0) {
    toast('No fields changed — edit at least one before submitting', 'error');
    return;
  }

  const btn = document.getElementById('piChangeSubmit');
  btn.disabled = true; btn.textContent = 'Submitting…';

  const { data, error } = await supabase.rpc('request_payment_info_change', {
    p_requested_data: changed,
    p_reason: reason,
  });

  btn.disabled = false; btn.textContent = 'Submit request';

  if (error) { toast(error.message, 'error'); return; }
  if (!data?.ok) {
    const msg = data?.error === 'pending_request_exists'
      ? 'You already have a pending change request — wait for admin review first.'
      : (data?.error || 'Failed to submit request');
    toast(msg, 'error');
    return;
  }

  toast('Change request submitted — admin will review it shortly', 'success');
  closePaymentInfoChangeModal();
  // Re-render the locked form so the pending banner appears
  fillPaymentsInfoForm();
}

// Wire each upload control once at module load
wireKycUpload('piQrUploadBox',  'piQrFile',  'piQrText',  'piQrPreview',  'qr',  (p) => { _piUploads.qr  = p; });
wireKycUpload('piIdUploadBox',  'piIdFile',  'piIdText',  'piIdPreview',  'id',  (p) => { _piUploads.id  = p; });
wireKycUpload('piSigUploadBox', 'piSigFile', 'piSigText', 'piSigPreview', 'sig', (p) => { _piUploads.sig = p; });

// Method-pill visual selection
document.querySelectorAll('input[name="piMethod"]').forEach(r => {
  r.addEventListener('change', () => {
    document.querySelectorAll('.pi-method-pill').forEach(p => p.classList.toggle('is-checked', p.querySelector('input').checked));
  });
});

// Save button — validates + submits + reloads earnings
document.getElementById('piSaveBtn')?.addEventListener('click', async () => {
  const fullName = document.getElementById('piFullName').value.trim();
  const phone    = document.getElementById('piPhone').value.trim();
  const email    = document.getElementById('piEmail').value.trim();
  const dob      = document.getElementById('piDob').value;
  const address  = document.getElementById('piAddress').value.trim();
  const method   = document.querySelector('input[name="piMethod"]:checked')?.value;

  if (!fullName) { toast('Full name is required', 'error'); return; }
  if (!phone)    { toast('Phone number is required', 'error'); return; }
  if (!email)    { toast('Email is required', 'error'); return; }
  if (!dob)      { toast('Date of birth is required', 'error'); return; }
  if (!address)  { toast('Address is required', 'error'); return; }
  if (!method)   { toast('Pick a payment method', 'error'); return; }

  // QR / ID / Signature — required on first submit, optional on re-edit
  // (we keep the existing upload paths if the user didn't pick new files).
  const qr  = _piUploads.qr  || _authorKyc?.payment_qr_url  || null;
  const id  = _piUploads.id  || _authorKyc?.id_document_url || null;
  const sig = _piUploads.sig || _authorKyc?.signature_url   || null;
  if (!qr)  { toast('Upload your payment QR code', 'error'); return; }
  if (!id)  { toast('Upload a valid government ID', 'error'); return; }
  if (!sig) { toast('Upload your signature', 'error'); return; }

  const btn = document.getElementById('piSaveBtn');
  btn.disabled = true; btn.querySelector('span').textContent = 'Saving…';

  const { data, error } = await supabase.rpc('submit_author_kyc', {
    p_full_name:        fullName,
    p_date_of_birth:    dob,
    p_id_type:          null,           // legacy — not collected by this form
    p_id_number:        null,           // legacy — not collected by this form
    p_id_document_url:  id,
    p_selfie_url:       null,           // legacy
    p_phone:            phone,
    p_email:            email,
    p_address:          address,
    p_payment_method:   method,
    p_payment_qr_url:   qr,
    p_signature_url:    sig,
  });

  btn.disabled = false; btn.querySelector('span').textContent = 'Save Information';

  if (error) { toast(error.message, 'error'); return; }
  if (data?.ok === false) { toast(data.error || 'Failed', 'error'); return; }

  toast('Submitted — we\'ll review within 1–2 business days.', 'success');
  await loadAuthorEarnings();
  fillPaymentsInfoForm();
});
document.getElementById('kycClose')?.addEventListener('click', () => { document.getElementById('kycModal').style.display = 'none'; });
document.getElementById('kycCancel')?.addEventListener('click', () => { document.getElementById('kycModal').style.display = 'none'; });
document.getElementById('kycSubmit')?.addEventListener('click', async () => {
  const fullName = document.getElementById('kycFullName').value.trim();
  const dob      = document.getElementById('kycDob').value;
  const idType   = document.getElementById('kycIdType').value;
  const idNumber = document.getElementById('kycIdNumber').value.trim();
  if (!fullName) { toast('Full name is required', 'error'); return; }
  if (!idNumber) { toast('ID number is required', 'error'); return; }
  const btn = document.getElementById('kycSubmit');
  btn.disabled = true; btn.textContent = 'Submitting…';
  const { data, error } = await supabase.rpc('submit_author_kyc', {
    p_full_name:       fullName,
    p_date_of_birth:   dob || null,
    p_id_type:         idType,
    p_id_number:       idNumber,
    p_id_document_url: null,
    p_selfie_url:      null,
  });
  btn.disabled = false; btn.textContent = 'Submit for review';
  if (error)        { toast(error.message, 'error'); return; }
  if (data?.ok === false) { toast(data.error || 'Failed', 'error'); return; }
  document.getElementById('kycModal').style.display = 'none';
  toast('KYC submitted — we\'ll review within 1-2 business days.', 'success');
  await loadAuthorEarnings();
});

// ── Withdrawal modal wiring (strict — server pulls saved Payments Info) ─
const PAYMENT_METHOD_LABELS = { gcash: 'GCash', maya: 'Maya', bank: 'Bank transfer', gotyme: 'GoTyme' };

document.getElementById('btnRequestPayout')?.addEventListener('click', () => {
  // Always re-derive these from cache so admin rate changes are reflected
  const minPhpMinor   = _walletConfigDefaults.min_payout_php_minor || 10000;
  const availPhpMinor = _authorBalance?._computed_available_minor ??
                        (_authorBalance?.available_php_minor || 0);

  const minModal = document.getElementById('minPayoutModal');

  // ── PRIORITY 1: No Payments Info saved → walk them to it ──
  // Even if they have ₱0 they should know payment info is required.
  if (!_authorKyc?.payment_method) {
    document.getElementById('minPayoutMsg').innerHTML =
      "You haven't saved your Payments Info yet — we need that before sending money. It only takes a minute.";
    const okBtn = document.getElementById('minPayoutOk');
    okBtn.textContent = 'Open Payments Info';
    okBtn.dataset.action = 'go-to-payments-info';
    const progress = minModal.querySelector('.min-payout-progress');
    if (progress) progress.style.display = 'none';
    const title = minModal.querySelector('.modal-title');
    if (title) title.textContent = 'Add Payments Info first';
    // Show with both inline display + .open class to be safe across themes
    minModal.style.display = 'flex';
    minModal.classList.add('open');
    return;
  }

  // ── PRIORITY 2: Below minimum → friendly explainer popup ──
  if (availPhpMinor < minPhpMinor) {
    const haveStr = formatPhpFromMinor(availPhpMinor);
    const minStr  = formatPhpFromMinor(minPhpMinor);
    const needStr = formatPhpFromMinor(Math.max(0, minPhpMinor - availPhpMinor));
    document.getElementById('minPayoutMsg').innerHTML =
      `You need at least <strong>${minStr}</strong> available to request a payout. Keep earning and you'll unlock withdrawals soon.`;
    document.getElementById('minPayoutHave').textContent = haveStr;
    document.getElementById('minPayoutMin').textContent  = minStr;
    document.getElementById('minPayoutNeed').textContent = needStr;
    const okBtn = document.getElementById('minPayoutOk');
    okBtn.textContent = 'Got it';
    okBtn.dataset.action = 'close';
    const progress = minModal.querySelector('.min-payout-progress');
    if (progress) progress.style.display = '';
    const title = minModal.querySelector('.modal-title');
    if (title) title.textContent = 'Not enough to withdraw yet';
    minModal.style.display = 'flex';
    minModal.classList.add('open');
    return;
  }

  // ── Open the simple modal ──
  const m = document.getElementById('withdrawalModal');
  if (!m) return;

  const amountInput = document.getElementById('withdrawalAmount');
  amountInput.min  = (minPhpMinor / 100).toFixed(2);
  amountInput.max  = (availPhpMinor / 100).toFixed(2);
  amountInput.value = (availPhpMinor / 100).toFixed(2);   // default to full balance
  amountInput.step = '0.01';
  document.getElementById('withdrawalAmountHint').textContent =
    `Minimum ${formatPhpFromMinor(minPhpMinor)}. Max available: ${formatPhpFromMinor(availPhpMinor)}.`;

  // Read-only saved account display
  const methodLabel = PAYMENT_METHOD_LABELS[_authorKyc.payment_method] || _authorKyc.payment_method;
  document.getElementById('withdrawalAccountMethod').textContent = methodLabel;
  document.getElementById('withdrawalAccountName').textContent   = _authorKyc.full_name || '(no name on file)';

  // Programmatic value sets don't fire `input`, so seed the fee preview +
  // Pioneer banner manually on modal open. After this, the listeners
  // wired further down handle live updates as the user edits.
  if (typeof _renderWithdrawalFeePreview === 'function') _renderWithdrawalFeePreview();

  m.style.display = 'flex';
});

// Min-payout popup helpers — close fully (both inline display + .open class)
function _closeMinPayoutModal() {
  const m = document.getElementById('minPayoutModal');
  if (!m) return;
  m.style.display = 'none';
  m.classList.remove('open');
}
document.getElementById('minPayoutClose')?.addEventListener('click', _closeMinPayoutModal);
document.getElementById('minPayoutOk')?.addEventListener('click', (e) => {
  const action = e.currentTarget.dataset.action;
  _closeMinPayoutModal();
  if (action === 'go-to-payments-info') {
    if (typeof switchEarningsTab === 'function') switchEarningsTab('payments');
  }
});
document.getElementById('minPayoutModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'minPayoutModal') _closeMinPayoutModal();
});

document.getElementById('withdrawalClose')?.addEventListener('click', () => { document.getElementById('withdrawalModal').style.display = 'none'; });
document.getElementById('withdrawalCancel')?.addEventListener('click', () => { document.getElementById('withdrawalModal').style.display = 'none'; });

// ── Pioneer-exemption + fee-preview helpers ──────────────────────────
// Mirror of mobile lib/utils/calculateWithdrawal.js. Kept in sync so the
// preview a Pioneer sees in the web modal matches what mobile would show
// AND what the server's request_author_withdrawal RPC will charge.
//
// Reads PLATFORM_COST and TRANSFER_FEE from _walletConfigDefaults
// (loaded from app_config). Both are stored as fractions (0.2, 0.02).
// pioneer_exemption_days defaults to 365 if the config key isn't set.

function _isPioneerExempt(profile, exemptionDays) {
  if (!profile) return false;
  if (profile.role !== 'pioneer') return false;
  if (!profile.pioneer_at) return false;
  const grantedAt = new Date(profile.pioneer_at).getTime();
  if (!Number.isFinite(grantedAt)) return false;
  const days = exemptionDays || 365;
  const expiresAt = grantedAt + days * 24 * 60 * 60 * 1000;
  return Date.now() <= expiresAt;
}

function _pioneerDaysRemaining(profile, exemptionDays) {
  if (!profile?.pioneer_at || profile.role !== 'pioneer') return 0;
  const grantedAt = new Date(profile.pioneer_at).getTime();
  if (!Number.isFinite(grantedAt)) return 0;
  const days = exemptionDays || 365;
  const expiresAt = grantedAt + days * 24 * 60 * 60 * 1000;
  const ms = expiresAt - Date.now();
  return ms <= 0 ? 0 : Math.floor(ms / (24 * 60 * 60 * 1000));
}

// Render the fee preview rows live as the user types in the amount input.
// Wired via input listener at the bottom of this block.
function _renderWithdrawalFeePreview() {
  const amountPhp   = parseFloat(document.getElementById('withdrawalAmount')?.value || '0') || 0;
  const exemptDays  = _walletConfigDefaults.pioneer_exemption_days || 365;
  const exempt      = _isPioneerExempt(currentProfile, exemptDays);
  const daysLeft    = _pioneerDaysRemaining(currentProfile, exemptDays);

  // Pioneer banner visibility + days-left copy
  const banner = document.getElementById('withdrawalPioneerBanner');
  const daysEl = document.getElementById('withdrawalPioneerDays');
  if (banner) banner.style.display = exempt ? 'flex' : 'none';
  if (daysEl) {
    daysEl.textContent = daysLeft > 0
      ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} of free withdrawals remaining`
      : 'Exemption window ending soon';
  }

  const platformFraction = Number(_walletConfigDefaults.PLATFORM_COST ?? 0.2) || 0;
  const transferFraction = Number(_walletConfigDefaults.TRANSFER_FEE  ?? 0.02) || 0;
  const platformPct = (platformFraction <= 1 ? platformFraction : platformFraction / 100);
  const transferPct = (transferFraction <= 1 ? transferFraction : transferFraction / 100);

  const platformCost = exempt ? 0 : amountPhp * platformPct;
  const transferFee  = exempt ? 0 : amountPhp * transferPct;
  const net          = Math.max(0, amountPhp - platformCost - transferFee);

  const fmt = (n) => '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  const setClass = (id, cls, on) => { const el = document.getElementById(id); if (el) el.classList.toggle(cls, on); };

  setText('withdrawalFeeGross',    fmt(amountPhp));
  setText('withdrawalFeePlatform', exempt ? 'Waived' : fmt(platformCost));
  setText('withdrawalFeeTransfer', exempt ? 'Waived' : fmt(transferFee));
  setText('withdrawalFeeNet',      fmt(net));
  setClass('withdrawalFeePlatform', 'is-waived', exempt);
  setClass('withdrawalFeeTransfer', 'is-waived', exempt);

  // Update label percentages so they reflect the current config rates.
  const pctTxt = (frac) => {
    const p = (frac <= 1 ? frac * 100 : frac);
    return `${(Math.round(p * 10) / 10)}%`;
  };
  setText('withdrawalFeePlatformLabel', `Platform cost (${pctTxt(platformFraction)})`);
  setText('withdrawalFeeTransferLabel', `Transfer fee (${pctTxt(transferFraction)})`);
}

// Re-run the preview every keystroke; also once when the modal opens
// (the existing modal-open code sets the input value, which doesn't fire
// `input`, so we hook the open click separately further down).
document.getElementById('withdrawalAmount')?.addEventListener('input', _renderWithdrawalFeePreview);
document.getElementById('withdrawalAmount')?.addEventListener('change', _renderWithdrawalFeePreview);

document.getElementById('withdrawalSubmit')?.addEventListener('click', async () => {
  const amountPhp   = parseFloat(document.getElementById('withdrawalAmount').value);
  const minPhpMinor = _walletConfigDefaults.min_payout_php_minor || 10000;

  if (!Number.isFinite(amountPhp) || amountPhp <= 0) { toast('Enter a valid amount', 'error'); return; }
  const amountMinor = Math.round(amountPhp * 100);
  if (amountMinor < minPhpMinor) {
    toast(`Need at least ${formatPhpFromMinor(minPhpMinor)}`, 'error');
    return;
  }

  const btn = document.getElementById('withdrawalSubmit');
  btn.disabled = true; btn.textContent = 'Submitting…';

  // Switched (May 2026 earnings overhaul) from request_author_withdrawal_php
  // to the unified request_author_withdrawal — the new RPC computes
  // Pioneer-aware fees server-side and earmarks across both coin and
  // star earnings FIFO. Payout method + account details still come from
  // author_kyc (the saved Payments Info row); we forward them through
  // p_payout_method + p_payout_details so the new RPC's signature is
  // satisfied without losing the strict-saved-account guarantee.
  const payoutMethod  = _authorKyc?.payment_method || '';
  const payoutDetails = {
    full_name:      _authorKyc?.full_name      || null,
    account_number: _authorKyc?.account_number || null,
    account_name:   _authorKyc?.account_name   || null,
  };
  const { data, error } = await supabase.rpc('request_author_withdrawal', {
    p_amount_php_minor: amountMinor,
    p_payout_method:    payoutMethod,
    p_payout_details:   payoutDetails,
  });

  btn.disabled = false; btn.textContent = 'Submit request';
  if (error) { toast(error.message, 'error'); return; }
  if (data?.ok === false) {
    const msg = data.error === 'kyc_not_approved'         ? 'KYC must be approved first.' :
                data.error === 'kyc_not_submitted'        ? 'Submit Payments Info first.' :
                data.error === 'no_payment_method_saved'  ? 'Save a payment method in Payments Info first.' :
                data.error === 'below_minimum'            ? `Need at least ${formatPhpFromMinor(data.minimum_php_minor || minPhpMinor)}.` :
                data.error === 'insufficient_available'   ? `Only ${formatPhpFromMinor(data.available_php_minor || 0)} available.` :
                data.error === 'withdrawal_in_progress'   ? 'You already have a pending or approved request.' :
                data.error === 'no_eligible_earnings'     ? 'No eligible earnings yet — your balance might still be in the hold period.' :
                data.error || 'Failed';
    toast(msg, 'error');
    return;
  }
  document.getElementById('withdrawalModal').style.display = 'none';
  toast('Withdrawal request submitted. Admin review usually within 1-3 business days.', 'success');
  await loadAuthorEarnings();
});

// ── New book modal ──
const newBookModal = document.getElementById('newBookModal');
function openNewBookModal() {
  document.getElementById('newBookTitle').value = '';
  document.getElementById('newBookDescription').value = '';
  // Build / reset the new-book genre picker
  if (!_newBookGenrePicker) {
    _newBookGenrePicker = buildGenrePicker('newBookGenrePicker', [], 5);
  } else {
    _newBookGenrePicker.clear();
  }
  newBookModal.style.display = 'flex';
  setTimeout(() => document.getElementById('newBookTitle').focus(), 50);
}
function closeNewBookModal() { newBookModal.style.display = 'none'; }
async function createNewBook() {
  const title = document.getElementById('newBookTitle').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }
  const description = document.getElementById('newBookDescription').value.trim();

  const curated = _newBookGenrePicker?.getSelected() || [];
  const genre = curated.length ? genreSlug(curated[0]) : null;
  const tags  = curated;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { toast('Sign in first', 'error'); return; }

  const btn = document.getElementById('newBookCreate');
  btn.disabled = true; btn.textContent = 'Creating…';

  const { data, error } = await supabase.from('books').insert({
    author_id: user.id,
    title, description, genre, tags,
    status: 'draft',
    is_public: false,
  }).select().single();

  btn.disabled = false; btn.textContent = 'Create book';

  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  closeNewBookModal();
  toast('Book created', 'success');
  openAuthorBookEditor(data.id);
}

document.getElementById('btnNewBook')?.addEventListener('click', openNewBookModal);
// Compose-area Book button (opens the same New Book modal)
document.getElementById('btnOpenBookUpload')?.addEventListener('click', () => {
  openNewBookModal();
});
document.getElementById('newBookClose')?.addEventListener('click', closeNewBookModal);
document.getElementById('newBookCancel')?.addEventListener('click', closeNewBookModal);
document.getElementById('newBookCreate')?.addEventListener('click', createNewBook);
newBookModal?.addEventListener('click', (e) => { if (e.target === newBookModal) closeNewBookModal(); });

// ── Book editor (metadata + chapter list) ──
async function openAuthorBookEditor(bookId) {
  editingBookId = bookId;
  // Reset the chapter tab on each book open so the entry state is
  // predictable. Keeping the tab sticky across DIFFERENT books would
  // surprise authors switching from a draft-heavy book to a published
  // one and finding themselves on an empty Drafts tab.
  _authorChaptersTab = 'published';
  hideAllMainPages();
  authorPage.style.display = 'block';
  setAuthorView('book');
  history.pushState(null, '', `#author/book/${bookId}`);
  // Background sweep — surface any scheduled chapters whose time passed.
  maybeFlushDueScheduledChapters();
  await loadBookEditor(bookId);
}

async function loadBookEditor(bookId) {
  const { data: book, error } = await supabase
    .from('books')
    .select('*')
    .eq('id', bookId)
    .single();
  if (error || !book) { toast('Book not found', 'error'); showAuthor(); return; }

  document.getElementById('bookEditorTitle').value = book.title || '';
  document.getElementById('bookEditorDescription').value = book.description || '';
  document.getElementById('bookEditorBookStatus').value = book.status || 'draft';
  document.getElementById('bookEditorPublic').checked = !!book.is_public;
  document.getElementById('bookEditorStatusBadge').textContent = book.is_public ? 'Visible to readers' : 'Hidden draft';

  // Book-level lock state
  setBookLockUI(book.lock_from_chapter, book.locked_at);

  // Render the lock-prompt banner above the editor form when the
  // book qualifies (Free, not dismissed, author monetizes elsewhere).
  // Empty string when it doesn't — the mount stays in the DOM but
  // renders no banner. We re-derive _authorHasPaidBooks here in case
  // the editor was opened directly via deep link without first
  // loading the dashboard (the dashboard pass is the canonical
  // setter, but the editor needs a fallback).
  const lockPromptMount = document.getElementById('bookEditorLockPrompt');
  if (lockPromptMount) {
    if (!_authorHasPaidBooks) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: hp } = await supabase.rpc('has_paid_books_for_author', { p_actor_id: user.id });
          _authorHasPaidBooks = Boolean(hp);
        }
      } catch (_) {
        // Non-fatal — banner just stays hidden.
      }
    }
    lockPromptMount.innerHTML = renderLockPromptBanner(book);
    ensureLockPromptHandler();
  }

  // Build / refresh genre picker. Seed from book.tags first (where curated genres live),
  // fall back to book.genre (single legacy slug). Unknown freeform tags go to the Custom tags input.
  const allTags = Array.isArray(book.tags) ? book.tags : [];
  const knownLabels    = new Set(SELEBOX_GENRES.map(g => g.toLowerCase()));
  const knownSlugs     = new Set(SELEBOX_GENRES.map(g => genreSlug(g)));
  const curatedSeeded  = allTags.filter(t => knownLabels.has(String(t).toLowerCase()) || knownSlugs.has(genreSlug(t)));
  const customTagsLeft = allTags.filter(t => !curatedSeeded.includes(t));

  // If the picker doesn't exist yet (first open), build it; else just reset selection
  if (!_bookEditorGenrePicker) {
    _bookEditorGenrePicker = buildGenrePicker('bookEditorGenrePicker', curatedSeeded.length ? curatedSeeded : (book.genre ? [book.genre] : []), 5);
  } else {
    _bookEditorGenrePicker.setSelected(curatedSeeded.length ? curatedSeeded : (book.genre ? [book.genre] : []));
  }

  document.getElementById('bookEditorTags').value = customTagsLeft.join(', ');

  const coverWrap = document.getElementById('bookEditorCover');
  const initialLetter = (book.title || '?').trim().charAt(0).toUpperCase();
  coverWrap.innerHTML = book.cover_url
    ? `<img src="${escHTML(book.cover_url)}" alt=""/>`
    : `<div class="book-cover-placeholder">${initialLetter}</div>`;

  // Load chapters. Includes is_locked + created_at so the row can
  // render a lock indicator and we can sort by upload time.
  // Sort: created_at DESC — author surface shows latest-uploaded first
  // so a writer's most recent work is at the top of the inline TOC,
  // mirroring the mobile book editor.
  const { data: chapters, error: chErr } = await supabase
    .from('chapters')
    .select('id, chapter_number, title, word_count, is_published, is_locked, scheduled_publish_at, created_at, updated_at')
    .eq('book_id', bookId)
    .order('created_at', { ascending: false });

  const chList = document.getElementById('bookEditorChapters');
  if (chErr) {
    chList.innerHTML = `<div class="loading">Couldn't load chapters: ${escHTML(chErr.message)}</div>`;
    return;
  }

  // Pass the book's lock_from_chapter through so the row template can
  // show the lock glyph using the same two-signal logic as mobile
  // (chapter.is_locked OR chapter_number >= lock_from_chapter).
  renderAuthorChapterList(chapters || [], bookId, book.lock_from_chapter);
}

// Module-level state for the Published / Drafts tab in the author book
// editor. Reset to "published" on each book open so the entry view is
// predictable; preserved across re-renders within the same book so the
// user can save a chapter and stay on the tab they were filtering on.
let _authorChaptersTab = 'published';

// Determines which tab a chapter belongs to. Mirrors mobile's
// getChapterTabBucket — anything that's not is_published=true is a draft,
// including future-scheduled chapters that have is_published=true but a
// scheduled_publish_at in the future (those count as Published from the
// author's "I've finished writing this" perspective).
function authorChapterBucket(c) {
  return c?.is_published ? 'published' : 'draft';
}

// Renders the chapter rows under whichever tab is active, plus the
// per-tab counts. Centralized so both the initial loadBookEditor pass
// and the tab-click handler can call the same function with the same
// chapters array.
//
// `lockFromChapter` is the book-level paywall threshold (NULL or a
// number 5-10). When non-null, any chapter whose chapter_number is
// >= this value renders with a lock icon, matching the reader's view.
// A per-chapter `is_locked=true` flag also forces the lock icon
// regardless of where the chapter sits relative to the threshold.
function renderAuthorChapterList(chapters, bookId, lockFromChapter) {
  const chList = document.getElementById('bookEditorChapters');
  if (!chList) return;
  // Cache the threshold on the element so subsequent tab-switch
  // re-renders (which call back through this function) don't lose it.
  // The first call from loadBookEditor seeds it; later calls can omit.
  if (lockFromChapter !== undefined) {
    chList.dataset.lockFromChapter = lockFromChapter == null ? '' : String(lockFromChapter);
  }
  const lockStart = chList.dataset.lockFromChapter ? Number(chList.dataset.lockFromChapter) : 0;

  // Update tab counts up front — counts reflect ALL chapters, regardless
  // of which tab is currently active.
  let publishedCount = 0;
  let draftCount = 0;
  for (const c of chapters) {
    if (authorChapterBucket(c) === 'draft') draftCount += 1;
    else publishedCount += 1;
  }
  const pubCountEl = document.getElementById('bookEditorTabCountPublished');
  const draftCountEl = document.getElementById('bookEditorTabCountDrafts');
  if (pubCountEl) pubCountEl.textContent = publishedCount > 99 ? '99+' : String(publishedCount);
  if (draftCountEl) draftCountEl.textContent = draftCount > 99 ? '99+' : String(draftCount);

  // Sync the active-tab class to whatever _authorChaptersTab is set to,
  // and (critically) re-attach tab click handlers BEFORE the early-return
  // cases below. If the user is on a tab with no visible chapters (e.g.
  // Published with 0 published, only drafts exist), the function would
  // previously bail out via `!visible.length` BEFORE the click handlers
  // were wired — leaving the tabs frozen and the user stuck on an empty
  // bucket. Wiring them up here means tabs are always clickable.
  document.querySelectorAll('#bookEditorChapterTabs .author-chapter-tab').forEach((btn) => {
    const isActive = btn.dataset.authorTab === _authorChaptersTab;
    btn.classList.toggle('is-active', isActive);
    btn.onclick = () => {
      const next = btn.dataset.authorTab;
      if (!next || next === _authorChaptersTab) return;
      _authorChaptersTab = next;
      // Don't re-pass lockFromChapter on tab switches — it's already
      // cached on the element's dataset from the initial render.
      renderAuthorChapterList(chapters, bookId);
    };
  });

  if (!chapters.length) {
    chList.innerHTML = '<div style="color:var(--text2);padding:1rem 0">No chapters yet. Click <strong>Add chapter</strong> to write the first one.</div>';
    return;
  }

  // Filter by the active tab. Empty-state copy is bucket-aware so the
  // Drafts tab feels intentional rather than broken when there are zero.
  const visible = chapters.filter((c) => authorChapterBucket(c) === (_authorChaptersTab === 'drafts' ? 'draft' : 'published'));
  if (!visible.length) {
    chList.innerHTML = _authorChaptersTab === 'drafts'
      ? '<div style="color:var(--text2);padding:1rem 0">No drafts yet — every chapter you save as draft will land here.</div>'
      : '<div style="color:var(--text2);padding:1rem 0">No published chapters yet.</div>';
    return;
  }

  chList.innerHTML = visible.map(c => {
    const isFutureSch = c.is_published && c.scheduled_publish_at && new Date(c.scheduled_publish_at) > new Date();
    let pillClass, pillLabel;
    if (isFutureSch)        { pillClass = 'author-chapter-pub-scheduled'; pillLabel = 'Scheduled · ' + formatScheduleShort(c.scheduled_publish_at); }
    else if (c.is_published) { pillClass = 'author-chapter-pub-published'; pillLabel = 'Published'; }
    else                     { pillClass = 'author-chapter-pub-draft';     pillLabel = 'Draft'; }
    // Two-signal lock check, same logic as mobile's isAuthorChapterLocked:
    //   • chapter.is_locked === true  (per-chapter override), OR
    //   • lockStart > 0 AND chapter_number >= lockStart  (book-level cascade)
    const isLocked = !!c.is_locked || (lockStart > 0 && Number(c.chapter_number) >= lockStart);
    const lockIcon = isLocked
      ? `<span class="author-chapter-lock" title="Locked"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>`
      : '';
    return `
    <div class="author-chapter-row" data-chapter-id="${c.id}">
      <span class="author-chapter-num">Ch ${c.chapter_number}</span>
      <span class="author-chapter-title">${lockIcon}${escHTML(c.title || `Chapter ${c.chapter_number}`)}</span>
      <span class="author-chapter-meta">${(c.word_count || 0).toLocaleString()} words</span>
      <span class="author-chapter-pub-pill ${pillClass}">${escHTML(pillLabel)}</span>
      <div class="author-chapter-actions">
        <button class="author-book-action-btn" data-chapter-action="edit" data-id="${c.id}" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="author-book-action-btn author-book-action-btn-danger" data-chapter-action="delete" data-id="${c.id}" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
      </div>
    </div>
  `;
  }).join('');

  chList.querySelectorAll('[data-chapter-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.chapterAction;
      const chapterId = btn.dataset.id;
      if (action === 'edit') openAuthorChapterEditor(bookId, chapterId);
      else if (action === 'delete') deleteAuthorChapter(chapterId, bookId);
    });
  });
  chList.querySelectorAll('.author-chapter-row').forEach(row => {
    row.addEventListener('click', () => openAuthorChapterEditor(bookId, row.dataset.chapterId));
  });

  // Tab click handlers were attached above — before the early returns —
  // so they always work regardless of which bucket is currently empty.
}

async function saveBookMetadata() {
  if (!editingBookId) return;
  const btn = document.getElementById('btnSaveBook');
  const title = document.getElementById('bookEditorTitle').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }

  btn.disabled = true; btn.textContent = 'Saving…';

  // Combine curated genres (from picker) + free-form custom tags
  const curated = _bookEditorGenrePicker?.getSelected() || [];
  const customTags = document.getElementById('bookEditorTags').value.split(',').map(t => t.trim()).filter(Boolean);
  // De-dupe — case-insensitive
  const seen = new Set();
  const tags = [...curated, ...customTags].filter(t => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  // Browse filter still uses single `genre` field — slug of first selected curated genre
  const genre = curated.length ? genreSlug(curated[0]) : null;
  const description = document.getElementById('bookEditorDescription').value.trim();
  // The Status dropdown and the Public checkbox are independent fields
  // in the editor UI, but checking "Public" with status='draft' is a
  // common UX trap: web's own list query AND mobile's
  // fetchPublishedBooks both filter status IN ('ongoing','completed'),
  // so a book with is_public=true + status='draft' is invisible
  // everywhere despite the user thinking they hit Publish.
  // Auto-promote draft → ongoing whenever the user saves with the
  // Public box checked. They can still flip to 'completed' later via
  // the dropdown. This matches user intent ("publish my book") without
  // forcing them to remember to change two fields in lockstep.
  let status = document.getElementById('bookEditorBookStatus').value;
  const isPublic = document.getElementById('bookEditorPublic').checked;
  if (isPublic && status === 'draft') {
    status = 'ongoing';
    // Sync the dropdown UI so the user sees the auto-promotion happen.
    document.getElementById('bookEditorBookStatus').value = 'ongoing';
  }

  // Lock-from-chapter (book-level). Must be in {5..10}; server has matching
  // CHECK constraint plus a 90-day-no-removal trigger.
  const lockEnabled = document.getElementById('bookLockEnabled')?.checked || false;
  const lockFromRaw = document.getElementById('bookLockFromChapter')?.value;
  let lockFromChapter = null;
  if (lockEnabled && lockFromRaw) {
    const n = parseInt(lockFromRaw, 10);
    if (!Number.isFinite(n) || n < 5 || n > 10) {
      toast('Lock-from-chapter must be between 5 and 10', 'error');
      btn.disabled = false; btn.textContent = 'Save';
      return;
    }
    lockFromChapter = n;
  }

  const update = {
    title, description, genre, tags, status, is_public: isPublic,
    lock_from_chapter: lockFromChapter,
    updated_at: new Date().toISOString(),
  };
  // Set published_at the first time the book becomes public
  if (isPublic) {
    const { data: existing } = await supabase.from('books').select('published_at').eq('id', editingBookId).single();
    if (!existing?.published_at) update.published_at = new Date().toISOString();
  }

  const { error } = await supabase.from('books').update(update).eq('id', editingBookId);
  btn.disabled = false; btn.textContent = 'Save';

  if (error) {
    // 90-day-grace trigger raises P0001 with a friendly message
    if (/90 days/i.test(error.message)) toast(error.message, 'error');
    else toast('Failed: ' + error.message, 'error');
    return;
  }
  toast('Saved', 'success');
  document.getElementById('bookEditorStatusBadge').textContent = isPublic ? 'Visible to readers' : 'Hidden draft';

  // Re-fetch to update locked_at after a fresh lock
  if (lockFromChapter !== null) {
    const { data: refreshed } = await supabase.from('books')
      .select('lock_from_chapter, locked_at').eq('id', editingBookId).single();
    if (refreshed) setBookLockUI(refreshed.lock_from_chapter, refreshed.locked_at);
  }
}

// ── Book lock UI helpers ────────────────────────────────────────────────
function setBookLockUI(lockFromChapter, lockedAt) {
  const cb       = document.getElementById('bookLockEnabled');
  const inp      = document.getElementById('bookLockFromChapter');
  const status   = document.getElementById('bookLockStatus');
  const warning  = document.getElementById('bookLockWarning');
  const toggle   = cb?.closest('.book-lock-toggle');
  if (!cb || !inp) return;

  const isLocked = lockFromChapter != null;
  cb.checked = isLocked;
  inp.value  = isLocked ? lockFromChapter : '';
  inp.disabled = !isLocked;

  // Default: toggle clickable.
  cb.disabled = false;
  toggle?.classList.remove('is-locked-grace');

  if (isLocked && lockedAt) {
    const lockedDate    = new Date(lockedAt);
    const eligibleDate  = new Date(lockedDate.getTime() + 90 * 24 * 60 * 60 * 1000);
    const now           = new Date();
    const fmt = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    if (now < eligibleDate) {
      const days = Math.ceil((eligibleDate - now) / (24 * 60 * 60 * 1000));
      // Within 90-day window: disable the toggle so the author can't try
      // to flip it off (server would reject anyway). Cost dropdown stays
      // editable (changing the lock point is allowed).
      cb.disabled = true;
      toggle?.classList.add('is-locked-grace');
      status.style.display = '';
      status.innerHTML = `<strong>Locked since ${fmt(lockedDate)}.</strong> You can disable this lock starting <strong>${fmt(eligibleDate)}</strong> (${days} day${days === 1 ? '' : 's'} from now).`;
      if (warning) warning.style.display = 'none';
    } else {
      // 90 days passed — toggle becomes clickable for unlock.
      status.style.display = '';
      status.innerHTML = `<strong>Locked since ${fmt(lockedDate)}.</strong> The 90-day window has passed — you can disable the lock anytime.`;
      if (warning) warning.style.display = 'none';
    }
  } else {
    status.style.display = 'none';
    if (warning) warning.style.display = '';
  }
}

// Toggle the input enable state when the checkbox flips
document.getElementById('bookLockEnabled')?.addEventListener('change', (e) => {
  const inp = document.getElementById('bookLockFromChapter');
  if (!inp) return;
  inp.disabled = !e.target.checked;
  if (e.target.checked && !inp.value) inp.value = '5';
});
document.getElementById('btnSaveBook')?.addEventListener('click', saveBookMetadata);
document.getElementById('btnBackToDashboard')?.addEventListener('click', showAuthor);

// Cover upload
document.getElementById('btnUploadCover')?.addEventListener('click', () => {
  document.getElementById('bookCoverFile').click();
});
document.getElementById('bookCoverFile')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !editingBookId) return;
  if (!file.type.startsWith('image/')) { toast('Pick an image file', 'error'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('Cover must be under 5MB', 'error'); return; }

  // Open the crop modal at 2:3 (book cover standard). The save callback
  // uploads the cropped JPEG to book-covers and updates books.cover_url.
  openCropModal(file, {
    aspectRatio: 2 / 3,
    title: 'Crop book cover',
    onSave: async (croppedFile) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { toast('Sign in first', 'error'); return; }

      const path = `${user.id}/${editingBookId}-${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage.from('book-covers').upload(path, croppedFile, { upsert: true, contentType: 'image/jpeg' });
      if (upErr) { toast('Upload failed: ' + upErr.message, 'error'); return; }

      const { data: { publicUrl } } = supabase.storage.from('book-covers').getPublicUrl(path);
      const { error: updErr } = await supabase.from('books').update({ cover_url: publicUrl, updated_at: new Date().toISOString() }).eq('id', editingBookId);
      if (updErr) { toast('Saved file but DB update failed: ' + updErr.message, 'error'); return; }

      document.getElementById('bookEditorCover').innerHTML = `<img src="${escHTML(publicUrl)}" alt=""/>`;
      toast('Cover updated', 'success');
    },
  });
});

// New chapter
document.getElementById('btnNewChapter')?.addEventListener('click', () => {
  if (!editingBookId) return;
  openAuthorChapterEditor(editingBookId, null);
});

async function deleteAuthorChapter(chapterId, bookId) {
  const ok = await confirmDialog({
    title: 'Delete this chapter?',
    body: 'The chapter and its content will be permanently removed. This can\'t be undone.',
    confirmLabel: 'Delete forever',
  });
  if (!ok) return;
  const { error } = await supabase.from('chapters').delete().eq('id', chapterId);
  if (error) { toast('Failed: ' + error.message, 'error'); return; }
  // Recompute denormalized counts
  await recomputeBookCounts(bookId);
  toast('Chapter deleted', 'success');
  loadBookEditor(bookId);
}

async function recomputeBookCounts(bookId) {
  const { data: rows } = await supabase
    .from('chapters')
    .select('word_count, is_published')
    .eq('book_id', bookId);
  if (!rows) return;
  const chaptersCount = rows.filter(r => r.is_published).length;
  const wordCount = rows.reduce((s, r) => s + (r.word_count || 0), 0);
  await supabase.from('books').update({ chapters_count: chaptersCount, word_count: wordCount, updated_at: new Date().toISOString() }).eq('id', bookId);
}

// ── Chapter editor (Quill) ──
async function openAuthorChapterEditor(bookId, chapterId) {
  editingBookId = bookId;
  editingChapterId = chapterId;
  hideAllMainPages();
  authorPage.style.display = 'block';
  setAuthorView('chapter');
  history.pushState(null, '', `#author/book/${bookId}/chapter/${chapterId || 'new'}`);

  // Init Quill on first use
  if (!chapterQuill) {
    chapterQuill = new Quill('#chapterEditorQuill', {
      theme: 'snow',
      placeholder: 'Start writing your chapter…',
      modules: {
        toolbar: {
          container: [
            [{ header: [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ list: 'ordered' }, { list: 'bullet' }],
            ['blockquote', 'link', 'image'],
            [{ align: [] }],
            ['clean'],
          ],
          handlers: {
            image: openChapterImagePicker,
          },
        },
      },
    });
    chapterQuill.on('text-change', () => {
      chapterDirty = true;
      updateChapterWordCount();
      scheduleChapterAutosave();
    });
    document.getElementById('chapterEditorTitle').addEventListener('input', () => {
      chapterDirty = true;
      scheduleChapterAutosave();
    });

    // ─── Chapter cover upload ───
    document.getElementById('btnUploadChapterCover')?.addEventListener('click', () => {
      document.getElementById('chapterCoverFile').click();
    });
    document.getElementById('btnReplaceChapterCover')?.addEventListener('click', () => {
      document.getElementById('chapterCoverFile').click();
    });
    document.getElementById('btnRemoveChapterCover')?.addEventListener('click', removeChapterCover);
    document.getElementById('chapterCoverFile')?.addEventListener('change', uploadChapterCover);

    // ─── Inline content image upload ───
    document.getElementById('chapterContentImageFile')?.addEventListener('change', uploadChapterInlineImage);
  }

  // Reset state
  chapterQuill.setText('');
  document.getElementById('chapterEditorTitle').value = '';
  _chapterPublishState = { is_published: false, scheduled_publish_at: null };
  setChapterLockControls(false, null, null);
  setChapterStatePill();
  setChapterCoverPreview(null);
  setChapterSaveStatus('idle');
  chapterDirty = false;

  // Fetch the book's lock_from_chapter so we can gate the per-chapter
  // Premium toggle: chapters BELOW the lock-from point can't be marked
  // premium individually (they're always free).
  let bookLockFrom = null;
  try {
    const { data: b } = await supabase.from('books')
      .select('lock_from_chapter')
      .eq('id', bookId)
      .maybeSingle();
    bookLockFrom = b?.lock_from_chapter ?? null;
  } catch {}

  if (chapterId) {
    const { data, error } = await supabase
      .from('chapters')
      .select('id, chapter_number, title, content, is_published, scheduled_publish_at, cover_url, is_locked, unlock_cost_coins, unlock_cost_stars')
      .eq('id', chapterId)
      .single();
    if (error || !data) { toast('Chapter not found', 'error'); openAuthorBookEditor(bookId); return; }
    document.getElementById('chapterEditorTitle').value = data.title || '';
    _chapterPublishState = {
      is_published: !!data.is_published,
      scheduled_publish_at: data.scheduled_publish_at || null,
    };
    setChapterStatePill();
    setChapterCoverPreview(data.cover_url || null);
    setChapterLockControls(data.is_locked, data.unlock_cost_coins, data.unlock_cost_stars, data.chapter_number, bookLockFrom);
    if (data.content) chapterQuill.clipboard.dangerouslyPasteHTML(data.content);
    chapterDirty = false;
  } else {
    // New chapter — chapter_number is computed at save time. For UI, treat
    // as eligible if book lock is set (we don't know N yet, optimistic).
    setChapterLockControls(false, null, null, null, bookLockFrom);
  }

  updateChapterWordCount();
  setTimeout(() => chapterQuill.focus(), 100);
}

function updateChapterWordCount() {
  if (!chapterQuill) return;
  const text = chapterQuill.getText().trim();
  const words = text.length ? text.split(/\s+/).length : 0;
  const min   = _walletConfigDefaults.min_chapter_words || 100;
  const max   = _walletConfigDefaults.max_chapter_words || 10000;

  const wcEl = document.getElementById('chapterWordCount');
  if (wcEl) wcEl.textContent = words.toLocaleString();

  // Color-code the word count container based on whether the chapter is
  // publishable. The container is the .chapter-meta-strip element.
  const strip = wcEl?.closest('.chapter-meta-strip');
  if (!strip) return;

  strip.classList.remove('wc-under', 'wc-ok', 'wc-over');
  let label = '';
  if (words === 0) {
    label = `Aim for ${min.toLocaleString()}–${max.toLocaleString()} words`;
  } else if (words < min) {
    strip.classList.add('wc-under');
    label = `${(min - words).toLocaleString()} more to reach minimum (${min.toLocaleString()})`;
  } else if (words > max) {
    strip.classList.add('wc-over');
    label = `${(words - max).toLocaleString()} over the maximum (${max.toLocaleString()})`;
  } else {
    strip.classList.add('wc-ok');
    label = `Within range · max ${max.toLocaleString()}`;
  }

  // Inject (or update) a small hint span next to the count
  let hint = strip.querySelector('.chapter-wc-hint');
  if (!hint) {
    hint = document.createElement('span');
    hint.className = 'chapter-wc-hint';
    strip.appendChild(hint);
  }
  hint.textContent = label;
}

// Sync the lock UI with a chapter row's lock fields. Also gates the toggle
// based on book.lock_from_chapter — chapters below that point can never be
// marked premium individually (1-4 are always free).
function setChapterLockControls(locked, coins, stars, chapterNumber, bookLockFrom) {
  const cb        = document.getElementById('chapterLockEnabled');
  const costRow   = document.getElementById('chapterLockCostRow');
  const coinsInp  = document.getElementById('chapterLockCoins');
  const starsInp  = document.getElementById('chapterLockStars');
  const sub       = document.getElementById('chapterLockSub');
  const toggle    = cb?.closest('.lock-toggle');
  if (!cb) return;
  cb.checked = !!locked;
  if (costRow) costRow.style.display = locked ? '' : 'none';
  if (coinsInp) coinsInp.value = (coins ?? '') === null ? '' : (coins || '');
  if (starsInp) starsInp.value = (stars ?? '') === null ? '' : (stars || '');

  // Eligibility check
  // - If the book has NO book-level lock → no per-chapter premium possible
  //   (the new model is book-level-only; per-chapter is an override only)
  // - If chapterNumber is below book.lock_from_chapter → can't lock
  // - Otherwise → eligible
  let eligible = true;
  let reason = '';
  if (bookLockFrom == null) {
    eligible = false;
    reason = 'Set book-level lock first (in book editor) before marking individual chapters premium.';
  } else if (chapterNumber != null && chapterNumber < bookLockFrom) {
    eligible = false;
    reason = `Chapters before #${bookLockFrom} are always free for readers.`;
  }

  cb.disabled = !eligible;
  if (toggle) toggle.classList.toggle('is-disabled', !eligible);
  if (sub) {
    sub.textContent = eligible
      ? 'Readers pay coins or stars to unlock. You set the price below.'
      : reason;
  }
  // If not eligible, force unchecked (defensive)
  if (!eligible && cb.checked) {
    cb.checked = false;
    if (costRow) costRow.style.display = 'none';
  }
}

// Show/hide cost row when toggle flips, mark dirty so autosave fires.
document.getElementById('chapterLockEnabled')?.addEventListener('change', (e) => {
  const costRow = document.getElementById('chapterLockCostRow');
  if (costRow) costRow.style.display = e.target.checked ? '' : 'none';
  chapterDirty = true;
  scheduleChapterAutosave();
});
['chapterLockCoins', 'chapterLockStars'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => {
    chapterDirty = true;
    scheduleChapterAutosave();
  });
});

function setChapterSaveStatus(state) {
  const el = document.getElementById('chapterSaveStatus');
  el.classList.remove('saving', 'saved', 'error');
  if (state === 'saving')      { el.classList.add('saving'); el.textContent = 'Saving…'; }
  else if (state === 'saved')  { el.classList.add('saved');  el.textContent = 'Saved'; }
  else if (state === 'error')  { el.classList.add('error');  el.textContent = 'Save failed'; }
  else                          el.textContent = 'Idle';
}

function scheduleChapterAutosave() {
  if (chapterAutosaveTimer) clearTimeout(chapterAutosaveTimer);
  chapterAutosaveTimer = setTimeout(saveChapter, 1500);
}

async function saveChapter() {
  if (!editingBookId || !chapterQuill) return;
  setChapterSaveStatus('saving');
  const title = document.getElementById('chapterEditorTitle').value.trim();
  const content = chapterQuill.root.innerHTML;
  const text = chapterQuill.getText().trim();
  const wordCount = text.length ? text.split(/\s+/).length : 0;

  // Cover URL — null if no cover, otherwise the public URL of uploaded image
  const coverUrl = document.getElementById('chapterCoverImg')?.dataset?.url || null;

  // Lock fields
  const isLocked = document.getElementById('chapterLockEnabled')?.checked || false;
  const lockCoinsRaw = document.getElementById('chapterLockCoins')?.value;
  const lockStarsRaw = document.getElementById('chapterLockStars')?.value;
  // Clamp to 1..10 — defensive in case someone bypasses the input min/max
  const clampCost = (v) => {
    if (v == null || v === '') return null;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.min(10, n);
  };
  const unlockCostCoins = isLocked ? clampCost(lockCoinsRaw) : null;
  const unlockCostStars = isLocked ? clampCost(lockStarsRaw) : null;

  let result;
  if (editingChapterId) {
    // Save = autosave the draft body. Don't touch is_published or scheduled_publish_at —
    // those are owned by the Publish/Unpublish flow.
    result = await supabase.from('chapters').update({
      title, content, word_count: wordCount,
      cover_url: coverUrl,
      is_locked: isLocked,
      unlock_cost_coins: unlockCostCoins,
      unlock_cost_stars: unlockCostStars,
      updated_at: new Date().toISOString(),
    }).eq('id', editingChapterId).select().single();
  } else {
    // Determine next chapter number
    const { data: existing } = await supabase.from('chapters').select('chapter_number').eq('book_id', editingBookId).order('chapter_number', { ascending: false }).limit(1);
    const nextNum = (existing?.[0]?.chapter_number || 0) + 1;
    result = await supabase.from('chapters').insert({
      book_id: editingBookId,
      chapter_number: nextNum,
      title, content, word_count: wordCount,
      is_published: false, // brand-new chapter is always a draft until Publish
      cover_url: coverUrl,
      is_locked: isLocked,
      unlock_cost_coins: unlockCostCoins,
      unlock_cost_stars: unlockCostStars,
    }).select().single();
    if (result.data) {
      editingChapterId = result.data.id;
      // Update URL with the real chapter id
      history.replaceState(null, '', `#author/book/${editingBookId}/chapter/${editingChapterId}`);
    }
  }

  if (result.error) {
    setChapterSaveStatus('error');
    return;
  }
  await recomputeBookCounts(editingBookId);
  setChapterSaveStatus('saved');
  chapterDirty = false;
}

// ════════════════════════════════════════════════════════════════════════════
// Chapter publish — Now / Schedule + Wattpad-style success modal
// ════════════════════════════════════════════════════════════════════════════

// Mirror of chapter row's publish state, kept in sync as we edit.
let _chapterPublishState = { is_published: false, scheduled_publish_at: null };

// Throttled diagnostic sweep so the author sees recent schedule firings reflected.
let _lastChapterPublishCheck = 0;
function maybeFlushDueScheduledChapters() {
  const now = Date.now();
  if (now - _lastChapterPublishCheck < 5 * 60 * 1000) return; // 5 min throttle
  _lastChapterPublishCheck = now;
  supabase.rpc('publish_due_scheduled_chapters').then(({ error }) => {
    if (error) console.warn('publish_due_scheduled_chapters:', error.message);
  }).catch(() => {});
}

function setChapterStatePill() {
  const pill = document.getElementById('chapterStatePill');
  const txt  = pill?.querySelector('.chapter-state-text');
  const btnLabel = document.getElementById('btnPublishChapterLabel');
  if (!pill || !txt) return;

  const { is_published, scheduled_publish_at } = _chapterPublishState;
  const isFutureSchedule = is_published && scheduled_publish_at && new Date(scheduled_publish_at) > new Date();

  if (!is_published) {
    pill.dataset.state = 'draft';
    txt.textContent = 'Draft';
    if (btnLabel) btnLabel.textContent = 'Publish';
  } else if (isFutureSchedule) {
    pill.dataset.state = 'scheduled';
    txt.textContent = 'Scheduled · ' + formatScheduleShort(scheduled_publish_at);
    if (btnLabel) btnLabel.textContent = 'Reschedule';
  } else {
    pill.dataset.state = 'published';
    txt.textContent = 'Published';
    if (btnLabel) btnLabel.textContent = 'Republish';
  }
}

function formatScheduleShort(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  } catch { return ''; }
}

// ── Publish dialog ──
function openChapterPublishModal() {
  if (!editingChapterId) {
    toast('Save your chapter first', 'error');
    return;
  }
  const modal = document.getElementById('chapterPublishModal');
  const subtitle = document.getElementById('cpSubtitle');
  const commitBtn = document.getElementById('cpCommit');
  const unpubBtn  = document.getElementById('cpUnpublish');
  const radioNow  = document.querySelector('label.vu-radio[data-cp-when="now"]');
  const radioSch  = document.querySelector('label.vu-radio[data-cp-when="schedule"]');
  const dtWrap    = document.getElementById('cpScheduleWrap');
  const dtInput   = document.getElementById('cpScheduleDatetime');

  const { is_published, scheduled_publish_at } = _chapterPublishState;
  const isFutureSchedule = is_published && scheduled_publish_at && new Date(scheduled_publish_at) > new Date();

  // Default radio + datetime based on current state
  if (isFutureSchedule) {
    document.querySelector('input[name="cpWhen"][value="schedule"]').checked = true;
    radioNow.classList.remove('active'); radioSch.classList.add('active');
    dtWrap.style.display = 'block';
    // Pre-fill picker with current scheduled time (in local format)
    const d = new Date(scheduled_publish_at);
    const pad = n => String(n).padStart(2, '0');
    dtInput.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    subtitle.textContent = 'Currently scheduled — change the time or publish now';
  } else {
    document.querySelector('input[name="cpWhen"][value="now"]').checked = true;
    radioNow.classList.add('active'); radioSch.classList.remove('active');
    dtWrap.style.display = 'none';
    dtInput.value = '';
    subtitle.textContent = is_published ? 'Already live — re-publish or unpublish below' : 'Choose when this chapter goes live';
  }

  unpubBtn.style.display = is_published ? '' : 'none';
  commitBtn.textContent = 'Publish now';

  modal.style.display = 'flex';
}

function closeChapterPublishModal() {
  document.getElementById('chapterPublishModal').style.display = 'none';
}

async function commitChapterPublish() {
  const which = document.querySelector('input[name="cpWhen"]:checked')?.value || 'now';
  let scheduledAt = null;
  if (which === 'schedule') {
    const dtStr = document.getElementById('cpScheduleDatetime').value;
    if (!dtStr) { toast('Pick a date and time', 'error'); return; }
    const dt = new Date(dtStr);
    if (isNaN(dt.getTime()) || dt.getTime() <= Date.now()) {
      toast('Schedule a future time', 'error');
      return;
    }
    scheduledAt = dt.toISOString();
  }

  const commitBtn = document.getElementById('cpCommit');

  // Word-count guardrail (admin-tunable in app_config: min/max_chapter_words).
  // Pull live word count from the Quill editor so the check matches what the
  // author currently sees in the meta strip.
  const text = chapterQuill?.getText().trim() || '';
  const words = text.length ? text.split(/\s+/).length : 0;
  const minW = _walletConfigDefaults.min_chapter_words || 100;
  const maxW = _walletConfigDefaults.max_chapter_words || 10000;
  if (words < minW) {
    toast(`Chapter must be at least ${minW.toLocaleString()} words. Current: ${words.toLocaleString()}.`, 'error');
    return;
  }
  if (words > maxW) {
    toast(`Chapter is too long — max ${maxW.toLocaleString()} words. Current: ${words.toLocaleString()}. Split it into multiple chapters.`, 'error');
    return;
  }

  commitBtn.disabled = true;
  commitBtn.textContent = scheduledAt ? 'Scheduling…' : 'Publishing…';

  // Persist any unsaved body edits first so what we publish is current.
  if (chapterDirty) await saveChapter();

  const { error } = await supabase.from('chapters').update({
    is_published: true,
    scheduled_publish_at: scheduledAt,
    updated_at: new Date().toISOString(),
  }).eq('id', editingChapterId);

  if (error) {
    commitBtn.disabled = false;
    commitBtn.textContent = scheduledAt ? 'Schedule' : 'Publish now';
    toast('Couldn\'t publish: ' + error.message, 'error');
    return;
  }

  // Update local state + UI
  _chapterPublishState = { is_published: true, scheduled_publish_at: scheduledAt };
  setChapterStatePill();
  closeChapterPublishModal();

  // Touch the book's updated_at so dashboards re-sort.
  await supabase.from('books').update({ updated_at: new Date().toISOString() }).eq('id', editingBookId);

  // Show the Wattpad-style success modal
  await showChapterPublishSuccess(editingBookId, editingChapterId, !!scheduledAt, scheduledAt);

  commitBtn.disabled = false;
  commitBtn.textContent = 'Publish now';
}

async function unpublishChapter() {
  if (!editingChapterId) return;
  const { error } = await supabase.from('chapters').update({
    is_published: false,
    scheduled_publish_at: null,
    updated_at: new Date().toISOString(),
  }).eq('id', editingChapterId);
  if (error) { toast('Couldn\'t unpublish: ' + error.message, 'error'); return; }
  _chapterPublishState = { is_published: false, scheduled_publish_at: null };
  setChapterStatePill();
  closeChapterPublishModal();
  toast('Chapter unpublished', 'success');
}

// ── Wattpad-style success modal ──
async function showChapterPublishSuccess(bookId, chapterId, isScheduled, scheduledAt) {
  // Pull just enough data for the card. Keep it cheap.
  const [bookRes, chRes] = await Promise.all([
    supabase.from('books').select('id, title, cover_url, genre, tags').eq('id', bookId).maybeSingle(),
    supabase.from('chapters').select('id, chapter_number, title').eq('id', chapterId).maybeSingle(),
  ]);
  const book = bookRes.data || {};
  const ch   = chRes.data   || {};

  const modal = document.getElementById('chapterPublishSuccessModal');
  const title = document.getElementById('cpSuccessTitle');
  const sub   = document.getElementById('cpSuccessSub');
  const cover = document.getElementById('cpSuccessCover');
  const bookT = document.getElementById('cpSuccessBookTitle');
  const chNum = document.getElementById('cpSuccessChapterNum');
  const chTit = document.getElementById('cpSuccessChapterTitle');
  const chips = document.getElementById('cpSuccessChips');
  const previewBtn = document.getElementById('cpSuccessPreview');
  const shareBtn   = document.getElementById('cpSuccessShare');

  title.textContent = isScheduled ? 'Chapter scheduled!' : 'Chapter published!';
  sub.textContent   = isScheduled
    ? `Goes live ${formatScheduleShort(scheduledAt)} — readers can’t see it until then.`
    : 'Your readers can dive in right now.';

  if (book.cover_url) {
    cover.src = book.cover_url;
    cover.style.display = '';
  } else {
    cover.removeAttribute('src');
    cover.style.display = 'none';
  }
  bookT.textContent = book.title || 'Untitled book';
  chNum.textContent = `Ch ${ch.chapter_number || ''}`.trim();
  chTit.textContent = ch.title || `Chapter ${ch.chapter_number || ''}`.trim();

  // "Found under" chips: genre first, then up to 4 tags
  chips.innerHTML = '';
  const labels = [];
  if (book.genre) labels.push(book.genre);
  if (Array.isArray(book.tags)) labels.push(...book.tags.slice(0, 4));
  if (!labels.length) labels.push('Uncategorized');
  labels.forEach(l => {
    const span = document.createElement('span');
    span.className = 'cp-chip';
    span.textContent = l;
    chips.appendChild(span);
  });

  // Wire actions (use the public reader URL — works for both states; scheduled
  // chapters will 404 for non-authors via RLS, which is the desired UX).
  // Path-based URL so mobile Universal Links / App Links pick this up
  // when shared.
  const shareUrl = `${location.origin}/books/${bookId}/chapter/${chapterId}`;
  shareBtn.onclick = async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: book.title || 'Selebox',
          text: `Read "${ch.title || 'Chapter ' + (ch.chapter_number || '')}" on Selebox`,
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        toast('Link copied to clipboard', 'success');
      }
    } catch { /* user cancelled */ }
  };
  previewBtn.onclick = () => {
    closeChapterPublishSuccessModal();
    location.hash = `#book/${bookId}/chapter/${chapterId}`;
  };

  modal.style.display = 'flex';
}

function closeChapterPublishSuccessModal() {
  document.getElementById('chapterPublishSuccessModal').style.display = 'none';
}

// ── Wire up buttons (one-shot init guarded by dataset flag) ──
function wireChapterPublishUI() {
  const root = document.getElementById('btnPublishChapter');
  if (!root || root.dataset.wired) return;
  root.dataset.wired = '1';

  root.addEventListener('click', openChapterPublishModal);
  document.getElementById('cpClose')?.addEventListener('click', closeChapterPublishModal);
  document.getElementById('cpCancel')?.addEventListener('click', closeChapterPublishModal);
  document.getElementById('cpCommit')?.addEventListener('click', commitChapterPublish);
  document.getElementById('cpUnpublish')?.addEventListener('click', unpublishChapter);

  // Radio active-state + datetime visibility
  document.querySelectorAll('label.vu-radio[data-cp-when]').forEach(label => {
    label.addEventListener('click', () => {
      document.querySelectorAll('label.vu-radio[data-cp-when]').forEach(l => l.classList.remove('active'));
      label.classList.add('active');
      const wrap = document.getElementById('cpScheduleWrap');
      wrap.style.display = label.dataset.cpWhen === 'schedule' ? 'block' : 'none';
    });
  });

  // Success modal close
  document.getElementById('cpSuccessClose')?.addEventListener('click', closeChapterPublishSuccessModal);
  document.getElementById('chapterPublishSuccessModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'chapterPublishSuccessModal') closeChapterPublishSuccessModal();
  });
  document.getElementById('chapterPublishModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'chapterPublishModal') closeChapterPublishModal();
  });
}
// Init once when the script loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireChapterPublishUI);
} else {
  wireChapterPublishUI();
}

// ════════════════════════════════════════════════════════════════════════════
// Tag chip input — YouTube-style chips around an existing <input>
// ════════════════════════════════════════════════════════════════════════════
//
// Wraps a hidden `<input>` whose `.value` is kept in sync with the chip
// array (joined by ", "). Existing form-handling code that reads
// `document.getElementById('videoUploadTags').value` continues to work
// unchanged, and code that writes `el.value = "a, b, c"` (e.g. when
// populating the studio edit modal) re-renders the chips because we
// override the `value` accessor to fire a sync.
//
// Behaviors:
//   • Type + comma → chip commits (mid-type recognition)
//   • Enter → chip commits
//   • Blur → any pending text commits
//   • Backspace on empty editor → drops last chip
//   • × on a chip → removes that chip
//   • De-dupe is case-insensitive, first-seen casing wins
//   • maxTags caps how many can be added; editor disables when full
function attachTagChips(inputEl, { maxTags = 15 } = {}) {
  if (!inputEl || inputEl._tagChipsAttached) return;
  inputEl._tagChipsAttached = true;

  const wrapper = document.createElement('div');
  wrapper.className = 'tag-chip-wrap';

  const editor = document.createElement('input');
  editor.type = 'text';
  editor.className = 'tag-chip-editor';
  editor.placeholder = inputEl.placeholder || 'Add a tag…';
  editor.autocomplete = 'off';
  editor.autocapitalize = 'off';
  editor.spellcheck = false;

  // Hide the original but keep it in the DOM so existing form code's
  // `.value` reads/writes still hit a real input.
  inputEl.style.display = 'none';
  inputEl.parentNode.insertBefore(wrapper, inputEl.nextSibling);

  // Tags list lives on the wrapper element; chips render inside it,
  // editor is appended last so it sits visually after the chips.
  let tags = [];

  const splitInput = (text) =>
    String(text || '')
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const writeOriginal = () => {
    // Skip our overridden setter to avoid re-entrancy; write through
    // the prototype descriptor so the underlying value updates and
    // any plain-DOM listeners still fire.
    nativeValueSetter.call(inputEl, tags.join(', '));
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const render = () => {
    // Clear and rebuild — small lists, simple is fine.
    Array.from(wrapper.children).forEach((c) => c.remove());
    tags.forEach((tag, i) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip-pill';
      const txt = document.createElement('span');
      txt.className = 'tag-chip-text';
      txt.textContent = tag;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tag-chip-remove';
      close.setAttribute('aria-label', `Remove ${tag}`);
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        tags.splice(i, 1);
        writeOriginal();
        render();
        editor.focus();
      });
      chip.appendChild(txt);
      chip.appendChild(close);
      wrapper.appendChild(chip);
    });
    wrapper.appendChild(editor);
    editor.disabled = tags.length >= maxTags;
    editor.placeholder = tags.length === 0 ? (inputEl.placeholder || 'Add a tag…') : '';
  };

  const addCandidates = (rawText) => {
    const candidates = splitInput(rawText);
    if (candidates.length === 0) return false;
    const lower = new Set(tags.map((t) => t.toLowerCase()));
    let added = false;
    for (const c of candidates) {
      const lc = c.toLowerCase();
      if (lower.has(lc)) continue;
      if (tags.length >= maxTags) break;
      lower.add(lc);
      tags.push(c);
      added = true;
    }
    return added;
  };

  const commitFromEditor = (rawText) => {
    const text = String(rawText ?? editor.value);
    if (!text.trim()) {
      editor.value = '';
      return;
    }
    const added = addCandidates(text);
    editor.value = '';
    if (added) {
      writeOriginal();
      render();
    }
  };

  editor.addEventListener('input', () => {
    if (editor.value.endsWith(',')) commitFromEditor(editor.value.slice(0, -1));
  });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitFromEditor();
    } else if (e.key === 'Backspace' && editor.value === '' && tags.length > 0) {
      tags.pop();
      writeOriginal();
      render();
    }
  });
  editor.addEventListener('blur', () => {
    if (editor.value.trim()) commitFromEditor();
  });

  // Tap anywhere in the wrapper to focus the editor — matches the
  // single-line-input feel.
  wrapper.addEventListener('click', (e) => {
    if (e.target === wrapper) editor.focus();
  });

  // Override the original input's `.value` accessor so that:
  //   - Reads return the comma-joined chip list (already the case via
  //     writeOriginal, but we want this to be the source of truth even
  //     before any chip is added).
  //   - Writes (e.g. populating the edit modal) re-render the chips.
  const proto = Object.getPrototypeOf(inputEl);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
               Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const nativeValueGetter = desc.get;
  const nativeValueSetter = desc.set;

  Object.defineProperty(inputEl, 'value', {
    get() { return nativeValueGetter.call(this); },
    set(v) {
      nativeValueSetter.call(this, v);
      tags = splitInput(v);
      // Cap on initial population too.
      if (tags.length > maxTags) tags = tags.slice(0, maxTags);
      render();
    },
    configurable: true,
  });

  // Initial sync from any value already on the input (e.g. server-
  // populated edit modal).
  tags = splitInput(inputEl.value);
  if (tags.length > maxTags) tags = tags.slice(0, maxTags);
  render();
}

function initVideoTagChips() {
  const TAGS_LIMIT = (() => {
    // Read from app_config cache if available, fall back to 15.
    try {
      if (typeof window.appConfigCache === 'object' && window.appConfigCache?.TAGS_LIMIT_MAX) {
        return Number(window.appConfigCache.TAGS_LIMIT_MAX) || 15;
      }
    } catch {}
    return 15;
  })();
  const upload = document.getElementById('videoUploadTags');
  const edit = document.getElementById('studioEditTags');
  if (upload) attachTagChips(upload, { maxTags: TAGS_LIMIT });
  if (edit) attachTagChips(edit, { maxTags: TAGS_LIMIT });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVideoTagChips);
} else {
  initVideoTagChips();
}

// ════════════════════════════════════════════════════════════════════════════
// Chapter cover + inline images
// ════════════════════════════════════════════════════════════════════════════

function setChapterCoverPreview(url) {
  const empty   = document.getElementById('btnUploadChapterCover');
  const img     = document.getElementById('chapterCoverImg');
  const actions = document.getElementById('chapterCoverActions');
  if (!empty || !img || !actions) return;
  if (url) {
    img.src = url;
    img.dataset.url = url;
    img.style.display     = 'block';
    actions.style.display = 'flex';
    empty.style.display   = 'none';
  } else {
    img.removeAttribute('src');
    delete img.dataset.url;
    img.style.display     = 'none';
    actions.style.display = 'none';
    empty.style.display   = 'flex';
  }
}

async function uploadChapterCover(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/'))   { toast('Pick an image file', 'error'); return; }
  if (file.size > 8 * 1024 * 1024)        { toast('Cover must be under 8MB', 'error'); return; }

  toast('Uploading cover…', '');
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { toast('Sign in first', 'error'); return; }

  const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `chapters/${user.id}/${editingBookId || 'unsaved'}-${editingChapterId || 'new'}-${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage.from('book-covers').upload(path, file, { upsert: true, contentType: file.type });
  if (upErr) { toast('Upload failed: ' + upErr.message, 'error'); return; }

  const { data: { publicUrl } } = supabase.storage.from('book-covers').getPublicUrl(path);
  setChapterCoverPreview(publicUrl);

  // If chapter already exists, persist immediately. Otherwise it'll go in via saveChapter.
  if (editingChapterId) {
    await supabase.from('chapters').update({ cover_url: publicUrl, updated_at: new Date().toISOString() }).eq('id', editingChapterId);
  }
  chapterDirty = true;
  scheduleChapterAutosave();
  toast('Cover updated', 'success');
}

async function removeChapterCover() {
  setChapterCoverPreview(null);
  if (editingChapterId) {
    await supabase.from('chapters').update({ cover_url: null, updated_at: new Date().toISOString() }).eq('id', editingChapterId);
  }
  chapterDirty = true;
  scheduleChapterAutosave();
  toast('Cover removed', 'success');
}

// Quill image button → triggers our hidden file input
function openChapterImagePicker() {
  document.getElementById('chapterContentImageFile').click();
}

async function uploadChapterInlineImage(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !chapterQuill) return;
  if (!file.type.startsWith('image/')) { toast('Pick an image file', 'error'); return; }
  if (file.size > 12 * 1024 * 1024)     { toast('Image must be under 12MB', 'error'); return; }

  toast('Uploading image…', '');
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { toast('Sign in first', 'error'); return; }

  const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `chapter-content/${user.id}/${editingChapterId || 'new'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error: upErr } = await supabase.storage.from('book-covers').upload(path, file, { upsert: false, contentType: file.type });
  if (upErr) { toast('Upload failed: ' + upErr.message, 'error'); return; }

  const { data: { publicUrl } } = supabase.storage.from('book-covers').getPublicUrl(path);

  // Insert image at current cursor position. Quill keeps it as <img class="ql-image">
  const range = chapterQuill.getSelection(true);
  chapterQuill.insertEmbed(range.index, 'image', publicUrl, 'user');
  chapterQuill.setSelection(range.index + 1);

  toast('Image inserted', 'success');
  chapterDirty = true;
  scheduleChapterAutosave();
}

document.getElementById('btnSaveChapter')?.addEventListener('click', saveChapter);
document.getElementById('btnBackToBookEditor')?.addEventListener('click', () => {
  if (editingBookId) openAuthorBookEditor(editingBookId);
  else showAuthor();
});

// Warn before leaving while dirty
window.addEventListener('beforeunload', (e) => {
  if (chapterDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ════════════════════════════════════════
// CREATOR STUDIO
// ════════════════════════════════════════

let studioVideosCache = [];
let studioSearchQuery = '';
let studioEditingVideoId = null;

// Lightweight client-side substitute for the scheduled-publish cron.
// Fires `publish_due_scheduled_videos()` at most once per 5 min whenever
// the user opens Studio — covers the case where no real cron is wired yet.
let _lastSchedulePublishCheck = 0;
function maybeFlushDueScheduledVideos() {
  const now = Date.now();
  if (now - _lastSchedulePublishCheck < 5 * 60 * 1000) return; // 5 min throttle
  _lastSchedulePublishCheck = now;
  // Fire-and-forget — never block UI on this.
  supabase.rpc('publish_due_scheduled_videos').then(({ error }) => {
    if (error) console.warn('publish_due_scheduled_videos:', error.message);
  }).catch(() => {});
}

async function loadStudio() {
  const content = document.getElementById('studioContent');
  content.innerHTML = '<div class="empty"><h3>Loading your videos...</h3></div>';

  if (!currentUser) {
    content.innerHTML = '<div class="empty"><h3>Please sign in</h3></div>';
    return;
  }

  // Background sweep: surface any scheduled videos whose publish time has passed.
  maybeFlushDueScheduledVideos();

  const { data: videos, error } = await supabase
    .from('videos')
    .select('id, title, description, thumbnail_url, video_url, views, likes, duration, status, created_at, tags, category, bunny_video_id, is_locked, is_monetized, unlock_cost_coins, unlock_cost_stars')
    .eq('uploader_id', currentUser.id)
    .order('created_at', { ascending: false });
  
  if (error) {
    content.innerHTML = `<div class="empty"><h3>Error loading videos</h3><p>${escHTML(error.message)}</p></div>`;
    return;
  }
  
  studioVideosCache = videos || [];
  renderStudio();
}

function renderStudio() {
  const content = document.getElementById('studioContent');
  const videos = studioVideosCache;
  
  if (!videos.length) {
    content.innerHTML = `
      <div class="studio-empty">
        <div class="studio-empty-icon">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2"/>
          </svg>
        </div>
        <h3>No videos yet</h3>
        <p>Upload your first video to get started</p>
        <button class="vu-btn vu-btn-primary" onclick="document.getElementById('btnStudioUpload').click()" style="margin-top:1rem">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Upload your first video
        </button>
      </div>
    `;
    return;
  }
  
  const totalVideos = videos.length;
  const totalViews = videos.reduce((sum, v) => sum + (v.views || 0), 0);
  const totalLikes = videos.reduce((sum, v) => sum + (v.likes || 0), 0);
  const publishedCount = videos.filter(v => v.status === 'ready').length;
  
  // Filter by search
  const q = studioSearchQuery.trim().toLowerCase();
  const filtered = q
    ? videos.filter(v => 
        (v.title || '').toLowerCase().includes(q) ||
        (v.description || '').toLowerCase().includes(q) ||
        (v.tags || []).some(t => t.toLowerCase().includes(q))
      )
    : videos;
  
  content.innerHTML = `
    <div class="studio-stats">
      <div class="studio-stat">
        <div class="studio-stat-icon" style="background:linear-gradient(135deg,#a855f7,#6366f1)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
        </div>
        <div>
          <div class="studio-stat-value">${totalVideos.toLocaleString()}</div>
          <div class="studio-stat-label">Total videos</div>
        </div>
      </div>
      <div class="studio-stat">
        <div class="studio-stat-icon" style="background:linear-gradient(135deg,#3b82f6,#06b6d4)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </div>
        <div>
          <div class="studio-stat-value">${totalViews.toLocaleString()}</div>
          <div class="studio-stat-label">Total views</div>
        </div>
      </div>
      <div class="studio-stat">
        <div class="studio-stat-icon" style="background:linear-gradient(135deg,#ec4899,#f43f5e)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </div>
        <div>
          <div class="studio-stat-value">${totalLikes.toLocaleString()}</div>
          <div class="studio-stat-label">Total likes</div>
        </div>
      </div>
      <div class="studio-stat">
        <div class="studio-stat-icon" style="background:linear-gradient(135deg,#22c55e,#10b981)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div>
          <div class="studio-stat-value">${publishedCount.toLocaleString()}</div>
          <div class="studio-stat-label">Published</div>
        </div>
      </div>
    </div>

    <div class="studio-toolbar">
      <div class="studio-search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="studioSearchInput" placeholder="Search your videos..." value="${escHTML(studioSearchQuery)}"/>
      </div>
      <div class="studio-toolbar-info">${filtered.length} of ${totalVideos} ${totalVideos === 1 ? 'video' : 'videos'}</div>
    </div>

    <div class="studio-table-wrap">
      ${filtered.length === 0 ? `
        <div class="studio-empty" style="padding:3rem 1rem">
          <h3>No matches</h3>
          <p>Try a different search term</p>
        </div>
      ` : `
        <table class="studio-table">
          <thead>
            <tr>
              <th class="studio-col-video">Video</th>
              <th class="studio-col-status">Visibility</th>
              <th class="studio-col-date">Date</th>
              <th class="studio-col-views">Views</th>
              <th class="studio-col-likes">Likes</th>
              <th class="studio-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(v => renderStudioRow(v)).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;
  
  // Wire up search input
  const searchInput = document.getElementById('studioSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      studioSearchQuery = e.target.value;
      renderStudio();
      // Re-focus the input after re-render
      const newInput = document.getElementById('studioSearchInput');
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(studioSearchQuery.length, studioSearchQuery.length);
      }
    });
  }
  
  // Wire up monetize/edit/delete buttons via delegation
  content.querySelectorAll('[data-studio-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.studioAction;
      const id = btn.dataset.id;
      if (action === 'edit')          openStudioEditModal(id);
      else if (action === 'delete')   deleteStudioVideo(id);
      else if (action === 'monetize') toggleStudioMonetize(id, btn);
    });
  });
}

// Inline monetize toggle from the studio list — no need to open the edit modal.
// Same gate as the modal: video duration must be ≥ 3 min (else show why).
async function toggleStudioMonetize(videoId, btn) {
  const v = studioVideosCache.find(x => x.id === videoId);
  if (!v) return;
  const minSec = _walletConfigDefaults.video_initial_unlock_seconds || 180;

  // Already monetized → just turn it off (no gate needed)
  if (v.is_monetized) {
    btn.disabled = true;
    const { error } = await supabase.from('videos').update({ is_monetized: false }).eq('id', videoId);
    btn.disabled = false;
    if (error) { toast(error.message, 'error'); return; }
    v.is_monetized = false;
    btn.classList.remove('is-on');
    btn.title = 'Toggle monetization';
    toast('Monetization disabled', 'success');
    return;
  }

  // Turning on → check duration. If 0 (legacy/migrated), prompt them to open
  // edit modal which auto-probes the file for actual duration.
  if (!v.duration || v.duration === 0) {
    toast('Open Edit to read this video\'s duration first, then toggle monetization there.', 'error');
    openStudioEditModal(videoId);
    return;
  }
  if (v.duration < minSec) {
    const mins = Math.floor(v.duration / 60);
    const secs = Math.floor(v.duration % 60);
    toast(`Video must be at least ${minSec/60} min to monetize. This one is ${mins}m ${secs}s.`, 'error');
    return;
  }

  // Eligible — flip it on
  btn.disabled = true;
  const { error } = await supabase.from('videos').update({ is_monetized: true }).eq('id', videoId);
  btn.disabled = false;
  if (error) { toast(error.message, 'error'); return; }
  v.is_monetized = true;
  btn.classList.add('is-on');
  btn.title = 'Monetized — click to disable';
  toast('Monetization enabled 💰', 'success');
}

function renderStudioRow(v) {
  const thumb = v.thumbnail_url 
    ? `<img src="${escHTML(v.thumbnail_url)}" alt="" loading="lazy"/>` 
    : '<div class="studio-thumb-placeholder"></div>';
  const date = new Date(v.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const desc = v.description 
    ? `<div class="studio-row-desc">${escHTML(v.description.slice(0, 100))}${v.description.length > 100 ? '…' : ''}</div>` 
    : '<div class="studio-row-desc" style="color:#aaa;font-style:italic">No description</div>';
  const statusBadge = v.status === 'ready' 
    ? '<span class="studio-badge studio-badge-ready"><span class="studio-dot studio-dot-green"></span>Public</span>' 
    : `<span class="studio-badge studio-badge-processing"><span class="studio-dot studio-dot-yellow"></span>Processing</span>`;
  const duration = v.duration ? formatDuration(v.duration) : '';
  
  return `
    <tr data-video-id="${v.id}">
      <td>
        <div class="studio-row-video">
          <div class="studio-thumb">
            ${thumb}
            ${duration ? `<span class="studio-thumb-duration">${duration}</span>` : ''}
          </div>
          <div class="studio-row-text">
            <div class="studio-row-title">${escHTML(v.title || 'Untitled')}</div>
            ${desc}
          </div>
        </div>
      </td>
      <td>${statusBadge}</td>
      <td><span class="studio-cell-muted">${date}</span></td>
      <td>${(v.views || 0).toLocaleString()}</td>
      <td>${(v.likes || 0).toLocaleString()}</td>
      <td>
        <div class="studio-actions">
          <button class="studio-btn studio-btn-monetize ${v.is_monetized ? 'is-on' : ''}" data-studio-action="monetize" data-id="${v.id}" title="${v.is_monetized ? 'Monetized — click to disable' : 'Toggle monetization'}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9"/>
              <path d="M14.8 9.5c-.4-1-1.4-1.5-2.8-1.5-1.7 0-3 1-3 2.5 0 1.4 1.3 2 2.7 2.4 1.6.4 3.3.9 3.3 2.6 0 1.5-1.3 2.5-3 2.5-1.6 0-2.8-.6-3.2-1.7"/>
              <path d="M12 6v2"/><path d="M12 16v2"/>
            </svg>
          </button>
          <button class="studio-btn" data-studio-action="edit" data-id="${v.id}" title="Edit details">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button class="studio-btn studio-btn-danger" data-studio-action="delete" data-id="${v.id}" title="Delete forever">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `;
}

function openStudioEditModal(videoId) {
  const v = studioVideosCache.find(x => x.id === videoId);
  if (!v) return;
  
  studioEditingVideoId = videoId;
  
  document.getElementById('studioEditTitle').value = v.title || '';
  document.getElementById('studioEditDescription').value = v.description || '';
  document.getElementById('studioEditTags').value = (v.tags || []).join(', ');
  // Category dropdown removed — see videoUploadCategory comment above.

  const preview = document.getElementById('studioEditPreview');
  const thumb = document.getElementById('studioEditThumb');
  if (v.thumbnail_url) {
    thumb.src = v.thumbnail_url;
    preview.style.display = '';
  } else {
    preview.style.display = 'none';
  }

  document.getElementById('studioEditTitleCount').textContent = `${(v.title || '').length} / 100`;
  document.getElementById('studioEditDescCount').textContent = `${(v.description || '').length} / 2000`;

  // Monetization toggle (Phase 6: time-based, not gated-from-start).
  // Gate: monetize requires duration >= 3 min, since the first paid threshold
  // is the 3:00 mark — a 2-min video could never trigger an unlock.
  const monCb     = document.getElementById('studioEditMonetized');
  const monLabel  = monCb?.closest('.lock-toggle');
  const minSec    = _walletConfigDefaults.video_initial_unlock_seconds || 180;

  // Helper: render the gate state given a duration in seconds.
  const applyGate = (duration) => {
    const eligible = (duration || 0) >= minSec;
    if (!monCb) return;
    monCb.checked  = !!v.is_monetized && eligible;
    monCb.disabled = !eligible;
    if (monLabel) monLabel.classList.toggle('is-disabled', !eligible);
    const subEl = monLabel?.querySelector('.lock-toggle-sub');
    if (!subEl) return;
    if (duration == null) {
      subEl.textContent = 'Reading video duration…';
    } else if (eligible) {
      subEl.innerHTML = 'Free for the first 3 minutes. After that, viewers pay <strong>1 coin</strong> for permanent access, or <strong>1 star every 10 minutes</strong> they keep watching.';
    } else {
      subEl.textContent = `Video must be at least ${Math.floor(minSec/60)} minute${minSec/60 === 1 ? '' : 's'} long to monetize. This one is ${Math.floor((duration||0)/60)}m ${Math.floor((duration||0)%60)}s.`;
    }
  };

  // Initial render with whatever the DB has (may be 0 for legacy/migrated videos)
  applyGate(v.duration || 0);

  // Backfill from the actual video file if duration is missing or zero.
  // Reads metadata client-side, then UPDATEs the videos row so the gate works
  // immediately and stays correct on future opens.
  if (!v.duration && (v.video_url || v.videoUrl)) {
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.muted   = true;
    probe.crossOrigin = 'anonymous';
    probe.style.display = 'none';
    probe.src = v.video_url || v.videoUrl;
    const cleanup = () => probe.remove();
    probe.onloadedmetadata = async () => {
      const real = Math.round(probe.duration || 0);
      if (real > 0) {
        v.duration = real;       // patch in-memory cache so save sees the right value
        applyGate(real);
        // Persist back to DB so we don't probe again on next open
        try {
          await supabase.from('videos').update({ duration: real }).eq('id', studioEditingVideoId);
        } catch {}
      }
      cleanup();
    };
    probe.onerror = () => { applyGate(0); cleanup(); };
    document.body.appendChild(probe);
  }

  document.getElementById('studioEditModal').style.display = 'flex';
}

function closeStudioEditModal() {
  document.getElementById('studioEditModal').style.display = 'none';
  studioEditingVideoId = null;
}

async function saveStudioEdit() {
  if (!studioEditingVideoId) return;

  const saveBtn = document.getElementById('studioEditSave');
  const originalLabel = saveBtn.textContent;

  const setSaving = (saving) => {
    if (saving) {
      saveBtn.classList.add('is-saving');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving';
    } else {
      saveBtn.classList.remove('is-saving');
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  };

  const title = document.getElementById('studioEditTitle').value.trim();
  const description = document.getElementById('studioEditDescription').value.trim();
  const tagsRaw = document.getElementById('studioEditTags').value;
  // Category dropdown removed — see videoUploadCategory comment.

  if (!title) {
    toast('Title is required', 'error');
    return;
  }

  setSaving(true);

  const tags = tagsRaw.split(',').map(t => t.trim()).filter(t => t);

  // Monetization toggle (Phase 6 replaces is_locked for new videos)
  const isMonetized = document.getElementById('studioEditMonetized')?.checked || false;

  const { error } = await supabase
    .from('videos')
    .update({
      title, description, tags,
      is_monetized: isMonetized,
      updated_at: new Date().toISOString(),
    })
    .eq('id', studioEditingVideoId);

  setSaving(false);

  if (error) {
    toast('Failed to save: ' + error.message, 'error');
    return;
  }

  toast('Saved', 'success');
  closeStudioEditModal();

  // Invalidate caches and reload
  allVideosCache = [];
  loadStudio();
}

async function deleteStudioVideo(videoId) {
  const v = studioVideosCache.find(x => x.id === videoId);
  if (!v) return;

  const ok = await confirmDialog({
    title: `Delete "${v.title || 'this video'}"?`,
    body: 'This permanently removes the video from your feed and Bunny storage. This can\'t be undone.',
    confirmLabel: 'Delete forever',
  });
  if (!ok) return;
  
  // Show loading state on the row
  const row = document.querySelector(`tr[data-video-id="${videoId}"]`);
  if (row) row.style.opacity = '0.4';
  
  try {
    // 1. Call Edge Function to delete from Bunny + Supabase videos table
    await callEdgeFunction('bunny-delete', { videoId });
    
    // 2. Also delete any post that links to this video
    await supabase.from('posts').delete().eq('video_id', videoId);
    
    // 3. Update local cache
    studioVideosCache = studioVideosCache.filter(x => x.id !== videoId);
    
    // 4. Invalidate other caches
    allVideosCache = [];
    
    toast('Video deleted', 'success');
    renderStudio();
    
    // 5. Refresh feed if it's open
    if (feedEl.style.display !== 'none') {
      loadFeed();
    }
  } catch (err) {
    console.error('Delete failed:', err);
    toast('Failed to delete: ' + err.message, 'error');
    if (row) row.style.opacity = '1';
  }
}

// Wire up edit modal events
document.getElementById('studioEditClose')?.addEventListener('click', closeStudioEditModal);
document.getElementById('studioEditCancel')?.addEventListener('click', closeStudioEditModal);
document.getElementById('studioEditSave')?.addEventListener('click', saveStudioEdit);
document.getElementById('studioEditModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'studioEditModal') closeStudioEditModal();
});

// Live char counters in edit modal
document.getElementById('studioEditTitle')?.addEventListener('input', (e) => {
  document.getElementById('studioEditTitleCount').textContent = `${e.target.value.length} / 100`;
});
document.getElementById('studioEditDescription')?.addEventListener('input', (e) => {
  document.getElementById('studioEditDescCount').textContent = `${e.target.value.length} / 2000`;
});

// Studio upload button → trigger same upload modal as Videos page
document.getElementById('btnStudioUpload')?.addEventListener('click', () => {
  document.getElementById('btnUploadVideo')?.click();
});

function showVideoPlayer() {
  hideAllMainPages();
  videoPlayerPage.style.display = 'block';
  // CRITICAL: enables full-bleed layout (body.on-videos .main-wrap rule).
  // Without this the player gets the default narrow main-wrap width when
  // navigating from a user's wall (skipping showVideos), leaving big empty
  // gutters left/right of the video.
  document.body.classList.add('on-videos');
}

document.getElementById('btnVideos').addEventListener('click', () => {
  setSidebarActive('btnVideos');
  if (videosPage.style.display === 'block') {
    // Scroll the actual scrolling element to the very top
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  showVideos();
});
document.getElementById('btnStudio').addEventListener('click', () => {
  setSidebarActive('btnStudio');
  showStudio();
});
document.getElementById('btnBook')?.addEventListener('click', () => {
  setSidebarActive('btnBook');
  showBook();
});
document.getElementById('btnAuthor')?.addEventListener('click', () => {
  setSidebarActive('btnAuthor');
  showAuthor();
});

// "Become an author" CTA inside Book empty state
document.getElementById('btnGoToAuthor')?.addEventListener('click', () => {
  setSidebarActive('btnAuthor');
  showAuthor();
});
document.getElementById('btnBackVideos').addEventListener('click', () => {
  if (currentHls) { currentHls.destroy(); currentHls = null; }
  document.getElementById('videoPlayer').pause();
  showVideos();
});

// Fetch new videos uploaded via web (from Supabase)
async function fetchSupabaseVideos() {
  try {
    const { data, error } = await supabase
      .from('videos')
      .select(`
        id,
        bunny_video_id,
        title,
        description,
        tags,
        category,
        video_url,
        thumbnail_url,
        views,
        duration,
        created_at,
        uploader_id,
        is_locked,
        is_monetized,
        unlock_cost_coins,
        unlock_cost_stars,
        profiles!videos_uploader_id_fkey (
          id,
          username,
          avatar_url,
          is_banned
        )
      `)
      .eq('status', 'ready')
      .eq('is_hidden', false)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('Supabase videos fetch error:', error);
      return [];
    }

    // Map to the shape used throughout the app (videoStats, $id, $createdAt, etc.).
    // Filter out videos whose uploader is banned.
    return (data || [])
      .filter(v => !v.profiles?.is_banned)
      .map(v => ({
        $id: 'sb_' + v.id, // prefix so we can tell Supabase videos apart
        _supabase: true,    // flag for special handling
        _supabaseId: v.id,
        title: v.title,
        description: v.description || '',
        tags: v.tags || [],
        uploader: v.uploader_id,
        thumbnail: v.thumbnail_url,
        videoUrl: v.video_url,
        uri: v.video_url,
        videoStats: { views: v.views || 0, duration: v.duration || 0 },
        // Monetization fields (Phase 6) — needed by setupVideoMonetGate to
        // decide whether to set up the time-based unlock listener.
        // Without these the gate silently no-ops, breaking auto-deduct.
        is_locked:          !!v.is_locked,
        is_monetized:       !!v.is_monetized,
        duration:           v.duration || 0,
        unlock_cost_coins:  v.unlock_cost_coins ?? null,
        unlock_cost_stars:  v.unlock_cost_stars ?? null,
        status: 'ready',
        $createdAt: v.created_at,
        // Pre-populated uploader info (saves an extra fetch)
        _uploaderInfo: v.profiles ? {
          $id: v.profiles.id,
          username: v.profiles.username,
          avatar: v.profiles.avatar_url,
        } : null,
      }));
  } catch (err) {
    console.error('Failed to fetch Supabase videos:', err);
    return [];
  }
}

async function loadVideos() {
  const grid = document.getElementById('videoGrid');
  grid.innerHTML = '<div class="loading">Loading videos...</div>';

  // Populate cache from Supabase if empty (post-migration: Supabase is the only source)
  if (!allVideosCache.length) {
    const supabaseVideos = await fetchSupabaseVideos();
    supabaseVideos.forEach(v => {
      if (v._uploaderInfo && !allUploadersCache[v.uploader]) {
        allUploadersCache[v.uploader] = v._uploaderInfo;
      }
    });
    allVideosCache = supabaseVideos;
  }
  window._cache = allVideosCache; // expose for debugging

  if (!allVideosCache.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><h3>No videos yet</h3></div>';
    return;
  }

  renderTagPills();

  // If no search/tag filter, show personalized feed
  if (!activeSearchQuery && !activeTagFilter) {
    const personalized = getPersonalizedFeed();
    renderVideoResults(personalized);
  } else {
    runSearch();
  }
}

function getPersonalizedFeed() {
  const { tagWeights, watchedIds, recentUploaders } = getInterestProfile();
  const hasHistory = Object.keys(tagWeights).length > 0;
  const myId = currentUser?.id;

  // Filter out already-watched (last 30 days), but always show user's own uploads
  let pool = allVideosCache.filter(v => v.uploader === myId || !watchedIds.has(v.$id));

  // Pin user's own recent uploads (last 7 days) at the top
  const myRecent = pool.filter(v =>
    v.uploader === myId &&
    v.$createdAt &&
    (Date.now() - new Date(v.$createdAt).getTime()) < 7 * 24 * 3600 * 1000
  );
  const myRecentIds = new Set(myRecent.map(v => v.$id));
  const others = pool.filter(v => !myRecentIds.has(v.$id));

  if (!hasHistory) {
    // No watch history → my recent uploads first, then by recency
    return [...myRecent, ...others];
  }

  // Score each remaining video
  others.forEach(v => {
    let score = 0;

    // Tag matching (interest profile)
    (v.tags || []).forEach(tag => {
      if (tagWeights[tag]) score += tagWeights[tag] * 100;
    });

    // Same uploader bonus (creators you've watched before)
    if (recentUploaders.includes(v.uploader)) score += 15;

    // Engagement boost
    const views = v.videoStats?.views || 0;
    score += Math.log10(views + 1) * 2;

    // Recency boost (newer videos slightly preferred)
    const ageHours = (Date.now() - new Date(v.$createdAt).getTime()) / 3600000;
    if (ageHours < 24) score += 8;
    else if (ageHours < 168) score += 4;

    // Random spice (30% chance to boost a random video)
    if (Math.random() < 0.3) score += Math.random() * 20;

    v._feedScore = score;
  });

  // Sort: 70% personalized + 30% trending mixed in
  others.sort((a, b) => b._feedScore - a._feedScore);

  // Take top 70 personalized
  const personalized = others.slice(0, 70);
  // Take 30 trending (high views, not in personalized)
  const personalizedIds = new Set(personalized.map(v => v.$id));
  const trending = others
    .filter(v => !personalizedIds.has(v.$id))
    .sort((a, b) => (b.videoStats?.views || 0) - (a.videoStats?.views || 0))
    .slice(0, 30);

  // Interleave them (every 3rd is trending)
  const result = [];
  const maxLen = Math.max(personalized.length, trending.length);
  for (let i = 0; i < maxLen; i++) {
    if (personalized[i]) result.push(personalized[i]);
    if (i % 2 === 1 && trending[Math.floor(i/2)]) {
      result.push(trending[Math.floor(i/2)]);
    }
  }

  // Pin my recent uploads at the top
  return [...myRecent, ...result];
}

// ── Video search ──
let allVideosCache = [];
let allUploadersCache = {};
let activeSearchQuery = '';
let activeTagFilter = null;

function searchVideos(query, tagFilter) {
  query = (query || '').trim();
  if (!query && !tagFilter) return allVideosCache;

  // Detect hashtag search (e.g. "#music")
  const hashtagMatch = query.match(/^#(\w+)/);
  const isHashtag = !!hashtagMatch;
  // Normalize so "café" matches "cafe" and "Mañana" matches "manana"
  const cleanQuery = normalizeForSearch(isHashtag ? hashtagMatch[1] : query);

  return allVideosCache.filter(v => {
    // Tag filter (when user clicks a tag pill)
    if (tagFilter) {
      const hasTag = (v.tags || []).some(t => normalizeForSearch(t) === normalizeForSearch(tagFilter));
      if (!hasTag) return false;
    }
    if (!cleanQuery) return true;

    // Hashtag mode: ONLY match tags
    if (isHashtag) {
      return (v.tags || []).some(t => normalizeForSearch(t).includes(cleanQuery));
    }

    // Normal search: match title, description, tags, category, uploader
    const title    = normalizeForSearch(v.title);
    const desc     = normalizeForSearch(v.description);
    const tags     = normalizeForSearch((v.tags || []).join(' '));
    const category = normalizeForSearch((v.category || '').replace(/-/g, ' '));
    const uploader = allUploadersCache[v.uploader];
    const uploaderName = normalizeForSearch(uploader?.username || v._uploaderInfo?.username || '');

    return title.includes(cleanQuery)
        || desc.includes(cleanQuery)
        || tags.includes(cleanQuery)
        || category.includes(cleanQuery)
        || uploaderName.includes(cleanQuery);
  });
}

// Adaptive tag chips — blends user's watch-history tags with platform-popular tags.
// YouTube-style: chips reflect what YOU'VE been watching, with some discovery sprinkled in.
function getTopTags(limit = 18) {
  // Platform popularity (counts every tag occurrence across all videos)
  const platformCounts = {};
  allVideosCache.forEach(v => {
    (v.tags || []).forEach(t => {
      if (!t || typeof t !== 'string') return;
      platformCounts[t] = (platformCounts[t] || 0) + 1;
    });
  });
  const platformRanked = Object.entries(platformCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);

  // User's interest profile — tags weighted by their recent watch history
  const { tagWeights } = (typeof getInterestProfile === 'function')
    ? getInterestProfile()
    : { tagWeights: {} };
  const userRanked = Object.entries(tagWeights || {})
    .filter(([t]) => t && platformCounts[t]) // only suggest tags that actually have content
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);

  const hasInterest = userRanked.length > 0;

  if (!hasInterest) {
    // Brand new user → 100% platform-popular
    return platformRanked.slice(0, limit);
  }

  // Returning user → 70% from interest profile, 30% platform discovery
  const userQuota = Math.ceil(limit * 0.7);
  const out = new Set(userRanked.slice(0, userQuota));
  for (const t of platformRanked) {
    if (out.size >= limit) break;
    out.add(t);
  }
  return [...out].slice(0, limit);
}

function renderTagPills() {
  const wrap = document.getElementById('videoSearchTags');
  const tags = getTopTags(18);

  // First chip = "All" (clears active filter)
  const allActive = !activeTagFilter ? 'active' : '';
  let html = `<button class="search-tag-pill search-tag-pill-all ${allActive}" data-tag="">All</button>`;
  // Then user-adapted + popular tag chips
  html += tags.map(tag =>
    `<button class="search-tag-pill ${tag === activeTagFilter ? 'active' : ''}" data-tag="${escHTML(tag)}">${escHTML(tag)}</button>`
  ).join('');
  wrap.innerHTML = html;

  wrap.querySelectorAll('.search-tag-pill').forEach(pill => {
    pill.onclick = () => {
      const tag = pill.dataset.tag;
      // "All" chip (empty data-tag) clears the filter; clicking the active tag toggles it off
      activeTagFilter = (!tag || activeTagFilter === tag) ? null : tag;
      renderTagPills();
      if (!activeTagFilter && !activeSearchQuery) {
        renderVideoResults(getPersonalizedFeed());
      } else {
        runSearch();
      }
    };
  });
}

async function runSearch() {
  const q = (activeSearchQuery || '').trim();

  // Empty query — show personalized feed, or tag-filtered results.
  // For tag filters we must hit the server (not the 100-video in-memory cache),
  // otherwise older videos in that category never show. Without this fix,
  // clicking "Comedy" only surfaced comedy videos that happened to be in the
  // most recent 100 uploads.
  if (!q) {
    if (activeTagFilter) {
      const grid = document.getElementById('videoGrid');
      grid.innerHTML = '<div class="loading" style="grid-column:1/-1">Loading…</div>';
      const tagLower = activeTagFilter.toLowerCase();
      try {
        // Match category OR any tag that equals the filter — covers both
        // schema patterns (category column + tags array).
        const baseSelect = `id, bunny_video_id, title, description, tags, category, video_url, thumbnail_url, views, duration, created_at, uploader_id, is_locked, is_monetized, unlock_cost_coins, unlock_cost_stars, profiles!videos_uploader_id_fkey ( id, username, avatar_url, is_banned )`;
        const [byCat, byTag] = await Promise.all([
          supabase.from('videos').select(baseSelect)
            .eq('status', 'ready').eq('is_hidden', false)
            .ilike('category', tagLower)
            .order('created_at', { ascending: false })
            .limit(100),
          supabase.from('videos').select(baseSelect)
            .eq('status', 'ready').eq('is_hidden', false)
            .contains('tags', [activeTagFilter])
            .order('created_at', { ascending: false })
            .limit(100),
        ]);
        // Merge + dedupe + drop banned uploaders
        const seen = new Set();
        const merged = [];
        [...(byCat.data || []), ...(byTag.data || [])].forEach(v => {
          if (seen.has(v.id) || v.profiles?.is_banned) return;
          seen.add(v.id);
          merged.push(v);
        });
        const formatted = merged.map(v => ({
          $id: 'sb_' + v.id, _supabase: true, _supabaseId: v.id,
          title: v.title, description: v.description || '',
          tags: v.tags || [], uploader: v.uploader_id,
          thumbnail: v.thumbnail_url, videoUrl: v.video_url, uri: v.video_url,
          videoStats: { views: v.views || 0, duration: v.duration || 0 },
          is_locked: !!v.is_locked, is_monetized: !!v.is_monetized,
          duration: v.duration || 0,
          unlock_cost_coins: v.unlock_cost_coins ?? null,
          unlock_cost_stars: v.unlock_cost_stars ?? null,
          status: 'ready', $createdAt: v.created_at,
          _uploaderInfo: v.profiles ? { $id: v.profiles.id, username: v.profiles.username, avatar: v.profiles.avatar_url } : null,
        }));
        // Hydrate cache so playVideo finds these
        formatted.forEach(v => {
          if (!allVideosCache.find(x => x.$id === v.$id)) allVideosCache.push(v);
          if (v._uploaderInfo && !allUploadersCache[v.uploader]) {
            allUploadersCache[v.uploader] = v._uploaderInfo;
          }
        });
        renderVideoResults(formatted);
      } catch (err) {
        console.warn('Tag filter server fetch failed, falling back to cache:', err);
        renderVideoResults(searchVideos('', activeTagFilter));
      }
    } else {
      renderVideoResults(getPersonalizedFeed?.() || allVideosCache);
    }
    return;
  }

  // Hashtag mode → cache filter is fine (tag is typed, exact field)
  if (q.startsWith('#')) {
    renderVideoResults(searchVideos(q, activeTagFilter));
    return;
  }

  // Real search → query the DB so we find ALL matching videos site-wide,
  // not just the 100 most-recent that live in allVideosCache. This also
  // fixes "Unknown" creator names (the 100-cap cache may miss some uploaders).
  const grid = document.getElementById('videoGrid');
  grid.innerHTML = '<div class="loading" style="grid-column:1/-1">Searching…</div>';

  // Sanitize FIRST (strip , ( ) " — these break .or() / quoting), then ilike-escape.
  const safeQ = sanitizeSearchQuery(q);
  // If sanitize stripped everything (e.g. user typed only `,,,` or `()`),
  // fall back to the personalized feed instead of an unbounded `%%` query
  // that would match every video on the platform.
  if (!safeQ) {
    renderVideoResults(getPersonalizedFeed?.() || allVideosCache);
    return;
  }
  const term = `%${escapeIlike(safeQ)}%`;
  const baseSelect = `id, bunny_video_id, title, description, tags, category, video_url, thumbnail_url, views, duration, created_at, uploader_id, is_locked, is_monetized, unlock_cost_coins, unlock_cost_stars, profiles!videos_uploader_id_fkey ( id, username, avatar_url, is_banned )`;
  // Stale-query guard: a slow request mustn't clobber a newer query.
  const savedQuery = activeSearchQuery;

  try {
    // Two parallel queries: title/description match, and creator-name match.
    // Also collect matching CREATOR profiles to surface them as channel cards.
    let matchingCreators = [];
    const [byText, byUploader] = await Promise.all([
      supabase.from('videos').select(baseSelect)
        .eq('status', 'ready').eq('is_hidden', false)
        .or(`title.ilike.${term},description.ilike.${term}`)
        .order('created_at', { ascending: false })
        .limit(60),
      (async () => {
        const { data: profs } = await supabase.from('profiles')
          .select('id, username, avatar_url, bio, is_banned')
          .ilike('username', term)
          .eq('is_banned', false)
          .limit(8);
        if (!profs?.length) return { data: [] };
        matchingCreators = profs;
        const ids = profs.map(p => p.id);
        return await supabase.from('videos').select(baseSelect)
          .eq('status', 'ready').eq('is_hidden', false)
          .in('uploader_id', ids)
          .order('created_at', { ascending: false })
          .limit(60);
      })(),
    ]);

    // Stale-query guard — user kept typing while we awaited; abandon this run.
    if (activeSearchQuery !== savedQuery) return;

    // Merge + dedupe + drop banned uploaders
    const seen = new Set();
    const merged = [];
    [...(byText.data || []), ...(byUploader.data || [])].forEach(v => {
      if (seen.has(v.id) || v.profiles?.is_banned) return;
      seen.add(v.id);
      merged.push(v);
    });

    // Map to canonical shape
    const formatted = merged.map(v => ({
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
      // Monetization fields needed by setupVideoMonetGate (auto-deduct at 3:00)
      is_locked:          !!v.is_locked,
      is_monetized:       !!v.is_monetized,
      duration:           v.duration || 0,
      unlock_cost_coins:  v.unlock_cost_coins ?? null,
      unlock_cost_stars:  v.unlock_cost_stars ?? null,
      status: 'ready',
      $createdAt: v.created_at,
      _uploaderInfo: v.profiles ? { $id: v.profiles.id, username: v.profiles.username, avatar: v.profiles.avatar_url } : null,
    }));

    // Hydrate caches so playVideo + repeat searches are instant
    formatted.forEach(v => {
      if (!allVideosCache.find(x => x.$id === v.$id)) allVideosCache.push(v);
      if (v._uploaderInfo && !allUploadersCache[v.uploader]) {
        allUploadersCache[v.uploader] = v._uploaderInfo;
      }
    });

    // Apply optional tag filter client-side (rare path)
    let out = formatted;
    if (activeTagFilter) {
      out = formatted.filter(v => (v.tags || []).some(t => t.toLowerCase() === activeTagFilter.toLowerCase()));
    }

    // Decorate matching creators with video count + total views drawn from
    // the search results we already have in hand. Cheap, no extra round-trip.
    const creatorStats = new Map();
    for (const v of formatted) {
      const s = creatorStats.get(v.uploader) || { videos: 0, views: 0 };
      s.videos += 1;
      s.views  += (v.videoStats?.views || 0);
      creatorStats.set(v.uploader, s);
    }
    const creators = (matchingCreators || []).map(p => ({
      id: p.id,
      username: p.username,
      avatar_url: p.avatar_url,
      bio: p.bio || '',
      videos_count: creatorStats.get(p.id)?.videos || 0,
      views_count:  creatorStats.get(p.id)?.views  || 0,
    }));

    renderVideoResults(out, creators);
  } catch (err) {
    console.error('Search failed:', err);
    // Fallback: cache filter (covers offline / RPC issues)
    if (activeSearchQuery !== savedQuery) return; // stale-guard for fallback path too
    renderVideoResults(searchVideos(q, activeTagFilter));
  }
}

function renderVideoResults(videos, creators = []) {
  const grid = document.getElementById('videoGrid');
  // No videos AND no matching creators → empty state
  if (!videos.length && !creators.length) {
    grid.innerHTML = `
      <div class="video-search-empty">
        <h3>No videos found</h3>
        <p>Try a different keyword or tag</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = '';

  // ── Creator channel cards (YouTube-style, top of search results) ──
  if (creators?.length) {
    const header = document.createElement('div');
    header.className = 'video-creators-header';
    header.textContent = creators.length === 1 ? 'Creator' : 'Creators';
    grid.appendChild(header);

    const channelRow = document.createElement('div');
    channelRow.className = 'video-creators-row';
    creators.forEach(c => channelRow.appendChild(renderCreatorChannelCard(c)));
    grid.appendChild(channelRow);

    if (videos.length) {
      const videosHeader = document.createElement('div');
      videosHeader.className = 'video-creators-header';
      videosHeader.textContent = 'Videos';
      grid.appendChild(videosHeader);
    }
  }

  videos.slice(0, 100).forEach((v, i) => {
    const card = renderVideoCard(v, allUploadersCache[v.uploader]);
    card.style.animationDelay = `${i * 0.03}s`;
    grid.appendChild(card);
  });
}

// Creator channel card (search result top row, YouTube-style)
function renderCreatorChannelCard(creator) {
  const card = document.createElement('button');
  card.className = 'creator-channel-card';
  card.type = 'button';
  card.onclick = () => openProfile(creator.id);

  const initial = (creator.username || '?').trim().charAt(0).toUpperCase();
  const avatar = creator.avatar_url
    ? `<img src="${escHTML(creator.avatar_url)}" alt=""/>`
    : `<div class="creator-channel-avatar-placeholder">${initial}</div>`;

  const videosLabel = creator.videos_count === 1 ? '1 video' : `${formatCompact(creator.videos_count)} videos`;
  const viewsLabel  = creator.views_count > 0 ? ` · ${formatCompact(creator.views_count)} views` : '';

  card.innerHTML = `
    <div class="creator-channel-avatar">${avatar}</div>
    <div class="creator-channel-info">
      <div class="creator-channel-name">${escHTML(creator.username || 'Unknown')}</div>
      <div class="creator-channel-meta">${videosLabel}${viewsLabel}</div>
      ${creator.bio ? `<div class="creator-channel-bio">${escHTML(creator.bio.slice(0, 90))}${creator.bio.length > 90 ? '…' : ''}</div>` : ''}
    </div>
    <div class="creator-channel-cta">View channel →</div>
  `;
  return card;
}

function renderVideoCard(video, uploader) {
  const div = document.createElement('div');
  div.className = 'video-card';
  div.onclick = () => playVideo(video.$id);

  // Resolve uploader from arg → cache → embedded info, in that order
  uploader = uploader
    || allUploadersCache[video.uploader]
    || video._uploaderInfo
    || null;
  const name = uploader?.username || 'Unknown';
  const uploaderId = uploader?.$id || uploader?.id || video.uploader || null;
  const avatarHTML = uploader?.avatar ? `<img src="${uploader.avatar}" alt="${escHTML(name)}"/>` : initials(name);

  const thumbHTML = video.thumbnail ? `<img src="${video.thumbnail}" loading="lazy" onerror="this.style.display='none'"/>` : '';
  const resumeTime = getResumeTime(video.$id);
  const videoDuration = video.videoStats?.duration || 0;
  const progressPct = (resumeTime && videoDuration) ? Math.min(100, (resumeTime / videoDuration) * 100) : 0;

  // Make creator name + avatar clickable when we have an uploader id
  const clickableClass = uploaderId ? ' video-card-creator-clickable' : '';

  div.innerHTML = `
    <div class="video-thumb">
      ${thumbHTML}
      <video class="preview" muted playsinline preload="none"></video>
      <span class="video-thumb-duration" data-duration></span>
      ${progressPct > 0 ? `<div class="video-thumb-progress"><div class="video-thumb-progress-fill" style="width:${progressPct}%"></div></div>` : ''}
    </div>
    <div class="video-card-info">
      <div class="avatar${clickableClass}" data-uploader-id="${uploaderId || ''}" title="${uploaderId ? 'View profile' : ''}">${avatarHTML}</div>
      <div class="video-card-text">
        <div class="video-card-title">${escHTML(video.title || 'Untitled')}</div>
        <div class="video-card-meta">
          <span class="video-card-creator${clickableClass}" data-uploader-id="${uploaderId || ''}">${escHTML(name)}</span><br>
          ${(video.videoStats?.views || 0).toLocaleString()} views • ${timeAgo(video.$createdAt)}
        </div>
      </div>
    </div>
  `;

  // Wire creator-name + avatar click → open profile (don't bubble to card)
  if (uploaderId) {
    div.querySelectorAll('[data-uploader-id="' + uploaderId + '"]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof openProfile === 'function') openProfile(uploaderId);
      });
    });
  }

  // Show duration if available, otherwise fetch from video metadata
  const durationEl = div.querySelector('[data-duration]');
  if (videoDuration) {
    durationEl.textContent = formatDuration(videoDuration);
  } else if (video.videoUrl) {
    const tempVid = document.createElement('video');
    tempVid.preload = 'metadata';
    tempVid.muted = true;
    if (video.videoUrl.endsWith('.m3u8') && window.Hls && Hls.isSupported() && !tempVid.canPlayType('application/vnd.apple.mpegurl')) {
      const tempHls = new Hls();
      tempHls.loadSource(video.videoUrl);
      tempHls.attachMedia(tempVid);
      tempHls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (tempVid.duration && !isNaN(tempVid.duration)) {
          durationEl.textContent = formatDuration(tempVid.duration);
        }
        setTimeout(() => tempHls.destroy(), 500);
      });
    } else {
      tempVid.src = video.videoUrl;
      tempVid.addEventListener('loadedmetadata', () => {
        durationEl.textContent = formatDuration(tempVid.duration);
        tempVid.removeAttribute('src');
      });
    }
  }

  // Hover to play preview
  const previewEl = div.querySelector('video.preview');
  let hoverHls = null;
  let hoverTimeout = null;

  div.addEventListener('mouseenter', () => {
    hoverTimeout = setTimeout(() => {
      if (video.videoUrl && video.videoUrl.endsWith('.m3u8')) {
        if (previewEl.canPlayType('application/vnd.apple.mpegurl')) {
          previewEl.src = video.videoUrl;
        } else if (window.Hls && Hls.isSupported()) {
          hoverHls = new Hls();
          hoverHls.loadSource(video.videoUrl);
          hoverHls.attachMedia(previewEl);
        }
      } else {
        previewEl.src = video.videoUrl;
      }
      previewEl.play().then(() => {
        previewEl.classList.add('playing');
      }).catch(() => {});
    }, 600); // 600ms delay before preview starts (like YouTube)
  });

  div.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimeout);
    previewEl.classList.remove('playing');
    previewEl.pause();
    previewEl.currentTime = 0;
    if (hoverHls) { hoverHls.destroy(); hoverHls = null; }
    previewEl.removeAttribute('src');
    previewEl.load();
  });

  return div;
}

async function playVideo(videoId) {
  try {
    let video = null;
    let uploader = null;

    // All videos are now Supabase. Cache holds the most recent ~100 platform-wide,
    // but profiles can list older uploads — so a cache miss is normal and not an error.
    // Try the cache first, then fall back to a direct fetch by ID.
    if (!allVideosCache.length) {
      const fresh = await fetchSupabaseVideos();
      allVideosCache = fresh;
    }
    let cached = allVideosCache.find(v => v.$id === videoId);
    if (!cached) {
      // Cache miss — fetch this specific video by ID (works for older videos
      // outside the top-100 window, deep links, and shared URLs).
      const rawId = videoId.startsWith('sb_') ? videoId.slice(3) : videoId;
      const { data, error } = await supabase
        .from('videos')
        .select(`id, bunny_video_id, title, description, tags, category, video_url, thumbnail_url, views, duration, created_at, uploader_id, status, is_hidden, is_locked, is_monetized, unlock_cost_coins, unlock_cost_stars, profiles!videos_uploader_id_fkey ( id, username, avatar_url, is_banned )`)
        .eq('id', rawId)
        .maybeSingle();
      if (error || !data) {
        toast('Video not found', 'error');
        return;
      }
      // Block playback for banned uploaders or unready/hidden videos (unless owner).
      const isOwner = currentUser && currentUser.id === data.uploader_id;
      if (data.profiles?.is_banned) { toast('Video unavailable', 'error'); return; }
      if (!isOwner && (data.status !== 'ready' || data.is_hidden)) {
        toast('Video unavailable', 'error');
        return;
      }
      cached = {
        $id: 'sb_' + data.id,
        _supabase: true,
        _supabaseId: data.id,
        title: data.title,
        description: data.description || '',
        tags: data.tags || [],
        uploader: data.uploader_id,
        thumbnail: data.thumbnail_url,
        videoUrl: data.video_url,
        uri: data.video_url,
        videoStats: { views: data.views || 0, duration: data.duration || 0 },
        status: data.status || 'ready',
        $createdAt: data.created_at,
        is_locked:         data.is_locked,
        is_monetized:      data.is_monetized,
        unlock_cost_coins: data.unlock_cost_coins,
        unlock_cost_stars: data.unlock_cost_stars,
        _uploaderInfo: data.profiles ? { $id: data.profiles.id, username: data.profiles.username, avatar: data.profiles.avatar_url } : null,
      };
      // Cache it so revisits are instant + Prev/Next nav has it.
      allVideosCache.push(cached);
    }
    video = cached;
    uploader = cached._uploaderInfo || null;

    showVideoPlayer();
    history.pushState(null, '', `#video/${videoId}`);

    const player = document.getElementById('videoPlayer');
    if (currentHls) { currentHls.destroy(); currentHls = null; }

    // PAYWALL: locked videos that the viewer hasn't unlocked AND don't own.
    // Owner (the uploader) can always preview their own video.
    const sbId = video._supabaseId || (videoId.startsWith('sb_') ? videoId.slice(3) : videoId);
    const isOwner = currentUser && currentUser.id === video.uploader;
    const paywallEl = document.getElementById('videoPaywall');
    if (video.is_locked && !isOwner && !isUnlocked('video', sbId)) {
      const coinCost = resolveUnlockCost('video', 'coin', { unlock_cost_coins: video.unlock_cost_coins, unlock_cost_stars: video.unlock_cost_stars });
      const starCost = resolveUnlockCost('video', 'star', { unlock_cost_coins: video.unlock_cost_coins, unlock_cost_stars: video.unlock_cost_stars });
      // Stop playback + hide controls until unlock.
      player.pause();
      player.removeAttribute('src');
      player.load();
      document.getElementById('videoPaywallTitle').textContent = video.title || 'This video is locked';
      document.getElementById('videoPaywallCoins').textContent = coinCost;
      document.getElementById('videoPaywallStars').textContent = starCost;
      paywallEl.style.display = '';
      const unlockBtn = document.getElementById('btnVideoUnlock');
      unlockBtn.onclick = () => {
        openUnlockDialog({
          targetType: 'video',
          targetId:   sbId,
          row:        { unlock_cost_coins: video.unlock_cost_coins, unlock_cost_stars: video.unlock_cost_stars },
          title:      video.title,
          onUnlocked: () => { paywallEl.style.display = 'none'; playVideo(videoId); },
        });
      };
      return;
    }
    if (paywallEl) paywallEl.style.display = 'none';

    // PHASE 6 — time-based monetization. Independent of the legacy is_locked
    // gated-from-start paywall above. If video.is_monetized is true and the
    // viewer has NOT permanently unlocked (no `unlocks` row), set up a
    // timeupdate listener that pauses + prompts at thresholds (180, 780,
    // 1380, 1980, …). Coin = permanent. Star = 10-min window only.
    if (video.is_monetized && !isOwner && !isUnlocked('video', sbId)) {
      // sbId may be 'aw_xxx' for legacy videos; setupVideoMonetGate handles
      // both UUID and legacy ids by skipping video_progress writes for legacy.
      await setupVideoMonetGate(player, sbId, video);
    } else {
      teardownVideoMonetGate(player);
    }

    const resumeFrom = getResumeTime(videoId);

    const startPlayback = () => {
      if (resumeFrom > 0) {
        player.currentTime = resumeFrom;
        toast(`Resumed at ${formatDuration(resumeFrom)}`, '');
      }
      player.play().catch(() => {});
    };

    if (video.videoUrl && video.videoUrl.endsWith('.m3u8')) {
      if (player.canPlayType('application/vnd.apple.mpegurl')) {
        player.src = video.videoUrl;
        player.addEventListener('loadedmetadata', startPlayback, { once: true });
      } else if (window.Hls && Hls.isSupported()) {
        currentHls = new Hls();
        currentHls.loadSource(video.videoUrl);
        currentHls.attachMedia(player);
        currentHls.on(Hls.Events.MANIFEST_PARSED, startPlayback);
      } else {
        toast('HLS not supported in this browser', 'error');
      }
    } else {
      player.src = video.videoUrl || '';
      player.addEventListener('loadedmetadata', startPlayback, { once: true });
    }

    // Save position every 3 seconds
    let saveInterval = setInterval(() => {
      if (!player.paused && player.currentTime > 0) {
        saveResumeTime(videoId, player.currentTime, player.duration);
      }
    }, 3000);

    // Clean up interval when video changes
    player._saveInterval && clearInterval(player._saveInterval);
    player._saveInterval = saveInterval;

    // Save when paused
    player.onpause = () => saveResumeTime(videoId, player.currentTime, player.duration);

    document.getElementById('videoTitle').textContent = video.title || 'Untitled';
    document.getElementById('videoViews').textContent = '';
    document.getElementById('videoDate').textContent = timeAgo(video.$createdAt);
    document.getElementById('videoDescription').textContent = video.description || '';

    const name = uploader?.username || 'Unknown';
    const avatarEl = document.getElementById('videoUploaderAvatar');
    avatarEl.innerHTML = uploader?.avatar ? `<img src="${uploader.avatar}"/>` : initials(name);
    document.getElementById('videoUploaderName').textContent = name;
    document.getElementById('videoUploaderBadge').textContent = video.tags?.length ? video.tags.join(' • ') : '';
    
    // Track watch history & load suggestions
    addToWatchHistory(video, uploader);
    loadUpNext(video);

    // Each setup is independent — wrap so one failing path doesn't kill the others
    try { setupVideoActions(video); }       catch (e) { console.warn('setupVideoActions failed:', e); }
    try { setupVideoComments(video); }      catch (e) { console.warn('setupVideoComments failed:', e); }
    try { setupCreatorFollow(video, uploader); } catch (e) { console.warn('setupCreatorFollow failed:', e); }
    try { setupDescriptionToggle(); }       catch (e) { console.warn('setupDescriptionToggle failed:', e); }
  } catch (error) {
    toast('Couldn\'t load video: ' + error.message, 'error');
  }
}

// ── Follow-the-creator button on the video player ──
// Always visible (except on your own video). Falls back to a friendly toast
// when the creator is mobile-only (no matching Supabase profile).
async function setupCreatorFollow(video, uploader) {
  const btn = document.getElementById('btnFollowCreator');
  if (!btn) return;
  btn.style.display = 'none';
  btn.disabled = false;
  btn.classList.remove('following');
  btn.onclick = null;
  if (!currentUser) return;

  const isSupabaseVideo = !!resolveSupabaseVideoId(video);
  const username = uploader?.username || video?.uploader?.username || null;
  let creatorId = null;

  if (isSupabaseVideo) {
    creatorId =
         uploader?.id
      || uploader?.$id
      || video?.author_id
      || video?.uploader
      || video?._uploaderInfo?.$id
      || video?._uploaderInfo?.id
      || null;
    if (creatorId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(creatorId)) {
      creatorId = null;
    }
  } else if (username) {
    const { data: matchingProfile } = await supabase
      .from('profiles')
      .select('id')
      .ilike('username', username)
      .maybeSingle();
    creatorId = matchingProfile?.id || null;
  }

  if (creatorId === currentUser.id) return;   // your own video → hide

  // Always show the button. Behavior depends on whether we resolved a profile.
  btn.style.display = 'inline-flex';

  // CASE A: creator has a Supabase profile → full follow flow
  if (creatorId) {
    const setFollowingState = (isFollowing) => {
      if (isFollowing) {
        btn.classList.add('following');
        btn.textContent = '✓ Following';
      } else {
        btn.classList.remove('following');
        btn.textContent = '+ Follow';
      }
    };

    const { data: existing } = await supabase
      .from('follows')
      .select('follower_id')
      .eq('follower_id', currentUser.id)
      .eq('following_id', creatorId)
      .maybeSingle();
    setFollowingState(!!existing);

    btn.onclick = async () => {
      btn.disabled = true;
      const wasFollowing = btn.classList.contains('following');
      setFollowingState(!wasFollowing);   // optimistic
      let error = null;
      if (wasFollowing) {
        ({ error } = await supabase.from('follows').delete()
          .eq('follower_id', currentUser.id).eq('following_id', creatorId));
      } else {
        ({ error } = await supabase.from('follows').insert({
          follower_id: currentUser.id, following_id: creatorId,
        }));
      }
      btn.disabled = false;
      if (error) {
        setFollowingState(wasFollowing);
        toast('Couldn\'t update follow: ' + error.message, 'error');
      } else {
        toast(wasFollowing ? 'Unfollowed' : 'Following!', 'success');
      }
    };
    return;
  }

  // CASE B: legacy creator without a Supabase profile → show button, friendly toast
  btn.textContent = '+ Follow';
  btn.classList.remove('following');
  btn.onclick = () => {
    const who = username ? `@${username}` : 'this creator';
    toast(`${who} is on the mobile app — follow them there for now.`, 'error');
  };
  return;

  const setFollowingState = (isFollowing) => {
    if (isFollowing) {
      btn.classList.add('following');
      btn.textContent = '✓ Following';
    } else {
      btn.classList.remove('following');
      btn.textContent = '+ Follow';
    }
  };

  // Initial state lookup
  const { data: existing } = await supabase
    .from('follows')
    .select('follower_id')
    .eq('follower_id', currentUser.id)
    .eq('following_id', creatorId)
    .maybeSingle();
  setFollowingState(!!existing);

  btn.onclick = async () => {
    btn.disabled = true;
    const wasFollowing = btn.classList.contains('following');
    setFollowingState(!wasFollowing);   // optimistic
    let error = null;
    if (wasFollowing) {
      ({ error } = await supabase.from('follows').delete()
        .eq('follower_id', currentUser.id).eq('following_id', creatorId));
    } else {
      ({ error } = await supabase.from('follows').insert({
        follower_id: currentUser.id, following_id: creatorId,
      }));
    }
    btn.disabled = false;
    if (error) {
      // Revert on failure
      setFollowingState(wasFollowing);
      toast('Couldn\'t update follow: ' + error.message, 'error');
    } else {
      toast(wasFollowing ? 'Unfollowed' : 'Following!', 'success');
    }
  };
}

// ── Description "Show more" toggle (4-line clamp) ──
function setupDescriptionToggle() {
  const desc   = document.getElementById('videoDescription');
  const toggle = document.getElementById('videoDescriptionToggle');
  if (!desc || !toggle) return;

  // Reset state so navigating between videos doesn't carry over
  desc.classList.remove('expanded');
  toggle.style.display = 'none';
  toggle.textContent = 'Show more';

  // Wait one frame for the new text to lay out, then check overflow
  requestAnimationFrame(() => {
    if (desc.scrollHeight > desc.clientHeight + 2) {
      toggle.style.display = 'inline-block';
    }
  });

  toggle.onclick = () => {
    const expanded = desc.classList.toggle('expanded');
    toggle.textContent = expanded ? 'Show less' : 'Show more';
  };
}

// Resolve the Supabase video ID from whatever shape `video` happens to be
function resolveSupabaseVideoId(video) {
  if (!video) return null;
  if (video._supabaseId) return video._supabaseId;
  if (video._supabase && video.id) return video.id;
  if (typeof video.$id === 'string' && video.$id.startsWith('sb_')) return video.$id.slice(3);
  return null;
}

// Wire up the comment section on the video player page.
// `video_id` in the comments table is a text column to support legacy
// pre-migration formats; new comments always use the Supabase video UUID.
function setupVideoComments(video) {
  const wrap = document.getElementById('videoCommentsWrap');
  if (!wrap) {
    console.warn('[video] videoCommentsWrap missing from the DOM — index.html may be stale');
    return;
  }
  const supabaseId = resolveSupabaseVideoId(video);
  // Pick whichever id this video has. Supabase ID wins if present.
  const videoIdForComments = supabaseId || video?.$id || null;

  if (!videoIdForComments) {
    wrap.style.display = 'none';
    return;
  }

  // Make sure the wrap is visible (override any stale inline display:none)
  wrap.style.display = 'block';
  const countEl = document.getElementById('videoCommentsCount');
  if (countEl) countEl.textContent = '';
  loadComments(null, videoIdForComments);
  loadCommentCount(null, videoIdForComments);
}

// ── VIDEO ACTIONS: Like / Repost / Share ──
let _currentVideoCtx = null;   // { supabaseId, title, post_id }

async function setupVideoActions(video) {
  const actionsBar = document.getElementById('videoActions');
  if (!actionsBar) return;

  const supabaseVideoId = resolveSupabaseVideoId(video);
  const legacyVideoId   = !supabaseVideoId ? (video?.$id || null) : null;
  const isLegacy        = !supabaseVideoId;
  // Polymorphic id used for the reactions table — works for both Supabase and legacy now
  const videoIdForActions = supabaseVideoId || legacyVideoId;

  const reactionWrap = actionsBar.querySelector('.reaction-wrap[data-type="video"]');
  const reactionBtn  = actionsBar.querySelector('.reaction-trigger[data-type="video"]');
  const picker       = actionsBar.querySelector('.reaction-picker');

  // Like button — works for both Supabase and legacy videos via the polymorphic
  // reactions.target_id (now text after migration_reactions_legacy.sql).
  if (videoIdForActions) {
    reactionWrap.style.display = '';
    reactionWrap.dataset.target = videoIdForActions;
    reactionBtn.dataset.target  = videoIdForActions;
    reactionBtn.onclick = null;     // restore default reaction-picker behavior
    picker.style.display = '';
    picker.innerHTML = REACTIONS.map(r => `
      <button class="reaction-option" data-key="${r.key}" data-target="${videoIdForActions}" data-type="video" title="${r.label}">
        <span class="r-emoji">${r.emoji}</span>
        <span class="r-label">${r.label}</span>
      </button>
    `).join('');
    loadReactions(videoIdForActions, 'video');
  } else {
    reactionWrap.style.display = 'none';
  }

  // Repost — always show. Supabase: real repost via the auto-created post.
  // Legacy: friendly toast (we can't repost into the posts table without a video_id FK).
  const repostBtn = document.getElementById('videoRepostBtn');
  repostBtn.style.display = '';
  let postIdForRepost = null;
  if (supabaseVideoId) {
    const { data: postRow } = await supabase
      .from('posts')
      .select('id')
      .eq('video_id', supabaseVideoId)
      .maybeSingle();
    postIdForRepost = postRow?.id || null;
  }
  if (postIdForRepost) {
    repostBtn.onclick = () => repostPost(postIdForRepost);
  } else if (isLegacy) {
    repostBtn.onclick = () => toast('Reposting legacy videos is coming soon — share the link instead.', 'error');
  } else {
    repostBtn.onclick = () => toast('This video has no original post to repost.', 'error');
  }

  // Share — always works. Opens the menu, options pick the platform.
  const shareBtn  = document.getElementById('videoShareBtn');
  const shareMenu = document.getElementById('videoShareMenu');
  shareBtn.onclick = (e) => {
    e.stopPropagation();
    shareMenu.classList.toggle('visible');
  };
  shareMenu.querySelectorAll('.share-option').forEach(opt => {
    opt.onclick = (e) => {
      e.stopPropagation();
      shareMenu.classList.remove('visible');
      const platform = opt.dataset.platform;
      const fragId = supabaseVideoId ? 'sb_' + supabaseVideoId : (video.$id || '');
      const url = `${window.location.origin}/#video/${fragId}`;
      const text = encodeURIComponent(video.title || 'Check out this video on Selebox');
      const shareUrl = encodeURIComponent(url);
      if (platform === 'copy') {
        navigator.clipboard?.writeText(url).then(
          () => toast('Link copied', 'success'),
          () => toast('Could not copy link', 'error')
        );
      } else if (platform === 'facebook') {
        window.open(`https://www.facebook.com/sharer/sharer.php?u=${shareUrl}`, '_blank');
      } else if (platform === 'twitter') {
        window.open(`https://twitter.com/intent/tweet?text=${text}&url=${shareUrl}`, '_blank');
      } else if (platform === 'whatsapp') {
        window.open(`https://wa.me/?text=${text}%20${shareUrl}`, '_blank');
      }
    };
  });

  _currentVideoCtx = { supabaseId: supabaseVideoId, title: video?.title || '' };

  // Defensive: hide bookmark button if the video has no Supabase row (shouldn't happen post-migration)
  const bmBtn = document.getElementById('videoBookmarkBtn');
  if (bmBtn) bmBtn.style.display = supabaseVideoId ? 'inline-flex' : 'none';
  if (supabaseVideoId) loadVideoBookmarkState(supabaseVideoId);
}

// Update popstate to handle videos
window.addEventListener('popstate', () => {
  const hash = window.location.hash;
  if (hash.startsWith('#profile/')) {
    setSidebarActive('btnProfile');
    openProfile(hash.replace('#profile/', ''));
  } else if (hash === '#videos') {
    setSidebarActive('btnVideos');
    showVideos();
  } else if (hash === '#studio') {
    setSidebarActive('btnStudio');
    showStudio();
  } else if (hash === '#book') {
    setSidebarActive('btnBook');
    showBook();
  } else if (hash.startsWith('#book/')) {
    setSidebarActive('btnBook');
    const bookId = hash.replace('#book/', '').split('/')[0];
    openBookDetail(bookId);
  } else if (hash === '#author') {
    setSidebarActive('btnAuthor');
    showAuthor();
  } else if (hash.startsWith('#author/book/')) {
    setSidebarActive('btnAuthor');
    const parts = hash.replace('#author/book/', '').split('/');
    const bookId = parts[0];
    if (parts[2]) {
      // chapter editor — parts[1] === 'chapter', parts[2] === id or 'new'
      openAuthorChapterEditor(bookId, parts[2] === 'new' ? null : parts[2]);
    } else {
      openAuthorBookEditor(bookId);
    }
  } else if (hash.startsWith('#video/')) {
    setSidebarActive('btnVideos');
    playVideo(hash.replace('#video/', ''));
  } else if (hash === '#store') {
    showStore();
  } else if (hash === '#earnings') {
    showEarnings();
  } else {
    setSidebarActive('btnHome');
    showFeed();
    loadFeed();
  }
});

// ── Theme toggle ──
function applyTheme(theme) {
  if (theme === 'light') document.body.classList.add('light');
  else document.body.classList.remove('light');
}
applyTheme(localStorage.getItem('selebox_theme') || 'dark');

document.getElementById('btnTheme').addEventListener('click', () => {
  const isLight = document.body.classList.contains('light');
  const newTheme = isLight ? 'dark' : 'light';
  applyTheme(newTheme);
  localStorage.setItem('selebox_theme', newTheme);
});

// ════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════
const NOTIF_PAGE_SIZE = 25;
let _notifications = [];
let _notifUnreadCount = 0;
let _notifChannel = null;
let _notifPanelOpen = false;
let _notifFilter = 'all';      // 'all' | 'you' | 'following'
const _notifActorCache = {};   // user_id → { username, avatar_url }

// Categorize a notification for the filter tabs
function notifCategory(n) {
  return (n?.type || '').startsWith('follow_') ? 'following' : 'you';
}

async function initNotifications() {
  if (!currentUser) return;

  await loadNotifications();

  // Realtime — subscribe to new notifications for this user only
  if (_notifChannel) {
    try { supabase.removeChannel(_notifChannel); } catch {}
    _notifChannel = null;
  }
  try {
    _notifChannel = supabase
      .channel(`notif:${currentUser.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${currentUser.id}`,
      }, async (payload) => {
        const n = payload.new;
        // Fetch the actor profile for nicer rendering
        await hydrateActorProfiles([n]);
        _notifications.unshift(n);
        if (_notifications.length > 100) _notifications.length = 100;
        _notifUnreadCount += 1;
        updateNotifBadge();
        renderNotifications();
        // No toast on incoming notifications — the bell badge + dropdown
        // already surfaces them. Toast was too intrusive (especially for DMs
        // where the unread badge on the Messages sidebar entry is enough).
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_id=eq.${currentUser.id}`,
      }, async (payload) => {
        // Coalesced DM notifications: an existing unread row is being bumped
        // (preview/timestamp updated). Replace the row in-place — DON'T re-increment
        // the badge (it was already counted on first INSERT).
        const n = payload.new;
        await hydrateActorProfiles([n]);
        const idx = _notifications.findIndex(x => x.id === n.id);
        if (idx >= 0) {
          _notifications[idx] = n;
        } else {
          _notifications.unshift(n);
        }
        // Re-sort by created_at desc so the bumped row floats to the top
        _notifications.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        renderNotifications();
      })
      .subscribe();
  } catch (err) {
    console.warn('Notifications realtime subscribe failed:', err);
  }
}

async function loadNotifications() {
  const list = document.getElementById('notificationsList');
  if (list) list.innerHTML = '<div class="notifications-empty">Loading…</div>';

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('recipient_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(NOTIF_PAGE_SIZE);

  if (error) {
    if (list) list.innerHTML = `<div class="notifications-empty">Couldn't load notifications</div>`;
    console.warn('Notifications fetch error:', error);
    return;
  }
  let raw = data || [];

  // Suppress dm_message notifications whose conversation is Secret. The
  // user discovers Secret messages by opening the Secret tab; they never
  // appear in the bell. We collect all dm_message conversation IDs and
  // bulk-fetch the is_secret flag in one query, then drop the matching
  // notifications.
  const dmConvIds = Array.from(new Set(
    raw
      .filter(n => n.type === 'dm_message' && n.parent_target_type === 'conversation' && n.parent_target_id)
      .map(n => n.parent_target_id),
  ));
  if (dmConvIds.length) {
    const { data: convs } = await supabase
      .from('conversations')
      .select('id, is_secret')
      .in('id', dmConvIds);
    const secretSet = new Set((convs || []).filter(c => c.is_secret).map(c => c.id));
    if (secretSet.size > 0) {
      raw = raw.filter(n => !(n.type === 'dm_message' && secretSet.has(n.parent_target_id)));
    }
  }

  _notifications = raw;
  await hydrateActorProfiles(_notifications);

  _notifUnreadCount = _notifications.filter(n => !n.is_read).length;
  updateNotifBadge();
  renderNotifications();
}

async function hydrateActorProfiles(items) {
  // Collect ALL actor ids (primary + coalesced others) so the
  // "Alice and Bob reacted" label can resolve every name.
  const allIds = new Set();
  items.forEach(n => {
    if (n.actor_id) allIds.add(n.actor_id);
    if (Array.isArray(n.actor_ids)) {
      n.actor_ids.forEach(id => { if (id) allIds.add(id); });
    }
  });
  const ids = [...allIds].filter(id => !_notifActorCache[id]);
  if (!ids.length) return;
  const { data } = await supabase.from('profiles').select('id, username, avatar_url').in('id', ids);
  (data || []).forEach(p => { _notifActorCache[p.id] = p; });
}

function updateNotifBadge() {
  const badge = document.getElementById('notifBadge');
  const bell  = document.getElementById('btnNotifications');
  if (!badge || !bell) return;
  if (_notifUnreadCount > 0) {
    badge.style.display = 'flex';
    badge.textContent = _notifUnreadCount > 99 ? '99+' : String(_notifUnreadCount);
    bell.classList.add('has-unread');
    // Re-trigger animation
    bell.classList.remove('has-unread');
    void bell.offsetWidth;
    bell.classList.add('has-unread');
  } else {
    badge.style.display = 'none';
    bell.classList.remove('has-unread');
  }
}

function renderNotifications() {
  const list = document.getElementById('notificationsList');
  if (!list) return;

  const visible = _notifFilter === 'all'
    ? _notifications
    : _notifications.filter(n => notifCategory(n) === _notifFilter);

  if (!visible.length) {
    const msg = _notifications.length === 0
      ? `<p style="margin:0;font-size:0.85rem">You're all caught up.</p>
         <p style="margin:0.35rem 0 0;font-size:0.75rem;color:var(--text3)">When someone reacts, comments, replies, or someone you follow posts, it'll show up here.</p>`
      : (_notifFilter === 'you'
          ? `<p style="margin:0;font-size:0.85rem">No activity on your content yet.</p>
             <p style="margin:0.35rem 0 0;font-size:0.75rem;color:var(--text3)">Reactions and comments on your posts/books will appear here.</p>`
          : `<p style="margin:0;font-size:0.85rem">Nothing from people you follow yet.</p>
             <p style="margin:0.35rem 0 0;font-size:0.75rem;color:var(--text3)">When someone you follow posts, uploads, or publishes, you'll see it here.</p>`);
    list.innerHTML = `<div class="notifications-empty">${msg}</div>`;
    return;
  }

  list.innerHTML = visible.map(n => {
    const actor = _notifActorCache[n.actor_id] || {};
    // Privacy treatment (lock avatar, "Someone sent you a private
    // message", no preview) is reserved for SECRET-CHAT DMs only. The
    // is_secret flag is written by the chat-bell trigger
    // (migration_notifications_dm_secret_flag.sql) and backfilled for
    // existing rows. Regular DMs render with the real sender, real
    // avatar, and the normal "X sent you a message" label so the bell
    // doesn't lie about who's chatting with you.
    const isPrivateDm = n.type === 'dm_message' && n.metadata?.is_secret === true;
    const avatar = isPrivateDm
      ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
      : (actor.avatar_url
          ? `<img src="${escHTML(actor.avatar_url)}"/>`
          : (actor.username ? initials(actor.username) : '?'));
    const text = isPrivateDm
      ? 'Someone sent you a private message'
      : notificationLabel(n, actor.username);
    // Snippets reveal context — also hidden for Secret DMs.
    const snippet = isPrivateDm ? '' : (n.metadata?.snippet || n.metadata?.caption || '');
    const snippetHTML = snippet
      ? `<div class="notification-snippet">"${escHTML(snippet)}"</div>`
      : '';
    return `
      <div class="notification-item ${n.is_read ? '' : 'unread'}${isPrivateDm ? ' notification-private' : ''}" data-id="${n.id}">
        <div class="notification-avatar">${avatar}</div>
        <div class="notification-body">
          <div class="notification-text">${text}</div>
          ${snippetHTML}
          <div class="notification-time">${timeAgo(n.created_at)}</div>
        </div>
        <span class="notification-dot"></span>
      </div>`;
  }).join('');

  list.querySelectorAll('.notification-item').forEach(item => {
    item.addEventListener('click', () => onNotificationClick(item.dataset.id));
  });
}

function notificationLabel(n, knownUsername) {
  // Build the actor display: 1 = "Alice", 2 = "Alice and Bob",
  // 3+ = "Alice and N others". Uses actor_ids when present (coalesced
  // engagement notifications), otherwise falls back to the single actor_id.
  const ids = (Array.isArray(n.actor_ids) && n.actor_ids.length)
    ? n.actor_ids
    : (n.actor_id ? [n.actor_id] : []);
  const names = ids
    .map(id => _notifActorCache[id]?.username)
    .filter(Boolean);
  const fallbackName = knownUsername || _notifActorCache[n.actor_id]?.username || 'Someone';
  let actorTag;
  if (names.length === 0) {
    actorTag = `<strong>${escHTML(fallbackName)}</strong>`;
  } else if (names.length === 1) {
    actorTag = `<strong>${escHTML(names[0])}</strong>`;
  } else if (names.length === 2) {
    actorTag = `<strong>${escHTML(names[0])}</strong> and <strong>${escHTML(names[1])}</strong>`;
  } else {
    actorTag = `<strong>${escHTML(names[0])}</strong> and <strong>${names.length - 1} others</strong>`;
  }
  const titleHint = n.metadata?.title ? ` <em style="color:var(--text2)">"${escHTML(n.metadata.title)}"</em>` : '';
  switch (n.type) {
    // ── You: engagement on your stuff ──
    case 'like_post':
    case 'post_like':              // legacy noun_verb, pre-rename migration
      return `${actorTag} reacted to your post`;
    case 'like_video':
    case 'video_like':             // legacy
      return `${actorTag} reacted to your video`;
    case 'like_comment':
    case 'post_comment_like':      // legacy
    case 'video_comment_like':     // legacy
      return `${actorTag} reacted to your comment`;
    case 'like_book':
    case 'book_like':              // legacy
      return `${actorTag} liked your book${titleHint}`;
    case 'comment_post':
    case 'post_comment':           // legacy
      return `${actorTag} commented on your post`;
    case 'comment_video':
    case 'video_comment':          // legacy
      return `${actorTag} commented on your video`;
    case 'reply_comment':
    case 'post_comment_reply':     // legacy
    case 'video_comment_reply':    // legacy
      return `${actorTag} replied to your comment`;
    case 'comment_chapter':
    case 'chapter_comment':        // legacy
      return `${actorTag} commented on your chapter`;
    case 'reply_chapter_comment':
    case 'chapter_comment_reply':  // legacy
      return `${actorTag} replied to your chapter comment`;
    case 'repost_post':
    case 'post_repost':            // legacy
      return `${actorTag} reposted your post`;
    // ── Follows ──
    // The notify_on_follow trigger fires this on every new row in
    // public.follows. Earlier we keyed off 'follow_new_post' /
    // 'follow_new_video' / 'follow_new_book' for the more specialized
    // "person you follow just published X" notifications, but the
    // raw "X started following you" event gets the bare 'follow' type.
    case 'follow':                 return `${actorTag} started following you`;

    // ── Following: people you follow doing things ──
    case 'follow_new_post':        return `${actorTag} posted something new`;
    case 'follow_new_video':       return `${actorTag} uploaded a new video`;
    case 'follow_new_book':        return `${actorTag} published a new book${titleHint}`;
    case 'follow_repost':          return `${actorTag} shared a post`;

    // ── Mentions ──
    case 'mention_comment':        return `${actorTag} mentioned you in a comment`;
    case 'mention_chapter_comment':return `${actorTag} mentioned you in a chapter comment`;

    // ── Direct messages ──
    case 'dm_message': {
      const preview = n.metadata?.preview ? ` <em style="color:var(--text2)">"${escHTML(String(n.metadata.preview).slice(0, 80))}"</em>` : '';
      return `${actorTag} sent you a message${preview}`;
    }

    default:                       return `${actorTag} did something on Selebox`;
  }
}

async function onNotificationClick(notifId) {
  const n = _notifications.find(x => x.id === notifId);
  if (!n) return;

  // Mark as read locally + in DB (optimistic)
  if (!n.is_read) {
    n.is_read = true;
    _notifUnreadCount = Math.max(0, _notifUnreadCount - 1);
    updateNotifBadge();
    renderNotifications();
    supabase.from('notifications').update({ is_read: true }).eq('id', notifId)
      .then(({ error }) => { if (error) console.warn('Mark read failed:', error); });
  }

  closeNotifPanel();

  // ── DM short-circuit ──────────────────────────────────────────────────
  // Always land in the inbox/thread for chat notifications, even if the
  // legacy row predates the parent_target_type backfill and would
  // otherwise miss the dispatch table below.
  if (n.type === 'dm_message' || n.target_type === 'message' || n.parent_target_type === 'conversation') {
    const convId = n.parent_target_type === 'conversation' ? n.parent_target_id : null;
    if (convId) { showMessages(); setTimeout(() => openConversation(convId), 50); }
    else        { showMessages(); }
    return;
  }

  // ── Data-driven dispatch ──────────────────────────────────────────────
  // Bell notifications carry a (kind, id) routing pair. Prefer the parent
  // (the openable surface — post / video / book / profile) over the
  // immediate target (which for a comment is the comment row itself,
  // never directly openable). Falls back to target_type when the parent
  // wasn't populated by the trigger (true for some legacy rows and for
  // the repost / follow_new_post fanout triggers whose source isn't
  // versioned in this repo).
  //
  // The kind→opener table is the single place to add a new notification
  // surface. New notification types just need their write-side trigger
  // to set parent_target_type / parent_target_id correctly — no edits
  // needed here.
  //
  // See migration_notifications_parent_target_type.sql for the matching
  // server-side change and historical-row backfill.
  let kind = n.parent_target_type || n.target_type || null;
  let id   = n.parent_target_id   || n.target_id   || null;

  // 'follow' notifications carry target_type='profile' but target_id IS
  // NULL (the row's actor_id is the followed-from user). Route to that
  // profile directly.
  if (n.type === 'follow') {
    kind = 'profile';
    id = n.actor_id || id;
  }

  // A bare 'comment' kind can survive on legacy reply rows where the
  // parent comment had no post/video link at backfill time. Land the
  // user on Home rather than open a non-openable target.
  if (kind === 'comment') {
    kind = null;
  }

  const ROUTES = {
    post:    (postId)    => openPostFromSearch(postId),
    video:   (videoUuid) => playVideo('sb_' + videoUuid),
    book:    (bookId)    => openBookDetail(bookId),
    chapter: (bookId)    => openBookDetail(bookId),
    profile: (userId)    => openProfile(userId),
  };

  const opener = kind ? ROUTES[kind] : null;
  if (opener && id) {
    opener(id);
    return;
  }

  // ── Final fallback ──
  setSidebarActive('btnHome');
  showFeed();
}

async function markAllNotificationsRead() {
  if (!_notifUnreadCount) return;
  const unread = _notifications.filter(n => !n.is_read).map(n => n.id);
  _notifications.forEach(n => { n.is_read = true; });
  _notifUnreadCount = 0;
  updateNotifBadge();
  renderNotifications();
  if (unread.length) {
    const { error } = await supabase.from('notifications').update({ is_read: true }).in('id', unread);
    if (error) console.warn('Mark all read failed:', error);
  }
}

function toggleNotifPanel() {
  if (_notifPanelOpen) closeNotifPanel();
  else openNotifPanel();
}
function openNotifPanel() {
  const panel = document.getElementById('notificationsPanel');
  if (!panel) return;
  panel.style.display = 'flex';
  _notifPanelOpen = true;
}
function closeNotifPanel() {
  const panel = document.getElementById('notificationsPanel');
  if (!panel) return;
  panel.style.display = 'none';
  _notifPanelOpen = false;
}

document.getElementById('btnNotifications')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleNotifPanel();
});
document.getElementById('notifMarkAll')?.addEventListener('click', (e) => {
  e.stopPropagation();
  markAllNotificationsRead();
});
// Filter tabs
document.querySelectorAll('.notif-filter-tab').forEach(tab => {
  tab.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.notif-filter-tab').forEach(t => t.classList.toggle('active', t === tab));
    _notifFilter = tab.dataset.filter || 'all';
    renderNotifications();
  });
});
// Click outside the panel → close
document.addEventListener('click', (e) => {
  if (!_notifPanelOpen) return;
  if (e.target.closest('#notificationsPanel') || e.target.closest('#btnNotifications')) return;
  closeNotifPanel();
});

// ════════════════════════════════════════════════════════════════════════════
// DAILY QUESTS — brainstorming surface (web-only, hardcoded data)
// ════════════════════════════════════════════════════════════════════════════
// Goal: ship a clickable UI we can iterate on for daily-quest UX +
// economics WITHOUT writing schema or backend yet. The hardcoded
// `_dailyQuestsState` below is the single source of truth — change it
// to mock different progress states and reload.
//
// Once the design feels right, we replace _dailyQuestsState with a
// fetch from `daily_quests` (quest definitions) + `user_quest_progress`
// (per-user-per-day completion) on Supabase, and port the same UI to
// mobile via NotificationCard's pattern.
//
// Quests are organized to drive the behaviors we actually want: open
// the app, read chapters (the core engagement metric), watch videos,
// engage socially. Rewards are tuned so the heaviest task pays the
// most per minute of effort, and the meta-bonus for completing all
// makes the streak emotionally sticky.

// Quest definitions for each cadence (Daily / Weekly / Monthly).
// `progress` and `claimed` are mutable state and would come from
// user_quest_progress in production. `target` and `reward` come from
// the quest definition.
//
// Reward design philosophy:
//   • Daily quests pay out small (3–20 stars) — quick wins, cheap to
//     repeat, drive DAU.
//   • Weekly quests pay 30–80 stars — meaningful but require a streak
//     of engagement, drive 7-day return rate.
//   • Monthly quests pay 150–500 stars + cosmetic badges — epic goals
//     for power users, drive long-term retention + a sense of mastery.
const _dailyQuestsState = {
  // Streak: consecutive days the user has completed the daily set.
  // Same number powers the topbar badge + the "Day N" pip strip.
  streak: 7,
  bonusClaimed: false,
  activeTab: 'daily', // 'daily' | 'weekly' | 'monthly'

  // Featured "Quest of the Day" — pinned at the top of the daily tab
  // with a bigger reward. Rotates daily based on day-of-year so users
  // get a fresh focal point each session. Pool of 4 below; pick by
  // (dayOfYear % pool.length).
  featuredPool: [
    { id: 'feat_genre',    icon: 'compass', label: 'Try a book in a new genre',  target: 1, reward: 30, unit: '' },
    { id: 'feat_creator',  icon: 'compass', label: 'Discover a new creator',     target: 1, reward: 30, unit: '' },
    { id: 'feat_finish',   icon: 'compass', label: 'Finish a chapter today',     target: 1, reward: 30, unit: '' },
    { id: 'feat_share',    icon: 'compass', label: 'Share a post or book',       target: 1, reward: 30, unit: '' },
  ],

  // Daily quest list — Charles's spec (v6).
  //
  // ECONOMY: 1⭐ = ₱0.05, 1🪙 = ₱0.20.
  // Max daily payout per user (all quests cleared): 28⭐ + 7🪙 = ₱2.80.
  //
  // ⚠️ ABUSE-GUARD NOTES (must enforce server-side before production):
  //
  // • follow_creator (10⭐): "Follow 1 Creator/Writer (should always
  //   new)". Server-side rule: counts ONLY follows of creators the user
  //   has never followed before (or hasn't followed in 30+ days). Daily
  //   cap: 1. Without this, a user can follow → unfollow → follow next
  //   and farm 10⭐ on every cycle.
  //
  // • invite_friend (5🪙): SUCCESSFUL invites only. The 5-coin (₱1.00)
  //   reward is the highest single-quest payout, so it's the highest
  //   abuse target. Required server-side guards:
  //     1. Invitee signs up via the inviter's unique referral link/code
  //        (links the new account to the inviter at signup time).
  //     2. Invitee verifies their email.
  //     3. Invitee opens the app on a DIFFERENT calendar day from
  //        signup (cheap proof-of-human; bots typically create + abandon
  //        in one session).
  //     4. ONLY THEN does the inviter's 5🪙 settle and the quest tick.
  //     5. Daily cap: 1 invite toward this quest (additional invites
  //        can pay a smaller reward separately, e.g. 1🪙, capped at 5/day).
  //   Optional anti-self-invite: invitee's IP / device ID / payment
  //   method must differ from inviter's. Optional 50/50 split: pay
  //   2.5🪙 on signup, 2.5🪙 after 7-day invitee activity — doubles
  //   the fraud cost.
  //
  // • watch_ads (2🪙): hard-cap at exactly 20 ads/day toward this
  //   quest — past 20 the counter doesn't tick. Use the rewarded-ad
  //   SDK so impressions count toward AdMob fill (otherwise the user
  //   sees ads but you don't get paid). Net economics: 20 ads ≈ +₱4.50
  //   AdMob revenue vs −₱0.40 reward = +₱4.10/user/day. Revenue-positive.
  //
  // • read5 + read10 are "tiered": completing Read 10 also implies
  //   Read 5. The UI shows both for transparency, but the underlying
  //   reward should NOT double-pay. Final implementation should either
  //   merge into one quest with a milestone marker or auto-claim the
  //   smaller tier when the larger lands. Same for watch30 + watch60.
  // ─── DAILY QUESTS — POOL REWARD MODEL ─────────────────────────────────
  // 6 quests on offer; user clears any 4 of them to claim the daily
  // pool reward = 4⭐ + 1🪙. Per-quest payouts are GONE — only the pool
  // pays out, which keeps the daily payout envelope strictly bounded
  // (max ₱0.40 in stars + ₱0.20 in coins = ₱0.60/user/day for the pool).
  //
  // Exception: `invite_friend` carries an additional +1🪙 BONUS that
  // settles on top of the pool reward. The bonus is its own ledger
  // entry — successful-invite specific (signup + email-verify +
  // different-day session per the abuse-guard notes elsewhere). Worth
  // ₱0.20 server-cost; treat as referral-acquisition spend, not engagement.
  //
  // Per-quest `reward` and `currency` fields removed — there's no
  // individual payout to render in the reward pill anymore. The pill
  // is replaced by a progress-only display ("0/3", "5/10 mins").
  daily: [
    // Log-in check anchors the list — auto-clears the moment the user
    // opens the app and an authenticated session is detected. Cheapest
    // possible quest by design (free progress toward the pool of 4),
    // but gated server-side on a real session so guests / signed-out
    // visitors don't tick it.
    { id: 'login',         icon: 'door',     label: 'Log in today',            progress: 0, target: 1,  unit: '' },
    { id: 'read_chapters', icon: 'book',     label: 'Read 3 chapters',         progress: 0, target: 3,  unit: '' },
    { id: 'watch_video',   icon: 'video',    label: 'Watch 10 mins of video',  progress: 0, target: 10, unit: 'min' },
    { id: 'like_comment',  icon: 'heart',    label: 'Like & comment 3 posts',  progress: 0, target: 3,  unit: '' },
    { id: 'follow_user',   icon: 'userplus', label: 'Follow 1 new user',       progress: 0, target: 1,  unit: '' },
    { id: 'watch_ads',     icon: 'ad',       label: 'Watch 3 ads',             progress: 0, target: 3,  unit: '' },
    { id: 'invite_friend', icon: 'gift',     label: 'Invite 1 friend',         progress: 0, target: 1,  unit: '', bonus: { stars: 0, coins: 1 } },
  ],

  // Pool config — drives the reward header + claim button.
  //
  // Tight-budget tuning: daily threshold raised to 5 of 7 (was 4) so
  // the pool earn is gated on real engagement breadth, not just a
  // couple of cheap clears. Weekly threshold raised to 6 of 9, and
  // the weekly reward shrunk hard from 20⭐+5🪙 to 8⭐+2🪙 — payout
  // envelope dropped from ₱2.00 to ₱0.80/user/week. Bonus settlements
  // (invite_friend / purchase_coin) sit on top but route to acquisition
  // / margin-positive lines, so they don't pressure the engagement
  // payout budget.
  dailyPool: {
    questsRequired: 5,
    reward: { stars: 4, coins: 1 },
    claimed: false,
  },
  weeklyPool: {
    questsRequired: 6,
    reward: { stars: 8, coins: 2 },
    claimed: false,
  },
  // Monthly pool: 9-of-10 threshold (90% — power-user gate). Reward
  // 1000🪙 — large aspirational payout that only the heaviest-engaged
  // power users will clear (90% completion bar across a full month
  // including 30-day stay-active and IAP/invite quests). Per-user
  // expected cost is bounded by the % of users who actually hit the
  // 9-of-10 gate, not the headline 1000🪙 number itself.
  // Bonus settlements (purchase_coin +5🪙, invite_friend +5🪙) sit on
  // top via separate margin/acquisition lines.
  monthlyPool: {
    questsRequired: 9,
    reward: { stars: 0, coins: 1000 },
    claimed: false,
  },

  // ─── WEEKLY QUESTS — POOL REWARD MODEL ────────────────────────────────
  // 9 quests on offer; user clears any 5 to claim the weekly pool reward
  // = 20⭐ + 5🪙. Two quests carry their own +3🪙 bonus settlement on
  // top of the pool: invite_friend (5 successful invites) and
  // purchase_coin (1 IAP this week — incentivizes the conversion).
  // Same per-quest fields as daily (no individual reward / currency).
  weekly: [
    { id: 'w_read_chapters', icon: 'book',     label: 'Read 20 chapters',           progress: 0, target: 20, unit: '' },
    { id: 'w_watch_video',   icon: 'video',    label: 'Watch 60 mins of video',     progress: 0, target: 60, unit: 'min' },
    { id: 'w_like_comment',  icon: 'heart',    label: 'Like & comment 20 times',    progress: 0, target: 20, unit: '' },
    { id: 'w_follow_users',  icon: 'userplus', label: 'Follow 5 users',             progress: 0, target: 5,  unit: '' },
    { id: 'w_share',         icon: 'compass',  label: 'Share 5 books or videos',    progress: 0, target: 5,  unit: '' },
    { id: 'w_unlock',        icon: 'gift',     label: 'Unlock 3 books or videos',   progress: 0, target: 3,  unit: '' },
    { id: 'w_watch_ads',     icon: 'ad',       label: 'Watch 10 ads',               progress: 0, target: 10, unit: '' },
    { id: 'w_invite_friend', icon: 'userplus', label: 'Invite 5 friends',           progress: 0, target: 5,  unit: '', bonus: { stars: 0, coins: 3 } },
    { id: 'w_purchase_coin', icon: 'gift',     label: 'Purchase coins',             progress: 0, target: 1,  unit: '', bonus: { stars: 0, coins: 3 } },
  ],

  // ─── MONTHLY QUESTS — POOL REWARD MODEL ───────────────────────────────
  // 10 quests on offer; user clears any 9 to claim the monthly pool
  // reward = 20⭐ + 5🪙. Two quests carry their own +5🪙 bonus
  // settlement on top of the pool (purchase_coin → margin-positive,
  // invite_friend → acquisition spend).
  monthly: [
    { id: 'm_read_chapters', icon: 'book',     label: 'Read 100 chapters',         progress: 0, target: 100, unit: '' },
    { id: 'm_watch_video',   icon: 'video',    label: 'Watch 300 mins of video',   progress: 0, target: 300, unit: 'min' },
    { id: 'm_like_comment',  icon: 'heart',    label: 'Like & comment 100 times',  progress: 0, target: 100, unit: '' },
    { id: 'm_follow_users',  icon: 'userplus', label: 'Follow 20 users',           progress: 0, target: 20,  unit: '' },
    { id: 'm_share',         icon: 'compass',  label: 'Share 20 books or videos',  progress: 0, target: 20,  unit: '' },
    { id: 'm_unlock',        icon: 'gift',     label: 'Unlock 30 books or videos', progress: 0, target: 30,  unit: '' },
    { id: 'm_watch_ads',     icon: 'ad',       label: 'Watch 100 ads',             progress: 0, target: 100, unit: '' },
    { id: 'm_active30',      icon: 'door',     label: 'Stay active 30 days',       progress: 0, target: 30,  unit: ' days' },
    { id: 'm_purchase_coin', icon: 'gift',     label: 'Purchase coins 4 times',    progress: 0, target: 4,   unit: '', bonus: { stars: 0, coins: 5 } },
    { id: 'm_invite_friend', icon: 'userplus', label: 'Invite 10 friends',         progress: 0, target: 10,  unit: '', bonus: { stars: 0, coins: 5 } },
  ],

  // Per-day completion log for the day-strip rendering. Each entry
  // is an offset from today (negative = past). Status: 'complete'
  // means "all daily quests claimed that day". Pre-seeded with the
  // 7-day streak so the strip looks lived-in on first paint.
  dayHistory: [
    { offset: -6, status: 'complete' },
    { offset: -5, status: 'complete' },
    { offset: -4, status: 'complete' },
    { offset: -3, status: 'complete' },
    { offset: -2, status: 'complete' },
    { offset: -1, status: 'complete' },
    { offset:  0, status: 'today'    },
    { offset:  1, status: 'future'   },
    { offset:  2, status: 'future'   },
  ],

  // Persist to localStorage so demo state survives page reloads.
  _persistKey: 'daily_quests_demo_state_v2',
};

// Per-tab display config. Lets us drive title text + day-strip cadence
// + footer label off a single source. Daily strip is fixed at 7 pips
// (one per day of the current week — Day 1 to Day 7); weekly is a
// 5-week rolling window; monthly is the last 6 months.
// User-facing rebrand: "Quests" → "Goals" so the system reads cleaner
// and matches the mobile app's [Goals][Store] tab. Internal ID/class
// names (questsXyz, _dailyQuestsState) intentionally NOT renamed —
// touching them would ripple across hundreds of CSS rules and JS
// selectors. Only the visible labels change.
const QUEST_TAB_META = {
  daily:   { title: 'Daily Goals',   stripCadence: 'day',   stripCount: 7 },
  weekly:  { title: 'Weekly Goals',  stripCadence: 'week',  stripCount: 5 },
  monthly: { title: 'Monthly Goals', stripCadence: 'month', stripCount: 6 },
};

const QUEST_ICONS = {
  door:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v18"/><line x1="2" y1="22" x2="22" y2="22"/><line x1="14" y1="12" x2="14" y2="13"/></svg>',
  book:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  video:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
  heart:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
  star:    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  userplus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
  gift:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
  ad:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2" ry="2"/><polygon points="10 8 16 11 10 14 10 8" fill="currentColor"/><line x1="6" y1="22" x2="18" y2="22"/><line x1="12" y1="18" x2="12" y2="22"/></svg>',
};

// Pick today's featured quest deterministically from the day-of-year so
// every user sees the SAME quest on a given day (creates a shared "daily
// thing" to talk about) but rotates through the pool over time.
function _featuredQuestForToday() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now - start;
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  const pool = _dailyQuestsState.featuredPool || [];
  if (pool.length === 0) return null;
  const def = pool[dayOfYear % pool.length];
  // Pull mutable progress/claimed state from the persisted overlay if any.
  const overlay = (_dailyQuestsState.featuredState && _dailyQuestsState.featuredState[def.id]) || {};
  return {
    ...def,
    isFeatured: true,
    progress: typeof overlay.progress === 'number' ? overlay.progress : 0,
    claimed: !!overlay.claimed,
  };
}

function _loadDailyQuestsFromStorage() {
  try {
    const raw = localStorage.getItem(_dailyQuestsState._persistKey);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.day !== new Date().toISOString().slice(0, 10)) return; // new day → reset
    if (typeof saved.streak === 'number') _dailyQuestsState.streak = saved.streak;
    if (typeof saved.bonusClaimed === 'boolean') _dailyQuestsState.bonusClaimed = saved.bonusClaimed;
    if (typeof saved.activeTab === 'string') _dailyQuestsState.activeTab = saved.activeTab;
    if (saved.featuredState && typeof saved.featuredState === 'object') {
      _dailyQuestsState.featuredState = saved.featuredState;
    }
    for (const tab of ['daily', 'weekly', 'monthly']) {
      if (Array.isArray(saved[tab])) {
        for (const q of _dailyQuestsState[tab]) {
          const found = saved[tab].find(s => s.id === q.id);
          if (found) {
            if (typeof found.progress === 'number') q.progress = found.progress;
            if (typeof found.claimed === 'boolean') q.claimed = found.claimed;
          }
        }
      }
    }
  } catch (e) { /* corrupt cache, fall back to defaults */ }
}

function _saveDailyQuestsToStorage() {
  try {
    const snap = (list) => list.map(q => ({ id: q.id, progress: q.progress, claimed: !!q.claimed }));
    localStorage.setItem(_dailyQuestsState._persistKey, JSON.stringify({
      day: new Date().toISOString().slice(0, 10),
      streak: _dailyQuestsState.streak,
      bonusClaimed: _dailyQuestsState.bonusClaimed,
      activeTab: _dailyQuestsState.activeTab,
      daily: snap(_dailyQuestsState.daily),
      weekly: snap(_dailyQuestsState.weekly),
      monthly: snap(_dailyQuestsState.monthly),
      featuredState: _dailyQuestsState.featuredState || {},
    }));
  } catch (e) { /* localStorage full or disabled — non-fatal for a demo surface */ }
}

// ─── Supabase-backed goals (cross-device alignment) ───────────────────
// Migration: Selebox/migration_goals_progress.sql. The same Dear Jen
// account → identical state on phone + laptop. localStorage stays as
// a write-through cache so the panel renders instantly on open;
// authoritative state is read from / written to Supabase.

const _periodKeyDaily   = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const _periodKeyWeekly  = (now = new Date()) => {
  // ISO week — same algorithm mobile uses, so both platforms compute
  // the SAME period_key for the same calendar week.
  const tmp = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7;
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
  const firstThursday = tmp.valueOf();
  tmp.setUTCMonth(0, 1);
  if (tmp.getUTCDay() !== 4) tmp.setUTCMonth(0, 1 + ((4 - tmp.getUTCDay()) + 7) % 7);
  const weekNum = 1 + Math.round((firstThursday - tmp) / 604800000);
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
};
const _periodKeyMonthly = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

const _PERIOD_KEY_FN = { daily: _periodKeyDaily, weekly: _periodKeyWeekly, monthly: _periodKeyMonthly };

// Pull current-period progress + claim state from Supabase, fold the
// counters into _dailyQuestsState quest rows. Called on panel open
// (so the user sees server state, not stale localStorage).
async function _fetchGoalsFromSupabase() {
  if (!currentUser?.id) return;
  try {
    // Build the (period, period_key) tuples we care about so the
    // query fires once per period bucket rather than three round-trips.
    const periods = ['daily', 'weekly', 'monthly'];
    const periodKeys = periods.map(p => _PERIOD_KEY_FN[p]());

    const [progressRes, claimsRes] = await Promise.all([
      supabase
        .from('user_goal_progress')
        .select('period, period_key, counters')
        .eq('user_id', currentUser.id)
        .in('period', periods),
      supabase
        .from('user_goal_claims')
        .select('period, period_key')
        .eq('user_id', currentUser.id)
        .in('period', periods),
    ]);

    if (progressRes.error) {
      console.warn('[goals] fetch progress', progressRes.error.message);
    } else {
      const byPeriod = {};
      for (const row of progressRes.data || []) {
        if (row.period_key === _PERIOD_KEY_FN[row.period]()) {
          byPeriod[row.period] = row.counters || {};
        }
      }
      // Fold server counters onto our local quest definitions.
      for (const tab of periods) {
        const counters = byPeriod[tab] || {};
        for (const q of _dailyQuestsState[tab]) {
          if (typeof counters[q.id] === 'number') q.progress = counters[q.id];
        }
      }
    }

    if (claimsRes.error) {
      console.warn('[goals] fetch claims', claimsRes.error.message);
    } else {
      for (const row of claimsRes.data || []) {
        if (row.period_key !== _PERIOD_KEY_FN[row.period]()) continue;
        const poolKey = row.period === 'daily' ? 'dailyPool' : row.period === 'weekly' ? 'weeklyPool' : 'monthlyPool';
        if (_dailyQuestsState[poolKey]) _dailyQuestsState[poolKey].claimed = true;
      }
    }
  } catch (e) {
    console.warn('[goals] fetch fatal', e);
  }
}

// Fire the tick_user_goal RPC for a given (period, deltas) pair.
// Fire-and-forget — local optimistic write already happened via the
// caller, so a failed RPC just logs.
async function _fireTickGoalRpc(period, deltas) {
  if (!currentUser?.id) return;
  if (!deltas || Object.keys(deltas).length === 0) return;
  const { error } = await supabase.rpc('tick_user_goal', {
    p_actor_id: currentUser.id,
    p_period: period,
    p_period_key: _PERIOD_KEY_FN[period](),
    p_deltas: deltas,
  });
  if (error) console.warn('[goals] tick rpc', period, error.message);
}

// Atomic claim. Returns { ok, alreadyClaimed }.
async function _fireClaimGoalPoolRpc(period, reward = { stars: 0, coins: 0 }) {
  if (!currentUser?.id) return { ok: true };
  const { data, error } = await supabase.rpc('claim_user_goal_pool', {
    p_actor_id: currentUser.id,
    p_period: period,
    p_period_key: _PERIOD_KEY_FN[period](),
    p_stars_to_credit: reward.stars || 0,
    p_coins_to_credit: reward.coins || 0,
  });
  if (error) {
    console.warn('[goals] claim rpc', period, error.message);
    return { ok: false };
  }
  return { ok: !!data?.ok, alreadyClaimed: !!data?.already_claimed };
}

let _dailyQuestsPanelOpen = false;

// Render the day-strip pips. Cadence comes from QUEST_TAB_META so each
// tab gets a different timeline view:
//   • daily   → recent days as "Day N" pips around the current streak
//   • weekly  → recent 5 weeks as "W1..W5"
//   • monthly → recent 6 months as "Jan..Jun"
// Today/this-week/this-month pip is highlighted; past complete pips are
// green, missed pips are red strikethrough, future pips are dim.
function _renderQuestsDayStrip() {
  const strip = document.getElementById('questsDayStrip');
  if (!strip) return;
  const meta = QUEST_TAB_META[_dailyQuestsState.activeTab] || QUEST_TAB_META.daily;

  let pips = [];
  if (meta.stripCadence === 'day') {
    // Always show Day 1 through Day 7 — represents the current 7-day
    // cycle. Status mapping based on streak:
    //   • streak === 0 → Day 1 is today, rest future
    //   • 0 < streak < 7 → Days 1..(streak-1) complete, Day streak is today
    //   • streak >= 7 → all 7 complete; Day 7 is "today" (the day they
    //     just completed). Higher streaks roll over to a new week (we
    //     show the same Day 1-7 grid, fully filled).
    const streak = Math.max(_dailyQuestsState.streak, 0);
    const cappedStreak = streak === 0 ? 0 : ((streak - 1) % 7) + 1; // 1..7
    const showFullWeek = streak >= 7;
    for (let i = 1; i <= 7; i++) {
      let status;
      if (showFullWeek) {
        status = i < cappedStreak ? 'complete' : (i === cappedStreak ? 'today' : 'complete');
      } else if (streak === 0) {
        status = i === 1 ? 'today' : 'future';
      } else {
        if (i < cappedStreak) status = 'complete';
        else if (i === cappedStreak) status = 'today';
        else status = 'future';
      }
      pips.push({ label: 'Day', num: i, status });
    }
  } else if (meta.stripCadence === 'week') {
    // Last 5 weeks — current week is highlighted.
    for (let i = 0; i < meta.stripCount; i++) {
      const offset = i - (meta.stripCount - 1);
      pips.push({
        label: 'Wk',
        num: meta.stripCount + offset,
        status: offset === 0 ? 'today' : (offset < 0 ? 'complete' : 'future'),
      });
    }
  } else if (meta.stripCadence === 'month') {
    const now = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let i = 0; i < meta.stripCount; i++) {
      const offset = i - (meta.stripCount - 1);
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      pips.push({
        label: months[d.getMonth()],
        num: '',
        status: offset === 0 ? 'today' : (offset < 0 ? 'complete' : 'future'),
      });
    }
  }

  // Daily uses the 7-column grid (exact week view); weekly + monthly use
  // a horizontal scroll because the count varies / can grow over time.
  strip.classList.toggle('is-flex', meta.stripCadence !== 'day');

  strip.innerHTML = pips.map(p => {
    const klass = ['quest-day-pip', `is-${p.status}`].join(' ');
    const mark = p.status === 'complete' ? '<span class="quest-day-pip-mark">✓</span>' : '';
    const num = p.num !== '' ? `<span class="quest-day-pip-num">${p.num}</span>` : '';
    return `<div class="${klass}"><span class="quest-day-pip-label">${p.label}</span>${num}${mark}</div>`;
  }).join('');
}

function renderDailyQuests() {
  const list = document.getElementById('questsList');
  const streakCount = document.getElementById('questsStreakCount');
  const streakBadge = document.getElementById('questsStreakBadge');
  const titleEl = document.getElementById('questsTitle');
  // questsFooter / questsBonusReward intentionally not queried — the
  // "Complete all quests for +25 ⭐ bonus" footer was removed from the
  // DOM (budget envelope didn't allow the meta-payout).
  if (!list) return;

  const tab = _dailyQuestsState.activeTab;
  const meta = QUEST_TAB_META[tab] || QUEST_TAB_META.daily;
  // For the daily tab, prepend today's featured quest. Featured quests
  // sit above the regular quests with a distinguishing visual treatment
  // (gradient background + "FEATURED" pill). Featured quest doesn't
  // participate in the "complete all" meta-bonus calc — it's pure
  // upside, not gating the streak.
  const baseQuests = _dailyQuestsState[tab] || [];
  // Featured "Quest of the Day" disabled — the +30 ⭐ daily payout
  // sits outside the budget envelope. Quest definitions are still in
  // _dailyQuestsState.featuredPool for when budget allows reactivating
  // it; just flip back to the prepend logic from git history.
  let quests = baseQuests;

  if (titleEl) titleEl.textContent = meta.title;
  // bonusReward write removed — that DOM node and meta.bonus are gone.

  if (streakCount) streakCount.textContent = _dailyQuestsState.streak;
  if (streakBadge) {
    streakBadge.textContent = _dailyQuestsState.streak;
    streakBadge.style.display = _dailyQuestsState.streak > 0 ? 'flex' : 'none';
  }

  // Tab-active state in the tab bar.
  document.querySelectorAll('.quests-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.questsTab === tab);
  });

  // Day strip — depends on which tab is active.
  _renderQuestsDayStrip();

  // Premium monochrome currency SVGs — used in the pool reward header
  // and (for invite-friend) the per-quest bonus tag. fill="currentColor"
  // so the same shape works for light + dark mode.
  const STAR_SVG = '<svg class="quest-currency-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12,2 14.6,9 22,9.5 16.2,14 17.9,21.5 12,17.5 6.1,21.5 7.8,14 2,9.5 9.4,9"/></svg>';
  const COIN_SVG = '<svg class="quest-currency-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="6.5" fill="rgba(255,255,255,0.35)"/><circle cx="12" cy="12" r="3.5"/></svg>';

  // ─── Pool reward header (daily + weekly + monthly) ──────────────────
  // Pool model: complete N quests of M → claim a single bundled reward.
  // Lives at the top of the list, replaces individual reward pills.
  // All three tiers (daily / weekly / monthly) now use the same pool
  // shape; per-quest claim flow is fully retired.
  let poolHeader = '';
  const POOL_KEY_BY_TAB = { daily: 'dailyPool', weekly: 'weeklyPool', monthly: 'monthlyPool' };
  const POOL_TITLE_BY_TAB = { daily: 'Daily Reward', weekly: 'Weekly Reward', monthly: 'Monthly Reward' };
  const POOL_BTN_ID_BY_TAB = { daily: 'dailyPoolClaimBtn', weekly: 'weeklyPoolClaimBtn', monthly: 'monthlyPoolClaimBtn' };
  if (POOL_KEY_BY_TAB[tab]) {
    const pool = _dailyQuestsState[POOL_KEY_BY_TAB[tab]] || { questsRequired: 4, reward: { stars: 0, coins: 0 }, claimed: false };
    const completedCount = quests.filter(q => q.progress >= q.target).length;
    const required = pool.questsRequired || 4;
    const reachedThreshold = completedCount >= required;
    const isClaimed = !!pool.claimed;
    const stars = pool.reward?.stars || 0;
    const coins = pool.reward?.coins || 0;
    // Reward label includes the word "Star(s)" / "Coin(s)" alongside
    // the icon — without it the pill reads as bare numbers + abstract
    // shapes, leaving new users guessing what they'd actually earn.
    // Singular "Star" / "Coin" when the value is exactly 1.
    const starWord = stars === 1 ? 'Star' : 'Stars';
    const coinWord = coins === 1 ? 'Coin' : 'Coins';
    const rewardLabel = [
      stars > 0 ? `${stars} ${STAR_SVG} ${starWord}` : '',
      coins > 0 ? `${coins} ${COIN_SVG} ${coinWord}` : '',
    ].filter(Boolean).join(' &nbsp;·&nbsp; ');
    const action = isClaimed
      ? '<span class="quest-pool-claimed">✓ Claimed</span>'
      : (reachedThreshold
          ? `<button class="quest-pool-claim-btn" id="${POOL_BTN_ID_BY_TAB[tab]}">Claim Reward</button>`
          : '<span class="quest-pool-progress">' + completedCount + '/' + required + ' quests</span>');
    poolHeader = `
      <div class="quest-pool-header ${reachedThreshold && !isClaimed ? 'is-claimable' : ''} ${isClaimed ? 'is-claimed' : ''}">
        <div class="quest-pool-row">
          <div class="quest-pool-meta">
            <div class="quest-pool-title">${POOL_TITLE_BY_TAB[tab]}</div>
            <div class="quest-pool-subtitle">Finish ${required} quests to earn</div>
          </div>
          <div class="quest-pool-reward">${rewardLabel}</div>
        </div>
        <div class="quest-pool-action">${action}</div>
      </div>`;
  }

  // ─── Per-quest rows ──────────────────────────────────────────────────
  // All three tabs (daily / weekly / monthly) use the pool model — no
  // individual payouts, rewards bundled in poolHeader at the top.
  // Bonus-tagged quests carry an EXTRA payout on top of the pool —
  // surfaced via the small purple BONUS pill on the right side of the
  // label row.
  const isPoolTab = !!POOL_KEY_BY_TAB[tab];
  const questRows = quests.map(q => {
    const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
    const isComplete = q.progress >= q.target;
    const isClaimed = !!q.claimed;
    const klass = [
      isClaimed ? 'is-claimed' : (isComplete ? 'is-claimable' : ''),
    ].filter(Boolean).join(' ');

    let actionHtml = '';
    let labelExtras = '';
    if (isPoolTab) {
      labelExtras = q.bonus
        ? `<span class="quest-bonus-tag">+${q.bonus.coins || 0} ${COIN_SVG} BONUS</span>`
        : '';
      // No per-quest action in pool mode.
    } else {
      const currency = q.currency === 'coin' ? 'coin' : 'star';
      const glyph = currency === 'coin' ? COIN_SVG : STAR_SVG;
      actionHtml = isClaimed
        ? '<span class="quest-claimed-mark">✓</span>'
        : (isComplete
            ? `<button class="quest-claim-btn" data-quest="${q.id}">Claim</button>`
            : `<span class="quest-reward-pill">+${q.reward} ${glyph}</span>`);
    }

    return `
      <div class="quest-item ${klass}" data-quest-id="${q.id}">
        <div class="quest-icon">${QUEST_ICONS[q.icon] || ''}</div>
        <div class="quest-body">
          <div class="quest-label-row">
            <div class="quest-label">${q.label}</div>
            ${labelExtras}
          </div>
          <div class="quest-progress">
            <div class="quest-progress-bar"><div class="quest-progress-fill" style="width:${pct}%"></div></div>
            <div class="quest-progress-label">${q.progress}${q.unit}/${q.target}${q.unit}</div>
          </div>
        </div>
        ${actionHtml ? `<div class="quest-action">${actionHtml}</div>` : ''}
      </div>`;
  }).join('');

  list.innerHTML = poolHeader + questRows;

  // Wire up the pool claim button — works for both daily + weekly
  // (only one is on screen at a time, depending on active tab).
  // Period name lookup so the claim RPC knows which bucket we're
  // settling — pool key (`dailyPool`) → period (`daily`).
  const POOL_PERIOD_BY_KEY = { dailyPool: 'daily', weeklyPool: 'weekly', monthlyPool: 'monthly' };

  const wirePoolClaim = (btnId, poolKey) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pool = _dailyQuestsState[poolKey];
      if (!pool || pool.claimed) return;
      // Optimistic flip first so the UI reflects the claim immediately,
      // then settle server-side. UNIQUE on user_goal_claims rejects a
      // concurrent claim from another device — the second attempt
      // returns already_claimed=true (still ok=true), no error.
      pool.claimed = true;
      const stars = pool.reward?.stars || 0;
      const coins = pool.reward?.coins || 0;
      if (stars > 0) _flyRewardToBalance(btn, stars, 'star');
      if (coins > 0) setTimeout(() => _flyRewardToBalance(btn, coins, 'coin'), 180);
      _saveDailyQuestsToStorage();
      renderDailyQuests();
      // Fire-and-forget the server claim. If it fails (offline /
      // network blip), the local cache still shows ✓ Claimed; the
      // next refresh from server will reconcile if needed.
      _fireClaimGoalPoolRpc(POOL_PERIOD_BY_KEY[poolKey] || 'daily', pool.reward || {});
    });
  };
  wirePoolClaim('dailyPoolClaimBtn', 'dailyPool');
  wirePoolClaim('weeklyPoolClaimBtn', 'weeklyPool');
  wirePoolClaim('monthlyPoolClaimBtn', 'monthlyPool');

  // Per-quest .quest-claim-btn wiring removed — all three tabs use the
  // pool model now. Per-quest payouts are dead. Bonus-tagged quests
  // (invite_friend, purchase_coin) settle their bonus through a
  // server-side ledger when the underlying action succeeds; the UI
  // doesn't need a click handler for them.

  // Streak tick — bump the streak counter when all REGULAR daily quests
  // are claimed (featured quest is excluded; it's pure upside, not
  // gating the streak). The +25 ⭐ "complete all" bonus is intentionally
  // GONE — the budget envelope can't absorb a second payout layer on
  // top of the per-quest stars. Footer DOM was removed in index.html;
  // we keep this hook so the streak +1 still fires once per day.
  const regularQuests = quests.filter(q => !q.isFeatured);
  const allClaimed = regularQuests.length > 0 && regularQuests.every(q => q.claimed);
  if (allClaimed && !_dailyQuestsState.bonusClaimed && tab === 'daily') {
    _dailyQuestsState.bonusClaimed = true;
    _dailyQuestsState.streak = (_dailyQuestsState.streak || 0) + 1;
    _saveDailyQuestsToStorage();
    setTimeout(renderDailyQuests, 50);
  }
}

// ── Reset countdown timer ────────────────────────────────────────────────
// Renders "Resets in Xh Ym" inline next to the streak pill. Updates every
// minute via _scheduleQuestsCountdown. Daily resets at midnight local time;
// weekly resets Monday midnight; monthly resets first of next month.
function _msUntilDailyReset() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return tomorrow - now;
}
function _msUntilWeeklyReset() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
  const daysToMonday = (8 - (day === 0 ? 7 : day)) % 7 || 7;
  const nextMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToMonday, 0, 0, 0, 0);
  return nextMonday - now;
}
function _msUntilMonthlyReset() {
  const now = new Date();
  const firstNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return firstNextMonth - now;
}
function _formatCountdown(ms) {
  if (ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
function _renderQuestsCountdown() {
  const el = document.getElementById('questsCountdown');
  if (!el) return;
  const tab = _dailyQuestsState.activeTab;
  const ms = tab === 'monthly' ? _msUntilMonthlyReset() : (tab === 'weekly' ? _msUntilWeeklyReset() : _msUntilDailyReset());
  el.textContent = `Resets in ${_formatCountdown(ms)}`;
}
let _questsCountdownInterval = null;
function _scheduleQuestsCountdown() {
  _renderQuestsCountdown();
  if (_questsCountdownInterval) clearInterval(_questsCountdownInterval);
  _questsCountdownInterval = setInterval(_renderQuestsCountdown, 60 * 1000);
}

// ── Floating "+N ⭐" / "+N 🪙" reward animation ──────────────────────────
// Spawns a transient absolute-positioned pill at the claim button's
// location, then transitions it toward the matching topbar wallet pill.
// Coin rewards target #topbarCoinBalance, star rewards target
// #topbarStarBalance. After the animation, the element removes itself.
function _flyRewardToBalance(originEl, amount, currency) {
  const isCoin = currency === 'coin';
  const balElId = isCoin ? 'topbarCoinBalance' : 'topbarStarBalance';
  const balEl = document.getElementById(balElId) || document.getElementById('topbarCoinPill');
  const glyph = isCoin ? '🪙' : '⭐';
  if (!originEl) return;
  const originRect = originEl.getBoundingClientRect();
  const targetRect = balEl ? balEl.getBoundingClientRect() : { left: window.innerWidth - 60, top: 20, width: 0, height: 0 };
  const fly = document.createElement('div');
  fly.className = `quest-fly-reward ${isCoin ? 'is-coin' : ''}`;
  fly.textContent = `+${amount} ${glyph}`;
  fly.style.left = `${originRect.left + originRect.width / 2}px`;
  fly.style.top  = `${originRect.top  + originRect.height / 2}px`;
  document.body.appendChild(fly);
  requestAnimationFrame(() => {
    fly.classList.add('is-poppin');
    requestAnimationFrame(() => {
      const dx = (targetRect.left + targetRect.width / 2) - (originRect.left + originRect.width / 2);
      const dy = (targetRect.top  + targetRect.height / 2) - (originRect.top  + originRect.height / 2);
      fly.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.55)`;
      fly.style.opacity = '0';
    });
  });
  setTimeout(() => fly.remove(), 950);
  setTimeout(() => {
    if (balEl) {
      const cur = parseInt(balEl.textContent || '0', 10) || 0;
      balEl.textContent = String(cur + amount);
      balEl.classList.add('is-just-bumped');
      setTimeout(() => balEl.classList.remove('is-just-bumped'), 600);
    }
  }, 700);
}

function toggleDailyQuestsPanel() {
  const panel = document.getElementById('dailyQuestsPanel');
  if (!panel) return;
  if (_dailyQuestsPanelOpen) {
    panel.style.display = 'none';
    _dailyQuestsPanelOpen = false;
    if (_questsCountdownInterval) {
      clearInterval(_questsCountdownInterval);
      _questsCountdownInterval = null;
    }
  } else {
    panel.style.display = 'flex';
    _dailyQuestsPanelOpen = true;
    // Render once with the local-cache state for an instant open,
    // then fire the server fetch and re-render with authoritative
    // counters. If the server fetch fails (offline) the local cache
    // remains visible — graceful degradation.
    renderDailyQuests();
    _fetchGoalsFromSupabase().then(() => {
      if (_dailyQuestsPanelOpen) renderDailyQuests();
    });
    _scheduleQuestsCountdown();
  }
}

// Demo reset — clears localStorage state so we can start fresh during
// brainstorming. Held back behind the panel header's circular "↻"
// button so it doesn't show up to real users when this ships.
function _resetDailyQuestsDemo() {
  localStorage.removeItem(_dailyQuestsState._persistKey);
  _dailyQuestsState.streak = 7;
  _dailyQuestsState.bonusClaimed = false;
  _dailyQuestsState.featuredState = {};
  const dailyDefaults = {
    login: 1, read5: 2, read10: 2, watch30: 12, watch60: 12,
    like3: 0, comment3: 0, follow_creator: 0, watch_ads: 0, invite_friend: 0,
  };
  const weeklyDefaults = {
    w_read25: 11, w_finish1: 0, w_watch3hr: 47, w_comment10: 2, w_streak7: 7,
  };
  const monthlyDefaults = {
    m_read100: 38, m_finish3: 1, m_streak30: 7, m_engage: 24,
  };
  const apply = (list, defaults) => {
    for (const q of list) {
      if (q.id in defaults) q.progress = defaults[q.id];
      q.claimed = false;
    }
  };
  apply(_dailyQuestsState.daily, dailyDefaults);
  apply(_dailyQuestsState.weekly, weeklyDefaults);
  apply(_dailyQuestsState.monthly, monthlyDefaults);
  renderDailyQuests();
  _renderQuestsCountdown();
}

// Boot — load any persisted state then paint the streak badge.
_loadDailyQuestsFromStorage();
renderDailyQuests();

document.getElementById('btnDailyQuests')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleDailyQuestsPanel();
});
document.getElementById('questsResetDemo')?.addEventListener('click', (e) => {
  e.stopPropagation();
  _resetDailyQuestsDemo();
});
// Tab-bar clicks switch which quest list is rendered.
document.querySelectorAll('.quests-tab').forEach(tab => {
  tab.addEventListener('click', (e) => {
    e.stopPropagation();
    _dailyQuestsState.activeTab = tab.dataset.questsTab || 'daily';
    _saveDailyQuestsToStorage();
    renderDailyQuests();
  });
});
// Click outside → close
document.addEventListener('click', (e) => {
  if (!_dailyQuestsPanelOpen) return;
  if (e.target.closest('#dailyQuestsPanel') || e.target.closest('#btnDailyQuests')) return;
  const panel = document.getElementById('dailyQuestsPanel');
  if (panel) panel.style.display = 'none';
  _dailyQuestsPanelOpen = false;
});

// ════════════════════════════════════════
// @MENTION AUTOCOMPLETE
// Type @ in any .comment-input → dropdown with matching usernames.
// Arrow keys navigate, Enter/Tab inserts, Esc closes.
// ════════════════════════════════════════
let _mentionDropdown = null;
let _mentionTextarea = null;
let _mentionResults  = [];
let _mentionIdx      = 0;
let _mentionDebounce = null;

function getMentionDropdown() {
  if (_mentionDropdown) return _mentionDropdown;
  const el = document.createElement('div');
  el.className = 'mention-dropdown';
  el.style.display = 'none';
  document.body.appendChild(el);
  _mentionDropdown = el;
  return el;
}

function closeMentionDropdown() {
  if (_mentionDropdown) _mentionDropdown.style.display = 'none';
  _mentionTextarea = null;
  _mentionResults = [];
  _mentionIdx = 0;
}

function positionMentionDropdown(textarea) {
  const dd = getMentionDropdown();
  const rect = textarea.getBoundingClientRect();
  dd.style.position = 'fixed';
  // Place below the textarea by default; flip above if it would clip the viewport
  const wantTop = rect.bottom + 6;
  const ddH = dd.offsetHeight || 220;
  const flipAbove = wantTop + ddH > window.innerHeight - 12;
  dd.style.top  = `${flipAbove ? Math.max(8, rect.top - ddH - 6) : wantTop}px`;
  dd.style.left = `${Math.max(8, rect.left)}px`;
  dd.style.minWidth = `${Math.min(260, Math.max(220, rect.width * 0.7))}px`;
}

async function maybeShowMentionDropdown(textarea) {
  if (!textarea) return;
  const cursor = textarea.selectionStart ?? textarea.value.length;
  const before = textarea.value.slice(0, cursor);
  // Match @<word> at end of `before`. Allow underscores and digits.
  const match = before.match(/(?:^|\s)@([A-Za-z0-9_]{0,24})$/);
  if (!match) {
    closeMentionDropdown();
    return;
  }
  _mentionTextarea = textarea;
  const query = match[1] || '';
  _mentionIdx = 0;

  // Debounced profile search
  clearTimeout(_mentionDebounce);
  _mentionDebounce = setTimeout(async () => {
    let q = supabase.from('profiles').select('id, username, avatar_url').limit(6);
    if (query) q = q.ilike('username', `${query}%`);
    else q = q.order('username', { ascending: true }).limit(6);
    const { data } = await q;
    _mentionResults = (data || []).filter(p => p.id !== currentUser?.id);
    renderMentionDropdown();
  }, 120);
}

function renderMentionDropdown() {
  const dd = getMentionDropdown();
  if (!_mentionResults.length || !_mentionTextarea) {
    dd.style.display = 'none';
    return;
  }
  dd.innerHTML = _mentionResults.map((p, i) => `
    <div class="mention-item ${i === _mentionIdx ? 'active' : ''}" data-idx="${i}">
      <div class="mention-avatar">${p.avatar_url ? `<img src="${escHTML(p.avatar_url)}"/>` : escHTML((p.username || '?').slice(0,2).toUpperCase())}</div>
      <div class="mention-name"><strong>@${escHTML(p.username || '')}</strong></div>
    </div>
  `).join('');
  dd.querySelectorAll('.mention-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();    // keep textarea focus
      e.stopPropagation();
      selectMention(parseInt(item.dataset.idx, 10));
    });
  });
  dd.style.display = 'block';
  positionMentionDropdown(_mentionTextarea);
}

function selectMention(index) {
  const profile = _mentionResults[index];
  const textarea = _mentionTextarea;
  if (!profile || !textarea) return;
  const cursor = textarea.selectionStart ?? textarea.value.length;
  const before = textarea.value.slice(0, cursor);
  const after  = textarea.value.slice(cursor);
  // Replace the @<typed> at end of `before` with @username + space
  const newBefore = before.replace(/(^|\s)@([A-Za-z0-9_]{0,24})$/, `$1@${profile.username} `);
  textarea.value = newBefore + after;
  const newCursor = newBefore.length;
  textarea.setSelectionRange(newCursor, newCursor);
  // Bubble an input event so any auto-resize textareas re-measure
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  closeMentionDropdown();
}

// Document-level event delegation — works for dynamically created comment textareas
document.addEventListener('input', (e) => {
  const ta = e.target;
  if (!ta || ta.tagName !== 'TEXTAREA') return;
  if (!ta.classList.contains('comment-input')) return;
  maybeShowMentionDropdown(ta);
});

document.addEventListener('keydown', (e) => {
  if (!_mentionTextarea || !_mentionResults.length) return;
  if (_mentionDropdown?.style.display !== 'block') return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _mentionIdx = (_mentionIdx + 1) % _mentionResults.length;
    renderMentionDropdown();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _mentionIdx = (_mentionIdx - 1 + _mentionResults.length) % _mentionResults.length;
    renderMentionDropdown();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    selectMention(_mentionIdx);
  } else if (e.key === 'Escape') {
    closeMentionDropdown();
  }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('.mention-dropdown')) return;
  if (e.target.closest('.comment-input')) return;
  closeMentionDropdown();
});
window.addEventListener('scroll', closeMentionDropdown, true);
window.addEventListener('resize', closeMentionDropdown);

// Render @mentions inside posted comment bodies as clickable links.
// Hooks into the existing linkify pipeline by post-processing its output.
const _origLinkify = typeof linkify === 'function' ? linkify : null;
if (_origLinkify) {
  // Re-define linkify globally (the original was a const-declared function;
  // we override behavior via the same name through the module scope).
  // eslint-disable-next-line no-func-assign
  linkify = function patchedLinkify(str) {
    const html = _origLinkify(str || '');
    return html.replace(/(^|[\s>])@([A-Za-z0-9_]{1,24})\b/g,
      (_, lead, name) => `${lead}<span class="mention-token" data-mention="${escHTML(name)}">@${escHTML(name)}</span>`);
  };
}
// Clicking a rendered @mention → navigate to that user's profile
document.addEventListener('click', async (e) => {
  const tok = e.target.closest('.mention-token');
  if (!tok) return;
  e.stopPropagation();
  const username = tok.dataset.mention;
  if (!username) return;
  const { data } = await supabase.from('profiles').select('id').ilike('username', username).maybeSingle();
  if (data?.id) openProfile(data.id);
  else toast(`User @${username} not found`, 'error');
});

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

// ── Reactor list modal ────────────────────────────────────────────────────
async function openReactorListModal(targetId, targetType = 'post') {
  closeAllModals('.modal-backdrop[data-modal="reactor-list"]');

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'reactor-list';
  modal.innerHTML = `
    <div class="modal-card follow-list-modal" role="dialog" aria-labelledby="reactor-list-title">
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

  // Build emoji tabs (All, then per-emoji with counts)
  const counts = {};
  rxs.forEach(r => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
  const sortedEmojis = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const tabsEl = modal.querySelector('#reactorTabs');
  tabsEl.innerHTML = `
    <button class="reactor-tab active" data-emoji-filter="">All ${rxs.length}</button>
    ${sortedEmojis.map(([emoji, c]) =>
      `<button class="reactor-tab" data-emoji-filter="${escHTML(emoji)}">${emoji} ${c}</button>`
    ).join('')}
  `;

  function renderRows(filterEmoji) {
    const rows = filterEmoji ? rxs.filter(r => r.emoji === filterEmoji) : rxs;
    body.innerHTML = rows.map(r => {
      const p = profileMap.get(r.user_id) || { id: r.user_id, username: 'Unknown', avatar_url: null };
      const safeName = escHTML(p.username || '');
      const safeAvatar = p.avatar_url ? escHTML(p.avatar_url) : '';
      return `
        <div class="follow-list-row">
          <button class="follow-list-avatar" data-uid="${p.id}">
            ${safeAvatar ? `<img src="${safeAvatar}"/>` : initials(p.username)}
          </button>
          <div class="follow-list-info">
            <button class="follow-list-name" data-uid="${p.id}">@${safeName}</button>
          </div>
          <span class="reactor-emoji">${escHTML(r.emoji)}</span>
        </div>
      `;
    }).join('');
    body.querySelectorAll('[data-uid]').forEach(el => {
      el.onclick = () => { close(); openProfile(el.dataset.uid); };
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

// ════════════════════════════════════════════════════════════════════════════
// DIRECT MESSAGES — Phase 1 (FB Messenger-style with purple)
// Two-pane layout: conversation list on left, active thread on right.
// Realtime via Supabase channel on `messages` table.
// ════════════════════════════════════════════════════════════════════════════

let dmState = {
  conversations: [],            // [{ id, isGroup, isSecret, archived, name, otherUser?, members?, lastMessageAt, lastMessagePreview, unread }]
  activeConvId: null,           // currently-open conversation id
  activeConv: null,             // full active conversation object (incl. is_group, name, members)
  activeOther: null,            // for 1:1: the other user; for groups: null
  messages: [],                 // current thread's messages
  reactions: {},                // { messageId: [{ user_id, emoji }, ...] }
  realtimeChannel: null,        // active Realtime subscription (DB changes for active thread)
  presenceChannel: null,        // presence + typing broadcast for active thread
  totalUnread: 0,
  inboxChannel: null,           // realtime subscription for unread badge
  otherIsTyping: false,         // is the other user currently typing?
  typingUsers: {},              // groups: { userId: { name, lastSeen } } for "X is typing"
  otherTypingTimer: null,       // auto-clear typing if no broadcast for N seconds
  myTypingTimer: null,          // debounce my own typing broadcasts
  otherIsOnline: false,
  otherLastSeen: null,
  hoverMenuEl: null,            // currently-open bubble hover menu
  reactionPickerEl: null,       // currently-open reaction picker
  convMenuEl: null,             // thread header ⋯ menu
  editingMessageId: null,       // bubble being inline-edited
  replyingTo: null,             // { id, body, sender_id, sender_name } when composing a reply
  globalSearchResults: null,    // { conversations: [], messages: [] } when global search is active
  viewMode: 'active',           // 'active' | 'archived' | 'secret' — which tab pill is selected
};

// ─────────────────────────────────────────────────────────────────────────
// Secret-tab lock — web parity for the mobile lib/secret-lock.js module.
//
// PIN persists across browser restarts in localStorage (hashed + salted).
// "Unlocked for this session" is held in sessionStorage so closing the
// tab forgets the unlock — a closed tab in a coffee-shop browser stays
// locked until re-authenticated. Visibility change (tab background)
// triggers a re-lock after RELOCK_AFTER_BG_MS for an extra layer.
//
// Threat model: same as mobile — the PIN raises friction for a casual
// snooper. Anyone with full access to the user's browser data can still
// recover the salt + hash. For real privacy we'd put the hash on a
// server profile column with per-device unlock; deferred.
// ─────────────────────────────────────────────────────────────────────────

const SECRET_LOCK = (() => {
  const KEY_HASH = 'selebox.secretLock.pinHash.v1';
  const KEY_SALT = 'selebox.secretLock.pinSalt.v1';
  const SESSION_UNLOCKED = 'selebox.secretLock.unlocked';
  const RELOCK_AFTER_BG_MS = 60 * 1000;

  let backgroundedAt = null;

  // djb2 with salt — fast non-crypto digest. Detail in mobile module's
  // header comment.
  const djb2 = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    return (h >>> 0).toString(36);
  };
  const genSalt = () => {
    let s = '';
    for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 36).toString(36);
    return s;
  };
  const hashPin = (pin, salt) => djb2(`${salt}:${pin}:${salt}`);

  return {
    hasPin: () => !!localStorage.getItem(KEY_HASH),
    setPin: (pin) => {
      if (!pin || String(pin).length < 4) throw new Error('PIN must be at least 4 digits');
      const salt = genSalt();
      localStorage.setItem(KEY_SALT, salt);
      localStorage.setItem(KEY_HASH, hashPin(String(pin), salt));
      sessionStorage.setItem(SESSION_UNLOCKED, '1');
      backgroundedAt = null;
    },
    verifyPin: (pin) => {
      const hash = localStorage.getItem(KEY_HASH);
      const salt = localStorage.getItem(KEY_SALT);
      if (!hash || !salt) return false;
      return hashPin(String(pin), salt) === hash;
    },
    unlock: () => {
      sessionStorage.setItem(SESSION_UNLOCKED, '1');
      backgroundedAt = null;
    },
    lock: () => {
      sessionStorage.removeItem(SESSION_UNLOCKED);
      backgroundedAt = null;
    },
    isUnlocked: () => sessionStorage.getItem(SESSION_UNLOCKED) === '1',
    onVisibilityChange: () => {
      if (document.hidden) {
        backgroundedAt = Date.now();
      } else if (backgroundedAt && Date.now() - backgroundedAt > RELOCK_AFTER_BG_MS) {
        sessionStorage.removeItem(SESSION_UNLOCKED);
        backgroundedAt = null;
        // Re-render the conversations list so the lock gate appears if
        // the user is on the Secret tab.
        if (typeof renderConversationList === 'function') renderConversationList();
      }
    },
    clearPin: () => {
      localStorage.removeItem(KEY_HASH);
      localStorage.removeItem(KEY_SALT);
      sessionStorage.removeItem(SESSION_UNLOCKED);
      backgroundedAt = null;
    },
  };
})();

const secretLockIsUnlocked = () => SECRET_LOCK.isUnlocked();

// Wire visibility changes once at module load — covers tab switch,
// minimize, lock screen on macOS, etc.
document.addEventListener('visibilitychange', () => SECRET_LOCK.onVisibilityChange());

// Wire the Secret-tab UI handlers — empty-state CTA, lock gate inputs,
// PIN flow. Called from renderConversationList after the HTML is set.
function wireSecretTabHandlers(wrap) {
  // Empty-state CTA: "Start a Secret chat"
  const startBtn = wrap.querySelector('#dmStartSecretBtn');
  if (startBtn) startBtn.onclick = () => openSecretChatPicker();

  // Lock gate
  const gate = wrap.querySelector('.dm-secret-gate');
  if (!gate) return;
  const input = gate.querySelector('.dm-secret-input');
  const submit = gate.querySelector('.dm-secret-submit');
  const errorEl = gate.querySelector('.dm-secret-error');
  let pendingPin = null; // first half of the create flow

  const phase = SECRET_LOCK.hasPin() ? 'verify' : 'createNew';
  let currentPhase = phase;

  const reflect = (txt) => {
    if (errorEl) errorEl.textContent = txt || '';
  };

  const onSubmit = () => {
    const pin = (input?.value || '').replace(/[^0-9]/g, '').slice(0, 6);
    if (pin.length < 4) { reflect('Use at least 4 digits.'); return; }
    if (currentPhase === 'createNew') {
      pendingPin = pin;
      input.value = '';
      reflect('');
      currentPhase = 'createConfirm';
      const titleEl = gate.querySelector('.dm-secret-title');
      const subtitleEl = gate.querySelector('.dm-secret-subtitle');
      if (titleEl) titleEl.textContent = 'Confirm your PIN';
      if (subtitleEl) subtitleEl.textContent = 'Enter the same digits once more.';
      input.focus();
      return;
    }
    if (currentPhase === 'createConfirm') {
      if (pin !== pendingPin) {
        reflect("PINs don't match. Try again.");
        pendingPin = null;
        currentPhase = 'createNew';
        input.value = '';
        return;
      }
      try {
        SECRET_LOCK.setPin(pin);
        renderConversationList();
      } catch (e) {
        reflect(e?.message || 'Could not set PIN.');
      }
      return;
    }
    if (SECRET_LOCK.verifyPin(pin)) {
      SECRET_LOCK.unlock();
      renderConversationList();
    } else {
      reflect('Wrong PIN.');
      input.value = '';
    }
  };

  if (submit) submit.onclick = onSubmit;
  if (input) {
    input.oninput = () => {
      input.value = input.value.replace(/[^0-9]/g, '').slice(0, 6);
      reflect('');
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') onSubmit(); };
    setTimeout(() => input.focus(), 0);
  }
}

// HTML for the PIN gate. Three phases: createNew, createConfirm, verify.
// Phase logic lives in wireSecretTabHandlers; this just paints the
// initial state based on whether a PIN exists.
function renderSecretLockGateHtml() {
  const has = SECRET_LOCK.hasPin();
  const title = has ? 'Enter your Secret PIN' : 'Set a Secret PIN';
  const subtitle = has
    ? 'Enter your PIN to view Secret chats.'
    : 'This PIN locks your Secret tab. Pick at least 4 digits.';
  const buttonLabel = has ? 'Unlock' : 'Continue';
  return `
    <div class="dm-secret-gate">
      <div class="dm-secret-gate-icon">🔒</div>
      <div class="dm-secret-title">${title}</div>
      <div class="dm-secret-subtitle">${subtitle}</div>
      <input class="dm-secret-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="••••" />
      <div class="dm-secret-error"></div>
      <button class="dm-secret-submit" type="button">${buttonLabel}</button>
    </div>
  `;
}

// Quick-reaction emojis (FB-style — these match the existing post REACTIONS set)
const DM_QUICK_REACTIONS = ['❤️','😂','😮','😢','😡','👍'];

// IDs of messages already painted to the DOM. Used in renderMessages to skip
// the entrance animation on bubbles that already existed — prevents the whole
// list from flashing every time we re-render (sends, reactions, read receipts).
const _renderedMessageIds = new Set();

async function showMessages(targetUserId = null) {
  if (!currentUser) { toast('Please sign in', 'error'); return; }
  hideAllMainPages();
  if (messagesPage) messagesPage.style.display = 'block';
  document.body.classList.remove('on-videos');
  history.pushState(null, '', '#messages');
  setSidebarActive('btnMessages');

  // DMs have a realtime subscription that keeps the list fresh — so on a
  // quick tab-flick the list is already up to date. Only re-fetch on first
  // load, when forced (targetUserId), or after 30 seconds.
  const dmList = document.getElementById('dmList') || messagesPage?.querySelector('.dm-list');
  const alreadyRendered = dmList && dmList.children.length > 0 && !dmList.querySelector('.loading');
  const now = Date.now();
  const stale = !window._dmListLoadedAt || (now - window._dmListLoadedAt) > 30_000;
  if (!alreadyRendered || stale || targetUserId) {
    await loadConversationList();
    window._dmListLoadedAt = now;
  }

  if (targetUserId) {
    // Open or create conversation with this user
    await openConversationWithUser(targetUserId);
  }
}

// ── Conversation list ─────────────────────────────────────────────────────
const DM_EMPTY_HTML = `
  <div class="dm-empty-list" id="dmEmptyList">
    <div class="dm-empty-icon">💬</div>
    <h3>No conversations yet</h3>
    <p>Start one from anyone's profile.</p>
  </div>
`;

async function loadConversationList() {
  const wrap = document.getElementById('dmConvList');
  if (!wrap || !currentUser) return;

  // Skeleton while loading
  if (!dmState.conversations.length) {
    wrap.innerHTML = `
      <div class="dm-conv-skel"></div>
      <div class="dm-conv-skel"></div>
      <div class="dm-conv-skel"></div>
    `;
  }

  // Fetch the conversation ids the viewer can see. Two parallel sources,
  // unioned client-side:
  //   (1) conversation_participants — covers groups + most 1:1s.
  //   (2) conversations.user_a / user_b — covers 1:1s where the participants
  //       row was never written. Secret 1:1 conversations created via the
  //       getOrCreateSecretConversation flow only insert into `conversations`
  //       and don't always seed `conversation_participants` (depends on the
  //       trigger pipeline). Without (2), Secret chats are invisible to web
  //       even though they're correctly stored.
  // Mobile already does this via direct user_a / user_b query in
  // lib/messages-supabase.js → loadConversations; this matches that
  // behavior for cross-platform parity.
  const [partsRes, oneOnOneRes] = await Promise.all([
    supabase
      .from('conversation_participants')
      .select('conversation_id')
      .eq('user_id', currentUser.id),
    supabase
      .from('conversations')
      .select('id')
      .eq('is_group', false)
      .or(`user_a.eq.${currentUser.id},user_b.eq.${currentUser.id}`),
  ]);
  if (partsRes.error) {
    wrap.innerHTML = `<div class="dm-error">Couldn't load chats: ${escHTML(partsRes.error.message)}</div>`;
    return;
  }
  if (oneOnOneRes.error) {
    // Non-fatal — fall back to participants-only. Logged so we notice if
    // it starts failing universally.
    console.warn('[dm] 1:1 fetch failed, falling back to participants-only:', oneOnOneRes.error?.message);
  }
  const idSet = new Set();
  for (const p of partsRes.data || []) if (p.conversation_id) idSet.add(p.conversation_id);
  for (const c of oneOnOneRes.data || []) if (c.id) idSet.add(c.id);
  const convIds = [...idSet];
  if (!convIds.length) {
    wrap.innerHTML = DM_EMPTY_HTML;
    dmState.conversations = [];
    updateUnreadBadge(0);
    return;
  }

  const { data: convs, error } = await supabase
    .from('conversations')
    .select('id, user_a, user_b, is_group, is_secret, name, avatar_url, created_by, last_message_at, last_message_preview, last_message_sender, created_at, archived_by_a, archived_by_b, muted_until_a, muted_until_b')
    .in('id', convIds)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(100);

  if (error) {
    wrap.innerHTML = `<div class="dm-error">Couldn't load chats: ${escHTML(error.message)}</div>`;
    return;
  }

  if (!convs || !convs.length) {
    wrap.innerHTML = DM_EMPTY_HTML;
    dmState.conversations = [];
    updateUnreadBadge(0);
    return;
  }

  // We no longer filter at fetch time. The 3-tab pill (Active / Archived /
  // Secret) lives in renderConversationList and decides which bucket
  // each conversation belongs to. This means the user can switch tabs
  // without re-fetching from the network.
  const visibleConvs = convs;

  // Pull all participants for groups so we can render stacked avatars
  const groupConvIds = visibleConvs.filter(c => c.is_group).map(c => c.id);
  const groupMembersByConv = {};
  if (groupConvIds.length) {
    const { data: members } = await supabase
      .from('conversation_participants')
      .select('conversation_id, user_id')
      .in('conversation_id', groupConvIds);
    (members || []).forEach(m => {
      if (!groupMembersByConv[m.conversation_id]) groupMembersByConv[m.conversation_id] = [];
      groupMembersByConv[m.conversation_id].push(m.user_id);
    });
  }

  // Hydrate ALL profiles needed (1:1 partners + group members)
  const allProfileIds = new Set();
  visibleConvs.forEach(c => {
    if (!c.is_group) {
      const otherId = c.user_a === currentUser.id ? c.user_b : c.user_a;
      if (otherId) allProfileIds.add(otherId);
    } else {
      (groupMembersByConv[c.id] || []).forEach(id => allProfileIds.add(id));
    }
  });
  const [{ data: profiles }, unreadByConv] = await Promise.all([
    allProfileIds.size
      ? supabase.from('profiles').select('id, username, avatar_url, is_guest').in('id', [...allProfileIds])
      : Promise.resolve({ data: [] }),
    fetchUnreadCounts(visibleConvs.map(c => c.id)),
  ]);

  const profileMap = new Map((profiles || []).map(p => [p.id, p]));
  // totalUnread excludes:
  //   - Archived (per-side flag)
  //   - Muted
  //   - Secret (stealth design — never count toward the global badge)
  let totalUnread = 0;
  dmState.conversations = visibleConvs.map(c => {
    const unread = unreadByConv[c.id] || 0;
    const isMutedNow = isConvMutedForMe(c);
    const archivedByMe = c.is_group
      ? false  // groups don't expose per-side archive yet
      : ((c.user_a === currentUser.id && c.archived_by_a) ||
         (c.user_b === currentUser.id && c.archived_by_b));
    const isSecret = !!c.is_secret;
    if (!isMutedNow && !archivedByMe && !isSecret) totalUnread += unread;

    if (c.is_group) {
      const memberIds = (groupMembersByConv[c.id] || []).filter(id => id !== currentUser.id);
      const members = memberIds.map(id => profileMap.get(id)).filter(Boolean);
      const allMembers = (groupMembersByConv[c.id] || []).map(id => profileMap.get(id) || { id, username: 'Unknown' });
      // Auto-name: "Alice, Bob, Carol" from up to 3 other members
      const autoName = c.name || members.slice(0, 3).map(m => m.username).join(', ') || 'Group chat';
      return {
        id: c.id,
        isGroup: true,
        isSecret,
        archived: archivedByMe,
        createdBy: c.created_by,
        name: autoName,
        members: allMembers,
        memberCount: allMembers.length,
        avatarUrl: c.avatar_url,
        lastMessageAt: c.last_message_at,
        lastMessagePreview: c.last_message_preview || '',
        lastMessageSender: c.last_message_sender,
        unread,
        muted: isMutedNow,
        raw: c,
      };
    }
    const otherId = c.user_a === currentUser.id ? c.user_b : c.user_a;
    return {
      id: c.id,
      isGroup: false,
      isSecret,
      archived: archivedByMe,
      createdBy: c.created_by,
      otherUser: profileMap.get(otherId) || { id: otherId, username: 'Unknown', avatar_url: null },
      lastMessageAt: c.last_message_at,
      lastMessagePreview: c.last_message_preview || '',
      lastMessageSender: c.last_message_sender,
      unread,
      muted: isMutedNow,
      raw: c,
    };
  });

  renderConversationList();
  updateUnreadBadge(totalUnread);
}

// Returns true if the conversation is currently muted for the current user
function isConvMutedForMe(c) {
  if (!c) return false;
  const my = currentUser?.id;
  let until;
  if (c.is_group) return false; // group mute TBD
  if (c.user_a === my)      until = c.muted_until_a;
  else if (c.user_b === my) until = c.muted_until_b;
  if (!until) return false;
  return new Date(until).getTime() > Date.now();
}

async function fetchUnreadCounts(conversationIds) {
  if (!conversationIds.length) return {};
  // Pull only unread messages where I'm NOT the sender, group client-side
  const { data } = await supabase
    .from('messages')
    .select('conversation_id, sender_id')
    .in('conversation_id', conversationIds)
    .is('read_at', null)
    .is('deleted_at', null)
    .neq('sender_id', currentUser.id);
  const counts = {};
  (data || []).forEach(m => {
    counts[m.conversation_id] = (counts[m.conversation_id] || 0) + 1;
  });
  return counts;
}

function renderConversationList() {
  const wrap = document.getElementById('dmConvList');
  if (!wrap) return;

  // ── Bucket conversations into Active / Archived / Secret ─────────────
  // Secret wins over Archived — a Secret conversation that's somehow
  // archived still shows under Secret only, never leaks back to
  // Archived. This matches the mobile invariant.
  const buckets = { active: [], archived: [], secret: [] };
  for (const c of dmState.conversations) {
    if (c.isSecret) buckets.secret.push(c);
    else if (c.archived) buckets.archived.push(c);
    else buckets.active.push(c);
  }

  const mode = dmState.viewMode || 'active';
  const visible = buckets[mode] || [];

  // ── 3-tab pill ───────────────────────────────────────────────────────
  // Always show Active. Show Archived only when there's at least one
  // archived chat OR the user is currently viewing it. Always show
  // Secret so the lock affordance is discoverable.
  const showArchivedTab = buckets.archived.length > 0 || mode === 'archived';
  const pillHtml = `
    <div class="dm-tab-pill">
      <button class="dm-tab ${mode === 'active' ? 'is-active' : ''}" data-tab="active" type="button">
        Active${mode !== 'active' ? ` (${buckets.active.length})` : ''}
      </button>
      ${showArchivedTab ? `
        <button class="dm-tab ${mode === 'archived' ? 'is-active' : ''}" data-tab="archived" type="button">
          Archived (${buckets.archived.length})
        </button>` : ''}
      <button class="dm-tab ${mode === 'secret' ? 'is-active' : ''}" data-tab="secret" type="button">
        Secret
      </button>
    </div>
  `;

  // ── Body ─────────────────────────────────────────────────────────────
  // Secret tab is gated by the lock module; if not unlocked, render the
  // PIN gate instead of the list.
  let bodyHtml;
  if (mode === 'secret' && !secretLockIsUnlocked()) {
    bodyHtml = renderSecretLockGateHtml();
  } else if (visible.length === 0) {
    bodyHtml = renderConvEmptyStateHtml(mode);
  } else {
    bodyHtml = visible.map(c => renderConvItemHtml(c)).join('');
  }

  wrap.innerHTML = pillHtml + bodyHtml;

  // Wire pill clicks
  wrap.querySelectorAll('.dm-tab').forEach(el => {
    el.onclick = () => {
      dmState.viewMode = el.dataset.tab;
      renderConversationList();
    };
  });

  // Wire conversation row clicks (only when not on the locked Secret gate)
  wrap.querySelectorAll('.dm-conv-item').forEach(el => {
    el.onclick = () => openConversation(el.dataset.convId);
  });

  // Wire Secret-tab CTA + lock-gate handlers (when present)
  wireSecretTabHandlers(wrap);
}

// Empty-state HTML per tab. Secret gets a CTA inviting the user to
// start one — others get the existing "no chats" copy.
function renderConvEmptyStateHtml(mode) {
  if (mode === 'secret') {
    return `
      <div class="dm-empty-list">
        <div class="dm-empty-icon">🔒</div>
        <div class="dm-empty-title">No Secret chats yet</div>
        <div class="dm-empty-sub">
          Secret chats are silent — no notifications, hidden from the unread badge,
          and only available with mutual followers.
        </div>
        <button class="dm-cta-btn" id="dmStartSecretBtn" type="button">🔒 Start a Secret chat</button>
      </div>
    `;
  }
  if (mode === 'archived') {
    return `
      <div class="dm-empty-list">
        <div class="dm-empty-icon">📥</div>
        <div class="dm-empty-title">No archived chats.</div>
      </div>
    `;
  }
  return DM_EMPTY_HTML;
}

function renderConvItemHtml(c) {
  let safeName, avatarHtml;
  if (c.isGroup) {
    safeName = escHTML(c.name || 'Group chat');
    // If the creator has set an explicit group photo (avatar_url), prefer
    // it. Falls back to the stacked-member avatars when no photo set.
    // Without this branch, the group-photo edit feature was invisible
    // anywhere outside the group settings modal — same root cause as
    // the mobile bug we just fixed.
    avatarHtml = c.avatarUrl
      ? `<div class="dm-conv-avatar"><img src="${escHTML(c.avatarUrl)}" alt=""/></div>`
      : renderGroupAvatarHtml(c.members, 'list');
  } else {
    const u = c.otherUser;
    safeName = escHTML(u.username || 'Unknown');
    avatarHtml = `<div class="dm-conv-avatar">${u.avatar_url
      ? `<img src="${escHTML(u.avatar_url)}" alt=""/>`
      : `<span class="dm-avatar-initials">${initials(u.username)}</span>`}</div>`;
  }
  // Secret rows get a small lock badge on the avatar so it's clear
  // at a glance which conversations are stealth.
  //
  // We need to add the dm-conv-avatar-secret class to whatever the
  // outer wrapper turned out to be — but the wrapper varies by branch:
  //   1:1 with photo:        class="dm-conv-avatar"
  //   1:1 initials:          class="dm-conv-avatar"
  //   group with photo:      class="dm-conv-avatar"
  //   group stacked avatars: class="dm-conv-avatar dm-group-avatar"
  //   group empty (no others): class="dm-conv-avatar"
  // A literal-string replace covered three of those but missed the
  // stacked-group case (no badge for Secret groups). Use a regex that
  // appends the modifier class regardless of what other classes are
  // already on the wrapper.
  if (c.isSecret) {
    avatarHtml = avatarHtml.replace(/class="dm-conv-avatar([^"]*)"/, 'class="dm-conv-avatar$1 dm-conv-avatar-secret"');
  }
  const isMine = c.lastMessageSender === currentUser.id;
  const senderPrefix = c.isGroup && c.lastMessageSender && !isMine
    ? (escHTML(senderUsernameInGroup(c, c.lastMessageSender) || 'Someone') + ': ')
    : (isMine ? 'You: ' : '');
  // If preview body is whitespace-only (image-only message), show generic label
  const previewText = (c.lastMessagePreview || '').trim();
  const preview = c.lastMessagePreview && previewText
    ? senderPrefix + escHTML(c.lastMessagePreview)
    : (c.lastMessageAt ? senderPrefix + '<em>📷 Sent an attachment</em>' : '<em>No messages yet</em>');
  const time = c.lastMessageAt ? timeAgo(c.lastMessageAt) : '';
  const isActive = c.id === dmState.activeConvId;
  const unreadCls = c.unread > 0 ? ' has-unread' : '';
  const mutedIcon = c.muted ? '<span class="dm-conv-muted" title="Muted">🔕</span>' : '';
  return `
    <button class="dm-conv-item${isActive ? ' active' : ''}${unreadCls}" data-conv-id="${c.id}">
      ${avatarHtml}
      <div class="dm-conv-meta">
        <div class="dm-conv-row">
          <span class="dm-conv-name">${safeName}${mutedIcon}</span>
          <span class="dm-conv-time">${time}</span>
        </div>
        <div class="dm-conv-preview">${preview}</div>
      </div>
      ${c.unread > 0 && !c.muted ? `<span class="dm-conv-unread">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
    </button>
  `;
}

function senderUsernameInGroup(conv, senderId) {
  if (!conv?.members) return null;
  const m = conv.members.find(p => p.id === senderId);
  return m?.username || null;
}

// Stacked avatars for group conversations (list = small, header = large)
function renderGroupAvatarHtml(members, variant = 'list') {
  const others = (members || []).filter(m => m.id !== currentUser.id).slice(0, 2);
  if (!others.length) {
    return `<div class="dm-conv-avatar">👥</div>`;
  }
  const cls = variant === 'list' ? 'dm-conv-avatar dm-group-avatar' : 'dm-thread-avatar dm-group-avatar';
  const tiles = others.map((m, i) => {
    const safeAvatar = m.avatar_url ? escHTML(m.avatar_url) : '';
    return `<span class="dm-group-tile dm-group-tile-${i}">${safeAvatar
      ? `<img src="${safeAvatar}" alt=""/>`
      : initials(m.username)}</span>`;
  }).join('');
  return `<div class="${cls}">${tiles}</div>`;
}

// ── Open a thread ─────────────────────────────────────────────────────────
async function openConversationWithUser(otherUserId) {
  // Resolve / create the conversation, then open it
  const { data: convId, error } = await supabase
    .rpc('get_or_create_conversation', { p_other_user_id: otherUserId });

  if (error) {
    if (/blocked/i.test(error.message)) toast('Cannot message blocked user', 'error');
    else toast(error.message, 'error');
    return;
  }
  await loadConversationList();
  await openConversation(convId);
}

async function openConversation(convId) {
  if (!convId || !currentUser) return;
  dmState.activeConvId = convId;
  dmState.replyingTo = null;
  hideReplyPreview();

  // Find conversation in cache (or refetch — also re-hydrate participants)
  let conv = dmState.conversations.find(c => c.id === convId);
  if (!conv) {
    // Fetch conversation + participants in parallel (saves one round-trip).
    // For 1:1 we still know the partner from user_a/user_b, but we kick off
    // the participants query speculatively so groups don't pay an extra hop.
    const [{ data, error: fetchErr }, { data: parts }] = await Promise.all([
      supabase.from('conversations')
        .select('id, user_a, user_b, is_group, is_secret, name, avatar_url, created_by, last_message_at, last_message_preview, last_message_sender, archived_by_a, archived_by_b, muted_until_a, muted_until_b, created_at')
        .eq('id', convId)
        .single(),
      supabase.from('conversation_participants').select('user_id').eq('conversation_id', convId),
    ]);
    if (fetchErr || !data) { toast('Conversation not found', 'error'); console.warn('[dm] conv fetch failed', fetchErr); return; }
    if (data.is_group) {
      const memberIds = (parts || []).map(p => p.user_id);
      const { data: profs } = memberIds.length
        ? await supabase.from('profiles').select('id, username, avatar_url, is_guest').in('id', memberIds)
        : { data: [] };
      const members = (profs || []);
      conv = {
        id: data.id, isGroup: true, isSecret: !!data.is_secret, createdBy: data.created_by,
        name: data.name || members.filter(m => m.id !== currentUser.id).slice(0,3).map(m => m.username).join(', '),
        members, memberCount: members.length, avatarUrl: data.avatar_url,
        lastMessageAt: data.last_message_at, lastMessagePreview: data.last_message_preview || '',
        unread: 0, muted: false, raw: data,
      };
    } else {
      const otherId = data.user_a === currentUser.id ? data.user_b : data.user_a;
      const { data: prof } = await supabase.from('profiles').select('id, username, avatar_url, is_guest').eq('id', otherId).single();
      conv = {
        id: data.id, isGroup: false, isSecret: !!data.is_secret, createdBy: data.created_by,
        otherUser: prof || { id: otherId, username: 'Unknown', avatar_url: null },
        lastMessageAt: data.last_message_at,
        lastMessagePreview: data.last_message_preview || '',
        unread: 0, muted: isConvMutedForMe(data), raw: data,
      };
    }
  }
  // Carry the raw flags onto the activeConv for any downstream code that
  // checks them by snake_case (the send-time mutuals gate, etc.).
  if (conv && conv.raw) {
    conv.is_secret = !!conv.raw.is_secret;
    conv.is_group = !!conv.raw.is_group;
    conv.user_a = conv.raw.user_a;
    conv.user_b = conv.raw.user_b;
  }
  dmState.activeConv = conv;
  dmState.activeOther = conv.isGroup ? null : conv.otherUser;

  // Show active panel, hide empty placeholder
  document.getElementById('dmThreadEmpty').style.display = 'none';
  document.getElementById('dmThreadActive').style.display = 'flex';

  // Header — different rendering for groups vs 1:1
  const av = document.getElementById('dmThreadAvatar');
  const nameBtn = document.getElementById('dmThreadName');
  const statusEl = document.getElementById('dmThreadStatus');
  if (conv.isGroup) {
    // Prefer the explicitly-set group photo (creator-uploaded). Falls
    // back to the stacked-member rendering when no photo is set. Same
    // resolution rule as the conversation list — keeps the surfaces in
    // sync with the group settings modal's avatar editor.
    if (conv.avatarUrl) {
      av.innerHTML = `<img src="${escHTML(conv.avatarUrl)}" alt=""/>`;
    } else {
      av.innerHTML = renderGroupAvatarHtml(conv.members, 'list')
        .replace('class="dm-conv-avatar dm-group-avatar"', 'class="dm-group-avatar dm-group-avatar-header"');
    }
    av.onclick = () => openConvActionsMenu(); // tap header avatar → menu (View members)
    nameBtn.textContent = (conv.isSecret ? '🔒 ' : '') + conv.name;
    nameBtn.onclick = () => openConvActionsMenu();
    statusEl.textContent = `${conv.memberCount} members`;
  } else {
    const u = conv.otherUser;
    av.innerHTML = (u.avatar_url
      ? `<img src="${escHTML(u.avatar_url)}" alt=""/>`
      : `<span class="dm-avatar-initials">${initials(u.username)}</span>`) +
      `<span class="dm-online-dot" id="dmOnlineDot" style="display:none"></span>`;
    av.onclick = () => openProfile(u.id);
    nameBtn.textContent = (conv.isSecret ? '🔒 ' : '') + (u.username || 'Unknown');
    nameBtn.onclick = () => openProfile(u.id);
    statusEl.textContent = '';
  }

  // Highlight in list
  document.querySelectorAll('.dm-conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.convId === convId);
  });

  // Mobile: collapse list, show thread
  document.querySelector('.dm-shell')?.classList.add('thread-open');

  // Load messages
  await loadMessages(convId);

  // ── Optimistically clear unread BEFORE the RPC call ──
  // Even if mark_conversation_read fails (RPC missing, network error, etc.),
  // the user sees the badge clear immediately. Real-time correction happens
  // on next loadConversationList if the server disagrees.
  const _zeroUnread = () => {
    const c = dmState.conversations.find(x => x.id === convId);
    if (c) c.unread = 0;
    renderConversationList();
    const total = dmState.conversations.reduce((sum, x) => x.muted ? sum : sum + (x.unread || 0), 0);
    updateUnreadBadge(total);
  };
  _zeroUnread();
  supabase.rpc('mark_conversation_read', { p_conversation_id: convId })
    .then(_zeroUnread)
    .catch(() => {});  // Already cleared optimistically; ignore RPC errors

  // Subscribe to realtime updates for this conversation
  subscribeToThread(convId);
}

async function loadMessages(convId) {
  const wrap = document.getElementById('dmMessages');
  if (!wrap) return;
  wrap.innerHTML = '<div class="dm-loading">Loading messages…</div>';
  // Fresh conversation → reset the "already-animated" tracker so first paint animates in
  _renderedMessageIds.clear();

  // Fetch messages + reactions in parallel (include reply_to_id + image fields).
  // Pull the LATEST 100 (descending), then reverse to chronological order so
  // newest sits at the bottom. Previously this was ascending+limit(200) which,
  // on a thread with >200 messages, would silently miss the most recent ones.
  // Older messages can be paged in via a future "load older" affordance.
  const [{ data: msgs, error: msgErr }, reactionsByMsg] = await Promise.all([
    supabase
      .from('messages')
      .select('id, conversation_id, sender_id, body, created_at, read_at, edited_at, deleted_at, reply_to_id, image_url, image_kind')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .limit(100),
    fetchReactionsForConversation(convId),
  ]);

  if (msgErr) {
    wrap.innerHTML = `<div class="dm-error">Couldn't load messages: ${escHTML(msgErr.message)}</div>`;
    return;
  }
  // Reverse to chronological order (oldest first → newest at bottom of thread)
  dmState.messages = (msgs || []).slice().reverse();
  dmState.reactions = reactionsByMsg;
  renderMessages();
  // Initial open of a thread → always pin to bottom regardless of prior scroll.
  scrollMessagesToBottom({ force: true });
}

// Fetch all reactions for messages in this conversation, indexed by message_id
async function fetchReactionsForConversation(convId) {
  // First get the message ids in this convo (RLS-protected)
  const { data: msgIds } = await supabase
    .from('messages')
    .select('id')
    .eq('conversation_id', convId);
  if (!msgIds?.length) return {};
  const ids = msgIds.map(m => m.id);
  const { data: reactions } = await supabase
    .from('message_reactions')
    .select('message_id, user_id, emoji, created_at')
    .in('message_id', ids);
  const out = {};
  (reactions || []).forEach(r => {
    if (!out[r.message_id]) out[r.message_id] = [];
    out[r.message_id].push(r);
  });
  return out;
}

// ── Render messages with FB-style grouping ────────────────────────────────
function renderMessages() {
  const wrap = document.getElementById('dmMessages');
  if (!wrap) return;

  if (!dmState.messages.length) {
    if (dmState.activeConv?.isGroup) {
      wrap.innerHTML = `
        <div class="dm-thread-intro">
          <div class="dm-thread-intro-avatar">${renderGroupAvatarHtml(dmState.activeConv.members, 'list')}</div>
          <h3>${escHTML(dmState.activeConv.name || 'Group chat')}</h3>
          <p>${dmState.activeConv.memberCount} members. Send a message to get the chat going.</p>
        </div>
      `;
    } else {
      wrap.innerHTML = `
        <div class="dm-thread-intro">
          <div class="dm-thread-intro-avatar">${dmState.activeOther?.avatar_url
            ? `<img src="${escHTML(dmState.activeOther.avatar_url)}"/>`
            : initials(dmState.activeOther?.username)}</div>
          <h3>${escHTML(dmState.activeOther?.username || '')}</h3>
          <p>Say hello — your first message starts the conversation.</p>
        </div>
      `;
    }
    return;
  }
  const isGroup = !!dmState.activeConv?.isGroup;
  const memberMap = new Map();
  if (isGroup) (dmState.activeConv.members || []).forEach(m => memberMap.set(m.id, m));

  // Identify the LAST message sent by ME that the OTHER has already read,
  // so we can stick the read avatar to it (FB pattern).
  let lastReadOfMine = null;
  for (let i = dmState.messages.length - 1; i >= 0; i--) {
    const m = dmState.messages[i];
    if (m.sender_id === currentUser.id && m.read_at) { lastReadOfMine = m.id; break; }
  }

  let lastDateStamp = '';
  let html = '';
  for (let i = 0; i < dmState.messages.length; i++) {
    const m = dmState.messages[i];
    const prev = dmState.messages[i - 1];
    const next = dmState.messages[i + 1];
    const mine = m.sender_id === currentUser.id;

    // Date separator (every ~30 min gap or new day)
    const stamp = formatMessageDateStamp(m.created_at, prev?.created_at);
    if (stamp && stamp !== lastDateStamp) {
      html += `<div class="dm-date-sep">${stamp}</div>`;
      lastDateStamp = stamp;
    }

    // Grouping: this message belongs to the same "burst" if same sender as prev/next AND within 5 min
    const isFirstInGroup = !prev || prev.sender_id !== m.sender_id || (new Date(m.created_at) - new Date(prev.created_at)) > 5 * 60000;
    const isLastInGroup  = !next || next.sender_id !== m.sender_id || (new Date(next.created_at) - new Date(m.created_at)) > 5 * 60000;

    // Only animate bubbles we haven't rendered before — prevents the whole
    // list from flashing on every re-render (e.g. after optimistic→real swap).
    const isNewBubble = !_renderedMessageIds.has(m.id);
    const bubbleCls = `dm-bubble ${mine ? 'mine' : 'theirs'}` +
      (isFirstInGroup ? ' first-in-group' : '') +
      (isLastInGroup  ? ' last-in-group'  : '') +
      (isNewBubble    ? ' is-new'         : '');

    // Avatar: in groups, show the SENDER's avatar (different per message); in 1:1, the activeOther's
    const senderProfile = isGroup ? memberMap.get(m.sender_id) : dmState.activeOther;
    const showAvatar = !mine && isLastInGroup;
    const avatarHtml = showAvatar
      ? `<div class="dm-bubble-avatar">${senderProfile?.avatar_url
          ? `<img src="${escHTML(senderProfile.avatar_url)}"/>`
          : initials(senderProfile?.username)}</div>`
      : '<div class="dm-bubble-avatar-spacer"></div>';
    // In groups: show sender name above their FIRST bubble in a stretch
    const senderNameHtml = (isGroup && !mine && isFirstInGroup && senderProfile)
      ? `<div class="dm-sender-name">${escHTML(senderProfile.username || 'Unknown')}</div>`
      : '';

    const isDeleted = !!m.deleted_at;
    // Build bubble content: deleted messages render as a static label (NOT through linkify),
    // otherwise escape body, convert newlines, then linkify URLs.
    let bubbleContent;
    let linkPreviewHtml = '';
    let imageHtml = '';
    if (isDeleted) {
      const who = mine ? 'You' : escHTML(dmState.activeOther?.username || 'User');
      bubbleContent = `<span class="dm-bubble-deleted">${who} unsent a message</span>`;
    } else {
      // Image attachment (uploaded photo OR GIF from picker)
      if (m.image_url) {
        const isGif = m.image_kind === 'gif' || /\.gif(\?|$)/i.test(m.image_url);
        imageHtml = `
          <div class="dm-bubble-image ${isGif ? 'is-gif' : ''}" data-img-url="${escHTML(m.image_url)}">
            <img src="${escHTML(m.image_url)}" alt="Attachment" loading="lazy"/>
            ${isGif ? '<span class="dm-bubble-image-tag">GIF</span>' : ''}
          </div>
        `;
      }
      // Body text (skip if message is image-only with whitespace body)
      const trimmedBody = (m.body || '').trim();
      if (trimmedBody) {
        const escaped = escHTML(m.body || '').replace(/\n/g, '<br>');
        bubbleContent = linkify(escaped);
        linkPreviewHtml = renderDmLinkPreview(m.body || '');
      } else {
        bubbleContent = '';
      }
    }

    const editedTag = (!isDeleted && m.edited_at) ? '<span class="dm-edited-tag" title="Edited">(edited)</span>' : '';

    const readBadge = mine && m.id === lastReadOfMine
      ? `<div class="dm-bubble-read" title="Seen ${timeAgo(m.read_at)}">
          ${dmState.activeOther?.avatar_url
            ? `<img src="${escHTML(dmState.activeOther.avatar_url)}"/>`
            : `<span>${initials(dmState.activeOther?.username)}</span>`}
        </div>`
      : '';

    // Reaction pills (groups by emoji)
    const reactions = (dmState.reactions[m.id] || []);
    let reactionsHtml = '';
    if (reactions.length) {
      const grouped = {};
      const myReacts = new Set();
      reactions.forEach(r => {
        grouped[r.emoji] = (grouped[r.emoji] || 0) + 1;
        if (r.user_id === currentUser.id) myReacts.add(r.emoji);
      });
      reactionsHtml = `<div class="dm-bubble-reactions">${
        Object.entries(grouped).map(([emoji, count]) =>
          `<button class="dm-rx-pill ${myReacts.has(emoji) ? 'mine' : ''}" data-msg="${m.id}" data-emoji="${escHTML(emoji)}" title="${myReacts.has(emoji) ? 'Remove your reaction' : 'React'}">
            <span>${emoji}</span>${count > 1 ? `<span class="dm-rx-count">${count}</span>` : ''}
          </button>`
        ).join('')
      }</div>`;
    }

    const canEditDelete = mine && !isDeleted && !m.image_url; // can't inline-edit images
    const deletedCls = isDeleted ? ' is-deleted' : '';
    const imageOnlyCls = (!isDeleted && imageHtml && !bubbleContent) ? ' is-image-only' : '';

    // Reply quote chip — show the quoted message above the bubble
    let replyQuoteHtml = '';
    if (m.reply_to_id) {
      const parent = dmState.messages.find(x => x.id === m.reply_to_id);
      if (parent) {
        const parentSender = isGroup
          ? memberMap.get(parent.sender_id)
          : (parent.sender_id === currentUser.id ? { username: 'You' } : dmState.activeOther);
        const parentName = parent.sender_id === currentUser.id ? 'You' : (parentSender?.username || 'Unknown');
        const parentBody = parent.deleted_at ? '(unsent message)' : (parent.body || '').slice(0, 100);
        replyQuoteHtml = `
          <button class="dm-reply-quote ${mine ? 'mine' : 'theirs'}" data-jump-to="${parent.id}">
            <span class="dm-reply-quote-name">${escHTML(parentName)}</span>
            <span class="dm-reply-quote-body">${escHTML(parentBody)}</span>
          </button>
        `;
      } else {
        replyQuoteHtml = `<div class="dm-reply-quote ${mine ? 'mine' : 'theirs'} dm-reply-orphan">Original message unavailable</div>`;
      }
    }

    html += `
      <div class="dm-bubble-row ${mine ? 'mine' : 'theirs'}" data-msg-id="${m.id}">
        ${!mine ? avatarHtml : ''}
        <div class="dm-bubble-wrap">
          ${senderNameHtml}
          ${replyQuoteHtml}
          <div class="${bubbleCls}${deletedCls}${imageOnlyCls}" data-msg-id="${m.id}" data-is-mine="${mine ? '1' : '0'}" data-can-edit="${canEditDelete ? '1' : '0'}" title="${new Date(m.created_at).toLocaleString()}">
            ${imageHtml}
            ${bubbleContent ? `<div class="dm-bubble-text">${bubbleContent}${editedTag ? ' ' + editedTag : ''}</div>` : (editedTag && !imageHtml ? editedTag : '')}
          </div>
          ${linkPreviewHtml}
          ${reactionsHtml}
          ${mine ? readBadge : ''}
        </div>
      </div>
    `;
  }

  // Typing indicator at bottom (only if other is typing AND we have at least one msg)
  if (dmState.otherIsTyping) {
    html += `
      <div class="dm-bubble-row theirs dm-typing-row">
        <div class="dm-bubble-avatar">${dmState.activeOther?.avatar_url
          ? `<img src="${escHTML(dmState.activeOther.avatar_url)}"/>`
          : initials(dmState.activeOther?.username)}</div>
        <div class="dm-bubble theirs first-in-group last-in-group dm-typing-bubble" aria-label="Typing">
          <span class="dm-typing-dot"></span><span class="dm-typing-dot"></span><span class="dm-typing-dot"></span>
        </div>
      </div>
    `;
  }

  wrap.innerHTML = html;

  // Mark all currently-rendered message ids as "seen" so future re-renders
  // don't re-trigger the entrance animation on existing bubbles.
  _renderedMessageIds.clear();
  dmState.messages.forEach(m => _renderedMessageIds.add(m.id));

  // Async-fill any Selebox-internal preview placeholders (videos/books/profiles)
  hydrateDmInternalPreviews();
}

function formatMessageDateStamp(current, previous) {
  const cur = new Date(current);
  if (!previous) {
    // Always show stamp for the first message
    return formatStampLabel(cur);
  }
  const prev = new Date(previous);
  const gapMs = cur - prev;
  if (gapMs > 30 * 60 * 1000 || cur.toDateString() !== prev.toDateString()) {
    return formatStampLabel(cur);
  }
  return null;
}

function formatStampLabel(d) {
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const dayStart = new Date(d); dayStart.setHours(0,0,0,0);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (dayStart.getTime() === today.getTime())     return `Today at ${t}`;
  if (dayStart.getTime() === yesterday.getTime()) return `Yesterday at ${t}`;
  // older
  const dateStr = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `${dateStr} at ${t}`;
}

// True when the messages pane is scrolled to (or within 80px of) the bottom.
function isDmAtBottom(wrap) {
  if (!wrap) return false;
  return wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 80;
}

// Pin the messages pane to the latest message.
//
// Why this is more involved than a one-shot scrollTop: bubbles can grow AFTER
// the initial pin — lazy-loaded image attachments, link-preview thumbnails
// (favicons / YouTube), and the hydrated internal-preview cards (skeleton →
// full card swap). Each of those landings nudges the latest message above
// the fold. So we re-pin in a few passes as content settles, AND once per
// <img> load.
//
// Pass `{ force: true }` for "I just opened the thread / I just sent" — those
// must pin regardless of prior scroll position. Without `force`, we only
// re-pin when the user was already at the bottom (so we don't yank them
// back if they've scrolled up to read older messages).
function scrollMessagesToBottom(opts = {}) {
  const wrap = document.getElementById('dmMessages');
  if (!wrap) return;
  const force = !!opts.force;
  // Capture once: was the user at the bottom at the moment of this call?
  // Subsequent stick() calls honor that snapshot so we don't fight the user
  // if they scroll up between passes.
  const wasAtBottom = force || isDmAtBottom(wrap);
  const stick = () => {
    if (wasAtBottom) wrap.scrollTop = wrap.scrollHeight;
  };
  requestAnimationFrame(stick);
  // Re-pin as async content settles (link previews, hydrated cards, fonts).
  setTimeout(stick, 80);
  setTimeout(stick, 300);
  setTimeout(stick, 800);
  // Pin once each not-yet-loaded <img> finishes — covers slower networks
  // where attachments / link thumbnails arrive long after the timeouts.
  wrap.querySelectorAll('img').forEach(img => {
    if (img.complete && img.naturalWidth > 0) return;
    img.addEventListener('load',  stick, { once: true });
    img.addEventListener('error', stick, { once: true });
  });
}

// ── Send a message ────────────────────────────────────────────────────────
async function sendDmMessage() {
  const input = document.getElementById('dmInput');
  if (!input || !dmState.activeConvId) return;
  const body = input.value.trim();
  if (!body) {
    // Empty composer + send click = thumbs-up emoji (FB classic)
    return sendDmThumbsUp();
  }

  // Capture & clear reply state up front
  const replyToId = dmState.replyingTo?.id || null;
  dmState.replyingTo = null;
  if (typeof hideReplyPreview === 'function') hideReplyPreview();

  // Secret-conversation send-time mutuals re-check. Mirrors mobile's
  // sendMessage gate. The conversation row's is_secret never changes,
  // so we trust dmState.activeConv (already loaded). For Secret 1:1's
  // we re-verify the mutual-follow invariant — if either side has
  // unfollowed since the conversation was created, the message is
  // refused with a friendly toast. The conversation row stays visible
  // (frozen) so the user can see the shared history.
  const ac = dmState.activeConv;
  if (ac && ac.is_secret && !ac.is_group) {
    const otherId = ac.user_a === currentUser.id ? ac.user_b : ac.user_a;
    if (otherId) {
      const stillMutual = await dmIsMutualFollow(currentUser.id, otherId);
      if (!stillMutual) {
        toast('You and this person are no longer mutuals. Secret chat is frozen.', 'error');
        return;
      }
    }
  }

  // Optimistic render
  const tempId = 'temp-' + Date.now();
  const optimistic = {
    id: tempId,
    conversation_id: dmState.activeConvId,
    sender_id: currentUser.id,
    body,
    reply_to_id: replyToId,
    created_at: new Date().toISOString(),
    read_at: null,
    _pending: true,
  };
  dmState.messages.push(optimistic);
  renderMessages();
  // Sending my own message → always pin so I see it land.
  scrollMessagesToBottom({ force: true });
  input.value = '';
  resizeDmInput();
  updateSendButton();

  const { data, error } = await supabase.from('messages').insert({
    conversation_id: dmState.activeConvId,
    sender_id: currentUser.id,
    body,
    reply_to_id: replyToId,
  }).select().single();

  if (error) {
    // Rollback optimistic
    dmState.messages = dmState.messages.filter(m => m.id !== tempId);
    renderMessages();
    toast(error.message, 'error');
    return;
  }
  // Replace temp with real — transfer the "already-rendered" status so the
  // bubble doesn't re-animate (otherwise the whole list would flash).
  const idx = dmState.messages.findIndex(m => m.id === tempId);
  if (idx >= 0) dmState.messages[idx] = data;
  if (_renderedMessageIds.has(tempId)) {
    _renderedMessageIds.delete(tempId);
    _renderedMessageIds.add(data.id);
  }
  // Also update the DOM in place so we don't need a full re-render at all.
  // The bubble keeps its position + animation state; we just swap the IDs.
  document.querySelectorAll(`[data-msg-id="${tempId}"]`).forEach(el => {
    el.dataset.msgId = data.id;
  });
}

async function sendDmThumbsUp() {
  if (!dmState.activeConvId) return;
  const { data, error } = await supabase.from('messages').insert({
    conversation_id: dmState.activeConvId,
    sender_id: currentUser.id,
    body: '👍',
  }).select().single();
  if (error) { toast(error.message, 'error'); return; }
  dmState.messages.push(data);
  renderMessages();
  // Sending my own thumbs-up → always pin.
  scrollMessagesToBottom({ force: true });
}

function updateSendButton() {
  const btn = document.getElementById('dmSendBtn');
  const input = document.getElementById('dmInput');
  if (!btn || !input) return;
  const hasText = input.value.trim().length > 0;
  btn.classList.toggle('has-text', hasText);
}

function resizeDmInput() {
  const input = document.getElementById('dmInput');
  if (!input) return;
  // Capture whether the user was anchored to the bottom BEFORE the resize
  const messages = document.getElementById('dmMessages');
  const wasAtBottom = messages
    ? (messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 80)
    : false;

  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';

  // Composer just got taller → messages area shrunk. If user was at the
  // bottom before, keep them at the bottom (so latest message stays visible).
  if (wasAtBottom && messages) {
    requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
  }
}

// ── Realtime ──────────────────────────────────────────────────────────────
function subscribeToThread(convId) {
  // Tear down previous channels
  if (dmState.realtimeChannel) {
    supabase.removeChannel(dmState.realtimeChannel);
    dmState.realtimeChannel = null;
  }
  if (dmState.presenceChannel) {
    supabase.removeChannel(dmState.presenceChannel);
    dmState.presenceChannel = null;
  }
  // Reset transient state
  dmState.otherIsTyping = false;
  if (dmState.otherTypingTimer) { clearTimeout(dmState.otherTypingTimer); dmState.otherTypingTimer = null; }
  if (dmState.myTypingTimer) { clearTimeout(dmState.myTypingTimer); dmState.myTypingTimer = null; }
  dmState.otherIsOnline = false;

  // — Channel A: postgres_changes for this thread (messages + reactions) —
  dmState.realtimeChannel = supabase
    .channel(`dm-thread-${convId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages',
      filter: `conversation_id=eq.${convId}`,
    }, (payload) => {
      const newMsg = payload.new;
      // Already in the array by real id? skip (covers the case where the
      // HTTP insert response landed first and we already swapped tempId → real).
      if (dmState.messages.some(m => m.id === newMsg.id)) return;

      // Race fix: if MY own message echoes back from realtime BEFORE the HTTP
      // insert response returns, the temp-XXX placeholder is still in the
      // array. Without this match, we'd push a second copy and the user
      // would see the message twice. Find the matching temp and swap in
      // place rather than push.
      if (newMsg.sender_id === currentUser.id) {
        const tempIdx = dmState.messages.findIndex(m =>
          String(m.id).startsWith('temp-') &&
          m.sender_id === currentUser.id &&
          (m.body || '') === (newMsg.body || '')
        );
        if (tempIdx >= 0) {
          const oldId = dmState.messages[tempIdx].id;
          dmState.messages[tempIdx] = newMsg;
          // Migrate the rendered-id tracker so the bubble doesn't re-animate
          if (_renderedMessageIds.has(oldId)) {
            _renderedMessageIds.delete(oldId);
            _renderedMessageIds.add(newMsg.id);
          }
          // Update the DOM in-place — same as the HTTP-response path does
          document.querySelectorAll(`[data-msg-id="${oldId}"]`).forEach(el => {
            el.dataset.msgId = newMsg.id;
          });
          return;
        }
      }

      dmState.messages.push(newMsg);
      renderMessages();
      scrollMessagesToBottom();
      if (newMsg.sender_id !== currentUser.id) {
        // The other side just sent — clear typing indicator
        dmState.otherIsTyping = false;
        supabase.rpc('mark_conversation_read', { p_conversation_id: convId });
        // Also reset local unread immediately so the sidebar badge doesn't
        // tick up while the user is actively reading the thread. The inbox
        // channel's guard already skips totalUnread bump, but the per-conv
        // count needs explicit clearing here in case it drifted.
        const c = dmState.conversations.find(x => x.id === convId);
        if (c) c.unread = 0;
        const total = dmState.conversations.reduce((sum, x) => x.muted ? sum : sum + (x.unread || 0), 0);
        updateUnreadBadge(total);
        renderConversationList();
      }
    })
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'messages',
      filter: `conversation_id=eq.${convId}`,
    }, (payload) => {
      const idx = dmState.messages.findIndex(m => m.id === payload.new.id);
      if (idx >= 0) {
        dmState.messages[idx] = payload.new;
        renderMessages();
      }
    })
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'message_reactions',
    }, (payload) => {
      const r = payload.new;
      // Only handle reactions on messages in this thread
      if (!dmState.messages.some(m => m.id === r.message_id)) return;
      if (!dmState.reactions[r.message_id]) dmState.reactions[r.message_id] = [];
      // Avoid duplicates from optimistic insert
      const exists = dmState.reactions[r.message_id].some(x => x.user_id === r.user_id && x.emoji === r.emoji);
      if (!exists) {
        dmState.reactions[r.message_id].push(r);
        renderMessages();
      }
    })
    .on('postgres_changes', {
      event: 'DELETE', schema: 'public', table: 'message_reactions',
    }, (payload) => {
      const r = payload.old;
      if (!dmState.reactions[r.message_id]) return;
      dmState.reactions[r.message_id] = dmState.reactions[r.message_id].filter(x =>
        !(x.user_id === r.user_id && x.emoji === r.emoji));
      renderMessages();
    })
    .subscribe();

  // — Channel B: presence + typing broadcast (lighter weight, ephemeral) —
  subscribeToPresenceAndTyping(convId);
}

function subscribeToPresenceAndTyping(convId) {
  const channel = supabase.channel(`dm-presence-${convId}`, {
    config: { presence: { key: currentUser.id } },
  });

  channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const otherId = dmState.activeOther?.id;
      const otherPresent = otherId && state[otherId];
      dmState.otherIsOnline = !!otherPresent;
      updateThreadPresenceUI();
    })
    .on('broadcast', { event: 'typing' }, (payload) => {
      const fromId = payload.payload?.userId;
      if (!fromId || fromId === currentUser.id) return;
      // Show typing for ~3s; if more broadcasts arrive, refresh the timer
      dmState.otherIsTyping = true;
      if (dmState.otherTypingTimer) clearTimeout(dmState.otherTypingTimer);
      dmState.otherTypingTimer = setTimeout(() => {
        dmState.otherIsTyping = false;
        renderMessages();
        scrollMessagesToBottom();
      }, 3500);
      renderMessages();
      scrollMessagesToBottom();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ userId: currentUser.id, online_at: new Date().toISOString() });
      }
    });

  dmState.presenceChannel = channel;
}

function updateThreadPresenceUI() {
  const dot = document.getElementById('dmOnlineDot');
  const status = document.getElementById('dmThreadStatus');
  if (dot) dot.style.display = dmState.otherIsOnline ? '' : 'none';
  if (status) status.textContent = dmState.otherIsOnline ? 'Active now' : '';
}

// Broadcast that I'm typing (debounced)
function broadcastTyping() {
  if (!dmState.presenceChannel) return;
  if (dmState.myTypingTimer) return;  // already broadcasted recently — wait
  dmState.presenceChannel.send({
    type: 'broadcast',
    event: 'typing',
    payload: { userId: currentUser.id },
  });
  // Throttle: don't re-broadcast more than once every 1.5s
  dmState.myTypingTimer = setTimeout(() => {
    dmState.myTypingTimer = null;
  }, 1500);
}

// ── Reactions API ──────────────────────────────────────────────────────────
async function toggleReaction(messageId, emoji) {
  if (!currentUser) return;
  const existing = (dmState.reactions[messageId] || []).find(r =>
    r.user_id === currentUser.id && r.emoji === emoji);

  if (existing) {
    // Remove (optimistic)
    dmState.reactions[messageId] = dmState.reactions[messageId].filter(r =>
      !(r.user_id === currentUser.id && r.emoji === emoji));
    renderMessages();
    const { error } = await supabase.from('message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', currentUser.id)
      .eq('emoji', emoji);
    if (error) toast(error.message, 'error');
  } else {
    // Add (optimistic)
    if (!dmState.reactions[messageId]) dmState.reactions[messageId] = [];
    dmState.reactions[messageId].push({ message_id: messageId, user_id: currentUser.id, emoji });
    renderMessages();
    const { error } = await supabase.from('message_reactions').insert({
      message_id: messageId, user_id: currentUser.id, emoji,
    });
    if (error) {
      // Rollback
      dmState.reactions[messageId] = dmState.reactions[messageId].filter(r =>
        !(r.user_id === currentUser.id && r.emoji === emoji));
      renderMessages();
      toast(error.message, 'error');
    }
  }
  closeReactionPicker();
}

// ── Edit / delete own message ─────────────────────────────────────────────
async function deleteMessage(messageId) {
  const ok = await confirmDialog({
    title: 'Delete message?',
    body: 'This message will be replaced with "Message deleted" for both of you. Can\'t be undone.',
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  const { error } = await supabase.from('messages')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', messageId)
    .eq('sender_id', currentUser.id);
  if (error) { toast(error.message, 'error'); return; }
  // Local update — realtime UPDATE will also fire
  const idx = dmState.messages.findIndex(m => m.id === messageId);
  if (idx >= 0) {
    dmState.messages[idx] = { ...dmState.messages[idx], deleted_at: new Date().toISOString() };
    renderMessages();
  }
}

function startEditMessage(messageId) {
  const msg = dmState.messages.find(m => m.id === messageId);
  if (!msg || msg.sender_id !== currentUser.id) return;
  dmState.editingMessageId = messageId;
  // Replace the bubble's contents with an inline editor
  const bubble = document.querySelector(`.dm-bubble[data-msg-id="${messageId}"]`);
  if (!bubble) return;
  const original = msg.body || '';
  bubble.innerHTML = `
    <textarea class="dm-edit-textarea" maxlength="4000">${escHTML(original)}</textarea>
    <div class="dm-edit-actions">
      <button class="dm-edit-cancel" type="button">Cancel</button>
      <button class="dm-edit-save" type="button">Save</button>
    </div>
  `;
  const ta = bubble.querySelector('.dm-edit-textarea');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  bubble.querySelector('.dm-edit-cancel').onclick = () => {
    dmState.editingMessageId = null;
    renderMessages();
  };
  bubble.querySelector('.dm-edit-save').onclick = () => saveEditMessage(messageId, ta.value);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEditMessage(messageId, ta.value);
    } else if (e.key === 'Escape') {
      dmState.editingMessageId = null;
      renderMessages();
    }
  });
}

async function saveEditMessage(messageId, newBody) {
  const trimmed = (newBody || '').trim();
  const msg = dmState.messages.find(m => m.id === messageId);
  if (!msg) return;
  if (!trimmed) { toast('Message can\'t be empty', 'error'); return; }
  if (trimmed === msg.body) {
    dmState.editingMessageId = null;
    renderMessages();
    return;
  }
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('messages')
    .update({ body: trimmed, edited_at: nowIso })
    .eq('id', messageId)
    .eq('sender_id', currentUser.id);
  if (error) { toast(error.message, 'error'); return; }
  const idx = dmState.messages.findIndex(m => m.id === messageId);
  if (idx >= 0) {
    dmState.messages[idx] = { ...dmState.messages[idx], body: trimmed, edited_at: nowIso };
  }
  dmState.editingMessageId = null;
  renderMessages();
}

// ── Hover menu + reaction picker ──────────────────────────────────────────
function closeHoverMenu() {
  if (dmState.hoverMenuEl) { dmState.hoverMenuEl.remove(); dmState.hoverMenuEl = null; }
}
function closeReactionPicker() {
  if (dmState.reactionPickerEl) { dmState.reactionPickerEl.remove(); dmState.reactionPickerEl = null; }
}

function openHoverMenu(bubbleEl) {
  closeHoverMenu();
  if (!bubbleEl) return;
  const messageId = bubbleEl.dataset.msgId;
  const isMine = bubbleEl.dataset.isMine === '1';
  const canEdit = bubbleEl.dataset.canEdit === '1';

  const menu = document.createElement('div');
  menu.className = 'dm-hover-menu' + (isMine ? ' mine' : ' theirs');
  menu.innerHTML = `
    <button class="dm-hover-btn" data-act="react" title="React">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
    </button>
    <button class="dm-hover-btn" data-act="reply" title="Reply">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
    </button>
    <button class="dm-hover-btn" data-act="copy" title="Copy text">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>
    ${canEdit ? `
      <button class="dm-hover-btn" data-act="edit" title="Edit">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
      </button>
      <button class="dm-hover-btn dm-hover-danger" data-act="delete" title="Delete">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    ` : ''}
  `;
  document.body.appendChild(menu);

  // Position above the bubble
  const r = bubbleEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${Math.max(8, r.top - 44)}px`;
  if (isMine) {
    menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  } else {
    menu.style.left = `${Math.max(8, r.left)}px`;
  }
  dmState.hoverMenuEl = menu;

  menu.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const act = btn.dataset.act;
      closeHoverMenu();
      if      (act === 'react')  openReactionPicker(bubbleEl);
      else if (act === 'reply')  startReplyToMessage(messageId);
      else if (act === 'copy')   copyMessageText(messageId);
      else if (act === 'edit')   startEditMessage(messageId);
      else if (act === 'delete') deleteMessage(messageId);
    };
  });
}

function openReactionPicker(bubbleEl) {
  closeReactionPicker();
  if (!bubbleEl) return;
  const messageId = bubbleEl.dataset.msgId;
  const picker = document.createElement('div');
  picker.className = 'dm-reaction-picker';
  picker.innerHTML = DM_QUICK_REACTIONS.map(emoji =>
    `<button class="dm-rx-pick" data-emoji="${emoji}">${emoji}</button>`
  ).join('');
  document.body.appendChild(picker);

  const r = bubbleEl.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.top = `${Math.max(8, r.top - 50)}px`;
  const isMine = bubbleEl.dataset.isMine === '1';
  if (isMine) picker.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  else        picker.style.left  = `${Math.max(8, r.left)}px`;

  dmState.reactionPickerEl = picker;
  picker.querySelectorAll('[data-emoji]').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      toggleReaction(messageId, btn.dataset.emoji);
    };
  });
}

async function copyMessageText(messageId) {
  const m = dmState.messages.find(x => x.id === messageId);
  if (!m) return;
  try {
    await navigator.clipboard.writeText(m.body || '');
    toast('Copied', 'success');
  } catch {
    toast('Copy failed', 'error');
  }
}

// Bubble hover/click → show menu (works on mobile via tap)
document.addEventListener('click', (e) => {
  // Click on a DM image → open lightbox, don't open hover menu
  const dmImg = e.target.closest('.dm-bubble-image');
  if (dmImg) {
    e.stopPropagation();
    const url = dmImg.dataset.imgUrl;
    if (url) window.openLightbox?.(url);
    return;
  }
  // Click on existing reaction pill → toggle
  const pill = e.target.closest('.dm-rx-pill');
  if (pill) {
    e.stopPropagation();
    toggleReaction(pill.dataset.msg, pill.dataset.emoji);
    return;
  }
  // Click on bubble → open hover menu (skip typing/deleted bubbles)
  const bubble = e.target.closest('.dm-bubble');
  if (bubble && bubble.dataset.msgId
      && !bubble.classList.contains('dm-typing-bubble')
      && !bubble.classList.contains('is-deleted')) {
    if (dmState.editingMessageId === bubble.dataset.msgId) return; // don't reopen while editing
    e.stopPropagation();
    openHoverMenu(bubble);
    return;
  }
  // Click outside → close menus
  if (!e.target.closest('.dm-hover-menu') && !e.target.closest('.dm-reaction-picker')) {
    closeHoverMenu();
    closeReactionPicker();
  }
});

// Inbox-wide subscription so the unread badge updates even when DMs page is closed
// Per-conversation cache of { user_a, user_b, is_secret } — the inbox
// subscription would otherwise SELECT the same row on every message,
// burning a round-trip per inbound message. The fields cached here
// don't change for a conversation's lifetime.
const __convInboxCache = new Map();

function subscribeToInbox() {
  if (!currentUser) return;
  if (dmState.inboxChannel) supabase.removeChannel(dmState.inboxChannel);
  // Drop the cache when re-subscribing — different user could be signed
  // in, different conversations.
  __convInboxCache.clear();
  dmState.inboxChannel = supabase
    .channel(`dm-inbox-${currentUser.id}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
    }, async (payload) => {
      const m = payload.new;
      if (m.sender_id === currentUser.id) return; // my own message

      let meta = __convInboxCache.get(m.conversation_id);
      if (!meta) {
        const { data: c } = await supabase
          .from('conversations')
          .select('user_a, user_b, is_secret')
          .eq('id', m.conversation_id)
          .single();
        if (!c) return;
        meta = { user_a: c.user_a, user_b: c.user_b, is_secret: !!c.is_secret };
        __convInboxCache.set(m.conversation_id, meta);
      }

      if (meta.user_a !== currentUser.id && meta.user_b !== currentUser.id) return;
      // Secret conversations are stealth — never bump the global badge,
      // never surface a notification. The user discovers them only by
      // opening the Secret tab. Mirrors mobile's useTotalUnreadCount
      // suppression and chat-push.js Secret skip.
      if (meta.is_secret) return;
      // If we're already viewing this thread, the thread channel will mark it read.
      if (dmState.activeConvId === m.conversation_id && messagesPage?.style.display === 'block') return;
      // Otherwise bump unread
      dmState.totalUnread++;
      updateUnreadBadge(dmState.totalUnread);
    })
    .subscribe();
}

function updateUnreadBadge(total) {
  dmState.totalUnread = total;
  const badge = document.getElementById('messagesUnreadBadge');
  if (!badge) return;
  if (total > 0) {
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// ── Wire up sidebar + composer + back button ─────────────────────────────
document.getElementById('btnMessages')?.addEventListener('click', () => showMessages());

document.getElementById('dmBackBtn')?.addEventListener('click', () => {
  document.querySelector('.dm-shell')?.classList.remove('thread-open');
  document.getElementById('dmThreadActive').style.display = 'none';
  document.getElementById('dmThreadEmpty').style.display = 'flex';
  if (dmState.realtimeChannel) {
    supabase.removeChannel(dmState.realtimeChannel);
    dmState.realtimeChannel = null;
  }
  if (dmState.presenceChannel) {
    supabase.removeChannel(dmState.presenceChannel);
    dmState.presenceChannel = null;
  }
  closeHoverMenu();
  closeReactionPicker();
  dmState.activeConvId = null;
  dmState.activeOther = null;
  dmState.editingMessageId = null;
});

const dmInputEl = document.getElementById('dmInput');
if (dmInputEl) {
  dmInputEl.addEventListener('input', () => {
    resizeDmInput();
    updateSendButton();
    // Broadcast that I'm typing (throttled inside)
    if (dmInputEl.value.trim().length > 0) broadcastTyping();
  });
  dmInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendDmMessage();
    }
  });
}
document.getElementById('dmSendBtn')?.addEventListener('click', () => sendDmMessage());

// Conversation list search filter
document.getElementById('dmSearchInput')?.addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.dm-conv-item').forEach(el => {
    const name = el.querySelector('.dm-conv-name')?.textContent.toLowerCase() || '';
    const preview = el.querySelector('.dm-conv-preview')?.textContent.toLowerCase() || '';
    el.style.display = (!q || name.includes(q) || preview.includes(q)) ? '' : 'none';
  });
});

// Initial badge load + inbox subscription on app boot
async function bootstrapDmBadge() {
  if (!currentUser) return;
  // Pull is_secret too so we can exclude Secret conversations from the
  // global unread total.
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, is_secret')
    .or(`user_a.eq.${currentUser.id},user_b.eq.${currentUser.id}`);
  if (!convs?.length) { updateUnreadBadge(0); return; }
  const eligibleIds = convs.filter(c => !c.is_secret).map(c => c.id);
  if (!eligibleIds.length) { updateUnreadBadge(0); return; }
  const counts = await fetchUnreadCounts(eligibleIds);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  updateUnreadBadge(total);
  subscribeToInbox();
}

// Run on initial sign-in (delayed so currentUser is set)
setTimeout(() => bootstrapDmBadge(), 1500);

// Hash routing
window.addEventListener('hashchange', () => {
  if (window.location.hash === '#messages') showMessages();
});
if (window.location.hash === '#messages') {
  setTimeout(() => showMessages(), 600);
}

// Path routing (popstate). Hash routes have hashchange handlers above;
// path routes need popstate because no hash transitions when going
// between path-based URLs. Currently only book detail + chapter routes
// are path-based; everything else still uses hash.
//
// On back/forward:
//   • /books/<id>/chapter/<n>  → re-render book detail, chapter restore
//   • /books/<id>              → re-render book detail
//   • anything else (including a hash route)  → no-op; hashchange
//     handlers cover those paths.
window.addEventListener('popstate', () => {
  const path = window.location.pathname || '';
  const chapterMatch = path.match(/^\/books?\/([^\/?#]+)\/chapter\/([^\/?#]+)/);
  const bookMatch = !chapterMatch ? path.match(/^\/books?\/([^\/?#]+)$/) : null;
  if (chapterMatch) {
    _pendingChapterFromUrl = chapterMatch[2];
    setSidebarActive('btnBook');
    openBookDetail(chapterMatch[1]);
    return;
  }
  if (bookMatch) {
    _pendingChapterFromUrl = null;
    setSidebarActive('btnBook');
    openBookDetail(bookMatch[1]);
    return;
  }
  // Path doesn't match a book route — back-button likely went to root
  // or to a hash route. If there's no hash either, render the home
  // feed (mirrors the boot router's default branch).
  if (!window.location.hash && path === '/') {
    bookDetailPage.style.display = 'none';
    if (typeof loadStories === 'function') loadStories();
    if (typeof loadFeed === 'function') loadFeed();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DMs Phase 3 — reply, conv menu, group creation, search
// ════════════════════════════════════════════════════════════════════════════

// ── Reply state ───────────────────────────────────────────────────────────
function startReplyToMessage(messageId) {
  const m = dmState.messages.find(x => x.id === messageId);
  if (!m) return;
  const senderProfile = m.sender_id === currentUser.id
    ? { username: 'yourself' }
    : (dmState.activeConv?.isGroup
        ? (dmState.activeConv.members || []).find(p => p.id === m.sender_id)
        : dmState.activeOther);
  dmState.replyingTo = {
    id: m.id,
    body: m.body,
    sender_id: m.sender_id,
    sender_name: senderProfile?.username || 'Unknown',
  };
  showReplyPreview();
  document.getElementById('dmInput')?.focus();
}

function showReplyPreview() {
  const el = document.getElementById('dmReplyPreview');
  if (!el || !dmState.replyingTo) return;
  document.getElementById('dmReplyName').textContent = dmState.replyingTo.sender_name;
  document.getElementById('dmReplyText').textContent = (dmState.replyingTo.body || '').slice(0, 140);
  el.style.display = '';
}
function hideReplyPreview() {
  const el = document.getElementById('dmReplyPreview');
  if (el) el.style.display = 'none';
}

document.getElementById('dmReplyCancel')?.addEventListener('click', () => {
  dmState.replyingTo = null;
  hideReplyPreview();
});


// ── Conversation actions menu (thread header ⋯) ───────────────────────────
function closeConvMenu() {
  if (dmState.convMenuEl) { dmState.convMenuEl.remove(); dmState.convMenuEl = null; }
}

function openConvActionsMenu() {
  closeConvMenu();
  if (!dmState.activeConv) return;
  const c = dmState.activeConv;
  const isGroup = c.isGroup;
  const isMuted = c.muted || isConvMutedForMe(c.raw);

  const menu = document.createElement('div');
  menu.className = 'post-action-menu dm-conv-menu';
  menu.innerHTML = isGroup ? `
    <button data-act="members">View members (${c.memberCount})</button>
    <button data-act="mute">${isMuted ? 'Unmute notifications' : 'Mute notifications'}</button>
    <button data-act="archive">Archive chat</button>
    <button data-act="leave" class="pam-danger">Leave group</button>
  ` : `
    <button data-act="profile">View profile</button>
    <button data-act="mute">${isMuted ? 'Unmute notifications' : 'Mute notifications'}</button>
    <button data-act="archive">Archive chat</button>
    <button data-act="report">Report user</button>
    <button data-act="delete" class="pam-danger">Delete conversation</button>
  `;
  document.body.appendChild(menu);

  // Position below the header ⋯ button
  const trigger = document.getElementById('dmThreadMenu');
  const r = trigger?.getBoundingClientRect() || { top: 80, right: window.innerWidth - 20 };
  menu.style.position = 'fixed';
  menu.style.top   = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
  dmState.convMenuEl = menu;

  menu.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const act = btn.dataset.act;
      closeConvMenu();
      if      (act === 'profile')  openProfile(dmState.activeOther?.id);
      else if (act === 'members')  showGroupMembersDialog();
      else if (act === 'mute')     toggleConvMute(isMuted);
      else if (act === 'archive')  archiveConversation();
      else if (act === 'report')   openReportUserModal(dmState.activeOther?.id, dmState.activeOther?.username || 'this user');
      else if (act === 'delete')   confirmDeleteConversation();
      else if (act === 'leave')    confirmLeaveGroup();
    };
  });

  setTimeout(() => {
    const onDocClick = (ev) => {
      if (!dmState.convMenuEl?.contains(ev.target)) {
        closeConvMenu();
        document.removeEventListener('click', onDocClick);
      }
    };
    document.addEventListener('click', onDocClick);
  }, 0);
}

document.getElementById('dmThreadMenu')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openConvActionsMenu();
});

async function toggleConvMute(currentlyMuted) {
  const c = dmState.activeConv;
  if (!c || c.isGroup) { toast('Group mute coming soon', ''); return; }
  const conv = c.raw;
  const myCol = conv.user_a === currentUser.id ? 'muted_until_a' : 'muted_until_b';
  const newVal = currentlyMuted ? null : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(); // mute 7 days
  const { error } = await supabase.from('conversations').update({ [myCol]: newVal }).eq('id', conv.id);
  if (error) { toast(error.message, 'error'); return; }
  toast(currentlyMuted ? 'Unmuted' : 'Muted for 7 days', 'success');
  conv[myCol] = newVal;
  c.muted = !currentlyMuted;
  renderConversationList();
  // Recompute unread badge
  const total = dmState.conversations.reduce((s, x) => x.muted ? s : s + (x.unread || 0), 0);
  updateUnreadBadge(total);
}

async function archiveConversation() {
  const c = dmState.activeConv;
  if (!c || c.isGroup) { toast('Group archive coming soon', ''); return; }
  const conv = c.raw;
  const myCol = conv.user_a === currentUser.id ? 'archived_by_a' : 'archived_by_b';
  const { error } = await supabase.from('conversations').update({ [myCol]: true }).eq('id', conv.id);
  if (error) { toast(error.message, 'error'); return; }
  toast('Archived', 'success');
  // Remove from list, close thread
  dmState.conversations = dmState.conversations.filter(x => x.id !== c.id);
  document.getElementById('dmBackBtn')?.click();
  renderConversationList();
}

async function confirmDeleteConversation() {
  const c = dmState.activeConv;
  if (!c) return;
  const ok = await confirmDialog({
    title: 'Delete this conversation?',
    body: 'All messages will be removed for both of you. This can\'t be undone.',
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  const { error } = await supabase.from('conversations').delete().eq('id', c.id);
  if (error) { toast(error.message, 'error'); return; }
  toast('Deleted', 'success');
  dmState.conversations = dmState.conversations.filter(x => x.id !== c.id);
  document.getElementById('dmBackBtn')?.click();
  renderConversationList();
}

async function confirmLeaveGroup() {
  const c = dmState.activeConv;
  if (!c?.isGroup) return;
  const ok = await confirmDialog({
    title: 'Leave this group?',
    body: 'You\'ll stop receiving messages and won\'t see new ones unless you\'re re-added.',
    confirmLabel: 'Leave',
  });
  if (!ok) return;
  const { error } = await supabase.rpc('leave_conversation', { p_conversation_id: c.id });
  if (error) { toast(error.message, 'error'); return; }
  toast('Left the group', 'success');
  dmState.conversations = dmState.conversations.filter(x => x.id !== c.id);
  document.getElementById('dmBackBtn')?.click();
  renderConversationList();
}

// Group settings modal — full parity with mobile's group-info screen.
// Creator-only manage affordances (rename, photo, add, kick); everyone
// can view + leave. Reuses follow-list-modal styles for the body since
// the row layout matches.
function showGroupMembersDialog() {
  const c = dmState.activeConv;
  if (!c?.isGroup) return;
  const isCreator = c.createdBy === currentUser.id || c.raw?.created_by === currentUser.id;
  closeAllModals('.modal-backdrop[data-modal="group-members"]');
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'group-members';

  // Sort members: creator first, then alphabetical by username.
  const creatorId = c.createdBy || c.raw?.created_by;
  const sortedMembers = [...c.members].sort((a, b) => {
    if (a.id === creatorId && b.id !== creatorId) return -1;
    if (b.id === creatorId && a.id !== creatorId) return 1;
    return (a.username || '').toLowerCase().localeCompare((b.username || '').toLowerCase());
  });

  const headerAvatar = c.avatarUrl
    ? `<img src="${escHTML(c.avatarUrl)}" alt=""/>`
    : `<span class="dm-avatar-initials">${initials(c.name || '?')}</span>`;

  modal.innerHTML = `
    <div class="modal-card group-info-modal">
      <div class="group-info-identity">
        <div class="group-info-avatar-wrap">
          <div class="group-info-avatar">${headerAvatar}</div>
          ${isCreator ? `
            <button class="group-info-avatar-edit" data-action="edit-avatar" title="Change group photo">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            </button>
            <input type="file" accept="image/*" id="groupInfoFile" style="display:none"/>
          ` : ''}
        </div>
        <div class="group-info-name-row">
          <h2 class="group-info-name" data-action="${isCreator ? 'edit-name' : ''}">
            ${escHTML(c.name || 'Group chat')}
            ${isCreator ? '<span class="group-info-pencil">✎</span>' : ''}
          </h2>
        </div>
        <p class="modal-sub">${c.memberCount} ${c.memberCount === 1 ? 'member' : 'members'}</p>
      </div>

      ${isCreator ? `
        <button class="group-info-add-row" data-action="add-members" type="button">
          <span class="group-info-add-icon">+</span>
          <span>Add members</span>
        </button>
      ` : ''}

      <div class="follow-list-body group-info-members-body">
        ${sortedMembers.map(m => {
          const isCreatorRow = m.id === creatorId;
          const isYou = m.id === currentUser.id;
          const showKick = isCreator && !isCreatorRow;
          return `
            <div class="follow-list-row">
              <button class="follow-list-avatar" data-uid="${m.id}">
                ${m.avatar_url ? `<img src="${escHTML(m.avatar_url)}"/>` : initials(m.username)}
              </button>
              <div class="follow-list-info">
                <button class="follow-list-name" data-uid="${m.id}">@${escHTML(m.username || '')}${isYou ? ' (You)' : ''}</button>
                ${isCreatorRow ? '<span class="group-info-creator-badge">Creator</span>' : ''}
              </div>
              ${showKick ? `<button class="group-info-kick" data-kick="${m.id}" title="Remove from group">×</button>` : ''}
            </div>
          `;
        }).join('')}
      </div>

      <div class="modal-actions">
        <button class="btn-danger" data-action="leave">Leave group</button>
        <button class="btn-ghost" data-action="cancel">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('[data-action="cancel"]').onclick = close;
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });

  // Member row → open profile.
  modal.querySelectorAll('.follow-list-avatar[data-uid], .follow-list-name[data-uid]').forEach(el => {
    el.onclick = () => { close(); openProfile(el.dataset.uid); };
  });

  // Inline rename — creator only.
  if (isCreator) {
    const nameEl = modal.querySelector('[data-action="edit-name"]');
    if (nameEl) {
      nameEl.style.cursor = 'pointer';
      nameEl.onclick = () => promptRenameGroup(c, modal);
    }
    const addBtn = modal.querySelector('[data-action="add-members"]');
    if (addBtn) addBtn.onclick = () => { close(); openAddMembersModal(c); };
    const editAvatarBtn = modal.querySelector('[data-action="edit-avatar"]');
    const fileInput = modal.querySelector('#groupInfoFile');
    if (editAvatarBtn && fileInput) {
      editAvatarBtn.onclick = () => fileInput.click();
      fileInput.onchange = (ev) => handleGroupAvatarPicked(ev, c, modal);
    }
    modal.querySelectorAll('.group-info-kick').forEach(btn => {
      btn.onclick = () => kickGroupMember(c, btn.dataset.kick, btn);
    });
  }

  modal.querySelector('[data-action="leave"]').onclick = () => { close(); confirmLeaveGroup(); };
}

// Inline rename — replaces the heading with an input + save button.
function promptRenameGroup(c, modal) {
  const newName = window.prompt('New group name', c.name || '');
  if (newName == null) return; // cancelled
  const trimmed = newName.trim().slice(0, 60);
  if (!trimmed) { toast('Name cannot be empty', 'error'); return; }
  if (trimmed === c.name) return;
  supabase.from('conversations').update({ name: trimmed }).eq('id', c.id)
    .then(({ error }) => {
      if (error) { toast(error.message || 'Could not rename', 'error'); return; }
      c.name = trimmed;
      if (c.raw) c.raw.name = trimmed;
      toast('Group renamed', 'success');
      modal.remove();
      // Reflect in list + thread header.
      const cached = dmState.conversations.find(x => x.id === c.id);
      if (cached) cached.name = trimmed;
      renderConversationList();
      const nameBtn = document.getElementById('dmThreadName');
      if (nameBtn) nameBtn.textContent = trimmed;
    });
}

// Avatar picker — uploads the picked file to Supabase Storage under
// group-avatars/<convId>/, then patches conversations.avatar_url.
async function handleGroupAvatarPicked(ev, c, modal) {
  const file = ev.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('Please pick an image', 'error');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    toast('Image too large (max 10MB)', 'error');
    return;
  }
  toast('Uploading…', '');
  try {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `group-avatars/${c.id}/${currentUser.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await supabase.storage.from('images').upload(path, file, {
      contentType: file.type || `image/${ext}`,
      cacheControl: '3600',
      upsert: false,
    });
    if (upErr) throw upErr;
    const { data } = supabase.storage.from('images').getPublicUrl(path);
    const url = data?.publicUrl;
    if (!url) throw new Error('Could not resolve uploaded URL');
    const { error: updErr } = await supabase.from('conversations').update({ avatar_url: url }).eq('id', c.id);
    if (updErr) throw updErr;

    // Reflect everywhere
    c.avatarUrl = url;
    if (c.raw) c.raw.avatar_url = url;
    const cached = dmState.conversations.find(x => x.id === c.id);
    if (cached) cached.avatarUrl = url;
    renderConversationList();
    const headerAv = document.getElementById('dmThreadAvatar');
    if (headerAv) headerAv.innerHTML = `<img src="${escHTML(url)}" alt=""/>`;
    toast('Group photo updated', 'success');
    modal.remove();
  } catch (err) {
    console.error('[dm] group avatar upload failed', err);
    toast(err?.message || 'Could not update photo', 'error');
  }
}

// Add members modal — search profiles excluding existing members, multi-
// select, on submit insert into conversation_participants.
function openAddMembersModal(c) {
  if (!c?.isGroup) return;
  const existingIds = new Set(c.members.map(m => m.id));
  closeAllModals('.modal-backdrop[data-modal="group-add"]');
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'group-add';
  modal.innerHTML = `
    <div class="modal-card dm-new-modal">
      <h2>Add members</h2>
      <p class="modal-sub">People already in the group are hidden from results.</p>
      <input type="text" class="dm-new-search" id="groupAddSearch" placeholder="Search by username…" autocomplete="off"/>
      <div class="dm-new-selected" id="groupAddSelected"></div>
      <div class="dm-new-results" id="groupAddResults">
        <div class="dm-new-hint">Start typing a username…</div>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" data-action="cancel">Cancel</button>
        <button class="btn-primary" data-action="add" disabled>Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('[data-action="cancel"]').onclick = close;
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });

  const selected = []; // [{id, username, avatar_url}]
  const search = modal.querySelector('#groupAddSearch');
  const selectedWrap = modal.querySelector('#groupAddSelected');
  const results = modal.querySelector('#groupAddResults');
  const addBtn = modal.querySelector('[data-action="add"]');

  const refreshSelected = () => {
    selectedWrap.innerHTML = selected.map(u => `
      <span class="dm-new-chip" data-uid="${u.id}">
        ${u.avatar_url ? `<img src="${escHTML(u.avatar_url)}"/>` : `<span class="dm-new-chip-init">${initials(u.username)}</span>`}
        <span>@${escHTML(u.username)}</span>
        <button class="dm-new-chip-x" aria-label="Remove">×</button>
      </span>
    `).join('');
    selectedWrap.querySelectorAll('.dm-new-chip-x').forEach((btn, i) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        selected.splice(i, 1);
        refreshSelected();
        addBtn.disabled = selected.length === 0;
      };
    });
  };

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    const q = search.value.trim();
    if (!q) { results.innerHTML = '<div class="dm-new-hint">Start typing a username…</div>'; return; }
    timer = setTimeout(async () => {
      const excludeIds = [...existingIds, ...selected.map(s => s.id)];
      let qb = supabase.from('profiles').select('id, username, avatar_url, is_guest').ilike('username', `%${q}%`).limit(20);
      if (excludeIds.length) qb = qb.not('id', 'in', `(${excludeIds.join(',')})`);
      const { data } = await qb;
      if (!data?.length) { results.innerHTML = '<div class="dm-new-hint">No matches.</div>'; return; }
      results.innerHTML = data.map(p => `
        <button class="dm-new-result" data-uid="${p.id}" type="button">
          <span class="dm-new-result-avatar">${p.avatar_url ? `<img src="${escHTML(p.avatar_url)}"/>` : initials(p.username)}</span>
          <span class="dm-new-result-name">@${escHTML(p.username || '')}</span>
        </button>
      `).join('');
      results.querySelectorAll('[data-uid]').forEach(btn => {
        btn.onclick = () => {
          const profile = data.find(p => p.id === btn.dataset.uid);
          if (!profile) return;
          if (selected.some(s => s.id === profile.id)) return;
          selected.push(profile);
          search.value = '';
          results.innerHTML = '<div class="dm-new-hint">Start typing a username…</div>';
          refreshSelected();
          addBtn.disabled = selected.length === 0;
        };
      });
    }, 200);
  });
  search.focus();

  addBtn.onclick = async () => {
    if (selected.length === 0) return;
    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';
    try {
      const rows = selected.map(s => ({ conversation_id: c.id, user_id: s.id }));
      const { error } = await supabase
        .from('conversation_participants')
        .upsert(rows, { onConflict: 'conversation_id,user_id', ignoreDuplicates: true });
      if (error) throw error;
      toast(`Added ${selected.length}`, 'success');
      close();
      // Refresh the active conv's members list + the conversations list.
      await refreshActiveConvMembers(c.id);
      renderConversationList();
    } catch (err) {
      console.error('[dm] add members failed', err);
      toast(err.message || 'Could not add members', 'error');
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
    }
  };
}

// Remove a member from a group. Creator-only — UI hides the X for
// non-creator viewers; this is the second line of defense in case the
// markup is tampered with.
async function kickGroupMember(c, userId, btnEl) {
  if (!c?.isGroup) return;
  if (c.createdBy && c.createdBy !== currentUser.id) {
    toast('Only the group creator can remove members', 'error');
    return;
  }
  if (userId === currentUser.id) {
    toast('Use Leave group to leave', 'error');
    return;
  }
  if (userId === c.createdBy) {
    toast('Cannot remove the group creator', 'error');
    return;
  }
  if (!window.confirm('Remove this member from the group?')) return;
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '…'; }
  const { error } = await supabase
    .from('conversation_participants')
    .delete()
    .eq('conversation_id', c.id)
    .eq('user_id', userId);
  if (error) {
    toast(error.message || 'Could not remove', 'error');
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '×'; }
    return;
  }
  toast('Removed', 'success');
  // Patch local state and re-render the modal.
  c.members = c.members.filter(m => m.id !== userId);
  c.memberCount = c.members.length;
  document.querySelector('.modal-backdrop[data-modal="group-members"]')?.remove();
  showGroupMembersDialog();
  renderConversationList();
}

// Re-fetch the active group's members after a mutation (add). Local
// state has the old list; we want the canonical server view.
async function refreshActiveConvMembers(convId) {
  const c = dmState.activeConv;
  if (!c || c.id !== convId) return;
  const { data: parts } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', convId);
  const memberIds = (parts || []).map(p => p.user_id);
  if (!memberIds.length) return;
  const { data: profs } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, is_guest')
    .in('id', memberIds);
  c.members = profs || [];
  c.memberCount = c.members.length;
  // Update the cached row in the conversations list too.
  const cached = dmState.conversations.find(x => x.id === convId);
  if (cached) {
    cached.members = c.members;
    cached.memberCount = c.memberCount;
  }
  // Refresh the open settings modal if the user's still looking at it.
  const openModal = document.querySelector('.modal-backdrop[data-modal="group-members"]');
  if (openModal) {
    openModal.remove();
    showGroupMembersDialog();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Mutuals helper — both directions of public.follows must exist.
// Mirrors lib/messages-supabase.js's isMutualFollow on mobile. One round-
// trip via the OR-of-AND postgrest filter; checks the result client-side
// for both edges.
// ─────────────────────────────────────────────────────────────────────────
async function dmIsMutualFollow(uuidA, uuidB) {
  if (!uuidA || !uuidB || uuidA === uuidB) return false;
  const { data, error } = await supabase
    .from('follows')
    .select('follower_id, following_id')
    .or(`and(follower_id.eq.${uuidA},following_id.eq.${uuidB}),and(follower_id.eq.${uuidB},following_id.eq.${uuidA})`);
  if (error) {
    console.warn('[dm] isMutualFollow failed:', error.message);
    return false;
  }
  const ab = (data || []).some(r => r.follower_id === uuidA && r.following_id === uuidB);
  const ba = (data || []).some(r => r.follower_id === uuidB && r.following_id === uuidA);
  return ab && ba;
}

// ─────────────────────────────────────────────────────────────────────────
// Get-or-create Secret 1:1. Direct DB calls on web (no parallel RPC yet).
// Parity with mobile's getOrCreateSecretConversation:
//   - Mutuals-only floor (throws if not mutual)
//   - Self-conversation rejected
//   - Canonical (smaller, larger) ordering for the unique-pair index
//   - Fully separate from non-Secret 1:1's (creating a Secret with someone
//     you already DM does NOT touch the existing thread)
// ─────────────────────────────────────────────────────────────────────────
async function dmGetOrCreateSecretConv(otherUserId) {
  if (!currentUser) throw new Error('Please sign in');
  if (!otherUserId || otherUserId === currentUser.id) {
    throw new Error('Cannot start a conversation with yourself');
  }
  const mutual = await dmIsMutualFollow(currentUser.id, otherUserId);
  if (!mutual) throw new Error('Both of you must follow each other to start a Secret chat');

  const [a, b] = currentUser.id < otherUserId
    ? [currentUser.id, otherUserId]
    : [otherUserId, currentUser.id];

  const lookup = async () => {
    const { data } = await supabase
      .from('conversations')
      .select('*')
      .eq('is_group', false)
      .eq('is_secret', true)
      .eq('user_a', a)
      .eq('user_b', b)
      .maybeSingle();
    return data;
  };

  const existing = await lookup();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      user_a: a,
      user_b: b,
      is_group: false,
      is_secret: true,
      created_by: currentUser.id,
      last_message_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (!error) return created.id;
  if (error.code === '23505') {
    // Race — another tab inserted first. Re-fetch.
    const winner = await lookup();
    if (winner) return winner.id;
  }
  throw error;
}

// ─────────────────────────────────────────────────────────────────────────
// Secret-chat picker modal — mutuals-only search. Reuses the structure of
// openNewConvModal but pre-filters profiles to your mutual followers.
// ─────────────────────────────────────────────────────────────────────────
async function openSecretChatPicker() {
  if (!currentUser) { toast('Please sign in', 'error'); return; }
  closeAllModals('.modal-backdrop[data-modal="dm-new-secret"]');

  // Pre-fetch mutual UUIDs once. Same trick as mobile's SupabaseNewChat.
  let mutualIds = null;
  try {
    const [iFollow, followsMe] = await Promise.all([
      supabase.from('follows').select('following_id').eq('follower_id', currentUser.id),
      supabase.from('follows').select('follower_id').eq('following_id', currentUser.id),
    ]);
    const aSet = new Set((iFollow.data || []).map(r => r.following_id));
    const bSet = new Set((followsMe.data || []).map(r => r.follower_id));
    mutualIds = [];
    for (const id of aSet) if (bSet.has(id)) mutualIds.push(id);
  } catch (e) {
    toast('Could not load mutuals', 'error');
    return;
  }

  // Pre-load up to 5 mutual profiles to render as a "Suggested" row of
  // avatar chips above the search input. Reduces friction for the common
  // case where you want to start a Secret chat with a frequent contact —
  // tapping an avatar skips the search entirely.
  let suggestedMutuals = [];
  if (mutualIds.length > 0) {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, avatar_url, is_guest')
        .in('id', mutualIds.slice(0, 50)) // upper bound for the IN list
        .order('username', { ascending: true })
        .limit(5);
      suggestedMutuals = data || [];
    } catch (e) {
      // Non-fatal — search still works.
      console.warn('[secret] suggested mutuals load failed', e?.message);
    }
  }
  const moreThanShown = mutualIds.length > suggestedMutuals.length;

  const suggestedHtml = suggestedMutuals.length > 0 ? `
    <div class="dm-secret-suggested">
      <div class="dm-secret-suggested-label">Suggested mutuals</div>
      <div class="dm-secret-suggested-row">
        ${suggestedMutuals.map(p => `
          <button class="dm-secret-suggested-chip" data-uid="${p.id}" data-username="${escHTML(p.username || '')}" type="button" title="@${escHTML(p.username || '')}">
            ${p.avatar_url ? `<img src="${escHTML(p.avatar_url)}" alt=""/>` : `<span class="dm-secret-suggested-initials">${initials(p.username)}</span>`}
          </button>
        `).join('')}
      </div>
      ${moreThanShown ? '<div class="dm-secret-suggested-more">Search below to find more mutuals.</div>' : ''}
    </div>` : '';

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'dm-new-secret';
  modal.innerHTML = `
    <div class="modal-card dm-new-modal">
      <h2>🔒 New Secret chat</h2>
      <p class="modal-sub">
        ${mutualIds.length === 0
          ? "You don't have any mutual followers yet. Both people must follow each other to start a Secret chat."
          : 'Pick a mutual follower. The chat is silent — no notifications.'}
      </p>
      ${mutualIds.length > 0 ? `
        ${suggestedHtml}
        <input type="text" class="dm-new-search" id="dmSecretSearch" placeholder="Search mutuals by username…" autocomplete="off"/>
        <div class="dm-new-results" id="dmSecretResults">
          <div class="dm-new-hint">Start typing a username…</div>
        </div>` : ''}
      <div class="modal-actions">
        <button class="btn-ghost" data-action="cancel">${mutualIds.length === 0 ? 'Close' : 'Cancel'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('[data-action="cancel"]').onclick = close;
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });
  if (mutualIds.length === 0) return;

  // Shared handler — used by both the suggested-mutuals chips and the
  // search-result rows. Both call dmGetOrCreateSecretConv and then jump
  // into the new conversation.
  const startSecretWith = async (uid, btnEl) => {
    if (!uid) return;
    if (btnEl) btnEl.disabled = true;
    try {
      const convId = await dmGetOrCreateSecretConv(uid);
      close();
      dmState.viewMode = 'secret';
      await loadConversationList();
      await openConversation(convId);
    } catch (err) {
      console.error('[dm] secret create failed', err);
      toast(err.message || 'Failed to start Secret chat', 'error');
      if (btnEl) btnEl.disabled = false;
    }
  };

  // Wire the suggested-mutuals chips
  modal.querySelectorAll('.dm-secret-suggested-chip').forEach((chip) => {
    chip.onclick = () => startSecretWith(chip.dataset.uid, chip);
  });

  const search = modal.querySelector('#dmSecretSearch');
  const results = modal.querySelector('#dmSecretResults');
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    const q = search.value.trim();
    if (!q) {
      results.innerHTML = '<div class="dm-new-hint">Start typing a username…</div>';
      return;
    }
    timer = setTimeout(async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, avatar_url, is_guest')
        .ilike('username', `%${q}%`)
        .in('id', mutualIds)
        .neq('id', currentUser.id)
        .limit(20);
      if (!data?.length) {
        results.innerHTML = '<div class="dm-new-hint">No matching mutuals.</div>';
        return;
      }
      results.innerHTML = data.map(p => `
        <button class="dm-new-result" data-uid="${p.id}" type="button">
          <span class="dm-new-result-avatar">${p.avatar_url ? `<img src="${escHTML(p.avatar_url)}"/>` : initials(p.username)}</span>
          <span class="dm-new-result-name">@${escHTML(p.username || '')}</span>
          <span class="dm-new-result-arrow">→</span>
        </button>
      `).join('');
      results.querySelectorAll('[data-uid]').forEach(btn => {
        btn.onclick = () => startSecretWith(btn.dataset.uid, btn);
      });
    }, 200);
  });
  search.focus();
}

// ── New conversation modal (1:1 OR group) ────────────────────────────────
document.getElementById('dmNewBtn')?.addEventListener('click', () => openNewConvModal());

// "+ Secret" header button — exposed if the page has a #dmNewSecretBtn
// element. The empty-Secret-tab CTA also reaches this via the wired
// button in renderConvEmptyStateHtml.
document.getElementById('dmNewSecretBtn')?.addEventListener('click', () => openSecretChatPicker());

function openNewConvModal() {
  if (!currentUser) { toast('Please sign in', 'error'); return; }
  closeAllModals('.modal-backdrop[data-modal="dm-new"]');
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.modal = 'dm-new';
  modal.innerHTML = `
    <div class="modal-card dm-new-modal">
      <h2>New message</h2>
      <p class="modal-sub">Pick one person for a 1:1 chat, or 2+ for a group.</p>
      <input type="text" class="dm-new-search" id="dmNewSearch" placeholder="Search users by username…" autocomplete="off"/>
      <div class="dm-new-selected" id="dmNewSelected"></div>
      <div class="dm-new-results" id="dmNewResults">
        <div class="dm-new-hint">Start typing a username…</div>
      </div>
      <div class="dm-new-name-wrap" id="dmNewNameWrap" style="display:none">
        <input type="text" class="dm-new-name" id="dmNewName" placeholder="Group name (optional)" maxlength="120"/>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" data-action="cancel">Cancel</button>
        <button class="btn-primary" data-action="create" disabled>Start chat</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const selectedUsers = []; // [{id, username, avatar_url}]
  const search = modal.querySelector('#dmNewSearch');
  const results = modal.querySelector('#dmNewResults');
  const selectedWrap = modal.querySelector('#dmNewSelected');
  const nameWrap = modal.querySelector('#dmNewNameWrap');
  const nameInput = modal.querySelector('#dmNewName');
  const createBtn = modal.querySelector('[data-action="create"]');

  const close = () => modal.remove();
  modal.querySelector('[data-action="cancel"]').onclick = close;
  modal.addEventListener('click', (ev) => { if (ev.target === modal) close(); });

  function refreshSelected() {
    selectedWrap.innerHTML = selectedUsers.map(u => `
      <span class="dm-new-chip" data-uid="${u.id}">
        ${u.avatar_url ? `<img src="${escHTML(u.avatar_url)}"/>` : `<span class="dm-new-chip-init">${initials(u.username)}</span>`}
        <span>@${escHTML(u.username)}</span>
        <button class="dm-new-chip-x" aria-label="Remove">×</button>
      </span>
    `).join('');
    selectedWrap.querySelectorAll('.dm-new-chip-x').forEach((btn, i) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const id = selectedUsers[i].id;
        const idx = selectedUsers.findIndex(u => u.id === id);
        if (idx >= 0) selectedUsers.splice(idx, 1);
        refreshSelected();
        updateButton();
      };
    });
    nameWrap.style.display = selectedUsers.length >= 2 ? '' : 'none';
  }
  function updateButton() {
    createBtn.disabled = selectedUsers.length === 0;
    createBtn.textContent = selectedUsers.length >= 2 ? 'Start group chat' : 'Start chat';
  }

  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = search.value.trim();
    if (!q) {
      results.innerHTML = '<div class="dm-new-hint">Start typing a username…</div>';
      return;
    }
    searchTimer = setTimeout(async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, username, avatar_url, is_guest')
        .ilike('username', `%${q}%`)
        .neq('id', currentUser.id)
        .limit(20);
      if (!data?.length) {
        results.innerHTML = '<div class="dm-new-hint">No users found.</div>';
        return;
      }
      results.innerHTML = data.map(p => `
        <button class="dm-new-result" data-uid="${p.id}" ${selectedUsers.some(u => u.id === p.id) ? 'data-already-selected="1"' : ''}>
          <span class="dm-new-result-avatar">${p.avatar_url ? `<img src="${escHTML(p.avatar_url)}"/>` : initials(p.username)}</span>
          <span class="dm-new-result-name">@${escHTML(p.username || '')}</span>
          ${selectedUsers.some(u => u.id === p.id) ? '<span class="dm-new-result-check">✓</span>' : ''}
        </button>
      `).join('');
      results.querySelectorAll('[data-uid]').forEach(btn => {
        btn.onclick = () => {
          const uid = btn.dataset.uid;
          const profile = data.find(p => p.id === uid);
          const idx = selectedUsers.findIndex(u => u.id === uid);
          if (idx >= 0) selectedUsers.splice(idx, 1);
          else selectedUsers.push(profile);
          refreshSelected();
          updateButton();
          search.dispatchEvent(new Event('input')); // re-render results with check state
        };
      });
    }, 200);
  });
  search.focus();

  createBtn.onclick = async () => {
    if (!selectedUsers.length) return;
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    try {
      let convId;
      if (selectedUsers.length === 1) {
        const { data, error } = await supabase.rpc('get_or_create_conversation', {
          p_other_user_id: selectedUsers[0].id,
        });
        if (error) throw error;
        convId = data;
      } else {
        const payload = {
          p_name: nameInput.value.trim() || '',
          p_participant_ids: selectedUsers.map(u => u.id),
        };
        const { data, error } = await supabase.rpc('create_group_conversation', payload);
        if (error) {
          console.error('[dm] create_group_conversation failed', error, 'payload:', payload);
          throw error;
        }
        if (!data) {
          console.error('[dm] create_group_conversation returned no id', { data });
          throw new Error('No conversation id returned from server');
        }
        convId = data;
      }
      if (!convId) throw new Error('Could not resolve conversation');
      close();
      await loadConversationList();
      await openConversation(convId);
    } catch (err) {
      console.error('[dm] create chat failed', err);
      toast(err.message || 'Failed to create chat', 'error');
      createBtn.disabled = false;
      createBtn.textContent = selectedUsers.length >= 2 ? 'Start group chat' : 'Start chat';
    }
  };
}

// ── Global search (across conversations + message bodies) ─────────────────
let _dmSearchTimer = null;
const _origSearchHandler = (e) => {
  // Replace the simple-filter behavior with debounced server search if length > 1
  const q = e.target.value.trim();
  clearTimeout(_dmSearchTimer);
  if (!q) {
    dmState.globalSearchResults = null;
    renderConversationList();
    return;
  }
  // Quick local filter first (instant feedback)
  document.querySelectorAll('.dm-conv-item').forEach(el => {
    const name = el.querySelector('.dm-conv-name')?.textContent.toLowerCase() || '';
    const preview = el.querySelector('.dm-conv-preview')?.textContent.toLowerCase() || '';
    el.style.display = (name.includes(q.toLowerCase()) || preview.includes(q.toLowerCase())) ? '' : 'none';
  });
  // Then debounced server message search
  _dmSearchTimer = setTimeout(async () => {
    const { data: hits } = await supabase
      .from('messages')
      .select('id, conversation_id, sender_id, body, created_at')
      .ilike('body', `%${q}%`)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(40);
    if (!hits?.length) return;
    renderGlobalSearchResults(hits, q);
  }, 280);
};
const dmSearchInput = document.getElementById('dmSearchInput');
if (dmSearchInput) {
  // Clear any prior listener by cloning & re-attaching is messier — just override behavior
  dmSearchInput.removeEventListener?.('input', dmSearchInput._dmHandler);
  dmSearchInput._dmHandler = _origSearchHandler;
  dmSearchInput.addEventListener('input', _origSearchHandler);
}

function renderGlobalSearchResults(hits, query) {
  const wrap = document.getElementById('dmConvList');
  if (!wrap) return;
  // Group hits by conversation
  const byConv = {};
  hits.forEach(h => {
    if (!byConv[h.conversation_id]) byConv[h.conversation_id] = [];
    byConv[h.conversation_id].push(h);
  });
  // Map convs we already have in state
  const convsById = new Map(dmState.conversations.map(c => [c.id, c]));
  const html = Object.entries(byConv).map(([cid, msgs]) => {
    const conv = convsById.get(cid);
    if (!conv) return '';
    const name = conv.isGroup ? conv.name : conv.otherUser?.username;
    return `
      <div class="dm-search-group">
        <div class="dm-search-group-name">${escHTML(name || 'Conversation')}</div>
        ${msgs.map(m => `
          <button class="dm-search-hit" data-conv="${cid}" data-msg="${m.id}">
            <span class="dm-search-hit-time">${timeAgo(m.created_at)}</span>
            <span class="dm-search-hit-body">${highlightSearchMatch(m.body, query)}</span>
          </button>
        `).join('')}
      </div>
    `;
  }).join('');
  wrap.innerHTML = `
    <div class="dm-search-results">
      ${html || '<div class="dm-empty-list"><h3>No matches</h3></div>'}
    </div>
  `;
  wrap.querySelectorAll('.dm-search-hit').forEach(el => {
    el.onclick = () => openConversation(el.dataset.conv);
  });
}

function highlightSearchMatch(body, query) {
  const text = (body || '').slice(0, 200);
  const safe = escHTML(text);
  const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  return safe.replace(re, '<mark>$1</mark>');
}

// ════════════════════════════════════════════════════════════════════════════
// DMs Phase 4 — image attachments (2.5 MB), GIF picker, emoji picker
// ════════════════════════════════════════════════════════════════════════════

const DM_MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;   // 2.5 MB
const DM_BUCKET = 'dm-attachments';

// ─── GIF picker key ───────────────────────────────────────────────────────
// Giphy API key from developers.giphy.com/dashboard. Free tier = 100k req/day.
// Public client-side use is the intended exposure — Giphy rate-limits per IP.
const DM_GIPHY_KEY = 'UYrH9t3qUegWfBNynMFTHL3uEHsySkSm';

let _dmPendingAttachment = null;   // { file, dataUrl, kind: 'upload' | 'gif', gifUrl }
let _dmAttachMenuEl = null;
let _dmGifPickerEl = null;
let _dmEmojiPickerEl = null;

// ── + (attach) button → small menu: Photo · GIF ───────────────────────────
function closeDmAttachMenu() {
  if (_dmAttachMenuEl) { _dmAttachMenuEl.remove(); _dmAttachMenuEl = null; }
}
document.getElementById('dmAttachBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (_dmAttachMenuEl) { closeDmAttachMenu(); return; }
  closeDmGifPicker();
  closeDmEmojiPicker();

  const btn = e.currentTarget;
  const menu = document.createElement('div');
  menu.className = 'dm-attach-menu';
  menu.innerHTML = `
    <button type="button" data-act="photo">
      <span class="dm-attach-icon">🖼</span><span>Photo</span>
    </button>
    <button type="button" data-act="gif">
      <span class="dm-attach-icon">GIF</span><span>GIF picker</span>
    </button>
  `;
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
  menu.style.left   = `${r.left}px`;
  _dmAttachMenuEl = menu;

  menu.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const act = b.dataset.act;
      closeDmAttachMenu();
      if (act === 'photo') document.getElementById('dmFileInput')?.click();
      else if (act === 'gif') openDmGifPicker();
    };
  });

  setTimeout(() => {
    const onDoc = (ev) => {
      if (!_dmAttachMenuEl?.contains(ev.target)) {
        closeDmAttachMenu();
        document.removeEventListener('click', onDoc);
      }
    };
    document.addEventListener('click', onDoc);
  }, 0);
});

// ── File picker → preview (with size check + JPEG compression for big photos) ──
document.getElementById('dmFileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // allow re-selecting same file later
  if (!file) return;

  // Hard reject anything way over the limit
  if (file.size > DM_MAX_IMAGE_BYTES * 4) {
    toast(`Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 2.5 MB.`, 'error');
    return;
  }

  let finalFile = file;
  // Compress non-GIF static images that are over the cap (GIFs lose animation if compressed)
  if (file.size > DM_MAX_IMAGE_BYTES && file.type !== 'image/gif') {
    try {
      finalFile = await compressImageToJpeg(file, DM_MAX_IMAGE_BYTES);
    } catch (err) {
      console.warn('[dm] compress failed, sending original', err);
    }
  }

  if (finalFile.size > DM_MAX_IMAGE_BYTES) {
    toast(`Image still ${(finalFile.size / 1024 / 1024).toFixed(1)} MB after compress. Try a smaller one (max 2.5 MB).`, 'error');
    return;
  }

  // Build a data-URL preview (for the composer's preview strip)
  const dataUrl = await fileToDataUrl(finalFile);
  _dmPendingAttachment = { file: finalFile, dataUrl, kind: 'upload' };
  showDmAttachPreview(dataUrl, finalFile.name, finalFile.size);
  updateSendButton();
});

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Canvas-based JPEG compression — reduces a photo to fit under maxBytes
async function compressImageToJpeg(file, maxBytes) {
  const dataUrl = await fileToDataUrl(file);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });

  // Step down quality until under cap (or stop at 0.5)
  let quality = 0.85;
  let scale = 1;
  // Cap dimensions at 1920px for sanity
  const maxDim = 1920;
  if (img.width > maxDim || img.height > maxDim) {
    scale = Math.min(maxDim / img.width, maxDim / img.height);
  }

  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(img.width  * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  for (let attempt = 0; attempt < 6; attempt++) {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob) break;
    if (blob.size <= maxBytes) {
      return new File([blob], (file.name.replace(/\.[^.]+$/, '') || 'image') + '.jpg', { type: 'image/jpeg' });
    }
    quality -= 0.12;
    if (quality < 0.5) break;
  }
  return file;
}

function showDmAttachPreview(src, name, size) {
  const wrap = document.getElementById('dmAttachPreview');
  document.getElementById('dmAttachPreviewImg').src = src;
  document.getElementById('dmAttachPreviewName').textContent = name || 'Image';
  document.getElementById('dmAttachPreviewSize').textContent = size ? `· ${formatBytes(size)}` : '';
  if (wrap) wrap.style.display = '';
}
function hideDmAttachPreview() {
  const wrap = document.getElementById('dmAttachPreview');
  if (wrap) wrap.style.display = 'none';
  _dmPendingAttachment = null;
  updateSendButton();
}
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
document.getElementById('dmAttachCancel')?.addEventListener('click', hideDmAttachPreview);

// ── Override sendDmMessage to handle attachments + GIFs ─────────────────
// Rather than re-declaring the function, we wrap upload logic into a helper
// that the existing sendDmMessage delegates to when an attachment is staged.
// We do this by hooking into the send button click before it runs sendDmMessage.
async function sendDmAttachment() {
  if (!dmState.activeConvId || !_dmPendingAttachment) return false;
  const att = _dmPendingAttachment;

  let imageUrl = null;
  let imageKind = att.kind;

  if (att.kind === 'gif') {
    imageUrl = att.gifUrl;
  } else {
    // Upload to Supabase Storage at {user_id}/{timestamp}-{name}
    const ext = (att.file.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const path = `${currentUser.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await supabase.storage.from(DM_BUCKET).upload(path, att.file, {
      contentType: att.file.type,
      cacheControl: '3600',
      upsert: false,
    });
    if (upErr) {
      console.error('[dm] upload failed', upErr);
      toast(upErr.message || 'Upload failed', 'error');
      return false;
    }
    const { data: urlData } = supabase.storage.from(DM_BUCKET).getPublicUrl(path);
    imageUrl = urlData?.publicUrl;
  }
  if (!imageUrl) { toast('Failed to attach image', 'error'); return false; }

  const input = document.getElementById('dmInput');
  const body = (input?.value || '').trim();
  const replyToId = dmState.replyingTo?.id || null;
  dmState.replyingTo = null;
  hideReplyPreview();

  // Optimistic render
  const tempId = 'temp-' + Date.now();
  dmState.messages.push({
    id: tempId,
    conversation_id: dmState.activeConvId,
    sender_id: currentUser.id,
    body: body || '',
    image_url: imageUrl,
    image_kind: imageKind,
    reply_to_id: replyToId,
    created_at: new Date().toISOString(),
    read_at: null,
    _pending: true,
  });
  hideDmAttachPreview();
  if (input) { input.value = ''; resizeDmInput(); updateSendButton(); }
  renderMessages();
  // Image/GIF I just sent → always pin so it lands in view.
  scrollMessagesToBottom({ force: true });

  const { data, error } = await supabase.from('messages').insert({
    conversation_id: dmState.activeConvId,
    sender_id: currentUser.id,
    body: body || ' ',     // body has a NOT-NULL/length constraint; one-space passes
    image_url: imageUrl,
    image_kind: imageKind,
    reply_to_id: replyToId,
  }).select().single();
  if (error) {
    dmState.messages = dmState.messages.filter(m => m.id !== tempId);
    _renderedMessageIds.delete(tempId);
    renderMessages();
    toast(error.message, 'error');
    return false;
  }
  // Replace temp with real — transfer the "already-rendered" status so the
  // bubble doesn't re-animate (would cause the whole list to flash).
  const idx = dmState.messages.findIndex(m => m.id === tempId);
  if (idx >= 0) dmState.messages[idx] = data;
  if (_renderedMessageIds.has(tempId)) {
    _renderedMessageIds.delete(tempId);
    _renderedMessageIds.add(data.id);
  }
  document.querySelectorAll(`[data-msg-id="${tempId}"]`).forEach(el => {
    el.dataset.msgId = data.id;
  });
  return true;
}

// Intercept the send button: if an attachment is pending, send it via the
// attachment path; otherwise fall through to the normal text send.
document.getElementById('dmSendBtn')?.addEventListener('click', (e) => {
  if (_dmPendingAttachment) {
    e.stopImmediatePropagation();
    sendDmAttachment();
  }
}, true);

// Also intercept Enter key in textarea when an attachment is staged
document.getElementById('dmInput')?.addEventListener('keydown', (e) => {
  if (_dmPendingAttachment && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    sendDmAttachment();
  }
}, true);

// ── GIF picker (Giphy) ───────────────────────────────────────────────────
function closeDmGifPicker() {
  if (_dmGifPickerEl) { _dmGifPickerEl.remove(); _dmGifPickerEl = null; }
}
async function openDmGifPicker() {
  if (_dmGifPickerEl) { closeDmGifPicker(); return; }
  closeDmEmojiPicker();
  closeDmAttachMenu();

  const composer = document.getElementById('dmComposer');
  if (!composer) return;
  const picker = document.createElement('div');
  picker.className = 'dm-gif-picker';
  picker.innerHTML = `
    <div class="dm-gif-header">
      <input type="text" class="dm-gif-search" placeholder="Search GIFs…" id="dmGifSearch"/>
      <button type="button" class="dm-gif-close" aria-label="Close">×</button>
    </div>
    <div class="dm-gif-grid" id="dmGifGrid">
      <div class="dm-gif-loading">Loading trending…</div>
    </div>
  `;
  document.body.appendChild(picker);
  // Position above composer
  const r = composer.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.bottom = `${window.innerHeight - r.top + 6}px`;
  picker.style.left   = `${r.left}px`;
  picker.style.width  = `${r.width}px`;
  _dmGifPickerEl = picker;

  picker.querySelector('.dm-gif-close').onclick = closeDmGifPicker;
  const search = picker.querySelector('#dmGifSearch');
  search.focus();

  // Initial: trending
  loadGifResults('', picker.querySelector('#dmGifGrid'));

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      loadGifResults(search.value.trim(), picker.querySelector('#dmGifGrid'));
    }, 250);
  });
}
async function loadGifResults(query, gridEl) {
  if (!gridEl) return;

  // No key configured → show setup instructions instead of empty results
  if (!DM_GIPHY_KEY) {
    gridEl.innerHTML = `
      <div class="dm-gif-setup">
        <div class="dm-gif-setup-icon">🔑</div>
        <h4>GIF picker needs an API key</h4>
        <p>Giphy's free public key was retired. Get your own (takes 3 min):</p>
        <ol>
          <li>Open <a href="https://developers.giphy.com/dashboard/" target="_blank" rel="noopener">developers.giphy.com</a></li>
          <li>Create an API-type app</li>
          <li>Copy your API key</li>
          <li>Paste it into <code>DM_GIPHY_KEY</code> in app.js</li>
        </ol>
        <p class="dm-gif-setup-note">Free tier: 100,000 requests/day.</p>
      </div>
    `;
    return;
  }

  gridEl.innerHTML = '<div class="dm-gif-loading">Loading…</div>';
  const endpoint = query
    ? `https://api.giphy.com/v1/gifs/search?api_key=${DM_GIPHY_KEY}&q=${encodeURIComponent(query)}&limit=24&rating=pg-13`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${DM_GIPHY_KEY}&limit=24&rating=pg-13`;
  try {
    const res = await fetch(endpoint);
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error('[dm] giphy non-OK', res.status, errBody);
      const friendlyMsg = res.status === 401 || res.status === 403
        ? 'Invalid Giphy API key — check the DM_GIPHY_KEY constant in app.js.'
        : `Giphy returned ${res.status}. Try again later.`;
      gridEl.innerHTML = `<div class="dm-gif-loading">${escHTML(friendlyMsg)}</div>`;
      return;
    }
    const json = await res.json();
    const gifs = json?.data || [];
    if (!gifs.length) {
      gridEl.innerHTML = '<div class="dm-gif-loading">No GIFs found</div>';
      return;
    }
    gridEl.innerHTML = gifs.map(g => {
      const preview = g.images?.fixed_height_small?.url || g.images?.fixed_height?.url || g.images?.original?.url;
      const send    = g.images?.fixed_height?.url   || g.images?.original?.url;
      if (!preview || !send) return '';
      return `<button class="dm-gif-tile" type="button" data-send="${escHTML(send)}" title="${escHTML(g.title || 'GIF')}">
        <img src="${escHTML(preview)}" alt="${escHTML(g.title || 'GIF')}" loading="lazy"/>
      </button>`;
    }).join('');
    gridEl.querySelectorAll('.dm-gif-tile').forEach(tile => {
      tile.onclick = () => sendDmGif(tile.dataset.send);
    });
  } catch (err) {
    console.error('[dm] giphy fetch failed', err);
    gridEl.innerHTML = `<div class="dm-gif-loading">Couldn't load GIFs — ${escHTML(err.message || 'network error')}</div>`;
  }
}
async function sendDmGif(gifUrl) {
  if (!gifUrl) return;
  closeDmGifPicker();
  _dmPendingAttachment = { file: null, dataUrl: gifUrl, kind: 'gif', gifUrl };
  await sendDmAttachment();
}

// ── Emoji picker ─────────────────────────────────────────────────────────
const DM_EMOJI_GROUPS = [
  { label: 'Smileys', emojis: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐'.split(' ') },
  { label: 'Gestures', emojis: '👍 👎 👏 🙌 🤝 🙏 👋 🤚 ✋ 🖐 ✊ 👊 🤛 🤜 🫶 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝ 💪 🦾'.split(' ') },
  { label: 'Hearts', emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 💖 💗 💓 💞 💕 💘 💝 💟'.split(' ') },
  { label: 'Animals', emojis: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦄 🐝'.split(' ') },
  { label: 'Food', emojis: '🍕 🍔 🍟 🌭 🥪 🌮 🌯 🥗 🍝 🍜 🍣 🍱 🍤 🍙 🍘 🍚 🍛 🍦 🍰 🎂 🍩 🍪 🍫 🍬 🍭 ☕ 🍺'.split(' ') },
  { label: 'Activities', emojis: '⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🏓 🏸 🥊 🎯 🎳 🎮 🎲 🎰 🎬 🎤 🎧 🎵 🎶 📚 ✏️ 📝 💻 📱'.split(' ') },
  { label: 'Travel', emojis: '✈️ 🚗 🚕 🚙 🚌 🚎 🏎 🚓 🚑 🚒 🚐 🚚 🚛 🚜 🏍 🛵 🚲 🛴 🛹 🚂 🚆 🚇 ⛵ 🛳 🚀'.split(' ') },
  { label: 'Symbols', emojis: '✨ 💫 ⭐ 🌟 💥 🔥 ⚡ 💧 🌈 ☀️ 🌙 🎉 🎊 🎁 🏆 🥇 ✅ ❌ ❗ ❓ 💯 ‼️ ⁉️ 💬 💭 🔔'.split(' ') },
];
function closeDmEmojiPicker() {
  if (_dmEmojiPickerEl) { _dmEmojiPickerEl.remove(); _dmEmojiPickerEl = null; }
}
document.getElementById('dmEmojiBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (_dmEmojiPickerEl) { closeDmEmojiPicker(); return; }
  closeDmGifPicker();
  closeDmAttachMenu();

  const trigger = e.currentTarget;
  const picker = document.createElement('div');
  picker.className = 'dm-emoji-picker';
  picker.innerHTML = DM_EMOJI_GROUPS.map(g => `
    <div class="dm-emoji-group">
      <div class="dm-emoji-label">${g.label}</div>
      <div class="dm-emoji-grid">
        ${g.emojis.map(em => `<button type="button" class="dm-emoji-cell" data-emoji="${escHTML(em)}">${em}</button>`).join('')}
      </div>
    </div>
  `).join('');
  document.body.appendChild(picker);

  const r = trigger.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.bottom = `${window.innerHeight - r.top + 8}px`;
  picker.style.right  = `${Math.max(8, window.innerWidth - r.right)}px`;
  _dmEmojiPickerEl = picker;

  picker.querySelectorAll('.dm-emoji-cell').forEach(cell => {
    cell.onclick = (ev) => {
      ev.stopPropagation();
      insertEmojiIntoComposer(cell.dataset.emoji);
    };
  });

  setTimeout(() => {
    const onDoc = (ev) => {
      if (!_dmEmojiPickerEl?.contains(ev.target) && ev.target !== trigger) {
        closeDmEmojiPicker();
        document.removeEventListener('click', onDoc);
      }
    };
    document.addEventListener('click', onDoc);
  }, 0);
});

function insertEmojiIntoComposer(emoji) {
  const input = document.getElementById('dmInput');
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end   = input.selectionEnd   ?? input.value.length;
  input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
  const newPos = start + emoji.length;
  input.setSelectionRange(newPos, newPos);
  input.focus();
  resizeDmInput();
  updateSendButton();
}
