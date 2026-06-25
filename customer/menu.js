// Catalog: category grid, category/search/sort rendering, item cards and
// the size/add-on selection sheet that pushes items into the cart.
import { state, saveToLocal } from './state.js';
import { supabaseClient } from '../shared/supabase.js';
import { openSheet, closeAll } from './ui.js';
import { updateCartBar } from './cart.js';

export function renderCategoryGrid() {
  const grid = document.getElementById('categoryGrid');
  const area = document.getElementById('menuArea');
  const controls = document.querySelector('.top-controls');
  const catNav = document.querySelector('.cat-nav');
  const hero = document.querySelector('.hero');

  grid.innerHTML = '';
  grid.style.display = 'grid';
  area.style.display = 'none';
  controls.style.display = 'flex';
  catNav.style.display = 'none';
  hero.style.display = 'flex'; // Restore hero on main menu
  window.scrollTo(0, 0);

  const cats = Object.keys(state.MENU);

  cats.forEach((cat, i) => {
    const processed = processItems(state.MENU[cat]);
    if (processed.length === 0 && state.vegOnly) return;

    const card = document.createElement('div');
    card.className = 'category-card';
    card.style.animationDelay = `${0.05 + i * 0.03}s`;

    const catData = state.CATEGORIES.find(c => c.name === cat);
    const cardSize = catData?.layout_size || 'normal';
    if (cardSize === 'large') card.classList.add('large');
    else if (cardSize === 'wide') card.classList.add('wide');
    const img = catData?.image_url || 'assets/woody_bg.webp';
    const cleanName = cat.replace(/[\u{1F300}-\u{1F9FF}]/gu, '').trim();
    const count = processed.length;

    card.innerHTML = `
      <img src="${img}" alt="${cat}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='assets/woody_bg.webp'">
      <div class="category-card-count" style="background: ${catData?.color || 'var(--primary)'}; color: white;">${count} ITEMS</div>
      <div class="category-card-content">
        <div class="category-card-name">${cleanName}</div>
        ${catData?.description ? `<div class="category-card-desc" style="font-size:0.75rem; color:rgba(255,255,255,0.7); margin-top:4px; font-weight:500; text-shadow:0 1px 4px rgba(0,0,0,0.8);">${catData.description}</div>` : ''}
      </div>
    `;

    if (catData?.color) {
      card.onmouseenter = () => { card.style.borderColor = catData.color; };
      card.onmouseleave = () => { card.style.borderColor = 'rgba(255,255,255,0.05)'; };
    }

    card.onclick = () => {
      const btns = document.querySelectorAll('.cat-btn');
      let targetBtn = null;
      btns.forEach(b => { if (b.textContent.trim() === cat) targetBtn = b; });
      if (targetBtn) switchCat(cat, targetBtn);
    };

    grid.appendChild(card);
  });

  if (grid.innerHTML === '') {
    grid.innerHTML = '<div class="empty" style="grid-column: span 2"><div class="ei">🥗</div><p>No items match your filters</p></div>';
  }
}

export async function fetchMenu() {
  const area = document.getElementById('menuArea');
  if (Object.keys(state.MENU).length === 0) {
    area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted);"><div class="loading-spinner"></div><p style="margin-top:15px">Loading fresh flavors...</p></div>';
  }

  try {
    const { data, error } = await supabaseClient
      .from('menu_items')
      .select('*')
      .eq('available', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (error) throw error;

    state.ALL_ITEMS_FLAT = data.map(item => ({
      id: item.id, n: item.name, d: item.description, e: item.emoji,
      img: item.image_url, veg: item.is_veg, tags: item.tags,
      sz: item.sizes, addons: item.addons, cat: item.category
    }));

    state.MENU = {};
    state.ALL_ITEMS_FLAT.forEach(it => {
      if (!state.MENU[it.cat]) state.MENU[it.cat] = [];
      state.MENU[it.cat].push(it);
    });

    const { data: catData } = await supabaseClient
      .from('categories')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (catData) {
      state.CATEGORIES = catData;
      const sortedMenu = {};
      state.CATEGORIES.forEach(c => { if (state.MENU[c.name]) sortedMenu[c.name] = state.MENU[c.name]; });
      Object.keys(state.MENU).forEach(k => { if (!sortedMenu[k]) sortedMenu[k] = state.MENU[k]; });
      state.MENU = sortedMenu;
    }

    saveToLocal(); // Save fresh cloud data to local phone storage
    buildCats();
  } catch (err) {
    console.warn("Fetch failed, using local data if available", err);
  }
}

