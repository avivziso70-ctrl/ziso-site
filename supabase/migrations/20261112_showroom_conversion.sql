-- Applied 12.11.2026. Anonymous showroom funnel per day (owner only): gate camera 11 vs Priority quotes/orders.
create or replace function public.showroom_conversion(p_days int default 14)
returns table(day date, entries int, exits int, visitors int, quote_customers int, order_customers int, order_total numeric, conversion_pct numeric, trial boolean)
language sql stable security definer set search_path = public as $$
  with d as (
    select g::date as dd
    from generate_series((now() at time zone 'Asia/Jerusalem')::date - greatest(least(p_days,90),1) + 1,
                         (now() at time zone 'Asia/Jerusalem')::date, interval '1 day') g
  ), v as (
    select vh.day as dd, sum(vh.entries)::int e, sum(vh.exits)::int x from visitors_hourly vh where vh.camera = 11 group by vh.day
  ), q as (
    select pq."date" as dd, count(distinct pq.cust_no)::int c from priority_quotes pq group by pq."date"
  ), o as (
    select po."date" as dd, count(distinct po.cust_no)::int c, sum(po.amount) s from priority_orders_all po group by po."date"
  )
  select d.dd, v.e, v.x,
         greatest(v.e, v.x),
         coalesce(q.c,0), coalesce(o.c,0), coalesce(o.s,0),
         case when greatest(v.e, v.x) > 0 then round(100.0 * coalesce(o.c,0) / greatest(v.e, v.x), 0) end,
         d.dd < date '2026-11-19'
  from d left join v using (dd) left join q using (dd) left join o using (dd)
  where public.crm_is_owner()
  order by d.dd desc
$$;
revoke all on function public.showroom_conversion(int) from public, anon;
grant execute on function public.showroom_conversion(int) to authenticated;
