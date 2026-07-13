-- ============================================================================
--  Grill & Chill — Multi-Tenant Foundation (Phase 1)
--  Converts the single-tenant app into a shared-schema, RLS-isolated SaaS.
--
--  What it does, in order:
--    1. Creates `tenants` and `tenant_members`.
--    2. Seeds the existing store as Tenant #1 and links current admins as owners.
--    3. Adds `tenant_id` to every data table and backfills it to Tenant #1.
--    4. Reshapes `store_settings` to be per-tenant.
--    5. Adds the khata/expense tables (parties, ledger_entries, expenses).
--    6. Adds an auto-stamp trigger so existing app code keeps working unchanged.
--    7. Enables tenant-isolating RLS on everything.
--
--  Safe to run once on the live project. Written defensively (IF NOT EXISTS /
--  DROP POLICY IF EXISTS) so a re-run does not error. Wrapped in a transaction.
--
--  A fixed UUID is used for the seed tenant so it can be referenced as a
--  column default for the anonymous storefront during Phase 1 (single tenant).
-- ============================================================================

begin;

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- Well-known id for the seeded "first" tenant (your existing Grill & Chill data).
-- Referenced by name below via public.default_tenant_id().
create or replace function public.default_tenant_id()
returns uuid language sql immutable as $$
  select '00000000-0000-0000-0000-000000000001'::uuid;
$$;

-- ----------------------------------------------------------------------------
-- 1. TENANCY TABLES
-- ----------------------------------------------------------------------------
create table if not exists public.tenants (
    id            uuid primary key default gen_random_uuid(),
    name          text not null,
    slug          text unique,
    business_type text default 'restaurant',   -- restaurant | cafe | kirana | dhaba | bakery | other
    plan          text not null default 'free',-- free | pro
    phone         text,
    upi_id        text,
    logo_url      text,
    created_at    timestamptz not null default now()
);

create table if not exists public.tenant_members (
    id         uuid primary key default gen_random_uuid(),
    tenant_id  uuid not null references public.tenants(id) on delete cascade,
    user_id    uuid not null references auth.users(id) on delete cascade,
    role       text not null default 'owner',  -- owner | manager | staff
    created_at timestamptz not null default now(),
    unique (tenant_id, user_id)
);
create index if not exists tenant_members_user_idx on public.tenant_members(user_id);

-- ----------------------------------------------------------------------------
-- 2. SEED TENANT #1 + LINK EXISTING ADMINS AS OWNERS
-- ----------------------------------------------------------------------------
insert into public.tenants (id, name, slug, business_type, plan)
values (public.default_tenant_id(), 'Grill & Chill', 'grill-and-chill', 'restaurant', 'pro')
on conflict (id) do nothing;

-- Anyone currently flagged admin in `profiles` becomes an owner of Tenant #1.
insert into public.tenant_members (tenant_id, user_id, role)
select public.default_tenant_id(), p.id, 'owner'
from public.profiles p
where p.role = 'admin'
on conflict (tenant_id, user_id) do nothing;

-- ----------------------------------------------------------------------------
-- 3. ADD tenant_id EVERYWHERE + BACKFILL TO TENANT #1
-- ----------------------------------------------------------------------------
-- The app reads/writes these order columns but they are absent from the
-- original schema dump; add them up front so later objects can rely on them.
alter table public.orders add column if not exists delivery_lat     double precision;
alter table public.orders add column if not exists delivery_lng     double precision;
alter table public.orders add column if not exists delivery_address text;

alter table public.categories            add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.menu_items            add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.orders                add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.bills                 add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.admin_push_subscriptions add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;

-- order_items exists in the app but not in the original schema dump; create it
-- if missing so the migration is self-contained, then add tenant_id.
create table if not exists public.order_items (
    id           uuid primary key default gen_random_uuid(),
    order_id     uuid references public.orders(id) on delete cascade,
    menu_item_id uuid,
    item_name    text,
    quantity     integer default 1,
    price        numeric(10,2) default 0,
    size         text,
    addons       jsonb,
    created_at   timestamptz not null default now()
);
alter table public.order_items add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;

