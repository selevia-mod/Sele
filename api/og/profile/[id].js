// Vercel serverless function — OG meta tags for /profile/:id share previews.
// See api/og/books/[id].js for the architecture overview.
//
// Profile-specific notes:
//   - The :id is either a Supabase UUID (post-migration users) or an
//     Appwrite hex (legacy mobile users). Try both columns.
//   - We surface avatar_url as og:image, username + bio as title/desc.
//   - og:type = profile is the OpenGraph spec for users.

const SUPABASE_URL = "https://zplisqwoejxrdrpbfass.supabase.co";
const SUPABASE_KEY = "sb_publishable_1u8sicdlwn15-I_9kvQmLA_NavAUkDs";
const SITE_URL = "https://www.selebox.com";
const APP_STORE_ID = "6736897349";
const DEFAULT_OG_IMAGE = `${SITE_URL}/img/og-default.png`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

const truncate = (s, max = 200) => {
  const v = String(s ?? "").replace(/\s+/g, " ").trim();
  if (v.length <= max) return v;
  return v.slice(0, max - 1).trimEnd() + "…";
};

async function fetchProfile(id) {
  const isUuid = UUID_RE.test(id);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const url = `${SUPABASE_URL}/rest/v1/profiles?${column}=eq.${encodeURIComponent(id)}&select=id,username,about,bio,avatar_url,banner_url,legacy_appwrite_id&limit=1`;

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

  const profile = await fetchProfile(id);

  const username = profile?.username || "Selebox user";
  const title = profile?.username ? `${username} on Selebox` : "Selebox";
  // Profiles can use either `about` or `bio` historically — try both.
  const bioText = profile?.about || profile?.bio || "";
  const description =
    truncate(bioText, 200) || `${username}'s profile on Selebox — original stories, videos, and more.`;
  // Prefer banner image (16:9, looks better in preview cards) but fall
  // back to avatar (1:1) since not every user has a banner.
  const image = profile?.banner_url || profile?.avatar_url || DEFAULT_OG_IMAGE;
  const canonicalUrl = `${SITE_URL}/profile/${id}`;
  const spaUrl = `/#profile/${id}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">

  <meta property="og:type" content="profile">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:url" content="${esc(canonicalUrl)}">
  <meta property="og:site_name" content="Selebox">
  <meta property="og:locale" content="en_US">
  ${profile?.username ? `<meta property="profile:username" content="${esc(profile.username)}">` : ""}

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(image)}">

  <meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}, app-argument=${esc(canonicalUrl)}">

  <link rel="canonical" href="${esc(canonicalUrl)}">

  <script>window.location.replace(${JSON.stringify(spaUrl)});</script>
  <noscript><meta http-equiv="refresh" content="0; url=${esc(spaUrl)}"></noscript>

  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           max-width: 600px; margin: 2rem auto; padding: 1rem; color: #1f2937; }
    h1 { font-size: 1.5rem; }
    img.avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; }
    a { color: #7c3aed; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  ${profile?.avatar_url ? `<img class="avatar" src="${esc(profile.avatar_url)}" alt="${esc(username)}">` : ""}
  <h1>${esc(username)}</h1>
  <p>${esc(description)}</p>
  <p><a href="${esc(spaUrl)}">View profile on Selebox →</a></p>
</body>
</html>`);
}
