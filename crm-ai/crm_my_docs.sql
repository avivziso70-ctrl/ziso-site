-- The customer downloads the PDF of their own receipts and invoices from their page (Aviv 17.11.2026: "שהלקוח יוכל להוריד pdf לבד").
-- PDFs are Priority's own documents, made by the office robot (crm_doc_requests -> priority_jobs print_document -> crm_docs,
-- private bucket priority-docs). A customer gets only documents of the Priority customer behind their link.
-- Originals: Aviv 17.11 10:17Z in this thread, "אני מאשר להדפיס את המקור תמיד". Page requests pass allow_original with that approval;
-- the CRM office print (crm_print_job) carries the same approval_msg.
-- Entry point: edge function crm-my-doc (service role) signs a 5-minute link. The functions here are not open to anon.
-- No DROP in this file.

create or replace function public.crm_doc_requests_enqueue() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status <> 'queued' then return new; end if;
  insert into public.priority_jobs (type, params, requested_by, priority, idempotency_key, crm_doc_request_id, approval_msg)
  values ('print_document',
          jsonb_build_object('doc', new.doc, 'kind', new.kind, 'tail9', new.tail9, 'allow_original', new.requested_by = 'customer-page'),
          'crm:' || new.requested_by, case when new.requested_by = 'customer-page' then 4 else 3 end, 'crm_doc:' || new.id, new.id,
          case when new.requested_by = 'customer-page' then 'Aviv 17.11 10:17Z in the CRM builder thread (cmsg_015WfBHagqpBzbKTebtDJ3B5CXPLGXTKt6ptaPqu73x4Ku): "אני מאשר להדפיס את המקור תמיד"' end);
  return new;
end $$;

-- state: ready (path to sign) | pending (the robot is making it) | unavailable (cannot be made automatically) | error codes of the gate
create or replace function public.crm_my_doc(p_token text, p_pin text, p_doc text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare g record; d crm_deals; v_cust text; v_kind text; v_path text; r crm_doc_requests;
begin
  select * into g from crm_my_gate(p_token, p_pin);
  if g.err is not null then return jsonb_build_object('ok', false, 'error', g.err); end if;
  select * into d from crm_deals where id = g.deal_id;
  v_cust := coalesce(d.cust_no,
    (select c.priority_cust_no from crm_customers c where c.tail9 = d.customer_tail9 and c.deleted_at is null and c.priority_cust_no is not null limit 1),
    (select min(pc.cust_no) from priority_customers pc where pc.tail9 = d.customer_tail9 having count(*) = 1));
  if v_cust is null or p_doc is null or p_doc !~ '^[A-Z]{2}[0-9]{6,12}$' or p_doc like 'ON%' then return jsonb_build_object('ok', false, 'error', 'doc'); end if;
  if exists (select 1 from priority_receipts where doc = p_doc and cust_no = v_cust) then v_kind := 'receipt';
  elsif exists (select 1 from priority_invoices where doc = p_doc and cust_no = v_cust) then v_kind := 'invoice';
  else return jsonb_build_object('ok', false, 'error', 'doc'); end if;

  select path into v_path from crm_docs where doc = p_doc and (cust_no is null or cust_no = v_cust);
  if v_path is not null then return jsonb_build_object('ok', true, 'state', 'ready', 'path', v_path, 'kind', v_kind); end if;

  select * into r from crm_doc_requests where doc = p_doc order by id desc limit 1;
  if r.id is not null and r.status = 'queued' and r.requested_at > now() - interval '2 hours' then
    return jsonb_build_object('ok', true, 'state', 'pending');
  end if;
  if r.id is not null and r.status in ('skipped', 'failed') and r.requested_at > now() - interval '6 hours' then
    return jsonb_build_object('ok', true, 'state', 'unavailable');
  end if;
  insert into crm_doc_requests (doc, kind, tail9, requested_by, channel, note)
  values (p_doc, v_kind, d.customer_tail9, 'customer-page', 'crm', 'הלקוח ביקש PDF מהדף שלו · ' || d.deal_no);
  return jsonb_build_object('ok', true, 'state', 'pending');
end $$;
revoke all on function public.crm_my_doc(text, text, text) from public, anon, authenticated;

-- Make the PDFs ahead of time for customers who have a live page, so a download is instant.
create or replace function public.crm_my_docs_prefetch() returns int
language plpgsql security definer set search_path to 'public' as $$
declare n int := 0; x record;
begin
  for x in
    select distinct on (t.doc) t.doc, t.kind, dl.customer_tail9 as tail9, dl.deal_no
    from crm_deals dl
    join lateral (
      select r.doc, 'receipt' as kind from priority_receipts r where r.cust_no = dl.cust_no and r.date >= current_date - 400
      union all
      select i.doc, 'invoice' from priority_invoices i where i.cust_no = dl.cust_no and i.date >= current_date - 400 and i.doc not like 'ON%'
    ) t on true
    where dl.share_token is not null and dl.priority_sync and dl.cust_no is not null
      and not exists (select 1 from crm_docs c where c.doc = t.doc)
      and not exists (select 1 from crm_doc_requests q where q.doc = t.doc and (q.status = 'queued' or q.requested_at > now() - interval '1 day'))
    limit 10
  loop
    insert into crm_doc_requests (doc, kind, tail9, requested_by, channel, note)
    values (x.doc, x.kind, x.tail9, 'customer-page', 'crm', 'הכנה מראש לדף הלקוח · ' || x.deal_no);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.crm_my_docs_prefetch() from public, anon, authenticated;
select cron.schedule('crm-my-docs-prefetch', '*/15 * * * *', 'select public.crm_my_docs_prefetch()');

create or replace function public.crm_print_job(p_id bigint) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare r record; j uuid;
begin
  select * into r from crm_print_requests where id = p_id and status = 'queued' and job_id is null;
  if not found then return null; end if;
  insert into priority_jobs (type, params, requested_by, priority, idempotency_key, approval_msg)
  values ('print_document',
          jsonb_build_object('doc', r.doc, 'kind', r.kind, 'print_to', r.printer, 'copies', r.copies, 'allow_original', true, 'print_request_id', r.id),
          'crm-print:' || r.requested_by, 2, 'crm_print:' || r.id, 'Aviv 17.11 10:17Z in the CRM builder thread (cmsg_015WfBHagqpBzbKTebtDJ3B5CXPLGXTKt6ptaPqu73x4Ku): "אני מאשר להדפיס את המקור תמיד"')
  returning id into j;
  update crm_print_requests set job_id = j, note = null where id = r.id;
  return j;
end $$;
