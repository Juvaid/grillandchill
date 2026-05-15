-- ═══════════════════════════════════════════════════════
--  Grill & Chill – Supabase Schema
--  Run this ONCE in: Supabase → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════

-- 1. Enable UUID extension (if not already)
create extension if not exists "uuid-ossp";

-- 2. Menu Items Table
create table if not exists public.menu_items (
  id            bigint generated always as identity primary key,
  name          text not null,
  category      text not null,
  description   text default '',
  emoji         text default '🍽️',
  is_veg        boolean default true,
  tags          text[] default '{}',
  sizes         jsonb not null default '{}',
  addons        jsonb default '[]',
  image_url     text default null,
  available     boolean default true,
  sort_order    int default 0,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- 3. Auto-update updated_at
create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger on_menu_item_updated
  before update on public.menu_items
  for each row execute procedure public.handle_updated_at();

-- 4. Row Level Security
alter table public.menu_items enable row level security;

-- Public can SELECT available items
create policy "Public read available items"
  on public.menu_items for select
  using (available = true);

-- Authenticated users (admins) can do everything
create policy "Authenticated full access"
  on public.menu_items for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- 5. Storage Bucket for item images
insert into storage.buckets (id, name, public)
values ('menu-images', 'menu-images', true)
on conflict do nothing;

create policy "Public read menu images"
  on storage.objects for select
  using (bucket_id = 'menu-images');

create policy "Auth upload menu images"
  on storage.objects for insert
  using (auth.role() = 'authenticated')
  with check (bucket_id = 'menu-images');

create policy "Auth delete menu images"
  on storage.objects for delete
  using (auth.role() = 'authenticated' and bucket_id = 'menu-images');

-- Done! ✅
