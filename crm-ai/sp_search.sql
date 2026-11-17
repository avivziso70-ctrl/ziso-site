-- Smart SKU search for the staff (Aviv 17.11.2026: "שהתהליך של איתור המקט יהיה הכי קל בעולם").
-- One search for the supplier price list page (crm/prices.html) and the order page (crm/order.html).
-- What it forgives: typos (nearest word in the catalogs), plural/singular, ה/ל/ב before a word, final letters,
-- quotes, 60/120 = 120x60 = "60 על 120", a code typed with or without dashes, a keyboard left on the wrong language,
-- a width that falls inside a shower's range (78 finds 76-79), and synonyms (sp_search_syn).
-- Results come best match first (exact code, then real products before upgrade lines, then price).
-- Additive only, no DROP. Staff only: every entry point checks crm_me().

create extension if not exists fuzzystrmatch with schema extensions;

-- ---------- text normalisation (same function for the catalog text and for what the staff type) ----------
create or replace function public.sp_norm(t text) returns text
language sql immutable parallel safe as $$
  select btrim(replace(regexp_replace(
    translate(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(coalesce(t, '')), '["''`׳״´’‘“”]', '', 'g'),
          '(\d)\s*(?:x|×|\*|/|\\|על)\s*(?=\d)', '\1x', 'g'),
        '(\d)\.(?=\d)', '\1~', 'g'),
      'םןץףך', 'מנצפכ'),
    '[^a-z0-9א-ת~]+', ' ', 'g'), '~', '.'))
$$;

-- product group, the same rule as classify() in crm/order.html: the keyword that comes first wins
create or replace function public.sp_grp(t text) returns text
language plpgsql immutable parallel safe as $$
declare
  s text := lower(coalesce(t, '')); best text := 'other'; at int := 1000000; p int; i int;
  k text[] := array['cabinets', 'showers', 'mirrors', 'sanitary', 'faucets', 'tiles', 'acc'];
  r text[] := array[
    'ארון|ארונות|מזנון|כוורת|קונסול',
    'מקלחון|דלת מקלחת|ויטרינ|קיר זכוכית|מחיצת',
    'מראה|מראות',
    'אסל|כיור|מיכל הדחה|ביד[הו ]|משתנ|אמבט|ג''?קוזי|מושב|wc',
    'ברז|סוללה|מערבל|ראש מקלחת|מוט מקלחת|זרוע|פרח|גוף פנימי|מזלף|שלאוך|צינור',
    'אריח|ריצוף|חיפוי|פורצלן|גרניט|פסיפס|פרקט|ספים|שיש|דק |\d{2,3}\s*[/x*]\s*\d{2,3}',
    'מתקן|מחזיק|מתלה|סבון|נייר|מגבת|פח|מברשת|וו|מדף|אביזר|ניקוז|סיפון|תעלה|קולטן|ידית|כפתור|חבק'];
begin
  for i in 1..7 loop
    p := regexp_instr(s, r[i]);
    if p > 0 and p < at then at := p; best := k[i]; end if;
  end loop;
  return best;
end $$;

-- ---------- the search index: one row per price row, kept by a trigger ----------
create table if not exists public.sp_search_doc (
  price_id bigint primary key references public.sp_prices(id) on delete cascade,
  supplier_id uuid,
  txt text not null,
  code_key text,
  grp text not null default 'other',
  extra boolean not null default false,   -- upgrade / add-on / service line, shown after real products
  rlo int[], rhi int[]                    -- size ranges such as 76-79 (adjustable showers)
);
alter table public.sp_search_doc enable row level security;   -- no policies: only the functions below read it

create table if not exists public.sp_search_words (word text primary key, n int not null);
alter table public.sp_search_words enable row level security;

create table if not exists public.sp_search_syn (term text not null, alt text not null, primary key (term, alt));
alter table public.sp_search_syn enable row level security;

