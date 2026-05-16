/**
 * scripts/scan-messages9a-undef.js — pre-flight scan for Stage 9A
 * (Messages core extraction).
 */

const fs   = require('fs');
const path = require('path');
const j    = require('jscodeshift').withParser('babel');

const APP = path.resolve(__dirname, '../js/app.js');

// Mirror EXTRACT_FNS in extract-stage9a.js. Keep in sync.
const FNS = [
  'showMessages', 'openConversation', 'openConversationWithUser',
  'loadConversationList', 'renderConversationList',
  'renderConvEmptyStateHtml', 'renderConvItemHtml',
  'fetchUnreadCounts', 'isConvMutedForMe',
  'renderGroupAvatarHtml', 'senderUsernameInGroup',
  'loadMessages', 'renderMessages',
  'formatMessageDateStamp', 'formatStampLabel',
  'sendDmMessage', 'sendDmThumbsUp',
  'updateSendButton', 'resizeDmInput',
  'scrollMessagesToBottom', 'isDmAtBottom',
  'fetchReactionsForConversation',
  'toggleReaction', 'deleteMessage',
  'startEditMessage', 'saveEditMessage',
  'openHoverMenu', 'closeHoverMenu',
  'openReactionPicker', 'closeReactionPicker',
  'copyMessageText',
  'subscribeToThread', 'subscribeToPresenceAndTyping',
  'updateThreadPresenceUI', 'broadcastTyping',
  'subscribeToInbox',
  'computeDmUnreadTotal', 'updateUnreadBadge', 'bootstrapDmBadge',
];

// State vars co-moved with 9A.
const MOVED_STATE = new Set([
  'dmState',
  '_dmSendInFlight',
  '_renderedMessageIds',     // const Set — dedup guard for incoming realtime + render
  'DM_EMPTY_HTML',           // const template for empty-list state
  'DM_QUICK_REACTIONS',      // const array — emoji shortcuts on the reaction picker
  '__convInboxCache',        // const Map — subscribeToInbox bookkeeping
]);

// Already imported into messages.js from supabase.js or messages-dock.js
const IMPORTED = new Set([
  'supabase', 'toast', 'escHTML', 'initials', 'timeAgo',
  // From messages-dock — note: `loadConversationList` in dock conflicts
  // with our local name, so the scan should treat the LOCAL one as the
  // bound symbol. We rename the dock import to `dockLoadConversationList`
  // in the skeleton.
  'dockLoadConversationList', 'fetchConversationById',
  'loadMessagesForConversation', 'sendMessageToConversation',
  'markConversationRead', 'subscribeToConversation',
  'teardownConversationSubscription',
]);

// App.js helpers bridged via _cfg.X (rewritten by codemod at CallExpression
// callee positions).
const PLANNED_CFG = new Set([
  'hideAllMainPages', 'openProfile', 'setSidebarActive', 'stopVideoPlayer',
  'confirmDialog', 'closeAllModals', 'uploadImage',
  'formatCompact', 'linkify',
  // Stage 9B bridges — these live in app.js for now; 9B will move them
  // into messages.js and the bridge can be dropped.
  'startReplyToMessage', 'hideReplyPreview', 'showReplyPreview',
  'closeMentionDropdown', 'closeDmAttachMenu', 'closeDmGifPicker',
  'closeDmEmojiPicker', 'showDmAttachPreview', 'hideDmAttachPreview',
  'openScopedEmojiPicker', 'renderDmLinkPreview',
  'hydrateDmInternalPreviews', 'getMentionDropdown',
  'maybeShowMentionDropdown', 'renderMentionDropdown', 'selectMention',
  'isSecretUnlocked', 'promptSecretUnlock',
  // Stage 9B targets that 9A's flow still references.
  'openConvActionsMenu', 'dmIsMutualFollow',
  'secretLockIsUnlocked', 'renderSecretLockGateHtml', 'wireSecretTabHandlers',
]);

