// ════════════════════════════════════════════════════════════════════════
// Selebox Direct Messages — extracted from js/app.js as Stage 9 of the
// refactor roadmap. The full-page Messenger-style DM surface lives here
// (the floating dock in js/messages-dock.js already extracted the
// shared data layer that both surfaces call into).
//
// Stage 9A — Messages core (this file at first commit):
//   • Page entry + nav: showMessages, openConversation,
//     openConversationWithUser
//   • Conversation list: loadConversationList, renderConversationList,
//     renderConvEmptyStateHtml, renderConvItemHtml, fetchUnreadCounts,
//     isConvMutedForMe, renderGroupAvatarHtml, senderUsernameInGroup
//   • Thread render + send: loadMessages, renderMessages,
//     formatMessageDateStamp, formatStampLabel, sendDmMessage,
//     sendDmThumbsUp, updateSendButton, resizeDmInput,
//     scrollMessagesToBottom, isDmAtBottom, fetchReactionsForConversation
//   • Edit / delete / react / copy: toggleReaction, deleteMessage,
//     startEditMessage, saveEditMessage, openHoverMenu, closeHoverMenu,
//     openReactionPicker, closeReactionPicker, copyMessageText
//   • Realtime: subscribeToThread, subscribeToPresenceAndTyping,
//     updateThreadPresenceUI, broadcastTyping, subscribeToInbox
//   • Inbox badge: computeDmUnreadTotal, updateUnreadBadge,
//     bootstrapDmBadge
//   • State: dmState (~30 fields — conversations, activeConvId,
//     messages, reactions, channels, typing/presence, hover/reaction
//     pickers, editingMessageId, replyingTo, viewMode), _dmSendInFlight,
//     dmInputEl (lazy ref)
//
// Stage 9B — Messages extras (NOT in this commit, queued):
//   emoji picker, attach menu, GIF picker, secret-lock IIFE, reply
//   state, conv menu, group admin (add/kick), global search,
//   mention dropdown, openNewConvModal, DM link preview hydrator.
//
// NOT moved (stays in app.js by design):
//   • Floating dock (js/messages-dock.js) — already its own module.
//     Both surfaces share dock's data helpers.
//   • Notifications panel — its own module since Stage 1.
//   • Top-bar search input — app.js owns search context routing.
//
// CAREFUL: pure code movement. Inward references rewritten to _cfg.X
// via the Stage 9A jscodeshift codemod (scripts/extract-stage9a.js).
// Module-private state lives at the bottom of this file. No circular
// imports — we depend on supabase.js + the floating-dock data helpers
// + the config injection.
// ════════════════════════════════════════════════════════════════════════

import { supabase, toast, escHTML, initials, timeAgo } from './supabase.js';

// Shared data helpers — the floating dock already owns these (the
// dock was Phase 1 of the Messages decomposition). Importing here so
// the full-page DM flow uses the same code path as the dock for list
// fetch, conversation fetch, message fetch, send, mark-read, and
// realtime subscribe/unsubscribe. Single source of truth means a
// future bug fix touches one place not two.
import {
  loadConversationList as dockLoadConversationList,
  fetchConversationById,
  loadMessagesForConversation,
  sendMessageToConversation,
  markConversationRead,
  subscribeToConversation,
  teardownConversationSubscription,
} from './messages-dock.js';

// ─── Config-injection dependency surface ─────────────────────────────────
// App.js-owned helpers that messages code calls back into. Codemod
// rewrites bare `helperName(...)` calls inside extracted functions to
// `_cfg.helperName(...)`. Defaults are no-ops so the module loads cleanly
// even before initMessages() has been called from app.js.
let _cfg = {
  // Identity / session
  getCurrentUser:        () => null,
  getCurrentProfile:     () => null,

  // Navigation / page switching
  hideAllMainPages:      () => {},
  openProfile:           () => {},
  setSidebarActive:      () => {},
  stopVideoPlayer:       () => {},

  // Dialogs / prompts
  confirmDialog:         async () => false,
  closeAllModals:        () => {},
  uploadImage:           async () => null,

  // Formatters (shared with feed/videos/books)
  formatCompact:         (n) => String(n || 0),
  linkify:               (s) => s || '',

  // URL extraction helper — shared with the general feed renderLinkPreview
  // that stays in app.js. Used by renderDmLinkPreview (which moved here
  // in Stage 9B) to find URLs in message bodies. firstUrlInText is the
  // only helper the 9B extraction didn't migrate because it's still
  // called from app.js's general renderLinkPreview path.
  firstUrlInText:        () => null,

  // ─── Additional bridges caught in the Stage 9 Codex review ──────────
  // Both live in app.js and are called from inside Stage 9B-extracted
  // functions. The codemod's CONFIG_DEPS list missed them — `bare`
  // calls in messages.js would silently fail.
  //
  // openReportUserModal — opens the cross-feature "report a user" modal
  // from the conv-menu's "Report" action. Lives in app.js because it's
  // shared with profile/post/video report flows.
  //
  // renderLinkPreview — general feed link preview (YouTube embed +
  // generic favicon card). Called by sendDmMessage's optimistic
  // rendering when a non-internal URL appears in a message body.
  openReportUserModal:   () => {},
  renderLinkPreview:     () => '',

  // (Stage 9B-era bridges removed — emoji picker, attach menu, GIF picker,
  // secret lock IIFE, reply state, conv menu, group admin, mention
  // dropdown, and DM link preview all live in this module now. The 9A
  // code that used to call them through _cfg now calls them as siblings.
  // closeHoverMenu / closeReactionPicker / openHoverMenu /
  // openReactionPicker were ALREADY intra-module in 9A — those bridges
  // were dead defaults and have been dropped too.)
};

