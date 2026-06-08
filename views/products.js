import { db, supabaseClient } from '../db.js';
import { closeModal, openModal } from '../utils.js';

export function getCategorySortIndex(catName) {
  if (!window.allCategories) return 9999;
  const idx = window.allCategories.findIndex(c => c.name === catName);
  return idx === -1 ? 9999 : idx;
}

export function renderProductSkeletons() {
  const body = document.getElementById('productsBody');
  if (!body) return;
  body.innerHTML = `
    <div class="category-header">
      <div class="skeleton-line heading skeleton-shimmer w-20" style="height:22px;"></div>
      <div class="skeleton-line skeleton-shimmer w-10"></div>
    </div>
    <div class="category-grid">
      ${Array(4).fill(0).map(() => `
        <div class="product-card">
          <div class="skeleton-circle skeleton-shimmer" style="width:70px; height:70px;"></div>
          <div class="product-card-content" style="flex:1;">
            <div class="skeleton-line heading skeleton-shimmer w-70" style="margin-bottom:8px;"></div>
            <div class="skeleton-line skeleton-shimmer w-40" style="margin-bottom:8px;"></div>
            <div class="skeleton-line skeleton-shimmer w-50"></div>
          </div>
          <div class="product-card-actions" style="min-width:140px;">
            <div style="display:flex; gap:6px; width:100%">
              <div class="skeleton-line skeleton-shimmer w-50" style="height:32px; border-radius:8px;"></div>
              <div class="skeleton-line skeleton-shimmer w-50" style="height:32px; border-radius:8px;"></div>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; width:100%; margin-top:12px">
              <div class="skeleton-line skeleton-shimmer w-40"></div>
              <div class="skeleton-line skeleton-shimmer w-30" style="height:20px; border-radius:10px;"></div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

export function renderCategorySkeletons() {
  const body = document.getElementById('collectionsBody');
  if (!body) return;
  body.innerHTML = Array(3).fill(0).map(() => `
    <div class="product-card" style="margin-bottom:15px; display:flex; align-items:center; gap:15px;">
      <div class="skeleton-circle skeleton-shimmer" style="width:60px; height:60px; border-radius:12px;"></div>
      <div style="flex:1;">
        <div class="skeleton-line heading skeleton-shimmer w-40" style="margin-bottom:8px;"></div>
        <div class="skeleton-line skeleton-shimmer w-30"></div>
      </div>
      <div style="display:flex; gap:6px;">
        <div class="skeleton-line skeleton-shimmer w-10" style="height:32px; width:45px; border-radius:8px;"></div>
        <div class="skeleton-line skeleton-shimmer w-10" style="height:32px; width:45px; border-radius:8px;"></div>
      </div>
    </div>
  `).join('');
}

export async function loadProducts() {
  renderProductSkeletons();

  if (!window.allCategories) {
    await loadCategories();
  }

  let localData = [];
  
  try {
    localData = await db.menu_items.toArray();
    if (localData && localData.length > 0) {
      localData.sort((a, b) => {
        const catIdxA = getCategorySortIndex(a.category);
        const catIdxB = getCategorySortIndex(b.category);
        if (catIdxA !== catIdxB) return catIdxA - catIdxB;
        if (a.sort_order !== b.sort_order) return (a.sort_order || 0) - (b.sort_order || 0);
        return a.name.localeCompare(b.name);
      });
      window.allProducts = localData;
      const statTotalItemsEl = document.getElementById('statTotalItems');
      if (statTotalItemsEl) statTotalItemsEl.innerText = localData.length;
      renderProducts(localData);
      populateCategoryDropdown();
    }
  } catch (e) {
    console.warn('Failed to load products from Dexie:', e);
  }

  const fetchPromise = (async () => {
    if (!navigator.onLine) return;
    try {
      const fetchQuery = supabaseClient.from('menu_items').select('*');
      const res = await Promise.race([
        fetchQuery,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase products fetch timeout')), 4000))
      ]);
      
      const freshData = res.data;
      if (freshData && freshData.length > 0) {
        freshData.sort((a, b) => {
          const catIdxA = getCategorySortIndex(a.category);
          const catIdxB = getCategorySortIndex(b.category);
          if (catIdxA !== catIdxB) return catIdxA - catIdxB;
          if (a.sort_order !== b.sort_order) return (a.sort_order || 0) - (b.sort_order || 0);
          return a.name.localeCompare(b.name);
        });
        window.allProducts = freshData;
        const statTotalItemsEl = document.getElementById('statTotalItems');
        if (statTotalItemsEl) statTotalItemsEl.innerText = freshData.length;
        renderProducts(freshData);
        populateCategoryDropdown();

        await db.menu_items.clear();
        await db.menu_items.bulkPut(freshData);
      }
    } catch (err) {
      console.warn('Failed to load products from Supabase:', err);
      if (!localData || localData.length === 0) {
        renderProducts([]);
      }
    }
  })();

  if (!navigator.onLine && (!localData || localData.length === 0)) {
    renderProducts([]);
  }

  if (!localData || localData.length === 0) {
    await fetchPromise;
  }
}

export function populateCategoryDropdown() {
  const select = document.getElementById('itemCat');
  const filterSelect = document.getElementById('categoryFilter');
  const cats = window.allCategories || [];
  const catNames = cats.length > 0
    ? cats.map(c => c.name)
    : [...new Set((window.allProducts || []).map(p => p.category))].sort();
  
  if (select) {
    select.innerHTML = catNames.map(c => `<option value="${c}">${c}</option>`).join('') + 
      `<option value="__new__">+ Create New Category...</option>`;
  }
  
  if (filterSelect) {
    const currentValue = filterSelect.value;
    filterSelect.innerHTML = `<option value="all">All Items</option>` + 
      catNames.map(c => `<option value="${c}">${c}</option>`).join('');
    if (catNames.includes(currentValue)) {
      filterSelect.value = currentValue;
    } else {
      filterSelect.value = 'all';
    }
  }
}

export function handleCategoryChange(val) {
  const newCatGroup = document.getElementById('newCatGroup');
  const itemCatNew = document.getElementById('itemCatNew');
  if (val === '__new__') {
    newCatGroup.classList.remove('hidden');
    itemCatNew.setAttribute('required', 'true');
  } else {
    newCatGroup.classList.add('hidden');
    itemCatNew.removeAttribute('required');
    itemCatNew.value = '';
  }
}

export function previewImage(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      document.getElementById('imagePreview').src = e.target.result;
      document.getElementById('imagePreview').classList.remove('hidden');
      document.getElementById('uploadPlaceholder').classList.add('hidden');
    }
    reader.readAsDataURL(input.files[0]);
  }
}

