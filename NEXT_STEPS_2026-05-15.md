# Next steps — Selebox roadmap
## Last updated: 2026-05-15

The single tracking doc for everything left after today's earnings hardening
session. Items are roughly in order of when they should happen. Cross-
reference docs are linked where they go deeper.

---

## A. Before Saturday's withdrawal re-enable (must-do)

- [ ] **Smoke-test the withdrawal flow end-to-end** on your own creator
      account. Submit a small test withdrawal → approve as admin →
      mark paid. Confirm:
      - The "Approved" notification lands on mobile
      - "Payment sent" notification fires after mark-paid with the
        `hitpay_payout_ref`
      - `author_earnings` rows flip to `status='withdrawn'`
      - Admin Payouts tab shows `status='paid'`

- [ ] **Decide on Sentry + Google Analytics.** Either set them up
      (~5 min each on the respective dashboards, then paste keys into
      `index.html`) or rip the placeholder blocks out so they're not
      pretending to work. Strongly recommended: wire Sentry before
      Saturday so you see any JS error during the first hour of
      re-enable. See SELEBOX_WEB_AUDIT_2026-05-15.md §1.1–1.2.

- [ ] **Flip the disabled flag on the Withdraw button.** `index.html`
      line 1552. Remove `disabled aria-disabled="true"`. Remove or
      update the maintenance banner (lines 1490–1503). Commit + push
      the web. The button is live the moment the push deploys.

## B. Saturday operations

- [ ] Flip the button. Watch the admin Payouts tab for the first few
      hours of activity.
- [ ] First real withdrawal that comes through = your acceptance test.
      Confirm the full chain works on a real creator: request → approve →
      mark paid → notification → `author_earnings` flips to withdrawn.
- [ ] Post a brief community message that withdrawals are live again.

## C. Next week — earnings polish

- [ ] **Mobile notification routing for `target_type='withdrawal'`.**
      Open `app/(notification)/notification.jsx` and confirm the tap
      handler navigates to `/(payments)/payments` when target_type is
      `'withdrawal'`. If it doesn't, add the case. One-line fix.

- [ ] **Task #123 — advisory locks on `unlock_content` and
      `unlock_book_bulk`.** Pull canonical RPC bodies from production
      via `pg_get_functiondef()`, retrofit the same `pg_advisory_xact_lock`
      pattern we put on `unlock_video_threshold`. Currently the
      date-predicated UNIQUE catches duplicates at the DB level as
      a safety net, but the advisory lock is the proper fix that
      makes the unlock RPC race-proof end-to-end.

- [ ] **Optional: clean up 25 orphan paid withdrawals.** Section 1 of
      `orphan-withdrawals-backfill.sql` shows what they are. They
      don't affect creator balances (the defensive offset in
      `author_balance_for` compensates at read time) but the data is
      inconsistent. Section 2 has the backfill SQL — review section 1
      output first, then decide.

- [ ] **Optional: investigate the `wallet_debits=0` phantom credit
      source.** Figure out which historical backfill or buggy code path
      created the ₱15K of phantom book_bulk credits we're absorbing.
      Knowing the source lets us prevent the same shape of bug elsewhere.

## D. Web audit — medium-term sprints

Full audit doc: `SELEBOX_WEB_AUDIT_2026-05-15.md`. Summarized in priority
order:

- [ ] **Sprint 1 (~1–2 days):** live placeholders + ship-blockers.
      Sentry DSN, GA ID, "Dear Jen" hardcode in featured slot, group
      mute returning false hardcoded, withdrawal-button date in the
      maintenance banner.

- [ ] **Sprint 2 (~5–7 days):** mobile parity for the For You feed.
      Port `fetch_hybrid_feed` consumption on web, add display_name
      to every profile SELECT, add the profile-preview-on-tap
      interaction, swap video posts from full-player-inline to
      thumbnail-with-tap. This is your #1 stated user complaint.

