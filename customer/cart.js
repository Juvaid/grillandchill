// Cart sheet: rendering, add/remove, the cart bar and refreshment upsells.
import { state } from './state.js';
import { openSheet } from './ui.js';

export function openCart() { renderCartSheet(); openSheet('cartSheet'); }

export function renderCartSheet() {
  const items = document.getElementById('cartItems');
  const empty = document.getElementById('cartEmpty');
  const footer = document.getElementById('cartFooter');
  if (!state.cart.length) {
    items.innerHTML = '';
    empty.style.display = 'block';
    footer.style.display = 'none';
    const section = document.getElementById('refreshmentSection');
    if (section) section.style.display = 'none';
    return;
  }
  empty.style.display = 'none'; footer.style.display = 'block';

  items.innerHTML = state.cart.map((it, i) => {
    // Render addons string for cart
    let adStr = '';
    if (it.chosenAddons) {
      const adArr = [];
      const skip = ['Classic Base', 'Burger Only', 'Without Ice Cream', 'Veg'];
      Object.values(it.chosenAddons).forEach(arr => arr.forEach(a => { if (!skip.includes(a)) adArr.push(a); }));
      if (adArr.length) adStr = `<div style="font-size:.65rem;color:#a855f7;margin-top:2px">+ ${adArr.join(', ')}</div>`;
    }
    return `
    <div class="cart-item-row">
      <div class="ci-emoji">${it.e}</div>
      <div style="flex:1">
        <div class="ci-name">${it.n}</div>
        <div class="ci-size">${it.chosenSize}</div>
        ${adStr}
      </div>
      <div class="ci-price">₹${it.price}</div>
      <button class="ci-rm" onclick="removeItem(${i})" aria-label="Remove item">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
      </button>
    </div>`;
  }).join('');
  document.getElementById('cartSubtotal').textContent = '₹' + state.cart.reduce((s, i) => s + i.price, 0);
  renderRefreshmentRecommendations();
}

export function renderRefreshmentRecommendations() {
  const container = document.getElementById('refreshmentsContainer');
  const section = document.getElementById('refreshmentSection');
  if (!container || !section) return;

  if (!state.cart.length || !window.REFRESHMENT_ITEMS_CONFIG) {
    section.style.display = 'none';
    return;
  }

  const configuredNames = window.REFRESHMENT_ITEMS_CONFIG.split(',').map(name => name.trim().toLowerCase());
  if (!configuredNames.length || (configuredNames.length === 1 && !configuredNames[0])) {
    section.style.display = 'none';
    return;
  }

  // Find matching items from ALL_ITEMS_FLAT that are NOT already in the cart
  const cartNames = state.cart.map(it => it.n.toLowerCase());
  const matchingItems = state.ALL_ITEMS_FLAT.filter(item => {
    return configuredNames.includes(item.n.toLowerCase()) && !cartNames.includes(item.n.toLowerCase());
  });

  if (!matchingItems.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  container.innerHTML = matchingItems.map(item => {
    const defaultSize = Object.keys(item.sz)[0] || 'Regular';
    const price = item.sz[defaultSize] || 0;

    return `
      <div style="flex: 0 0 auto; width: 110px; background: var(--s3); border: 1.5px solid var(--b); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; justify-content: space-between; align-items: center; text-align: center; gap: 4px; box-shadow: 0 4px 10px rgba(0,0,0,0.15)">
        <div style="font-size: 1.4rem; height: 30px; display: flex; align-items: center; justify-content: center;">${item.e || '🥤'}</div>
        <div style="font-size: 0.72rem; font-weight: 800; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%;">${item.n}</div>
        <div style="font-size: 0.7rem; font-weight: 700; color: var(--accent);">₹${price}</div>
        <button onclick="addRefreshmentToCart(${item.id})" style="width: 100%; background: var(--accent); border: none; border-radius: 6px; color: white; padding: 4px; font-size: 0.65rem; font-weight: 800; cursor: pointer; transition: 0.2s;">+ ADD</button>
      </div>
    `;
  }).join('');
}

export function addRefreshmentToCart(itemId) {
  const item = state.ALL_ITEMS_FLAT.find(it => it.id === itemId);
  if (!item) return;
  const defaultSize = Object.keys(item.sz)[0] || 'Regular';
  const price = item.sz[defaultSize] || 0;

  const cartItem = {
    id: item.id,
    n: item.n,
    e: item.e,
    cat: item.cat,
    price: price,
    chosenSize: defaultSize,
    chosenAddons: {},
    qty: 1
  };

  state.cart.push(cartItem);
  updateCartBar();
  renderCartSheet();
  if (navigator.vibrate) navigator.vibrate(15);
}

export function removeItem(i) { state.cart.splice(i, 1); updateCartBar(); renderCartSheet(); }

export function updateCartBar() {
  const n = state.cart.length, t = state.cart.reduce((s, i) => s + i.price, 0);
  document.getElementById('cbBadge').textContent = n + ' item' + (n !== 1 ? 's' : '');
  document.getElementById('cbTotal').textContent = '₹' + t;
  document.getElementById('cartBar').classList.toggle('on', n > 0);
}
