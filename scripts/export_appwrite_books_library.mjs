// ════════════════════════════════════════════════════════════════════════════
// export_appwrite_books_library.mjs
//
// Dumps the legacy Appwrite `books-library` collection to CSV — every
// "user bookmarked book" record. Companion to:
//   supabase/migrations/2026-05-10_book_bookmarks_backfill_from_appwrite.sql
//
// WHY THIS EXISTS
// ---------------
// Same shape as the unlock recovery: the original Appwrite → Supabase
// migration left some bookmarks behind. The library cap was raised to
// 50 (task #70) but heavy savers who hit the old cap on Appwrite have
// books in their legacy library that never propagated to Supabase
// public.book_bookmarks. Their library on the new app shows only the
// post-migration saves; everything from before is gone from their view
// even though it's still visible in Appwrite.
//
// OUTPUT FORMAT
// -------------
// Stdout = CSV. One header row + one data row per (user, book) pair:
//
//     appwrite_user_id,appwrite_book_id,created_at
//     69c3...,69f6...,2026-04-12T08:34:21.000Z
//     68eb...,68f5...,2026-03-02T19:02:54.000Z
//
// `created_at` is the Appwrite `$createdAt` ISO timestamp — passed
// through so the backfill can preserve the original bookmark date
// instead of stamping everything as "saved today" (which would
// scramble each user's "Recently saved" ordering).
//
// Status / progress messages go to stderr.
//
// SETUP
// -----
// Same Appwrite API key as the unlock exports (documents.read scope).
//
//     APPWRITE_API_KEY=... node scripts/export_appwrite_books_library.mjs > out_library.csv
//
// On a ~24k-row collection this takes 1–3 minutes.
// ════════════════════════════════════════════════════════════════════════════

import { Client, Databases, Query } from "node-appwrite";

const ENDPOINT             = "https://fra.cloud.appwrite.io/v1";
const PROJECT              = "66b8be7400121b5d4697";
const DATABASE             = "66b32b3600246bc34956";
const BOOKS_LIBRARY_COL    = "68e651f1001a61697373";

const PAGE_SIZE = 100;

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

// CSV emit. user_id and book_id are hex; created_at is ISO 8601 from
// Appwrite (already safe for CSV — no commas, no quotes).
const emitRow = (userId, bookId, createdAt) => {
  process.stdout.write(`${userId},${bookId},${createdAt}\n`);
};

process.stdout.write("appwrite_user_id,appwrite_book_id,created_at\n");

let cursor = null;
let docsProcessed = 0;
let rowsEmitted = 0;
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
    page = await db.listDocuments(DATABASE, BOOKS_LIBRARY_COL, queries);
  } catch (err) {
    console.error(`! list books-library page failed: ${err.message}. Aborting.`);
    process.exit(2);
  }
  if (!page.documents.length) break;

  for (const doc of page.documents) {
    docsProcessed++;
    const userId    = doc.user;
    const bookId    = doc.book;
    const createdAt = doc.$createdAt;

    if (!userId || !bookId) {
      skippedMissingFields++;
      continue;
    }

    emitRow(userId, bookId, createdAt || "");
    rowsEmitted++;
  }

  if (page.documents.length < PAGE_SIZE) break;
  cursor = page.documents[page.documents.length - 1].$id;

  console.error(
    `[${fmtElapsed()}] docs=${docsProcessed}  rows=${rowsEmitted}  skipped_missing=${skippedMissingFields}`,
  );
}

console.error("");
console.error(`DONE in ${fmtElapsed()}.`);
console.error(`  Documents processed       : ${docsProcessed}`);
console.error(`  CSV rows emitted          : ${rowsEmitted}`);
console.error(`  Skipped (missing fields)  : ${skippedMissingFields}`);
console.error("");
console.error("Next:");
console.error("  1. head -n 6 out_library.csv");
console.error("  2. Apply the staging migration (creates the table):");
console.error("       2026-05-10_book_bookmarks_backfill_from_appwrite.sql");
console.error("  3. Import the CSV via Studio Table Editor (schema=tmp →");
console.error("     appwrite_books_library_csv → Import data from CSV).");
console.error("  4. Re-apply the migration to run the backfill.");
