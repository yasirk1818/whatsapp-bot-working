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
const path = require('path');
const qrcode = require('qrcode');

const AUTH_DIR = path.join(__dirname, '..', 'auth_info');

const REACTIONS = ['👍', '❤️', '😂', '🔥', '👏', '🎉', '💯', '😍', '🙏', '✨'];

const MAX_CACHE_SIZE = 500;
const messageCache = new Map();

let state = {
  qr: null,
  connected: false,
  phoneNumber: null,
};

let settings = {
  rejectCalls: { enabled: false },
  autoRead: { enabled: false, minDelay: 1000, maxDelay: 5000 },
  autoReact: { enabled: false, reactions: REACTIONS },
  autoReply: {
    enabled: false,
    message: 'Thank you for your message! I will get back to you soon.',
  },
  autoStatusView: { enabled: false },
  antiDelete: { enabled: false, adminNumber: '' },
};

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
        messageCache.set(msg.key.id, {
          key: msg.key,
          message: msg.message,
          sender: msg.key.remoteJid,
          pushName: msg.pushName || 'Unknown',
          timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
        });
        if (messageCache.size > MAX_CACHE_SIZE) {
          const oldest = messageCache.keys().next().value;
          messageCache.delete(oldest);
        }
      }

      // Detect "Delete for Everyone" (revoke protocol message)
      const protocolMsg = msg.message?.protocolMessage;
      if (protocolMsg && protocolMsg.type === proto.Message.ProtocolMessage.Type.REVOKE) {
        if (settings.antiDelete.enabled && settings.antiDelete.adminNumber) {
          const revokedId = protocolMsg.key?.id;
          const cached = revokedId ? messageCache.get(revokedId) : null;
          const adminJid = settings.antiDelete.adminNumber.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
          const senderName = cached?.pushName || 'Unknown';
          const senderNumber = (cached?.sender || jid || 'Unknown').replace('@s.whatsapp.net', '');
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
            `👤 *From:* ${senderName} (${senderNumber})\n` +
            `🕐 *Time:* ${time}\n` +
            `💬 *Deleted Message:*\n${deletedContent}`;

          try {
            await sock.sendMessage(adminJid, { text: notification });
            console.log('Anti-delete notification sent to admin');
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
