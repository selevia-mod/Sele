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
  // For "open in full chat" the dock needs to direct the full Messages
  // page to a specific conversation id (works for both 1:1 and groups).
  // showMessages() with a userId only resolves 1:1 chats; for groups
  // we follow up with openConversation(convId). Codex review (#279).
  openConversation:      async (_convId) => {},
  closeAllModals:        () => {},

  // Image upload — shared with the full-page composer + post composer.
  // Receives a File, returns the uploaded URL (or throws).
  uploadImage:           async (_file) => null,

  // Shared GIF picker. The full-page implementation lives in messages.js
  // and supports an `{ anchor, onPick }` callback shape so the dock can
  // anchor the picker to a mini-chat composer and route the picked URL
  // to the mini's own send path. Charles 2026-05-16 parity pass (#257).
  openDmGifPicker:       (_opts) => {},

  // Shared confirm dialog — used by the dock's Delete action to mirror
  // the full-page "Are you sure?" UX before soft-deleting a message.
  // Returns a Promise<boolean>. Charles 2026-05-16 dock parity (#268).
  confirmDialog:         async (_opts) => false,
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

// Quick-reactions strip — same set as full-page DM_QUICK_REACTIONS so a
// reaction added from the dock and a reaction added from the full page
// render identically (no extra grouping). Charles 2026-05-16 dock parity
// (#258).
export const DOCK_QUICK_REACTIONS = ['❤️','😂','😢','😡','👍','🔥'];

// Module-level reaction picker handle. Only one strip can be open at a
// time across all mini chats — opening on a new bubble closes the prior
// one. Click-outside teardown is wired in _openDockReactionPicker.
// `_dockReactionPickerAnchor` tracks which trigger element opened it so
// clicking the SAME trigger a second time toggles the picker off
// (Messenger-style). Without this, the user couldn't dismiss the
// picker by re-clicking the smiley they used to open it — every click
// re-ran open which closes-and-reopens, visibly keeping the strip up.
// Charles 2026-05-16 bug fix.
let _dockReactionPickerEl     = null;
let _dockReactionPickerAnchor = null;