export function renderProducts(products) {
  const body = document.getElementById('productsBody');
  if (!body) return;
  if (!products || products.length === 0) {
    body.innerHTML = '<div style="padding: 30px; text-align: center; color: var(--muted); font-weight:700;">No items found.</div>';
    return;
  }

  const grouped = {};
  products.forEach(p => {
    const cat = p.category || 'Uncategorized';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(p);
  });

  let html = '';
  for (const [cat, items] of Object.entries(grouped)) {
    html += `
      <div class="category-header">
        <h3>${cat}</h3>
        <span class="item-count">${items.length} items</span>
      </div>
      <div class="category-grid">
        ${items.map(i => `
          <div class="product-card">
            ${i.image_url 
              ? `<img src="${i.image_url}" class="product-img" loading="lazy">`
              : `<div class="product-emoji">${i.emoji || '🍕'}</div>`
            }
            <div class="product-card-content">
              <div class="product-card-title">${i.name}</div>
              <div class="product-card-meta">Sort Order #${i.sort_order || 0}</div>
              <div class="product-card-prices">
                ${Object.entries(i.sizes || {}).map(([s, p]) => `<span class="price-pill"><b>${s[0]}</b> ₹${p}</span>`).join('')}
              </div>
            </div>
            <div class="product-card-actions">
              <div style="display:flex; gap:6px; width:100%">
                <button class="mini-btn" onclick="editProduct(${i.id})" style="flex:1; display:flex; align-items:center; justify-content:center; gap:4px; padding:8px 12px"><i data-lucide="edit-2" style="width:14px; height:14px"></i> EDIT</button>
                <button class="mini-btn" onclick="deleteProduct(${i.id}, '${i.name.replace(/'/g, "\\'")}')" style="flex:1; border-color:rgba(239,68,68,0.2); color:#ef4444; background:rgba(239,68,68,0.05); display:flex; align-items:center; justify-content:center; gap:4px; padding:8px 12px"><i data-lucide="trash-2" style="width:14px; height:14px"></i> DEL</button>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; width:100%; margin-top:12px">
                <span style="font-size:0.65rem; color:var(--muted); font-weight:800; letter-spacing:0.5px">${i.available ? 'AVAILABLE' : 'HIDDEN'}</span>
                <label class="toggle-switch" style="margin:0">
                  <input type="checkbox" ${i.available ? 'checked' : ''} onchange="toggleAvailable(${i.id}, this.checked)">
                  <span class="slider"></span>
                </label>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }
  body.innerHTML = html;
  if (window.lucide) window.lucide.createIcons();
}

