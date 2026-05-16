// Quick scan of feed.js for free identifiers (ones not declared locally,
// not imported, not _cfg.X, not a standard global). Prints unique names.
const fs = require('fs');
const path = require('path');
const j = require('jscodeshift').withParser('babel');
const src = fs.readFileSync(path.resolve(__dirname, '/sessions/vigilant-adoring-hypatia/mnt/Selebox/js/feed.js'), 'utf8');
const root = j(src);

const declared = new Set();
const imported = new Set();
// Imports
root.find(j.ImportSpecifier).forEach(p => imported.add(p.node.local.name));
root.find(j.ImportDefaultSpecifier).forEach(p => imported.add(p.node.local.name));
// Top-level declarations
root.find(j.FunctionDeclaration).forEach(p => declared.add(p.node.id.name));
root.find(j.VariableDeclarator).forEach(p => { if (p.node.id.type === 'Identifier') declared.add(p.node.id.name); });

const GLOBALS = new Set([
  'window','document','console','setTimeout','clearTimeout','setInterval','clearInterval',
  'Promise','Array','Object','String','Number','Boolean','Math','Date','JSON','Set','Map','WeakMap','WeakSet',
  'undefined','null','true','false','NaN','Infinity','globalThis','this',
  'IntersectionObserver','MutationObserver','ResizeObserver','URL','URLSearchParams','FormData','Blob','File','FileReader',
  'navigator','location','history','localStorage','sessionStorage','fetch','XMLHttpRequest','crypto',
  'requestAnimationFrame','cancelAnimationFrame','requestIdleCallback','HTMLElement','Node','Element','Event',
  'CustomEvent','Error','TypeError','RangeError','Symbol','Reflect','Proxy','Intl','RegExp',
  'arguments','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent',
  'btoa','atob','alert','confirm','prompt','HTMLVideoElement','MediaSource','Hls',
]);

const free = new Map();
root.find(j.Identifier).forEach(p => {
  const name = p.node.name;
  if (declared.has(name) || imported.has(name) || GLOBALS.has(name)) return;
  if (name.startsWith('_cfg')) return;
  const parent = p.parent && p.parent.node;
  if (!parent) return;
  if (parent.type === 'MemberExpression' && parent.property === p.node && !parent.computed) return;
  if (parent.type === 'Property' && parent.key === p.node && !parent.computed) return;
  if (parent.type === 'ObjectProperty' && parent.key === p.node && !parent.computed) return;
  if (parent.type === 'ImportSpecifier' || parent.type === 'ExportSpecifier') return;
  if (parent.type === 'VariableDeclarator' && parent.id === p.node) return;
  if (parent.type === 'FunctionDeclaration' && parent.id === p.node) return;
  if (parent.type === 'FunctionExpression' && parent.id === p.node) return;
  if (parent.type === 'ArrowFunctionExpression' && (parent.params || []).includes(p.node)) return;
  if (parent.type === 'FunctionExpression' && (parent.params || []).includes(p.node)) return;
  if (parent.type === 'FunctionDeclaration' && (parent.params || []).includes(p.node)) return;
  if (parent.type === 'CatchClause' && parent.param === p.node) return;
  if (parent.type === 'AssignmentPattern' && parent.left === p.node) return;
  if (parent.type === 'RestElement' && parent.argument === p.node) return;
  if (parent.type === 'ObjectPattern' || parent.type === 'ArrayPattern') return;
  if (parent.type === 'LabeledStatement' && parent.label === p.node) return;
  free.set(name, (free.get(name) || 0) + 1);
});
const sorted = [...free.entries()].sort((a,b) => b[1]-a[1]);
sorted.forEach(([n, c]) => console.log(`${c.toString().padStart(4)}  ${n}`));
