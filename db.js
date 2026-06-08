import { generateUUID } from './utils.js';

// --- Dexie Offline Database Init ---
export const db = new Dexie("grill_chill_db");
db.version(6).stores({
  local_bills: 'id, customer_name, customer_phone, total_amount, payment_status, created_at, sync_status, client_uuid',
  pending_orders: '++id, status',
  categories: 'id, name, sort_order',
  menu_items: 'id, name, price, category, available',
  store_settings: 'key',
  local_orders: 'id, status, created_at, sync_status'
});

// --- Supabase Client Init ---
export const supabaseClient = window.supabase.createClient(window.ENV.SUPABASE_URL, window.ENV.SUPABASE_ANON_KEY);

export async function migrateOldBills() {
  try {
    const oldBills = await db.table('bills').toArray();
    if (oldBills.length > 0) {
      console.log('Migrating old bills...', oldBills.length);
      for (let b of oldBills) {
        const newId = generateUUID();
        await db.local_bills.add({
          ...b,
          id: newId,
          client_uuid: newId,
          sync_status: 'pending'
        });
      }
      await db.table('bills').clear();
    }
  } catch (e) {
    // Table might not exist or already be empty
  }
}

export async function syncOrders() {
  if (window.isPublicPosMode) return;
  if (!navigator.onLine) return;
  try {
    const pending = await db.local_orders.where('sync_status').equals('pending').toArray();
    for (const ord of pending) {
      const { error } = await supabaseClient.from('orders').update({ status: ord.status }).eq('id', ord.id);
      if (!error) {
        await db.local_orders.update(ord.id, { sync_status: 'synced' });
      }
    }
  } catch (e) {
    console.warn('Failed to sync orders:', e);
  }
}

let isSyncing = false;
export async function syncBills() {
  if (window.isPublicPosMode) return;
  if (!navigator.onLine) return;
  if (isSyncing) return;
  isSyncing = true;

  try {
    const syncEl = document.getElementById('syncStatus');
    const pending = await db.local_bills.where('sync_status').equals('pending').toArray();
    
    if (pending.length === 0) {
      if (syncEl) syncEl.innerText = 'All Bills Synced ✅';
      return;
    }

    if (syncEl) syncEl.innerText = `Syncing ${pending.length} bills...`;

    for (const bill of pending) {
      try {
        const { error } = await supabaseClient.from('bills').upsert([{
          id: bill.id,
          customer_name: bill.customer_name,
          customer_phone: bill.customer_phone || null,
          total_amount: bill.total_amount,
          items: bill.items,
          payment_status: bill.payment_status,
          payment_method: bill.payment_method || 'Cash',
          order_type: bill.order_type || 'dine-in',
          notes: bill.notes || '',
          table_number: bill.table_number || '',
          discount_amount: bill.discount_amount || 0,
          created_at: bill.created_at
        }]);
        
        if (!error) {
          await db.local_bills.update(bill.id, { sync_status: 'synced' });
        } else {
          console.error('Supabase Sync Error:', error);
          if (syncEl) syncEl.innerText = `Sync Error: ${error.message}`;
        }
      } catch (err) {
        console.error('Sync failed for bill:', bill.id, err);
        if (syncEl) syncEl.innerText = 'Sync Connection Failed ❌';
      }
    }
  } finally {
    isSyncing = false;
    if (typeof window.loadBilling === 'function') {
      window.loadBilling();
    }
  }
}
