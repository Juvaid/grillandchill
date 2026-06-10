import { db, supabaseClient, migrateOldBills, syncOrders, syncBills } from './db.js';
import { escapeHTML, getBillItems, generateUUID, padLine, showToast, openModal, closeModal, playNotificationSound } from './utils.js';
import { checkAuth, login, logout, currentUser } from './auth.js';
import { renderOrderSkeletons, subscribeToOrders, loadOrders, renderOrders, updateStats, updateStatus, selectPaymentMethodForOrder, billOrder } from './views/orders.js';
import { renderBillingSkeletons, loadBilling, renderBilling, voidBill, toggleRevenueVisibility, showRevenueAnalytics, updateAnalyticsView, updateBillingStats, filterBills, exportBillsCSV, printDailyZReport } from './views/billing.js';
import { renderPosItemSkeletons, showQuickBill, closeQuickBill, selectPosCategory, filterAndSearchPosItems, renderPosCategories, renderPosItems, addToBill, changeBasketQty, renderBasket, clearPosBasket, updatePosTotal, switchPosMobileTab, updateMobilePillVisibility, selectOrderType, setDiscountMode, saveBillWithPayment, saveBill, finalizeBill, writeInChunks, getBLEPrinter, disconnectBLEPrinter, handleReceipt, handleBluetoothPrint, handleShare, printDirectlyViaBluetooth, printBluetooth, shareReceipt, sendWhatsAppReceipt, logoToEscPos, generateEscPosBytes, generateReceipt, cachedPrinterChar, cachedPrinterDevice } from './views/pos.js';
import { getCategorySortIndex, renderProductSkeletons, renderCategorySkeletons, loadProducts, populateCategoryDropdown, handleCategoryChange, previewImage, renderProducts, setDietary, resetTagChips, setSelectedTags, handleTagSelect, renderActiveTag, removeActiveTag, addSizeRow, addAddonRow, getSizesFromBuilder, getAddonsFromBuilder, populateSizesBuilder, populateAddonsBuilder, showProductModal, editProduct, deleteProduct, toggleAvailable, filterProducts, renderCategories, loadCategories, openCategoriesModal, addCollection, editCollection, deleteCollection, previewCatImage } from './views/products.js';
import { loadSettings, saveAllSettings, switchSettingsTab, previewSettingsLogo, loadLocationStats } from './views/settings.js';

// --- BIND GLOBALS TO WINDOW FOR HTML INLINE HANDLERS COMPATIBILITY ---
window.escapeHTML = escapeHTML;
window.getBillItems = getBillItems;
window.generateUUID = generateUUID;
window.padLine = padLine;
window.showToast = showToast;
window.openModal = openModal;
window.closeModal = closeModal;
window.playNotificationSound = playNotificationSound;

window.db = db;
window.supabaseClient = supabaseClient;
window.migrateOldBills = migrateOldBills;
window.syncOrders = syncOrders;
window.syncBills = syncBills;

window.checkAuth = checkAuth;
window.logout = logout;
window.login = login;

window.loadOrders = loadOrders;
window.renderOrders = renderOrders;
window.updateStatus = updateStatus;
window.billOrder = billOrder;
window.selectPaymentMethodForOrder = selectPaymentMethodForOrder;

window.loadBilling = loadBilling;
window.renderBilling = renderBilling;
window.voidBill = voidBill;
window.toggleRevenueVisibility = toggleRevenueVisibility;
window.showRevenueAnalytics = showRevenueAnalytics;
window.updateAnalyticsView = updateAnalyticsView;
window.filterBills = filterBills;
window.exportBillsCSV = exportBillsCSV;
window.printDailyZReport = printDailyZReport;

window.showQuickBill = showQuickBill;
window.closeQuickBill = closeQuickBill;
window.selectPosCategory = selectPosCategory;
window.filterAndSearchPosItems = filterAndSearchPosItems;
window.renderPosCategories = renderPosCategories;
window.renderPosItems = renderPosItems;
window.addToBill = addToBill;
window.changeBasketQty = changeBasketQty;
window.clearPosBasket = clearPosBasket;
window.switchPosMobileTab = switchPosMobileTab;
window.updateMobilePillVisibility = updateMobilePillVisibility;
window.selectOrderType = selectOrderType;
window.setDiscountMode = setDiscountMode;
window.saveBillWithPayment = saveBillWithPayment;
window.saveBill = saveBill;
window.handleReceipt = handleReceipt;
window.handleBluetoothPrint = handleBluetoothPrint;
window.handleShare = handleShare;
window.printDirectlyViaBluetooth = printDirectlyViaBluetooth;
window.printBluetooth = printBluetooth;
window.shareReceipt = shareReceipt;
window.sendWhatsAppReceipt = sendWhatsAppReceipt;

