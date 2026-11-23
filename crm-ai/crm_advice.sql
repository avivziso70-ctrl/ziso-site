-- Deal advisor (Aviv 19.11.2026: "ה-AI רץ ברקע בזמן כתיבת הזמנה חדשה ומחפש איך לייעל את העסקה").
-- First version: rules and comparisons over our own data, no paid model, no customer data leaves the database.
--   crm_adv_key(text)        what a product is: type | colour | sizes, or null when the text is not a known product type
--   crm_deal_advice(lines)   read only; returns raw findings, the order screen words them and decides what to show
--   crm_advice_log           what the team did with each suggestion (applied or dismissed) and the profit it added
-- Estimated prices (uploads from chat extracts) are never offered as a cheaper alternative.
-- The expression indexes at the end make the comparisons fast. After a change to crm_adv_key() the two key indexes must be rebuilt (REINDEX).
-- A comparison needs a colour or a size in the key: a bare type ("cistern") is too wide to call two products the same kind.

create table if not exists public.crm_advice_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  by text not null default public.crm_me(),
  deal_id bigint not null,
  lid text,
  kind text not null,
  key text not null,
  action text not null check (action in ('applied', 'dismissed')),
  gain numeric,
  detail jsonb
);
create index if not exists crm_advice_log_deal on public.crm_advice_log (deal_id);
alter table public.crm_advice_log enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'crm_advice_log' and policyname = 'staff read') then
    create policy "staff read" on public.crm_advice_log for select using (public.crm_me() is not null);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'crm_advice_log' and policyname = 'staff write') then
    create policy "staff write" on public.crm_advice_log for insert with check (public.crm_me() is not null and by = public.crm_me());
  end if;
end $$;
grant select, insert on public.crm_advice_log to authenticated;

create or replace function public.crm_adv_key(p text)
returns text language plpgsql immutable cost 500 as $$
declare t text := ' ' || lower(coalesce(p, '')) || ' '; ty text; col text; sz text;
begin
  if t ~ 'שדרוג|תוספת|חילוף|חלפים|הובלה|התקנה|מבצע סט' then return null; end if;
  ty := case
    when t ~ 'אסלה תלוי|אסלת תלוי|אסלה סמוי' then 'wc_hang'
    when t ~ 'מיכל הדחה|ניאגרה' then 'cistern'
    when t ~ 'לחצן' then 'plate'
    when t ~ 'מושב' then 'seat'
    when t ~ 'אסלה|אסלת' then 'wc'
    when t ~ 'אינטרפוץ' then case when t ~ '4 דרך|ארבע דרך' then 'ip4' when t ~ '3 דרך|שלוש דרך' then 'ip3' else 'ip' end
    when t ~ 'ראש מקלחת|ראש גשם' then 'head'
    when t ~ 'ברז מטבח|נשלף' then 'f_kitchen'
    when t ~ 'ברז פרח|פרח' then 'f_basin'
    when t ~ 'סוללה לאמבט|ברז אמבט' then 'f_bath'
    when t ~ 'כיור מונח' then 'sink_top'
    when t ~ 'כיור תלוי' then 'sink_wall'
    when t ~ 'כיור מטבח' then 'sink_kitchen'
    when t ~ 'מקלחון פינתי' then 'sh_corner'
    when t ~ 'מקלחון חזית' then 'sh_front'
    when t ~ 'הרמוניקה' then 'sh_fold'
    when t ~ 'אמבטיון' then 'bath_screen'
    when t ~ 'מקלחון' then 'sh'
    when t ~ 'אגנית' then 'tray'
    when t ~ 'תעלת' then 'drain'
    when t ~ 'מראה עגול' then 'mir_round'
    when t ~ 'מראה' then 'mir'
    when t ~ 'ארון תלוי' then 'cab_hang'
    when t ~ 'ארון עומד' then 'cab_stand'
    when t ~ 'סיפון' then 'siphon'
    else null end;
  if ty is null then return null; end if;
  col := concat_ws('+',
    case when t ~ 'שחור' then 'black' end, case when t ~ 'לבן' then 'white' end, case when t ~ 'ניקל' then 'nickel' end,
    case when t ~ 'כרום' then 'chrome' end, case when t ~ 'זהב' then 'gold' end, case when t ~ 'ברונז' then 'bronze' end,
    case when t ~ 'גרפיט' then 'graphite' end, case when t ~ 'אפור' then 'grey' end, case when t ~ 'נחושת' then 'copper' end,
    case when t ~ 'רוז' then 'rose' end, case when t ~ 'אלון' then 'oak' end, case when t ~ 'אגוז' then 'walnut' end,
    case when t ~ ' מט[ ,.)]' then 'matt' end, case when t ~ 'מבריק' then 'gloss' end, case when t ~ 'מוברש' then 'brushed' end);
  select string_agg(n, 'x' order by n::int) into sz from (
    select distinct m[1] as n from regexp_matches(t, '(?<![0-9.])([0-9]{2,3})(?![0-9.])', 'g') m where m[1]::int between 20 and 300 limit 3) z;
  return ty || '|' || coalesce(col, '') || '|' || coalesce(sz, '');
