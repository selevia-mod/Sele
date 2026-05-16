/**
 * scripts/extract-stage5.js — jscodeshift codemod for Stage 5 (Feed extraction).
 *
 * Why AST instead of regex:
 *   * Regex doesn't understand JS structure — it conflated `===` with `=`,
 *     stripped `async` from `async function`, mangled `++` operators,
 *     and broke string literals containing identifier names. Stages
 *     7B/8/9 burned ~12 hours of iteration on these traps.
 *   * AST tools parse the file into nodes (FunctionDeclaration,
 *     Identifier, StringLiteral). The codemod sees structure, not
 *     characters. Can't fall into the regex traps.
 *
 * What this script does:
 *   1. Parse js/app.js into AST.
 *   2. For each name in EXTRACT_FNS / EXTRACT_WINDOW / EXTRACT_STATE:
 *      - Find the matching node, remove it from the AST.
 *      - Add it to the destination AST (js/feed.js).
 *   3. Apply config-injection rewrites (currentUser → _cfg.getCurrentUser(),
 *      bare app.js helper calls → _cfg.X). These rewrites only touch
 *      Identifier nodes — they cannot affect string literals or operators.
 *   4. Print both ASTs back to source files using Recast (preserves
 *      formatting where possible).
 *
 * Usage:
 *   node scripts/extract-stage5.js
 *
 * The script writes BOTH js/app.js AND js/feed.js. It's idempotent
 * up to the AST mutations.
 */

const fs = require('fs');
const path = require('path');
const jscodeshift = require('jscodeshift').withParser('babel');

const APP = path.resolve(__dirname, '../js/app.js');
const FED = path.resolve(__dirname, '../js/feed.js');

// ── Stage 5 extraction targets ──────────────────────────────────────────

// Functions: extracted by exact name. AST handles `function X` and
// `async function X` automatically — no need to split them.
const EXTRACT_FNS = [
  'loadStories',
  '_prependFreshPosts',
  '_applyNewPostsBuffer',
  '_renderNewPostsPill',
  '_pollForNewPosts',
  '_buildAndExecFeedQuery',
  '_fetchHybridFeedPage',
  '_wireUpNewPosts',
  'setupCollapsibleBodies',
  'loadMoreFeed',
  'attachHlsToPostVideo',
  'triggerPostLazyLoad',
  'flushPostLazyLoad',
  'renderPost',
  '_renderHybridBookCarousel',
  '_renderHybridVideoCard',
  'togglePinPost',
  'shouldHidePost',
  'closePostActionMenu',
  'hidePostFromFeed',
  '_closePostDetailModal',
];

// `window.X = function() {...}` style assignments. Extracted as
// ExpressionStatement nodes whose expression is `AssignmentExpression`
// with left = `window.X`. We convert them into regular function
// declarations in feed.js, then re-attach to window in app.js after
// the import (preserves inline onclick wiring in rendered HTML).
const EXTRACT_WINDOW = [
  'loadFeed',
  'deletePost',
  'openPostActionMenu',
  'repostPost',
  'toggleShareMenu',
  'shareTo',
];

// State vars: VariableDeclaration nodes by name.
const EXTRACT_STATE = [
  '_feedVideoObserver',
  '_feedPostObserver',
  '_feedMode',
  '_realtimeRefreshTimer',
  '_newPostsBuffer',
  '_feedHybridCursor',
  'FEED_SELECT', // multi-line const — AST handles regardless of length
];

// App.js helpers that should be bridged to `_cfg.X` inside extracted code
const CONFIG_DEPS = new Set([
  'hideAllMainPages', 'setSidebarActive', 'openProfile', 'openBookDetail',
  'openChapterReader', 'playVideo', 'openPostDetail', 'closeAllModals',
  'confirmDialog', 'uploadImage', 'isUnlocked', 'resolveUnlockCost',
  'openUnlockDialog', 'tickGoal', 'tickGoalUnique', 'loadReactions',
  'loadCommentCount', 'loadComments', 'formatCompact', 'formatDuration',
  'flushReadClose', 'showStore', 'getActiveSearchQuery',
]);

// Globals to bridge as getters
const GLOBAL_GETTERS = {
  currentUser: '_cfg.getCurrentUser()',
  currentProfile: '_cfg.getCurrentProfile()',
};

