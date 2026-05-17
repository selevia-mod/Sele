-- ════════════════════════════════════════════════════════════════════════
-- 2026-05-17 — Google Play IAP support (schema + RPCs + SKU backfill)
--
-- Background
-- ----------
-- credit_iap_purchase + refund_iap_purchase currently handle only
-- 'apple_ios' and 'hitpay' platforms. coin_purchases has
-- apple_transaction_id and hitpay_payment_id columns, but no
-- equivalent for Google Play. Result: any 'google_play' call into
-- credit_iap_purchase returns 'unsupported_platform' and the user
-- never gets credited.
--
-- This migration adds:
--   1. coin_purchases.google_play_purchase_token (text, unique partial idx)
--   2. credit_iap_purchase — new 'google_play' branch using the
--      purchase token as the idempotency key
--   3. refund_iap_purchase — same
--   4. Backfill the existing iOS coins20 pack with its Android SKU
--      (Google Play uses the same product id 'com.talesofsiren.coins20')
--
-- The Google Play purchase token is what Google's Developer API
-- considers the canonical idempotency key for a single purchase.
-- It's emitted to the mobile client at purchase time and surfaced
-- in Real-Time Developer Notifications (RTDN). Storing it lets us
-- dedupe replays + correlate refunds back to the original credit.
--
-- Rollback
-- --------
--   • Re-apply migration_coin_packages_iap_columns.sql to restore
--     the old (apple-only + hitpay) credit_iap_purchase signatures.
--   • drop the google_play_purchase_token column.
-- ════════════════════════════════════════════════════════════════════════

begin;


-- ──────────────────────────────────────────────────────────────────────
-- 1. Schema — add google_play_purchase_token to coin_purchases.
-- ──────────────────────────────────────────────────────────────────────
alter table public.coin_purchases
  add column if not exists google_play_purchase_token text;

-- Unique partial index — purchase tokens from Google Play are globally
-- unique per (developer, product). The partial WHERE matches the
-- existing apple_transaction_id pattern.
create unique index if not exists coin_purchases_google_play_purchase_token_uidx
  on public.coin_purchases (google_play_purchase_token)
  where google_play_purchase_token is not null;


-- ──────────────────────────────────────────────────────────────────────
-- 2. credit_iap_purchase — add 'google_play' branch.
-- ──────────────────────────────────────────────────────────────────────
-- Replaces the version from migration_coin_packages_iap_columns.sql.
-- Same external contract; the only changes are:
--   • New 'google_play' branch in the lookup-by-platform block
--   • New 'google_play' branch in the INSERT (writes to
--     google_play_purchase_token)
-- Everything else (idempotency, refund guard, wallet update, exception
-- handler) is byte-identical to the previous version.

drop function if exists public.credit_iap_purchase(uuid, text, text, uuid, jsonb);

