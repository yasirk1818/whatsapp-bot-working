const express = require('express');
const path = require('path');
const {
  initAllDevices,
  addDevice,
  removeDevice,
  getDeviceList,
  getDeviceInstance,
} = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── Device Management ───

// List all devices
app.get('/api/devices', (req, res) => {
  res.json(getDeviceList());
});

// Add new device
app.post('/api/devices', (req, res) => {
  const deviceId = addDevice();
  res.json({ success: true, deviceId });
});

// Delete device
app.delete('/api/devices/:id', async (req, res) => {
  try {
    await removeDevice(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Per-Device State & Settings ───

// Get device state (QR, connection)
app.get('/api/devices/:id/state', (req, res) => {
  const instance = getDeviceInstance(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Device not found' });
  res.json(instance.getState());
});

// Get device settings
app.get('/api/devices/:id/settings', (req, res) => {
  const instance = getDeviceInstance(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Device not found' });
  res.json(instance.getSettings());
});

// Update device settings
app.post('/api/devices/:id/settings', (req, res) => {
  const instance = getDeviceInstance(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Device not found' });
  const updated = instance.updateSettings(req.body);
  res.json({ success: true, settings: updated });
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  initAllDevices();
});