// Action popover — single instance across the dock. Opened by tapping
// any message bubble, closed by tap-outside / Esc / picking an action.
// Charles 2026-05-16 (#291) replaces the hover-revealed action strip.
let _dockActionPopoverEl       = null;
let _dockActionPopoverAnchorId = null;
// Module-level refs to the deferred document listeners so close can
// explicitly remove them. Previously they were closure-scoped and
// only self-unhooked on the next event after teardown — so a stale
// onDoc/onKey fired once orphaned after dock unmount. Codex P2-2.
let _dockActionPopoverDocHandler = null;
let _dockActionPopoverKeyHandler = null;

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

  // Per-conv unread counts in parallel with the profile fetch above —
  // structured this way so future additions (presence pings etc.)
  // can join the parallel block. Codex review 2026-05-16 (#280).
  const unreadCounts = await loadUnreadCountsForConvIds([...idSet]);

  return (convs || []).map((c) => {
    const otherId = !c.is_group && (c.user_a === user.id ? c.user_b : c.user_a);
    return {
      ...c,
      _otherUser:    otherId ? profilesById[otherId] || null : null,
      _archived:     user.id === c.user_a ? !!c.archived_by_a : !!c.archived_by_b,
      _mutedUntil:   user.id === c.user_a ? c.muted_until_a   : c.muted_until_b,
      _unreadCount:  unreadCounts[c.id] || 0,
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

// Load group members + their profiles for a given conversation.
// Returns a Map keyed by user_id → { id, username, display_name,
// avatar_url, role }. Used by the dock to resolve sender identity in
// group chats — 1:1 DMs already get _otherUser via fetchConversationById,
// but groups have N senders and need per-message lookup. Charles
// 2026-05-16 group chat avatar/name fix.
export async function loadGroupMembers(convId) {
  if (!convId) return new Map();
  // Pull last_read_at too so the dock can render per-member seen
  // indicators in groups (mini avatars stacked under own messages
  // every member has read past). Codex follow-up 2026-05-16.
  const { data: parts, error } = await supabase
    .from('conversation_participants')
    .select('user_id, role, last_read_at')
    .eq('conversation_id', convId);
  if (error) {
    console.warn('[dock] group members fetch failed:', error.message);
    return new Map();
  }
  const ids = (parts || []).map(p => p.user_id).filter(Boolean);
  if (!ids.length) return new Map();
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, role')
    .in('id', ids);
  const out = new Map();
  for (const p of (profiles || [])) {
    out.set(p.id, p);
  }
  for (const part of (parts || [])) {
    const profile = out.get(part.user_id);
    if (profile) {
      profile._convRole    = part.role;
      profile._lastReadAt  = part.last_read_at || null;
    }
  }
  return out;
}

// Build a map of messageId → array of group members (other than me)
// who have read past that message. Walks members.last_read_at against
// each own message's created_at — a member counts as "has read message
// M" iff their last_read_at >= M.created_at. Cheap O(messages × members).
// Codex follow-up for Charles's group-seen question 2026-05-16.
function _computeGroupSeenByMsg(thread) {
  const out = {};
  if (!thread.conv.is_group || !thread.members?.size) return out;
  const myId = _cfg.getCurrentUser()?.id;
  const renderMessages = (thread.messages || []).filter(_isRenderableDockMessage);
  for (const m of renderMessages) {
    if (m.sender_id !== myId || m.deleted_at) continue;
    if (!m.created_at) continue;
    const seers = [];
    for (const [, member] of thread.members) {
      if (member.id === myId) continue;
      if (!member._lastReadAt) continue;
      if (new Date(member._lastReadAt) >= new Date(m.created_at)) {
        seers.push(member);
      }
    }
    if (seers.length) out[m.id] = seers;
  }
  // Compress: only show seen badge on the LATEST own message every
  // member has read. Lower messages are implicitly seen, so showing
  // the badge on each one is visual clutter. Keep only the highest
  // id (latest) entry per unique seer-set signature.
  let latestSeenMsgId = null;
  let latestSeenAt = 0;
  for (const m of renderMessages) {
    if (!out[m.id]) continue;
    const t = new Date(m.created_at).getTime();
    if (t > latestSeenAt) { latestSeenAt = t; latestSeenMsgId = m.id; }
  }
  if (!latestSeenMsgId) return {};
  const compact = {};
  compact[latestSeenMsgId] = out[latestSeenMsgId];
  return compact;
}

function _messageImageUrls(m) {
  if (!m) return [];
  if (Array.isArray(m.image_urls)) return m.image_urls.filter(Boolean);
  return m.image_url ? [m.image_url] : [];
}

function _isRenderableDockMessage(m) {
  if (!m) return false;
  if (m.deleted_at || m._pending) return true;
  if ((m.body || '').trim()) return true;
  return _messageImageUrls(m).length > 0;
}

// Merge two reaction maps without losing entries that landed via
// realtime or optimistic toggle while a fetch was in flight. Earlier
// the lazy-load did `thread.reactions = reactions` wholesale, which
// silently dropped any (user_id, emoji) added between the fetch
// starting and resolving. Codex 2026-05-16 P0-1.
function _mergeReactionMaps(existing = {}, incoming = {}) {
  const out = { ...existing };
  for (const [messageId, rows] of Object.entries(incoming || {})) {
    const merged = [...(out[messageId] || [])];
    const seen = new Set(merged.map(r => `${r.user_id}:${r.emoji}`));
    for (const r of rows || []) {
      const key = `${r.user_id}:${r.emoji}`;
      if (!seen.has(key)) {
        merged.push(r);
        seen.add(key);
      }
    }
    out[messageId] = merged;
  }
  return out;
}

// Per-conv unread counts. Mirrors full-page fetchUnreadCounts at
// js/messages.js — counts messages where I'm NOT the sender, read_at
// is null, and deleted_at is null. Earlier the dock approximated
// "unread" as "last_message_sender !== me", which flagged convs as
// unread even after they'd been read. Codex review 2026-05-16 (#280).
export async function loadUnreadCountsForConvIds(convIds) {
  if (!convIds.length) return {};
  const user = _cfg.getCurrentUser();
  if (!user?.id) return {};
  const { data, error } = await supabase
    .from('messages')
    .select('conversation_id, sender_id')
    .in('conversation_id', convIds)
    .is('read_at', null)
    .is('deleted_at', null)
    .neq('sender_id', user.id);
  if (error) {
    console.warn('[dock] unread counts failed:', error.message);
    return {};
  }
  const counts = {};
  for (const m of (data || [])) {
    counts[m.conversation_id] = (counts[m.conversation_id] || 0) + 1;
  }
  return counts;
}

// Load all reactions for a set of message ids, grouped by message_id.
// Returns { [messageId]: [{ user_id, emoji, message_id }, ...] } so
// callers can store the map on their thread and pass it straight into
// the bubble renderer. Empty {} on no messages / no reactions. Mirrors
// fetchReactionsForConversation in messages.js but avoids a second
// round-trip to fetch message ids (the dock already has them).
export async function loadReactionsForMessageIds(messageIds = []) {
  if (!messageIds.length) return {};
  const { data, error } = await supabase
    .from('message_reactions')
    .select('message_id, user_id, emoji, created_at')
    .in('message_id', messageIds);
  if (error) {
    console.warn('[dock] reactions fetch failed:', error.message);
    return {};
  }
  const out = {};
  for (const r of (data || [])) {
    if (!out[r.message_id]) out[r.message_id] = [];
    out[r.message_id].push(r);
  }
  return out;
}

// Toggle a reaction. Returns 'added' / 'removed' / null (on failure).
// Optimistic mutation of the passed `reactionsMap` happens in the
// caller; this helper just handles the supabase round-trip + rollback
// signaling.
export async function toggleMessageReaction(messageId, emoji) {
  const user = _cfg.getCurrentUser();
  if (!user?.id || !messageId || !emoji) return null;
  // Check existing first to choose insert vs delete branch — same
  // pattern as the full-page toggleReaction. A duplicate insert would
  // hit the unique index and fail; a missing delete is a no-op.
  const { data: existing, error: lookupErr } = await supabase
    .from('message_reactions')
    .select('message_id')
    .eq('message_id', messageId)
    .eq('user_id', user.id)
    .eq('emoji', emoji)
    .maybeSingle();
  if (lookupErr) {
    console.warn('[dock] reaction lookup failed:', lookupErr.message);
    return null;
  }
  if (existing) {
    const { error } = await supabase.from('message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', user.id)
      .eq('emoji', emoji);
    if (error) { toast(error.message, 'error'); return null; }
    return 'removed';
  } else {
    const { error } = await supabase.from('message_reactions').insert({
      message_id: messageId, user_id: user.id, emoji,
    });
    if (error) { toast(error.message, 'error'); return null; }
    return 'added';
  }
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

  // ── Progressive open (Charles 2026-05-16 perf fix #290) ──
  // Old flow: await fetchConversationById + loadMessages (parallel) →
  // await loadReactions → await loadGroupMembers → render. Total
  // wait before the mini chat appeared was 600-1000ms.
  //
  // New flow (Messenger-style):
  //   1. Use cached conv from _convCache (the inbox click implies it's
  //      already there). Skip the conv fetch entirely. → render shell
  //      in <50ms.
  //   2. Subscribe to realtime channels concurrently with data loads,
  //      so a message arriving during the load still lands in state.
  //   3. Fire messages + members loads in PARALLEL via Promise.all.
  //   4. Fetch reactions LAST — they're decorative, can land late
  //      without blocking the bubble render. Patch the markup again
  //      when they arrive.
  //
  // Falls back to fetchConversationById ONLY for deep-link / notification
  // taps where the conv isn't in the inbox cache yet.

  let conv = _convCache.find(c => c.id === convId);
  if (!conv) {
    // Cold path — no cache. This is the rare deep-link case.
    conv = await fetchConversationById(convId);
    if (!conv) { toast('Could not load conversation', 'error'); return; }
  }
  // Secret chats can NEVER render in the dock — they require the PIN
  // gate that lives on the full-page Messages view.
  // Codex P1-1 (2026-05-16): the cached `is_secret` flag is NOT
  // authoritative — a conv flipped to secret server-side may still
  // appear non-secret in our local cache for ~minutes until the
  // conversations.UPDATE realtime echo lands. Do a fresh fetch in
  // parallel with the rest of the open flow; if the live row says
  // secret, redirect to full-page PIN gate after tearing down the
  // mini we may have already rendered.
  if (conv.is_secret) {
    _cfg.showMessages?.();
    return;
  }

  // Build the thread shell IMMEDIATELY with placeholders. The render
  // path handles empty messages/members/reactions gracefully (renders
  // a small "Loading…" stub via the new isLoadingMessages flag).
  // openingUnreadCount snapshot — captured before _markDockConvReadLocal
  // zeroes the cache, so the unread-divider computation has the right
  // anchor even after the badge updates locally. Codex P1-4.
  const openingUnreadCount = conv._unreadCount || 0;
  const thread = {
    conv,
    messages: [],
    reactions: {},
    members: new Map(),
    groupSeenByMsg: {},
    unreadAnchorId: null,
    openingUnreadCount,        // captured before local cache clears
    otherIsTyping: false,
    typingTimer:   null,
    presenceChannel: null,
    myTypingThrottle: null,
    displayState: 'expanded',
    sendInFlight: false,
    subscription: null,
    reactionSubscription: null,
    focusedAt: Date.now(),
    hasOlder: false,
    loadingOlder: false,
    isLoadingMessages: true,    // render loader until messages land (#290)
  };
  dmDockState.openThreads.set(convId, thread);
  _bumpFocus(convId);
  _displaceIfOverCap(convId);
  _renderAllChats();              // ← INSTANT shell render
  _syncLauncherCompact();

  // Subscribe to realtime BEFORE the data load — any insert/update
  // arriving mid-load gets buffered into state correctly. Channels
  // are cheap (free until messages flow).
  thread.subscription = subscribeToConversation(convId, {
    onInsert: (msg) => _handleIncomingMessage(convId, msg),
    onUpdate: (msg) => _handleMessageUpdate(convId, msg),
    onDelete: (msg) => _handleMessageDelete(convId, msg),
  });
  thread.reactionSubscription = _subscribeReactionsForThread(convId);
  thread.presenceChannel = _subscribeDockPresence(convId);

  // Fire messages + members in parallel. Reactions wait for messages
  // (need their ids) but launch as soon as messages return — they
  // don't block the bubble render. markConversationRead also kicks
  // off in parallel.
  // Mark read on the server + IMMEDIATELY zero the local cache so the
  // inbox badge drops without waiting for the next conversations.UPDATE
  // round-trip. _markDockConvReadLocal also patches the inbox list in
  // place if it's open. Codex P1-4.
  _markDockConvReadLocal(convId);
  markConversationRead(convId);

  // Verify is_secret against the live row in parallel — protects
  // against the case where the cached conv is stale and the chat
  // has been flipped to secret server-side. If verified secret, tear
  // down the mini we just rendered and bounce to full-page PIN gate.
  // Codex P1-1.
  fetchConversationById(convId).then((live) => {
    if (!live) return;
    // Refresh local cache copy so subsequent opens use accurate data.
    const cached = _convCache.find(c => c.id === convId);
    if (cached) Object.assign(cached, live);
    if (live.is_secret) {
      _closeMini(convId);
      _cfg.showMessages?.();
    }
  }).catch(() => {});

  try {
    const [messages, members] = await Promise.all([
      loadMessagesForConversation(convId, { limit: 30 }),
      conv.is_group ? loadGroupMembers(convId) : Promise.resolve(new Map()),
    ]);
    thread.messages = messages;
    thread.members  = members;
    thread.hasOlder = messages.length >= 30;
    thread.isLoadingMessages = false;

    // Unread divider anchor (#281). Use openingUnreadCount snapshot,
    // NOT conv._unreadCount — the local cache was zeroed in
    // _markDockConvReadLocal above. Codex P1-4.
    if (thread.openingUnreadCount > 0 && messages.length > 0) {
      const idx = Math.max(0, messages.length - thread.openingUnreadCount);
      const anchor = messages.slice(idx).find(_isRenderableDockMessage) || messages.find(_isRenderableDockMessage);
      thread.unreadAnchorId = anchor?.id || null;
    }
    if (conv.is_group) {
      thread.groupSeenByMsg = _computeGroupSeenByMsg(thread);
    }
    _patchMessagesMarkup(thread, { preserveScroll: false });
    _scrollMiniToBottom(convId);
    _focusMiniInput(convId);

    // Reactions — lazy, non-blocking. Decorative so it's OK if they
    // appear a beat after the bubbles. Merge instead of wholesale-
    // assign so any realtime echo / optimistic toggle that landed
    // during the fetch isn't dropped. Codex 2026-05-16 P0-1.
    if (messages.length) {
      loadReactionsForMessageIds(messages.map(m => m.id))
        .then((reactions) => {
          thread.reactions = _mergeReactionMaps(thread.reactions, reactions);
          _patchMessagesMarkup(thread);
        })
        .catch(() => {});
    }
  } catch (err) {
    console.warn('[dock] progressive load failed:', err?.message);
    thread.isLoadingMessages = false;
    _patchMessagesMarkup(thread);
  }
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
    if (thread.reactionSubscription) {
      try { supabase.removeChannel(thread.reactionSubscription); } catch {}
    }
    if (thread.presenceChannel) {
      try { supabase.removeChannel(thread.presenceChannel); } catch {}
    }
    if (thread.typingTimer) clearTimeout(thread.typingTimer);
    if (thread.myTypingThrottle) clearTimeout(thread.myTypingThrottle);
  }
  // Close any open reaction picker so its outside-click listener doesn't
  // outlive the dock.
  _closeDockReactionPicker();
  _closeDockActionPopover();   // #291 — tap-to-open action popover
  dmDockState.openThreads.clear();
  dmDockState.focusOrder.length = 0;
  dmDockState.inboxOpen = false;
  if (_inboxChannel) { try { supabase.removeChannel(_inboxChannel); } catch {} _inboxChannel = null; }
  // Clear pending inbox-refresh debounce (Codex P2-1).
  if (_refreshUnreadTimer) { clearTimeout(_refreshUnreadTimer); _refreshUnreadTimer = null; }
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
  // Exclude is_secret too — Secret chats live behind the full-page PIN
  // gate. Showing them in the always-visible dock inbox would let a
  // single click open a mini chat that bypasses PIN entry, which is
  // exactly the gate the Secret feature is supposed to enforce.
  // (Codex review 2026-05-16, P0 extra finding. The unread-badge
  // calculation at _refreshUnreadBadge already excludes is_secret —
  // this brings the inbox list to the same invariant.)
  const list = _convCache.filter(c => !c._archived && !c.is_secret).slice(0, 30);
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
    // Real unread count (Codex review 2026-05-16 #280). Prior impl
    // showed a dot for ANY conv whose last message wasn't mine, even
    // if I'd already read it. Now we render a numeric badge when
    // there are actually unread messages I haven't seen, and nothing
    // otherwise. Muted convs suppress the badge entirely.
    const unread = c._unreadCount || 0;
    const muted = c._mutedUntil && new Date(c._mutedUntil) > new Date();
    const unreadBadge = (unread > 0 && !muted)
      ? `<span class="dm-dock-conv-unread-count">${unread > 99 ? '99+' : unread}</span>`
      : '';
    return `
      <button type="button" class="dm-dock-conv-item" data-conv-id="${escHTML(c.id)}">
        <span class="dm-dock-conv-avatar">${avatarHTML}</span>
        <span class="dm-dock-conv-meta">
          <span class="dm-dock-conv-name">${escHTML(otherName)}</span>
          <span class="dm-dock-conv-preview">${preview}</span>
        </span>
        <span class="dm-dock-conv-aside">
          ${time ? `<span class="dm-dock-conv-time">${escHTML(time)}</span>` : ''}
          ${unreadBadge}
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
      <button type="submit" class="dm-mini-send is-thumb" title="Send" aria-label="Send">
        <!-- Two icons; CSS swaps visibility based on .is-thumb (empty
             input → thumbs-up quick send) vs the default paper-plane.
             Empty composer + tap = ship 👍 (mirrors mobile + full page).
             Charles 2026-05-16 dock parity. -->
        <svg class="dm-mini-send-icon-plane" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        <svg class="dm-mini-send-icon-thumb" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 21h4V9H2v12zM23 10c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>
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
  section.querySelector('.dm-mini-expand').addEventListener('click', async () => {
    _closeMini(convId);
    // Two-step open: showMessages() routes to the full Messages page,
    // then openConversation(convId) selects the specific thread. The
    // userId variant of showMessages only resolves 1:1 chats — for
    // groups (and for safety in 1:1 too) we explicitly target by
    // convId. Codex review 2026-05-16 (#279).
    await _cfg.showMessages();
    try { await _cfg.openConversation?.(convId); } catch (e) { console.warn('[dock] openConversation failed:', e?.message); }
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
  // Module-level _syncSendIcon (below) is the canonical implementation;
  // the closure here just defers to it so the attach paths can also
  // call it without needing access to the section's inner refs. Charles
  // 2026-05-16 + Codex review P1-6.
  const sync = () => _syncSendIcon(convId);
  input.addEventListener('input', () => {
    autosize();
    sync();
    _broadcastDockTyping(convId);   // typing presence (#283)
  });
  // paste fires BEFORE the input value updates, so defer one tick so
  // syncSendIcon reads the post-paste value. Mirrors how Safari resolves
  // paste → input sequencing.
  input.addEventListener('paste', () => setTimeout(sync, 0));
  sync();
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
    // Load-older sentinel at the top of the messages list. Codex
    // review (#282). Prepends one page of older messages then
    // re-renders + restores scroll position so the user doesn't lose
    // their place.
    const olderBtn = e.target.closest('[data-action="load-older"]');
    if (olderBtn) {
      e.preventDefault();
      e.stopPropagation();
      _handleLoadOlder(convId);
      return;
    }
    // Reaction pill — toggle. Lives before the image branch so a pill
    // overlaid on an image bubble (rare but possible with image+caption
    // messages) doesn't trigger the lightbox.
    const pill = e.target.closest('.dm-mini-rx-pill');
    if (pill) {
      e.preventDefault();
      e.stopPropagation();
      _toggleDockReaction(convId, pill.dataset.msg, pill.dataset.emoji);
      return;
    }
    // NOTE — bubble-tap branch lives BELOW the image branch (further
    // down in this handler). Images need to open the lightbox before
    // the wrap's tap-to-popover catches the click. Order matters:
    // pill > older > image > edit save/cancel > reply quote > bubble
    // wrap. Charles 2026-05-16 (#291).
    // Edit save / cancel buttons.
    const editSave = e.target.closest('.dm-mini-edit-save');
    if (editSave) {
      e.preventDefault();
      e.stopPropagation();
      _saveDockEdit(convId, editSave.dataset.msg);
      return;
    }
    const editCancel = e.target.closest('.dm-mini-edit-cancel');
    if (editCancel) {
      e.preventDefault();
      e.stopPropagation();
      _cancelDockEdit(convId);
      return;
    }
    // Reply-quote chip → scroll to original message in the mini.
    const replyQuote = e.target.closest('.dm-mini-reply-quote[data-jump-to]');
    if (replyQuote) {
      e.preventDefault();
      e.stopPropagation();
      _jumpToDockMessage(convId, replyQuote.dataset.jumpTo);
      return;
    }
    // Image-message actions overlay button. Runs before the image
    // branch so tapping the ⋯ opens the popover instead of the
    // lightbox. Codex P1-3.
    const imgActBtn = e.target.closest('.dm-mini-img-actions');
    if (imgActBtn) {
      e.preventDefault();
      e.stopPropagation();
      _closeDockReactionPicker();
      const wrap = imgActBtn.closest('.dm-mini-bubble-wrap[data-msg]');
      _openDockActionPopover(convId, imgActBtn.dataset.msg, wrap || imgActBtn);
      return;
    }
    const img = e.target.closest('.dm-mini-image img, .dm-mini-image-cell img');
    if (img) {
      e.preventDefault();
      e.stopPropagation();
      const url = img.getAttribute('src');
      if (!url) return;
      // If the image is part of a group (2/3/4-up grid), open the
      // gallery lightbox so the user can prev/next through the rest.
      // Codex review (#284).
      const row = img.closest('.dm-mini-row');
      const msgId = row?.dataset.msgId;
      const thread = dmDockState.openThreads.get(convId);
      const msg = thread?.messages.find(m => m.id === msgId);
      const imgs = Array.isArray(msg?.image_urls) ? msg.image_urls : (msg?.image_url ? [msg.image_url] : []);
      if (imgs.length > 1 && typeof window.openLightboxGallery === 'function') {
        const startIndex = Math.max(0, imgs.indexOf(url));
        window.openLightboxGallery(imgs, startIndex);
      } else if (typeof window.openLightbox === 'function') {
        window.openLightbox(url);
      }
      return;
    }

    // Skip the action popover when clicking inside the inline edit
    // textarea — caret positioning, drag-select, right-click all
    // bubble up to the wrap and would otherwise pop the action menu
    // on top of the editor. Codex P0-2.
    if (e.target.closest('.dm-mini-edit-textarea')) return;
    // Bubble-wrap tap → open action popover (React / Reply / Copy /
    // Edit / Delete). Lives at the END so pills / images / reply
    // quotes / edit buttons / load-older all get first crack at
    // the click. Charles 2026-05-16 (#291).
    const wrap = e.target.closest('.dm-mini-bubble-wrap[data-msg]');
    if (wrap) {
      e.preventDefault();
      e.stopPropagation();
      _closeDockReactionPicker();
      _openDockActionPopover(convId, wrap.dataset.msg, wrap);
    }
  });

  // Edit textarea keyboard handlers — bound here so they survive
  // bubble re-renders (the textarea itself is rebuilt by _patchMessagesMarkup
  // on every update). Delegated keydown lets us catch Enter/Esc cheaply.
  // Also handles Enter/Space on the bubble tap target so keyboard
  // users can open the action popover. Charles 2026-05-16 (#291).
  messagesEl.addEventListener('keydown', (e) => {
    // Edit textarea handler FIRST — Enter/Space inside the editor must
    // save/cancel + insert space, not open the action popover (the
    // wrap is an ancestor of the textarea so it'd otherwise match).
    // Codex P0-2.
    const ta = e.target.closest('.dm-mini-edit-textarea');
    if (ta) {
      const row = ta.closest('.dm-mini-row');
      const msgId = row?.dataset.msgId;
      if (!msgId) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _saveDockEdit(convId, msgId);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        _cancelDockEdit(convId);
      }
      return;
    }
    const wrap = e.target.closest('.dm-mini-bubble-wrap[data-msg]');
    if (wrap && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      _closeDockReactionPicker();
      _openDockActionPopover(convId, wrap.dataset.msg, wrap);
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
      closeAttachMenu();
      if (kind === 'gif') {
        // Hand off to the shared Giphy picker. Anchor against the +
        // button so the picker pops above the mini-composer; onPick
        // routes the chosen URL through _handleAttachGifUrl so the
        // dock's optimistic-bubble + per-mini reconcile fires (the
        // full-page sendDmGif targets dmComposer state, not the dock).
        _cfg.openDmGifPicker({
          anchor: attachBtn,
          onPick: (gifUrl) => _handleAttachGifUrl(convId, gifUrl),
        });
        return;
      }
      // Photo: open the file picker with image MIME filter.
      fileInput.accept = 'image/png,image/jpeg,image/webp,image/heic,image/heif';
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
  const isGroup = !!thread.conv.is_group;
  // Load-older sentinel — sits above the oldest message. Codex review
  // (#282). Hidden when we've definitively run out (hasOlder=false)
  // OR while a load is in flight (loadingOlder=true) to prevent
  // double-clicks racing.
  let olderHtml = '';
  if (thread.hasOlder) {
    olderHtml = thread.loadingOlder
      ? `<div class="dm-mini-older-row is-loading"><span>Loading older messages…</span></div>`
      : `<button type="button" class="dm-mini-older-row" data-action="load-older">Load older messages</button>`;
  }
  // Sender resolver — for groups looks up the per-message sender from
  // thread.members; for 1:1 falls back to conv._otherUser (the single
  // counterparty). Without this groups render every incoming message
  // with a "?" placeholder because _otherUser is null. Charles
  // 2026-05-16 group avatar/name bug.
  const senderProfile = (senderId) => {
    if (!senderId) return null;
    if (isGroup) return thread.members?.get(senderId) || null;
    return senderId === myId ? null : (thread.conv._otherUser || null);
  };
  const senderShortName = (p) => {
    if (!p) return 'Unknown';
    return p.display_name?.split(' ')[0] || p.username || 'Unknown';
  };
  const senderFullName = (p) => p?.display_name || p?.username || 'Unknown';
  const renderMessages = (thread.messages || []).filter(_isRenderableDockMessage);
  const messageById = new Map((thread.messages || []).map(m => [m.id, m]));
  if (!renderMessages.length) {
    // Distinguish "still loading initial page" from "truly empty conv".
    // Without this, the open-shell-first optimization (#290) would
    // briefly flash a "Start the conversation with X" empty state
    // before the messages land — confusing for chats that aren't
    // actually new.
    if (thread.isLoadingMessages) {
      return `<div class="dm-mini-loading"><span class="dm-mini-loading-dot"></span><span class="dm-mini-loading-dot"></span><span class="dm-mini-loading-dot"></span></div>`;
    }
    const otherName = isGroup
      ? (thread.conv.name || 'this group')
      : (thread.conv._otherUser?.display_name || thread.conv._otherUser?.username || 'this person');
    const verb = isGroup ? 'Start the conversation in' : 'Start the conversation with';
    return `<div class="dm-mini-empty">${escHTML(verb)} ${escHTML(otherName)}.</div>`;
  }
  // Group consecutive same-sender messages so only the LAST bubble in a
  // run shows the avatar — Messenger pattern. (We compute "last in run"
  // by peeking at the next message via index, NOT by tracking
  // lastSender across iterations — that prior bookkeeping was dead
  // code, removed Codex review P2-274.)
  let html = olderHtml;
  let lastDate = null;
  // Precompute the id of the LAST own message that the other side has
  // actually read. We render the seen avatar INLINE right after that
  // message — not blanket at the bottom — otherwise we'd visually
  // claim the newest message was seen even when the recipient only
  // read an older one. Charles bug 2026-05-16 (Codex #283 follow-up).
  let lastReadOfMineId = null;
  if (!isGroup && thread.conv._otherUser) {
    for (let i = renderMessages.length - 1; i >= 0; i--) {
      const m = renderMessages[i];
      if (m.sender_id === myId && m.read_at && !m.deleted_at) {
        lastReadOfMineId = m.id;
        break;
      }
    }
  }

  renderMessages.forEach((m, i) => {
    const mine = m.sender_id === myId;
    const dateKey = (m.created_at || '').slice(0, 10);
    if (dateKey !== lastDate) {
      const d = m.created_at ? new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      html += `<div class="dm-mini-date-divider"><span>${escHTML(d)}</span></div>`;
      lastDate = dateKey;
    }
    // Unread divider — render once, just above the first message that
    // was unread when the chat opened. Codex review (#281).
    if (thread.unreadAnchorId && m.id === thread.unreadAnchorId) {
      html += `<div class="dm-mini-unread-divider"><span>New messages</span></div>`;
    }
    const prev = renderMessages[i - 1];
    const next = renderMessages[i + 1];
    const isLastInRun = !next || next.sender_id !== m.sender_id;
    const pendingCls = m._pending ? ' is-pending' : '';

    // ── Deleted-message branch ──────────────────────────────────────
    // Soft-deleted messages (delete-for-everyone) arrive with
    // `deleted_at` set and `body` cleared to '' (web + mobile both
    // clear body now — see deleteMessage in messages.js). Without
    // this branch the dock rendered an empty bubble for text deletes
    // and STILL showed the picture for image deletes because
    // `image_urls` is never cleared (the asset's already on the CDN;
    // we just hide it in the UI). Suppress images, the react button,
    // and the reactions strip — show only an "unsent a message"
    // label. Codex review 2026-05-16, P0-2.
    if (m.deleted_at) {
      const sender = senderProfile(m.sender_id);
      const who = mine ? 'You' : escHTML(senderShortName(sender));
      const avatarHtml = sender?.avatar_url
        ? `<img src="${escHTML(sender.avatar_url)}"/>`
        : `<span class="dm-dock-initials">${escHTML(initials(senderFullName(sender)))}</span>`;
      html += `
        <div class="dm-mini-row ${mine ? 'is-mine' : 'is-theirs'}${isLastInRun ? ' is-tail' : ''}" data-msg-id="${escHTML(m.id)}">
          ${mine
            ? ''
            : (isLastInRun
                ? `<span class="dm-mini-row-avatar">${avatarHtml}</span>`
                : '<span class="dm-mini-row-avatar dm-mini-row-avatar-spacer"></span>')}
          <div class="dm-mini-bubble-wrap">
            <div class="dm-mini-bubble is-deleted" title="${escHTML(new Date(m.deleted_at).toLocaleString())}">
              <span class="dm-mini-deleted-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
              </span>
              ${who} unsent a message
            </div>
          </div>
        </div>
      `;
      return;   // skip the live-message render path below
    }

    // Image messages render the picture(s) instead of a text bubble.
    // If both image AND text exist (caption), show the image group then
    // the bubble underneath. Multiple images get grouped into a collage:
    // 2-up, 3-up T-layout, or 4-up 2x2 with +N overlay on overflow.
    const imgs = _messageImageUrls(m);
    let body = '';
    if (imgs.length > 0) body += _renderImageGroup(imgs, pendingCls);
    const bodyText = (m.body || '').trim();
    if (bodyText) {
      body += `<div class="dm-mini-bubble${pendingCls}">${escHTML(bodyText)}</div>`;
    }
    if (!body) return;

    // ── Reactions strip + hover "react" affordance ────────────────────
    // Pills group identical emojis and highlight the ones I added so
    // tapping toggles the right row. Hover button is a tiny smiley to
    // the side of the bubble; clicking opens the quick-reactions
    // picker anchored above the bubble. Both render flags are gated on
    // !_pending — reacting to an optimistic placeholder before it has
    // a real id would write to a non-existent message_id.
    const reactList = thread.reactions?.[m.id] || [];
    let reactionsHtml = '';
    if (reactList.length) {
      const grouped = {};
      const mineSet = new Set();
      for (const r of reactList) {
        grouped[r.emoji] = (grouped[r.emoji] || 0) + 1;
        if (r.user_id === myId) mineSet.add(r.emoji);
      }
      const pills = Object.entries(grouped).map(([emoji, count]) =>
        `<button type="button" class="dm-mini-rx-pill${mineSet.has(emoji) ? ' is-mine' : ''}" data-msg="${escHTML(m.id)}" data-emoji="${escHTML(emoji)}" title="${mineSet.has(emoji) ? 'Remove your reaction' : 'Toggle reaction'}">
          <span class="dm-mini-rx-pill-emoji">${emoji}</span>${count > 1 ? `<span class="dm-mini-rx-pill-count">${count}</span>` : ''}
        </button>`
      ).join('');
      // aria-live=polite so screen-readers announce reactions arriving
      // from realtime without yelling. Codex review P2-269.
      reactionsHtml = `<div class="dm-mini-bubble-reactions ${mine ? 'is-mine' : 'is-theirs'}" role="group" aria-label="Reactions on this message" aria-live="polite">${pills}</div>`;
    }
    // ── Bubble actions are now TAP-TRIGGERED, not hover-revealed.
    // Charles 2026-05-16 — replaces the absolute-positioned hover
    // action strip that added ~28px of visual claim above each row.
    // The bubble itself is the trigger; click opens an action popover
    // (React / Reply / Copy / Edit / Delete) anchored to the bubble.
    // No per-message DOM cost in the render path now. Layout is
    // visibly tighter as a result. */

    // Reply quote chip — show the quoted message above the bubble.
    // Mirrors the full-page dm-reply-quote rendering. The original
    // sender's name + a snippet of body (or "unsent message"). For
    // groups, resolves parentName via the per-message member lookup.
    let replyQuoteHtml = '';
    if (m.reply_to_id) {
      const parent = messageById.get(m.reply_to_id);
      if (parent) {
        const parentMine = parent.sender_id === myId;
        const parentName = parentMine ? 'You' : senderShortName(senderProfile(parent.sender_id));
        const parentBody = parent.deleted_at ? '(unsent message)' : (parent.body || '').slice(0, 80);
        replyQuoteHtml = `<div class="dm-mini-reply-quote ${mine ? 'is-mine' : 'is-theirs'}" data-jump-to="${escHTML(parent.id)}">
          <span class="dm-mini-reply-quote-name">${escHTML(parentName)}</span>
          <span class="dm-mini-reply-quote-body">${escHTML(parentBody)}</span>
        </div>`;
      } else {
        replyQuoteHtml = `<div class="dm-mini-reply-quote ${mine ? 'is-mine' : 'is-theirs'} is-orphan">Original message unavailable</div>`;
      }
    }

    // Edit-mode replaces the bubble body with an inline textarea. The
    // input wiring (Enter save, Esc cancel) is bound below in _renderMini's
    // delegated handler since the row is innerHTML-rebuilt on every patch.
    let bubbleHtml = body;
    if (thread.editingMessageId === m.id) {
      bubbleHtml = `<div class="dm-mini-edit-wrap">
        <textarea class="dm-mini-edit-textarea" maxlength="4000">${escHTML(m.body || '')}</textarea>
        <div class="dm-mini-edit-actions">
          <button type="button" class="dm-mini-edit-cancel" data-msg="${escHTML(m.id)}">Cancel</button>
          <button type="button" class="dm-mini-edit-save" data-msg="${escHTML(m.id)}">Save</button>
        </div>
      </div>`;
    } else if (m.edited_at && m.body) {
      // Append a small "(edited)" tag inline so users see the bubble was
      // changed post-send. Mirrors full-page editedTag pattern.
      bubbleHtml = body.replace(
        /<div class="dm-mini-bubble([^"]*)">([\s\S]*?)<\/div>/,
        '<div class="dm-mini-bubble$1">$2 <span class="dm-mini-edited">(edited)</span></div>'
      );
    }

    // Per-message sender (groups need this per-bubble; 1:1 reuses _otherUser).
    const sender = senderProfile(m.sender_id);
    const senderAvatarHtml = sender?.avatar_url
      ? `<img src="${escHTML(sender.avatar_url)}"/>`
      : `<span class="dm-dock-initials">${escHTML(initials(senderFullName(sender)))}</span>`;

    // Group chats show the sender name above the FIRST bubble in a run
    // (Messenger group pattern). Skip for 1:1 (you know who you're
    // talking to) and skip for my own messages. Only render at the
    // top of a run so consecutive bubbles from the same person don't
    // repeat the name.
    const isFirstInRun = !prev || prev.sender_id !== m.sender_id;
    const senderNameHtml = (isGroup && !mine && isFirstInRun)
      ? `<div class="dm-mini-sender-name">${escHTML(senderFullName(sender))}</div>`
      : '';
    // Run-position class — drives the Messenger-style corner-radius
    // grouping + tighter vertical spacing for consecutive same-sender
    // bubbles. Charles bug 2026-05-16. Mapping:
    //   first AND last  → singleton (no class — full rounded bubble)
    //   first only      → is-run-first (tail corner on bottom of run side)
    //   neither         → is-run-mid   (both corners on run side tight)
    //   last only       → is-run-last  (tail corner on top of run side)
    let runClass = '';
    if (isFirstInRun && !isLastInRun)       runClass = ' is-run-first';
    else if (!isFirstInRun && !isLastInRun) runClass = ' is-run-mid';
    else if (!isFirstInRun && isLastInRun)  runClass = ' is-run-last';

    // Inline seen indicator — render IMMEDIATELY after the row that
    // matches lastReadOfMineId so the avatar sits under the exact
    // message the recipient read. Earlier impl appended to the end
    // of the chat, which made it look like the newest message was
    // seen even when only an older one was. Charles bug 2026-05-16.
    let seenInlineHtml = '';
    if (!isGroup && m.id === lastReadOfMineId && thread.conv._otherUser) {
      const other = thread.conv._otherUser;
      const seenAv = other.avatar_url
        ? `<img src="${escHTML(other.avatar_url)}" alt=""/>`
        : `<span class="dm-dock-initials">${escHTML(initials(other.display_name || other.username || '?'))}</span>`;
      seenInlineHtml = `<div class="dm-mini-seen-row" title="Seen ${escHTML(new Date(m.read_at).toLocaleString())}">${seenAv}</div>`;
    } else if (isGroup && thread.groupSeenByMsg?.[m.id]?.length && m.sender_id === myId) {
      // Group seen: stacked mini-avatars of members (other than me)
      // who have read up through THIS message. Codex follow-up for
      // Charles's group-seen question 2026-05-16.
      const seers = thread.groupSeenByMsg[m.id];
      const stackHtml = seers.slice(0, 4).map(p => p.avatar_url
        ? `<img src="${escHTML(p.avatar_url)}" alt="${escHTML(p.display_name || p.username || '?')}" title="${escHTML(p.display_name || p.username || '?')}"/>`
        : `<span class="dm-dock-initials" title="${escHTML(p.display_name || p.username || '?')}">${escHTML(initials(p.display_name || p.username || '?'))}</span>`
      ).join('');
      const overflow = seers.length > 4 ? `<span class="dm-mini-seen-overflow">+${seers.length - 4}</span>` : '';
      seenInlineHtml = `<div class="dm-mini-seen-row is-group" title="Seen by ${escHTML(seers.map(p => p.display_name || p.username || '?').join(', '))}">${stackHtml}${overflow}</div>`;
    }

    // For image-only messages (no .dm-mini-bubble) the image click
    // opens the lightbox via the image branch — which means the
    // wrap-tap-to-popover branch never fires. Without an explicit
    // affordance, users can't React/Reply/Delete pure-image messages
    // from the dock. Add a small ⋯ overlay button on those rows.
    // Codex P1-3 (2026-05-16).
    const isImageOnly = !m.deleted_at && !m._pending && imgs.length > 0 && !m.body;
    const imgActionsBtn = isImageOnly
      ? `<button type="button" class="dm-mini-img-actions" data-msg="${escHTML(m.id)}" aria-label="Image message actions" title="Actions">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
        </button>`
      : '';

    // seenInlineHtml now lives INSIDE the bubble-wrap (after reactions)
    // instead of as its own row sibling. Earlier impl appended it
    // after </div></div> at the row level, so the seen avatar acted
    // as a third flex item in .dm-mini-messages and got the same row
    // margin treatment — visually detaching from the message it was
    // supposed to belong to. Codex 2026-05-16.
    html += `
      <div class="dm-mini-row ${mine ? 'is-mine' : 'is-theirs'}${isLastInRun ? ' is-tail' : ''}${runClass}" data-msg-id="${escHTML(m.id)}">
        ${mine
          ? ''
          : (isLastInRun
              ? `<span class="dm-mini-row-avatar">${senderAvatarHtml}</span>`
              : '<span class="dm-mini-row-avatar dm-mini-row-avatar-spacer"></span>')}
        <div class="dm-mini-bubble-wrap" data-msg="${escHTML(m.id)}" role="button" tabindex="0" aria-label="Message actions">
          ${senderNameHtml}
          ${replyQuoteHtml}
          ${bubbleHtml}
          ${imgActionsBtn}
          ${reactionsHtml}
          ${seenInlineHtml}
        </div>
      </div>
    `;
  });

  // ── Typing indicator — 3-dot animated bubble. Mirrors full-page
  // dm-typing-bubble. Codex review (#283).
  if (thread.otherIsTyping) {
    const other = thread.conv._otherUser;
    const avatar = other?.avatar_url
      ? `<img src="${escHTML(other.avatar_url)}" alt=""/>`
      : `<span class="dm-dock-initials">${escHTML(initials(other?.display_name || other?.username || '?'))}</span>`;
    html += `
      <div class="dm-mini-row is-theirs is-tail dm-mini-typing-row">
        <span class="dm-mini-row-avatar">${avatar}</span>
        <div class="dm-mini-bubble-wrap">
          <div class="dm-mini-bubble dm-mini-typing-bubble" aria-label="Typing">
            <span class="dm-mini-typing-dot"></span><span class="dm-mini-typing-dot"></span><span class="dm-mini-typing-dot"></span>
          </div>
        </div>
      </div>
    `;
  }
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
  // Reaction channel is its own handle (different filter, different
  // table) — tear it down separately so we don't leak.
  if (thread.reactionSubscription) {
    try { supabase.removeChannel(thread.reactionSubscription); } catch {}
  }
  // Presence/typing channel (Codex review #283).
  if (thread.presenceChannel) {
    try { supabase.removeChannel(thread.presenceChannel); } catch {}
  }
  if (thread.typingTimer) clearTimeout(thread.typingTimer);
  if (thread.myTypingThrottle) clearTimeout(thread.myTypingThrottle);
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

// Single source of truth for the send-button icon swap. Called from:
//   • the textarea's input + paste listener (typing → flips to plane)
//   • _handleSend finally  (clears input → flips back to thumbs-up)
//   • _handleAttachImage + _handleAttachGifUrl finally (attach paths
//     don't touch input but we run sync defensively in case future
//     attach flows pre-fill a caption). Codex review 2026-05-16 P1-6.
function _syncSendIcon(convId) {
  const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`);
  if (!root) return;
  const input = root.querySelector('.dm-mini-input');
  const sendBtn = root.querySelector('.dm-mini-send');
  if (!input || !sendBtn) return;
  const empty = !(input.value || '').trim();
  sendBtn.classList.toggle('is-thumb', empty);
  sendBtn.setAttribute('title', empty ? 'Send 👍' : 'Send');
  sendBtn.setAttribute('aria-label', empty ? 'Send thumbs-up' : 'Send message');
}

async function _handleSend(convId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread || thread.sendInFlight) return;
  const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`);
  const input = root?.querySelector('.dm-mini-input');
  const sendBtn = root?.querySelector('.dm-mini-send');
  if (!input) return;
  // Thumbs-up quick send: empty composer + tap-send = ship a 👍 immediately.
  // Mirrors mobile + full-screen UX (the classic Messenger heart-but-thumbs
  // button). Same single-flight lock applies. Charles 2026-05-16 parity
  // pass — was task #238.
  let body = (input.value || '').trim();
  if (!body) body = '👍';

  thread.sendInFlight = true;
  if (sendBtn) sendBtn.disabled = true;
  input.disabled = true;

  // If user has a pending reply, attach reply_to_id + clear the chip
  // after we capture the id (the chip clears on the next render anyway,
  // but we want the optimistic bubble to render with the quote too).
  const replyToId = thread.replyTo?.id || null;
  if (replyToId) {
    thread.replyTo = null;
    _renderDockReplyChip(convId);
  }

  const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const optimistic = {
    id: tempId,
    conversation_id: convId,
    sender_id: _cfg.getCurrentUser()?.id,
    body,
    created_at: new Date().toISOString(),
    image_urls: [],
    reply_to_id: replyToId,
    _pending: true,
  };
  thread.messages.push(optimistic);
  _patchMessagesMarkup(thread);
  _scrollMiniToBottom(convId);
  input.value = '';
  input.style.height = 'auto';

  try {
    const sent = await sendMessageToConversation(convId, { body, replyToId });
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
    // Re-evaluate the icon — after clearing input on success the
    // empty-state thumbs-up should return. Single helper now lives
    // module-level (Codex review P1-6 cleanup).
    _syncSendIcon(convId);
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
    // Defensive — if a future flow ever pre-fills the input as part of
    // an attach (e.g. caption from filename), this ensures the icon
    // tracks the new state. Codex review P1-6.
    _syncSendIcon(convId);
  }
}

// Send a GIF (pre-uploaded Giphy URL) as a message. Mirrors
// _handleAttachImage's optimistic-bubble flow but skips the upload step
// because the URL is already CDN-hosted by Giphy. Charles 2026-05-16
// dock parity (#257).
async function _handleAttachGifUrl(convId, gifUrl) {
  if (!gifUrl) return;
  const thread = dmDockState.openThreads.get(convId);
  if (!thread || thread.sendInFlight) return;

  thread.sendInFlight = true;
  const tempId = `temp-gif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const optimistic = {
    id: tempId,
    conversation_id: convId,
    sender_id: _cfg.getCurrentUser()?.id,
    body: '',
    created_at: new Date().toISOString(),
    image_urls: [gifUrl],
    image_kind: 'gif',
    _pending: true,
  };
  thread.messages.push(optimistic);
  _patchMessagesMarkup(thread);
  _scrollMiniToBottom(convId);

  try {
    const sent = await sendMessageToConversation(convId, {
      imageUrl:  gifUrl,
      imageUrls: [gifUrl],
      imageKind: 'gif',
    });
    const idx = thread.messages.findIndex(m => m.id === tempId);
    if (idx >= 0) thread.messages[idx] = sent;
    _patchMessagesMarkup(thread);
    const c = _convCache.find(x => x.id === convId);
    if (c) {
      c.last_message_at = sent.created_at;
      c.last_message_preview = '🎬 GIF';
      c.last_message_sender = sent.sender_id;
    }
  } catch (err) {
    thread.messages = thread.messages.filter(m => m.id !== tempId);
    _patchMessagesMarkup(thread);
    toast(err?.message || 'GIF send failed', 'error');
  } finally {
    thread.sendInFlight = false;
    _syncSendIcon(convId);   // mirrors _handleAttachImage (P1-6)
  }
}