export function initMessages(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// Eager DOM ref — messagesPage element exists in index.html. Messages.js
// is loaded as an ES module via app.js's import graph, which executes
// after the HTML parser has built the body. App.js also keeps its own
// `const messagesPage` because hideAllMainPages reads it directly;
// duplicating the lookup here keeps each module self-contained.
const messagesPage = document.getElementById('messagesPage');

// ════════════════════════════════════════════════════════════════════════
// Extracted state + functions are appended below by the Stage 9A script.
// ════════════════════════════════════════════════════════════════════════


// ─── Module state ─────────────────────────────────────────────────
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
// Codex audit 2026-05-16: single-flight guard for DM sends. Without this,
// Enter pressed twice in quick succession (or Enter + click race) fired two
// sendDmMessage() calls — each one optimistically inserted, each one POSTed,
// each one came back via realtime. Some users were seeing duplicate
// messages. Lift the guard outside the function so both text and attachment
// paths share it.
let _dmSendInFlight = false;
// IDs of messages already painted to the DOM. Used in renderMessages to skip
// the entrance animation on bubbles that already existed — prevents the whole
// list from flashing every time we re-render (sends, reactions, read receipts).
const _renderedMessageIds = new Set();
// ── Conversation list ─────────────────────────────────────────────────────
const DM_EMPTY_HTML = `
  <div class="dm-empty-list" id="dmEmptyList">
    <div class="dm-empty-icon">💬</div>
    <h3>No conversations yet</h3>
    <p>Start one from anyone's profile.</p>
  </div>
`;
// Quick-reaction emojis (FB-style — these match the existing post REACTIONS set)
const DM_QUICK_REACTIONS = ['❤️','😂','😮','😢','😡','👍'];
// Inbox-wide subscription so the unread badge updates even when DMs page is closed
// Per-conversation cache of { user_a, user_b, is_secret } — the inbox
// subscription would otherwise SELECT the same row on every message,
// burning a round-trip per inbound message. The fields cached here
// don't change for a conversation's lifetime.
const __convInboxCache = new Map();

// ─── Extracted functions ──────────────────────────────────────────

async function showMessages(targetUserId = null) {
  if (!_cfg.getCurrentUser()) { toast('Please sign in', 'error'); return; }
  _cfg.hideAllMainPages();
  if (messagesPage) messagesPage.style.display = 'block';
  document.body.classList.remove('on-videos');
  history.pushState(null, '', '#messages');
  _cfg.setSidebarActive('btnMessages');

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

async function openConversation(convId) {
  if (!convId || !_cfg.getCurrentUser()) return;
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
        name: data.name || members.filter(m => m.id !== _cfg.getCurrentUser().id).slice(0,3).map(m => m.username).join(', '),
        members, memberCount: members.length, avatarUrl: data.avatar_url,
        lastMessageAt: data.last_message_at, lastMessagePreview: data.last_message_preview || '',
        unread: 0, muted: false, raw: data,
      };
    } else {
      const otherId = data.user_a === _cfg.getCurrentUser().id ? data.user_b : data.user_a;
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
    av.onclick = () => _cfg.openProfile(u.id);
    nameBtn.textContent = (conv.isSecret ? '🔒 ' : '') + (u.username || 'Unknown');
    nameBtn.onclick = () => _cfg.openProfile(u.id);
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
    updateUnreadBadge(computeDmUnreadTotal());
  };
  _zeroUnread();
  supabase.rpc('mark_conversation_read', { p_conversation_id: convId })
    .then(_zeroUnread)
    .catch(() => {});  // Already cleared optimistically; ignore RPC errors

  // Subscribe to realtime updates for this conversation
  subscribeToThread(convId);
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

async function loadConversationList() {
  const wrap = document.getElementById('dmConvList');
  if (!wrap || !_cfg.getCurrentUser()) return;

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
      .eq('user_id', _cfg.getCurrentUser().id),
    supabase
      .from('conversations')
      .select('id')
      .eq('is_group', false)
      .or(`user_a.eq.${_cfg.getCurrentUser().id},user_b.eq.${_cfg.getCurrentUser().id}`),
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
      const otherId = c.user_a === _cfg.getCurrentUser().id ? c.user_b : c.user_a;
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
      : ((c.user_a === _cfg.getCurrentUser().id && c.archived_by_a) ||
         (c.user_b === _cfg.getCurrentUser().id && c.archived_by_b));
    const isSecret = !!c.is_secret;
    if (!isMutedNow && !archivedByMe && !isSecret) totalUnread += unread;

    if (c.is_group) {
      const memberIds = (groupMembersByConv[c.id] || []).filter(id => id !== _cfg.getCurrentUser().id);
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
    const otherId = c.user_a === _cfg.getCurrentUser().id ? c.user_b : c.user_a;
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
  if (mode === 'secret' && !SECRET_LOCK.isUnlocked()) {
    // Codex P1 fix — SECRET_LOCK exposes isUnlocked/isPinSet/setPin/etc.
    // but NOT renderGateHtml (that's a separate top-level function in
    // this module). My initMessages-era arrow wrapper hid the bug.
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
  const isMine = c.lastMessageSender === _cfg.getCurrentUser().id;
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

async function fetchUnreadCounts(conversationIds) {
  if (!conversationIds.length) return {};
  // Pull only unread messages where I'm NOT the sender, group client-side
  const { data } = await supabase
    .from('messages')
    .select('conversation_id, sender_id')
    .in('conversation_id', conversationIds)
    .is('read_at', null)
    .is('deleted_at', null)
    .neq('sender_id', _cfg.getCurrentUser().id);
  const counts = {};
  (data || []).forEach(m => {
    counts[m.conversation_id] = (counts[m.conversation_id] || 0) + 1;
  });
  return counts;
}

// Returns true if the conversation is currently muted for the current user
function isConvMutedForMe(c) {
  if (!c) return false;
  const my = _cfg.getCurrentUser()?.id;
  let until;
  if (c.is_group) return false; // group mute TBD
  if (c.user_a === my)      until = c.muted_until_a;
  else if (c.user_b === my) until = c.muted_until_b;
  if (!until) return false;
  return new Date(until).getTime() > Date.now();
}

// Stacked avatars for group conversations (list = small, header = large)
function renderGroupAvatarHtml(members, variant = 'list') {
  const others = (members || []).filter(m => m.id !== _cfg.getCurrentUser().id).slice(0, 2);
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

function senderUsernameInGroup(conv, senderId) {
  if (!conv?.members) return null;
  const m = conv.members.find(p => p.id === senderId);
  return m?.username || null;
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
      .select('id, conversation_id, sender_id, body, created_at, read_at, edited_at, deleted_at, reply_to_id, image_url, image_urls, image_kind')
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
  // and normalize image fields so the renderer always sees image_urls as an
  // array. Pre-2026-05-07 rows only have image_url populated; new rows have
  // both. The mobile lib does the same shape promotion; matching here means
  // renderMessages doesn't have to branch on legacy schema shape.
  dmState.messages = (msgs || []).slice().reverse().map((m) => {
    if (Array.isArray(m.image_urls) && m.image_urls.length > 0) return m;
    if (m.image_url) return { ...m, image_urls: [m.image_url] };
    return { ...m, image_urls: [] };
  });
  dmState.reactions = reactionsByMsg;
  renderMessages();
  // Initial open of a thread → always pin to bottom regardless of prior scroll.
  scrollMessagesToBottom({ force: true });
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
    if (m.sender_id === _cfg.getCurrentUser().id && m.read_at) { lastReadOfMine = m.id; break; }
  }

  let lastDateStamp = '';
  let html = '';
  for (let i = 0; i < dmState.messages.length; i++) {
    const m = dmState.messages[i];
    const prev = dmState.messages[i - 1];
    const next = dmState.messages[i + 1];
    const mine = m.sender_id === _cfg.getCurrentUser().id;

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
      // Image attachment(s) — multi-image post-2026-05-07. The loadMessages
      // normalizer above guarantees `m.image_urls` is always an array
      // (possibly empty); legacy `m.image_url` rows are promoted to
      // length-1 arrays at fetch time. GIF detection still uses the lead
      // url's image_kind/extension since GIFs are always single-attachment.
      const imageUrls = Array.isArray(m.image_urls) && m.image_urls.length > 0
        ? m.image_urls
        : (m.image_url ? [m.image_url] : []);
      if (imageUrls.length > 0) {
        const leadUrl = imageUrls[0];
        const isGif = m.image_kind === 'gif' || /\.gif(\?|$)/i.test(leadUrl);
        if (imageUrls.length === 1) {
          // Single image keeps the existing markup so the surrounding CSS
          // (rounded corners, GIF tag, lightbox click handler) all still
          // applies unchanged.
          imageHtml = `
            <div class="dm-bubble-image ${isGif ? 'is-gif' : ''}" data-img-url="${escHTML(leadUrl)}">
              <img src="${escHTML(leadUrl)}" alt="Attachment" loading="lazy"/>
              ${isGif ? '<span class="dm-bubble-image-tag">GIF</span>' : ''}
            </div>
          `;
        } else {
          // Gallery grid for 2+ images. We render up to 4 thumbs; if there
          // are more, the 4th cell gets a "+N" overlay. Each thumb is
          // tappable via the same data-img-url lightbox hook the single
          // image uses, so existing click handlers keep working.
          const visible = imageUrls.slice(0, 4);
          const overflow = imageUrls.length - 4;
          imageHtml = `
            <div class="dm-bubble-gallery dm-bubble-gallery-${visible.length}">
              ${visible.map((url, idx) => {
                const isOverflow = idx === 3 && overflow > 0;
                return `
                  <div class="dm-bubble-gallery-cell" data-img-url="${escHTML(url)}">
                    <img src="${escHTML(url)}" alt="Attachment" loading="lazy"/>
                    ${isOverflow ? `<span class="dm-bubble-gallery-overflow">+${overflow}</span>` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          `;
        }
      }
      // Body text (skip if message is image-only with whitespace body)
      const trimmedBody = (m.body || '').trim();
      if (trimmedBody) {
        const escaped = escHTML(m.body || '').replace(/\n/g, '<br>');
        bubbleContent = _cfg.linkify(escaped);
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
        if (r.user_id === _cfg.getCurrentUser().id) myReacts.add(r.emoji);
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
          : (parent.sender_id === _cfg.getCurrentUser().id ? { username: 'You' } : dmState.activeOther);
        const parentName = parent.sender_id === _cfg.getCurrentUser().id ? 'You' : (parentSender?.username || 'Unknown');
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

// ── Send a message ────────────────────────────────────────────────────────
// ─── Shared send-path guards (Codex P1 — extracted in Stage 9 review) ─────
// Every send entry-point (text, thumbs-up, GIF, attachment) needs:
//   1. an active conversation
//   2. the single-flight lock (so a fast double-tap doesn't double-send)
//   3. for secret 1:1's, a server re-verification that the mutual-follow
//      still holds. Without this, sendDmThumbsUp / sendDmGif / sendDmAttachment
//      could ship a message into a secret chat where the other side has
//      unfollowed since the conversation was created.
//
// _dmCanSendInActiveConv() returns true iff there's an active convo AND
// (for secret 1:1's) the mutual-follow is still intact. Toasts on failure
// — caller doesn't need to.
async function _dmCanSendInActiveConv() {
  if (!dmState.activeConvId) return false;
  const ac = dmState.activeConv;
  if (ac && ac.is_secret && !ac.is_group) {
    const otherId = ac.user_a === _cfg.getCurrentUser().id ? ac.user_b : ac.user_a;
    if (otherId) {
      const stillMutual = await dmIsMutualFollow(_cfg.getCurrentUser().id, otherId);
      if (!stillMutual) {
        toast('You and this person are no longer mutuals. Secret chat is frozen.', 'error');
        return false;
      }
    }
  }
  return true;
}

// _dmWithSendLock(fn) wraps an async send op behind the single-flight
// lock. Returns true if the op ran, false if the lock was already held.
// Doesn't toast — caller controls error messaging.
async function _dmWithSendLock(fn) {
  if (_dmSendInFlight) return false;
  _dmSendInFlight = true;
  try { await fn(); }
  finally { _dmSendInFlight = false; }
  return true;
}

async function sendDmMessage() {
  if (_dmSendInFlight) return;
  const input = document.getElementById('dmInput');
  if (!input || !dmState.activeConvId) return;
  const body = input.value.trim();
  if (!body) {
    // Empty composer + send click = thumbs-up emoji (FB classic).
    // sendDmThumbsUp now has its own guard + lock so it's safe to chain.
    return sendDmThumbsUp();
  }

  _dmSendInFlight = true;
  const sendBtn = document.getElementById('dmSendBtn');
  if (sendBtn) sendBtn.disabled = true;
  input.disabled = true;
  // Release the single-flight lock from every exit path. Defined here so
  // every early-return below can call it without forgetting.
  const releaseSendLock = () => {
    _dmSendInFlight = false;
    if (sendBtn) sendBtn.disabled = false;
    input.disabled = false;
  };

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
    const otherId = ac.user_a === _cfg.getCurrentUser().id ? ac.user_b : ac.user_a;
    if (otherId) {
      const stillMutual = await dmIsMutualFollow(_cfg.getCurrentUser().id, otherId);
      if (!stillMutual) {
        toast('You and this person are no longer mutuals. Secret chat is frozen.', 'error');
        releaseSendLock();
        return;
      }
    }
  }

  // Optimistic render
  const tempId = 'temp-' + Date.now();
  const optimistic = {
    id: tempId,
    conversation_id: dmState.activeConvId,
    sender_id: _cfg.getCurrentUser().id,
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
    sender_id: _cfg.getCurrentUser().id,
    body,
    reply_to_id: replyToId,
  }).select().single();

  if (error) {
    // Rollback optimistic
    dmState.messages = dmState.messages.filter(m => m.id !== tempId);
    renderMessages();
    toast(error.message, 'error');
    releaseSendLock();
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
  releaseSendLock();
}

async function sendDmThumbsUp() {
  // Codex P1 — apply the same can-send check + single-flight lock the
  // text path enforces. Pre-fix this returned early on missing convo
  // but skipped the lock and the secret-mutual check, so:
  //   • two fast thumbs-up taps could double-send (no lock)
  //   • a thumbs-up in a frozen secret chat (mutual broken since
  //     creation) would silently slip through
  if (!await _dmCanSendInActiveConv()) return;
  await _dmWithSendLock(async () => {
    const { data, error } = await supabase.from('messages').insert({
      conversation_id: dmState.activeConvId,
      sender_id: _cfg.getCurrentUser().id,
      body: '👍',
    }).select().single();
    if (error) { toast(error.message, 'error'); return; }
    dmState.messages.push(data);
    renderMessages();
    // Sending my own thumbs-up → always pin.
    scrollMessagesToBottom({ force: true });
  });
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

// True when the messages pane is scrolled to (or within 80px of) the bottom.
function isDmAtBottom(wrap) {
  if (!wrap) return false;
  return wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 80;
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

// ── Reactions API ──────────────────────────────────────────────────────────
async function toggleReaction(messageId, emoji) {
  if (!_cfg.getCurrentUser()) return;
  const existing = (dmState.reactions[messageId] || []).find(r =>
    r.user_id === _cfg.getCurrentUser().id && r.emoji === emoji);

  if (existing) {
    // Remove (optimistic)
    dmState.reactions[messageId] = dmState.reactions[messageId].filter(r =>
      !(r.user_id === _cfg.getCurrentUser().id && r.emoji === emoji));
    renderMessages();
    const { error } = await supabase.from('message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', _cfg.getCurrentUser().id)
      .eq('emoji', emoji);
    if (error) toast(error.message, 'error');
  } else {
    // Add (optimistic)
    if (!dmState.reactions[messageId]) dmState.reactions[messageId] = [];
    dmState.reactions[messageId].push({ message_id: messageId, user_id: _cfg.getCurrentUser().id, emoji });
    renderMessages();
    const { error } = await supabase.from('message_reactions').insert({
      message_id: messageId, user_id: _cfg.getCurrentUser().id, emoji,
    });
    if (error) {
      // Rollback
      dmState.reactions[messageId] = dmState.reactions[messageId].filter(r =>
        !(r.user_id === _cfg.getCurrentUser().id && r.emoji === emoji));
      renderMessages();
      toast(error.message, 'error');
    }
  }
  closeReactionPicker();
}

// ── Edit / delete own message ─────────────────────────────────────────────
async function deleteMessage(messageId) {
  const ok = await _cfg.confirmDialog({
    title: 'Delete message?',
    body: 'This message will be replaced with "Message deleted" for both of you. Can\'t be undone.',
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  const { error } = await supabase.from('messages')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', messageId)
    .eq('sender_id', _cfg.getCurrentUser().id);
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
  if (!msg || msg.sender_id !== _cfg.getCurrentUser().id) return;
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
    .eq('sender_id', _cfg.getCurrentUser().id);
  if (error) { toast(error.message, 'error'); return; }
  const idx = dmState.messages.findIndex(m => m.id === messageId);
  if (idx >= 0) {
    dmState.messages[idx] = { ...dmState.messages[idx], body: trimmed, edited_at: nowIso };
  }
  dmState.editingMessageId = null;
  renderMessages();
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

// ── Hover menu + reaction picker ──────────────────────────────────────────
function closeHoverMenu() {
  if (dmState.hoverMenuEl) { dmState.hoverMenuEl.remove(); dmState.hoverMenuEl = null; }
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

function closeReactionPicker() {
  if (dmState.reactionPickerEl) { dmState.reactionPickerEl.remove(); dmState.reactionPickerEl = null; }
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

// ── Realtime ──────────────────────────────────────────────────────────────

// Codex P2 — teardown helper called by app.js's hideAllMainPages when the
// Messages page leaves the screen. Without this, dmState.realtimeChannel
// + presenceChannel kept their Supabase subscriptions open in the
// background long after the user navigated away (the same #213 finding
// pre-extraction). subscribeToThread already calls this implicitly when
// the user switches threads — exposing it lets the page-leave path call
// the same cleanup. Idempotent: safe to call when no conversation is
// active (the channels are null and we no-op).
//
// Codex re-verification finding 2 — the teardown also resets the thread
// pane to the empty-state, drops the .thread-open class, and unhighlights
// the active conversation row. Without this, navigating away from
// Messages while a thread was open and then returning left the old
// thread pane visible but with activeConvId=null, so sending and
// realtime were silently broken until the user reselected a conv.
// Mirrors the dmBackBtn click handler in app.js (~line 13283).
export function teardownActiveConversation() {
  if (dmState.realtimeChannel) {
    supabase.removeChannel(dmState.realtimeChannel);
    dmState.realtimeChannel = null;
  }
  if (dmState.presenceChannel) {
    supabase.removeChannel(dmState.presenceChannel);
    dmState.presenceChannel = null;
  }
  if (dmState.otherTypingTimer) {
    clearTimeout(dmState.otherTypingTimer);
    dmState.otherTypingTimer = null;
  }
  if (dmState.myTypingTimer) {
    clearTimeout(dmState.myTypingTimer);
    dmState.myTypingTimer = null;
  }
  dmState.otherIsTyping = false;
  dmState.otherIsOnline = false;
  dmState.activeConvId = null;
  dmState.activeConv = null;
  dmState.activeOther = null;
  dmState.editingMessageId = null;
  // ── UI reset (Codex re-verify finding 2) ──
  // Guarded with optional-chaining + try because teardown can fire
  // before the Messages DOM has ever been rendered (auth flip, first
  // page load → other tab). Don't let a missing element block channel
  // cleanup above.
  try {
    document.querySelector('.dm-shell')?.classList.remove('thread-open');
    const active = document.getElementById('dmThreadActive');
    if (active) active.style.display = 'none';
    const empty = document.getElementById('dmThreadEmpty');
    if (empty) empty.style.display = 'flex';
    document.querySelectorAll('.dm-conv-item.active').forEach((el) => el.classList.remove('active'));
  } catch {}
}

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
      if (newMsg.sender_id === _cfg.getCurrentUser().id) {
        const tempIdx = dmState.messages.findIndex(m =>
          String(m.id).startsWith('temp-') &&
          m.sender_id === _cfg.getCurrentUser().id &&
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
      if (newMsg.sender_id !== _cfg.getCurrentUser().id) {
        // The other side just sent — clear typing indicator
        dmState.otherIsTyping = false;
        supabase.rpc('mark_conversation_read', { p_conversation_id: convId });
        // Also reset local unread immediately so the sidebar badge doesn't
        // tick up while the user is actively reading the thread. The inbox
        // channel's guard already skips totalUnread bump, but the per-conv
        // count needs explicit clearing here in case it drifted.
        const c = dmState.conversations.find(x => x.id === convId);
        if (c) c.unread = 0;
        updateUnreadBadge(computeDmUnreadTotal());
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
    config: { presence: { key: _cfg.getCurrentUser().id } },
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
      if (!fromId || fromId === _cfg.getCurrentUser().id) return;
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
        await channel.track({ userId: _cfg.getCurrentUser().id, online_at: new Date().toISOString() });
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
    payload: { userId: _cfg.getCurrentUser().id },
  });
  // Throttle: don't re-broadcast more than once every 1.5s
  dmState.myTypingTimer = setTimeout(() => {
    dmState.myTypingTimer = null;
  }, 1500);
}

function subscribeToInbox() {
  if (!_cfg.getCurrentUser()) return;
  if (dmState.inboxChannel) supabase.removeChannel(dmState.inboxChannel);
  // Drop the cache when re-subscribing — different user could be signed
  // in, different conversations.
  __convInboxCache.clear();
  dmState.inboxChannel = supabase
    .channel(`dm-inbox-${_cfg.getCurrentUser().id}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
    }, async (payload) => {
      const m = payload.new;
      if (m.sender_id === _cfg.getCurrentUser().id) return; // my own message

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

      if (meta.user_a !== _cfg.getCurrentUser().id && meta.user_b !== _cfg.getCurrentUser().id) return;
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

// Single source of truth for the DM unread badge total. Mute + archive +
// secret all exclude a conversation from the lower-right badge. Codex audit
// 2026-05-16: three separate inline `.reduce` sites were drifting (some
// excluded only `muted`, the initial load excluded mute+archive+secret),
// so the badge total flickered as you opened/marked threads. Centralize.
function computeDmUnreadTotal() {
  return dmState.conversations.reduce((sum, c) => {
    if (c.muted || c.archived || c.isSecret) return sum;
    return sum + (c.unread || 0);
  }, 0);
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

// Initial badge load + inbox subscription on app boot
async function bootstrapDmBadge() {
  if (!_cfg.getCurrentUser()) return;
  // Pull is_secret too so we can exclude Secret conversations from the
  // global unread total.
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, is_secret')
    .or(`user_a.eq.${_cfg.getCurrentUser().id},user_b.eq.${_cfg.getCurrentUser().id}`);
  if (!convs?.length) { updateUnreadBadge(0); return; }
  const eligibleIds = convs.filter(c => !c.is_secret).map(c => c.id);
  if (!eligibleIds.length) { updateUnreadBadge(0); return; }
  const counts = await fetchUnreadCounts(eligibleIds);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  updateUnreadBadge(total);
  subscribeToInbox();
}



// ════════════════════════════════════════════════════════════════════════
// Stage 9B — Messages extras (appended by extract-stage9b.js)
// Secret lock IIFE + emoji picker + attach menu + GIF picker + reply
// state + conv menu + group admin + global search + mention dropdown +
// DM link preview.
// ════════════════════════════════════════════════════════════════════════

// ─── Module state (9B) ────────────────────────────────────────────

// ─── Mention dropdown state ──────────────────────────────────────────────
// Backs the mention helpers (getMentionDropdown, positionMentionDropdown,
// maybeShowMentionDropdown, renderMentionDropdown, selectMention,
// closeMentionDropdown). Added in the Stage 9B Codex review pass — the
// codemod's EXTRACT_STATE list missed these and the mention dropdown
// threw ReferenceErrors at runtime when the composer fired `@`.
let _mentionDropdown = null;
let _mentionTextarea = null;
let _mentionResults  = [];
let _mentionIdx      = 0;
let _mentionDebounce = null;

// ─── Attach / GIF / Emoji picker constants ───────────────────────────────
// Same Codex catch — these were left as top-level consts in app.js when
// the codemod moved their consumers. Without them in module scope:
//   • sendDmAttachment threw on DM_BUCKET (Supabase storage bucket name)
//   • openDmGifPicker / loadGifResults threw on DM_GIPHY_KEY
//   • openScopedEmojiPicker threw on DM_EMOJI_GROUPS (the emoji grid data)
//
// DM_MAX_IMAGE_BYTES stays in app.js — its only reader is the file-picker
// handler inside the app.js DM wiring block, which passes it across as
// an argument to compressImageToJpeg.
const DM_BUCKET = 'dm-attachments';

// Giphy API key from developers.giphy.com/dashboard. Free tier = 100k req/day.
// Public client-side use is the intended exposure — Giphy rate-limits per IP.
const DM_GIPHY_KEY = 'UYrH9t3qUegWfBNynMFTHL3uEHsySkSm';

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
// In-memory cache so we don't refetch the same item on every render
const _dmInternalPreviewCache = new Map(); // key = type:id, value = {title, thumb, sub}
// ── Global search (across conversations + message bodies) ─────────────────
let _dmSearchTimer = null;
// _dmPendingAttachment shapes (post-2026-05-07 multi-image):
//   { kind: 'upload', files: File[], dataUrls: string[] } — 1..10 photos
//   { kind: 'gif',    gifUrl: string }                     — single Giphy
// Kept as one variable so the existing show/hide/send paths can keep
// switching on `.kind`. The legacy { file, dataUrl } shape is gone —
// the upload path always uses arrays now (single-photo sends just have
// length-1 arrays).
let _dmPendingAttachment = null;
let _dmAttachMenuEl = null;
let _dmGifPickerEl = null;
let _dmEmojiPickerEl = null;
// Tracks which trigger opened the current picker so a click on a DIFFERENT
// trigger closes the existing one and opens a fresh one bound to the new
// input (needed for the floating mini-chats — each has its own emoji button
// + its own composer textarea).
let _dmEmojiPickerTrigger = null;

// ─── Extracted functions (9B) ─────────────────────────────────────

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
    _mentionResults = (data || []).filter(p => p.id !== _cfg.getCurrentUser()?.id);
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

// Document-level keydown handler for the @mention dropdown navigation.
// Lives here (not in app.js) because all of _mentionTextarea /
// _mentionResults / _mentionDropdown / _mentionIdx are module-scoped to
// messages.js — referencing them from app.js throws ReferenceError after
// the Stage 9B state move (Codex re-verification finding 1). Wired into
// the document keydown listener in app.js, which is just a thin pass-
// through into this function.
export function handleMentionKeydown(e) {
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
}

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

// ════════════════════════════════════════════════════════════════════════════
// DMs Phase 3 — reply, conv menu, group creation, search
// ════════════════════════════════════════════════════════════════════════════

// ── Reply state ───────────────────────────────────────────────────────────
function startReplyToMessage(messageId) {
  const m = dmState.messages.find(x => x.id === messageId);
  if (!m) return;
  const senderProfile = m.sender_id === _cfg.getCurrentUser().id
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
      if      (act === 'profile')  _cfg.openProfile(dmState.activeOther?.id);
      else if (act === 'members')  showGroupMembersDialog();
      else if (act === 'mute')     toggleConvMute(isMuted);
      else if (act === 'archive')  archiveConversation();
      else if (act === 'report')   _cfg.openReportUserModal(dmState.activeOther?.id, dmState.activeOther?.username || 'this user');
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

async function toggleConvMute(currentlyMuted) {
  const c = dmState.activeConv;
  if (!c || c.isGroup) { toast('Group mute coming soon', ''); return; }
  const conv = c.raw;
  const myCol = conv.user_a === _cfg.getCurrentUser().id ? 'muted_until_a' : 'muted_until_b';
  const newVal = currentlyMuted ? null : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(); // mute 7 days
  const { error } = await supabase.from('conversations').update({ [myCol]: newVal }).eq('id', conv.id);
  if (error) { toast(error.message, 'error'); return; }
  toast(currentlyMuted ? 'Unmuted' : 'Muted for 7 days', 'success');
  conv[myCol] = newVal;
  c.muted = !currentlyMuted;
  renderConversationList();
  // Recompute unread badge
  updateUnreadBadge(computeDmUnreadTotal());
}

async function archiveConversation() {
  const c = dmState.activeConv;
  if (!c || c.isGroup) { toast('Group archive coming soon', ''); return; }
  const conv = c.raw;
  const myCol = conv.user_a === _cfg.getCurrentUser().id ? 'archived_by_a' : 'archived_by_b';
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
  const ok = await _cfg.confirmDialog({
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
  const ok = await _cfg.confirmDialog({
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
  const isCreator = c.createdBy === _cfg.getCurrentUser().id || c.raw?.created_by === _cfg.getCurrentUser().id;
  _cfg.closeAllModals('.modal-backdrop[data-modal="group-members"]');
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
          const isYou = m.id === _cfg.getCurrentUser().id;
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
    el.onclick = () => { close(); _cfg.openProfile(el.dataset.uid); };
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
    const path = `group-avatars/${c.id}/${_cfg.getCurrentUser().id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
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
  _cfg.closeAllModals('.modal-backdrop[data-modal="group-add"]');
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
  if (c.createdBy && c.createdBy !== _cfg.getCurrentUser().id) {
    toast('Only the group creator can remove members', 'error');
    return;
  }
  if (userId === _cfg.getCurrentUser().id) {
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
  if (!_cfg.getCurrentUser()) throw new Error('Please sign in');
  if (!otherUserId || otherUserId === _cfg.getCurrentUser().id) {
    throw new Error('Cannot start a conversation with yourself');
  }
  const mutual = await dmIsMutualFollow(_cfg.getCurrentUser().id, otherUserId);
  if (!mutual) throw new Error('Both of you must follow each other to start a Secret chat');

  const [a, b] = _cfg.getCurrentUser().id < otherUserId
    ? [_cfg.getCurrentUser().id, otherUserId]
    : [otherUserId, _cfg.getCurrentUser().id];

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
      created_by: _cfg.getCurrentUser().id,
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
  if (!_cfg.getCurrentUser()) { toast('Please sign in', 'error'); return; }
  _cfg.closeAllModals('.modal-backdrop[data-modal="dm-new-secret"]');

  // Pre-fetch mutual UUIDs once. Same trick as mobile's SupabaseNewChat.
  let mutualIds = null;
  try {
    const [iFollow, followsMe] = await Promise.all([
      supabase.from('follows').select('following_id').eq('follower_id', _cfg.getCurrentUser().id),
      supabase.from('follows').select('follower_id').eq('following_id', _cfg.getCurrentUser().id),
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
        .neq('id', _cfg.getCurrentUser().id)
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

function openNewConvModal() {
  if (!_cfg.getCurrentUser()) { toast('Please sign in', 'error'); return; }
  _cfg.closeAllModals('.modal-backdrop[data-modal="dm-new"]');
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
        .neq('id', _cfg.getCurrentUser().id)
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
  const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\// ─── Stage 9A exports ─────────────────────────────────────────────') + ')', 'ig');
  return safe.replace(re, '<mark>$1</mark>');
}

// ── + (attach) button → small menu: Photo · GIF ───────────────────────────
function closeDmAttachMenu() {
  if (_dmAttachMenuEl) { _dmAttachMenuEl.remove(); _dmAttachMenuEl = null; }
}

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

// Now takes either:
//   showDmAttachPreview(dataUrl, name, size)              — legacy single-image / GIF call sites
//   showDmAttachPreview(dataUrls: string[], files: File[]) — multi-image upload path
// We detect the multi-image shape by Array.isArray on the first arg and
// render a thumbnail strip; the legacy callers (gif preview) still get
// the original single-image markup so nothing else has to change.
function showDmAttachPreview(srcOrUrls, nameOrFiles, size) {
  const wrap = document.getElementById('dmAttachPreview');
  const isMulti = Array.isArray(srcOrUrls);
  if (isMulti) {
    const dataUrls = srcOrUrls;
    const files = Array.isArray(nameOrFiles) ? nameOrFiles : [];
    // Lead image goes in the existing single-image slot; the rest get
    // injected as a horizontal thumb row right after. Each thumb has its
    // own X overlay that drops just that file from the staged batch.
    const leadImg = document.getElementById('dmAttachPreviewImg');
    if (leadImg) leadImg.src = dataUrls[0] || '';
    document.getElementById('dmAttachPreviewName').textContent = files.length === 1
      ? (files[0]?.name || 'Image')
      : `${files.length} photos`;
    const totalBytes = files.reduce((sum, f) => sum + (f?.size || 0), 0);
    document.getElementById('dmAttachPreviewSize').textContent = totalBytes ? `· ${formatBytes(totalBytes)}` : '';
    // Render the supplementary thumb strip if more than one. Reuses the
    // existing #dmAttachPreviewExtra container when present, otherwise
    // appends one inside #dmAttachPreview so no HTML change is required.
    let extra = document.getElementById('dmAttachPreviewExtra');
    if (files.length > 1) {
      if (!extra) {
        extra = document.createElement('div');
        extra.id = 'dmAttachPreviewExtra';
        extra.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;';
        wrap?.appendChild(extra);
      }
      extra.style.display = '';
      extra.innerHTML = dataUrls.map((u, idx) => `
        <div style="position:relative;width:48px;height:48px;border-radius:6px;overflow:hidden;background:#222">
          <img src="${u}" style="width:100%;height:100%;object-fit:cover" alt=""/>
          <button type="button" data-dm-remove-idx="${idx}" style="position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.85);color:#fff;border:none;font-size:11px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center" title="Remove">×</button>
        </div>
      `).join('');
      // Wire per-thumb X buttons.
      extra.querySelectorAll('[data-dm-remove-idx]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const idx = parseInt(btn.dataset.dmRemoveIdx, 10);
          if (!_dmPendingAttachment || _dmPendingAttachment.kind !== 'upload') return;
          _dmPendingAttachment.files.splice(idx, 1);
          _dmPendingAttachment.dataUrls.splice(idx, 1);
          if (_dmPendingAttachment.files.length === 0) {
            hideDmAttachPreview();
          } else {
            showDmAttachPreview(_dmPendingAttachment.dataUrls, _dmPendingAttachment.files);
          }
          updateSendButton();
        });
      });
    } else if (extra) {
      extra.style.display = 'none';
      extra.innerHTML = '';
    }
  } else {
    // Legacy single-image path (still used by GIF preview).
    document.getElementById('dmAttachPreviewImg').src = srcOrUrls;
    document.getElementById('dmAttachPreviewName').textContent = nameOrFiles || 'Image';
    document.getElementById('dmAttachPreviewSize').textContent = size ? `· ${formatBytes(size)}` : '';
    const extra = document.getElementById('dmAttachPreviewExtra');
    if (extra) { extra.style.display = 'none'; extra.innerHTML = ''; }
  }
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

// ── Override sendDmMessage to handle attachments + GIFs ─────────────────
// Rather than re-declaring the function, we wrap upload logic into a helper
// that the existing sendDmMessage delegates to when an attachment is staged.
// We do this by hooking into the send button click before it runs sendDmMessage.
async function sendDmAttachment() {
  if (!_dmPendingAttachment) return false;
  // Codex P1 — secret-mutual + send-lock parity with the text path.
  // Previously: just an `activeConvId && _dmPendingAttachment` check;
  // could double-fire on Enter+click, and could leak into frozen
  // secret chats. Wrap the body in try/finally so the lock releases
  // on every exit path (multiple early returns + the success return).
  if (!await _dmCanSendInActiveConv()) return false;
  if (_dmSendInFlight) return false;
  _dmSendInFlight = true;
  try {
  const att = _dmPendingAttachment;

  let imageUrls = [];
  let imageKind = att.kind;

  if (att.kind === 'gif') {
    // GIFs are always single-attachment.
    imageUrls = [att.gifUrl];
  } else {
    // Upload all picked files in parallel. Order is preserved by Promise.all
    // so the gallery grid renders in the user's selection order. A single
    // failed upload aborts the whole send so the user knows something went
    // wrong rather than silently shipping a partial batch.
    const uploads = att.files.map(async (file) => {
      const ext = (file.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const path = `${_cfg.getCurrentUser().id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage.from(DM_BUCKET).upload(path, file, {
        contentType: file.type,
        cacheControl: '3600',
        upsert: false,
      });
      if (upErr) throw upErr;
      const { data: urlData } = supabase.storage.from(DM_BUCKET).getPublicUrl(path);
      if (!urlData?.publicUrl) throw new Error('No public URL returned');
      return urlData.publicUrl;
    });
    try {
      imageUrls = await Promise.all(uploads);
    } catch (upErr) {
      console.error('[dm] upload failed', upErr);
      toast(upErr.message || 'Upload failed', 'error');
      return false;
    }
  }
  if (!imageUrls.length) { toast('Failed to attach image(s)', 'error'); return false; }

  const input = document.getElementById('dmInput');
  const body = (input?.value || '').trim();
  const replyToId = dmState.replyingTo?.id || null;
  dmState.replyingTo = null;
  hideReplyPreview();

  // Optimistic render — image_url stays = the lead image so any code that
  // still reads the singular field (legacy code paths, push notifications)
  // sees something; image_urls is the canonical ordered list.
  const tempId = 'temp-' + Date.now();
  dmState.messages.push({
    id: tempId,
    conversation_id: dmState.activeConvId,
    sender_id: _cfg.getCurrentUser().id,
    body: body || '',
    image_url: imageUrls[0],
    image_urls: imageUrls,
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
    sender_id: _cfg.getCurrentUser().id,
    body: body || ' ',     // body has a NOT-NULL/length constraint; one-space passes
    image_url: imageUrls[0],
    image_urls: imageUrls,
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
  } finally {
    // Release the single-flight lock from every exit path inside the
    // try (success + 4 early returns).
    _dmSendInFlight = false;
  }
}

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

function closeDmEmojiPicker() {
  if (_dmEmojiPickerEl) { _dmEmojiPickerEl.remove(); _dmEmojiPickerEl = null; }
}

function openScopedEmojiPicker({ trigger, input, onInsert } = {}) {
  if (!trigger) return;
  // Toggle off if the same trigger is clicked twice in a row.
  if (_dmEmojiPickerEl) {
    const wasSameTrigger = _dmEmojiPickerTrigger === trigger;
    closeDmEmojiPicker();
    _dmEmojiPickerTrigger = null;
    if (wasSameTrigger) return;
  }
  closeDmGifPicker();
  closeDmAttachMenu();

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
  _dmEmojiPickerTrigger = trigger;

  // Caller can pass either (a) an explicit onInsert callback for full
  // control, or (b) just an input element — in which case we insert at
  // the cursor + restore focus + dispatch input event so any composer-
  // local listeners (resize, counters) still fire.
  const doInsert = (em) => {
    if (typeof onInsert === 'function') return onInsert(em);
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end   = input.selectionEnd   ?? input.value.length;
    input.value = input.value.slice(0, start) + em + input.value.slice(end);
    const caret = start + em.length;
    input.focus();
    try { input.setSelectionRange(caret, caret); } catch {}
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  picker.querySelectorAll('.dm-emoji-cell').forEach(cell => {
    cell.onclick = (ev) => {
      ev.stopPropagation();
      doInsert(cell.dataset.emoji);
    };
  });

  setTimeout(() => {
    const onDoc = (ev) => {
      if (!_dmEmojiPickerEl?.contains(ev.target) && !trigger.contains(ev.target)) {
        closeDmEmojiPicker();
        _dmEmojiPickerTrigger = null;
        document.removeEventListener('click', onDoc);
      }
    };
    document.addEventListener('click', onDoc);
  }, 0);
}

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

function renderDmLinkPreview(body) {
  const url = _cfg.firstUrlInText(body);
  if (!url) return '';

  // Selebox-internal: render placeholder, hydrator fills it in
  const internal = parseSeleboxInternalUrl(url);
  if (internal) {
    const cacheKey = `${internal.type}:${internal.id}`;
    const cached = _dmInternalPreviewCache.get(cacheKey);
    return renderInternalPreviewCard(internal, cached);
  }

  // External: existing YouTube/generic preview (just wrap in dm-link-preview class for spacing)
  const html = _cfg.renderLinkPreview(body);
  return html ? `<div class="dm-link-preview-wrap">${html}</div>` : '';
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


// ─── Stage 9B exports ─────────────────────────────────────────────
export {
  getMentionDropdown,
  closeMentionDropdown,
  positionMentionDropdown,
  maybeShowMentionDropdown,
  renderMentionDropdown,
  selectMention,
  wireSecretTabHandlers,
  renderSecretLockGateHtml,
  startReplyToMessage,
  showReplyPreview,
  hideReplyPreview,
  closeConvMenu,
  openConvActionsMenu,
  toggleConvMute,
  archiveConversation,
  confirmDeleteConversation,
  confirmLeaveGroup,
  showGroupMembersDialog,
  promptRenameGroup,
  handleGroupAvatarPicked,
  openAddMembersModal,
  kickGroupMember,
  refreshActiveConvMembers,
  dmIsMutualFollow,
  dmGetOrCreateSecretConv,
  openSecretChatPicker,
  openNewConvModal,
  renderGlobalSearchResults,
  highlightSearchMatch,
  closeDmAttachMenu,
  fileToDataUrl,
  compressImageToJpeg,
  showDmAttachPreview,
  hideDmAttachPreview,
  formatBytes,
  sendDmAttachment,
  closeDmGifPicker,
  openDmGifPicker,
  loadGifResults,
  sendDmGif,
  closeDmEmojiPicker,
  openScopedEmojiPicker,
  insertEmojiIntoComposer,
  parseSeleboxInternalUrl,
  renderInternalPreviewCard,
  renderDmLinkPreview,
  hydrateDmInternalPreviews,
};

// ─── Stage 9A exports ─────────────────────────────────────────────
export {
  showMessages,
  openConversation,
  openConversationWithUser,
  loadConversationList,
  renderConversationList,
  renderConvEmptyStateHtml,
  renderConvItemHtml,
  fetchUnreadCounts,
  isConvMutedForMe,
  renderGroupAvatarHtml,
  senderUsernameInGroup,
  loadMessages,
  renderMessages,
  formatMessageDateStamp,
  formatStampLabel,
  sendDmMessage,
  sendDmThumbsUp,
  updateSendButton,
  resizeDmInput,
  scrollMessagesToBottom,
  isDmAtBottom,
  fetchReactionsForConversation,
  toggleReaction,
  deleteMessage,
  startEditMessage,
  saveEditMessage,
  openHoverMenu,
  closeHoverMenu,
  openReactionPicker,
  closeReactionPicker,
  copyMessageText,
  subscribeToThread,
  subscribeToPresenceAndTyping,
  updateThreadPresenceUI,
  broadcastTyping,
  subscribeToInbox,
  computeDmUnreadTotal,
  updateUnreadBadge,
  bootstrapDmBadge,
  // Shared mutable state — exported as live bindings so Stage 9B-territory
  // code still in app.js (reply preview, attach send, emoji insert, secret
  // lock, conv menu, group admin, search, mention dropdown) can read AND
  // write dmState.X / _renderedMessageIds without us inventing a 30-field
  // accessor surface. Mutations through field access are shared between
  // modules automatically because both sides hold a reference to the same
  // object. When Stage 9B lands and those callers move into messages.js
  // too, the export stays as the canonical owner.
  dmState,
  _renderedMessageIds,
};

// ─── Accessor exports for 9B mutable state that app.js still touches ─────
// App.js's top-level DM-page event listener block (search debounce,
// attach-menu wiring, file picker, paste handler, send-button overrides,
// keydown intercepts) reads AND reassigns these three locals. ES module
// `let` exports give read-only bindings on the import side, so a direct
// `_dmAttachMenuEl = menu` from app.js can't reach across modules.
// Accessor pairs route the writes through messages.js where the binding
// lives. Follow-up: move the whole wiring block into a wireMessagesPage()
// here, the way Stage 8 did with wireBooksPage / wireBookReader, then
// drop these accessors.
export function getDmAttachMenuEl()          { return _dmAttachMenuEl; }
export function setDmAttachMenuEl(el)        { _dmAttachMenuEl = el; }
export function getDmPendingAttachment()     { return _dmPendingAttachment; }
export function setDmPendingAttachment(p)    { _dmPendingAttachment = p; }
export function getDmSearchTimer()           { return _dmSearchTimer; }
export function setDmSearchTimer(t)          { _dmSearchTimer = t; }

// SECRET_LOCK is the IIFE-built lock controller. App.js still calls
// SECRET_LOCK.isUnlocked() + SECRET_LOCK.onVisibilityChange() from boot
// wiring. Read-only access — export the const directly (member access
// works through ES module bindings).
export { SECRET_LOCK };