update public.categories            set tenant_id = public.default_tenant_id() where tenant_id is null;
update public.menu_items            set tenant_id = public.default_tenant_id() where tenant_id is null;
update public.orders                set tenant_id = public.default_tenant_id() where tenant_id is null;
update public.order_items           set tenant_id = public.default_tenant_id() where tenant_id is null;
update public.bills                 set tenant_id = public.default_tenant_id() where tenant_id is null;
update public.admin_push_subscriptions set tenant_id = public.default_tenant_id() where tenant_id is null;

create index if not exists categories_tenant_idx  on public.categories(tenant_id);
create index if not exists menu_items_tenant_idx  on public.menu_items(tenant_id);
create index if not exists orders_tenant_idx      on public.orders(tenant_id, created_at desc);
create index if not exists order_items_tenant_idx on public.order_items(tenant_id);
create index if not exists bills_tenant_idx       on public.bills(tenant_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 4. RESHAPE store_settings TO PER-TENANT
--    Old: PK(key). New: PK(tenant_id, key) so every tenant has its own config.
-- ----------------------------------------------------------------------------
alter table public.store_settings add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
update public.store_settings set tenant_id = public.default_tenant_id() where tenant_id is null;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.store_settings'::regclass and contype = 'p'
  ) then
    execute 'alter table public.store_settings drop constraint ' ||
      (select conname from pg_constraint
       where conrelid = 'public.store_settings'::regclass and contype = 'p');
  end if;
end $$;

alter table public.store_settings alter column tenant_id set not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.store_settings'::regclass and contype = 'p'
  ) then
    alter table public.store_settings add primary key (tenant_id, key);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5. KHATA / EXPENSE MODULE (schema now; UI ships in Phase 2)
-- ----------------------------------------------------------------------------
-- parties: customers/suppliers you keep a running balance with (udhaar/jama).
create table if not exists public.parties (
    id         uuid primary key default gen_random_uuid(),
    tenant_id  uuid not null references public.tenants(id) on delete cascade,
    name       text not null,
    phone      text,
    type       text not null default 'customer',   -- customer | supplier
    balance    numeric(12,2) not null default 0,    -- cached net balance (+ = they owe you)
    note       text,
    created_at timestamptz not null default now()
);
create index if not exists parties_tenant_idx on public.parties(tenant_id);

-- ledger_entries: the udhaar book. One row per credit/debit event.
create table if not exists public.ledger_entries (
    id         uuid primary key default gen_random_uuid(),
    tenant_id  uuid not null references public.tenants(id) on delete cascade,
    party_id   uuid not null references public.parties(id) on delete cascade,
    direction  text not null,                        -- 'debit' (they took udhaar) | 'credit' (they paid)
    amount     numeric(12,2) not null check (amount >= 0),
    note       text,
    bill_id    uuid references public.bills(id) on delete set null,
    entry_date date not null default (now() at time zone 'utc')::date,
    created_at timestamptz not null default now(),
    check (direction in ('debit','credit'))
);
create index if not exists ledger_party_idx  on public.ledger_entries(party_id, created_at desc);
create index if not exists ledger_tenant_idx on public.ledger_entries(tenant_id);

-- expenses: business spend tracker (rent, supplies, salaries, utilities…).
create table if not exists public.expenses (
    id         uuid primary key default gen_random_uuid(),
    tenant_id  uuid not null references public.tenants(id) on delete cascade,
    category   text not null default 'general',
    amount     numeric(12,2) not null check (amount >= 0),
    note       text,
    paid_to    text,
    payment_method text default 'Cash',
    spent_on   date not null default (now() at time zone 'utc')::date,
    created_at timestamptz not null default now()
);
create index if not exists expenses_tenant_idx on public.expenses(tenant_id, spent_on desc);