- [ ] **Sprint 3 (~3–5 days):** reader social on book pages.
      Tap-to-rate stars, follow author button, share, report. Closes
      the most obvious "this feels half-built" reader gap.

- [ ] **Sprint 4 (~2–3 weeks):** comments + reactions everywhere.
      Video comments rendering (the HTML shell exists, no JS),
      chapter-bottom comments, inline chapter comments, emoji
      reactions on comments.

- [ ] **Sprint 5 (~3–5 days):** creator tool polish. KYC photo
      upload UI (currently the RPC accepts URLs but the form
      hardcodes null), earnings rejection-reason modal, studio
      thumbnail column.

- [ ] **Sprint 6 (~1.5 weeks):** reader experience polish — theme/
      font controls, reading progress, search filters, notifications
      panel list rendering.

- [ ] **Sprint 7 (~1 week):** the polish tail — dark-mode CSS sweep
      (14+ hard-coded `#fff`), accessibility (aria-label on icon
      buttons, modal aria-modal, focus trap), z-index scale
      definition, iOS safe-area-inset on fixed elements.

## E. Process — pre-deploy checklist

Add to `CLAUDE.md` or a new `DEPLOY.md`:

```
Before `git push` on web or `eas update` on mobile:
1. grep for TODO / FIXME / YOUR_ / XXXXXXX / HARDCODED — confirm
   each is intentional
2. git status — confirm no untracked files are imported by tracked
   files (the event-log.js incident)
3. For SQL migrations, manually check the deployed function body of
   any RPC the migration replaces (the goals wallet credit incident)
4. Glance at the diff one more time before pushing
```

Five minutes of friction per deploy. Would have caught:
- The Sentry DSN being a literal placeholder
- The Google Analytics ID being G-XXXXXXXXXX
- The goals wallet credit shipped as commented-out pseudocode
- The `js/event-log.js` untracked file killing the last web deploy
- The `external_ref` column name mismatch I made earlier today

## F. Comms backlog

- [ ] **Goals backfill notification** for the 63 users we paid back
      (107 coins + 428 stars). Draft text was written earlier today;
      send as in-app banner or push.

- [ ] **Saturday withdrawal re-enable announcement.** Short
      community-GC message when the button flips.

- [ ] **No comms needed for the dedupe** — we didn't run it. Existing
      balances are untouched.

## G. Done today (reference)

The complete list of what landed today in case you need to refer
back:

**Server-side (Supabase deployed):**
- v3 of `claim_user_goal_pool` — wallet credit unlocked, goals backfill
  for 63 users (107 coins + 428 stars)
- `_unlock_lock_key` helper + advisory lock on `unlock_video_threshold`
- `_notify_withdrawal_status_change` trigger on `author_withdrawals`
- Idempotent `admin_approve_withdrawal`
- Date-predicated UNIQUE on `author_earnings`

**Mobile OTA (live on user phones, update group 55296680-…):**
- Goals login-tick chatUserId gate + self-heal fallback
- Goals claim handler waits for server response with friendly errors
- Android photo upload green-screen fix across every upload path
- Reading list save latency fix
- Chapter inline image clamp + render-loop hotfix
- Book shelf cover-staleness Redux Persist v2 migrate

**Web (live at commit b4c6b73):**
- 5-step video upload wizard with auto-thumbnails + success modal
- Chapter editor paste handler for Word/Google Docs
- Studio edit thumbnail UI
- Chapter inline image CSS clamp
- `event-log.js` (the hotfix after the first deploy went black)

**Documentation produced:**
- `SELEBOX_WEB_AUDIT_2026-05-15.md` — full web audit with prioritized sprints
- `EARNINGS_VERIFICATION_MATRIX_2026-05-15.md` — Day 1 earnings audit
- `ROLLBACK_PLAN_2026-05-15.md` — withdrawal failure recovery runbook
- `NEXT_STEPS_2026-05-15.md` — this file
- Various diagnostic + migration SQL files

---

Update this file as items move from `[ ]` to `[x]`. Keep it as the
single source of truth for "what's next."
