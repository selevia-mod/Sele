/**
 * scripts/scan-books-undef.js — pre-flight unbound-identifier scan for
 * Stage 8A (Books listing/discovery extraction).
 *
 * Why this exists:
 *   The Stage 5 codemod taught us a hard lesson — moving a function or
 *   state var out of app.js silently leaves behind every call-site that
 *   still expects the symbol on the module-local scope. Those manifest at
 *   runtime as "ReferenceError: foo is not defined", and they're
 *   expensive to find by browser-side smoke testing alone.
 *
 *   This scanner walks every function we plan to move into books.js and
 *   flags identifier references that:
 *     (1) Are NOT declared inside the function body (locals/params).
 *     (2) Are NOT in the extracted set (i.e. won't move with us).
 *     (3) Are NOT in our planned _cfg-bridge list.
 *     (4) Are NOT imported from supabase.js or another module.
 *     (5) Are NOT a standard global (window/document/console/etc.).
 *
 *   What's left over is the work surface: either add to CONFIG_DEPS,
 *   add to the extracted set, or add an explicit bridge accessor.
 *
 * Run:
 *   node scripts/scan-books-undef.js
 *
 * Reports two lists:
 *   - Unbound identifiers (sorted by frequency) — most useful
 *   - Function-by-function breakdown — useful for tracking which mover
 *     has the most cross-feature reach
 */

const fs   = require('fs');
const path = require('path');
const j    = require('jscodeshift').withParser('babel');

const APP = path.resolve(__dirname, '../js/app.js');

// Mirror the EXTRACT_FNS list in extract-stage8a.js. Keep these in sync!
const FNS = [
  'showBook', 'loadBooksTab',
  '_loadForYouTab', '_renderBookSection',
  '_fetchHiddenGems', '_fetchQuickReads',
  '_fetchWeeklyFeaturedWithFallback', '_fetchRecommendedForUser',
  '_loadRankingTab', '_renderRankGenreChips',
  '_loadRankingForGenre', '_renderRankCard',
  '_loadDiscoverTab', '_loadDiscoverGenreRow',
  '_loadCollectionTab', '_loadReadingListTab',
  '_renderBookCardV2',
  '_openBookSeeAll', '_loadMoreSeeAllBooks', '_setupSeeAllInfiniteScroll',
  'applyBookFilter', 'searchBooks', 'runBookSearch', 'renderWriterChannelCard',
  '_normalizeBookRow', '_normalizeBookRows',
  'fetchSupabaseBooks', 'fetchBooksServerSearch',
  'renderBookCard',
  'prettyGenre',
  'getUserBookTaste', 'renderBookChips',
  'loadBookRecommendations', 'renderBookRecsRail',
];

// State vars + consts we plan to move alongside the functions.
const MOVED_STATE = new Set([
  // raw state
  'allBooksCache', 'allBooksRaw',
  'bookGenreFilter', 'bookSortBy', 'activeBookSearchQuery',
  '_activeBookTab', '_bookTabLoaded', '_booksOffset',
  // ranking
  '_rankingActiveGenre', '_rankingSeq',
  // see-all sub-view
  '_seeAllSeq', '_seeAllOffset', '_seeAllSort', '_seeAllGenre',
  '_seeAllFilter', '_seeAllHasMore', '_seeAllLoading', '_seeAllObserver',
  // taste cache
  '_userBookTasteCache', '_userBookTasteAt',
  // recs cache
  '_bookRecsCache', '_bookRecsTimestamp',
  // consts
  '_SECTION_ROW_SIZE', '_FORYOU_SECTIONS',
  '_RANKING_GENRES', '_DISCOVER_GENRES',
  '_SEE_ALL_MAP', 'BOOKS_PAGE_SIZE',
  'BOOK_LIST_SELECT', 'BOOK_CARD_SELECT', '_BOOK_SORT_PIPELINES',
  'PRETTY_GENRE', 'BOOK_RECS_TTL',
]);

// Helpers in app.js that books code calls into — these will become _cfg.X
// after the codemod's rewriteIdentifiers pass.
const PLANNED_CFG = new Set([
  'hideAllMainPages', 'stopVideoPlayer', 'openProfile',
  'openBookDetail',
  'formatCompact',
  'sanitizeSearchQuery', 'escapeIlike', 'normalizeForSearch',
]);

// Globals that get a getter wrapper through _cfg (handled by codemod).
const PLANNED_GLOBALS = new Set(['currentUser']);

// Symbols already imported into books.js from supabase.js.
const IMPORTED = new Set(['supabase', 'toast', 'escHTML']);

// Standard browser/JS globals that won't trip ReferenceErrors.
const STD_GLOBALS = new Set([
  'window', 'document', 'console', 'Promise', 'Date', 'Math', 'JSON',
  'Object', 'Array', 'Set', 'Map', 'String', 'Number', 'Boolean',
  'Error', 'TypeError', 'RangeError',
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
  // node globals (in case any function uses them — none should, but defensive)
  'process', 'Buffer', '__dirname', '__filename',
]);

