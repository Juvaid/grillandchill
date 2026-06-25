// Checkout: order submission to Supabase, UPI confirmation modal, offline
// order queue + sync, and the local order history sheet.
import { state } from './state.js';
import { supabaseClient } from '../shared/supabase.js';
import { getLocation } from './location.js';
import { updateCartBar } from './cart.js';
import { openSheet, closeAll } from './ui.js';

// ═══════ OFFLINE QUEUE SYNC ═══════
export async function syncPendingOrders() {
  const pending = JSON.parse(localStorage.getItem('pending_sync_orders') || '[]');
  if (pending.length === 0) return;

  console.log(`Attempting to sync ${pending.length} offline orders...`);
  const remaining = [];

  for (const ord of pending) {
    try {
      const { data: order, error: orderErr } = await supabaseClient
        .from('orders')
        .insert([{
          customer_name: ord.name,
          customer_phone: ord.phone,
          total_amount: ord.total,
          delivery_lat: ord.lat,
          delivery_lng: ord.lng,
          delivery_address: ord.address || null,
          status: 'pending'
        }])
        .select().single();

      if (orderErr) throw orderErr;

      const orderItems = ord.cart.map(i => ({
        order_id: order.id,
        menu_item_id: i.id,
        item_name: i.n,
        quantity: 1,
        price: i.price,
        size: i.chosenSize,
        addons: i.chosenAddons
      }));

      await supabaseClient.from('order_items').insert(orderItems);
    } catch (e) {
      remaining.push(ord); // Keep in queue if still failing
    }
  }
  localStorage.setItem('pending_sync_orders', JSON.stringify(remaining));
}

// ═══════ ORDER SUBMISSION ═══════
export async function sendOrder() {
  const name = document.getElementById('custName').value.trim();
  const phone = document.getElementById('custPhone').value.trim();
  const manualAddr = document.getElementById('manualAddr').value.trim();

  if (!name || !phone) {
    alert("Please enter your name and phone number so we can reach you!");
    return;
  }

  if (!state.userLoc) {
    // Force one try if they haven't clicked
    await getLocation();
  }

  // Extract coordinates from marker if map exists
  let lat = 30.5716, lng = 75.7401; // Default
  if (state.marker) {
    const pos = state.marker.getLatLng();
    lat = pos.lat;
    lng = pos.lng;
  }

  const total = state.cart.reduce((s, i) => s + i.price, 0);
  const selectedPayment = document.querySelector('input[name="custPaymentMethod"]:checked').value;

  if (selectedPayment === 'UPI') {
    // Open UPI Instruction modal
    window.pendingUpiOrderData = { name, phone, manualAddr, lat, lng, total, cart: JSON.parse(JSON.stringify(state.cart)) };

    const upiUrl = `upi://pay?pa=${state.STORE_UPI}&pn=${encodeURIComponent(state.STORE_MERCHANT_NAME)}&am=${total}&cu=INR`;
    const qr = new QRious({
      value: upiUrl,
      size: 180
    });
    document.getElementById('custUpiQrImg').src = qr.toDataURL();
    document.getElementById('custUpiPayBtn').href = upiUrl;
    document.getElementById('custUpiAmount').innerText = total;

    document.getElementById('customerUpiModal').style.display = 'flex';
    startCustUpiCountdown();
  } else {
    executeOrderPlacement('Cash', name, phone, manualAddr, lat, lng, total, state.cart);
  }
}