create or replace function public.sp_search_put(p_id bigint, p_sup uuid, p_code text, p_desc text, p_size text, p_cat text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare lo int[]; hi int[]; ck text;
begin
  select array_agg(a), array_agg(b) into lo, hi from (
    select floor(m[1]::numeric)::int a, ceil(m[2]::numeric)::int b
    from regexp_matches(coalesce(p_size, '') || ' ' || coalesce(p_desc, ''), '(\d{2,3}(?:\.\d+)?)\s*[-–]\s*(\d{2,3}(?:\.\d+)?)', 'g') m
  ) x where b > a and b - a <= 45;
  ck := nullif(translate(regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9א-ת]', '', 'g'), 'םןץףך', 'מנצפכ'), '');
  insert into sp_search_doc (price_id, supplier_id, txt, code_key, grp, extra, rlo, rhi)
  values (p_id, p_sup,
          btrim(sp_norm(coalesce(p_desc, '') || ' ' || coalesce(p_size, '') || ' ' || coalesce(p_cat, '') || ' ' || coalesce(p_code, '')) || ' ' || coalesce(ck, '')),
          ck, sp_grp(coalesce(p_desc, '') || ' ' || coalesce(p_size, '') || ' ' || coalesce(p_cat, '')),
          coalesce(p_desc, '') ~ 'שדרוג|תוספת|התקנה|הובלה|מדידה', lo, hi)
  on conflict (price_id) do update set supplier_id = excluded.supplier_id, txt = excluded.txt, code_key = excluded.code_key,
    grp = excluded.grp, extra = excluded.extra, rlo = excluded.rlo, rhi = excluded.rhi;
end $$;
revoke all on function public.sp_search_put(bigint, uuid, text, text, text, text) from public, anon, authenticated;

-- the index must never block a price-list upload: any error here is swallowed
create or replace function public.sp_search_doc_trg() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  begin
    perform sp_search_put(new.id, new.supplier_id, new.supplier_code, new.description, new.size, new.category);
  exception when others then null;
  end;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'sp_prices_search_doc') then
    create trigger sp_prices_search_doc after insert or update of description, size, category, supplier_code, supplier_id
      on public.sp_prices for each row execute function public.sp_search_doc_trg();
  end if;
end $$;

-- vocabulary for typo correction: every word of the active catalogs and of the supplier names
create or replace function public.sp_search_reindex() returns int
language plpgsql security definer set search_path to 'public' as $$
begin
  perform sp_search_put(p.id, p.supplier_id, p.supplier_code, p.description, p.size, p.category)
    from sp_prices p where not exists (select 1 from sp_search_doc d where d.price_id = p.id);
  update sp_search_words set n = 0 where n <> 0;
  insert into sp_search_words (word, n)
    select w, count(*)::int from (
      select unnest(string_to_array(d.txt, ' ')) w from sp_search_doc d join sp_prices p on p.id = d.price_id where p.status = 'active'
      union all
      select unnest(string_to_array(sp_norm(s.name), ' ')) from sp_suppliers s where s.id in (select supplier_id from sp_prices where status = 'active')
    ) x where w ~ '^([a-z]{3,}|[א-ת]{3,})$' group by 1
    on conflict (word) do update set n = excluded.n;
  return (select count(*) from sp_search_words where n > 0);
end $$;
revoke all on function public.sp_search_reindex() from public, anon, authenticated;

-- a keyboard left on the other language: "crz" is "ברז", "צפ1009" is "mp1009"
create or replace function public.sp_kbd(q text) returns text
language sql immutable as $$
  select case
    when q ~ '[א-ת]' and q !~* '[a-z]' then translate(q, 'קראטוןםפשדגכעיחלךףזסבהנמצתץ', 'ertyuiopasdfghjkl;zxcvbnm,.')
    when q ~* '[a-z]' and q !~ '[א-ת]' then translate(lower(q), 'qwertyuiopasdfghjkl;zxcvbnm,./', '/''קראטוןםפשדגכעיחלךףזסבהנמצתץ.')
    else null end
$$;

-- ---------- one search pass ----------
create or replace function public.sp_search_run(p_q text, p_sup uuid[], p_grp text, p_limit int, p_sort text, p_priced boolean, p_partial boolean)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $$
declare
  toks text[]; t text; stem text; vars text[]; cand text[]; rx text; sups uuid[]; num int; parts text[]; maxd int;
  hits text[] := '{}'; quality text[] := '{}'; codes text[] := '{}'; terms text[] := '{}'; fixes jsonb := '[]';
  lead text := 'false'; h text; nq text; supf uuid[]; srec record; k text; n int := 0; need int; qkey text; has_extra boolean; base text; sql text; res jsonb; code_expr text;
begin
  -- a supplier named by its two-word name ("טופ בט ברז") narrows the search to that supplier
  nq := ' ' || sp_norm(p_q) || ' ';
  for srec in select s.id, sp_norm(s.name) nn from sp_suppliers s where s.id in (select supplier_id from sp_prices where status = 'active') loop
    k := array_to_string((string_to_array(srec.nn, ' '))[1:2], ' ');
    if k like '% %' and position(' ' || k || ' ' in nq) > 0 then
      nq := replace(nq, ' ' || k || ' ', ' '); supf := supf || srec.id;
    end if;
  end loop;
  toks := array(select w from (select w, min(o) o from unnest(string_to_array(btrim(nq), ' ')) with ordinality u(w, o)
                where w <> '' and (length(w) > 1 or w ~ '^\d$') and w not in ('של', 'עמ', 'את', 'או', 'גמ', 'סמ', 'cm', 'מקט', 'מקטימ') group by w) z
                order by o limit 7);
  n := coalesce(array_length(toks, 1), 0);
  if n = 0 and p_sup is null and p_grp is null and supf is null then
    return jsonb_build_object('total', 0, 'n', 0, 'matched', 0, 'fixes', '[]'::jsonb, 'terms', '[]'::jsonb, 'sups', '[]'::jsonb, 'grps', '[]'::jsonb, 'rows', '[]'::jsonb);
  end if;
  qkey := translate(regexp_replace(lower(coalesce(p_q, '')), '[^a-z0-9א-ת]', '', 'g'), 'םןץףך', 'מנצפכ');
  has_extra := sp_norm(p_q) ~ 'שדרוג|תוספת|התקנ|הובל|מדיד';

  foreach t in array coalesce(toks, '{}') loop
    vars := '{}'; rx := null; sups := null; num := null; stem := t;
    if t ~ '^\d+(\.\d+)?$' then
      rx := '(^|[^0-9.])' || replace(t, '.', '\.') || '([^0-9]|$)';
      if t ~ '^\d{2,3}$' and t::int between 20 and 300 then num := t::int; end if;
      terms := terms || t;
    elsif t ~ '^\d+(\.\d+)?(x\d+(\.\d+)?)+$' then
      parts := string_to_array(t, 'x');
      rx := '(^|[^0-9.])(' || replace(t, '.', '\.') || '|' || replace(array_to_string(array(select x from unnest(parts) with ordinality u(x, o) order by o desc), 'x'), '.', '\.') || ')([^0-9]|$)';
      terms := terms || t || array_to_string(array(select x from unnest(parts) with ordinality u(x, o) order by o desc), 'x');
    else
      -- plural and feminine endings: מראות/מראה/מראת, ארונות/ארון, תלויה/תלוי, שחורה/שחור
      if t ~ '^[א-ת]+$' then
        if length(t) >= 5 and t ~ '(ימ|ות)$' then stem := left(t, length(t) - 2);
        elsif length(t) >= 4 and t ~ '[הת]$' then stem := left(t, length(t) - 1);
        end if;
      end if;
      vars := array[stem] || array(select alt from sp_search_syn where term in (t, stem));
      if length(stem) >= 2 then
        select array_agg(s.id) into sups from sp_suppliers s
          where sp_norm(s.name) like any (array(select '%' || x || '%' from unnest(vars) x)) and s.id in (select supplier_id from sp_prices where status = 'active');
      end if;
      -- a word that appears nowhere: the same word without ה/ל/ב..., or the nearest word in the catalogs
      if sups is null and not exists (select 1 from sp_search_doc d where d.txt like any (array(select '%' || x || '%' from unnest(vars) x))) then
        cand := '{}';
        if t ~ '\d' then
          if length(t) >= 5 then
            cand := array(select distinct d.code_key from sp_search_doc d
                          where d.code_key is not null and abs(length(d.code_key) - length(t)) <= 1 and levenshtein_less_equal(d.code_key, t, 1) <= 1 limit 3);
          end if;
        elsif length(stem) >= 4 and stem ~ '^[הובלמשכ]' and exists (select 1 from sp_search_doc d where d.txt like '%' || substr(stem, 2) || '%') then
          vars := array[substr(stem, 2)];
          select array_agg(s.id) into sups from sp_suppliers s
            where sp_norm(s.name) like '%' || substr(stem, 2) || '%' and s.id in (select supplier_id from sp_prices where status = 'active');
        else
          maxd := case when length(stem) >= 6 then 2 when length(stem) >= 4 then 1 else 0 end;
          if maxd > 0 then
            cand := array(select word from (
                select w.word, levenshtein(w.word, stem) dist, w.n from sp_search_words w
                where w.n > 0 and abs(length(w.word) - length(stem)) <= maxd and levenshtein_less_equal(w.word, stem, maxd) <= maxd) z
              order by z.dist, z.n desc limit 2);
          end if;
        end if;
        if coalesce(array_length(cand, 1), 0) > 0 then
          vars := cand; fixes := fixes || jsonb_build_object('from', t, 'to', cand[1]);
          select array_agg(s.id) into sups from sp_suppliers s
            where sp_norm(s.name) like '%' || cand[1] || '%' and s.id in (select supplier_id from sp_prices where status = 'active');
        end if;
      end if;
      terms := terms || vars;
      if t ~ '\d' and length(t) >= 3 then codes := codes || t; end if;
    end if;

    h := '(false';
    if coalesce(array_length(vars, 1), 0) > 0 then
      -- the closest-match pass counts a word only where a word starts, so a fragment inside another word does not win
      if p_partial then h := h || format(' or (%L || d.txt) like any (%L::text[])', ' ', array(select '% ' || x || '%' from unnest(vars) x));
      else h := h || format(' or d.txt like any (%L::text[])', array(select '%' || x || '%' from unnest(vars) x)); end if;
      quality := quality || format('((%L || d.txt) like any (%L::text[]))::int', ' ', array(select '% ' || x || '%' from unnest(vars) x));
      quality := quality || format('((%L || d.txt || %L) like %L)::int', ' ', ' ', '% ' || t || ' %');   -- the word exactly as typed
      lead := lead || format(' or d.txt like any (%L::text[])', array(select x || '%' from unnest(vars) x));   -- the row starts with a searched word: the product itself, not its accessory
    end if;
    if rx is not null then
      h := h || format(' or d.txt ~ %L', rx);
      quality := quality || format('(d.txt ~ %L)::int', rx);
    end if;
    if num is not null then
      h := h || format(' or (d.rlo is not null and exists (select 1 from unnest(d.rlo, d.rhi) r(a, b) where %s between r.a and r.b))', num);
    end if;
    if sups is not null then h := h || format(' or d.supplier_id = any (%L::uuid[])', sups); end if;
    hits := hits || (h || ')');
  end loop;

  need := case when n = 0 then 0 when p_partial then greatest(1, ceil(n / 2.0)::int) else n end;
  base := 'p.status = ''active''' || case when p_priced then ' and p.price is not null and coalesce(p.currency, ''ILS'') = ''ILS''' else '' end;
  if supf is not null then base := base || format(' and d.supplier_id = any (%L::uuid[])', supf); end if;
  code_expr := case when length(qkey) >= 3 or coalesce(array_length(codes, 1), 0) > 0 then
    format('case when d.code_key is null then 0 when d.code_key = %L or d.code_key = any (%L::text[]) then 3 when %L <> '''' and d.code_key like %L then 2 when d.code_key like any (%L::text[]) then 1 else 0 end',
           qkey, codes, case when length(qkey) >= 3 then qkey else '' end, qkey || '%', array(select x || '%' from unnest(codes) x))
    else '0' end;

  sql := 'with c as (select d.price_id, ' || case when n = 0 then '0' else array_to_string(array(select x || '::int' from unnest(hits) x), ' + ') end || ' as m
      from sp_search_doc d join sp_prices p on p.id = d.price_id
      where ' || base || case when n = 0 then '' else ' and (' || array_to_string(hits, ' or ') || ')' end || '),
    b as (select coalesce(max(m), 0) mm from c),
    hit as (select c.price_id from c, b where c.m = b.mm and b.mm >= $1),
    f as (select d.price_id, d.supplier_id, d.grp from hit join sp_search_doc d using (price_id)),
    used as (select (l ->> ''price_id'')::bigint pid, count(*) k from crm_deals dl, jsonb_array_elements(dl.lines) l
             where dl.updated_at > now() - interval ''180 days'' and (l ->> ''price_id'') ~ ''^\d+$'' group by 1),
    r as (select p.id, p.supplier_id, p.supplier_code, p.description, p.size, p.unit, p.price, p.list_price, p.currency, p.vat_included,
                 p.category, p.created_at, p.image_path, d.grp,
                 row_number() over (order by ' ||
      case when p_sort = 'cheap' then '(d.extra and not $5), p.price asc nulls last, p.id'
           else '(' || code_expr || ') desc, (d.extra and not $5), (' || case when coalesce(array_length(quality, 1), 0) = 0 then '0' else array_to_string(quality, ' + ') end || ') desc, (' || lead || ') desc, (p.price is null), coalesce(u.k, 0) desc, p.price asc nulls last, p.id' end || ') rn
          from hit join sp_search_doc d using (price_id) join sp_prices p on p.id = d.price_id left join used u on u.pid = p.id
          where ($2::uuid[] is null or d.supplier_id = any ($2)) and ($3::text is null or d.grp = $3))
    select jsonb_build_object(
      ''total'', (select count(*) from f),
      ''shown'', (select count(*) from r),
      ''matched'', (select mm from b),
      ''sups'', (select coalesce(jsonb_agg(jsonb_build_object(''id'', supplier_id, ''n'', k) order by k desc), ''[]''::jsonb)
                 from (select supplier_id, count(*) k from f where ($3::text is null or grp = $3) group by 1) s),
      ''grps'', (select coalesce(jsonb_agg(jsonb_build_object(''g'', grp, ''n'', k) order by k desc), ''[]''::jsonb)
                 from (select grp, count(*) k from f where ($2::uuid[] is null or supplier_id = any ($2)) group by 1) g),
      ''rows'', (select coalesce(jsonb_agg(to_jsonb(r) - ''rn'' order by rn), ''[]''::jsonb) from r where rn <= $4))';
  execute sql into res using need, p_sup, p_grp, least(greatest(coalesce(p_limit, 60), 1), 300), has_extra;
  return res || jsonb_build_object('n', n, 'fixes', fixes, 'terms', to_jsonb(terms));
end $$;
revoke all on function public.sp_search_run(text, uuid[], text, int, text, boolean, boolean) from public, anon, authenticated;

-- ---------- the whole search: exact pass, wrong-keyboard pass, then the closest partial match ----------
create or replace function public.sp_search_any(p_q text, p_sup uuid[], p_grp text, p_limit int, p_sort text, p_priced boolean)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $$
declare r jsonb; r2 jsonb; alt text;
begin
  p_q := left(coalesce(p_q, ''), 200);
  r := sp_search_run(p_q, p_sup, p_grp, p_limit, p_sort, p_priced, false);
  if (r ->> 'n')::int = 0 then return r; end if;
  if (r ->> 'total')::int = 0 or jsonb_array_length(r -> 'fixes') > 0 then
    alt := sp_kbd(p_q);
    if alt is not null then
      r2 := sp_search_run(alt, p_sup, p_grp, p_limit, p_sort, p_priced, false);
      if (r2 ->> 'total')::int > 0 and jsonb_array_length(r2 -> 'fixes') = 0 then return r2 || jsonb_build_object('kbd', alt); end if;
    end if;
  end if;
  if (r ->> 'total')::int > 0 then return r; end if;
  r := sp_search_run(p_q, p_sup, p_grp, p_limit, p_sort, p_priced, true);
  if (r ->> 'total')::int > 0 then return r || jsonb_build_object('partial', (r ->> 'matched')::int < (r ->> 'n')::int); end if;
  if alt is not null then
    r2 := sp_search_run(alt, p_sup, p_grp, p_limit, p_sort, p_priced, true);
    if (r2 ->> 'total')::int > 0 then return r2 || jsonb_build_object('kbd', alt, 'partial', (r2 ->> 'matched')::int < (r2 ->> 'n')::int); end if;
  end if;
  return r;
end $$;
revoke all on function public.sp_search_any(text, uuid[], text, int, text, boolean) from public, anon, authenticated;

-- entry point for the pages. p_ids: return these rows as they are (the "picked lately" list of a device).
create or replace function public.sp_search(p_q text default '', p_sup uuid[] default null, p_grp text default null, p_limit int default 60,
                                            p_sort text default 'best', p_priced boolean default false, p_ids bigint[] default null)
returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions' as $$
begin
  if public.crm_me() is null then return jsonb_build_object('error', 'staff only', 'total', 0, 'rows', '[]'::jsonb); end if;
  if p_ids is not null then
    return jsonb_build_object('total', coalesce(array_length(p_ids, 1), 0), 'n', 0, 'rows', (
      select coalesce(jsonb_agg(to_jsonb(x) - 'o' order by o), '[]'::jsonb) from (
        select p.id, p.supplier_id, p.supplier_code, p.description, p.size, p.unit, p.price, p.list_price, p.currency, p.vat_included,
               p.category, p.created_at, p.image_path, d.grp, u.o
        from unnest(p_ids[1:30]) with ordinality u(id, o) join sp_prices p on p.id = u.id and p.status = 'active'
        left join sp_search_doc d on d.price_id = p.id
        where not p_priced or (p.price is not null and coalesce(p.currency, 'ILS') = 'ILS')) x));
  end if;
  -- nothing asked yet: only the counts per supplier and per product group, for the filter buttons
  if btrim(coalesce(p_q, '')) = '' and p_sup is null and nullif(p_grp, 'all') is null then
    return (with f as (select d.supplier_id, d.grp from sp_search_doc d join sp_prices p on p.id = d.price_id
                       where p.status = 'active' and (not p_priced or (p.price is not null and coalesce(p.currency, 'ILS') = 'ILS')))
      select jsonb_build_object('total', 0, 'shown', 0, 'n', 0, 'rows', '[]'::jsonb, 'fixes', '[]'::jsonb, 'terms', '[]'::jsonb,
        'sups', (select coalesce(jsonb_agg(jsonb_build_object('id', supplier_id, 'n', k) order by k desc), '[]'::jsonb) from (select supplier_id, count(*) k from f group by 1) s),
        'grps', (select coalesce(jsonb_agg(jsonb_build_object('g', grp, 'n', k) order by k desc), '[]'::jsonb) from (select grp, count(*) k from f group by 1) g)));
  end if;
  return sp_search_any(p_q, p_sup, nullif(p_grp, 'all'), p_limit, p_sort, p_priced);
end $$;
revoke all on function public.sp_search(text, uuid[], text, int, text, boolean, bigint[]) from public, anon;
grant execute on function public.sp_search(text, uuid[], text, int, text, boolean, bigint[]) to authenticated;

-- words the staff say differently from the catalogs (both directions where both are real catalog words).
-- Stored the way sp_norm writes them. Only sure pairs: colours and series names in two alphabets, common spellings.
insert into public.sp_search_syn (term, alt) values
  ('זהב', 'גולד'), ('זהב', 'gold'), ('גולד', 'זהב'), ('גולד', 'gold'), ('gold', 'גולד'), ('gold', 'זהב'),
  ('שחור', 'בלאק'), ('שחור', 'black'), ('בלאק', 'שחור'), ('בלאק', 'black'), ('black', 'שחור'), ('black', 'בלאק'),
  ('לבנ', 'white'), ('white', 'לבנ'),
  ('רוזגולד', 'רוז גולד'),
  ('שדרוג', 'שידרוג'), ('שידרוג', 'שדרוג'),
  ('שירות', 'שרות'), ('שרות', 'שירות'),
  ('שירותימ', 'אסל'), ('שרותימ', 'אסל'),
  ('אמבטיה', 'אמבט'),
  ('ראי', 'מרא'),
  ('פרינס', 'prince'), ('prince', 'פרינס'),
  ('קראונ', 'crown'), ('crown', 'קראונ'),
  ('זאוס', 'zeus'), ('zeus', 'זאוס'),
  ('לד', 'led'),
  -- supplier names the way people say them
  ('דיור', 'דיאור'), ('dior', 'דיאור'), ('טופבט', 'טופ בט'), ('topbat', 'טופ בט'), ('רפובליק', 'ריפאבליק'), ('ריפבליק', 'ריפאבליק'),
  ('republic', 'ריפאבליק'), ('סיוונ', 'סיונ'), ('sanitec', 'סניטק'), ('ניוסטאר', 'ניו סטאר'), ('ambin', 'אמבינ'), ('onda', 'אונדה')
on conflict do nothing;

-- first fill + hourly refresh of the vocabulary (also repairs any row the trigger skipped)
select public.sp_search_reindex();
select cron.schedule('sp-search-reindex', '7 * * * *', 'select public.sp_search_reindex()')
  where not exists (select 1 from cron.job where jobname = 'sp-search-reindex');
