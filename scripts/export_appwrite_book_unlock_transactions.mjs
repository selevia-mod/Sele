// ════════════════════════════════════════════════════════════════════════════
// export_appwrite_book_unlock_transactions.mjs
//
// Step 2 of the unlock recovery pipeline. Step 1
// (export_appwrite_book_unlocks.mjs + the *_from_appwrite_collection.sql
// migration) restored entitlements that exist in Appwrite's
// `users-book-unlocks` but never made it to Supabase. This script catches
// the harder bucket: transactions that DO exist (the user was charged)
// but have NO matching entitlement on Appwrite either — the Cloud
// Function ate the unlock mid-call. Symptom from users: "I bought it,
// I see the charge, but the chapter is still locked."
//
// Dumps `users-book-unlock-transactions` to CSV with one row per
// (user, book, chapter, currency, cost, status) tuple. Companion
// migration:
//   supabase/migrations/2026-05-10_unlocks_backfill_from_transactions.sql
//
// OUTPUT FORMAT
// -------------
// Stdout = CSV. One header row + one data row per transaction:
//
//     appwrite_user_id,appwrite_book_id,appwrite_chapter_id,currency,cost,status
//     69c3...,699f...,69a0...,coin,3,success
//     69fe...,69e8...,69ec...,star,3,success
//
// Note: `currency` is normalized from Appwrite's "coins"/"stars"
// (plural) → Supabase's "coin"/"star" (singular). Saves the migration
// from doing the same translation in SQL.
//
// Status / progress messages go to stderr so `> out.csv` works cleanly.
//
// SETUP
// -----
// Same Appwrite API key as the Step 1 export (documents.read scope).
//
//     APPWRITE_API_KEY=... node scripts/export_appwrite_book_unlock_transactions.mjs > out_txns.csv
//
// CLI flags (optional):
//
//   --include-all-statuses   By default only rows with status starting
//                            with "succ" (success / succeeded /
//                            successful) are exported. Pass this flag
//                            to dump everything — useful if you want
//                            to analyze failed/refunded transactions
//                            for separate refund decisions.
//
// On a ~500k-row collection this takes 10–25 minutes (no per-row
// secondary fetches, just paging through transactions).
// ════════════════════════════════════════════════════════════════════════════

import { Client, Databases, Query } from "node-appwrite";

const ENDPOINT      = "https://fra.cloud.appwrite.io/v1";
const PROJECT       = "66b8be7400121b5d4697";
const DATABASE      = "66b32b3600246bc34956";
const TXNS_COL      = "68ee7453000ef41fa704";

const PAGE_SIZE = 100;
const INCLUDE_ALL_STATUSES = process.argv.includes("--include-all-statuses");

const API_KEY = process.env.APPWRITE_API_KEY;
if (!API_KEY) {
  console.error("Missing APPWRITE_API_KEY env var. See setup notes at top of file.");
  process.exit(1);
}

const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT)
  .setKey(API_KEY);
const db = new Databases(client);

// Normalize Appwrite's plural currency form ("coins" / "stars") to
// Supabase's singular form ("coin" / "star"). Anything we don't
// recognize gets emitted as-is so the SQL can flag it for inspection.
const normalizeCurrency = (raw) => {
  if (!raw) return "";
  const s = String(raw).toLowerCase().trim();
  if (s === "coins" || s === "coin") return "coin";
  if (s === "stars" || s === "star") return "star";
  return s;
};

// Status filter. Appwrite's column header showed "succ..." (truncated)
// so we LIKE against the prefix instead of equality — survives
// "success" / "successful" / "succeeded" without us having to know
// which exact string is in there.
const isSuccessStatus = (status) => {
  if (!status) return false;
  return String(status).toLowerCase().startsWith("succ");
};

// CSV emit. Quote nothing — every field is hex IDs or short keywords.
const emitRow = (userId, bookId, chapterId, currency, cost, status) => {
  process.stdout.write(
    `${userId},${bookId},${chapterId},${currency},${cost},${status}\n`,
  );
};

process.stdout.write("appwrite_user_id,appwrite_book_id,appwrite_chapter_id,currency,cost,status\n");

let cursor = null;
let docsProcessed = 0;
let rowsEmitted = 0;
let skippedNonSuccess = 0;
let skippedMissingFields = 0;
const startedAt = Date.now();

const fmtElapsed = () => {
  const s = Math.round((Date.now() - startedAt) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
};

while (true) {
  const queries = [Query.limit(PAGE_SIZE)];
  if (cursor) queries.push(Query.cursorAfter(cursor));

  let page;
  try {
    page = await db.listDocuments(DATABASE, TXNS_COL, queries);
  } catch (err) {
    console.error(`! list users-book-unlock-transactions page failed: ${err.message}. Aborting.`);
    process.exit(2);
  }
  if (!page.documents.length) break;

  for (const doc of page.documents) {
    docsProcessed++;
    const userId    = doc.userId;
    const bookId    = doc.bookId;
    const chapterId = doc.chapterId;
    const status    = doc.status || "";
    const currency  = normalizeCurrency(doc.type);
    const cost      = Number.isFinite(doc.cost) ? doc.cost : 0;

    if (!userId || !bookId || !chapterId) {
      skippedMissingFields++;
      continue;
    }
    if (!INCLUDE_ALL_STATUSES && !isSuccessStatus(status)) {
      skippedNonSuccess++;
      continue;
    }

    emitRow(userId, bookId, chapterId, currency, cost, status);
    rowsEmitted++;
  }

  if (page.documents.length < PAGE_SIZE) break;
  cursor = page.documents[page.documents.length - 1].$id;

  console.error(
    `[${fmtElapsed()}] docs=${docsProcessed}  rows=${rowsEmitted}  ` +
      `skipped_nonsuccess=${skippedNonSuccess}  skipped_missing=${skippedMissingFields}`,
  );
}

console.error("");
console.error(`DONE in ${fmtElapsed()}.`);
console.error(`  Documents processed         : ${docsProcessed}`);
console.error(`  CSV rows emitted            : ${rowsEmitted}`);
console.error(`  Skipped (non-success status): ${skippedNonSuccess}` + (INCLUDE_ALL_STATUSES ? " [included via --include-all-statuses]" : ""));
console.error(`  Skipped (missing fields)    : ${skippedMissingFields}`);
console.error("");
console.error("Next:");
console.error("  1. Inspect the first few rows of the CSV.");
console.error("  2. Import via psql \\copy:");
console.error("       psql \"$DATABASE_URL\" -c \"\\copy tmp.appwrite_book_unlock_txns_csv from 'out_txns.csv' csv header\"");
console.error("     (the staging table is created by the companion migration).");
console.error("  3. Apply 2026-05-10_unlocks_backfill_from_transactions.sql");
console.error("  4. Run the verification queries at the bottom of the migration.");
