// ════════════════════════════════════════════════════════════════════════
// Selebox floating Messages dock — shared data helpers + scoped state for
// the Facebook-style chat dock (launcher pill + inbox panel + mini chats).
//
// Commit 1 (this file): API surface + data helpers only. No UI yet.
// Commit 2: launcher / inbox / mini-chat rendering will be appended to
// this same file so Stage 9 extraction (#215) can fold everything into
// js/messages.js in one pass later.
//
// Design rules (keep coexisting with the full Messages page intact):
//   * NEVER touch the existing #dmInput / #dmMessages / #dmThreadActive
//     / #dmEmojiBtn DOM. The full page renders into those.
//   * Floating UI uses scoped class + data-conv-id selectors, never
//     document-wide IDs. Multiple mini chats can render at once.
//   * Data helpers below are pure Supabase wrappers — both the existing
//     app.js code AND the dock UI (Commit 2) can call them. Existing
//     sendDmMessage / loadConversations / etc. in app.js stay unchanged
//     so we don't break the live full page.
// ════════════════════════════════════════════════════════════════════════

import { supabase, toast, escHTML, initials, timeAgo } from './supabase.js';

// ─── Config-injection dependency surface ─────────────────────────────────
let _cfg = {
  // Identity
  getCurrentUser:        () => null,
  getCurrentProfile:     () => null,    // for launcher avatar

  // Shared emoji picker. Each mini-chat composer passes its own input
  // element so the picker inserts at the right cursor. Provided by
  // app.js (kept there until Stage 9 extraction so the existing
  // #dmEmojiBtn flow keeps using the same code path).
  openScopedEmojiPicker: (_opts) => {},

  // Cross-module helpers used by Commit 2 UI.
  openProfile:           (_userId) => {},
  showMessages:          (_targetUserId) => {},   // hand-off to full page
  closeAllModals:        () => {},

  // Image upload — shared with the full-page composer + post composer.
  // Receives a File, returns the uploaded URL (or throws).
  uploadImage:           async (_file) => null,
};

// ─── DOM refs (lazy — resolved on first mount, cleared on teardown) ──────
let _root = null;            // #dmFloatingRoot
let _miniContainerEl = null; // horizontal row of expanded chats (left side)
let _rightColEl = null;      // vertical stack: inbox + avatars + launcher (right edge)
let _avatarContainerEl = null; // vertical column of avatar bubbles (above launcher)
let _launcherEl = null;      // the always-visible bottom-right pill
let _inboxEl = null;         // the slide-up inbox panel

// Inbox-level realtime channel for unread badge updates (separate from
// per-mini subscriptions). Subscribed once when dock mounts, removed on
// teardown.
let _inboxChannel = null;

// Cached conversation list — reloaded on mount + on any realtime ping.
// Keyed by id for fast lookup when rendering inbox / handling clicks.
let _convCache = [];

export function initMessagesDock(config) {
  if (config) _cfg = { ..._cfg, ...config };
  if (!_cfg.getCurrentUser()?.id) {
    // Not signed in yet — the sign-in flow will call initMessagesDock
    // again, OR teardownMessagesDock first. Either way nothing to mount.
    return;
  }
  _mountDock();
}

// ─── Dock state — kept entirely separate from app.js dmState ─────────────
// dmState.activeConvId belongs to the FULL Messages page. The floating
// dock has its own per-conv records (Map keyed by convId) so opening a
// mini chat doesn't fight the full page over which conversation is active.
//
// Facebook-style cap (2026-05-16): 2 expanded chats + 3 avatar bubbles
// = 5 visible. Opening a 6th demotes oldest expanded → avatar, and if
// that pushes avatars over 3 the oldest avatar drops entirely (still
// reachable via the inbox conversation list).
export const DM_FLOAT_MAX_THREADS = 2;       // expanded chat windows
export const DM_FLOAT_MAX_AVATARS = 3;       // collapsed-to-bubble overflow
export const DM_FLOAT_MAX_VISIBLE = DM_FLOAT_MAX_THREADS + DM_FLOAT_MAX_AVATARS;

export const dmDockState = {
  inboxOpen: false,
  // convId → {
  //   conv,                // conversation row
  //   messages,            // local message array (separate from dmState.messages)
  //   displayState,        // 'expanded' (full chat) | 'avatar' (collapsed bubble)
  //   sendInFlight,        // single-flight guard per mini chat
  //   subscription,        // teardown handle from subscribeToConversation
  //   focusedAt,           // ms timestamp for displace ordering
  // }
  openThreads: new Map(),
  // Ordered list of convIds, most-recently-focused last. Drives both
  // the displace-oldest rule AND the inbox sort fallback.
  focusOrder: [],
};

// ════════════════════════════════════════════════════════════════════════
// Shared data helpers
//
// All Supabase access for the dock funnels through these. Each one is a
// thin wrapper — no DOM access, no rendering, returns plain data or a
// teardown handle. Safe to call from app.js's existing full-page flow
// during Stage 9 extraction.
// ════════════════════════════════════════════════════════════════════════

// Load every conversation the current user can see. Mirrors app.js's
// loadConversations query (Stage 9 extraction will collapse the two
// into a single call site). Returns an array of conversation rows
// already hydrated with the "other user" profile for 1:1 chats.
export async function loadConversationList() {
  const user = _cfg.getCurrentUser();
  if (!user?.id) return [];

  // Two-source union: (1) explicit participants + (2) 1:1 user_a/user_b.
  // Some Secret 1:1's only insert into `conversations`, not
  // conversation_participants — mirroring app.js fix at ~line 15598.
  const [partsRes, oneOnOneRes] = await Promise.all([
    supabase.from('conversation_participants').select('conversation_id').eq('user_id', user.id),
    supabase.from('conversations').select('id').eq('is_group', false).or(`user_a.eq.${user.id},user_b.eq.${user.id}`),
  ]);
  if (partsRes.error) {
    console.warn('[dock] participants fetch failed:', partsRes.error.message);
    return [];
  }
  const idSet = new Set();
  for (const p of (partsRes.data || [])) if (p.conversation_id) idSet.add(p.conversation_id);
  for (const c of (oneOnOneRes.data || [])) if (c.id) idSet.add(c.id);
  if (idSet.size === 0) return [];

  const { data: convs, error } = await supabase
    .from('conversations')
    .select('id, user_a, user_b, is_group, is_secret, name, avatar_url, created_by, last_message_at, last_message_preview, last_message_sender, created_at, archived_by_a, archived_by_b, muted_until_a, muted_until_b')
    .in('id', [...idSet])
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) {
    console.warn('[dock] conversations fetch failed:', error.message);
    return [];
  }

  // Hydrate "other user" profile for 1:1's so the dock list can render
  // avatar + display name without an extra round-trip per row.
  const otherIds = new Set();
  for (const c of (convs || [])) {
    if (c.is_group) continue;
    const other = c.user_a === user.id ? c.user_b : c.user_a;
    if (other) otherIds.add(other);
  }
  let profilesById = {};
  if (otherIds.size > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, is_banned, role')
      .in('id', [...otherIds]);
    for (const p of (profiles || [])) profilesById[p.id] = p;
  }

  return (convs || []).map((c) => {
    const otherId = !c.is_group && (c.user_a === user.id ? c.user_b : c.user_a);
    return {
      ...c,
      _otherUser:  otherId ? profilesById[otherId] || null : null,
      _archived:   user.id === c.user_a ? !!c.archived_by_a : !!c.archived_by_b,
      _mutedUntil: user.id === c.user_a ? c.muted_until_a   : c.muted_until_b,
    };
  });
}

