-- "כסף ובנק" screen in crm/home.html#money (19.11.2026). Read only. The tables stay owner-only; this function is the only door.
-- Owner: the full picture of the latest cash_snapshot (the finance thread keeps that table).
-- Staff marked sees_bank: balance, daily forecast closes and supplier cheques only
-- (no day items, alerts, loans or card, because those carry salary and owners lines).
-- No REVOKE here: the guard is inside the function (a caller with no staff email gets 42501).
create or replace function public.crm_money()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare own boolean; ok boolean; c record; r jsonb;
begin
  select coalesce(bool_or(role = 'owner'), false), coalesce(bool_or(role = 'owner' or sees_bank), false)
    into own, ok
    from public.crm_staff
   where active and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));
  if not ok then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from public.cash_snapshot order by as_of desc limit 1;
  if not found then return jsonb_build_object('empty', true, 'full', own); end if;
  r := jsonb_build_object(
    'full', own, 'as_of', c.as_of, 'updated_at', c.updated_at, 'source', c.source,
    'balance', c.balance, 'credit_limit', c.credit_limit,
    'receipts_mtd', c.receipts_mtd, 'receipts_per_workday', c.receipts_per_workday, 'receipts_prev', c.receipts_prev_month_per_workday,
    'supplier_due', coalesce(c.supplier_due, '[]'::jsonb),
    'days', coalesce((
        select jsonb_agg(case when own then d else jsonb_build_object('date', d -> 'date', 'close', d -> 'close') end order by d ->> 'date')
          from jsonb_array_elements(coalesce(c.calendar, '[]'::jsonb)) d
         where (d ->> 'date')::date >= current_date - 1), '[]'::jsonb),
    'cheques', coalesce((
        select jsonb_agg(x order by x.due, x.net desc) from (
          select check_due as due, max(sup_name) as sup, round(sum(net)) as net, check_no as no
            from public.priority_supplier_checks
           where check_due between current_date and current_date + 200
           group by check_no, check_due) x), '[]'::jsonb));
  if own then
    r := r || jsonb_build_object(
      'alerts', coalesce(c.alerts, '[]'::jsonb), 'loans', coalesce(c.loans, '[]'::jsonb), 'loans_total', c.loans_total,
      'discounted_cheques_total', c.discounted_cheques_total, 'card_next_bill', c.card_next_bill, 'card_next_bill_date', c.card_next_bill_date);
  end if;
  return r;
end $$;
grant execute on function public.crm_money() to authenticated;
