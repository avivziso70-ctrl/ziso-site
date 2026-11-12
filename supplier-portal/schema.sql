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
  -- a failed upload can only be dismissed; a file still under the WhatsApp placeholder cannot be approved
  if u.id is null or not (u.status = 'parsed' or (u.status = 'failed' and not p_approve)) then raise exception 'upload not ready'; end if;
  if not p_approve then
    update sp_prices set status = 'rejected' where upload_id = p_upload;
    update sp_uploads set status = 'rejected', decided_by = crm_me(), decided_at = now() where id = p_upload;
    return 0;
  end if;
  if exists (select 1 from sp_suppliers where id = u.supplier_id and kind = 'wa_inbox') then raise exception 'קודם לשייך את הקובץ לספק'; end if;
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

-- ---------------------------------------------------------------------------------------------------------------
-- 12.11.2026: heavy PDFs. supplier-upload hands every PDF to the edge function supplier-parse, which cuts it into
-- page parts, reads them as a Message Batch and reports page by page. State lives on the upload row.
alter table public.sp_uploads
  add column if not exists job jsonb,            -- reader state: phase new/send/wait/done, batch ids, page ranges sent and still to send
  add column if not exists job_lease timestamptz, -- a worker holds the row until this time
  add column if not exists parse_info text,       -- neutral reading summary for staff; parse_note is for problems
  add column if not exists task_id bigint;        -- the CRM task opened for this upload (sp_upload_alert)

select cron.schedule('supplier-parse', '* * * * *', $cron$
  select net.http_post(url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/supplier-parse',
    headers := '{"content-type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 5000)
  where exists (select 1 from public.sp_uploads where status = 'parsing' and job is not null)
$cron$);

-- WhatsApp channel (12.11.2026, Aviv: "תתקדם לפרוייקט וואטסאפ"): price lists that suppliers send to the business
-- WhatsApp number go into the same approval queue as portal uploads. Edge function supplier-wa, cron every 2 minutes.
alter table public.sp_suppliers add column if not exists kind text;           -- 'wa_inbox' = placeholder for files from a number we do not know yet
alter table public.sp_uploads add column if not exists wa_phone text;         -- sender, for uploads that came through WhatsApp

create or replace function public.sp_phone_key(p text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '^972', ''), '^0', '')
$$;

create table if not exists public.sp_supplier_phones (
  phone_key text primary key,                 -- national number, no leading 0 or 972 (sp_phone_key)
  supplier_id uuid not null references public.sp_suppliers(id) on delete cascade,
  source text not null default 'priority',    -- priority = supplier card, staff = assigned from a WhatsApp upload
  created_at timestamptz not null default now()
);
create table if not exists public.sp_wa_log (  -- one row per WhatsApp message the intake looked at, so nothing is taken twice
  msg_id text primary key,
  result text not null,                        -- skip | working | ok | failed
  upload_id uuid,
  note text,
  at timestamptz not null default now()
);
alter table public.sp_supplier_phones enable row level security;
alter table public.sp_wa_log enable row level security;
create policy sp_ph_staff on public.sp_supplier_phones for select using (crm_me() is not null);
create policy sp_wal_staff on public.sp_wa_log for select using (crm_me() is not null);

insert into public.sp_suppliers (name, kind, created_by)
select 'וואטסאפ: ספק לא מזוהה', 'wa_inbox', 'system'
where not exists (select 1 from public.sp_suppliers where kind = 'wa_inbox');

-- business phones from the Priority supplier cards; a number that belongs to two suppliers is left out.
-- The numbers themselves were loaded once by hand and are not kept in this (public) repository.
insert into public.sp_supplier_phones (phone_key, supplier_id, source)
select v.k, s.id, 'priority'
from (values ('<phone key>', '<priority sup>')) as v(k, sup)
join public.sp_suppliers s on s.priority_sup = v.sup
on conflict (phone_key) do nothing;

