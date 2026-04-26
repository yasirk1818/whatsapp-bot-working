// Build API base URL without credentials (handles user:pass@host URLs)
const API_BASE = (() => {
  const url = new URL(window.location.href);
  url.username = '';
  url.password = '';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.origin;
})();

// Poll state every 2 seconds
let pollInterval = null;

async function fetchState() {
  try {
    const res = await fetch(`${API_BASE}/api/state`);
    const data = await res.json();
    updateConnectionUI(data);
  } catch (err) {
    console.error('Error fetching state:', err);
  }
}

async function fetchSettings() {
  try {
    const res = await fetch(`${API_BASE}/api/settings`);
    const data = await res.json();
    applySettingsToUI(data);
  } catch (err) {
    console.error('Error fetching settings:', err);
  }
}

async function updateSetting(feature, values) {
  try {
    const body = {};
    body[feature] = values;
    await fetch(`${API_BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('Error updating setting:', err);
  }
}

function updateConnectionUI(data) {
  const statusEl = document.getElementById('connection-status');
  const statusText = document.getElementById('status-text');
  const qrSection = document.getElementById('qr-section');
  const connectedSection = document.getElementById('connected-section');
  const phoneNumber = document.getElementById('phone-number');
  const qrContainer = document.getElementById('qr-container');

  if (data.connected) {
    statusEl.className = 'status connected';
    statusText.textContent = 'Connected';
    qrSection.style.display = 'none';
    connectedSection.style.display = 'block';
    phoneNumber.textContent = data.phoneNumber || '-';
  } else {
    statusEl.className = 'status disconnected';
    statusText.textContent = 'Disconnected';
    connectedSection.style.display = 'none';
    qrSection.style.display = 'block';

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
    if (toggle) {
      toggle.checked = data[feature].enabled;
    }
  }

  // Auto Read delay values
  const minDelayEl = document.getElementById('autoRead-minDelay');
  const maxDelayEl = document.getElementById('autoRead-maxDelay');
  if (minDelayEl && data.autoRead) {
    minDelayEl.value = data.autoRead.minDelay;
  }
  if (maxDelayEl && data.autoRead) {
    maxDelayEl.value = data.autoRead.maxDelay;
  }

  // Auto Reply message
  const replyMsgEl = document.getElementById('autoReply-message');
  if (replyMsgEl && data.autoReply) {
    replyMsgEl.value = data.autoReply.message;
  }

  // Anti Delete admin number
  const adminNumEl = document.getElementById('antiDelete-adminNumber');
  if (adminNumEl && data.antiDelete) {
    adminNumEl.value = data.antiDelete.adminNumber || '';
  }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  fetchState();
  fetchSettings();

  pollInterval = setInterval(fetchState, 2000);

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
      updateSetting('autoRead', {
        minDelay: parseInt(minDelayEl.value, 10),
      });
    });
  }

  if (maxDelayEl) {
    maxDelayEl.addEventListener('change', () => {
      updateSetting('autoRead', {
        maxDelay: parseInt(maxDelayEl.value, 10),
      });
    });
  }

  // Auto Reply message
  const replyMsgEl = document.getElementById('autoReply-message');
  if (replyMsgEl) {
    replyMsgEl.addEventListener('change', () => {
      updateSetting('autoReply', { message: replyMsgEl.value });
    });
  }

  // Anti Delete admin number
  const adminNumEl = document.getElementById('antiDelete-adminNumber');
  if (adminNumEl) {
    adminNumEl.addEventListener('change', () => {
      updateSetting('antiDelete', { adminNumber: adminNumEl.value });
    });
  }
});
