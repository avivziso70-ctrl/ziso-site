-- CRM automations, 10.11.2026. Closes two data gaps found by the control board check (public.leads):
--   1. "טופל" set handled_at but left the lead in 'new', so it kept counting as waiting.
--   2. 'won' was never written, so nobody could see which leads turned into money.
-- Nothing here messages a customer or writes to Priority. Safe to run twice.

-- 1. A chat marked "טופל" moves that customer's 'new' leads to 'answered'.
create or replace function public.crm_handled_to_answered() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.handled_at is not null and new.handled_at is distinct from old.handled_at then
    perform public.set_lead_stage(l.id, 'answered') from public.leads l where l.phone_tail9 = new.tail9 and l.stage = 'new';
  end if;
  return new;
end $$;
drop trigger if exists crm_handled_to_answered on public.crm_customers;
create trigger crm_handled_to_answered after update of handled_at on public.crm_customers
  for each row execute function public.crm_handled_to_answered();

-- one-time catch-up for chats already marked handled
select public.set_lead_stage(l.id, 'answered') from public.leads l
  join public.crm_customers c on c.tail9 = l.phone_tail9 and c.handled_at is not null
  where l.stage = 'new';

-- 2. A lead is won when Priority has a real order (not a draft, not cancelled) for the same phone, dated on or after the lead.
--    Same rule the control board uses. Only the newest open lead per phone, leads of the last 90 days, test leads skipped.
--    The previous stage is kept in crm_audit (action 'auto_won') so a wrong mark can be put back.
create or replace function public.crm_auto_won() returns integer
language plpgsql security definer set search_path to 'public' as $$
declare r record; n integer := 0;
begin
  for r in
    with open_lead as (
      select distinct on (l.phone_tail9) l.id, l.phone_tail9, l.stage, l.created_at
      from public.leads l
      where l.stage not in ('won', 'lost') and l.phone_tail9 is not null and l.created_at > now() - interval '90 days'
        and coalesce(l.name, '') !~* '^\s*(בדיקה|test)' and l.id not in (5, 6, 7, 252, 253)
      order by l.phone_tail9, l.created_at desc)
    select ol.id, ol.phone_tail9, ol.stage, min(pc.cust_no) cust_no, sum(o.amount) amt, min(o.so) first_so
    from open_lead ol
    join public.priority_customers pc on pc.tail9 = ol.phone_tail9
    join public.priority_orders_all o on o.cust_no = pc.cust_no
      and o.date >= (ol.created_at at time zone 'Asia/Jerusalem')::date
      and coalesce(o.status, '') <> 'טיוטא' and coalesce(o.status, '') not like 'מבוטל%'
    group by ol.id, ol.phone_tail9, ol.stage
  loop
    perform public.set_lead_stage(r.id, 'won', r.cust_no, r.amt, null);
    insert into public.crm_audit (who, action, tail9, detail)
      values ('agent:crm-auto-won', 'auto_won', r.phone_tail9, jsonb_build_object('lead', r.id, 'prev_stage', r.stage, 'amount', r.amt, 'so', r.first_so));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.crm_auto_won() from public, anon, authenticated;

-- hourly in working hours (UTC), Sunday to Friday; the first run marks the backlog
select cron.unschedule('crm-auto-won') where exists (select 1 from cron.job where jobname = 'crm-auto-won');
select cron.schedule('crm-auto-won', '20 5-16 * * 0-5', $$select public.crm_auto_won()$$);
select public.crm_auto_won();
