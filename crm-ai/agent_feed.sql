-- Station screensaver feed, 12.11.2026. One short line per department, shown on the main office PC
-- when it is idle or covered ("יש לקוחות"). Customers may see it, so lines carry no customer names,
-- no bank balance and no cheque details. Staff read; the departments' agents write through the service role.
create table if not exists public.agent_feed (
  dept text primary key,
  ord int not null default 0,
  line text not null,
  updated_at timestamptz not null default now()
);
alter table public.agent_feed enable row level security;
drop policy if exists agent_feed_read on public.agent_feed;
create policy agent_feed_read on public.agent_feed for select using (crm_me() is not null);
revoke insert, update, delete on public.agent_feed from anon, authenticated;

insert into public.agent_feed (dept, ord, line) values
  ('מחלקת מכירות', 1, 'יעד: עוד 2 פגישות באולם בכל יום, ומענה לכל פנייה תוך 15 דקות'),
  ('מחלקת תזרים', 2, 'מעקב יומי אחרי הקבלות מול היעד של ₪16,800 ליום עבודה'),
  ('מחלקת שיווק', 3, 'המודעות בגוגל ובמטא מובילות לוואטסאפ ולפגישה חינם באולם'),
  ('מחלקת ביקורת', 4, 'בדיקת המלאי בפריוריטי מול הספירה במחסן'),
  ('מחלקת מערכות', 5, 'CRM חדש: טיוטות תשובה חכמות, מסך עמדה וסימון אוטומטי של עסקאות שנסגרו')
on conflict (dept) do nothing;
