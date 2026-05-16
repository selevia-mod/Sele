import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://zplisqwoejxrdrpbfass.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1u8sicdlwn15-I_9kvQmLA_NavAUkDs';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Each entry carries both the emoji glyph (legacy fallback / DM reactions /
// search-result text rendering) and the SVG URL for the custom FB-style
// badge icons. The SVGs live in /images/reactions/ and were copied from
// mobile's assets/reactions/ to keep platforms visually identical
// (mobile uses these via react-native-svg-transformer). Mobile rationale
// for SVGs over emoji glyphs lives in components/PostReaction.jsx — TL;DR
// emoji descender clipping + Apple's white-shine on ❤️ at small sizes.
// Web doesn't have the iOS clipping issue but matching mobile's polish
// is the goal here (Stage 12 follow-up).
export const REACTIONS = [
  { key: 'heart', emoji: '❤️', label: 'Love',  svg: 'images/reactions/heart.svg' },
  { key: 'laugh', emoji: '😂', label: 'Haha',  svg: 'images/reactions/laugh.svg' },
  { key: 'sad',   emoji: '😢', label: 'Sad',   svg: 'images/reactions/sad.svg'   },
  { key: 'cry',   emoji: '😭', label: 'Cry',   svg: 'images/reactions/cry.svg'   },
  { key: 'angry', emoji: '😡', label: 'Angry', svg: 'images/reactions/angry.svg' }
];

// URL lookup by reaction key. Returns null for unknown keys so callers
// can fall back to the emoji glyph (e.g. legacy DM reactions that use
// other keys, or future reactions added without SVG assets).
export function reactionSvgUrl(key) {
  const r = REACTIONS.find(x => x.key === key);
  return r?.svg || null;
}

export function timeAgo(date) {
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

export function initials(name) {
  return (name || 'G').split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
}

// ── Shared UI utilities ──
// Moved here from js/app.js as Stage 1 prep (2026-05-15). Notification
// extraction needs both — putting them in the existing shared module
// (rather than creating a new core.js) keeps the import surface small.
// Topically a bit odd to have escHTML/toast next to the supabase client,
// but pragmatic for now; can refactor into a dedicated utils.js later.

export function escHTML(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

export function toast(msg, type = '') {
  const el = document.getElementById('toast');
  if (!el) { console.warn('[toast] #toast element missing:', msg); return; }
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

// ── Edge Function helper ──
export async function callEdgeFunction(functionName, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not logged in');
  
  const url = `${SUPABASE_URL}/functions/v1/${functionName}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || 'Request failed');
  }
  
  return await response.json();
}
