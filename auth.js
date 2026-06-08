import { supabaseClient } from './db.js';

export let currentUser = null;

export function setCurrentUser(val) {
  currentUser = val;
  window.currentUser = val;
}

export async function checkAuth() {
  try {
    const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
    console.log('Session check:', session);
    
    if (sessionError) {
      const lastUserId = localStorage.getItem('gc_last_user_id');
      if (lastUserId && localStorage.getItem('gc_user_profile_' + lastUserId)) {
        const cachedProfile = JSON.parse(localStorage.getItem('gc_user_profile_' + lastUserId));
        if (cachedProfile?.role === 'admin') {
          console.log('Offline: Session error but cached admin profile found. Granting access.');
          setCurrentUser({ id: lastUserId, email: localStorage.getItem('gc_last_user_email') || 'admin@local' });
          if (typeof window.showDashboard === 'function') window.showDashboard();
          return;
        }
      }
      document.getElementById('authMsg').textContent = 'Session error: ' + sessionError.message;
      return;
    }

    if (session) {
      localStorage.setItem('gc_last_user_id', session.user.id);
      localStorage.setItem('gc_last_user_email', session.user.email || '');
      
      let profile = null;
      let profileError = null;
      
      try {
        const { data, error } = await supabaseClient.from('profiles')
          .select('role, full_name')
          .eq('id', session.user.id)
          .single();
        profile = data;
        profileError = error;
        if (profile) {
          localStorage.setItem('gc_user_profile_' + session.user.id, JSON.stringify(profile));
        }
      } catch (err) {
        console.warn('Profile fetch failed, trying local cache...', err);
      }

      if (!profile) {
        const cached = localStorage.getItem('gc_user_profile_' + session.user.id);
        if (cached) {
          profile = JSON.parse(cached);
          profileError = null;
        }
      }

      if (profileError) {
        document.getElementById('authMsg').textContent = 'Profile fetch error: ' + profileError.message;
        return;
      }

      if (profile?.role === 'admin') {
        setCurrentUser(session.user);
        if (typeof window.showDashboard === 'function') window.showDashboard();
      } else {
        document.getElementById('authMsg').textContent = 'Unauthorized. Admin access only.';
        console.error('Unauthorized attempt:', { id: session.user.id, role: profile?.role });
        await logout();
      }
    }
  } catch (err) {
    console.error('Unexpected auth error:', err);
    const lastUserId = localStorage.getItem('gc_last_user_id');
    if (lastUserId && localStorage.getItem('gc_user_profile_' + lastUserId)) {
      const cachedProfile = JSON.parse(localStorage.getItem('gc_user_profile_' + lastUserId));
      if (cachedProfile?.role === 'admin') {
        console.log('Offline: Unexpected error but cached admin profile found. Granting access.');
        setCurrentUser({ id: lastUserId, email: localStorage.getItem('gc_last_user_email') || 'admin@local' });
        if (typeof window.showDashboard === 'function') window.showDashboard();
        return;
      }
    }
    document.getElementById('authMsg').textContent = 'Auth system error. Please refresh.';
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

export async function logout() {
  if (currentUser) {
    try {
      // Delete subscription from Database to avoid piling up dead subscriptions
      await supabaseClient.from('admin_push_subscriptions').delete().eq('user_id', currentUser.id);
      
      // Unsubscribe locally from Push Manager
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
      }
    } catch(e) {
      console.error("Error unsubscribing on logout:", e);
    }
  }
  await supabaseClient.auth.signOut();
  location.reload();
}