export function setDietary(isVeg) {
  document.getElementById('itemIsVeg').value = isVeg ? 'true' : 'false';
  const btnVeg = document.getElementById('btnVeg');
  const btnNonVeg = document.getElementById('btnNonVeg');
  const container = btnVeg?.closest('.segmented-control');
  if (isVeg) {
    if (btnVeg) btnVeg.classList.add('active');
    if (btnNonVeg) btnNonVeg.classList.remove('active');
    if (container) container.classList.remove('nonveg-active');
  } else {
    if (btnVeg) btnVeg.classList.remove('active');
    if (btnNonVeg) btnNonVeg.classList.add('active');
    if (container) container.classList.add('nonveg-active');
  }
}

export function resetTagChips() {
  document.getElementById('itemTags').value = '[]';
  const activeList = document.getElementById('activeTagsList');
  if (activeList) activeList.innerHTML = '';
  const dropdown = document.getElementById('tagDropdown');
  if (dropdown) dropdown.value = '';
}

export function setSelectedTags(tagsArr) {
  resetTagChips();
  if (!tagsArr || !Array.isArray(tagsArr)) return;
  document.getElementById('itemTags').value = JSON.stringify(tagsArr);
  tagsArr.forEach(t => {
    renderActiveTag(t);
  });
}

export function handleTagSelect(tagVal) {
  if (!tagVal) return;
  let tags = JSON.parse(document.getElementById('itemTags').value || '[]');
  if (!tags.includes(tagVal)) {
    tags.push(tagVal);
    document.getElementById('itemTags').value = JSON.stringify(tags);
    renderActiveTag(tagVal);
  }
  document.getElementById('tagDropdown').value = '';
}

export function renderActiveTag(tagVal) {
  const list = document.getElementById('activeTagsList');
  if (!list) return;
  const emojis = {
    'Spicy': '🔥',
    'Best Seller': '⭐',
    'New': '🆕',
    'Popular': '🌟',
    'Special': '🎉'
  };
  const emoji = emojis[tagVal] || '';
  const tagClass = tagVal.toLowerCase().replace(' ', '-');
  
  const chip = document.createElement('div');
  chip.className = `tag-chip active ${tagClass}`;
  chip.style.margin = '0';
  chip.style.padding = '4px 10px';
  chip.style.fontSize = '0.68rem';
  chip.style.display = 'inline-flex';
  chip.style.alignItems = 'center';
  chip.style.gap = '4px';
  chip.style.borderRadius = '6px';
  chip.style.cursor = 'pointer';
  chip.innerHTML = `${emoji} ${tagVal} <i data-lucide="x" style="width:10px; height:10px; margin-left: 2px; opacity: 0.7;"></i>`;
  
  chip.onclick = () => {
    removeActiveTag(tagVal, chip);
  };
  list.appendChild(chip);
  if (window.lucide) window.lucide.createIcons();
}

export function removeActiveTag(tagVal, chipEl) {
  let tags = JSON.parse(document.getElementById('itemTags').value || '[]');
  tags = tags.filter(t => t !== tagVal);
  document.getElementById('itemTags').value = JSON.stringify(tags);
  chipEl.remove();
}

