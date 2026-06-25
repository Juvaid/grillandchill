// Delivery location: geolocation, the Leaflet map picker and address search.
// `L` (Leaflet) is loaded via a deferred CDN <script> and is only referenced
// here, after the user opens the map, so it is available by then.
import { state } from './state.js';

export async function getLocation() {
  const btn = document.getElementById('locBtn');
  const status = document.getElementById('locStatus');
  const mc = document.getElementById('mapContainer');
  btn.textContent = '⌛ FETCHING...';

  try {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      throw new Error('Insecure Origin');
    }
    const p = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 10000 }));
    const lat = p.coords.latitude, lng = p.coords.longitude;
    state.userLoc = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    status.innerHTML = '✅ <span style="color:#22c55e">GPS Fixed! Drag pin if needed:</span>';
    btn.textContent = '🔄 RESET';
    mc.style.display = 'block';

    if (!state.map) {
      state.map = L.map('map').setView([lat, lng], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
      }).addTo(state.map);
      state.marker = L.marker([lat, lng], { draggable: true }).addTo(state.map);
      state.marker.on('dragend', function () {
        const pos = state.marker.getLatLng();
        state.userLoc = `https://www.google.com/maps/search/?api=1&query=${pos.lat.toFixed(6)},${pos.lng.toFixed(6)}`;
      });
    } else {
      state.map.setView([lat, lng], 16);
      state.marker.setLatLng([lat, lng]);
    }
    // Fix leaflet grey tiles on first load
    setTimeout(() => state.map.invalidateSize(), 400);
  } catch (e) {
    const isInsecure = e.message === 'Insecure Origin';
    status.innerHTML = isInsecure
      ? '❌ <span style="color:#ef4444">GPS blocked (HTTP). Please drag the pin manually:</span>'
      : '❌ <span style="color:#ef4444">GPS failed. Please drag the pin manually below:</span>';
    mc.style.display = 'block';
    btn.textContent = isInsecure ? '📍 USE MANUAL PIN' : '📍 TRY GPS AGAIN';

    // Default to Sandhaur center if GPS fails
    const defLat = 30.5716, defLng = 75.7401;
    if (!state.map) {
      state.map = L.map('map').setView([defLat, defLng], 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(state.map);
      state.marker = L.marker([defLat, defLng], { draggable: true }).addTo(state.map);
      state.marker.on('dragend', function () {
        const pos = state.marker.getLatLng();
        state.userLoc = `https://www.google.com/maps/search/?api=1&query=${pos.lat.toFixed(6)},${pos.lng.toFixed(6)}`;
      });
    }
    setTimeout(() => state.map.invalidateSize(), 400);
  }
}

export async function searchAddress() {
  let q = document.getElementById('addrSearch').value.trim();
  if (!q) return;

  // Append local context for better rural accuracy
  if (!q.toLowerCase().includes('punjab')) q += ', Malerkotla, Punjab';

  const status = document.getElementById('locStatus');
  const btn = window.event.target;
  const oldText = btn.textContent;
  btn.textContent = '...';

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`);
    const data = await res.json();
    if (data.length > 0) {
      const { lat, lon, display_name } = data[0];
      const newLat = parseFloat(lat), newLng = parseFloat(lon);

      state.map.setView([newLat, newLng], 17);
      state.marker.setLatLng([newLat, newLng]);
      state.userLoc = `https://www.google.com/maps/search/?api=1&query=${newLat.toFixed(6)},${newLng.toFixed(6)}`;
      status.innerHTML = `✅ <span style="color:#22c55e">Found: ${display_name.split(',')[0]}</span>`;
    } else {
      status.innerHTML = '❌ <span style="color:#ef4444">Location not found. Try another search.</span>';
    }
  } catch (e) {}
  btn.textContent = oldText;
}
