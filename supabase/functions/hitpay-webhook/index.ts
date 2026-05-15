// supabase/functions/hitpay-webhook/index.ts
//
// HitPay payment webhook receiver (Android side).
// ─────────────────────────────────────────────────────────────────────
//
// HitPay is the third-party payment processor used for Android coin
// purchases. After the user completes a payment in HitPay's flow,
// HitPay POSTs an x-www-form-urlencoded body here with the payment
// status. We:
//
//   1. Verify the HMAC signature using the salt from env
//      (HITPAY_WEBHOOK_SALT — copy from HitPay dashboard → API Keys)
//   2. If status='completed', resolve the purchased pack via the
//      `reference_number` (we set this when creating the payment
//      request in mobile to be `userId:packId`)
//   3. Call credit_iap_purchase with platform='hitpay'
//
// HMAC scheme (from HitPay docs):
//   payload_str = sorted(form_fields).map(k => `${k}${v}`).join('')
//   expected_hmac = HMAC_SHA256(payload_str, salt).hex()
//   compare against the `hmac` form field.
//
// Configure in HitPay Dashboard:
//   Settings → API Keys → Webhook URL =
//   https://zplisqwoejxrdrpbfass.supabase.co/functions/v1/hitpay-webhook
//   Salt → copy into HITPAY_WEBHOOK_SALT env var on Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HITPAY_WEBHOOK_SALT = Deno.env.get("HITPAY_WEBHOOK_SALT")!;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Compute HMAC-SHA256 of `data` keyed by `salt`. Returns lowercase hex.
async function hmacSha256Hex(data: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Build the canonical signing string from form fields (HitPay
// convention). Sort keys alphabetically and concatenate `${k}${v}`.
function buildSigningString(fields: Record<string, string>): string {
  const keys = Object.keys(fields).filter((k) => k !== "hmac").sort();
  return keys.map((k) => `${k}${fields[k]}`).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method_not_allowed", { status: 405 });
  }

  // HitPay posts urlencoded form data.
  let form: Record<string, string>;
  try {
    const text = await req.text();
    const params = new URLSearchParams(text);
    form = Object.fromEntries(params.entries());
  } catch {
    return new Response("bad_form", { status: 400 });
  }

  const receivedHmac = form["hmac"] || form["HMAC"] || "";
  if (!receivedHmac) {
    return new Response(JSON.stringify({ ok: false, error: "no_hmac" }), { status: 401 });
  }

  // Verify signature.
  const signing = buildSigningString(form);
  const expected = await hmacSha256Hex(signing, HITPAY_WEBHOOK_SALT);
  if (expected !== receivedHmac.toLowerCase()) {
    console.error("[hitpay-webhook] hmac mismatch", { expected, received: receivedHmac });
    return new Response(JSON.stringify({ ok: false, error: "bad_hmac" }), { status: 401 });
  }

  const status = (form["status"] || "").toLowerCase();
  const paymentId = form["payment_id"] || form["payment_request_id"] || "";
  const reference = form["reference_number"] || "";
  const amount = Number(form["amount"]) || 0;
  // Convention: mobile sets reference_number = `${userId}:${packId}`.
  const [userId, packId] = reference.split(":");

  // Only credit on completed; ignore pending / failed / canceled.
  if (status !== "completed") {
    return new Response(JSON.stringify({ ok: true, ignored: true, status }), { status: 200 });
  }

  if (!paymentId || !userId || !packId) {
    return new Response(JSON.stringify({ ok: false, error: "missing_fields" }), { status: 400 });
  }

  // Resolve pack — exists check only. credit_iap_purchase reads
  // base/bonus/price internally via package_id, so we just need to
  // verify the uuid is valid and pass it through.
  const { data: pack, error: packErr } = await sb
    .from("coin_packages")
    .select("id")
    .eq("id", packId)
    .maybeSingle();
  if (packErr || !pack) {
    console.error("[hitpay-webhook] pack lookup failed:", packErr);
    return new Response(JSON.stringify({ ok: false, error: "unknown_pack" }), { status: 200 });
  }

  const { data, error } = await sb.rpc("credit_iap_purchase", {
    p_user_id: userId,
    p_platform: "hitpay",
    p_transaction_id: paymentId,
    p_package_id: pack.id,
    p_raw_payload: form,
  });

  if (error) {
    console.error("[hitpay-webhook] credit rpc error:", error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  }

  return new Response(JSON.stringify(data), { status: 200 });
});
