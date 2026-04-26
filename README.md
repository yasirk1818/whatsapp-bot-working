# WhatsApp Bot with Web Dashboard

A WhatsApp automation bot with a beautiful web dashboard for managing features. Connect your WhatsApp by scanning QR code and control all features with on/off toggles.

## Features

| Feature | Description |
|---------|-------------|
| 📵 **Reject Calls** | Automatically reject incoming WhatsApp calls |
| 👁️ **Auto Read** | Mark messages as read with random delay (configurable) |
| 😍 **Auto React** | Send random emoji reactions to incoming messages |
| 💬 **Auto Reply** | Send automatic reply message (customizable) |
| 👀 **Auto Status View** | Automatically view all status updates |
| 🛡️ **Anti Delete** | Prevent message deletion (log deleted messages) |

## Setup

### Prerequisites
- Node.js 18+
- npm

### Installation

```bash
# Clone the repository
git clone https://github.com/yasirk1818/whatsapp-bot.git
cd whatsapp-bot

# Install dependencies
npm install

# Start the bot
npm start
```

### Usage

1. Start the server with `npm start`
2. Open `http://localhost:3000` in your browser
3. Scan the QR code with WhatsApp (Settings → Linked Devices → Link a Device)
4. Toggle features on/off from the dashboard

## Tech Stack

- **Backend**: Node.js + Express
- **WhatsApp**: @whiskeysockets/baileys
- **Frontend**: Vanilla HTML/CSS/JS
- **QR Code**: qrcode library

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/state` | Get connection state and QR code |
| GET | `/api/settings` | Get current feature settings |
| POST | `/api/settings` | Update feature settings |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |

## License

MIT
