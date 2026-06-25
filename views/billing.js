import { db, supabaseClient } from '../db.js';
import { escapeHTML, getBillItems, padLine, showToast, openModal, closeModal } from '../utils.js';
import { cachedPrinterChar, cachedPrinterDevice, writeInChunks } from './pos.js';

export let billsDisplayedCount = 15;

export function renderBillingSkeletons() {
  const rev = document.getElementById('statRevenue');
  const count = document.getElementById('statBillsCount');
  const avg = document.getElementById('statAvgBill');
  const voided = document.getElementById('statVoidedCount');
  const body = document.getElementById('billingBody');

  const shimmerHtml = '<span class="skeleton-shimmer" style="display:inline-block; width:50px; height:18px; border-radius:4px;"></span>';
  if (rev) rev.innerHTML = shimmerHtml;
  if (count) count.innerHTML = shimmerHtml;
  if (avg) avg.innerHTML = shimmerHtml;
  if (voided) voided.innerHTML = shimmerHtml;

  if (body) {
    body.innerHTML = Array(3).fill(0).map(() => `
      <div class="skeleton-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <div class="skeleton-line heading skeleton-shimmer w-30"></div>
          <div class="skeleton-line skeleton-shimmer w-20" style="height:24px; border-radius:12px;"></div>
        </div>
        <div class="skeleton-line skeleton-shimmer w-50" style="margin-bottom:8px;"></div>
        <div class="skeleton-line skeleton-shimmer w-40" style="margin-bottom:8px;"></div>
        <div style="display:flex; gap:10px; margin-top:20px;">
          <div class="skeleton-line skeleton-shimmer w-35" style="height:36px; border-radius:8px;"></div>
          <div class="skeleton-line skeleton-shimmer w-35" style="height:36px; border-radius:8px;"></div>
        </div>
      </div>
    `).join('');
  }
}

export async function loadBilling() {
  renderBillingSkeletons();

  let localBills = [];
  
  try {
    localBills = await db.local_bills.orderBy('created_at').reverse().toArray();
    if (localBills && localBills.length > 0) {
      window.CURRENT_BILLS = localBills;
      filterBills();
    }
  } catch (e) {
    console.warn('Failed to load bills from Dexie cache:', e);
  }

  if (navigator.onLine) {
    try {
      const fetchPromise = supabaseClient.from('bills').select('*').order('created_at', { ascending: false }).limit(500);
      const res = await Promise.race([
        fetchPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase bills fetch timeout')), 4000))
      ]);
      
      const onlineBills = res.data || [];
      
      const allBills = [...localBills];
      onlineBills.forEach(ob => {
        const exists = allBills.find(lb => lb.id === ob.id);
        if (!exists) allBills.push(ob);
      });
      allBills.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      
      window.CURRENT_BILLS = allBills;
      filterBills();
    } catch (err) {
      console.warn('Failed to load bills from Supabase:', err);
      if (!window.CURRENT_BILLS) {
        window.CURRENT_BILLS = localBills;
        filterBills();
      }
    }
  } else {
    if (!window.CURRENT_BILLS) {
      window.CURRENT_BILLS = localBills;
      filterBills();
    }
  }
}