// ── Load older + Presence/Typing/Seen helpers ────────────────────────────

// Prepend one page of older messages above the current oldest. Preserves
// scroll position so the user doesn't lose their reading spot. Codex
// review 2026-05-16 (#282).
async function _handleLoadOlder(convId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread || thread.loadingOlder || !thread.hasOlder) return;
  thread.loadingOlder = true;
  _patchMessagesMarkup(thread);

  const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`);
  const list = root?.querySelector('.dm-mini-messages');
  const prevScrollHeight = list?.scrollHeight || 0;
  const prevScrollTop    = list?.scrollTop    || 0;

  const oldest = thread.messages[0];
  if (!oldest?.created_at) {
    thread.loadingOlder = false;
    thread.hasOlder = false;
    _patchMessagesMarkup(thread);
    return;
  }
  const PAGE = 30;
  try {
    const { data: msgs, error } = await supabase
      .from('messages')
      .select('id, conversation_id, sender_id, body, created_at, read_at, edited_at, deleted_at, reply_to_id, image_url, image_urls, image_kind')
      .eq('conversation_id', convId)
      .lt('created_at', oldest.created_at)
      .order('created_at', { ascending: false })
      .limit(PAGE);
    if (error) {
      console.warn('[dock] load older failed:', error.message);
      thread.loadingOlder = false;
      _patchMessagesMarkup(thread);
      return;
    }
    const older = (msgs || []).slice().reverse().map((m) => {
      if (Array.isArray(m.image_urls) && m.image_urls.length > 0) return m;
      if (m.image_url) return { ...m, image_urls: [m.image_url] };
      return { ...m, image_urls: [] };
    });
    // Fetch reactions for the older batch + merge into thread.reactions.
    // Codex P0-1: use _mergeReactionMaps so we don't drop entries for
    // older messages that already had reactions added in this session
    // (rare but possible if a member long-pressed an older message).
    if (older.length) {
      const olderReacts = await loadReactionsForMessageIds(older.map(m => m.id));
      thread.reactions = _mergeReactionMaps(thread.reactions, olderReacts);
    }
    // Prepend; mark hasOlder false if the page wasn't full (we hit
    // the start of the conversation).
    thread.messages = [...older, ...thread.messages];
    thread.hasOlder = older.length === PAGE;
  } catch (e) {
    console.warn('[dock] load older threw:', e?.message);
  } finally {
    thread.loadingOlder = false;
    _patchMessagesMarkup(thread, { preserveScroll: false });
    // Restore scroll position so the page grows UPWARD without
    // pushing the user's view. scrollHeight delta gives us the offset.
    requestAnimationFrame(() => {
      if (list) {
        const delta = (list.scrollHeight || 0) - prevScrollHeight;
        list.scrollTop = prevScrollTop + delta;
      }
    });
  }
}

// Subscribe to per-conv presence + typing broadcasts. Mirrors full-page
// subscribeToPresenceAndTyping. Codex review (#283).
function _subscribeDockPresence(convId) {
  const user = _cfg.getCurrentUser();
  if (!user?.id) return null;
  const channel = supabase.channel(`dock-presence-${convId}-${Math.random().toString(36).slice(2, 6)}`, {
    config: { presence: { key: user.id } },
  });
  channel
    .on('broadcast', { event: 'typing' }, (payload) => {
      const fromId = payload.payload?.userId;
      if (!fromId || fromId === user.id) return;
      const thread = dmDockState.openThreads.get(convId);
      if (!thread) return;
      thread.otherIsTyping = true;
      if (thread.typingTimer) clearTimeout(thread.typingTimer);
      thread.typingTimer = setTimeout(() => {
        thread.otherIsTyping = false;
        _patchMessagesMarkup(thread);
        _scrollMiniToBottom(convId);
      }, 3500);
      _patchMessagesMarkup(thread);
      _scrollMiniToBottom(convId);
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ userId: user.id, online_at: new Date().toISOString() });
      }
    });
  return channel;
}

// Throttled typing broadcast — fires at most once per 1.5s while user
// is typing. Mirrors full-page broadcastTyping pattern. Codex review
// (#283).
function _broadcastDockTyping(convId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread?.presenceChannel) return;
  if (thread.myTypingThrottle) return;
  thread.presenceChannel.send({
    type: 'broadcast',
    event: 'typing',
    payload: { userId: _cfg.getCurrentUser()?.id },
  });
  thread.myTypingThrottle = setTimeout(() => {
    thread.myTypingThrottle = null;
  }, 1500);
}

// ── Reply / Copy / Edit / Delete actions ────────────────────────────────
// Dock parity with the full-page hover menu. Each helper mutates per-thread
// state then re-renders. Server writes go through the same supabase tables
// the full page uses, so a reply / edit / delete from the dock and the same
// action from the full page produce identical rows and realtime echoes.
// Charles 2026-05-16 (#268).

function _startDockReply(convId, messageId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  const target = thread.messages.find(m => m.id === messageId);
  if (!target) return;
  thread.replyTo = target;
  // Render the reply chip above the composer + focus input.
  _renderDockReplyChip(convId);
  _focusMiniInput(convId);
}

function _cancelDockReply(convId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  thread.replyTo = null;
  _renderDockReplyChip(convId);
}

function _renderDockReplyChip(convId) {
  const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`);
  if (!root) return;
  const composer = root.querySelector('.dm-mini-composer');
  if (!composer) return;
  // Remove any existing chip first (idempotent). 2026-05-17 fix: the
  // chip is inserted as a sibling BEFORE the composer (see
  // insertBefore below), not inside it — so the previous
  // composer.querySelector lookup never found anything and the chip
  // stuck around after sending. Scope the removal to the chat root
  // (or the composer's parent — equivalent) so we actually find it.
  root.querySelectorAll('.dm-mini-reply-chip').forEach(el => el.remove());
  const thread = dmDockState.openThreads.get(convId);
  if (!thread?.replyTo) return;
  const r = thread.replyTo;
  const myId = _cfg.getCurrentUser()?.id;
  const rMine = r.sender_id === myId;
  // Group chats: look up the original sender from thread.members so the
  // chip shows the right name. For 1:1 falls back to conv._otherUser.
  // Codex review 2026-05-16 (#277) — earlier impl always used
  // _otherUser, which is null in groups → chip read "Replying to them".
  let replyName = 'them';
  if (rMine) {
    replyName = 'yourself';
  } else if (thread.conv.is_group) {
    const member = thread.members?.get(r.sender_id);
    replyName = member?.display_name?.split(' ')[0] || member?.username || 'them';
  } else {
    replyName = thread.conv._otherUser?.display_name?.split(' ')[0] || thread.conv._otherUser?.username || 'them';
  }
  const name = replyName;
  const preview = r.deleted_at ? '(unsent message)' : (r.body || '').slice(0, 60) || (r.image_urls?.length ? '📷 Photo' : '');
  const chip = document.createElement('div');
  chip.className = 'dm-mini-reply-chip';
  chip.innerHTML = `
    <span class="dm-mini-reply-chip-meta">
      <span class="dm-mini-reply-chip-name">Replying to ${escHTML(name)}</span>
      <span class="dm-mini-reply-chip-body">${escHTML(preview)}</span>
    </span>
    <button type="button" class="dm-mini-reply-chip-close" aria-label="Cancel reply" title="Cancel">×</button>
  `;
  chip.querySelector('.dm-mini-reply-chip-close').addEventListener('click', () => _cancelDockReply(convId));
  composer.parentNode.insertBefore(chip, composer);
}

