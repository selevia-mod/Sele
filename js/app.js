import { supabase, REACTIONS, timeAgo, initials, callEdgeFunction, escHTML, toast } from './supabase.js';
import { initNotifications, teardownNotifications } from './notifications.js';
import { initScheduledPosts, refreshScheduledPostsBadge } from './scheduled-posts.js';
import { initComposer } from './composer.js';
import { initStudio, loadStudio } from './studio.js';
import { initProfile, openProfile, setViewingProfileId, refreshProfilePostsIfViewing } from './profile.js';
// Stage 10 — Search module. Owns the topbar search input (recent-searches
// dropdown, context-aware placeholder, debounced fan-out to feed/videos/
// books runners) + the People/Videos/Books/Posts dropdown for feed-context
// searches. Re-exports the 3 pure helpers (sanitize / escape / normalize)
// so videos.js + books.js + composer.js can keep passing them through
// their existing _cfg blocks without churn.
import {
  initSearch,
  sanitizeSearchQuery, escapeIlike, normalizeForSearch,
} from './search.js';
// Stage 11A — Earnings read/render. Module owns showEarnings +
// loadAuthorEarnings + breakdown drill-down + all balance/totals/list
// rendering. KYC subsystem (Stage 11B) and withdrawal request flow
// (Stage 11C) still live in app.js — bridged into earnings via _cfg.
import {
  initEarnings, showEarnings, loadAuthorEarnings,
  openEarningsBreakdown, closeEarningsBreakdown, _loadMoreEarningsBreakdown,
  formatPhpFromMinor,
  // Read-only getters for state that 11B (KYC handlers) + 11C (withdrawal
  // request) need until they're extracted. `resolveEarningsTitles` is
  // borrowed by the wallet-history block (Stage 13 territory).
  getAuthorBalance, getAuthorKyc, resolveEarningsTitles,
} from './earnings.js';
import {
  initVideos, showVideos, loadVideos, fetchSupabaseVideos,
  renderVideoCard, renderVideoResults, renderTagPills, runSearch,
  getWatchHistory, addToWatchHistory, getInterestProfile,
  getAllVideos, setAllVideos, findVideoInCache, addToVideosCache,
  getUploader, getUploaderCache, setUploader, invalidateAllVideosCache,
  getActiveSearchQuery, setActiveSearchQuery,
  getActiveTagFilter, setActiveTagFilter,
} from './videos.js';
// Stage 5 — Feed module. Owns the For You / Following feed (loadFeed +
// hybrid RPC + new-posts pill + post renderer + post action menu + share
// menu + repost + pin/hide). Six functions are re-attached to `window`
// below for inline onclick handlers in the rendered post HTML.
import {
  initFeed,
  loadFeed, loadStories, loadMoreFeed,
  renderPost, _renderHybridBookCarousel, _renderHybridVideoCard,
  _wireUpNewPosts, setupCollapsibleBodies,
  triggerPostLazyLoad, flushPostLazyLoad, attachHlsToPostVideo,
  closePostActionMenu, togglePinPost, shouldHidePost, hidePostFromFeed,
  _closePostDetailModal,
  _fetchHybridFeedPage, _buildAndExecFeedQuery,
  _prependFreshPosts, _applyNewPostsBuffer, _renderNewPostsPill, _pollForNewPosts,
  deletePost, openPostActionMenu, repostPost, toggleShareMenu, shareTo,
  FEED_SELECT,
  getFeedMode, setFeedMode,
  getFeedPostObserver, setFeedPostObserver,
  getFeedVideoObserver, setFeedVideoObserver,
  getNewPostsBuffer,
  getRealtimeRefreshTimer, setRealtimeRefreshTimer,
  getHasMoreFeedPosts,
  getCachedFollowIds,
  getFeedScrollObserver, setFeedScrollObserver,
} from './feed.js';
// Anti-fraud telemetry — fire-and-forget event logging used by the
// Phase 4 detection job. All four helpers are safe to call any time;
// signed-out callers short-circuit, network errors get swallowed.
import { registerSessionDevice, logRead, logView, getDeviceId } from './event-log.js';
// Floating Messages dock — Commit 1 of 2 (foundation). The dock UI itself
// renders nothing yet; only the shared data helpers + scoped state are
// live. Commit 2 will mount the launcher + inbox + mini-chat windows.
// Existing full-page Messages flow is intentionally untouched.
import {
  initMessagesDock, teardownMessagesDock,
  openMessagesDock, openMessagesDockToConv,
} from './messages-dock.js';
// Stage 8A — Books listing / discovery. Owns showBook + the four tabs
// (For You / Discover / Ranking / Reading List), the See-All sub-view,
// book search + writer-channel cards, normalization, and the
// recommendation rail. Stage 8B added: book detail page +
// chapter reader + reader watermark / anti-copy / nav-button wiring
// (under wireBookReader). Bookmarks dispatcher stays in app.js — it
// straddles videos + books and gets its own future module.
import {
  initBooks, wireBooksPage, wireBookReader,
  showBook, loadBooksTab, _openBookSeeAll,
  runBookSearch, prettyGenre, renderBookChips, loadBookRecommendations,
  fetchSupabaseBooks, fetchBooksServerSearch,
  renderBookCard, _renderBookCardV2, renderWriterChannelCard,
  _normalizeBookRow, _normalizeBookRows,
  openBookDetail, openChapterReader,
  toggleBookLike, toggleBookBookmark, loadBookActionState,
  applyReaderWatermark, flushReadClose,
  getActiveBookTab, setActiveBookTab,
  getActiveBookSearchQuery, setActiveBookSearchQuery,
  resetBooksSessionState,
} from './books.js';
// Stage 9A — Direct Messages core. Owns the full-page Messenger flow:
// conversation list, thread render, message send/edit/delete/react,
// realtime + presence + typing channels, inbox unread badge. The
// floating dock (messages-dock.js) factored out the shared data layer
// earlier; this is the full-page UI on top. Stage 9B (queued) moves the
// remaining extras — emoji picker, attach menu, GIF picker, secret
// lock IIFE, reply state, conv menu, group admin, search, mention
// dropdown. Until 9B, those still-in-app.js helpers read/write
// dmState + _renderedMessageIds via the live-binding exports.
import {
  initMessages,
  showMessages, openConversation, openConversationWithUser,
  loadConversationList, renderConversationList,
  loadMessages, renderMessages,
  sendDmMessage, sendDmThumbsUp,
  updateSendButton, resizeDmInput,
  scrollMessagesToBottom, isDmAtBottom,
  fetchReactionsForConversation,
  toggleReaction, deleteMessage,
  startEditMessage, saveEditMessage,
  openHoverMenu, closeHoverMenu,
  openReactionPicker, closeReactionPicker,
  copyMessageText,
  subscribeToThread, subscribeToPresenceAndTyping,
  updateThreadPresenceUI, broadcastTyping,
  subscribeToInbox,
  computeDmUnreadTotal, updateUnreadBadge, bootstrapDmBadge,
  dmState, _renderedMessageIds,
  // ─── Stage 9B exports ─────────────────────────────────────────
  // Functions used by app.js's DM page event-listener block (lines
  // ~13270+) and notification routing.
  openScopedEmojiPicker, insertEmojiIntoComposer, closeDmEmojiPicker,
  openNewConvModal, openSecretChatPicker, openAddMembersModal,
  closeConvMenu, openConvActionsMenu,
  archiveConversation, confirmDeleteConversation, confirmLeaveGroup,
  toggleConvMute, showGroupMembersDialog,
  startReplyToMessage, showReplyPreview, hideReplyPreview,
  closeMentionDropdown, maybeShowMentionDropdown, renderMentionDropdown, selectMention,
  handleMentionKeydown,
  closeDmAttachMenu, showDmAttachPreview, hideDmAttachPreview, sendDmAttachment,
  fileToDataUrl, compressImageToJpeg, formatBytes,
  closeDmGifPicker, openDmGifPicker, sendDmGif,
  renderDmLinkPreview, hydrateDmInternalPreviews,
  renderGlobalSearchResults, highlightSearchMatch,
  dmIsMutualFollow, dmGetOrCreateSecretConv,
  // Read-only IIFE export — SECRET_LOCK.isUnlocked() + .onVisibilityChange()
  // are called from app.js's secret-tab boot wiring at line ~13127.
  SECRET_LOCK,
  // Accessor pairs for 9B mutable state — app.js's DM page wiring
  // block reassigns these and ES module `let` exports are read-only on
  // the import side. Wrap reads/writes in get/set calls.
  // Follow-up: move the wiring block itself into a wireMessagesPage()
  // inside messages.js, the way Stage 8 did with wireBooksPage().
  getDmAttachMenuEl, setDmAttachMenuEl,
  getDmPendingAttachment, setDmPendingAttachment,
  getDmSearchTimer, setDmSearchTimer,
  // Codex P2/#213 — page-leave cleanup. Calls supabase.removeChannel on
  // realtime + presence subscriptions so they don't keep the connection
  // open in the background when the user navigates away from Messages.
  teardownActiveConversation,
} from './messages.js';

// Columns we actually use from the profiles table — explicit list cuts payload
// vs SELECT * (which pulls email, legacy ids, server-only fields, etc.).
const PROFILE_DISPLAY_COLS = 'id, username, display_name, avatar_url, bio, banner_url, location, website, is_guest, is_banned, role, pioneer_at, created_at';

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

// Exported as a live `let` binding (Stage 1, 2026-05-15). When this
// module reassigns currentUser (sign-in/sign-out), every other module
// that imported it sees the new value automatically. DON'T change to
// const or to a getter — both break the live binding.
export let currentUser = null;

// (flushReadClose moved into js/books.js as part of Stage 8B — it pairs
// with _readChapterOpenTs / _readChapterOpenId / _readChapterOpenBookId /
// _readMaxScrollPct, which all live in books.js now. The import at the
// top of this file makes it available to hideAllMainPages.)

// ── Anti-fraud telemetry state for the video player ───────────────────────
// Tracks the currently-playing video so we can emit play / pause / end
// events. The shared <video id="videoPlayer"> element handles every
// video, so we attach native event listeners ONCE on first init and
// read the live video id from the URL hash (#video/<id>) inside each
// handler. _videoEventsInit is the one-time flag.
let _videoEventsInit = false;
let _videoLastWatchedSec = 0;

function _currentLoggedVideoId() {
  // Reuses the same hash-route extractor the rest of the code uses
  // for #video/<id> deep links. Returns the bare UUID (no 'sb_' prefix).
  const id = (typeof _currentVideoIdForRoute === 'function')
    ? _currentVideoIdForRoute()
    : null;
  if (!id) return null;
  return id.startsWith('sb_') ? id.slice(3) : id;
}

function flushViewEnd() {
  const id = _currentLoggedVideoId();
  if (!id) return;
  logView({
    videoId:        id,
    kind:           'end',
    watchedSeconds: _videoLastWatchedSec,
  });
  _videoLastWatchedSec = 0;
}

function _initVideoEventLogging() {
  if (_videoEventsInit) return;
  const player = document.getElementById('videoPlayer');
  if (!player) return;
  _videoEventsInit = true;

  // play — fired on initial start AND on resume after pause.
  // Phase 4 detection cares about play-starts as a denominator for
  // threshold-crossed events (e.g. "what % of plays cross paywall?").
  player.addEventListener('play', () => {
    const id = _currentLoggedVideoId();
    if (!id) return;
    logView({
      videoId:        id,
      kind:           'play',
      watchedSeconds: Math.floor(player.currentTime || 0),
    });
  });

  // pause — fired on explicit pause + on navigation away (most
  // browsers fire pause before unload). Useful for partial-watch
  // dwell distributions in Phase 4.
  player.addEventListener('pause', () => {
    const id = _currentLoggedVideoId();
    if (!id) return;
    const ws = Math.floor(player.currentTime || 0);
    _videoLastWatchedSec = ws;
    // Don't emit 'pause' on the natural end — 'ended' will fire
    // separately and that's the more meaningful signal.
    if (player.ended) return;
    logView({ videoId: id, kind: 'pause', watchedSeconds: ws });
  });

  // ended — fired when playback reaches the natural end of the
  // video. Combined with the 'end' event in flushViewEnd (fired on
  // nav-away), this gives us both "watched to completion" and
  // "abandoned mid-stream" as distinct signals.
  player.addEventListener('ended', () => {
    const id = _currentLoggedVideoId();
    if (!id) return;
    const ws = Math.floor(player.currentTime || player.duration || 0);
    _videoLastWatchedSec = ws;
    logView({ videoId: id, kind: 'end', watchedSeconds: ws });
  });

  // timeupdate — fires ~4x/sec while playing. We DON'T log on every
  // tick (that'd be hundreds of events per video). Instead, just keep
  // _videoLastWatchedSec fresh so flushViewEnd has accurate dwell on
  // nav-away or hideAllMainPages.
  player.addEventListener('timeupdate', () => {
    _videoLastWatchedSec = Math.floor(player.currentTime || 0);
  });
}
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
  // Earnings hold knob — read by the Author Earnings card so the
  // "available in N days" copy stays in sync with whatever the SQL
  // app_config.author_earnings_hold_days is set to. Default 7 matches
  // the current production value (down from 14 on May 2026). Update
  // SQL → both web + mobile picks it up; no client deploy needed.
  author_earnings_hold_days:       7,
};
let _walletChannel = null;

// toast() moved to js/supabase.js (Stage 1 prep, 2026-05-15).
// Imported at the top of this file alongside supabase + timeAgo + initials.

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
  // Anti-fraud telemetry — register this device + IP on every sign-in
  // (including same-tab session re-init). Fire-and-forget. UPSERTs on
  // (user_id, device_id) so multiple registrations just refresh
  // last_seen; cost is one RPC ~100ms, doesn't block anything below.
  // See js/event-log.js for the full registerSessionDevice contract.
  registerSessionDevice();
  // Books page: invalidate user-scoped state (Reading List gate +
  // user-taste cache + recs cache) so a fresh sign-in re-fetches
  // instead of reusing the previous user's (or the signed-out) state.
  // The public listing pool stays — it's not user-scoped, no reason to
  // make the new user wait through another trending fetch.
  resetBooksSessionState();
  // Home: clear cache + restore skeletons so admin-only UI (the inline
  // "replace cover" pencil on home book cards) from the prior session
  // doesn't linger into a regular user's view.
  resetHomeSessionState();
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

  // Notifications — fetch initial batch + start realtime subscription.
  // Config-inject the current user getter + navigation functions so
  // notifications.js stays decoupled from app.js (no circular import).
  initNotifications({
    getCurrentUser: () => currentUser,
    nav: {
      profile:        openProfile,
      post:           openPostFromSearch,
      video:          playVideo,
      book:           openBookDetail,
      conversation:   openConversation,
      messages:       showMessages,
      feed:           showFeed,
      home:           showHomeLanding,
      earnings:       showEarnings,
      sidebarActive:  setSidebarActive,
    },
  });

  // Scheduled posts module — wires the "X scheduled" pill, modal, and
  // row-action handlers. Config-injected getCurrentUser so the module
  // reads live state without importing from app.js (Stage 2 pattern).
  // Fire-and-forget; the initial badge refresh happens inside init.
  initScheduledPosts({
    getCurrentUser: () => currentUser,
  });

  // Studio module — wires the creator-studio grid + edit/share modals +
  // monetize/delete/thumbnail flows. Config-injects what app.js owns:
  // currentUser getter, wallet config, thumbnail uploader, format
  // helpers, confirmDialog, the earnings nav, the allVideosCache reset,
  // and a refresh-feed-if-visible helper. loadStudio is exported so
  // showStudio (sidebar nav entry, still in app.js) can call it.
  initStudio({
    getCurrentUser:            () => currentUser,
    getWalletConfig:           () => _walletConfigDefaults,
    uploadThumbnail:           _vuUploadThumbnailFile,
    uploadImage,                                      // for share-modal photo attach (2026-05-15)
    formatPhpFromMinor,
    formatDuration,
    confirmDialog,
    showEarnings,
    invalidateAllVideosCache:  () => { invalidateAllVideosCache(); },
    refreshFeedIfVisible:      () => {
      if (feedEl && feedEl.style.display !== 'none') loadFeed();
    },
  });

  // Profile module — wires the profile page + edit modal + sub-tabs.
  // Stage 6 (2026-05-15) — widest injection surface yet (~24 callbacks).
  // openProfile is exported from profile.js + imported at top so existing
  // callers throughout app.js keep working.
  initProfile({
    getCurrentUser:           () => currentUser,
    getCurrentProfile:        () => currentProfile,
    setCurrentProfile:        (p) => { currentProfile = p; },
    getPosts:                 () => posts,
    setPosts:                 (arr) => { posts = arr; },
    PROFILE_DISPLAY_COLS,
    hideAllMainPages,
    stopVideoPlayer,
    scrollToTop,
    closeAllModals,
    closePostActionMenu,
    updateTopbarUser,
    setSidebarActive,
    // Codex audit 2026-05-16 — Stage 6 was calling these bare; profile.js
    // now reaches them through _cfg.
    openProfileActionMenu,
    closeProfileActionMenu,
    shouldHidePost,
    renderRoleSeal,
    renderPost,
    _wireUpNewPosts,
    setupCollapsibleBodies,
    renderVideoCard,
    renderBookCard,
    triggerPostLazyLoad,
    attachHlsToPostVideo,
    uploadImage,
    openCropModal,
    showMessages,
    tickGoalUnique,
    // Feed observers live in js/feed.js now (Stage 5); profile.js still
    // reads them when hydrating posts, so we pass the shared accessors
    // straight through (shorthand — imported names match the keys).
    getFeedPostObserver,
    getFeedVideoObserver,
    feedEl,
    storiesEl,
    composeEl,
  });

// ─── earnings.js (Stage 11A) ───────────────────────────────────
// Wires the Earnings page read/render layer. Bridges still here for
// the KYC subsystem (Stage 11B #250) and the withdrawal request flow
// (Stage 11C #251); both will become intra-module calls once those
// stages land in earnings.js.
initEarnings({
  getCurrentUser:           () => currentUser,
  getCurrentProfile:        () => currentProfile,
  getWalletConfig:          () => _walletConfigDefaults,
  setSidebarActive,
  hideAllMainPages,
});

// ─── search.js (Stage 10) ─────────────────────────────────────
// Wires the topbar input + recent-searches dropdown. Module-load-time
// listeners attach when search.js imports above; initSearch only injects
// cross-feature handles (currentUser getter, profile/post openers,
// videos/books runners + active-query setters).
initSearch({
  getCurrentUser:           () => currentUser,
  renderRoleSeal,
  openProfile,
  openPostFromSearch,
  // Result-click openers (Stage 10 smoke test fix #247)
  playVideo,
  openBookDetail,
  // Videos page search
  setActiveSearchQuery,
  runSearch,
  // Books page search
  setActiveBookSearchQuery,
  runBookSearch,
  getActiveBookTab,
});

// ─── videos.js (Stage 7A) ──────────────────────────────
initVideos({
  getCurrentUser:      () => currentUser,
  hideAllMainPages,
  stopVideoPlayer,
  playVideo,
  openProfile,
  getResumeTime,
  formatDuration,
  formatCompact,
  normalizeForSearch,
  sanitizeSearchQuery,
  escapeIlike,
});

// ─── books.js (Stage 8A — listing/discovery + Stage 8B — detail/reader) ─
// Both halves of the books surface now live in books.js. Detail page +
// chapter reader (8B) added: currentProfile getter (Editor's-Pick admin
// gate), wallet config getter (book_bulk_unlock_discount_pct read),
// unlock/paywall bridges (openUnlockDialog, openBulkBookUnlockDialog,
// isUnlocked, resolveUnlockCost — all shared with feed/videos), and
// engagement counters (tickGoalUnique, flushReadClose, logRead).
//
// `openBookDetail` is intentionally NOT in this object — it now lives
// in books.js (the import at the top of the file gives us access). The
// Stage 8A bridge that routed book cards through `_cfg.openBookDetail`
// becomes a direct intra-module call once books.js owns the function.
initBooks({
  // Identity
  getCurrentUser:           () => currentUser,
  getCurrentProfile:        () => currentProfile,

  // Navigation
  hideAllMainPages,
  stopVideoPlayer,
  openProfile,
  // (openBookDetail dropped from the bridge in Stage 8B Codex review —
  // it lives in books.js now, intra-module call, no bridge needed.)

  // Formatters + search-input sanitisers
  formatCompact,
  sanitizeSearchQuery,
  escapeIlike,
  normalizeForSearch,

  // CDN URL helpers (8A — used by _renderBookCardV2)
  _cleanCdnUrl,
  _supabaseRatioCrop,

  // ─ 8B bridges ─────────────────────────────────────────────────
  // Wallet config — books.js reads `_cfg.getWalletConfig().X` for the
  // bulk-unlock discount percentage. App.js owns the live object so
  // the realtime app_config subscription keeps everyone in sync.
  getWalletConfig:          () => _walletConfigDefaults,

  // Unlock / paywall — same surface as feed.js + videos.js.
  openUnlockDialog,
  openBulkBookUnlockDialog,
  isUnlocked,
  resolveUnlockCost,

  // Engagement counters + anti-fraud telemetry — chapter open ticks
  // the "Read N chapters" goal and emits a logRead open event.
  // flushReadClose lives inside books.js now (Stage 8B) — it owns the
  // open-state vars so there's no bridge needed for the close emit.
  tickGoalUnique,
  logRead,
});
// Page-level DOM wiring — split into two functions:
//   • wireBooksPage()  — listing tab clicks, See-All delegation, See-All back
//   • wireBookReader() — back-to-books, reader anti-copy IIFE, theme-toggle
//                        watermark sync, reader prev/next/font/back nav
// Both stay in books.js but get called from here so app.js remains the
// single place that decides "this runs at boot time".
wireBooksPage();
wireBookReader();

// ─── messages.js (Stage 9A — DM core) ──────────────────────
// Full-page Messenger UI on top of messages-dock.js's shared data layer.
// 9A's bridge surface is narrower than feed/books because most DM logic
// is self-contained (one canonical dmState object, internal helpers
// call siblings directly). The bridges below cover (a) cross-feature
// navigation (hideAllMainPages, openProfile, setSidebarActive,
// stopVideoPlayer), (b) shared dialogs (confirmDialog, closeAllModals,
// uploadImage), (c) shared formatters (formatCompact, linkify), and
// (d) Stage 9B-territory helpers that still live in app.js — emoji
// picker, attach menu, GIF picker, secret lock, reply state, conv
// menu, group admin, search, mention dropdown. Each 9B target gets a
// bridge entry so 9A code can call into it; when 9B lands the bridge
// drops and the call becomes intra-module.
initMessages({
  // Identity
  getCurrentUser:    () => currentUser,
  getCurrentProfile: () => currentProfile,

  // Navigation
  hideAllMainPages,
  openProfile,
  setSidebarActive,
  stopVideoPlayer,

  // Shared dialogs
  confirmDialog,
  closeAllModals,
  uploadImage,

  // Formatters
  formatCompact,
  linkify,

  // The ONLY 9B-era bridge that survived — firstUrlInText is shared
  // with the general feed renderLinkPreview (which stays in app.js)
  // so messages.js's renderDmLinkPreview can't import it without a
  // cycle. Every other 9B bridge dropped because the function moved
  // into messages.js alongside its callers (emoji picker, attach
  // menu, GIF picker, secret lock IIFE, reply state, conv menu,
  // group admin, mention dropdown, DM link preview).
  firstUrlInText,
  // Two more bridges caught in the Codex Stage 9 review pass:
  //   • openReportUserModal — shared with post/video/profile reports
  //   • renderLinkPreview   — the general feed link-preview renderer,
  //     called by sendDmMessage's optimistic non-internal URL rendering
  openReportUserModal,
  renderLinkPreview,
});

// ─── feed.js (Stage 5) ──────────────────────────────────
// Widest config surface yet (~25 callbacks) because feed touches
// everything: navigation, unlocks, dialogs, formatters, the shared
// posts[] array, the last-seen-at watermark, role seals, and the
// profile-tab refresher. All injections are getter/setter pairs where
// the value is mutable — that keeps app.js the single source of truth
// for state that other modules (composer, profile) also mutate.
initFeed({
  // Identity / session
  getCurrentUser:               () => currentUser,
  getCurrentProfile:            () => currentProfile,

  // Navigation / page switching
  hideAllMainPages,
  setSidebarActive,
  openProfile,
  openBookDetail,
  openChapterReader,
  playVideo,
  // openPostDetail is in the _cfg default surface as a no-op — the
  // modal opener doesn't actually exist as a top-level fn in app.js
  // (the post-detail modal is handled elsewhere by event delegation).
  closeAllModals,

  // Dialogs / prompts
  confirmDialog,
  uploadImage,
  openUnlockDialog,
  showStore,

  // Unlock / paywall
  isUnlocked,
  resolveUnlockCost,

  // Engagement counters / goals
  tickGoal,
  tickGoalUnique,
  loadReactions,
  loadCommentCount,
  loadComments,

  // Search / read-close
  flushReadClose,
  getActiveSearchQuery,

  // Formatters
  formatCompact,
  formatDuration,

  // Shared posts[] — owned by app.js, also mutated by composer + profile.
  getPosts:                     () => posts,
  setPosts:                     (arr) => { posts = arr; },

  // Last-seen-at watermark + bumper used by the new-posts pill.
  getFeedLastSeenAt:            () => _feedLastSeenAt,
  setFeedLastSeenAt:            (ts) => { _feedLastSeenAt = ts; },
  _bumpFeedLastSeenAt,

  // Role / verified seal renderer (top-level fn in app.js).
  renderRoleSeal,

  // Profile-tab refresher after pin/unpin.
  refreshProfilePostsIfViewing,

  // Pagination + filter-aware over-fetch + scroll observer setup. All
  // three live in app.js because they're referenced by app.js code paths
  // outside the feed (composer, realtime channel, scroll-restore).
  FEED_PAGE_SIZE,
  _feedFetchLimitWithFilters,
  setupFeedInfiniteScroll,

  // Lazy-load + view-tracking + row-processing helpers (app.js internals
  // that touch wider state — videos cache, view observer, content filters).
  setupFeedLazyLoaders,
  _ensureViewObserver,
  _processFeedRows,
  _feedFriendlyError,
  _formatDuration,
  _getWebBookPool,

  // Bulk loaders for reactions + comment counts (single roundtrip per page).
  bulkLoadReactions,
  bulkLoadCommentCounts,

  // Body-text linkifier + link-preview renderer.
  linkify,
  renderLinkPreview,

  // Background poller control (paired with visibilitychange listener).
  _startFeedPolling,
  _stopFeedPolling,

  // Author safety actions + cross-page invalidation hooks.
  openReportModal,
  blockAuthor,
  snoozeAuthor,
  invalidateAllVideosCache,
  loadVideos,

  // User content filter sets (hidden/snoozed/blocked) — read by shouldHidePost.
  getUserContentFilters: () => userContentFilters,
  // Whether the videos page is currently the visible main pane (deletePost
  // uses this to decide whether to refresh the videos grid post-deletion).
  // videosPage is a top-level const document.getElementById('videosPage').
  isVideosPageVisible: () => videosPage?.style.display === 'block',
  // Repost target — app.js owns the modal submit handler that reads it.
  setRepostTargetId: (id) => { repostTargetId = id; },
});