-- staff: this upload belongs to that supplier. Moves the rows and remembers the sender's number for next time.
create or replace function public.sp_assign_upload(p_upload uuid, p_supplier uuid)
returns void language plpgsql security definer set search_path = public as $$
declare u public.sp_uploads; s public.sp_suppliers;
begin
  if crm_me() is null then raise exception 'staff only'; end if;
  select * into u from sp_uploads where id = p_upload for update;
  if u.id is null or u.status in ('approved', 'rejected') then raise exception 'upload not open'; end if;
  select * into s from sp_suppliers where id = p_supplier;
  if s.id is null or s.kind = 'wa_inbox' then raise exception 'pick a supplier'; end if;
  update sp_prices set supplier_id = p_supplier where upload_id = p_upload;
  update sp_uploads set supplier_id = p_supplier where id = p_upload;
  update sp_suppliers set last_upload_at = greatest(coalesce(last_upload_at, u.created_at), u.created_at) where id = p_supplier;
  if sp_phone_key(u.wa_phone) ~ '^\d{8,12}$' then
    insert into sp_supplier_phones (phone_key, supplier_id, source) values (sp_phone_key(u.wa_phone), p_supplier, 'staff')
    on conflict (phone_key) do update set supplier_id = excluded.supplier_id, source = 'staff';
  end if;
end $$;
revoke all on function public.sp_assign_upload(uuid, uuid) from public, anon;
grant execute on function public.sp_assign_upload(uuid, uuid) to authenticated;

-- CRM alert (Aviv 12.11: "כספק מעלה פרטים חדשים לפורטל ספקים, שתקפוץ התראה במערכת ה crm במשרד ראשי"):
-- every upload that is not from staff opens a task that pops on the CRM screens, and closes when staff decide.
create or replace function public.sp_upload_alert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text; v_kind text; v_task bigint; v_file text; v_text text;
begin
  if tg_op = 'INSERT' then
    if new.source = 'staff' then return new; end if;
    select s.name, s.kind into v_name, v_kind from sp_suppliers s where s.id = new.supplier_id;
    v_file := coalesce(new.file_name, case when new.file_path is null then 'הודעה בטקסט' else 'קובץ' end);
    if new.status = 'failed' then
      v_text := 'קובץ מספק בוואטסאפ לא נקלט' || case when v_kind = 'wa_inbox' then '' else ' (' || coalesce(v_name, 'ספק') || ')' end || ' · ' || v_file || '. ' || coalesce(new.parse_note, '');
    elsif v_kind = 'wa_inbox' then
      v_text := 'מחירון בוואטסאפ ממספר לא מזוהה' || coalesce(' (' || new.wa_phone || ')', '') || ' · ' || v_file || '. לשייך לספק ולאשר ב"מחירון ספקים", לשונית "לאישור".';
    else
      v_text := 'עדכון חדש מספק' || case when new.source = 'whatsapp' then ' בוואטסאפ' else '' end || ': ' || coalesce(v_name, 'ספק') || ' · ' || v_file || '. לבדוק ולאשר ב"מחירון ספקים", לשונית "לאישור".';
    end if;
    insert into crm_tasks (text, due, "by") values (v_text, now(), 'פורטל ספקים') returning id into v_task;
    new.task_id := v_task;
    return new;
  end if;
  if new.status in ('approved', 'rejected') and new.status is distinct from old.status and new.task_id is not null then
    update crm_tasks set done_at = now(), done_by = coalesce(new.decided_by, 'מחירון ספקים') where id = new.task_id and done_at is null;
  end if;
  return new;
end $$;

create or replace trigger sp_upload_alert_ins before insert on public.sp_uploads for each row execute function public.sp_upload_alert();
create or replace trigger sp_upload_alert_upd after update of status on public.sp_uploads for each row execute function public.sp_upload_alert();

select cron.schedule('supplier-wa', '*/2 * * * *', $cron$
  select net.http_post(url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/supplier-wa',
    headers := '{"content-type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 5000)
  where exists (select 1 from public.wa_messages m where m.dir = 'in' and m.source = 'live' and m.type in ('document', 'image')
    and m.ts > now() - interval '48 hours' and not exists (select 1 from public.sp_wa_log l where l.msg_id = m.id))
$cron$);