export function buildCats() {
  const bar = document.getElementById('catScroll');
  bar.innerHTML = '';

  // All button
  const all = document.createElement('button');
  all.className = 'cat-btn active';
  all.textContent = 'All';
  all.onclick = () => {
    if (state.searchMode) clearSearch();
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    all.classList.add('active');
    renderCategoryGrid();
    all.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  };
  bar.appendChild(all);

  Object.keys(state.MENU).forEach((cat) => {
    const b = document.createElement('button');
    b.className = 'cat-btn';
    b.textContent = cat;
    b.onclick = () => switchCat(cat, b);
    bar.appendChild(b);
  });
}

export function switchCat(cat, btn) {
  if (state.searchMode) clearSearch();
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  // UI visibility transitions
  document.getElementById('categoryGrid').style.display = 'none';
  document.getElementById('menuArea').style.display = 'block';
  document.querySelector('.top-controls').style.display = 'flex';
  document.querySelector('.cat-nav').style.display = 'block';
  document.querySelector('.hero').style.display = 'none'; // Hide hero for focus

  renderCat(cat);
  btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  window.scrollTo(0, 0);
}

export function gotoCategory(catName) {
  const btns = document.querySelectorAll('.cat-btn');
  let targetBtn = null;
  btns.forEach(b => {
    if (b.textContent.trim() === catName) targetBtn = b;
  });
  if (targetBtn) {
    switchCat(catName, targetBtn);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

export function renderAll() {
  const area = document.getElementById('menuArea');
  area.innerHTML = '';

  if (state.currentSort !== 'relevance') {
    let allItems = [];
    Object.entries(state.MENU).forEach(([cat, items]) => {
      items.forEach(it => allItems.push({ ...it, cat }));
    });
    let processed = processItems(allItems);
    if (processed.length > 0) {
      area.innerHTML = `<div class="section-head"><h2>Sorted Results</h2><span>${processed.length} items</span></div><div class="item-grid">${processed.map((it, idx) => gridCard(it, it.cat, idx)).join('')}</div>`;
    }
  } else {
    Object.entries(state.MENU).forEach(([cat, items]) => {
      let processed = processItems(items);
      if (processed.length > 0) {
        area.innerHTML += `<div class="section-head"><h2>${cat}</h2><span>${processed.length} items</span></div>`;
        area.innerHTML += `<div class="item-grid">${processed.map((it, idx) => gridCard(it, cat, idx)).join('')}</div><div class="divider" style="margin:16px 0"></div>`;
      }
    });
  }

  if (area.innerHTML === '') {
    area.innerHTML = '<div class="empty"><div class="ei">🥗</div><p>No items match your filters</p></div>';
  }
}

export function renderCat(cat) {
  const items = state.MENU[cat];
  const processed = processItems(items);
  const area = document.getElementById('menuArea');
  if (processed.length === 0) {
    area.innerHTML = `<div class="section-head"><h2>${cat}</h2><span>0 items</span></div>` + '<div class="empty"><div class="ei">🥗</div><p>No items match your filters in this category</p></div>';
  } else {
    area.innerHTML = `<div class="section-head"><h2>${cat}</h2><span>${processed.length} items</span></div><div class="item-grid">${processed.map((it, idx) => gridCard(it, cat, idx)).join('')}</div>`;
  }
}

export function processItems(items) {
  let list = [...items];

  // Veg Filter
  if (state.vegOnly) {
    list = list.filter(it => it.veg);
  }

  // Sort
  if (state.currentSort === 'price-low') {
    list.sort((a, b) => Math.min(...Object.values(a.sz)) - Math.min(...Object.values(b.sz)));
  } else if (state.currentSort === 'price-high') {
    list.sort((a, b) => Math.min(...Object.values(b.sz)) - Math.min(...Object.values(a.sz)));
  } else if (state.currentSort === 'pop') {
    const score = (it) => {
      if (it.tags.includes('best')) return 3;
      if (it.tags.includes('pop')) return 2;
      if (it.tags.includes('new')) return 1;
      return 0;
    };
    list.sort((a, b) => score(b) - score(a));
  } else if (state.currentSort === 'alpha') {
    list.sort((a, b) => a.n.localeCompare(b.n));
  } else if (state.currentSort === 'rating') {
    list = list.filter(it => it.tags.includes('best') || it.tags.includes('pop'));
    const score = (it) => it.tags.includes('best') ? 1 : 0;
    list.sort((a, b) => score(b) - score(a));
  }

  return list;
}

export function handleSortChange() {
  const sel = document.getElementById('sortSelect');
  state.currentSort = sel.value;
  document.getElementById('activeSortLabel').textContent = 'Sort: ' + sel.options[sel.selectedIndex].text;

  if (state.searchMode) handleSearch();
  else {
    const activeBtn = document.querySelector('.cat-btn.active');
    if (activeBtn && activeBtn.textContent !== 'All') {
      const activeCat = activeBtn.textContent;
      renderCat(activeCat);
    } else {
      renderAll();
    }
  }
}

export function toggleVegOnly() {
  state.vegOnly = !state.vegOnly;
  document.getElementById('vegToggle').classList.toggle('active', state.vegOnly);
  if (state.searchMode) handleSearch();
  else {
    const activeBtn = document.querySelector('.cat-btn.active');
    if (activeBtn && activeBtn.textContent === 'All') {
      renderCategoryGrid();
    } else if (activeBtn) {
      renderCat(activeBtn.textContent);
    } else {
      renderCategoryGrid();
    }
  }
}

export function gridCard(it, cat, idx = 0) {
  const tags = it.tags.map(t => {
    const map = { pop: 't-pop ⭐ Popular', hot: 't-hot 🌶 Spicy', new: 't-new ✨ New', best: 't-best 🔥 Best' };
    const [cls, ...rest] = map[t]?.split(' ') || [];
    return cls ? `<span class="tag ${cls}">${rest.join(' ')}</span>` : '';
  }).join('');
  const dot = it.veg ? '<div class="veg-dot"></div>' : '<div class="nveg-dot"></div>';
  const minP = Math.min(...Object.values(it.sz));

  // High-performance image rendering with fallback
  const media = it.img
    ? `<img class="item-card-img" src="${it.img}" loading="lazy" alt="${it.n}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">` + `<div class="item-card-emoji" style="display:none">${it.e}</div>`
    : `<div class="item-card-emoji">${it.e}</div>`;

  return `
  <div class="item-card" style="animation-delay: ${0.04 + idx * 0.06}s">
    ${dot}
    ${media}
    <div class="item-card-body">
      <div class="item-card-name">${it.n}</div>
      <div class="item-card-desc">${it.d}</div>
      ${tags ? `<div class="tag-row" style="margin-top:4px">${tags}</div>` : ''}
      <div class="item-card-footer">
        <div class="item-price">₹${minP}<br><span class="item-price-sub">onwards</span></div>
        <button class="add-btn" onclick="openSize(${it.id},'${encodeURIComponent(cat)}')">ADD +</button>
      </div>
    </div>
  </div>`;
}

// ═══════ SEARCH ═══════
export function handleSearch() {
  const q = document.getElementById('searchInput').value.toLowerCase().trim();
  if (!q) { clearSearch(); return; }
  state.searchMode = true;
  const area = document.getElementById('menuArea');
  const results = [];
  Object.entries(state.MENU).forEach(([cat, items]) => {
    items.forEach(it => { if (it.n.toLowerCase().includes(q) || it.d.toLowerCase().includes(q)) results.push({ ...it, cat }); });
  });

  const processed = processItems(results);

  if (!processed.length) { area.innerHTML = '<div class="empty"><div class="ei">🔍</div><p>No items found for "' + q + '"' + (state.vegOnly ? ' (Veg Only)' : '') + '</p></div>'; return; }
  area.innerHTML = `<div class="section-head"><h2>Search Results</h2><span>${processed.length} found</span></div><div class="item-grid">${processed.map((it, idx) => gridCard(it, it.cat, idx)).join('')}</div>`;
}

export function clearSearch() {
  state.searchMode = false;
  document.getElementById('searchInput').value = '';
  renderCategoryGrid();
}

// ═══════ SIZE SHEET & ADDONS ═══════
export function openSize(id, catEnc) {
  const item = state.ALL_ITEMS_FLAT.find(i => String(i.id) === String(id));
  state.pendingItem = item;
  const sizes = Object.keys(item.sz);
  state.pendingSize = sizes[0];
  state.pendingAddons = {};

  if (item.addons) {
    item.addons.forEach(group => {
      state.pendingAddons[group.title] = group.type === 'single' ? [group.opts[0].n] : [];
    });
  }

  // Consistent image rendering for the selection sheet
  const media = item.img
    ? `<img src="${item.img}" alt="${item.n}" onerror="this.style.display='none'; this.nextElementSibling.style.display='block'">` + `<span style="display:none">${item.e}</span>`
    : item.e;

  document.getElementById('sheetPreview').innerHTML = `
    <div class="sheet-preview-img">${media}</div>
    <div><div style="font-size:1rem;font-weight:700">${item.n}</div>
    <div style="font-size:.75rem;color:#777;margin-top:3px">${item.d}</div></div>`;

  renderSheetContent();
  openSheet('sizeSheet');
}

export function renderSheetContent() {
  const item = state.pendingItem;

  // Sizes
  const sizeHtml = Object.keys(item.sz).map((s) => {
    const isSel = s === state.pendingSize;
    return `
    <div class="sz-opt${isSel ? ' sel' : ''}" onclick="selSize('${s}')">
      <div style="display:flex;align-items:center">
        <div class="sz-radio"><div class="sz-dot"></div></div>
        <div class="sz-name">${s}</div>
      </div>
      <div class="sz-price">₹${item.sz[s]}</div>
    </div>`;
  }).join('');

  // Addons
  let addonHtml = '';
  let addonTotal = 0;
  if (item.addons) {
    addonHtml = item.addons.map((group) => {
      const isMulti = group.type === 'multi';
      const optsHtml = group.opts.map((opt) => {
        const p = typeof opt.p === 'object' ? (opt.p[state.pendingSize] || 0) : opt.p;
        const isSel = state.pendingAddons[group.title].includes(opt.n);
        if (isSel) addonTotal += p;
        const icon = isMulti ? 'sz-checkbox' : 'sz-radio';
        return `
        <div class="sz-opt${isSel ? ' sel' : ''}" onclick="toggleAddon('${group.title}','${opt.n}','${group.type}')">
          <div style="display:flex;align-items:center">
            <div class="${icon}"><div class="sz-dot"></div></div>
            <div class="sz-name">${opt.n}</div>
          </div>
          <div class="sz-price">${p > 0 ? '+₹' + p : (p < 0 ? '-₹' + Math.abs(p) : 'Inc.')}</div>
        </div>`;
      }).join('');
      return `<div class="sheet-lbl" style="margin-top:16px">${group.title} ${isMulti ? '(Optional)' : '(Choose 1)'}</div>${optsHtml}`;
    }).join('');
  }

  const finalPrice = item.sz[state.pendingSize] + addonTotal;

  // Assign content
  document.getElementById('sizeOpts').innerHTML = `<div class="sheet-lbl">Choose Size / Portion</div>` + sizeHtml + addonHtml;

  // Update button dynamically
  const btn = document.querySelector('#sizeSheet .sheet-cta');
  btn.innerHTML = `ADD TO ORDER — ₹${finalPrice}`;
  btn.onclick = () => confirmAdd(finalPrice);
}

export function selSize(s) {
  state.pendingSize = s;
  renderSheetContent();
}

export function toggleAddon(groupTitle, optName, type) {
  const arr = state.pendingAddons[groupTitle];
  if (type === 'single') {
    state.pendingAddons[groupTitle] = [optName];
  } else {
    if (arr.includes(optName)) {
      state.pendingAddons[groupTitle] = arr.filter(x => x !== optName);
    } else {
      arr.push(optName);
    }
  }
  renderSheetContent();
}

export function confirmAdd(finalPrice) {
  state.cart.push({ ...state.pendingItem, chosenSize: state.pendingSize, price: finalPrice, chosenAddons: JSON.parse(JSON.stringify(state.pendingAddons)) });
  updateCartBar();
  closeAll();
  if (navigator.vibrate) navigator.vibrate(25);
}
