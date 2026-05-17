// supabase/functions/google-play-rtdn-webhook/index.ts
//
// Google Play Real-Time Developer Notifications (RTDN) receiver.
// ─────────────────────────────────────────────────────────────────────
//
// What this handles
// -----------------
// Google Play uses Pub/Sub to push notifications about purchase
// lifecycle events (refunds, voids, chargebacks, subscription
// changes). For Selebox's one-time coin purchases the only event we
// care about right now is `voidedPurchaseNotification` — when a user
// (or Google) refunds a purchase, we need to debit the coins from
// their wallet so they can't keep coins they didn't pay for.
//
// Flow
// ----
//   1. Google Play emits a notification to a Pub/Sub topic owned by
//      our project.
//   2. Pub/Sub Push subscription POSTs the message to this function.
//   3. We verify the OIDC JWT in the Authorization header — confirms
//      the call came from Google Pub/Sub (not a forger trying to fake
//      refunds and drain coins from users).
//   4. We decode the base64 message body.
//   5. For voidedPurchaseNotification: call refund_iap_purchase RPC
//      with platform='google_play' and the purchase token.
//   6. For other notification types: log + ACK (we don't act on them).
//   7. Always return 200 OK so Pub/Sub doesn't redeliver. Errors are
//      handled internally — Pub/Sub redelivery would just spam.
//
// Idempotency
// -----------
// refund_iap_purchase already has built-in idempotency (returns
// already_refunded:true on second call). So Pub/Sub re-delivering
// the same message is harmless.
//
// Required env vars
// -----------------
//   SUPABASE_URL                 — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY    — auto-injected
//   GOOGLE_RTDN_AUDIENCE         — the OIDC `aud` claim configured on
//                                  the Pub/Sub Push subscription.
//                                  Typically the webhook URL itself, or
//                                  a custom audience string. Must match
//                                  what's set in the Pub/Sub console.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_RTDN_AUDIENCE = Deno.env.get("GOOGLE_RTDN_AUDIENCE") || "";

// ── Notification type constants (Google Play docs) ────────────────────
// For one-time products (productType=2 inside the notification):
//   1 = ONE_TIME_PRODUCT_PURCHASED   (informational; verified at buy)
//   2 = ONE_TIME_PRODUCT_CANCELED    (user canceled before completion)
// voidedPurchase covers refunds + chargebacks regardless of product type.

interface PubSubPushMessage {
  message: {
    data?: string;            // base64-encoded JSON
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

interface RtdnPayload {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  voidedPurchaseNotification?: {
    purchaseToken: string;
    orderId: string;
    productType?: number;     // 1 = subscription, 2 = one-time
    refundType?: number;      // 1 = full, 2 = partial
  };
  oneTimeProductNotification?: {
    version?: string;
    notificationType: number;
    purchaseToken: string;
    sku?: string;
  };
  subscriptionNotification?: {
    notificationType: number;
    purchaseToken: string;
    subscriptionId?: string;
  };
  testNotification?: {
    version: string;
  };
}

// ── JWT decoding helpers ──────────────────────────────────────────────
function base64UrlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// Cache Google's OIDC public keys for the isolate's lifetime so we
// don't re-fetch them on every invocation. Keys rotate so we refresh
// every 6 hours.
interface GoogleKeysCache {
  keys: Record<string, CryptoKey>;
  fetchedAt: number;
}
let cachedKeys: GoogleKeysCache | null = null;
const KEYS_TTL_MS = 6 * 60 * 60 * 1000;

async function getGooglePublicKeys(): Promise<Record<string, CryptoKey>> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < KEYS_TTL_MS) {
    return cachedKeys.keys;
  }
  // Google publishes OIDC keys at this JWKS endpoint
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new Error(`google_jwks_fetch_failed: ${res.status}`);
  const jwks = await res.json();
  const keys: Record<string, CryptoKey> = {};
  for (const k of jwks.keys || []) {
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "jwk",
        k,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys[k.kid] = cryptoKey;
    } catch (e) {
      console.warn("[rtdn] skipping non-RS256 key kid=", k.kid, e);
    }
  }
  cachedKeys = { keys, fetchedAt: Date.now() };
  return keys;
}

async function verifyGoogleOidcJwt(jwt: string): Promise<{
  ok: boolean;
  reason?: string;
  claims?: Record<string, unknown>;
}> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_jwt" };

  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string; kid?: string; typ?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(utf8(base64UrlDecode(headerB64)));
    payload = JSON.parse(utf8(base64UrlDecode(payloadB64)));
  } catch {
    return { ok: false, reason: "jwt_decode_failed" };
  }

  if (header.alg !== "RS256") return { ok: false, reason: "unsupported_alg" };
  if (!header.kid)            return { ok: false, reason: "missing_kid" };

  const keys = await getGooglePublicKeys();
  const key = keys[header.kid];
  if (!key) return { ok: false, reason: "unknown_kid" };

  const sig = base64UrlDecode(sigB64);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  if (!valid) return { ok: false, reason: "bad_signature" };

  // Standard OIDC claim checks. Google's tokens have:
  //   iss: 'https://accounts.google.com' or 'accounts.google.com'
  //   aud: the audience we set on the Pub/Sub subscription
  //   exp: unix seconds
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || (payload.exp as number) < nowSec) {
    return { ok: false, reason: "expired" };
  }
  const iss = payload.iss as string;
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
    return { ok: false, reason: "bad_issuer" };
  }
  if (GOOGLE_RTDN_AUDIENCE) {
    const aud = payload.aud as string;
    if (aud !== GOOGLE_RTDN_AUDIENCE) {
      return { ok: false, reason: `bad_audience (got ${aud})` };
    }
  }
  return { ok: true, claims: payload };
}