export function addSizeRow(name = '', price = '') {
  const container = document.getElementById('sizesBuilderContainer');
  if (!container) return;
  const rowId = `size-row-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  const rowDiv = document.createElement('div');
  rowDiv.id = rowId;
  rowDiv.className = 'builder-row';
  rowDiv.style.display = 'grid';
  rowDiv.style.gridTemplateColumns = '2fr 1fr 38px';
  rowDiv.style.gap = '10px';
  rowDiv.style.alignItems = 'center';
  rowDiv.style.marginTop = '8px';
  rowDiv.style.animation = 'scaleIn 0.2s ease-out';
  rowDiv.innerHTML = `
    <input type="text" class="auth-input size-name" value="${name}" placeholder="e.g. Regular" style="margin-bottom:0;" required>
    <div style="position:relative; display:flex; align-items:center;">
      <span class="price-symbol">₹</span>
      <input type="number" class="auth-input size-price" value="${price}" placeholder="199" min="0" style="margin-bottom:0; width:100%" required>
    </div>
    <button type="button" onclick="document.getElementById('${rowId}').remove()" class="trash-btn">
      <i data-lucide="trash-2" style="width:14px; height:14px;"></i>
    </button>
  `;
  container.appendChild(rowDiv);
  if (window.lucide) window.lucide.createIcons();
}

export function addAddonRow(name = '', price = '') {
  const container = document.getElementById('addonsBuilderContainer');
  if (!container) return;
  const rowId = `addon-row-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  const rowDiv = document.createElement('div');
  rowDiv.id = rowId;
  rowDiv.className = 'builder-row';
  rowDiv.style.display = 'grid';
  rowDiv.style.gridTemplateColumns = '2fr 1fr 38px';
  rowDiv.style.gap = '10px';
  rowDiv.style.alignItems = 'center';
  rowDiv.style.marginTop = '8px';
  rowDiv.style.animation = 'scaleIn 0.2s ease-out';
  rowDiv.innerHTML = `
    <input type="text" class="auth-input addon-name" value="${name}" placeholder="e.g. Extra Cheese" style="margin-bottom:0;" required>
    <div style="position:relative; display:flex; align-items:center;">
      <span class="price-symbol">₹</span>
      <input type="number" class="auth-input addon-price" value="${price}" placeholder="50" min="0" style="margin-bottom:0; width:100%" required>
    </div>
    <button type="button" onclick="document.getElementById('${rowId}').remove()" class="trash-btn">
      <i data-lucide="trash-2" style="width:14px; height:14px;"></i>
    </button>
  `;
  container.appendChild(rowDiv);
  if (window.lucide) window.lucide.createIcons();
}

export function getSizesFromBuilder() {
  const rows = document.querySelectorAll('#sizesBuilderContainer > div');
  const sizes = {};
  rows.forEach(row => {
    const nameInput = row.querySelector('.size-name');
    const priceInput = row.querySelector('.size-price');
    if (nameInput && priceInput) {
      const name = nameInput.value.trim();
      const price = Number(priceInput.value);
      if (name) {
        sizes[name] = price;
      }
    }
  });
  return sizes;
}

export function getAddonsFromBuilder() {
  const rows = document.querySelectorAll('#addonsBuilderContainer > div');
  const addons = [];
  rows.forEach(row => {
    const nameInput = row.querySelector('.addon-name');
    const priceInput = row.querySelector('.addon-price');
    if (nameInput && priceInput) {
      const name = nameInput.value.trim();
      const price = Number(priceInput.value);
      if (name) {
        addons.push({ name, price });
      }
    }
  });
  return addons;
}

export function populateSizesBuilder(sizesObj) {
  const container = document.getElementById('sizesBuilderContainer');
  if (!container) return;
  container.innerHTML = '';
  if (!sizesObj || typeof sizesObj !== 'object') return;
  Object.entries(sizesObj).forEach(([name, price]) => {
    addSizeRow(name, price);
  });
  if (container.children.length === 0) {
    addSizeRow('Regular', '');
  }
}

export function populateAddonsBuilder(addonsArr) {
  const container = document.getElementById('addonsBuilderContainer');
  if (!container) return;
  container.innerHTML = '';
  if (!addonsArr || !Array.isArray(addonsArr)) return;
  addonsArr.forEach(addon => {
    addAddonRow(addon.name, addon.price);
  });
}

