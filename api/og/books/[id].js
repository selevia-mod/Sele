// Vercel serverless function — OG meta tags for /books/:id share previews.
//
// Why this exists
// ---------------
// Selebox web is a static SPA with hash routing (/#book/<id>). When users
// share a book link in WhatsApp / iMessage / Messenger / Discord / Slack /
// Telegram, those apps scrape the URL for OpenGraph meta tags to render a
// preview card. The static index.html only has a generic <title>; no
// per-book og:image or og:title. Result: blank or generic preview cards.
//
// This function intercepts /books/:id (via vercel.json rewrite), fetches
// the book from Supabase by ID, and returns HTML with proper og tags +
// twitter card + Apple Smart App Banner. Humans see a brief "Read on
// Selebox" page that JS-redirects to /#book/<id>; bots only read the
// meta tags.
//
// Caching: 5 min CDN cache (s-maxage=300). Books rarely change cover/
// description — this saves Supabase round-trips on viral shares.

const SUPABASE_URL = "https://zplisqwoejxrdrpbfass.supabase.co";
const SUPABASE_KEY = "sb_publishable_1u8sicdlwn15-I_9kvQmLA_NavAUkDs";
const SITE_URL = "https://www.selebox.com";
const APP_STORE_ID = "6736897349"; // Selebox iOS app — for Apple Smart App Banner
const DEFAULT_OG_IMAGE = `${SITE_URL}/img/og-default.png`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// HTML escape — required since book title/description can contain
// arbitrary user content. Without this, `<script>` in a title would
// inject into the rendered page.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

// Truncate description to a reasonable preview-card length. WhatsApp
// renders ~150 chars, FB more. 200 is a safe ceiling.
const truncate = (s, max = 200) => {
  const v = String(s ?? "").replace(/\s+/g, " ").trim();
  if (v.length <= max) return v;
  return v.slice(0, max - 1).trimEnd() + "…";
};

async function fetchBook(id) {
  const isUuid = UUID_RE.test(id);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const url = `${SUPABASE_URL}/rest/v1/books?${column}=eq.${encodeURIComponent(id)}&select=id,title,description,cover_url,legacy_appwrite_id,profiles!books_author_id_fkey(username)&limit=1`;

  try {
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) && data[0] ? data[0] : null;
  } catch (err) {
    // Best-effort — if Supabase is unreachable, fall through to generic OG.
    return null;
  }
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) {
    res.setHeader("Location", "/");
    res.status(302).end();
    return;
  }

  const book = await fetchBook(id);

  // Build og fields — fall back to generic if book not found / unavailable.
  const author = book?.profiles?.username ? ` by ${book.profiles.username}` : "";
  const title = book?.title ? `${book.title}${author} — Selebox` : "Selebox";
  const description = truncate(book?.description, 200) || "Read original stories on Selebox.";
  const image = book?.cover_url || DEFAULT_OG_IMAGE;
  const canonicalUrl = `${SITE_URL}/books/${id}`;
  const spaUrl = `/#book/${id}`;

  // 5-minute CDN cache. Bots scraping the same URL within 5 min won't
  // re-hit Supabase. Humans don't care because they're JS-redirected
  // to the SPA on first paint anyway.
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">

  <!-- Open Graph (Facebook / WhatsApp / Slack / Discord / iMessage) -->
  <meta property="og:type" content="book">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:url" content="${esc(canonicalUrl)}">
  <meta property="og:site_name" content="Selebox">
  <meta property="og:locale" content="en_US">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(image)}">

  <!-- Apple Smart App Banner — Safari shows "OPEN" CTA when the app is installed. -->
  <meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}, app-argument=${esc(canonicalUrl)}">

  <link rel="canonical" href="${esc(canonicalUrl)}">

  <!-- Redirect humans to the SPA. Bots don't execute JS, so they only
       read the og:* tags above and never reach this. -->
  <script>window.location.replace(${JSON.stringify(spaUrl)});</script>
  <noscript><meta http-equiv="refresh" content="0; url=${esc(spaUrl)}"></noscript>

  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           max-width: 600px; margin: 2rem auto; padding: 1rem; color: #1f2937; }
    h1 { font-size: 1.5rem; }
    img { max-width: 100%; border-radius: 12px; }
    a { color: #7c3aed; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <h1>${esc(book?.title || "Selebox")}</h1>
  ${book?.cover_url ? `<img src="${esc(book.cover_url)}" alt="${esc(book.title || "Book cover")}">` : ""}
  <p>${esc(description)}</p>
  <p><a href="${esc(spaUrl)}">Continue reading on Selebox →</a></p>
</body>
</html>`);
}