// ── Main handler ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  // Pub/Sub Push sends POSTs.
  if (req.method !== "POST") {
    return new Response("method_not_allowed", { status: 405 });
  }

  // OIDC auth.
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    console.warn("[rtdn] missing authorization header");
    return new Response("missing_authorization", { status: 401 });
  }
  const jwt = authHeader.slice(7);
  const auth = await verifyGoogleOidcJwt(jwt);
  if (!auth.ok) {
    console.warn("[rtdn] auth failed:", auth.reason);
    return new Response(`auth_failed: ${auth.reason}`, { status: 401 });
  }

  // Parse Pub/Sub envelope.
  let envelope: PubSubPushMessage;
  try {
    envelope = (await req.json()) as PubSubPushMessage;
  } catch {
    return new Response("invalid_envelope", { status: 400 });
  }
  if (!envelope?.message?.data) {
    // Pub/Sub sometimes pings with empty/test messages — ACK anyway.
    console.log("[rtdn] empty message body, ACKing");
    return new Response("ok", { status: 200 });
  }

  // Decode the base64 message body. This is the actual Google Play
  // notification payload.
  let payload: RtdnPayload;
  try {
    const json = utf8(base64UrlDecode(envelope.message.data));
    payload = JSON.parse(json) as RtdnPayload;
  } catch (e) {
    console.error("[rtdn] payload decode failed:", e);
    // ACK so Pub/Sub doesn't redeliver garbage.
    return new Response("ok", { status: 200 });
  }

  console.log(
    "[rtdn] notification received:",
    JSON.stringify({
      packageName: payload.packageName,
      eventTimeMillis: payload.eventTimeMillis,
      types: Object.keys(payload).filter((k) => k.endsWith("Notification")),
    }),
  );

  // Service-role client for the refund RPC + dedup lookup.
  const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Test notification (Play Console "Send test notification") ──────
  if (payload.testNotification) {
    console.log(
      "[rtdn] test notification received, version=",
      payload.testNotification.version,
    );
    return new Response("ok", { status: 200 });
  }

  // ── Voided purchase (refund / chargeback / void) ────────────────────
  if (payload.voidedPurchaseNotification) {
    const { purchaseToken, orderId, productType, refundType } =
      payload.voidedPurchaseNotification;

    console.log(
      "[rtdn] voidedPurchase orderId=",
      orderId,
      "productType=",
      productType,
      "refundType=",
      refundType,
    );

    try {
      const { data, error } = await sbAdmin.rpc("refund_iap_purchase", {
        p_platform:       "google_play",
        p_transaction_id: purchaseToken,
        p_raw_payload:    {
          source:           "rtdn",
          orderId,
          productType,
          refundType,
          eventTimeMillis:  payload.eventTimeMillis,
          messageId:        envelope.message.messageId,
        },
      });
      if (error) {
        console.error("[rtdn] refund RPC error:", error.message);
        // 500 → Pub/Sub will retry. That's what we want — transient
        // DB error shouldn't drop the refund event.
        return new Response(`refund_failed: ${error.message}`, { status: 500 });
      }
      if (!data?.ok && !data?.already_refunded) {
        if (data?.error === "not_found") {
          // Purchase token isn't in our table. Could be: a real
          // purchase that never got verified (e.g. mobile crashed
          // mid-flow) or noise from a different app sharing the
          // same Pub/Sub topic. Log + ACK; nothing to debit.
          console.warn(
            "[rtdn] refund for unknown purchase token, ignoring. token=",
            purchaseToken.slice(0, 12) + "…",
          );
          return new Response("ok_unknown_token", { status: 200 });
        }
        console.error("[rtdn] refund returned error:", data);
        return new Response(`refund_failed: ${data?.error}`, { status: 500 });
      }
      console.log(
        "[rtdn] refund OK purchase_id=",
        data.purchase_id,
        "already_refunded=",
        !!data.already_refunded,
        "coins_refunded=",
        data.coins_refunded,
      );
    } catch (e) {
      console.error("[rtdn] refund handler exception:", e);
      return new Response(`refund_exception: ${e}`, { status: 500 });
    }
    return new Response("ok", { status: 200 });
  }

  // ── Other notification types (informational only) ──────────────────
  if (payload.oneTimeProductNotification) {
    // notificationType:
    //   1 = ONE_TIME_PRODUCT_PURCHASED — already verified at buy time
    //   2 = ONE_TIME_PRODUCT_CANCELED  — user canceled before confirming
    console.log(
      "[rtdn] oneTimeProduct notif type=",
      payload.oneTimeProductNotification.notificationType,
      "sku=",
      payload.oneTimeProductNotification.sku,
    );
    return new Response("ok", { status: 200 });
  }
  if (payload.subscriptionNotification) {
    // Not used today (no subscriptions). Logging so we'd see them if
    // someone enables a subscription product in Play Console.
    console.log(
      "[rtdn] subscription notif type=",
      payload.subscriptionNotification.notificationType,
    );
    return new Response("ok", { status: 200 });
  }

  // Unknown shape — ACK so Pub/Sub stops retrying.
  console.warn("[rtdn] unrecognized notification shape, ACKing.");
  return new Response("ok_unknown", { status: 200 });
});
