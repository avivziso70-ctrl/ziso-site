-- Loop closing (Aviv 17.11.2026, standing): "הcrm צריך תמיד לראות שהלולאות נסגרות. קבלות. חשבוניות. הזמנות רכש ... ושהכל יהיה online".
-- Every open loop has an age, an owner and a due time. A loop closes by itself when its document shows up; staff get ONE task only
-- when a loop is past due. Supplier order confirmation / cancellation already alert through crm_po_overdue() (crm_po_ack.sql),
-- so here they are listed but not alerted again. Runs hourly (cron crm-loops) after crm_takings_autoclose() (crm_takings_autoclose.sql).
-- Staff only. No DROP.

create table if not exists public.crm_loop_alerts (
  kind text not null,
  ref text not null,
  task_id bigint,
  at timestamptz not null default now(),
  primary key (kind, ref)
);
alter table public.crm_loop_alerts enable row level security;
create policy crm_loop_alerts_staff on public.crm_loop_alerts for select using (public.crm_me() is not null);

-- refund -> credit document in Priority: a negative receipt or invoice for the same amount, from the original charge day to 10 days
-- after the refund, not already claimed by another refund. A staff "done" on the refund's task also closes it.
create or replace function public.crm_refunds_autoclose() returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer := 0; r record; d text;
begin
  for r in select * from crm_refunds where status = 'done' and resolved_at is null order by id loop
    select x.doc into d from (
      select doc, date from priority_receipts where amount = -r.amount
      union all select doc, date from priority_invoices where amount = -r.amount) x
    where x.date between coalesce(r.tz_day, (r.at at time zone 'Asia/Jerusalem')::date) and (r.at at time zone 'Asia/Jerusalem')::date + 10
      and not exists (select 1 from crm_refunds y where y.resolved_by = 'auto: priority ' || x.doc)
    order by x.date desc limit 1;
    if d is not null then
      update crm_refunds set resolved_at = now(), resolved_by = 'auto: priority ' || d where id = r.id;
      update crm_tasks set done_at = now(), done_by = 'auto: priority' where id = r.task_id and done_at is null;
      n := n + 1;
    elsif exists (select 1 from crm_tasks t where t.id = r.task_id and t.done_at is not null) then
      update crm_refunds set resolved_at = (select done_at from crm_tasks where id = r.task_id), resolved_by = 'task done' where id = r.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- transfer proof from WhatsApp -> receipt in Priority: same amount, receipt 0-5 days after the transfer date, customer phone matches.
create or replace function public.crm_proofs_autoclose() returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer := 0; p record; d text;
begin
  for p in select * from payment_proofs where status = 'extracted' and receipt_doc is null and amount is not null loop
    select r.doc into d from priority_receipts r join priority_customers c on c.cust_no = r.cust_no
    where r.amount = p.amount
      and r.date between coalesce(p.pay_date, (p.created_at at time zone 'Asia/Jerusalem')::date) and coalesce(p.pay_date, (p.created_at at time zone 'Asia/Jerusalem')::date) + 5
      and c.tail9 = right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9)
      and not exists (select 1 from payment_proofs q where q.receipt_doc = r.doc)
    order by r.date limit 1;
    if d is not null then update payment_proofs set receipt_doc = d, updated_at = now() where id = p.id; n := n + 1; end if;
  end loop;
  return n;
end $$;

-- every open loop, oldest first. due_at = when it counts as stuck.
create or replace function public.crm_open_loops() returns table (
  kind text, label text, ref text, title text, amount numeric, owner text, opened_at timestamptz, due_at timestamptz, stuck boolean, tail9 text, link text)