window.loadProducts = loadProducts;
window.renderProducts = renderProducts;
window.populateCategoryDropdown = populateCategoryDropdown;
window.handleCategoryChange = handleCategoryChange;
window.previewImage = previewImage;
window.setDietary = setDietary;
window.resetTagChips = resetTagChips;
window.setSelectedTags = setSelectedTags;
window.handleTagSelect = handleTagSelect;
window.renderActiveTag = renderActiveTag;
window.removeActiveTag = removeActiveTag;
window.addSizeRow = addSizeRow;
window.addAddonRow = addAddonRow;
window.showProductModal = showProductModal;
window.editProduct = editProduct;
window.deleteProduct = deleteProduct;
window.toggleAvailable = toggleAvailable;
window.filterProducts = filterProducts;
window.renderCategories = renderCategories;
window.loadCategories = loadCategories;
window.openCategoriesModal = openCategoriesModal;
window.addCollection = addCollection;
window.editCollection = editCollection;
window.deleteCollection = deleteCollection;
window.previewCatImage = previewCatImage;

window.loadSettings = loadSettings;
window.saveAllSettings = saveAllSettings;
window.switchSettingsTab = switchSettingsTab;
window.previewSettingsLogo = previewSettingsLogo;
window.loadLocationStats = loadLocationStats;

// --- ORCHESTRATION & INITIALIZATION ---
let isDashboardInitialized = false;
let billsChannel = null;
window.isPublicPosMode = false;

function updateConnectionStatus() {
  const badge = document.getElementById('connectionStatusBadge');
  if (!badge) return;

  if (navigator.onLine) {
    badge.innerHTML = '<span class="status-dot online"></span><span class="status-text">Online</span>';
    syncBills();
    syncOrders();
  } else {
    badge.innerHTML = '<span class="status-dot offline"></span><span class="status-text">Offline</span>';
  }
}

async function showDashboard() {
  if (isDashboardInitialized) return;
  isDashboardInitialized = true;
  window.isPublicPosMode = false;

  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  
  window.addEventListener('online', updateConnectionStatus);
  window.addEventListener('offline', updateConnectionStatus);
  updateConnectionStatus();

  await migrateOldBills();
  await loadSettings();
  await loadOrders();

  subscribeToOrders();
  subscribeToBills();
  setupPushNotifications();
}
window.showDashboard = showDashboard;

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
    
    const currentUserVal = window.currentUser || currentUser;
    if (currentUserVal) {
      const subJson = JSON.parse(JSON.stringify(sub));
      await supabaseClient.from('admin_push_subscriptions').delete().eq('user_id', currentUserVal.id);
      const { error: insErr } = await supabaseClient
        .from('admin_push_subscriptions')
        .insert({
          user_id: currentUserVal.id,
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

async function updateDashboardStats() {
  const actEl = document.getElementById('activeOrders');
  if (!actEl) return;
  
  const { data: activeOrders } = await supabaseClient.from('orders').select('id').not('status', 'in', '("completed","cancelled")');
  actEl.innerText = activeOrders?.length || 0;

  const { count } = await supabaseClient.from('menu_items').select('*', { count: 'exact', head: true });
  const itemEl = document.getElementById('statTotalItems');
  if (itemEl) itemEl.innerText = count || 0;
}
window.updateDashboardStats = updateDashboardStats;

// --- TAB LOGIC ---
function switchTab(tabId) {
  window.currentTab = tabId;
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
window.switchTab = switchTab;

// --- SYSTEM INITIALIZERS ---
const loginBtn = document.getElementById('loginBtn');
if (loginBtn) loginBtn.onclick = login;

const publicPosBtn = document.getElementById('publicPosBtn');
if (publicPosBtn) {
  publicPosBtn.onclick = () => {
    window.isPublicPosMode = true;
    document.getElementById('authScreen').classList.add('hidden');
    loadSettings();
    showQuickBill();
  };
}

setInterval(syncBills, 30000);
setInterval(syncOrders, 30000);

supabaseClient.auth.onAuthStateChange((event, session) => {
  console.log('Auth state change:', event, session);
  if (event === 'SIGNED_IN') {
    checkAuth();
  } else if (event === 'SIGNED_OUT') {
    location.reload();
  }
});

// Boot the application
checkAuth();