// Fetch a single conversation by id with the same "other user" hydration
// as loadConversationList. Used when the dock receives a notification or
// deep-link for a conversation it hasn't loaded yet.
export async function fetchConversationById(convId) {
  const user = _cfg.getCurrentUser();
  if (!user?.id || !convId) return null;
  const { data: c, error } = await supabase
    .from('conversations')
    .select('id, user_a, user_b, is_group, is_secret, name, avatar_url, created_by, last_message_at, last_message_preview, last_message_sender, created_at, archived_by_a, archived_by_b, muted_until_a, muted_until_b')
    .eq('id', convId)
    .single();
  if (error || !c) return null;
  let other = null;
  if (!c.is_group) {
    const otherId = c.user_a === user.id ? c.user_b : c.user_a;
    if (otherId) {
      const { data: p } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, is_banned, role')
        .eq('id', otherId)
        .single();
      other = p || null;
    }
  }
  return {
    ...c,
    _otherUser:  other,
    _archived:   user.id === c.user_a ? !!c.archived_by_a : !!c.archived_by_b,
    _mutedUntil: user.id === c.user_a ? c.muted_until_a   : c.muted_until_b,
  };
}

// Load the latest N messages for a conversation. Returns chronological
// order (oldest first → newest last) so callers can append directly to a
// scrolling pane. Normalises image_urls so the legacy single image_url
// column promotes to an array (mirrors app.js loadMessages at ~line 16124).
export async function loadMessagesForConversation(convId, { limit = 50 } = {}) {
  if (!convId) return [];
  const { data: msgs, error } = await supabase
    .from('messages')
    .select('id, conversation_id, sender_id, body, created_at, read_at, edited_at, deleted_at, reply_to_id, image_url, image_urls, image_kind')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[dock] messages fetch failed:', error.message);
    return [];
  }
  return (msgs || []).slice().reverse().map((m) => {
    if (Array.isArray(m.image_urls) && m.image_urls.length > 0) return m;
    if (m.image_url) return { ...m, image_urls: [m.image_url] };
    return { ...m, image_urls: [] };
  });
}

// Send a message to a conversation. Returns the inserted row on success,
// throws an Error on failure (with .code if the server returned one).
//
// Caller-supplied client_nonce lets the realtime channel handler dedupe
// the INSERT echo against an optimistic placeholder — see task #212.
// Falls back to a generated nonce so callers can omit it.
export async function sendMessageToConversation(convId, payload = {}) {
  const user = _cfg.getCurrentUser();
  if (!user?.id) throw new Error('Sign in to send messages');
  if (!convId) throw new Error('Missing conversation');
  const body       = (payload.body || '').trim();
  const replyToId  = payload.replyToId || null;
  const imageUrl   = payload.imageUrl || null;
  const imageUrls  = Array.isArray(payload.imageUrls) ? payload.imageUrls : null;
  const imageKind  = payload.imageKind || null;
  const nonce      = payload.clientNonce || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  if (!body && !imageUrl && !(imageUrls && imageUrls.length)) {
    throw new Error('Empty message');
  }

  // We intentionally do NOT store client_nonce on the row — the messages
  // table doesn't have that column yet (task #212 will add it). For now
  // dedup happens client-side via sender_id + body + created_at window.
  const insertRow = {
    conversation_id: convId,
    sender_id:       user.id,
    body,
    reply_to_id:     replyToId,
  };
  if (imageUrl)            insertRow.image_url  = imageUrl;
  if (imageUrls)           insertRow.image_urls = imageUrls;
  if (imageKind)           insertRow.image_kind = imageKind;

  const { data, error } = await supabase
    .from('messages')
    .insert(insertRow)
    .select()
    .single();
  if (error) {
    const e = new Error(error.message || 'Failed to send message');
    e.code = error.code;
    throw e;
  }
  // Surface the nonce on the returned row so callers can reconcile.
  return { ...data, _clientNonce: nonce };
}

// Mark a conversation as read. Best-effort — failures are logged but
// don't throw, so a read-receipt blip doesn't break a UI action.
export async function markConversationRead(convId) {
  const user = _cfg.getCurrentUser();
  if (!user?.id || !convId) return;
  try {
    // Mirror the existing pattern in app.js: zero unread + stamp read_at
    // on the participant row. Server-side trigger updates the
    // conversations.last_read_* timestamps that drive unread counts.
    await supabase.rpc('mark_conversation_read', { p_conversation_id: convId });
  } catch (err) {
    console.warn('[dock] mark read failed:', err?.message);
  }
}

// Subscribe to realtime INSERT/UPDATE/DELETE on a conversation's messages.
// Returns an opaque handle — pass it back to teardownConversationSubscription
// to remove the channel. Multiple mini-chats can each have their own
// subscription; this helper doesn't dedupe across the app (Stage 9
// extraction will introduce a per-conv channel registry).
export function subscribeToConversation(convId, { onInsert, onUpdate, onDelete } = {}) {
  if (!convId) return null;
  const channel = supabase
    .channel(`dock-conv-${convId}-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` }, (payload) => {
      try { onInsert?.(payload.new); } catch (e) { console.warn('[dock] onInsert handler threw:', e?.message); }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` }, (payload) => {
      try { onUpdate?.(payload.new, payload.old); } catch (e) { console.warn('[dock] onUpdate handler threw:', e?.message); }
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` }, (payload) => {
      try { onDelete?.(payload.old); } catch (e) { console.warn('[dock] onDelete handler threw:', e?.message); }
    })
    .subscribe();
  return { channel, convId };
}