async function _copyDockMessage(convId, messageId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  const m = thread.messages.find(x => x.id === messageId);
  if (!m) return;
  try {
    await navigator.clipboard.writeText(m.body || '');
    toast('Copied', 'success');
  } catch {
    toast('Copy failed', 'error');
  }
}

function _startDockEdit(convId, messageId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  const m = thread.messages.find(x => x.id === messageId);
  if (!m || m.sender_id !== _cfg.getCurrentUser()?.id) return;
  thread.editingMessageId = messageId;
  _patchMessagesMarkup(thread);
  // Focus the textarea + place caret at end so users can append immediately.
  setTimeout(() => {
    const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`);
    const ta = root?.querySelector(`.dm-mini-row[data-msg-id="${CSS.escape(messageId)}"] .dm-mini-edit-textarea`);
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, 0);
}

function _cancelDockEdit(convId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  thread.editingMessageId = null;
  _patchMessagesMarkup(thread);
}

async function _saveDockEdit(convId, messageId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`);
  const ta = root?.querySelector(`.dm-mini-row[data-msg-id="${CSS.escape(messageId)}"] .dm-mini-edit-textarea`);
  if (!ta) return;
  const trimmed = (ta.value || '').trim();
  const m = thread.messages.find(x => x.id === messageId);
  if (!m) return;
  if (!trimmed) { toast('Message can\'t be empty', 'error'); return; }
  if (trimmed === m.body) {
    thread.editingMessageId = null;
    _patchMessagesMarkup(thread);
    return;
  }
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from('messages')
    .update({ body: trimmed, edited_at: nowIso })
    .eq('id', messageId)
    .eq('sender_id', _cfg.getCurrentUser().id);
  if (error) { toast(error.message || 'Edit failed', 'error'); return; }
  // Local patch — realtime UPDATE will also fire for both sides.
  const idx = thread.messages.findIndex(x => x.id === messageId);
  if (idx >= 0) thread.messages[idx] = { ...thread.messages[idx], body: trimmed, edited_at: nowIso };
  thread.editingMessageId = null;
  _patchMessagesMarkup(thread);
}

async function _deleteDockMessage(convId, messageId) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  const m = thread.messages.find(x => x.id === messageId);
  if (!m || m.sender_id !== _cfg.getCurrentUser()?.id) return;
  const ok = await _cfg.confirmDialog({
    title: 'Delete message?',
    body: 'This message will be replaced with "Message deleted" for both of you. Can\'t be undone.',
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  const nowIso = new Date().toISOString();
  // Match mobile + full-page: set deleted_at AND clear body so any
  // client picking the row up sees a consistent "unsent" shape (the
  // image_urls column is intentionally left untouched; the dock's
  // _renderMessagesMarkup deleted_at branch hides images).
  const { error } = await supabase.from('messages')
    .update({ deleted_at: nowIso, body: '' })
    .eq('id', messageId)
    .eq('sender_id', _cfg.getCurrentUser().id);
  if (error) { toast(error.message || 'Delete failed', 'error'); return; }
  // Local patch — realtime UPDATE will also fire for the other side.
  const idx = thread.messages.findIndex(x => x.id === messageId);
  if (idx >= 0) {
    thread.messages[idx] = { ...thread.messages[idx], deleted_at: nowIso, body: '' };
    _patchMessagesMarkup(thread);
  }
}

function _jumpToDockMessage(convId, messageId) {
  const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(convId)}"]`);
  const target = root?.querySelector(`.dm-mini-row[data-msg-id="${CSS.escape(messageId)}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Brief highlight pulse so the user sees where they landed.
  target.classList.add('is-jump-highlight');
  setTimeout(() => target.classList.remove('is-jump-highlight'), 1200);
}

// ── Bubble action popover (tap-to-open) ────────────────────────────────
// Charles 2026-05-16 (#291). Replaces the hover-revealed action strip
// that used absolute positioning above every bubble. Now: tap a bubble
// → small floating popover appears anchored to it with React / Reply /
// Copy / Edit (mine only) / Delete (mine only). Same-bubble re-tap
// dismisses. Tap-outside / Esc dismisses. Action runs + closes.

function _closeDockActionPopover() {
  if (_dockActionPopoverEl) {
    try { _dockActionPopoverEl.remove(); } catch {}
    _dockActionPopoverEl = null;
  }
  _dockActionPopoverAnchorId = null;
  // Codex P2-2: remove the deferred document listeners now so they
  // don't outlive the popover. (Previously they self-unhooked on the
  // next event, which could fire orphaned after dock teardown.)
  if (_dockActionPopoverDocHandler) {
    document.removeEventListener('click', _dockActionPopoverDocHandler);
    _dockActionPopoverDocHandler = null;
  }
  if (_dockActionPopoverKeyHandler) {
    document.removeEventListener('keydown', _dockActionPopoverKeyHandler);
    _dockActionPopoverKeyHandler = null;
  }
}

function _openDockActionPopover(convId, messageId, anchorEl) {
  if (!convId || !messageId || !anchorEl) return;
  // Toggle: re-tapping the same bubble closes the popover.
  if (_dockActionPopoverEl && _dockActionPopoverAnchorId === messageId) {
    _closeDockActionPopover();
    return;
  }
  _closeDockActionPopover();

  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  const m = thread.messages.find(x => x.id === messageId);
  if (!m || m.deleted_at || m._pending) return;

  const myId = _cfg.getCurrentUser()?.id;
  const mine = m.sender_id === myId;
  // Capability gates mirror the prior in-line action menu (#268 +
  // Codex #278 — image-only own messages stay deletable).
  const hasText = (m.body || '').length > 0;
  const hasImg  = Array.isArray(m.image_urls) && m.image_urls.length > 0;
  const canEdit = mine && hasText && !hasImg;
  const canCopy = hasText;
  const canDelete = mine;

  const pop = document.createElement('div');
  pop.className = 'dm-mini-action-popover';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Message actions');
  pop.innerHTML = `
    <button type="button" class="dm-mini-pop-act" data-act="react" aria-label="React" title="React">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
    </button>
    <button type="button" class="dm-mini-pop-act" data-act="reply" aria-label="Reply" title="Reply">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
    </button>
    ${canCopy ? `
    <button type="button" class="dm-mini-pop-act" data-act="copy" aria-label="Copy text" title="Copy">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>` : ''}
    ${canEdit ? `
    <button type="button" class="dm-mini-pop-act" data-act="edit" aria-label="Edit" title="Edit">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
    </button>` : ''}
    ${canDelete ? `
    <button type="button" class="dm-mini-pop-act dm-mini-pop-act-danger" data-act="delete" aria-label="Delete" title="Delete">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>` : ''}
  `;
  // Stage off-screen so we can measure before final placement (same
  // pattern as the reaction picker).
  pop.style.position = 'fixed';
  pop.style.visibility = 'hidden';
  pop.style.top = '0px';
  pop.style.left = '0px';
  document.body.appendChild(pop);

  const r = anchorEl.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  // Place above the bubble by default. If there's no room above,
  // flip below. THEN clamp against the viewport bottom too — earlier
  // impl only clamped the top edge, so a bubble near the bottom of a
  // tall mini chat would push the popover past window.innerHeight.
  // Codex P1-2.
  const viewportBottom = window.innerHeight - 8;
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  if (top + h > viewportBottom) top = Math.max(8, viewportBottom - h);
  // Horizontal: align to the side of the bubble. Mine → right edge,
  // theirs → left edge. Clamp inside viewport.
  let left;
  if (mine) {
    left = r.right - w;
  } else {
    left = r.left;
  }
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (left < 8) left = 8;
  pop.style.top  = `${top}px`;
  pop.style.left = `${left}px`;
  pop.style.visibility = 'visible';
  _dockActionPopoverEl       = pop;
  _dockActionPopoverAnchorId = messageId;

  // Wire each action.
  pop.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const act = btn.dataset.act;
      // Close popover first so the action's optimistic re-render
      // doesn't see a stale popover floating over the new DOM.
      _closeDockActionPopover();
      if (act === 'react') {
        // Chain into the reaction picker — anchored to the bubble too.
        _openDockReactionPicker(convId, messageId, anchorEl);
      } else if (act === 'reply')  _startDockReply(convId, messageId);
      else if (act === 'copy')     _copyDockMessage(convId, messageId);
      else if (act === 'edit')     _startDockEdit(convId, messageId);
      else if (act === 'delete')   _deleteDockMessage(convId, messageId);
    };
  });

  // Outside-click + Escape dismiss. Deferred one tick so the click
  // that opened the popover doesn't immediately close it. Listener
  // refs are stored on module-level handles so _closeDockActionPopover
  // can remove them explicitly — earlier impl relied on the listeners
  // self-unhooking on next event, leaving them orphaned after
  // teardown. Codex P2-2.
  setTimeout(() => {
    _dockActionPopoverDocHandler = (ev) => {
      if (!_dockActionPopoverEl) {
        // Defensive — close should have cleaned up. Remove just in case.
        document.removeEventListener('click', _dockActionPopoverDocHandler);
        _dockActionPopoverDocHandler = null;
        return;
      }
      if (!_dockActionPopoverEl.contains(ev.target)) {
        _closeDockActionPopover();
      }
    };
    _dockActionPopoverKeyHandler = (ev) => {
      if (ev.key === 'Escape' && _dockActionPopoverEl) {
        _closeDockActionPopover();
        anchorEl.focus?.();
      }
    };
    document.addEventListener('click', _dockActionPopoverDocHandler);
    document.addEventListener('keydown', _dockActionPopoverKeyHandler);
  }, 0);
}

// ── Reactions: picker + toggle + realtime ───────────────────────────────

function _closeDockReactionPicker() {
  if (_dockReactionPickerEl) {
    try { _dockReactionPickerEl.remove(); } catch {}
    _dockReactionPickerEl = null;
  }
  _dockReactionPickerAnchor = null;
}

// Open the quick-reactions strip anchored above the react-button (which
// sits next to the bubble). Mirrors the full-page openReactionPicker
// pattern — fixed-position above the trigger, dismissed by outside
// click. Clicking an emoji toggles the reaction immediately.
function _openDockReactionPicker(convId, messageId, anchorEl) {
  // Toggle off if the same anchor is clicked twice in a row. Without
  // this, re-clicking the React smiley after the picker opens just
  // re-runs open (close-then-open) and the picker visibly stays up,
  // which makes it look broken. Compare via dataset.msg since the
  // anchor element itself may have been re-rendered between clicks
  // (_patchMessagesMarkup wipes and rebuilds the action menu DOM).
  if (_dockReactionPickerEl && _dockReactionPickerAnchor?.dataset?.msg === anchorEl?.dataset?.msg) {
    _closeDockReactionPicker();
    return;
  }
  _closeDockReactionPicker();
  if (!messageId || !anchorEl) return;

  const picker = document.createElement('div');
  picker.className = 'dm-mini-rx-picker';
  picker.setAttribute('role', 'toolbar');
  picker.setAttribute('aria-label', 'Reactions');
  // Each pick button gets a real aria-label (the emoji itself isn't
  // useful for screen-readers) + tabindex so the picker is keyboard-
  // operable. Codex review P2-269.
  const emojiNames = {
    '❤️': 'Heart',
    '😂': 'Laugh',
    '😢': 'Sad',
    '😡': 'Angry',
    '👍': 'Thumbs up',
    '🔥': 'Fire',
  };
  picker.innerHTML = DOCK_QUICK_REACTIONS.map((em, i) => {
    const name = emojiNames[em] || `Reaction ${i + 1}`;
    return `<button type="button" class="dm-mini-rx-pick" data-emoji="${escHTML(em)}" aria-label="${escHTML(name)}" title="${escHTML(name)}" tabindex="0">${em}</button>`;
  }).join('');
  // Stage off-screen so we can measure the rendered width before final
  // placement. The earlier version used a hardcoded PICK_W=240 estimate
  // but the actual inline-flex picker measures ~80-100px, so the strip
  // landed ~140px too far left and the right-edge clamp branch was
  // unreachable. Codex review 2026-05-16 P1-1 fix.
  picker.style.position = 'fixed';
  picker.style.visibility = 'hidden';
  picker.style.top = '0px';
  picker.style.left = '0px';
  document.body.appendChild(picker);

  const r = anchorEl.getBoundingClientRect();
  // Measure now that the picker is in the DOM. offsetWidth includes
  // padding + border (matches what the browser will actually paint).
  const pickW = picker.offsetWidth;
  const pickH = picker.offsetHeight;

  // Vertical: 8px above the trigger, never above the viewport top.
  picker.style.top = `${Math.max(8, r.top - pickH - 8)}px`;
  // Horizontal: center on the trigger, clamp inside the viewport.
  let left = r.left + r.width / 2 - pickW / 2;
  if (left + pickW > window.innerWidth - 8) left = window.innerWidth - pickW - 8;
  if (left < 8) left = 8;
  picker.style.left = `${left}px`;
  picker.style.visibility = 'visible';
  _dockReactionPickerEl     = picker;
  _dockReactionPickerAnchor = anchorEl;

  const pickBtns = [...picker.querySelectorAll('[data-emoji]')];
  pickBtns.forEach((btn, idx) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      // Close FIRST so the picker disappears before the optimistic
      // _patchMessagesMarkup re-render inside _toggleDockReaction
      // fires. Charles 2026-05-16 bug fix — keeps the strip from
      // visually outliving the click.
      _closeDockReactionPicker();
      _toggleDockReaction(convId, messageId, btn.dataset.emoji);
      // Skip the focus-return — anchorEl was wiped by the re-render
      // and focusing a detached node does nothing useful.
    };
    // Arrow keys move focus within the strip; Escape closes; Enter/
    // Space activate (default browser button behavior already handles
    // those). Codex review P2-269.
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        pickBtns[(idx + 1) % pickBtns.length].focus();
      } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        pickBtns[(idx - 1 + pickBtns.length) % pickBtns.length].focus();
      } else if (ev.key === 'Home') {
        ev.preventDefault();
        pickBtns[0].focus();
      } else if (ev.key === 'End') {
        ev.preventDefault();
        pickBtns[pickBtns.length - 1].focus();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        _closeDockReactionPicker();
        anchorEl.focus?.();
      }
    });
  });
  // Auto-focus the first reaction so keyboard users can immediately
  // arrow + Enter without hunting for the strip.
  pickBtns[0]?.focus();

  // Outside-click dismiss. Deferred so the click that opened us doesn't
  // immediately close it. Cleans itself up on close OR when the picker
  // is replaced by another open. Esc on document is also wired so
  // dismissal works even if focus has moved outside the picker.
  setTimeout(() => {
    const onDoc = (ev) => {
      if (!_dockReactionPickerEl) {
        document.removeEventListener('click', onDoc);
        document.removeEventListener('keydown', onKey);
        return;
      }
      if (!_dockReactionPickerEl.contains(ev.target)) {
        _closeDockReactionPicker();
        document.removeEventListener('click', onDoc);
        document.removeEventListener('keydown', onKey);
      }
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape' && _dockReactionPickerEl) {
        _closeDockReactionPicker();
        document.removeEventListener('click', onDoc);
        document.removeEventListener('keydown', onKey);
        anchorEl.focus?.();
      }
    };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
  }, 0);
}

// Optimistic toggle — patches the thread's reactions map immediately,
// kicks the server call, rolls back on failure. Identical model to the
// full-page toggleReaction in messages.js (the dock can't share that
// function directly because it writes to dmState.reactions, but the
// shape is the same).
//
// Rollback strategy: INVERSE-OP on the current array, NOT wholesale
// restore of a pre-mutation snapshot. The earlier implementation
// snapshotted `list` and restored it on failure, which would have
// overwritten any reaction inserts that arrived from other users via
// the realtime channel during the await. Codex review 2026-05-16
// P1-2 fix.
async function _toggleDockReaction(convId, messageId, emoji) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  const myId = _cfg.getCurrentUser()?.id;
  if (!myId) return;

  if (!thread.reactions) thread.reactions = {};
  const list = thread.reactions[messageId] || [];
  const had  = list.some(r => r.user_id === myId && r.emoji === emoji);

  // Optimistic.
  if (had) {
    thread.reactions[messageId] = list.filter(r => !(r.user_id === myId && r.emoji === emoji));
  } else {
    thread.reactions[messageId] = [...list, { message_id: messageId, user_id: myId, emoji }];
  }
  _patchMessagesMarkup(thread);

  const result = await toggleMessageReaction(messageId, emoji);
  if (result === null) {
    // Rollback — undo just OUR optimistic mutation against whatever
    // the array looks like NOW. If we optimistically added, remove
    // (myId, emoji). If we optimistically removed, push it back.
    // This preserves any other-user reactions that landed via the
    // realtime channel during the await.
    const current = thread.reactions[messageId] || [];
    if (had) {
      // We tried to remove → put our entry back IF it's not already there
      // (defensive: realtime echo of our own delete cancellation might
      // still arrive before this rollback).
      if (!current.some(r => r.user_id === myId && r.emoji === emoji)) {
        thread.reactions[messageId] = [...current, { message_id: messageId, user_id: myId, emoji }];
      }
    } else {
      // We tried to add → strip our entry. Leaves everyone else's
      // reactions (including any that arrived during the await) intact.
      thread.reactions[messageId] = current.filter(r => !(r.user_id === myId && r.emoji === emoji));
    }
    _patchMessagesMarkup(thread);
  }
}

// Subscribe to message_reactions INSERT/DELETE for any message belonging
// to THIS thread. We can't filter by conversation_id in the postgres
// filter (reactions table has no conv FK), so we accept all events for
// the user's reachable rows (RLS-scoped) and reject in-handler when the
// message isn't in our open thread.
function _subscribeReactionsForThread(convId) {
  return supabase
    .channel(`dock-rx-${convId}-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions' }, (payload) => {
      _handleReactionInsert(convId, payload.new);
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_reactions' }, (payload) => {
      _handleReactionDelete(convId, payload.old);
    })
    .subscribe();
}

