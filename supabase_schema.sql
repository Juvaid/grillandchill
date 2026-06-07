-- Orders
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
