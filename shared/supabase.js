// Shared Supabase client for the customer storefront.
// `supabase` (UMD global) and `window.ENV` are provided by classic <script>
// tags that run before this deferred module, so they are always available here.
export const supabaseClient = supabase.createClient(
  window.ENV.SUPABASE_URL,
  window.ENV.SUPABASE_ANON_KEY
);