function _handleReactionInsert(convId, row) {
  if (!row?.message_id) return;
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  // Only care about reactions on messages we know about.
  if (!thread.messages.some(m => m.id === row.message_id)) return;
  if (!thread.reactions) thread.reactions = {};
  const list = thread.reactions[row.message_id] || [];
  // Dedupe — our own optimistic add already inserted this same key.
  if (list.some(r => r.user_id === row.user_id && r.emoji === row.emoji)) return;
  thread.reactions[row.message_id] = [...list, row];
  _patchMessagesMarkup(thread);
}

function _handleReactionDelete(convId, row) {
  if (!row?.message_id) return;
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  if (!thread.reactions?.[row.message_id]) return;
  const next = thread.reactions[row.message_id].filter(r =>
    !(r.user_id === row.user_id && r.emoji === row.emoji)
  );
  thread.reactions[row.message_id] = next;
  _patchMessagesMarkup(thread);
}

function _handleIncomingMessage(convId, msg) {
  const thread = dmDockState.openThreads.get(convId);
  if (thread) {
    // Dedupe — realtime echo for messages we just sent (their temp
    // already got swapped above).
    if (thread.messages.some(m => m.id === msg.id)) return;
    thread.messages.push(msg);
    // Group-seen map needs a recompute when a new message arrives —
    // the latest-message anchor may have shifted. Cheap (O(messages
    // × members)) per ping.
    if (thread.conv.is_group) {
      thread.groupSeenByMsg = _computeGroupSeenByMsg(thread);
    }
    // For group chats: if the sender isn't in our members cache
    // (e.g., added after we opened the chat), refresh members in the
    // background so subsequent renders resolve the avatar/name. Render
    // immediately with a placeholder so the message lands without lag.
    // Guard with an in-flight promise so two parallel unknown-sender
    // inserts don't fire two refetches that race on assignment.
    // Codex P2-3 (2026-05-16).
    if (thread.conv.is_group && msg.sender_id && !thread.members?.has(msg.sender_id) && !thread.membersRefreshPromise) {
      thread.membersRefreshPromise = loadGroupMembers(convId)
        .then((members) => {
          // Only apply if the thread is still open (user may have
          // closed it during the fetch).
          if (dmDockState.openThreads.get(convId) === thread) {
            thread.members = members;
            _patchMessagesMarkup(thread);
          }
        })
        .catch(() => {})
        .finally(() => {
          thread.membersRefreshPromise = null;
        });
    }
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
    // For 1:1 the inline-seen lookup re-runs on every render so we get
    // the latest read_at automatically. For groups we additionally
    // need a fresh map (members' last_read_at may have advanced
    // because the same realtime UPDATE that bumped read_at on the
    // message also implies they're caught up). Recompute defensively.
    if (thread.conv.is_group) {
      thread.groupSeenByMsg = _computeGroupSeenByMsg(thread);
    }
    _patchMessagesMarkup(thread);
  }
}

