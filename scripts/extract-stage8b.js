/**
 * scripts/extract-stage8b.js — jscodeshift codemod for Stage 8B
 * (Book detail + chapter reader extraction).
 *
 * Same machinery as extract-stage8a.js with two additions:
 *
 *   • Handles `export async function X` — when the matching
 *     FunctionDeclaration is wrapped in an ExportNamedDeclaration,
 *     we replace the ENTIRE export wrapper, not just the inner
 *     function. Without this, removing the function alone leaves an
 *     empty `export ;` which is a parse error.
 *
 *   • Wider GLOBAL_GETTERS — adds `currentProfile` and
 *     `_walletConfigDefaults` (read as an object via `.field`, so the
 *     rewrite replaces every bare read regardless of call-shape).
 *
 * Module-level wiring (the setupReaderAntiCopy IIFE, the
 * #sidebarThemeToggle watermark listeners, and the five reader nav
 * buttons + btnBackBooks) is NOT touched by the codemod. After this
 * script runs, hand-add a `wireBookReader()` function to books.js and
 * delete the equivalent app.js blocks. That seam matches the way
 * wireBooksPage() was added in Stage 8A.
 *
 * Usage:
 *   node scripts/extract-stage8b.js
 */

const fs = require('fs');
const path = require('path');
const jscodeshift = require('jscodeshift').withParser('babel');

const APP   = path.resolve(__dirname, '../js/app.js');
const BOOKS = path.resolve(__dirname, '../js/books.js');

// ── Stage 8B extraction targets ─────────────────────────────────────────

const EXTRACT_FNS = [
  'openBookDetail', 'renderBookDetail',
  'loadBookActionState', 'setBookActionActive',
  'toggleBookLike', 'toggleBookBookmark',
  'openChapterReader', 'normalizeChapterContent',
  'saveReadingProgress',
  'getReaderWatermarkLabel', 'applyReaderWatermark',
];

const EXTRACT_WINDOW = [];

const EXTRACT_STATE = [
  'currentBookDetail', 'currentChapterIndex', 'readerFontSize',
  '_openBookToken', '_watermarkLabelCache',
  '_readMaxScrollPct',
  '_readChapterOpenTs', '_readChapterOpenId', '_readChapterOpenBookId',
];

// App.js helpers bridged via `_cfg.X` at CallExpression callee positions.
const CONFIG_DEPS = new Set([
  'hideAllMainPages',
  'openProfile',
  'openUnlockDialog', 'openBulkBookUnlockDialog',
  'isUnlocked', 'resolveUnlockCost',
  'tickGoalUnique', 'flushReadClose', 'logRead',
]);

// Globals to bridge as getters — rewritten at ANY read position, not
// just calls. Reads like `_walletConfigDefaults.field` become
// `_cfg.getWalletConfig().field`.
const GLOBAL_GETTERS = {
  currentUser:           '_cfg.getCurrentUser()',
  currentProfile:        '_cfg.getCurrentProfile()',
  _walletConfigDefaults: '_cfg.getWalletConfig()',
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

    // GLOBAL_GETTERS: rewrite to `_cfg.getX()` member call wherever the
    // identifier is read. Skip locals that shadow.
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

    // CONFIG_DEPS: only rewrite at CallExpression callee position.
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
  console.log('[stage8b] loading js/app.js + js/books.js …');
  const app = loadAst(APP);
  let books;
  try {
    books = loadAst(BOOKS);
  } catch (e) {
    console.error('books.js missing — run Stage 8A first.');
    process.exit(1);
  }

  const BOOKS_MARKER = '// ─── Stage 8A exports ─────────────────────────────────────────────';
  if (!books.src.includes(BOOKS_MARKER)) {
    console.error(`books.js is missing the Stage 8A exports marker.`);
    process.exit(1);
  }

  const extracted = [];

  // 1. Functions — handle export-wrapped declarations specially.
  EXTRACT_FNS.forEach(name => {
    // First: look for an ExportNamedDeclaration whose .declaration is a
    // FunctionDeclaration with this name. If found, remove the WHOLE
    // export wrapper (not just the inner function — that would leave
    // an empty `export ;` and fail to parse).
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

    // Fallback: bare FunctionDeclaration at module scope.
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

  // ── Compose books.js append block ──
  // We want the new block to appear BEFORE the existing
  // "Stage 8A exports" line in books.js. Inject above the marker.
  let appendBlock = '\n// ════════════════════════════════════════════════════════════════════════\n';
  appendBlock += '// Stage 8B — Book detail page + chapter reader (appended by extract-stage8b.js)\n';
  appendBlock += '// ════════════════════════════════════════════════════════════════════════\n\n';
  appendBlock += '// ─── Module state (8B) ─────────────────────────────────────────────\n';
  extracted.filter(x => x.kind === 'state').forEach(x => {
    appendBlock += x.code + '\n';
  });
  appendBlock += '\n// ─── Extracted functions (8B) ──────────────────────────────────────\n\n';
  extracted.filter(x => x.kind === 'fn').forEach(x => {
    appendBlock += x.code + '\n\n';
  });

  const allExports = extracted.filter(x => x.kind === 'fn').map(x => x.name);
  appendBlock += '\n// ─── Stage 8B exports ─────────────────────────────────────────────\nexport {\n';
  allExports.forEach(n => { appendBlock += `  ${n},\n`; });
  appendBlock += '};\n';

  // Insert the new block ABOVE the Stage 8A exports marker so the 8A
  // exports remain at the bottom of the file (visually grouped). The
  // injection point is the marker line itself.
  const newBooksSrc = books.src.replace(BOOKS_MARKER, appendBlock + '\n' + BOOKS_MARKER);
  fs.writeFileSync(BOOKS, newBooksSrc);
  console.log(`[write] books.js: ${newBooksSrc.length} bytes`);

  const newAppSrc = app.root.toSource();
  fs.writeFileSync(APP, newAppSrc);
  console.log(`[write] app.js: ${newAppSrc.length} bytes`);

  console.log('\n[stage8b] extraction complete.');
  console.log('Next steps:');
  console.log('  1. Hand-add wireBookReader() to books.js (anti-copy IIFE, theme listeners,');
  console.log('     reader nav buttons, btnBackBooks).');
  console.log('  2. Delete the equivalent blocks from app.js.');
  console.log('  3. Update initBooks({...}) in app.js with the new bridge surface.');
  console.log('  4. Add wireBookReader() call after wireBooksPage().');
  console.log('  5. Add openChapterReader to the books.js import in app.js.');
  console.log('  6. node --check both files + smoke test in browser.');
}

main();
