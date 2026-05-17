# google-play-rtdn-webhook — setup runbook

This Edge Function receives Google Play's Real-Time Developer Notifications (RTDN). It's how we auto-debit users' wallets when they refund or charge back a coin purchase.

Setup is a chain of three things: a **Pub/Sub topic** (where Google publishes events), a **Push subscription** (delivers them to this function), and a **Play Console RTDN config** (points Play at the topic). Do them in order.

---

## 1. Deploy the Edge Function

```bash
cd /Users/arcaracalague/Documents/Selebox
supabase functions deploy google-play-rtdn-webhook
```

After deploy, the function URL is:

```
https://zplisqwoejxrdrpbfass.supabase.co/functions/v1/google-play-rtdn-webhook
```

Keep this URL handy — you'll paste it into Pub/Sub in step 3.

---

## 2. Create the Pub/Sub topic

1. Open https://console.cloud.google.com → top-left dropdown → make sure you're in the same Cloud project linked to Play Console (`selebox-play-api` or whatever you used in step 2 of the verify-google-play-purchase runbook)
2. Sidebar → **Pub/Sub → Topics**
3. **Create topic**
4. Topic ID: `google-play-rtdn-selebox`
5. **Add a default subscription**: uncheck this — we'll create a Push subscription manually with auth in the next step
6. Click **Create**

---

## 3. Grant Google Play permission to publish to the topic

Google Play needs to be able to write to your Pub/Sub topic. Grant the Play service account `pubsub.publisher` on the topic:

1. Still on the topic page → **Permissions** tab (or click the topic name → "Permissions" at the top)
2. **Add principal**
3. New principal: `google-play-developer-notifications@system.gserviceaccount.com`
4. Role: **Pub/Sub Publisher**
5. **Save**

This is the system account Google Play uses to push notifications to your project. Same for everyone.

---

## 4. Create the Push subscription

This is where we tell Pub/Sub "when a message lands, POST it to our Edge Function with an OIDC token so the function can verify it."

1. Sidebar → **Pub/Sub → Subscriptions**
2. **Create subscription**
3. Subscription ID: `google-play-rtdn-selebox-push`
4. **Cloud Pub/Sub topic**: `projects/<your-cloud-project>/topics/google-play-rtdn-selebox` (use the dropdown to pick it)
5. **Delivery type**: **Push**
6. **Endpoint URL**: paste your Edge Function URL from step 1:
   ```
   https://zplisqwoejxrdrpbfass.supabase.co/functions/v1/google-play-rtdn-webhook
   ```
7. **Enable authentication**: ✓ tick this
8. **Service account**: pick the `selebox-play-iap-verifier` service account you created in the verify-google-play-purchase runbook. Pub/Sub will use it to sign the OIDC token.
9. **Audience**: leave blank to use the endpoint URL as the audience, OR set a custom string like `selebox-rtdn`. Whatever you put here must match the `GOOGLE_RTDN_AUDIENCE` env var on Supabase (step 5).
10. **Acknowledgement deadline**: 60 seconds (default is fine)
11. **Message retention duration**: 7 days (default is fine — gives Google time to retry if our function is down)
12. **Click Create**

If it complains the service account doesn't have permission to act as a Pub/Sub service account, you'll need to grant it the **Service Account Token Creator** role on itself: IAM → find `selebox-play-iap-verifier` → grant the role to itself. Then retry creating the subscription.

---

## 5. Set the GOOGLE_RTDN_AUDIENCE env var on Supabase

Whatever you put in the **Audience** field in step 4.9 above — paste it into Supabase as an env var:

1. Supabase Dashboard → your project → **Project Settings → Edge Functions → Secrets**
2. **Add new secret**
3. Name: `GOOGLE_RTDN_AUDIENCE`
4. Value: either the full webhook URL (if you left audience blank) OR the custom string you set
5. **Save**

If you skip this step, the function will accept any audience — less secure but still works. Set it for production-grade auth.

---

## 6. Configure Play Console to publish RTDN to your topic

