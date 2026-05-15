// ════════════════════════════════════════════════════════════════════════
// Selebox post composer — extracted from js/app.js as Stage 3 of the
// refactor roadmap (2026-05-15). This module owns:
//   • The compose textbox (#composeText) — char count + auto-resize
//   • Image attachment (#composeImageInput) — preview + remove
//   • Schedule popover (Stage 1 Safari fix) — date/time picker, chip,
//     clear, click-outside / Escape dismiss
//   • The submit handler (#btnPostSubmit) — uploads image, calls the
//     submit_post RPC, refetches the row with joins, and hands the new
//     post to app.js via the onPostCreated callback
//
// NOT moved (lives elsewhere):
//   • Video / Book attach buttons → those route to Studio / Book Editor,
//     so they're navigation surfaces from the sidebar, not composer state
//   • The "{N} scheduled" pill + modal → already in scheduled-posts.js
//
// CAREFUL: pure code movement, not a rewrite. Same lines of code,
// different file. Stage 1 discipline rule still applies.
//
// Stage 1 lesson: don't import from app.js — circular ES module imports
// break realtime channel setup at module load. We import ONLY from
// supabase.js + scheduled-posts.js (both leaf-level). Everything app.js
// needs to know about (currentUser, uploadImage, FEED_SELECT, the feed
// array + DOM update plumbing) is INJECTED via initComposer(config).
// ════════════════════════════════════════════════════════════════════════

import { supabase, toast } from './supabase.js';
import { refreshScheduledPostsBadge } from './scheduled-posts.js';

// ─── Config-injection dependency surface ──────────────────────────────────
// 5 injected pieces:
//   getCurrentUser()       → returns the live currentUser object or null
//   uploadImage(file)      → uploads to bunny, returns CDN url or null
//   feedSelect             → FEED_SELECT constant (string of columns
//                            we want back when re-fetching after submit)
//   onPostCreated(post)    → app.js handles prepending to its feed array
//                            + DOM insert + scroll-to-top + last-seen bump.
//                            Composer doesn't need to know HOW.
//   onPostCreateFallback() → app.js handles the "RPC succeeded but the
//                            re-fetch returned nothing" safety net,
//                            usually loadFeed().
let _cfg = {
  getCurrentUser:        () => null,
  uploadImage:           async () => null,
  feedSelect:            '*',
  onPostCreated:         () => {},
  onPostCreateFallback:  () => {},
};

// ─── DOM refs (resolved at module load) ──────────────────────────────────
const composeText            = document.getElementById('composeText');
const charCount              = document.getElementById('charCount');
const composeImageInput      = document.getElementById('composeImageInput');
const composeImagePreview    = document.getElementById('composeImagePreview');
const _btnOpenSchedule         = document.getElementById('btnOpenSchedule');
const _composeSchedulePopover  = document.getElementById('composeSchedulePopover');
const _composeScheduleDate     = document.getElementById('composeScheduleDate');
const _composeScheduleTime     = document.getElementById('composeScheduleTime');
const _composeScheduleSetBtn   = document.getElementById('composeScheduleSet');
const _composeScheduleCancelBtn = document.getElementById('composeScheduleCancel');
const _composeScheduleChip     = document.getElementById('composeScheduleChip');
const _composeScheduleLabel    = document.getElementById('composeScheduleLabel');
const _composeScheduleClear    = document.getElementById('composeScheduleClear');

// ─── Mutable state ───────────────────────────────────────────────────────
let composeImageFile = null;
// Compose scheduling state — set when user picks a future datetime via
// the Schedule button. When non-null, the submit handler routes through
// the submit_post RPC with is_hidden=true + scheduled_publish_at, so a
// server cron job flips the post live at that moment. Mirrors mobile's
// "Schedule for later" flow.
let composeScheduledAt = null;   // Date | null
// Re-entrancy guard — Safari can fire 'click' twice for the same tap
// under certain touch/mouse hybrid conditions, which would otherwise
// fire two parallel submit_post RPCs and render two optimistic cards.
// btn.disabled = true happens AFTER the function starts but before any
// await, so the second click can still slip in if the first click's
// async work hasn't yielded. The flag closes that gap.
let _submitting = false;

// ─── Public API ──────────────────────────────────────────────────────────
// initComposer is called from app.js's onSignedIn. It stores the config
// so the event listeners (which were bound at module load) can call
// _cfg.getCurrentUser() / _cfg.uploadImage() / etc. with live state.
export function initComposer(config) {
  if (config) _cfg = { ..._cfg, ...config };
}

// ─── Schedule UI ─────────────────────────────────────────────────────────
// 2026-05-15: rewritten from native <input type="datetime-local"> to a
// custom popover with separate <input type="date"> + <input type="time"> +
// explicit Set/Cancel buttons. The native control had broken UX on Safari
// (no calendar, no obvious close button, no proper time picker). The
// split inputs render decent native pickers in both Safari and Chrome,
// and the explicit Set button removes the silent fallthrough we had
// before — you can no longer "schedule" by clicking the button and
// accidentally posting immediately because no time got picked. If
// composeScheduledAt is null at submit time, the post button label
// still reads "Post" (not "Schedule") so the user always knows whether
// they're scheduling or posting live.

