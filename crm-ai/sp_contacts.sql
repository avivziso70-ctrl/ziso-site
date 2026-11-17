-- Supplier card in the CRM (Aviv 17.11.2026 "תכניס הכל לcrm"): who to talk to at each supplier, what we buy there, delivery
-- habits, and the terms Moshe mentioned on WhatsApp. Source: thread "ללמוד את העסק מהוואטסאפ של משה" (business chats 19.8–17.11.2026).
-- Terms from that source are UNVERIFIED notes: they never feed sp_suppliers.discount_pct or any cost / profit calculation until checked
-- against a supplier invoice. No debts or balances from that source. Phone numbers live only in the database, never in this repo.
-- Staff read only; writes by the service role. No DROP.

create table if not exists public.sp_contacts (
  id bigint generated always as identity primary key,
  supplier_id uuid references public.sp_suppliers(id),
  label text not null,                 -- supplier or service field as Moshe knows it
  kind text not null default 'supplier' check (kind in ('supplier', 'service')),
  name text,
  role text,
  phone text,
  phone_key text,                      -- digits without 972 / leading 0, same key as sp_supplier_phones
  how_to_order text,
  active boolean not null default true,
  source text not null default 'moshe-wa-2026-11-17',
  created_at timestamptz not null default now()
);
create index if not exists sp_contacts_supplier_idx on public.sp_contacts (supplier_id);
alter table public.sp_contacts enable row level security;
create policy sp_contacts_staff on public.sp_contacts for select using (public.crm_me() is not null);

alter table public.sp_suppliers add column if not exists products text;
alter table public.sp_suppliers add column if not exists delivery_note text;
alter table public.sp_suppliers add column if not exists terms_note text;      -- unverified, never used in cost calculations
alter table public.sp_suppliers add column if not exists work_note text;
alter table public.sp_suppliers add column if not exists prices_note text;     -- prices said in chats, unverified, not a price list
alter table public.sp_suppliers add column if not exists info_source text;
