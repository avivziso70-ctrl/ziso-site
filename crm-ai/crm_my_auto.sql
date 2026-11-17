-- Every new customer gets their own page automatically (Aviv 17.11.2026: "כל לקוח חדש שנפתח במערכת מקבל לינק לכרטיס לקוח שלו ...
-- אוטומטי לחלוטין ללא יד מגע אדם").
-- A Priority customer number seen for the first time (in priority_customers or priority_orders; both are re-pushed in bulk, so
-- "new" = not in crm_my_seen) gets a
-- deal with priority_sync, its secret link, and a row in crm_my_invites. Cards that existed when this went live are only marked seen.
-- Sending the link is a separate step: it needs an approved WhatsApp template and Aviv's yes on its wording, so invites wait in
-- status 'waiting_template' and nothing is sent from here. The customer can close their page from the page itself (crm_my_close).
-- Skipped: no mobile number, a phone shared by more than 3 cards, walk-in / general cards. No DROP in this file.

create table if not exists public.crm_my_seen (
  cust_no text primary key,
  first_seen timestamptz not null default now(),
  deal_id bigint
);
alter table public.crm_my_seen enable row level security;

create table if not exists public.crm_my_invites (
  id bigint generated always as identity primary key,
  deal_id bigint not null references public.crm_deals (id),
  tail9 text not null,
  channel text not null default 'whatsapp',
  status text not null default 'waiting_template' check (status in ('waiting_template', 'queued', 'sent', 'failed', 'skipped', 'cancelled')),
  note text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  wa_msg_id text
);
create unique index if not exists crm_my_invites_deal_idx on public.crm_my_invites (deal_id);
alter table public.crm_my_invites enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'crm_my_invites' and policyname = 'staff read') then
    create policy "staff read" on public.crm_my_invites for select using (public.crm_me() is not null);
  end if;
end $$;

-- the cards that exist today are not "new"
insert into public.crm_my_seen (cust_no, first_seen)
select cust_no, '2026-11-17'::timestamptz from public.priority_customers
union select cust_no, '2026-11-17'::timestamptz from public.priority_orders where cust_no is not null
union select cust_no, '2026-11-17'::timestamptz from public.priority_orders_all where cust_no is not null
on conflict do nothing;
update public.crm_my_seen s set deal_id = d.id from public.crm_deals d where d.cust_no = s.cust_no and s.deal_id is null;

create or replace function public.crm_my_auto_open() returns int
language plpgsql security definer set search_path to 'public' as $$
declare c record; v_deal bigint; n int := 0;
begin
  for c in
    -- a new card shows up in the half-hourly orders push before the daily customers push, so both count
    select distinct on (x.cust_no) x.cust_no, x.name, x.tail9, x.phone from (
      select pc.cust_no, pc.name, pc.tail9, pc.phone, 1 as pr from priority_customers pc
      union all
      select o.cust_no, o.cust_name, o.tail9, null, 2 from priority_orders o where o.cust_no is not null
    ) x
    where not exists (select 1 from crm_my_seen s where s.cust_no = x.cust_no)
    order by x.cust_no, x.pr limit 50
  loop
    insert into crm_my_seen (cust_no) values (c.cust_no) on conflict do nothing;
    if c.tail9 is null or c.tail9 !~ '^5[0-9]{8}$'
       or coalesce(c.name, '') ~ '(מזדמן|כללי|לקוח קופה|בדיקה)'
       or (select count(*) from priority_customers q where q.tail9 = c.tail9) > 3
       or exists (select 1 from crm_deals d where d.cust_no = c.cust_no) then
      continue;
    end if;
    insert into crm_deals (customer_name, customer_tail9, customer_phone, deliver_to, deliver, lines, markup, status, total_sell,
                           "by", by_name, cust_no, priority_sync, share_token, shared_at, shared_by)
    values (c.name, c.tail9, c.phone, 'business', '{}'::jsonb, '[]'::jsonb, 0, 'open', 0,
            'auto', 'אוטומטי', c.cust_no, true, translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_'), now(), 'auto: new customer')
    returning id into v_deal;
    update crm_my_seen set deal_id = v_deal where cust_no = c.cust_no;
    perform crm_deal_pull_priority(v_deal);
    insert into crm_my_invites (deal_id, tail9) values (v_deal, c.tail9) on conflict do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.crm_my_auto_open() from public, anon, authenticated;
select cron.schedule('crm-my-auto-open', '*/10 * * * *', 'select public.crm_my_auto_open()');

-- The customer closes their own page (the "הסרה" in the invite and a button on the page).
create or replace function public.crm_my_close(p_token text, p_pin text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare g record; d crm_deals;
begin
  select * into g from crm_my_gate(p_token, p_pin);
  if g.err is not null then return jsonb_build_object('ok', false, 'error', g.err); end if;
  select * into d from crm_deals where id = g.deal_id;
  update crm_deals set share_token = null, updated_at = now() where id = d.id;
  update crm_my_invites set status = 'cancelled', note = 'הלקוח סגר את הדף' where deal_id = d.id and status in ('waiting_template', 'queued');
  insert into crm_tasks (tail9, text, due, "by") values (d.customer_tail9,
    'הלקוח סגר את הדף האישי שלו · ' || coalesce(d.customer_name, '') || ' · ' || d.deal_no || '. לא לשלוח לו קישור חדש בלי בקשה שלו.', now(), 'דף לקוח');
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.crm_my_close(text, text) to anon, authenticated;
