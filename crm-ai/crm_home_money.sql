-- Home screen (12.11.2026): bank position + supplier cheques, readable ONLY by staff marked sees_bank (Moshe) and the owner.
-- The underlying tables stay owner-only; this function returns a small summary, no customer names.
alter table public.crm_staff add column if not exists sees_bank boolean not null default false;

create or replace function public.crm_home_money()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare ok boolean; c record; r jsonb;
begin
  select coalesce(bool_or(role = 'owner' or sees_bank), false) into ok from public.crm_staff
   where active and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));
  if not ok then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from public.cash_snapshot order by as_of desc limit 1;
  select jsonb_build_object(
    'as_of', c.as_of, 'updated_at', c.updated_at, 'balance', c.balance, 'credit_limit', c.credit_limit,
    'forecast_low', c.forecast_low, 'forecast_low_date', c.forecast_low_date,
    'receipts_mtd', c.receipts_mtd, 'receipts_per_workday', c.receipts_per_workday,
    'cheques', coalesce((select jsonb_agg(x order by x.due, x.net desc) from (
        select check_due as due, max(sup_name) as sup, round(sum(net)) as net
          from public.priority_supplier_checks
         where check_due between current_date and current_date + 13
         group by check_no, check_due) x), '[]'::jsonb)
  ) into r;
  return r;
end $$;
revoke execute on function public.crm_home_money() from public, anon;
grant execute on function public.crm_home_money() to authenticated;