export function teardownConversationSubscription(handle) {
  if (!handle?.channel) return;
  try { supabase.removeChannel(handle.channel); } catch {}
}

// ════════════════════════════════════════════════════════════════════════
// Public dock API
// ════════════════════════════════════════════════════════════════════════

export function openMessagesDock() {
  if (!_launcherEl) _mountDock();
  dmDockState.inboxOpen = true;
  // Facebook behavior: opening the inbox demotes any expanded chats
  // to avatar bubbles so the inbox panel has room without overlapping
  // the chat windows. User can re-promote by clicking the avatar or
  // by picking a conversation from the inbox.
  let demoted = false;
  for (const [, t] of dmDockState.openThreads) {
    if (t.displayState === 'expanded') { t.displayState = 'avatar'; demoted = true; }
  }
  if (demoted) {
    // Trim overflow (auto-demote may push avatars over cap if user had
    // 2 expanded + 3 avatars = 5; new state would be 5 avatars).
    _displaceIfOverCap(null);
    _renderAllChats();
  }
  _syncLauncherCompact();
  _renderInbox();
}

export function closeMessagesDock() {
  dmDockState.inboxOpen = false;
  if (_inboxEl) _inboxEl.remove();
  _inboxEl = null;
  // Re-expand the launcher back to its full pill state IF nothing
  // else is floating (no open chats). Helper picks the right state.
  _syncLauncherCompact();
}

// Open a specific conversation as an expanded mini chat. Used by profile
// "Message" buttons, notification taps, the inbox list, and avatar-bubble
// clicks. Handles the 2-expanded / 3-avatar visible cap:
//   * Already open as expanded → bump focus, scroll input into view.
//   * Already open as avatar → promote to expanded (which displaces the
//     oldest expanded into the avatar column).
//   * Not open + room available → load + render as expanded.
//   * Not open + at cap → displace oldest expanded to avatar; if that
//     pushes the avatar column over the cap, drop the oldest avatar
//     entirely (teardown subscription + remove from state). The conv is
//     still reachable from the inbox list.
export async function openMessagesDockToConv(convId) {
  if (!convId) return;
  if (!_launcherEl) _mountDock();

  // Already open in some form — promote to expanded and bump focus.
  if (dmDockState.openThreads.has(convId)) {
    const t = dmDockState.openThreads.get(convId);
    const wasAvatar = t.displayState === 'avatar';
    t.displayState = 'expanded';
    _bumpFocus(convId);
    if (wasAvatar) _displaceIfOverCap(convId);   // make room
    _renderAllChats();                            // repaint every slot
    setTimeout(() => {
      _scrollMiniToBottom(convId);
      _focusMiniInput(convId);
    }, 30);
    return;
  }

  // Load conv + initial messages in parallel before we render.
  const [conv, messages] = await Promise.all([
    fetchConversationById(convId),
    loadMessagesForConversation(convId, { limit: 30 }),
  ]);
  if (!conv) {
    toast('Could not load conversation', 'error');
    return;
  }

  const thread = {
    conv,
    messages,
    displayState: 'expanded',
    sendInFlight: false,
    subscription: null,
    focusedAt: Date.now(),
  };
  // Subscribe BEFORE rendering so an incoming message during the initial
  // render still hits the handler.
  thread.subscription = subscribeToConversation(convId, {
    onInsert: (msg) => _handleIncomingMessage(convId, msg),
    onUpdate: (msg) => _handleMessageUpdate(convId, msg),
    onDelete: (msg) => _handleMessageDelete(convId, msg),
  });
  dmDockState.openThreads.set(convId, thread);
  _bumpFocus(convId);
  _displaceIfOverCap(convId);   // demote / drop neighbors as needed
  _renderAllChats();
  _syncLauncherCompact();       // first chat → compact pill

  markConversationRead(convId).then(() => _refreshUnreadBadge());
  setTimeout(() => {
    _scrollMiniToBottom(convId);
    _focusMiniInput(convId);
  }, 30);
}

// Enforce the visible cap: at most DM_FLOAT_MAX_THREADS expanded +
// DM_FLOAT_MAX_AVATARS avatars. Called whenever a thread changes its
// displayState OR a new thread is added. The conv that just changed
// (passed in as `protectedId`) is never displaced — it always keeps the
// state the caller just set.
function _displaceIfOverCap(protectedId) {
  // 1) Too many expanded → demote oldest expanded (other than protected)
  //    to 'avatar'. Repeat until within cap.
  while (_countByState('expanded') > DM_FLOAT_MAX_THREADS) {
    const oldest = _findOldest('expanded', protectedId);
    if (!oldest) break;  // nothing to demote — shouldn't happen
    const t = dmDockState.openThreads.get(oldest);
    if (t) t.displayState = 'avatar';
  }
  // 2) Too many avatars → drop oldest avatar entirely.
  while (_countByState('avatar') > DM_FLOAT_MAX_AVATARS) {
    const oldest = _findOldest('avatar', protectedId);
    if (!oldest) break;
    _closeMini(oldest);
  }
}

function _countByState(state) {
  let n = 0;
  for (const [, t] of dmDockState.openThreads) if (t.displayState === state) n++;
  return n;
}

// Oldest thread in the given state, by focusOrder ascending. Skips the
// protected id so the conv the user JUST acted on never gets bumped.
function _findOldest(state, protectedId) {
  for (const id of dmDockState.focusOrder) {
    if (id === protectedId) continue;
    const t = dmDockState.openThreads.get(id);
    if (t && t.displayState === state) return id;
  }
  return null;
}

