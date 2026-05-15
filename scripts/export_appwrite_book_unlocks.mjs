// ════════════════════════════════════════════════════════════════════════════
// export_appwrite_book_unlocks.mjs
//
// Dumps the legacy Appwrite `users-book-unlocks` collection to CSV, expanded
// into one row per (user, book, chapter) tuple. The output is the input for
// `supabase/migrations/2026-05-10_unlocks_backfill_from_appwrite_collection.sql`,
// which cross-references the CSV against `public.unlocks` and inserts any
// missing rows.
//
// WHY THIS EXISTS
// ---------------
// The May 9 aw_-prefix backfill repointed Appwrite-migrated chapter unlocks
// that were already present in `public.unlocks`. It does NOTHING for
// users whose Appwrite `users-book-unlocks` rows never made it into Supabase
// at all — those readers see paywalls on chapters they paid for and the
// audit query in `2026-05-10_unlocks_backfill_rerun_may2_to_6_audit.sql`
// can't see them either (because that audit only checks Supabase wallet
// transactions, not Appwrite docs).
//
// Charles also flagged the FULL-UNLOCK case: in Appwrite, a row with
// `isFullyUnlocked=true` means the user owns the entire book even if the
// `chapters[]` array doesn't list every chapter. The mobile read code
// short-circuits on `unlocks.isFullyUnlocked === true` without walking the
// chapter list. So a backfill that just emits the literal `chapters[]`
// array would miss every chapter the user never explicitly tapped on for
// any full-unlock row.
//
// This script handles that: when isFullyUnlocked=true, we fetch the
// book's full published chapter list (cached per book) and emit one row
// per chapter, union'd with whatever was in the literal chapters[] array.
//
// OUTPUT FORMAT
// -------------
// Stdout = CSV. One header row + one data row per (user, book, chapter):
//
//     appwrite_user_id,appwrite_book_id,appwrite_chapter_id,was_full_unlock
//     66c1...,68af...,68b0...,0
//     66c1...,68af...,68b1...,1
//
// Status / progress messages go to stderr so you can `>` redirect stdout
// straight to a file:
//
//     APPWRITE_API_KEY=... node scripts/export_appwrite_book_unlocks.mjs > out.csv
//
// SETUP
// -----
// 1. In Appwrite Console → Project Settings → API Keys → Create API Key.
//    Scopes needed:
//        - documents.read (to list users-book-unlocks + book-chapters)
//    Copy the key value (shown once).
//
// 2. Run:
//        APPWRITE_API_KEY="<the-key>" node scripts/export_appwrite_book_unlocks.mjs > out.csv
//
//    On a ~500k-row collection this takes 5–15 minutes depending on how
//    many distinct books appear (each unique book triggers one cached
//    chapter-list fetch).
//
// 3. Import the CSV into Supabase via psql:
//        psql "$DATABASE_URL" -c "\copy tmp.appwrite_book_unlocks_csv from 'out.csv' csv header"
//    (the migration creates the staging table for you).
//
// 4. Run the backfill migration:
//        2026-05-10_unlocks_backfill_from_appwrite_collection.sql
//
// 5. Verify with the queries at the bottom of that migration.
//
// DEPENDENCIES
// ------------
// node-appwrite (server SDK) — already installed in scripts/node_modules
// from the verify_appwrite_balances.mjs setup.
// ════════════════════════════════════════════════════════════════════════════

import { Client, Databases, Query } from "node-appwrite";

// ── APPWRITE CONFIG (matches private/secrets.js) ────────────────────────────
const ENDPOINT                = "https://fra.cloud.appwrite.io/v1";
const PROJECT                 = "66b8be7400121b5d4697";
const DATABASE                = "66b32b3600246bc34956";
const USER_BOOK_UNLOCKS_COL   = "68d2caa2000a85d1bc2b";
const BOOK_CHAPTERS_COL       = "68aefa280035f6435da1";

// Page size is the Appwrite max (100). Smaller pages = more round trips
// but smaller blast radius if anything goes wrong mid-run.
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-book chapter list cache. Each unique book the script encounters with
// isFullyUnlocked=true triggers ONE chapter-list fetch; subsequent rows for
// the same book hit the cache. With ~thousands of distinct books this caps
// the total chapter-list fetches to a manageable number (vs. potentially
// hundreds of thousands of full-unlock rows hitting Appwrite each).
// ─────────────────────────────────────────────────────────────────────────────
const chapterCache = new Map();

