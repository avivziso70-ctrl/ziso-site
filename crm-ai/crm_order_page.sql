-- New staff order page (crm/order.html, preview next to crm/deal.html; Aviv 17.11). Additive only, no DROP.
-- A payment taken on the order page is a normal crm_takings row (same receipt task for the office), linked to its deal.
alter table public.crm_takings add column if not exists deal_id bigint references public.crm_deals (id);
create index if not exists crm_takings_deal_idx on public.crm_takings (deal_id) where deal_id is not null;
-- the customer panel: the standard details
alter table public.crm_customers add column if not exists email text;
alter table public.crm_customers add column if not exists address text;
alter table public.crm_customers add column if not exists vat_id text;
alter table public.crm_customers add column if not exists contact_name text;
alter table public.crm_deals add column if not exists internal_note text;   -- free-text staff note on the order page, never returned by crm_my