export function showProductModal() {
  const form = document.getElementById('productForm');
  if (form) form.reset();
  document.getElementById('itemId').value = '';
  document.getElementById('modalTitle').innerText = 'Add New Item';
  document.getElementById('imagePreview').classList.add('hidden');
  document.getElementById('uploadPlaceholder').classList.remove('hidden');
  
  populateSizesBuilder({"Regular": 199});
  populateAddonsBuilder([]);
  setDietary(true);
  resetTagChips();
  
  const select = document.getElementById('itemCat');
  if (select && select.options.length > 0) {
    select.value = select.options[0].value;
    handleCategoryChange(select.value);
  } else {
    handleCategoryChange('');
  }

  document.getElementById('productModal').style.display = 'flex';
}

export function editProduct(id) {
  const item = window.allProducts.find(p => p.id === id);
  if (!item) return;
  document.getElementById('itemId').value = item.id;
  document.getElementById('itemName').value = item.name;
  document.getElementById('itemCat').value = item.category;
  handleCategoryChange(item.category);
  document.getElementById('itemEmoji').value = item.emoji;
  document.getElementById('itemDesc').value = item.description || '';
  
  populateSizesBuilder(item.sizes);
  populateAddonsBuilder(item.addons);
  setDietary(item.is_veg !== false);
  setSelectedTags(item.tags || []);
  
  document.getElementById('itemSortOrder').value = item.sort_order || 0;
  document.getElementById('itemAvailable').value = item.available ? 'true' : 'false';
  
  if (item.image_url) {
    document.getElementById('imagePreview').src = item.image_url;
    document.getElementById('imagePreview').classList.remove('hidden');
    document.getElementById('uploadPlaceholder').classList.add('hidden');
  } else {
    document.getElementById('imagePreview').classList.add('hidden');
    document.getElementById('uploadPlaceholder').classList.remove('hidden');
  }
  
  document.getElementById('modalTitle').innerText = 'Edit Item';
  document.getElementById('productModal').style.display = 'flex';
}

export async function deleteProduct(id, name) {
  const msg = `Are you sure you want to permanently delete "${name}"?\n\nTIP: If you just want to hide this item from your menu temporarily, click Cancel and toggle the "AVAILABLE" switch instead!`;
  if (!confirm(msg)) return;
  try {
    const { error } = await supabaseClient.from('menu_items').delete().eq('id', id);
    if (error) throw error;
    await loadProducts();
  } catch (err) {
    alert('Error deleting menu item: ' + err.message);
  }
}

export async function toggleAvailable(id, available) {
  try {
    const { error } = await supabaseClient.from('menu_items').update({ available }).eq('id', id);
    if (error) throw error;
    await loadProducts();
  } catch (err) {
    console.error('Failed to toggle availability:', err);
  }
}

export function filterProducts() {
  const query = document.getElementById('menuSearch').value.toLowerCase();
  const category = document.getElementById('categoryFilter').value;
  const filtered = window.allProducts.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(query) || p.category.toLowerCase().includes(query);
    const matchesCat = category === 'all' || p.category === category;
    return matchesSearch && matchesCat;
  });
  renderProducts(filtered);
}

export function renderCategories(cats) {
  const body = document.getElementById('collectionsBody');
  if (!body) return;
  if (cats.length === 0) {
    body.innerHTML = '<div style="padding:30px; text-align:center; color:var(--muted)">No categories found.</div>';
    return;
  }
  
  body.innerHTML = cats.map(c => `
    <div class="product-card" style="margin-bottom:15px; display:flex; align-items:center; gap:15px;">
      ${c.image_url 
        ? `<img src="${c.image_url}" style="width:60px; height:60px; border-radius:12px; object-fit:cover;">`
        : `<div style="width:60px; height:60px; border-radius:12px; background:var(--glass); display:flex; align-items:center; justify-content:center; font-size:1.5rem">${c.name.slice(0,2).toUpperCase()}</div>`
      }
      <div style="flex:1;">
        <h4 style="margin:0; font-weight:800; font-size:0.95rem">${c.name}</h4>
        <span style="font-size:0.75rem; color:var(--muted)">Sort Order #${c.sort_order}</span>
      </div>
      <div style="display:flex; gap:6px;">
        <button class="mini-btn" onclick="editCollection(${c.id})" style="border-color:var(--primary); color:var(--primary)">EDIT</button>
        <button class="mini-btn" onclick="deleteCollection(${c.id}, '${c.name.replace(/'/g, "\\'")}')" style="border-color:#ef4444; color:#ef4444">DELETE</button>
      </div>
    </div>
  `).join('');
}

