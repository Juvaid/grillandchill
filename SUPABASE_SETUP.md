# Supabase setup — Multi-tenant foundation (Phase 1)

This PR turns Grill & Chill into a multi-tenant SaaS: every business (tenant)
gets isolated data, and owners sign in with **Google** or email/password. Your
existing store is preserved as **Tenant #1**.

There are only **two things to do in Supabase**, both below. Everything in the
app already works against the new schema without code changes (a trigger
auto-stamps `tenant_id` on writes).

---

## 1. Run the migration

File: [`supabase/migrations/20260713_0001_multi_tenant_foundation.sql`](supabase/migrations/20260713_0001_multi_tenant_foundation.sql)

**Dashboard route (simplest):**
1. Supabase → your project (**Grill & Chill / "punjab road watch"**) → **SQL Editor**.
2. Paste the whole migration file → **Run**.
3. It wraps itself in a transaction and is safe to re-run (idempotent).

**CLI route (if you use the Supabase CLI):**
```bash
supabase db push        # or: psql "$DATABASE_URL" -f supabase/migrations/20260713_0001_multi_tenant_foundation.sql
```

### What it does
- Creates `tenants` + `tenant_members`.
- Seeds your current store as Tenant #1 (`id = 00000000-0000-0000-0000-000000000001`) and makes every existing `profiles.role = 'admin'` user an **owner**.
- Adds `tenant_id` to `categories, menu_items, orders, order_items, bills, store_settings, admin_push_subscriptions` and backfills them to Tenant #1.
- Reshapes `store_settings` to a per-tenant primary key `(tenant_id, key)`.
- Adds the khata/expense tables: `parties`, `ledger_entries`, `expenses` (+ a trigger that keeps each party's udhaar balance in sync).
- Enables **tenant-isolating RLS** on everything, plus public read for the storefront menu and public order placement.

> Validated end-to-end against PostgreSQL 16 before shipping: trigger stamping,
> cross-tenant isolation, anon storefront fallback, composite-PK upsert, and the
> ledger balance trigger all pass. It only **adds** objects and backfills, so your
> existing rows are never destroyed.

---

## 2. Enable Google sign-in

### a) Google Cloud Console
1. <https://console.cloud.google.com> → create/select a project.
2. **APIs & Services → OAuth consent screen** → External → fill app name, support email, save.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → type **Web application**.
4. Under **Authorized redirect URIs**, add your Supabase callback:
   ```
   https://<YOUR-PROJECT-REF>.supabase.co/auth/v1/callback
   ```
   (Find `<YOUR-PROJECT-REF>` in Supabase → Project Settings → API.)
5. Copy the **Client ID** and **Client secret**.

### b) Supabase
1. Supabase → **Authentication → Providers → Google** → enable.
2. Paste the **Client ID** and **Client secret** → save.
3. Supabase → **Authentication → URL Configuration → Redirect URLs**, add every URL the admin app is served from, e.g.:
   ```
   http://localhost:3000/admin.html
   https://<your-vercel-domain>/admin.html
   ```
   (The app redirects back to whatever `origin + path` it was opened from.)

That's it. Open `admin.html` → **Continue with Google** → first-time users land on
the **"Set up your shop"** onboarding, create a business, and are in.

---

## How the app behaves now
- **Existing admin (you):** already backfilled as owner of Tenant #1 → logs straight into the console, sees all your current data.
- **New Google/email user with no shop:** routed to onboarding → creating a business inserts a `tenant` + owner `tenant_member`, then drops them into the console scoped to that tenant.
- **Customer storefront (`index.html`):** unchanged in Phase 1 — it reads the single seeded tenant's menu and places orders that auto-attach to it.

## Security notes / Phase-2 hardening (not required to ship)
- The migration ships a `place_order(tenant, order, items)` SECURITY DEFINER RPC. When you adopt it in the storefront checkout, drop the `orders_anon_select` / `order_items_anon_select` policies so anonymous users can't read the orders table at all. Until then, behavior matches today's app.
- Don't store secrets in `store_settings` — it's publicly readable by design (store name, UPI id, WhatsApp number are meant to be public storefront config).
- `store_settings` is now keyed by `(tenant_id, key)`; the app's `.upsert()` continues to work because the trigger fills `tenant_id`.

## Rollback
Because the migration only adds columns/tables and backfills, the safe revert is
to drop the new objects (`tenants, tenant_members, parties, ledger_entries,
expenses`), drop the added `tenant_id` columns, and restore the `store_settings`
primary key to `(key)`. Your original data rows are untouched.