function _handleMessageDelete(convId, msg) {
  const thread = dmDockState.openThreads.get(convId);
  if (!thread) return;
  thread.messages = thread.messages.filter(m => m.id !== msg.id);
  // Free the reactions map slot for the deleted message — otherwise
  // long-lived dock chats with heavy message churn (active group
  // chats deleting + reposting) leak orphan reaction lists keyed by
  // ids no longer in `messages`. Codex review 2026-05-16 P1-5.
  if (thread.reactions) delete thread.reactions[msg.id];
  _patchMessagesMarkup(thread);
}

function _patchMessagesMarkup(thread, opts = {}) {
  const root = _miniContainerEl?.querySelector(`.dm-mini-chat[data-conv-id="${CSS.escape(thread.conv.id)}"]`);
  const list = root?.querySelector('.dm-mini-messages');
  if (!list) return;
  const preserveScroll = opts.preserveScroll !== false;
  const prevScrollHeight = list.scrollHeight || 0;
  const prevScrollTop = list.scrollTop || 0;
  const wasNearBottom = preserveScroll
    && (prevScrollHeight - prevScrollTop - list.clientHeight < 80);

  list.innerHTML = _renderMessagesMarkup(thread);

  if (!preserveScroll) return;
  if (wasNearBottom) {
    list.scrollTop = list.scrollHeight;
  } else if (prevScrollHeight > 0) {
    list.scrollTop = prevScrollTop + ((list.scrollHeight || 0) - prevScrollHeight);
  }
}

