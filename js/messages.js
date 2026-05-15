// ════════════════════════════════════════════════════════════════════════
// Selebox messages page — extracted from js/app.js as Stage 9 of the
// refactor roadmap (2026-05-16). Owns the chat / DM surface:
//   • showMessages() — entry point (sidebar + deep-link)
//   • Conversation list: loadConversationList, renderConversationList,
//     renderConvItemHtml, renderConvEmptyStateHtml, isConvMutedForMe,
//     fetchUnreadCounts, openConversationWithUser
//   • Thread view: loadMessages, renderMessages, formatMessageDateStamp,
//     scrollMessagesToBottom, isDmAtBottom
//   • Send: sendDmMessage, sendDmThumbsUp, resizeDmInput,
//     fetchReactionsForConversation
//   • Realtime: subscribeToThread, subscribeToInbox,
//     updateThreadPresenceUI, updateUnreadBadge, bootstrapDmBadge
//   • Message actions: deleteMessage, startEditMessage, saveEditMessage,
//     copyMessageText, startReplyToMessage
//   • Conv menu: closeConvMenu, openConvActionsMenu, toggleConvMute,
//     archiveConversation, confirmDeleteConversation,
//     openAddMembersModal, refreshActiveConvMembers
//   • DM helpers: dmIsMutualFollow, dmGetOrCreateSecretConv,
//     openNewConvModal
//   • Attachments: closeDmAttachMenu, showDmAttachPreview,
//     hideDmAttachPreview, sendDmAttachment
//   • GIF picker: closeDmGifPicker, openDmGifPicker, sendDmGif
//   • Emoji picker: closeDmEmojiPicker
//   • Link preview: renderDmLinkPreview, hydrateDmInternalPreviews
//
// External deps via initMessages(config). Imports from supabase.js for
// the shared infra (supabase client, helpers).
//
// CAREFUL: applied lessons from Stages 7B + 8 — paren-aware brace match,
// underscore-prefix names not filtered, arrow-const detection, string-
// literal protection, ++/-- operator handling, local closure detection.
// ════════════════════════════════════════════════════════════════════════

import { supabase, toast, escHTML, initials, timeAgo, callEdgeFunction } from './supabase.js';

// ─── Config-injection dependency surface ─────────────────────────────────
let _cfg = {
  getCurrentUser:        () => null,
  getCurrentProfile:     () => null,
  hideAllMainPages:      () => {},
  stopVideoPlayer:       () => {},
  setSidebarActive:      () => {},
  openProfile:           () => {},
  closeAllModals:        () => {},
  confirmDialog:         () => Promise.resolve(false),
  uploadImage:           async () => null,
  REACTIONS:             [],
  formatCompact:         (n) => String(n || 0),
  isReaderVisible:       () => false,
  confirmLeaveGroup: () => null,
  firstUrlInText: () => null,
  formatBytes: (s) => String(s ?? ''),
  formatStampLabel: (s) => String(s ?? ''),
  hideReplyPreview: () => {},
  linkify: (s) => String(s ?? ''),
  loadGifResults: async () => [],
  openConversation: () => {},
  openReportUserModal: () => {},
  parseSeleboxInternalUrl: () => null,
  renderGroupAvatarHtml: () => '',
  renderInternalPreviewCard: () => '',
  renderLinkPreview: () => '',
  renderSecretLockGateHtml: () => '',
  secretLockIsUnlocked: () => null,
  senderUsernameInGroup: () => null,
  showGroupMembersDialog: () => {},
  showReplyPreview: () => {},
  subscribeToPresenceAndTyping: () => {},
  updateSendButton: () => {},
  wireSecretTabHandlers: () => {},
};

