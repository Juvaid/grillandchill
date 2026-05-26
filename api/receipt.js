// ═══════════════════════════════════════════════════════════
//  Grill & Chill — Bluetooth Thermal Receipt API
//  Vercel Serverless Function: /api/receipt
//
//  Returns JSON in the format expected by Bluetooth Print app
//  (mate.bluetoothprint). Accepts bill data as a base64-encoded
//  JSON query parameter.
//
//  Usage: /api/receipt?bill=<base64_encoded_json>
// ═══════════════════════════════════════════════════════════

// Store constants
const STORE = {
  name: 'GRILL & CHILL',
  tagline: 'Pizzeria & Bakery',
  address1: 'Raikot Road, Sandhaur',
  address2: 'Adj. HDFC Bank, Malerkotla',
  phone: 'Ph: 79019 94174',
  website: 'grillandchillpizzeria.juvaid.in',
  logoUrl: 'https://grillandchillpizzeria.juvaid.in/assets/logo-receipt-bw.png',
  qrValue: 'https://grillandchillpizzeria.juvaid.in',
};

// ─── Helpers for building JSON entries ───
// Type 0 = Text, Type 1 = Image, Type 3 = QR Code
// Align: 0=left, 1=center, 2=right
// Format: 0=normal, 1=double height, 2=double h+w, 3=double width, 4=small

function textEntry(content, { bold = 0, align = 1, format = 0 } = {}) {
  return { type: 0, content: String(content), bold, align, format };
}

function imageEntry(path, align = 1) {
  return { type: 1, path, align };
}

function qrEntry(value, size = 40, align = 1) {
  return { type: 3, value: String(value), size: Number(size), align: Number(align) };
}

function emptyLine() {
  return textEntry(' ', { bold: 0, align: 0, format: 0 });
}

function separator(char = '━', length = 32) {
  return textEntry(char.repeat(length), { bold: 0, align: 1, format: 4 });
}

function dashSeparator(length = 32) {
  return textEntry('─'.repeat(length), { bold: 0, align: 1, format: 4 });
}

// ─── Pad a line to fit 32-char width (58mm) ───
function padLine(left, right, width = 32) {
  const leftStr = String(left);
  const rightStr = String(right);
  const gap = width - leftStr.length - rightStr.length;
  if (gap <= 0) return leftStr + ' ' + rightStr;
  return leftStr + ' '.repeat(gap) + rightStr;
}

