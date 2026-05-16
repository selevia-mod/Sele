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

  // Shared emoji picker. Each mini-chat composer will pass its own input
  // element. Provided by app.js (kept there until Stage 9 extraction so
  // the existing #dmEmojiBtn flow keeps using the same code path).
  openScopedEmojiPicker: (_opts) => {},

  // Cross-module helpers Commit 2's dock will need.
  openProfile:           (_userId) => {},
  showMessages:          (_targetUserId) => {},   // hand-off to full page
  closeAllModals:        () => {},
};

export function initMessagesDock(config) {
  if (config) _cfg = { ..._cfg, ...config };
  // Commit 2: mount #dmFloatingRoot here, render launcher, wire sign-in/out.
}

// ─── Dock state — kept entirely separate from app.js dmState ─────────────
// dmState.activeConvId belongs to the FULL Messages page. The floating
// dock has its own per-conv records (Map keyed by convId) so opening a
// mini chat doesn't fight the full page over which conversation is active.
export const DM_FLOAT_MAX_THREADS = 2;

export const dmDockState = {
  inboxOpen: false,
  // convId → {
  //   conv,                // conversation row
  //   messages,            // local message array (separate from dmState.messages)
  //   minimized,           // true when collapsed into the bottom header strip
  //   sendInFlight,        // single-flight guard per mini chat
  //   subscription,        // teardown handle from subscribeToConversation
  //   focusedAt,           // ms timestamp for replace-oldest rule
  // }
  openThreads: new Map(),
  // Ordered list of convIds, most-recently-focused last. Used by the
  // replace-oldest rule when a 3rd chat opens.
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
// Public dock API — Commit 2 will fill these in. Stubs for now so
// app.js can wire its imports without errors.
// ════════════════════════════════════════════════════════════════════════

export function openMessagesDock() {
  dmDockState.inboxOpen = true;
  // Commit 2: render inbox panel
}

export function closeMessagesDock() {
  dmDockState.inboxOpen = false;
  // Commit 2: hide inbox panel, leave launcher visible
}

// Open a specific conversation in a mini chat. Used by profile "Message"
// buttons, notification taps, and the inbox list. Commit 2 implements
// the actual mini-chat render + the replace-oldest rule when there are
// already DM_FLOAT_MAX_THREADS chats open.
export async function openMessagesDockToConv(convId) {
  if (!convId) return;
  if (dmDockState.openThreads.has(convId)) {
    // Already open — just bump focus order.
    const idx = dmDockState.focusOrder.indexOf(convId);
    if (idx >= 0) dmDockState.focusOrder.splice(idx, 1);
    dmDockState.focusOrder.push(convId);
    // Commit 2: un-minimize + scroll into focus
    return;
  }
  // Commit 2: enforce DM_FLOAT_MAX_THREADS, load conv + messages,
  // subscribe to realtime, render the mini-chat shell.
  console.debug('[dock] openMessagesDockToConv stub — Commit 2 will render', convId);
}

// Teardown all dock state — called on sign-out. Safe to call repeatedly.
export function teardownMessagesDock() {
  for (const [, thread] of dmDockState.openThreads) {
    teardownConversationSubscription(thread.subscription);
  }
  dmDockState.openThreads.clear();
  dmDockState.focusOrder.length = 0;
  dmDockState.inboxOpen = false;
  // Commit 2: also unmount #dmFloatingRoot children
}