export async function loadCategories() {
  renderCategorySkeletons();

  let localData = [];
  
  try {
    localData = await db.categories.toArray();
    if (localData && localData.length > 0) {
      localData.sort((a, b) => {
        if (a.sort_order !== b.sort_order) return (a.sort_order || 0) - (b.sort_order || 0);
        return a.name.localeCompare(b.name);
      });
      window.allCategories = localData;
      renderCategories(localData);
    }
  } catch (e) {
    console.warn('Failed to load categories from Dexie:', e);
  }

  const fetchPromise = (async () => {
    if (!navigator.onLine) return;
    try {
      const fetchQuery = supabaseClient.from('categories').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true });
      const res = await Promise.race([
        fetchQuery,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase categories fetch timeout')), 4000))
      ]);
      
      const freshData = res.data;
      if (freshData && freshData.length > 0) {
        window.allCategories = freshData;
        renderCategories(freshData);

        await db.categories.clear();
        await db.categories.bulkPut(freshData);
      }
    } catch (err) {
      console.warn('Failed to load categories from Supabase:', err);
      if (!localData || localData.length === 0) {
        renderCategories([]);
      }
    }
  })();

  if (!localData || localData.length === 0) {
    await fetchPromise;
  }
}

export function openCategoriesModal() {
  loadCategories();
  document.getElementById('categoriesModal').style.display = 'flex';
}

export function addCollection() {
  document.getElementById('collectionForm').reset();
  document.getElementById('catId').value = '';
  document.getElementById('catNameInput').value = '';
  document.getElementById('catDescInput').value = '';
  document.getElementById('catColorInput').value = '#ff6b00';
  
  const maxSort = (window.allCategories || []).reduce((max, c) => Math.max(max, c.sort_order || 0), 0);
  document.getElementById('catSortInput').value = maxSort + 10;
  document.getElementById('catSizeInput').value = 'normal';
  
  document.getElementById('catImagePreview').src = '';
  document.getElementById('catImagePreview').classList.add('hidden');
  document.getElementById('catUploadPlaceholder').classList.remove('hidden');
  
  document.getElementById('collectionModalTitle').innerText = 'Add Category';
  document.getElementById('collectionModal').style.display = 'flex';
}

export function editCollection(id) {
  const cat = window.allCategories.find(c => c.id === id);
  if (!cat) return;
  document.getElementById('catId').value = cat.id;
  document.getElementById('catNameInput').value = cat.name;
  document.getElementById('catDescInput').value = cat.description || '';
  document.getElementById('catColorInput').value = cat.color || '#ff6b00';
  document.getElementById('catSortInput').value = cat.sort_order;
  document.getElementById('catSizeInput').value = cat.layout_size || 'normal';
  if (cat.image_url) {
    document.getElementById('catImagePreview').src = cat.image_url;
    document.getElementById('catImagePreview').classList.remove('hidden');
    document.getElementById('catUploadPlaceholder').classList.add('hidden');
  } else {
    document.getElementById('catImagePreview').classList.add('hidden');
    document.getElementById('catUploadPlaceholder').classList.remove('hidden');
  }
  document.getElementById('collectionModalTitle').innerText = 'Edit Category';
  document.getElementById('collectionModal').style.display = 'flex';
}

export async function deleteCollection(id, name) {
  if (!confirm(`Are you sure you want to delete the category "${name}"?\nThis will not delete the menu items in it, but they will be categorized under an orphaned category.`)) return;
  try {
    const { error } = await supabaseClient.from('categories').delete().eq('id', id);
    if (error) throw error;
    await loadCategories();
    await loadProducts();
  } catch (err) {
    alert('Error deleting category: ' + err.message);
  }
}

export function previewCatImage(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = e => {
      document.getElementById('catImagePreview').src = e.target.result;
      document.getElementById('catImagePreview').classList.remove('hidden');
      document.getElementById('catUploadPlaceholder').classList.add('hidden');
    };
    reader.readAsDataURL(input.files[0]);
  }
}