// ─── Build the receipt JSON payload ───
function buildReceipt(bill, baseUrl) {
  const entries = [];
  const items = typeof bill.items === 'string' ? JSON.parse(bill.items) : (bill.items || []);
  const date = bill.created_at ? new Date(bill.created_at) : new Date();

  // ── Logo ──
  const logoUrl = baseUrl ? `${baseUrl}/assets/logo-receipt-bw.png` : STORE.logoUrl;
  entries.push(imageEntry(logoUrl, 1));
  entries.push(emptyLine());

  // ── Store Header ──
  entries.push(separator('━', 32));
  entries.push(textEntry(STORE.name, { bold: 1, align: 1, format: 2 }));
  entries.push(textEntry(STORE.tagline, { bold: 0, align: 1, format: 0 }));
  entries.push(textEntry(STORE.address1, { bold: 0, align: 1, format: 4 }));
  entries.push(textEntry(STORE.address2, { bold: 0, align: 1, format: 4 }));
  entries.push(textEntry(STORE.phone, { bold: 0, align: 1, format: 4 }));
  entries.push(separator('━', 32));

  // ── Bill Info ──
  const billId = bill.id ? `#${String(bill.id).slice(0, 8).toUpperCase()}` : '#N/A';
  const timeStr = date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dateStr = date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  entries.push(textEntry(padLine(`Bill ${billId}`, timeStr), { bold: 1, align: 0, format: 4 }));
  entries.push(textEntry(`Date: ${dateStr}`, { bold: 0, align: 0, format: 4 }));
  entries.push(dashSeparator(32));

  // ── Items ──
  // Group items by name+size for quantity counting
  const grouped = {};
  items.forEach(item => {
    const key = `${item.name}|${item.size || ''}`;
    if (!grouped[key]) {
      grouped[key] = { ...item, qty: 0, totalPrice: 0 };
    }
    grouped[key].qty += (item.quantity || 1);
    grouped[key].totalPrice += Number(item.price) * (item.quantity || 1);
  });

  Object.values(grouped).forEach(item => {
    const qty = item.qty;
    const nameWithSize = item.size ? `${item.name} (${item.size})` : item.name;
    const label = `${qty}x ${nameWithSize}`;
    const priceStr = `Rs.${item.totalPrice}`;

    // If the line is too long, split into two lines
    if (label.length + priceStr.length + 1 > 32) {
      entries.push(textEntry(label, { bold: 0, align: 0, format: 4 }));
      entries.push(textEntry(priceStr, { bold: 0, align: 2, format: 4 }));
    } else {
      entries.push(textEntry(padLine(label, priceStr), { bold: 0, align: 0, format: 4 }));
    }
  });

  entries.push(dashSeparator(32));

  // ── Total ──
  const totalStr = `Rs.${bill.total_amount || 0}`;
  entries.push(textEntry(padLine('TOTAL', totalStr), { bold: 1, align: 0, format: 1 }));
  entries.push(separator('━', 32));

  // ── Customer Info ──
  if (bill.customer_phone && bill.customer_phone !== 'N/A') {
    entries.push(textEntry(`Customer: ${bill.customer_phone}`, { bold: 0, align: 0, format: 4 }));
  }
  if (bill.customer_name && bill.customer_name !== 'Walk-in') {
    entries.push(textEntry(`Name: ${bill.customer_name}`, { bold: 0, align: 0, format: 4 }));
  }

  // ── Tax Note ──
  entries.push(emptyLine());
  entries.push(textEntry('All prices inclusive of taxes', { bold: 0, align: 1, format: 4 }));
  entries.push(dashSeparator(32));

  // ── Footer ──
  entries.push(emptyLine());
  entries.push(textEntry('Thank you! Visit again.', { bold: 1, align: 1, format: 0 }));
  entries.push(emptyLine());
  entries.push(textEntry('Order Online - Free Delivery', { bold: 1, align: 1, format: 0 }));

  // ── QR Code ──
  entries.push(qrEntry(STORE.qrValue, 40, 1));
  entries.push(textEntry(STORE.website, { bold: 0, align: 1, format: 4 }));
  entries.push(emptyLine());
  entries.push(emptyLine());
  entries.push(emptyLine());

  return entries;
}

// ─── Vercel Handler ───
export default function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { bill: billParam } = req.query;

    if (!billParam) {
      return res.status(400).json({ error: 'Missing bill parameter' });
    }

    // Decode base64 bill data
    let billData;
    try {
      const decoded = Buffer.from(billParam, 'base64').toString('utf-8');
      billData = JSON.parse(decoded);
    } catch (e) {
      // Try plain JSON as fallback
      try {
        billData = JSON.parse(decodeURIComponent(billParam));
      } catch (e2) {
        return res.status(400).json({ error: 'Invalid bill data' });
      }
    }

    const host = req.headers.host || 'grillandchillpizzeria.juvaid.in';
    const protocol = req.headers['x-forwarded-proto'] || (host.includes('localhost') || host.includes('127.0.0.1') || host.includes('192.168.') ? 'http' : 'https');
    const baseUrl = `${protocol}://${host}`;

    const receipt = buildReceipt(billData, baseUrl);

    // Bluetooth Print app expects an object with numeric keys
    const indexed = {};
    receipt.forEach((entry, i) => {
      Object.defineProperty(indexed, String(i), {
        value: entry,
        enumerable: true,
        writable: true,
        configurable: true
      });
    });

    return res.status(200).json(indexed);
  } catch (err) {
    console.error('Receipt generation error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

