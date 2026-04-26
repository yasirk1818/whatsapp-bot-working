const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
  proto,
  USyncQuery,
  USyncUser,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');

const DATA_DIR = path.join(__dirname, '..');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const REACTIONS = ['👍', '❤️', '😂', '🔥', '👏', '🎉', '💯', '😍', '🙏', '✨'];

const DEFAULT_SETTINGS = {
  rejectCalls: { enabled: false },
  autoRead: { enabled: false, minDelay: 1000, maxDelay: 5000 },
  autoReact: { enabled: false, reactions: REACTIONS },
  autoReply: {
    enabled: false,
    message: 'Thank you for your message! I will get back to you soon.',
  },
  autoStatusView: { enabled: false },
  antiDelete: { enabled: false },
};

// ─── Device Registry ───
function loadDeviceList() {
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Error loading devices.json:', err.message);
  }
  return [];
}

function saveDeviceList(devices) {
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
  } catch (err) {
    console.error('Error saving devices.json:', err.message);
  }
}

// ─── Bot Instance Class ───
class BotInstance {
  constructor(deviceId) {
    this.deviceId = deviceId;
    this.authDir = path.join(DATA_DIR, 'auth_info', deviceId);
    this.settingsFile = path.join(DATA_DIR, `settings-${deviceId}.json`);
    this.lidMapFile = path.join(DATA_DIR, `lid-map-${deviceId}.json`);

    this.sock = null;
    this.state = { qr: null, connected: false, phoneNumber: null };
    this.settings = this._loadSettings();
    this.lidToPhone = new Map();
    this.messageCache = new Map();
    this.MAX_CACHE_SIZE = 500;
    this._loadLidMap();
  }

