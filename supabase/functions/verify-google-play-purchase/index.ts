// supabase/functions/verify-google-play-purchase/index.ts
//
// Google Play IAP receipt verification + credit endpoint.
// ─────────────────────────────────────────────────────────────────────
//
// Called by the mobile app (selebox-mobile-main) AFTER a successful
// Google Play purchase flow. The client POSTs:
//
//   { userId, packageName, productId, purchaseToken }
//
// We:
//   1. Verify the calling user is authenticated (Authorization: Bearer
//      <supabase access token>) and resolve to a profile UUID.
//   2. Build a Google Service Account JWT, exchange it for an access
//      token from accounts.google.com.
//   3. Call Google Play Developer API v3:
//        GET /androidpublisher/v3/applications/{packageName}/purchases/products/{productId}/tokens/{token}
//      to confirm purchaseState == 0 (purchased), consumptionState,
//      and orderId.
//   4. Look up coin_packages.id by iap_android_product_id = productId.
//   5. Call credit_iap_purchase RPC with platform='google_play',
//      transaction_id = purchaseToken, package_id resolved above.
//   6. Return ok+balance to the client. Client calls finishTransaction
//      to acknowledge / consume the Google Play purchase only after
//      we return ok.
//
// Why server-side verification:
//   Anyone with a HAR-capture tool can replay a fake mobile request.
//   Server-to-Google verification is the only way to confirm the
//   purchase actually happened with real money.
//
// Required env vars on Supabase:
//   SUPABASE_URL                    — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY       — auto-injected
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON — full JSON for the service
//                                     account with androidpublisher
//                                     access. See runbook in
//                                     GOOGLE_PLAY_SETUP.md.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SERVICE_ACCOUNT_JSON_RAW = Deno.env.get("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON")!;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

interface GooglePlayPurchase {
  purchaseTimeMillis?: string;
  purchaseState?: number; // 0 = purchased, 1 = cancelled, 2 = pending
  consumptionState?: number; // 0 = yet to be consumed, 1 = consumed
  orderId?: string;
  acknowledgementState?: number;
  productId?: string;
  kind?: string;
}

interface RequestBody {
  userId?: string;
  packageName?: string;
  productId?: string;
  purchaseToken?: string;
}

// ── Cached access token across invocations of the same isolate ─────────
let cachedAccessToken: string | null = null;
let cachedAccessTokenExpiresAt = 0;

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ── Service-account JWT → Google OAuth access token ────────────────────
async function getGoogleAccessToken(): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessTokenExpiresAt > nowSec + 60) {
    return cachedAccessToken;
  }

  const sa: ServiceAccountKey = JSON.parse(SERVICE_ACCOUNT_JSON_RAW);

  // Build the JWT claim set Google's OAuth endpoint expects.
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: sa.token_uri,
    exp: nowSec + 3600,
    iat: nowSec,
  };

  const base64UrlEncode = (s: string): string =>
    btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaim = base64UrlEncode(JSON.stringify(claim));
  const signingInput = `${encodedHeader}.${encodedClaim}`;

  // Import the PEM private key for signing.
  // The JSON's private_key field is a PEM string like:
  //   "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
  // We strip the headers + base64-decode the body to get the PKCS#8 DER.
  const pem = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const pkcs8 = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const jwt = `${signingInput}.${sig}`;

  // Exchange the JWT for an access token.
  const tokRes = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokRes.ok) {
    const txt = await tokRes.text();
    throw new Error(`google_oauth_failed: ${tokRes.status} ${txt}`);
  }
  const tokJson = await tokRes.json();
  cachedAccessToken = tokJson.access_token as string;
  cachedAccessTokenExpiresAt = nowSec + (tokJson.expires_in as number);
  return cachedAccessToken;
}

// ── Fetch purchase details from Google Play Developer API ──────────────
async function fetchPurchase(
  packageName: string,
  productId: string,
  purchaseToken: string,
): Promise<{ status: number; body: GooglePlayPurchase | { error?: { message?: string } } }> {
  const accessToken = await getGoogleAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(packageName)}/purchases/products/` +
    `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  return { status: res.status, body };
}