export function teardownMessagesDock() {
  // Teardown every per-mini subscription before nuking state, otherwise
  // orphan channels keep pumping events into a Map that no longer has
  // their thread.
  for (const [, thread] of dmDockState.openThreads) {
    teardownConversationSubscription(thread.subscription);
  }
  dmDockState.openThreads.clear();
  dmDockState.focusOrder.length = 0;
  dmDockState.inboxOpen = false;
  if (_inboxChannel) { try { supabase.removeChannel(_inboxChannel); } catch {} _inboxChannel = null; }
  if (_root) _root.innerHTML = '';
  _launcherEl = _inboxEl = _miniContainerEl = null;
  _convCache = [];
}

// ════════════════════════════════════════════════════════════════════════
// Mount + render — premium feel, brand purple accent
// ════════════════════════════════════════════════════════════════════════

function _mountDock() {
  _root = document.getElementById('dmFloatingRoot');
  if (!_root) {
    // Defensive — if index.html hasn't been updated, create the mount
    // on the fly so the dock still works (just appended to body).
    _root = document.createElement('div');
    _root.id = 'dmFloatingRoot';
    document.body.appendChild(_root);
  }
  _root.innerHTML = ''; // wipe any prior content

  // Layout: [expanded mini chats]    [right column: inbox / avatars / launcher]
  // Avatars stack vertically above the launcher; inbox panel slots above
  // the avatars when open. All three live in the same flex column so the
  // launcher stays anchored to the bottom even as siblings appear/disappear.
  _miniContainerEl = document.createElement('div');
  _miniContainerEl.className = 'dm-dock-mini-stack';
  _root.appendChild(_miniContainerEl);

  _rightColEl = document.createElement('div');
  _rightColEl.className = 'dm-dock-rightcol';
  _root.appendChild(_rightColEl);

  _avatarContainerEl = document.createElement('div');
  _avatarContainerEl.className = 'dm-dock-avatar-stack';
  _rightColEl.appendChild(_avatarContainerEl);

  _renderLauncher();   // appends to _rightColEl after the avatar stack
  _loadAndRefreshUnread();
  _subscribeInboxBadge();
}

function _renderLauncher() {
  if (_launcherEl) _launcherEl.remove();
  const profile = _cfg.getCurrentProfile() || {};
  const name = profile.display_name || profile.username || 'You';
  const avatarHTML = profile.avatar_url
    ? `<img src="${escHTML(profile.avatar_url)}" alt="${escHTML(name)}"/>`
    : `<span class="dm-dock-initials">${escHTML(initials(name))}</span>`;

  // Default: full pill [icon] Messages [avatar]. Collapses to an
  // avatar-only compact state when the inbox is open so the panel
  // has room and the launcher doesn't compete for attention. The
  // `.is-compact` class toggle in openMessagesDock/closeMessagesDock
  // drives a CSS transition (width + label fade) so the swap reads
  // as a smooth slide rather than a hard re-render.
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dm-dock-launcher';
  btn.setAttribute('aria-label', 'Messages');
  btn.setAttribute('title', 'Messages');
  // Badge is a direct child of the launcher (not nested under the icon)
  // so it stays visible after the icon collapses to max-width:0 in
  // compact mode. Positioned absolutely against the launcher root.
  btn.innerHTML = `
    <span class="dm-dock-launcher-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
      </svg>
    </span>
    <span class="dm-dock-launcher-label">Messages</span>
    <span class="dm-dock-launcher-avatar">${avatarHTML}</span>
    <span class="dm-dock-launcher-badge" data-empty="1"></span>
  `;
  btn.addEventListener('click', () => {
    if (dmDockState.inboxOpen) closeMessagesDock();
    else openMessagesDock();
  });
  _rightColEl.appendChild(btn);
  _launcherEl = btn;
  _syncLauncherCompact();   // pick up current state on (re-)mount
}

// Decide whether the launcher should be in its full pill state or
// collapsed to a compact avatar circle. The pill blocks viewport
// real-estate when ANY floating UI is present (the inbox panel OR a
// mini chat OR even an avatar bubble in the overflow column), so
// collapse whenever something is taking the right edge. Re-expand only
// when the dock is back to "just the launcher". Single source of truth
// — every state change calls this instead of toggling .is-compact
// inline.
function _syncLauncherCompact() {
  if (!_launcherEl) return;
  const anyChat = dmDockState.openThreads.size > 0;
  const shouldBeCompact = dmDockState.inboxOpen || anyChat;
  _launcherEl.classList.toggle('is-compact', shouldBeCompact);
}

function _renderInbox() {
  if (_inboxEl) _inboxEl.remove();
  const panel = document.createElement('section');
  panel.className = 'dm-dock-inbox';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Inbox');
  panel.innerHTML = `
    <header class="dm-dock-inbox-header">
      <h2>Messages <span class="dm-dock-inbox-badge" data-empty="1"></span></h2>
      <div class="dm-dock-inbox-actions">
        <button type="button" class="dm-dock-inbox-expand" title="Open full Messages" aria-label="Open full Messages">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        </button>
        <button type="button" class="dm-dock-inbox-close" title="Close" aria-label="Close inbox">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </header>
    <div class="dm-dock-inbox-list">${_renderConvListMarkup()}</div>
  `;
  panel.querySelector('.dm-dock-inbox-close').addEventListener('click', closeMessagesDock);
  panel.querySelector('.dm-dock-inbox-expand').addEventListener('click', () => {
    closeMessagesDock();
    _cfg.showMessages();
  });
  panel.querySelectorAll('.dm-dock-conv-item[data-conv-id]').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.convId;
      closeMessagesDock();
      openMessagesDockToConv(id);
    });
  });
  // Prepend so inbox sits at the TOP of the right column (avatars +
  // launcher below). Falls back to root if rightcol isn't mounted yet.
  (_rightColEl || _root).insertBefore(panel, (_rightColEl || _root).firstChild);
  _inboxEl = panel;
  _refreshUnreadBadge(); // updates the badge inside the inbox header too
}