  // Settings persistence
  _loadSettings() {
    try {
      if (fs.existsSync(this.settingsFile)) {
        const data = JSON.parse(fs.readFileSync(this.settingsFile, 'utf-8'));
        const merged = { ...DEFAULT_SETTINGS };
        for (const key of Object.keys(merged)) {
          if (data[key]) merged[key] = { ...merged[key], ...data[key] };
        }
        return merged;
      }
    } catch (err) {
      console.error(`[${this.deviceId}] Error loading settings:`, err.message);
    }
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  _saveSettings() {
    try {
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      console.error(`[${this.deviceId}] Error saving settings:`, err.message);
    }
  }

  // LID map persistence
  _loadLidMap() {
    try {
      if (fs.existsSync(this.lidMapFile)) {
        const data = JSON.parse(fs.readFileSync(this.lidMapFile, 'utf-8'));
        for (const [lid, phone] of Object.entries(data)) {
          this.lidToPhone.set(lid, phone);
        }
      }
    } catch (err) {
      console.error(`[${this.deviceId}] Error loading LID map:`, err.message);
    }
  }

  _saveLidMap() {
    try {
      const obj = Object.fromEntries(this.lidToPhone);
      fs.writeFileSync(this.lidMapFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error(`[${this.deviceId}] Error saving LID map:`, err.message);
    }
  }

  _addLidMapping(lid, phone) {
    if (!lid || !phone) return false;
    const lidJid = lid.includes('@') ? lid : lid + '@lid';
    const cleanPhone = phone.replace(/@.*/, '').split(':')[0];
    if (this.lidToPhone.has(lidJid) && this.lidToPhone.get(lidJid) === cleanPhone) return false;
    this.lidToPhone.set(lidJid, cleanPhone);
    const lidNum = lidJid.replace(/@.*/, '');
    if (!this.lidToPhone.has(lidNum)) this.lidToPhone.set(lidNum, cleanPhone);
    return true;
  }

  _resolveJidToNumber(jid) {
    if (!jid) return 'Unknown';
    if (jid.endsWith('@s.whatsapp.net')) {
      return jid.replace('@s.whatsapp.net', '').split(':')[0];
    }
    if (this.lidToPhone.has(jid)) return this.lidToPhone.get(jid);
    if (!jid.includes('@') && this.lidToPhone.has(jid + '@lid')) {
      return this.lidToPhone.get(jid + '@lid');
    }
    const numPart = jid.replace(/@.*/, '').split(':')[0];
    if (this.lidToPhone.has(numPart)) return this.lidToPhone.get(numPart);
    return numPart;
  }

  async _lookupPhoneFromLid(lidJid) {
    if (!this.sock || !lidJid) return null;
    try {
      const query = new USyncQuery().withContactProtocol().withLIDProtocol();
      const user = new USyncUser().withId(lidJid);
      query.withUser(user);
      const result = await this.sock.executeUSyncQuery(query);
      if (result?.list?.length) {
        const entry = result.list[0];
        if (entry.id && entry.id.endsWith('@s.whatsapp.net')) {
          const phone = entry.id.replace('@s.whatsapp.net', '').split(':')[0];
          this._addLidMapping(lidJid, phone);
          this._saveLidMap();
          return phone;
        }
        if (entry.lid && typeof entry.lid === 'string' && !entry.lid.includes('@lid')) {
          this._addLidMapping(lidJid, entry.lid);
          this._saveLidMap();
          return entry.lid;
        }
      }
    } catch (err) {
      console.error(`[${this.deviceId}] USyncQuery failed:`, err.message);
    }
    return null;
  }

  async _buildLidMap() {
    if (!this.sock) return;
    try {
      const files = fs.readdirSync(this.authDir).filter(f => f.startsWith('session-'));
      const numbers = new Set();
      for (const file of files) {
        const match = file.match(/^session-(\d+)\./);
        if (match && match[1].length >= 10 && match[1].length <= 14) {
          numbers.add(match[1]);
        }
      }
      try {
        const groups = await this.sock.groupFetchAllParticipating();
        for (const gid of Object.keys(groups)) {
          const group = groups[gid];
          if (group.participants) {
            for (const p of group.participants) {
              if (p.id && p.id.endsWith('@s.whatsapp.net')) {
                const num = p.id.replace('@s.whatsapp.net', '').split(':')[0];
                if (num.length >= 10 && num.length <= 14) numbers.add(num);
              }
            }
          }
        }
      } catch (err) { /* ignore */ }

      if (numbers.size === 0) return;
      const phoneList = [...numbers];
      let mapped = 0;
      for (let i = 0; i < phoneList.length; i += 10) {
        const batch = phoneList.slice(i, i + 10);
        try {
          const results = await this.sock.onWhatsApp(...batch.map(n => n + '@s.whatsapp.net'));
          if (results) {
            for (const r of results) {
              if (r.jid && r.lid) {
                const phone = r.jid.replace('@s.whatsapp.net', '').split(':')[0];
                const lidJid = r.lid.endsWith('@lid') ? r.lid : r.lid + '@lid';
                if (this._addLidMapping(lidJid, phone)) mapped++;
              }
            }
          }
        } catch (err) { /* ignore */ }
      }
      if (mapped > 0) this._saveLidMap();
    } catch (err) {
      console.error(`[${this.deviceId}] buildLidMap error:`, err.message);
    }
  }

  _randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  _getRandomReaction() {
    const list = this.settings.autoReact.reactions;
    return list[Math.floor(Math.random() * list.length)];
  }

  getState() { return { ...this.state }; }
  getSettings() { return { ...this.settings }; }

  updateSettings(newSettings) {
    for (const key of Object.keys(newSettings)) {
      if (this.settings[key] !== undefined) {
        this.settings[key] = { ...this.settings[key], ...newSettings[key] };
      }
    }
    this._saveSettings();
    return { ...this.settings };
  }

  async start() {
    // Ensure auth dir exists
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }

    const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);
    const logger = pino({ level: 'silent' });

    let version;
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched.version;
    } catch (err) {
      const defaultVersion = require('@whiskeysockets/baileys/lib/Defaults/baileys-version.json');
      version = defaultVersion.version;
    }

