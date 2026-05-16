/**
 * scripts/patch-stage5-bridges.js — second pass over js/feed.js to bridge
 * names the initial Stage 5 codemod missed because they weren't in its
 * CONFIG_DEPS list. Pure additive — same AST-only safety guarantees as
 * the main codemod.
 *
 * Why a second pass: the initial codemod's CONFIG_DEPS only included
 * helpers we'd previously refactored against (Stages 6-9). Stage 5 is the
 * deepest extraction yet and touches a handful of cross-module bindings
 * (the shared `posts` array, the seen-at watermark, role-seal renderer,
 * profile refresh) that we hadn't seen the need to bridge before. Catalog
 * here, add to initFeed config, done.
 *
 * Usage:  node scripts/patch-stage5-bridges.js
 */
const fs = require('fs');
const path = require('path');
const jscodeshift = require('jscodeshift').withParser('babel');

const FED = path.resolve(__dirname, '../js/feed.js');

// Names that should be bridged as `_cfg.X(...)` for plain function calls.
const FN_DEPS = new Set([
  '_bumpFeedLastSeenAt',
  'renderRoleSeal',
  'refreshProfilePostsIfViewing',
]);

// Names that are mutable state. Read becomes `_cfg.getX()`, assignment
// `X = v` becomes `_cfg.setX(v)`. Map: source name → { get, set }.
const STATE_DEPS = {
  posts: { get: 'getPosts', set: 'setPosts' },
  _feedLastSeenAt: { get: 'getFeedLastSeenAt', set: 'setFeedLastSeenAt' },
};

function main() {
  const src = fs.readFileSync(FED, 'utf8');
  const root = jscodeshift(src);

  let fnRewrites = 0;
  let stateReads = 0;
  let stateWrites = 0;

  // Pass 1: Assignments to state vars — must happen BEFORE the generic
  // identifier walk so we replace the AssignmentExpression as a whole
  // (otherwise the LHS identifier would already be rewritten to a getter
  // call, which can't be assigned to).
  root.find(jscodeshift.AssignmentExpression).forEach(p => {
    const { left, right, operator } = p.node;
    if (operator !== '=') return;
    if (left.type !== 'Identifier') return;
    const dep = STATE_DEPS[left.name];
    if (!dep) return;
    p.replace(
      jscodeshift.callExpression(
        jscodeshift.memberExpression(
          jscodeshift.identifier('_cfg'),
          jscodeshift.identifier(dep.set)
        ),
        [right]
      )
    );
    stateWrites++;
  });

  // Pass 2: All remaining Identifier reads.
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

    if (STATE_DEPS[name]) {
      const dep = STATE_DEPS[name];
      p.replace(
        jscodeshift.callExpression(
          jscodeshift.memberExpression(
            jscodeshift.identifier('_cfg'),
            jscodeshift.identifier(dep.get)
          ),
          []
        )
      );
      stateReads++;
      return;
    }

    if (FN_DEPS.has(name)) {
      // Only bridge when used as a callee (consistent with original codemod).
      if (parent.type === 'CallExpression' && parent.callee === p.node) {
        p.replace(
          jscodeshift.memberExpression(
            jscodeshift.identifier('_cfg'),
            jscodeshift.identifier(name)
          )
        );
        fnRewrites++;
      }
    }
  });

  fs.writeFileSync(FED, root.toSource());
  console.log(`[patch] fn callees rewritten: ${fnRewrites}`);
  console.log(`[patch] state reads rewritten:  ${stateReads}`);
  console.log(`[patch] state writes rewritten: ${stateWrites}`);
  console.log(`[patch] feed.js: ${fs.statSync(FED).size} bytes`);
}

main();
