-- 15.11.2026 (Aviv): deal file in the showroom. Customer -> product list from all supplier price lists with our cost and a live
-- profit line -> purchase orders per supplier (crm-po), linked to the deal. Purchasing lives here; customer orders, receipts and
-- invoices keep going through Priority. Applied as migration crm_deals.
create sequence if not exists public.crm_deal_no;
create table if not exists public.crm_deals (
  id bigserial primary key,
  deal_no text not null unique default 'D' || lpad(nextval('public.crm_deal_no')::text, 4, '0'),
  customer_name text, customer_tail9 text, customer_phone text,
  deliver_to text not null default 'business',  -- business | customer
  deliver jsonb not null default '{}',
  lines jsonb not null default '[]',             -- [{ price_id, supplier_id, sku, desc, size, unit, qty, cost (before VAT), sell (per unit, with VAT), stock, po_id, po_no }]
  markup numeric not null default 40,
  status text not null default 'open',           -- open | ordered | closed
  total_cost numeric, total_sell numeric,
  "by" text, by_name text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists crm_deals_open_idx on public.crm_deals (status, updated_at desc);
alter table public.crm_deals enable row level security;
create policy crm_deals_read on public.crm_deals for select using (crm_me() is not null);
create policy crm_deals_add on public.crm_deals for insert with check (crm_me() is not null);
create policy crm_deals_edit on public.crm_deals for update using (crm_me() is not null) with check (crm_me() is not null);
revoke all on public.crm_deals from anon;
grant select, insert, update on public.crm_deals to authenticated;
grant usage on sequence public.crm_deals_id_seq, public.crm_deal_no to authenticated;
alter table public.crm_po add column if not exists deal_id bigint;
create index if not exists crm_po_deal_idx on public.crm_po (deal_id) where deal_id is not null;