// ── Main handler ───────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  // ── Auth: resolve caller via their Supabase JWT ──────────────────────
  const authHeader = req.headers.get("Authorization") || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!accessToken) {
    return jsonResponse({ ok: false, error: "missing_authorization" }, 401);
  }

  // Validate the user's JWT via Supabase auth. We use the anon key for
  // the apikey header (any valid project key works) and the user's
  // access token in the Authorization header — that's what getUser
  // actually checks. Earlier version passed accessToken as the apikey,
  // which Supabase rejected with "Invalid API key" before even reaching
  // the JWT validation step.
  const sbAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data: userRes, error: userErr } = await sbAnon.auth.getUser(accessToken);
  if (userErr || !userRes?.user?.id) {
    return jsonResponse({ ok: false, error: "invalid_token" }, 401);
  }
  const callerAuthId = userRes.user.id;

  // ── Body validation ──────────────────────────────────────────────────
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }
  const { userId, packageName, productId, purchaseToken } = body;
  if (!userId || !packageName || !productId || !purchaseToken) {
    return jsonResponse({ ok: false, error: "missing_fields" }, 400);
  }

  // Service-role client for the dedup lookup + RPC call (bypasses RLS).
  const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve the caller's profile UUID and confirm it matches userId
  // the client claims. profiles.auth_user_id is the canonical link.
  const { data: profile, error: profileErr } = await sbAdmin
    .from("profiles")
    .select("id, auth_user_id")
    .or(`auth_user_id.eq.${callerAuthId},id.eq.${callerAuthId}`)
    .limit(1)
    .maybeSingle();
  if (profileErr || !profile?.id) {
    return jsonResponse({ ok: false, error: "profile_not_found" }, 404);
  }
  if (profile.id !== userId) {
    return jsonResponse({ ok: false, error: "user_id_mismatch" }, 403);
  }

  // ── Look up the coin pack by Android SKU ─────────────────────────────
  const { data: pack, error: packErr } = await sbAdmin
    .from("coin_packages")
    .select("id")
    .eq("iap_android_product_id", productId)
    .eq("is_active", true)
    .maybeSingle();
  if (packErr || !pack?.id) {
    return jsonResponse({ ok: false, error: "unknown_or_inactive_product" }, 404);
  }

  // ── Verify the purchase with Google Play Developer API ──────────────
  let verify;
  try {
    verify = await fetchPurchase(packageName, productId, purchaseToken);
  } catch (e) {
    console.error("[verify-google-play-purchase] google api error:", e);
    return jsonResponse({ ok: false, error: "google_api_error", detail: String(e) }, 502);
  }
  if (verify.status !== 200) {
    console.error("[verify-google-play-purchase] google rejected:", verify.status, verify.body);
    return jsonResponse(
      { ok: false, error: "purchase_not_verified", google_status: verify.status, detail: verify.body },
      400,
    );
  }
  const gp = verify.body as GooglePlayPurchase;
  // purchaseState: 0 = purchased, 1 = cancelled, 2 = pending
  if (gp.purchaseState !== 0) {
    return jsonResponse(
      {
        ok: false,
        error: gp.purchaseState === 2 ? "purchase_pending" : "purchase_not_completed",
        purchase_state: gp.purchaseState,
      },
      400,
    );
  }

  // ── Credit via the RPC. Purchase token is the idempotency key. ───────
  const { data: creditData, error: creditErr } = await sbAdmin.rpc("credit_iap_purchase", {
    p_user_id:        userId,
    p_platform:       "google_play",
    p_transaction_id: purchaseToken,
    p_package_id:     pack.id,
    p_raw_payload:    {
      orderId:               gp.orderId,
      purchaseTimeMillis:    gp.purchaseTimeMillis,
      consumptionState:      gp.consumptionState,
      acknowledgementState:  gp.acknowledgementState,
      productId,
      packageName,
    },
  });
  if (creditErr) {
    console.error("[verify-google-play-purchase] credit RPC error:", creditErr);
    return jsonResponse({ ok: false, error: "credit_rpc_error", detail: creditErr.message }, 500);
  }
  if (!creditData?.ok) {
    return jsonResponse({ ok: false, error: creditData?.error || "credit_failed", detail: creditData }, 400);
  }

  return jsonResponse({
    ok: true,
    already_credited: creditData.already_credited === true,
    purchase_id:      creditData.purchase_id,
    new_balance:      creditData.new_balance,
    coins_credited:   creditData.coins_credited,
    order_id:         gp.orderId,
  });
});