end $$;

create or replace function public.crm_adv_lines2(p_lines jsonb)
returns table (lid text, d text, s text, code text, pid bigint, cost numeric, sell numeric, qty numeric, locked boolean, st boolean, k text, cat text)
language sql immutable as $$
  select x->>'lid', coalesce(x->>'desc', ''), coalesce(x->>'size', ''),
         upper(regexp_replace(coalesce(x->>'sku', ''), '[\s\-./]', '', 'g')),
         case when x->>'price_id' ~ '^[0-9]+$' then (x->>'price_id')::bigint end,
         case when x->>'cost' ~ '^[0-9]+(\.[0-9]+)?$' then (x->>'cost')::numeric end,
         case when x->>'sell' ~ '^[0-9]+(\.[0-9]+)?$' then (x->>'sell')::numeric end,
         case when x->>'qty' ~ '^[0-9]+(\.[0-9]+)?$' then (x->>'qty')::numeric else 0 end,
         coalesce(x->>'so', '') <> '' or coalesce(x->>'po_no', '') <> '',
         coalesce(x->>'stock', '') = 'true',
         public.crm_adv_key(coalesce(x->>'desc', '') || ' ' || coalesce(x->>'size', '')),
         coalesce(x->>'cat', '')
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality e(x, o) where o <= 40
$$;

