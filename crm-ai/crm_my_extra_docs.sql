-- Older documents on the customer's page (Aviv 26.11.2026, a customer asked for the document of a transfer from 28.12.2025).
-- priority_receipts and priority_invoices hold 2026 only, so a document from before 1.1.2026 never showed on /my and its
-- PDF could not be downloaded. A row here adds ONE verified Priority document to its customer's page: the list, the PDF
-- download (crm_my_doc) and the nightly preparation (crm_my_docs_prefetch) read it beside the synced tables.
-- Add a row only after the document, its customer number, date and amount were checked in Priority data. No DROP here.

create table if not exists public.crm_my_extra_docs (
  doc text primary key check (doc ~ '^[A-Z]{2}[0-9]{6,12}$'),
  kind text not null check (kind in ('receipt', 'invoice')),
  cust_no text not null,
  date date not null,
  amount numeric not null,
  method text,
  note text,
  added_at timestamptz not null default now(),
  added_by text not null default coalesce(public.crm_me(), 'system')
);
alter table public.crm_my_extra_docs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'crm_my_extra_docs' and policyname = 'staff read') then
    create policy "staff read" on public.crm_my_extra_docs for select using (public.crm_me() is not null);
  end if;
end $$;

-- the three readers, patched in place (each step fails loudly if its text is not found)
do $$
declare d text; n text;
  rc text := '(select doc, date, amount, method, cust_no from priority_receipts union all select doc, date, amount, method, cust_no from crm_my_extra_docs where kind = ''receipt'')';
  iv text := '(select doc, date, amount, cust_no from priority_invoices union all select doc, date, amount, cust_no from crm_my_extra_docs where kind = ''invoice'')';
begin
  d := pg_get_functiondef('public.crm_my(text,text)'::regprocedure);
  if d not like '%crm_my_extra_docs%' then
    n := replace(d, 'from priority_receipts r where r.cust_no = v_cust', 'from ' || rc || ' r where r.cust_no = v_cust');
    if n = d then raise exception 'crm_my receipts'; end if; d := n;
    n := replace(d, 'from priority_invoices i where i.cust_no = v_cust', 'from ' || iv || ' i where i.cust_no = v_cust');
    if n = d then raise exception 'crm_my invoices'; end if;
    execute n;
  end if;

  d := pg_get_functiondef('public.crm_my_doc(text,text,text)'::regprocedure);
  if d not like '%crm_my_extra_docs%' then
    n := replace(d, 'from priority_receipts where doc = p_doc and cust_no = v_cust', 'from ' || rc || ' q where doc = p_doc and cust_no = v_cust');
    if n = d then raise exception 'crm_my_doc receipts'; end if; d := n;
    n := replace(d, 'from priority_invoices where doc = p_doc and cust_no = v_cust', 'from ' || iv || ' q where doc = p_doc and cust_no = v_cust');
    if n = d then raise exception 'crm_my_doc invoices'; end if;
    execute n;
  end if;

  d := pg_get_functiondef('public.crm_my_docs_prefetch()'::regprocedure);
  if d not like '%crm_my_extra_docs%' then
    n := replace(d, 'from priority_receipts r where r.cust_no = dl.cust_no', 'from ' || rc || ' r where r.cust_no = dl.cust_no');
    if n = d then raise exception 'prefetch receipts'; end if; d := n;
    n := replace(d, 'from priority_invoices i where i.cust_no = dl.cust_no', 'from ' || iv || ' i where i.cust_no = dl.cust_no');
    if n = d then raise exception 'prefetch invoices'; end if;
    execute n;
  end if;
end $$;
