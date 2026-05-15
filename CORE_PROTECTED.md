# Core-Protected Files

**What this is:** A list of files where a change can affect multiple
features at once. Touching any of these requires the **full** SMOKE_TEST.md
run, not just verifying the feature you intended to change.

**Why it exists:** Today (2026-05-15) we learned that "I only touched one
thing" is often a lie when the codebase has shared globals. A typo in the
supabase client init or a column rename in a migration can break things
9,000 lines away. This list flags those landmines.

**When to update:** Add a file here when you discover its blast radius is
larger than expected. Remove a file when the refactor roadmap successfully
isolates it.

---

## Tier 1 — Site goes black if you break this

Touch these only with the smoke test loaded and ready to run.

| File | Why it's protected |
|------|---------------------|
| `index.html` | DOM contract for the entire web client. Renames an `id`, every event listener breaks. |
| `admin.html` | Same as above for the admin shell. |
| `js/app.js` | 24,000-line god file. Until the refactor lands (REFACTOR_ROADMAP.md), every feature touches it. |
| `js/admin.js` | Admin shell — KYC, payouts, earnings moderation, settings. Cross-feature. |
| `private/secrets.js` | API keys + Supabase project config. A typo here kills the entire app's auth + data layer. |
| `scripts/pre-deploy-check.sh` | The safety net itself. Break this, lose protection on every future push. |
| `scripts/install-git-hook.sh` | Hook installer. Break this and new clones miss the safety net. |

---

## Tier 2 — Multiple features depend on this

Less catastrophic but a regression here cascades.

| File | Why |
|------|-----|
| `supabase/migrations/*` | Each migration alters the schema RPCs depend on. A column rename in one breaks every consumer. **Special rule:** verify the migration via `pg_get_functiondef` after deploy. |
| `lib/feature-flags.js` (if it exists on web — currently mobile-only) | Flips behavior across features. |
| `css/styles.css`, `css/admin.css` | Visual contract. A CSS-variable rename or selector specificity change can blow out an unrelated screen. |
| `js/event-log.js` | Telemetry helper imported by `app.js`. If absent, the whole script fails to load (we hit this earlier — the original pure-black-page incident). |

---

## Tier 3 — Migration / config files

These don't get pushed via `git push` but still need protection.

| Surface | Why |
|---------|-----|
| Supabase RLS policies | Changing one can hide data from the wrong users. Verify with: a known user can still read what they should, a known stranger cannot read what they shouldn't. |
| pg_cron jobs (e.g. `promote_scheduled_content`) | A misconfigured cron drops scheduled posts forever. Verify the cron `schedule` column after each rename. |
| Bunny.net storage zone keys | Lose these, every image / video URL 404s. |
| HitPay payout config | Withdrawal flow depends on this. Out-of-band change → notify Charles before deploying. |

---

## Tier 4 — Files that LOOK shared but aren't

For clarity — these are commonly mistaken as core but are actually scoped.

| File | Actual scope |
|------|--------------|
| `js/app.js` post-Stage-1 (notifications extracted) | Will shrink as the roadmap lands. Update this doc when each stage ships. |
| `admin.html` post-refactor | Eventually splits into per-section files. Track in REFACTOR_ROADMAP.md. |
| Mobile files (`selebox-mobile-main/*`) | Different repo entirely. Web changes never touch mobile. |

---

## Rules when you touch a Tier-1 or Tier-2 file

1. **Pre-deploy script must pass.** (`scripts/pre-deploy-check.sh`)
2. **Full SMOKE_TEST.md must pass** — not just the feature you intended.
3. **Document the change in the PR / commit body.** What did you change in
   the core file? Why? What unrelated paths might be affected?
4. **Deploy alone, then watch.** Don't pile a Tier-1 change in with three
   feature changes. Push it as its own commit so you can git-bisect if
   something explodes 6 hours later.
5. **Open Sentry** after deploy. If any feature's error rate spikes within
   30 min, you probably broke something. Be ready to revert.

---

## How the pre-deploy script enforces this

`scripts/pre-deploy-check.sh` checks the git diff against `origin/main` for
any file matching the Tier-1 + Tier-2 patterns. If any are present, it
prints a warning (not a failure) reminding you to run the full smoke test:

```
⚠ Core-protected file in this push:
    index.html
    js/app.js
  Run SMOKE_TEST.md before merging develop → main.
```

The warning doesn't block the push (you're allowed to change these files —
just not blindly). It nudges you to take the extra 10 minutes of testing.

---

## When this list is wrong

Same rule as everything else: update it. If you find a file whose blast
radius surprised you, add it here. If you successfully extract a file out
of `app.js` and it's now properly isolated, move it down a tier or remove
it from the list entirely.

This file is part of the codebase's institutional memory. Future-you (and
future devs) read it to learn what bit us.
