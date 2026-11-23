-- Easy cancel (Aviv 19.11.2026: "שיהיה אפשר לבטל הזמנה. או כל מסמך בקלות").
-- Nothing is deleted: a cancelled order keeps every line, and who / when / why stay on it and in crm_audit.
--   crm_deal_cancel(deal, reason, note, dry)  dry = true only lists what is linked to the order; false cancels it
--   crm_deal_restore(deal)                    brings a cancelled order back
--   crm_taking_cancel(id, why, note)          cancels a payment that was recorded on the order
-- What the CRM may undo by itself it undoes (a payment link nobody paid). Everything that is money, a legal
-- document or a message to a supplier becomes one task for the office with the exact steps: until the exit from
-- Priority, receipts and credit notes come only from Priority, a refund to a card goes through the till screen,
-- and a purchase order is cancelled by a person in the orders tab (that sends the supplier a message).

alter table public.crm_deals
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by text,
  add column if not exists cancel_reason text,
  add column if not exists cancel_note text,
  add column if not exists cancel_prev text,
  add column if not exists cancel_task_id bigint;

create or replace function public.crm_deal_cancel(p_deal bigint, p_reason text, p_note text default null, p_dry boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare me text := public.crm_me(); d crm_deals; who text; steps text[] := '{}'; v_links jsonb; v_paid jsonb; v_pos jsonb; v_so jsonb; v_docs jsonb;
        v_deliv int; v_task bigint; r record; out jsonb; why text := btrim(coalesce(p_reason, '')); note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if me is null then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into d from crm_deals where id = p_deal for update;
  if d.id is null then return jsonb_build_object('ok', false, 'error', 'ההזמנה לא נמצאה'); end if;
  if d.status = 'cancelled' then return jsonb_build_object('ok', false, 'error', 'ההזמנה כבר בוטלה'); end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'amount', t.amount) order by t.id), '[]'::jsonb) into v_links
    from crm_takings t where t.deal_id = d.id and t.cancelled_at is null and t.method = 'card_link' and t.paid_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'amount', t.amount, 'method', t.method, 'payments', t.payments, 'at', t.at, 'doc_no', t.doc_no, 'receipt', t.closed_at is not null) order by t.id), '[]'::jsonb) into v_paid
    from crm_takings t where t.deal_id = d.id and t.cancelled_at is null and (t.method <> 'card_link' or t.paid_at is not null);
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'po_no', p.po_no, 'supplier', p.supplier_name, 'status', p.status, 'received', p.received_at is not null) order by p.id), '[]'::jsonb) into v_pos
    from crm_po p where p.deal_id = d.id and p.status not in ('cancelled', 'failed');
  select coalesce(jsonb_agg(distinct l ->> 'so'), '[]'::jsonb) into v_so from jsonb_array_elements(coalesce(d.lines, '[]'::jsonb)) l where coalesce(l ->> 'so', '') <> '';
  select count(*) into v_deliv from jsonb_array_elements(coalesce(d.lines, '[]'::jsonb)) l where (l ->> 'delivered_qty') ~ '^[0-9.]+$' and (l ->> 'delivered_qty')::numeric > 0;
  select coalesce(jsonb_agg(jsonb_build_object('kind', s.kind, 'no', s.sumit_document_number, 'total', s.total) order by s.id), '[]'::jsonb) into v_docs
    from acc_sales_docs s where s.our_ref like 'deal:' || d.deal_no || ':%' and not s.is_draft and s.status = 'created';

  out := jsonb_build_object('ok', true, 'deal_no', d.deal_no, 'links', v_links, 'paid', v_paid, 'pos', v_pos, 'so', v_so, 'delivered', v_deliv, 'docs', v_docs, 'shared', d.share_token is not null);

  -- the steps a person has to do, in the order they are done
  for r in select * from jsonb_to_recordset(v_pos) as x(po_no text, supplier text, received boolean) loop
    steps := steps || case when r.received then 'הזמנה ' || r.po_no || ' מ' || r.supplier || ' כבר הגיעה: להחליט אם הסחורה נשארת במלאי או חוזרת לספק'
                           else 'לבטל את הזמנה ' || r.po_no || ' מול ' || r.supplier || ' בלשונית ההזמנות' end;
  end loop;
  for r in select value as so from jsonb_array_elements_text(v_so) loop steps := steps || ('לבטל בפריוריטי את הזמנה ' || r.so); end loop;
  if v_deliv > 0 then steps := steps || (case when v_deliv = 1 then 'שורה אחת כבר נמסרה ללקוח' else v_deliv || ' שורות כבר נמסרו ללקוח' end || ': לתאם החזרה של הסחורה'); end if;
  for r in select * from jsonb_to_recordset(v_paid) as x(amount numeric, method text, doc_no text, receipt boolean) loop
    steps := steps || ('להחזיר ללקוח ₪' || to_char(r.amount, 'FM999G999G990D00') || ' ('
      || case r.method when 'cash' then 'שולם במזומן' when 'cheque' then 'שולם בצ׳ק: להחזיר את הצ׳ק אם לא הופקד' when 'transfer' then 'שולם בהעברה' when 'card_terminal' then 'אשראי במסוף: זיכוי במסוף' else 'אשראי בלינק: החזר לכרטיס במסך הקופה' end || ')'
      || case when r.receipt then ' ולהוציא בפריוריטי מסמך מבטל לקבלה ' || coalesce(r.doc_no, '') else ' ולתעד בפריוריטי' end);
  end loop;
  for r in select * from jsonb_to_recordset(v_docs) as x(no bigint) loop steps := steps || ('יצאה חשבונית מספר ' || coalesce(r.no::text, '') || ': נדרשת חשבונית זיכוי'); end loop;

  if p_dry then return out || jsonb_build_object('steps', to_jsonb(steps)); end if;
  if length(why) < 2 then return jsonb_build_object('ok', false, 'error', 'חסרה סיבת הביטול'); end if;

  who := coalesce((select s.name from crm_staff s where lower(s.email) = lower(me) limit 1), me);
  if array_length(steps, 1) > 0 then
    insert into crm_tasks (tail9, text, due, "by")
    values (d.customer_tail9, 'ביטול הזמנה ' || d.deal_no || coalesce(' של ' || d.customer_name, '') || ' (' || who || ': ' || why || '). מה נשאר לעשות: ' || array_to_string(steps, '. ') || '.', now(), me)
    returning id into v_task;
  end if;
  update crm_takings set cancelled_at = now(), cancelled_by = me, cancel_note = 'ההזמנה בוטלה: ' || why
   where deal_id = d.id and cancelled_at is null and method = 'card_link' and paid_at is null;
  update crm_deals set cancel_prev = status, status = 'cancelled', cancelled_at = now(), cancelled_by = me, cancel_reason = why, cancel_note = note, cancel_task_id = v_task, updated_at = now() where id = d.id;
  insert into crm_audit (who, action, tail9, detail) values (me, 'deal_cancel', d.customer_tail9, out || jsonb_build_object('deal_id', d.id, 'reason', why, 'note', note, 'task_id', v_task, 'steps', to_jsonb(steps)));
  return out || jsonb_build_object('steps', to_jsonb(steps), 'task_id', v_task);