export function renderBilling(bills, append = false) {
  const body = document.getElementById('billingBody');
  if (!body) return;
  const currency = window.storeSettings?.currency_symbol || '₹';
  
  const newHtml = bills.map((b, idx) => {
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
        <div style="font-size:0.8rem; font-weight:700; color:var(--text)">${escapeHTML(custName)}${b.customer_phone && b.customer_phone !== 'N/A' ? ` · <span style="color:var(--muted); font-weight:400">${escapeHTML(b.customer_phone)}</span>` : ''}</div>
        <div style="font-size:0.65rem; font-weight:700; color:var(--muted); background:rgba(255,255,255,0.03); padding:3px 8px; border-radius:6px; border:1px solid var(--border)">${typeIcon} ${(b.order_type || 'dine-in').replace('-',' ')}</div>
      </div>
      <div style="font-size:0.75rem; color:var(--muted); margin-bottom:6px">
        ${new Date(b.created_at).toLocaleString()}${b.table_number ? ` · Table ${escapeHTML(b.table_number)}` : ''}
      </div>
      ${b.discount_amount > 0 ? `<div style="font-size:0.7rem; color:#22c55e; font-weight:600; margin-bottom:4px">Discount: −${currency}${b.discount_amount}</div>` : ''}
      ${b.notes ? `<div style="font-size:0.7rem; color:var(--muted); font-style:italic; margin-bottom:4px">📝 ${escapeHTML(b.notes)}</div>` : ''}
      <div style="margin-top:6px; font-size:0.8rem; color:rgba(255,255,255,0.7)">
        ${getBillItems(b).map(i => `${escapeHTML(i.name)} (${escapeHTML(i.size)})`).join(', ')}
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
    `;
  }).join('');

  if (append) {
    body.insertAdjacentHTML('beforeend', newHtml);
  } else {
    body.innerHTML = newHtml || '<div class="empty-state">No bills found</div>';
  }
  
  if (window.lucide) window.lucide.createIcons();
}

export async function voidBill(billId) {
  if (!confirm('Are you sure you want to VOID this bill?')) return;
  const bill = window.CURRENT_BILLS.find(b => b.id === billId);
  if (!bill) return;
  
  try {
    const localRecord = await db.local_bills.get(bill.id);
    if (localRecord) {
      await db.local_bills.update(bill.id, { payment_status: 'voided' });
    } else {
      await db.local_bills.put({ 
        ...bill, 
        payment_status: 'voided', 
        sync_status: 'synced' 
      });
    }

    const { error } = await supabaseClient
      .from('bills')
      .update({ payment_status: 'voided' })
      .eq('id', bill.id);
      
    if (error) {
      console.error('Cloud void failed:', error);
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
    if (typeof window.updateDashboardStats === 'function') {
      window.updateDashboardStats();
    }
  } catch (err) {
    console.error('Void error:', err);
    showToast('Error voiding bill', true);
  }
}

export function toggleRevenueVisibility(e) {
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

export function showRevenueAnalytics() {
  document.getElementById('analyticsModal').style.display = 'flex';
  updateAnalyticsView();
}

export async function updateAnalyticsView() {
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
}

export function updateBillingStats(bills) {
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
  
  const countEl = document.getElementById('statBillsCount');
  if (countEl) countEl.innerText = count;
  
  const avgEl = document.getElementById('statAvgBill');
  if (avgEl) avgEl.innerText = `₹${avg}`;
  
  const voidedEl = document.getElementById('statVoidedCount');
  if (voidedEl) voidedEl.innerText = vCount;
}

export function filterBills() {
  if (!window.CURRENT_BILLS) return;
  
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
    const itemsStr = typeof b.items === 'string' ? b.items : JSON.stringify(b.items || []);
    const matchesSearch = !q || 
      (b.customer_phone && b.customer_phone.toLowerCase().includes(q)) || 
      (b.customer_name && b.customer_name.toLowerCase().includes(q)) ||
      (b.id && b.id.toLowerCase().includes(q)) ||
      (itemsStr && itemsStr.toLowerCase().includes(q));
      
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
  window.FILTERED_BILLS = filtered;
  billsDisplayedCount = 15;
  renderBilling(filtered.slice(0, 15));
}

export function exportBillsCSV() {
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
    const itemsStr = typeof b.items === 'string' ? b.items : JSON.stringify(b.items || []);
    const matchesSearch = !q || 
      (b.customer_phone && b.customer_phone.toLowerCase().includes(q)) || 
      (b.customer_name && b.customer_name.toLowerCase().includes(q)) ||
      (b.id && b.id.toLowerCase().includes(q)) ||
      (itemsStr && itemsStr.toLowerCase().includes(q));
      
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
    const items = getBillItems(b).map(i => `${i.name} (x${i.quantity || 1} ${i.size || ''})`).join(' | ');
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

export async function printDailyZReport() {
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
      const items = getBillItems(b);
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

// Setup scroll listener for Infinite Scroll on the Billing tab
window.addEventListener('scroll', () => {
  if (window.currentTab !== 'billing') return;
  
  const scrollHeight = document.documentElement.scrollHeight;
  const scrollTop = window.scrollY || document.documentElement.scrollTop;
  const clientHeight = window.innerHeight;
  
  if (scrollTop + clientHeight >= scrollHeight - 200) {
    const sourceList = window.FILTERED_BILLS || window.CURRENT_BILLS;
    if (!sourceList || billsDisplayedCount >= sourceList.length) return;
    
    const nextChunk = sourceList.slice(billsDisplayedCount, billsDisplayedCount + 15);
    if (nextChunk.length === 0) return;
    
    renderBilling(nextChunk, true); // Append mode
    billsDisplayedCount += 15;
  }
}, { passive: true });
