-- crm_receipts: goods receipt from the CRM (Aviv 15.11.2026: staff photograph the supplier's invoice / delivery note when the
-- goods arrive; the system checks what arrived against what was ordered, at the agreed price, and measures order -> arrival time).
-- Flow: receive.html uploads the original photo (kept untouched) + a smaller copy for reading to the private bucket
-- goods-receipts -> crm-receive "read": Claude reads the document, the server matches it to the supplier and to an open
-- crm_po order and compares lines (quantity, price). No order in the system -> prices are compared to the supplier price list.
-- Status: ok (green) / gap (orange: missing, extra, price above agreed) / check (could not read or match) / failed.
-- A gap or check opens a crm_task and a push. Priority is never written.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('goods-receipts', 'goods-receipts', false, 26214400, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do nothing;
-- staff may add and read; no update / delete policy, so an original stays as it was photographed
create policy goods_receipts_ins on storage.objects for insert with check (bucket_id = 'goods-receipts' and crm_me() is not null);
create policy goods_receipts_read on storage.objects for select using (bucket_id = 'goods-receipts' and crm_me() is not null);

create table if not exists public.crm_receipts (
  id bigserial primary key,
  rc_no text generated always as ('R' || lpad(id::text, 4, '0')) stored,
  status text not null default 'reading' check (status in ('reading', 'ok', 'gap', 'check', 'failed')),
  files jsonb not null,                 -- [{orig, read, mime, size}] paths in bucket goods-receipts
  supplier_id uuid references public.sp_suppliers(id),
  supplier_name text,                   -- as matched, or as printed when the supplier is not in the system
  po_id bigint references public.crm_po(id),
  po_by text,                           -- auto / staff: who linked the order
  doc jsonb,                            -- what was read from the document
  doc_type text,                        -- tax_invoice / delivery_note / invoice_receipt / other / unreadable
  doc_no text,
  doc_date date,
  doc_total numeric,                    -- before VAT
  result jsonb,                         -- {lines: [...], flags: [...]}
  summary text,                         -- one Hebrew line
  gaps int not null default 0,
  dup_of bigint,                        -- the same supplier document was already photographed
  note text,
  "by" text not null,
  by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  task_id bigint,
  error text
);
create index if not exists crm_receipts_created_idx on public.crm_receipts (created_at desc);
create index if not exists crm_receipts_po_idx on public.crm_receipts (po_id);
create index if not exists crm_receipts_doc_idx on public.crm_receipts (supplier_id, doc_no);
alter table public.crm_receipts enable row level security;
create policy crm_receipts_read on public.crm_receipts for select using (crm_me() is not null);

alter table public.crm_po add column if not exists received_at timestamptz;   -- first document photographed for this order
alter table public.crm_po add column if not exists receive_state text;        -- full / partial / gap
alter table public.crm_po add column if not exists receive_summary text;

-- real lead time per supplier: from the moment the order went out to the moment the goods were photographed
create or replace view public.crm_po_lead_times with (security_invoker = true) as
select supplier_id, max(supplier_name) as supplier_name, count(*) as orders,
  round(avg(extract(epoch from received_at - sent_at) / 86400)::numeric, 1) as avg_days,
  round((percentile_cont(0.5) within group (order by extract(epoch from received_at - sent_at) / 86400))::numeric, 1) as median_days,
  round(min(extract(epoch from received_at - sent_at) / 86400)::numeric, 1) as min_days,
  round(max(extract(epoch from received_at - sent_at) / 86400)::numeric, 1) as max_days,
  max(received_at) as last_received
from public.crm_po where received_at is not null and sent_at is not null and received_at > sent_at
group by supplier_id;

-- a receipt was read: push to all phones; a gap / unclear document also opens a task for the office
create or replace function public.crm_receipt_notify() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_token text; v_task bigint; head text;
begin
  if new.status not in ('ok', 'gap', 'check') or old.status = new.status then return new; end if;
  head := coalesce(new.supplier_name, 'ספק לא מזוהה') || ' · קבלת סחורה ' || new.rc_no;
  if new.status in ('gap', 'check') and new.task_id is null then
    insert into crm_tasks (tail9, text, due, "by") values (null,
      'קבלת סחורה ' || new.rc_no || ' מ' || coalesce(new.supplier_name, 'ספק לא מזוהה') || ': ' || coalesce(new.summary, 'לבדוק') || '. הפרטים ב-CRM > קבלת סחורה.',
      now(), 'קבלת סחורה') returning id into v_task;
    update crm_receipts set task_id = v_task where id = new.id;
  end if;
  begin
    select hook_token into v_token from crm_push_keys where id = 1;
    perform net.http_post(
      url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-push',
      headers := jsonb_build_object('content-type', 'application/json', 'x-hook-token', v_token),
      body := jsonb_build_object('action', 'notify', 'phone', '0000000000', 'type', 'pay',
        'name', case when new.status = 'ok' then '✓ הגיעה סחורה · ' else '⚠ לבדוק · ' end || head,
        'text', coalesce(new.summary, 'צולם מסמך ספק.')));
  exception when others then null; -- an alert problem never blocks the receipt record
  end;
  return new;
end $$;
create trigger crm_receipt_notify_trg after update of status on public.crm_receipts for each row execute function public.crm_receipt_notify();
