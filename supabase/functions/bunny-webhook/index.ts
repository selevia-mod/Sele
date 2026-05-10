// Supabase Edge Function: bunny-webhook
//
// Receives Bunny.net Stream webhooks for both video libraries (mobile +
// web) and reconciles the matching `videos` row.
//
// Tier-3 (May 2026): merged with the previous client-side architecture
// so this function handles BOTH:
//
//   1. Legacy flow (old client code path, also still mobile today):
//        - Client inserts videos row at status='processing'
//        - Bunny encodes; webhook fires
//        - We PATCH the row → status='ready' + duration
//
//   2. New flow (Tier-3 web, future Tier-3 mobile):
//        - Client passes metadata to bunny-upload, which writes it to
//          Bunny's metaTags. Client does NOT insert a videos row.
//        - Bunny encodes; webhook fires
//        - We read metaTags from the payload and INSERT the row
//          (idempotent — won't duplicate if a legacy client also inserted)
//
// Either way, by the time the webhook returns 200 OK the row exists at
// status='ready' with duration populated.
//
// Bunny webhook payload (JSON, sent as POST):
//   {
//     "VideoLibraryId": 541939,
//     "VideoGuid": "abc-def-ghi",
//     "Status": 4,
//     "MetaTags": [{ "property": "selebox.title", "value": "..." }, ...]
//   }
//
// Bunny status codes (from bunny.net docs):
//   0 = Queued / Created
//   1 = Uploaded
//   2 = Processing
//   3 = Transcoding
//   4 = Finished              ← we mark video "ready" + populate
//   5 = Error                 ← we mark video "error"
//   6 = UploadFailed          ← we mark video "error"
//   7 = JitSegmentCreated     (interim — ignored)
//
// REQUIRED Edge Function secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-set by Supabase)
//   BUNNY_API_KEY_NEW                — for fetching duration from Bunny Stream
//   BUNNY_CDN_HOSTNAME_BY_LIBRARY    — JSON map of library_id → CDN hostname
//                                      e.g. {"541939":"vz-fdf88b4d-33a.b-cdn.net",
//                                            "645778":"vz-d2b58b9c-054.b-cdn.net"}
//   BUNNY_WEBHOOK_SIGNING_SECRET     — optional; HMAC-SHA256 verification
//
// JWT verification: must be DISABLED for this function. Bunny's webhook
// doesn't carry a Supabase auth token. Either deploy with --no-verify-jwt
// or set verify_jwt=false in supabase/functions/bunny-webhook/config.toml.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUNNY_API_KEY_NEW = Deno.env.get('BUNNY_API_KEY_NEW') ?? '';
const SIGNING_SECRET = Deno.env.get('BUNNY_WEBHOOK_SIGNING_SECRET') ?? '';

// Per-library CDN hostnames. Webhook can fire from EITHER the mobile
// library (541939, vz-fdf88b4d-33a.b-cdn.net) or the web library
// (645778, vz-d2b58b9c-054.b-cdn.net). Each has its own playback host
// since Bunny Stream provisions one CDN zone per library. We map
// library_id → hostname so the videoUrl we persist points at the right
// zone for the library that received the upload.
//
// Falls back to a sentinel hostname if the env var is missing or the
// library isn't in the map — the row still inserts, the URL will be
// wrong, but the orphan can be hand-fixed in SQL afterward.
const FALLBACK_CDN_HOSTNAME = 'vz-unknown.b-cdn.net';
const cdnHostnameByLibrary = (() => {
  try {
    const raw = Deno.env.get('BUNNY_CDN_HOSTNAME_BY_LIBRARY') || '{}';
    return JSON.parse(raw) as Record<string, string>;
  } catch (_err) {
    console.error('[bunny-webhook] BUNNY_CDN_HOSTNAME_BY_LIBRARY is not valid JSON; using fallback');
    return {};
  }
})();
const cdnHostFor = (libraryId: number | string): string => {
  return cdnHostnameByLibrary[String(libraryId)] || FALLBACK_CDN_HOSTNAME;
};

// Bunny status codes we care about
const STATUS_FINISHED = 4;
const STATUS_ERROR = 5;
const STATUS_UPLOAD_FAILED = 6;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });

