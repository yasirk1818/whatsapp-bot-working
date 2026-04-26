const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
  proto,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');

const AUTH_DIR = path.join(__dirname, '..', 'auth_info');
const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

const REACTIONS = ['👍', '❤️', '😂', '🔥', '👏', '🎉', '💯', '😍', '🙏', '✨'];

const MAX_CACHE_SIZE = 500;
const messageCache = new Map();
const LID_MAP_FILE = path.join(__dirname, '..', 'lid-map.json');
const lidToPhone = new Map();

function loadLidMap() {
  try {
    if (fs.existsSync(LID_MAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(LID_MAP_FILE, 'utf-8'));
      for (const [lid, phone] of Object.entries(data)) {
        lidToPhone.set(lid, phone);
      }
      console.log('Loaded', lidToPhone.size, 'LID mappings');
    }
  } catch (err) {
    console.error('Error loading LID map:', err.message);
  }
}

function saveLidMap() {
  try {
    const obj = Object.fromEntries(lidToPhone);
    fs.writeFileSync(LID_MAP_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('Error saving LID map:', err.message);
  }
}

function resolveJidToNumber(jid) {
  if (!jid) return 'Unknown';
  // Direct phone JID
  if (jid.endsWith('@s.whatsapp.net')) {
    return jid.replace('@s.whatsapp.net', '').split(':')[0];
  }
  // Check LID map with full JID
  if (lidToPhone.has(jid)) {
    return lidToPhone.get(jid);
  }
  // Check LID map with @lid suffix
  if (!jid.includes('@') && lidToPhone.has(jid + '@lid')) {
    return lidToPhone.get(jid + '@lid');
  }
  // Check LID map with just the numeric part
  const numPart = jid.replace(/@.*/, '').split(':')[0];
  if (lidToPhone.has(numPart)) {
    return lidToPhone.get(numPart);
  }
  // Return number part but mark it as potentially a LID
  return numPart;
}

loadLidMap();

let state = {
  qr: null,
  connected: false,
  phoneNumber: null,
};

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

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      const merged = { ...DEFAULT_SETTINGS };
      for (const key of Object.keys(merged)) {
        if (data[key]) merged[key] = { ...merged[key], ...data[key] };
      }
      return merged;
    }
  } catch (err) {
    console.error('Error loading settings:', err.message);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Error saving settings:', err.message);
  }
}

let settings = loadSettings();

let sock = null;

function getState() {
  return { ...state };
}

function getSettings() {
  return { ...settings };
}