create or replace function public.crm_deal_advice(p_lines jsonb)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare r jsonb := '[]'::jsonb; part jsonb; alld text;
begin
  if public.crm_me() is null then raise exception 'not allowed' using errcode = '42501'; end if;
  select string_agg(d, ' | ') into alld from public.crm_adv_lines2(p_lines);
  if alld is null then return r; end if;

  -- 1. what this item usually sells for (our own invoices of the last year, including VAT)
  select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) into part from (
    select 'usual' as kind, l.lid, round((percentile_cont(0.5) within group (order by sa.line_total / sa.qty * 1.18))::numeric) as usual, count(*) as n
      from public.crm_adv_lines2(p_lines) l join priority_part_sales sa on upper(regexp_replace(sa.part_no, '[\s\-./]', '', 'g')) = l.code
     where length(l.code) >= 3 and l.code !~ '^0+$' and not l.locked and sa.qty > 0 and sa.line_total > 0 and sa.doc_type in ('invoice', 'invoice_receipt') and sa.date > current_date - 365
     group by l.lid having count(*) >= 3) z;
  r := r || part;

  -- 2. what is missing beside what is already on the order
  select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) into part from (
    select 'add' as kind, 'add:' || ru.id as key, ru.id as rule, ru.label, ru.word, t.lid, t.d as beside,
           (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from (
              select pp.part_no, pp.part_desc as "desc", pp.price, pp.unit, coalesce(sk.q, 0) as stock, coalesce(sl.n, 0) as sold,
                     (select round(case when c.vat_included then c.price / 1.18 else c.price end, 2) from sp_prices c
                       where c.status = 'active' and c.price > 0 and upper(regexp_replace(c.supplier_code, '[\s\-./]', '', 'g')) = upper(regexp_replace(pp.part_no, '[\s\-./]', '', 'g')) limit 1) as cost
                from priority_part_prices pp
                left join (select part_no, sum(qty) q from priority_stock group by 1) sk on sk.part_no = pp.part_no
                left join (select part_no, count(*) n from priority_part_sales where date > current_date - 365 and qty > 0 group by 1) sl on sl.part_no = pp.part_no
               where pp.price_list = 'בסיס כולל מע"מ' and pp.price > 0 and pp.part_desc ~ ru.pick
                 and pp.part_desc !~ ('שדרוג|תוספת|חילוף|ללא|כולל|\+' || coalesce('|' || ru.nopick, ''))
                 and (coalesce(sk.q, 0) > 0 or coalesce(sl.n, 0) > 0)
               order by (coalesce(sk.q, 0) > 0) desc, coalesce(sl.n, 0) desc, pp.price limit 3) p) as picks
      from (values
        -- id, lines of which category (null = any), what on the order calls for it, what counts as already there, label, search word, which of our parts to offer, which to leave out
        ('cistern', null, 'אסלה תלוי|אסלת תלוי|אסלה סמוי', 'מיכל הדחה|ניאגרה|מיכל סמוי', 'מיכל הדחה סמוי', 'מיכל הדחה', 'מיכל הדחה|מיכל סמוי', 'לחצן'),
        ('plate',   null, 'מיכל הדחה|ניאגרה|אסלה תלוי|אסלת תלוי', 'לחצן', 'לחצן הפעלה למיכל', 'לחצן', 'לחצן', 'מיכל'),
        ('basinf',  null, 'כיור(?! מטבח)|ארון אמבט|ארון תלוי|ארון עומד', 'ברז|פרח|סוללה', 'ברז לכיור', 'ברז פרח', 'פרח', 'אינטרפוץ|מטבח'),
        ('siphon',  null, 'כיור(?! מטבח)|ארון אמבט|ארון תלוי|ארון עומד', 'סיפון', 'סיפון לכיור', 'סיפון', 'סיפון', 'אמבט|מטבח'),
        ('mirror',  null, 'ארון אמבט|ארון תלוי|ארון עומד', 'מראה', 'מראה מעל הארון', 'מראה', 'מראה', 'ארון'),
        ('showerf', null, 'מקלחון|אגנית|הרמוניקה', 'אינטרפוץ|מוט|ראש מקלחת|ראש גשם|מזלף|סוללה', 'ברז ומוט למקלחת', 'אינטרפוץ', 'אינטרפוץ', null),
        ('drain',   null, 'אגנית', 'תעלת|ניקוז', 'תעלת ניקוז', 'תעלת ניקוז', 'תעלת', null),
        ('glue',    'tiles', 'אריח|ריצוף|חיפוי|פורצלן|[0-9]{2,3} ?[/x*] ?[0-9]{2,3}', 'דבק', 'דבק לאריחים', 'דבק', '(^| )דבק( |$)', 'נייר|סיליקון'),
        ('grout',   'tiles', 'אריח|ריצוף|חיפוי|פורצלן|[0-9]{2,3} ?[/x*] ?[0-9]{2,3}', 'רובה', 'רובה', 'רובה', 'רובה', null),
        ('profile', 'tiles', 'אריח|חיפוי|פורצלן|[0-9]{2,3} ?[/x*] ?[0-9]{2,3}', 'פרופיל|פינת', 'פרופיל גמר לפינות', 'פרופיל', '^ *פרופיל', 'מקלחון|מראה|ארון'),
        ('skirt',   'tiles', 'פרקט', 'פנל|שיפול|סף ', 'פנלים וספים לפרקט', 'פנל', 'פנל|שיפול', null)
      ) as ru(id, cat, trig, have, label, word, pick, nopick)
      cross join lateral (select l.lid, l.d from public.crm_adv_lines2(p_lines) l where (l.d || ' ' || l.s) ~ ru.trig and l.d !~ 'תוספת|שדרוג|חילוף' and (ru.cat is null or l.cat = ru.cat) and not l.locked limit 1) t
     where alld !~ ru.have) z;
  r := r || part;

  -- 3. the same kind of product (type, colour, size) from a price list at a lower cost
  select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) into part from (
    select 'alt' as kind, l.lid, c.id as price_id, c.description as "desc", c.size, c.unit, c.supplier_id, c.supplier_code as sku, c.image_path, c.cost, c.page_ref
      from (select * from public.crm_adv_lines2(p_lines) where k is not null and k !~ '\|\|$' and pid is not null and cost > 0 and not locked limit 12) l
      cross join lateral (
        select c.id, c.description, c.size, c.unit, c.supplier_id, c.supplier_code, c.image_path, c.page_ref, round(case when c.vat_included then c.price / 1.18 else c.price end, 2) as cost
          from sp_prices c
         where c.status = 'active' and c.price > 0 and coalesce(c.currency, 'ILS') = 'ILS' and c.id <> l.pid
           and (case when c.vat_included then c.price / 1.18 else c.price end) between l.cost * 0.45 and l.cost * 0.88
           and not exists (select 1 from sp_uploads su where su.id = c.upload_id and su.source = 'chat-extract')
           and public.crm_adv_key(coalesce(c.description, '') || ' ' || coalesce(c.size, '')) = l.k
         order by (case when c.vat_included then c.price / 1.18 else c.price end) limit 1) c) z;
  r := r || part;

  -- 4. the same kind of product standing in our warehouse, when the chosen one is not in stock
  select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) into part from (
    select 'stock' as kind, l.lid, c.part_no, c.part_desc as "desc", c.q as stock, c.price, c.unit, c.last_sale,
           (select round(case when p.vat_included then p.price / 1.18 else p.price end, 2) from sp_prices p
             where p.status = 'active' and p.price > 0 and upper(regexp_replace(p.supplier_code, '[\s\-./]', '', 'g')) = upper(regexp_replace(c.part_no, '[\s\-./]', '', 'g')) limit 1) as cost,
           (c.last_sale is null or c.last_sale < current_date - 180) as slow
      from (select * from public.crm_adv_lines2(p_lines) where k is not null and k !~ '\|\|$' and not locked and not st limit 12) l
      cross join lateral (
        select sk.part_no, sk.part_desc, sk.q, pp.price, pp.unit, (select max(date) from priority_part_sales sa where sa.part_no = sk.part_no and sa.qty > 0) as last_sale
          from (select s1.part_no, max(s1.part_desc) part_desc, sum(s1.qty) q from priority_stock s1 where s1.qty > 0 and public.crm_adv_key(s1.part_desc) = l.k group by 1) sk
          join priority_part_prices pp on pp.part_no = sk.part_no and pp.price_list = 'בסיס כולל מע"מ' and pp.price > 0
         where sk.q >= greatest(l.qty, 1) and upper(regexp_replace(sk.part_no, '[\s\-./]', '', 'g')) <> l.code
         order by 6 nulls first limit 1) c
     where not exists (select 1 from priority_stock s2 where upper(regexp_replace(s2.part_no, '[\s\-./]', '', 'g')) = l.code and length(l.code) >= 3 and s2.qty > 0)) z;
  r := r || part;
  return r;
end $$;
grant execute on function public.crm_deal_advice(jsonb) to authenticated;

create index if not exists sp_prices_adv_key on public.sp_prices (public.crm_adv_key(coalesce(description, '') || ' ' || coalesce(size, ''))) where status = 'active';
create index if not exists priority_stock_adv_key on public.priority_stock (public.crm_adv_key(part_desc)) where qty > 0;
create index if not exists sp_prices_code_norm on public.sp_prices (upper(regexp_replace(supplier_code, '[\s\-./]', '', 'g'))) where status = 'active';
