# Selebox Web Smoke Test

**When to run:** Before every `develop → main` merge. Also after touching
anything in `CORE_PROTECTED.md`.

**How long:** ~10 minutes if everything works. If anything fails, STOP and
fix before merging.

**Test account:** Use the Sammy account (`charlesbcalague@gmail.com`)
unless a specific item needs a different role.

---

## How to use this

Walk through each item top to bottom. For each:

- ✓ if it works exactly as described → move on
- ✗ if it doesn't → STOP. Note what failed. Don't merge.

Don't skip items. The whole point is that a regression in step 4 might be
caused by a change you made for step 7.

If you're under time pressure and absolutely must merge with a known
broken item, document it as a hotfix-blocker in the commit message:
`KNOWN REGRESSION: step N — [reason] — hotfix follows.`

---

## The 10 items

### 1. Sign in
- [ ] Open the site, click Sign in
- [ ] Sign in with Sammy's account
- [ ] Land on the home feed
- **Expect:** no console errors, sidebar visible, avatar shows in topbar

### 2. For You feed loads
- [ ] Click "For You" tab
- [ ] Wait ~2 seconds
- **Expect:** Posts render, at least one book carousel appears every ~7
  posts ("📚 Books worth reading" header), arrows on the carousel work,
  no black screen

### 3. Submit a text post
- [ ] In the composer, type "smoke test"
- [ ] Click Post
- **Expect:** Toast says "Posted!", post appears at top of feed, no error

### 4. Notifications bell
- [ ] Click the bell icon (top right)
- [ ] Look at the recent "started following you" rows
- **Expect:** Multiple followers grouped as "X and N others started
  following you", NOT individual rows per follower

### 5. Tap a notification
- [ ] Click any notification row
- **Expect:** Routes to the relevant surface (post, profile, video, or
  Payments for withdrawal notifications). No black screen.

### 6. Profile videos visible
- [ ] Open Sammy's profile
- [ ] Click the Videos tab
- **Expect:** Sammy's recent uploads appear (the bug we fixed today —
  status='published' should be visible)

### 7. Play a video
- [ ] Click any video card in the feed or profile
- **Expect:** Video player opens, video plays, no error

### 8. Withdrawal flow (admin)
- [ ] Sign out, sign in as admin (juncalague26@gmail.com)
- [ ] Open admin → Payouts → Withdrawals
- [ ] Find a pending withdrawal (if none, skip this step)
- [ ] Click Approve
- **Expect:** Status flips to 'approved', a notification row for the
  creator gets inserted within ~1 second (verify via SQL or re-open the
  list)

### 9. Admin KYC list
- [ ] Still as admin
- [ ] Open Payouts → KYC list
- [ ] Click any row
- **Expect:** Detail modal opens with verification card, photo previews
  load, action buttons render (Reject/Revoke/Freeze/Ban/Change role for
  super-admin)

### 10. Schedule a post
- [ ] Sign back in as Sammy
- [ ] In the composer, click Schedule
- [ ] Pick a time ~5 minutes in the future
- [ ] Type "scheduled smoke test"
- [ ] Click Schedule
- **Expect:** Toast "Scheduled for X", post does NOT appear in feed,
  "N scheduled" pill appears near the composer, clicking it opens a modal
  with the row, Publish-now / Cancel buttons work

---

## Bonus items (run if you have time)

These are second-tier — nice to verify but not catastrophic if broken.

- [ ] Sidebar nav: every icon (Home / Books / Videos / Playlist / Messages /
      Notifications / Profile) navigates without console error
- [ ] Dark mode toggle (if exposed in the UI) flips theme
- [ ] Search bar returns results
- [ ] Comment on a post → comment appears
- [ ] Like a post → counter increments

---

## What to do when something fails

1. **STOP.** Do not merge `develop → main`.
2. Note which step failed, what you saw, browser console errors if any.
3. If the failure is in a step that worked yesterday, this is a regression
   from changes on `develop` since the last release.
4. Use `git log main..develop --oneline` to see what changed since
   production. The bug is in one of those commits.
5. Fix on a `fix/*` branch off `develop`, merge back, re-run this whole
   smoke test from step 1.

---

## When this list lies

Same rule as `BRANCHING.md`: update this file. If a critical user path
isn't here and gets broken, add it after the fix lands. The smoke test
grows by accretion as we learn what matters.

---

## Sign-off

Before merging `develop → main`, paste this in the merge commit message:

```
Smoke test passed 2026-MM-DD:
  1. Sign in              ✓
  2. For You feed loads   ✓
  3. Submit text post     ✓
  4. Notifications group  ✓
  5. Tap notification     ✓
  6. Profile videos       ✓
  7. Play video           ✓
  8. Withdrawal approve   ✓
  9. Admin KYC detail     ✓
 10. Schedule post        ✓
```

If you skipped any, write `(skipped — [reason])` next to it.
