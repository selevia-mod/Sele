// ════════════════════════════════════════════════════════════════════════════
// Selebox — Web event logger (Phase 3.3 of the moderation system)
// ════════════════════════════════════════════════════════════════════════════
// Thin client wrapper around the server-side emit RPCs:
//   register_session_device  — on every page load
//   record_read_event        — on chapter open / close
//   record_view_event        — on video play / threshold-crossed / end
//
// Design goals:
//   • FIRE-AND-FORGET — every call returns a Promise that resolves to
//     `void`. Errors are swallowed and console.warned in __DEV__. The
//     caller never has to `await` or handle errors; failed emits are
//     just lost telemetry, never user-visible.
//   • LAZY device_id — generated once per browser via crypto.randomUUID
//     and stored in localStorage. No prompt, no opt-in screen; this is
//     internal anti-fraud telemetry.
//   • LIGHTWEIGHT — no batching, no buffer. Each event is one RPC call.
//     Total volume per session is < 20 events; one RPC each is fine.
//   • AUTH-AWARE — RPCs require auth.uid(). When the user is signed
//     out, calls short-circuit before hitting the wire.
//
// Callers don't need to know about device_id management — just call
// `logRead({...})` or `logView({...})` and it threads through.
// ════════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase.js';


// ── device_id ────────────────────────────────────────────────────────────
// Generated once per browser, stored in localStorage. Survives across
// sessions; resets when the user clears their browser data (which is
// the correct privacy boundary — same as "this device wants to be
// forgotten"). Returns the same UUID on every call.

const DEVICE_ID_KEY = 'selebox_device_id';

export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (id && /^[0-9a-f-]{30,}$/i.test(id)) return id;
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      // Fallback for older browsers: timestamp + 16 hex chars.
      : Date.now().toString(16) + '-' +
        Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    // localStorage blocked (private mode, etc.). Telemetry still works
    // but device_id is per-page-load — detection just loses one
    // correlation axis.
    return 'no-storage';
  }
}


// ── UUID validation ──────────────────────────────────────────────────────
// Server-side RPCs declare chapter_id / video_id / book_id as `uuid`.
// Postgres rejects non-UUID strings with a cast error. Legacy Appwrite
// content has 16-char hex IDs (not UUIDs); sending those silently fails
// inside _emit's catch. Filter at the client so legacy content stops
// triggering pointless RPC calls. Result: legacy content doesn't
// contribute to fraud-detection signals — same as the existing
// behavior, just without the noise.
const _UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _isUuid = (val) => typeof val === 'string' && _UUID_RE.test(val);


// ── Internal: fire-and-forget RPC wrapper ────────────────────────────────
// Returns void. Errors caught + optionally logged.

async function _emit(rpc, args) {
  try {
    // Skip when signed out — the RPCs return not_authenticated anyway,
    // saves a round-trip.
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return;
    const { error } = await supabase.rpc(rpc, args);
    if (error && typeof console !== 'undefined') {
      // Don't spam the console for transient errors; the server's
      // error code (e.g. invalid_event_kind) is the actionable info.
      console.debug('[event-log]', rpc, 'error:', error.message);
    }
  } catch (err) {
    // Network blip / fetch throw — swallow.
    if (typeof console !== 'undefined') {
      console.debug('[event-log]', rpc, 'threw:', err?.message);
    }
  }
}


// ── Public API ───────────────────────────────────────────────────────────

/**
 * Register the current device with the server. Idempotent — the
 * server upserts on (user_id, device_id), so calling this every
 * page load just refreshes last_seen + ip_hash.
 *
 * Call this on every page load that finishes auth (i.e. after
 * supabase.auth.getSession() returns a user).
 */
export async function registerSessionDevice() {
  await _emit('register_session_device', {
    p_device_id:   getDeviceId(),
    p_user_agent:  (navigator?.userAgent || '').slice(0, 500),
    p_platform:    'web',
    p_app_version: null,
  });
}

/**
 * Log a read event (chapter open, scroll milestone, or close).
 *
 * @param {Object} args
 * @param {string} args.chapterId   UUID of the chapter (required)
 * @param {string} [args.bookId]    UUID of the parent book (optional, faster filtering)
 * @param {number} [args.dwellMs]   Milliseconds since chapter open
 * @param {number} [args.scrollPct] 0-100 furthest scroll reached
 * @param {boolean} [args.completed] True when chapter completed
 */
export async function logRead({ chapterId, bookId, dwellMs, scrollPct, completed } = {}) {
  // Skip non-UUID IDs — see _isUuid comment above.
  if (!_isUuid(chapterId)) return;
  await _emit('record_read_event', {
    p_chapter_id: chapterId,
    p_book_id:    _isUuid(bookId) ? bookId : null,
    p_dwell_ms:   dwellMs ?? null,
    p_scroll_pct: scrollPct ?? null,
    p_completed:  completed ?? null,
    p_device_id:  getDeviceId(),
  });
}

/**
 * Log a video view event (play, pause, seek, threshold, end).
 *
 * @param {Object} args
 * @param {string} args.videoId            UUID of the video (required)
 * @param {string} args.kind               One of 'play'|'pause'|'seek'|
 *                                         'threshold_approached'|'threshold_crossed'|'end'
 * @param {number} [args.watchedSeconds]   Total seconds watched at event time
 * @param {number} [args.thresholdSeconds] Only set for threshold_* events
 */
export async function logView({ videoId, kind, watchedSeconds, thresholdSeconds } = {}) {
  // Same UUID gate as logRead — server expects uuid for video_id.
  if (!_isUuid(videoId) || !kind) return;
  await _emit('record_view_event', {
    p_video_id:          videoId,
    p_event_kind:        kind,
    p_watched_seconds:   watchedSeconds ?? null,
    p_threshold_seconds: thresholdSeconds ?? null,
    p_device_id:         getDeviceId(),
  });
}
