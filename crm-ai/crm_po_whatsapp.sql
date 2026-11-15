-- crm_po over WhatsApp (first supplier: Sanitec, to Dudi). Applied 15.11.2026.
-- crm-po "create" sends the order at once from the business number (free text inside the 24h window, otherwise the
-- approved template ziso_supplier_order) and records it in wa_messages with source 'crm', so the customer bot stays quiet.
-- His answers: wa-webhook stores them in wa_messages (source 'live'); the trigger below posts them to crm-po "wa_reply".

alter table public.sp_suppliers add column if not exists order_wa_phone text;
update public.sp_suppliers set order_wa_phone = '0506395160', order_contact = coalesce(order_contact, 'דודי')
  where name like '%סניטק%' and order_wa_phone is null;

alter table public.crm_po add column if not exists channel text not null default 'email';
alter table public.crm_po add column if not exists to_phone text;
alter table public.crm_po add column if not exists wa_truncated boolean not null default false; -- template held only part of the lines
alter table public.crm_po alter column to_email drop not null;

create or replace function public.crm_po_wa_in() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_po bigint; v_token text; t9 text;
begin
  if new.dir <> 'in' or coalesce(new.source, '') <> 'live' then return new; end if;
  t9 := right(regexp_replace(coalesce(new.phone, ''), '\D', '', 'g'), 9);
  if length(t9) < 9 then return new; end if;
  select id into v_po from crm_po where channel in ('whatsapp', 'both') and right(regexp_replace(coalesce(to_phone, ''), '\D', '', 'g'), 9) = t9
    and status in ('sent', 'attention', 'confirmed') and sent_at > now() - interval '45 days' order by sent_at desc limit 1;
  if v_po is null then return new; end if;
  begin
    select hook_token into v_token from crm_push_keys where id = 1;
    perform net.http_post(
      url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-po',
      headers := jsonb_build_object('content-type', 'application/json', 'x-hook-token', v_token),
      body := jsonb_build_object('action', 'wa_reply', 'id', v_po, 'msg_id', new.id, 'from', new.phone, 'date', new.ts, 'type', new.type,
        'text', coalesce(new.text, new.raw #>> '{button,text}', new.raw #>> '{interactive,button_reply,title}', '')));
  exception when others then null; -- an order problem never blocks storing the message
  end;
  return new;
end $$;
create trigger crm_po_wa_in_trg after insert on public.wa_messages for each row execute function public.crm_po_wa_in();

-- Aviv 15.11: Sanitec also by email to dudi@sanitec.co.il (cc Eilat + Shir) in addition to WhatsApp -> channel 'both'.
-- order_paused blocks ordering while a supplier's price list is being fixed (Sanitec 15.11: prices were read from model codes).
alter table public.sp_suppliers add column if not exists order_paused boolean not null default false;
alter table public.crm_po add column if not exists email_state text; -- 'both' only: queued / sending / sent / failed / unknown
alter table public.crm_po add column if not exists wa_msg_id text;   -- outbound WhatsApp message id
-- crm_po_wa_in (above) matches channel in ('whatsapp', 'both') since 15.11.

-- 15.11.2026 (Aviv): delivery method, customer per order, cancel from the CRM. Applied as migrations crm_po_delivery_cancel + crm_po_customer.
alter table public.crm_po
  add column if not exists deliver_to text not null default 'business',   -- business | customer
  add column if not exists deliver jsonb,                                  -- { name, phone, address, note, tail9 } when deliver_to = customer
  add column if not exists customer_name text,                             -- who the order is for; null = stock
  add column if not exists customer_tail9 text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by text,
  add column if not exists cancel_email_state text,                        -- queued | sending | sent | failed
  add column if not exists cancel_claimed_at timestamptz,
  add column if not exists cancel_wa_state text,                           -- sent | failed
  add column if not exists cancel_error text;