// Re-attach the six post-card handlers to window so inline onclick=""
// attributes in renderPost / openPostActionMenu's rendered HTML resolve
// at user-click time. ESM module scope isn't reachable from inline event
// attributes; window is. (Same pattern as Stage 7B's playVideo, Stage 8's
// openBookDetail, etc.)
window.loadFeed = loadFeed;
window.deletePost = deletePost;
window.openPostActionMenu = openPostActionMenu;
window.repostPost = repostPost;
window.toggleShareMenu = toggleShareMenu;
window.shareTo = shareTo;

  // Composer module — wires the textbox / image preview / schedule
  // popover / submit handler. Config-injects everything it needs from
  // app.js: currentUser getter, image uploader, FEED_SELECT constant,
  // and two callbacks for the "post created" hand-off (one for success,
  // one for the rare RPC-succeeded-but-refetch-empty safety net).
  // Stage 3 pattern: composer.js imports ONLY from supabase.js +
  // scheduled-posts.js. The injected callbacks let it stay decoupled
  // from app.js's internal posts[] array + render fns.
  initComposer({
    getCurrentUser: () => currentUser,
    uploadImage,
    feedSelect: FEED_SELECT,
    onPostCreated: (post) => {
      // Dedup: if the post somehow already lives in posts[] (rapid
      // re-clicks past the composer's _submitting guard, or a realtime
      // INSERT that beat the optimistic prepend), skip the prepend so
      // we don't double-render the card.
      if (post?.id && posts.some(p => p?.id === post.id)) return;
      posts = [post, ...posts];
      const feedEl = document.getElementById('feed');
      if (feedEl) {
        const el = renderPost(post);
        el.style.animationDelay = '0s';
        feedEl.insertBefore(el, feedEl.firstChild);
        _wireUpNewPosts(feedEl);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      _bumpFeedLastSeenAt([post]);
    },
    onPostCreateFallback: () => loadFeed(),
  });

  // ─── messages-dock.js (Commit 1 of 2) ──────────────────────────────
  // Foundation only — shared data helpers + scoped state are live, no
  // visible UI yet. Commit 2 will mount #dmFloatingRoot and render the
  // launcher / inbox / mini chats. Wired now so the import isn't dead
  // and so smoke testing surfaces any boot-order issues early.
  initMessagesDock({
    getCurrentUser:        () => currentUser,
    getCurrentProfile:     () => currentProfile,  // for launcher avatar
    openScopedEmojiPicker,      // shared picker — used by mini-chats
    openProfile,
    showMessages,               // hand-off to full-page Messages
    closeAllModals,
    uploadImage,                // for + button + drag-drop attach
  });

  // Daily-goal: tick "Log in today". Dedupe key is the date so
  // multiple signed-in sessions in one calendar day count ONCE.
  // Mirrors mobile at context/global-provider.js:325. Wrapped in
  // try/catch — never let a goal hiccup break sign-in.
  try {
    const today = _periodKeyDaily();
    tickGoalUnique('login', `daily-login:${today}`);
  } catch {}

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
    // openBookDetail canonicalizes the URL via replaceState so it
    // matches whatever path shape it loaded under. The optional
    // { chapter } hint deep-link-opens the matching chapter once the
    // chapters list resolves (Stage 8B Codex P1 — was set as
    // _pendingChapterFromUrl but never read).
    if (bookChapterPath) {
      openBookDetail(bookId, { chapter: bookChapterPath[2] });
    } else {
      openBookDetail(bookId);
    }
    // RETURN here — without this we'd fall through to the no-hash
    // default branch below and call showHomeLanding(), which hides
    // the detail page we just opened. (Codex P1.) Path-based deep
    // links own the route on their own.
    return;
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
    // Default destination on fresh page load (no deep link hash) —
    // the curated home landing. Pre-May-2026 this just called
    // loadFeed() which kept the default-visible feed shell, so refresh
    // always landed on the post feed even with Home highlighted.
    // Now we explicitly route to the landing surface so the sidebar
    // state and visible content agree.
    setSidebarActive('btnHome');
    showHomeLanding();
    // Preload the feed silently so clicking Post afterwards is instant.
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
  // Notifications — _notifChannel moved into js/notifications.js as part
  // of Stage 1 (2026-05-15). We call the exported teardown so the same
  // cleanup happens, without app.js reaching across modules for a private.
  teardownNotifications();
  // DMs (inbox + per-thread + presence)
  if (typeof dmState !== 'undefined' && dmState) {
    teardown(dmState.inboxChannel);      dmState.inboxChannel = null;
    teardown(dmState.realtimeChannel);   dmState.realtimeChannel = null;
    teardown(dmState.presenceChannel);   dmState.presenceChannel = null;
  }
  // Floating dock — tears down any open mini-chat subscriptions + clears
  // the openThreads Map. No-op if Commit 2 hasn't rendered anything yet.
  teardownMessagesDock();

  await supabase.auth.signOut();

  // Reset all user-scoped state — leaving stale data in memory was causing
  // the next signed-in user to briefly see the previous user's wallet/profile.
  currentUser = null;
  currentProfile = null;
  posts = [];
  _wallet = { coin_balance: 0, star_balance: 0 };
  _userUnlocks.clear();
  // Reset books-module session state — public listing pool + per-tab gates
  // + user-taste cache + recs cache. clearPublic:true so memory is fully
  // released on sign-out. (Stage 8A pre-Codex used `typeof X !== 'undefined'`
  // guards that silently returned undefined in an ES module — Codex P1
  // catch. Moved into the books.js owner module so the next mover
  // doesn't have to re-derive what's user-scoped.)
  resetBooksSessionState({ clearPublic: true });
  // Home: same reset on sign-out so cached data + DOM (including the
  // admin pencil) is fully released. Next showHomeLanding() will trigger
  // a fresh loadHomeVideos and the skeletons paint immediately.
  resetHomeSessionState();
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
    markUnlocked(u.target_type, u.target_id);
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

// Normalize an unlock target id BEFORE storing or looking up in _userUnlocks.
// Codex audit (2026-05-16, bug #192): videos can carry either a bare
// Supabase UUID or an 'sb_<uuid>' prefixed id depending on which call path
// produced them — playVideo() uses the prefixed form for the player but
// strips it down to the bare uuid (`sbId`) before passing to isUnlocked /
// unlock_content. If we store one shape and look up the other, isUnlocked
// returns false after a successful unlock and the paywall re-shows.
// Everything is normalized to the bare server id here.
function normalizeUnlockTargetId(targetType, targetId) {
  const id = String(targetId || '');
  if (targetType === 'video' && id.startsWith('sb_')) return id.slice(3);
  return id;
}

// Always add to _userUnlocks through this — keeps the key shape consistent
// with what isUnlocked() will look up later.
function markUnlocked(targetType, targetId) {
  const normalized = normalizeUnlockTargetId(targetType, targetId);
  _userUnlocks.add(`${targetType}:${normalized}`);
}

// Has the current user unlocked this content?
function isUnlocked(targetType, targetId) {
  const normalized = normalizeUnlockTargetId(targetType, targetId);
  return _userUnlocks.has(`${targetType}:${normalized}`);
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

  // Close gate — same in-flight protection as the bulk dialog. The
  // user can't dismiss while a charge is mid-RPC.
  const close = () => {
    if (_unlockInFlight) return;
    modal.classList.remove('open');
    setTimeout(() => modal.remove(), 180);
  };
  modal.querySelector('.unlock-modal-close').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelectorAll('.unlock-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      if (_unlockInFlight) return; // a sibling button is already firing
      const currency = btn.dataset.cur;
      btn.classList.add('is-loading');
      // Disable BOTH currency buttons while the first one is in flight.
      // Closes the "tap coin then immediately tap star" race that
      // could fire two parallel RPCs before either response landed.
      modal.querySelectorAll('.unlock-option').forEach(b => { b.disabled = true; });
      _unlockInFlight = true;
      let data = null, error = null;
      try {
        const res = await supabase.rpc('unlock_content', {
          p_target_type: targetType,
          p_target_id:   targetId,
          p_currency:    currency,
        });
        data = res.data; error = res.error;
      } finally {
        _unlockInFlight = false;
        btn.classList.remove('is-loading');
      }
      if (error) {
        // Re-enable both buttons so the user can retry / switch currency.
        modal.querySelectorAll('.unlock-option').forEach(b => { if (!b.classList.contains('is-disabled')) b.disabled = false; });
        _handleUnlockFailure(error, {
          target_type: targetType,
          target_id: targetId,
          currency,
          balance_at_attempt: currency === 'coin' ? _wallet.coin_balance : _wallet.star_balance,
        });
        return;
      }
      if (!data?.ok) {
        modal.querySelectorAll('.unlock-option').forEach(b => { if (!b.classList.contains('is-disabled')) b.disabled = false; });
        _handleUnlockFailure(data, {
          target_type: targetType,
          target_id: targetId,
          currency,
          balance_at_attempt: currency === 'coin' ? _wallet.coin_balance : _wallet.star_balance,
        });
        return;
      }
      // Local state update (Realtime will also push, but this avoids the flicker)
      if (currency === 'coin') _wallet.coin_balance = data.balance_after;
      else                     _wallet.star_balance = data.balance_after;
      markUnlocked(targetType, targetId);
      renderTopbarCoinPill();
      close();
      toast(data.already_unlocked ? 'Already unlocked' : `Unlocked! −${data.cost} ${currency}${data.cost === 1 ? '' : 's'}`, 'success');
      // Weekly/monthly goal: tick "Unlock N items". Skip the
      // already_unlocked branch (data.already_unlocked === true means
      // server didn't charge — no new engagement). Dedupe by
      // target so re-buying the same unlock can't farm. Mirrors
      // mobile at lib/book-unlocks-supabase.js:39.
      if (!data.already_unlocked) {
        try { tickGoalUnique('unlock', `unlock:${targetType}:${targetId}`); } catch {}
      }
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
          markUnlocked('video', sbId);
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
        // Modal closed without payment. Pause so the user has to re-engage;
        // on next play, listener re-fires and re-prompts.
        //
        // We do NOT reset modalOpen synchronously. player.pause() doesn't
        // take effect immediately — the browser typically fires one or two
        // more 'timeupdate' events before the pause settles. If modalOpen
        // flipped to false now, those queued events would see the gate
        // clear + currentTime still past the threshold (nextThreshold
        // doesn't advance on cancel by design) and open a fresh modal
        // immediately. Scrubbing past N thresholds amplifies this into
        // needing N taps to dismiss — once per timeupdate that fires
        // before pause settles. (Bug report 2026-05-16: tap forward 15
        // min → 2 taps to close; 30 min → 3 taps.)
        //
        // Instead: keep modalOpen=true while paused (listener can't fire
        // anyway, so the guard is harmless) and clear it on the next
        // 'play' event — at which point we WANT the listener to re-prompt.
        try { player.pause(); } catch {}
        player.addEventListener('play', () => { modalOpen = false; }, { once: true });
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
  // Scope the monet paywall to the video player wrap, not the whole page.
  // The upfront `#videoPaywall` got this treatment in fix #196, but the
  // time-based gate (this dynamically-created modal) was still being
  // appended to document.body, inheriting `position: fixed; inset: 0`
  // from .unlock-modal-backdrop — so it covered the entire screen instead
  // of just the player. Mount inside .video-player-wrap and override the
  // positioning in CSS (.video-monet-backdrop block) to position absolute.
  // Falls back to body if the wrap can't be found (defensive).
  const monetParent = document.querySelector('#videoPlayerPage .video-player-wrap') || document.body;
  monetParent.appendChild(modal);
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

// ── Unlock error interpretation + recovery (May 2026, Pass B) ───────
//
// Single source of truth for unlock error code → user-facing copy.
// Mirrors mobile's lib/unlock-error-codes.js exactly — keep both
// sides in sync. When a new error code lands anywhere in the unlock
// stack, add a row here AND in mobile.
//
// Each entry: { title, message, recoverable, kind }
//   recoverable — true if the user can fix it (retry, top up, contact support)
//   kind        — 'coin' | 'star' | 'account' (drives the support-ticket form)
const _UNLOCK_ERROR_REGISTRY = {
  not_authenticated: { title: 'Reconnecting your account', message: "We're still connecting your account. Please try again in a moment — if the problem keeps happening, sign out and sign back in.", recoverable: true, kind: 'account' },
  insufficient_balance: { title: 'Not enough balance', message: "You don't have enough to unlock this. Top up in the Store and try again.", recoverable: true, kind: 'coin' },
  insufficient_coins: { title: 'Not enough coins', message: "You don't have enough coins to unlock this. Top up in the Store and try again.", recoverable: true, kind: 'coin' },
  insufficient_stars: { title: 'Not enough stars', message: "You don't have enough stars to unlock this. Earn more from the Goals tab or top up in the Store, then try again.", recoverable: true, kind: 'coin' },
  wallet_missing: { title: 'Setting up your wallet', message: "We're finalizing your wallet. Please try again in a few seconds. If the issue persists, we'll restore it manually within 24 hours.", recoverable: true, kind: 'coin' },
  cost_unresolved: { title: 'Pricing temporarily unavailable', message: "We couldn't load the unlock price. Please refresh the screen and try again.", recoverable: true, kind: 'coin' },
  // May 2026 — added to match mobile registry (lib/unlock-error-codes.js).
  // unlock_content emits `invalid_cost` when a chapter has NULL/<=0
  // pricing for the requested currency (author didn't set a price).
  invalid_cost: { title: 'Pricing missing for this chapter', message: "The author hasn't set a price for this chapter yet. Try a different chapter or contact support and we'll fix it within 24 hours.", recoverable: true, kind: 'coin' },
  // unlock_book_bulk equivalent — bulk pricing missing on the book row.
  invalid_book_cost: { title: 'Bulk pricing missing', message: "The author hasn't set a whole-book price yet. You can still unlock individual chapters, or contact support and we'll resolve it within 24 hours.", recoverable: true, kind: 'coin' },
  invalid_currency: { title: 'Unlock unavailable', message: 'Something went wrong with the payment type. Please refresh and try again.', recoverable: true, kind: 'coin' },
  invalid_target_type: { title: 'Unlock unavailable', message: "This item can't be unlocked right now. Please refresh and try again.", recoverable: false, kind: 'coin' },
  invalid_target_id: { title: 'Item not found', message: "We couldn't find this chapter or book. It may have been removed by the author.", recoverable: false, kind: 'coin' },
  book_not_found: { title: 'Book not found', message: "We couldn't find this book. It may have been removed.", recoverable: false, kind: 'coin' },
  no_locks_on_book: { title: 'Already free to read', message: "This book doesn't have any locked chapters — you can start reading right away.", recoverable: false, kind: 'coin' },
  kyc_not_approved: { title: 'Verify your account first', message: 'Please complete your Payment Info before unlocking content.', recoverable: true, kind: 'account' },
  // Alias: withdrawal RPC + future paywall paths emit `kyc_required` while
  // the registry historically used `kyc_not_approved`. Same user-facing copy.
  kyc_required: { title: 'Verify your account first', message: 'Please complete your Payment Info before unlocking content.', recoverable: true, kind: 'account' },
  network: { title: 'Connection issue', message: "We couldn't reach our servers. Check your connection and try again.", recoverable: true, kind: 'coin' },
  rate_limited: { title: 'Slow down a moment', message: "You're going a little fast. Please wait a few seconds and try again.", recoverable: true, kind: 'coin' },
  // Wrapper-thrown errors — see _interpretUnlockError's message-string
  // matchers below. These come from client-side helpers when a legacy
  // hex id can't be resolved to a Supabase UUID.
  cannot_resolve_chapter: { title: 'Chapter not ready', message: "This chapter isn't fully synced yet. Please refresh the book and try again.", recoverable: true, kind: 'coin' },
  cannot_resolve_book: { title: 'Book not ready', message: "This book isn't fully synced yet. Please refresh and try again.", recoverable: true, kind: 'coin' },
};

// Translate any unlock failure shape (server JSON, thrown Error, raw
// string) into a uniform UI object. Always returns a populated object.
// Currency-aware: `insufficient_balance` + payload currency
// dispatches to `insufficient_coins` / `insufficient_stars`.
function _interpretUnlockError(input, ctx = {}) {
  const rawCode = (() => {
    if (!input) return 'unknown';
    if (typeof input === 'string') return input;
    if (typeof input === 'object') {
      if (typeof input.error === 'string') return input.error;
      if (typeof input.message === 'string') {
        // Collapse long wrapper-thrown messages into registry codes
        // (matches mobile lib/unlock-error-codes.js:213-220). Without
        // these matchers, the raw error message becomes the lookup key
        // and falls through to the generic 'Unlock failed' fallback.
        const m = input.message.toLowerCase();
        if (m.includes('cannot resolve chapter')) return 'cannot_resolve_chapter';
        if (m.includes('cannot resolve book')) return 'cannot_resolve_book';
        if (m.includes('network') || m.includes('fetch')) return 'network';
        if (m.includes('not signed in') || m.includes('not authenticated')) return 'not_authenticated';
        return input.message;
      }
    }
    return String(input);
  })();
  let lookupCode = rawCode;
  if (rawCode === 'insufficient_balance') {
    const cur = ctx.currency || input?.currency;
    if (cur === 'coin' || cur === 'coins') lookupCode = 'insufficient_coins';
    else if (cur === 'star' || cur === 'stars') lookupCode = 'insufficient_stars';
  }
  const entry = _UNLOCK_ERROR_REGISTRY[lookupCode];
  if (!entry) {
    console.warn('[unlock] unmapped error code', rawCode, ctx);
    return { title: 'Unlock failed', message: "We couldn't complete the unlock. Please try again.", recoverable: true, kind: 'coin', rawCode };
  }
  return { ...entry, rawCode };
}

// File a support ticket against the recovery queue. Server-side
// per-day dedup prevents spam if the user retries multiple times.
// Best-effort: any error here is logged and swallowed (we never want
// to surface "recovery filing failed" on top of the original
// unlock failure that triggered it).
async function _submitUnlockRecoveryRequest({ kind, amount, reason, context }) {
  try {
    const { error } = await supabase.rpc('submit_balance_recovery_request', {
      p_kind: kind,
      p_reported_amount: kind === 'account' ? 1 : Math.max(1, Math.round(Number(amount) || 1)),
      p_reason: reason || null,
      p_context: context || {},
      p_actor_id: currentUser?.id || null,
    });
    if (error) console.warn('[unlock] auto-file recovery failed:', error.message);
  } catch (e) {
    console.warn('[unlock] auto-file recovery exception:', e?.message || e);
  }
}

// Centralized failure handler — toast the friendly message, log the
// raw code, auto-file a support ticket for recoverable non-balance
// failures (the user can't fix a wallet_missing or cost_unresolved
// themselves, so we want admin eyes on it). Mirrors mobile's
// components/BookChaptersUnlockModal.jsx:893-939.
function _handleUnlockFailure(errorOrResult, context) {
  const ui = _interpretUnlockError(errorOrResult, context);
  toast(ui.message, 'error');
  console.error('[unlock] failure:', { code: ui.rawCode, ...context });
  // Don't auto-file for insufficient-* (user just needs to top up)
  // or hard-data errors (no_locks_on_book — not actually a failure).
  const shouldFile = ui.recoverable
    && ui.rawCode !== 'insufficient_balance'
    && ui.rawCode !== 'insufficient_coins'
    && ui.rawCode !== 'insufficient_stars'
    && ui.rawCode !== 'no_locks_on_book';
  if (shouldFile && currentUser?.id) {
    _submitUnlockRecoveryRequest({
      kind: ui.kind === 'account' ? 'account' : (context?.currency === 'star' ? 'star' : 'coin'),
      amount: context?.cost || 1,
      reason: [
        `Unlock failed: ${ui.rawCode}`,
        context?.target_type && context?.target_id ? `Target: ${context.target_type}/${context.target_id}` : null,
        context?.currency ? `Currency: ${context.currency}` : null,
        typeof context?.balance_at_attempt === 'number' ? `Balance at attempt: ${context.balance_at_attempt}` : null,
      ].filter(Boolean).join('\n'),
      context: { source: 'web_unlock', ...context },
    });
  }
}

// Diagnostic: after a successful bulk unlock, re-read the user's
// unlocks rows and warn loudly if the count we expected didn't land.
// Mirrors mobile's lib/book-unlocks-supabase.js:79-121 — the
// diagnostic that caught the May 2026 revert-on-refresh bug. Pure
// observability, doesn't gate any UX. If a mismatch hits production
// telemetry, admins see it before users complain.
async function _verifyBulkUnlockPersistence(bookId, expectedUnlocksCount) {
  try {
    // Pull all this user's chapter-level unlocks for the book.
    // Bulk RPC writes chapter rows (one per locked chapter), so the
    // count comparison is direct.
    const { data: bookRow } = await supabase
      .from('books').select('id').eq('id', bookId).maybeSingle();
    if (!bookRow) return;
    const { data: chapters } = await supabase
      .from('chapters').select('id').eq('book_id', bookId);
    const chapterIds = (chapters || []).map(c => c.id);
    if (chapterIds.length === 0) return;
    const { data: unlockRows } = await supabase
      .from('unlocks')
      .select('target_id')
      .eq('user_id', currentUser.id)
      .eq('target_type', 'chapter')
      .in('target_id', chapterIds);
    const persisted = (unlockRows || []).length;
    if (persisted < expectedUnlocksCount) {
      console.warn(
        `[unlock-bulk] PERSISTENCE-MISMATCH book=${bookId}: server said ${expectedUnlocksCount} chapters unlocked, but only ${persisted} unlock rows are visible to the client. Real-money bug — investigate.`,
        { user_id: currentUser?.id, bookId, expected: expectedUnlocksCount, persisted },
      );
    }
  } catch (e) {
    // Verification is best-effort — never fail the unlock UX on it.
    console.warn('[unlock-bulk] verify exception:', e?.message || e);
  }
}

// ── Unlock state guard (May 2026 — real-money correctness fix) ──────
//
// Module-level boolean that's set the moment ANY unlock RPC fires
// and cleared in finally. Used by openUnlockDialog +
// openBulkBookUnlockDialog to short-circuit click handlers and
// modal-close attempts while a charge is in flight.
//
// The exposure this closes: tapping "coin" then "star" on the same
// unlock modal within ~50ms (before the first RPC's response lands)
// could fire two parallel RPCs. The server's `unlock_content` is
// idempotent per (user, target_type, target_id) so the same target
// won't double-charge — but a coin charge AND a star charge for the
// same target in flight at once IS a real exposure. This flag
// blocks the second tap before it gets to the network.
let _unlockInFlight = false;

// Ask the server for the authoritative bulk-unlock totals. Returns
// `{ coin: number, star: number }` on success, or `null` if either
// preview RPC fails — in which case the caller falls back to the
// client-computed estimate. Mirrors mobile's
// lib/wallet-supabase.js:253-285 (previewBookBulkUnlock).
//
// Rationale: web previously computed the bulk discount client-side
// (Math.max(1, sum - Math.floor(sum * pct / 100))) and sent the
// result to unlock_book_bulk, hoping the server agreed. If the
// discount % gets bumped server-side OR rounding behaves differently
// than expected, the user could see one price and get charged
// another. Asking the server for the price BEFORE rendering the
// modal eliminates that drift.
async function _previewBookBulkUnlock(bookId) {
  try {
    const [coinRes, starRes] = await Promise.all([
      supabase.rpc('preview_book_bulk_unlock', { p_book_id: bookId, p_currency: 'coin' }),
      supabase.rpc('preview_book_bulk_unlock', { p_book_id: bookId, p_currency: 'star' }),
    ]);
    if (coinRes.error || starRes.error) {
      console.warn('[bulk-preview] RPC failed; falling back to client estimate',
        coinRes.error?.message, starRes.error?.message);
      return null;
    }
    const coin = coinRes.data?.total_after ?? coinRes.data?.cost ?? null;
    const star = starRes.data?.total_after ?? starRes.data?.cost ?? null;
    if (coin == null || star == null) {
      console.warn('[bulk-preview] RPC returned no total; falling back to client estimate', coinRes.data, starRes.data);
      return null;
    }
    return { coin, star };
  } catch (e) {
    console.warn('[bulk-preview] exception; falling back to client estimate', e);
    return null;
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
          <!-- Hint repeats the locked-chapter count next to the
               action so the user sees exactly what they're paying
               for. Mirrors mobile's BookChaptersUnlockModal pattern
               of placing the count inside each option button rather
               than relying on the modal subtitle alone. -->
          <span class="unlock-option-hint">${canCoin ? `Unlock all ${lockedCount} part${lockedCount === 1 ? '' : 's'}` : `You have ${_wallet.coin_balance}`}</span>
        </button>
        <div class="unlock-or">or</div>
        <button class="unlock-option unlock-option-star ${canStar ? '' : 'is-disabled'}" data-cur="star" ${canStar ? '' : 'disabled'}>
          <span class="unlock-option-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 2l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16l-5.6 3.2 1.5-6.3L3 8.7l6.4-.5z" fill="#a855f7"/></svg>
          </span>
          <span class="unlock-option-cost">${starCost}</span>
          <span class="unlock-option-label">Star${starCost === 1 ? '' : 's'}</span>
          <span class="unlock-option-hint">${canStar ? `Unlock all ${lockedCount} part${lockedCount === 1 ? '' : 's'}` : `You have ${_wallet.star_balance}`}</span>
        </button>
      </div>
      ${(!canCoin && !canStar) ? '<p class="unlock-need-more">Not enough coins or stars yet. Open the Store to top up.</p>' : ''}
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('open'));

  // Refresh displayed prices with the server-authoritative totals
  // BEFORE the user can tap. If the preview RPC fails, the client
  // estimates we rendered above stay put as a graceful fallback.
  _previewBookBulkUnlock(bookId).then((server) => {
    if (!server) return;
    const coinEl  = modal.querySelector('.unlock-option-coin .unlock-option-cost');
    const starEl  = modal.querySelector('.unlock-option-star .unlock-option-cost');
    const coinLbl = modal.querySelector('.unlock-option-coin .unlock-option-label');
    const starLbl = modal.querySelector('.unlock-option-star .unlock-option-label');
    if (coinEl) coinEl.textContent = server.coin;
    if (starEl) starEl.textContent = server.star;
    if (coinLbl) coinLbl.textContent = `Coin${server.coin === 1 ? '' : 's'}`;
    if (starLbl) starLbl.textContent = `Star${server.star === 1 ? '' : 's'}`;
    // Re-evaluate affordability against the server price — the
    // displayed totals might be ₱X.XX different from the client
    // estimate, which could flip a button from enabled to disabled.
    const canCoinServer = _wallet.coin_balance >= server.coin;
    const canStarServer = _wallet.star_balance >= server.star;
    const coinBtn = modal.querySelector('.unlock-option-coin');
    const starBtn = modal.querySelector('.unlock-option-star');
    [[coinBtn, canCoinServer, _wallet.coin_balance], [starBtn, canStarServer, _wallet.star_balance]].forEach(([btn, can, bal]) => {
      if (!btn) return;
      btn.disabled = !can;
      btn.classList.toggle('is-disabled', !can);
      const hint = btn.querySelector('.unlock-option-hint');
      if (hint) hint.textContent = can
        ? `Unlock all ${lockedCount} part${lockedCount === 1 ? '' : 's'}`
        : `You have ${bal}`;
    });
    // Cache server totals on the modal so the click handler can use
    // the same number the user just saw (no race between paint and tap).
    modal.dataset.coinCost = String(server.coin);
    modal.dataset.starCost = String(server.star);
  });

  // Close gate — blocked while an unlock RPC is in flight so we
  // never tear down the modal mid-charge.
  const close = () => {
    if (_unlockInFlight) return;
    modal.classList.remove('open');
    setTimeout(() => modal.remove(), 180);
  };
  modal.querySelector('.unlock-modal-close').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelectorAll('.unlock-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      if (_unlockInFlight) return; // guard: a sibling button is already firing
      const currency = btn.dataset.cur;
      btn.classList.add('is-loading');
      // Disable BOTH buttons + the close while in flight — the user
      // shouldn't be able to switch currency or escape mid-charge.
      modal.querySelectorAll('.unlock-option').forEach(b => { b.disabled = true; });
      _unlockInFlight = true;
      let data = null, error = null;
      try {
        const res = await supabase.rpc('unlock_book_bulk', {
          p_book_id:  bookId,
          p_currency: currency,
        });
        data = res.data; error = res.error;
      } finally {
        _unlockInFlight = false;
        btn.classList.remove('is-loading');
      }
      if (error) {
        // Re-enable both buttons so the user can retry / pick the other currency.
        modal.querySelectorAll('.unlock-option').forEach(b => { if (!b.classList.contains('is-disabled')) b.disabled = false; });
        _handleUnlockFailure(error, {
          target_type: 'book',
          target_id: bookId,
          currency,
          balance_at_attempt: currency === 'coin' ? _wallet.coin_balance : _wallet.star_balance,
          locked_count: lockedCount,
        });
        return;
      }
      if (!data?.ok) {
        modal.querySelectorAll('.unlock-option').forEach(b => { if (!b.classList.contains('is-disabled')) b.disabled = false; });
        _handleUnlockFailure(data, {
          target_type: 'book',
          target_id: bookId,
          currency,
          balance_at_attempt: currency === 'coin' ? _wallet.coin_balance : _wallet.star_balance,
          locked_count: lockedCount,
        });
        return;
      }
      // Update local state — Realtime will push too, but avoid flicker.
      if (currency === 'coin') _wallet.coin_balance = data.balance_after;
      else                     _wallet.star_balance = data.balance_after;
      // Refresh unlocks set from server (cheaper than refetching all)
      const { data: unlocks } = await supabase.from('unlocks')
        .select('target_type, target_id').eq('user_id', currentUser.id);
      _userUnlocks.clear();
      for (const u of (unlocks || [])) markUnlocked(u.target_type, u.target_id);
      renderTopbarCoinPill();
      close();
      const saved = data.cost_before_discount - data.cost;
      toast(`Unlocked ${data.chapters_unlocked} chapter${data.chapters_unlocked === 1 ? '' : 's'} — saved ${saved} ${currency}${saved === 1 ? '' : 's'}`, 'success');
      // Weekly/monthly goal: tick "Unlock N items". Dedupe by book id
      // so re-clicking the bulk unlock (already-unlocked → no-op data
      // from server) doesn't farm. Mirrors mobile at
      // lib/book-unlocks-supabase.js:127.
      try { tickGoalUnique('unlock', `unlock:book:${bookId}`); } catch {}
      // Persistence verification — fire-and-forget. If the server
      // said "12 chapters unlocked" but only 10 unlock rows are
      // visible afterward, this logs a PERSISTENCE-MISMATCH warning
      // to the console for our telemetry to pick up. Production
      // mismatches mean real money was charged without the unlock
      // landing. Mirrors mobile's diagnostic at
      // lib/book-unlocks-supabase.js:79-121.
      const expected = Number(data.chapters_unlocked) || 0;
      if (expected > 0) _verifyBulkUnlockPersistence(bookId, expected);
      if (typeof onUnlocked === 'function') onUnlocked();
    });
  });
}

