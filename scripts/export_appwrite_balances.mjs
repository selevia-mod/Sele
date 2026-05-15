// ════════════════════════════════════════════════════════════════════════════
// export_appwrite_balances.mjs
//
// One-shot snapshot — pulls every Appwrite user with their email, username,
// coin balance, star balance, and lifetime earnings. Writes a CSV that
// opens cleanly in Excel / Google Sheets.
//
// Why a comprehensive snapshot:
//   When a user reports "I lost X coins" we currently chase per-claim.
//   A snapshot lets us look up any reporter in one place, see their
//   real numbers, and decide whether to credit. It's also a one-shot
//   audit trail — once the Supabase migration is final the legacy
//   numbers freeze and this CSV becomes the historical record.
//
// Schema notes (from lib/*.js + private/secrets.js):
//   coinsCollectionId       — keyed by `coinOwner = user.$id`, value `coins`
//   starsCollectionId       — doc `$id == user.$id` (1:1), value `stars`
//   usersEarningsCollectionId — keyed by `contentOwner = user.$id`, value
//                               `earningAmountToPhp` per-row (sum across
//                               rows for lifetime earnings)
//   userCollectionId        — has `username` field per user
//   Auth Users API          — emails live here, not in any collection
//
// Pagination strategy:
//   Iterate each collection in pages of 100, build {userId → value} maps
//   in memory, then walk auth users once. Avoids the N+M+P query
//   explosion we'd get from doing per-user lookups.
//
// Setup
// -----
//   APPWRITE_API_KEY="<key>" node export_appwrite_balances.mjs
//
// API key scopes needed:
//   users.read, documents.read
//
// Output: appwrite_balances.csv in the same directory.
// ════════════════════════════════════════════════════════════════════════════

import { Client, Users, Databases, Query } from "node-appwrite";
import { writeFileSync } from "node:fs";

// ── APPWRITE CONFIG (matches private/secrets.js) ────────────────────────────
const ENDPOINT          = "https://fra.cloud.appwrite.io/v1";
const PROJECT           = "66b8be7400121b5d4697";
const DATABASE          = "66b32b3600246bc34956";
const COINS_COL         = "66e2b02e002d4c90aeb0";
const STARS_COL         = "68cef60b00036657931d";
const USER_COL          = "66b32b4a0022880bc87e";
const EARNINGS_COL      = "68d2c7350025b497965a";

const API_KEY = process.env.APPWRITE_API_KEY;
if (!API_KEY) {
  console.error("Missing APPWRITE_API_KEY env var. See setup notes at top.");
  process.exit(1);
}

const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT)
  .setKey(API_KEY);

const users = new Users(client);
const db    = new Databases(client);

