-- The customer's page shows everything the customer has with us in Priority (Aviv 17.11.2026, pilot customer:
-- "כל הפעילות העסקית שלו מולנו כל ההזמנות כל הקבלות שהכל יהיה נגיש ללקוח. ומתעדכן").
-- A deal with priority_sync = true pulls the open Priority orders of its customer (crm_deals.cust_no) into its lines:
--   one line per order line, keyed by (so, so_line); price = the line total incl. VAT / qty (after discounts);
--   staff fields on a line (eta, stock, delivered_at, delivered_qty, cases by lid) are kept;
--   a new order shows up on its own; an order that leaves the open list keeps its lines with its final Priority status.
-- The page also gets the list of all the customer's Priority orders (number, date, status, amount).
-- Never returned: cost, supplier, agent, internal fields. No DROP in this file.

alter table public.crm_deals add column if not exists priority_sync boolean not null default false;

create or replace function public.crm_deal_pull_priority(p_deal bigint) returns void
language plpgsql security definer set search_path to 'public' as $$
declare d crm_deals; v_new jsonb;
begin
  select * into d from crm_deals where id = p_deal;
  if d.id is null or not d.priority_sync or d.cust_no is null then return; end if;
  with cur as (
    select l.j, l.n from jsonb_array_elements(coalesce(d.lines, '[]'::jsonb)) with ordinality l(j, n)
  ), pl as (                                   -- open Priority order lines of this customer
    select o.so, o.date, (x ->> 'n')::int as so_line, x
    from priority_orders o, jsonb_array_elements(coalesce(o.lines, '[]'::jsonb)) x
    where o.cust_no = d.cust_no
  ), merged as (
    -- lines we already have: refresh from Priority when the order is still open, else stamp the final status
    select c.n as ord, case
        when p.so is not null then c.j || jsonb_build_object('desc', p.x ->> 'desc', 'qty', (p.x ->> 'qty')::numeric,
          'sell', round((p.x ->> 'total')::numeric / nullif((p.x ->> 'qty')::numeric, 0) * 1.18, 2),
          'bal', (p.x ->> 'bal')::numeric, 'prio_due', p.x ->> 'due', 'so_date', p.date, 'prio_status', null)
        when c.j ? 'so' then c.j || jsonb_build_object('bal', null, 'prio_status',
          (select a.status from priority_orders_all a where a.so = c.j ->> 'so'))
        else c.j end as j
    from cur c left join pl p on p.so = c.j ->> 'so' and p.so_line = (c.j ->> 'so_line')::int
    union all
    -- new Priority lines
    select 100000 + row_number() over (order by p.so, p.so_line), jsonb_build_object(
        'lid', 'so' || p.so || '-' || p.so_line, 'so', p.so, 'so_line', p.so_line, 'so_date', p.date,
        'desc', p.x ->> 'desc', 'qty', (p.x ->> 'qty')::numeric,
        'sell', round((p.x ->> 'total')::numeric / nullif((p.x ->> 'qty')::numeric, 0) * 1.18, 2),
        'bal', (p.x ->> 'bal')::numeric, 'prio_due', p.x ->> 'due', 'eta', p.x ->> 'due', 'stock', false, 'item', p.x ->> 'item')
    from pl p
    where not exists (select 1 from cur c where c.j ->> 'so' = p.so and (c.j ->> 'so_line')::int = p.so_line)
  )
  select coalesce(jsonb_agg(j order by ord), '[]'::jsonb) into v_new from merged;
  if v_new is distinct from d.lines then
    update crm_deals set lines = v_new,
      total_sell = (select round(sum(coalesce((e ->> 'sell')::numeric, 0) * coalesce((e ->> 'qty')::numeric, 0)), 2) from jsonb_array_elements(v_new) e),
      updated_at = now()
    where id = d.id;
  end if;
end $$;
revoke all on function public.crm_deal_pull_priority(bigint) from public, anon, authenticated;

