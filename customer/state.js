// Single source of truth for the storefront's mutable state.
// Modules import this object and read/write `state.<field>` so that the
// shared menu, cart, and map state stay consistent across the ES modules.
export const state = {
  // Catalog
  MENU: {},                       // { [category]: items[] }
  ALL_ITEMS_FLAT: [],             // flat list of all items
  CATEGORIES: [],                 // category metadata rows
  STORE_UPI: 'paytm.slux68h@pty', // default fallback
  STORE_MERCHANT_NAME: 'Grill & Chill',

  // Order / selection
  cart: [],
  pendingItem: null,
  pendingSize: null,
  pendingAddons: {},

  // Browsing
  searchMode: false,
  currentSort: 'relevance',
  vegOnly: false,

  // Location
  userLoc: null,
  map: null,
  marker: null,
};

// ═══════ LOCAL CACHE (instant offline load) ═══════
export function loadFromLocal() {
  try {
    const cachedMenu = localStorage.getItem('gc_menu_data');
    const cachedCats = localStorage.getItem('gc_categories');
    const cachedFlat = localStorage.getItem('gc_flat_items');

    if (cachedMenu) state.MENU = JSON.parse(cachedMenu);
    if (cachedCats) state.CATEGORIES = JSON.parse(cachedCats);
    if (cachedFlat) state.ALL_ITEMS_FLAT = JSON.parse(cachedFlat);
  } catch (e) { console.warn("Local load failed", e); }
}

export function saveToLocal() {
  try {
    localStorage.setItem('gc_menu_data', JSON.stringify(state.MENU));
    localStorage.setItem('gc_categories', JSON.stringify(state.CATEGORIES));
    localStorage.setItem('gc_flat_items', JSON.stringify(state.ALL_ITEMS_FLAT));
  } catch (e) { console.error("Local save failed", e); }
}
