import { supabaseClient } from './db.js';

export let currentUser = null;
export let activeTenantId = null;

export function setCurrentUser(val) {
  currentUser = val;
  window.currentUser = val;
}

export function setActiveTenant(id) {
  activeTenantId = id;
  window.activeTenantId = id;
  if (id) localStorage.setItem('gc_active_tenant', id);
}

function cacheKey(uid) { return 'gc_memberships_' + uid; }

// Resolve which shop the signed-in user is acting as, then show the console.
// A signed-in user with NO shop yet is routed to onboarding instead of an error.
function enterWithMemberships(user, memberships) {
  setCurrentUser(user);
  if (memberships && memberships.length > 0) {
    const saved = localStorage.getItem('gc_active_tenant');
    const active = memberships.find(m => m.tenant_id === saved) || memberships[0];
    setActiveTenant(active.tenant_id);
    window.gcMemberships = memberships;
    if (typeof window.showDashboard === 'function') window.showDashboard();
  } else {
    if (typeof window.showOnboarding === 'function') window.showOnboarding();
  }
}

export async function checkAuth() {
  try {
    const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
    console.log('Session check:', session);

    if (sessionError) {
      // Offline: fall back to a cached membership if we have one.
      const lastUserId = localStorage.getItem('gc_last_user_id');
      const cached = lastUserId && localStorage.getItem(cacheKey(lastUserId));
      if (cached) {
        console.log('Offline: session error but cached membership found. Granting access.');
        enterWithMemberships(
          { id: lastUserId, email: localStorage.getItem('gc_last_user_email') || 'owner@local' },
          JSON.parse(cached)
        );
        return;
      }
      const msg = document.getElementById('authMsg');
      if (msg) msg.textContent = 'Session error: ' + sessionError.message;
      return;
    }

    if (!session) return; // Not signed in — stay on the login screen.

    localStorage.setItem('gc_last_user_id', session.user.id);
    localStorage.setItem('gc_last_user_email', session.user.email || '');

    // Which businesses does this user belong to?
    let memberships = null;
    try {
      const { data, error } = await supabaseClient
        .from('tenant_members')
        .select('tenant_id, role, tenants(name, slug, plan)')
        .eq('user_id', session.user.id);
      if (error) throw error;
      memberships = data || [];
      localStorage.setItem(cacheKey(session.user.id), JSON.stringify(memberships));
    } catch (err) {
      console.warn('Membership fetch failed, trying local cache...', err);
      const cached = localStorage.getItem(cacheKey(session.user.id));
      if (cached) memberships = JSON.parse(cached);
    }

    enterWithMemberships(session.user, memberships || []);
  } catch (err) {
    console.error('Unexpected auth error:', err);
    const lastUserId = localStorage.getItem('gc_last_user_id');
    const cached = lastUserId && localStorage.getItem(cacheKey(lastUserId));
    if (cached) {
      enterWithMemberships(
        { id: lastUserId, email: localStorage.getItem('gc_last_user_email') || 'owner@local' },
        JSON.parse(cached)
      );
      return;
    }
    const msg = document.getElementById('authMsg');
    if (msg) msg.textContent = 'Auth system error. Please refresh.';
  }
}

export async function login() {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    document.getElementById('authMsg').textContent = error.message;
  } else {
    await checkAuth();
  }
}

// Google OAuth. Redirects back to this same admin page, where the
// onAuthStateChange -> checkAuth flow resolves membership/onboarding.
export async function loginWithGoogle() {
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo }
  });
  if (error) {
    const msg = document.getElementById('authMsg');
    if (msg) msg.textContent = 'Google sign-in failed: ' + error.message;
  }
}

// First-run onboarding: create the business (tenant) and make the signer its owner.
export async function createTenantAndOnboard() {
  const name = document.getElementById('onbBusinessName')?.value.trim();
  const type = document.getElementById('onbBusinessType')?.value || 'restaurant';
  const phone = document.getElementById('onbPhone')?.value.trim();
  const upi = document.getElementById('onbUpi')?.value.trim();
  const msg = document.getElementById('onbMsg');
  const btn = document.getElementById('onbCreateBtn');

  if (!name) { if (msg) msg.textContent = 'Please enter your business name.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    + '-' + Math.random().toString(36).slice(2, 6);

  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) throw new Error('You are not signed in.');

    const { data: tenant, error: tErr } = await supabaseClient
      .from('tenants')
      .insert({ name, slug, business_type: type, phone: phone || null, upi_id: upi || null })
      .select()
      .single();
    if (tErr) throw tErr;

    const { error: mErr } = await supabaseClient
      .from('tenant_members')
      .insert({ tenant_id: tenant.id, user_id: user.id, role: 'owner' });
    if (mErr) throw mErr;

    setActiveTenant(tenant.id);
    localStorage.removeItem(cacheKey(user.id)); // force a fresh membership read
    await checkAuth();
  } catch (e) {
    console.error('Onboarding failed:', e);
    if (msg) msg.textContent = 'Could not create business: ' + e.message;
    if (btn) { btn.disabled = false; btn.textContent = 'Create business'; }
  }
}

export async function logout() {
  if (currentUser) {
    try {
      await supabaseClient.from('admin_push_subscriptions').delete().eq('user_id', currentUser.id);
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (e) {
      console.error("Error unsubscribing on logout:", e);
    }
  }
  await supabaseClient.auth.signOut();
  location.reload();
}