-- Keep parties.balance in sync from ledger_entries (+debit / -credit).
create or replace function public.apply_ledger_to_party()
returns trigger language plpgsql security definer set search_path = public as $$
declare delta numeric(12,2);
begin
  if (tg_op = 'INSERT') then
    delta := case when new.direction = 'debit' then new.amount else -new.amount end;
    update public.parties set balance = balance + delta where id = new.party_id;
  elsif (tg_op = 'DELETE') then
    delta := case when old.direction = 'debit' then old.amount else -old.amount end;
    update public.parties set balance = balance - delta where id = old.party_id;
  end if;
  return null;
end $$;

drop trigger if exists trg_ledger_balance on public.ledger_entries;
create trigger trg_ledger_balance
  after insert or delete on public.ledger_entries
  for each row execute function public.apply_ledger_to_party();

-- ----------------------------------------------------------------------------
-- 6. AUTO-STAMP tenant_id  (so existing app code needs NO changes)
--    Authenticated writes get the caller's tenant; the anonymous storefront
--    falls back to the single seeded tenant during Phase 1.
--    Phase 3 (per-tenant storefront) will pass tenant_id explicitly, which
--    overrides this fallback — remove the fallback branch then.
-- ----------------------------------------------------------------------------
create or replace function public.set_tenant_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.tenant_id is null then
    new.tenant_id := coalesce(
      (select tenant_id from public.tenant_members
        where user_id = auth.uid() order by created_at limit 1),
      (select id from public.tenants order by created_at limit 1)  -- Phase-1 anon fallback
    );
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'categories','menu_items','orders','order_items','bills',
    'store_settings','admin_push_subscriptions','parties','ledger_entries','expenses'
  ] loop
    execute format('drop trigger if exists trg_set_tenant on public.%I', t);
    execute format(
      'create trigger trg_set_tenant before insert on public.%I
         for each row execute function public.set_tenant_id()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- Helper: the tenant ids the current user belongs to. SECURITY DEFINER so the
-- policy can read tenant_members without recursing into its own RLS.
create or replace function public.my_tenant_ids()
returns setof uuid language sql security definer stable set search_path = public as $$
  select tenant_id from public.tenant_members where user_id = auth.uid();
$$;

alter table public.tenants                  enable row level security;
alter table public.tenant_members           enable row level security;
alter table public.categories               enable row level security;
alter table public.menu_items               enable row level security;
alter table public.orders                   enable row level security;
alter table public.order_items              enable row level security;
alter table public.bills                    enable row level security;
alter table public.store_settings           enable row level security;
alter table public.admin_push_subscriptions enable row level security;
alter table public.parties                  enable row level security;
alter table public.ledger_entries           enable row level security;
alter table public.expenses                 enable row level security;

-- tenants: a member can see/update tenants they belong to; any authenticated
-- user may create a tenant (onboarding). Membership is granted app-side.
drop policy if exists tenants_member_select on public.tenants;
create policy tenants_member_select on public.tenants for select to authenticated
  using (id in (select public.my_tenant_ids()));
drop policy if exists tenants_insert on public.tenants;
create policy tenants_insert on public.tenants for insert to authenticated
  with check (true);
drop policy if exists tenants_member_update on public.tenants;
create policy tenants_member_update on public.tenants for update to authenticated
  using (id in (select public.my_tenant_ids()))
  with check (id in (select public.my_tenant_ids()));
-- storefront needs to resolve a shop by slug without logging in:
drop policy if exists tenants_public_read on public.tenants;
create policy tenants_public_read on public.tenants for select to anon
  using (true);

-- tenant_members: you can see rows for your own tenants; you can insert your
-- OWN membership (used by onboarding to make the creator an owner).
drop policy if exists members_self_select on public.tenant_members;
create policy members_self_select on public.tenant_members for select to authenticated
  using (user_id = auth.uid() or tenant_id in (select public.my_tenant_ids()));
drop policy if exists members_self_insert on public.tenant_members;
create policy members_self_insert on public.tenant_members for insert to authenticated
  with check (user_id = auth.uid());

-- Generic per-tenant read/write for authenticated members.
do $$
declare t text;
begin
  foreach t in array array[
    'categories','menu_items','orders','order_items','bills',
    'store_settings','admin_push_subscriptions','parties','ledger_entries','expenses'
  ] loop
    execute format('drop policy if exists %I on public.%I', t||'_member_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (tenant_id in (select public.my_tenant_ids()))
         with check (tenant_id in (select public.my_tenant_ids()))',
      t||'_member_all', t);
  end loop;
end $$;

-- Anonymous storefront access (public menu + placing orders).
-- NOTE (Phase-2 hardening): anon SELECT on orders/order_items is only needed so
-- the storefront can read back the row it just inserted. Replace with the
-- SECURITY DEFINER `place_order` RPC below and drop these two anon policies.
drop policy if exists categories_public_read on public.categories;
create policy categories_public_read on public.categories for select to anon using (true);

drop policy if exists menu_items_public_read on public.menu_items;
create policy menu_items_public_read on public.menu_items for select to anon using (available = true);

drop policy if exists store_settings_public_read on public.store_settings;
create policy store_settings_public_read on public.store_settings for select to anon using (true);

drop policy if exists orders_anon_insert on public.orders;
create policy orders_anon_insert on public.orders for insert to anon with check (true);
drop policy if exists orders_anon_select on public.orders;
create policy orders_anon_select on public.orders for select to anon using (true);

drop policy if exists order_items_anon_insert on public.order_items;
create policy order_items_anon_insert on public.order_items for insert to anon with check (true);
drop policy if exists order_items_anon_select on public.order_items;
create policy order_items_anon_select on public.order_items for select to anon using (true);

-- ----------------------------------------------------------------------------
-- 8. (Optional, recommended) Secure order placement RPC.
--    Lets the storefront place an order for a specific tenant WITHOUT any
--    anon read access to the orders table. Adopt in Phase 2, then remove the
--    orders_anon_* / order_items_anon_* policies above.
-- ----------------------------------------------------------------------------
create or replace function public.place_order(p_tenant uuid, p_order jsonb, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  insert into public.orders
    (tenant_id, customer_name, customer_phone, total_amount, delivery_lat,
     delivery_lng, delivery_address, status, payment_status, order_type, notes, table_number)
  values
    (p_tenant,
     p_order->>'customer_name', p_order->>'customer_phone',
     (p_order->>'total_amount')::numeric,
     nullif(p_order->>'delivery_lat','')::double precision,
     nullif(p_order->>'delivery_lng','')::double precision,
     p_order->>'delivery_address',
     coalesce(p_order->>'status','pending'),
     coalesce(p_order->>'payment_status','unpaid'),
     coalesce(p_order->>'order_type','delivery'),
     p_order->>'notes', p_order->>'table_number')
  returning id into new_id;

  insert into public.order_items (tenant_id, order_id, menu_item_id, item_name, quantity, price, size, addons)
  select p_tenant, new_id,
         nullif(i->>'menu_item_id','')::uuid, i->>'item_name',
         coalesce((i->>'quantity')::int,1), coalesce((i->>'price')::numeric,0),
         i->>'size', i->'addons'
  from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) as i;

  return new_id;
end $$;

grant execute on function public.place_order(uuid, jsonb, jsonb) to anon, authenticated;

commit;

-- ============================================================================
--  ROLLBACK (manual): if you must revert, drop the new tables and the
--  tenant_id columns, and restore store_settings PK to (key). Because this
--  migration only ADDS columns/tables and backfills, your original rows are
--  never destroyed — the safest revert is to drop the added objects only.
-- ============================================================================