function _renderConvListMarkup() {
  const user = _cfg.getCurrentUser();
  const list = _convCache.filter(c => !c._archived).slice(0, 30);
  if (!list.length) {
    return `<div class="dm-dock-empty">No conversations yet.<br/>Open someone's profile and tap Message to start.</div>`;
  }
  return list.map(c => {
    const isGroup = c.is_group;
    const otherName = isGroup ? (c.name || 'Group') : (c._otherUser?.display_name || c._otherUser?.username || 'Unknown');
    const avatar = isGroup ? (c.avatar_url || '') : (c._otherUser?.avatar_url || '');
    const avatarHTML = avatar
      ? `<img src="${escHTML(avatar)}" alt=""/>`
      : `<span class="dm-dock-initials">${escHTML(initials(otherName))}</span>`;
    const preview = c.last_message_preview ? escHTML(c.last_message_preview).slice(0, 60) : '<span class="dm-dock-conv-empty-preview">Say hi 👋</span>';
    const time = c.last_message_at ? timeAgo(c.last_message_at) : '';
    // Unread is computed from conversations.last_read_a/b vs last_message_at —
    // not always reliable from a single column. For v1 just show a dot if
    // the last message wasn't from me; a fuller unread state lands with
    // task #215 (Stage 9 extraction).
    const mineLast = c.last_message_sender === user?.id;
    const unreadDot = !mineLast && c.last_message_at ? '<span class="dm-dock-conv-unread-dot" aria-hidden="true"></span>' : '';
    return `
      <button type="button" class="dm-dock-conv-item" data-conv-id="${escHTML(c.id)}">
        <span class="dm-dock-conv-avatar">${avatarHTML}</span>
        <span class="dm-dock-conv-meta">
          <span class="dm-dock-conv-name">${escHTML(otherName)}</span>
          <span class="dm-dock-conv-preview">${preview}</span>
        </span>
        <span class="dm-dock-conv-aside">
          ${time ? `<span class="dm-dock-conv-time">${escHTML(time)}</span>` : ''}
          ${unreadDot}
        </span>
      </button>
    `;
  }).join('');
}

// Repaint every open thread into the right container. Cheap: clears
// both containers and re-renders. Called whenever the mix of expanded
// vs avatar threads changes (open / promote / demote / close).
function _renderAllChats() {
  if (!_miniContainerEl || !_avatarContainerEl) return;
  _miniContainerEl.innerHTML = '';
  _avatarContainerEl.innerHTML = '';
  if (dmDockState.openThreads.size === 0) return;

  // Iterate in focusOrder so the most-recently-focused appears closest
  // to the launcher (rightmost expanded chat, topmost avatar bubble).
  // We render avatars top-down with newest at the bottom (closest to
  // launcher) by reversing the focus order subset.
  const expandedIds = [];
  const avatarIds   = [];
  for (const id of dmDockState.focusOrder) {
    const t = dmDockState.openThreads.get(id);
    if (!t) continue;
    if (t.displayState === 'expanded') expandedIds.push(id);
    else if (t.displayState === 'avatar') avatarIds.push(id);
  }
  // Expanded chats: oldest on left, newest on right (closest to launcher).
  for (const id of expandedIds) _renderMini(dmDockState.openThreads.get(id));
  // Avatar bubbles: oldest on top, newest on bottom (closest to launcher).
  for (const id of avatarIds)   _renderAvatar(dmDockState.openThreads.get(id));
}

// Render the avatar-bubble overflow representation. Click → promote back
// to expanded. Hover shows a small "×" close button.
function _renderAvatar(thread) {
  if (!_avatarContainerEl) return;
  const convId = thread.conv.id;
  const other = thread.conv._otherUser || {};
  const name = thread.conv.is_group ? (thread.conv.name || 'Group') : (other.display_name || other.username || 'Unknown');
  const avatar = thread.conv.is_group ? thread.conv.avatar_url : other.avatar_url;
  const avatarHTML = avatar
    ? `<img src="${escHTML(avatar)}" alt="${escHTML(name)}"/>`
    : `<span class="dm-dock-initials">${escHTML(initials(name))}</span>`;

  const wrap = document.createElement('div');
  wrap.className = 'dm-mini-avatar-bubble';
  wrap.dataset.convId = convId;
  wrap.title = name;
  wrap.innerHTML = `
    <button type="button" class="dm-mini-avatar-bubble-btn" aria-label="Open chat with ${escHTML(name)}">
      ${avatarHTML}
    </button>
    <button type="button" class="dm-mini-avatar-bubble-close" aria-label="Close chat with ${escHTML(name)}" title="Close">×</button>
  `;
  wrap.querySelector('.dm-mini-avatar-bubble-btn').addEventListener('click', () => {
    openMessagesDockToConv(convId);
  });
  wrap.querySelector('.dm-mini-avatar-bubble-close').addEventListener('click', (e) => {
    e.stopPropagation();
    _closeMini(convId);
  });
  _avatarContainerEl.appendChild(wrap);
}

