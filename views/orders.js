import { db, supabaseClient, syncOrders, syncBills } from '../db.js';
import { escapeHTML, generateUUID, showToast, closeModal } from '../utils.js';
import { generateReceipt } from './pos.js';

let ordersChannel = null;

export function renderOrderSkeletons() {
  const body = document.getElementById('ordersBody');
  if (!body) return;
  body.innerHTML = Array(3).fill(0).map(() => `
    <div class="skeleton-card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div class="skeleton-line heading skeleton-shimmer w-30"></div>
        <div class="skeleton-line skeleton-shimmer w-20" style="height:24px; border-radius:12px;"></div>
      </div>
      <div class="skeleton-line skeleton-shimmer w-50" style="margin-bottom:8px;"></div>
      <div class="skeleton-line skeleton-shimmer w-40" style="margin-bottom:8px;"></div>
      <div style="display:flex; gap:10px; margin-top:20px;">
        <div class="skeleton-line skeleton-shimmer w-30" style="height:36px; border-radius:8px;"></div>
        <div class="skeleton-line skeleton-shimmer w-30" style="height:36px; border-radius:8px;"></div>
      </div>
    </div>
  `).join('');
}

export function subscribeToOrders() {
  if (ordersChannel) {
    console.log('Already subscribed to live orders.');
    return;
  }
  console.log('📡 Subscribing to Live Orders...');
  
  if (window.Notification && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  ordersChannel = supabaseClient
    .channel('orders-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, payload => {
      console.log('🔥 New Live Order:', payload);
      
      if (typeof window.playNotificationSound === 'function') {
        window.playNotificationSound();
      }
      
      if (window.Notification && Notification.permission === 'granted') {
        new Notification('New Order Received! 🍕', {
          body: `${payload.new.customer_name} ordered for ₹${payload.new.total_amount}`,
          icon: 'assets/logo-transparent.png'
        });
      }
      
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

export async function loadOrders() {
  renderOrderSkeletons();

  let localData = [];
  
  try {
    localData = await db.local_orders.orderBy('created_at').reverse().toArray();
    if (localData && localData.length > 0) {
      window.allOrders = localData;
      renderOrders(localData);
    }
  } catch (e) {
    console.warn('Failed to load orders from Dexie:', e);
  }

  if (navigator.onLine) {
    syncOrders().catch(err => console.warn('Background syncOrders failed:', err));
  }

  if (navigator.onLine) {
    try {
      const fetchPromise = supabaseClient
        .from('orders')
        .select('*, order_items(*)')
        .order('created_at', { ascending: false });

      const res = await Promise.race([
        fetchPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase orders fetch timeout')), 4000))
      ]);

      const freshData = res.data;
      if (freshData && freshData.length > 0) {
        window.allOrders = freshData;
        renderOrders(freshData);

        await db.local_orders.clear();
        await db.local_orders.bulkPut(freshData.map(o => ({ ...o, sync_status: 'synced' })));
      }
    } catch (err) {
      console.warn('Failed to load orders from Supabase:', err);
      if (!localData || localData.length === 0) {
        renderOrders([]);
      }
    }
  } else {
    if (!localData || localData.length === 0) {
      renderOrders([]);
    }
  }
}

export function renderOrders(data) {
  const body = document.getElementById('ordersBody');
  if (!body) return;
  if (!data || data.length === 0) {
    body.innerHTML = '<div class="empty-state">No orders found</div>';
    return;
  }
  
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
          <div style="font-weight:900; font-size:1.05rem; letter-spacing:-0.3px">${escapeHTML(o.customer_name || 'Walk-in')}</div>
          <div style="display:flex; align-items:center; gap:8px; margin-top:2px">
            <span style="font-size:0.75rem; color:var(--muted)">${escapeHTML(o.customer_phone || 'N/A')}</span>
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
                <span style="font-weight:700; color:var(--text)">${escapeHTML(i.item_name)}</span>
                <div style="font-size:0.7rem; color:var(--muted); margin-top:2px">${escapeHTML(i.size)}</div>
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
  
  if (typeof window.updateDashboardStats === 'function') {
    window.updateDashboardStats();
  }
  if (window.lucide) window.lucide.createIcons();
  updateStats(data);
}

export function updateStats(data) {
  if (!data) return;
  const rev = data.filter(o => o.status === 'completed').reduce((acc, o) => acc + o.total_amount, 0);
  const active = data.filter(o => !['completed', 'cancelled'].includes(o.status)).length;
  
  const revEl = document.getElementById('revenueToday');
  const actEl = document.getElementById('activeOrders');
  if (revEl) revEl.innerText = '₹' + rev;
  if (actEl) actEl.innerText = active;
}

export async function updateStatus(id, status) {
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

export function selectPaymentMethodForOrder(order, callback, onCancel) {
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

export async function billOrder(orderId) {
  const order = (window.allOrders || []).find(o => o.id === orderId);
  if (!order) return alert('Order not found!');
  
  selectPaymentMethodForOrder(order, async (paymentMethod) => {
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