// Globals to bridge as getters (rewritten at any read position, not just calls).
const PLANNED_GLOBALS = new Set(['currentUser', 'currentProfile']);

// DOM refs that stay in app.js but messages.js re-resolves via getElementById.
const KNOWN_DOM_REFS = new Set(['messagesPage']);

const STD_GLOBALS = new Set([
  'window', 'document', 'console', 'Promise', 'Date', 'Math', 'JSON',
  'Object', 'Array', 'Set', 'Map', 'String', 'Number', 'Boolean',
  'Error', 'TypeError', 'RangeError', 'Intl',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'IntersectionObserver', 'MutationObserver', 'ResizeObserver',
  'history', 'location', 'localStorage', 'sessionStorage',
  'fetch', 'URL', 'URLSearchParams', 'FormData', 'Blob', 'File',
  'Image', 'HTMLElement', 'Node', 'Event', 'CustomEvent',
  'undefined', 'NaN', 'Infinity',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent',
  'Symbol', 'Reflect', 'Proxy', 'WeakMap', 'WeakSet',
  'process', 'Buffer', '__dirname', '__filename',
  'navigator', 'alert', 'prompt', 'confirm',
]);

function isPropertyKey(p) {
  const parent = p.parent && p.parent.node;
  if (!parent) return false;
  if (parent.type === 'MemberExpression' && parent.property === p.node && !parent.computed) return true;
  if (parent.type === 'Property' && parent.key === p.node && !parent.computed) return true;
  if (parent.type === 'ObjectProperty' && parent.key === p.node && !parent.computed) return true;
  if (parent.type === 'ImportSpecifier') return true;
  if (parent.type === 'ExportSpecifier') return true;
  if (parent.type === 'VariableDeclarator' && parent.id === p.node) return true;
  if (parent.type === 'FunctionDeclaration' && parent.id === p.node) return true;
  if (parent.type === 'FunctionExpression' && parent.id === p.node) return true;
  return false;
}

function collectLocals(funcNode) {
  const locals = new Set();
  if (funcNode.params) {
    funcNode.params.forEach(p => {
      if (p.type === 'Identifier') locals.add(p.name);
      if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') locals.add(p.left.name);
      if (p.type === 'ObjectPattern') {
        p.properties.forEach(pr => {
          if (pr.value && pr.value.type === 'Identifier') locals.add(pr.value.name);
          else if (pr.key && pr.key.type === 'Identifier') locals.add(pr.key.name);
        });
      }
      if (p.type === 'ArrayPattern') {
        p.elements.forEach(el => { if (el && el.type === 'Identifier') locals.add(el.name); });
      }
    });
  }
  j(funcNode).find(j.VariableDeclarator).forEach(vp => {
    if (vp.node.id.type === 'Identifier') locals.add(vp.node.id.name);
    if (vp.node.id.type === 'ObjectPattern') {
      vp.node.id.properties.forEach(prop => {
        if (prop.value && prop.value.type === 'Identifier') locals.add(prop.value.name);
        else if (prop.key && prop.key.type === 'Identifier') locals.add(prop.key.name);
      });
    }
    if (vp.node.id.type === 'ArrayPattern') {
      vp.node.id.elements.forEach(el => { if (el && el.type === 'Identifier') locals.add(el.name); });
    }
  });
  j(funcNode).find(j.FunctionDeclaration).forEach(fp => {
    if (fp.node.id) locals.add(fp.node.id.name);
  });
  j(funcNode).find(j.ArrowFunctionExpression).forEach(ap => {
    (ap.node.params || []).forEach(p => {
      if (p.type === 'Identifier') locals.add(p.name);
      if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') locals.add(p.left.name);
      if (p.type === 'ObjectPattern') {
        p.properties.forEach(pr => {
          if (pr.value && pr.value.type === 'Identifier') locals.add(pr.value.name);
          else if (pr.key && pr.key.type === 'Identifier') locals.add(pr.key.name);
        });
      }
      if (p.type === 'ArrayPattern') {
        p.elements.forEach(el => { if (el && el.type === 'Identifier') locals.add(el.name); });
      }
    });
  });
  j(funcNode).find(j.FunctionExpression).forEach(fp => {
    (fp.node.params || []).forEach(p => {
      if (p.type === 'Identifier') locals.add(p.name);
    });
  });
  j(funcNode).find(j.CatchClause).forEach(cp => {
    if (cp.node.param && cp.node.param.type === 'Identifier') locals.add(cp.node.param.name);
  });
  return locals;
}