function _renderMini(thread) {
  if (!_miniContainerEl) return;
  const convId = thread.conv.id;
  // Remove any existing render for this convId before re-rendering.
  _miniContainerEl.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`)?.remove();

  const section = document.createElement('section');
  section.className = 'dm-mini-chat';
  section.dataset.convId = convId;
  const other = thread.conv._otherUser || {};
  const name = thread.conv.is_group ? (thread.conv.name || 'Group') : (other.display_name || other.username || 'Unknown');
  // @handle dropped from mini header for compactness (user feedback
  // 2026-05-16). Still shown on the full profile page.
  const avatar = thread.conv.is_group ? thread.conv.avatar_url : other.avatar_url;
  const avatarHTML = avatar
    ? `<img src="${escHTML(avatar)}" alt=""/>`
    : `<span class="dm-dock-initials">${escHTML(initials(name))}</span>`;
  section.innerHTML = `
    <header class="dm-mini-header">
      <button type="button" class="dm-mini-peek" data-action="open-profile" title="View profile">
        <span class="dm-mini-avatar">${avatarHTML}</span>
        <span class="dm-mini-name">${escHTML(name)}</span>
      </button>
      <span class="dm-mini-spacer"></span>
      <button type="button" class="dm-mini-expand" title="Open full chat" aria-label="Open full chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      </button>
      <button type="button" class="dm-mini-minimize" title="Minimize" aria-label="Minimize">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="18" x2="18" y2="18"/></svg>
      </button>
      <button type="button" class="dm-mini-close" title="Close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </header>
    <div class="dm-mini-messages" role="log" aria-live="polite" data-conv-msgs="${escHTML(convId)}">${_renderMessagesMarkup(thread)}</div>
    <div class="dm-mini-drop-hint" aria-hidden="true">
      <span>Drop image to send</span>
    </div>
    <form class="dm-mini-composer" autocomplete="off">
      <div class="dm-mini-attach-wrap">
        <button type="button" class="dm-mini-attach" title="Send photo or GIF" aria-label="Send photo or GIF" aria-haspopup="menu" aria-expanded="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <div class="dm-mini-attach-menu" role="menu" hidden>
          <button type="button" role="menuitem" class="dm-mini-attach-opt" data-kind="photo">
            <span class="dm-mini-attach-opt-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </span>
            Photo
          </button>
          <button type="button" role="menuitem" class="dm-mini-attach-opt" data-kind="gif">
            <span class="dm-mini-attach-opt-icon" aria-hidden="true">
              <span class="dm-mini-attach-opt-gif">GIF</span>
            </span>
            GIF
          </button>
        </div>
      </div>
      <input type="file" class="dm-mini-file-input" accept="image/*" hidden/>
      <button type="button" class="dm-mini-emoji" title="Emoji" aria-label="Emoji">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
      </button>
      <textarea class="dm-mini-input" placeholder="Message..." rows="1" maxlength="2000"></textarea>
      <button type="submit" class="dm-mini-send" title="Send" aria-label="Send">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </form>
  `;

  // Header buttons (back arrow dropped — close serves the same nav role,
  // user feedback 2026-05-16: reduce header clutter)
  section.querySelector('.dm-mini-close').addEventListener('click', () => _closeMini(convId));
  section.querySelector('.dm-mini-minimize').addEventListener('click', () => {
    // Demote this chat to an avatar bubble (Facebook-style). Repaint so
    // the row of expanded chats reshuffles + the avatar column updates.
    thread.displayState = 'avatar';
    _renderAllChats();
  });
  section.querySelector('.dm-mini-expand').addEventListener('click', () => {
    _closeMini(convId);
    _cfg.showMessages(other.id);
  });
  section.querySelector('[data-action="open-profile"]').addEventListener('click', () => {
    if (other.id) _cfg.openProfile(other.id);
  });

  // Composer
  const input = section.querySelector('.dm-mini-input');
  const sendBtn = section.querySelector('.dm-mini-send');
  const form = section.querySelector('.dm-mini-composer');
  const emojiBtn = section.querySelector('.dm-mini-emoji');

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  };
  input.addEventListener('input', autosize);
  input.addEventListener('focus', () => _bumpFocus(convId));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      _handleSend(convId);
    }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); _handleSend(convId); });
  emojiBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    _cfg.openScopedEmojiPicker({ trigger: emojiBtn, input });
  });

  // Click any image in the message list to open it in the full-page
  // lightbox. window.openLightbox is the same handler used by post
  // images (set up in app.js around line 325). Delegate on the
  // messages container so freshly-arrived realtime images also work
  // without re-binding per render.
  const messagesEl = section.querySelector('.dm-mini-messages');
  messagesEl.addEventListener('click', (e) => {
    const img = e.target.closest('.dm-mini-image img, .dm-mini-image-cell img');
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    const url = img.getAttribute('src');
    if (url && typeof window.openLightbox === 'function') {
      window.openLightbox(url);
    }
  });

  // ── Attach (+ button) → Photo / GIF menu + drag-drop image ─────────
  const attachBtn  = section.querySelector('.dm-mini-attach');
  const attachMenu = section.querySelector('.dm-mini-attach-menu');
  const fileInput  = section.querySelector('.dm-mini-file-input');
  const closeAttachMenu = () => {
    attachMenu.hidden = true;
    attachBtn.setAttribute('aria-expanded', 'false');
  };
  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !attachMenu.hidden;
    if (open) { closeAttachMenu(); return; }
    attachMenu.hidden = false;
    attachBtn.setAttribute('aria-expanded', 'true');
    // Close on first outside click.
    setTimeout(() => {
      const onDoc = (ev) => {
        if (!attachMenu.contains(ev.target) && !attachBtn.contains(ev.target)) {
          closeAttachMenu();
          document.removeEventListener('click', onDoc);
        }
      };
      document.addEventListener('click', onDoc);
    }, 0);
  });
  attachMenu.querySelectorAll('.dm-mini-attach-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      const kind = opt.dataset.kind;
      // Switch the file input's accept so the OS picker filters
      // appropriately. Photo excludes gifs; GIF only accepts gifs.
      fileInput.accept = kind === 'gif' ? 'image/gif' : 'image/png,image/jpeg,image/webp,image/heic,image/heif';
      closeAttachMenu();
      fileInput.click();
    });
  });
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) _handleAttachImage(convId, file);
    e.target.value = ''; // reset so the same filename can be picked again
  });
  // Drag-and-drop: dim the chat + show the "Drop image" hint while a
  // file is hovering. Drop fires the same upload path as the + button.
  let dragDepth = 0;
  section.addEventListener('dragenter', (e) => {
    if (!_hasImageFile(e)) return;
    e.preventDefault();
    dragDepth++;
    section.classList.add('is-dragover');
  });
  section.addEventListener('dragover', (e) => {
    if (!_hasImageFile(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  section.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) section.classList.remove('is-dragover');
  });
  section.addEventListener('drop', (e) => {
    if (!_hasImageFile(e)) return;
    e.preventDefault();
    dragDepth = 0;
    section.classList.remove('is-dragover');
    const file = [...(e.dataTransfer.files || [])].find(f => f.type.startsWith('image/'));
    if (file) _handleAttachImage(convId, file);
  });

  _miniContainerEl.appendChild(section);
}

// dragenter/over fires for non-files too (text, links). Filter so we
// only show the drop hint for actual image drags.
function _hasImageFile(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (const t of types) if (t === 'Files') return true;
  return false;
}

function _renderMessagesMarkup(thread) {
  const user = _cfg.getCurrentUser();
  const myId = user?.id;
  if (!thread.messages.length) {
    const otherName = thread.conv._otherUser?.display_name || thread.conv._otherUser?.username || 'this person';
    return `<div class="dm-mini-empty">Start the conversation with ${escHTML(otherName)}.</div>`;
  }
  // Group consecutive same-sender messages so only the LAST bubble in a
  // run shows the avatar — Messenger pattern.
  let html = '';
  let lastSender = null;
  let lastDate   = null;
  thread.messages.forEach((m, i) => {
    const mine = m.sender_id === myId;
    const dateKey = (m.created_at || '').slice(0, 10);
    if (dateKey !== lastDate) {
      const d = m.created_at ? new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      html += `<div class="dm-mini-date-divider"><span>${escHTML(d)}</span></div>`;
      lastDate = dateKey;
    }
    const next = thread.messages[i + 1];
    const isLastInRun = !next || next.sender_id !== m.sender_id;
    const pendingCls = m._pending ? ' is-pending' : '';
    // Image messages render the picture(s) instead of a text bubble.
    // If both image AND text exist (caption), show the image group then
    // the bubble underneath. Multiple images get grouped into a collage:
    // 2-up, 3-up T-layout, or 4-up 2x2 with +N overlay on overflow.
    const imgs = Array.isArray(m.image_urls) ? m.image_urls : (m.image_url ? [m.image_url] : []);
    let body = '';
    if (imgs.length > 0) body += _renderImageGroup(imgs, pendingCls);
    if (m.body) {
      body += `<div class="dm-mini-bubble${pendingCls}">${escHTML(m.body)}</div>`;
    }
    if (!body) body = `<div class="dm-mini-bubble${pendingCls}"></div>`;
    html += `
      <div class="dm-mini-row ${mine ? 'is-mine' : 'is-theirs'}${isLastInRun ? ' is-tail' : ''}" data-msg-id="${escHTML(m.id)}">
        ${(!mine && isLastInRun)
          ? `<span class="dm-mini-row-avatar">${
              thread.conv._otherUser?.avatar_url
                ? `<img src="${escHTML(thread.conv._otherUser.avatar_url)}"/>`
                : `<span class="dm-dock-initials">${escHTML(initials(thread.conv._otherUser?.display_name || thread.conv._otherUser?.username || '?'))}</span>`
            }</span>`
          : '<span class="dm-mini-row-avatar dm-mini-row-avatar-spacer"></span>'}
        <div class="dm-mini-bubble-wrap">${body}</div>
      </div>
    `;
    lastSender = m.sender_id;
  });
  return html;
}

// Build the image collage for a message. Layouts mirror Messenger:
//   1   →  single full-width image
//   2   →  side-by-side 1×2 grid
//   3   →  T-layout (1 tall left + 2 stacked right)
//   4+  →  2×2 grid, with the 4th cell showing "+N more" when >4 images
function _renderImageGroup(imgs, pendingCls) {
  const cell = (url, extra = '') => `
    <div class="dm-mini-image-cell${extra}">
      <img src="${escHTML(url)}" alt="" loading="lazy"/>
    </div>`;
  if (imgs.length === 1) {
    return `<div class="dm-mini-image${pendingCls}"><img src="${escHTML(imgs[0])}" alt="" loading="lazy"/></div>`;
  }
  if (imgs.length === 2) {
    return `<div class="dm-mini-image-grid is-2${pendingCls}">${cell(imgs[0])}${cell(imgs[1])}</div>`;
  }
  if (imgs.length === 3) {
    return `<div class="dm-mini-image-grid is-3${pendingCls}">${cell(imgs[0])}${cell(imgs[1])}${cell(imgs[2])}</div>`;
  }
  // 4+ — 2x2 with overflow badge on the 4th cell when needed.
  const overflow = imgs.length - 4;
  const four = imgs.slice(0, 4);
  return `<div class="dm-mini-image-grid is-4${pendingCls}">
    ${cell(four[0])}
    ${cell(four[1])}
    ${cell(four[2])}
    ${cell(four[3], overflow > 0 ? ' has-overflow' : '')}
    ${overflow > 0 ? `<div class="dm-mini-image-overflow">+${overflow}</div>` : ''}
  </div>`;
}

// ════════════════════════════════════════════════════════════════════════
// Actions + helpers
// ════════════════════════════════════════════════════════════════════════

function _closeMini(convId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  teardownConversationSubscription(thread.subscription);
  dmDockState.openThreads.delete(convId);
  const idx = dmDockState.focusOrder.indexOf(convId);
  if (idx >= 0) dmDockState.focusOrder.splice(idx, 1);
  _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`)?.remove();
  _avatarContainerEl?.querySelector(`.dm-mini-avatar-bubble[data-conv-id="${CSS.escape(convId)}"]`)?.remove();
  _syncLauncherCompact();   // last chat closing → re-expand pill
}