create or replace function public.credit_iap_purchase(
  p_user_id        uuid,
  p_platform       text,
  p_transaction_id text,
  p_package_id     uuid,
  p_raw_payload    jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack         record;
  v_coins        int;
  v_amount_minor int;
  v_existing     record;
  v_purchase_id  uuid;
  v_new_balance  int;
begin
  if p_user_id is null or p_platform is null or p_transaction_id is null or p_package_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_args');
  end if;

  select id, base_coins, bonus_coins, price_minor
    into v_pack
    from public.coin_packages
    where id = p_package_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown_pack');
  end if;
  v_coins := coalesce(v_pack.base_coins, 0) + coalesce(v_pack.bonus_coins, 0);
  if v_coins <= 0 then
    return jsonb_build_object('ok', false, 'error', 'zero_coins');
  end if;
  v_amount_minor := coalesce(v_pack.price_minor, 0);

  -- Platform-specific dedup lookup. Each platform has its own
  -- idempotency column on coin_purchases.
  if p_platform = 'apple_ios' then
    select * into v_existing from public.coin_purchases
      where apple_transaction_id = p_transaction_id
      for update;
  elsif p_platform = 'hitpay' then
    select * into v_existing from public.coin_purchases
      where hitpay_payment_id = p_transaction_id
      for update;
  elsif p_platform = 'google_play' then
    select * into v_existing from public.coin_purchases
      where google_play_purchase_token = p_transaction_id
      for update;
  else
    return jsonb_build_object('ok', false, 'error', 'unsupported_platform');
  end if;

  if found and v_existing.status in ('credited', 'completed') then
    select coin_balance into v_new_balance from public.wallets where user_id = v_existing.user_id;
    return jsonb_build_object(
      'ok', true,
      'already_credited', true,
      'purchase_id', v_existing.id,
      'new_balance', coalesce(v_new_balance, 0)
    );
  end if;

  if found and v_existing.status = 'refunded' then
    return jsonb_build_object('ok', false, 'error', 'already_refunded', 'purchase_id', v_existing.id);
  end if;

  if found then
    v_purchase_id := v_existing.id;
    update public.coin_purchases
      set platform = p_platform,
          metadata = coalesce(p_raw_payload, metadata),
          status   = 'pending'
      where id = v_purchase_id;
  else
    insert into public.coin_purchases
      (user_id, package_id, platform,
       apple_transaction_id, hitpay_payment_id, google_play_purchase_token,
       amount_minor, currency, status, metadata)
    values
      (p_user_id, p_package_id, p_platform,
       case when p_platform = 'apple_ios'   then p_transaction_id else null end,
       case when p_platform = 'hitpay'      then p_transaction_id else null end,
       case when p_platform = 'google_play' then p_transaction_id else null end,
       v_amount_minor, 'PHP', 'pending', coalesce(p_raw_payload, '{}'::jsonb))
    returning id into v_purchase_id;
  end if;

  insert into public.wallets (user_id, coin_balance)
  values (p_user_id, v_coins)
  on conflict (user_id)
  do update set coin_balance = wallets.coin_balance + v_coins,
                updated_at   = now()
  returning coin_balance into v_new_balance;

  update public.coin_purchases
    set status = 'credited', completed_at = now()
    where id = v_purchase_id;

  return jsonb_build_object(
    'ok', true,
    'already_credited', false,
    'purchase_id', v_purchase_id,
    'new_balance', v_new_balance,
    'coins_credited', v_coins
  );
exception when others then
  if v_purchase_id is not null then
    update public.coin_purchases set status = 'failed' where id = v_purchase_id;
  end if;
  return jsonb_build_object('ok', false, 'error', 'credit_failed', 'detail', sqlerrm);
end;
$$;

revoke all on function public.credit_iap_purchase(uuid, text, text, uuid, jsonb) from public;
revoke all on function public.credit_iap_purchase(uuid, text, text, uuid, jsonb) from authenticated;
revoke all on function public.credit_iap_purchase(uuid, text, text, uuid, jsonb) from anon;
grant execute on function public.credit_iap_purchase(uuid, text, text, uuid, jsonb) to service_role;


-- ──────────────────────────────────────────────────────────────────────
-- 3. refund_iap_purchase — add 'google_play' branch.
-- ──────────────────────────────────────────────────────────────────────
drop function if exists public.refund_iap_purchase(text, text, jsonb);

create or replace function public.refund_iap_purchase(
  p_platform       text,
  p_transaction_id text,
  p_raw_payload    jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_pack record;
  v_coins int;
  v_new_balance int;
begin
  if p_platform = 'apple_ios' then
    select * into v_row from public.coin_purchases
      where apple_transaction_id = p_transaction_id for update;
  elsif p_platform = 'hitpay' then
    select * into v_row from public.coin_purchases
      where hitpay_payment_id = p_transaction_id for update;
  elsif p_platform = 'google_play' then
    select * into v_row from public.coin_purchases
      where google_play_purchase_token = p_transaction_id for update;
  else
    return jsonb_build_object('ok', false, 'error', 'unsupported_platform');
  end if;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_row.status = 'refunded' then
    return jsonb_build_object('ok', true, 'already_refunded', true, 'purchase_id', v_row.id);
  end if;

  select base_coins, bonus_coins into v_pack
    from public.coin_packages where id = v_row.package_id;
  v_coins := coalesce(v_pack.base_coins, 0) + coalesce(v_pack.bonus_coins, 0);

  update public.wallets
    set coin_balance = greatest(0, coin_balance - v_coins),
        updated_at = now()
    where user_id = v_row.user_id
    returning coin_balance into v_new_balance;

  update public.coin_purchases
    set status = 'refunded',
        metadata = coalesce(p_raw_payload, metadata)
    where id = v_row.id;

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_row.id,
    'coins_refunded', v_coins,
    'new_balance', coalesce(v_new_balance, 0)
  );
end;
$$;

revoke all on function public.refund_iap_purchase(text, text, jsonb) from public;
revoke all on function public.refund_iap_purchase(text, text, jsonb) from authenticated;
revoke all on function public.refund_iap_purchase(text, text, jsonb) from anon;
grant execute on function public.refund_iap_purchase(text, text, jsonb) to service_role;


-- ──────────────────────────────────────────────────────────────────────
-- 4. Backfill: set iap_android_product_id on the 20-coins pack.
--
-- The iOS column for this pack is 'com.talesofsiren.COINS20' (uppercase)
-- but Google Play only allows lowercase product IDs — so the Android
-- SKU is 'com.talesofsiren.coins20'. Same logical pack, different SKU
-- strings per store (that's why we have two columns).
--
-- Matching by the pack's id directly (vs by iOS SKU with LOWER()) so
-- this stays correct regardless of which case conventions other packs
-- end up using.
-- ──────────────────────────────────────────────────────────────────────
update public.coin_packages
   set iap_android_product_id = 'com.talesofsiren.coins20'
 where id = '1c3559f8-52da-4c1b-8a2a-afa375cecd58'
   and (iap_android_product_id is distinct from 'com.talesofsiren.coins20');


commit;


-- ════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. Confirm column added:
--      \d public.coin_purchases
--    Should show google_play_purchase_token text.
--
-- 2. Confirm the SKU backfill landed:
--      select id, name, base_coins, bonus_coins, price_minor,
--             iap_ios_product_id, iap_android_product_id
--        from public.coin_packages
--       where id = '1c3559f8-52da-4c1b-8a2a-afa375cecd58';
--    Expect: iap_ios_product_id     = 'com.talesofsiren.COINS20'
--            iap_android_product_id = 'com.talesofsiren.coins20'
--
-- 3. Confirm RPC handles google_play (manual smoke — make sure your
--    test runs under service_role since the RPC is service-role only):
--      select public.credit_iap_purchase(
--        '<test-user-uuid>'::uuid,
--        'google_play',
--        'fake_purchase_token_smoketest_001',
--        (select id from public.coin_packages
--          where iap_android_product_id = 'com.talesofsiren.coins20'),
--        '{"smoke":"test"}'::jsonb
--      );
--    Should return ok:true with coins_credited matching base+bonus.
--    Re-running should return already_credited:true.
--    Clean up afterward:
--      delete from public.coin_purchases
--       where google_play_purchase_token = 'fake_purchase_token_smoketest_001';
--      -- and roll back the wallet credit on the test user.


-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════
-- Re-apply migration_coin_packages_iap_columns.sql to restore the
-- two-platform version of credit_iap_purchase + refund_iap_purchase.
-- alter table public.coin_purchases drop column google_play_purchase_token;
-- update public.coin_packages set iap_android_product_id = null
--  where iap_android_product_id = 'com.talesofsiren.coins20';