function isPropertyKey(p) {
  const parent = p.parent && p.parent.node;
  if (!parent) return false;
  // obj.X
  if (parent.type === 'MemberExpression' && parent.property === p.node && !parent.computed) return true;
  // {X: ...}
  if (parent.type === 'Property' && parent.key === p.node && !parent.computed) return true;
  if (parent.type === 'ObjectProperty' && parent.key === p.node && !parent.computed) return true;
  // import {X}, export {X}
  if (parent.type === 'ImportSpecifier') return true;
  if (parent.type === 'ExportSpecifier') return true;
  // const X = ...
  if (parent.type === 'VariableDeclarator' && parent.id === p.node) return true;
  // function X () {}
  if (parent.type === 'FunctionDeclaration' && parent.id === p.node) return true;
  if (parent.type === 'FunctionExpression' && parent.id === p.node) return true;
  // arrow param destructure name
  if (parent.type === 'AssignmentPattern' && parent.left === p.node) return false;
  return false;
}

function collectLocals(funcNode) {
  const locals = new Set();
  // Params (Identifier params only — destructured handled below by walking)
  if (funcNode.params) {
    funcNode.params.forEach(param => {
      if (param.type === 'Identifier') locals.add(param.name);
      // Destructured params — descend
      if (param.type === 'ObjectPattern') {
        param.properties.forEach(prop => {
          if (prop.value && prop.value.type === 'Identifier') locals.add(prop.value.name);
          else if (prop.key && prop.key.type === 'Identifier') locals.add(prop.key.name);
        });
      }
      if (param.type === 'ArrayPattern') {
        param.elements.forEach(el => {
          if (el && el.type === 'Identifier') locals.add(el.name);
        });
      }
      // Default-value params: `foo = bar` — left is the identifier
      if (param.type === 'AssignmentPattern' && param.left.type === 'Identifier') {
        locals.add(param.left.name);
      }
    });
  }
  // Walk the body collecting declarators + nested function names
  j(funcNode).find(j.VariableDeclarator).forEach(vp => {
    if (vp.node.id.type === 'Identifier') locals.add(vp.node.id.name);
    // Destructured const/let
    if (vp.node.id.type === 'ObjectPattern') {
      vp.node.id.properties.forEach(prop => {
        if (prop.value && prop.value.type === 'Identifier') locals.add(prop.value.name);
        else if (prop.key && prop.key.type === 'Identifier') locals.add(prop.key.name);
      });
    }
    if (vp.node.id.type === 'ArrayPattern') {
      vp.node.id.elements.forEach(el => {
        if (el && el.type === 'Identifier') locals.add(el.name);
      });
    }
  });
  j(funcNode).find(j.FunctionDeclaration).forEach(fp => {
    if (fp.node.id) locals.add(fp.node.id.name);
  });
  // Catch-clause param: try { ... } catch (e) { ... } — `e` is local
  j(funcNode).find(j.CatchClause).forEach(cp => {
    if (cp.node.param && cp.node.param.type === 'Identifier') {
      locals.add(cp.node.param.name);
    }
  });
  return locals;
}

const EXTRACTED = new Set(FNS);

function scanFunction(name, root) {
  const found = root.find(j.FunctionDeclaration, { id: { name } });
  if (found.size() === 0) {
    return { name, status: 'NOT_FOUND', unbound: [] };
  }
  const node = found.get(0).node;
  const locals = collectLocals(node);
  const unbound = [];

  j(node).find(j.Identifier).forEach(p => {
    const id = p.node.name;
    if (isPropertyKey(p)) return;
    if (locals.has(id)) return;
    if (EXTRACTED.has(id)) return;          // co-moved function
    if (MOVED_STATE.has(id)) return;         // co-moved state/const
    if (PLANNED_CFG.has(id)) return;         // codemod will rewrite
    if (PLANNED_GLOBALS.has(id)) return;     // codemod will rewrite
    if (IMPORTED.has(id)) return;            // imported into books.js
    if (STD_GLOBALS.has(id)) return;         // browser globals
    if (id === name) return;                 // self-reference
    if (id === '_cfg') return;
    if (id === 'arguments') return;          // implicit in non-arrow functions
    unbound.push(id);
  });

  return { name, status: 'OK', unbound };
}

function main() {
  console.log('[scan] reading js/app.js …');
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
    console.log('\n[scan] FUNCTIONS NOT FOUND in app.js — fix the EXTRACT_FNS list:');
    notFound.forEach(r => console.log(`  ✗ ${r.name}`));
  }

  console.log('\n[scan] Unbound identifiers (after planned _cfg/import/co-move) ranked by frequency:');
  const sorted = Object.entries(allHits).sort((a, b) => b[1].count - a[1].count);
  if (!sorted.length) {
    console.log('  ✓ none — extraction set is clean.');
  } else {
    sorted.forEach(([id, info]) => {
      const fnsList = [...info.fns].slice(0, 4).join(', ') + (info.fns.size > 4 ? ` (+${info.fns.size - 4} more)` : '');
      console.log(`  ${String(info.count).padStart(3)}×  ${id.padEnd(36)}  ← ${fnsList}`);
    });
  }

  console.log('\n[scan] Per-function unbound counts (descending):');
  const ranked = results.filter(r => r.status === 'OK')
    .map(r => ({ name: r.name, uniq: new Set(r.unbound).size, total: r.unbound.length }))
    .sort((a, b) => b.uniq - a.uniq);
  ranked.forEach(r => {
    if (r.uniq === 0) return;
    console.log(`  ${String(r.uniq).padStart(3)} uniq / ${String(r.total).padStart(3)} total  ${r.name}`);
  });
  console.log('\n[scan] done.');
}

main();