export async function executeOrderPlacement(paymentMethod, name, phone, manualAddr, lat, lng, total, itemsCart) {
  const btn = document.getElementById('waBtn');
  btn.textContent = '🚀 PROCESSING...'; btn.disabled = true;

  try {
    // 1. Create Order in Supabase
    const { data: order, error: orderErr } = await supabaseClient
      .from('orders')
      .insert([{
        customer_name: name,
        customer_phone: phone,
        total_amount: total,
        delivery_lat: lat,
        delivery_lng: lng,
        delivery_address: manualAddr || null,
        status: 'pending',
        payment_status: paymentMethod === 'UPI' ? 'paid' : 'unpaid'
      }])
      .select()
      .single();

    if (orderErr) throw orderErr;

    // 2. Add Order Items
    const orderItems = itemsCart.map(i => ({
      order_id: order.id,
      menu_item_id: i.id,
      item_name: i.n,
      quantity: 1,
      price: i.price,
      size: i.chosenSize,
      addons: i.chosenAddons
    }));

    const { error: itemsErr } = await supabaseClient.from('order_items').insert(orderItems);
    if (itemsErr) throw itemsErr;

    // 3. Trigger WhatsApp
    const orderLines = itemsCart.map(i => {
      let adStr = '';
      if (i.chosenAddons) {
        const adArr = [];
        const skip = ['Classic Base', 'Burger Only', 'Without Ice Cream', 'Veg'];
        Object.values(i.chosenAddons).forEach(arr => arr.forEach(a => { if (!skip.includes(a)) adArr.push(a); }));
        if (adArr.length) adStr = `\n    ↳ _+ ${adArr.join(', ')}_`;
      }
      return `• ${i.n} _(${i.chosenSize})_ — *₹${i.price}*${adStr}`;
    });

    const lines = [
      `*🔥 NEW ORDER — GRILL & CHILL*`,
      `*ORDER ID: #${order.id}*`,
      `*PAYMENT: ${paymentMethod === 'UPI' ? '📱 UPI (Paid)' : '💵 Cash/COD'}*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ...orderLines,
      `━━━━━━━━━━━━━━━━━━━━`,
      `*TOTAL: ₹${total}*`,
      ``, `📍 *Delivery location:*`,
      state.userLoc || `_(GPS Not shared)_`,
      manualAddr ? `\n🏠 *Address:* ${manualAddr}` : ``
    ];

    // Save locally for offline access
    const recentOrders = JSON.parse(localStorage.getItem('recent_orders') || '[]');
    recentOrders.unshift({ id: order.id, date: new Date(), total, items: itemsCart });
    localStorage.setItem('recent_orders', JSON.stringify(recentOrders.slice(0, 10)));

    window.open(`https://wa.me/917901994174?text=${encodeURIComponent(lines.join('\n'))}`, '_blank');

    // Clear cart after success
    state.cart = [];
    updateCartBar();
    closeAll();
    alert("Order placed successfully! We've redirected you to WhatsApp for confirmation.");

  } catch (err) {
    console.error("Order failed to reach DB, queuing for sync:", err);

    // Save to sync queue
    const pending = JSON.parse(localStorage.getItem('pending_sync_orders') || '[]');
    pending.push({ name, phone, total, lat, lng, address: manualAddr || null, payment: paymentMethod, cart: JSON.parse(JSON.stringify(itemsCart)), date: new Date() });
    localStorage.setItem('pending_sync_orders', JSON.stringify(pending));

    alert("No internet? No problem! We've saved your order and will sync it with our kitchen soon. We're opening WhatsApp now to confirm your order!");

    // Fallback to pure WhatsApp
    const orderLines = itemsCart.map(i => `• ${i.n} (${i.chosenSize}) - ₹${i.price}`);
    const fallbackLines = [
      `*🔥 OFFLINE ORDER — GRILL & CHILL*`,
      `*PAYMENT: ${paymentMethod === 'UPI' ? '📱 UPI (Paid)' : '💵 Cash/COD'}*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ...orderLines,
      `━━━━━━━━━━━━━━━━━━━━`,
      `TOTAL: ₹${total}`,
      `Loc: ${state.userLoc}`
    ];
    window.open(`https://wa.me/917901994174?text=${encodeURIComponent(fallbackLines.join('\n'))}`, '_blank');

    state.cart = [];
    updateCartBar();
    closeAll();
  } finally {
    btn.innerHTML = '<span>🛵</span><span>ORDER ON WHATSAPP</span>'; btn.disabled = false;
  }
}

export function confirmUpiAndSendWhatsApp() {
  if (window.custUpiTimer) clearInterval(window.custUpiTimer);
  const modal = document.getElementById('customerUpiModal');
  modal.style.display = 'none';

  if (window.pendingUpiOrderData) {
    const d = window.pendingUpiOrderData;
    executeOrderPlacement('UPI', d.name, d.phone, d.manualAddr, d.lat, d.lng, d.total, d.cart);
    window.pendingUpiOrderData = null;
  }
}

export function closeCustomerUpiModal() {
  if (window.custUpiTimer) clearInterval(window.custUpiTimer);
  document.getElementById('customerUpiModal').style.display = 'none';
  const btn = document.getElementById('waBtn');
  btn.innerHTML = '<span>🛵</span><span>ORDER ON WHATSAPP</span>';
  btn.disabled = false;

  // Restore confirm button state
  const confirmBtn = document.getElementById('custWaConfirmBtn');
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = `
      <svg viewBox="0 0 448 512" width="16" height="16" fill="currentColor" style="display:inline-block; vertical-align:middle;">
        <path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L3.2 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7 .9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z"/>
      </svg>
      <span>CONFIRM & SEND ON WHATSAPP</span>
    `;
  }
}

export function startCustUpiCountdown() {
  const btn = document.getElementById('custWaConfirmBtn');
  if (!btn) return;

  const origHtml = btn.innerHTML;
  let count = 15; // 15 seconds delay

  if (window.custUpiTimer) clearInterval(window.custUpiTimer);

  btn.disabled = true;
  btn.querySelector('span').innerText = `CONFIRM IN ${count}S...`;

  window.custUpiTimer = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(window.custUpiTimer);
      btn.disabled = false;
      btn.innerHTML = origHtml;
    } else {
      btn.querySelector('span').innerText = `CONFIRM IN ${count}S...`;
    }
  }, 1000);
}

// ═══════ HISTORY ═══════
export function openHistory() {
  const items = document.getElementById('historyItems');
  const empty = document.getElementById('historyEmpty');
  const orders = JSON.parse(localStorage.getItem('recent_orders') || '[]');

  if (!orders.length) {
    items.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    items.innerHTML = orders.map(ord => {
      const date = new Date(ord.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const itemNames = ord.items.map(it => `${it.n} x${it.q || 1}`).join(', ');

      return `
      <div class="history-card">
        <div class="hc-header">
          <div class="hc-id">Order #${ord.id}</div>
          <div class="hc-date">${date}</div>
        </div>
        <div class="hc-items">${itemNames}</div>
        <div class="hc-footer">
          <div class="hc-total">Total: ₹${ord.total}</div>
          <div class="hc-status">Completed</div>
        </div>
      </div>`;
    }).join('');
  }
  openSheet('historySheet');
}
