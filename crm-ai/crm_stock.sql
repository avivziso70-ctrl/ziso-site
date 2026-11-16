-- Stock on hand for the deal file: "the system knows what is in stock and orders only what is missing" (Aviv 15.11.2026).
-- priority_stock is pushed daily by the Priority robot (part_no, warehouse, qty, reserved_qty, available_qty).
-- A supplier price-list code is matched to our Priority item code after removing spaces, dashes, dots and slashes.
-- 16.11.2026: 261 of 1,541 Priority items match a supplier code this way; the rest stay a manual tick. Staff only. No DROP.
-- reserved_qty is null until open order lines are pushed, which makes available_qty null: fall back to qty.
create or replace function public.crm_stock_for(p_codes text[]) returns table (code text, available numeric, as_of timestamptz)
language sql stable security definer set search_path to 'public' as $$
  select c.code, sum(coalesce(s.available_qty, s.qty))::numeric, max(s.source_at)
  from unnest(p_codes) c(code)
  join priority_stock s on upper(regexp_replace(s.part_no, '[\s\-./]', '', 'g')) = upper(regexp_replace(c.code, '[\s\-./]', '', 'g'))
  where public.crm_me() is not null and length(regexp_replace(c.code, '[\s\-./]', '', 'g')) >= 3
  group by c.code
$$;
revoke all on function public.crm_stock_for(text[]) from public, anon;
grant execute on function public.crm_stock_for(text[]) to authenticated;
