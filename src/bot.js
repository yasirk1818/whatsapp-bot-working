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

// Look up phone number from LID using WhatsApp's USyncQuery
async function lookupPhoneFromLid(lidJid) {
  if (!sock || !lidJid) return null;
  try {
    const query = new USyncQuery().withContactProtocol().withLIDProtocol();
    const user = new USyncUser().withId(lidJid);
    query.withUser(user);
    const result = await sock.executeUSyncQuery(query);
    if (result?.list?.length) {
      const entry = result.list[0];
      // The response id might be the phone JID
      if (entry.id && entry.id.endsWith('@s.whatsapp.net')) {
        const phone = entry.id.replace('@s.whatsapp.net', '').split(':')[0];
        addLidMapping(lidJid, phone);
        saveLidMap();
        console.log('USyncQuery resolved LID:', lidJid, '->', phone);
        return phone;
      }
      // Or the lid field might have the phone
      if (entry.lid && typeof entry.lid === 'string' && !entry.lid.includes('@lid')) {
        addLidMapping(lidJid, entry.lid);
        saveLidMap();
        console.log('USyncQuery resolved LID via lid field:', lidJid, '->', entry.lid);
        return entry.lid;
      }

    }
  } catch (err) {
    console.error('USyncQuery lookup failed:', err.message);
  }
  return null;
}

function addLidMapping(lid, phone) {
  if (!lid || !phone) return false;
  const lidJid = lid.includes('@') ? lid : lid + '@lid';
  const cleanPhone = phone.replace(/@.*/, '').split(':')[0];
  if (lidToPhone.has(lidJid) && lidToPhone.get(lidJid) === cleanPhone) return false;
  lidToPhone.set(lidJid, cleanPhone);
  const lidNum = lidJid.replace(/@.*/, '');
  if (!lidToPhone.has(lidNum)) lidToPhone.set(lidNum, cleanPhone);
  return true;
}

// Build LID map by looking up known contacts via onWhatsApp
async function buildLidMapFromSessions() {
  if (!sock) return;
  try {
    // Extract phone-like numbers from session files in auth_info
    const files = fs.readdirSync(AUTH_DIR).filter(f => f.startsWith('session-'));
    const numbers = new Set();
    for (const file of files) {
      const match = file.match(/^session-(\d+)\./);
      if (match) {
        const num = match[1];
        // Phone numbers are typically 10-13 digits; LIDs are 15+
        if (num.length >= 10 && num.length <= 14) {
          numbers.add(num);
        }
      }
    }

    // Also extract phone numbers from group metadata
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const groupId of Object.keys(groups)) {
        const group = groups[groupId];
        if (group.participants) {
          for (const p of group.participants) {
            if (p.id && p.id.endsWith('@s.whatsapp.net')) {
              const num = p.id.replace('@s.whatsapp.net', '').split(':')[0];
              if (num.length >= 10 && num.length <= 14) numbers.add(num);
            }
          }
        }
      }
    } catch (err) {
      console.error('Group metadata fetch error:', err.message);
    }

    if (numbers.size === 0) return;
    console.log('Looking up', numbers.size, 'phone numbers for LID mapping...');

    // Query WhatsApp for each number to get LID
    const phoneList = [...numbers];
    const batchSize = 10;
    let mapped = 0;
    for (let i = 0; i < phoneList.length; i += batchSize) {
      const batch = phoneList.slice(i, i + batchSize);
      try {
        const results = await sock.onWhatsApp(...batch.map(n => n + '@s.whatsapp.net'));
        if (results) {
          for (const result of results) {
            if (result.jid && result.lid) {
              const phone = result.jid.replace('@s.whatsapp.net', '').split(':')[0];
              const lidJid = result.lid.endsWith('@lid') ? result.lid : result.lid + '@lid';
              if (addLidMapping(lidJid, phone)) mapped++;
            }
          }
        }
      } catch (err) {
        console.error('onWhatsApp batch lookup error:', err.message);
      }
    }

    if (mapped > 0) {
      saveLidMap();
      console.log('LID map: resolved', mapped, 'numbers, total:', lidToPhone.size);
    } else {
      console.log('LID map: no new mappings found from', numbers.size, 'numbers');
    }
  } catch (err) {
    console.error('buildLidMapFromSessions error:', err.message);
  }
}

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

      // Build LID mapping by looking up known phone numbers
      buildLidMapFromSessions().catch(err => console.error('LID map build error:', err.message));
    }
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

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

      // Detect "Delete for Everyone" (revoke protocol message) — check BEFORE caching
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


          let senderNumber = '';

          // Step 1: Try all available JIDs for phone number
          const jidsToTry = [participantJid, senderJid, protocolMsg.key?.remoteJid, protocolMsg.key?.participant].filter(Boolean);
          for (const tryJid of jidsToTry) {
            if (tryJid.endsWith('@s.whatsapp.net')) {
              senderNumber = tryJid.replace('@s.whatsapp.net', '').split(':')[0];
              break;
            }
            const resolved = resolveJidToNumber(tryJid);
            if (resolved !== tryJid.replace(/@.*/, '').split(':')[0]) {
              senderNumber = resolved;
              break;
            }
          }

          // Step 2: If still no number, try USyncQuery lookup for LID JIDs
          if (!senderNumber || !/^\d{10,15}$/.test(senderNumber)) {
            for (const tryJid of jidsToTry) {
              if (tryJid.endsWith('@lid')) {
                const phone = await lookupPhoneFromLid(tryJid);
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
            await sock.sendMessage(adminJid, { text: notification });
            console.log('Anti-delete notification sent to', myNumber);
          } catch (err) {
            console.error('Error sending anti-delete notification:', err.message);
          }
        }
        continue;
      }

      // Cache message for anti-delete (after revoke check to avoid caching revoke messages)
      if (settings.antiDelete.enabled) {
        const participant = msg.key.participant || null;
        const isLidSender = jid.endsWith('@lid') || (participant && participant.endsWith('@lid'));
        // Proactively resolve LID to phone when message arrives
        if (isLidSender) {
          const lidJidToResolve = jid.endsWith('@lid') ? jid : participant;
          if (lidJidToResolve && !lidToPhone.has(lidJidToResolve)) {
            lookupPhoneFromLid(lidJidToResolve).catch(() => {});
          }
        }
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
