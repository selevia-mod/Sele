/**
 * scripts/extract-stage9a.js — jscodeshift codemod for Stage 9A
 * (Messages core extraction).
 *
 * Same machinery as extract-stage8b.js — handles `export async function`
 * wrappers, runs CONFIG_DEPS rewrites at CallExpression callee positions,
 * GLOBAL_GETTERS at any read position. Writes both js/app.js and
 * js/messages.js.
 *
 * Usage:
 *   node scripts/extract-stage9a.js
 */

const fs = require('fs');
const path = require('path');
const jscodeshift = require('jscodeshift').withParser('babel');

const APP = path.resolve(__dirname, '../js/app.js');
const MSG = path.resolve(__dirname, '../js/messages.js');

// ── Stage 9A extraction targets ─────────────────────────────────────────

const EXTRACT_FNS = [
  // Page entry / nav
  'showMessages', 'openConversation', 'openConversationWithUser',

  // Conversation list
  'loadConversationList', 'renderConversationList',
  'renderConvEmptyStateHtml', 'renderConvItemHtml',
  'fetchUnreadCounts', 'isConvMutedForMe',
  'renderGroupAvatarHtml', 'senderUsernameInGroup',

  // Thread render + send
  'loadMessages', 'renderMessages',
  'formatMessageDateStamp', 'formatStampLabel',
  'sendDmMessage', 'sendDmThumbsUp',
  'updateSendButton', 'resizeDmInput',
  'scrollMessagesToBottom', 'isDmAtBottom',
  'fetchReactionsForConversation',

  // Edit/delete/react/copy/hover/picker
  'toggleReaction', 'deleteMessage',
  'startEditMessage', 'saveEditMessage',
  'openHoverMenu', 'closeHoverMenu',
  'openReactionPicker', 'closeReactionPicker',
  'copyMessageText',

  // Realtime
  'subscribeToThread', 'subscribeToPresenceAndTyping',
  'updateThreadPresenceUI', 'broadcastTyping',
  'subscribeToInbox',

  // Inbox badge
  'computeDmUnreadTotal', 'updateUnreadBadge', 'bootstrapDmBadge',
];

const EXTRACT_WINDOW = [];

const EXTRACT_STATE = [
  'dmState',
  '_dmSendInFlight',
  '_renderedMessageIds',
  'DM_EMPTY_HTML',
  'DM_QUICK_REACTIONS',
  '__convInboxCache',
];

const CONFIG_DEPS = new Set([
  'hideAllMainPages', 'openProfile', 'setSidebarActive', 'stopVideoPlayer',
  'confirmDialog', 'closeAllModals', 'uploadImage',
  'formatCompact', 'linkify',
  // Stage 9B targets bridged for 9A.
  'startReplyToMessage', 'hideReplyPreview', 'showReplyPreview',
  'closeMentionDropdown', 'closeDmAttachMenu', 'closeDmGifPicker',
  'closeDmEmojiPicker', 'showDmAttachPreview', 'hideDmAttachPreview',
  'openScopedEmojiPicker', 'renderDmLinkPreview',
  'hydrateDmInternalPreviews', 'getMentionDropdown',
  'maybeShowMentionDropdown', 'renderMentionDropdown', 'selectMention',
  'secretLockIsUnlocked', 'renderSecretLockGateHtml',
  'wireSecretTabHandlers', 'promptSecretUnlock',
  'openConvActionsMenu', 'dmIsMutualFollow',
]);

const GLOBAL_GETTERS = {
  currentUser:    '_cfg.getCurrentUser()',
  currentProfile: '_cfg.getCurrentProfile()',
};

// ── Helpers ─────────────────────────────────────────────────────────────

function loadAst(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  return { src, root: jscodeshift(src) };
}

function rewriteIdentifiers(root, locals) {
  root.find(jscodeshift.Identifier).forEach(p => {
    const name = p.node.name;
    const parent = p.parent && p.parent.node;
    if (!parent) return;
    if (parent.type === 'MemberExpression' && parent.property === p.node && !parent.computed) return;
    if (parent.type === 'Property' && parent.key === p.node && !parent.computed) return;
    if (parent.type === 'ObjectProperty' && parent.key === p.node && !parent.computed) return;
    if (parent.type === 'ImportSpecifier') return;
    if (parent.type === 'ExportSpecifier') return;
    if (parent.type === 'VariableDeclarator' && parent.id === p.node) return;
    if (parent.type === 'FunctionDeclaration' && parent.id === p.node) return;
    if (parent.type === 'FunctionExpression' && parent.id === p.node) return;

    if (GLOBAL_GETTERS[name] && !locals.has(name)) {
      const getterName = GLOBAL_GETTERS[name].split('.')[1].replace('()', '');
      const callExpr = jscodeshift.callExpression(
        jscodeshift.memberExpression(
          jscodeshift.identifier('_cfg'),
          jscodeshift.identifier(getterName)
        ),
        []
      );
      p.replace(callExpr);
      return;
    }

    if (CONFIG_DEPS.has(name) && !locals.has(name)) {
      if (parent.type === 'CallExpression' && parent.callee === p.node) {
        p.replace(
          jscodeshift.memberExpression(
            jscodeshift.identifier('_cfg'),
            jscodeshift.identifier(name)
          )
        );
      }
    }
  });
}