// ── Inbox-level unread badge ─────────────────────────────────────────────

async function _loadAndRefreshUnread() {
  try {
    _convCache = await loadConversationList();
  } catch (e) {
    console.warn('[dock] conv list load failed:', e?.message);
  }
  _refreshUnreadBadge();
  // If inbox is open, patch the list in place INSTEAD of nuking the
  // entire panel. Earlier impl called _renderInbox() which detached
  // and recreated the section, yanking the user's scroll back to top
  // on every realtime ping — a jarring papercut, especially when the
  // user is scrolling through older convs. Now we keep the panel
  // (and its scrollTop) and only re-render the list contents +
  // rebind their click handlers. Codex review 2026-05-16 P2-272 fix.
  if (dmDockState.inboxOpen && _inboxEl) {
    const listEl = _inboxEl.querySelector('.dm-dock-inbox-list');
    if (listEl) {
      const prevScroll = listEl.scrollTop;
      listEl.innerHTML = _renderConvListMarkup();
      // Re-bind click handlers (lost when innerHTML wipes the old DOM).
      listEl.querySelectorAll('.dm-dock-conv-item[data-conv-id]').forEach(item => {
        item.addEventListener('click', () => {
          const id = item.dataset.convId;
          closeMessagesDock();
          openMessagesDockToConv(id);
        });
      });
      // Restore scroll synchronously so the paint never shows the
      // top-of-list flash.
      listEl.scrollTop = prevScroll;
      // Update the badge inside the inbox header too (was previously
      // a side-effect of _renderInbox calling _refreshUnreadBadge).
      _refreshUnreadBadge();
    } else {
      // Defensive fallback — if the panel is malformed, fall back to
      // the old full-rerender path.
      _renderInbox();
    }
  }
}

