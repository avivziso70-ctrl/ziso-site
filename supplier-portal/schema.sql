-- Supplier price portal (11.11.2026, Aviv: "פורטל ספקים", suppliers upload from day 1).
-- Suppliers get a personal link (token). Files land in the private bucket supplier-files,
-- the edge function supplier-upload reads them into sp_prices (status 'pending'), and staff
-- approve each upload in /crm/prices.html before its prices become active.
-- Privacy: per supplier we keep only business name, Priority supplier number and an optional
-- contact phone (business contact). Nothing is sent to suppliers automatically.

create table if not exists public.sp_suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  priority_sup text,
  contact_phone text,
  token text not null unique default encode(gen_random_bytes(18), 'hex'),
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  last_upload_at timestamptz
);

create table if not exists public.sp_uploads (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.sp_suppliers(id),
  file_path text,
  file_name text,
  mime text,
  size_bytes int,
  uploader_name text,
  supplier_note text,
  replaces_all boolean not null default false,
  status text not null default 'received', -- received | parsing | parsed | failed | approved | rejected
  rows_count int,
  parse_note text,
  source text not null default 'supplier', -- supplier | staff
  created_at timestamptz not null default now(),
  parsed_at timestamptz,
  decided_by text,
  decided_at timestamptz
);
create index if not exists sp_uploads_sup on public.sp_uploads (supplier_id, created_at desc);

create table if not exists public.sp_prices (
  id bigserial primary key,
  upload_id uuid not null references public.sp_uploads(id) on delete cascade,
  supplier_id uuid not null references public.sp_suppliers(id),
  supplier_code text,
  description text not null,
  size text,
  unit text,
  price numeric,
  currency text default 'ILS',
  vat_included boolean,
  category text,
  page_ref text,
  status text not null default 'pending', -- pending | active | old | rejected
  created_at timestamptz not null default now()
);
create index if not exists sp_prices_active on public.sp_prices (status, supplier_id);
create index if not exists sp_prices_code on public.sp_prices (lower(supplier_code));

alter table public.sp_suppliers enable row level security;
alter table public.sp_uploads enable row level security;
alter table public.sp_prices enable row level security;

drop policy if exists sp_sup_staff on public.sp_suppliers;
create policy sp_sup_staff on public.sp_suppliers for select using (crm_me() is not null);
drop policy if exists sp_upl_staff on public.sp_uploads;
create policy sp_upl_staff on public.sp_uploads for select using (crm_me() is not null);
drop policy if exists sp_pr_staff on public.sp_prices;
create policy sp_pr_staff on public.sp_prices for select using (crm_me() is not null);

-- Staff actions go through these functions only (no direct writes from the browser).
create or replace function public.sp_add_supplier(p_name text, p_priority_sup text default null, p_phone text default null)
returns public.sp_suppliers language plpgsql security definer set search_path = public as $$
declare r public.sp_suppliers;
begin
  if crm_me() is null then raise exception 'staff only'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name required'; end if;
  insert into sp_suppliers (name, priority_sup, contact_phone, created_by)
  values (left(trim(p_name), 120), nullif(trim(p_priority_sup), ''), nullif(left(trim(p_phone), 20), ''), crm_me())
  returning * into r;
  return r;
end $$;

create or replace function public.sp_set_supplier(p_id uuid, p_active boolean, p_new_link boolean default false)
returns public.sp_suppliers language plpgsql security definer set search_path = public as $$
declare r public.sp_suppliers;
begin
  if crm_me() is null then raise exception 'staff only'; end if;
  update sp_suppliers set active = p_active,
    token = case when p_new_link then encode(gen_random_bytes(18), 'hex') else token end
  where id = p_id returning * into r;
  return r;
end $$;

-- Approve: the upload's rows become active. Rows of the same supplier with the same code become 'old';
-- with replaces_all, every earlier active row of that supplier becomes 'old'.
create or replace function public.sp_decide(p_upload uuid, p_approve boolean)
returns int language plpgsql security definer set search_path = public as $$
declare u public.sp_uploads; n int;
begin
  if crm_me() is null then raise exception 'staff only'; end if;
  select * into u from sp_uploads where id = p_upload for update;
  if u.id is null or u.status <> 'parsed' then raise exception 'upload not ready'; end if;
  if not p_approve then
    update sp_prices set status = 'rejected' where upload_id = p_upload;
    update sp_uploads set status = 'rejected', decided_by = crm_me(), decided_at = now() where id = p_upload;
    return 0;
  end if;
  if u.replaces_all then
    update sp_prices set status = 'old' where supplier_id = u.supplier_id and status = 'active';
  else
    update sp_prices o set status = 'old'
    where o.supplier_id = u.supplier_id and o.status = 'active' and o.supplier_code is not null
      and exists (select 1 from sp_prices n where n.upload_id = p_upload and lower(n.supplier_code) = lower(o.supplier_code));
  end if;
  update sp_prices set status = 'active' where upload_id = p_upload;
  get diagnostics n = row_count;
  update sp_uploads set status = 'approved', decided_by = crm_me(), decided_at = now() where id = p_upload;
  return n;
end $$;

revoke all on function public.sp_add_supplier(text, text, text) from public, anon;
revoke all on function public.sp_set_supplier(uuid, boolean, boolean) from public, anon;
revoke all on function public.sp_decide(uuid, boolean) from public, anon;
grant execute on function public.sp_add_supplier(text, text, text) to authenticated;
grant execute on function public.sp_set_supplier(uuid, boolean, boolean) to authenticated;
grant execute on function public.sp_decide(uuid, boolean) to authenticated;

-- Private bucket, 20 MB per file. Staff can read (signed URLs); only the edge function writes.
insert into storage.buckets (id, name, public, file_size_limit)
values ('supplier-files', 'supplier-files', false, 20971520)
on conflict (id) do nothing;
drop policy if exists sp_files_staff_read on storage.objects;
create policy sp_files_staff_read on storage.objects for select
  using (bucket_id = 'supplier-files' and public.crm_me() is not null);
alter table public.sp_uploads add column if not exists supplier_name_typed text; -- 11.11 required supplier name on the upload page

-- A supplier link whose last characters were cut off when it was copied (12.11): the supplier page asks for the full
-- token. Returned only when a 30-35 character prefix matches exactly one active supplier (still 120 bits).
create or replace function public.sp_token_fix(p text)
returns text language sql stable security definer set search_path = public as $$
  select case when count(*) = 1 then min(token) end
  from public.sp_suppliers
  where active and p ~ '^[0-9a-f]{30,35}$' and token like p || '%';
$$;
revoke all on function public.sp_token_fix(text) from public;
grant execute on function public.sp_token_fix(text) to anon, authenticated;
