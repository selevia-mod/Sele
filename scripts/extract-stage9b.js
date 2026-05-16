/**
 * scripts/extract-stage9b.js — jscodeshift codemod for Stage 9B
 * (Messages extras extraction).
 *
 * Moves the rest of the DM page into js/messages.js:
 *   • Mention dropdown
 *   • Secret-lock IIFE + helpers
 *   • Reply state
 *   • Conv menu + group admin
 *   • Global search renderers
 *   • Attach menu + GIF picker + emoji picker
 *   • DM link preview (parseSelebox internal + renderInternal + hydrate)
 *   • openNewConvModal, openSecretChatPicker, dmIsMutualFollow,
 *     dmGetOrCreateSecretConv
 *
 * Handles export wrapper on openScopedEmojiPicker (same path as
 * Stage 8B/9A openBookDetail/showMessages/openConversation).
 *
 * SECRET_LOCK IIFE is moved as a `VariableDeclaration` (extracted as
 * state). Member-access reads like `SECRET_LOCK.isUnlocked()` are
 * untouched by the codemod (it doesn't rewrite member access on
 * unknown identifiers), so they keep working once SECRET_LOCK is in
 * the same module.
 *
 * Usage:
 *   node scripts/extract-stage9b.js
 */

const fs = require('fs');
const path = require('path');
const jscodeshift = require('jscodeshift').withParser('babel');

const APP = path.resolve(__dirname, '../js/app.js');
const MSG = path.resolve(__dirname, '../js/messages.js');

// ── Stage 9B extraction targets ─────────────────────────────────────────

const EXTRACT_FNS = [
  // Mention dropdown
  'getMentionDropdown', 'closeMentionDropdown',
  'positionMentionDropdown', 'maybeShowMentionDropdown',
  'renderMentionDropdown', 'selectMention',

  // Secret lock
  'wireSecretTabHandlers', 'renderSecretLockGateHtml',

  // Reply state
  'startReplyToMessage', 'showReplyPreview', 'hideReplyPreview',

  // Conv menu
  'closeConvMenu', 'openConvActionsMenu',
  'toggleConvMute', 'archiveConversation',
  'confirmDeleteConversation', 'confirmLeaveGroup',
  'showGroupMembersDialog', 'promptRenameGroup',
  'handleGroupAvatarPicked',

  // Group admin
  'openAddMembersModal', 'kickGroupMember',
  'refreshActiveConvMembers',

  // Secret conv helpers + new conv
  'dmIsMutualFollow', 'dmGetOrCreateSecretConv',
  'openSecretChatPicker', 'openNewConvModal',

  // Global search renderers
  'renderGlobalSearchResults', 'highlightSearchMatch',

  // Attach menu
  'closeDmAttachMenu', 'fileToDataUrl', 'compressImageToJpeg',
  'showDmAttachPreview', 'hideDmAttachPreview', 'formatBytes',
  'sendDmAttachment',

  // GIF picker
  'closeDmGifPicker', 'openDmGifPicker', 'loadGifResults', 'sendDmGif',

  // Emoji picker (openScopedEmojiPicker is exported — codemod handles wrap)
  'closeDmEmojiPicker', 'openScopedEmojiPicker', 'insertEmojiIntoComposer',

  // DM link preview
  'parseSeleboxInternalUrl', 'renderInternalPreviewCard',
  'renderDmLinkPreview', 'hydrateDmInternalPreviews',
];

const EXTRACT_WINDOW = [];

const EXTRACT_STATE = [
  // SECRET_LOCK IIFE — `const SECRET_LOCK = (() => { ... })()`. Treated
  // as a top-level VariableDeclaration. The IIFE evaluates at module-
  // load time on the messages.js side after extraction, same as it
  // did in app.js. Internal state (KEY_HASH localStorage key,
  // backgroundedAt closure var) stays inside the IIFE; nothing external
  // mutates it.
  'SECRET_LOCK',
  // DM link-preview cache
  '_dmInternalPreviewCache',
  // Search debounce timer
  '_dmSearchTimer',
  // Attach pipeline state
  '_dmPendingAttachment',
  '_dmAttachMenuEl',
  '_dmGifPickerEl',
  '_dmEmojiPickerEl',
  '_dmEmojiPickerTrigger',
];

// Remaining app.js helpers that 9B code still calls into. After 9B
// lands, the only NEW _cfg entry we need on messages.js is
// firstUrlInText (used by renderDmLinkPreview for URL extraction —
// shared with the general feed renderLinkPreview that stays in app.js).
const CONFIG_DEPS = new Set([
  // From 9A (still needed)
  'hideAllMainPages', 'openProfile', 'setSidebarActive', 'stopVideoPlayer',
  'confirmDialog', 'closeAllModals', 'uploadImage',
  'formatCompact', 'linkify',
  // New for 9B
  'firstUrlInText',
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
  console.log('[stage9b] loading js/app.js + js/messages.js …');
  const app = loadAst(APP);
  let msg;
  try {
    msg = loadAst(MSG);
  } catch (e) {
    console.error('messages.js missing — run Stage 9A first.');
    process.exit(1);
  }

  const MARKER = '// ─── Stage 9A exports ─────────────────────────────────────────────';
  if (!msg.src.includes(MARKER)) {
    console.error(`messages.js is missing the Stage 9A exports marker.`);
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

  // 2. State vars (including SECRET_LOCK IIFE).
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

  // ── Compose messages.js append block — insert ABOVE the Stage 9A
  // exports marker so the exports list stays at the bottom. ──
  let appendBlock = '\n// ════════════════════════════════════════════════════════════════════════\n';
  appendBlock += '// Stage 9B — Messages extras (appended by extract-stage9b.js)\n';
  appendBlock += '// Secret lock IIFE + emoji picker + attach menu + GIF picker + reply\n';
  appendBlock += '// state + conv menu + group admin + global search + mention dropdown +\n';
  appendBlock += '// DM link preview.\n';
  appendBlock += '// ════════════════════════════════════════════════════════════════════════\n\n';
  appendBlock += '// ─── Module state (9B) ────────────────────────────────────────────\n';
  extracted.filter(x => x.kind === 'state').forEach(x => {
    appendBlock += x.code + '\n';
  });
  appendBlock += '\n// ─── Extracted functions (9B) ─────────────────────────────────────\n\n';
  extracted.filter(x => x.kind === 'fn').forEach(x => {
    appendBlock += x.code + '\n\n';
  });

  const allExports = extracted.filter(x => x.kind === 'fn').map(x => x.name);
  appendBlock += '\n// ─── Stage 9B exports ─────────────────────────────────────────────\nexport {\n';
  allExports.forEach(n => { appendBlock += `  ${n},\n`; });
  appendBlock += '};\n';

  const newMsgSrc = msg.src.replace(MARKER, appendBlock + '\n' + MARKER);
  fs.writeFileSync(MSG, newMsgSrc);
  console.log(`[write] messages.js: ${newMsgSrc.length} bytes`);

  const newAppSrc = app.root.toSource();
  fs.writeFileSync(APP, newAppSrc);
  console.log(`[write] app.js: ${newAppSrc.length} bytes`);

  console.log('\n[stage9b] extraction complete.');
  console.log('Next steps:');
  console.log('  1. Drop the Stage 9B bridges from initMessages({...}) in app.js');
  console.log('  2. Rewrite intra-module _cfg.X(...) calls in messages.js to bare X(...)');
  console.log('     for the moved 9B function names (sed pass over each name).');
  console.log('  3. node --check both files + smoke test in browser');
}

main();