    this.sock = makeWASocket({
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, logger),
      },
      version,
      logger,
      browser: Browsers.macOS('WhatsApp Bot'),
    });

    // Connection updates
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr: qrData } = update;

      if (qrData) {
        this.state.qr = await qrcode.toDataURL(qrData);
        this.state.connected = false;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        this.state.connected = false;
        this.state.qr = null;

        if (statusCode === DisconnectReason.loggedOut) {
          this.state.phoneNumber = null;
        }

        if (shouldReconnect) {
          setTimeout(() => this.start(), 3000);
        }
      }

      if (connection === 'open') {
        this.state.connected = true;
        this.state.qr = null;
        this.state.phoneNumber = this.sock.user?.id?.split(':')[0] || 'Unknown';
        console.log(`[${this.deviceId}] Connected as ${this.state.phoneNumber}`);
        this._buildLidMap().catch(() => {});
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    // LID mapping from contacts
    const processContacts = (contacts, source) => {
      let changed = false;
      for (const contact of contacts) {
        const id = contact.id || '';
        const lid = contact.lid || '';
        const jid = contact.jid || '';
        if (id.endsWith('@s.whatsapp.net') && lid) {
          const phone = id.replace('@s.whatsapp.net', '').split(':')[0];
          if (this._addLidMapping(lid, phone)) changed = true;
        }
        if (jid.endsWith('@s.whatsapp.net') && lid) {
          const phone = jid.replace('@s.whatsapp.net', '').split(':')[0];
          if (this._addLidMapping(lid, phone)) changed = true;
        }
        if (id.endsWith('@lid') && jid.endsWith('@s.whatsapp.net')) {
          const phone = jid.replace('@s.whatsapp.net', '').split(':')[0];
          if (this._addLidMapping(id, phone)) changed = true;
        }
      }
      if (changed) this._saveLidMap();
    };

    this.sock.ev.on('contacts.upsert', (c) => processContacts(c, 'contacts.upsert'));
    this.sock.ev.on('contacts.update', (c) => processContacts(c, 'contacts.update'));
    this.sock.ev.on('messaging-history.set', (data) => {
      if (data.contacts?.length) processContacts(data.contacts, 'history-sync');
    });
    this.sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
      if (lid && jid) {
        const phone = jid.replace('@s.whatsapp.net', '').split(':')[0];
        if (this._addLidMapping(lid, phone)) this._saveLidMap();
      }
    });

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') {
          if (jid === 'status@broadcast' && this.settings.autoStatusView.enabled) {
            try { await this.sock.readMessages([msg.key]); } catch (err) { /* ignore */ }
          }
          continue;
        }

        // Detect "Delete for Everyone" — check BEFORE caching
        const protocolMsg = msg.message?.protocolMessage;
        if (protocolMsg && protocolMsg.type === proto.Message.ProtocolMessage.Type.REVOKE) {
          if (this.settings.antiDelete.enabled && this.sock.user?.id) {
            const revokedId = protocolMsg.key?.id;
            const cached = revokedId ? this.messageCache.get(revokedId) : null;
            const myNumber = this.sock.user.id.split(':')[0];
            const adminJid = myNumber + '@s.whatsapp.net';
            const senderName = cached?.pushName || msg.pushName || 'Unknown';

            const senderJid = cached?.sender || jid || '';
            const participantJid = cached?.participant || msg.key.participant || '';

            const myLid = this.sock.user?.lid || '';
            const myJid = myNumber + '@s.whatsapp.net';
            const isOwnJid = (j) => {
              if (!j) return false;
              if (j === myJid) return true;
              if (myLid && j === myLid) return true;
              return this._resolveJidToNumber(j) === myNumber;
            };

            let senderNumber = '';
            const jidsToTry = [participantJid, senderJid, protocolMsg.key?.participant].filter(j => j && !isOwnJid(j));

            for (const tryJid of jidsToTry) {
              if (tryJid.endsWith('@s.whatsapp.net')) {
                senderNumber = tryJid.replace('@s.whatsapp.net', '').split(':')[0];
                break;
              }
              const resolved = this._resolveJidToNumber(tryJid);
              if (resolved !== tryJid.replace(/@.*/, '').split(':')[0]) {
                senderNumber = resolved;
                break;
              }
            }

            if (!senderNumber || !/^\d{10,15}$/.test(senderNumber)) {
              for (const tryJid of jidsToTry) {
                if (tryJid.endsWith('@lid')) {
                  const phone = await this._lookupPhoneFromLid(tryJid);
                  if (phone && /^\d{10,15}$/.test(phone)) {
                    senderNumber = phone;
                    break;
                  }
                }
              }
            }

            const showNumber = (senderNumber && /^\d{10,15}$/.test(senderNumber))
              ? ` (+${senderNumber})` : '';

            const time = cached?.timestamp
              ? new Date(cached.timestamp * 1000).toLocaleString()
              : new Date().toLocaleString();

            let deletedContent = '[Unable to retrieve message]';
            if (cached?.message) {
              const m = cached.message;
              if (m.conversation) deletedContent = m.conversation;
              else if (m.extendedTextMessage?.text) deletedContent = m.extendedTextMessage.text;
              else if (m.imageMessage) deletedContent = '[Image] ' + (m.imageMessage.caption || '');
              else if (m.videoMessage) deletedContent = '[Video] ' + (m.videoMessage.caption || '');
              else if (m.audioMessage) deletedContent = '[Audio]';
              else if (m.documentMessage) deletedContent = '[Document] ' + (m.documentMessage.fileName || '');
              else if (m.stickerMessage) deletedContent = '[Sticker]';
              else if (m.contactMessage) deletedContent = '[Contact] ' + (m.contactMessage.displayName || '');
              else if (m.locationMessage) deletedContent = '[Location]';
            }

            const notification = `🛡️ *Anti-Delete Alert*\n\n` +
              `👤 *From:* ${senderName}${showNumber}\n` +
              `🕐 *Time:* ${time}\n` +
              `💬 *Deleted Message:*\n${deletedContent}`;

            try {
              await this.sock.sendMessage(adminJid, { text: notification });
            } catch (err) {
              console.error(`[${this.deviceId}] Anti-delete send error:`, err.message);
            }
          }
          continue;
        }

        // Cache message for anti-delete
        if (this.settings.antiDelete.enabled) {
          const participant = msg.key.participant || null;
          const isLidSender = jid.endsWith('@lid') || (participant && participant.endsWith('@lid'));
          if (isLidSender) {
            const lidJidToResolve = jid.endsWith('@lid') ? jid : participant;
            if (lidJidToResolve && !this.lidToPhone.has(lidJidToResolve)) {
              this._lookupPhoneFromLid(lidJidToResolve).catch(() => {});
            }
          }
          this.messageCache.set(msg.key.id, {
            key: msg.key,
            message: msg.message,
            sender: msg.key.remoteJid,
            participant: participant,
            pushName: msg.pushName || 'Unknown',
            isLid: isLidSender,
            timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
          });
          if (jid && participant) {
            if (jid.endsWith('@lid') && participant.endsWith('@s.whatsapp.net')) {
              const phone = participant.replace('@s.whatsapp.net', '').split(':')[0];
              if (!this.lidToPhone.has(jid)) {
                this.lidToPhone.set(jid, phone);
                this._saveLidMap();
              }
            } else if (participant.endsWith('@lid') && jid.endsWith('@s.whatsapp.net')) {
              const phone = jid.replace('@s.whatsapp.net', '').split(':')[0];
              if (!this.lidToPhone.has(participant)) {
                this.lidToPhone.set(participant, phone);
                this._saveLidMap();
              }
            }
          }
          if (this.messageCache.size > this.MAX_CACHE_SIZE) {
            const oldest = this.messageCache.keys().next().value;
            this.messageCache.delete(oldest);
          }
        }

        // Auto Read
        if (this.settings.autoRead.enabled) {
          const delay = this._randomDelay(this.settings.autoRead.minDelay, this.settings.autoRead.maxDelay);
          setTimeout(async () => {
            try { await this.sock.readMessages([msg.key]); } catch (err) { /* ignore */ }
          }, delay);
        }

        // Auto React
        if (this.settings.autoReact.enabled) {
          const delay = this._randomDelay(1000, 3000);
          setTimeout(async () => {
            try {
              await this.sock.sendMessage(jid, {
                react: { text: this._getRandomReaction(), key: msg.key },
              });
            } catch (err) { /* ignore */ }
          }, delay);
        }

        // Auto Reply
        if (this.settings.autoReply.enabled) {
          const delay = this._randomDelay(2000, 5000);
          setTimeout(async () => {
            try {
              await this.sock.sendMessage(jid, { text: this.settings.autoReply.message });
            } catch (err) { /* ignore */ }
          }, delay);
        }
      }
    });

    // Handle incoming calls
    this.sock.ev.on('call', async (calls) => {
      if (!this.settings.rejectCalls.enabled) return;
      for (const call of calls) {
        if (call.status === 'offer') {
          try {
            await this.sock.rejectCall(call.id, call.from);
          } catch (err) { /* ignore */ }
        }
      }
    });
  }

  async stop() {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        await this.sock.logout();
      } catch (err) { /* ignore */ }
      this.sock = null;
    }
    this.state = { qr: null, connected: false, phoneNumber: null };
  }

  async disconnect() {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(new Error('Device disconnected by user'));
      } catch (err) { /* ignore */ }
      this.sock = null;
    }
    this.state = { qr: null, connected: false, phoneNumber: null };
  }

  async deleteData() {
    await this.disconnect();
    // Remove session files
    if (fs.existsSync(this.authDir)) {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    }
    // Remove settings file
    if (fs.existsSync(this.settingsFile)) fs.unlinkSync(this.settingsFile);
    // Remove lid map
    if (fs.existsSync(this.lidMapFile)) fs.unlinkSync(this.lidMapFile);
  }
}