function _bumpFocus(convId) {
  const idx = dmDockState.focusOrder.indexOf(convId);
  if (idx >= 0) dmDockState.focusOrder.splice(idx, 1);
  dmDockState.focusOrder.push(convId);
  const t = dmDockState.openThreads.get(convId);
  if (t) t.focusedAt = Date.now();
}

function _focusMiniInput(convId) {
  const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`);
  root?.querySelector('.dm-mini-input')?.focus();
}

function _scrollMiniToBottom(convId) {
  const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`);
  const list = root?.querySelector('.dm-mini-messages');
  if (list) list.scrollTop = list.scrollHeight;
}

async function _handleSend(convId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread || thread.sendInFlight) return;
  const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`);
  const input = root?.querySelector('.dm-mini-input');
  const sendBtn = root?.querySelector('.dm-mini-send');
  if (!input) return;
  const body = (input.value || '').trim();
  if (!body) return;

  thread.sendInFlight = true;
  if (sendBtn) sendBtn.disabled = true;
  input.disabled = true;

  const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const optimistic = {
    id: tempId,
    conversation_id: convId,
    sender_id: _cfg.getCurrentUser()?.id,
    body,
    created_at: new Date().toISOString(),
    image_urls: [],
    _pending: true,
  };
  thread.messages.push(optimistic);
  _patchMessagesMarkup(thread);
  _scrollMiniToBottom(convId);
  input.value = '';
  input.style.height = 'auto';

  try {
    const sent = await sendMessageToConversation(convId, { body });
    // Swap optimistic for real
    const idx = thread.messages.findIndex(m => m.id === tempId);
    if (idx >= 0) thread.messages[idx] = sent;
    _patchMessagesMarkup(thread);
    // Optimistically bump conv's last_message_preview in the inbox cache
    const c = _convCache.find(x => x.id === convId);
    if (c) {
      c.last_message_at = sent.created_at;
      c.last_message_preview = body.slice(0, 80);
      c.last_message_sender = sent.sender_id;
    }
  } catch (err) {
    thread.messages = thread.messages.filter(m => m.id !== tempId);
    _patchMessagesMarkup(thread);
    toast(err?.message || 'Message failed', 'error');
  } finally {
    thread.sendInFlight = false;
    if (sendBtn) sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

// Upload an image file then send as a message. Shows an optimistic
// "uploading" bubble with the local objectURL preview so the user
// sees instant feedback. Swaps for the real message on success;
// reverts + toasts on failure.
async function _handleAttachImage(convId, file) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread || thread.sendInFlight) return;
  if (!file || !file.type.startsWith('image/')) {
    toast('Only image files are supported here', 'error');
    return;
  }
  const MAX_BYTES = 10 * 1024 * 1024; // 10MB — matches mobile chat attach cap
  if (file.size > MAX_BYTES) {
    toast('Image too large (max 10MB)', 'error');
    return;
  }

  thread.sendInFlight = true;
  const previewUrl = URL.createObjectURL(file);
  const tempId = `temp-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const optimistic = {
    id: tempId,
    conversation_id: convId,
    sender_id: _cfg.getCurrentUser()?.id,
    body: '',
    created_at: new Date().toISOString(),
    image_urls: [previewUrl],
    _pending: true,
  };
  thread.messages.push(optimistic);
  _patchMessagesMarkup(thread);
  _scrollMiniToBottom(convId);

  try {
    const url = await _cfg.uploadImage(file);
    if (!url) throw new Error('Upload returned no URL');
    const sent = await sendMessageToConversation(convId, {
      imageUrl:  url,
      imageUrls: [url],
      imageKind: file.type === 'image/gif' ? 'gif' : 'photo',
    });
    // Swap optimistic for real — free the objectURL preview to release
    // memory before re-rendering with the real CDN URL.
    URL.revokeObjectURL(previewUrl);
    const idx = thread.messages.findIndex(m => m.id === tempId);
    if (idx >= 0) thread.messages[idx] = sent;
    _patchMessagesMarkup(thread);
    const c = _convCache.find(x => x.id === convId);
    if (c) {
      c.last_message_at = sent.created_at;
      c.last_message_preview = file.type === 'image/gif' ? '🎬 GIF' : '📷 Photo';
      c.last_message_sender = sent.sender_id;
    }
  } catch (err) {
    URL.revokeObjectURL(previewUrl);
    thread.messages = thread.messages.filter(m => m.id !== tempId);
    _patchMessagesMarkup(thread);
    toast(err?.message || 'Image send failed', 'error');
  } finally {
    thread.sendInFlight = false;
  }
}

