-- Business rules the bot reads at runtime (index.ts, cached 60s), so wording changes need no redeploy.
-- Table was created from the WhatsApp thread on 28.10.2026; this file records its shape for the repo.
create table if not exists public.bot_settings (
  id int primary key,
  extra_rules text,          -- rules for every channel (site + WhatsApp)
  wa_rules text,             -- WhatsApp-only rules
  note text,
  updated_at timestamptz default now()
);
insert into public.bot_settings (id) values (1) on conflict (id) do nothing;
