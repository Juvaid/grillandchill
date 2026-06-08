// --- UTILITIES FOR SECURITY AND GENERAL INTERACTION ---

export function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

export function getBillItems(bill) {
  if (!bill || !bill.items) return [];
  if (typeof bill.items === 'string') {
    try {
      return JSON.parse(bill.items);
    } catch (e) {
      console.warn("Failed to parse bill items:", e);
      return [];
    }
  }
  if (Array.isArray(bill.items)) {
    return bill.items;
  }
  return [];
}

export function generateUUID() {
  if (self.crypto && self.crypto.randomUUID) {
    try { return self.crypto.randomUUID(); } catch(e) {}
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export function padLine(left, right, width = 32) {
  const leftStr = String(left);
  const rightStr = String(right);
  const gap = width - leftStr.length - rightStr.length;
  if (gap <= 0) return leftStr + ' ' + rightStr;
  return leftStr + ' '.repeat(gap) + rightStr;
}

export function showToast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.innerText = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

export function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const playBeep = (delay, freq, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + delay);
      gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + delay + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + delay + duration);
      
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + duration);
    };
    playBeep(0, 587.33, 0.15); // D5
    playBeep(0.18, 880, 0.25); // A5
  } catch (e) {
    console.warn('Audio Context failed to play sound:', e);
  }
}

export function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.style.display = 'flex';
  }
}

export function closeModal(id) {
  if (id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'none';
  } else {
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  }
}
