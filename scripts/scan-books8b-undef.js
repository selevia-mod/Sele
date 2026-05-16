/**
 * scripts/scan-books8b-undef.js — pre-flight scan for Stage 8B
 * (Book detail + chapter reader extraction).
 *
 * Same machinery as scan-books-undef.js but with the 8B function set
 * and an expanded planned-cfg list that mirrors what the 8B codemod
 * will rewrite.
 */

const fs   = require('fs');
const path = require('path');
const j    = require('jscodeshift').withParser('babel');

const APP = path.resolve(__dirname, '../js/app.js');

// Mirror the EXTRACT_FNS list in extract-stage8b.js. Keep in sync.
const FNS = [
  'openBookDetail', 'renderBookDetail',
  'loadBookActionState', 'setBookActionActive',
  'toggleBookLike', 'toggleBookBookmark',
  'openChapterReader', 'normalizeChapterContent',
  'saveReadingProgress',
  'getReaderWatermarkLabel', 'applyReaderWatermark',
];

// State vars + consts moving with the 8B set.
const MOVED_STATE = new Set([
  'currentBookDetail', 'currentChapterIndex', 'readerFontSize',
  '_openBookToken', '_watermarkLabelCache',
  '_readMaxScrollPct',
  '_readChapterOpenTs', '_readChapterOpenId', '_readChapterOpenBookId',
]);

// Things already in books.js (from Stage 8A) — these are intra-module
// references that don't need bridging.
const ALREADY_IN_BOOKS = new Set([
  'showBook', 'loadBooksTab', '_openBookSeeAll',
  'runBookSearch', 'fetchSupabaseBooks', 'fetchBooksServerSearch',
  'renderBookCard', '_renderBookCardV2', 'renderWriterChannelCard',
  '_normalizeBookRow', '_normalizeBookRows',
  'prettyGenre', 'renderBookChips',
  'loadBookRecommendations', 'renderBookRecsRail',
  '_activeBookTab', 'activeBookSearchQuery',
  'allBooksCache', 'allBooksRaw', 'bookGenreFilter', 'bookSortBy',
  '_bookTabLoaded', '_booksOffset',
  '_rankingActiveGenre', '_rankingSeq',
  '_seeAllSeq', '_seeAllOffset', '_seeAllSort', '_seeAllGenre',
  '_seeAllFilter', '_seeAllHasMore', '_seeAllLoading', '_seeAllObserver',
  '_userBookTasteCache', '_userBookTasteAt',
  '_bookRecsCache', '_bookRecsTimestamp',
  '_SECTION_ROW_SIZE', '_FORYOU_SECTIONS',
  '_RANKING_GENRES', '_DISCOVER_GENRES',
  '_SEE_ALL_MAP', 'BOOKS_PAGE_SIZE',
  'BOOK_LIST_SELECT', 'BOOK_CARD_SELECT', '_BOOK_SORT_PIPELINES',
  'PRETTY_GENRE', 'BOOK_RECS_TTL',
  'getUserBookTaste', 'applyBookFilter', 'searchBooks',
]);

const PLANNED_CFG = new Set([
  'hideAllMainPages', 'openProfile',
  'openUnlockDialog', 'openBulkBookUnlockDialog',
  'isUnlocked', 'resolveUnlockCost',
  'tickGoalUnique', 'flushReadClose', 'logRead',
  // wallet defaults via getter (codemod will rewrite reads of
  // `_walletConfigDefaults` to `_cfg.getWalletConfig()`)
]);

const PLANNED_GLOBALS = new Set([
  'currentUser', 'currentProfile', '_walletConfigDefaults',
]);

const IMPORTED = new Set(['supabase', 'toast', 'escHTML', 'initials']);

// DOM refs that stay in app.js but books.js can re-resolve via
// getElementById. Treat as known so the scan doesn't flag them.
const KNOWN_DOM_REFS = new Set(['bookDetailPage', 'chapterReaderPage']);

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
  'process', 'Buffer', '__dirname', '__filename',
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
  // Arrow/function expression params — collect for nested scope suppression
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

function scanFunction(name, root) {
  const found = root.find(j.FunctionDeclaration, { id: { name } });
  if (found.size() === 0) return { name, status: 'NOT_FOUND', unbound: [] };
  const node = found.get(0).node;
  const locals = collectLocals(node);
  const unbound = [];
  j(node).find(j.Identifier).forEach(p => {
    const id = p.node.name;
    if (isPropertyKey(p)) return;
    if (locals.has(id)) return;
    if (EXTRACTED.has(id)) return;
    if (MOVED_STATE.has(id)) return;
    if (ALREADY_IN_BOOKS.has(id)) return;
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
  console.log('[scan-8b] reading js/app.js …');
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
    console.log('\n[scan-8b] FUNCTIONS NOT FOUND — fix EXTRACT_FNS list:');
    notFound.forEach(r => console.log(`  ✗ ${r.name}`));
  }

  console.log('\n[scan-8b] Unbound identifiers (after planned bridges) ranked by frequency:');
  const sorted = Object.entries(allHits).sort((a, b) => b[1].count - a[1].count);
  if (!sorted.length) {
    console.log('  ✓ none — extraction set is clean.');
  } else {
    sorted.forEach(([id, info]) => {
      const fnsList = [...info.fns].slice(0, 4).join(', ') + (info.fns.size > 4 ? ` (+${info.fns.size - 4} more)` : '');
      console.log(`  ${String(info.count).padStart(3)}×  ${id.padEnd(36)}  ← ${fnsList}`);
    });
  }

  console.log('\n[scan-8b] Per-function unbound counts:');
  const ranked = results.filter(r => r.status === 'OK')
    .map(r => ({ name: r.name, uniq: new Set(r.unbound).size, total: r.unbound.length }))
    .sort((a, b) => b.uniq - a.uniq);
  ranked.forEach(r => {
    if (r.uniq === 0) return;
    console.log(`  ${String(r.uniq).padStart(3)} uniq / ${String(r.total).padStart(3)} total  ${r.name}`);
  });
  console.log('\n[scan-8b] done.');
}

main();
