-- Past-customer outreach list (review + referral), 9.11.2026.
-- Staff send by hand from their phone (wa.me link); nothing is sent from the server.
-- Rows (names/phones) are seeded straight into the database, never committed here.
create table if not exists public.crm_outreach (
  id bigserial primary key,
  campaign text not null,
  name text, phone text not null, tail9 text not null,
  kind text, last_invoice date, note text,
  status text not null default 'todo' check (status in ('todo','sent','skip','optout')),
  status_at timestamptz, status_by text,
  created_at timestamptz not null default now(),
  unique (campaign, tail9)
);
alter table public.crm_outreach enable row level security;
drop policy if exists crm_outreach_read on public.crm_outreach;
create policy crm_outreach_read on public.crm_outreach for select to authenticated using (crm_me() is not null);
drop policy if exists crm_outreach_upd on public.crm_outreach;
create policy crm_outreach_upd on public.crm_outreach for update to authenticated using (crm_me() is not null) with check (crm_me() is not null);

-- optout: the customer ever wrote "הסר" to the business number. replied: wrote after we marked sent.
create or replace function public.crm_outreach_list(p_campaign text)
returns table (id bigint, name text, phone text, tail9 text, kind text, last_invoice date, note text, status text, status_at timestamptz, status_by text, optout boolean, replied boolean)
language sql stable security invoker as $f$
  select o.id, o.name, o.phone, o.tail9, o.kind, o.last_invoice, o.note, o.status, o.status_at, o.status_by,
    exists (select 1 from wa_messages m where m.dir = 'in' and right(regexp_replace(m.phone, '\D', '', 'g'), 9) = o.tail9 and m.text ~ '^\s*(הסר|הסירו|להסיר)'),
    o.status_at is not null and exists (select 1 from wa_messages m where m.dir = 'in' and right(regexp_replace(m.phone, '\D', '', 'g'), 9) = o.tail9 and m.ts > o.status_at)
  from crm_outreach o
  where o.campaign = p_campaign
  order by (o.status = 'todo') desc, o.last_invoice desc, o.id;
$f$;
grant execute on function public.crm_outreach_list(text) to authenticated;
