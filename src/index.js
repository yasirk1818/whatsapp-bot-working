const express = require('express');
const path = require('path');
const { startBot, getState, updateSettings, getSettings } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Get current bot state (QR, connection status, settings)
app.get('/api/state', (req, res) => {
  res.json(getState());
});

// Get settings
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

// Update settings
app.post('/api/settings', (req, res) => {
  const updated = updateSettings(req.body);
  res.json({ success: true, settings: updated });
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  startBot();
});