function _updateComposeScheduleUI() {
  const btn = document.getElementById('btnPostSubmit');
  if (composeScheduledAt) {
    _composeScheduleChip.style.display = 'inline-flex';
    _composeScheduleLabel.textContent = `Scheduled for ${composeScheduledAt.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}`;
    if (btn) btn.textContent = 'Schedule';
  } else {
    _composeScheduleChip.style.display = 'none';
    if (btn) btn.textContent = 'Post';
  }
}

// Helpers for the local-time formatting that <input type="date"> and
// <input type="time"> expect. We deliberately avoid toISOString() here
// because that converts to UTC and would shift the date across midnight
// for evening-time users in non-zero UTC offsets.
function _localYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function _localHm(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function _openComposeSchedulePopover() {
  if (!_composeSchedulePopover) return;
  // Default to 1 hour from now, rounded down to the minute. If a value
  // is already set (user re-opening to adjust), preserve it.
  const seed = composeScheduledAt || (() => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setSeconds(0, 0);
    return d;
  })();
  _composeScheduleDate.value = _localYmd(seed);
  _composeScheduleTime.value = _localHm(seed);
  _composeScheduleDate.min = _localYmd(new Date());
  _composeSchedulePopover.style.display = 'block';
}

function _closeComposeSchedulePopover() {
  if (_composeSchedulePopover) _composeSchedulePopover.style.display = 'none';
}

_btnOpenSchedule?.addEventListener('click', (e) => {
  e.stopPropagation();   // don't trip the outside-click handler below
  // Toggle: clicking the button again while the popover is open closes it.
  if (_composeSchedulePopover?.style.display === 'block') {
    _closeComposeSchedulePopover();
  } else {
    _openComposeSchedulePopover();
  }
});

_composeScheduleSetBtn?.addEventListener('click', () => {
  const dateStr = _composeScheduleDate?.value;
  const timeStr = _composeScheduleTime?.value;
  if (!dateStr || !timeStr) {
    toast('Pick both a date and a time', 'error');
    return;
  }
  // `${YYYY-MM-DD}T${HH:MM}` parses as local time in every browser we
  // care about. (datetime-local strings without a Z are local.)
  const d = new Date(`${dateStr}T${timeStr}`);
  if (Number.isNaN(d.getTime())) { toast('Invalid date/time', 'error'); return; }
  if (d.getTime() <= Date.now()) { toast('Schedule time must be in the future', 'error'); return; }
  composeScheduledAt = d;
  _updateComposeScheduleUI();
  _closeComposeSchedulePopover();
});

_composeScheduleCancelBtn?.addEventListener('click', () => {
  _closeComposeSchedulePopover();
});

// Click outside the popover closes it (without committing).
document.addEventListener('click', (e) => {
  if (!_composeSchedulePopover || _composeSchedulePopover.style.display !== 'block') return;
  // Click is inside the popover OR on the Schedule toggle button → ignore.
  if (e.target.closest('#composeSchedulePopover')) return;
  if (e.target.closest('#btnOpenSchedule')) return;
  _closeComposeSchedulePopover();
});

// Escape closes the popover.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (_composeSchedulePopover?.style.display === 'block') {
    _closeComposeSchedulePopover();
  }
});

// "Scheduled for X" chip × button — clears the schedule + flips the
// submit button label back to "Post".
_composeScheduleClear?.addEventListener('click', () => {
  composeScheduledAt = null;
  _updateComposeScheduleUI();
});

// ─── Compose textbox: char count + auto-resize ───────────────────────────
composeText?.addEventListener('input', () => {
  const len = composeText.value.length;
  charCount.textContent = `${len} / 5000`;
  charCount.className = 'char-count' + (len > 4500 ? ' warn' : '') + (len >= 5000 ? ' over' : '');
  composeText.style.height = 'auto';
  composeText.style.height = composeText.scrollHeight + 'px';
});

// ─── Image attachment: preview + remove ──────────────────────────────────
composeImageInput?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  composeImageFile = file;
  const reader = new FileReader();
  reader.onload = (ev) => {
    composeImagePreview.innerHTML = `
      <div class="image-preview">
        <img src="${ev.target.result}" alt="preview"/>
        <button class="image-preview-remove" id="removeComposeImage">×</button>
      </div>`;
    document.getElementById('removeComposeImage').addEventListener('click', () => {
      composeImageFile = null;
      composeImagePreview.innerHTML = '';
      composeImageInput.value = '';
    });
  };
  reader.readAsDataURL(file);
});