end $$;

create or replace function public.crm_deal_restore(p_deal bigint)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare me text := public.crm_me(); d crm_deals;
begin
  if me is null then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into d from crm_deals where id = p_deal for update;
  if d.id is null or d.status <> 'cancelled' then return jsonb_build_object('ok', false, 'error', 'ההזמנה לא מבוטלת'); end if;
  insert into crm_audit (who, action, tail9, detail) values (me, 'deal_restore', d.customer_tail9,
    jsonb_build_object('deal_id', d.id, 'deal_no', d.deal_no, 'cancelled_at', d.cancelled_at, 'cancelled_by', d.cancelled_by, 'reason', d.cancel_reason, 'note', d.cancel_note));
  update crm_tasks set done_at = now(), done_by = me where id = d.cancel_task_id and done_at is null;
  perform set_config('crm.restore', '1', true);
  update crm_deals set status = coalesce(nullif(cancel_prev, 'cancelled'), 'open'), cancelled_at = null, cancelled_by = null, cancel_reason = null, cancel_note = null, cancel_prev = null, cancel_task_id = null, updated_at = now() where id = d.id;
  return jsonb_build_object('ok', true);
end $$;

-- A payment recorded on an order. p_why: 'mistake' (was never received) or 'returned' (the money went back to the customer).
create or replace function public.crm_taking_cancel(p_id bigint, p_why text, p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare me text := public.crm_me(); t crm_takings; who text; v_task bigint; txt text;
begin
  if me is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_why not in ('mistake', 'returned') then return jsonb_build_object('ok', false, 'error', 'חסרה סיבה'); end if;
  select * into t from crm_takings where id = p_id for update;
  if t.id is null or t.cancelled_at is not null then return jsonb_build_object('ok', false, 'error', 'התשלום לא נמצא או כבר בוטל'); end if;
  if t.method = 'card_link' and t.paid_at is not null then
    return jsonb_build_object('ok', false, 'error', 'תשלום באשראי שאושר בטרנזילה מבטלים בהחזר לכרטיס, במסך הקופה');
  end if;
  txt := case p_why when 'mistake' then 'נרשם בטעות' else 'הכסף הוחזר ללקוח' end || coalesce(': ' || nullif(btrim(coalesce(p_note, '')), ''), '');
  who := coalesce((select s.name from crm_staff s where lower(s.email) = lower(me) limit 1), me);
  update crm_takings set cancelled_at = now(), cancelled_by = me, cancel_note = txt where id = t.id;   -- the trigger closes the open receipt task
  if t.closed_at is not null then   -- a receipt already went out: only Priority can cancel it
    insert into crm_tasks (tail9, text, due, "by")
    values (t.tail9, 'לבטל בפריוריטי את קבלה ' || coalesce(t.doc_no, '') || ' על ₪' || to_char(t.amount, 'FM999G999G990D00') || ' מ' || btrim(t.payer_name) || ' (' || who || ': ' || txt || ').', now(), me)
    returning id into v_task;
  end if;
  insert into crm_audit (who, action, tail9, detail) values (me, 'taking_cancel', t.tail9, jsonb_build_object('taking_id', t.id, 'deal_id', t.deal_id, 'amount', t.amount, 'method', t.method, 'doc_no', t.doc_no, 'why', p_why, 'note', p_note, 'task_id', v_task));
  return jsonb_build_object('ok', true, 'task_id', v_task, 'receipt', t.closed_at is not null);
end $$;

grant execute on function public.crm_deal_cancel(bigint, text, text, boolean) to authenticated;
grant execute on function public.crm_deal_restore(bigint) to authenticated;
grant execute on function public.crm_taking_cancel(bigint, text, text) to authenticated;

-- A screen that was left open on another device still holds the old status and saves it with every edit:
-- only crm_deal_restore may take an order out of "cancelled".
create or replace function public.crm_deals_keep_cancel() returns trigger language plpgsql as $$
begin
  if old.status = 'cancelled' and new.status is distinct from 'cancelled' and coalesce(current_setting('crm.restore', true), '') <> '1' then
    new.status := 'cancelled';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'crm_deals_keep_cancel' and tgrelid = 'public.crm_deals'::regclass) then
    create trigger crm_deals_keep_cancel before update on public.crm_deals for each row execute function public.crm_deals_keep_cancel();
  end if;
end $$;