function updateSettings(newSettings) {
  for (const key of Object.keys(newSettings)) {
    if (settings[key] !== undefined) {
      settings[key] = { ...settings[key], ...newSettings[key] };
    }
  }
  saveSettings();
  return { ...settings };
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomReaction() {
  const list = settings.autoReact.reactions;
  return list[Math.floor(Math.random() * list.length)];
}

async function startBot() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const logger = pino({ level: 'silent' });

  let version;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
    console.log('Using WA version:', version);
  } catch (err) {
    const defaultVersion = require('@whiskeysockets/baileys/lib/Defaults/baileys-version.json');
    version = defaultVersion.version;
    console.log('Using bundled WA version:', version);
  }

  sock = makeWASocket({
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    version,
    logger,
    browser: Browsers.macOS('WhatsApp Bot'),
  });

  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr: qrData } = update;

    if (qrData) {
      state.qr = await qrcode.toDataURL(qrData);
      state.connected = false;
      console.log('QR Code generated - scan from dashboard');
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        'Connection closed. Status:',
        statusCode,
        'Reconnecting:',
        shouldReconnect
      );

      state.connected = false;
      state.qr = null;

      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      }
    }

    if (connection === 'open') {
      state.connected = true;
      state.qr = null;
      state.phoneNumber = sock.user?.id?.split(':')[0] || 'Unknown';
      console.log('Connected to WhatsApp as', state.phoneNumber);
    }
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Helper to register a LID→phone mapping
  function addLidMapping(lid, phone) {
    if (!lid || !phone) return false;
    const lidJid = lid.includes('@') ? lid : lid + '@lid';
    const cleanPhone = phone.replace(/@.*/, '').split(':')[0];
    if (lidToPhone.has(lidJid) && lidToPhone.get(lidJid) === cleanPhone) return false;
    lidToPhone.set(lidJid, cleanPhone);
    // Also store without @lid suffix for flexible matching
    const lidNum = lidJid.replace(/@.*/, '');
    if (!lidToPhone.has(lidNum)) lidToPhone.set(lidNum, cleanPhone);
    return true;
  }

  // Build LID-to-phone mapping from all contact events
  function processContacts(contacts, source) {
    let changed = false;
    for (const contact of contacts) {
      const id = contact.id || '';
      const lid = contact.lid || '';
      const jid = contact.jid || '';
      // Case 1: id is phone JID and lid is present
      if (id.endsWith('@s.whatsapp.net') && lid) {
        const phone = id.replace('@s.whatsapp.net', '').split(':')[0];
        if (addLidMapping(lid, phone)) changed = true;
      }
      // Case 2: jid is phone JID and lid is present
      if (jid.endsWith('@s.whatsapp.net') && lid) {
        const phone = jid.replace('@s.whatsapp.net', '').split(':')[0];
        if (addLidMapping(lid, phone)) changed = true;
      }
      // Case 3: id is LID and jid is phone
      if (id.endsWith('@lid') && jid.endsWith('@s.whatsapp.net')) {
        const phone = jid.replace('@s.whatsapp.net', '').split(':')[0];
        if (addLidMapping(id, phone)) changed = true;
      }
    }
    if (changed) {
      saveLidMap();
      console.log(`LID map updated from ${source}, total:`, lidToPhone.size);
    }
  }

  sock.ev.on('contacts.upsert', (c) => processContacts(c, 'contacts.upsert'));
  sock.ev.on('contacts.update', (c) => processContacts(c, 'contacts.update'));
  sock.ev.on('messaging-history.set', (data) => {
    if (data.contacts?.length) processContacts(data.contacts, 'history-sync');
  });

  // Direct LID-to-phone mapping from phoneNumberShare event
  sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
    if (lid && jid) {
      const phone = jid.replace('@s.whatsapp.net', '').split(':')[0];
      if (addLidMapping(lid, phone)) {
        saveLidMap();
        console.log('LID mapped via phoneNumberShare:', lid, '->', phone);
      }
    }
  });

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') {
        // Handle status view
        if (
          jid === 'status@broadcast' &&
          settings.autoStatusView.enabled
        ) {
          try {
            await sock.readMessages([msg.key]);
          } catch (err) {
            console.error('Error viewing status:', err.message);
          }
        }
        continue;
      }

      // Cache message for anti-delete
      if (settings.antiDelete.enabled) {
        console.log('[Message Debug] from:', jid, 'participant:', msg.key.participant || 'none', 'pushName:', msg.pushName || 'none');
        const participant = msg.key.participant || null;
        const isLidSender = jid.endsWith('@lid') || (participant && participant.endsWith('@lid'));
        messageCache.set(msg.key.id, {
          key: msg.key,
          message: msg.message,
          sender: msg.key.remoteJid,
          participant: participant,
          pushName: msg.pushName || 'Unknown',
          isLid: isLidSender,
          timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
        });
        // Also try to build LID mapping from message sender
        if (jid && participant) {
          if (jid.endsWith('@lid') && participant.endsWith('@s.whatsapp.net')) {
            const phone = participant.replace('@s.whatsapp.net', '').split(':')[0];
            if (!lidToPhone.has(jid)) {
              lidToPhone.set(jid, phone);
              saveLidMap();
            }
          } else if (participant.endsWith('@lid') && jid.endsWith('@s.whatsapp.net')) {
            const phone = jid.replace('@s.whatsapp.net', '').split(':')[0];
            if (!lidToPhone.has(participant)) {
              lidToPhone.set(participant, phone);
              saveLidMap();
            }
          }
        }
        if (messageCache.size > MAX_CACHE_SIZE) {
          const oldest = messageCache.keys().next().value;
          messageCache.delete(oldest);
        }
      }

      // Detect "Delete for Everyone" (revoke protocol message)
      const protocolMsg = msg.message?.protocolMessage;
      if (protocolMsg && protocolMsg.type === proto.Message.ProtocolMessage.Type.REVOKE) {
        if (settings.antiDelete.enabled && sock.user?.id) {
          const revokedId = protocolMsg.key?.id;
          const cached = revokedId ? messageCache.get(revokedId) : null;
          const myNumber = sock.user.id.split(':')[0];
          const adminJid = myNumber + '@s.whatsapp.net';
          const senderName = cached?.pushName || msg.pushName || 'Unknown';

          // Try multiple sources for the real number
          const senderJid = cached?.sender || jid || '';
          const participantJid = cached?.participant || msg.key.participant || '';
          const wasLid = cached?.isLid || senderJid.endsWith('@lid');
          console.log('[Anti-Delete Debug] senderJid:', senderJid, 'participant:', participantJid, 'isLid:', wasLid, 'LID map size:', lidToPhone.size);

          let senderNumber = '';
          let resolvedFromLid = false;

          // Try all sources to get a phone number
          const jidsToTry = [participantJid, senderJid, protocolMsg.key?.remoteJid, protocolMsg.key?.participant].filter(Boolean);
          for (const tryJid of jidsToTry) {
            // If it's a phone JID, use it directly
            if (tryJid.endsWith('@s.whatsapp.net')) {
              senderNumber = tryJid.replace('@s.whatsapp.net', '').split(':')[0];
              resolvedFromLid = false;
              break;
            }
            // If it's a LID, try to resolve from map
            const resolved = resolveJidToNumber(tryJid);
            if (resolved !== tryJid.replace(/@.*/, '').split(':')[0]) {
              // Successfully resolved from LID map
              senderNumber = resolved;
              resolvedFromLid = true;
              break;
            }
          }

          // Only show number if it's a real phone number (not a LID)
          const isRealNumber = senderNumber && !wasLid || resolvedFromLid;
          const showNumber = (isRealNumber && senderNumber && /^\d{10,15}$/.test(senderNumber))
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
            await sock.sendMessage(adminJid, { text: notification });
            console.log('Anti-delete notification sent to', myNumber);
          } catch (err) {
            console.error('Error sending anti-delete notification:', err.message);
          }
        }
        continue;
      }

      // Auto Read
      if (settings.autoRead.enabled) {
        const delay = randomDelay(
          settings.autoRead.minDelay,
          settings.autoRead.maxDelay
        );
        setTimeout(async () => {
          try {
            await sock.readMessages([msg.key]);
          } catch (err) {
            console.error('Error marking read:', err.message);
          }
        }, delay);
      }

      // Auto React
      if (settings.autoReact.enabled) {
        const delay = randomDelay(1000, 3000);
        setTimeout(async () => {
          try {
            await sock.sendMessage(jid, {
              react: { text: getRandomReaction(), key: msg.key },
            });
          } catch (err) {
            console.error('Error sending reaction:', err.message);
          }
        }, delay);
      }

      // Auto Reply
      if (settings.autoReply.enabled) {
        const delay = randomDelay(2000, 5000);
        setTimeout(async () => {
          try {
            await sock.sendMessage(jid, {
              text: settings.autoReply.message,
            });
          } catch (err) {
            console.error('Error sending reply:', err.message);
          }
        }, delay);
      }
    }
  });

  // Handle incoming calls
  sock.ev.on('call', async (calls) => {
    if (!settings.rejectCalls.enabled) return;

    for (const call of calls) {
      if (call.status === 'offer') {
        try {
          await sock.rejectCall(call.id, call.from);
          console.log('Rejected call from', call.from);
        } catch (err) {
          console.error('Error rejecting call:', err.message);
        }
      }
    }
  });
}

module.exports = { startBot, getState, updateSettings, getSettings };