// ─── Submit ──────────────────────────────────────────────────────────────
// Selector matches the id="btnPostSubmit" in index.html (renamed from
// btnPost in #142 to avoid collision with the sidebar Post nav button).
//
// Routes through the submit_post RPC mobile uses, which supports the
// is_hidden + scheduled_publish_at parameters needed for scheduling.
// The legacy raw insert path (still present in git history) didn't
// give us scheduling; mobile users could schedule, web users couldn't.
// The RPC handles the insert + the AFTER INSERT follower-fanout trigger
// (which is gated on is_hidden=false so scheduled posts don't pre-spam
// notifications).
document.getElementById('btnPostSubmit')?.addEventListener('click', async () => {
  if (_submitting) return;             // re-entrancy guard (see _submitting decl)
  const body = composeText.value.trim();
  if (!body && !composeImageFile) return;
  const user = _cfg.getCurrentUser();
  if (!user) return toast('Please sign in first', 'error');

  _submitting = true;
  const isScheduled = !!composeScheduledAt;
  const scheduledIso = isScheduled ? composeScheduledAt.toISOString() : null;

  const btn = document.getElementById('btnPostSubmit');
  btn.disabled = true;
  btn.textContent = composeImageFile ? 'Uploading...' : (isScheduled ? 'Scheduling...' : 'Posting...');

  let imageUrl = null;
  if (composeImageFile) {
    imageUrl = await _cfg.uploadImage(composeImageFile);
    if (!imageUrl) {
      btn.disabled = false;
      _submitting = false;
      _updateComposeScheduleUI();
      return;
    }
  }

  btn.textContent = isScheduled ? 'Scheduling...' : 'Posting...';

  // submit_post returns { id, status, error } (per the RPC contract).
  // It performs the insert server-side under SECURITY DEFINER, so we
  // don't get the inserted row back with joins like the legacy
  // .insert().select(FEED_SELECT) did. Re-fetch via posts table after
  // for the local prepend, mirroring what mobile's createNewPost does.
  //
  // 9-param call: production has submit_post extended to accept
  // p_is_hidden + p_scheduled_publish_at (migration_scheduled_post_
  // notifications.sql, referenced but not in repo — applied via
  // Supabase SQL editor). This atomic-scheduled-insert path is what
  // mobile uses (selebox-mobile-main/lib/posts.js::createNewPost).
  // The matching AFTER INSERT notification trigger is gated on
  // is_hidden=false so scheduled posts don't fire "shared a post"
  // notifications to followers until the cron flips them live.
  const { data: rpcResult, error: rpcErr } = await supabase.rpc('submit_post', {
    p_actor_id:             user.id,
    p_body:                 body || null,
    p_image_url:            imageUrl,
    p_video_id:             null,
    p_book_id:              null,
    p_reposted_from:        null,
    p_legacy_appwrite_id:   null,
    p_is_hidden:            isScheduled,
    p_scheduled_publish_at: scheduledIso,
  });

  btn.disabled = false;
  if (rpcErr)              { _submitting = false; toast(rpcErr.message, 'error'); _updateComposeScheduleUI(); return; }
  if (rpcResult?.error)    { _submitting = false; toast(rpcResult.error, 'error'); _updateComposeScheduleUI(); return; }
  const newPostId = rpcResult?.id;
  if (!newPostId)          { _submitting = false; toast('Post creation failed (no id returned)', 'error'); _updateComposeScheduleUI(); return; }

  // Re-fetch the row with joins so we can prepend it locally
  // (same shape the legacy .insert().select(FEED_SELECT) returned).
  let created = null;
  if (newPostId) {
    const { data: row } = await supabase
      .from('posts')
      .select(_cfg.feedSelect)
      .eq('id', newPostId)
      .maybeSingle();
    created = row;
  }

  // Reset composer state — caption, image, schedule.
  composeText.value = '';
  composeImageFile = null;
  composeImagePreview.innerHTML = '';
  composeImageInput.value = '';
  charCount.textContent = '0 / 5000';
  composeScheduledAt = null;
  // The old datetime-local input is gone (replaced by the popover with
  // separate date/time inputs in 2026-05-15). The popover inputs reset
  // themselves the next time _openComposeSchedulePopover() runs, so we
  // don't need to clear them here.
  _updateComposeScheduleUI();   // also resets btn text to "Post"

  if (isScheduled) {
    // Scheduled posts shouldn't appear in the feed yet — the AFTER
    // INSERT trigger skipped fanout because is_hidden=true. Toast the
    // confirmation with the scheduled time so the user has feedback.
    toast(`Scheduled for ${new Date(scheduledIso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}`, 'success');
    // Refresh the "X scheduled" pill so it reflects the new total
    // (and reveals itself if this was the user's first scheduled post).
    refreshScheduledPostsBadge();
    _submitting = false;
    return;
  }

  toast('Posted!', 'success');

  // Hand off to app.js — it owns the feed array, render fn, last-seen
  // bump, and scroll behavior. Composer doesn't need to know how the
  // feed is structured.
  if (created) {
    _cfg.onPostCreated(created);
  } else {
    // Safety net — if the SELECT returned nothing for some reason
    // (RLS / shape), fall back to the legacy behavior so the user's
    // post isn't completely invisible.
    _cfg.onPostCreateFallback();
  }
  _submitting = false;
});