export function initMessages(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// Lazy DOM ref for messagesPage (avoids module-load timing)
let _messagesPageEl = null;
function messagesPage() {
  if (!_messagesPageEl) _messagesPageEl = document.getElementById('messagesPage');
  return _messagesPageEl;
}

// ════════════════════════════════════════════════════════════════════════
// Extracted state + functions are appended below by the Stage 9 script.
// ════════════════════════════════════════════════════════════════════════

// ─── module state ────────────────────────────────────────────────
const _dmInternalPreviewCache = new Map(); // key = type:id, value = {title, thumb, sub}
const _renderedMessageIds = new Set();
const __convInboxCache = new Map();
const dmInputEl = document.getElementById('dmInput');
let _dmSearchTimer = null;
const dmSearchInput = document.getElementById('dmSearchInput');
const DM_MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;   // 2.5 MB
const DM_BUCKET = 'dm-attachments';
const DM_GIPHY_KEY = 'UYrH9t3qUegWfBNynMFTHL3uEHsySkSm';
let _dmPendingAttachment = null;
let _dmAttachMenuEl = null;
let _dmGifPickerEl = null;
let _dmEmojiPickerEl = null;

// ─── module constants ────────────────────────────────────────────
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
const DM_QUICK_REACTIONS = ['❤️','😂','😮','😢','😡','👍'];
const DM_EMPTY_HTML = `
  <div class="dm-empty-list" id="dmEmptyList">
    <div class="dm-empty-icon">💬</div>
    <h3>No conversations yet</h3>
    <p>Start one from anyone's profile.</p>
  </div>
`;
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

// ─── extracted functions ─────────────────────────────────────────

function renderDmLinkPreview(body) {
  const url = _cfg.firstUrlInText(body);
  if (!url) return '';

  // Selebox-internal: render placeholder, hydrator fills it in
  const internal = _cfg.parseSeleboxInternalUrl(url);
  if (internal) {
    const cacheKey = `${internal.type}:${internal.id}`;
    const cached = _dmInternalPreviewCache.get(cacheKey);
    return _cfg.renderInternalPreviewCard(internal, cached);
  }

  // External: existing YouTube/generic preview (just wrap in dm-link-preview class for spacing)
  const html = _cfg.renderLinkPreview(body);
  return html ? `<div class="dm-link-preview-wrap">${html}</div>` : '';
}

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
    replacement.innerHTML = _cfg.renderInternalPreviewCard({ type: t, id }, data).trim();
    el.parentNode.replaceChild(replacement.firstChild, el);
  });

  if (wasAtBottom) scrollMessagesToBottom();
}

async function showMessages(targetUserId = null) {
  if (!_cfg.getCurrentUser()) { toast('Please sign in', 'error'); return; }
  _cfg.hideAllMainPages();
  if (messagesPage()) messagesPage().style.display = 'block';
  document.body.classList.remove('on-videos');
  history.pushState(null, '', '#messages');
  _cfg.setSidebarActive('btnMessages');

  // DMs have a realtime subscription that keeps the list fresh — so on a
  // quick tab-flick the list is already up to date. Only re-fetch on first
  // load, when forced (targetUserId), or after 30 seconds.
  const dmList = document.getElementById('dmList') || messagesPage()?.querySelector('.dm-list');
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
  if (mode === 'secret' && !_cfg.secretLockIsUnlocked()) {
    bodyHtml = _cfg.renderSecretLockGateHtml();
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
    el.onclick = () => _cfg.openConversation(el.dataset.convId);
  });

  // Wire Secret-tab CTA + lock-gate handlers (when present)
  _cfg.wireSecretTabHandlers(wrap);
}

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
      : _cfg.renderGroupAvatarHtml(c.members, 'list');
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
    ? (escHTML(_cfg.senderUsernameInGroup(c, c.lastMessageSender) || 'Someone') + ': ')
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
  await _cfg.openConversation(convId);
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

