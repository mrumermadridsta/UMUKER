# 🎯 ULTRA BINGO v2.1

Production-grade Telegram Mini App for real-money Bingo with Telebirr/CBE payment integration.

## ✨ Features

### Core
- ✅ **Real-time multiplayer** Bingo (Socket.IO)
- ✅ **4 stake tiers** (5/10/50/100 ETB)
- ✅ **2-line Bingo** winning (80% prize to winner)
- ✅ **Server-side card validation** (anti-cheat)
- ✅ **SQLite database** (persistent)
- ✅ **JWT auth + bcrypt** password hashing
- ✅ **Rate limiting + Helmet** security
- ✅ **Winston logging**

### Payments
- ✅ **Real Telebirr API** (Ethio Telecom) — H5 Web Payment
- ✅ **Real CBE Birr API** — merchant integration
- ✅ **Webhook handlers** with RSA signature verification
- ✅ **Refund support**
- ✅ **Manual deposit approval** (admin fallback)
- ✅ **Withdraw with PIN**

### Telegram
- ✅ **Telegram bot** with /start, /play, /balance, /deposit, /withdraw, /support
- ✅ **WebApp button** integration
- ✅ **Referral system** (+5 ETB per invite)
- ✅ **Inline keyboards**

### Admin
- ✅ **Web dashboard** at `/admin`
- ✅ **Stats overview** (users, rooms, deposits, withdrawals, payouts)
- ✅ **Approve deposits/withdrawals**
- ✅ **View users, games, transactions**
- ✅ **Search users**

## 🚀 Quick Start

```bash
# 1. Install
cd ultra-bingo
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your real Telebirr/CBE credentials

# 3. Start server
npm start

# 4. (Optional) Start Telegram bot in another terminal
npm run bot

# 5. Open
# Mini App: http://localhost:3000
# Admin:    http://localhost:3000/admin (key: 8084877485)
```

## 📁 Structure

```
ultra-bingo/
├── server.js                # Express + Socket.IO main server
├── package.json
├── .env.example
├── public/
│   ├── index.html           # Telegram Mini App frontend
│   └── admin.html           # Admin dashboard
├── bot/
│   └── telegram-bot.js      # Standalone Telegram bot
├── payment/
│   ├── telebirr.js          # Telebirr API client
│   └── cbe.js               # CBE Birr API client
├── data/
│   └── ultra-bingo.db       # SQLite (auto-created)
├── logs/                    # Winston logs
└── test-game.js             # Real-time game test
```

## 🔑 Default Credentials

- **Admin dashboard:** key `8084877485` at `http://localhost:3000/admin`
- **Admin in Mini App:** key `8084877485` in Wallet → Admin Panel
- **Withdraw PIN:** `1234`
- **New users:** +10 ETB signup bonus

## 🧪 Testing

```bash
# Health check
curl http://localhost:3000/health

# Run real-time game test
node test-game.js

# Register + login + deposit flow
curl -X POST http://localhost:3000/api/register -H "Content-Type: application/json" -d '{"name":"Test","phone":"911111111","password":"test1234"}'
```

## 💳 Real Payment Setup

### Telebirr
1. Register at https://developerportal.ethiotelecom.et/
2. Apply for H5 Web Payment merchant account
3. Get `APP_ID`, `MERCHANT_ID`, private/public keys
4. Set in `.env`:
   ```
   TELEBIRR_APP_ID=...
   TELEBIRR_MERCHANT_ID=...
   TELEBIRR_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
   TELEBIRR_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----..."
   TELEBIRR_SANDBOX=false
   ```

### CBE Birr
1. Register merchant at https://apps.cbe.com.et:9443/
2. Get `MERCHANT_CODE`, `API_KEY`, keys
3. Set in `.env`:
   ```
   CBE_MERCHANT_CODE=...
   CBE_API_KEY=...
   CBE_PRIVATE_KEY="..."
   CBE_PUBLIC_KEY="..."
   CBE_SANDBOX=false
   ```

## 🤖 Telegram Bot Setup

1. Create bot via [@BotFather](https://t.me/BotFather)
2. Get bot token
3. Set in `.env`: `TELEGRAM_BOT_TOKEN=...`
4. Set menu button: `/setmenubutton` → choose bot → `https://your-domain.com`
5. Run: `npm run bot`

Bot commands:
- `/start` — welcome + open Mini App
- `/play` — quick play
- `/balance` — check balance
- `/deposit` — top-up instructions
- `/withdraw` — cashout instructions
- `/support` — contact
- `/invite` — referral link

## 🚀 Production Deploy

```bash
# Option 1: PM2
npm install -g pm2
pm2 start server.js --name ultra-bingo
pm2 start bot/telegram-bot.js --name bingo-bot
pm2 save
pm2 startup

# Option 2: Docker
docker build -t ultra-bingo .
docker run -d -p 3000:3000 --name bingo ultra-bingo

# Option 3: systemd
sudo nano /etc/systemd/system/ultra-bingo.service
# See deploy/systemd.service
```

### HTTPS (required for Telegram WebApp)

Use Cloudflare (free):
1. Add domain to Cloudflare
2. Point to your server IP
3. Enable Full SSL
4. Set `PUBLIC_URL=https://your-domain.com` in `.env`

## 📊 Admin Dashboard

Visit `https://your-domain.com/admin`:
- Enter key `8084877485`
- View stats, users, games, transactions
- Approve deposits/withdrawals
- Search users

## 🔒 Security Notes

- ✅ bcrypt password hashing
- ✅ JWT auth tokens (30-day expiry)
- ✅ Rate limiting (10 auth attempts / 15min)
- ✅ Helmet security headers
- ✅ Input validation on all endpoints
- ✅ Admin key required for sensitive operations
- ✅ Server-side card validation (anti-cheat)
- ⚠️ For production: enable HTTPS, set strong `JWT_SECRET`, monitor logs

## 📜 License

Proprietary - All rights reserved.