const getChaptersForBook = async (bookId) => {
  if (chapterCache.has(bookId)) return chapterCache.get(bookId);

  const all = [];
  let cursor = null;
  while (true) {
    const queries = [Query.equal("book", bookId), Query.limit(PAGE_SIZE)];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    let page;
    try {
      page = await db.listDocuments(DATABASE, BOOK_CHAPTERS_COL, queries);
    } catch (err) {
      console.error(`  ! chapter fetch for book ${bookId} failed: ${err.message}. Skipping.`);
      break;
    }
    if (!page.documents.length) break;
    for (const c of page.documents) {
      // Only published chapters count toward an isFullyUnlocked entitlement —
      // drafts shouldn't get an unlock row inserted (and won't have
      // chapters.is_published=true on the Supabase side either, so the
      // backfill SQL would skip them anyway).
      // Some legacy chapters use `status: "Publish"`; some use a boolean
      // `is_published` / `isPublished`. Match all three so we don't miss any.
      const status = String(c.status || "").toLowerCase();
      const isPublished =
        status === "publish" ||
        status === "published" ||
        c.is_published === true ||
        c.isPublished === true;
      if (isPublished) all.push(c.$id);
    }
    if (page.documents.length < PAGE_SIZE) break;
    cursor = page.documents[page.documents.length - 1].$id;
  }

  chapterCache.set(bookId, all);
  return all;
};

// ─────────────────────────────────────────────────────────────────────────────
// CSV emit. Quote the cells defensively even though Appwrite IDs are hex
// (no commas/quotes in practice) — costs nothing and protects against any
// future schema changes that introduce text fields.
// ─────────────────────────────────────────────────────────────────────────────
const emitRow = (userId, bookId, chapterId, wasFullUnlock) => {
  process.stdout.write(
    `${userId},${bookId},${chapterId},${wasFullUnlock ? 1 : 0}\n`,
  );
};

// CSV header. Has to match the staging table column names in the
// companion SQL migration (or the \copy will misalign).
process.stdout.write("appwrite_user_id,appwrite_book_id,appwrite_chapter_id,was_full_unlock\n");

// ─────────────────────────────────────────────────────────────────────────────
// Main loop — paginate users-book-unlocks, expand each row, emit CSV.
// ─────────────────────────────────────────────────────────────────────────────
let cursor = null;
let docsProcessed = 0;
let rowsEmitted = 0;
let fullUnlockExpansions = 0;
let skippedNoOwnerOrBook = 0;
let chaptersCacheHits = 0;
let chaptersCacheMisses = 0;
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
    page = await db.listDocuments(DATABASE, USER_BOOK_UNLOCKS_COL, queries);
  } catch (err) {
    console.error(`! list users-book-unlocks page failed: ${err.message}. Aborting.`);
    process.exit(2);
  }
  if (!page.documents.length) break;

  for (const doc of page.documents) {
    docsProcessed++;
    const userId           = doc.unlockBy;
    const bookId           = doc.book;
    const literalChapters  = Array.isArray(doc.chapters) ? doc.chapters : [];
    const isFullyUnlocked  = doc.isFullyUnlocked === true;

    if (!userId || !bookId) {
      skippedNoOwnerOrBook++;
      continue;
    }

    let chaptersToEmit;
    if (isFullyUnlocked) {
      // Full-unlock case: union literal chapters[] with the book's full
      // published chapter list so a user who tapped a single chapter then
      // hit "Unlock whole book" gets every chapter restored, not just the
      // one they explicitly opened.
      fullUnlockExpansions++;
      const hadCacheHit = chapterCache.has(bookId);
      const fullList = await getChaptersForBook(bookId);
      if (hadCacheHit) chaptersCacheHits++;
      else chaptersCacheMisses++;
      const set = new Set([...literalChapters, ...fullList]);
      chaptersToEmit = Array.from(set);
    } else {
      // Per-chapter case: just the literal array. No Appwrite roundtrip.
      chaptersToEmit = literalChapters;
    }

    for (const chapterId of chaptersToEmit) {
      if (!chapterId) continue;
      emitRow(userId, bookId, chapterId, isFullyUnlocked);
      rowsEmitted++;
    }
  }

  if (page.documents.length < PAGE_SIZE) break;
  cursor = page.documents[page.documents.length - 1].$id;

  // Progress line every page. Goes to stderr so it doesn't pollute the
  // CSV on stdout.
  console.error(
    `[${fmtElapsed()}] docs=${docsProcessed}  rows=${rowsEmitted}  ` +
      `full_unlock_expansions=${fullUnlockExpansions}  ` +
      `chapter_cache=${chaptersCacheHits}h/${chaptersCacheMisses}m  ` +
      `skipped=${skippedNoOwnerOrBook}`,
  );
}

console.error("");
console.error(`DONE in ${fmtElapsed()}.`);
console.error(`  Documents processed       : ${docsProcessed}`);
console.error(`  CSV rows emitted          : ${rowsEmitted}`);
console.error(`  Full-unlock expansions    : ${fullUnlockExpansions}`);
console.error(`  Chapter-cache hits/misses : ${chaptersCacheHits}/${chaptersCacheMisses}`);
console.error(`  Skipped (no owner/book)   : ${skippedNoOwnerOrBook}`);
console.error("");
console.error("Next:");
console.error("  1. Inspect the first few rows of the CSV.");
console.error("  2. Import via psql \\copy:");
console.error("       psql \"$DATABASE_URL\" -c \"\\copy tmp.appwrite_book_unlocks_csv from 'out.csv' csv header\"");
console.error("     (the staging table is created by the companion migration).");
console.error("  3. Apply 2026-05-10_unlocks_backfill_from_appwrite_collection.sql");
console.error("  4. Run the verification query at the bottom of the migration.");
