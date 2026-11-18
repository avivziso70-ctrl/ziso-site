-- Online store (hidden preview, 15.11.2026). Prices are computed here, server-side only: the browser never sees cost.
-- Rule (Aviv 15.11): public price = our cost x multiplier (Sanitec 2.0) + 18% VAT, rounded up to a whole shekel,
-- never above the supplier's own consumer price incl. VAT.

create table if not exists public.shop_settings (
  id int primary key default 1 check (id = 1),
  live boolean not null default false,             -- false = only signed-in staff can check out, and every payment is a ₪5 test
  vat numeric not null default 18,
  multipliers jsonb not null default '{"162e5a6f-93b2-458c-b0ca-6d40e75d611b": 2}', -- supplier_id -> cost multiplier; a supplier not listed is not sold
  delivery_fee numeric,                             -- null = pickup from the showroom only
  lead_text text not null default 'עד 14 ימי עסקים',
  include_re text, exclude_re text,                 -- which product names are sold online
  ship jsonb,                                       -- courier fees incl. VAT: {"small":35,"sink":65,"extra_sink":30}; null = pickup only
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
-- order confirmation mail to the customer (shop/function/mail.ts): queued when paid, sent by the Gmail bridge
alter table public.shop_orders add column if not exists mail_state text, add column if not exists mail_claimed_at timestamptz,
  add column if not exists mail_sent_at timestamptz, add column if not exists mail_msg_id text, add column if not exists mail_error text;
-- supplier purchase orders for a paid web order (Aviv 18.11: sent automatically where the supplier has an order contact, and followed
-- until confirmed). Created by the CRM's own purchase-order mechanism (crm-po), which claims paid, non-test orders with po_state null:
-- creating -> done (crm_po rows carry shop_order_id) / manual (a supplier without an order contact: staff task).
alter table public.shop_orders add column if not exists po_state text, add column if not exists po_note text, add column if not exists po_at timestamptz;
alter table public.shop_orders enable row level security;
create policy shop_orders_staff_read on public.shop_orders for select to authenticated
  using (exists (select 1 from crm_staff s where s.active and lower(s.email) = lower(auth.jwt() ->> 'email')));

-- Picture override per SKU (finish). Filled by matching each catalogue picture to its finish by colour.
create table if not exists public.shop_item_images (code text primary key, path text not null, note text, updated_at timestamptz not null default now());
alter table public.shop_item_images enable row level security;

-- Per-product management from the admin page (crm/shop.html): hide a product, or set its price by hand (incl. VAT).
-- key = supplier_id:code (or supplier_id:description|size when the supplier gives no code), stable across price-list uploads.
create table if not exists public.shop_item_overrides (key text primary key, hidden boolean not null default false, price numeric check (price is null or price > 0),
  updated_at timestamptz not null default now(), updated_by text);
alter table public.shop_item_overrides enable row level security;
alter table public.shop_orders add column if not exists tracking text, add column if not exists courier text, add column if not exists staff_note text,
  add column if not exists sent_at timestamptz, add column if not exists done_at timestamptz;   -- status: new -> paid -> sent -> done / cancelled

-- One row per product: newest list wins. Sold online (Aviv 18.11.2026): only what people reasonably order on the web
-- (taps, sinks, shower fittings, bathroom accessories), from every supplier listed in multipliers, and only with a picture.
-- include_re / exclude_re live in shop_settings so the range changes without a deploy.
-- shop_catalog_full = everything the admin sees (cost incl. VAT, the computed price, overrides); shop_catalog = what is sold.
create or replace function public.shop_catalog_full()
returns table (id bigint, code text, name text, size text, unit text, category text, price numeric, image_path text,
               key text, supplier_id uuid, cost numeric, calc numeric, ov_price numeric, hidden boolean)
language sql stable security invoker set search_path = public as $$
  with st as (select vat, multipliers, include_re, exclude_re from shop_settings where id = 1),
  src as (
    select p.*, u.created_at up_at, (st.multipliers ->> p.supplier_id::text)::numeric mult, st.vat
      from sp_prices p join sp_uploads u on u.id = p.upload_id, st
     where p.status = 'active' and p.price > 0 and st.multipliers ? p.supplier_id::text
       and p.description !~* '(שדרוג|מדידה|התקנ|הובלה|משלוח|קידוח|מחיר לכל המידות|תוספת|סבלות|^דגם [0-9]+$)'
       and coalesce(p.category, '') !~* '(מידות מיוחדות|נילווים|נלווים|תקנון|איזור מרוחק)'
       and (st.include_re is null or p.description ~* st.include_re)
       and (st.exclude_re is null or p.description !~* st.exclude_re)),
  one as (
    select distinct on (supplier_id, coalesce(supplier_code, description || '|' || coalesce(size, ''))) *
      from src order by supplier_id, coalesce(supplier_code, description || '|' || coalesce(size, '')), up_at desc, image_path nulls last, id),
  calc as (
    select one.*, one.supplier_id::text || ':' || coalesce(one.supplier_code, one.description || '|' || coalesce(one.size, '')) k,
           case when one.vat_included then 1 else 1 + one.vat / 100 end vf from one)
  select c.id, c.supplier_code, c.description, c.size, c.unit, c.category,
         coalesce(o.price, least(ceil(c.price * c.mult * c.vf), coalesce(ceil(c.list_price * c.vf), 'infinity'::numeric))),
         coalesce(ov.path, c.image_path),   -- shop_item_images: the picture of this exact finish
         c.k, c.supplier_id, round(c.price * c.vf, 2),
         least(ceil(c.price * c.mult * c.vf), coalesce(ceil(c.list_price * c.vf), 'infinity'::numeric)), o.price, coalesce(o.hidden, false)
    from calc c left join shop_item_images ov on ov.code = c.supplier_code left join shop_item_overrides o on o.key = c.k
   where coalesce(ov.path, c.image_path) is not null;
$$;
create or replace function public.shop_catalog(p_ids bigint[] default null)
returns table (id bigint, code text, name text, size text, unit text, category text, price numeric, image_path text)
language sql stable security invoker set search_path = public as $$
  select f.id, f.code, f.name, f.size, f.unit, f.category, f.price, f.image_path from shop_catalog_full() f
   where not f.hidden and (p_ids is null or f.id = any(p_ids));
$$;
create or replace function public.shop_supplier_counts() returns table (supplier_id uuid, n bigint)
language sql stable security invoker set search_path = public as $$
  select f.supplier_id, count(*) from shop_catalog_full() f where not f.hidden group by 1;
$$;
-- security invoker: only the service role (the shop edge function) gets rows; anon is stopped by RLS on shop_settings / sp_prices.
-- No drop / revoke statements here: they raise a Supabase confirmation nobody sees and the migration hangs.

-- When Tranzila confirms the payment (crm-pay-notify sets crm_pay_requests.status = 'paid'), the order turns paid.
create or replace function public.shop_order_paid() returns trigger language plpgsql security definer set search_path = public as $$
declare o shop_orders;
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    update shop_orders set status = 'paid', mail_state = 'queued' where pay_request_id = new.id and status = 'new' returning * into o;
    -- the till gets the money only now, once per order: an abandoned checkout never creates a taking (asked by the CRM thread)
    if found and not o.test then
      insert into crm_takings ("by", amount, method, payer_name, tail9, reason, goods_taken, goods, pay_pr_id, payments, paid_at)
      values ('חנות אונליין', o.total, 'card_link', o.name, right(o.phone, 9),
        'הזמנה ' || o.id || ' מהחנות' || case when o.delivery = 'delivery' then ' · משלוח ל' || coalesce(o.city, '') else ' · איסוף עצמי' end, false,
        left((select string_agg((i ->> 'qty') || '× ' || coalesce(i ->> 'code', '') || ' ' || (i ->> 'name'), '; ') from jsonb_array_elements(o.items) i), 900),
        new.pr_id, 1, coalesce(new.paid_at, now()));
      -- the supplier orders (crm-po, crm-ai/crm_po_shop.sql): sent on the supplier's order channel and followed until confirmed.
      -- A failure here never blocks the payment; the bridge's 5-minute run picks up an order whose call got lost.
      begin perform crm_po_shop(o.id); exception when others then null; end;
    end if;
  end if;
  return new;
end $$;
create or replace trigger shop_order_paid after update of status on public.crm_pay_requests for each row execute function public.shop_order_paid();