// ── metaTag helpers ──────────────────────────────────────────────────
// Bunny's metaTags is an array of { property, value } pairs (both strings).
// bunny-upload writes selebox-namespaced keys; this reads them back.
type BunnyMetaTag = { property: string; value: string };
const metaGet = (tags: BunnyMetaTag[] | undefined, key: string): string => {
  if (!tags || !Array.isArray(tags)) return '';
  const found = tags.find((t) => t?.property === key);
  return found?.value || '';
};
const metaGetJson = <T,>(tags: BunnyMetaTag[] | undefined, key: string): T | null => {
  const raw = metaGet(tags, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (_err) {
    return null;
  }
};

// ── Webhook signature verification ───────────────────────────────────
// HMAC-SHA256 using the secret Bunny shows when you enable signing on a
// library. If SIGNING_SECRET is empty (Bunny doesn't expose signing on
// this plan) we log a warning and accept all requests — fine for dev,
// production should ideally have signing enabled.
const verifyBunnySignature = async (rawBody: string, signatureHeader: string | null, secret: string): Promise<boolean> => {
  if (!signatureHeader || !secret) return false;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const sigBytes = new Uint8Array(
      signatureHeader.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) || [],
    );
    return await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(rawBody));
  } catch (_err) {
    return false;
  }
};

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Read raw body once — needed for signature verification AND parsing.
  const rawBody = await req.text();

  if (SIGNING_SECRET) {
    const sigHeader = req.headers.get('X-Bunny-Signature') || req.headers.get('x-bunny-signature');
    const ok = await verifyBunnySignature(rawBody, sigHeader, SIGNING_SECRET);
    if (!ok) {
      console.warn('[bunny-webhook] signature verification failed');
      return json({ error: 'Invalid signature' }, 401);
    }
  } else {
    console.warn('[bunny-webhook] BUNNY_WEBHOOK_SIGNING_SECRET not set — accepting unsigned request');
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch (_err) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const VideoGuid = payload?.VideoGuid;
  const VideoLibraryId = payload?.VideoLibraryId;
  const Status = payload?.Status;
  const MetaTags: BunnyMetaTag[] | undefined = payload?.MetaTags;

  if (!VideoGuid) {
    return json({ error: 'Missing VideoGuid' }, 400);
  }

  // NOTE (Tier-3): we no longer filter by library ID. Both mobile (541939)
  // and web (645778) fire webhooks at this URL, both must be handled. The
  // previous library filter caused mobile webhooks to be silently ignored
  // — mobile videos never got their status flipped.

  // Map Bunny status → our DB status. Interim statuses (queued, processing,
  // transcoding) get a 200 OK so Bunny stops re-firing for non-actionable
  // events without retry pressure.
  let newStatus: 'ready' | 'error' | null = null;
  if (Status === STATUS_FINISHED) newStatus = 'ready';
  else if (Status === STATUS_ERROR || Status === STATUS_UPLOAD_FAILED) newStatus = 'error';

  if (!newStatus) {
    return json({ ok: true, action: 'ignored', reason: `interim status=${Status}` });
  }

  // ── Does the row already exist? ─────────────────────────────────────
  // Two flows converge here. Either the client inserted the row at
  // upload time (legacy + current mobile), or it didn't (Tier-3 web,
  // future Tier-3 mobile). The lookup tells us which path to take.
  const { data: existingRow, error: lookupErr } = await supabase
    .from('videos')
    .select('id, status')
    .eq('bunny_video_id', VideoGuid)
    .maybeSingle();

  if (lookupErr) {
    console.error('[bunny-webhook] row lookup failed:', lookupErr.message);
    return json({ error: `Row lookup failed: ${lookupErr.message}` }, 503);
  }

  // Build the duration update (only on Status=Finished, only if we can
  // fetch metadata from Bunny). Reused by both insert + update paths.
  let durationSeconds: number | null = null;
  if (newStatus === 'ready' && BUNNY_API_KEY_NEW) {
    try {
      const metaRes = await fetch(
        `https://video.bunnycdn.com/library/${VideoLibraryId}/videos/${VideoGuid}`,
        { headers: { AccessKey: BUNNY_API_KEY_NEW } },
      );
      if (metaRes.ok) {
        const meta = await metaRes.json();
        if (typeof meta?.length === 'number' && meta.length > 0) {
          durationSeconds = Math.round(meta.length);
        }
      }
    } catch (err) {
      // Non-fatal — status update still proceeds without duration.
      console.error('[bunny-webhook] Failed to fetch Bunny metadata:', err);
    }
  }

  // ── PATH A: row exists → PATCH ──────────────────────────────────────
  if (existingRow) {
    const update: Record<string, unknown> = {
      status: newStatus,
      updated_at: new Date().toISOString(),
    };
    if (durationSeconds !== null) update.duration = durationSeconds;

    const { error: patchErr } = await supabase
      .from('videos')
      .update(update)
      .eq('bunny_video_id', VideoGuid);

    if (patchErr) {
      console.error('[bunny-webhook] PATCH failed:', patchErr.message);
      return json({ error: `Patch failed: ${patchErr.message}` }, 503);
    }

    return json({ ok: true, action: 'patched', status: newStatus, video_id: VideoGuid });
  }

  // ── PATH B: row doesn't exist → INSERT from metaTags ────────────────
  // Tier-3 path. Reads the metadata bunny-upload stashed in metaTags
  // when the video shell was created and inserts a fresh videos row.

  const uploaderId = metaGet(MetaTags, 'selebox.uploader_id');
  if (!uploaderId) {
    // No metaTags = old client that didn't go through bunny-upload, OR
    // a malformed payload. Old clients SHOULD have inserted the row
    // themselves — the existsRow check above would have hit. So this
    // is genuinely an orphan situation.
    //
    // Don't 4xx here (Bunny would stop retrying). Return 200 with a
    // logged note so it falls off the retry queue but we can grep the
    // logs for these.
    console.warn(`[bunny-webhook] no row + no metaTags for VideoGuid=${VideoGuid} — orphan, skipping insert`);
    return json({ ok: true, action: 'orphan_skipped', video_id: VideoGuid });
  }

  // Status=error path with no existing row — record an error stub so
  // the user sees the failure rather than nothing. Rare case: Bunny
  // failed to encode a video that was uploaded via Tier-3 path.
  if (newStatus === 'error') {
    const { error: insertErr } = await supabase.from('videos').insert({
      bunny_video_id: VideoGuid,
      bunny_library_id: String(VideoLibraryId),
      uploader_id: uploaderId,
      title: metaGet(MetaTags, 'selebox.title') || '(failed upload)',
      status: 'error',
    });
    if (insertErr) {
      console.error('[bunny-webhook] error-stub insert failed:', insertErr.message);
    }
    return json({ ok: true, action: 'error_stub_inserted', video_id: VideoGuid });
  }

  // Status=ready + no existing row → full Tier-3 insert from metaTags.
  const title = metaGet(MetaTags, 'selebox.title');
  const description = metaGet(MetaTags, 'selebox.description');
  const tags = metaGetJson<string[]>(MetaTags, 'selebox.tags') || [];
  const isMonetized = metaGet(MetaTags, 'selebox.is_monetized') === 'true';
  const scheduledPublishAt = metaGet(MetaTags, 'selebox.scheduled_publish_at') || null;
  const thumbnailKey = metaGet(MetaTags, 'selebox.thumbnail_key');
  const createFeedPost = metaGet(MetaTags, 'selebox.create_feed_post') === 'true';

  const streamHost = cdnHostFor(VideoLibraryId);
  const videoUrl = `https://${streamHost}/${VideoGuid}/playlist.m3u8`;
  const thumbnailUrl = thumbnailKey
    ? thumbnailKey  // assume full URL was passed if user uploaded a custom thumbnail
    : `https://${streamHost}/${VideoGuid}/thumbnail.jpg`;

  const insertPayload: Record<string, unknown> = {
    bunny_video_id: VideoGuid,
    bunny_library_id: String(VideoLibraryId),
    title,
    description,
    tags,
    video_url: videoUrl,
    thumbnail_url: thumbnailUrl,
    uploader_id: uploaderId,
    status: 'ready',
    is_monetized: isMonetized,
    scheduled_publish_at: scheduledPublishAt,
    is_hidden: scheduledPublishAt ? true : false,
  };
  if (durationSeconds !== null) insertPayload.duration = durationSeconds;

  // Idempotent on bunny_video_id (videos_bunny_video_id_key unique
  // index added in migration_videos_bunny_id_unique.sql). If two
  // webhook fires race here the second one no-ops cleanly.
  const { error: insertErr } = await supabase
    .from('videos')
    .upsert(insertPayload, { onConflict: 'bunny_video_id', ignoreDuplicates: true });

  if (insertErr) {
    console.error('[bunny-webhook] videos insert failed:', insertErr.message);
    return json({ error: `Insert failed: ${insertErr.message}` }, 503);
  }

  // ── Conditionally create the home-feed post (web flow only) ────────
  // Idempotent via check-then-insert (no UNIQUE constraint on posts —
  // we deliberately avoid one to allow legitimate reposts referencing
  // the same video).
  if (createFeedPost) {
    const { data: videoRow } = await supabase
      .from('videos')
      .select('id')
      .eq('bunny_video_id', VideoGuid)
      .maybeSingle();

    if (videoRow?.id) {
      const { data: existingPost } = await supabase
        .from('posts')
        .select('id')
        .eq('user_id', uploaderId)
        .eq('video_id', videoRow.id)
        .limit(1)
        .maybeSingle();

      if (!existingPost) {
        const postBody = description || title;
        const { error: postErr } = await supabase.from('posts').insert({
          user_id: uploaderId,
          body: postBody,
          video_id: videoRow.id,
          is_hidden: true,  // flipped to visible by the videos.status='ready' trigger
        });
        if (postErr) {
          console.error('[bunny-webhook] posts insert failed (videos row OK):', postErr.message);
        }
      }
    }
  }

  return json({
    ok: true,
    action: 'inserted_from_metatags',
    video_id: VideoGuid,
    feed_post: createFeedPost,
  });
});
