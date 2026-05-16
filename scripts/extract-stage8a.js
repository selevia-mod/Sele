/**
 * scripts/extract-stage8a.js — jscodeshift codemod for Stage 8A
 * (Books listing/discovery extraction).
 *
 * Mirror of extract-stage5.js. Reads js/app.js, walks the AST, and
 * relocates the Stage 8A function set + supporting state/consts into
 * js/books.js. All app.js-owned helpers that the moved code calls into
 * are rewritten to `_cfg.X` (which books.js wires up via initBooks()).
 *
 * Why AST not regex:
 *   Single-character substitutions kept eating arrow-function param `t`s
 *   and `b`s, breaking sort callbacks. AST sees structure, never identifier
 *   look-alikes inside strings or operators.
 *
 * Usage:
 *   node scripts/extract-stage8a.js
 *
 * The script writes both js/app.js AND js/books.js. It is idempotent
 * up to the AST mutations — re-running after a successful pass finds
 * nothing left to move.
 */

const fs = require('fs');
const path = require('path');
const jscodeshift = require('jscodeshift').withParser('babel');

const APP   = path.resolve(__dirname, '../js/app.js');
const BOOKS = path.resolve(__dirname, '../js/books.js');

// ── Stage 8A extraction targets ─────────────────────────────────────────

const EXTRACT_FNS = [
  // Page entry + tab dispatcher
  'showBook', 'loadBooksTab',

  // For You tab
  '_loadForYouTab', '_renderBookSection',
  '_fetchHiddenGems', '_fetchQuickReads',
  '_fetchWeeklyFeaturedWithFallback', '_fetchRecommendedForUser',

  // Ranking tab
  '_loadRankingTab', '_renderRankGenreChips',
  '_loadRankingForGenre', '_renderRankCard',

  // Discover tab
  '_loadDiscoverTab', '_loadDiscoverGenreRow',

  // Reading List tab
  '_loadCollectionTab', '_loadReadingListTab',

  // v2 book card (shared across tabs)
  '_renderBookCardV2',

  // See-All sub-view
  '_openBookSeeAll', '_loadMoreSeeAllBooks', '_setupSeeAllInfiniteScroll',

  // Filter / search
  'applyBookFilter', 'searchBooks', 'runBookSearch', 'renderWriterChannelCard',

  // Normalisation + fetch
  '_normalizeBookRow', '_normalizeBookRows',
  'fetchSupabaseBooks', 'fetchBooksServerSearch',

  // Card renderer (legacy path — used by See All grid & search results)
  'renderBookCard',

  // Genre helpers
  'prettyGenre',

  // Recommendation rail
  'getUserBookTaste', 'renderBookChips',
  'loadBookRecommendations', 'renderBookRecsRail',
];

// No window-assigned books functions in the listing surface — the
// HTML uses data-attribute event delegation, not inline onclick.
const EXTRACT_WINDOW = [];

// State vars + consts to move. Order doesn't matter — the codemod
// preserves source order in the appended block, but consts will end
// up grouped together as a side effect of source layout in app.js.
const EXTRACT_STATE = [
  // raw state
  'allBooksCache', 'allBooksRaw',
  'bookGenreFilter', 'bookSortBy', 'activeBookSearchQuery',
  '_activeBookTab', '_bookTabLoaded', '_booksOffset',

  // ranking
  '_rankingActiveGenre', '_rankingSeq',

  // see-all sub-view
  '_seeAllSeq', '_seeAllOffset', '_seeAllSort', '_seeAllGenre',
  '_seeAllFilter', '_seeAllHasMore', '_seeAllLoading', '_seeAllObserver',

  // taste + recs caches
  '_userBookTasteCache', '_userBookTasteAt',
  '_bookRecsCache', '_bookRecsTimestamp',

  // consts (multi-line strings/objects — AST handles regardless of length)
  '_SECTION_ROW_SIZE', '_FORYOU_SECTIONS',
  '_RANKING_GENRES', '_DISCOVER_GENRES',
  '_SEE_ALL_MAP', 'BOOKS_PAGE_SIZE',
  'BOOK_LIST_SELECT', 'BOOK_CARD_SELECT', '_BOOK_SORT_PIPELINES',
  'PRETTY_GENRE', 'BOOK_RECS_TTL',
];

// App.js helpers that should be bridged to `_cfg.X` inside extracted code.
// These are matched at CallExpression callee position only — bare
// identifier reads are left alone (so e.g. `escHTML` won't get rewritten
// since it's already imported from supabase.js inside books.js).
const CONFIG_DEPS = new Set([
  'hideAllMainPages', 'stopVideoPlayer', 'openProfile',
  'openBookDetail',
  'formatCompact',
  'sanitizeSearchQuery', 'escapeIlike', 'normalizeForSearch',
  '_cleanCdnUrl', '_supabaseRatioCrop',
]);

