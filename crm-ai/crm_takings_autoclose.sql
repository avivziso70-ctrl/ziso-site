-- Auto-close "כסף שהתקבל ומחכה לקבלה" once the receipt shows up in Priority (Aviv 17.11.2026: alerts kept nagging for
-- payments whose receipt had already been issued, because staff typed the receipt in Priority but did not press "יצאה קבלה").
-- Match: same amount, receipt dated 0-5 days after the payment (Israel date), not already used by another taking, and either
-- the Priority customer's phone (tail9) equals the payer's, or the receipt's customer name contains the payer's name.
-- Runs hourly in business hours and once by hand. Closes with closed_by = 'auto: priority' so it can be told apart. No DROP.
create or replace function public.crm_takings_autoclose() returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer := 0; t record; d text;
begin
  for t in select * from crm_takings
           where closed_at is null and cancelled_at is null and doc_no is null
             and (method <> 'card_link' or paid_at is not null)
           order by at loop
    select r.doc into d
    from priority_receipts r
    left join priority_customers c on c.cust_no = r.cust_no
    where r.amount = t.amount
      and r.date between (t.at at time zone 'Asia/Jerusalem')::date and (t.at at time zone 'Asia/Jerusalem')::date + 5
      and not exists (select 1 from crm_takings x where x.doc_no = r.doc)
      and ((t.tail9 is not null and c.tail9 = t.tail9)
           or (length(trim(coalesce(t.payer_name, ''))) >= 2 and r.cust_name ilike '%' || trim(t.payer_name) || '%'))
    order by r.date
    limit 1;
    if d is not null then
      update crm_takings set doc_no = d, closed_at = now(), closed_by = 'auto: priority' where id = t.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.crm_takings_autoclose() from public, anon, authenticated;
select cron.schedule('crm-takings-autoclose', '25 5-17 * * 0-5', 'select public.crm_takings_autoclose()');