1. https://play.google.com/console → SeLeBox app → sidebar → **Monetize → Monetization setup**
2. Scroll to **Real-time developer notifications**
3. **Topic name**: paste the FULL Pub/Sub topic path:
   ```
   projects/<your-cloud-project>/topics/google-play-rtdn-selebox
   ```
   You can copy the exact format from Cloud Console → Pub/Sub → your topic → top of the page.
4. **Send test notification** — click this button. Within ~30 seconds you should see one invocation in **Supabase → Functions → google-play-rtdn-webhook → Logs** with log line `[rtdn] test notification received, version= 1.0`. If you see it, the whole chain is wired up correctly.
5. **Save changes**

That's it. You're live.

---

## What happens when a user refunds a purchase

1. User requests refund in Play Store (or Google approves a chargeback dispute)
2. Google Play emits a `voidedPurchaseNotification` to your Pub/Sub topic
3. Pub/Sub Push delivers it to your Edge Function with a signed OIDC token
4. Function verifies the JWT against Google's public keys
5. Function decodes the message → finds `purchaseToken` and `orderId`
6. Function calls `refund_iap_purchase(p_platform='google_play', p_transaction_id=<token>)`
7. RPC:
   - Looks up the purchase row by `google_play_purchase_token`
   - Marks it `status='refunded'`
   - Debits the coins from the user's wallet (using `greatest(0, balance - coins)` so the balance can't go negative even if the user already spent them)
8. Function returns 200 OK to ACK the Pub/Sub message
9. Pub/Sub never re-delivers (unless we return 5xx, which triggers retry with backoff)

If the user has already spent the refunded coins, their balance becomes 0 and they're effectively in "negative" territory. We don't track sub-zero balances explicitly — they just can't buy more locked content until they top up again. (Future enhancement: a "you have a negative balance due to refund" notice; not blocking launch.)

---

## Verification

### After Play Console test notification

**Supabase Functions logs** should show:

```
[rtdn] notification received: {"packageName":"com.talesofsiren.talesofsiren", ...}
[rtdn] test notification received, version= 1.0
```

If you see auth errors instead, the OIDC verification setup is off. Check:
- `GOOGLE_RTDN_AUDIENCE` env var matches what's set on the Pub/Sub subscription
- Service account on the subscription is real and has the right permissions

### Real refund smoke test

1. Make a test purchase (license tester, so it's free)
2. Wait for it to show in `coin_purchases` with `status='credited'`
3. Play Console → **Order management** → find the test order → **Refund**
4. Within ~1 minute, the RTDN should arrive
5. Verify:
   ```sql
   select status, metadata
     from public.coin_purchases
    where google_play_purchase_token = '<token>';
   ```
   Should show `status='refunded'` and `metadata` containing `source='rtdn'`.
6. Verify the wallet was debited:
   ```sql
   select coin_balance from public.wallets where user_id = '<test-user>';
   ```

---

## Troubleshooting

**Test notification doesn't arrive at the function** — Pub/Sub permissions issue. Check Pub/Sub → topic → Permissions tab confirms `google-play-developer-notifications@system.gserviceaccount.com` has Publisher role.

**Function returns 401 auth_failed: bad_audience** — `GOOGLE_RTDN_AUDIENCE` env var doesn't match what's on the Pub/Sub subscription. Check both, must be identical.

**Function returns 401 auth_failed: unknown_kid** — Google rotated their OIDC keys and our cache is stale. The function refreshes every 6h, so this self-heals; if it persists, redeploy the function to clear the isolate cache.

**Function returns 200 but refund didn't fire** — Check logs. If you see `refund for unknown purchase token, ignoring`, the purchase wasn't in `coin_purchases` (e.g. mobile failed to verify the purchase originally). Refund manually with:
```sql
update public.coin_purchases set status='refunded' where ...;
update public.wallets set coin_balance = greatest(0, coin_balance - N) where ...;
```

**Pub/Sub messages pile up in "unacked" state** — function is returning 5xx. Check Supabase logs for the error. Pub/Sub retries with exponential backoff up to the retention window (7 days), then drops.
