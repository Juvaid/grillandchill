    // --- OFFLINE DB SETUP ---
    const db = new Dexie("grill_chill_db");
    db.version(6).stores({
      local_bills: 'id, customer_name, customer_phone, total_amount, payment_status, created_at, sync_status, client_uuid',
      pending_orders: '++id, status',
      categories: 'id, name, sort_order',
      menu_items: 'id, name, price, category, available',
      store_settings: 'key',
      local_orders: 'id, status, created_at, sync_status'
    });
    
    // Migration helper for stuck bills
    async function migrateOldBills() {
      try {
        const oldBills = await db.table('bills').toArray();
        if (oldBills.length > 0) {
          console.log('Migrating old bills...', oldBills.length);
          for (let b of oldBills) {
            const newId = generateUUID();
            await db.local_bills.add({
              ...b,
              id: newId,
              client_uuid: newId,
              sync_status: 'pending'
            });
          }
          // Clear old table to prevent double migration
          await db.table('bills').clear();
        }
      } catch (e) {
        // Table might not exist or already be empty
      }
    }

    const supabaseClient = supabase.createClient(window.ENV.SUPABASE_URL, window.ENV.SUPABASE_ANON_KEY);
    let currentUser = null;
    let ordersChannel = null;
    let billsChannel = null;
    let isDashboardInitialized = false;

    // --- AUTH LOGIC ---
    async function checkAuth() {
      try {
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        console.log('Session check:', session);
        
        if (sessionError) {
          const lastUserId = localStorage.getItem('gc_last_user_id');
          if (lastUserId && localStorage.getItem('gc_user_profile_' + lastUserId)) {
            const cachedProfile = JSON.parse(localStorage.getItem('gc_user_profile_' + lastUserId));
            if (cachedProfile?.role === 'admin') {
              console.log('Offline: Session error but cached admin profile found. Granting access.');
              currentUser = { id: lastUserId, email: localStorage.getItem('gc_last_user_email') || 'admin@local' };
              showDashboard();
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
            currentUser = session.user;
            showDashboard();
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
            currentUser = { id: lastUserId, email: localStorage.getItem('gc_last_user_email') || 'admin@local' };
            showDashboard();
            return;
          }
        }
        document.getElementById('authMsg').textContent = 'Auth system error. Please refresh.';
      }
    }

    document.getElementById('loginBtn').onclick = async () => {
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) document.getElementById('authMsg').textContent = error.message;
      else checkAuth();
    };

    async function logout() {
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

    function updateConnectionStatus() {
      const badge = document.getElementById('connectionStatusBadge');
      if (!badge) return;

      if (navigator.onLine) {
        badge.innerHTML = '<span class="status-dot online"></span><span class="status-text">Online</span>';
        
        // Auto-sync pending bills and KDS orders when online
        syncBills();
        syncOrders();
      } else {
        badge.innerHTML = '<span class="status-dot offline"></span><span class="status-text">Offline</span>';
      }
    }

    async function showDashboard() {
      if (isDashboardInitialized) return;
      isDashboardInitialized = true;

      document.getElementById('authScreen').classList.add('hidden');
      document.getElementById('dashboard').classList.remove('hidden');
      
      // Setup online/offline connection listeners
      window.addEventListener('online', updateConnectionStatus);
      window.addEventListener('offline', updateConnectionStatus);
      updateConnectionStatus();

      await migrateOldBills();
      loadOrders();
      loadBilling();
      await loadCategories();
      await loadProducts();
      loadSettings();
      subscribeToOrders();
      subscribeToBills();
      setupPushNotifications();
    }

    async function setupPushNotifications() {
      if (location.protocol === 'file:') {
        console.warn('Push notifications and Service Workers cannot be registered when loading admin.html directly via file:// protocol. Please run a local web server.');
        return;
      }

      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn('Push notifications or Service Worker is not supported in this browser');
        return;
      }

      try {
        const reg = await navigator.serviceWorker.register('service-worker.js');
        console.log('Service Worker registered for Admin:', reg);
        
        if (Notification.permission === 'default') {
          await Notification.requestPermission();
        }
        
        if (Notification.permission !== 'granted') {
          console.warn('Push notifications permission not granted');
          return;
        }
        
        const VAPID_PUBLIC_KEY = 'BLd5176BENuYPrDrfx3388HbyX-BwJ2Ln8jaa4KtWEvhrzC-icfjzk5CxxSL6m_rgsW9qDA_Zv_m1EFLhAcrfnI';
        
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
          });
          console.log('New Push Subscription created:', sub);
        } else {
          console.log('Existing Push Subscription found:', sub);
        }
        
        if (currentUser) {
          const subJson = JSON.parse(JSON.stringify(sub));
          // Delete existing for this user and insert fresh subscription to avoid duplicate entries
          await supabaseClient.from('admin_push_subscriptions').delete().eq('user_id', currentUser.id);
          const { error: insErr } = await supabaseClient
            .from('admin_push_subscriptions')
            .insert({
              user_id: currentUser.id,
              subscription: subJson
            });
          if (insErr) console.error('Failed to save push subscription to DB:', insErr);
          else console.log('Push subscription saved to Supabase successfully!');
        }
      } catch (err) {
        console.error('Error setting up push notifications:', err);
      }
    }

    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - base64String.length % 4) % 4);
      const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

      const rawData = window.atob(base64);
      const outputArray = new Uint8Array(rawData.length);

      for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
      }
      return outputArray;
    }

    function subscribeToOrders() {
      if (ordersChannel) {
        console.log('Already subscribed to live orders.');
        return;
      }
      console.log('📡 Subscribing to Live Orders...');
      
      // Request permission on first live load/auth
      if (window.Notification && Notification.permission === 'default') {
        Notification.requestPermission();
      }

      ordersChannel = supabaseClient
        .channel('orders-live')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, payload => {
          console.log('🔥 New Live Order:', payload);
          
          // Sound double beep
          playNotificationSound();
          
          // Browser Notification
          if (window.Notification && Notification.permission === 'granted') {
            new Notification('New Order Received! 🍕', {
              body: `${payload.new.customer_name} ordered for ₹${payload.new.total_amount}`,
              icon: 'assets/logo-transparent.png'
            });
          }
          
          // Custom Alert / Toast
          showToast(`🔔 New Order from ${payload.new.customer_name} of ₹${payload.new.total_amount}!`);
          alert(`🔔 NEW ORDER RECEIVED!\n\nCustomer: ${payload.new.customer_name}\nPhone: ${payload.new.customer_phone}\nAmount: ₹${payload.new.total_amount}`);
          
          loadOrders();
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, payload => {
          console.log('🔥 Live Order Update:', payload);
          loadOrders();
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'orders' }, payload => {
          loadOrders();
        });

      ordersChannel.subscribe();
    }

    function playNotificationSound() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const playBeep = (delay, freq, duration) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0, ctx.currentTime + delay);
          gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + delay + 0.05);
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + delay + duration);
          
          osc.start(ctx.currentTime + delay);
          osc.stop(ctx.currentTime + delay + duration);
        };
        playBeep(0, 587.33, 0.15); // D5
        playBeep(0.18, 880, 0.25); // A5
      } catch (e) {
        console.warn('Audio Context failed to play sound:', e);
      }
    }

    function shareUpiRequestToWhatsApp() {
      if (!window.upiCurrentPhone) return;
      const storeUpi = localStorage.getItem('gc_store_upi_id') || 'juvaidpb13@okaxis';
      const storeName = window.storeSettings?.store_name || localStorage.getItem('gc_store_merchant_name') || 'Grill & Chill';
      const upiUrl = `upi://pay?pa=${storeUpi}&pn=${encodeURIComponent(storeName)}&am=${window.upiCurrentAmount}&cu=INR`;
      const message = `Hello! Please click the link below to pay ₹${window.upiCurrentAmount} to ${storeName}:\n\n${upiUrl}`;
      
      let cleanedPhone = window.upiCurrentPhone.replace(/\D/g, '');
      if (cleanedPhone.length === 10) {
        cleanedPhone = '91' + cleanedPhone;
      }
      window.open(`https://wa.me/${cleanedPhone}?text=${encodeURIComponent(message)}`, '_blank');
    }

    function subscribeToBills() {
      if (billsChannel) {
        console.log('Already subscribed to live bills.');
        return;
      }
      console.log('📡 Subscribing to Live Bills...');
      billsChannel = supabaseClient
        .channel('bills-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bills' }, payload => {
          console.log('💰 Live Bill Update:', payload);
          loadBilling();
          updateDashboardStats();
        });

      billsChannel.subscribe();
    }

    // --- TAB LOGIC ---
    function switchTab(tabId) {
      ['orders', 'products', 'billing', 'settings'].forEach(t => {
        const section = document.getElementById(t + 'Section');
        const navItem = document.getElementById('nav-' + t);
        if (section) section.classList.toggle('hidden', t !== tabId);
        if (navItem) navItem.classList.toggle('active', t === tabId);
      });

      if (tabId === 'orders') loadOrders();
      if (tabId === 'products') loadProducts();
      if (tabId === 'billing') loadBilling();
      if (tabId === 'settings') loadSettings();
    }

    async function syncOrders() {
      if (!navigator.onLine) return;
      try {
        const pending = await db.local_orders.where('sync_status').equals('pending').toArray();
        for (const ord of pending) {
          const { error } = await supabaseClient.from('orders').update({ status: ord.status }).eq('id', ord.id);
          if (!error) {
            await db.local_orders.update(ord.id, { sync_status: 'synced' });
          }
        }
      } catch (e) {
        console.warn('Failed to sync orders:', e);
      }
    }

    async function loadOrders() {
      let data = null;
      try {
        await syncOrders();
        const res = await supabaseClient
          .from('orders')
          .select('*, order_items(*)')
          .order('created_at', { ascending: false });
        data = res.data;
        if (data && data.length > 0) {
          await db.local_orders.clear();
          await db.local_orders.bulkPut(data.map(o => ({ ...o, sync_status: 'synced' })));
        }
      } catch (err) {
        console.warn('Failed to load orders from Supabase, checking local cache:', err);
      }

      if (!data) {
        try {
          data = await db.local_orders.orderBy('created_at').reverse().toArray();
        } catch (e) {
          console.warn('Failed to load orders from Dexie:', e);
        }
      }

      const body = document.getElementById('ordersBody');
      if (!data) return;
      window.allOrders = data;

      body.innerHTML = data.map(o => {
        const isCancelled = o.status === 'cancelled';
        return `
        <div class="order-card" style="position:relative; overflow:hidden; padding: 15px; ${isCancelled ? 'opacity:0.6; filter:grayscale(1)' : ''}">
          ${isCancelled ? `
            <div style="position:absolute; inset:0; background:rgba(239,68,68,0.1); display:flex; align-items:center; justify-content:center; z-index:2; pointer-events:none">
              <div style="border:3px solid #ef4444; color:#ef4444; padding:5px 15px; border-radius:10px; font-weight:900; font-size:1.5rem; transform:rotate(-15deg); text-transform:uppercase; letter-spacing:2px">CANCELLED</div>
            </div>
          ` : ''}
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px">
            <div>
              <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px">
                <span style="background:rgba(255,107,0,0.15); color:var(--primary); padding:4px 8px; border-radius:6px; font-weight:900; font-size:0.8rem">#${o.id.toString().slice(-4)}</span>
                <span style="font-size:0.7rem; color:var(--muted); font-weight:700">${new Date(o.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
              </div>
              <div style="font-weight:900; font-size:1.05rem; letter-spacing:-0.3px">${o.customer_name}</div>
              <div style="display:flex; align-items:center; gap:8px; margin-top:2px">
                <span style="font-size:0.75rem; color:var(--muted)">${o.customer_phone}</span>
                <a href="https://www.google.com/maps/search/?api=1&query=${o.delivery_lat},${o.delivery_lng}" target="_blank" style="color:var(--accent); font-size:0.7rem; text-decoration:none; display:flex; align-items:center; gap:3px;">
                  <i data-lucide="map-pin" style="width:12px; height:12px;"></i> MAP
                </a>
              </div>
            </div>
            <button class="mini-btn danger" onclick="updateStatus(${o.id}, 'cancelled')" style="padding:6px; height:32px; width:32px; display:flex; align-items:center; justify-content:center; border-radius:8px; background:rgba(239,68,68,0.1); border-color:rgba(239,68,68,0.2); color:#ef4444; ${isCancelled ? 'display:none;' : ''}">
              <i data-lucide="x" style="width:16px; height:16px;"></i>
            </button>
          </div>
          
          <div style="background:rgba(0,0,0,0.2); border-radius:12px; padding:12px; margin-bottom:15px; border:1px solid rgba(255,255,255,0.02)">
            ${o.order_items.map(i => `
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; font-size:0.85rem">
                <div style="display:flex; gap:8px; flex:1">
                  <span style="background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; font-weight:800; font-size:0.75rem; height:fit-content">${i.quantity}x</span>
                  <div style="line-height:1.2">
                    <span style="font-weight:700; color:var(--text)">${i.item_name}</span>
                    <div style="font-size:0.7rem; color:var(--muted); margin-top:2px">${i.size}</div>
                  </div>
                </div>
                <span style="font-weight:800; color:var(--text); padding-left:10px">₹${i.price * i.quantity}</span>
              </div>
            `).join('')}
          </div>

          <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-top:10px; ${isCancelled ? 'pointer-events:none; opacity:0.3' : ''}">
            <div style="display:flex; flex-direction:column; gap:6px">
              <span class="status-badge badge-${o.status}" style="width:fit-content; font-size:0.6rem">${o.status}</span>
              <div style="font-weight:900; font-size:1.3rem; color:var(--primary); line-height:1">₹${o.total_amount}</div>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; flex:1; padding-left:10px">
              <button class="mini-btn" onclick="updateStatus(${o.id}, 'cooking')" style="display:flex; align-items:center; gap:4px; padding:8px 12px; border-radius:10px">
                <i data-lucide="chef-hat" style="width:14px; height:14px"></i> COOK
              </button>
              <button class="mini-btn primary" onclick="updateStatus(${o.id}, 'completed')" style="display:flex; align-items:center; gap:4px; padding:8px 12px; border-radius:10px">
                <i data-lucide="check-circle" style="width:14px; height:14px"></i> FINISH
              </button>
              <button class="mini-btn" onclick="billOrder(${o.id})" style="background:rgba(0,242,255,0.1); border-color:rgba(0,242,255,0.2); color:var(--accent); display:flex; align-items:center; gap:4px; padding:8px 12px; border-radius:10px">
                <i data-lucide="receipt" style="width:14px; height:14px"></i> BILL
              </button>
            </div>
          </div>
        </div>
      `}).join('');
      updateDashboardStats();
      if (window.lucide) window.lucide.createIcons();
      
      updateStats(data);
    }

    async function updateStats(data) {
      if (!data) return;
      const rev = data.filter(o => o.status === 'completed').reduce((acc, o) => acc + o.total_amount, 0);
      const active = data.filter(o => !['completed', 'cancelled'].includes(o.status)).length;
      
      const revEl = document.getElementById('revenueToday');
      const actEl = document.getElementById('activeOrders');
      if (revEl) revEl.innerText = '₹' + rev;
      if (actEl) actEl.innerText = active;
    }

    function getCategorySortIndex(catName) {
      if (!window.allCategories) return 9999;
      const idx = window.allCategories.findIndex(c => c.name === catName);
      return idx === -1 ? 9999 : idx;
    }

    async function loadProducts() {
      let data = null;
      try {
        const res = await supabaseClient.from('menu_items').select('*');
        data = res.data;
        if (data && data.length > 0) {
          await db.menu_items.clear();
          await db.menu_items.bulkPut(data);
        }
      } catch (err) {
        console.warn('Failed to load products from Supabase, checking local cache:', err);
      }

      if (!data) {
        try {
          data = await db.menu_items.toArray();
        } catch (e) {
          console.warn('Failed to load products from Dexie:', e);
        }
      }

      if (!data) return;
      
      // Sort data: category's sort_order first, then item's sort_order, then name
      data.sort((a, b) => {
        const catIdxA = getCategorySortIndex(a.category);
        const catIdxB = getCategorySortIndex(b.category);
        if (catIdxA !== catIdxB) return catIdxA - catIdxB;
        if (a.sort_order !== b.sort_order) return (a.sort_order || 0) - (b.sort_order || 0);
        return a.name.localeCompare(b.name);
      });
      
      window.allProducts = data;
      const statTotalItemsEl = document.getElementById('statTotalItems');
      if (statTotalItemsEl) statTotalItemsEl.innerText = data.length;
      renderProducts(data);
      populateCategoryDropdown();
    }

    function populateCategoryDropdown() {
      const select = document.getElementById('itemCat');
      const filterSelect = document.getElementById('categoryFilter');
      const cats = window.allCategories || [];
      const catNames = cats.length > 0
        ? cats.map(c => c.name)
        : [...new Set((window.allProducts || []).map(p => p.category))].sort();
      
      select.innerHTML = catNames.map(c => `<option value="${c}">${c}</option>`).join('') + 
        `<option value="__new__">+ Create New Category...</option>`;
      
      if (filterSelect) {
        const currentValue = filterSelect.value;
        filterSelect.innerHTML = `<option value="all">All Items</option>` + 
          catNames.map(c => `<option value="${c}">${c}</option>`).join('');
        if (catNames.includes(currentValue)) {
          filterSelect.value = currentValue;
        } else {
          filterSelect.value = 'all';
        }
      }
    }

    function handleCategoryChange(val) {
      const newCatGroup = document.getElementById('newCatGroup');
      const itemCatNew = document.getElementById('itemCatNew');
      if (val === '__new__') {
        newCatGroup.classList.remove('hidden');
        itemCatNew.setAttribute('required', 'true');
      } else {
        newCatGroup.classList.add('hidden');
        itemCatNew.removeAttribute('required');
        itemCatNew.value = '';
      }
    }

    function previewImage(input) {
      if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
          document.getElementById('imagePreview').src = e.target.result;
          document.getElementById('imagePreview').classList.remove('hidden');
          document.getElementById('uploadPlaceholder').classList.add('hidden');
        }
        reader.readAsDataURL(input.files[0]);
      }
    }

    function renderProducts(products) {
      const body = document.getElementById('productsBody');
      if (!products || products.length === 0) {
        body.innerHTML = '<div style="padding: 30px; text-align: center; color: var(--muted); font-weight:700;">No items found.</div>';
        return;
      }

      // Group by category
      const grouped = {};
      products.forEach(p => {
        const cat = p.category || 'Uncategorized';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(p);
      });

      let html = '';
      for (const [cat, items] of Object.entries(grouped)) {
        html += `
          <div class="category-header">
            <h3>${cat}</h3>
            <span class="item-count">${items.length} items</span>
          </div>
          <div class="category-grid">
            ${items.map(i => `
              <div class="product-card">
                ${i.image_url 
                  ? `<img src="${i.image_url}" class="product-img" loading="lazy">`
                  : `<div class="product-emoji">${i.emoji || '🍕'}</div>`
                }
                <div class="product-card-content">
                  <div class="product-card-title">${i.name}</div>
                  <div class="product-card-meta">Sort Order #${i.sort_order || 0}</div>
                  <div class="product-card-prices">
                    ${Object.entries(i.sizes || {}).map(([s, p]) => `<span class="price-pill"><b>${s[0]}</b> ₹${p}</span>`).join('')}
                  </div>
                </div>
                <div class="product-card-actions">
                  <div style="display:flex; gap:6px; width:100%">
                    <button class="mini-btn" onclick="editProduct(${i.id})" style="flex:1; display:flex; align-items:center; justify-content:center; gap:4px; padding:8px 12px"><i data-lucide="edit-2" style="width:14px; height:14px"></i> EDIT</button>
                    <button class="mini-btn" onclick="deleteProduct(${i.id}, '${i.name.replace(/'/g, "\\'")}')" style="flex:1; border-color:rgba(239,68,68,0.2); color:#ef4444; background:rgba(239,68,68,0.05); display:flex; align-items:center; justify-content:center; gap:4px; padding:8px 12px"><i data-lucide="trash-2" style="width:14px; height:14px"></i> DEL</button>
                  </div>
                  <div style="display:flex; justify-content:space-between; align-items:center; width:100%; margin-top:12px">
                    <span style="font-size:0.65rem; color:var(--muted); font-weight:800; letter-spacing:0.5px">${i.available ? 'AVAILABLE' : 'HIDDEN'}</span>
                    <label class="toggle-switch" style="margin:0">
                      <input type="checkbox" ${i.available ? 'checked' : ''} onchange="toggleAvailable(${i.id}, this.checked)">
                      <span class="slider"></span>
                    </label>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        `;
      }
      body.innerHTML = html;
      if (window.lucide) window.lucide.createIcons();
    }

    async function deleteProduct(id, name) {
      const msg = `Are you sure you want to permanently delete "${name}"?\n\nTIP: If you just want to hide this item from your menu temporarily, click Cancel and toggle the "AVAILABLE" switch instead!`;
      if (!confirm(msg)) return;
      try {
        const { error } = await supabaseClient.from('menu_items').delete().eq('id', id);
        if (error) throw error;
        await loadProducts();
      } catch (err) {
        alert('Error deleting menu item: ' + err.message);
      }
    }

    async function updateStatus(id, status) {
      if (status === 'cancelled') {
        if (!confirm('Are you sure you want to completely cancel this order? This action cannot be easily undone.')) {
          return;
        }
      }

      try {
        const localOrd = await db.local_orders.get(id);
        if (localOrd) {
          await db.local_orders.update(id, { status, sync_status: 'pending' });
        }
      } catch (e) {
        console.warn('Failed to update local order cache:', e);
      }

      try {
        const { error } = await supabaseClient.from('orders').update({ status }).eq('id', id);
        if (error) throw error;
        await db.local_orders.update(id, { sync_status: 'synced' });
      } catch (err) {
        console.warn('Failed to update order status on Supabase, will retry:', err);
        if (!navigator.onLine) {
          showToast('KDS updated offline. Will sync later. 💾');
        }
      }

      await loadOrders();
    }

    // --- SETTINGS TABS LOGIC ---
    function switchSettingsTab(tabId) {
      document.querySelectorAll('.settings-tab-content').forEach(el => {
        el.style.display = 'none';
      });
      document.querySelectorAll('.settings-tab').forEach(btn => {
        btn.style.background = 'var(--glass)';
        btn.style.color = 'var(--muted)';
        btn.classList.remove('active');
      });
      const panel = document.getElementById('settingsTab-' + tabId);
      if (panel) panel.style.display = 'flex';
      const btn = document.getElementById('stab-' + tabId);
      if (btn) {
        btn.style.background = 'var(--primary)';
        btn.style.color = '#fff';
        btn.classList.add('active');
      }
    }

    function previewSettingsLogo(url) {
      const img = document.getElementById('settingsLogoPreview');
      if (url && url.startsWith('http')) {
        img.src = url;
        img.style.display = 'block';
      } else {
        img.style.display = 'none';
      }
    }

    // Settings key-to-element mapping
    const SETTINGS_MAP = {
      // Branding
      store_name: { el: 'set_store_name', default: 'Grill & Chill' },
      store_tagline: { el: 'set_store_tagline', default: 'Authentic Wood-Fired Pizzeria & Restaurant' },
      store_address: { el: 'set_store_address', default: 'Raikot Road, Sandhaur, Malerkotla', type: 'textarea' },
      store_phone: { el: 'set_store_phone', default: '79019 94174' },
      currency_symbol: { el: 'set_currency_symbol', default: '₹' },
      store_website: { el: 'set_store_website', default: 'https://grillandchillpizzeria.juvaid.in' },
      logo_url: { el: 'set_logo_url', default: 'https://grillandchillpizzeria.juvaid.in/assets/logo-receipt-bw.png' },
      brand_color: { el: 'set_brand_color', default: '#ff6b00', type: 'color' },
      // Payment
      upi_id: { el: 'set_upi_id', default: 'paytm.slux68h@pty' },
      merchant_name: { el: 'set_merchant_name', default: 'Grill & Chill' },
      default_payment: { el: 'set_default_payment', default: 'UPI' },
      enable_card: { el: 'set_enable_card', default: 'false', type: 'checkbox' },
      // Ordering
      enable_delivery: { el: 'set_enable_delivery', default: 'true', type: 'checkbox' },
      delivery_fee: { el: 'set_delivery_fee', default: '0' },
      free_delivery_above: { el: 'set_free_delivery_above', default: '0' },
      min_order: { el: 'set_min_order', default: '0' },
      whatsapp_number: { el: 'set_whatsapp_number', default: '917901994174' },
      enable_tables: { el: 'set_enable_tables', default: 'false', type: 'checkbox' },
      refreshment_items: { el: 'set_refreshment_items', default: 'Cold Coffee, Chocolate Shake, Pepsi' },
      // Hours
      store_open: { el: 'set_store_open', default: 'true', type: 'checkbox' },
      open_time: { el: 'set_open_time', default: '10:00' },
      close_time: { el: 'set_close_time', default: '22:00' },
      days_open: { el: null, default: 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', type: 'days' },
      announcement: { el: 'set_announcement', default: '🛵 FREE HOME DELIVERY ON ALL ORDERS! CALL: 79019 94174 📞', type: 'textarea' },
      // Receipt
      receipt_store_name: { el: 'set_receipt_store_name', default: 'GRILL & CHILL (SANDHAUR)' },
      receipt_store_tagline: { el: 'set_receipt_store_tagline', default: 'Premium Pizzas & Fast Food' },
      receipt_store_address: { el: 'set_receipt_store_address', default: 'Raikot Rd, Near Bus Stand, Sandhaur', type: 'textarea' },
      receipt_store_phone: { el: 'set_receipt_store_phone', default: '79019 94174' },
      receipt_qr_url: { el: 'set_receipt_qr_url', default: 'https://grillandchillpizzeria.juvaid.in' },
      receipt_tax_note: { el: 'set_receipt_tax_note', default: 'Prices inclusive of taxes' },
      receipt_footer: { el: 'set_receipt_footer', default: 'Thank you! Visit again.' },
      receipt_footer_subtext: { el: 'set_receipt_footer_subtext', default: 'Order Online • Free Delivery' },
      receipt_url: { el: 'set_receipt_url', default: 'grillandchillpizzeria.juvaid.in' },
      receipt_logo: { el: 'set_receipt_logo', default: 'true', type: 'checkbox' },
      instagram: { el: 'set_instagram', default: 'https://instagram.com/grillandchill' },
      facebook: { el: 'set_facebook', default: 'https://facebook.com/grillandchill' },
      google_maps: { el: 'set_google_maps', default: 'https://maps.app.goo.gl/HBKW128rAQaijUuM7?g_st=aw' }
    };

    // Global store settings cache
    window.storeSettings = {};

    async function loadSettings() {
      let data = null;
      let error = null;
      try {
        const res = await supabaseClient
          .from('store_settings')
          .select('*');
        data = res.data;
        error = res.error;
        if (data && !error && data.length > 0) {
          await db.store_settings.clear();
          await db.store_settings.bulkPut(data);
        }
      } catch (err) {
        console.warn('Failed to load store settings from Supabase, checking local cache:', err);
      }

      if (!data || error) {
        try {
          data = await db.store_settings.toArray();
        } catch (e) {
          console.warn('Failed to load store settings from Dexie:', e);
        }
      }

      const settings = {};
      if (data && data.length > 0) {
        data.forEach(row => { settings[row.key] = row.value; });
        localStorage.setItem('gc_store_settings', JSON.stringify(settings));
      } else {
        try {
          const cached = localStorage.getItem('gc_store_settings');
          if (cached) {
            Object.assign(settings, JSON.parse(cached));
          }
        } catch (e) {}
      }

      // Also sync legacy localStorage values if DB is empty
      if (!settings.upi_id) {
        settings.upi_id = localStorage.getItem('gc_store_upi_id') || SETTINGS_MAP.upi_id.default;
      }
      if (!settings.merchant_name) {
        settings.merchant_name = localStorage.getItem('gc_store_merchant_name') || SETTINGS_MAP.merchant_name.default;
      }

      // Populate all form fields
      for (const [key, config] of Object.entries(SETTINGS_MAP)) {
        const val = settings[key] || config.default;
        window.storeSettings[key] = val;

        if (config.type === 'checkbox') {
          const el = document.getElementById(config.el);
          if (el) el.checked = val === 'true' || val === true;
        } else if (config.type === 'color') {
          const el = document.getElementById(config.el);
          const hexEl = document.getElementById(config.el + '_hex');
          if (el) el.value = val;
          if (hexEl) hexEl.value = val;
        } else if (config.type === 'days') {
          const days = (val || config.default).split(',');
          document.querySelectorAll('.day-checkbox').forEach(cb => {
            cb.checked = days.includes(cb.value);
          });
        } else if (config.el) {
          const el = document.getElementById(config.el);
          if (el) el.value = val;
        }
      }

      // Preview logo if exists
      if (settings.logo_url) {
        previewSettingsLogo(settings.logo_url);
      }

      // Keep legacy localStorage in sync
      localStorage.setItem('gc_store_upi_id', window.storeSettings.upi_id);
      localStorage.setItem('gc_store_merchant_name', window.storeSettings.merchant_name);

      loadLocationStats();
    }

    async function saveAllSettings() {
      const rows = [];
      
      for (const [key, config] of Object.entries(SETTINGS_MAP)) {
        let val;
        if (config.type === 'checkbox') {
          val = document.getElementById(config.el)?.checked ? 'true' : 'false';
        } else if (config.type === 'color') {
          val = document.getElementById(config.el)?.value || config.default;
        } else if (config.type === 'days') {
          const checked = [...document.querySelectorAll('.day-checkbox:checked')].map(cb => cb.value);
          val = checked.join(',');
        } else if (config.el) {
          val = document.getElementById(config.el)?.value?.trim() || '';
        }
        
        if (val !== undefined) {
          rows.push({ key, value: val });
          window.storeSettings[key] = val;
        }
      }

      // Keep legacy localStorage in sync
      localStorage.setItem('gc_store_upi_id', window.storeSettings.upi_id || '');
      localStorage.setItem('gc_store_merchant_name', window.storeSettings.merchant_name || '');

      try {
        const { error } = await supabaseClient.from('store_settings').upsert(rows);
        if (error) throw error;

        // Clear and update Dexie cache
        await db.store_settings.clear();
        await db.store_settings.bulkPut(rows);
        const settings = {};
        rows.forEach(row => { settings[row.key] = row.value; });
        localStorage.setItem('gc_store_settings', JSON.stringify(settings));

        showToast('All settings saved successfully! ⚙️');
      } catch (err) {
        console.error('Failed to save settings to Supabase, saving locally:', err);
        try {
          await db.store_settings.clear();
          await db.store_settings.bulkPut(rows);
          const settings = {};
          rows.forEach(row => { settings[row.key] = row.value; });
          localStorage.setItem('gc_store_settings', JSON.stringify(settings));
          showToast('Settings saved locally! 💾');
        } catch (localErr) {
          console.error('Failed to save settings locally:', localErr);
          showToast('Failed to save settings online. Check console.');
        }
      }
    }

    async function loadLocationStats() {
      const statsList = document.getElementById('locationStatsList');
      if (!statsList) return;
      
      statsList.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted); font-size:0.8rem;">Loading location stats...</div>';
      
      try {
        const { data, error } = await supabaseClient
          .from('orders')
          .select('*, order_items(*)')
          .order('created_at', { ascending: false });
          
        if (error) throw error;
        
        // Filter orders that have location data (either GPS coords or typed address)
        const locationOrders = data.filter(o => (o.delivery_lat && o.delivery_lng) || o.delivery_address);
        
        if (locationOrders.length === 0) {
          statsList.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted); font-size:0.85rem;">No customer orders with location data found.</div>';
          return;
        }
        
        statsList.innerHTML = locationOrders.map(o => {
          const itemsStr = o.order_items.map(item => {
            const sz = item.size ? ` (${item.size})` : '';
            return `${item.quantity}x ${item.item_name}${sz}`;
          }).join(', ');
          
          const date = new Date(o.created_at).toLocaleString('en-IN', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
          });
          
          const hasGps = o.delivery_lat && o.delivery_lng;
          
          return `
            <div class="stat-card" style="background: rgba(255,255,255,0.02); border: 1px solid var(--border); padding: 15px; border-radius: 12px; display: flex; flex-direction: column; gap: 8px; cursor: default;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div>
                  <div style="font-weight: 800; font-size: 0.9rem; color: var(--text);">${o.customer_name}</div>
                  <div style="font-size: 0.75rem; color: var(--muted);">${o.customer_phone}</div>
                </div>
                <div style="text-align: right;">
                  <div style="font-weight: 800; font-size: 0.85rem; color: var(--primary);">₹${o.total_amount}</div>
                  <div style="font-size: 0.65rem; color: var(--muted);">${date}</div>
                </div>
              </div>
              <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.05); margin: 4px 0;">
              <div>
                <span style="font-size: 0.7rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;">Ordered:</span>
                <span style="font-size: 0.8rem; color: var(--text);">${itemsStr}</span>
              </div>
              ${o.delivery_address ? `
                <div style="margin-top: 2px;">
                  <span style="font-size: 0.7rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;">Address:</span>
                  <span style="font-size: 0.8rem; color: var(--text);">${o.delivery_address}</span>
                </div>
              ` : ''}
              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; gap: 10px;">
                <div>
                  <span style="font-size: 0.7rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px;">Coords:</span>
                  <span style="font-size: 0.75rem; color: var(--text); font-family: monospace;">
                    ${hasGps ? `${Number(o.delivery_lat).toFixed(5)}, ${Number(o.delivery_lng).toFixed(5)}` : '_(GPS Not shared)_'}
                  </span>
                </div>
                ${hasGps ? `
                  <a href="https://www.google.com/maps?q=${o.delivery_lat},${o.delivery_lng}" target="_blank" class="mini-btn" style="padding: 6px 12px; font-size: 0.65rem; color: var(--primary); border-color: var(--primary); background: rgba(255,107,0,0.05); text-decoration: none; border-radius: 8px; font-weight: 700; display: flex; align-items: center; gap: 4px; white-space: nowrap;">
                    📍 VIEW MAP
                  </a>
                ` : ''}
              </div>
            </div>
          `;
        }).join('');
      } catch (err) {
        console.error(err);
        statsList.innerHTML = '<div style="text-align:center; padding:20px; color:var(--danger); font-size:0.8rem;">Failed to load location stats.</div>';
      }
    }

    function sendWhatsAppReceipt(phone, bill) {
      let cleanedPhone = String(phone).replace(/\D/g, '');
      if (cleanedPhone.length === 10) {
        cleanedPhone = '91' + cleanedPhone;
      }
      const text = generateReceiptText(bill);
      const url = `https://wa.me/${cleanedPhone}?text=${encodeURIComponent(text)}`;
      window.open(url, '_blank');
    }

    function selectPaymentMethodForOrder(order, callback, onCancel) {
      const modal = document.getElementById('paymentMethodModal');
      const details = document.getElementById('payMethodOrderDetails');
      const btnCash = document.getElementById('payMethodCashBtn');
      const btnUpi = document.getElementById('payMethodUpiBtn');
      const btnCancel = document.getElementById('payMethodCancelBtn');
      
      details.innerText = `Order #${order.id.toString().slice(-4)} · Total: ₹${order.total_amount}`;
      modal.style.display = 'flex';
      
      const cleanUp = () => {
        modal.style.display = 'none';
        window.removeEventListener('keydown', handleKeydown);
      };
      
      const select = (method) => {
        cleanUp();
        callback(method);
      };
      
      const cancel = () => {
        cleanUp();
        if (onCancel) onCancel();
      };
      
      btnCash.onclick = () => select('Cash');
      btnUpi.onclick = () => select('UPI');
      btnCancel.onclick = () => cancel();
      
      function handleKeydown(e) {
        if (e.key === 'Escape') {
          cancel();
        } else if (e.key === 'c' || e.key === 'C') {
          select('Cash');
        } else if (e.key === 'u' || e.key === 'U') {
          select('UPI');
        }
      }
      
      window.addEventListener('keydown', handleKeydown);
    }

    async function billOrder(orderId) {
      const order = (window.allOrders || []).find(o => o.id === orderId);
      if (!order) return alert('Order not found!');
      
      selectPaymentMethodForOrder(order, async (paymentMethod) => {
        // Map order_items to flat bill items
        const billItems = [];
        order.order_items.forEach(oi => {
          const qty = oi.quantity || 1;
          const basePrice = Number(oi.price);
          
          let addonPrice = 0;
          let nameWithAddons = oi.item_name;
          if (oi.addons && Array.isArray(oi.addons) && oi.addons.length > 0) {
            const addonNames = oi.addons.map(a => a.name).join(', ');
            nameWithAddons += ` + ${addonNames}`;
            addonPrice = oi.addons.reduce((sum, a) => sum + Number(a.price), 0);
          }
          
          for (let q = 0; q < qty; q++) {
            billItems.push({
              id: oi.menu_item_id,
              name: nameWithAddons,
              size: oi.size,
              price: basePrice + addonPrice
            });
          }
        });

        const saveAndComplete = async () => {
          const uid = generateUUID();
          const billData = {
            id: uid,
            client_uuid: uid,
            customer_name: order.customer_name || 'Online Customer',
            customer_phone: order.customer_phone || 'N/A',
            total_amount: order.total_amount,
            items: JSON.stringify(billItems),
            payment_status: 'paid',
            payment_method: paymentMethod,
            created_at: new Date().toISOString(),
            sync_status: 'pending'
          };

          try {
            await db.local_bills.add(billData);
            showToast('Bill Created offline! 💾');
            
            const { error: orderErr } = await supabaseClient
              .from('orders')
              .update({ status: 'completed', payment_status: 'paid' })
              .eq('id', orderId);
            
            if (orderErr) throw orderErr;
            
            await loadOrders();
            syncBills();
            generateReceipt(billData, false);
          } catch (err) {
            console.error('Billing failed:', err);
            alert('Error billing order: ' + err.message);
          }
        };

        if (paymentMethod === 'UPI') {
          const storeUpi = localStorage.getItem('gc_store_upi_id') || 'juvaidpb13@okaxis';
          const storeName = localStorage.getItem('gc_store_merchant_name') || 'Grill & Chill';
          const upiUrl = `upi://pay?pa=${storeUpi}&pn=${encodeURIComponent(storeName)}&am=${order.total_amount}&cu=INR`;
          
          window.upiCurrentPhone = order.customer_phone;
          window.upiCurrentAmount = order.total_amount;
          
          const qr = new QRious({
            value: upiUrl,
            size: 200
          });
          document.getElementById('upiQrCodeImg').src = qr.toDataURL();
          document.getElementById('upiPayAmount').innerText = `₹${order.total_amount}`;
          document.getElementById('upiPayDetails').innerText = `To: ${storeUpi}`;
          
          const shareBtn = document.getElementById('upiShareWhatsAppBtn');
          if (shareBtn) {
            if (window.upiCurrentPhone && window.upiCurrentPhone !== 'N/A' && window.upiCurrentPhone.trim() !== '') {
              shareBtn.style.display = 'flex';
            } else {
              shareBtn.style.display = 'none';
            }
          }

          document.getElementById('upiPaidBtn').onclick = async () => {
            closeModal('upiPayModal');
            await saveAndComplete();
          };
          document.getElementById('upiPayModal').style.display = 'flex';
        } else {
          await saveAndComplete();
        }
      });
    }

    async function toggleAvailable(id, available) {
      await supabaseClient.from('menu_items').update({ available }).eq('id', id);
    }

    function setDietary(isVeg) {
      document.getElementById('itemIsVeg').value = isVeg ? 'true' : 'false';
      const btnVeg = document.getElementById('btnVeg');
      const btnNonVeg = document.getElementById('btnNonVeg');
      const container = btnVeg.closest('.segmented-control');
      if (isVeg) {
        btnVeg.classList.add('active');
        btnNonVeg.classList.remove('active');
        if (container) container.classList.remove('nonveg-active');
      } else {
        btnVeg.classList.remove('active');
        btnNonVeg.classList.add('active');
        if (container) container.classList.add('nonveg-active');
      }
    }

    function resetTagChips() {
      document.getElementById('itemTags').value = '[]';
      const activeList = document.getElementById('activeTagsList');
      if (activeList) activeList.innerHTML = '';
      const dropdown = document.getElementById('tagDropdown');
      if (dropdown) dropdown.value = '';
    }

    function setSelectedTags(tagsArr) {
      resetTagChips();
      if (!tagsArr || !Array.isArray(tagsArr)) return;
      document.getElementById('itemTags').value = JSON.stringify(tagsArr);
      tagsArr.forEach(t => {
        renderActiveTag(t);
      });
    }

    function handleTagSelect(tagVal) {
      if (!tagVal) return;
      let tags = JSON.parse(document.getElementById('itemTags').value || '[]');
      if (!tags.includes(tagVal)) {
        tags.push(tagVal);
        document.getElementById('itemTags').value = JSON.stringify(tags);
        renderActiveTag(tagVal);
      }
      document.getElementById('tagDropdown').value = '';
    }

    function renderActiveTag(tagVal) {
      const list = document.getElementById('activeTagsList');
      if (!list) return;
      const emojis = {
        'Spicy': '🔥',
        'Best Seller': '⭐',
        'New': '🆕',
        'Popular': '🌟',
        'Special': '🎉'
      };
      const emoji = emojis[tagVal] || '';
      const tagClass = tagVal.toLowerCase().replace(' ', '-');
      
      const chip = document.createElement('div');
      chip.className = `tag-chip active ${tagClass}`;
      chip.style.margin = '0';
      chip.style.padding = '4px 10px';
      chip.style.fontSize = '0.68rem';
      chip.style.display = 'inline-flex';
      chip.style.alignItems = 'center';
      chip.style.gap = '4px';
      chip.style.borderRadius = '6px';
      chip.style.cursor = 'pointer';
      chip.innerHTML = `${emoji} ${tagVal} <i data-lucide="x" style="width:10px; height:10px; margin-left: 2px; opacity: 0.7;"></i>`;
      
      chip.onclick = () => {
        removeActiveTag(tagVal, chip);
      };
      list.appendChild(chip);
      if (window.lucide) window.lucide.createIcons();
    }

    function removeActiveTag(tagVal, chipEl) {
      let tags = JSON.parse(document.getElementById('itemTags').value || '[]');
      tags = tags.filter(t => t !== tagVal);
      document.getElementById('itemTags').value = JSON.stringify(tags);
      chipEl.remove();
    }

    function addSizeRow(name = '', price = '') {
      const container = document.getElementById('sizesBuilderContainer');
      const rowId = `size-row-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
      const rowDiv = document.createElement('div');
      rowDiv.id = rowId;
      rowDiv.className = 'builder-row';
      rowDiv.style.display = 'grid';
      rowDiv.style.gridTemplateColumns = '2fr 1fr 38px';
      rowDiv.style.gap = '10px';
      rowDiv.style.alignItems = 'center';
      rowDiv.style.marginTop = '8px';
      rowDiv.style.animation = 'scaleIn 0.2s ease-out';
      rowDiv.innerHTML = `
        <input type="text" class="auth-input size-name" value="${name}" placeholder="e.g. Regular" style="margin-bottom:0;" required>
        <div style="position:relative; display:flex; align-items:center;">
          <span class="price-symbol">₹</span>
          <input type="number" class="auth-input size-price" value="${price}" placeholder="199" min="0" style="margin-bottom:0; width:100%" required>
        </div>
        <button type="button" onclick="document.getElementById('${rowId}').remove()" class="trash-btn">
          <i data-lucide="trash-2" style="width:14px; height:14px;"></i>
        </button>
      `;
      container.appendChild(rowDiv);
      if (window.lucide) window.lucide.createIcons();
    }
    
    function addAddonRow(name = '', price = '') {
      const container = document.getElementById('addonsBuilderContainer');
      const rowId = `addon-row-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
      const rowDiv = document.createElement('div');
      rowDiv.id = rowId;
      rowDiv.className = 'builder-row';
      rowDiv.style.display = 'grid';
      rowDiv.style.gridTemplateColumns = '2fr 1fr 38px';
      rowDiv.style.gap = '10px';
      rowDiv.style.alignItems = 'center';
      rowDiv.style.marginTop = '8px';
      rowDiv.style.animation = 'scaleIn 0.2s ease-out';
      rowDiv.innerHTML = `
        <input type="text" class="auth-input addon-name" value="${name}" placeholder="e.g. Extra Cheese" style="margin-bottom:0;" required>
        <div style="position:relative; display:flex; align-items:center;">
          <span class="price-symbol">₹</span>
          <input type="number" class="auth-input addon-price" value="${price}" placeholder="50" min="0" style="margin-bottom:0; width:100%" required>
        </div>
        <button type="button" onclick="document.getElementById('${rowId}').remove()" class="trash-btn">
          <i data-lucide="trash-2" style="width:14px; height:14px;"></i>
        </button>
      `;
      container.appendChild(rowDiv);
      if (window.lucide) window.lucide.createIcons();
    }

    function getSizesFromBuilder() {
      const rows = document.querySelectorAll('#sizesBuilderContainer > div');
      const sizes = {};
      rows.forEach(row => {
        const name = row.querySelector('.size-name').value.trim();
        const price = Number(row.querySelector('.size-price').value);
        if (name) {
          sizes[name] = price;
        }
      });
      return sizes;
    }
    
    function getAddonsFromBuilder() {
      const rows = document.querySelectorAll('#addonsBuilderContainer > div');
      const addons = [];
      rows.forEach(row => {
        const name = row.querySelector('.addon-name').value.trim();
        const price = Number(row.querySelector('.addon-price').value);
        if (name) {
          addons.push({ name, price });
        }
      });
      return addons;
    }

    function populateSizesBuilder(sizesObj) {
      const container = document.getElementById('sizesBuilderContainer');
      container.innerHTML = '';
      if (!sizesObj || typeof sizesObj !== 'object') return;
      Object.entries(sizesObj).forEach(([name, price]) => {
        addSizeRow(name, price);
      });
      if (container.children.length === 0) {
        addSizeRow('Regular', '');
      }
    }
    
    function populateAddonsBuilder(addonsArr) {
      const container = document.getElementById('addonsBuilderContainer');
      container.innerHTML = '';
      if (!addonsArr || !Array.isArray(addonsArr)) return;
      addonsArr.forEach(addon => {
        addAddonRow(addon.name, addon.price);
      });
    }

    function showProductModal() {
      document.getElementById('productForm').reset();
      document.getElementById('itemId').value = '';
      document.getElementById('modalTitle').innerText = 'Add New Item';
      document.getElementById('imagePreview').classList.add('hidden');
      document.getElementById('uploadPlaceholder').classList.remove('hidden');
      
      populateSizesBuilder({"Regular": 199});
      populateAddonsBuilder([]);
      setDietary(true);
      resetTagChips();
      
      // Reset category select & hide new category text box
      const select = document.getElementById('itemCat');
      if (select && select.options.length > 0) {
        select.value = select.options[0].value;
        handleCategoryChange(select.value);
      } else {
        handleCategoryChange('');
      }

      document.getElementById('productModal').style.display = 'flex';
    }

    function editProduct(id) {
      const item = window.allProducts.find(p => p.id === id);
      document.getElementById('itemId').value = item.id;
      document.getElementById('itemName').value = item.name;
      document.getElementById('itemCat').value = item.category;
      handleCategoryChange(item.category);
      document.getElementById('itemEmoji').value = item.emoji;
      document.getElementById('itemDesc').value = item.description || '';
      
      populateSizesBuilder(item.sizes);
      populateAddonsBuilder(item.addons);
      setDietary(item.is_veg !== false);
      setSelectedTags(item.tags || []);
      
      document.getElementById('itemSortOrder').value = item.sort_order || 0;
      document.getElementById('itemAvailable').value = item.available ? 'true' : 'false';
      
      if (item.image_url) {
        document.getElementById('imagePreview').src = item.image_url;
        document.getElementById('imagePreview').classList.remove('hidden');
        document.getElementById('uploadPlaceholder').classList.add('hidden');
      } else {
        document.getElementById('imagePreview').classList.add('hidden');
        document.getElementById('uploadPlaceholder').classList.remove('hidden');
      }
      
      document.getElementById('modalTitle').innerText = 'Edit Item';
      document.getElementById('productModal').style.display = 'flex';
    }


    function filterProducts() {
      const query = document.getElementById('menuSearch').value.toLowerCase();
      const category = document.getElementById('categoryFilter').value;
      const filtered = window.allProducts.filter(p => {
        const matchesSearch = p.name.toLowerCase().includes(query) || p.category.toLowerCase().includes(query);
        const matchesCat = category === 'all' || p.category === category;
        return matchesSearch && matchesCat;
      });
      renderProducts(filtered);
    }

    async function loadCategories() {
      let data = null;
      try {
        const res = await supabaseClient.from('categories').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true });
        data = res.data;
        if (data && data.length > 0) {
          await db.categories.clear();
          await db.categories.bulkPut(data);
        }
      } catch (err) {
        console.warn('Failed to load categories from Supabase, checking local cache:', err);
      }

      if (!data) {
        try {
          data = await db.categories.toArray();
          data.sort((a, b) => {
            if (a.sort_order !== b.sort_order) return (a.sort_order || 0) - (b.sort_order || 0);
            return a.name.localeCompare(b.name);
          });
        } catch (e) {
          console.warn('Failed to load categories from Dexie:', e);
        }
      }

      if (!data) return;
      window.allCategories = data;
      renderCategories(data);
    }

    function renderCategories(cats) {
      const body = document.getElementById('collectionsBody');
      body.innerHTML = cats.map(c => `
        <div class="product-card" style="margin-bottom:15px">
          <img src="${c.image_url || 'assets/woody_bg.png'}" class="product-img" style="border-radius:12px">
          <div style="flex:1">
            <div style="font-weight:800">${c.name}</div>
            <div style="font-size:0.7rem;color:var(--muted); display:flex; align-items:center; gap:5px;">
              Grid Rank: ${c.sort_order} · Size: ${c.layout_size || 'normal'}
              <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${c.color || '#ff6b00'}"></span>
            </div>
            ${c.description ? `<div style="font-size:0.75rem;color:var(--muted);margin-top:2px">${c.description}</div>` : ''}
          </div>
          <div style="display:flex; gap:8px">
            <button class="mini-btn" onclick="editCollection(${c.id})" style="border-color:var(--primary); color:var(--primary)">EDIT</button>
            <button class="mini-btn" onclick="deleteCollection(${c.id}, '${c.name.replace(/'/g, "\\'")}')" style="border-color:#ef4444; color:#ef4444">DELETE</button>
          </div>
        </div>
      `).join('');
    }

    function openCategoriesModal() {
      loadCategories();
      document.getElementById('categoriesModal').style.display = 'flex';
    }

    function addCollection() {
      document.getElementById('collectionForm').reset();
      document.getElementById('catId').value = '';
      document.getElementById('catNameInput').value = '';
      document.getElementById('catDescInput').value = '';
      document.getElementById('catColorInput').value = '#ff6b00';
      
      const maxSort = (window.allCategories || []).reduce((max, c) => Math.max(max, c.sort_order || 0), 0);
      document.getElementById('catSortInput').value = maxSort + 10;
      document.getElementById('catSizeInput').value = 'normal';
      
      document.getElementById('catImagePreview').src = '';
      document.getElementById('catImagePreview').classList.add('hidden');
      document.getElementById('catUploadPlaceholder').classList.remove('hidden');
      
      document.getElementById('collectionModalTitle').innerText = 'Add Category';
      document.getElementById('collectionModal').style.display = 'flex';
    }

    function editCollection(id) {
      const cat = window.allCategories.find(c => c.id === id);
      document.getElementById('catId').value = cat.id;
      document.getElementById('catNameInput').value = cat.name;
      document.getElementById('catDescInput').value = cat.description || '';
      document.getElementById('catColorInput').value = cat.color || '#ff6b00';
      document.getElementById('catSortInput').value = cat.sort_order;
      document.getElementById('catSizeInput').value = cat.layout_size || 'normal';
      if (cat.image_url) {
        document.getElementById('catImagePreview').src = cat.image_url;
        document.getElementById('catImagePreview').classList.remove('hidden');
        document.getElementById('catUploadPlaceholder').classList.add('hidden');
      } else {
        document.getElementById('catImagePreview').classList.add('hidden');
        document.getElementById('catUploadPlaceholder').classList.remove('hidden');
      }
      document.getElementById('collectionModalTitle').innerText = 'Edit Category';
      document.getElementById('collectionModal').style.display = 'flex';
    }

    async function deleteCollection(id, name) {
      if (!confirm(`Are you sure you want to delete the category "${name}"?\nThis will not delete the menu items in it, but they will be categorized under an orphaned category.`)) return;
      try {
        const { error } = await supabaseClient.from('categories').delete().eq('id', id);
        if (error) throw error;
        await loadCategories();
        await loadProducts();
      } catch (err) {
        alert('Error deleting category: ' + err.message);
      }
    }

    function previewCatImage(input) {
      if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = e => {
          document.getElementById('catImagePreview').src = e.target.result;
          document.getElementById('catImagePreview').classList.remove('hidden');
          document.getElementById('catUploadPlaceholder').classList.add('hidden');
        };
        reader.readAsDataURL(input.files[0]);
      }
    }

    document.getElementById('collectionForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const id = document.getElementById('catId').value;
        const name = document.getElementById('catNameInput').value.trim();
        const description = document.getElementById('catDescInput').value.trim();
        const color = document.getElementById('catColorInput').value;
        const sortOrder = parseInt(document.getElementById('catSortInput').value) || 0;
        const layoutSize = document.getElementById('catSizeInput').value;
        const file = document.getElementById('catImageFile').files[0];
        
        let image_url = null;
        if (file) {
          const fileName = `${Date.now()}_cat.png`;
          const { error: uploadError } = await supabaseClient.storage.from('menu-images').upload(`categories/${fileName}`, file);
          if (!uploadError) {
            const { data } = supabaseClient.storage.from('menu-images').getPublicUrl(`categories/${fileName}`);
            image_url = data.publicUrl;
          }
        } else if (id) {
          const existingCat = window.allCategories.find(c => c.id == id);
          image_url = existingCat ? existingCat.image_url : null;
        }

        const catData = { name, description, color, sort_order: sortOrder, layout_size: layoutSize, image_url };

        if (id) {
          const { error } = await supabaseClient.from('categories').update(catData).eq('id', id);
          if (error) throw error;
        } else {
          const { error } = await supabaseClient.from('categories').insert([catData]);
          if (error) throw error;
        }
        
        closeModal('collectionModal');
        await loadCategories();
        await loadProducts();
      } catch (err) {
        alert('Error saving category: ' + err.message);
      }
    };

    function closeModal(id) {
      if (id) {
        document.getElementById(id).style.display = 'none';
      } else {
        // Fallback for any legacy calls
        document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
      }
    }

    document.getElementById('productForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const id = document.getElementById('itemId').value;
        const file = document.getElementById('imageFile').files[0];
        
        let image_url = null;
        if (file) {
          const fileExt = file.name.split('.').pop();
          const fileName = `${Date.now()}.${fileExt}`;
          const filePath = `products/${fileName}`;
          const { error: uploadError } = await supabaseClient.storage.from('menu-images').upload(filePath, file);
          if (!uploadError) {
            const { data } = supabaseClient.storage.from('menu-images').getPublicUrl(filePath);
            image_url = data.publicUrl;
          }
        } else if (id) {
          const existing = window.allProducts.find(p => p.id == id);
          image_url = existing.image_url;
        }

        // 1. Get sizes and addons from builders
        const sizes = getSizesFromBuilder();
        if (Object.keys(sizes).length === 0) {
          alert('Please add at least one Size & Price.');
          return;
        }
        const addons = getAddonsFromBuilder();
        const isVeg = document.getElementById('itemIsVeg').value === 'true';
        const tags = JSON.parse(document.getElementById('itemTags').value || '[]');

        // 2. Handle Inline Category Creation
        let category = document.getElementById('itemCat').value;
        if (category === '__new__') {
          const newCatName = document.getElementById('itemCatNew').value.trim();
          if (!newCatName) {
            alert('Please enter a name for the new category.');
            return;
          }
          
          // Check if already exists (case-insensitive)
          const existingCat = (window.allCategories || []).find(c => c.name.toLowerCase() === newCatName.toLowerCase());
          if (!existingCat) {
            // Find max sort_order
            const maxSort = (window.allCategories || []).reduce((max, c) => Math.max(max, c.sort_order || 0), 0);
            const { data: newCatData, error: catErr } = await supabaseClient
              .from('categories')
              .insert([{ name: newCatName, sort_order: maxSort + 10 }])
              .select().single();
            if (catErr) throw new Error("Failed to create category: " + catErr.message);
            category = newCatName;
            await loadCategories(); // Refresh categories
          } else {
            category = existingCat.name;
          }
        }

        // 3. Auto-calculate sort order if 0 or empty
        let sortOrder = parseInt(document.getElementById('itemSortOrder').value);
        if (isNaN(sortOrder) || sortOrder === 0) {
          const catProducts = (window.allProducts || []).filter(p => p.category === category);
          const maxSort = catProducts.reduce((max, p) => Math.max(max, p.sort_order || 0), 0);
          sortOrder = maxSort + 10;
        }

        const available = document.getElementById('itemAvailable').value === 'true';

        const product = {
          name: document.getElementById('itemName').value.trim(),
          category: category,
          emoji: document.getElementById('itemEmoji').value.trim() || '🍽️',
          description: document.getElementById('itemDesc').value.trim(),
          is_veg: isVeg,
          tags: tags,
          sizes: sizes,
          addons: addons,
          image_url: image_url,
          sort_order: sortOrder,
          available: available
        };

        if (id) await supabaseClient.from('menu_items').update(product).eq('id', id);
        else await supabaseClient.from('menu_items').insert([product]);
        
        closeModal('productModal');
        await loadProducts();
      } catch (err) { alert('Error: ' + err.message); }
    };


    // --- POS / BILLING LOGIC ---
    let currentBillItems = [];
    let allMenuItems = [];
    let posOrderType = 'dine-in';
    let posDiscountMode = 'percent'; // 'percent' or 'flat'

    function selectOrderType(type) {
      posOrderType = type;
      document.querySelectorAll('.order-type-btn').forEach(btn => {
        const isActive = btn.dataset.type === type;
        btn.style.background = isActive ? 'rgba(255,107,0,0.12)' : 'var(--glass)';
        btn.style.color = isActive ? 'var(--primary)' : 'var(--muted)';
        btn.style.borderColor = isActive ? 'var(--primary)' : 'var(--border)';
        btn.classList.toggle('active', isActive);
      });
      // Show table number only for dine-in AND if enabled in settings
      const tableInput = document.getElementById('posTableNumber');
      if (tableInput) {
        const tablesEnabled = window.storeSettings?.enable_tables === 'true';
        tableInput.style.display = (type === 'dine-in' && tablesEnabled) ? 'block' : 'none';
      }
    }

    function setDiscountMode(mode) {
      posDiscountMode = mode;
      document.querySelectorAll('.discount-mode-btn').forEach(btn => {
        const isActive = btn.dataset.mode === mode;
        btn.style.background = isActive ? 'rgba(255,107,0,0.12)' : 'var(--glass)';
        btn.style.color = isActive ? 'var(--primary)' : 'var(--muted)';
      });
      updatePosTotal();
    }

    function clearPosBasket() {
      currentBillItems = [];
      renderBasket();
      updatePosTotal();
    }

    let currentPosMobileTab = 'menu';

    function switchPosMobileTab(tab) {
      currentPosMobileTab = tab;
      const menuBtn = document.getElementById('posTab-menu-btn');
      const cartBtn = document.getElementById('posTab-cart-btn');
      const leftPanel = document.querySelector('.pos-left-panel');
      const rightPanel = document.querySelector('.pos-right-panel');
      const mainLayout = document.querySelector('.pos-main-layout');
      
      if (!menuBtn || !cartBtn || !leftPanel || !rightPanel || !mainLayout) return;
      
      // Clean up any lingering inline styles from previous code version
      leftPanel.style.removeProperty('display');
      rightPanel.style.removeProperty('display');
      
      if (tab === 'menu') {
        menuBtn.style.background = 'rgba(255,107,0,0.12)';
        menuBtn.style.color = 'var(--primary)';
        menuBtn.style.borderColor = 'var(--primary)';
        menuBtn.classList.add('active');
        
        cartBtn.style.background = 'var(--glass)';
        cartBtn.style.color = 'var(--muted)';
        cartBtn.style.borderColor = 'var(--border)';
        cartBtn.classList.remove('active');
        
        mainLayout.classList.remove('mobile-cart-active');
        
        updateMobilePillVisibility();
      } else {
        cartBtn.style.background = 'rgba(255,107,0,0.12)';
        cartBtn.style.color = 'var(--primary)';
        cartBtn.style.borderColor = 'var(--primary)';
        cartBtn.classList.add('active');
        
        menuBtn.style.background = 'var(--glass)';
        menuBtn.style.color = 'var(--muted)';
        menuBtn.style.borderColor = 'var(--border)';
        menuBtn.classList.remove('active');
        
        mainLayout.classList.add('mobile-cart-active');
        
        const pill = document.getElementById('posMobileCartFloatingPill');
        if (pill) pill.style.setProperty('display', 'none', 'important');
      }
    }

    function updateMobilePillVisibility() {
      const pill = document.getElementById('posMobileCartFloatingPill');
      if (!pill) return;
      
      const isMobile = window.innerWidth <= 900;
      const hasItems = currentBillItems.length > 0;
      
      if (isMobile && hasItems && currentPosMobileTab === 'menu') {
        pill.style.setProperty('display', 'flex', 'important');
      } else {
        pill.style.setProperty('display', 'none', 'important');
      }
    }

    async function showQuickBill() {
      let data = null;
      try {
        const res = await supabaseClient.from('menu_items').select('*').eq('available', true).order('category', { ascending: true }).order('sort_order', { ascending: true }).order('name', { ascending: true });
        data = res.data;
      } catch (err) {
        console.warn('Failed to load menu items for POS from Supabase, checking local cache:', err);
      }

      if (!data) {
        try {
          data = await db.menu_items.toArray();
          data = data.filter(i => i.available === true || i.available === 'true' || i.available === 1);
          // Sort category -> sort_order -> name
          data.sort((a, b) => {
            const catA = a.category || '';
            const catB = b.category || '';
            if (catA !== catB) return catA.localeCompare(catB);
            if (a.sort_order !== b.sort_order) return (a.sort_order || 0) - (b.sort_order || 0);
            return a.name.localeCompare(b.name);
          });
        } catch (e) {
          console.warn('Failed to load menu items from Dexie cache:', e);
        }
      }

      if (data && data.length > 0) {
        allMenuItems = data;
        selectedPosCategory = 'all';
        renderPosCategories();
        renderPosItems(data);
        
        // Apply settings-driven visibility
        const cardBtn = document.getElementById('posCardBtn');
        if (cardBtn) cardBtn.style.display = (window.storeSettings?.enable_card === 'true') ? 'flex' : 'none';
        
        const deliveryBtn = document.getElementById('posDeliveryBtn');
        if (deliveryBtn) deliveryBtn.style.display = (window.storeSettings?.enable_delivery === 'true') ? 'flex' : 'none';
        
        // Set default payment method from settings
        const defaultPay = window.storeSettings?.default_payment;
        if (defaultPay) {
          const select = document.getElementById('billPaymentMethod');
          if (select) select.value = defaultPay;
        }
        
        // Reset order type and mobile tabs
        selectOrderType('dine-in');
        switchPosMobileTab('menu');
        
        document.getElementById('quickBillModal').style.display = 'flex';

        // Auto-focus search input for speed
        setTimeout(() => {
          const searchInput = document.getElementById('posSearch');
          if (searchInput) {
            searchInput.focus();
            searchInput.select();
          }
        }, 100);
      } else {
        alert('No menu items available! Please load the admin page while online at least once to cache the menu.');
      }
    }

    function closeQuickBill() {
      document.getElementById('quickBillModal').style.display = 'none';
      const phoneInput = document.getElementById('customerPhone');
      if (phoneInput) phoneInput.value = '';
      const nameInput = document.getElementById('posCustomerName');
      if (nameInput) nameInput.value = '';
      const noteInput = document.getElementById('posOrderNotes');
      if (noteInput) noteInput.value = '';
      const discInput = document.getElementById('posDiscountValue');
      if (discInput) discInput.value = '';
      const tableInput = document.getElementById('posTableNumber');
      if (tableInput) tableInput.value = '';
      currentBillItems = [];
      posOrderType = 'dine-in';
      posDiscountMode = 'percent';
      switchPosMobileTab('menu');
      updatePosTotal();
    }

    let selectedPosCategory = 'all';

    function selectPosCategory(cat) {
      selectedPosCategory = cat;
      document.querySelectorAll('.pos-cat-btn').forEach(btn => {
        const isActive = btn.dataset.category === cat;
        btn.classList.toggle('active', isActive);
      });
      filterAndSearchPosItems();
    }

    function filterAndSearchPosItems() {
      const q = document.getElementById('posSearch').value.toLowerCase();
      let filtered = allMenuItems;
      
      if (selectedPosCategory !== 'all') {
        filtered = filtered.filter(i => i.category === selectedPosCategory);
      }
      
      if (q) {
        filtered = filtered.filter(i => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));
      }
      
      renderPosItems(filtered);
    }

    function renderPosCategories() {
      const container = document.getElementById('posCategories');
      if (!container) return;
      
      const categories = [...new Set(allMenuItems.map(i => i.category))].filter(Boolean);
      
      container.innerHTML = `
        <button type="button" class="pos-cat-btn active" data-category="all" onclick="selectPosCategory('all')">🏷️ All Items</button>
        ${categories.map(cat => `
          <button type="button" class="pos-cat-btn" data-category="${cat}" onclick="selectPosCategory('${cat}')">${cat}</button>
        `).join('')}
      `;
    }

    function renderPosItems(items) {
      const container = document.getElementById('posItems');
      if (!container) return;
      if (items.length === 0) {
        container.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:40px; color:var(--muted); font-size:0.85rem">No items found matching the filter</div>';
        return;
      }
      container.innerHTML = items.map(it => {
        const sizes = it.sizes || {};
        return `
          <div class="pos-item-card">
            <div style="display: flex; flex-direction: column; gap: 4px;">
              <div style="font-size: 1.4rem; line-height: 1.2;">${it.emoji || '🍔'}</div>
              <div style="font-weight: 800; font-size: 0.85rem; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; height: 34px; line-height: 1.25;" title="${it.name}">${it.name}</div>
            </div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: auto; width: 100%;">
              ${Object.entries(sizes).map(([sz, pr]) => `
                <button type="button" class="pos-size-btn" onclick="addToBill('${it.id}', '${it.name.replace(/'/g, "\\'")}', '${sz}', ${pr})">
                  <span class="pos-size-name">${sz}</span>
                  <span class="pos-size-price">₹${pr}</span>
                </button>
              `).join('')}
            </div>
          </div>
        `;
      }).join('');
    }

    function filterPosItems() {
      filterAndSearchPosItems();
    }

    function addToBill(id, name, size, price) {
      // Check if same item+size already in basket, increment qty
      const existing = currentBillItems.find(i => i.id === id && i.size === size);
      if (existing) {
        existing.qty = (existing.qty || 1) + 1;
      } else {
        currentBillItems.push({ id, name, size, price, qty: 1 });
      }
      updatePosTotal();
      renderBasket();
      showToast(`Added ${name}`);
    }

    function changeBasketQty(idx, delta) {
      const item = currentBillItems[idx];
      if (!item) return;
      item.qty = (item.qty || 1) + delta;
      if (item.qty <= 0) {
        currentBillItems.splice(idx, 1);
      }
      updatePosTotal();
      renderBasket();
    }

    function renderBasket() {
      const container = document.getElementById('posBasket');
      if (currentBillItems.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:var(--muted); font-size:0.75rem; padding:10px">Basket is empty</div>';
        return;
      }
      container.innerHTML = currentBillItems.map((item, idx) => `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; font-size:0.85rem; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.03)">
          <div style="flex:1; min-width:0">
            <span style="font-weight:700">${item.name}</span>
            <span style="color:var(--muted); font-size:0.7rem; margin-left:5px">(${item.size})</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px; flex-shrink:0">
            <button onclick="changeBasketQty(${idx}, -1)" style="background:rgba(255,255,255,0.05); border:1px solid var(--border); color:var(--text); cursor:pointer; width:26px; height:26px; border-radius:8px; font-size:0.9rem; display:flex; align-items:center; justify-content:center; font-weight:800">−</button>
            <span style="font-weight:800; min-width:18px; text-align:center; font-size:0.8rem">${item.qty || 1}</span>
            <button onclick="changeBasketQty(${idx}, 1)" style="background:rgba(255,107,0,0.1); border:1px solid rgba(255,107,0,0.2); color:var(--primary); cursor:pointer; width:26px; height:26px; border-radius:8px; font-size:0.9rem; display:flex; align-items:center; justify-content:center; font-weight:800">+</button>
            <span style="font-weight:800; color:var(--primary); min-width:50px; text-align:right">₹${item.price * (item.qty || 1)}</span>
          </div>
        </div>
      `).join('');
    }

    function removeFromBasket(idx) {
      currentBillItems.splice(idx, 1);
      updatePosTotal();
      renderBasket();
    }

    function updatePosTotal() {
      const subtotal = currentBillItems.reduce((sum, i) => sum + (i.price * (i.qty || 1)), 0);
      const discVal = parseFloat(document.getElementById('posDiscountValue')?.value) || 0;
      let discount = 0;
      if (discVal > 0) {
        discount = posDiscountMode === 'percent' ? Math.round(subtotal * discVal / 100) : discVal;
      }
      const total = Math.max(0, subtotal - discount);
      
      document.getElementById('billTotalBox').innerText = `₹${total}`;
      
      const discLine = document.getElementById('posDiscountLine');
      const discDisp = document.getElementById('posDiscountDisplay');
      if (discLine && discDisp) {
        if (discount > 0) {
          discLine.style.display = 'block';
          discDisp.innerText = posDiscountMode === 'percent' ? `${discVal}% (−₹${discount})` : `₹${discount}`;
        } else {
          discLine.style.display = 'none';
        }
      }
      
      const itemCount = currentBillItems.reduce((sum, i) => sum + (i.qty || 1), 0);
      const countEl = document.getElementById('posItemCount');
      if (countEl) countEl.innerText = `${itemCount} item${itemCount !== 1 ? 's' : ''}`;

      // Update mobile tab and pill counts
      const mobileCount = document.getElementById('posMobileCartCount');
      if (mobileCount) mobileCount.innerText = itemCount;
      
      const pillCount = document.getElementById('posMobileCartCountPill');
      if (pillCount) pillCount.innerText = itemCount;
      
      const pillTotal = document.getElementById('posMobileCartTotalPill');
      if (pillTotal) pillTotal.innerText = `₹${total} ➜`;
      
      if (typeof updateMobilePillVisibility === 'function') {
        updateMobilePillVisibility();
      }
    }

    // Keep legacy alias
    function updateBillTotal() { updatePosTotal(); }

    function generateUUID() {
      if (self.crypto && self.crypto.randomUUID) {
        try { return self.crypto.randomUUID(); } catch(e) {}
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }

    async function saveBillWithPayment(paymentMethod) {
      if (currentBillItems.length === 0) return alert('Bill is empty!');
      const phone = document.getElementById('customerPhone').value || 'N/A';
      const customerName = document.getElementById('posCustomerName')?.value?.trim() || 'Walk-in';
      const notes = document.getElementById('posOrderNotes')?.value?.trim() || '';
      const tableNumber = document.getElementById('posTableNumber')?.value?.trim() || '';
      
      // Calculate total with discount
      const subtotal = currentBillItems.reduce((sum, i) => sum + (i.price * (i.qty || 1)), 0);
      const discVal = parseFloat(document.getElementById('posDiscountValue')?.value) || 0;
      let discount = 0;
      if (discVal > 0) {
        discount = posDiscountMode === 'percent' ? Math.round(subtotal * discVal / 100) : discVal;
      }
      const total = Math.max(0, subtotal - discount);

      // Expand items for storage (flatten qty)
      const expandedItems = [];
      currentBillItems.forEach(item => {
        for (let q = 0; q < (item.qty || 1); q++) {
          expandedItems.push({ id: item.id, name: item.name, size: item.size, price: item.price });
        }
      });

      if (paymentMethod === 'UPI') {
        const storeUpi = localStorage.getItem('gc_store_upi_id') || 'juvaidpb13@okaxis';
        const storeName = localStorage.getItem('gc_store_merchant_name') || 'Grill & Chill';
        const upiUrl = `upi://pay?pa=${storeUpi}&pn=${encodeURIComponent(storeName)}&am=${total}&cu=INR`;
        
        window.upiCurrentPhone = phone;
        window.upiCurrentAmount = total;

        const qr = new QRious({
          value: upiUrl,
          size: 200
        });
        document.getElementById('upiQrCodeImg').src = qr.toDataURL();
        document.getElementById('upiPayAmount').innerText = `₹${total}`;
        document.getElementById('upiPayDetails').innerText = `To: ${storeUpi}`;
        
        const shareBtn = document.getElementById('upiShareWhatsAppBtn');
        if (shareBtn) {
          if (window.upiCurrentPhone && window.upiCurrentPhone !== 'N/A' && window.upiCurrentPhone.trim() !== '') {
            shareBtn.style.display = 'flex';
          } else {
            shareBtn.style.display = 'none';
          }
        }

        document.getElementById('upiPaidBtn').onclick = async () => {
          closeModal('upiPayModal');
          await finalizeBill(customerName, phone, paymentMethod, total, expandedItems, notes, tableNumber, discount);
        };
        document.getElementById('upiPayModal').style.display = 'flex';
      } else {
        await finalizeBill(customerName, phone, paymentMethod, total, expandedItems, notes, tableNumber, discount);
      }
    }

    // Keep legacy alias for saveBill
    async function saveBill() {
      const currentMethod = document.getElementById('billPaymentMethod')?.value || 'Cash';
      await saveBillWithPayment(currentMethod);
    }

    // POS global keyboard shortcuts for fast actions
    window.addEventListener('keydown', (e) => {
      const posModal = document.getElementById('quickBillModal');
      if (posModal && posModal.style.display === 'flex') {
        if (e.key === 'F5') {
          e.preventDefault();
          saveBillWithPayment('Cash');
        } else if (e.key === 'F6') {
          e.preventDefault();
          saveBillWithPayment('UPI');
        } else if (e.key === 'F7') {
          e.preventDefault();
          if (window.storeSettings?.enable_card === 'true') {
            saveBillWithPayment('Card');
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeQuickBill();
        }
      }
    });

    async function finalizeBill(customerName, phone, paymentMethod, total, items, notes, tableNumber, discount) {
      const uid = generateUUID();
      const billData = {
        id: uid,
        client_uuid: uid,
        customer_name: customerName,
        customer_phone: phone,
        total_amount: total,
        items: JSON.stringify(items),
        payment_status: 'paid',
        payment_method: paymentMethod,
        order_type: posOrderType,
        notes: notes || '',
        table_number: tableNumber || '',
        discount_amount: discount || 0,
        created_at: new Date().toISOString(),
        sync_status: 'pending'
      };

      try {
        await db.local_bills.add(billData);
        showToast('Bill Saved Offline! 💾');
        closeQuickBill();
        loadBilling();
        syncBills(); 
        generateReceipt(billData, false);
      } catch (err) {
        console.error('Save failed:', err);
      }
    }

    async function loadBilling() {
      const localBills = await db.local_bills.orderBy('created_at').reverse().toArray();
      let onlineBills = [];
      try {
        const { data } = await supabaseClient.from('bills').select('*').order('created_at', { ascending: false });
        if (data) onlineBills = data;
      } catch (e) {}

      const allBills = [...localBills];
      onlineBills.forEach(ob => {
        const exists = allBills.find(lb => lb.id === ob.id);
        if (!exists) allBills.push(ob);
      });
      allBills.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      
      window.CURRENT_BILLS = allBills;
      filterBills();
    }

    function renderBilling(bills) {
      const body = document.getElementById('billingBody');
      const currency = window.storeSettings?.currency_symbol || '₹';
      body.innerHTML = bills.map((b, idx) => {
        const isVoided = b.payment_status === 'voided';
        const methodMap = { 
          Cash: '<i data-lucide="banknote" style="width:14px; height:14px; display:inline-block; vertical-align:middle; margin-right:4px; opacity:0.8"></i> Cash', 
          UPI: '<img src="https://upload.wikimedia.org/wikipedia/commons/e/e1/UPI-Logo-vector.svg" style="height:14px; width:auto; vertical-align:middle; display:inline-block; filter: brightness(0) invert(1); opacity:0.8">', 
          Card: '<i data-lucide="credit-card" style="width:14px; height:14px; display:inline-block; vertical-align:middle; margin-right:4px; opacity:0.8"></i> Card' 
        };
        const methodStr = methodMap[b.payment_method || 'Cash'] || methodMap['Cash'];
        const orderTypeMap = { 'dine-in': '🍽️', 'takeaway': '🥡', 'delivery': '🛵' };
        const typeIcon = orderTypeMap[b.order_type] || '🍽️';
        const custName = b.customer_name || 'Walk-in';
        return `
        <div class="order-card" style="position:relative; overflow:hidden; ${isVoided ? 'opacity:0.6; filter:grayscale(1)' : ''}">
          ${isVoided ? `
            <div style="position:absolute; inset:0; background:rgba(239,68,68,0.1); display:flex; align-items:center; justify-content:center; z-index:2; pointer-events:none">
              <div style="border:3px solid #ef4444; color:#ef4444; padding:5px 15px; border-radius:10px; font-weight:900; font-size:1.5rem; transform:rotate(-15deg); text-transform:uppercase; letter-spacing:2px">VOIDED</div>
            </div>
          ` : ''}
          <div class="order-header">
            <div class="order-id">${currency}${b.total_amount} <span style="font-size:0.7rem; font-weight:normal; color:var(--muted); margin-left:6px">${methodStr}</span></div>
            <div class="status-badge ${b.sync_status === 'synced' ? 'badge-completed' : 'badge-warning'}">
              ${b.sync_status === 'synced' ? 'SYNCED' : 'OFFLINE'}
            </div>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px">
            <div style="font-size:0.8rem; font-weight:700; color:var(--text)">${custName}${b.customer_phone && b.customer_phone !== 'N/A' ? ` · <span style="color:var(--muted); font-weight:400">${b.customer_phone}</span>` : ''}</div>
            <div style="font-size:0.65rem; font-weight:700; color:var(--muted); background:rgba(255,255,255,0.03); padding:3px 8px; border-radius:6px; border:1px solid var(--border)">${typeIcon} ${(b.order_type || 'dine-in').replace('-',' ')}</div>
          </div>
          <div style="font-size:0.75rem; color:var(--muted); margin-bottom:6px">
            ${new Date(b.created_at).toLocaleString()}${b.table_number ? ` · Table ${b.table_number}` : ''}
          </div>
          ${b.discount_amount > 0 ? `<div style="font-size:0.7rem; color:#22c55e; font-weight:600; margin-bottom:4px">Discount: −${currency}${b.discount_amount}</div>` : ''}
          ${b.notes ? `<div style="font-size:0.7rem; color:var(--muted); font-style:italic; margin-bottom:4px">📝 ${b.notes}</div>` : ''}
          <div style="margin-top:6px; font-size:0.8rem; color:rgba(255,255,255,0.7)">
            ${JSON.parse(b.items || '[]').map(i => `${i.name} (${i.size})`).join(', ')}
          </div>
          <div style="margin-top:20px; display:flex; gap:10px; flex-wrap:wrap; ${isVoided ? 'pointer-events:none; opacity:0.3' : ''}">
            <button onclick="handleBluetoothPrint('${b.id}')" class="btn-primary" style="flex:1.2; display:flex; align-items:center; justify-content:center; gap:8px; padding:14px; font-weight:800; min-width:100px; font-size:0.7rem">
              <i data-lucide="printer" style="width:16px"></i> PRINT
            </button>
            <button onclick="handleReceipt('${b.id}', false)" class="btn-primary" style="flex:1; display:flex; align-items:center; justify-content:center; gap:8px; padding:14px; background:rgba(255,255,255,0.05); border:1px solid var(--border); color:var(--text); font-weight:700; min-width:90px; font-size:0.7rem">
              <i data-lucide="eye" style="width:16px"></i> PREVIEW
            </button>
            <button onclick="voidBill('${b.id}')" class="mini-btn" style="padding:14px; width:50px; background:rgba(239,68,68,0.1); border-color:rgba(239,68,68,0.2); color:#ef4444; display:flex; align-items:center; justify-content:center">
              <i data-lucide="trash-2" style="width:18px"></i>
            </button>
          </div>
        </div>
      `}).join('') || '<div class="empty-state">No bills found</div>';
      lucide.createIcons();
    }

    async function voidBill(billId) {
      if (!confirm('Are you sure you want to VOID this bill?')) return;
      const bill = window.CURRENT_BILLS.find(b => b.id === billId);
      if (!bill) return;
      
      try {
        // 1. Update local DB (Dexie) for immediate feedback
        const localRecord = await db.local_bills.get(bill.id);
        if (localRecord) {
          await db.local_bills.update(bill.id, { payment_status: 'voided' });
        } else {
          // If it only existed in cloud, create a local voided record to ensure UI consistency
          await db.local_bills.put({ 
            ...bill, 
            payment_status: 'voided', 
            sync_status: 'synced' 
          });
        }

        // 2. Update Supabase (Cloud)
        const { error } = await supabaseClient
          .from('bills')
          .update({ payment_status: 'voided' })
          .eq('id', bill.id);
          
        if (error) {
          console.error('Cloud void failed:', error);
          // If we're offline, mark for later sync
          if (!navigator.onLine) {
            await db.local_bills.update(bill.id, { sync_status: 'pending' });
            showToast('Voided offline. Will sync later. 💾');
          } else {
            throw error;
          }
        } else {
          showToast('Bill Voided 🚫');
        }
        
        await loadBilling();
        updateDashboardStats();
      } catch (err) {
        console.error('Void error:', err);
        showToast('Error voiding bill', true);
      }
    }

    async function updateDashboardStats() {
      const actEl = document.getElementById('activeOrders');
      if (!actEl) return;
      
      // Active Orders Count (Excluding cancelled/completed)
      const { data: activeOrders } = await supabaseClient.from('orders').select('id').not('status', 'in', '("completed","cancelled")');
      actEl.innerText = activeOrders?.length || 0;

      // Total Menu Items
      const { count } = await supabaseClient.from('menu_items').select('*', { count: 'exact', head: true });
      const itemEl = document.getElementById('statTotalItems');
      if (itemEl) itemEl.innerText = count || 0;
    }

    window.revenueVisible = false;
    window.revenueVisible = false;
    function toggleRevenueVisibility(e) {
      if (e) e.stopPropagation();
      window.revenueVisible = !window.revenueVisible;
      const el = document.getElementById('statRevenue');
      const icon = document.getElementById('revEyeIcon');
      if (el) {
        if (window.revenueVisible) {
          el.innerText = `₹${el.dataset.value || 0}`;
          if (icon) icon.setAttribute('data-lucide', 'eye');
        } else {
          el.innerText = '₹ ****';
          if (icon) icon.setAttribute('data-lucide', 'eye-off');
        }
      }
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    function showRevenueAnalytics() {
      document.getElementById('analyticsModal').style.display = 'flex';
      updateAnalyticsView();
    }

    async function updateAnalyticsView() {
      const range = document.getElementById('statsRange').value;
      let dateLimit = new Date();
      if (range === 'today') dateLimit.setHours(0,0,0,0);
      else if (range === 'week') dateLimit.setDate(dateLimit.getDate() - 7);
      else if (range === 'month') dateLimit.setMonth(dateLimit.getMonth() - 1);
      else if (range === 'all') dateLimit = new Date(0);

      const isoLimit = dateLimit.toISOString();
      const { data } = await supabaseClient
        .from('bills')
        .select('total_amount')
        .neq('payment_status', 'voided')
        .gte('created_at', isoLimit);
      
      const total = data?.reduce((sum, b) => sum + Number(b.total_amount), 0) || 0;
      document.getElementById('rangeRevenue').innerText = `₹${total}`;
      document.getElementById('rangeOrderCount').innerText = `${data?.length || 0} Bills processed`;
    }

    function showActiveOrdersList() {
      showSection('orders');
    }


    // --- BLE printer state ---
    let cachedPrinterChar = null;
    let cachedPrinterDevice = null;
    const PRINTER_SERVICES = [
      '000018f0-0000-1000-8000-00805f9b34fb', // Standard BLE Print Service
      '0000ffe0-0000-1000-8000-00805f9b34fb', // Common Custom BLE
      '0000e7e1-0000-1000-8000-00805f9b34fb', // Custom BLE Printer
      'e7e1a2c0-294d-11e5-bc34-0002a5d5c51b', // Custom Serial BLE
      '0000ffe1-0000-1000-8000-00805f9b34fb',
      '00004953-0000-1000-8000-00805f9b34fb'  // ISSC BLE
    ];

    async function getBLEPrinter() {
      if (cachedPrinterChar && cachedPrinterDevice && cachedPrinterDevice.gatt.connected) {
        return cachedPrinterChar;
      }

      showToast('Searching for BLE Printer... 🖨️');
      
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: PRINTER_SERVICES
      });

      cachedPrinterDevice = device;
      
      device.addEventListener('gattserverdisconnected', () => {
        cachedPrinterChar = null;
        cachedPrinterDevice = null;
        const disconnectBtn = document.getElementById('btnDisconnectBLE');
        if (disconnectBtn) disconnectBtn.style.display = 'none';
        showToast('Printer disconnected ❌');
      });

      showToast('Connecting to printer GATT server...');
      const server = await device.gatt.connect();

      showToast('Locating write service...');
      let writeChar = null;

      for (const serviceUuid of PRINTER_SERVICES) {
        try {
          const service = await server.getPrimaryService(serviceUuid);
          const chars = await service.getCharacteristics();
          for (const char of chars) {
            if (char.properties.write || char.properties.writeWithoutResponse) {
              writeChar = char;
              break;
            }
          }
          if (writeChar) break;
        } catch (err) {
          console.warn(`BLE service ${serviceUuid} not found: ${err.message}`);
        }
      }

      if (!writeChar) {
        try {
          const services = await server.getPrimaryServices();
          for (const service of services) {
            const chars = await service.getCharacteristics();
            for (const char of chars) {
              if (char.properties.write || char.properties.writeWithoutResponse) {
                writeChar = char;
                break;
              }
            }
            if (writeChar) break;
          }
        } catch (err) {
          console.error('Fallback services list failed:', err);
        }
      }

      if (!writeChar) {
        throw new Error('Could not find a writable characteristic on this printer.');
      }

      cachedPrinterChar = writeChar;
      const disconnectBtn = document.getElementById('btnDisconnectBLE');
      if (disconnectBtn) disconnectBtn.style.display = 'block';
      showToast('Printer Connected! 🎉');
      return cachedPrinterChar;
    }

    function disconnectBLEPrinter() {
      if (cachedPrinterDevice && cachedPrinterDevice.gatt.connected) {
        cachedPrinterDevice.gatt.disconnect();
      }
      cachedPrinterChar = null;
      cachedPrinterDevice = null;
      const disconnectBtn = document.getElementById('btnDisconnectBLE');
      if (disconnectBtn) disconnectBtn.style.display = 'none';
      showToast('Printer disconnected');
    }

    async function logoToEscPos(url, targetWidth = 120) {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const scale = targetWidth / img.width;
            const targetHeight = Math.round(img.height * scale);
            // Round height up to multiple of 8 for strip alignment
            const alignedHeight = Math.ceil(targetHeight / 8) * 8;

            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = alignedHeight;
            const ctx = canvas.getContext('2d');

            // White background — transparent pixels become white on paper
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, targetWidth, alignedHeight);
            ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

            const imgData = ctx.getImageData(0, 0, targetWidth, alignedHeight);
            const pixels = imgData.data;

            const bytes = [];

            // ESC 3 8 — Set line spacing to 8 dots (no gap between strips)
            bytes.push(0x1B, 0x33, 0x08);
            // ESC a 1 — Center align
            bytes.push(0x1B, 0x61, 0x01);

            const nL = targetWidth & 0xFF;
            const nH = (targetWidth >> 8) & 0xFF;

            // Process image in 8-pixel-tall horizontal strips
            for (let stripY = 0; stripY < alignedHeight; stripY += 8) {
              // ESC * m nL nH d1...dk
              // m=0: 8-dot single density (widest, ~1/60" per dot)
              bytes.push(0x1B, 0x2A, 0x00, nL, nH);

              // Each column: 1 byte = 8 vertical pixels (MSB = top)
              for (let x = 0; x < targetWidth; x++) {
                let colByte = 0;
                for (let bit = 0; bit < 8; bit++) {
                  const y = stripY + bit;
                  const idx = (y * targetWidth + x) * 4;
                  const r = pixels[idx];
                  const g = pixels[idx + 1];
                  const b = pixels[idx + 2];
                  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                  if (gray < 128) {
                    colByte |= (1 << (7 - bit));
                  }
                }
                bytes.push(colByte);
              }
              // Line feed to advance to next strip
              bytes.push(0x0A);
            }

            // ESC 2 — Reset line spacing to default
            bytes.push(0x1B, 0x32);

            resolve(new Uint8Array(bytes));
          } catch (e) {
            console.error('Error encoding logo:', e);
            resolve(null);
          }
        };
        img.onerror = () => {
          console.error("Failed to load logo image for printing");
          resolve(null);
        };
        img.src = url;
      });
    }

    async function printDirectlyViaBluetooth(bill) {
      try {
        const char = await getBLEPrinter();
        showToast('Printing receipt... 🖨️');
        const bytes = generateEscPosBytes(bill);
        await writeInChunks(char, bytes);
        showToast('Print complete! ✅');
      } catch (err) {
        console.error('BLE Print error:', err);
        showToast('Direct BLE print failed: ' + err.message, true);
      }
    }

    async function writeInChunks(char, data) {
      // Negotiate best chunk size: most BLE printers handle 100-512 bytes.
      // Start with 100; fall back to 20 on error.
      let chunkSize = 100;
      const delay = 10;
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        try {
          if (char.writeValueWithoutResponse) {
            await char.writeValueWithoutResponse(chunk);
          } else {
            await char.writeValue(chunk);
          }
        } catch (err) {
          if (chunkSize > 20 && i === 0) {
            // First chunk failed with large size — retry with safe 20-byte chunks
            console.warn('Large chunk failed, falling back to 20-byte chunks:', err.message);
            chunkSize = 20;
            i = -chunkSize; // restart from 0
            continue;
          }
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    function padLine(left, right, width = 32) {
      const leftStr = String(left);
      const rightStr = String(right);
      const gap = width - leftStr.length - rightStr.length;
      if (gap <= 0) return leftStr + ' ' + rightStr;
      return leftStr + ' '.repeat(gap) + rightStr;
    }

    function handleReceipt(billId, autoPrint) {
      const bill = window.CURRENT_BILLS.find(b => b.id === billId);
      if (bill) {
        generateReceipt(bill, autoPrint);
      }
    }

    function handleBluetoothPrint(billId) {
      const bill = window.CURRENT_BILLS.find(b => b.id === billId);
      if (!bill) return;
      // On iOS/devices without Web Bluetooth, skip BLE attempt and go straight to receipt preview
      if (!navigator.bluetooth) {
        generateReceipt(bill, false);
        return;
      }
      if (cachedPrinterChar && cachedPrinterDevice && cachedPrinterDevice.gatt.connected) {
        printDirectlyViaBluetooth(bill);
      } else {
        generateReceipt(bill, false);
      }
    }

    function handleShare(billId) {
      const bill = window.CURRENT_BILLS.find(b => b.id === billId);
      if (bill) {
        shareReceipt(bill);
      }
    }

    function printBluetooth(bill) {
      try {
        const billPayload = {
          id: bill.id,
          customer_name: bill.customer_name || 'Walk-in',
          customer_phone: bill.customer_phone || 'N/A',
          total_amount: bill.total_amount,
          items: bill.items,
          payment_status: bill.payment_status,
          created_at: bill.created_at
        };
        const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(billPayload))));
        const siteUrl = window.location.origin;
        const responseUrl = `${siteUrl}/api/receipt?bill=${encoded}`;
        const btPrintUrl = `my.bluetoothprint.scheme://${responseUrl}`;
        window.location.href = btPrintUrl;
        showToast('Sending to printer... 🖨️');
      } catch (err) {
        console.error('Bluetooth print error:', err);
        showToast('Print failed. Is the Bluetooth Print app installed?');
      }
    }

    function updateBillingStats(bills) {
      const active = bills.filter(b => b.payment_status !== 'voided');
      const voided = bills.filter(b => b.payment_status === 'voided');
      
      const rev = active.reduce((sum, b) => sum + Number(b.total_amount), 0);
      const count = active.length;
      const avg = count > 0 ? Math.round(rev / count) : 0;
      const vCount = voided.length;
      
      const revEl = document.getElementById('statRevenue');
      if (revEl) {
        revEl.dataset.value = rev;
        if (window.revenueVisible) {
          revEl.innerText = `₹${rev}`;
        } else {
          revEl.innerText = '₹ ****';
        }
      }
      document.getElementById('statBillsCount').innerText = count;
      document.getElementById('statAvgBill').innerText = `₹${avg}`;
      document.getElementById('statVoidedCount').innerText = vCount;
    }

    function onBillingDateFilterChange() {
      const val = document.getElementById('billingDateFilter').value;
      const customBox = document.getElementById('billingCustomDateRange');
      if (val === 'custom') {
        customBox.style.display = 'flex';
      } else {
        customBox.style.display = 'none';
      }
      filterBills();
    }

    function exportBillsCSV() {
      const q = document.getElementById('billingSearch').value.toLowerCase().trim();
      const method = document.getElementById('billingMethodFilter').value;
      const status = document.getElementById('billingStatusFilter').value;
      const sync = document.getElementById('billingSyncFilter').value;
      const dateFilter = document.getElementById('billingDateFilter').value;
      
      const todayStr = new Date().toISOString().split('T')[0];
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      
      const filtered = window.CURRENT_BILLS.filter(b => {
        const matchesSearch = !q || 
          (b.customer_phone && b.customer_phone.toLowerCase().includes(q)) || 
          (b.customer_name && b.customer_name.toLowerCase().includes(q)) ||
          (b.id && b.id.toLowerCase().includes(q)) ||
          (b.items && b.items.toLowerCase().includes(q));
          
        const matchesMethod = method === 'all' || b.payment_method === method || (!b.payment_method && method === 'Cash');
        const matchesStatus = status === 'all' || b.payment_status === status || (!b.payment_status && status === 'paid');
        const matchesSync = sync === 'all' || b.sync_status === sync || (sync === 'synced' && (!b.sync_status || b.sync_status === 'synced'));
        
        let matchesDate = true;
        if (dateFilter === 'today') {
          matchesDate = b.created_at.startsWith(todayStr);
        } else if (dateFilter === 'yesterday') {
          matchesDate = b.created_at.startsWith(yesterdayStr);
        } else if (dateFilter === '7days') {
          const cut = new Date();
          cut.setDate(cut.getDate() - 7);
          matchesDate = new Date(b.created_at) >= cut;
        } else if (dateFilter === 'custom') {
          const start = document.getElementById('billingDateStart').value;
          const end = document.getElementById('billingDateEnd').value;
          if (start) {
            matchesDate = matchesDate && (b.created_at.split('T')[0] >= start);
          }
          if (end) {
            matchesDate = matchesDate && (b.created_at.split('T')[0] <= end);
          }
        }
        
        return matchesSearch && matchesMethod && matchesStatus && matchesSync && matchesDate;
      });

      if (filtered.length === 0) {
        showToast('No bills to export! 📊', true);
        return;
      }

      let csv = 'Bill ID,Date,Customer Name,Customer Phone,Payment Method,Status,Sync,Items,Total Amount\n';
      filtered.forEach(b => {
        const items = JSON.parse(b.items || '[]').map(i => `${i.name} (x${i.quantity || 1} ${i.size || ''})`).join(' | ');
        const id = b.id ? String(b.id).toUpperCase() : '';
        const date = new Date(b.created_at).toLocaleString();
        const name = (b.customer_name || 'Walk-in').replace(/"/g, '""');
        const phone = b.customer_phone || 'N/A';
        const method = b.payment_method || 'Cash';
        const status = b.payment_status || 'paid';
        const syncStatus = b.sync_status === 'synced' || !b.sync_status ? 'Synced' : 'Offline';
        const total = b.total_amount;
        
        csv += `"${id}","${date}","${name}","${phone}","${method}","${status}","${syncStatus}","${items.replace(/"/g, '""')}",${total}\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `bills_export_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('CSV Exported! 📊');
    }

    function filterBills() {
      const q = document.getElementById('billingSearch').value.toLowerCase().trim();
      const method = document.getElementById('billingMethodFilter').value;
      const status = document.getElementById('billingStatusFilter').value;
      const sync = document.getElementById('billingSyncFilter').value;
      const dateFilter = document.getElementById('billingDateFilter').value;
      
      const todayStr = new Date().toISOString().split('T')[0];
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      
      const filtered = window.CURRENT_BILLS.filter(b => {
        const matchesSearch = !q || 
          (b.customer_phone && b.customer_phone.toLowerCase().includes(q)) || 
          (b.customer_name && b.customer_name.toLowerCase().includes(q)) ||
          (b.id && b.id.toLowerCase().includes(q)) ||
          (b.items && b.items.toLowerCase().includes(q));
          
        const matchesMethod = method === 'all' || b.payment_method === method || (!b.payment_method && method === 'Cash');
        const matchesStatus = status === 'all' || b.payment_status === status || (!b.payment_status && status === 'paid');
        const matchesSync = sync === 'all' || b.sync_status === sync || (sync === 'synced' && (!b.sync_status || b.sync_status === 'synced'));
        
        let matchesDate = true;
        if (dateFilter === 'today') {
          matchesDate = b.created_at.startsWith(todayStr);
        } else if (dateFilter === 'yesterday') {
          matchesDate = b.created_at.startsWith(yesterdayStr);
        } else if (dateFilter === '7days') {
          const cut = new Date();
          cut.setDate(cut.getDate() - 7);
          matchesDate = new Date(b.created_at) >= cut;
        } else if (dateFilter === 'custom') {
          const start = document.getElementById('billingDateStart').value;
          const end = document.getElementById('billingDateEnd').value;
          if (start) {
            matchesDate = matchesDate && (b.created_at.split('T')[0] >= start);
          }
          if (end) {
            matchesDate = matchesDate && (b.created_at.split('T')[0] <= end);
          }
        }
        
        return matchesSearch && matchesMethod && matchesStatus && matchesSync && matchesDate;
      });
      
      updateBillingStats(filtered);
      renderBilling(filtered);
    }

    async function printDailyZReport() {
      try {
        const todayStr = new Date().toISOString().split('T')[0];
        const localBills = await db.local_bills.toArray();
        const todayBills = localBills.filter(b => b.created_at.startsWith(todayStr) && b.payment_status !== 'voided');
        
        if (todayBills.length === 0) {
          return alert('No bills generated today to generate Z-Report!');
        }

        const totalRevenue = todayBills.reduce((sum, b) => sum + Number(b.total_amount), 0);
        
        const paymentStats = { Cash: 0, UPI: 0, Card: 0 };
        todayBills.forEach(b => {
          const method = b.payment_method || 'Cash';
          if (paymentStats[method] !== undefined) {
            paymentStats[method] += Number(b.total_amount);
          } else {
            paymentStats['Cash'] += Number(b.total_amount);
          }
        });
        
        const itemStats = {};
        todayBills.forEach(b => {
          const items = JSON.parse(b.items || '[]');
          items.forEach(item => {
            const name = item.name + (item.size ? ` (${item.size})` : '');
            itemStats[name] = (itemStats[name] || 0) + (item.quantity || 1);
          });
        });
        
        const topItems = Object.entries(itemStats)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
          
        const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        const timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

        window.CURRENT_Z_REPORT_TEXT = (() => {
          let rText = '';
          rText += '================================\n';
          rText += '         GRILL & CHILL          \n';
          rText += '         DAILY SUMMARY          \n';
          rText += '          (Z-REPORT)            \n';
          rText += '================================\n';
          rText += padLine(`Date: ${dateStr}`, timeStr) + '\n';
          rText += '--------------------------------\n';
          rText += padLine('Total Bills:', todayBills.length) + '\n';
          rText += padLine('Total Revenue:', `Rs.${totalRevenue}`) + '\n';
          rText += '--------------------------------\n';
          rText += 'PAYMENT BREAKDOWN:\n';
          rText += padLine(' - Cash:', `Rs.${paymentStats.Cash}`) + '\n';
          rText += padLine(' - UPI:', `Rs.${paymentStats.UPI}`) + '\n';
          rText += padLine(' - Card:', `Rs.${paymentStats.Card}`) + '\n';
          rText += '--------------------------------\n';
          rText += 'TOP ITEMS SOLD:\n';
          topItems.forEach(([name, qty]) => {
            rText += padLine(` ${name}`, `x${qty}`) + '\n';
          });
          rText += '================================\n';
          rText += '        Z-Report End.           \n';
          rText += '\n\n\n\n';
          return rText;
        })();

        const zReportHtml = `
          <div class="center">
            <div class="bold" style="font-size: 14px; margin-bottom: 2px;">GRILL & CHILL</div>
            <div class="bold" style="font-size: 11px;">DAILY SUMMARY</div>
            <div style="font-size: 10px; margin-bottom: 4px;">(Z-REPORT)</div>
          </div>
          <hr class="double-separator">
          <div style="display:flex; justify-content:space-between; font-size:10px">
            <span>Date: ${dateStr}</span>
            <span>${timeStr}</span>
          </div>
          <hr class="separator">
          <div style="display:flex; justify-content:space-between; font-size:11px; margin: 3px 0;">
            <span>Total Bills:</span>
            <span class="bold">${todayBills.length}</span>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:11px; margin: 3px 0;">
            <span>Total Revenue:</span>
            <span class="bold">₹${totalRevenue}</span>
          </div>
          <hr class="separator">
          <div class="bold" style="font-size: 11px; margin-bottom: 4px;">PAYMENT BREAKDOWN:</div>
          <div style="display:flex; justify-content:space-between; font-size:10px; padding-left: 5px; margin: 2px 0;">
            <span>Cash:</span>
            <span>₹${paymentStats.Cash}</span>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:10px; padding-left: 5px; margin: 2px 0;">
            <span>UPI:</span>
            <span>₹${paymentStats.UPI}</span>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:10px; padding-left: 5px; margin: 2px 0;">
            <span>Card:</span>
            <span>₹${paymentStats.Card}</span>
          </div>
          <hr class="separator">
          <div class="bold" style="font-size: 11px; margin-bottom: 4px;">TOP ITEMS SOLD:</div>
          ${topItems.map(([name, qty]) => `
            <div style="display:flex; justify-content:space-between; font-size:10px; padding-left: 5px; margin: 2px 0;">
              <span>${name}</span>
              <span>x${qty}</span>
            </div>
          `).join('')}
          <hr class="double-separator">
          <div class="center" style="font-size: 9px; margin-top: 4px;">Z-Report End.</div>
        `;

        document.getElementById('zReportPaper').innerHTML = zReportHtml;
        
        const btnPrintZ = document.getElementById('btnDirectBtPrintZ');
        btnPrintZ.onclick = async () => {
          if (cachedPrinterChar && cachedPrinterDevice && cachedPrinterDevice.gatt.connected) {
            showToast('Printing Z-Report... 📊');
            const bytes = [];
            bytes.push(0x1B, 0x40);
            for (let i = 0; i < window.CURRENT_Z_REPORT_TEXT.length; i++) {
              bytes.push(window.CURRENT_Z_REPORT_TEXT.charCodeAt(i) & 0xFF);
            }
            bytes.push(0x1D, 0x56, 0x42, 0x00);
            await writeInChunks(cachedPrinterChar, new Uint8Array(bytes));
            showToast('Z-Report Printed! ✅');
            closeModal('zReportPreviewModal');
          } else {
            showToast('BLE Printer Not Connected! ❌', true);
          }
        };

        openModal('zReportPreviewModal');
      } catch (err) {
        console.error('Z-Report generation failed:', err);
        alert('Error generating report: ' + err.message);
      }
    }

    let isSyncing = false;
    async function syncBills() {
      if (!navigator.onLine) return;
      if (isSyncing) return;
      isSyncing = true;

      try {
        const syncEl = document.getElementById('syncStatus');
        const pending = await db.local_bills.where('sync_status').equals('pending').toArray();
        
        if (pending.length === 0) {
          if (syncEl) syncEl.innerText = 'All Bills Synced ✅';
          return;
        }

        if (syncEl) syncEl.innerText = `Syncing ${pending.length} bills...`;

        for (const bill of pending) {
          try {
            const { error } = await supabaseClient.from('bills').upsert([{
              id: bill.id,
              customer_name: bill.customer_name,
              customer_phone: bill.customer_phone || null,
              total_amount: bill.total_amount,
              items: bill.items,
              payment_status: bill.payment_status,
              payment_method: bill.payment_method || 'Cash',
              order_type: bill.order_type || 'dine-in',
              notes: bill.notes || '',
              table_number: bill.table_number || '',
              discount_amount: bill.discount_amount || 0,
              created_at: bill.created_at
            }]);
            
            if (!error) {
              await db.local_bills.update(bill.id, { sync_status: 'synced' });
            } else {
              console.error('Supabase Sync Error:', error);
              if (syncEl) syncEl.innerText = `Sync Error: ${error.message}`;
            }
          } catch (err) {
            console.error('Sync failed for bill:', bill.id, err);
            if (syncEl) syncEl.innerText = 'Sync Connection Failed ❌';
          }
        }
      } finally {
        isSyncing = false;
        loadBilling();
      }
    }

    setInterval(syncBills, 30000);

    function showToast(msg) {
      const t = document.createElement('div');
      t.className = 'toast';
      t.innerText = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3000);
    }

    async function shareReceipt(bill) {
      const items = JSON.parse(bill.items || '[]');
      const storeName = window.storeSettings?.store_name || 'Grill & Chill';
      const currency = window.storeSettings?.currency_symbol || '₹';
      const text = `${storeName} Receipt\nTotal: ${currency}${bill.total_amount}\nItems: ${items.map(i => i.name).join(', ')}`;
      
      if (navigator.share) {
        try {
          await navigator.share({ title: `${storeName} Receipt`, text: text });
        } catch (err) {}
      } else {
        await navigator.clipboard.writeText(text);
        showToast('Receipt details copied! 📋');
      }
    }

    // Detect iOS/iPadOS (UA sniff + touch check for iPad desktop mode)
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // Feature detection: true if Web Bluetooth is completely absent (iOS, Safari, Firefox)
    const noBluetooth = !navigator.bluetooth;

    if (isIOS || noBluetooth) {
      document.documentElement.classList.add('ios-device');
    }

    function printElementViaIframe(htmlContent) {
      // iOS Safari blocks iframe.contentWindow.print() — use a popup window instead
      if (isIOS) {
        // On iOS, open the receipt in a new tab so the user can long-press → Print
        // or use the share sheet. A direct popup window.print() works in Safari.
        const blob = new Blob([htmlContent], { type: 'text/html' });
        const blobUrl = URL.createObjectURL(blob);
        const win = window.open(blobUrl, '_blank');
        if (win) {
          win.onload = () => {
            setTimeout(() => {
              win.print();
              URL.revokeObjectURL(blobUrl);
            }, 600);
          };
        } else {
          // Popup blocked — fall back to share sheet
          showToast('Pop-up blocked. Use SHARE → Print instead.', true);
        }
        return;
      }

      // Desktop / Android: use hidden iframe
      let iframe = document.getElementById('printIframe');
      if (iframe) iframe.remove();
      
      iframe = document.createElement('iframe');
      iframe.id = 'printIframe';
      iframe.style.position = 'absolute';
      iframe.style.width = '0px';
      iframe.style.height = '0px';
      iframe.style.border = 'none';
      
      document.body.appendChild(iframe);
      
      const doc = iframe.contentWindow.document;
      doc.open();
      doc.write(htmlContent);
      doc.close();
      
      iframe.contentWindow.focus();
      setTimeout(() => {
        iframe.contentWindow.print();
      }, 500);
    }

    // AirPrint via Share Sheet (iOS only)
    async function airPrintViaShare(htmlContent, billId) {
      try {
        const blob = new Blob([htmlContent], { type: 'text/html' });
        const file = new File([blob], `receipt-${billId}.html`, { type: 'text/html' });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: `Receipt ${billId}` });
        } else if (navigator.share) {
          // Fallback: share the blob URL as a link
          const blobUrl = URL.createObjectURL(blob);
          await navigator.share({ title: `Receipt ${billId}`, url: blobUrl });
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        } else {
          // Last resort: open in new tab
          const blobUrl = URL.createObjectURL(blob);
          window.open(blobUrl, '_blank');
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          showToast('Could not open share sheet: ' + err.message, true);
        }
      }
    }

    function generateReceiptText(bill) {
      const items = typeof bill.items === 'string' ? JSON.parse(bill.items) : (bill.items || []);
      const dateObj = new Date(bill.created_at);
      const dateStr = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const timeStr = dateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
      const billId = bill.id ? `#${String(bill.id).slice(0, 8).toUpperCase()}` : '#N/A';

      const s = window.storeSettings || {};
      const storeName = (s.receipt_store_name || s.store_name || 'Grill & Chill').toUpperCase();
      const storeTagline = s.receipt_store_tagline || s.store_tagline || 'Pizzeria & Bakery';
      const storeAddress = s.receipt_store_address || s.store_address || 'Raikot Road, Sandhaur, Malerkotla';
      const storePhone = s.receipt_store_phone || s.store_phone || '79019 94174';
      const currency = s.currency_symbol || '₹';
      const receiptFooter = s.receipt_footer || 'Thank you! Visit again.';
      const receiptUrl = s.receipt_url || 'grillandchillpizzeria.juvaid.in';
      const footerSubtext = s.receipt_footer_subtext || 'Order Online • Free Delivery';
      const taxNote = s.receipt_tax_note || 'All prices inclusive of taxes';

      const grouped = {};
      items.forEach(item => {
        const key = `${item.name}|${item.size || ''}`;
        if (!grouped[key]) {
          grouped[key] = { ...item, qty: 0, totalPrice: 0 };
        }
        grouped[key].qty += (item.quantity || 1);
        grouped[key].totalPrice += Number(item.price) * (item.quantity || 1);
      });

      let text = '';
      text += `      ${storeName}      \n`;
      text += `    ${storeTagline}    \n`;
      
      // Split address by newlines and print centered lines
      storeAddress.split('\n').forEach(line => {
        if (line.trim()) text += `  ${line.trim()}  \n`;
      });
      
      text += `     Ph: ${storePhone}     \n`;
      text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      text += padLine(`Bill ${billId}`, timeStr) + '\n';
      text += `Date: ${dateStr}\n`;
      if (bill.order_type) text += `Type: ${bill.order_type}${bill.table_number ? ` | Table: ${bill.table_number}` : ''}\n`;
      text += '────────────────────────────────\n';
      
      Object.values(grouped).forEach(item => {
        const qty = item.qty;
        const nameWithSize = item.size ? `${item.name} (${item.size})` : item.name;
        const label = `${qty}x ${nameWithSize}`;
        const priceStr = `${currency}${item.totalPrice}`;
        text += padLine(label, priceStr) + '\n';
      });
      
      text += '────────────────────────────────\n';
      if (bill.discount_amount > 0) {
        text += padLine('Discount', `-${currency}${bill.discount_amount}`) + '\n';
      }
      text += padLine('TOTAL', `${currency}${bill.total_amount}`) + '\n';
      text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      
      if (bill.customer_name && bill.customer_name !== 'Walk-in') {
        text += `Name: ${bill.customer_name}\n`;
      }
      if (bill.customer_phone && bill.customer_phone !== 'N/A') {
        text += `Phone: ${bill.customer_phone}\n`;
      }
      if (bill.payment_method) {
        text += `Payment: ${bill.payment_method}\n`;
      }
      if (bill.notes) {
        text += `Note: ${bill.notes}\n`;
      }
      
      text += `${taxNote}\n`;
      text += '────────────────────────────────\n';
      text += `    ${receiptFooter}    \n`;
      if (footerSubtext) text += `    ${footerSubtext}    \n`;
      text += `${receiptUrl}\n`;
      
      return text;
    }

    function generateEscPosBytes(bill) {
      const bytes = [];
      const items = typeof bill.items === 'string' ? JSON.parse(bill.items) : (bill.items || []);
      const s = window.storeSettings || {};
      const storeName = (s.receipt_store_name || s.store_name || 'Grill & Chill').toUpperCase();
      const storeTagline = s.receipt_store_tagline || s.store_tagline || 'Pizzeria & Bakery';
      const storeAddress = s.receipt_store_address || s.store_address || 'Raikot Rd, Sandhaur | Malerkotla';
      const storePhone = s.receipt_store_phone || s.store_phone || '79019 94174';
      
      function addText(str) {
        for (let i = 0; i < str.length; i++) {
          bytes.push(str.charCodeAt(i) & 0xFF);
        }
      }
      
      function addLine(str = '') {
        addText(str + '\n');
      }

      function addQrCode(value) {
        bytes.push(0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
        bytes.push(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x04); // QR size 4 (smaller)
        bytes.push(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x44, 0x31);
        const dataBytes = [];
        for (let i = 0; i < value.length; i++) {
          dataBytes.push(value.charCodeAt(i) & 0xFF);
        }
        const len = dataBytes.length + 3;
        const pL = len & 0xFF;
        const pH = (len >> 8) & 0xFF;
        bytes.push(0x1D, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30);
        bytes.push(...dataBytes);
        bytes.push(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30);
      }
      
      // Initialize printer
      bytes.push(0x1B, 0x40);

      // ── Store Header (compact) ──
      bytes.push(0x1B, 0x61, 0x01); // Center
      bytes.push(0x1B, 0x45, 0x01); // Bold on
      bytes.push(0x1D, 0x21, 0x11); // Double height+width
      addLine(storeName);
      bytes.push(0x1D, 0x21, 0x00); // Normal size
      bytes.push(0x1B, 0x45, 0x00); // Bold off
      if (storeTagline) addLine(storeTagline);
      if (storeAddress) {
        storeAddress.split('\n').forEach(line => {
          if (line.trim()) addLine(line.trim());
        });
      }
      if (storePhone) addLine(`Ph: ${storePhone}`);
      addLine('================================');

      // ── Bill Info ──
      const date = bill.created_at ? new Date(bill.created_at) : new Date();
      const billId = bill.id ? `#${String(bill.id).slice(0, 8).toUpperCase()}` : '#N/A';
      const timeStr = date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
      const dateStr = date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      
      bytes.push(0x1B, 0x61, 0x00); // Left align
      bytes.push(0x1B, 0x45, 0x01);
      addLine(padLine(`Bill ${billId}`, `${dateStr} ${timeStr}`));
      bytes.push(0x1B, 0x45, 0x00);
      addLine('--------------------------------');

      // ── Items ──
      const grouped = {};
      items.forEach(item => {
        const key = `${item.name}|${item.size || ''}`;
        if (!grouped[key]) {
          grouped[key] = { ...item, qty: 0, totalPrice: 0 };
        }
        grouped[key].qty += (item.quantity || 1);
        grouped[key].totalPrice += Number(item.price) * (item.quantity || 1);
      });
      
      Object.values(grouped).forEach(item => {
        const qty = item.qty;
        const nameWithSize = item.size ? `${item.name} (${item.size})` : item.name;
        const label = `${qty}x ${nameWithSize}`;
        const priceStr = `Rs.${item.totalPrice}`;
        
        if (label.length + priceStr.length + 1 > 32) {
          addLine(label);
          bytes.push(0x1B, 0x61, 0x02);
          addLine(priceStr);
          bytes.push(0x1B, 0x61, 0x00);
        } else {
          addLine(padLine(label, priceStr));
        }
      });
      
      addLine('--------------------------------');

      // ── Total ──
      const totalStr = `Rs.${bill.total_amount || 0}`;
      bytes.push(0x1B, 0x45, 0x01);
      bytes.push(0x1D, 0x21, 0x01); // Double height
      addLine(padLine('TOTAL', totalStr));
      bytes.push(0x1D, 0x21, 0x00);
      bytes.push(0x1B, 0x45, 0x00);
      addLine('================================');

      // ── Customer / Payment ──
      if (bill.customer_phone && bill.customer_phone !== 'N/A') {
        addLine(`Customer: ${bill.customer_phone}`);
      }
      if (bill.payment_method) {
        addLine(`Payment: ${bill.payment_method}`);
      }

      // ── Footer (compact) ──
      bytes.push(0x1B, 0x61, 0x01); // Center
      addLine(s.receipt_tax_note || 'Prices inclusive of taxes');
      addLine('--------------------------------');
      addLine(s.receipt_footer || 'Thank you! Visit again.');
      addLine(s.receipt_footer_subtext || 'Order Online - Free Delivery');
      addQrCode(s.receipt_qr_url || s.store_website || 'https://grillandchillpizzeria.juvaid.in');
      addLine(s.receipt_url || 'grillandchillpizzeria.juvaid.in');

      // Minimal paper feed + cut
      bytes.push(0x0A, 0x0A);
      bytes.push(0x1D, 0x56, 0x42, 0x00);
      
      return new Uint8Array(bytes);
    }

    function generateReceipt(bill, autoPrint = false) {
      window.lastGeneratedBill = bill;
      const items = typeof bill.items === 'string' ? JSON.parse(bill.items) : (bill.items || []);
      const dateObj = new Date(bill.created_at);
      const dateStr = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const timeStr = dateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
      const billId = bill.id ? `#${String(bill.id).slice(0, 8).toUpperCase()}` : '#N/A';

      // Pull from settings with fallbacks
      const s = window.storeSettings || {};
      const storeName = (s.receipt_store_name || s.store_name || 'Grill & Chill').toUpperCase();
      const storeTagline = s.receipt_store_tagline || s.store_tagline || 'Pizzeria & Bakery';
      const storeAddress = s.receipt_store_address || s.store_address || 'Raikot Rd, Sandhaur | Malerkotla';
      const storePhone = s.receipt_store_phone || s.store_phone || '79019 94174';
      const currency = s.currency_symbol || '₹';
      const receiptFooter = s.receipt_footer || 'Thank you! Visit again.';
      const receiptUrl = s.receipt_url || 'grillandchillpizzeria.juvaid.in';
      const footerSubtext = s.receipt_footer_subtext || 'Order Online &bull; Free Delivery';
      const logoUrl = s.logo_url || '';
      const showLogo = s.receipt_logo !== 'false';
      const storeWebsite = s.receipt_qr_url || s.store_website || 'https://grillandchillpizzeria.juvaid.in';
      const taxNote = s.receipt_tax_note || 'Prices inclusive of taxes';

      const grouped = {};
      items.forEach(item => {
        const key = `${item.name}|${item.size || ''}`;
        if (!grouped[key]) {
          grouped[key] = { ...item, qty: 0, totalPrice: 0 };
        }
        grouped[key].qty += (item.quantity || 1);
        grouped[key].totalPrice += Number(item.price) * (item.quantity || 1);
      });

      let qrDataUrl = '';
      try {
        const qr = new QRious({
          value: storeWebsite,
          size: 150
        });
        qrDataUrl = qr.toDataURL();
      } catch (qrErr) {
        console.error('Failed to generate receipt QR code:', qrErr);
      }
      
      const orderTypeMap = { 'dine-in': 'Dine-in', 'takeaway': 'Takeaway', 'delivery': 'Delivery' };
      const orderTypeStr = orderTypeMap[bill.order_type] || '';
      const custName = bill.customer_name && bill.customer_name !== 'Walk-in' ? bill.customer_name : '';

      const receiptContentHtml = `
        <div class="center">
          ${(showLogo && logoUrl) ? `<img src="${logoUrl}" class="store-logo" alt="Logo" onerror="this.style.display='none'">` : ''}
          <div class="store-name">${storeName}</div>
          <div class="store-tagline">${storeTagline}</div>
          <div class="store-address">
            ${storeAddress.replace(/\n/g, '<br>')}<br>
            Ph: ${storePhone}
          </div>
        </div>

        <hr class="double-separator">

        <div class="bill-info">
          <span class="bold">Bill ${billId}</span>
          <span>${dateStr} ${timeStr}</span>
        </div>
        ${orderTypeStr ? `<div class="bill-info"><span>Type: ${orderTypeStr}</span>${bill.table_number ? `<span>Table: ${bill.table_number}</span>` : ''}</div>` : ''}
        ${custName ? `<div class="customer-info">Customer: ${custName}</div>` : ''}

        <hr class="separator">

        <div class="items">
          ${Object.values(grouped).map(item => {
            const nameWithSize = item.size ? `${item.name} (${item.size})` : item.name;
            return `
              <div class="item-row">
                <span class="item-name">${item.qty}x ${nameWithSize}</span>
                <span class="item-price">${currency}${item.totalPrice}</span>
              </div>
            `;
          }).join('')}
        </div>

        <hr class="separator">

        ${bill.discount_amount > 0 ? `
          <div class="item-row">
            <span class="item-name">Subtotal</span>
            <span class="item-price">${currency}${bill.total_amount + bill.discount_amount}</span>
          </div>
          <div class="item-row">
            <span class="item-name" style="color:#22c55e">Discount</span>
            <span class="item-price" style="color:#22c55e">-${currency}${bill.discount_amount}</span>
          </div>
          <hr class="separator">
        ` : ''}

        <div class="total-row">
          <span>TOTAL</span>
          <span>${currency}${bill.total_amount}</span>
        </div>

        <hr class="double-separator">

        ${(bill.customer_phone && bill.customer_phone !== 'N/A') ? `<div class="customer-info">Phone: ${bill.customer_phone}</div>` : ''}
        ${(bill.payment_method) ? `<div class="customer-info">Payment: ${bill.payment_method}</div>` : ''}
        ${bill.notes ? `<div class="customer-info">Note: ${bill.notes}</div>` : ''}

        <div class="tax-note">${taxNote}</div>

        <hr class="separator">

        <div class="footer">
          <div class="footer-thanks">${receiptFooter}</div>
          <div class="footer-url" style="margin-top:2px;font-weight:bold">${footerSubtext}</div>
          <div class="qr-container" style="position: relative; display: inline-block; margin: 4px auto;">
            ${qrDataUrl ? `<img src="${qrDataUrl}" class="qr-code" alt="QR Code" style="margin: 0 !important;">` : ''}
            ${(bill.customer_phone && bill.customer_phone !== 'N/A') ? `
              <button class="no-print whatsapp-qr-share-btn" onclick="sendWhatsAppReceipt('${encodeURIComponent(bill.customer_phone)}', window.lastGeneratedBill)" style="position: absolute; bottom: 0; right: 0; background: #25D366; border: none; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 2px 5px rgba(0,0,0,0.3); color: white; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'" title="Share via WhatsApp">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.514 2.266 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.502-5.713-1.455L0 24zm6.49-4.203a9.884 9.884 0 0 0 5.511 1.659h.005c5.561 0 10.086-4.523 10.09-10.086.002-2.695-1.047-5.227-2.951-7.133C17.296 2.33 14.77 1.28 12.01 1.28c-5.568 0-10.094 4.524-10.099 10.087-.001 1.905.499 3.766 1.448 5.421l-.955 3.486 3.57-.936zm12.39-5.147c-.345-.173-2.042-1.009-2.357-1.124-.315-.115-.545-.173-.775.173-.23.345-.889 1.124-1.09 1.354-.201.23-.402.26-.747.087a10.06 10.06 0 0 1-2.772-1.71 11.08 11.08 0 0 1-1.916-2.385c-.345-.575-.037-.887.251-1.173.259-.258.575-.672.863-.827.288-.175.384-.288.575-.69a.97.97 0 0 0-.048-.918c-.086-.173-.775-1.868-1.062-2.558-.28-.673-.56-.58-.775-.592-.2-.011-.429-.013-.659-.013-.23 0-.603.086-.918.429-.315.345-1.207 1.179-1.207 2.874 0 1.695 1.235 3.333 1.407 3.563.173.23 2.43 3.71 5.887 5.198.822.354 1.464.566 1.966.726.825.262 1.576.225 2.169.137.66-.098 2.043-.834 2.33-1.639.287-.805.287-1.495.2-.163z"/></svg>
              </button>
            ` : ''}
          </div>
          <div class="footer-url">${receiptUrl}</div>
        </div>
      `;

      // Render into receipt modal preview paper
      const paper = document.getElementById('receiptPaper');
      if (paper) {
        paper.innerHTML = receiptContentHtml;
      }

      // Configure Action Buttons
      const btnDirectBLE = document.getElementById('btnDirectBtPrint');
      const btnBrowser = document.getElementById('btnBrowserPrint');
      const btnApp = document.getElementById('btnAppPrint');
      const btnEmail = document.getElementById('btnEmailReceipt');
      const btnShare = document.getElementById('btnShareReceipt');
      const btnDisconnect = document.getElementById('btnDisconnectBLE');

      // Writable frame for print
      const printIframeHtml = `
        <html>
        <head>
          <title>Receipt ${billId} — Grill & Chill</title>
          <meta charset="UTF-8">
          <style>
            @page { size: 58mm auto; margin: 0; }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              font-family: 'Courier New', Courier, monospace;
              width: 58mm;
              max-width: 58mm;
              margin: 0 auto;
              padding: 8px 6px;
              color: #000;
              font-size: 11px;
              line-height: 1.4;
              background: #fff;
            }
            .center { text-align: center; }
            .bold { font-weight: bold; }
            .separator {
              border: none;
              border-top: 1px dashed #000;
              margin: 6px 0;
            }
            .double-separator {
              border: none;
              border-top: 2px solid #000;
              margin: 6px 0;
            }
            .store-logo {
              width: 40px;
              height: auto;
              margin: 0 auto 4px;
              display: block;
            }
            .store-name {
              font-size: 16px;
              font-weight: 900;
              letter-spacing: 1px;
              margin-bottom: 2px;
            }
            .store-tagline {
              font-size: 10px;
              margin-bottom: 2px;
            }
            .store-address {
              font-size: 9px;
              color: #333;
              line-height: 1.3;
            }
            .bill-info {
              display: flex;
              justify-content: space-between;
              font-size: 10px;
              margin: 2px 0;
            }
            .item-row {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              font-size: 11px;
              margin: 3px 0;
              gap: 4px;
            }
            .item-name { flex: 1; word-break: break-word; text-align: left; }
            .item-price { white-space: nowrap; font-weight: 600; }
            .total-row {
              display: flex;
              justify-content: space-between;
              font-size: 14px;
              font-weight: 900;
              margin: 4px 0;
            }
            .customer-info {
              font-size: 10px;
              margin: 3px 0;
              text-align: left;
            }
            .tax-note {
              font-size: 9px;
              color: #555;
              text-align: center;
              margin: 4px 0;
            }
            .footer {
              text-align: center;
              margin-top: 6px;
            }
            .footer-thanks {
              font-size: 11px;
              font-weight: bold;
              margin-bottom: 2px;
            }
            .footer-url {
              font-size: 8px;
              color: #666;
              margin-bottom: 6px;
            }
            .qr-code {
              width: 80px;
              height: 80px;
              margin: 4px auto;
              display: block;
            }
            .no-print {
              display: none !important;
            }
          </style>
        </head>
        <body>
          ${receiptContentHtml}
        </body>
        </html>
      `;

      if (btnDirectBLE) {
        if (noBluetooth) {
          // Web Bluetooth is not available (iOS, Safari, Firefox, etc.)
          btnDirectBLE.onclick = () => showToast('Bluetooth printing is not available in this browser. Use PRINT or SHARE instead. 🖨️', true);
        } else {
          btnDirectBLE.onclick = () => printDirectlyViaBluetooth(bill);
        }
      }
      if (btnBrowser) {
        btnBrowser.onclick = () => printElementViaIframe(printIframeHtml);
      }

      // iOS AirPrint share button
      const btnAirPrint = document.getElementById('btnAirPrint');
      if (btnAirPrint) {
        btnAirPrint.onclick = () => airPrintViaShare(printIframeHtml, billId);
      }

      if (btnApp) {
        btnApp.onclick = () => printBluetooth(bill);
      }
      if (btnEmail) {
        btnEmail.onclick = () => {
          const emailAddr = prompt('Enter customer email address:', '');
          if (emailAddr) {
            const receiptText = generateReceiptText(bill);
            const subject = encodeURIComponent(`Receipt from Grill & Chill — Bill ${billId}`);
            const body = encodeURIComponent(receiptText);
            window.open(`mailto:${emailAddr}?subject=${subject}&body=${body}`, '_blank');
          }
        };
      }
      if (btnShare) {
        btnShare.onclick = () => {
          const receiptText = generateReceiptText(bill);
          if (navigator.share) {
            navigator.share({
              title: `Grill & Chill Bill ${billId}`,
              text: receiptText
            }).catch(err => console.log('Share failed:', err));
          } else {
            navigator.clipboard.writeText(receiptText).then(() => {
              showToast('Receipt text copied! 📋');
            });
          }
        };
      }
      if (btnDisconnect) {
        btnDisconnect.onclick = () => disconnectBLEPrinter();
        btnDisconnect.style.display = (cachedPrinterDevice && cachedPrinterDevice.gatt.connected) ? 'block' : 'none';
      }

      // Open Modal
      document.getElementById('receiptPreviewModal').style.display = 'flex';

      // Recreate Lucide Icons inside modal
      if (window.lucide) {
        window.lucide.createIcons();
      }

      if (autoPrint) {
        printElementViaIframe(printIframeHtml);
      }
    }

    // Listen for auth state changes
    supabaseClient.auth.onAuthStateChange((event, session) => {
      console.log('Auth state change:', event, session);
      if (event === 'SIGNED_IN') {
        checkAuth();
      } else if (event === 'SIGNED_OUT') {
        location.reload();
      }
    });

    checkAuth();

    // --- MOBILE HEADER HIDE ON SCROLL ---
    let lastScrollY = window.scrollY;
    window.addEventListener('scroll', () => {
      // Only apply on mobile (where header takes up valuable space)
      if (window.innerWidth <= 1023) {
        const header = document.querySelector('header');
        if (header) {
          if (window.scrollY > lastScrollY && window.scrollY > 80) {
            header.classList.add('header-hidden');
          } else {
            header.classList.remove('header-hidden');
          }
        }
      }
      lastScrollY = window.scrollY;
    }, { passive: true });
