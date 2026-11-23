-- Account card for every customer and every supplier (Aviv 19.11.2026: "כרטיס לקוח עם חשבון לקוח, כמו פריוריטי... וכל ספק").
-- Read only. Until the exit from Priority the numbers are the synced Priority tables; from 1.1.2027 the ledger's own lines join by the same card number.
--   crm_account(kind, id)   one card: balance, open lines, every movement of the year with a running balance, linked documents
--   crm_account_find(q)     search by name, card number or phone
--   crm_account_list()      every card that carries a balance
-- Who sees what: any signed-in staff sees customer cards and goods suppliers (codes 20xxxx).
-- Finance, lender, owners and other non-goods accounts are for the owner only.
-- priority_invoices amounts include VAT. An invoice-receipt (OV) is both the charge and the payment; ON is its refund.
-- The opening balance of the year is derived: today's balance minus the movements of the year.

create or replace function public.crm_account(p_kind text, p_id text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare own boolean := public.crm_is_owner(); r jsonb; bal numeric; t9 text; nm text; ph text; cty text; spid uuid;
        yr date := date_trunc('year', current_date)::date;
begin
  if public.crm_me() is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_kind = 'customer' then
    select name, tail9, phone, city into nm, t9, ph, cty from priority_customers where cust_no = p_id;
    if nm is null then select max(name) into nm from priority_customer_aging where acct = p_id; end if;
    if nm is null then return jsonb_build_object('missing', true); end if;
    bal := coalesce((select total from priority_aging where cust_no = p_id), (select sum(amount) from priority_customer_aging where acct = p_id), 0);
    with m as (
      select i.date, i.doc, case when i.doc like 'IK%' then 'חשבונית זיכוי' else 'חשבונית מס' end as label, null::text as method,
             greatest(i.amount, 0) as debit, greatest(-i.amount, 0) as credit
        from priority_invoices i where i.cust_no = p_id
      union all
      select rc.date, rc.doc, case when rc.doc like 'OV%' then 'חשבונית מס קבלה' when rc.doc like 'ON%' then 'זיכוי חשבונית מס קבלה' else 'קבלה' end, rc.method,
             case when rc.doc ~ '^(OV|ON)' then rc.amount when rc.amount < 0 then -rc.amount else 0 end,
             case when rc.doc ~ '^(OV|ON)' then rc.amount when rc.amount > 0 then rc.amount else 0 end
        from priority_receipts rc where rc.cust_no = p_id),
    t as (select coalesce(sum(debit), 0) d, coalesce(sum(credit), 0) c from m),
    run as (select m.*, (bal - (select d - c from t)) + sum(m.debit - m.credit) over (order by m.date, m.doc) as bal_after from m)
    select jsonb_build_object(
      'kind', 'customer', 'id', p_id, 'name', nm, 'phone', ph, 'city', cty, 'tail9', t9, 'balance', bal,
      'aging', (select to_jsonb(a) - 'updated_at' - 'phone' - 'tail9' - 'name' - 'cust_no' from priority_aging a where a.cust_no = p_id),
      'year', extract(year from yr)::int, 'debit_ytd', (select d from t), 'credit_ytd', (select c from t), 'opening', bal - (select d - c from t),
      'moves', (select coalesce(jsonb_agg(jsonb_build_object('date', run.date, 'doc', run.doc, 'label', run.label, 'method', run.method, 'debit', run.debit, 'credit', run.credit, 'bal', run.bal_after) order by run.date, run.doc), '[]'::jsonb) from run),
      'open', (select coalesce(jsonb_agg(jsonb_build_object('doc', o.doc, 'type', o.type, 'date', o.doc_date, 'due', o.due, 'late', o.days_late, 'details', o.details, 'amount', o.amount) order by o.doc_date, o.seq), '[]'::jsonb) from priority_customer_aging o where o.acct = p_id),
      'orders', (select coalesce(jsonb_agg(jsonb_build_object('so', o.so, 'date', o.date, 'status', o.status, 'open_total', o.open_total) order by o.date desc), '[]'::jsonb) from (select * from priority_orders where cust_no = p_id order by date desc limit 30) o),
      'quotes', (select coalesce(jsonb_agg(jsonb_build_object('pq', q.pq, 'date', q.date, 'status', q.status, 'total', q.total) order by q.date desc), '[]'::jsonb) from (select * from priority_quotes where cust_no = p_id order by date desc limit 20) q),
      'deals', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'deal_no', d.deal_no, 'status', d.status, 'total', d.total_sell, 'at', d.updated_at) order by d.updated_at desc), '[]'::jsonb) from crm_deals d where d.cust_no = p_id or (t9 is not null and d.customer_tail9 = t9)),
      'takings', (select coalesce(jsonb_agg(jsonb_build_object('at', k.at, 'amount', k.amount, 'method', k.method, 'doc_no', k.doc_no, 'closed', k.closed_at is not null) order by k.at desc), '[]'::jsonb) from crm_takings k where t9 is not null and k.tail9 = t9 and k.cancelled_at is null),
      'synced', (select jsonb_object_agg(key, source_at) from priority_sync where key in ('aging', 'invoices', 'receipts', 'customer_aging'))
    ) into r;
  elsif p_kind = 'supplier' then
    select name into nm from priority_suppliers where sup = p_id;
    if nm is null then select max(sup_name) into nm from priority_supplier_aging where sup = p_id; end if;
    if nm is null then select max(sup_name) into nm from priority_supplier_checks where sup = p_id; end if;
    if nm is null then return jsonb_build_object('missing', true); end if;
    if not own and (p_id !~ '^20[0-9]{4}$' or nm ~ 'פיננס|מימון|הלווא|בעלים|חו"ז') then raise exception 'owner only' using errcode = '42501'; end if;
    select id into spid from sp_suppliers where priority_sup = p_id order by active desc limit 1;
    select jsonb_build_object(
      'kind', 'supplier', 'id', p_id, 'name', nm,
      'phone', (select contact_phone from sp_suppliers where id = spid),
      'balance', coalesce((select sum(open) from priority_supplier_aging where sup = p_id), 0),
      'late', coalesce((select sum(open) from priority_supplier_aging where sup = p_id and days_late > 0 and open > 0), 0),
      'open', (select coalesce(jsonb_agg(jsonb_build_object('doc', o.doc, 'sup_doc', o.sup_doc, 'type', o.type, 'date', o.doc_date, 'due', o.due, 'late', o.days_late, 'details', o.details, 'amount', o.doc_amount, 'open', o.open) order by o.due, o.seq), '[]'::jsonb) from priority_supplier_aging o where o.sup = p_id),
      'cheques', (select coalesce(jsonb_agg(to_jsonb(x) order by x.due), '[]'::jsonb) from (
          select check_no as no, check_due as due, round(sum(net), 2) as net, max(pay) as pay from priority_supplier_checks where sup = p_id and check_due >= current_date group by check_no, check_due) x),
      'payments', (select coalesce(jsonb_agg(to_jsonb(x) order by x.pay_date desc, x.pay desc), '[]'::jsonb) from (
          select pay, max(pay_date) as pay_date, max(check_no) as no, max(check_due) as due, round(sum(net), 2) as net,
                 jsonb_agg(jsonb_build_object('inv', inv_internal, 'sup_inv', inv_supplier, 'date', inv_date, 'amount', amount) order by line) as lines
            from priority_supplier_checks where sup = p_id group by pay order by max(pay_date) desc limit 80) x),
      'year', extract(year from yr)::int,
      'paid_ytd', coalesce((select sum(net) from priority_supplier_checks where sup = p_id and pay_date >= yr), 0),
      'po_open', (select coalesce(jsonb_agg(to_jsonb(x) order by x.date desc), '[]'::jsonb) from (
          select po, max(date) as date, max(due) as due, count(*) as n, round(sum(open_value_ils)) as open_value from priority_supplier_orders where sup = p_id and coalesce(open_qty, 0) > 0 group by po) x),
      'our_po', (select coalesce(jsonb_agg(jsonb_build_object('po_no', p.po_no, 'status', p.status, 'at', p.created_at, 'total', p.total_cost, 'cancelled', p.cancelled_at is not null) order by p.created_at desc), '[]'::jsonb) from crm_po p where spid is not null and p.supplier_id = spid),
      'our_inv', (select coalesce(jsonb_agg(jsonb_build_object('inv_no', i.inv_no, 'date', i.inv_date, 'total', i.total, 'status', i.status, 'doc_type', i.doc_type) order by i.inv_date desc), '[]'::jsonb) from acc_supplier_invoices i where spid is not null and i.supplier_id in (spid::text, p_id)),
      'synced', (select jsonb_object_agg(key, source_at) from priority_sync where key in ('supplier_aging', 'supplier_checks', 'supplier_orders'))
    ) into r;
  else
    return jsonb_build_object('missing', true);
  end if;
  return r;
