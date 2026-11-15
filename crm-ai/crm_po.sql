-- crm_po: supplier orders sent by email from the CRM (first supplier: Dior, to Irena).
-- Flow: staff pick SKUs + quantities from the supplier price list (prices.html) -> crm-po "create" (prices re-read
-- from sp_prices, total computed on the server) -> status queued. The Apps Script "Ziso Priority Bridge"
-- (SupplierOrders.gs, every 5 min, Aviv's Gmail) takes the outbox, sends with Eilat + Shir in cc, reports the
-- Gmail thread -> sent (yellow). It then reads new messages on that thread and posts them to crm-po "reply";
-- Claude classifies the supplier's answer: confirmed -> green; question / partial / refusal -> attention (orange,
-- never green); an auto-reply changes nothing. Priority is never written.

alter table public.sp_suppliers add column if not exists order_email text;
alter table public.sp_suppliers add column if not exists order_contact text;
alter table public.sp_suppliers add column if not exists order_cc text[] not null default '{}'; -- supplier-side cc (Dior: sales agent)
update public.sp_suppliers set order_cc = array['ilanbeni10@gmail.com'] where id = 'ab86c0a9-c86c-4563-92ca-1a2ec7ed3808';
update public.sp_suppliers set order_email = 'irena@di-or.co.il', order_contact = 'אירנה'
  where id = 'ab86c0a9-c86c-4563-92ca-1a2ec7ed3808' and order_email is null;

create table if not exists public.crm_po (
  id bigserial primary key,
  po_no text generated always as ('Z' || lpad(id::text, 4, '0')) stored,
  supplier_id uuid not null references public.sp_suppliers(id),
  supplier_name text,
  to_email text not null,
  cc text[] not null default '{}',
  contact text,
  lines jsonb not null,               -- [{price_id, sku, desc, size, unit, qty, price, total}]
  total_cost numeric not null,        -- before VAT, our cost
  note text,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'confirmed', 'attention', 'failed', 'cancelled')),
  "by" text not null,
  by_name text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  gmail_thread_id text,
  gmail_msg_id text,
  replies jsonb not null default '[]', -- [{msg_id, from, at, text, verdict, summary, ignored}]
  verdict text,                       -- last supplier verdict: confirmed / partial / question / rejected / unclear
  summary text,                       -- one Hebrew line about the last supplier answer
  reply_at timestamptz,
  confirmed_at timestamptz,
  error text,
  task_id bigint,
  updated_at timestamptz not null default now()
);
create index if not exists crm_po_status_idx on public.crm_po (status, created_at desc);
alter table public.crm_po enable row level security;
create policy crm_po_read on public.crm_po for select using (crm_me() is not null);

-- supplier answered: push to all phones; a question / partial answer also opens a task for the office
create or replace function public.crm_po_notify() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_token text; v_task bigint; head text; txt text;
begin
  if new.status not in ('confirmed', 'attention') or old.status = new.status then return new; end if;
  head := coalesce(new.supplier_name, 'ספק') || ' · הזמנה ' || new.po_no;
  if new.status = 'attention' then
    txt := 'לבדוק תשובה של ' || coalesce(new.contact, new.supplier_name, 'הספק') || ' על הזמנה ' || new.po_no
      || ' (₪' || to_char(new.total_cost, 'FM999G999G990') || ' לפני מע"מ): ' || coalesce(new.summary, coalesce(new.error, 'לא ברור'))
      || '. הפרטים במחירון ספקים > הזמנות לספקים ובמייל.';
    insert into crm_tasks (tail9, text, due, "by") values (null, txt, now(), new."by") returning id into v_task;
    update crm_po set task_id = v_task where id = new.id;
  end if;
  begin
    select hook_token into v_token from crm_push_keys where id = 1;
    perform net.http_post(
      url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-push',
      headers := jsonb_build_object('content-type', 'application/json', 'x-hook-token', v_token),
      body := jsonb_build_object('action', 'notify', 'phone', '0000000000', 'type', 'pay',
        'name', case when new.status = 'confirmed' then '✓ אושרה ' else '⚠ לבדוק ' end || head,
        'text', coalesce(new.summary, case when new.status = 'confirmed' then 'הספק אישר את ההזמנה.' else 'צריך לבדוק את תשובת הספק.' end)));
  exception when others then null; -- an alert problem never blocks the order record
  end;
  return new;
end $$;
create trigger crm_po_notify_trg after update of status on public.crm_po for each row execute function public.crm_po_notify();
