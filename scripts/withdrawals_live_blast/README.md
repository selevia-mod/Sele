# Withdrawals-live announcement blast — 2026-05-17

Re-engagement blast announcing that withdrawals are back, **website-only** for now.

## What goes out

- **Push** (Expo) — every creator with an Expo push token
- **In-app bell** — every creator (same audience; broader because not everyone has a push token)

Copy (both surfaces):

> **Withdrawals are open again**
> Currently available on the website only — visit selebox.com to request yours. App support coming back soon. Thanks for your patience 💜

## Audience

A creator is any profile that meets ANY of the following:

- `profiles.role = 'creator'`
- `'creator' = ANY(profiles.roles)`
- has at least one row in `author_earnings`
- has at least one row in `author_withdrawals`

Banned / suspended profiles are excluded.

## Slots — 4 sends across the day

| Slot        | Local time (Asia/Manila) | Trigger                          |
| ----------- | ------------------------ | -------------------------------- |
| `launch`    | now (2026-05-17 ~00:00)  | run-once at the bottom of `blast.sql` |
| `morning`   | 09:00                    | scheduled Claude task            |
| `noon`      | 12:00                    | scheduled Claude task            |
| `afternoon` | 15:00                    | scheduled Claude task            |

Each slot is independent — re-running the same slot is a no-op (idempotent via `metadata->>'ref'` on the notification row and the `push_blast_log` table for push).

## Step 1 — Run the SQL (Supabase Dashboard)

Paste **`blast.sql`** into the SQL editor and run it. This:

1. Creates `public.push_blast_log` (dedupe table for push).
2. Creates `public.send_withdrawals_live_blast(p_slot text)`.
3. Calls it with `'launch'` — the first slot fires immediately.

It returns `(inserted_count, skipped_count)` so you can sanity-check the audience size before the push.

## Step 2 — Run the push fan-out

```bash
cd /Users/arcaracalague/Documents/Selebox
SUPABASE_URL='https://<your-project>.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='<service-role-jwt>' \
BLAST_SLOT='launch' \
node scripts/withdrawals_live_blast/push_blast.mjs
```

Exit codes:

- `0` — all Expo POSTs succeeded
- `2` — partial failure (check stderr for first 10 failed recipients)

## Steps 3–5 — Subsequent slots (morning / noon / afternoon)

For each remaining slot, repeat both the SQL call AND the push:

```sql
-- on the SQL editor
select * from public.send_withdrawals_live_blast('morning');
```

```bash
# in a terminal
SUPABASE_URL='...' SUPABASE_SERVICE_ROLE_KEY='...' \
  BLAST_SLOT='morning' \
  node scripts/withdrawals_live_blast/push_blast.mjs
```

(Substitute `noon` and `afternoon` for the later slots.)

The scheduled-task companion (see `Claude/Scheduled/withdrawals-blast-*` if you set them up) automates the reminder.

## Rollback

```sql
-- pulls every notification this campaign inserted (across all slots)
delete from public.notifications
 where metadata->>'campaign' = 'withdrawals_live_2026_05_17';

-- and the push dedupe log
truncate public.push_blast_log;

-- drop the function if you don't plan to reuse it for future campaigns
drop function if exists public.send_withdrawals_live_blast(text);
drop table    if exists public.push_blast_log;
```

Push notifications are fire-and-forget on the OS — you can't recall delivered ones.
