// Build API base URL without credentials
const API_BASE = (() => {
  const url = new URL(window.location.href);
  url.username = '';
  url.password = '';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.origin;
})();

let currentDeviceId = null;
let pollInterval = null;

// ─── Device List ───

async function fetchDevices() {
  try {
    const res = await fetch(`${API_BASE}/api/devices`);
    const devices = await res.json();
    renderDeviceList(devices);
  } catch (err) {
    console.error('Error fetching devices:', err);
  }
}

function renderDeviceList(devices) {
  const container = document.getElementById('devices-container');
  if (!devices.length) {
    container.innerHTML = '<p class="empty-text">No devices yet. Click "+ Add Device" to get started.</p>';
    return;
  }

  container.innerHTML = devices.map(d => `
    <div class="card device-card" onclick="openDevice('${d.id}')">
      <div class="device-card-row">
        <div class="device-card-info">
          <div class="device-card-status ${d.connected ? 'online' : 'offline'}">
            <span class="dot"></span>
          </div>
          <div>
            <h3>${d.phoneNumber ? '+' + d.phoneNumber : 'New Device'}</h3>
            <p class="subtitle">${d.connected ? 'Connected' : 'Disconnected'}</p>
          </div>
        </div>
        <span class="arrow">→</span>
      </div>
    </div>
  `).join('');
}

async function addDevice() {
  try {
    const res = await fetch(`${API_BASE}/api/devices`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      openDevice(data.deviceId);
    }
  } catch (err) {
    console.error('Error adding device:', err);
  }
}

async function deleteCurrentDevice() {
  if (!currentDeviceId) return;
  if (!confirm('Are you sure you want to delete this device? This will disconnect and remove all data.')) return;
  try {
    await fetch(`${API_BASE}/api/devices/${currentDeviceId}`, { method: 'DELETE' });
    showDeviceList();
  } catch (err) {
    console.error('Error deleting device:', err);
  }
}

// ─── Device Detail ───

function openDevice(deviceId) {
  currentDeviceId = deviceId;
  document.getElementById('device-list-view').style.display = 'none';
  document.getElementById('device-detail-view').style.display = 'block';
  document.getElementById('back-btn').style.display = 'inline-block';

  fetchDeviceState();
  fetchDeviceSettings();

  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(fetchDeviceState, 2000);
}

function showDeviceList() {
  currentDeviceId = null;
  document.getElementById('device-list-view').style.display = 'block';
  document.getElementById('device-detail-view').style.display = 'none';
  document.getElementById('back-btn').style.display = 'none';

  if (pollInterval) clearInterval(pollInterval);
  fetchDevices();
  pollInterval = setInterval(fetchDevices, 3000);
}

async function fetchDeviceState() {
  if (!currentDeviceId) return;
  try {
    const res = await fetch(`${API_BASE}/api/devices/${currentDeviceId}/state`);
    if (res.status === 404) { showDeviceList(); return; }
    const data = await res.json();
    updateDeviceUI(data);
  } catch (err) {
    console.error('Error fetching device state:', err);
  }
}

async function fetchDeviceSettings() {
  if (!currentDeviceId) return;
  try {
    const res = await fetch(`${API_BASE}/api/devices/${currentDeviceId}/settings`);
    if (res.status === 404) return;
    const data = await res.json();
    applySettingsToUI(data);
  } catch (err) {
    console.error('Error fetching settings:', err);
  }
}

async function updateSetting(feature, values) {
  if (!currentDeviceId) return;
  try {
    const body = {};
    body[feature] = values;
    await fetch(`${API_BASE}/api/devices/${currentDeviceId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('Error updating setting:', err);
  }
}

function updateDeviceUI(data) {
  const statusEl = document.getElementById('device-status');
  const statusText = document.getElementById('device-status-text');
  const qrSection = document.getElementById('qr-section');
  const qrContainer = document.getElementById('qr-container');
  const deviceTitle = document.getElementById('device-title');
  const devicePhone = document.getElementById('device-phone');

  if (data.connected) {
    statusEl.className = 'status connected';
    statusText.textContent = 'Connected';
    qrSection.style.display = 'none';
    deviceTitle.textContent = '+' + (data.phoneNumber || 'Unknown');
    devicePhone.textContent = 'WhatsApp Connected';
  } else {
    statusEl.className = 'status disconnected';
    statusText.textContent = 'Disconnected';
    qrSection.style.display = 'block';
    deviceTitle.textContent = 'New Device';
    devicePhone.textContent = 'Scan QR to connect';

    if (data.qr) {
      qrContainer.innerHTML = `<img src="${data.qr}" alt="QR Code" />`;
    } else {
      qrContainer.innerHTML = `
        <div class="loader"></div>
        <p>Waiting for QR Code...</p>
      `;
    }
  }
}

function applySettingsToUI(data) {
  for (const feature of Object.keys(data)) {
    const toggle = document.getElementById(`${feature}-toggle`);
    if (toggle) toggle.checked = data[feature].enabled;
  }

  const minDelayEl = document.getElementById('autoRead-minDelay');
  const maxDelayEl = document.getElementById('autoRead-maxDelay');
  if (minDelayEl && data.autoRead) minDelayEl.value = data.autoRead.minDelay;
  if (maxDelayEl && data.autoRead) maxDelayEl.value = data.autoRead.maxDelay;

  const replyMsgEl = document.getElementById('autoReply-message');
  if (replyMsgEl && data.autoReply) replyMsgEl.value = data.autoReply.message;
}

// ─── Event Listeners ───

document.addEventListener('DOMContentLoaded', () => {
  // Start with device list
  fetchDevices();
  pollInterval = setInterval(fetchDevices, 3000);

  // Toggle switches
  document.querySelectorAll('.switch input[type="checkbox"]').forEach((toggle) => {
    toggle.addEventListener('change', (e) => {
      const feature = e.target.dataset.feature;
      updateSetting(feature, { enabled: e.target.checked });
    });
  });

  // Auto Read delay inputs
  const minDelayEl = document.getElementById('autoRead-minDelay');
  const maxDelayEl = document.getElementById('autoRead-maxDelay');

  if (minDelayEl) {
    minDelayEl.addEventListener('change', () => {
      updateSetting('autoRead', { minDelay: parseInt(minDelayEl.value, 10) });
    });
  }

  if (maxDelayEl) {
    maxDelayEl.addEventListener('change', () => {
      updateSetting('autoRead', { maxDelay: parseInt(maxDelayEl.value, 10) });
    });
  }

  // Auto Reply message
  const replyMsgEl = document.getElementById('autoReply-message');
  if (replyMsgEl) {
    replyMsgEl.addEventListener('change', () => {
      updateSetting('autoReply', { message: replyMsgEl.value });
    });
  }
});
