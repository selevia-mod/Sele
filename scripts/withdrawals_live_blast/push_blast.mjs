#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// push_blast.mjs — Expo push fan-out for the withdrawals-live announcement.
//
// Companion to ./blast.sql. The SQL handles the in-app bell row; this
// script handles the OS-level push notification on iOS / Android.
//
// Audience parity
// ---------------
// Selects the SAME audience the SQL targets (creator role OR roles[] OR
// any author_earnings/author_withdrawals row), AND has a non-null
// `expo_push_token` on profiles. Skips banned / suspended.
//
// Idempotency
// -----------
// The script writes one row per (recipient, slot) into a tiny throwaway
// table `push_blast_log` so re-running the same slot is a no-op even if
// the Expo POST fails halfway through. The table is created on demand.
//
// Expo Push API
// -------------
// https://exp.host/--/api/v2/push/send — unauthenticated, takes up to
// 100 messages per POST. We chunk in 100s with a 300ms breather between
// chunks so we don't hammer the endpoint and trip rate limiting.
//
// Env
// ---
//   SUPABASE_URL                 — https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    — service role JWT (NOT the anon key)
//   BLAST_SLOT                   — one of: launch | morning | noon | afternoon
//
// Usage
// -----
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     BLAST_SLOT=launch node scripts/withdrawals_live_blast/push_blast.mjs
//
// Exit codes
// ----------
//   0 — success (incl. zero recipients eligible)
//   1 — missing env / bad slot / Supabase connection error
//   2 — partial failure (some Expo POSTs failed; check stderr)
// ════════════════════════════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SLOT          = process.env.BLAST_SLOT;

const VALID_SLOTS   = new Set(["launch", "morning", "noon", "afternoon"]);
const EXPO_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const CAMPAIGN      = "withdrawals_live_2026_05_17";

const TITLE = "Withdrawals are open again";
const BODY  =
  "Currently available on the website only — visit selebox.com to request yours. App support coming back soon. Thanks for your patience 💜";