end $$;
grant execute on function public.crm_account(text, text) to authenticated;

create or replace function public.crm_account_find(p_q text, p_limit integer default 8)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare own boolean := public.crm_is_owner(); d text; q text := btrim(coalesce(p_q, ''));
begin
  if public.crm_me() is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if length(q) < 2 then return jsonb_build_object('customers', '[]'::jsonb, 'suppliers', '[]'::jsonb); end if;
  d := regexp_replace(q, '\D', '', 'g');
  return jsonb_build_object(
    'customers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select pc.cust_no as id, pc.name, pc.city, pc.tail9, coalesce(a.total, 0) as balance
          from priority_customers pc left join priority_aging a on a.cust_no = pc.cust_no
         where pc.name ilike '%' || q || '%' or (d <> '' and (pc.cust_no = d or (length(d) >= 4 and pc.phone like '%' || d || '%')))
         order by (pc.cust_no = d) desc, abs(coalesce(a.total, 0)) desc, pc.name limit p_limit) x),
    'suppliers', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
        select s.sup as id, s.name, coalesce((select sum(open) from priority_supplier_aging g where g.sup = s.sup), 0) as balance
          from priority_suppliers s
         where (s.name ilike '%' || q || '%' or (d <> '' and s.sup = d))
           and (own or (s.sup ~ '^20[0-9]{4}$' and s.name !~ 'פיננס|מימון|הלווא|בעלים|חו"ז'))
         order by s.name limit p_limit) x));
