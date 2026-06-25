// Storefront entry point. Boots the app, then exposes the functions that the
// HTML references through inline on* handlers onto `window` (the modules are
// otherwise scoped, so handlers must be published explicitly).
import { state, loadFromLocal } from './state.js';
import { supabaseClient } from '../shared/supabase.js';
import {
  initCta, setupSwipe, setupInstallPrompt, registerServiceWorker, setupRevealObserver,
  closeAll,
} from './ui.js';
import {
  renderCategoryGrid, fetchMenu, openSize, selSize, toggleAddon, confirmAdd,
  handleSearch, handleSortChange, toggleVegOnly, gotoCategory,
} from './menu.js';
import {
  openCart, removeItem, addRefreshmentToCart,
} from './cart.js';
import { getLocation, searchAddress } from './location.js';
import {
  sendOrder, confirmUpiAndSendWhatsApp, closeCustomerUpiModal, openHistory, syncPendingOrders,
} from './checkout.js';

// ═══════ INIT ═══════
async function init() {
  loadFromLocal();          // Instant load from phone memory
  renderCategoryGrid();

  // Fetch store settings from Supabase
  try {
    const { data } = await supabaseClient.from('store_settings').select('*');
    if (data) {
      const settings = {};
      data.forEach(r => { settings[r.key] = r.value; });

      // UPI & Merchant
      if (settings.upi_id) state.STORE_UPI = settings.upi_id;
      if (settings.merchant_name) state.STORE_MERCHANT_NAME = settings.merchant_name;

      // Store name & tagline
      if (settings.store_name) {
        const heroLogo = document.querySelector('.logo');
        if (heroLogo) heroLogo.textContent = settings.store_name.toUpperCase();
        document.title = `${settings.store_name} | Order Online`;
      }
      if (settings.store_tagline) {
        const tagline = document.querySelector('.tagline');
        if (tagline) tagline.textContent = settings.store_tagline;
      }

      // Brand color — apply as CSS variable
      if (settings.brand_color) {
        document.documentElement.style.setProperty('--accent', settings.brand_color);
      }

      // Open/Closed status
      if (settings.store_open === 'false') {
        const openBadge = document.querySelector('.open-badge');
        if (openBadge) {
          openBadge.innerHTML = '<span style="width:8px;height:8px;background:#ef4444;border-radius:50%;"></span> CLOSED';
          openBadge.style.borderColor = 'rgba(239,68,68,0.4)';
        }
      }

      // WhatsApp CTA link
      if (settings.whatsapp_number) {
        const mainCta = document.getElementById('mainCta');
        if (mainCta) mainCta.href = `https://wa.me/${settings.whatsapp_number}`;
      }

      // Announcement bar
      if (settings.announcement) {
        const ticker = document.querySelector('.announcement-ticker');
        if (ticker) ticker.textContent = settings.announcement;
      }

      window.STORE_DELIVERY_FEE = parseFloat(settings.delivery_fee) || 0;
      window.STORE_FREE_DELIVERY_ABOVE = parseFloat(settings.free_delivery_above) || 0;
      window.STORE_MIN_ORDER = parseFloat(settings.min_order) || 0;
      window.REFRESHMENT_ITEMS_CONFIG = settings.refreshment_items || 'Cold Coffee, Chocolate Shake, Pepsi';
    }
  } catch (e) { console.warn("Failed to fetch store settings", e); }

  // Background sync from cloud
  fetchMenu().then(() => {
    console.log("Cloud Sync Complete");
    renderCategoryGrid();
    syncPendingOrders(); // Try to push any offline orders
  });

  if (window.lucide) window.lucide.createIcons();
  initCta();
}

// Publish inline on* handlers used by the HTML (static markup + generated
// template strings) to the global scope.
Object.assign(window, {
  openCart, openSize, selSize, toggleAddon, confirmAdd, removeItem,
  addRefreshmentToCart, handleSearch, handleSortChange, toggleVegOnly,
  gotoCategory, getLocation, searchAddress, sendOrder,
  confirmUpiAndSendWhatsApp, closeCustomerUpiModal, openHistory, closeAll,
});

// Boot
init();
setupSwipe();
setupInstallPrompt();
registerServiceWorker();
setupRevealObserver();
