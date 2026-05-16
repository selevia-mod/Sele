#!/usr/bin/env node
// Stage 12 extraction — Engagement (comments + reactions) → js/engagement.js
//
// Reads js/app.js, slices the 6 source ranges that make up the
// engagement layer (batch loaders, loadCommentCount, Reactions block,
// Comments block, Global delegated click handlers, Reactor list modal),
// applies the cross-module substitutions, composes the new file with a
// header + imports + _cfg defaults + transformed block + exports, then
// removes the source ranges from app.js with MOVED markers.

const fs = require('fs');

const APP_PATH        = 'js/app.js';
const ENGAGEMENT_PATH = 'js/engagement.js';

// 1-based ranges. The blocks are listed in source order so we can do
// a single forward pass when slicing app.js.
const RANGES = [
  { start: 3215, end: 3251, label: 'Batch engagement loaders'         },
  { start: 3814, end: 3826, label: 'loadCommentCount helper'          },
  { start: 3828, end: 3953, label: 'Reactions block'                  },
  { start: 3954, end: 4355, label: 'Comments block'                   },
  { start: 4356, end: 4440, label: 'Global delegated click handlers'  },
  { start: 11088, end: 11265, label: 'Reactor list modal + tap handlers' },
];

const appSrc = fs.readFileSync(APP_PATH, 'utf8');
const appLines = appSrc.split('\n');

function slice(s, e) { return appLines.slice(s - 1, e).join('\n'); }

// ── Slice + concatenate the 6 ranges ────────────────────────────────────
const blocks = RANGES.map(r => ({
  label: r.label,
  body:  slice(r.start, r.end),
}));

