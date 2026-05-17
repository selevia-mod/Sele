# verify-google-play-purchase — setup runbook

This Edge Function verifies Google Play in-app purchases server-side and credits the buyer's wallet via `credit_iap_purchase`. Before it can run, you need a Google Cloud **service account** with permission to call the Play Developer API.

Do these once, in order. The whole thing takes ~15 minutes.

---

## 1. Make sure the Play Developer API is enabled

1. Open https://console.cloud.google.com — sign in with the same Google account you use for Play Console
2. Top-left dropdown → confirm you're in the project that's linked to your Play Console developer account
   - If you've never linked one, go to https://play.google.com/console → **Settings → Developer account → API access** and click **Choose a project to link**, then pick a Google Cloud project (create one called e.g. `selebox-play-api` if you don't have one yet)
3. In Cloud Console: **APIs & Services → Library** → search **"Google Play Android Developer API"** → click **Enable**

If it's already enabled you'll see "API enabled" instead of the Enable button — skip ahead.

---

## 2. Create the service account

1. Cloud Console: **IAM & Admin → Service Accounts** → **Create service account**
2. Name: `selebox-play-iap-verifier`
3. ID (auto-filled): leave it
4. Description: `Verifies Google Play IAP purchases for selebox.com`
5. Click **Create and continue**
6. **Skip** the "Grant this service account access to project" step — we don't need any Cloud project roles, only Play Console access (next step)
7. Click **Done**

You'll land back on the service accounts list. Click the one you just made.

---

## 3. Generate the JSON key

1. On the service account page → **Keys** tab → **Add key → Create new key**
2. Key type: **JSON** → **Create**
3. Browser downloads a `selebox-play-api-xxxxxxxx.json` file
4. **Open it in a text editor** — you'll need the whole contents in step 5
5. **Keep this file secret.** Don't commit it. Don't share it. Treat it like a password

The JSON looks like:

```json
{
  "type": "service_account",
  "project_id": "selebox-play-api",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "selebox-play-iap-verifier@selebox-play-api.iam.gserviceaccount.com",
  "client_id": "...",
  "auth_uri": "...",
  "token_uri": "https://oauth2.googleapis.com/token",
  ...
}
```

The `client_email` is what you'll paste into Play Console next.

---

## 4. Grant the service account access in Play Console

1. https://play.google.com/console → **Users and permissions** (sidebar, near the top)
2. **Invite new users**
3. Email address: paste the `client_email` from the JSON (the `....iam.gserviceaccount.com` one)
4. Account permissions → leave them blank (nothing global)
5. **App permissions** tab → **Add app** → pick **SeLeBox** (`com.talesofsiren.talesofsiren`)
6. Per-app permissions: tick exactly these (everything else stays off):
   - **View financial data, orders, and cancellation survey responses** ← needed for purchase verification
   - **Manage orders and subscriptions** ← needed if you want to refund/acknowledge via API later
7. **Apply** → **Invite user**
8. Service accounts auto-accept invites — no email confirmation needed

**Heads up:** Google's docs say permissions can take up to 24 hours to propagate. In practice it's usually a few minutes. If your first test purchase fails with `403 forbidden` from the Developer API, this is why — wait and try again.

---

## 5. Paste the JSON into Supabase env

The Edge Function reads the key from an env var named `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.

1. https://supabase.com/dashboard → your project → **Project Settings → Edge Functions → Secrets**
2. **Add new secret**
3. Name: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`
4. Value: paste the **entire** contents of the JSON file (open it, Cmd-A, Cmd-C, paste)
   - Yes, including the curly braces. The function does `JSON.parse(env_var)` to read it
   - Don't escape quotes manually — paste as-is

5. **Save**

---

## 6. Deploy the Edge Function

From your terminal (Supabase CLI needs to be installed once — `brew install supabase/tap/supabase` on Mac):

```bash
cd /Users/arcaracalague/Documents/Selebox
supabase functions deploy verify-google-play-purchase
```

If the CLI complains you're not logged in:

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

Project ref is the `zplisqwoejxrdrpbfass` part of your Supabase URL.

---

## 7. Add a license tester so test purchases don't charge real money

1. Play Console → **Settings → License testing**
2. **Add tester email** → paste the Google account email of the device you'll test on
3. License response: **RESPOND_NORMALLY**
4. **Save changes**

The tester device must be **signed in to Google Play with that email** for license testing to apply. Test purchases process through the Play UI like real ones but charge $0.

---

## 8. Build a new Android APK

The IAP flow is native code, not JS — `eas update` won't ship it. You need a fresh build:

```bash
cd /Users/arcaracalague/Documents/selebox-mobile-main
npm run build-apk
```

EAS will produce an APK URL. Install it on a physical Android device (emulator doesn't have Play Store IAP) that's signed in with the license tester email.

---

## 9. Test

Open the app → Store tab → tap the 20-coin pack. Should:

1. Show the Google Play purchase sheet with "₱X.XX" price (test purchase — no real charge)
2. After confirming, Play Console returns a purchase token to the app
3. App calls the edge function (you'll see one request in Supabase Functions → verify-google-play-purchase → Logs)
4. Edge function asks Google "is this real?" → Google says yes
5. RPC credits the wallet: balance goes up by 80 coins (20 base + 60 bonus)
6. Toast or balance refresh in the app
7. `coin_purchases` table has a new row with `platform='google_play'`, `google_play_purchase_token=<the token>`, `status='credited'`

To re-test, you'll need to either:
- Wait for Google to mark the test product as available again (auto-consumed in our flow, so usually instant), OR
- Refund the test purchase in Play Console → Orders, then it's purchasable again

---

## Troubleshooting

**`google_oauth_failed: 400 invalid_grant`** — Your service account JSON is malformed or the system clock on Supabase is skewed. Re-paste the JSON. Confirm the `private_key` includes the `\n` characters literally (they should NOT be expanded into actual newlines).

**`purchase_not_verified: 403`** — Service account doesn't have Play Console access yet. Wait 5-15 min after step 4, or double-check the email matches the `client_email` in the JSON.

**`purchase_not_verified: 404`** — Wrong `packageName` or `productId` sent from mobile. Confirm `app.json` has `"package": "com.talesofsiren.talesofsiren"` and the SKU you pressed exists in Play Console.

**`unknown_or_inactive_product`** — The pack's `iap_android_product_id` in `coin_packages` doesn't match what mobile sent. Run:

```sql
select id, name, iap_ios_product_id, iap_android_product_id
  from public.coin_packages
 where iap_android_product_id is not null;
```

**Edge function 401 `invalid_token`** — The mobile client isn't sending the user's Supabase JWT. `supabase.functions.invoke()` should attach it automatically; if not, check `lib/supabase.js` setup.

---

## When this is all working

Optionally layer on **Real-Time Developer Notifications (RTDN)** for refund / void events. That's a separate Edge Function + a Google Cloud Pub/Sub subscription. Not needed for the initial launch — the initial purchase flow is fully self-contained without it. Tackle RTDN as a follow-up when you start seeing refund tickets.