// Topbar pill click → open Store
document.getElementById('topbarCoinPill')?.addEventListener('click', () => showStore());

// ── Earnings page (Phase 7 — own sidebar entry, tabs) ────────────────────
// ── Earnings page (Phase 7 — own sidebar entry, tabs) ────────────────────
// showEarnings + switchEarningsTab + boot listeners MOVED to js/earnings.js
// (Stage 11A). The earnings module wires its own .earnings-tab + btnEarnings
// listeners at module-load time. App.js still imports showEarnings for the
// notification routing (nav.earnings) + Studio Share modal hand-off.

// (Admin KYC tab moved to admin.html / js/admin.js — that's the
// dedicated admin shell with Payouts → KYC review. This page is
// creator-facing only.)


// Month picker change listener MOVED to js/earnings.js (Stage 11A) —
// it references _selectedMonthYear + _renderMonthScopedBreakdown, both
// module-private to earnings now.

// Breakdown drill-down — wire tile clicks (delegated to the page so
// even if the tiles re-render the binding survives), the back
// button, and the "Load more" pager. Mirrors mobile.
document.getElementById('earningsPage')?.addEventListener('click', (e) => {
  const tile = e.target.closest?.('[data-breakdown-category]');
  if (tile) {
    openEarningsBreakdown(tile.dataset.breakdownCategory, tile.dataset.breakdownLabel || 'Earnings');
  }
});
document.getElementById('earningsBreakdownBack')?.addEventListener('click', () => closeEarningsBreakdown());
document.getElementById('btnEarningsBreakdownMore')?.addEventListener('click', () => _loadMoreEarningsBreakdown());

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

// ── Wallet history (May 2026 — canonical ledger version) ───────────
//
// Reads directly from `coin_transactions` / `star_transactions`, the
// authoritative wallet ledgers that every balance-mutating RPC
// already writes to. Each row carries:
//   • delta         signed integer (+credit / −debit)
//   • balance_after wallet balance immediately after the txn
//   • type          categorical ('unlock_chapter', 'unlock_video',
//                                 'unlock_book_bulk', 'admin_adjust',
//                                 'withdrawal_request', etc.)
//   • reference_type + reference_id  polymorphic source pointer
//   • metadata      jsonb with kind-specific extras (chapter_count,
//                                                     period, period_key,
//                                                     reason)
//
// Replaces last night's reconstruction-from-three-tables approach
// (which couldn't show debit amounts because the `unlocks` table
// doesn't store costs). The ledger HAS the cost on every row.
async function loadWalletHistory(currency) {
  if (!currentUser) return [];
  const cur = currency === 'star' ? 'star' : 'coin';
  const table = cur === 'star' ? 'star_transactions' : 'coin_transactions';

  const { data, error } = await supabase
    .from(table)
    .select('id, delta, balance_after, type, reference_type, reference_id, metadata, created_at')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.warn(`[wallet-history] ${table} fetch failed:`, error.message);
    return [];
  }
  const rows = data || [];
  console.log(`[wallet-history] ${table} fetched`, rows.length, 'rows');

  // Resolve titles for unlock debit rows (chapter / video / book).
  // The existing resolveEarningsTitles helper handles all three.
  // We map the ledger's reference_type → the resolver's source_type:
  //   chapter → chapter, video → video, book → book_bulk
  // (the resolver caches under "book_bulk:" for whole-book lookups).
  const titleLookupInput = [];
  for (const r of rows) {
    if (r.delta >= 0) continue;        // credits don't need titles
    if (!r.reference_type || !r.reference_id) continue;
    const refType =
      r.reference_type === 'book' ? 'book_bulk' :
      r.reference_type === 'chapter' ? 'chapter' :
      r.reference_type === 'video' ? 'video' :
      null;
    if (!refType) continue;
    titleLookupInput.push({ source_type: refType, source_id: r.reference_id });
  }
  const titles = titleLookupInput.length
    ? await resolveEarningsTitles(titleLookupInput)
    : new Map();

  // Map ledger rows → display events.
  const events = [];
  for (const r of rows) {
    // delta = 0 rows are pure audit (e.g., withdrawal_request) —
    // skip from the user-facing list. They're still useful for
    // admins reading the table directly.
    if (r.delta === 0) continue;

    const direction = r.delta > 0 ? 'credit' : 'debit';
    const amount = Math.abs(r.delta);
    let title = '';
    let sub = '';

    switch (r.type) {
      case 'unlock_chapter':
        title = titles.get(`chapter:${r.reference_id}`) || 'Chapter unlock';
        sub = 'Chapter unlock';
        break;
      case 'unlock_video':
        title = titles.get(`video:${r.reference_id}`) || 'Video unlock';
        sub = 'Video unlock';
        break;
      case 'unlock_book_bulk': {
        const chapterCount = r.metadata?.chapter_count;
        const bookTitle = titles.get(`book_bulk:${r.reference_id}`) || 'a book';
        title = chapterCount
          ? `Bulk unlock — ${chapterCount} chapter${chapterCount === 1 ? '' : 's'} from ${bookTitle}`
          : `Bulk unlock — ${bookTitle}`;
        sub = 'Whole book unlock';
        break;
      }
      case 'admin_adjust': {
        const reason = r.metadata?.reason;
        if (r.reference_type === 'goal_pool_claim' || reason === 'goal_pool_claim') {
          const period = r.metadata?.period;
          title = _walletHistoryClaimTitle(period);
          sub = r.metadata?.period_key || 'Goal pool claim';
        } else if (r.reference_type === 'balance_recovery' || reason === 'balance_recovery') {
          title = 'Balance restored';
          sub = 'Approved recovery request';
        } else {
          title = 'Admin adjustment';
          sub = reason || r.reference_type || '';
        }
        break;
      }
      case 'purchase':
      case 'coin_purchase':
      case 'iap_purchase':
      case 'hitpay_purchase':
        title = 'Store top-up';
        sub = r.metadata?.package_name
          || r.metadata?.product_id
          || (r.reference_type === 'hitpay' ? 'HitPay purchase' : 'In-app purchase');
        break;
      case 'withdrawal_request':
        // Usually delta=0 (filtered above). If non-zero, it's the
        // settle moment when funds actually leave the wallet.
        title = 'Withdrawal';
        sub = 'Payout to bank';
        break;
      case 'ad_reward':
        title = 'Star earned';
        sub = 'Rewarded ad';
        break;
      default:
        // Unknown type — surface it verbatim so we notice in dev.
        title = String(r.type || 'Wallet event').replace(/_/g, ' ');
        sub = r.reference_type || '';
    }

    events.push({
      kind: r.type,
      direction,
      amount,
      currency: cur,
      title,
      sub,
      at: r.created_at,
      balance_after: r.balance_after,
    });
  }
  return events;
}

function _walletHistoryClaimTitle(period) {
  if (period === 'daily')   return 'Daily goal pool claim';
  if (period === 'weekly')  return 'Weekly goal pool claim';
  if (period === 'monthly') return 'Monthly goal pool claim';
  return 'Goal pool claim';
}

// Compact, two-piece timestamp: "9:55 AM" + (date, when not today/yesterday).
// Date grouping lives at the section-header level so individual rows
// only need the time. Returns { primary, secondary }:
//   • primary   — short time ("9:55 AM")
//   • secondary — relative day for older rows ("Mar 14" or "Mar 14, 2025"
//                 when not in current year); blank for today / yesterday
function _formatWalletHistoryTime(iso) {
  if (!iso) return { primary: '—', secondary: '' };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { primary: '—', secondary: '' };

  const primary = d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
  });

  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (sameDay || isYesterday) return { primary, secondary: '' };

  const secondary = d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return { primary, secondary };
}

// Group key + display label for date section headers. Keeps the
// wallet history list visually segmented so the eye can scan blocks
// instead of an undifferentiated wall of rows.
function _walletHistoryDateKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { key: 'unknown', label: 'Unknown date' };

  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return { key: 'today', label: 'Today' };

  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return { key: 'yesterday', label: 'Yesterday' };
  }

  const dayDiff = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (dayDiff < 7) {
    return {
      key: d.toDateString(),
      label: d.toLocaleDateString('en-US', { weekday: 'long' }),
    };
  }

  if (d.getFullYear() === now.getFullYear()) {
    return {
      key: d.toDateString(),
      label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    };
  }
  return {
    key: d.toDateString(),
    label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  };
}

async function openWalletHistory(currency) {
  const cur = currency === 'star' ? 'star' : 'coin';
  const modal = document.getElementById('walletHistoryModal');
  if (!modal) return;

  // Update header for the chosen currency
  const titleText = document.getElementById('walletHistoryTitleText');
  const iconWrap  = document.getElementById('walletHistoryIcon');
  if (titleText) titleText.textContent = cur === 'star' ? 'Stars history' : 'Coins history';
  if (iconWrap) iconWrap.innerHTML = _walletCurrencyIconSvg(cur, 20);

  // Current balance card — render the new SVG glyph inline rather than
  // an emoji (the 🪙 / ⭐ emoji render as flat gray discs at small sizes
  // on many systems, which is what made the icon read as a moon).
  const balEl = document.getElementById('walletHistoryBalance');
  const summaryGlyphHtml = `<span class="wallet-history-summary-glyph" aria-hidden="true">${_walletCurrencyIconSvg(cur, 14)}</span>`;
  if (balEl) {
    const bal = cur === 'star' ? (_wallet.star_balance || 0) : (_wallet.coin_balance || 0);
    balEl.innerHTML = `${bal.toLocaleString()} ${summaryGlyphHtml}`;
  }

  // Reset summary + list to loading state.
  document.getElementById('walletHistoryEarned').innerHTML = `+0 ${summaryGlyphHtml}`;
  document.getElementById('walletHistorySpent').innerHTML  = `−0 ${summaryGlyphHtml}`;
  const list = document.getElementById('walletHistoryList');
  if (list) {
    list.innerHTML = `
      <div class="wallet-history-loading">
        <div class="wallet-history-loading-spinner" aria-hidden="true"></div>
        <div class="wallet-history-loading-text">Loading your history…</div>
      </div>
    `;
  }

  modal.style.display = 'flex';

  // Fetch + render.
  const events = await loadWalletHistory(cur);

  // Compute summary totals
  let earned = 0, spent = 0;
  for (const e of events) {
    if (e.direction === 'credit' && e.amount) earned += e.amount;
    if (e.direction === 'debit'  && e.amount) spent  += e.amount;
  }
  document.getElementById('walletHistoryEarned').innerHTML = `+${earned.toLocaleString()} ${summaryGlyphHtml}`;
  document.getElementById('walletHistorySpent').innerHTML  = `−${spent.toLocaleString()} ${summaryGlyphHtml}`;

  if (!events.length) {
    list.innerHTML = `
      <div class="wallet-history-empty">
        <div class="wallet-history-empty-illustration" aria-hidden="true">${_walletCurrencyIconSvg(cur, 56)}</div>
        <div class="wallet-history-empty-title">No history yet</div>
        <div class="wallet-history-empty-sub">When you earn or spend ${cur === 'star' ? 'stars' : 'coins'}, entries will show here.</div>
      </div>
    `;
    return;
  }

  // Build the list. Credits → green + sign, debits → red − sign.
  // Bulk-unlock rows get a "BULK" pill, a stacked-books icon, and a
  // soft purple tint so a whole-book purchase is visually distinct
  // from individual chapter/video unlocks.
  //
  // Premium redesign (May 2026):
  //   • Date section dividers ("Today", "Yesterday", "Tuesday", "Sat, May 3")
  //     so the eye scans clusters instead of an undifferentiated list.
  //   • Two-line metadata: title + sub-line, time on the right column above
  //     the running balance for at-a-glance verification.
  //   • Card-style rows with subtle elevation on hover.
  //   • Stagger fade-in animation per row.
  // Tiny version of the currency icon for the inline "Bal 514" line on
  // each row. 11px keeps it secondary to the amount column.
  const rowBalGlyph = `<span class="wallet-history-bal-glyph" aria-hidden="true">${_walletCurrencyIconSvg(cur, 11)}</span>`;
  let lastDateKey = null;
  const html = [];
  events.forEach((e, idx) => {
    const grp = _walletHistoryDateKey(e.at);
    if (grp.key !== lastDateKey) {
      lastDateKey = grp.key;
      html.push(`<div class="wallet-history-date-divider"><span>${escHTML(grp.label)}</span></div>`);
    }

    const sign = e.direction === 'credit' ? '+' : '−';
    const dirCls = e.direction === 'credit' ? 'wallet-history-row-credit' : 'wallet-history-row-debit';
    const kindCls = e.kind === 'unlock_book_bulk' ? 'wallet-history-row-bulk' : '';
    const amountText = e.amount != null
      ? `${sign}${e.amount.toLocaleString()}`
      : '—';
    const icon = _walletHistoryIconFor(e);
    const pill = e.kind === 'unlock_book_bulk'
      ? '<span class="wallet-history-pill wallet-history-pill-bulk" title="Whole-book purchase">BULK</span>'
      : '';
    const t = _formatWalletHistoryTime(e.at);
    // Right-column secondary line: balance-after, so the user can mentally
    // verify the ledger ("after this row I had 514 coins"). Falls back to
    // the date secondary (when not Today/Yesterday) if balance not present.
    // balanceHtml is raw HTML (contains the inline SVG glyph) — when
    // empty we fall back to the escaped date secondary.
    const balanceHtml = e.balance_after != null
      ? `Bal ${Number(e.balance_after).toLocaleString()} ${rowBalGlyph}`
      : (t.secondary ? escHTML(t.secondary) : '');
    const subText = e.sub ? escHTML(e.sub) : '';
    const stagger = `style="animation-delay:${Math.min(idx * 20, 600)}ms"`;
    html.push(`
      <div class="wallet-history-row ${dirCls} ${kindCls}" ${stagger}>
        <div class="wallet-history-row-icon" aria-hidden="true">${icon}</div>
        <div class="wallet-history-row-meta">
          <div class="wallet-history-row-title" title="${escHTML(e.title)}">
            <span class="wallet-history-row-title-text">${escHTML(e.title)}</span>
            ${pill}
          </div>
          <div class="wallet-history-row-sub">
            ${subText}${subText && t.primary ? '<span class="wallet-history-row-sub-dot">·</span>' : ''}<span class="wallet-history-row-time">${escHTML(t.primary)}${t.secondary ? `, ${escHTML(t.secondary)}` : ''}</span>
          </div>
        </div>
        <div class="wallet-history-row-right">
          <div class="wallet-history-row-amount">${amountText}</div>
          ${balanceHtml ? `<div class="wallet-history-row-balance">${balanceHtml}</div>` : ''}
        </div>
      </div>
    `);
  });
  list.innerHTML = html.join('');
}

// Currency icon SVG — used by the modal header AND every credit row.
// Two designs, both disc-shaped so they read as "currency" at a glance
// (the previous coin icon was a stacked cylinder that looked like a
// crescent moon at small sizes):
//   • coin → two overlapping gold discs with a faint inner ring on the
//     top coin (suggests dimensional embossing)
//   • star → light-purple disc with a deep-purple star emblem inside
//     (matches Selebox's existing star-as-purple-glyph convention while
//     pairing visually with the coin disc as a sibling)
// The `size` arg lets the same SVG drive 20px header icons and 18px
// row icons without duplicating markup.
function _walletCurrencyIconSvg(currency, size = 18) {
  if (currency === 'star') {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">`
      + `<circle cx="12" cy="12" r="9" fill="#c4b5fd" stroke="#6b21a8" stroke-width="1.2"/>`
      + `<path d="M12 6.8l1.55 3.25 3.6.3-2.78 2.36.88 3.49L12 14.45l-3.25 1.75.88-3.49-2.78-2.36 3.6-.3z" fill="#5b21b6"/>`
      + `</svg>`;
  }
  // coin — two overlapping discs, the upper one a shade darker with an
  // inner ring so it doesn't melt into the lower disc.
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">`
    + `<circle cx="9" cy="14.5" r="6.6" fill="#fbbf24" stroke="#b45309" stroke-width="1.2"/>`
    + `<circle cx="15" cy="9.5"  r="6.6" fill="#f59e0b" stroke="#b45309" stroke-width="1.2"/>`
    + `<circle cx="15" cy="9.5"  r="3.4" fill="none"   stroke="#78350f" stroke-width="0.8" opacity="0.55"/>`
    + `</svg>`;
}

// Pick an icon by event kind. Each row gets a small left-side glyph
// so the eye lands on the right category without reading. Bulk
// unlocks get a books-stack so they pop visually next to single-
// chapter or single-video unlocks. Credits get currency-specific
// glyphs (coin / star) instead of a kind icon — money in is money
// in, regardless of source.
function _walletHistoryIconFor(e) {
  if (e.direction === 'credit') {
    return _walletCurrencyIconSvg(e.currency, 18);
  }
  // Debits — pick by kind.
  switch (e.kind) {
    case 'unlock_book_bulk':
      // Books stack (three offset rectangles)
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6v16H4z"/><path d="M10 4h6v16h-6z"/><path d="M16.5 5.5l5 1.2-3.4 14.6-5-1.2z"/></svg>';
    case 'unlock_chapter':
      // Single document with lines
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>';
    case 'unlock_video':
      // Play in rounded rectangle
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
    case 'withdrawal_request':
      // Bank
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 22 8 2 8 12 2"/><line x1="5" y1="11" x2="5" y2="18"/><line x1="10" y1="11" x2="10" y2="18"/><line x1="14" y1="11" x2="14" y2="18"/><line x1="19" y1="11" x2="19" y2="18"/><line x1="2" y1="22" x2="22" y2="22"/></svg>';
    default:
      // Generic shopping bag for unknown debits
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>';
  }
}

function closeWalletHistory() {
  const modal = document.getElementById('walletHistoryModal');
  if (modal) modal.style.display = 'none';
}

