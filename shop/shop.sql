-- Online store (hidden preview, 15.11.2026). Prices are computed here, server-side only: the browser never sees cost.
-- Rule (Aviv 15.11): public price = our cost x multiplier (Sanitec 2.0) + 18% VAT, rounded up to a whole shekel,
-- never above the supplier's own consumer price incl. VAT.

create table if not exists public.shop_settings (
  id int primary key default 1 check (id = 1),
  live boolean not null default false,             -- false = only signed-in staff can check out, and every payment is a ₪5 test
  vat numeric not null default 18,
  multipliers jsonb not null default '{"162e5a6f-93b2-458c-b0ca-6d40e75d611b": 2}', -- supplier_id -> cost multiplier; a supplier not listed is not sold
  delivery_fee numeric,                             -- null = pickup from the showroom only
  lead_text text not null default 'עד 21 ימי עסקים',
  updated_at timestamptz not null default now()
);
insert into public.shop_settings (id) values (1) on conflict do nothing;
alter table public.shop_settings enable row level security;

create table if not exists public.shop_orders (
  id bigint generated always as identity primary key,
  token uuid not null default gen_random_uuid() unique,   -- the customer's own status link
  created_at timestamptz not null default now(),
  name text not null, phone text not null, email text not null,
  delivery text not null check (delivery in ('pickup', 'delivery')),
  address text, city text, notes text,
  items jsonb not null,                                   -- [{id, code, name, size, qty, price}] at the price charged
  items_total numeric not null, delivery_fee numeric not null default 0, total numeric not null,
  charged numeric not null,                               -- what Tranzila was asked for (₪5 on a test)
  test boolean not null default false,
  terms_at timestamptz not null, marketing_ok boolean not null default false,
  pay_request_id bigint references public.crm_pay_requests(id),
  status text not null default 'new',                     -- new -> paid -> handled / cancelled
  created_by text
);
alter table public.shop_orders enable row level security;
create policy shop_orders_staff_read on public.shop_orders for select to authenticated
  using (exists (select 1 from crm_staff s where s.active and lower(s.email) = lower(auth.jwt() ->> 'email')));

-- One row per product: newest list wins; upgrade options, measuring, installation, delivery, drilling and made-to-measure rows are not sold.
create or replace function public.shop_catalog(p_ids bigint[] default null)
returns table (id bigint, code text, name text, size text, unit text, category text, price numeric, image_path text)
language sql stable security invoker set search_path = public as $$
  with st as (select vat, multipliers from shop_settings where id = 1),
  src as (
    select p.*, u.created_at up_at, (st.multipliers ->> p.supplier_id::text)::numeric mult, st.vat
      from sp_prices p join sp_uploads u on u.id = p.upload_id, st
     where p.status = 'active' and p.price > 0 and st.multipliers ? p.supplier_id::text
       and p.description !~* '(שדרוג|מדידה|התקנ|הובלה|משלוח|קידוח|מחיר לכל המידות|תוספת|סבלות|^דגם [0-9]+$)'
       and coalesce(p.category, '') !~* '(מידות מיוחדות|נילווים|נלווים|תקנון|איזור מרוחק)'),  -- made-to-measure showers need a measuring visit: not sold online
  one as (
    select distinct on (coalesce(supplier_code, description || '|' || coalesce(size, ''))) *
      from src order by coalesce(supplier_code, description || '|' || coalesce(size, '')), up_at desc, image_path nulls last, id)
  select one.id, one.supplier_code, one.description, one.size, one.unit, one.category,
         least(ceil(one.price * one.mult * case when one.vat_included then 1 else 1 + one.vat / 100 end),
               coalesce(ceil(one.list_price * case when one.vat_included then 1 else 1 + one.vat / 100 end), 'infinity'::numeric)),
         one.image_path
    from one where p_ids is null or one.id = any(p_ids);
$$;
-- security invoker: only the service role (the shop edge function) gets rows; anon is stopped by RLS on shop_settings / sp_prices.
-- No drop / revoke statements here: they raise a Supabase confirmation nobody sees and the migration hangs.

-- When Tranzila confirms the payment (crm-pay-notify sets crm_pay_requests.status = 'paid'), the order turns paid.
create or replace function public.shop_order_paid() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    update shop_orders set status = 'paid' where pay_request_id = new.id and status = 'new';
  end if;
  return new;
end $$;
create or replace trigger shop_order_paid after update of status on public.crm_pay_requests for each row execute function public.shop_order_paid();
