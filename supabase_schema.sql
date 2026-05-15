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

-- 5. Profiles Table (for Auth & Roles)
create table if not exists public.profiles (
  id          uuid references auth.users on delete cascade primary key,
  full_name   text,
  role        text default 'customer' check (role in ('admin', 'customer')),
  created_at  timestamptz default now()
);

-- 6. Orders Table
create table if not exists public.orders (
  id              bigint generated always as identity primary key,
  customer_id     uuid references public.profiles(id),
  customer_name   text not null,
  customer_phone  text not null,
  total_amount    numeric(10,2) not null,
  status          text default 'pending' check (status in ('pending', 'confirmed', 'cooking', 'delivering', 'completed', 'cancelled')),
  payment_status  text default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  delivery_lat    numeric,
  delivery_lng    numeric,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- 7. Order Items (Snapshots)
create table if not exists public.order_items (
  id            bigint generated always as identity primary key,
  order_id      bigint references public.orders(id) on delete cascade,
  menu_item_id  bigint references public.menu_items(id),
  item_name     text not null,
  quantity      int not null,
  price         numeric(10,2) not null,
  size          text,
  addons        jsonb default '[]'
);

-- 8. Storage Bucket for item images
insert into storage.buckets (id, name, public)
values ('menu-images', 'menu-images', true)
on conflict do nothing;

-- 9. More RLS Policies
alter table public.profiles enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- Profiles: Users can read their own, Admins can read all
create policy "Users read own profile" on public.profiles for select using (auth.uid() = id);
create policy "Admins read all profiles" on public.profiles for select using (
  exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
);

-- Orders: Users can read own, Admins can do everything, Public can INSERT
create policy "Users read own orders" on public.orders for select using (customer_id = auth.uid());
create policy "Admins manage all orders" on public.orders for all using (
  exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
);
create policy "Public can place orders" on public.orders for insert with check (true);

-- Order Items: Admins manage all, Public can INSERT
create policy "Admins manage all order items" on public.order_items for all using (
  exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
);
create policy "Public can add order items" on public.order_items for insert with check (true);

-- Done! ✅