// Bind product catalog form submission
const productForm = document.getElementById('productForm');
if (productForm) {
  productForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const id = document.getElementById('itemId').value;
      const file = document.getElementById('imageFile').files[0];
      
      let image_url = null;
      if (file) {
        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}.${fileExt}`;
        const filePath = `products/${fileName}`;
        const { error: uploadError } = await supabaseClient.storage.from('menu-images').upload(filePath, file);
        if (!uploadError) {
          const { data } = supabaseClient.storage.from('menu-images').getPublicUrl(filePath);
          image_url = data.publicUrl;
        }
      } else if (id) {
        const existing = window.allProducts.find(p => p.id == id);
        image_url = existing.image_url;
      }

      const sizes = getSizesFromBuilder();
      if (Object.keys(sizes).length === 0) {
        alert('Please add at least one Size & Price.');
        return;
      }
      const addons = getAddonsFromBuilder();
      const isVeg = document.getElementById('itemIsVeg').value === 'true';
      const tags = JSON.parse(document.getElementById('itemTags').value || '[]');

      let category = document.getElementById('itemCat').value;
      if (category === '__new__') {
        const newCatName = document.getElementById('itemCatNew').value.trim();
        if (!newCatName) {
          alert('Please enter a name for the new category.');
          return;
        }
        
        const existingCat = (window.allCategories || []).find(c => c.name.toLowerCase() === newCatName.toLowerCase());
        if (!existingCat) {
          const maxSort = (window.allCategories || []).reduce((max, c) => Math.max(max, c.sort_order || 0), 0);
          const { data: newCatData, error: catErr } = await supabaseClient
            .from('categories')
            .insert([{ name: newCatName, sort_order: maxSort + 10 }])
            .select().single();
          if (catErr) throw new Error("Failed to create category: " + catErr.message);
          category = newCatName;
          await loadCategories();
        } else {
          category = existingCat.name;
        }
      }

      let sortOrder = parseInt(document.getElementById('itemSortOrder').value);
      if (isNaN(sortOrder) || sortOrder === 0) {
        const catProducts = (window.allProducts || []).filter(p => p.category === category);
        const maxSort = catProducts.reduce((max, p) => Math.max(max, p.sort_order || 0), 0);
        sortOrder = maxSort + 10;
      }

      const available = document.getElementById('itemAvailable').value === 'true';

      const product = {
        name: document.getElementById('itemName').value.trim(),
        category: category,
        emoji: document.getElementById('itemEmoji').value.trim() || '🍽️',
        description: document.getElementById('itemDesc').value.trim(),
        is_veg: isVeg,
        tags: tags,
        sizes: sizes,
        addons: addons,
        image_url: image_url,
        sort_order: sortOrder,
        available: available
      };

      if (id) await supabaseClient.from('menu_items').update(product).eq('id', id);
      else await supabaseClient.from('menu_items').insert([product]);
      
      closeModal('productModal');
      await loadProducts();
    } catch (err) { alert('Error: ' + err.message); }
  };
}

// Bind categories form submission
const collectionForm = document.getElementById('collectionForm');
if (collectionForm) {
  collectionForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const id = document.getElementById('catId').value;
      const name = document.getElementById('catNameInput').value.trim();
      const description = document.getElementById('catDescInput').value.trim();
      const color = document.getElementById('catColorInput').value;
      const sortOrder = parseInt(document.getElementById('catSortInput').value) || 0;
      const layoutSize = document.getElementById('catSizeInput').value;
      const file = document.getElementById('catImageFile').files[0];
      
      let image_url = null;
      if (file) {
        const fileName = `${Date.now()}_cat.png`;
        const { error: uploadError } = await supabaseClient.storage.from('menu-images').upload(`categories/${fileName}`, file);
        if (!uploadError) {
          const { data } = supabaseClient.storage.from('menu-images').getPublicUrl(`categories/${fileName}`);
          image_url = data.publicUrl;
        }
      } else if (id) {
        const existingCat = window.allCategories.find(c => c.id == id);
        image_url = existingCat ? existingCat.image_url : null;
      }

      const catData = { name, description, color, sort_order: sortOrder, layout_size: layoutSize, image_url };

      if (id) {
        const { error } = await supabaseClient.from('categories').update(catData).eq('id', id);
        if (error) throw error;
      } else {
        const { error } = await supabaseClient.from('categories').insert([catData]);
        if (error) throw error;
      }
      
      closeModal('collectionModal');
      await loadCategories();
      await loadProducts();
    } catch (err) {
      alert('Error saving category: ' + err.message);
    }
  };
}
