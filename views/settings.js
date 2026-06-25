import { db, supabaseClient } from '../db.js';
import { showToast } from '../utils.js';

export const SETTINGS_MAP = {
  store_name: { el: 'set_store_name', default: 'Grill & Chill' },
  store_tagline: { el: 'set_store_tagline', default: 'Authentic Wood-Fired Pizzeria & Restaurant' },
  store_address: { el: 'set_store_address', default: 'Raikot Road, Sandhaur, Malerkotla', type: 'textarea' },
  store_phone: { el: 'set_store_phone', default: '79019 94174' },
  currency_symbol: { el: 'set_currency_symbol', default: '₹' },
  store_website: { el: 'set_store_website', default: 'https://grillandchillpizzeria.juvaid.in' },
  logo_url: { el: 'set_logo_url', default: 'https://grillandchillpizzeria.juvaid.in/assets/logo-receipt-bw.png' },
  brand_color: { el: 'set_brand_color', default: '#ff6b00', type: 'color' },
  upi_id: { el: 'set_upi_id', default: 'paytm.slux68h@pty' },
  merchant_name: { el: 'set_merchant_name', default: 'Grill & Chill' },
  default_payment: { el: 'set_default_payment', default: 'UPI' },
  enable_card: { el: 'set_enable_card', default: 'false', type: 'checkbox' },
  enable_delivery: { el: 'set_enable_delivery', default: 'true', type: 'checkbox' },
  delivery_fee: { el: 'set_delivery_fee', default: '0' },
  free_delivery_above: { el: 'set_free_delivery_above', default: '0' },
  min_order: { el: 'set_min_order', default: '0' },
  whatsapp_number: { el: 'set_whatsapp_number', default: '917901994174' },
  enable_tables: { el: 'set_enable_tables', default: 'false', type: 'checkbox' },
  refreshment_items: { el: 'set_refreshment_items', default: 'Cold Coffee, Chocolate Shake, Pepsi' },
  store_open: { el: 'set_store_open', default: 'true', type: 'checkbox' },
  open_time: { el: 'set_open_time', default: '10:00' },
  close_time: { el: 'set_close_time', default: '22:00' },
  days_open: { el: null, default: 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', type: 'days' },
  announcement: { el: 'set_announcement', default: '🛵 FREE HOME DELIVERY ON ALL ORDERS! CALL: 79019 94174 📞', type: 'textarea' },
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

window.storeSettings = {};

export async function loadSettings() {
  let cachedData = null;
  try {
    cachedData = await db.store_settings.toArray();
  } catch (e) {
    console.warn('Failed to load store settings from Dexie:', e);
  }

  const settings = {};
  if (cachedData && cachedData.length > 0) {
    cachedData.forEach(row => { settings[row.key] = row.value; });
    localStorage.setItem('gc_store_settings', JSON.stringify(settings));
  } else {
    try {
      const cached = localStorage.getItem('gc_store_settings');
      if (cached) {
        Object.assign(settings, JSON.parse(cached));
      }
    } catch (e) {}
  }

  if (!settings.upi_id) {
    settings.upi_id = localStorage.getItem('gc_store_upi_id') || SETTINGS_MAP.upi_id.default;
  }
  if (!settings.merchant_name) {
    settings.merchant_name = localStorage.getItem('gc_store_merchant_name') || SETTINGS_MAP.merchant_name.default;
  }

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

  if (window.storeSettings.logo_url) {
    previewSettingsLogo(window.storeSettings.logo_url);
  }

  localStorage.setItem('gc_store_upi_id', window.storeSettings.upi_id || '');
  localStorage.setItem('gc_store_merchant_name', window.storeSettings.merchant_name || '');

  loadLocationStats();

  if (navigator.onLine) {
    try {
      const fetchPromise = supabaseClient.from('store_settings').select('*');
      const res = await Promise.race([
        fetchPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase settings fetch timeout')), 4000))
      ]);
      
      const freshData = res.data;
      if (freshData && freshData.length > 0) {
        await db.store_settings.clear();
        await db.store_settings.bulkPut(freshData);

        const newSettings = {};
        freshData.forEach(row => { newSettings[row.key] = row.value; });
        localStorage.setItem('gc_store_settings', JSON.stringify(newSettings));
        
        for (const [key, config] of Object.entries(SETTINGS_MAP)) {
          const val = newSettings[key] || config.default;
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

        if (window.storeSettings.logo_url) {
          previewSettingsLogo(window.storeSettings.logo_url);
        }
        localStorage.setItem('gc_store_upi_id', window.storeSettings.upi_id || '');
        localStorage.setItem('gc_store_merchant_name', window.storeSettings.merchant_name || '');
      }
    } catch (err) {
      console.warn('Failed to refresh settings from Supabase:', err);
    }
  }
}

export async function saveAllSettings() {
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

  localStorage.setItem('gc_store_upi_id', window.storeSettings.upi_id || '');
  localStorage.setItem('gc_store_merchant_name', window.storeSettings.merchant_name || '');

  try {
    const { error } = await supabaseClient.from('store_settings').upsert(rows);
    if (error) throw error;

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

export function switchSettingsTab(tabId) {
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

export function previewSettingsLogo(url) {
  const img = document.getElementById('settingsLogoPreview');
  if (img) {
    if (url && url.startsWith('http')) {
      img.src = url;
      img.style.display = 'block';
    } else {
      img.style.display = 'none';
    }
  }
}

export async function loadLocationStats() {
  if (window.isPublicPosMode) return;
  const statsList = document.getElementById('locationStatsList');
  if (!statsList) return;
  
  statsList.innerHTML = '<div style="text-align:center; padding:20px; color:var(--muted); font-size:0.8rem;">Loading location stats...</div>';
  
  try {
    const { data, error } = await supabaseClient
      .from('orders')
      .select('id, customer_name, customer_phone, delivery_lat, delivery_lng, delivery_address, total_amount, created_at, order_items(item_name, size, quantity)')
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) throw error;
    
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
