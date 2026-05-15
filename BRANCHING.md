# Selebox Branching Workflow

**TL;DR** — `main` is sacred (production). Everything else flows through
`develop`. Never commit straight to `main` except via a hotfix.

```
main         ←  production. What users see right now.
  ↑
develop      ←  integration. What we'll release next.
  ↑
feature/*    ←  new functionality
fix/*        ←  bug fixes
hotfix/*     ←  emergency production patches (bypass develop)
```

---

## Why this exists

Until now, every change went straight to `main`. That meant **every push
shipped to production immediately** — including the ones that black-screened
the site, broke the post button, and ungrouped notifications. We had no
buffer between "I think this works" and "users see it."

`develop` is the buffer. Code lives there, gets the full smoke test, then
moves to `main`.

---

## One-time setup

Run these once on your local clone:

```bash
cd /Users/arcaracalague/Documents/Selebox

# Create the develop branch off main and push it.
git checkout main
git pull
git checkout -b develop
git push -u origin develop

# Set develop as the default working branch.
git config --local init.defaultBranch develop
```

After this, `git status` should say "On branch develop" by default.

---

## Daily flow — new feature

You're building something new (e.g. the repost-on-feed-card flow).

```bash
# 1. Start fresh from develop
git checkout develop
git pull

# 2. Branch off
git checkout -b feature/repost-feed-card

# 3. Code + commit as usual
git add js/feed.js js/app.js
git commit -m "Feed: repost button on each card"

# 4. When ready to share/merge, push
git push -u origin feature/repost-feed-card

# 5. Merge back into develop
git checkout develop
git pull
git merge --no-ff feature/repost-feed-card
git push

# 6. Test on develop (run SMOKE_TEST.md)
# 7. If all good, merge develop → main for production deploy
git checkout main
git pull
git merge --ff-only develop
git push      # ← pre-deploy guard runs here

# 8. Clean up the feature branch
git branch -d feature/repost-feed-card
git push origin --delete feature/repost-feed-card
```

---

## Daily flow — bug fix

Same as feature flow but with `fix/` prefix. Example:

```bash
git checkout develop && git pull
git checkout -b fix/notification-grouping
# ... edit, commit ...
git push -u origin fix/notification-grouping
# merge to develop → smoke test → merge to main
```

The `fix/*` vs `feature/*` distinction is just for the log — when you scan
git history later, you can tell at a glance what was new vs what was
patching existing behaviour.

---

## Emergency flow — hotfix

The site is on fire RIGHT NOW. A user lost data. You don't have time to go
through develop.

```bash
# 1. Branch directly off main
git checkout main
git pull
git checkout -b hotfix/withdrawal-trigger-uuid-cast

# 2. Make the minimum fix. NOTHING ELSE.
git add supabase/migrations/2026-05-15_withdrawal_notif_uuid_cast_fix.sql
git commit -m "Hotfix: uuid cast in withdrawal notification trigger"

# 3. Run pre-deploy script
./scripts/pre-deploy-check.sh

# 4. Merge into main
git checkout main
git merge --ff-only hotfix/withdrawal-trigger-uuid-cast
git push

# 5. ALSO merge into develop so the fix doesn't get reverted next release
git checkout develop
git pull
git merge --no-ff hotfix/withdrawal-trigger-uuid-cast
git push

# 6. Clean up
git branch -d hotfix/withdrawal-trigger-uuid-cast
git push origin --delete hotfix/withdrawal-trigger-uuid-cast
```

**Rules for hotfix:**
- Smallest possible change
- No drive-by refactors
- Both branches get the fix (otherwise the next release re-introduces the bug)

---

## What happens on `git push`

The pre-deploy script (`scripts/pre-deploy-check.sh`) runs automatically as
a `pre-push` hook. It checks:

1. Duplicate HTML `id` values
2. Duplicate JS function declarations
3. JavaScript syntax (`node --check`)
4. Orphan call sweep (best-effort)
5. Stale placeholders

If any blocking check fails (✗), the push aborts. Fix the issue, then push
again. If you need to bypass for a known reason, use `git push --no-verify`
— but only for things like committing a deliberately-failing fixture.

---

## Branch naming cheat sheet

| Prefix     | When to use                          | Example                              |
|------------|--------------------------------------|--------------------------------------|
| `feature/` | New user-visible functionality       | `feature/post-scheduling`            |
| `fix/`     | Bug in existing functionality        | `fix/notification-grouping`          |
| `hotfix/`  | Production is broken, must ship now  | `hotfix/black-screen-regression`     |
| `refactor/`| Internal restructure, no behaviour Δ | `refactor/extract-notifications`     |
| `chore/`   | Tooling, deps, build scripts         | `chore/update-pre-deploy-script`     |

Use kebab-case. Keep names ≤50 chars. The branch name should answer "what
will this PR be titled?" before you've finished it.

---

## When to merge develop → main

Don't merge on a schedule. Merge when **all** of these are true:

- Pre-deploy script passes
- Manual `SMOKE_TEST.md` checklist passes
- No known regressions on the develop deploy
- The change is small enough to roll back cleanly if needed

If you're unsure, wait. Small frequent releases are safer than big batched
ones, but a release with an unfixed regression is worse than no release.

---

## What never goes in this flow

- **Migrations directly to production Supabase.** Those are deployed via
  the Supabase SQL editor, separately from the web push. Document each
  one in the migration file's verification block.
- **Mobile app changes.** `selebox-mobile-main` has its own repo with the
  `eas update --branch main` flow documented in its `CLAUDE.md`.
- **`private/secrets.js` rotations.** Done out-of-band; never commit a
  diff that exposes a new secret value.

---

## When this doc lies

Update it. This is the source of truth for "how we ship." If a real
scenario doesn't fit one of the flows above, add the flow here before
running it. Future-you will thank you.