// Clear local unread state for a conv WITHOUT waiting for the server
// round-trip. The earlier flow did `markConversationRead(...).then(()
// => _refreshUnreadBadge())` which zeroed the server row but left
// _convCache._unreadCount at its old value until the next inbox
// reload, so the badge appeared "stuck". Codex P1-4 2026-05-16.
function _markDockConvReadLocal(convId) {
  const c = _convCache.find(x => x.id === convId);
  if (c) c._unreadCount = 0;
  _refreshUnreadBadge();
  // Patch the inbox list in place if it's open so the badge drops
  // visibly the moment the user opens the chat.
  if (dmDockState.inboxOpen && _inboxEl) {
    const list = _inboxEl.querySelector('.dm-dock-inbox-list');
    if (list) {
      const prevScroll = list.scrollTop;
      list.innerHTML = _renderConvListMarkup();
      list.querySelectorAll('.dm-dock-conv-item[data-conv-id]').forEach(item => {
        item.addEventListener('click', () => {
          const id = item.dataset.convId;
          closeMessagesDock();
          openMessagesDockToConv(id);
        });
      });
      list.scrollTop = prevScroll;
    }
  }
}

function _refreshUnreadBadge() {
  // Sum real per-conv unread message counts. Earlier impl counted
  // CONVERSATIONS (not messages) and used a heuristic that flagged
  // any conv whose last message wasn't mine — both wrong. Now we sum
  // c._unreadCount (hydrated by loadUnreadCountsForConvIds), skipping
  // archived/muted/secret convs. Codex review 2026-05-16 (#280).
  const total = _convCache.reduce((sum, c) => {
    if (c._archived) return sum;
    if (c._mutedUntil && new Date(c._mutedUntil) > new Date()) return sum;
    if (c.is_secret) return sum;
    return sum + (c._unreadCount || 0);
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

// Debounced full reload of the conv list. Codex P2-1 (2026-05-16):
// the inbox UPDATE channel fires on EVERY change to any conv row the
// user touches — including mute/archive flag flips and our own
// markConversationRead writes. Each fire would otherwise run a full
// loadConversationList (100 convs + profile fetch + per-conv unread
// COUNT(*)). Trailing 600ms debounce coalesces bursts. Combined with
// the payload-level last_message_at check below, this drops typical
// load to <1 reload/sec even in a busy group chat.
let _refreshUnreadTimer = null;
function _scheduleRefreshUnread() {
  if (_refreshUnreadTimer) return;
  _refreshUnreadTimer = setTimeout(() => {
    _refreshUnreadTimer = null;
    _loadAndRefreshUnread();
  }, 600);
}

function _subscribeInboxBadge() {
  const user = _cfg.getCurrentUser();
  if (!user?.id) return;
  if (_inboxChannel) try { supabase.removeChannel(_inboxChannel); } catch {}
  // Pivoted from messages.INSERT (table-wide, no filter) to
  // conversations.UPDATE (RLS-narrowed to convs the user participates
  // in). The existing AFTER INSERT trigger on messages already bumps
  // conversations.last_message_at + .last_message_preview + sender —
  // so this catches the same signal with naturally narrower scope and
  // no per-conv re-subscribe machinery. Codex review 2026-05-16 P1-3
  // fix; supersedes the original table-wide listener that paid a
  // round-trip on every message insert anywhere in the DB.
  //
  // 2026-05-16 Codex P2-1: also filter out UPDATEs that don't change
  // last_message_at (mute/archive flips fire here too) and debounce
  // the reload so a burst of N messages = 1 round-trip not N.
  _inboxChannel = supabase
    .channel(`dock-inbox-${user.id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, (payload) => {
      const newRow = payload.new;
      const oldRow = payload.old;
      // Skip if last_message_at didn't change — this UPDATE was
      // triggered by mute/archive/etc., not by a new message.
      if (newRow?.last_message_at === oldRow?.last_message_at) return;
      _scheduleRefreshUnread();
    })
    .subscribe();
}
