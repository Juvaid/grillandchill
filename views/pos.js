import { db, supabaseClient, syncBills } from '../db.js';
import { generateUUID, padLine, showToast, closeModal, openModal } from '../utils.js';

export let cachedPrinterDevice = null;
export let cachedPrinterChar = null;

const PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // General BLE Printer Service
  '0000e7e1-0000-1000-8000-00805f9b34fb', // Custom BLE Printer
  'e7e1a2c0-294d-11e5-bc34-0002a5d5c51b', // Custom Serial BLE
  '0000ffe1-0000-1000-8000-00805f9b34fb',
  '00004953-0000-1000-8000-00805f9b34fb'  // ISSC BLE
];

const noBluetooth = !navigator.bluetooth;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

export let currentBillItems = [];
export let posOrderType = 'dine-in';
export let posDiscountMode = 'percent';
export let allMenuItems = [];
export let selectedPosCategory = 'all';

export function renderPosItemSkeletons() {
  const cats = document.getElementById('posCategories');
  const items = document.getElementById('posItems');
  if (cats) {
    cats.innerHTML = `
      <div class="pos-cat-btn active skeleton-shimmer" style="width: 60px; height: 32px; border: none;"></div>
      <div class="pos-cat-btn skeleton-shimmer" style="width: 80px; height: 32px; border: none; opacity: 0.6;"></div>
      <div class="pos-cat-btn skeleton-shimmer" style="width: 70px; height: 32px; border: none; opacity: 0.6;"></div>
      <div class="pos-cat-btn skeleton-shimmer" style="width: 90px; height: 32px; border: none; opacity: 0.6;"></div>
    `;
  }
  if (items) {
    items.innerHTML = Array(6).fill(0).map(() => `
      <div class="skeleton-pos-item">
        <div class="skeleton-line heading skeleton-shimmer w-70" style="margin-bottom:8px;"></div>
        <div class="skeleton-line skeleton-shimmer w-40" style="margin-bottom:8px;"></div>
        <div style="display:flex; gap:6px; margin-top:12px;">
          <div class="skeleton-line skeleton-shimmer w-50" style="height:28px; border-radius:8px;"></div>
          <div class="skeleton-line skeleton-shimmer w-50" style="height:28px; border-radius:8px;"></div>
        </div>
      </div>
    `).join('');
  }
}