// Wire the clickable balance cards + the close button.
document.querySelectorAll('[data-history-currency]').forEach((btn) => {
  btn.addEventListener('click', () => openWalletHistory(btn.dataset.historyCurrency));
});
document.getElementById('btnCloseWalletHistory')?.addEventListener('click', closeWalletHistory);
document.getElementById('walletHistoryModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'walletHistoryModal') closeWalletHistory();
});

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
  // Capture the original label so we can restore it on error (the success
  // path replaces the whole page so we don't need to restore in that case).
  // 2026-05-15: the hitpay-create-payment call takes ~3-5s because it does
  // auth verify + pack lookup + insert pending row + POST to HitPay's API +
  // patch back the request_id, all sequentially. We can't speed up the
  // external HitPay call, but a clear label-change makes the wait less
  // confusing — users see something happening instead of staring at an
  // unresponsive purple button.
  const originalText = btnEl ? btnEl.textContent : null;
  if (btnEl) {
    btnEl.classList.add('is-loading');
    btnEl.disabled = true;
    btnEl.textContent = 'Connecting to HitPay…';
  }
  try {
    const data = await callEdgeFunction('hitpay-create-payment', { package_id: packId });
    if (!data?.url) { toast('Could not start checkout', 'error'); return; }
    // Redirect the whole page to HitPay checkout
    window.location.href = data.url;
  } catch (err) {
    toast(err.message || 'Checkout failed', 'error');
  } finally {
    if (btnEl) {
      btnEl.classList.remove('is-loading');
      btnEl.disabled = false;
      if (originalText !== null) btnEl.textContent = originalText;
    }
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
// payment AND after cancel — the redirect_url field in a HitPay
// payment-request is single-purpose, so the URL alone can't tell us
// whether the user actually paid or just hit Back. The fix (May 2026)
// is to verify against the database: when we see ?store=success&ref=…,
// fetch the matching coin_purchases row and look at its real status.
//
// `failed` / `cancelled` rows trigger a cancel toast. `pending` rows
// (webhook hasn't fired yet OR was never going to because the user
// bailed) stay silent — the wallet's realtime subscription will still
// credit the coins if a webhook eventually lands, and we'd rather
// show no toast than a wrong toast.
//
// 2026-05-15 UX update: no more success toast. Charles reported that
// the toast was firing even when he just clicked Back from HitPay
// without paying, which felt dishonest. The wallet pill ticking up +
// a fresh entry in the Coins history is confirmation enough. We also
// always route back to the Coins/Store page on a `success` flag so the
// user lands directly on their updated balance instead of Home.
async function handleStoreReturn() {
  const params = new URLSearchParams(window.location.search);
  const storeFlag = params.get('store');
  const ref = params.get('ref');
  if (!storeFlag) return;

  // Strip params first so refresh / back-forward navigation doesn't
  // keep re-firing this logic. The toast itself fires async below.
  params.delete('store');
  params.delete('ref');
  const newQuery = params.toString();
  history.replaceState(null, '', window.location.pathname + (newQuery ? '?' + newQuery : '') + window.location.hash);

  if (storeFlag !== 'success') {
    if (storeFlag === 'cancelled' || storeFlag === 'cancel') {
      toast('Payment cancelled.', 'error');
    }
    return;
  }

  // success branch — always land the user on the Coins/Store page so
  // they can see their refreshed balance + the new history row, even
  // if the webhook hasn't fired yet (the wallet realtime subscription
  // will tick the balance up when it does).
  setTimeout(() => showStore(), 50);

  if (!ref) {
    // No reference id to verify against. We've already navigated to
    // the store — just don't show any error/cancel toast.
    return;
  }

  let purchaseStatus = null;
  try {
    const { data, error } = await supabase
      .from('coin_purchases')
      .select('status')
      .eq('id', ref)
      .maybeSingle();
    if (!error && data) purchaseStatus = data.status;
  } catch (e) {
    // Network blip or RLS reject — stay silent rather than guess.
    console.warn('[store] purchase status verify failed:', e?.message);
    return;
  }

  // Only surface the error toast when the row definitively says the
  // payment didn't go through. credited / completed / paid → silent
  // (no more success toast, per UX feedback). pending / null →
  // silent (the realtime wallet subscription will catch a late credit).
  if (purchaseStatus === 'failed' || purchaseStatus === 'cancelled') {
    toast('Payment was not completed. No coins added.', 'error');
  }
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

// ── Filter by user ──
window.filterByUser = async (userId, username) => {
  openProfile(userId);
};

// ── Feed ──
// ── Feed pagination + lazy loading ──
// FEED_PAGE_SIZE stays in app.js (used by composer / realtime hook) and is
// injected into feed.js via initFeed. The pagination/scroll state vars
// (_feedOffset, _hasMoreFeedPosts, _isLoadingMoreFeed, _feedScrollObserver,
// _feedSeq, _cachedFollowIds) moved to feed.js as part of Stage 5. App.js
// reaches the two that it still needs (_hasMoreFeedPosts, _cachedFollowIds,
// _feedScrollObserver) through the imported accessors.
const FEED_PAGE_SIZE = 15;

// Facebook-pattern feed delta. `_feedLastSeenAt` is the newest
// created_at across the rendered feed. refreshFeedAdditive() fetches
// only posts created after this timestamp and prepends them to the
// top, instead of re-running the expensive feed_for_you ranker on
// every refresh. Set by loadFeed/loadMoreFeed when fresh rows arrive,
// updated again on each successful additive refresh.
let _feedLastSeenAt = null;

// _newPostsBufferIds moved to feed.js (Stage 5) — it's the dedup partner of
// _newPostsBuffer and only the poller / pill-apply touch it.
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
  if (getFeedMode() !== 'foryou' || !_feedLastSeenAt) {
    return loadFeed();
  }
  // Fast path — buffer has new posts from the poller, just apply them.
  if (getNewPostsBuffer().length > 0) {
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

// _feedHybridSessionSeed moved to feed.js (Stage 5) — only the hybrid-feed
// page fetcher reads it, and the reset happens inside the moved loadFeed().

// Session-cached pool of trending books to PAD each hybrid feed
// carousel out to ~30 books on web. The server-side fetch_book_carousel
// RPC returns only 5 (with role labels: trending / newly_updated /
// community_pick / wild_card), which is the right size for mobile but
// way too thin for the wider desktop carousel. Solution: one extra
// SELECT * FROM books query per session that fetches the next ~30
// trending books, cached as a Promise so concurrent carousels share
// the same in-flight request. When each carousel mounts, it appends
// pool entries (deduped against the role-labeled set) to its track.
// Doesn't touch the server-side RPC or mobile.
let _webBookPoolPromise = null;
function _getWebBookPool() {
  if (!_webBookPoolPromise) {
    _webBookPoolPromise = supabase
      .from('books')
      .select('id, title, cover_url, author_id, ratings_avg, ratings_count, profiles!author_id(username, display_name, avatar_url)')
      .eq('is_public', true)
      .eq('is_hidden', false)
      .in('status', ['ongoing', 'completed'])
      .order('trending_score', { ascending: false, nullsFirst: false })
      .limit(40)
      .then(({ data, error }) => {
        if (error) { console.warn('[book-pool] fetch failed:', error.message); return []; }
        // Adapt to the shape _renderHybridBookCarousel expects.
        return (data || []).map(b => ({
          id: b.id,
          title: b.title,
          cover_url: b.cover_url,
          author_id: b.author_id,
          author_display_name: b.profiles?.display_name || null,
          author_username: b.profiles?.username || null,
          rating: b.ratings_avg,
          rating_count: b.ratings_count,
          role: 'discover',
        }));
      })
      .catch((err) => { console.warn('[book-pool] threw:', err?.message); return []; });
  }
  return _webBookPoolPromise;
}

// Best-effort duration formatter for video card tile. Mobile's helper
// lives in lib/utils — we don't have an obvious shared util on web,
// so format inline (M:SS or H:MM:SS).
function _formatDuration(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${sec}`;
  return `${m}:${sec}`;
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

// ── Collapsible post bodies (Facebook-style "See more / less") ──
// Auto-detects bodies that overflow ~6 lines and lets users tap the text
// itself to expand/collapse. Short posts get no toggle. Per-session state
// in `_expandedPosts` so toggle persists while scrolling but resets on refresh.
const _expandedPosts = new Set();

// Wire feed mode tabs (For You / Following / Discover)
document.querySelectorAll('#feedTabs .feed-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.feed;
    if (mode === getFeedMode()) return;
    document.querySelectorAll('#feedTabs .feed-tab').forEach(t => t.classList.toggle('active', t === tab));
    setFeedMode(mode);
    loadFeed();
  });
});

function setupFeedInfiniteScroll() {
  const sentinel = document.getElementById('feedSentinel');
  if (!sentinel) return;
  sentinel.style.display = 'block';

  const prevObs = getFeedScrollObserver();
  if (prevObs) prevObs.disconnect();
  if (!('IntersectionObserver' in window)) return;

  const obs = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) loadMoreFeed();
  }, { root: null, rootMargin: '600px 0px', threshold: 0.01 });
  setFeedScrollObserver(obs);
  obs.observe(sentinel);
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

  // Observer state lives in feed.js now (Stage 5). Bind locals before
  // constructing so the IntersectionObserver callbacks capture this exact
  // observer (rather than re-reading from feed.js, which would see the
  // newest observer if this fn is invoked twice in rapid succession).
  const prevVideoObs = getFeedVideoObserver();
  if (prevVideoObs) prevVideoObs.disconnect();
  const videoObs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      attachHlsToPostVideo(e.target);
      videoObs.unobserve(e.target);
    }
  }, { root: null, rootMargin: '300px 0px', threshold: 0.01 });
  setFeedVideoObserver(videoObs);

  const prevPostObs = getFeedPostObserver();
  if (prevPostObs) prevPostObs.disconnect();
  const postObs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      triggerPostLazyLoad(e.target);
      postObs.unobserve(e.target);
    }
  }, { root: null, rootMargin: '500px 0px', threshold: 0.01 });
  setFeedPostObserver(postObs);

  container.querySelectorAll('.post-video').forEach(v => videoObs.observe(v));
  container.querySelectorAll('.post-card').forEach(c => postObs.observe(c));
}

// Batch lazy-loads via a short debounce so 30 visible cards = 2 queries
// (one for reactions, one for comment counts) instead of 60 round-trips.
const _pendingLazyPostIds = new Set();
let _pendingLazyPostTimer = null;

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

// escHTML() moved to js/supabase.js (Stage 1 prep, 2026-05-15).
// Imported at the top of this file.
function linkify(str) {
  const escaped = escHTML(str);
  return escaped.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// ── Search helpers ────────────────────────────────────────────────────────────
// sanitizeSearchQuery / escapeIlike / normalizeForSearch moved to
// js/search.js (Stage 10). The names are still imported at the top of
// this file so existing _cfg.sanitizeSearchQuery bridges into books.js
// and videos.js continue to receive the real implementation.

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

window.shouldHidePost = shouldHidePost;

// _postActionMenuEl moved to feed.js (Stage 5) — only openPostActionMenu /
// closePostActionMenu touch it, and both are in feed.js now.

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

// Codex audit 2026-05-16: extracted to a named declaration so profile.js
// can take it via the initProfile config shorthand. Still re-attached to
// window because inline onclick=""-style call sites (if any are added
// later in rendered HTML) need a global handle.
function openProfileActionMenu(e, btn, ctx) {
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
}
window.openProfileActionMenu = openProfileActionMenu;

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
  } else if (targetType === 'post' && !(existing && existing.emoji === emojiKey)) {
    // Daily-goal: tick "Like & comment N posts". Dedup key is per-post
    // so like + comment on the same post still counts as ONE engagement
    // (mirrors mobile's PostInformation.jsx:249, PostCommentModal:1982).
    // Toggle-off branch skipped — only ADDS count toward the goal.
    try { tickGoalUnique('like_comment', `like_comment:${targetId}`); } catch {}
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
  // display_name preferred; falls back to @handle. Sprint 2 #2.
  const name = profile.display_name || profile.username || 'Unknown';
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
  // Daily-goal: tick "Like & comment N posts". Same dedup key as the
  // reaction path so commenting + liking the same post counts ONCE.
  // Skipped for video comments (videoId set) since the daily quest is
  // post-specific per the spec.
  if (!videoId) {
    try { tickGoalUnique('like_comment', `like_comment:${postId}`); } catch {}
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

// ── Repost modal ──
let repostTargetId = null;
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
// The realtime-refresh debounce timer lives in feed.js (Stage 5) alongside
// the rest of the feed state. We reach for it through accessors so the
// single timer slot stays the source of truth between app.js (this fn,
// which sets it) and feed.js (loadFeed, which clears it on user-driven
// loads).
function _scheduleRealtimeFeedRefresh() {
  if (getRealtimeRefreshTimer()) return; // already pending
  setRealtimeRefreshTimer(setTimeout(() => {
    setRealtimeRefreshTimer(null);
    const feedVisible = feedEl && feedEl.style.display !== 'none' && !document.hidden;
    if (feedVisible && currentUser?.id) loadFeed();
  }, 800));
}

supabase.channel('public-feed')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, (payload) => {
    const newPost = payload?.new;
    if (!newPost || !currentUser?.id) return;
    // Always refresh on the viewer's own posts
    if (newPost.user_id === currentUser.id) return _scheduleRealtimeFeedRefresh();
    // For Following tab, only refresh if the author is one the viewer follows
    if (getFeedMode() === 'following') {
      const followIds = getCachedFollowIds();
      if (followIds && followIds.includes(newPost.user_id)) {
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
const feedEl = document.getElementById('feed');
const storiesEl = document.getElementById('storiesRow');
const composeEl = document.querySelector('.compose');

// ── Home landing — data wiring ──────────────────────────────────────
//
// The mosaic has 7 video slots (1 hero + 3 Recent + 3 Trending) plus
// 2 book shelves. Each surface uses its own ranking:
//   · Hero    — single most recently published video (eye-catcher)
//   · Recent  — next 3 most recent
//   · Trending — top 3 by views_count (dedupped against hero+recent)
//
// Both queries run in parallel, fail soft (the skeleton stays if the
// network drops), and cache for 60s so re-clicking the Home tab in a
// session doesn't refetch unnecessarily.
const HOME_DATA_TTL_MS = 60 * 1000;
let _homeDataLoadedAt = 0;
let _homeDataInFlight = null;

// Dear Jen uploader id, resolved once per session and cached. The hero
// slot is "random video from the Dear Jen channel", so we need the
// profile id to filter videos by. Profile ids don't change at runtime;
// cache for the session, not just 60s.
let _dearJenUploaderId = null;
let _dearJenLookupAttempted = false;

// Book shelf pagination — each shelf holds up to 14 books split across
// 2 pages of 7. The right-arrow on the shelf header toggles between
// page 0 and page 1, cycling back to 0 after the second click. Pools
// are populated by loadHomeVideos and consulted by the arrow handler.
const _bookShelfPools = { trending: [], recent: [] };
const _bookShelfPages = { trending: 0, recent: 0 };
const _BOOKS_PER_PAGE = 6;
async function _resolveDearJenUploaderId() {
  if (_dearJenLookupAttempted) return _dearJenUploaderId;
  _dearJenLookupAttempted = true;
  try {
    const { data } = await supabase
      .from('profiles')
      .select('id, username')
      .ilike('username', '%Dear Jen%')
      .limit(1)
      .maybeSingle();
    if (data?.id) {
      _dearJenUploaderId = data.id;
      // (Resolution-success log removed — runs once per session, no signal value.)
    } else {
      console.warn('[home] No profile matched username ILIKE "%Dear Jen%" — featured slot will stay empty');
    }
  } catch (err) {
    console.warn('[home] Dear Jen profile lookup failed:', err?.message || err);
  }
  return _dearJenUploaderId;
}

// ─── Home session-state reset (called from sign-in / sign-out paths) ─────
// Clears the 60s TTL cache + book shelf pools + in-flight promise so an
// admin-rendered home (with the inline "replace cover" pencils) doesn't
// linger across an auth flip into a regular user's session. Without this,
// signing out then signing in within 60s reused the cached HTML — the
// regular user briefly saw the previous admin's pencils because
// `_homeDataLoadedAt` was still fresh and showHomeLanding returned early
// without re-rendering. (Codex P1 catch.)
function resetHomeSessionState() {
  _homeDataLoadedAt = 0;
  _homeDataInFlight = null;
  _bookShelfPools.trending = [];
  _bookShelfPools.recent = [];
  _bookShelfPages.trending = 0;
  _bookShelfPages.recent = 0;
  // Restore skeletons so the next showHomeLanding renders fresh state
  // immediately instead of carrying over the prior user's cards. The
  // `.home-skeleton-card` class is the default look from index.html.
  ['homeHeroVideo', 'homeFeaturedPost'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('home-skeleton-card');
      el.innerHTML = '';
      el.onclick = null;
    }
  });
  document.querySelectorAll('.home-video-medium, .home-video-trending, .home-book-card').forEach(el => {
    el.classList.add('home-skeleton-card');
    el.innerHTML = '';
    el.onclick = null;
  });
}

// Short-form view-count formatter — "4,213" → "4.2K", "1,580,000" → "1.6M"
const _formatHomeViews = (n) => {
  const num = Number(n) || 0;
  if (num >= 1000000) return (num / 1000000).toFixed(num >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (num >= 1000)    return (num / 1000).toFixed(num >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(num);
};

// HH:MM:SS / MM:SS — reuses the same shape as formatDuration() below but
// inlined here so loadHomeVideos isn't ordering-dependent on file position.
const _formatHomeDuration = (seconds) => {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
};

// HTML-escape user-supplied strings before interpolating into innerHTML.
// Titles + usernames are stored verbatim in the DB; a creator who put
// "<3 my fans" in their video title would otherwise blow up our markup.
const _escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Normalize a Bunny CDN URL.
//
// Legacy uploads (pre-May 2026) wrote thumbnail_url + video_url with a
// trailing slash in the CDN hostname constant, producing URLs like:
//   https://tales-of-siren-videos.b-cdn.net//abc/abc.jpg
// Bunny.net normalizes that inconsistently — sometimes the double-slash
// resolves, sometimes the request 404s. The hostname constant was fixed
// for new uploads, but historical rows still carry the malformed URL.
// We collapse the extra slash on render so playback / thumbnails work
// reliably without a DB backfill.
const _cleanCdnUrl = (url) => {
  if (!url) return '';
  // Preserve the "://" after the protocol; collapse any other "//" to "/".
  return String(url).replace(/([^:])\/\/+/g, '$1/');
};

// Supabase Storage cover with server-side ratio crop. Matches what
// mobile does in lib/utils/image-source.js — rewrites the URL to use
// the render/image endpoint with width+height+resize=cover params,
// which makes Supabase return a perfectly cropped 2:3 image centered
// on the source. CSS no longer has to fight with aspect mismatches:
// the image arrives at the target ratio.
//
// For Bunny, Appwrite, or other hosts, this is a no-op (pass-through).
// For Supabase URLs already at /render/image/public/, we just swap
// the params. For /object/public/ URLs, we rewrite the path too.
const _supabaseRatioCrop = (url, { width, height } = {}) => {
  if (!url || typeof url !== 'string') return url;
  if (!url.includes('.supabase.co')) return url;
  // Rewrite /object/public/ → /render/image/public/ if needed.
  const rendered = url.includes('/storage/v1/render/image/public/')
    ? url
    : url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/');
  if (!width || !height) return rendered;
  const [base, rawQuery = ''] = rendered.split('?');
  // Strip any existing transform params so our values win; preserve anything else.
  const preserved = rawQuery
    .split('&')
    .filter(p => p && !/^(width|height|quality|resize)=/i.test(p));
  preserved.push(`width=${width}`);
  preserved.push(`height=${height}`);
  preserved.push('resize=cover');
  preserved.push('quality=80');
  return `${base}?${preserved.join('&')}`;
};

// Build the inner HTML for one card slot. Type drives which fields show:
//   'hero'     → big card, no creator/views (those live in the meta band)
//   'recent'   → medium card with duration chip + title + creator
//   'trending' → small card with TRENDING chip + duration + title + creator·views
const _renderHomeVideoCard = (video, type) => {
  if (!video) return ''; // leave the existing skeleton DOM untouched
  const thumb = _cleanCdnUrl(video.thumbnail_url);
  const title = video.title || 'Untitled';
  const author = video.profiles?.username || 'Unknown';
  const dur = _formatHomeDuration(video.duration);
  const views = _formatHomeViews(video.views);
  // No TRENDING chip in the minimal redesign — the "Trending" header
  // above the column carries that signal now. Variable kept (empty)
  // so the template literal below still has its slot.
  const trendingChip = '';
  const durChip = dur ? `<span class="home-thumb-dur">${dur}</span>` : '';
  const thumbClass = type === 'hero' ? 'home-thumb home-thumb-wide' : 'home-thumb';
  // Real <img> element rather than CSS background-image. The rest of
  // the app uses <img> for thumbnails (search results, video cards,
  // post images) and we know those work — so the home cards do the
  // same to avoid the silent-fail trap that bit us with background-
  // image. Bonus: <img> shows a broken-image icon if the URL 404s,
  // making future debugging trivial.
  const thumbImg = thumb
    ? `<img class="home-thumb-img" src="${_escHtml(thumb)}" alt="${_escHtml(title)}" loading="lazy" referrerpolicy="no-referrer"/>`
    : '';

  // Trending — thumbnail-only (May 2026). Title / creator / views were
  // dropped because each thumbnail is heavily branded with title + author
  // overlay baked into the cover art itself, so the secondary metadata
  // was duplicating the cover. Hover-title attribute is added on the
  // wrapper article via _wireHomeVideoCard for accessibility.
  if (type === 'trending') {
    return `
      <div class="${thumbClass}">
        ${thumbImg}
        ${trendingChip}
        ${durChip}
      </div>
    `;
  }
  const sub = type === 'hero'
    ? `${author} · ${views} views`
    : author;
  return `
    <div class="${thumbClass}">
      ${thumbImg}
      ${trendingChip}
      ${durChip}
    </div>
    <div class="home-card-meta">
      <div class="home-card-title">${_escHtml(title)}</div>
      <div class="home-card-sub">${_escHtml(sub)}</div>
    </div>
  `;
};

// Render the Featured Post panel — replaces the skeleton overlay
// content with the post's real title, author byline, and (if available)
// a background image. Visual treatment stays the same as the skeleton:
//   · overline pill "SELEBOX POST"
//   · big title (the post body, line-clamped in CSS to 3 lines)
//   · byline with avatar + author + time-ago
// If the post has an image_url, we use it as the panel's background;
// otherwise the existing purple gradient placeholder stays visible
// behind the overlay's bottom fade.
const _renderHomeFeaturedPost = (post) => {
  if (!post) return '';
  const author = post.profiles?.username || 'Unknown';
  const avatar = _cleanCdnUrl(post.profiles?.avatar_url);
  const body = post.body || '(No content)';
  const when = (typeof timeAgo === 'function') ? timeAgo(post.created_at) : '';
  // Prefer the post's own image; fall back to the joined video's
  // thumbnail for video-posts (so the panel never sits as pure
  // gradient when media is available).
  const mediaUrl = _cleanCdnUrl(post.image_url) ||
                   _cleanCdnUrl(post.videos?.thumbnail_url);
  const mediaStyle = mediaUrl
    ? `style="background-image: linear-gradient(180deg, rgba(20,11,56,0.30) 0%, rgba(14,8,42,0.65) 100%), url(${JSON.stringify(mediaUrl)}); background-size: cover; background-position: center;"`
    : '';
  const avatarStyle = avatar
    ? `style="background-image: url(${JSON.stringify(avatar)}); background-size: cover; background-position: center;"`
    : '';
  return `
    <div class="home-featured-post-media" ${mediaStyle}></div>
    <div class="home-featured-post-overlay">
      <span class="home-featured-post-overline">Selebox Post</span>
      <h2 class="home-featured-post-title">${_escHtml(body)}</h2>
      <div class="home-featured-post-byline">
        <div class="home-featured-post-avatar" ${avatarStyle}></div>
        <div class="home-featured-post-author">${_escHtml(author)}</div>
        <span class="home-featured-post-dot">·</span>
        <div class="home-featured-post-when">${_escHtml(when)}</div>
      </div>
    </div>
  `;
};

// Render the current page of a book shelf — slices the pool stored in
// _bookShelfPools[shelf] by _bookShelfPages[shelf] and hands the visible
// 7 books to _renderBookShelf. Also updates the right-arrow button's
// disabled state when there's no page 2 available.
const _renderBookShelfPage = (shelf) => {
  const pool = _bookShelfPools[shelf] || [];
  const page = _bookShelfPages[shelf] || 0;
  const sectionId = shelf === 'trending' ? 'homeBooksTrending' : 'homeBooksRecent';
  const start = page * _BOOKS_PER_PAGE;
  const slice = pool.slice(start, start + _BOOKS_PER_PAGE);
  // If fewer than 7 in the slice (e.g., pool has only 9 books total),
  // pad with empty so the trailing slots clear out instead of holding
  // page-1 leftover content.
  while (slice.length < _BOOKS_PER_PAGE) slice.push(null);
  _renderBookShelf(sectionId, slice, shelf);
  // Disable the arrow if there's no second page worth of books.
  const arrow = document.querySelector(`.home-books-next[data-shelf="${shelf}"]`);
  if (arrow) arrow.disabled = pool.length <= _BOOKS_PER_PAGE;
};

// One-time wire-up for both shelf arrows. Idempotent — repeat calls
// (from re-runs of loadHomeVideos) won't stack listeners.
let _bookShelfArrowsWired = false;
const _wireBookShelfArrowsOnce = () => {
  if (_bookShelfArrowsWired) return;
  document.querySelectorAll('.home-books-next').forEach((btn) => {
    btn.addEventListener('click', () => {
      const shelf = btn.dataset.shelf;
      if (!shelf) return;
      const pool = _bookShelfPools[shelf] || [];
      const maxPage = Math.max(0, Math.ceil(pool.length / _BOOKS_PER_PAGE) - 1);
      // Cycle: 0 → 1 → 0 → ... The user gets a "next" arrow that wraps
      // back to the first page on the second click. Simpler than
      // showing both prev/next arrows for a 2-page list.
      _bookShelfPages[shelf] = (_bookShelfPages[shelf] || 0) >= maxPage
        ? 0
        : (_bookShelfPages[shelf] || 0) + 1;
      _renderBookShelfPage(shelf);
    });
  });
  // "See all" → navigate to the full Books page. Same effect as
  // clicking Books in the sidebar — sets the sidebar active state and
  // shows the books surface. Wrapped in the same idempotent flag so
  // re-runs of loadHomeVideos don't stack handlers.
  document.querySelectorAll('.home-books-seeall').forEach((btn) => {
    btn.addEventListener('click', () => {
      setSidebarActive('btnBook');
      if (typeof showBook === 'function') showBook();
    });
  });
  _bookShelfArrowsWired = true;
};

// Admin "replace cover" flow — used by the inline edit pencil on each
// home book card. Opens a file picker → existing crop modal (with the
// aspect lock removed) → uploads to Supabase Storage → updates the
// book's cover_url → re-renders the shelf so the new cover shows
// immediately, no page reload. Same upload destination + path pattern
// the book editor uses, so the replacement file lives next to the
// original in the bucket.
async function _replaceBookCoverFromHome(bookId) {
  if (!bookId) return;
  // Pop a file picker via a one-shot dynamic <input>. Cleaner than a
  // shared hidden input that would need its value reset between uses.
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.onchange = () => {
    const file = picker.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Pick an image file', 'error'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('Cover must be under 5MB', 'error'); return; }

    openCropModal(file, {
      // Lock to 2:3 — the canonical book-cover ratio that mobile uses
      // and that every display surface (For You, Discover, Ranking,
      // detail page, home shelves) renders into. Pre-fix this was NaN
      // (no aspect lock), which is why old covers landed at random
      // ratios and the display side kept fighting CSS object-fit to
      // make them look right. Charles flagged this directly: "this
      // cropper always [a] problem". Locking the aspect at upload
      // time means we never have to chase the display side again.
      aspectRatio: 2 / 3,
      title: 'Replace book cover (2:3)',
      onSave: async (croppedFile) => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { toast('Sign in first', 'error'); return; }

        const path = `${user.id}/${bookId}-${Date.now()}.jpg`;
        const { error: upErr } = await supabase.storage
          .from('book-covers')
          .upload(path, croppedFile, { upsert: true, contentType: 'image/jpeg' });
        if (upErr) { toast('Upload failed: ' + upErr.message, 'error'); return; }

        const { data: { publicUrl } } = supabase.storage
          .from('book-covers')
          .getPublicUrl(path);
        const { error: updErr } = await supabase
          .from('books')
          .update({ cover_url: publicUrl, updated_at: new Date().toISOString() })
          .eq('id', bookId);
        if (updErr) { toast('Saved file but DB update failed: ' + updErr.message, 'error'); return; }

        toast('Cover replaced', 'success');

        // Refresh the local pool + re-render any shelf that contains
        // this book so the new cover appears immediately without a
        // full page reload.
        ['trending', 'recent'].forEach(shelf => {
          const pool = _bookShelfPools[shelf] || [];
          const idx = pool.findIndex(b => b?.id === bookId);
          if (idx >= 0) {
            pool[idx] = { ...pool[idx], cover_url: publicUrl };
            _renderBookShelfPage(shelf);
          }
        });
      },
    });
  };
  picker.click();
}

// Render a book shelf — fills the existing 7 .home-book-card skeletons
// inside the section with the given id. Each card gets:
//   · cover image as the .home-book-cover background
//   · title
//   · author username
// And a click handler that opens the book detail page via the existing
// openBookDetail() route. If a book entry is null (pool was short),
// the slot resets to skeleton state instead of carrying over page-1
// content.
const _renderBookShelf = (sectionId, books, shelfType) => {
  const section = document.getElementById(sectionId);
  if (!section) return;
  const cards = section.querySelectorAll('.home-book-card');
  cards.forEach((card, i) => {
    const book = books[i];
    if (!book) {
      // Pool ran short for this slot — reset to neutral skeleton so we
      // don't show carried-over page-1 content when paginating.
      card.innerHTML = `
        <div class="home-book-cover"></div>
        <div class="home-book-title">&nbsp;</div>
        <div class="home-book-author">&nbsp;</div>
      `;
      card.classList.add('home-skeleton-card');
      card.style.cursor = 'default';
      card.onclick = null;
      return;
    }
    const rawCover = _cleanCdnUrl(book.cover_url);
    // Ask Supabase to crop the image server-side to a perfect 2:3 at
    // 400×600 px — same technique mobile uses. For 9:16 source covers,
    // this returns a centered 2:3 crop with full width preserved (only
    // the top/bottom of the source ends up trimmed). For Appwrite /
    // Bunny / other hosts, this is a no-op pass-through.
    const cover = _supabaseRatioCrop(rawCover, { width: 400, height: 600 });
    const title = book.title || 'Untitled';
    const author = book.profiles?.username || 'Unknown';
    // Single <img> at object-fit:cover. Now that Supabase pre-crops to
    // the slot ratio, the image arrives ALREADY at 2:3 — no letterbox-
    // blur needed, no awkward gaps, no horizontal stretch. CSS just
    // renders edge-to-edge.
    const coverImg = cover
      ? `<img class="home-book-cover-img" src="${_escHtml(cover)}" alt="${_escHtml(title)}" loading="lazy" referrerpolicy="no-referrer"/>`
      : '';

    // Admin-only inline edit pencil — appears on hover over the cover.
    // Clicking triggers _replaceBookCoverFromHome which opens the file
    // picker → cropper (no aspect lock) → upload + DB swap → live
    // re-render of this shelf. data-book-id is what the click handler
    // reads to know which book to replace. stopPropagation prevents
    // the card's own click (openBookDetail) from firing too.
    const isAdmin = currentProfile?.role === 'admin' || currentProfile?.role === 'moderator';
    const editBtn = isAdmin
      ? `<button class="home-book-edit" data-book-id="${_escHtml(book.id)}" title="Replace cover" type="button" aria-label="Replace cover">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z"/></svg>
         </button>`
      : '';

    // Cover overlays — vary by shelf type. Same chip style as the
    // video card's "TRENDING" pill so the visual language is
    // consistent.
    //   trending → TRENDING pill (top-left) + total reads (bottom)
    //   recent   → NEW CH. {N} pill (top-left)
    let coverChip = '';
    if (shelfType === 'trending') {
      coverChip = '<span class="home-book-chip home-book-chip-trending">TRENDING</span>';
    } else if (shelfType === 'recent') {
      const num = book._latestChapter?.number;
      const chipText = Number.isFinite(num)
        ? `NEW · CH. ${num}`
        : 'NEW CHAPTER';
      coverChip = `<span class="home-book-chip home-book-chip-new">${_escHtml(chipText)}</span>`;
    }

    // Reads chip on the cover bottom — Trending only. Uses the same
    // view-shortener as the videos (4213 → 4.2K).
    let readsChip = '';
    if (shelfType === 'trending') {
      const reads = _formatHomeViews(book.views_count || 0);
      readsChip = `<span class="home-book-reads">${_escHtml(reads)} reads</span>`;
    }

    card.innerHTML = `
      <div class="home-book-cover">
        ${coverImg}
        ${coverChip}
        ${readsChip}
        ${editBtn}
      </div>
      <div class="home-book-title">${_escHtml(title)}</div>
      <div class="home-book-author">${_escHtml(author)}</div>
    `;
    card.classList.remove('home-skeleton-card');
    card.style.cursor = 'pointer';
    card.onclick = (e) => {
      // Honor the inline edit pencil — if the click was on it (or its
      // SVG child), the replace flow handles it and we don't open the
      // book detail page.
      if (e.target.closest('.home-book-edit')) {
        e.stopPropagation();
        const editEl = e.target.closest('.home-book-edit');
        _replaceBookCoverFromHome(editEl.dataset.bookId);
        return;
      }
      openBookDetail(book.id);
    };
  });
};

// Wire one rendered card to navigate to the player.
const _wireHomeVideoCard = (el, video) => {
  if (!el || !video) return;
  el.classList.remove('home-skeleton-card');
  el.classList.add('home-live-card');
  el.dataset.videoId = video.id;
  el.onclick = () => {
    // Hydrate the all-videos cache so playVideo can find the row.
    // Mirrors what runSearch does after a server fetch.
    const formatted = {
      $id: 'sb_' + video.id,
      _supabase: true,
      _supabaseId: video.id,
      title: video.title,
      description: video.description || '',
      tags: video.tags || [],
      uploader: video.uploader_id,
      thumbnail: video.thumbnail_url,
      videoUrl: video.video_url,
      uri: video.video_url,
      videoStats: { views: video.views || 0, duration: video.duration || 0 },
      is_locked: !!video.is_locked,
      is_monetized: !!video.is_monetized,
      duration: video.duration || 0,
      unlock_cost_coins: video.unlock_cost_coins ?? null,
      unlock_cost_stars: video.unlock_cost_stars ?? null,
      status: 'ready',
      $createdAt: video.created_at,
      _uploaderInfo: video.profiles ? {
        $id: video.profiles.id,
        username: video.profiles.username,
        avatar: video.profiles.avatar_url,
      } : null,
    };
    // Hydrate the Videos page caches so a later showVideos() finds this
    // row instantly. `addToVideosCache` + `setUploader` are no-ops if the
    // entry already exists. (Stage 7A: was a defensive `typeof` guard
    // back when these caches lived in app.js — now they're module-owned.)
    if (!findVideoInCache(formatted.$id)) {
      addToVideosCache(formatted);
    }
    if (video.profiles && !getUploader(video.uploader_id)) {
      setUploader(video.uploader_id, formatted._uploaderInfo);
    }
    playVideo(formatted.$id);
  };
};

// Fisher-Yates shuffle — returns a shuffled copy, doesn't mutate.
const _shuffle = (arr) => {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

async function loadHomeVideos({ force = false } = {}) {
  // Cache short-circuit
  if (!force && _homeDataLoadedAt && Date.now() - _homeDataLoadedAt < HOME_DATA_TTL_MS) return;
  if (_homeDataInFlight) return _homeDataInFlight;

  const SELECT_COLS = `
    id, bunny_video_id, title, description, tags, category, video_url, thumbnail_url,
    views, duration, created_at, uploader_id, is_locked, is_monetized,
    unlock_cost_coins, unlock_cost_stars,
    profiles!videos_uploader_id_fkey ( id, username, avatar_url, is_banned )
  `;

  // ── Per-slot queries ──────────────────────────────────────────────
  // The home mosaic uses three different content sources:
  //
  //   Hero (Featured) — random video from the "Dear Jen" channel (the
  //     flagship Tagalog drama uploader). We resolve the channel's
  //     uploader_id from the profiles table once per session, then
  //     filter videos by that id and pick one client-side.
  //
  //   Trending — random pick of 3 from videos with views >= 100. The
  //     100-view floor filters out brand-new uploads that haven't yet
  //     proven traction; "random" within that pool gives the Home tab
  //     variety on every refresh.
  //
  //   Recent — newest 3 by created_at. Deterministic, not random.
  //
  // Overfetch + dedupe is the canonical pattern: fetch a pool larger
  // than needed (handles banned uploaders + cross-slot overlap), then
  // dedupe by id at the end.
  //
  // Status filter: 'published' is the canonical "publicly visible" state
  // on this DB (735 rows). 'ready' is a legacy state that only 28 rows
  // match. The home mosaic wants the full library, so 'published' is
  // the right gate.
  const COMMON_FILTERS = (q) => q.eq('status', 'published').eq('is_hidden', false);

  // Resolve the Dear Jen uploader id first. If we can't find the
  // channel, the hero query short-circuits to an empty result — the
  // skeleton stays put. The other two queries are independent of
  // this lookup and fire whether or not the channel was found.
  const dearJenUploaderId = await _resolveDearJenUploaderId();

  const heroPromise = dearJenUploaderId
    ? COMMON_FILTERS(supabase.from('videos').select(SELECT_COLS))
        .eq('uploader_id', dearJenUploaderId)
        .order('created_at', { ascending: false })
        .limit(60) // bigger pool — series has 100+ episodes, want real randomness
    : Promise.resolve({ data: [], error: null });

  const trendingPromise = COMMON_FILTERS(
    supabase.from('videos').select(SELECT_COLS),
  )
    .gte('views', 100)
    .order('views', { ascending: false })
    .limit(60);

  // (Recent video row was removed from the home layout in May 2026.
  // The recentPromise stub + matching recentRes destructure slot +
  // render block were dead code; cleaned up in the Codex home review.)

  // Featured Posts — most-recent visible posts (Discover-feed
  // convention). We render up to 10 stacked vertically in the panel,
  // and the panel scrolls so the user can browse without leaving Home.
  // Overfetch some extras since banned-user rows are filtered client-
  // side after the join.
  const FEATURED_POST_SELECT = `
    id, body, image_url, created_at, user_id, reposted_from,
    profiles!user_id ( id, username, avatar_url, is_guest, is_banned, role ),
    videos ( id, video_url, thumbnail_url, title, duration ),
    original:reposted_from ( *, profiles!user_id ( id, username, avatar_url, is_guest, is_banned, role ), videos ( id, video_url, thumbnail_url, title, duration ) )
  `;
  const featuredPostPromise = supabase
    .from('posts')
    .select(FEATURED_POST_SELECT)
    .eq('is_hidden', false)
    .order('created_at', { ascending: false })
    .limit(30); // overfetch — first 20 non-banned wins

  // ── Book shelves ──
  // Trending     — books with the highest views_count (= total reads).
  //                Filter to actually-published rows so drafts don't leak.
  // RecentUpdate — books that just got new published chapters. We can't
  //                join + group-by cleanly from PostgREST, so this is a
  //                two-step:
  //                  1. fetch the 40 most-recent published chapters
  //                  2. dedupe by book_id (preserving order), take ~10
  //                  3. fetch those books and reorder client-side
  // Both shelves use the slimmer BOOK_CARD_SELECT (cover + title + author).
  const BOOK_HOME_SELECT = `
    id, title, cover_url, status, views_count, chapters_count,
    published_at, created_at, author_id,
    profiles!books_author_id_fkey ( id, username, avatar_url, is_banned )
  `;

  // Mirror books.js list filters — visibility gates (is_public/is_hidden)
  // + status whitelist (ongoing/completed). Without these, a book that
  // was unpublished server-side or hidden by moderation but still has
  // its `published_at` set would surface on Home's Trending shelf.
  // (Codex P1 catch.)
  const trendingBooksPromise = supabase
    .from('books')
    .select(BOOK_HOME_SELECT)
    .not('published_at', 'is', null)
    .eq('is_public', true)
    .eq('is_hidden', false)
    .in('status', ['ongoing', 'completed'])
    .order('views_count', { ascending: false, nullsFirst: false })
    .limit(20); // overfetch — keep 14 after banned-author filter for 2 pages of 7

  // Step 1 of Recent Update — get recent published chapter rows. We
  // restrict to is_published=true AND (no schedule OR schedule passed)
  // so a future-scheduled chapter doesn't make its book "recently
  // updated" until the cron actually promotes it.
  const nowIso = new Date().toISOString();
  const recentChaptersPromise = supabase
    .from('chapters')
    .select('book_id, chapter_number, title, created_at, scheduled_publish_at, is_published')
    .eq('is_published', true)
    .or(`scheduled_publish_at.is.null,scheduled_publish_at.lte.${nowIso}`)
    .order('created_at', { ascending: false })
    .limit(80); // overfetch — need ~14 unique book_ids for 2 pages of 7

  _homeDataInFlight = Promise.all([
    heroPromise, trendingPromise, featuredPostPromise,
    trendingBooksPromise, recentChaptersPromise,
  ])
    .then(async ([heroRes, trendingRes, featuredPostRes, trendingBooksRes, recentChaptersRes]) => {
      if (heroRes.error)     console.warn('[home] hero (Dear Jen) query failed:', heroRes.error.message);
      if (trendingRes.error) console.warn('[home] trending (views>=100) query failed:', trendingRes.error.message);
      if (featuredPostRes.error) console.warn('[home] featured post query failed:', featuredPostRes.error.message);
      if (trendingBooksRes.error) console.warn('[home] trending books query failed:', trendingBooksRes.error.message);
      if (recentChaptersRes.error) console.warn('[home] recent chapters query failed:', recentChaptersRes.error.message);

      // (Pool-size console logs removed in the Codex home review — they
      // were "strip once the home page is observed populating reliably"
      // markers that overstayed their welcome.)

      // Drop banned-uploader rows post-fetch (RLS can't see is_banned).
      const heroPool = (heroRes.data || []).filter(v => !v.profiles?.is_banned);
      const trendingPool = (trendingRes.data || []).filter(v => !v.profiles?.is_banned);

      // Pick the hero first so we can exclude it from the other slots.
      const hero = heroPool.length > 0 ? _shuffle(heroPool)[0] : null;
      const usedIds = new Set();
      if (hero) usedIds.add(hero.id);

      // Trending list — shuffled pool, take the first 5 that aren't
      // the hero. Variety on every refresh. 4 slots — capped at 4 after
      // the May 2026 redesign where the cards became thumbnail-only and
      // each card grew taller (no more title/creator/views meta row).
      const trending = _shuffle(trendingPool)
        .filter(v => !usedIds.has(v.id))
        .slice(0, 4);

      // ── Render hero ──
      // Reset to skeleton state before fill so a no-hero refresh (Dear
      // Jen lookup failed, channel empty) doesn't keep the previous
      // hero clickable. Same Codex P2 pattern as the Trending stack.
      const heroEl = document.getElementById('homeHeroVideo');
      if (heroEl) {
        heroEl.classList.add('home-skeleton-card');
        heroEl.innerHTML = '';
        heroEl.onclick = null;
      }
      if (heroEl && hero) {
        heroEl.innerHTML = _renderHomeVideoCard(hero, 'hero');
        _wireHomeVideoCard(heroEl, hero);
        // Once the thumbnail decodes, the hero's height is final —
        // sync the trending + post columns then. We also fire an
        // immediate sync below the .then() chain for the case where
        // there's no image (skeleton placeholder still showing).
        const heroImg = heroEl.querySelector('img.home-thumb-img');
        if (heroImg && !heroImg.complete) {
          heroImg.addEventListener('load', _syncHomeTopHeights, { once: true });
        }
      }

      // (Render Recent row block removed in the Codex home review —
      // homeVideoMediumRow was deleted from the May 2026 redesign;
      // this loop iterated an empty `recent` array and was a no-op.)

      // ── Render Trending stack ──
      // Codex P2 — reset every slot to skeleton state BEFORE filling, so
      // a refresh that returns fewer rows (or zero rows) clears prior
      // cards instead of leaving them clickable. Without this, a stale
      // card from the previous fetch would still respond to clicks even
      // though its underlying video might no longer match the new
      // ranking pool.
      const trendingStack = document.getElementById('homeVideoSide');
      if (trendingStack) {
        const cards = trendingStack.querySelectorAll('.home-video-trending');
        cards.forEach((el, i) => {
          el.classList.add('home-skeleton-card');
          el.innerHTML = '';
          el.onclick = null;
          const v = trending[i];
          if (!v) return;
          el.innerHTML = _renderHomeVideoCard(v, 'trending');
          _wireHomeVideoCard(el, v);
        });
      }

      // ── Render the Featured Posts column ──
      // Up to 20 most-recent visible posts (Discover-feed convention),
      // banned-author rows stripped. Each post renders via the regular
      // renderPost() so it matches the Post tab exactly — the only
      // difference is the column is narrower, so it reads as "mini
      // Discover." The panel scrolls so the user can browse all 20
      // without leaving the Home tab. Bumped from 10 → 20 once the
      // hero grew and gave the column more vertical room.
      const featuredPosts = (featuredPostRes.data || [])
        .filter(p => !p.profiles?.is_banned)
        .slice(0, 20);
      const featuredPostEl = document.getElementById('homeFeaturedPost');
      if (featuredPostEl && featuredPosts.length > 0) {
        featuredPostEl.innerHTML = '';
        featuredPostEl.classList.remove('home-skeleton-card');
        featuredPosts.forEach((post) => {
          try {
            // Pass idScope='home' so renderPost stamps namespaced IDs
            // (e.g. `home-comments-XYZ`, `home-sharemenu-XYZ`) instead
            // of the unscoped variants the Discover feed uses. Without
            // this, since #homeLanding is earlier in the DOM than
            // #feed, document.getElementById('sharemenu-XYZ') and
            // document.getElementById('comments-XYZ') would resolve to
            // the Home copy and the feed's share/comment buttons would
            // operate on a hidden element.
            //
            // We previously fixed this with a post-render mutation that
            // prefixed every stamped id with `home-` — kept working but
            // was fragile because any new id added to renderPost had to
            // be remembered by the walker. The idScope parameter makes
            // the namespacing structural (Codex P2 / task #232).
            //
            // The Home copy stays read-only — inner buttons fall through
            // to openPostFromSearch via the outer click handler below.
            const postCardEl = renderPost(post, 'home');

            // Click anywhere outside the inner interactive elements
            // opens the full post (same fallback pattern as the
            // Discover feed). Inner handlers (profile link, lightbox,
            // 3-dot menu) keep their own behavior because they sit on
            // children — when their target matches, we bail out.
            postCardEl.addEventListener('click', (e) => {
              if (e.target.closest('.profile-link, .post-menu-btn, .post-image, .post-video, a, button')) return;
              openPostFromSearch(post.id);
            });
            postCardEl.style.cursor = 'pointer';
            featuredPostEl.appendChild(postCardEl);
          } catch (err) {
            console.warn('[home] renderPost failed for featured post:', post.id, err?.message || err);
          }
        });
      }

      // ── Trending books shelf ──
      // Already sorted by views_count DESC at the DB. Strip banned-
      // author rows + take up to 14 (2 pages × 7). Store the full
      // pool in module state so the right-arrow button can flip to
      // the second page without re-querying.
      _bookShelfPools.trending = (trendingBooksRes.data || [])
        .filter(b => !b.profiles?.is_banned)
        .slice(0, _BOOKS_PER_PAGE * 2);
      _bookShelfPages.trending = 0;
      _renderBookShelfPage('trending');

      // ── Recent Update books shelf ──
      // Dedupe the recent-chapter rows by book_id, preserving the
      // newest-first order. Also build a Map of book_id → the most
      // recent chapter (number + title) so the card can show "NEW
      // CH. {N}" on the cover.
      const orderedBookIds = [];
      const latestChapterByBook = new Map();
      const seen = new Set();
      for (const ch of (recentChaptersRes.data || [])) {
        if (!ch.book_id || seen.has(ch.book_id)) continue;
        seen.add(ch.book_id);
        orderedBookIds.push(ch.book_id);
        // First-seen wins because the chapters query is sorted newest-
        // first — so this is always the most recent chapter per book.
        latestChapterByBook.set(ch.book_id, {
          number: ch.chapter_number,
          title: ch.title,
        });
        if (orderedBookIds.length >= _BOOKS_PER_PAGE * 2 + 4) break; // a few extras for banned drop-off
      }
      if (orderedBookIds.length > 0) {
        // Same visibility/status filter as trendingBooksPromise — a chapter
        // can be published on a book that itself is no longer public/visible
        // (author hid the book post-publish, mod removed it, status flipped
        // to draft). Without the gate, Recent Update could leak such books.
        // (Codex P1 catch.)
        const { data: recentBooksData, error: recentBooksErr } = await supabase
          .from('books')
          .select(BOOK_HOME_SELECT)
          .in('id', orderedBookIds)
          .not('published_at', 'is', null)
          .eq('is_public', true)
          .eq('is_hidden', false)
          .in('status', ['ongoing', 'completed']);
        if (recentBooksErr) {
          console.warn('[home] recent-update books query failed:', recentBooksErr.message);
        } else {
          // Re-order to match the chapter-recency order from step 1,
          // then attach the latest-chapter info on each book row so
          // the renderer can show it without a second lookup.
          const byId = new Map((recentBooksData || []).map(b => [b.id, b]));
          _bookShelfPools.recent = orderedBookIds
            .map(id => byId.get(id))
            .filter(b => b && !b.profiles?.is_banned)
            .map(b => ({ ...b, _latestChapter: latestChapterByBook.get(b.id) || null }))
            .slice(0, _BOOKS_PER_PAGE * 2);
          _bookShelfPages.recent = 0;
          _renderBookShelfPage('recent');
        }
      }

      // Wire the arrow buttons once. The "once" flag prevents stacking
      // duplicate listeners on every loadHomeVideos call (which happens
      // on Home re-visits within the same session).
      _wireBookShelfArrowsOnce();

      // Force the Trending + Featured Post columns to exactly match
      // the hero's height. Wire the resize-sync once too. Both are
      // idempotent — safe to call on every refresh.
      _syncHomeTopHeights();
      _wireHomeTopHeightSync();

      _homeDataLoadedAt = Date.now();
    })
    .catch(err => {
      console.warn('[home] loadHomeVideos failed:', err?.message || err);
      // Skeleton stays — no destructive UI change on failure.
    })
    .finally(() => {
      _homeDataInFlight = null;
    });

  return _homeDataInFlight;
}

// Sync the Trending column + Featured Post column heights to exactly
// match the hero card. CSS Grid's align-items:stretch *should* handle
// this, but with intrinsic-content constraints on flex children and
// the post-column's scroll behavior, the columns can end up a few px
// taller than the hero in practice. Measuring the hero post-render and
// applying that as an explicit pixel height guarantees the three top
// columns end at the exact same horizontal line — top of hero
// thumbnail to bottom of "Dear Jen · 49 views" byline.
//
// Called after loadHomeVideos paints, then again on window resize +
// hero image load (since the hero's height depends on the thumb image
// being decoded for it to settle).
const _syncHomeTopHeights = () => {
  // May 2026 — post panel is now CSS-controlled (fixed 900px height),
  // independent of the trending column. Just clear any prior inline
  // heights we might have stamped in earlier passes and let CSS own
  // sizing from here on. No more height math.
  const trendingCol = document.getElementById('homeVideoSide');
  const featuredPost = document.getElementById('homeFeaturedPost');
  if (trendingCol) trendingCol.style.height = '';
  if (featuredPost) featuredPost.style.height = '';
};

// One-time wire-up — debounced resize listener that re-syncs the
// column heights when the viewport changes (col widths shift → hero
// 16:9 height shifts → trending + post need to follow).
let _homeTopResizeWired = false;
const _wireHomeTopHeightSync = () => {
  if (_homeTopResizeWired) return;
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(_syncHomeTopHeights, 120);
  });
  _homeTopResizeWired = true;
};

// showHomeLanding — the curated Home tab (mosaic: hero video + Recent
// row + Trending stack + Featured post + Book shelves). Lives parallel
// to showFeed (the Post tab) so each sidebar item targets its own
// surface.
export function showHomeLanding() {
  hideAllMainPages();
  const homeLanding = document.getElementById('homeLanding');
  if (homeLanding) homeLanding.style.display = '';
  // Opt into a body class so .main-wrap goes full-bleed (the default
  // 900px reading column is wrong for this mosaic).
  document.body.classList.add('on-home-landing');
  setViewingProfileId(null);
  stopVideoPlayer();
  if (window.location.hash) history.pushState(null, '', window.location.pathname);
  // Kick the data load. Fire-and-forget — the function is internally
  // cached + de-duped, so it's safe to call on every show.
  loadHomeVideos();
}

export function showFeed() {
  hideAllMainPages();
  feedEl.style.display = '';
  // storiesEl intentionally untouched — inline display:none in HTML keeps it hidden.
  // To bring stories back, remove `style="display:none"` from #storiesRow in index.html.
  composeEl.style.display = '';
  // Restore feed mode tabs (For You / Following / Discover) — Post feed only
  const feedTabs = document.getElementById('feedTabs');
  if (feedTabs) feedTabs.style.display = '';
  // Restore the feed sentinel only when there's actually more to load and posts already rendered
  const feedSentinel = document.getElementById('feedSentinel');
  if (feedSentinel && getHasMoreFeedPosts() && feedEl.querySelector('.post-card')) {
    feedSentinel.style.display = 'block';
  }
  document.body.classList.remove('on-videos');
  setViewingProfileId(null);
  stopVideoPlayer();
  if (window.location.hash) history.pushState(null, '', window.location.pathname);

  // Reload feed if it's empty or stuck
  if (!feedEl.querySelector('.post-card') || feedEl.querySelector('.loading')) {
    loadFeed();
  }
}

// ════════════════════════════════════════════════════════════════════════
// Profile page bulk (showProfileView through end of pre-crop section) moved to js/profile.js (Stage 6, 2026-05-15).
// ════════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════════
// Profile avatar/banner uploads + openMyProfile + topbarAvatar handler moved to js/profile.js (Stage 6, 2026-05-15).
// ════════════════════════════════════════════════════════════════════════

// ── Sidebar active state syncing ──
export function setSidebarActive(buttonId) {
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(buttonId);
  if (btn) btn.classList.add('active');
}

// Wire Home button → curated landing page (featured hero + shelves).
// The home landing is the new May-2026 surface that lives parallel to
// the social feed; it's a discovery destination, not a timeline.
document.getElementById('btnHome')?.addEventListener('click', () => {
  setSidebarActive('btnHome');
  showHomeLanding();
});

// Wire Post button → the social text/image feed (the surface this app
// historically called "Home"). Sidebar split lets users browse curated
// content (Home) separately from following their network's posts (Post).
document.getElementById('btnPost')?.addEventListener('click', () => {
  setSidebarActive('btnPost');
  showFeed();
});

// Logo click → home landing + scroll to top (whether already on landing
// or elsewhere). Mirrors the Home button so the logo always returns to
// the discovery destination, never to the post feed.
document.getElementById('topbarLogoBtn')?.addEventListener('click', () => {
  setSidebarActive('btnHome');
  showHomeLanding();
  scrollToTop();
});

// Handle browser back/forward
window.addEventListener('popstate', () => {
  const hash = window.location.hash;
  if (hash.startsWith('#profile/')) {
    const userId = hash.replace('#profile/', '');
    openProfile(userId);
  } else {
    // Default back-navigation destination — the home landing.
    // Pre-May-2026 fallback was showFeed() + loadFeed(); switched here
    // for the same reason as the initial-load fallback (refresh / no
    // hash should land on the new curated Home tab, not the social feed
    // that now lives behind the Post tab).
    setSidebarActive('btnHome');
    showHomeLanding();
  }
});

// ── Smart context-aware search ──
// MOVED to js/search.js (Stage 10). Topbar input wiring, recent-searches
// dropdown, context-aware placeholder, hashchange listener, runFeedSearch,
// and all 5 search helpers (sanitize / escape / normalize / getRecent /
// renderRecentSearchesPanel) live in search.js now. The import at the
// top of this file pulls in the 3 pure helpers so existing _cfg
// passthroughs into books.js + videos.js keep receiving the real impls.

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

// runFeedSearch MOVED to js/search.js (Stage 10). Comment kept as a
// breadcrumb so grep-driven audits land in the right place. The function
// is exported from search.js; nothing in app.js calls it directly.

// Open a focused post detail modal — works for ANY post, even old ones not
// in the loaded feed. Reuses renderPost so the post stays visually identical
// to the feed version (same actions, same comments, same look).
export async function openPostFromSearch(postId) {
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

document.getElementById('postDetailClose')?.addEventListener('click', _closePostDetailModal);
document.getElementById('postDetailModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'postDetailModal') _closePostDetailModal();
});

// hashchange listener + updateSearchPlaceholder boot call MOVED to
// js/search.js (Stage 10). search.js wires both at module-load time.

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
      invalidateAllVideosCache();
      
      setActiveSearchQuery('');
      setActiveTagFilter(null);
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
// 5-step wizard (May 2026): File → Thumbnail → Details → Visibility → Upload.
// Thumbnail used to live inside Details; it was promoted to its own step so
// authors see 5 auto-extracted frames + an Upload-your-own tile rather than
// a buried picker. The mobile app uses the same 5-step shape.
const VU_STEP_TITLES = {
  1: { title: 'Upload video',          sub: 'Pick the file you want to share.' },
  2: { title: 'Pick a thumbnail',      sub: 'Choose a cover frame — or upload your own.' },
  3: { title: 'Tell us about it',      sub: 'A great title helps people find your video.' },
  4: { title: 'Visibility & schedule', sub: 'Choose when it goes public.' },
  5: { title: 'Uploading…',            sub: 'Stay on this screen until it finishes.' },
};

function vuGotoStep(n) {
  if (n < 1 || n > 5) return;
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
  // Back: hidden on step 1 and during the upload progress step (5).
  back.style.display = (vuStep === 1 || vuStep === 5) ? 'none' : '';
  // Cancel: visible on steps 1-4, hidden during upload.
  cancel.style.display = (vuStep === 5) ? 'none' : '';

  if (vuStep === 1) {
    next.textContent = 'Continue';
    next.disabled = !pendingVideoFile;
  } else if (vuStep === 2) {
    // Thumbnail step. Skippable — Bunny's auto-generated frame is the
    // fallback. Label changes to clarify the user's choice doesn't
    // force a stop.
    next.textContent = pendingVideoThumbnailUrl ? 'Continue' : 'Skip & continue';
    next.disabled = false;
  } else if (vuStep === 3) {
    const title = document.getElementById('videoUploadTitle').value.trim();
    next.textContent = 'Continue';
    next.disabled = !title;
  } else if (vuStep === 4) {
    next.textContent = 'Upload';
    next.disabled = false;
  } else if (vuStep === 5) {
    // During upload, the "next" slot becomes a Done/Close (filled in after success).
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

  // Step 1: re-show the dropzone, hide the file-selected hero, revoke
  // the preview blob URL so we don't leak it.
  const dropzone = document.getElementById('videoFilePicker');
  const summary  = document.getElementById('vuFileSummary');
  if (dropzone) dropzone.style.display = '';
  if (summary)  summary.style.display  = 'none';
  if (_vuPreviewObjectUrl) {
    URL.revokeObjectURL(_vuPreviewObjectUrl);
    _vuPreviewObjectUrl = null;
  }
  const previewVid = document.getElementById('videoUploadPreview');
  if (previewVid) previewVid.removeAttribute('src');

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

  // Thumbnail state. Cancel any in-flight upload + frame extraction
  // (bumping both tokens makes their .then-handlers no-op), revoke
  // each frame's object URL, and reset the grid tiles to loading.
  pendingVideoThumbnailUrl = null;
  _vuThumbUploadToken++;
  _vuAutoThumbToken++;
  _vuAutoThumbBlobs = [null, null, null, null, null];
  _vuAutoThumbBlobUrls.forEach((u) => { if (u) URL.revokeObjectURL(u); });
  _vuAutoThumbBlobUrls = [null, null, null, null, null];
  _vuSelectedThumbSlot = -1;
  document.querySelectorAll('.vu-thumb-frame-tile').forEach((tile) => {
    tile.classList.add('is-loading');
    tile.classList.remove('is-selected');
    const img = tile.querySelector('img');
    if (img) img.remove();
    const stamp = tile.querySelector('.vu-thumb-frame-time');
    if (stamp) stamp.textContent = '';
  });
  const uploadTile = document.getElementById('vuThumbUploadTile');
  if (uploadTile) {
    uploadTile.classList.remove('is-selected', 'has-image');
    const img = uploadTile.querySelector('img');
    if (img) img.remove();
  }
  _vuRenderThumbStage();

  vuGotoStep(1);
}

// ── Phase 1: File picker ─────────────────────────────────────────────────
// We track the active preview's object URL so we can revoke it when the
// user replaces the file (and again on close). Without revocation, every
// re-pick leaks the previous blob into the page's memory for the rest
// of the session — meaningful on 2 GB videos.
let _vuPreviewObjectUrl = null;

function vuHandleFile(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024 * 1024) {
    toast('Video too large (max 2GB)', 'error');
    return;
  }
  pendingVideoFile = file;

  // Swap the dropzone for the file-selected hero. The two states are
  // mutually exclusive — having both visible at once (as the previous
  // layout did) wasted vertical space and made it ambiguous whether
  // the file had actually been accepted.
  const dropzone = document.getElementById('videoFilePicker');
  const summary  = document.getElementById('vuFileSummary');
  if (dropzone) dropzone.style.display = 'none';
  if (summary)  summary.style.display  = '';

  const preview = document.getElementById('videoUploadPreview');
  if (_vuPreviewObjectUrl) URL.revokeObjectURL(_vuPreviewObjectUrl);
  _vuPreviewObjectUrl = URL.createObjectURL(file);
  preview.src = _vuPreviewObjectUrl;

  document.getElementById('vuFileName').textContent = file.name;
  document.getElementById('vuFileSize').textContent = formatBytes(file.size);

  // Auto-fill title with filename (no extension)
  const titleInput = document.getElementById('videoUploadTitle');
  titleInput.value = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
  document.getElementById('titleCharCount').textContent = titleInput.value.length;

  // Reset any previously extracted frames + chosen thumbnail — the new
  // file means the auto-thumbnails are stale and the user should pick
  // again. Replace-file UX should feel like starting over for the
  // thumbnail step, not silently carrying forward a frame from a
  // different video.
  pendingVideoThumbnailUrl = null;
  _vuAutoThumbBlobs = [null, null, null, null, null];
  _vuAutoThumbBlobUrls.forEach((u) => { if (u) URL.revokeObjectURL(u); });
  _vuAutoThumbBlobUrls = [null, null, null, null, null];
  _vuRenderThumbStage();

  vuRefreshFooter();

  // Read the video's duration via the preview element so we can gate the
  // monetize toggle on step 4 AND know which timecodes to seek to for
  // auto-thumbnail extraction. <video> fires 'loadedmetadata' once
  // .duration is available.
  preview.addEventListener('loadedmetadata', () => {
    pendingVideoDurationSec = Number.isFinite(preview.duration) ? preview.duration : 0;
    syncVuMonetizeGate();
  }, { once: true });
}

// Pending file's duration (filled in by vuHandleFile via loadedmetadata)
let pendingVideoDurationSec = 0;

// ─── Custom thumbnail state (upload wizard, May 2026) ──────────────────
// Authors can now pick a custom thumbnail on the Details step. We upload
// the file to Supabase Storage as soon as it's picked (so the slow part
// of the upload is parallelized with the form-filling), and persist just
// the public URL for the eventual videos-row write. `null` means "use
// Bunny's auto-generated frame" — the existing fallback the webhook
// already handles correctly.
let pendingVideoThumbnailUrl = null;
// Mirror of the in-flight upload — used to guard against double-uploads
// when the user picks a new file before the previous one finishes.
let _vuThumbUploadToken = 0;

async function _vuUploadThumbnailFile(file) {
  if (!file) return null;
  if (!file.type?.startsWith?.('image/')) {
    toast('Please pick an image (JPG, PNG, or WebP)', 'error');
    return null;
  }
  // 5 MB matches the legacy uploadImage() cap. Thumbnails at 1280x720
  // with reasonable JPEG quality come in around 100-200 KB, so even
  // creators pasting screenshots from photo apps land well under this.
  if (file.size > 5 * 1024 * 1024) {
    toast('Image must be smaller than 5 MB', 'error');
    return null;
  }
  if (!currentUser?.id) {
    toast('You must be signed in to upload a thumbnail', 'error');
    return null;
  }
  const safeName = file.name?.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'thumb';
  const ext = (safeName.split('.').pop() || 'jpg').toLowerCase();
  const filename = `video-thumbnails/${currentUser.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from('images').upload(filename, file, {
    contentType: file.type || `image/${ext}`,
    cacheControl: '31536000', // immutable filename → cache aggressively
    upsert: false,
  });
  if (error) {
    toast('Thumbnail upload failed: ' + error.message, 'error');
    return null;
  }
  const { data } = supabase.storage.from('images').getPublicUrl(filename);
  return data?.publicUrl || null;
}

// ─── Thumbnail stage state (May 2026: 6-tile grid) ────────────────────
// The grid renders 6 tiles: tile[0] = "Upload your own", tiles[1..5] =
// 5 auto-extracted frames at evenly-spaced timecodes. State per slot:
//   _vuAutoThumbBlobs[i]   — the Blob produced by canvas.toBlob, kept
//                            so we can upload it to Storage on selection
//                            without re-extracting
//   _vuAutoThumbBlobUrls[i] — object URL for the <img> preview in the
//                            tile. Revoked on file replace / modal reset.
// _vuSelectedThumbSlot:
//   -1 → nothing picked, will fall back to Bunny auto
//   0  → "Upload your own" tile
//   1..5 → corresponding auto frame
let _vuAutoThumbBlobs    = [null, null, null, null, null];
let _vuAutoThumbBlobUrls = [null, null, null, null, null];
let _vuSelectedThumbSlot = -1;

// Auto-frame extraction runs in a single-flight loop: we increment this
// token on every new file pick so a still-running extraction for an old
// file knows to bail and not paint its results into the current grid.
let _vuAutoThumbToken = 0;

/**
 * Extract 5 frames from the picked video at 10/30/50/70/90% of duration
 * and paint them into the tiles in #vuThumbGrid. Runs purely client-side
 * via a hidden <video> + <canvas>; never sends bytes to the server until
 * the user picks one and we upload that single blob.
 *
 * Why a hidden video element instead of reusing the preview in step 1:
 * seeking the visible preview would jump the playhead while the user is
 * watching it. A second offscreen element lets us seek freely without
 * disturbing the UI.
 *
 * Seek-and-capture pattern: set currentTime → wait for `seeked` event →
 * draw to canvas → toBlob. Some Android Chrome builds fire `seeked`
 * before the new frame is actually painted; the 60ms RAF wait absorbs
 * the slip.
 */
async function vuExtractAutoThumbnails(file) {
  if (!file) return;
  const myToken = ++_vuAutoThumbToken;

  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  const objectUrl = URL.createObjectURL(file);
  video.src = objectUrl;

  try {
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('video metadata load failed')), { once: true });
      setTimeout(() => reject(new Error('metadata timeout')), 15000);
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (!duration) {
      // Couldn't read duration — leave the spinners in place rather
      // than render broken tiles. User can still "Upload your own".
      return;
    }

    // 10/30/50/70/90% — endpoints avoided because the very first and
    // very last frames of a video are often black (transitions/fades).
    const pcts = [0.10, 0.30, 0.50, 0.70, 0.90];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < pcts.length; i++) {
      if (myToken !== _vuAutoThumbToken) return; // user picked a new file

      const targetTime = duration * pcts[i];
      try {
        await new Promise((resolve, reject) => {
          const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
          video.addEventListener('seeked', onSeeked, { once: true });
          video.currentTime = targetTime;
          setTimeout(() => reject(new Error('seek timeout')), 8000);
        });
      } catch (err) {
        // Skip this frame, leave its spinner up. Other frames may still succeed.
        if (__DEV__) console.warn('[vuExtractAutoThumbnails] seek failed at', targetTime, err);
        continue;
      }

      // RAF wait absorbs the gap between `seeked` firing and the
      // browser actually painting the new frame to the video element.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (myToken !== _vuAutoThumbToken) return;

      // 1280x720 cap matches Bunny's auto-thumbnail size. Scale down
      // if the source is smaller (we don't want to upscale and blur).
      const vw = video.videoWidth || 1280;
      const vh = video.videoHeight || 720;
      const targetW = Math.min(vw, 1280);
      const targetH = Math.round(targetW * (vh / vw));
      canvas.width = targetW;
      canvas.height = targetH;
      try {
        ctx.drawImage(video, 0, 0, targetW, targetH);
      } catch (err) {
        if (__DEV__) console.warn('[vuExtractAutoThumbnails] draw failed', err);
        continue;
      }

      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
      if (!blob) continue;
      if (myToken !== _vuAutoThumbToken) return;

      // Stash the blob (we'll upload it to Storage when the user picks
      // this slot) and a local object URL for the tile preview.
      _vuAutoThumbBlobs[i] = blob;
      if (_vuAutoThumbBlobUrls[i]) URL.revokeObjectURL(_vuAutoThumbBlobUrls[i]);
      _vuAutoThumbBlobUrls[i] = URL.createObjectURL(blob);

      // Paint into tile i+1 (tile 0 is the "Upload your own" slot).
      _vuRenderAutoThumbTile(i, targetTime);
    }
  } catch (err) {
    if (__DEV__) console.warn('[vuExtractAutoThumbnails] failed:', err?.message || err);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function _vuFormatSeekTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function _vuRenderAutoThumbTile(frameIndex, timeSeconds) {
  const tile = document.querySelector(`.vu-thumb-frame-tile[data-frame-index="${frameIndex}"]`);
  if (!tile) return;
  tile.classList.remove('is-loading');
  // Insert / update the <img>. Re-using the same node when present
  // avoids a brief flicker between frames.
  let img = tile.querySelector('img');
  if (!img) {
    img = document.createElement('img');
    img.alt = '';
    tile.insertBefore(img, tile.firstChild);
  }
  img.src = _vuAutoThumbBlobUrls[frameIndex];
  const stamp = tile.querySelector('.vu-thumb-frame-time');
  if (stamp) stamp.textContent = _vuFormatSeekTime(timeSeconds);
}

/**
 * Repaint the whole thumbnail stage based on _vuSelectedThumbSlot.
 * Mostly toggles `.is-selected` on tiles and the "Thumbnail selected"
 * pill in the header. Loading spinners are driven independently by
 * vuExtractAutoThumbnails as frames land.
 */
function _vuRenderThumbStage() {
  // Selected ring on whichever slot is active.
  document.querySelectorAll('.vu-thumb-grid-tile').forEach((tile) => {
    tile.classList.remove('is-selected');
  });
  const uploadTile = document.getElementById('vuThumbUploadTile');
  if (_vuSelectedThumbSlot === 0 && uploadTile) {
    uploadTile.classList.add('is-selected');
    uploadTile.classList.add('has-image');
  } else if (uploadTile) {
    uploadTile.classList.remove('has-image');
    // If the user previously uploaded an image and is now switching
    // back to a frame, the upload-tile preview <img> can stay — they
    // might re-select it. We just hide the icon overlay via the
    // has-image class.
  }
  if (_vuSelectedThumbSlot >= 1 && _vuSelectedThumbSlot <= 5) {
    const tile = document.querySelector(`.vu-thumb-frame-tile[data-frame-index="${_vuSelectedThumbSlot - 1}"]`);
    if (tile) tile.classList.add('is-selected');
  }

  // Header pill.
  const pill = document.getElementById('vuThumbSelectedPill');
  if (pill) pill.style.display = _vuSelectedThumbSlot >= 0 ? '' : 'none';
}

// Upload-your-own tile — uses the hidden file input. We pre-render the
// chosen image into the upload tile so the user sees what they picked
// inside the same slot.
async function _vuHandleUploadOwnThumbnail(file) {
  if (!file) return;
  const myToken = ++_vuThumbUploadToken;
  // Optimistic preview — render the file into the upload tile right
  // away, even before the Storage upload finishes. If the upload
  // fails the toast surfaces the error and we leave the tile blank.
  const uploadTile = document.getElementById('vuThumbUploadTile');
  let img = uploadTile?.querySelector('img');
  if (!img && uploadTile) {
    img = document.createElement('img');
    img.alt = '';
    uploadTile.insertBefore(img, uploadTile.firstChild);
    Object.assign(img.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover' });
  }
  const previewUrl = URL.createObjectURL(file);
  if (img) img.src = previewUrl;
  _vuSelectedThumbSlot = 0;
  _vuRenderThumbStage();

  try {
    const url = await _vuUploadThumbnailFile(file);
    if (myToken !== _vuThumbUploadToken) return; // newer pick superseded
    if (!url) {
      // Upload failed — undo the selection.
      _vuSelectedThumbSlot = -1;
      _vuRenderThumbStage();
      return;
    }
    pendingVideoThumbnailUrl = url;
    toast('Thumbnail ready', 'success');
    vuRefreshFooter(); // updates Continue → Skip & continue label
  } finally {
    URL.revokeObjectURL(previewUrl);
  }
}

// Frame tile clicks — upload the stashed Blob to Storage as the
// user's thumbnail. Cheaper than the Upload-your-own path since the
// frame is already in memory; no FilePicker round-trip.
async function _vuHandleAutoThumbnailPick(frameIndex) {
  const blob = _vuAutoThumbBlobs[frameIndex];
  if (!blob) return; // tile is still loading
  const myToken = ++_vuThumbUploadToken;
  _vuSelectedThumbSlot = frameIndex + 1;
  _vuRenderThumbStage();

  // Wrap the Blob into a File-like object so _vuUploadThumbnailFile's
  // MIME + size guards behave identically to the user-picked path.
  const namedFile = new File([blob], `auto-frame-${frameIndex + 1}.jpg`, { type: 'image/jpeg' });

  try {
    const url = await _vuUploadThumbnailFile(namedFile);
    if (myToken !== _vuThumbUploadToken) return;
    if (!url) {
      _vuSelectedThumbSlot = -1;
      _vuRenderThumbStage();
      return;
    }
    pendingVideoThumbnailUrl = url;
    toast('Thumbnail ready', 'success');
    vuRefreshFooter();
  } catch (err) {
    if (__DEV__) console.warn('[vuHandleAutoThumbnailPick] upload failed', err);
    _vuSelectedThumbSlot = -1;
    _vuRenderThumbStage();
  }
}

// Wire the grid: clicks on frame tiles + change on the upload input.
document.querySelectorAll('.vu-thumb-frame-tile').forEach((tile) => {
  tile.addEventListener('click', () => {
    const idx = Number(tile.dataset.frameIndex);
    if (Number.isFinite(idx)) _vuHandleAutoThumbnailPick(idx);
  });
});
document.getElementById('vuThumbFile')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // allow re-picking the same file later
  _vuHandleUploadOwnThumbnail(file);
});

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
  // Back works on steps 2-4; step 5 is the upload progress screen (no back).
  if (vuStep > 1 && vuStep < 5) vuGotoStep(vuStep - 1);
});
document.getElementById('vuFooterNext')?.addEventListener('click', async () => {
  if (vuStep === 1) {
    if (!pendingVideoFile) return;
    // Kick off frame extraction now so the Thumbnail step has tiles
    // populated by the time the user lands on it. Fire-and-forget —
    // each frame fills its slot independently as ffmpeg-on-canvas
    // finishes seeking.
    vuExtractAutoThumbnails(pendingVideoFile);
    vuGotoStep(2);
  } else if (vuStep === 2) {
    // Thumbnail step is fully optional. Whatever the user picked (or
    // didn't) flows through; pendingVideoThumbnailUrl drives the
    // final videos row write.
    vuGotoStep(3);
  } else if (vuStep === 3) {
    const title = document.getElementById('videoUploadTitle').value.trim();
    if (!title) { toast('Please add a title', 'error'); return; }
    vuGotoStep(4);
  } else if (vuStep === 4) {
    vuGotoStep(5);
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
    // Tier-3 (May 2026): pass the FULL metadata payload to bunny-upload
    // so the Edge Function can stash it in the new Bunny video's
    // metaTags BEFORE returning the upload URL. After Bunny finishes
    // encoding, the bunny-video-ready webhook reads those metaTags
    // back and inserts BOTH the videos row AND the hidden home-feed
    // post row server-side.
    //
    // Why we no longer call supabase.from('videos').insert(...) +
    // supabase.from('posts').insert(...) here:
    //   The previous architecture had THIS file inserting both rows
    //   directly after the Bunny upload finished. When Supabase had a
    //   Cloudflare 502 mid-upload (May 2026), the file landed safely
    //   on Bunny but the two inserts lost — orphaned video, no feed
    //   post, user thought the upload had failed. Now Bunny calls our
    //   webhook, which is retried server-side until Supabase is
    //   reachable. Uploads survive Supabase outages.
    const isMonetized = document.getElementById('vuMonetized')?.checked || false;
    const uploadInfo = await callEdgeFunction('bunny-upload', {
      title,
      description,
      tags,
      is_monetized: isMonetized,
      scheduled_publish_at: scheduledPublishAt,
      // Web doesn't upload a separate thumbnail to Bunny Storage —
      // Bunny auto-generates one from the video. The webhook falls
      // back to the auto-generated thumbnail URL when this is empty.
      thumbnail_key: '',
      // Web flow needs the hidden home-feed post created server-side
      // (videos surface on the home feed via posts).
      create_feed_post: true,
    });

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

    // Bunny upload complete. The videos row + hidden home-feed post
    // are normally created server-side by the bunny-video-ready
    // webhook when Bunny finishes encoding (typically 5-30 seconds).
    //
    // BUT — May 2026 — we observed orphaned uploads on web: file
    // present in Bunny, zero matching row in `videos`, invisible in
    // Studio. The mobile side already mitigates this with a
    // client-side `createNewVideo` call (lib/video-supabase.js) that
    // runs alongside the webhook so either path lands the row. The
    // web flow had no such safety net — when the webhook silently
    // no-op'd (200 response with no insert, a known issue
    // documented in UploadVideo.jsx), the upload became a permanent
    // orphan.
    //
    // Fix: do the same client-side insert here as a safety net.
    // Field shape mirrors the webhook's insertPayload exactly
    // (functions/bunny-video-ready/index.ts ~L261-274), and we
    // upsert with onConflict: 'bunny_video_id' + ignoreDuplicates so
    // whichever side fires first wins. Status is 'processing' here
    // (the client knows the bytes are uploaded but not that Bunny
    // has finished encoding) — the webhook later promotes to
    // 'ready'. Wrapped in try/catch because the file IS safely on
    // Bunny at this point; we don't want to fail the user-visible
    // "Done" state if the DB write hiccups — log loudly so we can
    // diagnose orphans rather than silently lose them.
    // Custom thumbnail override (May 2026). When the author picked a
    // cover on the Details step we've already uploaded it to Supabase
    // Storage (pendingVideoThumbnailUrl), so prefer that URL over the
    // Bunny auto-generated frame. Falls back to uploadInfo.thumbnailUrl
    // (Bunny auto) when no custom thumbnail was provided.
    const finalThumbnailUrl = pendingVideoThumbnailUrl || uploadInfo.thumbnailUrl;

    try {
      const { error: insertErr } = await supabase
        .from('videos')
        .upsert(
          {
            bunny_video_id: uploadInfo.videoId,
            bunny_library_id: String(uploadInfo.libraryId),
            title,
            description,
            tags,
            video_url: uploadInfo.videoUrl,
            thumbnail_url: finalThumbnailUrl,
            uploader_id: currentUser.id,
            status: 'processing',
            is_monetized: isMonetized,
            scheduled_publish_at: scheduledPublishAt,
            is_hidden: scheduledPublishAt ? true : false,
          },
          { onConflict: 'bunny_video_id', ignoreDuplicates: true },
        );
      if (insertErr) {
        console.warn('[vuStartUpload] client-side videos upsert failed (webhook may still land row):', insertErr.message);
      } else {
        console.log('[vuStartUpload] client-side videos row written for', uploadInfo.videoId);
      }
    } catch (e) {
      console.warn('[vuStartUpload] client-side videos upsert exception:', e?.message || e);
    }

    // Custom-thumbnail race fix: if the bunny-video-ready webhook beat
    // our client-side upsert (rare — webhook normally fires minutes
    // later, after Bunny finishes encoding), the row already exists
    // with Bunny's auto thumbnail and our upsert no-op'd (because
    // ignoreDuplicates:true). Fire an explicit UPDATE so the author's
    // chosen cover wins regardless of insert ordering. No-op when the
    // user didn't pick a custom thumbnail (the upsert already set the
    // Bunny URL in that case).
    if (pendingVideoThumbnailUrl) {
      try {
        const { error: thumbUpdateErr } = await supabase
          .from('videos')
          .update({ thumbnail_url: pendingVideoThumbnailUrl })
          .eq('bunny_video_id', uploadInfo.videoId);
        if (thumbUpdateErr) {
          console.warn('[vuStartUpload] custom-thumbnail follow-up update failed:', thumbUpdateErr.message);
        }
      } catch (e) {
        console.warn('[vuStartUpload] custom-thumbnail follow-up update exception:', e?.message || e);
      }
    }

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

    // Footer "Done" stays as a fallback (in case someone closes the
    // success modal and lands back on the upload progress screen) but
    // the primary celebration is now the dedicated success modal —
    // see _vuShowSuccessModal below. The previous flow relied solely on
    // this small footer button, which buried the success state and
    // gave users no clear next action.
    next.disabled = false;
    next.textContent = 'Done';
    next.onclick = () => {
      closeVideoUploadModal();
      if (videosPage.style.display === 'block') { invalidateAllVideosCache(); loadVideos(); }
      if (feedEl.style.display !== 'none') window.loadFeed?.();
    };

    _vuShowSuccessModal({
      thumbnailUrl: pendingVideoThumbnailUrl || uploadInfo.thumbnailUrl,
      scheduledPublishAt,
    });

    toast(scheduledPublishAt ? 'Scheduled — processing now' : 'Uploaded — processing now', 'success');
  } catch (err) {
    console.error('Upload failed:', err);
    status.textContent = 'Upload failed';
    speedEl.textContent = '';
    heroIcon.outerHTML = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" id="vuUploadIcon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    heroTitle.textContent = 'Upload failed';
    // Step 4 (Visibility) used to be step 3 — the retry navigation
    // jumps back to Visibility so the user can re-confirm scheduling
    // before re-uploading.
    heroSub.textContent = err.message || 'Something went wrong. Try again.';
    next.disabled = false;
    next.textContent = 'Try again';
    next.onclick = () => { vuGotoStep(4); next.onclick = null; vuRefreshFooter(); };
    toast('Upload failed: ' + err.message, 'error');
  }
}

// ─── Upload success modal (May 2026) ──────────────────────────────────
// Centered confirmation dialog that pops on top of the upload wizard
// once the bytes are safely on Bunny. Replaces the previous "small green
// Done button" pattern, which buried the success state and made the
// upload feel unfinished from the user's POV.
//
// CTAs:
//   • View in Studio    — close the wizard, jump straight to the Studio
//                         tab where the new video is already visible
//                         (status: processing → ready in 5-30s).
//   • Upload another    — close the wizard and reopen it fresh, ready
//                         for a back-to-back upload.
function _vuShowSuccessModal({ thumbnailUrl, scheduledPublishAt }) {
  const modal     = document.getElementById('vuSuccessModal');
  const titleEl   = document.getElementById('vuSuccessTitle');
  const bodyEl    = document.getElementById('vuSuccessBody');
  const thumbWrap = document.getElementById('vuSuccessThumbWrap');
  const thumbImg  = document.getElementById('vuSuccessThumb');
  if (!modal) return;

  if (scheduledPublishAt) {
    titleEl.textContent = 'Scheduled!';
    bodyEl.textContent  = `Your video will go live on ${new Date(scheduledPublishAt).toLocaleString()} once Selebox finishes encoding it.`;
  } else {
    titleEl.textContent = 'Upload complete!';
    bodyEl.textContent  = 'Your video will appear publicly the moment Selebox finishes encoding it.';
  }

  if (thumbnailUrl) {
    thumbImg.src = thumbnailUrl;
    thumbWrap.style.display = '';
  } else {
    thumbImg.removeAttribute('src');
    thumbWrap.style.display = 'none';
  }

  modal.style.display = 'flex';
}

function _vuHideSuccessModal() {
  const modal = document.getElementById('vuSuccessModal');
  if (modal) modal.style.display = 'none';
}

document.getElementById('vuSuccessViewStudio')?.addEventListener('click', () => {
  _vuHideSuccessModal();
  closeVideoUploadModal();
  // Best-effort navigation to Studio. The Studio nav button id and
  // function names vary across this file's history; try the most
  // common entry points in order and stop at the first one that
  // actually exists.
  if (typeof showStudio === 'function') {
    try { showStudio(); return; } catch {}
  }
  const studioBtn = document.querySelector('[data-nav="studio"], #navStudio, #studioNavBtn');
  if (studioBtn && typeof studioBtn.click === 'function') {
    studioBtn.click();
    return;
  }
  // Last resort — at least refresh the Videos list so the new row shows up.
  if (videosPage?.style.display === 'block') {
    invalidateAllVideosCache();
    loadVideos();
  }
});

document.getElementById('vuSuccessUploadAnother')?.addEventListener('click', () => {
  _vuHideSuccessModal();
  resetVideoUploadModal();
  // Modal already open — resetVideoUploadModal puts us back on step 1
  // with a clean slate, ready to pick the next file.
});

// Backdrop click on the success overlay dismisses it (matches the
// rest of the modal layer's behavior). Clicks on the inner card are
// intercepted by the card itself.
document.getElementById('vuSuccessModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'vuSuccessModal') {
    _vuHideSuccessModal();
    closeVideoUploadModal();
  }
});

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
  // Flush any in-progress chapter dwell before the reader page goes
  // away. Catches all nav-out paths (back button, sidebar tab change,
  // deep-link, etc.) since they all funnel through here. flushReadClose
  // is a no-op when no chapter is open.
  if (chapterReaderPage && chapterReaderPage.style.display !== 'none') {
    try { flushReadClose(); } catch {}
  }
  // Same for video — flush an in-flight watched-seconds 'end' event.
  if (videoPlayerPage && videoPlayerPage.style.display !== 'none') {
    try { flushViewEnd(); } catch {}
  }
  // Drop layout-mode body classes — each show* opts back in if it needs a
  // wider canvas. (Currently used by the videos and books pages.)
  document.body.classList.remove('on-videos', 'on-books', 'on-home-landing', 'on-studio');
  feedEl.style.display = 'none';
  storiesEl.style.display = 'none';
  composeEl.style.display = 'none';
  // Feed mode tabs (For You / Following / Discover) — only on the Post feed
  const feedTabs = document.getElementById('feedTabs');
  if (feedTabs) feedTabs.style.display = 'none';
  // New curated landing page — Home tab (May 2026 redesign). Lives parallel
  // to the social feed so each sidebar item maps to its own surface.
  const homeLanding = document.getElementById('homeLanding');
  if (homeLanding) homeLanding.style.display = 'none';
  if (profilePage) profilePage.style.display = 'none';
  if (videosPage) videosPage.style.display = 'none';
  if (videoPlayerPage) videoPlayerPage.style.display = 'none';
  if (studioPage) studioPage.style.display = 'none';
  if (bookPage) bookPage.style.display = 'none';
  if (authorPage) authorPage.style.display = 'none';
  if (bookDetailPage) bookDetailPage.style.display = 'none';
  if (chapterReaderPage) chapterReaderPage.style.display = 'none';
  if (bookmarksPage) bookmarksPage.style.display = 'none';
  if (messagesPage) {
    // Codex P2/#213 fix — tear down the active conversation's realtime
    // + presence channels when the Messages page leaves the screen.
    // Without this, switching to any other tab (Home, Books, etc.) left
    // the Supabase subscriptions running in the background until the
    // tab was closed. Safe no-op when no conversation was active.
    if (messagesPage.style.display !== 'none') {
      try { teardownActiveConversation(); } catch {}
    }
    messagesPage.style.display = 'none';
  }
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