function renderMessages() {
  const wrap = document.getElementById('dmMessages');
  if (!wrap) return;

  if (!dmState.messages.length) {
    if (dmState.activeConv?.isGroup) {
      wrap.innerHTML = `
        <div class="dm-thread-intro">
          <div class="dm-thread-intro-avatar">${_cfg.renderGroupAvatarHtml(dmState.activeConv.members, 'list')}</div>
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
    return _cfg.formatStampLabel(cur);
  }
  const prev = new Date(previous);
  const gapMs = cur - prev;
  if (gapMs > 30 * 60 * 1000 || cur.toDateString() !== prev.toDateString()) {
    return _cfg.formatStampLabel(cur);
  }
  return null;
}

function isDmAtBottom(wrap) {
  if (!wrap) return false;
  return wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 80;
}

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
  if (typeof hideReplyPreview === 'function') _cfg.hideReplyPreview();

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
  _cfg.updateSendButton();

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
    sender_id: _cfg.getCurrentUser().id,
    body: '👍',
  }).select().single();
  if (error) { toast(error.message, 'error'); return; }
  dmState.messages.push(data);
  renderMessages();
  // Sending my own thumbs-up → always pin.
  scrollMessagesToBottom({ force: true });
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
  _cfg.subscribeToPresenceAndTyping(convId);
}

function updateThreadPresenceUI() {
  const dot = document.getElementById('dmOnlineDot');
  const status = document.getElementById('dmThreadStatus');
  if (dot) dot.style.display = dmState.otherIsOnline ? '' : 'none';
  if (status) status.textContent = dmState.otherIsOnline ? 'Active now' : '';
}

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
      if (dmState.activeConvId === m.conversation_id && messagesPage()?.style.display === 'block') return;
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
  _cfg.showReplyPreview();
  document.getElementById('dmInput')?.focus();
}

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
      else if (act === 'members')  _cfg.showGroupMembersDialog();
      else if (act === 'mute')     toggleConvMute(isMuted);
      else if (act === 'archive')  archiveConversation();
      else if (act === 'report')   _cfg.openReportUserModal(dmState.activeOther?.id, dmState.activeOther?.username || 'this user');
      else if (act === 'delete')   confirmDeleteConversation();
      else if (act === 'leave')    _cfg.confirmLeaveGroup();
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
  const total = dmState.conversations.reduce((s, x) => x.muted ? s : s + (x.unread || 0), 0);
  updateUnreadBadge(total);
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
    _cfg.showGroupMembersDialog();
  }
}

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
      await _cfg.openConversation(convId);
    } catch (err) {
      console.error('[dm] create chat failed', err);
      toast(err.message || 'Failed to create chat', 'error');
      createBtn.disabled = false;
      createBtn.textContent = selectedUsers.length >= 2 ? 'Start group chat' : 'Start chat';
    }
  };
}

function closeDmAttachMenu() {
  if (_dmAttachMenuEl) { _dmAttachMenuEl.remove(); _dmAttachMenuEl = null; }
}

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
    document.getElementById('dmAttachPreviewSize').textContent = totalBytes ? `· ${_cfg.formatBytes(totalBytes)}` : '';
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
          _cfg.updateSendButton();
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
    document.getElementById('dmAttachPreviewSize').textContent = size ? `· ${_cfg.formatBytes(size)}` : '';
    const extra = document.getElementById('dmAttachPreviewExtra');
    if (extra) { extra.style.display = 'none'; extra.innerHTML = ''; }
  }
  if (wrap) wrap.style.display = '';
}

function hideDmAttachPreview() {
  const wrap = document.getElementById('dmAttachPreview');
  if (wrap) wrap.style.display = 'none';
  _dmPendingAttachment = null;
  _cfg.updateSendButton();
}

async function sendDmAttachment() {
  if (!dmState.activeConvId || !_dmPendingAttachment) return false;
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
  _cfg.hideReplyPreview();

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
  if (input) { input.value = ''; resizeDmInput(); _cfg.updateSendButton(); }
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
}

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
  _cfg.loadGifResults('', picker.querySelector('#dmGifGrid'));

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      _cfg.loadGifResults(search.value.trim(), picker.querySelector('#dmGifGrid'));
    }, 250);
  });
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


// ─── Stage 9 exports
export {
  dmState,
  showMessages,
  loadConversationList, openConversationWithUser,
  bootstrapDmBadge, subscribeToInbox, updateUnreadBadge,
  dmGetOrCreateSecretConv, dmIsMutualFollow,
  openNewConvModal,
  closeDmAttachMenu,
  closeDmEmojiPicker,
  closeDmGifPicker,
  copyMessageText,
  deleteMessage,
  hydrateDmInternalPreviews,
  isConvMutedForMe,
  loadMessages,
  openAddMembersModal,
  openConvActionsMenu,
  openDmGifPicker,
  renderConversationList,
  renderMessages,
  resizeDmInput,
  scrollMessagesToBottom,
  sendDmAttachment,
  sendDmGif,
  sendDmMessage,
  showDmAttachPreview,
  startEditMessage,
  startReplyToMessage,
  subscribeToThread,
  updateThreadPresenceUI,
};

// Stage 9 — DOM-state bridge for app.js code that wasn't moved
//   * Constants are exported by name (immutable values; reading via
//     ES module binding is enough)
//   * State `let` vars need getter+setter pairs because ESM imports
//     are read-only bindings — the importing module can't mutate the
//     export.
export {
  DM_QUICK_REACTIONS,
  DM_EMOJI_GROUPS,
  DM_MAX_IMAGE_BYTES,
  DM_GIPHY_KEY,
  DM_BUCKET,
};

export function get__dmAttachMenuEl() { return _dmAttachMenuEl; }
export function set__dmAttachMenuEl(val) { _dmAttachMenuEl = val; }
export function get__dmEmojiPickerEl() { return _dmEmojiPickerEl; }
export function set__dmEmojiPickerEl(val) { _dmEmojiPickerEl = val; }
export function get__dmGifPickerEl() { return _dmGifPickerEl; }
export function set__dmGifPickerEl(val) { _dmGifPickerEl = val; }
export function get__dmPendingAttachment() { return _dmPendingAttachment; }
export function set__dmPendingAttachment(val) { _dmPendingAttachment = val; }
export function get__dmSearchTimer() { return _dmSearchTimer; }
export function set__dmSearchTimer(val) { _dmSearchTimer = val; }
export function get_dmInputEl() { return dmInputEl; }
export function set_dmInputEl(val) { dmInputEl = val; }
export function get_dmSearchInput() { return dmSearchInput; }
export function set_dmSearchInput(val) { dmSearchInput = val; }