// ── Cross-module substitutions ──────────────────────────────────────────
// Engagement.js lives next to (not inside) app.js — references to app.js-
// owned identifiers need to flow through _cfg, except for things that
// come from leaf utility modules (supabase.js exports escHTML/toast/
// initials/timeAgo/REACTIONS, plus supabase itself).
function transform(s) {
  return s
    // Identity (callers in app.js read live currentUser from globalThis)
    .replace(/\bcurrentUser\b/g, '_cfg.getCurrentUser()')
    .replace(/\bcurrentProfile\b/g, '_cfg.getCurrentProfile()')
    // Goal counter — tickGoalUnique still lives in app.js until Stage 14
    .replace(/\btickGoalUnique\(/g, '_cfg.tickGoalUnique(')
    // Profile navigation (profile.js export, but bridged through _cfg so
    // we don't add another import for one callsite)
    .replace(/\bopenProfile\(/g, '_cfg.openProfile(')
    // Modal helper (lives in app.js)
    .replace(/\bcloseAllModals\(/g, '_cfg.closeAllModals(')
    // Role seal helper (lives in app.js)
    .replace(/\brenderRoleSeal\(/g, '_cfg.renderRoleSeal(')
    // Image uploader (lives in app.js — wraps Bunny CDN upload)
    .replace(/\buploadImage\(/g, '_cfg.uploadImage(')
    // Confirm dialog primitive (lives in app.js)
    .replace(/\bconfirmDialog\(/g, '_cfg.confirmDialog(')
    // Linkify + link-preview utilities (lives in app.js)
    .replace(/\blinkify\(/g, '_cfg.linkify(')
    .replace(/\brenderLinkPreview\(/g, '_cfg.renderLinkPreview(')
    .replace(/\bfirstUrlInText\(/g, '_cfg.firstUrlInText(');
}

const transformedBody = blocks.map(b =>
  `\n// ─── ${b.label} ──────────────────────────────────────────────\n` +
  transform(b.body)
).join('\n');

// ── Compose engagement.js ───────────────────────────────────────────────
const header = `// ════════════════════════════════════════════════════════════════════════
// Selebox engagement — extracted from js/app.js as Stage 12 of the
// refactor roadmap (2026-05-16). This module owns the polymorphic
// reactions + comments engagement layer that's shared by posts,
// videos, and comments-on-the-above (anything that uses the generic
// \`reactions\` and \`comments\` tables with a \`target_type\` discriminator).
//
// What's here:
//   • Batch loaders — bulkLoadReactions, bulkLoadCommentCounts (used
//     by feed.js when it renders a page of posts).
//   • Reactions — loadReactions, handleReaction (set/clear/swap),
//     the .reaction-trigger + .reaction-option click delegates.
//   • Comments — loadComments, renderComment, submitComment, the
//     "N comments" + .comment-toggle click delegates, the per-section
//     realtime channel (_commentsChannelByContainer).
//   • Reactor list modal — openReactorListModal (the "X others" tap
//     that shows everyone who reacted, grouped by emoji).
//
// What's NOT here:
//   • Book chapter likes (\`chapter_likes\` table) — lives in books.js
//     because it uses different tables/RPCs.
//   • Book comments — likewise, lives in books.js.
//   • Engagement-goal ticking (\`tickGoalUnique\`) — still in app.js
//     for now; will move to js/goals.js in Stage 14.
//
// CAREFUL: this is pure code movement, not a rewrite. If you see
// something you want to "improve while you're here" — DON'T. Open a
// separate task. Stage discipline is "translation, not interpretation."
//
// See REFACTOR_ROADMAP.md (Stage 12 section).
// ════════════════════════════════════════════════════════════════════════

import { supabase, REACTIONS, escHTML, initials, timeAgo, toast } from './supabase.js';

// ─── Config-injection dependency surface ──────────────────────────────────
// app.js INJECTS these on sign-in via initEngagement(config). Defaults
// are no-ops so the module loads cleanly even if a caller fires before
// init (delegated DOM click handlers attach at module-load time).
let _cfg = {
  getCurrentUser:           () => null,
  getCurrentProfile:        () => null,
  tickGoalUnique:           () => {},
  openProfile:              () => {},
  closeAllModals:           () => {},
  renderRoleSeal:           () => '',
  uploadImage:              async () => null,
  confirmDialog:            async () => false,
  linkify:                  (s) => s,
  renderLinkPreview:        () => '',
  firstUrlInText:           () => null,
};

export function initEngagement(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

`;

const composed = header + transformedBody + '\n';

// ── Promote selected functions to export so app.js / feed.js can import ─
const exportTargets = [
  'async function bulkLoadReactions',
  'async function bulkLoadCommentCounts',
  'async function loadCommentCount',
  'async function loadReactions',
  'async function handleReaction',
  'async function loadComments',
  'async function renderComment',
  'async function submitComment',
  'async function openReactorListModal',
];
let withExports = composed;
for (const sig of exportTargets) {
  const re = new RegExp('(?<![A-Za-z_])' + sig.replace(/\$/g, '\\$'));
  withExports = withExports.replace(re, 'export ' + sig);
}

fs.writeFileSync(ENGAGEMENT_PATH, withExports);

// ── Remove ranges from app.js (forward pass, MOVED markers) ─────────────
function markerFor(label, range) {
  return [
    '// ════════════════════════════════════════════════════════════════════════',
    `// ${label} MOVED to js/engagement.js (Stage 12).`,
    `// Was lines ${range.start}-${range.end} pre-extraction. See engagement.js`,
    '// for the implementation. App.js re-imports the exported functions so',
    '// the feed.js _cfg passthroughs (bulkLoadReactions, bulkLoadCommentCounts,',
    '// loadComments, loadReactions, loadCommentCount) keep receiving the real',
    '// impls.',
    '// ════════════════════════════════════════════════════════════════════════',
  ].join('\n');
}

const newLines = [];
let i = 0;
let rangeIdx = 0;
while (i < appLines.length) {
  const lineNum = i + 1;
  const range = RANGES[rangeIdx];
  if (range && lineNum === range.start) {
    newLines.push(markerFor(range.label, range));
    i = range.end;          // skip past the moved range
    rangeIdx++;
    continue;
  }
  newLines.push(appLines[i]);
  i++;
}

fs.writeFileSync(APP_PATH, newLines.join('\n'));

const movedLines = RANGES.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
console.log('Wrote', ENGAGEMENT_PATH, '(' + withExports.split('\n').length + ' lines)');
console.log('Removed', movedLines, 'lines from', APP_PATH);
console.log('Promoted', exportTargets.length, 'functions to export');