// ─── Device Manager ───
const instances = new Map();

function generateDeviceId() {
  return 'device-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function migrateExistingDevice() {
  // Migrate existing single-device setup to multi-device
  const oldAuthDir = path.join(DATA_DIR, 'auth_info');
  const oldSettingsFile = path.join(DATA_DIR, 'settings.json');
  const oldLidMapFile = path.join(DATA_DIR, 'lid-map.json');

  // Check if old auth_info exists and has session files directly (not in subdirs)
  if (fs.existsSync(oldAuthDir)) {
    const files = fs.readdirSync(oldAuthDir);
    const hasSessionFiles = files.some(f => f.startsWith('creds') || f.startsWith('session-'));
    const hasSubDirs = files.some(f => {
      const fullPath = path.join(oldAuthDir, f);
      return fs.statSync(fullPath).isDirectory();
    });

    if (hasSessionFiles && !hasSubDirs) {
      // Migrate: move session files into a subdirectory
      const deviceId = 'device-main';
      const newDir = path.join(oldAuthDir, deviceId);
      fs.mkdirSync(newDir, { recursive: true });

      for (const file of files) {
        const src = path.join(oldAuthDir, file);
        if (fs.statSync(src).isFile()) {
          fs.renameSync(src, path.join(newDir, file));
        }
      }

      // Migrate settings
      if (fs.existsSync(oldSettingsFile)) {
        const newSettingsFile = path.join(DATA_DIR, `settings-${deviceId}.json`);
        if (!fs.existsSync(newSettingsFile)) {
          fs.renameSync(oldSettingsFile, newSettingsFile);
        }
      }

      // Migrate lid map
      if (fs.existsSync(oldLidMapFile)) {
        const newLidMapFile = path.join(DATA_DIR, `lid-map-${deviceId}.json`);
        if (!fs.existsSync(newLidMapFile)) {
          fs.renameSync(oldLidMapFile, newLidMapFile);
        }
      }

      // Register the device
      const devices = loadDeviceList();
      if (!devices.find(d => d.id === deviceId)) {
        devices.push({ id: deviceId, createdAt: new Date().toISOString() });
        saveDeviceList(devices);
      }

      console.log('Migrated existing device to multi-device system as', deviceId);
      return deviceId;
    }
  }
  return null;
}