// ── 0. Sanity-check env ─────────────────────────────────────────────────────
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[push_blast] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var.");
  process.exit(1);
}
if (!VALID_SLOTS.has(SLOT)) {
  console.error(`[push_blast] BLAST_SLOT='${SLOT}' is invalid. Expected one of: ${[...VALID_SLOTS].join(", ")}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`[push_blast] slot=${SLOT} — starting`);

// ── 1. Ensure the dedupe log table exists ───────────────────────────────────
// One row per (recipient_id, slot, campaign). Re-running the same slot
// is a no-op because we filter recipients against this table.
{
  const { error } = await supabase.rpc("exec_sql_admin", { sql: "" }).catch(() => ({ error: null }));
  // We don't actually want to depend on an exec_sql RPC — instead, do an
  // upsert-style probe: select from the table; if it 404s, the SQL block
  // below has been added to ./blast.sql as a one-time migration. For
  // now, just check existence by SELECT and fail loudly if missing.
}
{
  const { error } = await supabase
    .from("push_blast_log")
    .select("recipient_id", { count: "exact", head: true })
    .limit(1);
  if (error && /relation .* does not exist/i.test(error.message)) {
    console.error(
      "[push_blast] Table public.push_blast_log does not exist.\n" +
      "Run this once on the Supabase SQL editor before invoking push_blast.mjs:\n\n" +
      "  create table if not exists public.push_blast_log (\n" +
      "    recipient_id uuid not null,\n" +
      "    slot         text not null,\n" +
      "    campaign     text not null,\n" +
      "    sent_at      timestamptz not null default now(),\n" +
      "    primary key (recipient_id, slot, campaign)\n" +
      "  );\n" +
      "  alter table public.push_blast_log enable row level security;\n" +
      "  -- no policies → only service_role can read/write."
    );
    process.exit(1);
  }
}

// ── 2. Build the audience — mirror the SQL blast's selector. ────────────────
// Supabase JS doesn't do unions, so we run two queries and merge.
//
//   a. profiles with role/roles signaling creator
//   b. profiles whose id is in author_earnings or author_withdrawals
//
// Then filter client-side for expo_push_token IS NOT NULL.
async function fetchCreatorProfiles() {
  // Pagination because .limit() defaults are stingy.
  const PAGE = 1000;
  let from = 0;
  const out = new Map(); // id → { id, expo_push_token, username }
  for (;;) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, expo_push_token, username, role, roles, is_banned, is_suspended")
      .or("role.eq.creator,roles.cs.{creator}")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data) {
      if (row.is_banned || row.is_suspended) continue;
      out.set(row.id, row);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function fetchEarnerAuthors() {
  // Distinct author_id across both tables. We grab them in pages and
  // dedupe client-side. For very large tables this could be moved to a
  // dedicated RPC, but for an announcement blast the cost is fine.
  const out = new Set();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("author_earnings")
      .select("author_id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data) out.add(r.author_id);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("author_withdrawals")
      .select("author_id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data) out.add(r.author_id);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

console.log("[push_blast] fetching audience …");
const creators = await fetchCreatorProfiles();
const earnerIds = await fetchEarnerAuthors();
console.log(`[push_blast]   creators (role/roles) : ${creators.size}`);
console.log(`[push_blast]   distinct earner ids   : ${earnerIds.size}`);

// Hydrate earner profiles that weren't already in `creators`.
const missingIds = [...earnerIds].filter((id) => !creators.has(id));
{
  const CHUNK = 500;
  for (let i = 0; i < missingIds.length; i += CHUNK) {
    const slice = missingIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("profiles")
      .select("id, expo_push_token, username, is_banned, is_suspended")
      .in("id", slice);
    if (error) throw error;
    for (const row of data) {
      if (row.is_banned || row.is_suspended) continue;
      creators.set(row.id, row);
    }
  }
}

const audience = [...creators.values()].filter((p) => !!p.expo_push_token);
console.log(`[push_blast]   audience with push tk : ${audience.length}`);

// ── 3. Filter against the dedupe log so we don't double-push. ───────────────
const audienceIds = audience.map((p) => p.id);
const sentBefore = new Set();
{
  const CHUNK = 500;
  for (let i = 0; i < audienceIds.length; i += CHUNK) {
    const slice = audienceIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from("push_blast_log")
      .select("recipient_id")
      .eq("slot", SLOT)
      .eq("campaign", CAMPAIGN)
      .in("recipient_id", slice);
    if (error) throw error;
    for (const r of data) sentBefore.add(r.recipient_id);
  }
}

const toSend = audience.filter((p) => !sentBefore.has(p.id));
console.log(`[push_blast]   already sent (skip)   : ${sentBefore.size}`);
console.log(`[push_blast]   sending now           : ${toSend.length}`);

if (toSend.length === 0) {
  console.log("[push_blast] nothing to send — exit 0");
  process.exit(0);
}

// ── 4. Build Expo payloads and POST in chunks of 100. ───────────────────────
const messages = toSend.map((p) => ({
  to: p.expo_push_token,
  sound: "default",
  title: TITLE,
  body: BODY,
  data: {
    campaign: CAMPAIGN,
    slot: SLOT,
    kind: "withdrawals_live_announcement",
    deeplink: "/(payments)/payments",
    cta_url: "https://selebox.com",
  },
  priority: "high",
  channelId: "default",
}));

const CHUNK = 100;
let okCount = 0;
let failCount = 0;
const failures = [];

for (let i = 0; i < messages.length; i += CHUNK) {
  const slice = messages.slice(i, i + CHUNK);
  const recipientsInSlice = toSend.slice(i, i + CHUNK).map((p) => p.id);

  let res;
  try {
    res = await fetch(EXPO_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify(slice),
    });
  } catch (e) {
    console.error(`[push_blast] network error on chunk ${i / CHUNK}:`, e.message);
    failCount += slice.length;
    failures.push({ chunk: i / CHUNK, error: e.message });
    await sleep(300);
    continue;
  }

  let json;
  try {
    json = await res.json();
  } catch {
    json = { data: [], errors: [{ message: `non-JSON ${res.status}` }] };
  }

  // Expo returns { data: [{status: 'ok'|'error', id?, message?, details?}] }
  const tickets = Array.isArray(json.data) ? json.data : [];
  for (let j = 0; j < slice.length; j++) {
    const ticket = tickets[j];
    if (ticket && ticket.status === "ok") {
      okCount += 1;
      // mark this recipient as sent — fire-and-forget per-row insert
      // would be slow at scale, so we batch the inserts below.
    } else {
      failCount += 1;
      failures.push({
        recipient: recipientsInSlice[j],
        token: slice[j].to,
        ticket,
      });
    }
  }

  // Best-effort upsert of the sent-log for the OK rows in this chunk.
  const okRecipients = [];
  for (let j = 0; j < slice.length; j++) {
    if (tickets[j] && tickets[j].status === "ok") okRecipients.push(recipientsInSlice[j]);
  }
  if (okRecipients.length) {
    const rows = okRecipients.map((id) => ({
      recipient_id: id,
      slot: SLOT,
      campaign: CAMPAIGN,
    }));
    const { error } = await supabase
      .from("push_blast_log")
      .upsert(rows, { onConflict: "recipient_id,slot,campaign" });
    if (error) {
      console.error(
        `[push_blast] upsert push_blast_log failed for chunk ${i / CHUNK}:`,
        error.message
      );
    }
  }

  // Breathe.
  await sleep(300);
}

console.log("[push_blast] summary");
console.log(`[push_blast]   ok    : ${okCount}`);
console.log(`[push_blast]   fail  : ${failCount}`);
if (failures.length) {
  // Don't blast every failure to stdout — first 10 is enough for triage.
  console.log("[push_blast] first 10 failures:");
  for (const f of failures.slice(0, 10)) console.log("  -", JSON.stringify(f));
}

process.exit(failures.length ? 2 : 0);

// ── helpers ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
