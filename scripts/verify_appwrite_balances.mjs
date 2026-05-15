// ════════════════════════════════════════════════════════════════════════════
// verify_appwrite_balances.mjs
//
// One-off verification script — given a list of emails, prints each user's
// CURRENT Appwrite coin balance. Used to fact-check user-reported "I lost X
// coins" claims against the legacy ledger before issuing a Supabase restore.
//
// Why a script instead of a SQL query: Appwrite isn't accessible via SQL —
// it's a document store with a REST API. We use the node-appwrite server
// SDK with an admin API key.
//
// Setup
// -----
// 1. In Appwrite Console → Project Settings → API Keys → Create API Key.
//    Scopes needed:
//        - users.read   (to look up auth user by email)
//        - documents.read (to read the coins collection)
//    Copy the key value (shown once).
//
// 2. Run:
//        APPWRITE_API_KEY="<the-key>" node scripts/verify_appwrite_balances.mjs
//
//    (The key is NOT committed. Don't paste it into the file. Don't push
//     it anywhere. Treat it like a Stripe secret.)
//
// 3. Output looks like:
//        softsancha@gmail.com           claim:  331  appwrite:  331  ✓ matches
//        satsukikawano649@gmail.com     claim:  600  appwrite:  412  ✗ over by 188
//        modanciam@gmail.com            claim:  150  appwrite:  150  ✓ matches
//        tanteoalexesmarie@gmail.com    claim:  189  appwrite:    0  ✗ never had any
//
//    Then you credit the actual Appwrite numbers, not the claimed ones.
//
// Dependencies
// ------------
// node-appwrite (server SDK) — install with:
//     npm install node-appwrite
//
// (You can install it globally with npm install -g node-appwrite, or
//  in a tiny package.json in the same directory. It's not added to the
//  mobile project's package.json — this script is repo-local tooling.)
// ════════════════════════════════════════════════════════════════════════════

import { Client, Users, Databases, Query } from "node-appwrite";

// ── EDIT THIS LIST ──────────────────────────────────────────────────────────
// Each entry is { email, claim }. Add / remove rows as needed.
const CLAIMS = [
  { email: "softsancha@gmail.com",          claim: 331 },
  { email: "satsukikawano649@gmail.com",    claim: 600 },
  { email: "modanciam@gmail.com",           claim: 150 },
  { email: "tanteoalexesmarie@gmail.com",   claim: 189 },
];

// ── APPWRITE CONFIG (matches private/secrets.js) ────────────────────────────
const ENDPOINT  = "https://fra.cloud.appwrite.io/v1";
const PROJECT   = "66b8be7400121b5d4697";
const DATABASE  = "66b32b3600246bc34956";
const COINS_COL = "66e2b02e002d4c90aeb0";

const API_KEY = process.env.APPWRITE_API_KEY;
if (!API_KEY) {
  console.error("Missing APPWRITE_API_KEY env var. See setup notes at top of file.");
  process.exit(1);
}

const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT)
  .setKey(API_KEY);

const users = new Users(client);
const db    = new Databases(client);

// Look up an Appwrite auth user by email. Returns the user object or null.
const findUserByEmail = async (email) => {
  // Users API supports search by email via the `queries` parameter.
  // We use Query.equal("email", ...) for an exact match.
  const result = await users.list([Query.equal("email", email)], email);
  return result.users?.[0] || null;
};

// Read the user's coins document. The coins collection is keyed by
// `coinOwner = user.$id`. There should be at most 1 row per user; if
// somehow there are multiple, we sum them (better safe than miss legacy
// dupes).
const readCoinBalance = async (userId) => {
  const result = await db.listDocuments(DATABASE, COINS_COL, [
    Query.equal("coinOwner", userId),
    Query.limit(10),
  ]);
  if (!result.documents?.length) return 0;
  return result.documents.reduce((sum, doc) => sum + (Number(doc.coins) || 0), 0);
};

// ── MAIN ────────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
const padN = (s, n) => String(s).padStart(n);

console.log("");
console.log(pad("email", 36) + pad("claim", 10) + pad("appwrite", 12) + "verdict");
console.log("─".repeat(80));

for (const { email, claim } of CLAIMS) {
  try {
    const user = await findUserByEmail(email);
    if (!user) {
      console.log(pad(email, 36) + padN(claim, 6) + "    " + padN("—", 8) + "    " + "✗ no Appwrite user");
      continue;
    }
    const appwriteBalance = await readCoinBalance(user.$id);
    let verdict;
    if (appwriteBalance === 0)         verdict = "✗ never had any";
    else if (appwriteBalance >= claim) verdict = appwriteBalance === claim ? "✓ matches" : `✓ has ${appwriteBalance - claim} more than claimed`;
    else                               verdict = `✗ over by ${claim - appwriteBalance} (cap to ${appwriteBalance})`;
    console.log(pad(email, 36) + padN(claim, 6) + "    " + padN(appwriteBalance, 8) + "    " + verdict);
  } catch (err) {
    console.log(pad(email, 36) + padN(claim, 6) + "    " + padN("ERR", 8) + "    " + (err?.message || String(err)));
  }
}

console.log("");