async function initAllDevices() {
  // Run migration if needed
  migrateExistingDevice();

  const devices = loadDeviceList();
  for (const device of devices) {
    const instance = new BotInstance(device.id);
    instances.set(device.id, instance);
    instance.start().catch(err => console.error(`[${device.id}] Start error:`, err.message));
  }
  console.log(`Initialized ${devices.length} device(s)`);
}

function addDevice() {
  const deviceId = generateDeviceId();
  const devices = loadDeviceList();
  devices.push({ id: deviceId, createdAt: new Date().toISOString() });
  saveDeviceList(devices);

  const instance = new BotInstance(deviceId);
  instances.set(deviceId, instance);
  instance.start().catch(err => console.error(`[${deviceId}] Start error:`, err.message));

  return deviceId;
}

async function removeDevice(deviceId) {
  const instance = instances.get(deviceId);
  if (instance) {
    await instance.deleteData();
    instances.delete(deviceId);
  }

  let devices = loadDeviceList();
  devices = devices.filter(d => d.id !== deviceId);
  saveDeviceList(devices);
}

function getDeviceList() {
  const devices = loadDeviceList();
  return devices.map(d => {
    const inst = instances.get(d.id);
    return {
      id: d.id,
      createdAt: d.createdAt,
      connected: inst?.state.connected || false,
      phoneNumber: inst?.state.phoneNumber || null,
    };
  });
}

function getDeviceInstance(deviceId) {
  return instances.get(deviceId) || null;
}

module.exports = {
  initAllDevices,
  addDevice,
  removeDevice,
  getDeviceList,
  getDeviceInstance,
};