function collectLocals(funcNode) {
  const locals = new Set();
  if (funcNode.params) {
    funcNode.params.forEach(p => {
      if (p.type === 'Identifier') locals.add(p.name);
      if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') {
        locals.add(p.left.name);
      }
      if (p.type === 'ObjectPattern') {
        p.properties.forEach(pr => {
          if (pr.value && pr.value.type === 'Identifier') locals.add(pr.value.name);
          else if (pr.key && pr.key.type === 'Identifier') locals.add(pr.key.name);
        });
      }
      if (p.type === 'ArrayPattern') {
        p.elements.forEach(el => {
          if (el && el.type === 'Identifier') locals.add(el.name);
        });
      }
    });
  }
  jscodeshift(funcNode).find(jscodeshift.VariableDeclarator).forEach(vp => {
    if (vp.node.id.type === 'Identifier') locals.add(vp.node.id.name);
  });
  jscodeshift(funcNode).find(jscodeshift.FunctionDeclaration).forEach(fp => {
    if (fp.node.id) locals.add(fp.node.id.name);
  });
  return locals;
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  console.log('[stage9a] loading js/app.js + js/messages.js …');
  const app = loadAst(APP);
  let msg;
  try {
    msg = loadAst(MSG);
  } catch (e) {
    console.error('messages.js missing — create the Stage 9A skeleton first.');
    process.exit(1);
  }

  const MARKER = '// Extracted state + functions are appended below by the Stage 9A script.';
  if (!msg.src.includes(MARKER)) {
    console.error(`messages.js is missing the anchor marker: "${MARKER}"`);
    process.exit(1);
  }

  const extracted = [];

  // 1. Functions — handle export-wrapped declarations specially.
  EXTRACT_FNS.forEach(name => {
    const exported = app.root.find(jscodeshift.ExportNamedDeclaration).filter(p => {
      const d = p.node.declaration;
      return d && d.type === 'FunctionDeclaration' && d.id && d.id.name === name;
    });
    if (exported.size() > 0) {
      const exportNode = exported.get(0).node;
      const funcNode = exportNode.declaration;
      const locals = collectLocals(funcNode);
      rewriteIdentifiers(jscodeshift(funcNode), locals);
      const code = jscodeshift(funcNode).toSource();
      extracted.push({ kind: 'fn', name, code, wasExported: true });
      exported.remove();
      console.log(`  [fn] extracted ${name} (export-wrapped, ${code.length} chars)`);
      return;
    }

    const found = app.root.find(jscodeshift.FunctionDeclaration, { id: { name } });
    if (found.size() === 0) {
      console.warn(`  [fn] NOT FOUND: ${name}`);
      return;
    }
    const node = found.get(0).node;
    const locals = collectLocals(node);
    rewriteIdentifiers(jscodeshift(node), locals);
    const code = jscodeshift(node).toSource();
    extracted.push({ kind: 'fn', name, code, wasExported: false });
    found.remove();
    console.log(`  [fn] extracted ${name} (${code.length} chars)`);
  });

  // 2. State vars
  EXTRACT_STATE.forEach(name => {
    const found = app.root.find(jscodeshift.VariableDeclaration).filter(p => {
      if (p.parent.node.type !== 'Program') return false;
      return p.node.declarations.some(d =>
        d.id.type === 'Identifier' && d.id.name === name
      );
    });
    if (found.size() === 0) {
      console.warn(`  [state] NOT FOUND: ${name}`);
      return;
    }
    const node = found.get(0).node;
    const code = jscodeshift(node).toSource();
    extracted.push({ kind: 'state', name, code });
    found.remove();
    console.log(`  [state] extracted ${name} (${code.length} chars)`);
  });

  // ── Compose messages.js append block ──
  let appendBlock = '\n\n// ─── Module state ─────────────────────────────────────────────────\n';
  extracted.filter(x => x.kind === 'state').forEach(x => {
    appendBlock += x.code + '\n';
  });
  appendBlock += '\n// ─── Extracted functions ──────────────────────────────────────────\n\n';
  extracted.filter(x => x.kind === 'fn').forEach(x => {
    appendBlock += x.code + '\n\n';
  });

  const allExports = extracted.filter(x => x.kind === 'fn').map(x => x.name);
  appendBlock += '\n// ─── Stage 9A exports ─────────────────────────────────────────────\nexport {\n';
  allExports.forEach(n => { appendBlock += `  ${n},\n`; });
  appendBlock += '};\n';

  const MARKER_LINE = '// ════════════════════════════════════════════════════════════════════════\n// Extracted state + functions are appended below by the Stage 9A script.\n// ════════════════════════════════════════════════════════════════════════\n';
  if (!msg.src.includes(MARKER_LINE)) {
    console.error('messages.js marker block not found exactly — check the skeleton header.');
    process.exit(1);
  }
  const newMsgSrc = msg.src.replace(MARKER_LINE, MARKER_LINE + appendBlock);
  fs.writeFileSync(MSG, newMsgSrc);
  console.log(`[write] messages.js: ${newMsgSrc.length} bytes`);

  const newAppSrc = app.root.toSource();
  fs.writeFileSync(APP, newAppSrc);
  console.log(`[write] app.js: ${newAppSrc.length} bytes`);

  console.log('\n[stage9a] extraction complete.');
  console.log('Next steps:');
  console.log('  1. Add the import + initMessages({...}) call in app.js');
  console.log('  2. node --check js/app.js && node --check js/messages.js');
  console.log('  3. Smoke test Messages page in browser');
}

main();
