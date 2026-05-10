// supabase/functions/bunny-upload/index.ts
//
// Creates a Bunny Stream video shell + returns the upload URL the
// client uses to PUT the actual video file.
//
// Tier-3 update (May 2026):
//   Now also writes the video's metadata (title, description, tags,
//   monetization, scheduled-publish, uploader_id, thumbnail key) into
//   the Bunny video's `metaTags`. The new bunny-video-ready webhook
//   reads those metaTags back when Bunny finishes encoding and uses
//   them to insert the public.videos row server-side.
//
//   Why server-side: the previous architecture had the client doing
//   the videos table insert directly, which meant any Supabase blip
//   mid-upload orphaned the Bunny file. Moving the insert to a
//   webhook handler that Bunny retries on failure eliminates that
//   entire failure mode. See supabase/functions/bunny-video-ready/
//   for the receiver.
//
// Backwards compatibility:
//   Old clients still calling this with just `{ title }` will get a
//   Bunny shell created without metaTags. Those clients also still
//   call createNewVideo themselves (the old path); the webhook will
//   try to insert too but no-op via ON CONFLICT (bunny_video_id) and
//   also bail because selebox.uploader_id metaTag is missing. Net:
//   exactly one row is inserted, by the old-client path, no harm.
//   New clients pass the full metadata payload below and let the
//   webhook do the insert.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Sanitize values headed into Bunny metaTags. Strings are clamped to
// 4 KB each — Bunny's per-tag value limit isn't documented but the
// company support's general-purpose answer is "keep it small". 4 KB
// is comfortably above any realistic title/description while staying
// inside any reasonable header/payload limit.
const clampString = (s: unknown, maxBytes = 4096): string => {
  const str = typeof s === 'string' ? s : String(s ?? '')
  if (str.length <= maxBytes) return str
  return str.slice(0, maxBytes)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Not logged in' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': authHeader,
        'apikey': Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      },
    })

    if (!userRes.ok) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const user = await userRes.json()

    const body = await req.json()
    const title = body.title
    if (!title || title.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'Title required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── New (Tier-3): optional metadata that the webhook will read ──
    // All fields below are optional for backwards compatibility with
    // old clients still passing only { title }. New clients pass the
    // full set so the webhook can insert the row without needing the
    // client to make a separate Supabase call.
    const description: string = body.description ?? ''
    const tags: string[] = Array.isArray(body.tags) ? body.tags : []
    const isMonetized: boolean = Boolean(body.is_monetized)
    const scheduledPublishAt: string | null = body.scheduled_publish_at ?? null
    const thumbnailKey: string = body.thumbnail_key ?? ''
    // Web flow creates a hidden home-feed post alongside the video row;
    // mobile flow does not (mobile videos surface in the Videos tab,
    // not in the home feed). The webhook reads this flag to decide
    // whether to insert a posts row after the video insert. Default
    // true here because bunny-upload is used by the web client; the
    // mobile client (when it adopts the metaTags pattern) will either
    // omit this or set it false explicitly.
    const createFeedPost: boolean = body.create_feed_post !== false

    const BUNNY_API_KEY = Deno.env.get('BUNNY_API_KEY_NEW')
    const BUNNY_LIBRARY_ID = Deno.env.get('BUNNY_LIBRARY_ID_NEW')
    const BUNNY_CDN_HOSTNAME = Deno.env.get('BUNNY_CDN_HOSTNAME_NEW')

    if (!BUNNY_API_KEY || !BUNNY_LIBRARY_ID || !BUNNY_CDN_HOSTNAME) {
      return new Response(JSON.stringify({ error: 'Server not configured: missing BUNNY_*_NEW secrets' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Step 1: Create the Bunny video shell ──
    const bunnyResponse = await fetch(
      `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`,
      {
        method: 'POST',
        headers: {
          'AccessKey': BUNNY_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: title.trim() }),
      }
    )

    if (!bunnyResponse.ok) {
      const errText = await bunnyResponse.text()
      return new Response(JSON.stringify({ error: 'Bunny error: ' + errText }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const video = await bunnyResponse.json()
    const videoGuid = video.guid

    // ── Step 2 (Tier-3): Stash metadata into Bunny's metaTags ──
    // Only attempt this if the client passed the full metadata
    // payload — old clients sending just { title } skip this and the
    // webhook insert too, falling back to the legacy client-side
    // createNewVideo path. Failure here is non-fatal: if the
    // metaTags PUT fails, the shell still exists, the upload URL
    // still works, and the client (if it's a new client) will see
    // their video stuck in processing forever — which is at least
    // diagnosable. Worst case we manually fix the orphan via SQL.
    //
    // metaTags shape: array of { property, value }. Both must be
    // strings. JSON-encode arrays / non-strings since the property
    // type doesn't accept richer values.
    //
    // Namespace all our keys with `selebox.` so they don't collide
    // with anything Bunny might add automatically (or future Bunny
    // features that introduce reserved keys).
    const hasMetadataPayload =
      Boolean(description) ||
      tags.length > 0 ||
      isMonetized ||
      scheduledPublishAt ||
      thumbnailKey

    if (hasMetadataPayload || user.id) {
      const metaTags = [
        { property: 'selebox.uploader_id',          value: clampString(user.id) },
        { property: 'selebox.title',                value: clampString(title.trim(), 256) },
        { property: 'selebox.description',          value: clampString(description, 4096) },
        { property: 'selebox.tags',                 value: clampString(JSON.stringify(tags)) },
        { property: 'selebox.is_monetized',         value: isMonetized ? 'true' : 'false' },
        { property: 'selebox.scheduled_publish_at', value: clampString(scheduledPublishAt || '') },
        { property: 'selebox.thumbnail_key',        value: clampString(thumbnailKey) },
        { property: 'selebox.create_feed_post',     value: createFeedPost ? 'true' : 'false' },
      ]

      try {
        const metaResponse = await fetch(
          `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${videoGuid}`,
          {
            method: 'POST',  // Bunny's "update video" is POST, not PUT
            headers: {
              'AccessKey': BUNNY_API_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ metaTags }),
          }
        )
        if (!metaResponse.ok) {
          // Don't fail the upload — the shell + upload URL are still
          // valid. Just log loudly so we can fix the orphan if the
          // upload completes without metaTags landing.
          const errText = await metaResponse.text().catch(() => '')
          console.warn(`[bunny-upload] metaTags write failed for ${videoGuid}: ${metaResponse.status} ${errText}`)
        }
      } catch (metaErr) {
        console.warn(`[bunny-upload] metaTags write exception for ${videoGuid}:`, metaErr)
      }
    }

    return new Response(
      JSON.stringify({
        videoId: videoGuid,
        libraryId: BUNNY_LIBRARY_ID,
        uploadUrl: `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${videoGuid}`,
        accessKey: BUNNY_API_KEY,
        videoUrl: `https://${BUNNY_CDN_HOSTNAME}/${videoGuid}/playlist.m3u8`,
        thumbnailUrl: `https://${BUNNY_CDN_HOSTNAME}/${videoGuid}/thumbnail.jpg`,
        userId: user.id,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
