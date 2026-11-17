-- Suppliers that have no price list and price every item on request (first: Onda, through Rima). Aviv 17.11.2026.
-- 1. "Last prices" taken from the chat history sit in sp_prices under an upload with source 'chat-extract'.
--    The search marks them est = true; the order page shows them as an estimate ("סופי באישור רימה") and the
--    customer page says the price is an estimate until confirmed.
-- 2. A price request from an order line: crm-po { action: "price_ask" } sends model, size, colour and the customer's name
--    to the supplier's order contact from the business WhatsApp, only when a staff member presses the button.
--    The answer is caught by a trigger on wa_messages and kept on the request, which the order page shows on the line.
-- Additive only.

alter table public.sp_suppliers add column if not exists price_by_ask boolean not null default false;
update public.sp_suppliers set price_by_ask = true, order_contact = coalesce(order_contact, 'רימה')
  where name like 'אונדה%' and not price_by_ask;

create table if not exists public.crm_price_asks (
  id bigint generated always as identity primary key,
  deal_id bigint not null references public.crm_deals(id),
  lid text,                                  -- the order line it was asked for
  supplier_id uuid not null references public.sp_suppliers(id),
  item text not null,                        -- model · size · colour, as sent
  customer_name text,
  text text not null,                        -- the whole message
  by text not null, by_name text,
  asked_at timestamptz not null default now(),
  via text,                                  -- text (inside Meta's 24h window) | template
  wa_msg_id text,
  state text not null default 'sent',        -- sent | answered | failed | closed
  error text,
  replies jsonb not null default '[]'::jsonb, -- [{ msg_id, at, text }]
  reply_at timestamptz,
  price numeric,                             -- the final cost before VAT the staff took from the answer
  closed_by text, closed_at timestamptz
);
create index if not exists crm_price_asks_deal on public.crm_price_asks (deal_id);
create index if not exists crm_price_asks_open on public.crm_price_asks (supplier_id, asked_at desc) where state in ('sent', 'answered');
alter table public.crm_price_asks enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'crm_price_asks' and policyname = 'crm_price_asks_staff') then
    create policy crm_price_asks_staff on public.crm_price_asks for select to authenticated using (public.crm_me() is not null);
  end if;
end $$;

-- the supplier's answer on WhatsApp. Which request it belongs to: the one she quoted, otherwise the newest one still
-- waiting, otherwise the one answered in the last 30 minutes (a second message of the same answer).
create or replace function public.crm_price_ask_in() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare t9 text; v_id bigint; v_txt text; v_ctx text; v_deal bigint; v_item text; v_sup text;
begin
  if new.dir <> 'in' or coalesce(new.source, '') <> 'live' then return new; end if;
  begin
    t9 := right(regexp_replace(coalesce(new.phone, ''), '\D', '', 'g'), 9);
    if length(t9) < 9 then return new; end if;
    v_txt := btrim(coalesce(new.text, new.raw #>> '{button,text}', ''));
    if v_txt = '' and new.type in ('image', 'document', 'audio', 'video') then
      v_txt := case new.type when 'image' then '[תמונה]' when 'document' then '[קובץ]' when 'audio' then '[הודעה קולית]' else '[סרטון]' end;
    end if;
    if v_txt = '' then return new; end if;
    v_ctx := new.raw #>> '{context,id}';
    select a.id, a.deal_id, a.item, s.name into v_id, v_deal, v_item, v_sup
      from crm_price_asks a join sp_suppliers s on s.id = a.supplier_id
      where right(regexp_replace(coalesce(s.order_wa_phone, ''), '\D', '', 'g'), 9) = t9
        and a.asked_at > now() - interval '14 days'
        and ((v_ctx is not null and a.wa_msg_id = v_ctx and a.state in ('sent', 'answered'))
          or a.state = 'sent' or (a.state = 'answered' and a.reply_at > now() - interval '30 minutes'))
      order by (v_ctx is not null and a.wa_msg_id = v_ctx) desc, (a.state = 'sent') desc, a.asked_at desc limit 1;
    if v_id is null then return new; end if;
    update crm_price_asks set replies = replies || jsonb_build_object('msg_id', new.id, 'at', new.ts, 'text', left(v_txt, 2000)),
        reply_at = new.ts, state = 'answered'
      where id = v_id and not exists (select 1 from jsonb_array_elements(replies) r where r ->> 'msg_id' = new.id);
    -- one line in the alerts panel, once per request
    if found and not exists (select 1 from crm_tasks where by = 'בקשת מחיר' and text like '%(בקשה ' || v_id || ')%') then
      insert into crm_tasks (text, due, by)
        select 'תשובה על בקשת מחיר מ' || split_part(v_sup, ' ', 1) || ': ' || left(v_item, 80) || '. הזמנה ' || coalesce(d.deal_no, '') || ' של ' || coalesce(d.customer_name, '') || ' (בקשה ' || v_id || ')',
               now(), 'בקשת מחיר' from crm_deals d where d.id = v_deal;
    end if;
  exception when others then null;   -- never blocks storing the message
  end;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'crm_price_ask_in_trg') then
    create trigger crm_price_ask_in_trg after insert on public.wa_messages for each row execute function public.crm_price_ask_in();
  end if;
end $$;

-- the staff took the final price from the answer (or gave up on the request)
create or replace function public.crm_price_ask_close(p_id bigint, p_price numeric default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_me text := public.crm_me();
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'staff only'); end if;
  update crm_price_asks set state = 'closed', price = p_price, closed_by = v_me, closed_at = now() where id = p_id and state <> 'closed';
  update crm_tasks set done_at = now(), done_by = v_me where by = 'בקשת מחיר' and done_at is null and text like '%(בקשה ' || p_id || ')%';
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.crm_price_ask_close(bigint, numeric) from public, anon;
grant execute on function public.crm_price_ask_close(bigint, numeric) to authenticated;