-- crm_my: same as crm-ai/crm_my.sql, plus the Priority pull, Priority stages and the orders list.
create or replace function public.crm_my(p_token text, p_pin text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare g record; d crm_deals; v_cust text; v_lines jsonb; v_money jsonb := '{}'::jsonb; v_bal numeric; v_orders jsonb := '[]'::jsonb;
begin
  select * into g from crm_my_gate(p_token, p_pin);
  if g.err is not null then return jsonb_build_object('ok', false, 'error', g.err, 'tries_left', g.tries_left); end if;
  perform crm_deal_pull_priority(g.deal_id);
  select * into d from crm_deals where id = g.deal_id;
  if d.seen_at is null or d.seen_at < now() - interval '10 minutes' then
    update crm_deals set seen_at = now(), seen_count = seen_count + 1 where id = d.id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'desc', l.j ->> 'desc', 'size', l.j ->> 'size', 'unit', l.j ->> 'unit',
      'qty', (l.j ->> 'qty')::numeric, 'sell', (l.j ->> 'sell')::numeric,
      'order', l.j ->> 'so', 'order_date', l.j ->> 'so_date',
      'stage', case
        when l.j ->> 'delivered_at' is not null then 'delivered'
        when l.j ? 'so' and ((l.j ->> 'bal') is not null and (l.j ->> 'bal')::numeric <= 0 or l.j ->> 'prio_status' = 'בוצעה') then 'delivered'
        when coalesce((l.j ->> 'stock')::boolean, false) then 'ready'
        when p.id is null or p.status in ('failed', 'cancelled') then 'chosen'
        when p.received_at is not null and p.receive_state = 'full' then 'ready'
        when p.received_at is not null then 'partial'
        when p.status = 'confirmed' then 'confirmed'
        else 'ordered' end,
      'ordered_at', case when p.status not in ('failed', 'cancelled') then coalesce(p.sent_at, p.created_at) end,
      'confirmed_at', case when p.status = 'confirmed' then p.confirmed_at end,
      'arrived_at', p.received_at,
      'delivered_at', l.j ->> 'delivered_at',
      'delivered_qty', coalesce((l.j ->> 'delivered_qty')::numeric,
        case when l.j ? 'so' and (l.j ->> 'bal') is not null and (l.j ->> 'bal')::numeric > 0 and (l.j ->> 'bal')::numeric < (l.j ->> 'qty')::numeric
          then (l.j ->> 'qty')::numeric - (l.j ->> 'bal')::numeric end),
      'cases', (select coalesce(jsonb_agg(jsonb_build_object('kind', c.kind, 'status', c.status, 'outcome', c.outcome, 'qty', c.qty, 'at', c.created_at) order by c.id), '[]'::jsonb)
        from crm_deal_cases c where c.deal_id = d.id and c.lid = l.j ->> 'lid'),
      'eta', coalesce(l.j ->> 'eta', case when p.id is not null and p.received_at is null and p.status in ('sent', 'confirmed') and lt.orders >= 3
        then to_char((coalesce(p.sent_at, p.created_at) + make_interval(days => ceil(lt.median_days)::int)) at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') end),
      'eta_from', case when l.j ->> 'eta' is not null then 'team' when lt.orders >= 3 then 'stats' end,
      'est', coalesce(l.j ->> 'est', '') = 'true'
    ) order by l.n), '[]'::jsonb) into v_lines
  from jsonb_array_elements(coalesce(d.lines, '[]'::jsonb)) with ordinality l(j, n)
  left join crm_po p on p.id = nullif(l.j ->> 'po_id', '')::bigint and p.deal_id = d.id
  left join crm_po_lead_times lt on lt.supplier_id::text = p.supplier_id::text;

  v_cust := coalesce(d.cust_no,
    (select c.priority_cust_no from crm_customers c where c.tail9 = d.customer_tail9 and c.deleted_at is null and c.priority_cust_no is not null limit 1),
    (select min(pc.cust_no) from priority_customers pc where pc.tail9 = d.customer_tail9 having count(*) = 1));
  if v_cust is not null then
    select a.total into v_bal from priority_aging a where a.cust_no = v_cust limit 1;
    v_money := jsonb_build_object(
      'known', true, 'balance', coalesce(v_bal, 0),
      'as_of', (select source_at from priority_sync where key = 'aging'),
      'invoices', (select coalesce(jsonb_agg(x order by x.date desc), '[]'::jsonb) from (select i.doc, i.date, i.amount from priority_invoices i where i.cust_no = v_cust and i.date >= current_date - 400 order by i.date desc limit 30) x),
      'receipts', (select coalesce(jsonb_agg(x order by x.date desc), '[]'::jsonb) from (select r.doc, r.date, r.amount, r.method from priority_receipts r where r.cust_no = v_cust and r.date >= current_date - 400 order by r.date desc limit 30) x));
    if d.priority_sync then
      select coalesce(jsonb_agg(jsonb_build_object('so', x.so, 'date', x.date, 'status', x.status, 'amount', x.amount, 'open', x.open) order by x.date desc, x.so desc), '[]'::jsonb) into v_orders
      from (select o.so, o.date, coalesce(a.status, 'פתוחה') as status,
              coalesce(a.amount, round(o.open_total * 1.18, 2)) as amount, true as open
            from priority_orders o left join priority_orders_all a on a.so = o.so where o.cust_no = v_cust
            union all
            select a.so, a.date, a.status, a.amount, false from priority_orders_all a
            where a.cust_no = v_cust and a.date >= current_date - 400 and not exists (select 1 from priority_orders o where o.so = a.so)) x;
    end if;
  end if;
  v_money := v_money || jsonb_build_object(
    'to_pay', (select coalesce(jsonb_agg(jsonb_build_object('amount', q.amount, 'what', q.description, 'link', q.pr_link, 'token', case when (select s.pay_frame_on from crm_settings s where s.id = 1) then q.pay_token end) order by q.id desc), '[]'::jsonb)
      from crm_pay_requests q where q.tail9 = d.customer_tail9 and q.status = 'created' and not coalesce(q.test, false) and q.pr_link is not null and q.created_at > now() - interval '30 days'),
    'paid', (select coalesce(jsonb_agg(jsonb_build_object('amount', coalesce(q.paid_sum, q.amount), 'what', q.description, 'at', q.paid_at) order by q.paid_at desc), '[]'::jsonb)
      from crm_pay_requests q where q.tail9 = d.customer_tail9 and q.status = 'paid' and not coalesce(q.test, false) and q.paid_at > now() - interval '180 days'));

  return jsonb_build_object('ok', true, 'now', now(),
    'deal', jsonb_build_object('no', d.deal_no, 'name', d.customer_name, 'status', d.status, 'created_at', d.created_at, 'updated_at', d.updated_at,
      'total', d.total_sell, 'note', d.public_note, 'deliver_to', coalesce(d.deliver_to, 'business'),
      'address', case when d.deliver_to = 'customer' then d.deliver ->> 'address' end),
    'lines', v_lines, 'money', v_money, 'orders', v_orders,
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('side', n.side, 'kind', n.kind, 'text', n.text, 'by', case when n.side = 'team' then n.by_name end, 'at', n.at) order by n.at), '[]'::jsonb)
      from (select * from crm_deal_notes where deal_id = d.id order by at desc limit 60) n));
end $$;
grant execute on function public.crm_my(text, text) to anon, authenticated;

-- Staff see the same lines on the deal page: pull every synced deal shortly after the robot pushes orders.
create or replace function public.crm_deals_pull_all() returns void
language plpgsql security definer set search_path to 'public' as $$
declare r record;
begin
  for r in select id from crm_deals where priority_sync and cust_no is not null loop
    perform crm_deal_pull_priority(r.id);
  end loop;
end $$;
revoke all on function public.crm_deals_pull_all() from public, anon, authenticated;
select cron.schedule('crm-deals-pull-priority', '*/10 * * * *', 'select public.crm_deals_pull_all()');