function _handleIncomingMessage(convId, msg) {
  const thread = dmDockState.openThreads.get(convId);
  if (thread) {
    // Dedupe — realtime echo for messages we just sent (their temp
    // already got swapped above).
    if (thread.messages.some(m => m.id === msg.id)) return;
    thread.messages.push(msg);
    _patchMessagesMarkup(thread);
    // Auto-scroll only if user is already near the bottom; otherwise
    // they're reading older content and we shouldn't yank them.
    const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`);
    const list = root?.querySelector('.dm-mini-messages');
    if (list) {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      if (nearBottom) list.scrollTop = list.scrollHeight;
    }
    // If the user is looking at this chat (expanded, not collapsed to an
    // avatar bubble), mark read immediately.
    if (thread.displayState === 'expanded') markConversationRead(convId);
  }
  // Bump inbox preview + badge regardless of whether mini is open.
  _loadAndRefreshUnread();
}

function _handleMessageUpdate(convId, msg) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  const idx = thread.messages.findIndex(m => m.id === msg.id);
  if (idx >= 0) {
    thread.messages[idx] = { ...thread.messages[idx], ...msg };
    _patchMessagesMarkup(thread);
  }
}

function _handleMessageDelete(convId, msg) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  thread.messages = thread.messages.filter(m => m.id !== msg.id);
  _patchMessagesMarkup(thread);
}

function _patchMessagesMarkup(thread) {
  const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(thread.conv.id)}"]`);
  const list = root?.querySelector('.dm-mini-messages');
  if (!list) return;
  list.innerHTML = _renderMessagesMarkup(thread);
}

// ── Inbox-level unread badge ─────────────────────────────────────────────

async function _loadAndRefreshUnread() {
  try {
    _convCache = await loadConversationList();
  } catch (e) {
    console.warn('[dock] conv list load failed:', e?.message);
  }
  _refreshUnreadBadge();
  // If inbox is open, re-render the list too.
  if (dmDockState.inboxOpen && _inboxEl) _renderInbox();
}

function _refreshUnreadBadge() {
  const user = _cfg.getCurrentUser();
  const total = _convCache.reduce((sum, c) => {
    if (c._archived) return sum;
    if (c._mutedUntil && new Date(c._mutedUntil) > new Date()) return sum;
    if (c.is_secret) return sum;
    // Same "is unread" heuristic as the inbox list — flagged when the
    // last message exists and wasn't from me. Full per-conv unread
    // counts require the app.js dmState logic; Stage 9 extraction
    // will unify the two.
    const isUnread = c.last_message_at && c.last_message_sender !== user?.id;
    return sum + (isUnread ? 1 : 0);
  }, 0);
  const launcherBadge = _launcherEl?.querySelector('.dm-dock-launcher-badge');
  if (launcherBadge) {
    if (total > 0) {
      launcherBadge.textContent = total > 99 ? '99+' : String(total);
      launcherBadge.removeAttribute('data-empty');
    } else {
      launcherBadge.textContent = '';
      launcherBadge.setAttribute('data-empty', '1');
    }
  }
  const inboxBadge = _inboxEl?.querySelector('.dm-dock-inbox-badge');
  if (inboxBadge) {
    if (total > 0) {
      inboxBadge.textContent = String(total);
      inboxBadge.removeAttribute('data-empty');
    } else {
      inboxBadge.textContent = '';
      inboxBadge.setAttribute('data-empty', '1');
    }
  }
}

function _subscribeInboxBadge() {
  const user = _cfg.getCurrentUser();
  if (!user?.id) return;
  if (_inboxChannel) try { supabase.removeChannel(_inboxChannel); } catch {}
  // Coarse: any INSERT into messages pings us. We refresh the conv list
  // (which gets the new last_message_* via the server trigger). Cheap
  // enough since most users don't have thousands of conversations.
  _inboxChannel = supabase
    .channel(`dock-inbox-${user.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => {
      _loadAndRefreshUnread();
    })
    .subscribe();
}
