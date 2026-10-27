-- Site/WhatsApp bot conversations (Supabase project ziso-whatsapp). Service role only, like the other tables.
-- Minimal data: no IP (salted hash for rate limits only), no name/phone outside the lead row the visitor agreed to.
create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  channel text not null check (channel in ('site','whatsapp')),
  ip_hash text,
  page text,
  message_count int not null default 0,
  lead_id bigint references public.leads(id)
);
create table if not exists public.chat_messages (
  id bigserial primary key,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  role text not null check (role in ('user','assistant')),
  content text not null,
  ip_hash text,
  tokens_in int,
  tokens_out int
);
create index if not exists chat_messages_session_idx on public.chat_messages (session_id, created_at);
create index if not exists chat_messages_ip_idx on public.chat_messages (ip_hash, created_at) where role = 'user';
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;

create or replace function public.chat_session_touch(p_id uuid, p_lead bigint default null) returns void
language sql security definer set search_path = public as $$
  update public.chat_sessions set updated_at = now(), message_count = message_count + 1,
    lead_id = coalesce(p_lead, lead_id) where id = p_id;
$$;

-- Retention: 90 days for chats, as stated in the site privacy policy. Run from a cron or by hand.
create or replace function public.chat_purge() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.chat_sessions where updated_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;
