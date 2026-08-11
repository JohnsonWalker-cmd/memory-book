-- Our Memory Book — Supabase schema
-- Run this once in your Supabase project's SQL editor (Database > SQL Editor).

-- 1. The two (or more) people allowed to use the app.
create table if not exists allowed_emails (
  email text primary key
);

-- Add yourself and your girlfriend, e.g.:
-- insert into allowed_emails (email) values ('you@example.com'), ('her@example.com');

-- 2. Memories.
create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  image_path text,
  memory_date date not null default current_date,
  author_email text not null default auth.email(),
  created_at timestamptz not null default now()
);

-- 3. Notes/comments left on a memory.
create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references memories(id) on delete cascade,
  body text not null,
  author_email text not null default auth.email(),
  created_at timestamptz not null default now()
);

-- 4. Helper function: is the current logged-in user one of the allowed people?
-- security definer lets it read allowed_emails even though allowed_emails itself
-- has no client-facing policies (avoids recursive-policy issues).
create or replace function public.is_allowed_user()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from allowed_emails where email = auth.email()
  );
$$;

-- 5. Lock everything down, then allow only allowed_emails members.
alter table allowed_emails enable row level security;
alter table memories enable row level security;
alter table notes enable row level security;

drop policy if exists "allowed can read memories" on memories;
create policy "allowed can read memories" on memories for select
  using (is_allowed_user());

drop policy if exists "allowed can insert memories" on memories;
create policy "allowed can insert memories" on memories for insert
  with check (is_allowed_user());

drop policy if exists "authors can delete their memories" on memories;
create policy "authors can delete their memories" on memories for delete
  using (is_allowed_user() and author_email = auth.email());

drop policy if exists "allowed can read notes" on notes;
create policy "allowed can read notes" on notes for select
  using (is_allowed_user());

drop policy if exists "allowed can insert notes" on notes;
create policy "allowed can insert notes" on notes for insert
  with check (is_allowed_user());

-- 6. Realtime: let both partners see new memories/notes live.
alter publication supabase_realtime add table memories;
alter publication supabase_realtime add table notes;

-- 7. Private storage bucket for photos.
insert into storage.buckets (id, name, public)
values ('memory-photos', 'memory-photos', false)
on conflict (id) do nothing;

drop policy if exists "allowed can read photos" on storage.objects;
create policy "allowed can read photos" on storage.objects for select
  using (bucket_id = 'memory-photos' and is_allowed_user());

drop policy if exists "allowed can upload photos" on storage.objects;
create policy "allowed can upload photos" on storage.objects for insert
  with check (bucket_id = 'memory-photos' and is_allowed_user());