function showStudio(forceReload = false) {
  hideAllMainPages();
  studioPage.style.display = 'block';
  document.body.classList.remove('on-videos');
  // Edge-to-edge canvas — Studio mosaic looks cramped inside the
  // feed's 900px reading column. CSS rule on `body.on-studio
  // .main-wrap` lifts the max-width and zeroes the lateral padding.
  document.body.classList.add('on-studio');
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

// (Tab switching, See-All click delegation, and See-All back wiring all
// migrated to wireBooksPage() in js/books.js as part of Stage 8A. The
// initBooks({…}) + wireBooksPage() pair near the top of this file owns
// the boot-time attach now.)

let _hasMoreBooks = true;
let _isLoadingMoreBooks = false;
let _bookScrollObserver = null;
let _booksSeq = 0;
let _booksLoadedSort = null;
let _booksLoadedGenre = null;

// Format a number compactly: 1234 → "1.2k", 1500000 → "1.5M"
function formatCompact(n) {
  if (n == null) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

// (`_pendingChapterFromUrl` removed in Stage 8B Codex review — it was
// set by the boot router + popstate handler but never read. Deep-linked
// chapters are now threaded through openBookDetail(bookId, { chapter })
// instead.)

// (Back-to-books, theme-toggle watermark sync, reader anti-copy IIFE, and
// the five reader nav buttons all migrated to wireBookReader() in
// js/books.js as part of Stage 8B. App.js calls it after wireBooksPage()
// near the initBooks({…}) block.)

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
    // Inline onclick can't see module-scoped imports (`showVideos`,
    // `setSidebarActive`) since the migration to ES modules — Codex P3.
    // Wire the CTA via a real listener after innerHTML lands.
    wrap.innerHTML = `
      <div class="bookmarks-empty">
        <div class="bookmarks-empty-icon">🎬</div>
        <h3>No saved videos yet</h3>
        <p>Tap the <strong>Bookmark</strong> button on any video to save it here.</p>
        <button class="btn btn-purple btn-sm" id="btnBookmarksBrowseVideos">Browse videos</button>
      </div>`;
    document.getElementById('btnBookmarksBrowseVideos')?.addEventListener('click', () => {
      setSidebarActive('btnVideos');
      showVideos();
    });
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
    // Inline onclick can't see module-scoped imports (`showBook`,
    // `setSidebarActive`) since the migration to ES modules — Codex P3.
    // Wire the CTA via a real listener after innerHTML lands.
    wrap.innerHTML = `
      <div class="bookmarks-empty">
        <div class="bookmarks-empty-icon">📚</div>
        <h3>No saved books yet</h3>
        <p>Tap the <strong>Bookmark</strong> button on any book to save it for later.</p>
        <button class="btn btn-purple btn-sm" id="btnBookmarksBrowseBooks">Browse books</button>
      </div>`;
    document.getElementById('btnBookmarksBrowseBooks')?.addEventListener('click', () => {
      setSidebarActive('btnBook');
      showBook();
    });
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

// ════════════════════════════════════════════════════════════════════════
// Earnings read/render layer MOVED to js/earnings.js (Stage 11A).
// ~1,000 lines covering loadAuthorEarnings + breakdown modal + all
// totals/balance/recent-list/withdrawal-list rendering.
//
// Bridges still here in app.js (queued for later stages):
//   • Stage 11B (#250) — KYC + Payments Info form subsystem
//   • Stage 11C (#251) — Withdrawal request flow + Pioneer helpers
//
// formatPhpFromMinor is re-imported at the top of this file so the
// withdrawal-flow handlers (still in app.js) and the _cfg passthrough
// to other modules keep working.
// ════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════
// KYC + Payments Info form subsystem MOVED to js/earnings.js (Stage 11B).
// ~437 lines, 10 functions: renderAuthorKycBanner, syncAuthorPayoutButton,
// uploadKycImage, wireKycUpload, fillPaymentsInfoForm, applyPaymentsInfo-
// LockState, openPaymentInfoChangeModal, closePaymentInfoChangeModal,
// createPaymentInfoChangeModal, submitPaymentInfoChange.
//
// Stage 11A bridges (_cfg.renderAuthorKycBanner / syncAuthorPayoutButton /
// fillPaymentsInfoForm) are now intra-module direct calls. The 3 entries
// were dropped from app.js's initEarnings({...}) block too.
//
// Stage 11C — withdrawal request flow — still below.
// ════════════════════════════════════════════════════════════════════════
// ── Withdrawal modal wiring (strict — server pulls saved Payments Info) ─
const PAYMENT_METHOD_LABELS = { gcash: 'GCash', maya: 'Maya', bank: 'Bank transfer', gotyme: 'GoTyme' };

document.getElementById('btnRequestPayout')?.addEventListener('click', () => {
  // Always re-derive these from cache so admin rate changes are reflected
  const minPhpMinor   = _walletConfigDefaults.min_payout_php_minor || 10000;
  const availPhpMinor = getAuthorBalance()?._computed_available_minor ??
                        (getAuthorBalance()?.available_php_minor || 0);

  const minModal = document.getElementById('minPayoutModal');

  // ── PRIORITY 1: No Payments Info saved → walk them to it ──
  // Even if they have ₱0 they should know payment info is required.
  if (!getAuthorKyc()?.payment_method) {
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
  const methodLabel = PAYMENT_METHOD_LABELS[getAuthorKyc().payment_method] || getAuthorKyc().payment_method;
  document.getElementById('withdrawalAccountMethod').textContent = methodLabel;
  document.getElementById('withdrawalAccountName').textContent   = getAuthorKyc().full_name || '(no name on file)';

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
  const payoutMethod  = getAuthorKyc()?.payment_method || '';
  const payoutDetails = {
    full_name:      getAuthorKyc()?.full_name      || null,
    account_number: getAuthorKyc()?.account_number || null,
    account_name:   getAuthorKyc()?.account_name   || null,
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

  // Lock to 2:3 — the canonical book-cover ratio. Mobile uses it for
  // every render path, and every web display surface (For You,
  // Discover, Ranking, detail page, home shelves) frames covers at
  // 2:3 via aspect-ratio CSS. The previous NaN (free crop) was added
  // to fix one symptom (titles clipped on 9:16 uploads) but caused a
  // bigger one (covers landed at random aspect ratios → display layer
  // had to letterbox-or-zoom-crop them forever). Better fix: tell the
  // author to crop their 9:16 source to 2:3 here, once, instead of
  // chasing the consequences across every shelf and detail page.
  // Cropper.js shows a draggable 2:3 box over the source so creators
  // can pick the best 2:3 window of their original at upload time.
  openCropModal(file, {
    aspectRatio: 2 / 3,
    title: 'Crop book cover (2:3)',
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
    // ─── Paste normalizer: preserve paragraphs from Word / Google Docs ──
    // Authors report (user feedback, May 2026) that pasting manuscript
    // text from Word or Google Docs collapses paragraph spacing into one
    // wall of text. Two common shapes cause it:
    //
    //   1. Google Docs wraps the entire copied selection in a single
    //      <b id="docs-internal-guid-..."> tag — a clipboard-fidelity
    //      hack on Google's end. Downstream HTML→Delta matchers see the
    //      outer <b> and treat the inner <p> blocks as inline children,
    //      so paragraph boundaries vanish.
    //   2. MS Word emits each paragraph as <p class="MsoNormal" style=
    //      "margin-top: 14pt"> with <o:p> namespaced tags inside.
    //      Stripping the style strips the visual spacing AND, depending
    //      on how the matcher walks the tree, sometimes drops the <p>
    //      boundary along with it.
    //
    // We intercept the native paste event BEFORE Quill's clipboard
    // module runs, sanitize the HTML into a known-good shape
    // (<p>…</p><p>…</p>), and hand it back via dangerouslyPasteHTML at
    // the current selection. Plain-text fallback (clipboard has no
    // text/html) splits blank-line-separated chunks into paragraphs to
    // match normalizeChapterContent's reader-side behaviour, so what
    // the author sees in the editor matches what readers will see.
    function _normalizePastedManuscriptHtml(rawHtml) {
      let html = String(rawHtml || '');
      if (!html.trim()) return '';

      // Strip MS Office namespaced tags, conditional comments, and any
      // <style>/<script>/<meta>/<link> the source HTML brought along.
      // <style> in particular needs to go — Word emits hundreds of
      // mso-* selectors that don't affect Quill but leave noise that
      // can break the regex-based <p> detection below.
      html = html
        .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
        .replace(/<\/?o:p\b[^>]*>/gi, '')
        .replace(/<\/?w:[^>]*>/gi, '')
        .replace(/<\/?meta\b[^>]*>/gi, '')
        .replace(/<\/?link\b[^>]*>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '');

      // Parse the cleaned HTML through DOMParser. When the source is a
      // full document (<html><body>...</body></html>) the parser puts
      // everything sensible into doc.body — exactly what we want.
      let doc;
      try {
        doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
      } catch {
        return html; // unparseable; fall back to handing Quill the raw HTML
      }
      const root = doc.body;
      if (!root) return html;

      // Unwrap the Google Docs <b id="docs-internal-guid-..."> wrapper.
      // Inner children are real <p>s — promote them to siblings of <b>,
      // then remove <b>. After this pass the structure looks like a
      // normal HTML fragment.
      root.querySelectorAll('b[id^="docs-internal-guid-"]').forEach(node => {
        while (node.firstChild) node.parentNode.insertBefore(node.firstChild, node);
        node.remove();
      });

      // Strip class/style/lang/dir/id from every node. Quill's matchers
      // discard most of this on their own, but pre-cleaning avoids the
      // edge case where Word's `margin-top: 14pt` on a <p> confuses the
      // block-formatter into emitting an empty soft break instead of a
      // hard paragraph break — the exact failure mode users reported.
      root.querySelectorAll('*').forEach(el => {
        el.removeAttribute('class');
        el.removeAttribute('style');
        el.removeAttribute('lang');
        el.removeAttribute('dir');
        el.removeAttribute('id');
      });

      // Convert <div> wrappers into <p>. Some sources (browser-default
      // contenteditable, a few rich-text web apps) emit <div>line</div>
      // per paragraph; Quill flattens consecutive <div>s into soft
      // breaks. Promoting to <p> forces real block boundaries.
      root.querySelectorAll('div').forEach(div => {
        const p = doc.createElement('p');
        while (div.firstChild) p.appendChild(div.firstChild);
        div.replaceWith(p);
      });

      return root.innerHTML;
    }

    chapterQuill.root.addEventListener('paste', (e) => {
      if (!e.clipboardData) return;
      const html = e.clipboardData.getData('text/html');
      const text = e.clipboardData.getData('text/plain');
      if (!html && !text) return;

      let normalized = '';
      if (html) {
        normalized = _normalizePastedManuscriptHtml(html);
      } else {
        // Plain-text fallback: blank-line-separated chunks → <p>, single
        // newlines inside a chunk → <br>. Mirrors the reader-side
        // normalizeChapterContent() so authors and readers agree.
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        normalized = text
          .split(/\n\s*\n/)
          .filter(chunk => chunk.trim().length > 0)
          .map(chunk => `<p>${esc(chunk).replace(/\n/g, '<br>')}</p>`)
          .join('');
      }

      // Empty after normalization (e.g. user pasted only whitespace or
      // only a <style> block) — fall through to Quill's default handler.
      if (!normalized || !normalized.trim()) return;

      e.preventDefault();
      e.stopPropagation();
      try {
        const range = chapterQuill.getSelection(true);
        if (range && typeof range.index === 'number') {
          // Replace the active selection (if any), then insert at the
          // resulting caret. dangerouslyPasteHTML in Quill 2 advances
          // the selection to the end of the inserted content for us.
          if (range.length > 0) chapterQuill.deleteText(range.index, range.length, 'user');
          chapterQuill.clipboard.dangerouslyPasteHTML(range.index, normalized, 'user');
        } else {
          chapterQuill.clipboard.dangerouslyPasteHTML(normalized, 'user');
        }
      } catch (err) {
        console.error('chapter paste normalizer failed:', err);
      }
    }, { capture: true });

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

// ════════════════════════════════════════════════════════════════════════
// Creator Studio moved to js/studio.js (Stage 4, 2026-05-15). The original
// block lived here from line ~15624 to ~16795 and owned: ~30 studio* state
// vars (cache, search, sort, filter, page, selection), loadStudio,
// renderStudio, renderStudioRow, openStudioEditModal + saveStudioEdit,
// _renderStudioEditThumb + _studioEditHandleThumbPick + thumbnail picker
// listeners, openStudioShareModal (with its own internal listeners),
// toggleStudioMonetize, deleteStudioVideo, maybeFlushDueScheduledVideos,
// _studioDeriveVisibility, _studioGetSortValue, and the btnStudioUpload
// click handler.
//
// What stays here: showStudio() at ~line 9461 (sidebar nav entry). It now
// imports loadStudio from ./studio.js. The btnStudio sidebar listener
// stays unchanged; it calls showStudio() which in turn calls loadStudio().
//
// Drive-by fix bundled in: the share modal used to call a `esc()` helper
// that didn't exist at module scope (local const inside a different fn),
// so Share would have thrown ReferenceError under certain code paths.
// Replaced with the imported escHTML during the move.
// ════════════════════════════════════════════════════════════════════════

function showVideoPlayer() {
  hideAllMainPages();
  videoPlayerPage.style.display = 'block';
  // CRITICAL: enables full-bleed layout (body.on-videos .main-wrap rule).
  // Without this the player gets the default narrow main-wrap width when
  // navigating from a user's wall (skipping showVideos), leaving big empty
  // gutters left/right of the video.
  document.body.classList.add('on-videos');
  // Idempotent — attaches native play/pause/ended/timeupdate listeners
  // ONCE on first show. Subsequent calls are no-ops thanks to the
  // _videoEventsInit flag inside the helper.
  _initVideoEventLogging();
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


export async function playVideo(videoId) {
  try {
    let video = null;
    let uploader = null;

    // All videos are now Supabase. Cache holds the most recent ~100 platform-wide,
    // but profiles can list older uploads — so a cache miss is normal and not an error.
    // Try the cache first, then fall back to a direct fetch by ID.
    if (!getAllVideos().length) {
      const fresh = await fetchSupabaseVideos();
      setAllVideos(fresh);
    }
    let cached = findVideoInCache(videoId);
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
      addToVideosCache(cached);
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

    // Save position every 3 seconds + accumulate watch-time toward
    // the "Watch N mins of video" daily goal. tickGoal('watch_video',
    // 1) fires once per full minute of actual playback (paused time
    // doesn't count). Mirrors mobile at app/(video)/video-player.jsx.
    // _accumWatchSec lives on the player element so we don't pollute
    // module scope and so it resets cleanly when the player is reused.
    player._accumWatchSec = player._accumWatchSec || 0;
    player._lastTickSec   = (player.currentTime > 0) ? player.currentTime : 0;
    let saveInterval = setInterval(() => {
      if (!player.paused && player.currentTime > 0) {
        saveResumeTime(videoId, player.currentTime, player.duration);

        // Watch-time accumulator. Use the *delta* between samples so
        // seeking forward doesn't farm the counter (a 30-second skip
        // only adds 3 seconds — the interval tick width — to the
        // accumulator). On backward seek the delta goes negative,
        // which we clamp to zero so a rewind doesn't reduce credit.
        const delta = Math.max(0, Math.min(3, player.currentTime - player._lastTickSec));
        player._lastTickSec   = player.currentTime;
        player._accumWatchSec = (player._accumWatchSec || 0) + delta;
        // Fire ONE minute-tick per 60s crossed. Loop in case the
        // interval was paused (browser tab background throttling) and
        // we accumulated multiple minutes at once.
        while (player._accumWatchSec >= 60) {
          tickGoal('watch_video', 1);
          player._accumWatchSec -= 60;
        }
      } else if (!player.paused && player.currentTime > 0) {
        // Player resumed after a pause — update the baseline so the
        // first delta after resume doesn't credit paused time.
        player._lastTickSec = player.currentTime;
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

  // ── Record a unique view (May 2026 parity fix) ──────────────────────
  // Mobile inserts into public.video_views on open; web previously had
  // no view-recording path at all, so videos.views_count never advanced
  // from web traffic. Composite PK (video_id, viewer_id) makes this
  // idempotent — a returning viewer hits ON CONFLICT and the trigger
  // doesn't double-count. We deliberately don't await this; the player
  // shouldn't block on analytics.
  if (supabaseVideoId && currentUser?.id) {
    // Strip the 'sb_' prefix that resolveSupabaseVideoId prepends for
    // cache lookups. The DB column is the bare UUID.
    const rawVideoId = supabaseVideoId.startsWith('sb_')
      ? supabaseVideoId.slice(3)
      : supabaseVideoId;
    // Fire-and-forget. Swallow errors silently — RLS or transient
    // network blips here must never interrupt playback.
    supabase
      .from('video_views')
      .upsert({ video_id: rawVideoId, viewer_id: currentUser.id }, { onConflict: 'video_id,viewer_id', ignoreDuplicates: true })
      .then(({ error }) => {
        if (error) console.warn('[recordVideoView] failed (non-fatal):', error.message);
      });
  }

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
    // Default destination when no deep link matched — curated home
    // landing (May 2026). The post feed lives behind the Post tab now.
    setSidebarActive('btnHome');
    showHomeLanding();
  }
});

// ── Theme toggle ──
// May 2026: moved from topbar sun-icon button to a segmented radio
// in the sidebar (above Log out). The selected option carries the
// purple-glass highlight via `.is-selected`; we keep aria-checked in
// sync for screen readers, and persist the choice in localStorage.
function applyTheme(theme) {
  if (theme === 'light') document.body.classList.add('light');
  else document.body.classList.remove('light');
  // Sync the segmented radio UI to match the applied theme.
  const options = document.querySelectorAll('#sidebarThemeToggle .sidebar-theme-option');
  options.forEach((btn) => {
    const isSelected = btn.dataset.theme === theme;
    btn.classList.toggle('is-selected', isSelected);
    btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
  });
}
applyTheme(localStorage.getItem('selebox_theme') || 'dark');

document.querySelectorAll('#sidebarThemeToggle .sidebar-theme-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    const newTheme = btn.dataset.theme === 'light' ? 'light' : 'dark';
    if ((newTheme === 'light') === document.body.classList.contains('light')) return; // no-op
    applyTheme(newTheme);
    localStorage.setItem('selebox_theme', newTheme);
  });
});


// ════════════════════════════════════════════════════════════════════════════
// DAILY QUESTS
// ════════════════════════════════════════════════════════════════════════════
// Cross-platform reward feature backed by Supabase
// (migration_goals_progress.sql: `user_goal_progress`, `user_goal_claims`,
// RPCs `tick_user_goal` + `claim_user_goal_pool`). Web + mobile share
// the same tables — opening this panel on either surface shows the
// same state.
//
// `_dailyQuestsState` below is the in-memory rendering state. Progress
// values are kept in sync via three paths:
//   1. _fetchGoalsFromSupabase()  — server → state on panel open
//   2. tickGoal() / tickGoalUnique() — engagement events fire the
//      tick_user_goal RPC and bump local state optimistically (see
//      the helpers near `_QUEST_ID_MAP`). Call sites are spread
//      across the engagement layer: openChapterReader, video-player
//      saveInterval, handleReaction, submitComment, toggleFollow,
//      the unlock_content / unlock_book_bulk RPCs, and onSignedIn.
//   3. _saveDailyQuestsToStorage() — localStorage cache keeps the
//      panel painting instantly on next open.
//
// Quests are organized to drive the behaviors we actually want: open
// the app, read chapters (the core engagement metric), watch videos,
// engage socially. The pool reward model (clear N of M quests to
// claim the pool) keeps the daily payout envelope strictly bounded.

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
  // Seeded at 0 (May 2026 — was 7, which was a hardcoded demo value
  // that pretended the user had a 7-day streak on first paint).
  // Real streak source isn't yet plumbed end-to-end; until it is,
  // the badge stays hidden when streak === 0 (see renderDailyQuests).
  streak: 0,
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
    // Streak intentionally NOT restored from localStorage (May 2026).
    // The previous code seeded a hardcoded `streak: 7` demo value that
    // got persisted on first save, then resurrected on every reload —
    // so even after zeroing the seed, returning users still saw a
    // fake "7" on the topbar trophy. Until a real streak source is
    // wired (server-side compute or mobile-synced field), the streak
    // stays at the in-memory seed (0) which hides the badge.
    // if (typeof saved.streak === 'number') _dailyQuestsState.streak = saved.streak;
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
      // streak persistence intentionally omitted (May 2026) — see
      // matching note in _loadDailyQuestsFromStorage. We write a
      // sentinel 0 so any existing cache holding a stale "7" gets
      // overwritten on the first save after this deploy.
      streak: 0,
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

// ─── Goal dispatch (May 2026 — closes web-vs-mobile parity gap) ─────
// `tickGoal(category, delta)` mirrors mobile's lib/goals-store.js
// export of the same name. Web engagement events (chapter open,
// video minute crossed, like, follow, share, unlock, login) call
// this helper instead of building their own RPC payload. Each event
// fans out to up to three periods (daily / weekly / monthly) per the
// QUEST_ID_MAP table — same map mobile uses, kept in sync by hand.
//
// On call we ALSO bump the matching row in `_dailyQuestsState[tab]`
// so the panel reflects the new progress instantly without waiting
// for the next _fetchGoalsFromSupabase(). The server-side RPC is
// fire-and-forget — local state is already correct, a failed network
// hop just means the next panel-open re-syncs from the source of
// truth.
const _QUEST_ID_MAP = {
  login:         { daily: 'login',         weekly: null,              monthly: null              },
  read_chapters: { daily: 'read_chapters', weekly: 'w_read_chapters', monthly: 'm_read_chapters' },
  watch_video:   { daily: 'watch_video',   weekly: 'w_watch_video',   monthly: 'm_watch_video'   },
  like_comment:  { daily: 'like_comment',  weekly: 'w_like_comment',  monthly: 'm_like_comment'  },
  follow_user:   { daily: 'follow_user',   weekly: 'w_follow_users',  monthly: 'm_follow_users'  },
  share:         { daily: null,            weekly: 'w_share',         monthly: 'm_share'         },
  unlock:        { daily: null,            weekly: 'w_unlock',        monthly: 'm_unlock'        },
  watch_ads:     { daily: 'watch_ads',     weekly: 'w_watch_ads',     monthly: 'm_watch_ads'     },
  invite_friend: { daily: 'invite_friend', weekly: 'w_invite_friend', monthly: 'm_invite_friend' },
  purchase_coin: { daily: null,            weekly: 'w_purchase_coin', monthly: 'm_purchase_coin' },
  active_day:    { daily: null,            weekly: null,              monthly: 'm_active30'      },
};

// Bump the matching quest's progress in the local state for optimistic
// UI. Cap at the target so we never render "11/10 chapters".
function _optimisticBumpGoal(period, questId, delta) {
  const list = _dailyQuestsState[period];
  if (!Array.isArray(list)) return;
  const q = list.find((x) => x.id === questId);
  if (!q) return;
  q.progress = Math.min((q.progress || 0) + delta, q.target || Infinity);
}

// Public-facing dispatcher. Categories are stable abstract names; the
// underlying quest IDs are the implementation detail tracked in
// _QUEST_ID_MAP. Callers stay simple: `tickGoal('read_chapters')`.
function tickGoal(category, delta = 1) {
  if (!currentUser?.id) return; // logged-out — no goals
  const map = _QUEST_ID_MAP[category];
  if (!map) { console.warn('[goals] unknown category', category); return; }
  if (!Number.isFinite(delta) || delta === 0) return;
  for (const period of ['daily', 'weekly', 'monthly']) {
    const questId = map[period];
    if (!questId) continue;
    _optimisticBumpGoal(period, questId, delta);
    _fireTickGoalRpc(period, { [questId]: delta });
  }
  // Persist the optimistic state so a quick reload doesn't flicker
  // back to the pre-tick values before _fetchGoalsFromSupabase lands.
  try { _saveDailyQuestsToStorage?.(); } catch {}
  // Re-render the panel if it's open, so the user watches the bar
  // advance as soon as the event lands.
  try { if (_dailyQuestsPanelOpen) renderDailyQuests?.(); } catch {}
}

// Deduped tick — used for things like read_chapters where a user
// could re-open the same chapter multiple times in one day; we only
// want the first open to count. Local-only dedup, mirrors mobile's
// SEEN_PREFIX approach. Server-side dedup is a future hardening.
const _GOAL_SEEN_PREFIX = 'selebox_goal_seen_v1';
function tickGoalUnique(category, uniqueKey, delta = 1) {
  if (!currentUser?.id || !uniqueKey) return false;
  if (!_QUEST_ID_MAP[category]) return false;
  const dayKey = _periodKeyDaily();
  const storageKey = `${_GOAL_SEEN_PREFIX}:${dayKey}:${category}`;
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(storageKey) || '[]') || []; } catch {}
  if (seen.includes(uniqueKey)) return false;
  seen.push(uniqueKey);
  try { localStorage.setItem(storageKey, JSON.stringify(seen)); } catch {}
  tickGoal(category, delta);
  return true;
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

// Atomic claim. Returns the full RPC envelope so callers can surface
// server-side rejections (goals_threshold_not_met,
// required_goal_incomplete, no_progress, …) instead of treating every
// failure as a generic ok:false. Pre-fix this collapsed every non-ok
// to {ok:false} with no reason, which is what made the "I clicked
// claim and nothing happens" reports invisible to us — the optimistic
// pool.claimed=true flip stuck around just long enough for the user
// to see the green ✓ Claimed pill, then loadWalletState/cron refresh
// reverted it (no user_goal_claims row was ever written), making the
// button reappear.
async function _fireClaimGoalPoolRpc(period, reward = { stars: 0, coins: 0 }) {
  if (!currentUser?.id) return { ok: false, error: 'not_signed_in' };
  const { data, error } = await supabase.rpc('claim_user_goal_pool', {
    p_actor_id: currentUser.id,
    p_period: period,
    p_period_key: _PERIOD_KEY_FN[period](),
    p_stars_to_credit: reward.stars || 0,
    p_coins_to_credit: reward.coins || 0,
  });
  if (error) {
    console.warn('[goals] claim rpc', period, error.message);
    return { ok: false, error: error.message || 'network_error' };
  }
  return {
    ok: !!data?.ok,
    alreadyClaimed: !!data?.already_claimed,
    error: data?.ok ? undefined : data?.error,
    stars: data?.stars,
    coins: data?.coins,
    coinBalance: data?.coin_balance,
    starBalance: data?.star_balance,
    completed: data?.completed,
    required: data?.required,
  };
}

// Human-readable mapping for the server error codes returned by
// claim_user_goal_pool. Anything unrecognized falls through to a
// generic "try again" — better to be vague than to render a code
// like 'goals_threshold_not_met' to an end user.
function _friendlyGoalClaimError(code) {
  switch (code) {
    case 'no_progress':
      return "We couldn't find your progress for this period yet. Refresh and try again.";
    case 'goals_threshold_not_met':
      return "Server doesn't see enough goals completed yet. Refresh and try again.";
    case 'required_goal_incomplete':
      return 'You still have a required goal to finish before claiming.';
    case 'missing_actor':
    case 'not_signed_in':
      return 'You need to be signed in to claim. Try signing in again.';
    default:
      return "We couldn't credit your reward right now. Please try again.";
  }
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
      if (!pool || pool.claimed || pool._claiming) return;

      // Disable the button + show "Claiming…" while the RPC is in
      // flight. Without this, an unresolved RPC can leave the user
      // tapping the button repeatedly (each tap pre-fix flipped
      // pool.claimed=true → re-rendered → second tap saw `claimed`
      // and bailed silently, looking exactly like "nothing happens").
      pool._claiming = true;
      const originalLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Claiming…';

      const stars = pool.reward?.stars || 0;
      const coins = pool.reward?.coins || 0;

      let result;
      try {
        result = await _fireClaimGoalPoolRpc(
          POOL_PERIOD_BY_KEY[poolKey] || 'daily',
          pool.reward || {}
        );
      } catch (err) {
        result = { ok: false, error: err?.message || 'network_error' };
      }

      if (!result?.ok) {
        // Roll back the disabled/loading state so the user can retry
        // and so they can SEE the error message we're about to toast.
        pool._claiming = false;
        btn.disabled = false;
        btn.textContent = originalLabel;
        toast(_friendlyGoalClaimError(result?.error), 'error');
        return;
      }

      // Server confirmed — only NOW flip the claim flag, persist,
      // animate the rewards, and refresh the topbar balance pill so
      // the user can see their stars + coins jump immediately.
      pool.claimed = true;
      pool._claiming = false;
      if (stars > 0) _flyRewardToBalance(btn, stars, 'star');
      if (coins > 0) setTimeout(() => _flyRewardToBalance(btn, coins, 'coin'), 180);
      _saveDailyQuestsToStorage();
      // loadWalletState pulls coin_balance / star_balance fresh from
      // the wallets row and re-renders the topbar pill. Without this
      // the user has to wait for the Realtime UPDATE event on
      // wallets, which can lag on flakier networks and made the
      // "I claimed but my balance didn't change" complaint feel
      // identical to the no-credit bug we're fixing here.
      try { await loadWalletState(); } catch (_) { /* non-fatal */ }
      renderDailyQuests();
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
// _resetDailyQuestsDemo() removed May 2026 — it only wiped
// localStorage, not the real Supabase state. The demo reset button
// it powered (#questsResetDemo) was also removed from the markup.
// To reset progress in production for legitimate debug, run the
// matching DELETE / RPC against user_goal_progress + user_goal_claims
// directly via Supabase SQL.


// Boot — load any persisted state then paint the streak badge.
_loadDailyQuestsFromStorage();
renderDailyQuests();

document.getElementById('btnDailyQuests')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleDailyQuestsPanel();
});
// Demo reset button removed May 2026 — it only wiped localStorage,
// not Supabase, so users saw progress "reset" then immediately
// resurrect on the next panel open from the real server state.
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
// (Mention dropdown state vars moved to js/messages.js in Stage 9B Codex
// review pass — the mention helpers themselves moved as part of 9B but
// their backing state was missed by the codemod's EXTRACT_STATE list,
// causing ReferenceErrors at runtime when the dropdown tried to read
// _mentionDropdown / _mentionResults / etc.)

// Document-level event delegation — works for dynamically created comment textareas
document.addEventListener('input', (e) => {
  const ta = e.target;
  if (!ta || ta.tagName !== 'TEXTAREA') return;
  if (!ta.classList.contains('comment-input')) return;
  maybeShowMentionDropdown(ta);
});

// Delegate to messages.js — all of _mentionTextarea / _mentionResults /
// _mentionDropdown / _mentionIdx live in that module after the Stage 9B
// state move. Referencing them from app.js threw ReferenceError on every
// keystroke (Stage 9 re-verification finding 1).
document.addEventListener('keydown', (e) => {
  handleMentionKeydown(e);
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

// (Dead const `secretLockIsUnlocked` removed in Stage 9 Codex review —
// was a pre-9B bridge wrapper, no remaining callers.)

// Wire visibility changes once at module load — covers tab switch,
// minimize, lock screen on macOS, etc.
document.addEventListener('visibilitychange', () => SECRET_LOCK.onVisibilityChange());

// Bubble hover/click → show menu (works on mobile via tap)
document.addEventListener('click', (e) => {
  // Click on a DM image OR a gallery cell → open lightbox, don't open
  // hover menu. Both selectors carry data-img-url, so the same handler
  // covers single-image bubbles and multi-image grids.
  const dmImgTarget = e.target.closest('.dm-bubble-image, .dm-bubble-gallery-cell');
  if (dmImgTarget) {
    e.stopPropagation();
    const url = dmImgTarget.dataset.imgUrl;
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
    // Thread the chapter through openBookDetail(opts) so the deep-link
    // auto-opens the right chapter after the chapters list lands
    // (Stage 8B Codex P1 — previously set _pendingChapterFromUrl, which
    // nothing read).
    setSidebarActive('btnBook');
    openBookDetail(chapterMatch[1], { chapter: chapterMatch[2] });
    return;
  }
  if (bookMatch) {
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

document.getElementById('dmReplyCancel')?.addEventListener('click', () => {
  dmState.replyingTo = null;
  hideReplyPreview();
});


document.getElementById('dmThreadMenu')?.addEventListener('click', (e) => {
  e.stopPropagation();
  openConvActionsMenu();
});

// ── New conversation modal (1:1 OR group) ────────────────────────────────
document.getElementById('dmNewBtn')?.addEventListener('click', () => openNewConvModal());

// "+ Secret" header button — exposed if the page has a #dmNewSecretBtn
// element. The empty-Secret-tab CTA also reaches this via the wired
// button in renderConvEmptyStateHtml.
document.getElementById('dmNewSecretBtn')?.addEventListener('click', () => openSecretChatPicker());

const _origSearchHandler = (e) => {
  // Replace the simple-filter behavior with debounced server search if length > 1
  const q = e.target.value.trim();
  clearTimeout(getDmSearchTimer());
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
  setDmSearchTimer(setTimeout(async () => {
    const { data: hits } = await supabase
      .from('messages')
      .select('id, conversation_id, sender_id, body, created_at')
      .ilike('body', `%${q}%`)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(40);
    if (!hits?.length) return;
    renderGlobalSearchResults(hits, q);
  }, 280));
};
const dmSearchInput = document.getElementById('dmSearchInput');
if (dmSearchInput) {
  // Clear any prior listener by cloning & re-attaching is messier — just override behavior
  dmSearchInput.removeEventListener?.('input', dmSearchInput._dmHandler);
  dmSearchInput._dmHandler = _origSearchHandler;
  dmSearchInput.addEventListener('input', _origSearchHandler);
}

// ════════════════════════════════════════════════════════════════════════════
// DMs Phase 4 — image attachments (2.5 MB), GIF picker, emoji picker
// ════════════════════════════════════════════════════════════════════════════

// DM_MAX_IMAGE_BYTES stays here — only app.js's file-picker handler reads
// it directly (passed as 2nd arg to compressImageToJpeg). The picker is
// part of the DM wiring block still pending migration to wireMessagesPage().
const DM_MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;   // 2.5 MB

// (DM_BUCKET, DM_GIPHY_KEY, DM_EMOJI_GROUPS moved to js/messages.js in
// the Stage 9B Codex review pass — they're consumed by sendDmAttachment /
// openDmGifPicker / loadGifResults / openScopedEmojiPicker which all live
// in messages.js now. Leaving them as top-level app.js consts caused
// ReferenceErrors as soon as the emoji button or attach-send fired.)

document.getElementById('dmAttachBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (getDmAttachMenuEl()) { closeDmAttachMenu(); return; }
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
  setDmAttachMenuEl(menu);

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
      if (!getDmAttachMenuEl()?.contains(ev.target)) {
        closeDmAttachMenu();
        document.removeEventListener('click', onDoc);
      }
    };
    document.addEventListener('click', onDoc);
  }, 0);
});

// ── File picker → preview (with size check + JPEG compression for big photos) ──
document.getElementById('dmFileInput')?.addEventListener('change', async (e) => {
  const picked = Array.from(e.target.files || []);
  e.target.value = ''; // allow re-selecting same file later
  if (!picked.length) return;

  // Cap at 10 total — combine with anything already staged. If the user
  // exceeds the cap we keep the first N and toast the rest.
  const existing = getDmPendingAttachment()?.kind === 'upload' ? getDmPendingAttachment().files : [];
  const remainingSlots = Math.max(0, 10 - existing.length);
  if (remainingSlots === 0) {
    toast('Limit reached — up to 10 photos per message.', 'warning');
    return;
  }
  const incoming = picked.slice(0, remainingSlots);
  if (picked.length > remainingSlots) {
    toast(`Only added the first ${remainingSlots} (10-photo limit per message).`, 'warning');
  }

  // Process each file: size check → compress if needed → bail if still over.
  // Failures are reported per-file so the user knows which one didn't make it
  // and the rest still go through.
  const processed = [];
  for (const file of incoming) {
    if (file.size > DM_MAX_IMAGE_BYTES * 4) {
      toast(`${file.name}: too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 2.5 MB.`, 'error');
      continue;
    }
    let finalFile = file;
    if (file.size > DM_MAX_IMAGE_BYTES && file.type !== 'image/gif') {
      try {
        finalFile = await compressImageToJpeg(file, DM_MAX_IMAGE_BYTES);
      } catch (err) {
        console.warn('[dm] compress failed, sending original', err);
      }
    }
    if (finalFile.size > DM_MAX_IMAGE_BYTES) {
      toast(`${file.name}: still ${(finalFile.size / 1024 / 1024).toFixed(1)} MB after compress.`, 'error');
      continue;
    }
    processed.push(finalFile);
  }
  if (!processed.length) return;

  // Build data URLs for ALL processed files in parallel for the preview strip.
  const dataUrls = await Promise.all(processed.map(fileToDataUrl));

  // Merge with anything already staged so the user can pick in batches.
  const allFiles = [...existing, ...processed];
  const allDataUrls = getDmPendingAttachment()?.kind === 'upload'
    ? [...getDmPendingAttachment().dataUrls, ...dataUrls]
    : dataUrls;

  setDmPendingAttachment({ kind: 'upload', files: allFiles, dataUrls: allDataUrls });
  showDmAttachPreview(allDataUrls, allFiles);
  updateSendButton();
});

document.getElementById('dmAttachCancel')?.addEventListener('click', hideDmAttachPreview);

// Intercept the send button: if an attachment is pending, send it via the
// attachment path; otherwise fall through to the normal text send.
document.getElementById('dmSendBtn')?.addEventListener('click', (e) => {
  if (getDmPendingAttachment()) {
    e.stopImmediatePropagation();
    sendDmAttachment();
  }
}, true);

// Also intercept Enter key in textarea when an attachment is staged
document.getElementById('dmInput')?.addEventListener('keydown', (e) => {
  if (getDmPendingAttachment() && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    sendDmAttachment();
  }
}, true);

// (DM_EMOJI_GROUPS moved to js/messages.js in Stage 9B Codex review pass —
// openScopedEmojiPicker is the only consumer and it lives in messages.js.)

// Delegated handler for the full-page composer's emoji button. The dock's
// per-mini-chat triggers wire their OWN delegated handler in messages-dock.js
// (Commit 2) so this one doesn't have to know about future selectors.
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('#dmEmojiBtn');
  if (!trigger) return;
  e.preventDefault();
  e.stopPropagation();
  openScopedEmojiPicker({
    trigger,
    input: document.getElementById('dmInput'),
    onInsert: insertEmojiIntoComposer,  // full-page-specific insert
  });
});