const EXTRACTED = new Set(FNS);

function findFunction(name, root) {
  // Check export-wrapped first
  const exported = root.find(j.ExportNamedDeclaration).filter(p => {
    const d = p.node.declaration;
    return d && d.type === 'FunctionDeclaration' && d.id && d.id.name === name;
  });
  if (exported.size() > 0) return exported.get(0).node.declaration;

  // Fallback: bare FunctionDeclaration
  const found = root.find(j.FunctionDeclaration, { id: { name } });
  if (found.size() === 0) return null;
  return found.get(0).node;
}

function scanFunction(name, root) {
  const node = findFunction(name, root);
  if (!node) return { name, status: 'NOT_FOUND', unbound: [] };
  const locals = collectLocals(node);
  const unbound = [];
  j(node).find(j.Identifier).forEach(p => {
    const id = p.node.name;
    if (isPropertyKey(p)) return;
    if (locals.has(id)) return;
    if (EXTRACTED.has(id)) return;
    if (MOVED_STATE.has(id)) return;
    if (PLANNED_CFG.has(id)) return;
    if (PLANNED_GLOBALS.has(id)) return;
    if (IMPORTED.has(id)) return;
    if (KNOWN_DOM_REFS.has(id)) return;
    if (STD_GLOBALS.has(id)) return;
    if (id === name) return;
    if (id === '_cfg') return;
    if (id === 'arguments') return;
    unbound.push(id);
  });
  return { name, status: 'OK', unbound };
}

function main() {
  console.log('[scan-9a] reading js/app.js …');
  const src = fs.readFileSync(APP, 'utf8');
  const root = j(src);

  const results = FNS.map(n => scanFunction(n, root));
  const notFound = results.filter(r => r.status === 'NOT_FOUND');
  const allHits = {};

  results.filter(r => r.status === 'OK').forEach(r => {
    for (const id of r.unbound) {
      if (!allHits[id]) allHits[id] = { count: 0, fns: new Set() };
      allHits[id].count++;
      allHits[id].fns.add(r.name);
    }
  });

  if (notFound.length) {
    console.log('\n[scan-9a] FUNCTIONS NOT FOUND — fix EXTRACT_FNS:');
    notFound.forEach(r => console.log(`  ✗ ${r.name}`));
  }

  console.log('\n[scan-9a] Unbound identifiers (after planned bridges) ranked by frequency:');
  const sorted = Object.entries(allHits).sort((a, b) => b[1].count - a[1].count);
  if (!sorted.length) {
    console.log('  ✓ none — extraction set is clean.');
  } else {
    sorted.forEach(([id, info]) => {
      const fnsList = [...info.fns].slice(0, 4).join(', ') + (info.fns.size > 4 ? ` (+${info.fns.size - 4} more)` : '');
      console.log(`  ${String(info.count).padStart(3)}×  ${id.padEnd(36)}  ← ${fnsList}`);
    });
  }

  console.log('\n[scan-9a] Per-function unbound counts:');
  const ranked = results.filter(r => r.status === 'OK')
    .map(r => ({ name: r.name, uniq: new Set(r.unbound).size, total: r.unbound.length }))
    .sort((a, b) => b.uniq - a.uniq);
  ranked.forEach(r => {
    if (r.uniq === 0) return;
    console.log(`  ${String(r.uniq).padStart(3)} uniq / ${String(r.total).padStart(3)} total  ${r.name}`);
  });
  console.log('\n[scan-9a] done.');
}

main();