export async function showQuickBill() {
  document.getElementById('quickBillModal').style.display = 'flex';
  renderPosItemSkeletons();
  selectOrderType('dine-in');
  switchPosMobileTab('menu');

  const cardBtn = document.getElementById('posCardBtn');
  if (cardBtn) cardBtn.style.display = (window.storeSettings?.enable_card === 'true') ? 'flex' : 'none';
  
  const deliveryBtn = document.getElementById('posDeliveryBtn');
  if (deliveryBtn) deliveryBtn.style.display = (window.storeSettings?.enable_delivery === 'true') ? 'flex' : 'none';
  
  const defaultPay = window.storeSettings?.default_payment;
  if (defaultPay) {
    const select = document.getElementById('billPaymentMethod');
    if (select) select.value = defaultPay;
  }

  let data = null;
  if (navigator.onLine) {
    try {
      const fetchPromise = supabaseClient.from('menu_items')
        .select('*')
        .eq('available', true)
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
        
      const res = await Promise.race([
        fetchPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase menu fetch timeout')), 1500))
      ]);
      
      if (res && !res.error) data = res.data;
    } catch (err) {
      console.warn('Failed to load menu items for POS from Supabase, checking local cache:', err);
    }
  }

  if (!data) {
    try {
      data = await db.menu_items.toArray();
      data = data.filter(i => i.available === true || i.available === 'true' || i.available === 1);
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
    
    setTimeout(() => {
      const searchInput = document.getElementById('posSearch');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    }, 100);
  } else {
    document.getElementById('quickBillModal').style.display = 'none';
    alert('No menu items available! Please load the admin page while online at least once to cache the menu.');
  }
}

export function closeQuickBill() {
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

  if (window.isPublicPosMode) {
    const authScreen = document.getElementById('authScreen');
    const dashboard = document.getElementById('dashboard');
    if (authScreen) authScreen.classList.remove('hidden');
    if (dashboard) dashboard.classList.add('hidden');
  }
}

export function selectPosCategory(cat) {
  selectedPosCategory = cat;
  document.querySelectorAll('.pos-cat-btn').forEach(btn => {
    const isActive = btn.dataset.category === cat;
    btn.classList.toggle('active', isActive);
  });
  filterAndSearchPosItems();
}

export function filterAndSearchPosItems() {
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

export function renderPosCategories() {
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

export function renderPosItems(items) {
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

export function addToBill(id, name, size, price) {
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

export function changeBasketQty(idx, delta) {
  const item = currentBillItems[idx];
  if (!item) return;
  item.qty = (item.qty || 1) + delta;
  if (item.qty <= 0) {
    currentBillItems.splice(idx, 1);
  }
  updatePosTotal();
  renderBasket();
}

export function renderBasket() {
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

export function clearPosBasket() {
  currentBillItems = [];
  updatePosTotal();
  renderBasket();
  showToast('Basket Cleared');
}

export function updatePosTotal() {
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

  const mobileCount = document.getElementById('posMobileCartCount');
  if (mobileCount) mobileCount.innerText = itemCount;
  
  const pillCount = document.getElementById('posMobileCartCountPill');
  if (pillCount) pillCount.innerText = itemCount;
  
  const pillTotal = document.getElementById('posMobileCartTotalPill');
  if (pillTotal) pillTotal.innerText = `₹${total} ➜`;
  
  updateMobilePillVisibility();
}

export function switchPosMobileTab(tab) {
  document.querySelectorAll('.pos-mobile-tab').forEach(btn => {
    const isActive = btn.id === `posTab-${tab}-btn`;
    btn.classList.toggle('active', isActive);
  });
  
  const menuCol = document.getElementById('posMenuCol');
  const cartCol = document.getElementById('posCartCol');
  if (tab === 'menu') {
    if (menuCol) menuCol.style.display = 'flex';
    if (cartCol) cartCol.style.display = 'none';
  } else {
    if (menuCol) menuCol.style.display = 'none';
    if (cartCol) cartCol.style.display = 'flex';
    renderBasket();
  }
  
  updateMobilePillVisibility();
}

export function updateMobilePillVisibility() {
  const pill = document.getElementById('posMobileCartFloatingPill');
  if (!pill) return;
  
  const menuCol = document.getElementById('posMenuCol');
  const itemCount = currentBillItems.reduce((sum, i) => sum + (i.qty || 1), 0);
  
  const isMenuVisible = menuCol && window.getComputedStyle(menuCol).display !== 'none';
  const isMobileLayout = window.innerWidth <= 1024;
  
  if (isMobileLayout && isMenuVisible && itemCount > 0) {
    pill.style.display = 'flex';
  } else {
    pill.style.display = 'none';
  }
}

export function selectOrderType(type) {
  posOrderType = type;
  document.querySelectorAll('.order-type-btn').forEach(btn => {
    const isActive = btn.dataset.type === type;
    btn.classList.toggle('active', isActive);
  });
  
  const tableContainer = document.getElementById('posTableNumContainer');
  if (tableContainer) {
    tableContainer.style.display = (type === 'dine-in') ? 'block' : 'none';
  }
}

export function setDiscountMode(mode) {
  posDiscountMode = mode;
  document.querySelectorAll('.discount-mode-btn').forEach(btn => {
    const isActive = btn.dataset.mode === mode;
    btn.classList.toggle('active', isActive);
  });
  updatePosTotal();
}

export async function saveBillWithPayment(paymentMethod) {
  if (currentBillItems.length === 0) return alert('Bill is empty!');
  const phone = document.getElementById('customerPhone').value || 'N/A';
  const customerName = document.getElementById('posCustomerName')?.value?.trim() || 'Walk-in';
  const notes = document.getElementById('posOrderNotes')?.value?.trim() || '';
  const tableNumber = document.getElementById('posTableNumber')?.value?.trim() || '';
  
  const subtotal = currentBillItems.reduce((sum, i) => sum + (i.price * (i.qty || 1)), 0);
  const discVal = parseFloat(document.getElementById('posDiscountValue')?.value) || 0;
  let discount = 0;
  if (discVal > 0) {
    discount = posDiscountMode === 'percent' ? Math.round(subtotal * discVal / 100) : discVal;
  }
  const total = Math.max(0, subtotal - discount);

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

export async function saveBill() {
  const currentMethod = document.getElementById('billPaymentMethod')?.value || 'Cash';
  await saveBillWithPayment(currentMethod);
}

export async function finalizeBill(customerName, phone, paymentMethod, total, items, notes, tableNumber, discount) {
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
    if (typeof window.loadBilling === 'function') {
      window.loadBilling();
    }
    syncBills(); 
    generateReceipt(billData, false);
  } catch (err) {
    console.error('Save failed:', err);
  }
}

export async function writeInChunks(char, data) {
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
        console.warn('Large chunk failed, falling back to 20-byte chunks:', err.message);
        chunkSize = 20;
        i = -chunkSize;
        continue;
      }
      throw err;
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

export async function getBLEPrinter() {
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

export function disconnectBLEPrinter() {
  if (cachedPrinterDevice && cachedPrinterDevice.gatt.connected) {
    cachedPrinterDevice.gatt.disconnect();
  }
  cachedPrinterChar = null;
  cachedPrinterDevice = null;
  const disconnectBtn = document.getElementById('btnDisconnectBLE');
  if (disconnectBtn) disconnectBtn.style.display = 'none';
  showToast('Printer disconnected');
}

export function handleReceipt(billId, autoPrint) {
  const bill = window.CURRENT_BILLS.find(b => b.id === billId);
  if (bill) {
    generateReceipt(bill, autoPrint);
  }
}

export function handleBluetoothPrint(billId) {
  const bill = window.CURRENT_BILLS.find(b => b.id === billId);
  if (!bill) return;
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

export function handleShare(billId) {
  const bill = window.CURRENT_BILLS.find(b => b.id === billId);
  if (bill) {
    shareReceipt(bill);
  }
}

export async function printDirectlyViaBluetooth(bill) {
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

export function printBluetooth(bill) {
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

export async function shareReceipt(bill) {
  const items = getBillItems(bill);
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

export function sendWhatsAppReceipt(phone, bill) {
  const text = generateReceiptText(bill);
  const encodedText = encodeURIComponent(text);
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const waUrl = `https://wa.me/${cleanPhone}?text=${encodedText}`;
  window.open(waUrl, '_blank');
}

export async function logoToEscPos(url, targetWidth = 120) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const scale = targetWidth / img.width;
        const targetHeight = Math.round(img.height * scale);
        const alignedHeight = Math.ceil(targetHeight / 8) * 8;

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = alignedHeight;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, targetWidth, alignedHeight);
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        const imgData = ctx.getImageData(0, 0, targetWidth, alignedHeight);
        const pixels = imgData.data;

        const bytes = [];
        bytes.push(0x1B, 0x33, 0x08);
        bytes.push(0x1B, 0x61, 0x01);

        const nL = targetWidth & 0xFF;
        const nH = (targetWidth >> 8) & 0xFF;

        for (let stripY = 0; stripY < alignedHeight; stripY += 8) {
          bytes.push(0x1B, 0x2A, 0x00, nL, nH);

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
          bytes.push(0x0A);
        }

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

export function generateEscPosBytes(bill) {
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
    bytes.push(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x04);
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
  
  bytes.push(0x1B, 0x40);

  bytes.push(0x1B, 0x61, 0x01);
  bytes.push(0x1B, 0x45, 0x01);
  bytes.push(0x1D, 0x21, 0x11);
  addLine(storeName);
  bytes.push(0x1D, 0x21, 0x00);
  bytes.push(0x1B, 0x45, 0x00);
  if (storeTagline) addLine(storeTagline);
  if (storeAddress) {
    storeAddress.split('\n').forEach(line => {
      if (line.trim()) addLine(line.trim());
    });
  }
  if (storePhone) addLine(`Ph: ${storePhone}`);
  addLine('================================');

  const date = bill.created_at ? new Date(bill.created_at) : new Date();
  const billId = bill.id ? `#${String(bill.id).slice(0, 8).toUpperCase()}` : '#N/A';
  const timeStr = date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  
  bytes.push(0x1B, 0x61, 0x00);
  bytes.push(0x1B, 0x45, 0x01);
  addLine(padLine(`Bill ${billId}`, `${dateStr} ${timeStr}`));
  bytes.push(0x1B, 0x45, 0x00);
  addLine('--------------------------------');

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

  const totalStr = `Rs.${bill.total_amount || 0}`;
  bytes.push(0x1B, 0x45, 0x01);
  bytes.push(0x1D, 0x21, 0x01);
  addLine(padLine('TOTAL', totalStr));
  bytes.push(0x1D, 0x21, 0x00);
  bytes.push(0x1B, 0x45, 0x00);
  addLine('================================');

  if (bill.customer_phone && bill.customer_phone !== 'N/A') {
    addLine(`Customer: ${bill.customer_phone}`);
  }
  if (bill.payment_method) {
    addLine(`Payment: ${bill.payment_method}`);
  }

  bytes.push(0x1B, 0x61, 0x01);
  addLine(s.receipt_tax_note || 'Prices inclusive of taxes');
  addLine('--------------------------------');
  addLine(s.receipt_footer || 'Thank you! Visit again.');
  addLine(s.receipt_footer_subtext || 'Order Online - Free Delivery');
  addQrCode(s.receipt_qr_url || s.store_website || 'https://grillandchillpizzeria.juvaid.in');
  addLine(s.receipt_url || 'grillandchillpizzeria.juvaid.in');

  bytes.push(0x0A, 0x0A);
  bytes.push(0x1D, 0x56, 0x42, 0x00);
  
  return new Uint8Array(bytes);
}

export function generateReceipt(bill, autoPrint = false) {
  window.lastGeneratedBill = bill;
  const items = typeof bill.items === 'string' ? JSON.parse(bill.items) : (bill.items || []);
  const dateObj = new Date(bill.created_at);
  const dateStr = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = dateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const billId = bill.id ? `#${String(bill.id).slice(0, 8).toUpperCase()}` : '#N/A';

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

  const paper = document.getElementById('receiptPaper');
  if (paper) {
    paper.innerHTML = receiptContentHtml;
  }

  const btnDirectBLE = document.getElementById('btnDirectBtPrint');
  const btnBrowser = document.getElementById('btnBrowserPrint');
  const btnApp = document.getElementById('btnAppPrint');
  const btnEmail = document.getElementById('btnEmailReceipt');
  const btnShare = document.getElementById('btnShareReceipt');

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
      btnDirectBLE.onclick = () => showToast('Bluetooth printing is not available in this browser. Use PRINT or SHARE instead. 🖨️', true);
    } else {
      btnDirectBLE.onclick = () => printDirectlyViaBluetooth(bill);
    }
  }
  if (btnBrowser) {
    btnBrowser.onclick = () => printElementViaIframe(printIframeHtml);
  }

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
          title: `Receipt ${billId}`,
          text: receiptText
        });
      } else {
        navigator.clipboard.writeText(receiptText);
        showToast('Receipt text copied to clipboard! 📋');
      }
    };
  }

  openModal('receiptPreviewModal');
}

function printElementViaIframe(htmlContent) {
  if (isIOS) {
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
      showToast('Pop-up blocked. Use SHARE → Print instead.', true);
    }
    return;
  }

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

async function airPrintViaShare(htmlContent, billId) {
  try {
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const file = new File([blob], `receipt-${billId}.html`, { type: 'text/html' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: `Receipt ${billId}` });
    } else if (navigator.share) {
      const blobUrl = URL.createObjectURL(blob);
      await navigator.share({ title: `Receipt ${billId}`, url: blobUrl });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } else {
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank');
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('Could not open share sheet: ' + err.message, true);
    }
  }
}

function getBillItems(bill) {
  if (typeof window.getBillItems === 'function') {
    return window.getBillItems(bill);
  }
  return [];
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

// Bind POS key handlers
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