end $$;
grant execute on function public.crm_account_find(text, integer) to authenticated;

create or replace function public.crm_account_list()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare own boolean := public.crm_is_owner();
begin
  if public.crm_me() is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'customers', (select coalesce(jsonb_agg(to_jsonb(x) order by x.balance desc, x.name), '[]'::jsonb) from (
        select a.cust_no as id, coalesce(pc.name, a.name) as name, pc.city, round(a.total, 2) as balance,
               round(coalesce(a.d90p, 0), 2) as old, round(coalesce(a.future, 0), 2) as future
          from priority_aging a left join priority_customers pc on pc.cust_no = a.cust_no
         where abs(coalesce(a.total, 0)) >= 0.5) x),
    'suppliers', (select coalesce(jsonb_agg(to_jsonb(x) order by (x.balance + x.cheques) desc, x.name), '[]'::jsonb) from (
        select u.sup as id, coalesce(s.name, u.nm) as name, round(u.balance, 2) as balance, round(u.late, 2) as late, round(u.cheques, 2) as cheques
          from (select sup, max(nm) as nm, sum(balance) as balance, sum(late) as late, sum(cheques) as cheques from (
                  select sup, max(sup_name) as nm, sum(open) as balance, sum(open) filter (where days_late > 0 and open > 0) as late, 0::numeric as cheques
                    from priority_supplier_aging group by sup
                  union all
                  select sup, max(sup_name), 0, 0, sum(net) from priority_supplier_checks where check_due >= current_date group by sup) z
                 group by sup) u
          left join priority_suppliers s on s.sup = u.sup
         where (abs(coalesce(u.balance, 0)) >= 0.5 or coalesce(u.cheques, 0) >= 0.5)
           and (own or (u.sup ~ '^20[0-9]{4}$' and coalesce(s.name, u.nm) !~ 'פיננס|מימון|הלווא|בעלים|חו"ז'))) x),
    'synced', (select jsonb_object_agg(key, source_at) from priority_sync where key in ('aging', 'supplier_aging', 'supplier_checks')));
end $$;
grant execute on function public.crm_account_list() to authenticated;