language sql stable security definer set search_path to 'public' as $$
  select * from (
    select 'receipt'::text, 'תשלום ← קבלה', 'taking:' || t.id, 'קבלה ל' || coalesce(nullif(trim(t.payer_name), ''), 'לקוח'), t.amount::numeric, 'משרד',
           coalesce(t.paid_at, t.at), coalesce(t.paid_at, t.at) + interval '24 hours', coalesce(t.paid_at, t.at) + interval '24 hours' < now(), t.tail9, 'kupa'
    from crm_takings t where t.closed_at is null and t.cancelled_at is null and (t.method <> 'card_link' or t.paid_at is not null)
    union all
    select 'credit', 'החזר ← חשבונית זיכוי', 'refund:' || r.id, case when r.shop_order_id is not null then 'חנות אונליין · הזמנה ' || r.shop_order_id || ' · ' else '' end || 'זיכוי בפריוריטי: החזר ' || coalesce(nullif(trim(r.payer_name), ''), 'לקוח'), r.amount, 'משרד',
           r.at, r.at + interval '24 hours', r.at + interval '24 hours' < now(), r.tail9, 'kupa'
    from crm_refunds r where r.status = 'done' and r.resolved_at is null
    union all
    select 'proof', 'העברה ← קבלה', 'proof:' || p.id, 'קבלה על העברה מ' || coalesce(nullif(trim(p.payer), ''), 'לקוח'), p.amount, 'משרד',
           p.created_at, p.created_at + interval '48 hours', p.created_at + interval '48 hours' < now(), right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9), null
    from payment_proofs p where p.status = 'extracted' and p.receipt_doc is null
    union all
    select 'po_ack', 'הזמנת רכש ← אישור ספק', 'po:' || o.id, o.po_no || ' · ' || coalesce(o.supplier_name, 'ספק') || ' לא אישר', o.total_cost, coalesce(o.by_name, 'משרד'),
           o.sent_at, o.sent_at + interval '3 hours', o.sent_at + interval '3 hours' < now(), o.customer_tail9, 'prices'
    from crm_po o where o.sent_at is not null and o.confirmed_at is null and o.cancelled_at is null and o.received_at is null
    union all
    select 'po_cancel', 'ביטול ← אישור ספק', 'pocancel:' || o.id, o.po_no || ' · ' || coalesce(o.supplier_name, 'ספק') || ' לא אישר ביטול', o.total_cost, coalesce(o.by_name, 'משרד'),
           o.cancelled_at, o.cancelled_at + interval '2 hours', o.cancelled_at + interval '2 hours' < now(), o.customer_tail9, 'prices'
    from crm_po o where o.cancelled_at is not null and coalesce(o.cancel_ack, 'waiting') <> 'confirmed'
    union all
    select 'po_goods', 'הזמנת רכש ← סחורה', 'pogoods:' || o.id, o.po_no || ' · סחורה מ' || coalesce(o.supplier_name, 'ספק') || ' עוד לא הגיעה', o.total_cost, coalesce(o.by_name, 'משרד'),
           o.confirmed_at, o.sent_at + make_interval(days => (coalesce(lt.median_days, 14) + 3)::int),
           o.sent_at + make_interval(days => (coalesce(lt.median_days, 14) + 3)::int) < now(), o.customer_tail9, 'prices'
    from crm_po o left join crm_po_lead_times lt on lt.supplier_id = o.supplier_id
    where o.confirmed_at is not null and o.received_at is null and o.cancelled_at is null
    union all
    select 'po_invoice', 'סחורה ← חשבונית ספק', 'poinv:' || o.id, o.po_no || ' · חסרה חשבונית מ' || coalesce(o.supplier_name, 'ספק'), o.total_cost, 'משרד',
           o.received_at, o.received_at + interval '7 days', o.received_at + interval '7 days' < now(), o.customer_tail9, 'receive'
    from crm_po o where o.received_at is not null and o.cancelled_at is null
      and not exists (select 1 from crm_receipts c where c.po_id = o.id and c.doc_type in ('tax_invoice', 'invoice_receipt') and c.status in ('ok', 'gap', 'check'))
    union all
    select 'deal_invoice', 'עסקה ← חשבונית', 'deal:' || d.id, d.deal_no || ' · ' || coalesce(d.customer_name, 'לקוח') || ': אין עדיין חשבונית בפריוריטי', d.total_sell, coalesce(d.by_name, 'משרד'),
           d.updated_at, d.updated_at + interval '30 days', d.updated_at + interval '30 days' < now(), d.customer_tail9, 'deal'
    from crm_deals d where d.status = 'ordered'
      and not exists (select 1 from priority_invoices i where i.cust_no = d.cust_no and i.date >= (d.created_at at time zone 'Asia/Jerusalem')::date)
  ) x(kind, label, ref, title, amount, owner, opened_at, due_at, stuck, tail9, link)
  where public.crm_me() is not null or session_user = 'postgres'  -- cron runs as postgres; API callers arrive as authenticator
  order by opened_at
$$;
revoke all on function public.crm_open_loops() from public, anon;
grant execute on function public.crm_open_loops() to authenticated;

-- hourly: close what closed by itself, then one task per loop that is past due (supplier ack / cancel loops alert in crm_po_overdue).
create or replace function public.crm_loops_run() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare a integer; b integer; c integer; n integer := 0; l record; tid bigint;
begin
  a := crm_takings_autoclose(); b := crm_refunds_autoclose(); c := crm_proofs_autoclose();
  for l in select * from crm_open_loops() o
           where o.stuck and o.kind not in ('po_ack', 'po_cancel')
             and not exists (select 1 from crm_loop_alerts x where x.kind = o.kind and x.ref = o.ref) loop
    insert into crm_tasks (tail9, text, due, "by", at)
    values (nullif(l.tail9, ''), 'מעגל פתוח (' || l.label || '): ' || l.title || coalesce(' · ₪' || to_char(l.amount, 'FM999,999,990.##'), '')
              || ' · פתוח מ-' || to_char(l.opened_at at time zone 'Asia/Jerusalem', 'DD.MM'), now(), 'סגירת מעגלים', now())
    returning id into tid;
    insert into crm_loop_alerts (kind, ref, task_id) values (l.kind, l.ref, tid);
    n := n + 1;
  end loop;
  return jsonb_build_object('receipts', a, 'credits', b, 'proofs', c, 'alerts', n);
end $$;
revoke all on function public.crm_loops_run() from public, anon, authenticated;
revoke all on function public.crm_refunds_autoclose() from public, anon, authenticated;
revoke all on function public.crm_proofs_autoclose() from public, anon, authenticated;

select cron.unschedule('crm-takings-autoclose');
select cron.schedule('crm-loops', '25 * * * *', 'select public.crm_loops_run()');
