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

-- 4. Profiles Table (for Auth & Roles)
create table if not exists public.profiles (
  id          uuid references auth.users on delete cascade primary key,
  full_name   text,
  role        text default 'customer' check (role in ('admin', 'customer')),
  created_at  timestamptz default now()
);

-- 5. Orders Table
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
  delivery_address text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- 6. Order Items (Snapshots)
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

-- 7. Bills Table
create table if not exists public.bills (
  id              uuid primary key default gen_random_uuid(),
  customer_name   text default 'Walk-in Customer',
  total_amount    numeric(10,2) not null,
  items           jsonb default '[]'::jsonb,
  payment_status  text default 'paid' check (payment_status in ('paid', 'voided')),
  payment_method  text default 'Cash' check (payment_method in ('Cash', 'UPI', 'Card')),
  client_uuid     uuid unique,
  customer_phone  text,
  order_type      text default 'dine-in',
  notes           text default '',
  table_number    text default '',
  discount_amount numeric(10,2) default 0,
  created_at      timestamptz default now()
);

-- 8. Categories Table
create table if not exists public.categories (
  id            bigint generated always as identity primary key,
  name          text not null,
  image_url     text,
  sort_order    int default 0,
  is_featured   boolean default false,
  layout_size   text default 'normal' check (layout_size in ('normal', 'large', 'wide')),
  color         text default '#ff6b00',
  description   text default '',
  created_at    timestamptz default now()
);

-- 9. Storage Bucket for item images
insert into storage.buckets (id, name, public)
values ('menu-images', 'menu-images', true)
on conflict do nothing;

-- 10. Security Helper Function (Bypasses RLS to avoid recursion)
create or replace function public.is_admin()
returns boolean security definer as $$
begin
  return exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
end;
$$ language plpgsql;

-- 11. Enable Row Level Security (RLS)
alter table public.menu_items enable row level security;
alter table public.profiles enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.bills enable row level security;
alter table public.categories enable row level security;

-- 12. RLS Policies

-- Menu Items
create policy "Public read available items"
  on public.menu_items for select
  using (available = true);

create policy "Admins full access to menu_items"
  on public.menu_items for all
  using (public.is_admin())
  with check (public.is_admin());

-- Profiles
create policy "Users read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Admins read all profiles"
  on public.profiles for select
  using (public.is_admin());

-- Orders
create policy "Users read own orders"
  on public.orders for select
  using (customer_id = auth.uid());

create policy "Admins manage all orders"
  on public.orders for all
  using (public.is_admin());

create policy "Public can place orders"
  on public.orders for insert
  with check (true);

-- Order Items
create policy "Admins manage all order items"
  on public.order_items for all
  using (public.is_admin());

create policy "Public can add order items"
  on public.order_items for insert
  with check (true);

-- Bills
create policy "Admins manage all bills"
  on public.bills for all
  using (public.is_admin());

-- Categories
create policy "Public read categories"
  on public.categories for select
  using (true);

create policy "Admins manage all categories"
  on public.categories for all
  using (public.is_admin())
  with check (public.is_admin());

-- Done! ✅

-- 13. Store Settings Table (shared between Admin and Customers)
create table if not exists public.store_settings (
  key   text primary key,
  value text not null
);

alter table public.store_settings enable row level security;

create policy "Public read store settings"
  on public.store_settings for select
  using (true);

create policy "Admins manage store settings"
  on public.store_settings for all
  using (get_auth_role() = 'admin')
  with check (get_auth_role() = 'admin');

-- 14. Admin Push Subscriptions (For Background Push Notifications)
create table if not exists public.admin_push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users on delete cascade,
  subscription  jsonb not null,
  created_at    timestamptz default now()
);

alter table public.admin_push_subscriptions enable row level security;

create policy "Admins manage own subscriptions"
  on public.admin_push_subscriptions for all
  using (auth.uid() = user_id and get_auth_role() = 'admin')
  with check (auth.uid() = user_id and get_auth_role() = 'admin');

-- 15. Push Notification Webhook Trigger on Orders
create or replace function public.on_order_inserted_push()
returns trigger as $$
begin
  perform net.http_post(
    url := 'https://grillandchillpizzeria.juvaid.in/api/send-order-push',
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'id', new.id,
        'customer_name', new.customer_name,
        'total_amount', new.total_amount
      )
    ),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_order_inserted_push_trigger
  after insert on public.orders
  for each row execute procedure public.on_order_inserted_push();