// ── Helpers ─────────────────────────────────────────────────────────────

function loadAst(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  return { src, root: jscodeshift(src) };
}

function rewriteIdentifiers(root, locals) {
  // Walk every Identifier node. If its name matches a CONFIG_DEPS or
  // GLOBAL_GETTERS entry AND it's NOT being used as an object property
  // key OR an import/export specifier, rewrite it.
  //
  // Skipping locals: if the function declares its own `currentUser`
  // parameter or local const, that local shadows the global — don't
  // rewrite those.
  root.find(jscodeshift.Identifier).forEach(p => {
    const name = p.node.name;

    // Skip if this Identifier is a property name (obj.X), property key
    // ({X: ...}), or import/export specifier — those aren't variable refs.
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

    // GLOBAL_GETTERS: rewrite to a CallExpression on member.
    if (GLOBAL_GETTERS[name] && !locals.has(name)) {
      // Create an expression like `_cfg.getCurrentUser()`
      const callExpr = jscodeshift.callExpression(
        jscodeshift.memberExpression(
          jscodeshift.identifier('_cfg'),
          jscodeshift.identifier(GLOBAL_GETTERS[name].split('.')[1].replace('()', ''))
        ),
        []
      );
      p.replace(callExpr);
      return;
    }

    // CONFIG_DEPS: rewrite ONLY when used as a callee of CallExpression
    // (so we bridge function calls but don't touch random identifier reads).
    if (CONFIG_DEPS.has(name) && !locals.has(name)) {
      if (parent.type === 'CallExpression' && parent.callee === p.node) {
        // Replace `X(...)` with `_cfg.X(...)` — i.e. wrap callee in
        // member expression on _cfg.
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
  // Names that this function declares locally (params + var/let/const inside).
  const locals = new Set();
  if (funcNode.params) {
    funcNode.params.forEach(p => {
      if (p.type === 'Identifier') locals.add(p.name);
      // (Destructured params would need recursion; skipping for v1.)
    });
  }
  // Walk the body collecting VariableDeclarator names + nested function names.
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
  console.log('[stage5] loading js/app.js + js/feed.js …');
  const app = loadAst(APP);
  let fed;
  try {
    fed = loadAst(FED);
  } catch (e) {
    console.error('feed.js missing — create it first via the Stage 5 skeleton.');
    process.exit(1);
  }

  // Anchor: where in feed.js to append extracted code (a marker comment).
  const FED_MARKER = '// Extracted state + functions are appended below by the Stage 5 script.';
  if (!fed.src.includes(FED_MARKER)) {
    console.error(`feed.js is missing the anchor marker: "${FED_MARKER}"`);
    process.exit(1);
  }

  // Collect extracted nodes in source-order so feed.js mirrors original layout.
  const extracted = []; // { kind: 'fn'|'state'|'window', name, code, originalNode }

  // 1. Functions (FunctionDeclaration by name)
  EXTRACT_FNS.forEach(name => {
    const found = app.root.find(jscodeshift.FunctionDeclaration, {
      id: { name }
    });
    if (found.size() === 0) {
      console.warn(`[fn] NOT FOUND: ${name}`);
      return;
    }
    const node = found.get(0).node;
    const locals = collectLocals(node);
    // Apply rewrites scoped to this function
    rewriteIdentifiers(jscodeshift(node), locals);
    const code = jscodeshift(node).toSource();
    extracted.push({ kind: 'fn', name, code });
    found.remove();
    console.log(`  [fn] extracted ${name} (${code.length} chars)`);
  });

  // 2. State vars (top-level VariableDeclarator by name)
  EXTRACT_STATE.forEach(name => {
    const found = app.root.find(jscodeshift.VariableDeclaration).filter(p => {
      // Top-level only
      if (p.parent.node.type !== 'Program') return false;
      return p.node.declarations.some(d =>
        d.id.type === 'Identifier' && d.id.name === name
      );
    });
    if (found.size() === 0) {
      console.warn(`[state] NOT FOUND: ${name}`);
      return;
    }
    const node = found.get(0).node;
    const code = jscodeshift(node).toSource();
    extracted.push({ kind: 'state', name, code });
    found.remove();
    console.log(`  [state] extracted ${name} (${code.length} chars)`);
  });

  // 3. window.X = func/arrow assignments
  EXTRACT_WINDOW.forEach(name => {
    const found = app.root.find(jscodeshift.ExpressionStatement).filter(p => {
      const e = p.node.expression;
      return (
        e &&
        e.type === 'AssignmentExpression' &&
        e.operator === '=' &&
        e.left.type === 'MemberExpression' &&
        e.left.object.type === 'Identifier' &&
        e.left.object.name === 'window' &&
        e.left.property.type === 'Identifier' &&
        e.left.property.name === name
      );
    });
    if (found.size() === 0) {
      console.warn(`[window] NOT FOUND: window.${name}`);
      return;
    }
    const node = found.get(0).node;
    const expr = node.expression;
    // Convert `window.X = async function (args) {...}` or
    // `window.X = (args) => {...}` into a regular FunctionDeclaration.
    let funcDecl;
    if (expr.right.type === 'FunctionExpression') {
      funcDecl = jscodeshift.functionDeclaration(
        jscodeshift.identifier(name),
        expr.right.params,
        expr.right.body
      );
      funcDecl.async = expr.right.async;
    } else if (expr.right.type === 'ArrowFunctionExpression') {
      // Arrow body might be an Expression — wrap in BlockStatement if so.
      const body = expr.right.body.type === 'BlockStatement'
        ? expr.right.body
        : jscodeshift.blockStatement([
            jscodeshift.returnStatement(expr.right.body)
          ]);
      funcDecl = jscodeshift.functionDeclaration(
        jscodeshift.identifier(name),
        expr.right.params,
        body
      );
      funcDecl.async = expr.right.async;
    } else {
      console.warn(`[window] unsupported RHS for window.${name}: ${expr.right.type}`);
      return;
    }
    const locals = collectLocals(funcDecl);
    rewriteIdentifiers(jscodeshift(funcDecl), locals);
    const code = jscodeshift(funcDecl).toSource();
    extracted.push({ kind: 'window', name, code });
    found.remove();
    console.log(`  [window] extracted window.${name} → function ${name} (${code.length} chars)`);
  });

  // ── Compose feed.js append block ──
  let appendBlock = '\n\n// ─── Module state ────────────────────────────────────────────────\n';
  extracted.filter(x => x.kind === 'state').forEach(x => {
    appendBlock += x.code + '\n';
  });
  appendBlock += '\n// ─── Extracted functions ─────────────────────────────────────────\n\n';
  extracted.filter(x => x.kind === 'fn').forEach(x => {
    appendBlock += x.code + '\n\n';
  });
  appendBlock += '\n// ─── Functions previously attached to window (inline onclick handlers) ───\n\n';
  extracted.filter(x => x.kind === 'window').forEach(x => {
    appendBlock += x.code + '\n\n';
  });

  // Re-export everything app.js needs
  const allExports = [
    ...extracted.filter(x => x.kind === 'fn').map(x => x.name),
    ...extracted.filter(x => x.kind === 'window').map(x => x.name),
  ];
  appendBlock += '\n// ─── Stage 5 exports ─────────────────────────────────────────────\nexport {\n';
  allExports.forEach(n => { appendBlock += `  ${n},\n`; });
  appendBlock += '};\n';

  // Write feed.js (insert after the marker)
  const newFedSrc = fed.src.replace(
    FED_MARKER + '\n// ════════════════════════════════════════════════════════════════════════\n',
    FED_MARKER + '\n// ════════════════════════════════════════════════════════════════════════' + appendBlock
  );
  fs.writeFileSync(FED, newFedSrc);
  console.log(`[write] feed.js: ${newFedSrc.length} bytes`);

  // Write app.js
  const newAppSrc = app.root.toSource();
  fs.writeFileSync(APP, newAppSrc);
  console.log(`[write] app.js: ${newAppSrc.length} bytes`);

  console.log('\n[stage5] extraction complete.');
  console.log('Next: re-add the imports + initFeed call + window re-attaches in app.js,');
  console.log('then run `node --check js/app.js` and `node --check js/feed.js`.');
}

main();
