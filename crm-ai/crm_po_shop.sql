-- Online store orders go to the supplier by themselves (Aviv 18.11.2026: "כשלקוח מזמין - שתשלח הזמנה לספק אוטומטית במידה
-- ומחוברים לו אנשי קשר כמו שצריך - ותאזין לתשובה. ושנהיה על זה. תפריד בין החנות האינטרנטית לעסק הפיזי").
-- The store's paid trigger calls crm_po_shop(order id); crm-po (action shop_order) reads the order itself and opens one crm_po
-- per supplier. origin separates the two businesses: 'crm' = the showroom, 'shop' = the online store. No DROP in this file.
alter table public.crm_po add column if not exists origin text not null default 'crm';
alter table public.crm_po add column if not exists shop_order_id bigint;
-- one supplier order per store order and supplier, whatever calls twice
create unique index if not exists crm_po_shop_uq on public.crm_po (shop_order_id, supplier_id) where shop_order_id is not null;

-- Stock on hand by supplier code, for the edge function (crm_stock_for is the same match for signed-in staff).
create or replace function public.crm_stock_sys(p_codes text[]) returns table (code text, available numeric)
language sql stable security definer set search_path to 'public' as $$
  select c.code, sum(coalesce(s.available_qty, s.qty))::numeric
  from unnest(p_codes) c(code)
  join priority_stock s on upper(regexp_replace(s.part_no, '[\s\-./]', '', 'g')) = upper(regexp_replace(c.code, '[\s\-./]', '', 'g'))
  where length(regexp_replace(c.code, '[\s\-./]', '', 'g')) >= 3
  group by c.code
$$;
revoke all on function public.crm_stock_sys(text[]) from public, anon, authenticated;

-- Called by the store when an order turns paid. Returns the pg_net request id; the answer lands in net._http_response.
-- Safe to call twice, and a call that gets lost is picked up by crm-po's outbox run within minutes.
create or replace function public.crm_po_shop(p_order bigint) returns bigint language plpgsql security definer set search_path to 'public' as $$
declare v_token text; v_id bigint;
begin
  select hook_token into v_token from crm_push_keys where id = 1;
  select net.http_post(
    url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-po',
    headers := jsonb_build_object('content-type', 'application/json', 'x-hook-token', v_token),
    body := jsonb_build_object('action', 'shop_order', 'order_id', p_order)) into v_id;
  return v_id;
end $$;
revoke all on function public.crm_po_shop(bigint) from public, anon, authenticated;