// Globals to bridge as getters. Read-only — write paths into these
// belong in the owner module (app.js).
const GLOBAL_GETTERS = {
  currentUser: '_cfg.getCurrentUser()',
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
    // Skip non-reference uses
    if (parent.type === 'MemberExpression' && parent.property === p.node && !parent.computed) return;
    if (parent.type === 'Property' && parent.key === p.node && !parent.computed) return;
    if (parent.type === 'ObjectProperty' && parent.key === p.node && !parent.computed) return;
    if (parent.type === 'ImportSpecifier') return;
    if (parent.type === 'ExportSpecifier') return;
    if (parent.type === 'VariableDeclarator' && parent.id === p.node) return;
    if (parent.type === 'FunctionDeclaration' && parent.id === p.node) return;
    if (parent.type === 'FunctionExpression' && parent.id === p.node) return;

    // GLOBAL_GETTERS: rewrite to `_cfg.getX()` member call.
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

    // CONFIG_DEPS: rewrite ONLY when used as a CallExpression callee.
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
  console.log('[stage8a] loading js/app.js + js/books.js …');
  const app = loadAst(APP);
  let books;
  try {
    books = loadAst(BOOKS);
  } catch (e) {
    console.error('books.js missing — create it first via the Stage 8A skeleton.');
    process.exit(1);
  }

  const BOOKS_MARKER = '// Extracted state + functions are appended below by the Stage 8A script.';
  if (!books.src.includes(BOOKS_MARKER)) {
    console.error(`books.js is missing the anchor marker: "${BOOKS_MARKER}"`);
    process.exit(1);
  }

  const extracted = []; // { kind, name, code }

  // 1. Functions
  EXTRACT_FNS.forEach(name => {
    const found = app.root.find(jscodeshift.FunctionDeclaration, { id: { name } });
    if (found.size() === 0) {
      console.warn(`  [fn] NOT FOUND: ${name}`);
      return;
    }
    const node = found.get(0).node;
    const locals = collectLocals(node);
    rewriteIdentifiers(jscodeshift(node), locals);
    const code = jscodeshift(node).toSource();
    extracted.push({ kind: 'fn', name, code });
    found.remove();
    console.log(`  [fn] extracted ${name} (${code.length} chars)`);
  });

  // 2. State vars (top-level VariableDeclaration by name)
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

  // 3. window.X = ... (none for 8A but loop kept for symmetry)
  EXTRACT_WINDOW.forEach(name => {
    const found = app.root.find(jscodeshift.ExpressionStatement).filter(p => {
      const e = p.node.expression;
      return (
        e && e.type === 'AssignmentExpression' && e.operator === '=' &&
        e.left.type === 'MemberExpression' &&
        e.left.object.type === 'Identifier' && e.left.object.name === 'window' &&
        e.left.property.type === 'Identifier' && e.left.property.name === name
      );
    });
    if (found.size() === 0) {
      console.warn(`  [window] NOT FOUND: window.${name}`);
      return;
    }
    const node = found.get(0).node;
    const expr = node.expression;
    let funcDecl;
    if (expr.right.type === 'FunctionExpression') {
      funcDecl = jscodeshift.functionDeclaration(
        jscodeshift.identifier(name),
        expr.right.params,
        expr.right.body
      );
      funcDecl.async = expr.right.async;
    } else if (expr.right.type === 'ArrowFunctionExpression') {
      const body = expr.right.body.type === 'BlockStatement'
        ? expr.right.body
        : jscodeshift.blockStatement([jscodeshift.returnStatement(expr.right.body)]);
      funcDecl = jscodeshift.functionDeclaration(
        jscodeshift.identifier(name),
        expr.right.params,
        body
      );
      funcDecl.async = expr.right.async;
    } else {
      console.warn(`  [window] unsupported RHS for window.${name}`);
      return;
    }
    const locals = collectLocals(funcDecl);
    rewriteIdentifiers(jscodeshift(funcDecl), locals);
    const code = jscodeshift(funcDecl).toSource();
    extracted.push({ kind: 'window', name, code });
    found.remove();
    console.log(`  [window] extracted window.${name} → function ${name}`);
  });

  // ── Compose books.js append block ──
  let appendBlock = '\n\n// ─── Module state ─────────────────────────────────────────────────\n';
  extracted.filter(x => x.kind === 'state').forEach(x => {
    appendBlock += x.code + '\n';
  });
  appendBlock += '\n// ─── Extracted functions ──────────────────────────────────────────\n\n';
  extracted.filter(x => x.kind === 'fn').forEach(x => {
    appendBlock += x.code + '\n\n';
  });
  if (extracted.filter(x => x.kind === 'window').length) {
    appendBlock += '\n// ─── Functions previously attached to window ──────────────────────\n\n';
    extracted.filter(x => x.kind === 'window').forEach(x => {
      appendBlock += x.code + '\n\n';
    });
  }

  // Re-export everything app.js needs.
  const allExports = [
    ...extracted.filter(x => x.kind === 'fn').map(x => x.name),
    ...extracted.filter(x => x.kind === 'window').map(x => x.name),
  ];
  appendBlock += '\n// ─── Stage 8A exports ─────────────────────────────────────────────\nexport {\n';
  allExports.forEach(n => { appendBlock += `  ${n},\n`; });
  appendBlock += '};\n';

  // Write books.js — replace just the marker line with marker + appended block.
  const MARKER_LINE = '// ════════════════════════════════════════════════════════════════════════\n// Extracted state + functions are appended below by the Stage 8A script.\n// ════════════════════════════════════════════════════════════════════════\n';
  if (!books.src.includes(MARKER_LINE)) {
    console.error('books.js marker block not found exactly — check the skeleton header.');
    process.exit(1);
  }
  const newBooksSrc = books.src.replace(MARKER_LINE, MARKER_LINE + appendBlock);
  fs.writeFileSync(BOOKS, newBooksSrc);
  console.log(`[write] books.js: ${newBooksSrc.length} bytes`);

  // Write app.js
  const newAppSrc = app.root.toSource();
  fs.writeFileSync(APP, newAppSrc);
  console.log(`[write] app.js: ${newAppSrc.length} bytes`);

  console.log('\n[stage8a] extraction complete.');
  console.log('Next steps:');
  console.log('  1. Add the import + initBooks({...}) call in app.js');
  console.log('  2. node --check js/app.js && node --check js/books.js');
  console.log('  3. Smoke test books page in browser');
}

main();