// Retry wrapper — Appwrite cloud occasionally times out on cold pages
// (especially the auth users list, which scans across regions). 3
// attempts with exponential backoff covers transient network blips
// without hiding real errors.
const withRetry = async (fn, label, attempts = 3) => {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = 1000 * Math.pow(2, i);
      console.warn(`  ${label} attempt ${i + 1}/${attempts} failed (${err?.code || err?.message}); retrying in ${wait}ms…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
};

// Page through any collection until exhaustion. Page size 25 (down
// from 100) keeps each request small enough to dodge the cold-cache
// timeout we hit in the wild. Slower but reliable.
const PAGE_SIZE = 25;

const fetchAll = async (collectionId, queries = []) => {
  const out = [];
  let offset = 0;
  while (true) {
    const res = await withRetry(
      () => db.listDocuments(collectionId, [...queries, Query.limit(PAGE_SIZE), Query.offset(offset)]),
      `listDocuments(${collectionId}) offset=${offset}`,
    );
    out.push(...(res.documents || []));
    if ((res.documents || []).length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset % 500 === 0) console.log(`    …${offset} fetched`);
  }
  return out;
};

// Same pagination for the Auth Users API.
const fetchAllAuthUsers = async () => {
  const out = [];
  let offset = 0;
  while (true) {
    const res = await withRetry(
      () => users.list([Query.limit(PAGE_SIZE), Query.offset(offset)]),
      `users.list offset=${offset}`,
    );
    out.push(...(res.users || []));
    if ((res.users || []).length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset % 500 === 0) console.log(`    …${offset} fetched`);
  }
  return out;
};

// CSV escaping — wrap a field in quotes if it contains a comma, quote,
// or newline; double up any embedded quote. Matches RFC 4180.
const csvEscape = (val) => {
  if (val == null) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

// ── MAIN ────────────────────────────────────────────────────────────────────

console.log("Fetching auth users…");
const authUsers = await fetchAllAuthUsers();
console.log(`  ${authUsers.length} auth users`);

console.log("Fetching user profiles (for usernames)…");
const userDocs = await fetchAll(USER_COL);
const usernameByUserId = new Map();
for (const doc of userDocs) {
  // The profile doc's $id matches the auth user's $id. Username field
  // is `username`.
  usernameByUserId.set(doc.$id, doc.username || "");
}
console.log(`  ${userDocs.length} profile docs`);

console.log("Fetching coins…");
const coinDocs = await fetchAll(COINS_COL);
const coinsByUserId = new Map();
for (const doc of coinDocs) {
  // Sum across rows in case there are dupes (some legacy users have
  // multiple coin rows from buggy first-write paths).
  const owner = doc.coinOwner;
  if (!owner) continue;
  coinsByUserId.set(owner, (coinsByUserId.get(owner) || 0) + (Number(doc.coins) || 0));
}
console.log(`  ${coinDocs.length} coin docs`);

console.log("Fetching stars…");
const starDocs = await fetchAll(STARS_COL);
const starsByUserId = new Map();
for (const doc of starDocs) {
  // Star doc's $id IS the user's $id (1:1 by primary key).
  starsByUserId.set(doc.$id, Number(doc.stars) || 0);
}
console.log(`  ${starDocs.length} star docs`);

console.log("Fetching earnings (this may take a moment)…");
const earningDocs = await fetchAll(EARNINGS_COL);
const earningsByUserId = new Map();
for (const doc of earningDocs) {
  const owner = doc.contentOwner;
  if (!owner) continue;
  const amount = Number(doc.earningAmountToPhp) || 0;
  earningsByUserId.set(owner, (earningsByUserId.get(owner) || 0) + amount);
}
console.log(`  ${earningDocs.length} earning rows`);

// Build CSV
const rows = [];
rows.push(["email", "username", "user_id", "coins", "stars", "earnings_php"].join(","));

for (const u of authUsers) {
  const id    = u.$id;
  const email = u.email || "";
  const uname = usernameByUserId.get(id) || "";
  const coins = coinsByUserId.get(id) || 0;
  const stars = starsByUserId.get(id) || 0;
  const earn  = (earningsByUserId.get(id) || 0).toFixed(2);
  rows.push([email, uname, id, coins, stars, earn].map(csvEscape).join(","));
}

const outPath = new URL("./appwrite_balances.csv", import.meta.url).pathname;
writeFileSync(outPath, rows.join("\n") + "\n");
console.log(`\n✓ Wrote ${authUsers.length} rows to ${outPath}`);

// Quick stats so you don't have to open the CSV to sanity-check.
const totalCoins   = [...coinsByUserId.values()].reduce((a, b) => a + b, 0);
const totalStars   = [...starsByUserId.values()].reduce((a, b) => a + b, 0);
const totalEarn    = [...earningsByUserId.values()].reduce((a, b) => a + b, 0);
const usersWithCoins = [...coinsByUserId.values()].filter((v) => v > 0).length;
const usersWithStars = [...starsByUserId.values()].filter((v) => v > 0).length;

console.log("");
console.log("Totals:");
console.log(`  Coins outstanding:   ${totalCoins.toLocaleString()}`);
console.log(`  Stars outstanding:   ${totalStars.toLocaleString()}`);
console.log(`  Lifetime earnings:   ₱${totalEarn.toFixed(2)}`);
console.log(`  Users with coins>0:  ${usersWithCoins.toLocaleString()}`);
console.log(`  Users with stars>0:  ${usersWithStars.toLocaleString()}`);
