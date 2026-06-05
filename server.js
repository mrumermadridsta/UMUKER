/**
 * ULTRA BINGO - Production-Grade Backend
 * Node.js + Express + Socket.IO + SQLite + JWT + bcrypt
 *
 * Features:
 * - Persistent SQLite database
 * - JWT authentication
 * - Bcrypt password hashing
 * - Real-time multiplayer (Socket.IO)
 * - Anti-cheat (server-side card validation)
 * - Admin panel (deposit verification)
 * - Rate limiting
 * - Helmet security headers
 * - Logging (winston)
 * - Health check endpoint
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const winston = require('winston');
const Telebirr = require('./payment/telebirr');
const CBEBirr = require('./payment/cbe');

// ════════════════════════════════════════════════
//   CONFIG
// ════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_KEY = process.env.ADMIN_KEY || '8084877485';
const WITHDRAW_PIN = process.env.WITHDRAW_PIN || '1234';
const JWT_EXPIRY = '30d';
const DB_PATH = process.env.DB_PATH || './data/ultra-bingo.db';

if (NODE_ENV === 'production' && JWT_SECRET === 'dev-secret-change-me') {
  console.error('❌ FATAL: JWT_SECRET must be set in production');
  process.exit(1);
}

// ════════════════════════════════════════════════
//   LOGGER
// ════════════════════════════════════════════════
const logger = winston.createLogger({
  level: NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple())
    })
  ]
});

// ════════════════════════════════════════════════
//   DATABASE
// ════════════════════════════════════════════════
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    balance REAL DEFAULT 0,
    ref_code TEXT UNIQUE,
    referred_by TEXT,
    wins INTEGER DEFAULT 0,
    total_won REAL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (phone) REFERENCES users(phone) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    status TEXT DEFAULT 'waiting',
    host_phone TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    winner_phone TEXT,
    prize_pool REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS room_players (
    room_id TEXT NOT NULL,
    socket_id TEXT,
    phone TEXT NOT NULL,
    name TEXT NOT NULL,
    card_number INTEGER NOT NULL,
    card_matrix TEXT NOT NULL,
    marked TEXT NOT NULL,
    lines_set TEXT NOT NULL,
    lines INTEGER DEFAULT 0,
    is_winner INTEGER DEFAULT 0,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, phone),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    amount REAL NOT NULL,
    reference TEXT NOT NULL,
    method TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    approved_at INTEGER,
    approved_by TEXT,
    FOREIGN KEY (phone) REFERENCES users(phone) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    amount REAL NOT NULL,
    withdraw_phone TEXT NOT NULL,
    method TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    processed_at INTEGER,
    FOREIGN KEY (phone) REFERENCES users(phone) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payment_orders (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL,
    external_order_id TEXT,
    status TEXT DEFAULT 'pending',
    checkout_url TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (phone) REFERENCES users(phone) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    balance_after REAL NOT NULL,
    reference TEXT,
    status TEXT DEFAULT 'completed',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (phone) REFERENCES users(phone) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone);
  CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_transactions_phone ON transactions(phone, created_at);
  CREATE INDEX IF NOT EXISTS idx_room_players_room ON room_players(room_id);
`);

// ════════════════════════════════════════════════
//   DB HELPERS
// ════════════════════════════════════════════════
const stmt = {
  // users
  getUser: db.prepare('SELECT * FROM users WHERE phone = ?'),
  getUserByRef: db.prepare('SELECT * FROM users WHERE ref_code = ?'),
  createUser: db.prepare(`
    INSERT INTO users (phone, name, password, balance, ref_code, referred_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  updateLastLogin: db.prepare('UPDATE users SET last_login = ? WHERE phone = ?'),
  updateBalance: db.prepare('UPDATE users SET balance = balance + ? WHERE phone = ?'),
  setBalance: db.prepare('UPDATE users SET balance = ? WHERE phone = ?'),
  incrementWins: db.prepare('UPDATE users SET wins = wins + 1, total_won = total_won + ? WHERE phone = ?'),
  getTopWinners: db.prepare('SELECT name, phone, wins, total_won FROM users ORDER BY wins DESC, total_won DESC LIMIT 20'),
  updateWithdrawalStatus: db.prepare("UPDATE withdrawals SET status = ? WHERE id = ?"),

  // sessions
  createSession: db.prepare(`
    INSERT INTO sessions (token, phone, created_at, expires_at) VALUES (?, ?, ?, ?)
  `),
  getSession: db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  cleanExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

  // rooms
  createRoom: db.prepare(`
    INSERT INTO rooms (id, name, price, host_phone, created_at) VALUES (?, ?, ?, ?, ?)
  `),
  getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  updateRoomStatus: db.prepare('UPDATE rooms SET status = ?, finished_at = ?, winner_phone = ?, prize_pool = ? WHERE id = ?'),

  // room players
  addPlayer: db.prepare(`
    INSERT INTO room_players (room_id, socket_id, phone, name, card_number, card_matrix, marked, lines_set, joined_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updatePlayer: db.prepare(`
    UPDATE room_players SET socket_id = ?, marked = ?, lines_set = ?, lines = ? WHERE room_id = ? AND phone = ?
  `),
  updatePlayerSocket: db.prepare('UPDATE room_players SET socket_id = ? WHERE room_id = ? AND phone = ?'),
  getPlayer: db.prepare('SELECT * FROM room_players WHERE room_id = ? AND phone = ?'),
  getPlayers: db.prepare('SELECT * FROM room_players WHERE room_id = ?'),
  removePlayer: db.prepare('DELETE FROM room_players WHERE room_id = ? AND phone = ?'),
  markWinner: db.prepare('UPDATE room_players SET is_winner = 1 WHERE room_id = ? AND phone = ?'),

  // deposits
  createDeposit: db.prepare(`
    INSERT INTO deposits (id, phone, amount, reference, method, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getDeposit: db.prepare('SELECT * FROM deposits WHERE id = ?'),
  getPendingDeposits: db.prepare("SELECT * FROM deposits WHERE status = 'pending' ORDER BY created_at ASC"),
  approveDeposit: db.prepare("UPDATE deposits SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?"),

  // withdrawals
  createWithdrawal: db.prepare(`
    INSERT INTO withdrawals (id, phone, amount, withdraw_phone, method, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `),

  // payment orders
  createPaymentOrder: db.prepare(`
    INSERT INTO payment_orders (id, phone, amount, method, external_order_id, status, checkout_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getPaymentOrder: db.prepare('SELECT * FROM payment_orders WHERE id = ?'),
  getPaymentOrderByExternal: db.prepare('SELECT * FROM payment_orders WHERE external_order_id = ?'),
  completePaymentOrder: db.prepare("UPDATE payment_orders SET status = 'completed', completed_at = ? WHERE id = ?"),
  getPendingPayments: db.prepare("SELECT * FROM payment_orders WHERE status = 'pending' ORDER BY created_at ASC"),

  // transactions
  addTransaction: db.prepare(`
    INSERT INTO transactions (phone, type, amount, balance_after, reference, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getTransactions: db.prepare('SELECT * FROM transactions WHERE phone = ? ORDER BY created_at DESC LIMIT 50')
};

// ════════════════════════════════════════════════
//   UTILS
// ════════════════════════════════════════════════
function genRefCode() {
  return 'UB-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}
function genRoomId() {
  return 'R' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
function genDepositId() {
  return 'D' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
function genWithdrawalId() {
  return 'W' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
function getDailySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
}
function generateCardFromNumber(cardNum) {
  const rng = seededRng(getDailySeed() * 997 + cardNum * 31);
  const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
  return ranges.map(([mn, mx]) => {
    const pool = [];
    for (let i = mn; i <= mx; i++) pool.push(i);
    const col = [];
    while (col.length < 5) {
      const idx = Math.floor(rng() * pool.length);
      col.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return col;
  });
}
function validatePhone(phone) {
  // Ethiopian phone: 9XXXXXXXX or 7XXXXXXXX
  return /^9\d{8}$|^7\d{8}$/.test(phone);
}

// ════════════════════════════════════════════════
//   AUTH MIDDLEWARE
// ════════════════════════════════════════════════
function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'] || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, message: 'ያልተረጋገጠ — token ያስፈልጋል' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = stmt.getUser.get(decoded.phone);
    if (!user) return res.status(401).json({ success: false, message: 'ተጠቃሚ አልተገኘም' });
    req.user = user;
    req.phone = user.phone;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'የጠፋ ወይም ያረጀ token' });
  }
}
function adminMiddleware(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey || req.body.adminKey;
  if (key !== ADMIN_KEY) return res.status(403).json({ success: false, message: 'የተከለከለ' });
  next();
}

// ════════════════════════════════════════════════
//   ROOM CLASS (in-memory, persisted to DB)
// ════════════════════════════════════════════════
class Room {
  constructor(id, name, price, hostPhone) {
    this.id = id;
    this.name = name;
    this.price = price;
    this.hostPhone = hostPhone;
    this.players = new Map(); // phone -> player data
    this.takenCards = new Set();
    this.status = 'waiting';
    this.calledNumbers = [];
    this.calledOrder = [];
    this.gameTimer = null;
    this.countdownTimer = null;
    this.maxPlayers = 100;
    this.createdAt = Date.now();
  }

  addPlayer(socketId, phone, name, cardNumber) {
    if (this.players.size >= this.maxPlayers) return { ok: false, msg: 'ክፍሉ ሞልቷል' };
    if (this.takenCards.has(cardNumber)) return { ok: false, msg: 'ካርቴላ ተወስዷል' };

    const cardMatrix = generateCardFromNumber(cardNumber);
    const marked = Array(5).fill(null).map(() => Array(5).fill(false));
    marked[2][2] = true;

    this.takenCards.add(cardNumber);
    this.players.set(phone, {
      socketId,
      phone,
      name,
      cardNumber,
      cardMatrix,
      marked,
      linesSet: new Set(),
      lines: 0
    });

    // Persist
    stmt.addPlayer.run(
      this.id, socketId, phone, name, cardNumber,
      JSON.stringify(cardMatrix), JSON.stringify(marked), '[]', Date.now()
    );
    return { ok: true };
  }

  removePlayer(phone) {
    const p = this.players.get(phone);
    if (p) {
      this.takenCards.delete(p.cardNumber);
      this.players.delete(phone);
    }
  }

  broadcastPlayersList() {
    const list = Array.from(this.players.values()).map(p => ({
      id: p.socketId,
      name: p.name,
      phone: p.phone,
      lines: p.lines,
      cardNumber: p.cardNumber
    }));
    for (const p of this.players.values()) {
      io.to(p.socketId).emit('playersList', list);
    }
  }

  startCountdown(seconds = 30) {
    let remaining = seconds;
    this.broadcastCountdown(remaining);
    this.countdownTimer = setInterval(() => {
      remaining--;
      if (remaining < 0) {
        clearInterval(this.countdownTimer);
        this.startGame();
        return;
      }
      this.broadcastCountdown(remaining);
    }, 1000);
  }

  broadcastCountdown(remaining) {
    for (const p of this.players.values()) {
      io.to(p.socketId).emit('countdown', { remaining });
    }
  }

  startGame() {
    if (this.status !== 'waiting') return;
    if (this.players.size < 2) {
      for (const p of this.players.values()) {
        io.to(p.socketId).emit('errorMessage', { message: 'ቢያንስ 2 ተጫዋቾች ያስፈልጋሉ' });
      }
      return;
    }
    this.status = 'running';
    this.calledNumbers = [];
    this.calledOrder = [];
    stmt.updateRoomStatus.run('running', null, null, 0, this.id);

    for (const [phone, p] of this.players) {
      p.marked = Array(5).fill(null).map(() => Array(5).fill(false));
      p.marked[2][2] = true;
      p.linesSet = new Set();
      p.lines = 0;
      stmt.updatePlayer.run(p.socketId, JSON.stringify(p.marked), '[]', 0, this.id, phone);
      io.to(p.socketId).emit('gameStarted', {
        cardNumber: p.cardNumber,
        cardMatrix: p.cardMatrix
      });
    }
    this.callNext();
  }

  callNext() {
    if (this.status !== 'running') return;
    if (this.calledNumbers.length >= 75) {
      setTimeout(() => this.endGame(null), 2000);
      return;
    }
    let num;
    do {
      num = Math.floor(Math.random() * 75) + 1;
    } while (this.calledNumbers.includes(num));

    this.calledNumbers.push(num);
    const letter = getLetter(num);
    this.calledOrder.push({ letter, number: num });

    for (const p of this.players.values()) {
      io.to(p.socketId).emit('numberCalled', {
        letter,
        number: num,
        calledCount: this.calledNumbers.length
      });
    }

    if (this.calledNumbers.length < 75) {
      this.gameTimer = setTimeout(() => this.callNext(), 3000);
    } else {
      setTimeout(() => this.endGame(null), 4000);
    }
  }

  markNumber(socketId, row, col) {
    const p = Array.from(this.players.values()).find(x => x.socketId === socketId);
    if (!p) return;
    const num = p.cardMatrix[col][row];
    if (!this.calledNumbers.includes(num)) return;
    if (p.marked[row][col]) return;
    p.marked[row][col] = true;
    stmt.updatePlayer.run(socketId, JSON.stringify(p.marked), JSON.stringify([...p.linesSet]), p.lines, this.id, p.phone);
    this.checkPlayerBingo(p);
  }

  checkPlayerBingo(player) {
    let newLine = false;
    for (let i = 0; i < 5; i++) {
      let rowC = true, colC = true;
      for (let j = 0; j < 5; j++) {
        if (!player.marked[i][j]) rowC = false;
        if (!player.marked[j][i]) colC = false;
      }
      if (rowC && !player.linesSet.has('r' + i)) { player.linesSet.add('r' + i); newLine = true; }
      if (colC && !player.linesSet.has('c' + i)) { player.linesSet.add('c' + i); newLine = true; }
    }
    let d1 = true, d2 = true;
    for (let i = 0; i < 5; i++) {
      if (!player.marked[i][i]) d1 = false;
      if (!player.marked[i][4 - i]) d2 = false;
    }
    if (d1 && !player.linesSet.has('d0')) { player.linesSet.add('d0'); newLine = true; }
    if (d2 && !player.linesSet.has('d1')) { player.linesSet.add('d1'); newLine = true; }

    if (newLine) {
      player.lines = player.linesSet.size;
      stmt.updatePlayer.run(
        player.socketId, JSON.stringify(player.marked),
        JSON.stringify([...player.linesSet]), player.lines, this.id, player.phone
      );
      io.to(player.socketId).emit('linesUpdate', { lines: player.lines });
      this.broadcastPlayersList();

      if (player.lines >= 2) {
        this.endGame({
          winner: player.name,
          winnerPhone: player.phone,
          prize: Math.floor(this.players.size * this.price * 0.8),
          players: this.players.size
        });
      }
    }
  }

  endGame(winnerData) {
    if (this.status === 'finished') return;
    this.status = 'finished';
    if (this.gameTimer) clearTimeout(this.gameTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);

    if (winnerData) {
      const user = stmt.getUser.get(winnerData.winnerPhone);
      if (user) {
        const newBal = user.balance + winnerData.prize;
        stmt.setBalance.run(newBal, winnerData.winnerPhone);
        stmt.incrementWins.run(winnerData.prize, winnerData.winnerPhone);
        stmt.addTransaction.run(
          winnerData.winnerPhone, 'win', winnerData.prize, newBal,
          this.id, 'completed', Date.now()
        );
      }
      stmt.updateRoomStatus.run('finished', Date.now(), winnerData.winnerPhone, winnerData.prize, this.id);
      stmt.markWinner.run(this.id, winnerData.winnerPhone);
    } else {
      stmt.updateRoomStatus.run('finished', Date.now(), null, 0, this.id);
    }

    for (const p of this.players.values()) {
      io.to(p.socketId).emit('gameEnded', winnerData);
    }

    // Auto-cleanup after 60s
    setTimeout(() => {
      rooms.delete(this.id);
    }, 60000);
  }
}

function getLetter(n) {
  if (n <= 15) return 'B';
  if (n <= 30) return 'I';
  if (n <= 45) return 'N';
  if (n <= 60) return 'G';
  return 'O';
}

// ════════════════════════════════════════════════
//   PAYMENT GATEWAYS
// ════════════════════════════════════════════════
const telebirr = new Telebirr({ sandbox: process.env.TELEBIRR_SANDBOX !== 'false' });
const cbe = new CBEBirr({ sandbox: process.env.CBE_SANDBOX !== 'false' });

// ════════════════════════════════════════════════
//   EXPRESS APP
// ════════════════════════════════════════════════
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: NODE_ENV === 'production' ? false : '*' },
  pingTimeout: 30000
});

app.use(helmet({
  contentSecurityPolicy: false, // CSP for SPA needs careful setup
  crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: NODE_ENV === 'production' ? false : '*' }));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Admin dashboard route
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'በጣም ብዙ ጥያቄ — በኋላ ይሞክሩ' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'ብዙ login/register attempts' }
});

app.use('/api/', apiLimiter);

// ════════════════════════════════════════════════
//   HEALTH CHECK
// ════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    env: NODE_ENV,
    rooms: rooms.size,
    db: 'connected'
  });
});

// ════════════════════════════════════════════════
//   AUTH API
// ════════════════════════════════════════════════
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { name, phone, password, refCode } = req.body;
    if (!name || !phone || !password) {
      return res.json({ success: false, message: 'ስም፣ ስልክ እና ፓስዎርድ ያስፈልጋል' });
    }
    if (!validatePhone(phone)) {
      return res.json({ success: false, message: 'ስልክ ቁጥር ትክክል አይደለም (9XXXXXXXX)' });
    }
    if (password.length < 4) {
      return res.json({ success: false, message: 'ፓስዎርድ ቢያንስ 4 ቁምፊ ይሁን' });
    }
    if (stmt.getUser.get(phone)) {
      return res.json({ success: false, message: 'ይህ ስልክ ቀድሞ ተመዝግቷል' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const myRefCode = genRefCode();
    const bonus = 10;

    stmt.createUser.run(phone, name, hashedPassword, bonus, myRefCode, refCode || null, Date.now());

    // referral bonus
    if (refCode) {
      const referrer = stmt.getUserByRef.get(refCode);
      if (referrer && referrer.phone !== phone) {
        stmt.updateBalance.run(5, referrer.phone);
        const newBal = stmt.getUser.get(referrer.phone).balance;
        stmt.addTransaction.run(referrer.phone, 'referral', 5, newBal, phone, 'completed', Date.now());
      }
    }

    // Signup bonus transaction
    stmt.addTransaction.run(phone, 'signup_bonus', bonus, bonus, null, 'completed', Date.now());

    const token = jwt.sign({ phone }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    stmt.createSession.run(token, phone, Date.now(), Date.now() + 30 * 24 * 60 * 60 * 1000);

    logger.info(`✅ New user: ${phone} (${name})`);
    res.json({
      success: true,
      token,
      user: { name, phone, balance: bonus, refCode: myRefCode, wins: 0 }
    });
  } catch (e) {
    logger.error('Register error:', e);
    res.status(500).json({ success: false, message: 'ስህተት' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.json({ success: false, message: 'ስልክ እና ፓስዎርድ ያስፈልጋል' });
    }
    const user = stmt.getUser.get(phone);
    if (!user) {
      return res.json({ success: false, message: 'ስልክ ወይም ፓስዎርድ ትክክል አይደለም' });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.json({ success: false, message: 'ስልክ ወይም ፓስዎርድ ትክክል አይደለም' });
    }

    const token = jwt.sign({ phone }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    stmt.createSession.run(token, phone, Date.now(), Date.now() + 30 * 24 * 60 * 60 * 1000);
    stmt.updateLastLogin.run(Date.now(), phone);

    logger.info(`✅ Login: ${phone}`);
    res.json({
      success: true,
      token,
      user: {
        name: user.name,
        phone: user.phone,
        balance: user.balance,
        refCode: user.ref_code,
        wins: user.wins
      }
    });
  } catch (e) {
    logger.error('Login error:', e);
    res.status(500).json({ success: false, message: 'ስህተት' });
  }
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers['x-auth-token'];
  stmt.deleteSession.run(token);
  res.json({ success: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({
    success: true,
    user: {
      name: req.user.name,
      phone: req.user.phone,
      balance: req.user.balance,
      refCode: req.user.ref_code,
      wins: req.user.wins,
      totalWon: req.user.total_won
    }
  });
});

// ════════════════════════════════════════════════
//   WALLET API
// ════════════════════════════════════════════════
app.post('/api/deposit', authMiddleware, (req, res) => {
  try {
    const { amount, reference, method } = req.body;
    if (!amount || amount < 100 || amount > 10000) {
      return res.json({ success: false, message: 'ከ100-10,000 ብር ብቻ' });
    }
    if (!reference || reference.length < 4) {
      return res.json({ success: false, message: 'የክፍያ ማጣቀሻ ያስፈልጋል' });
    }
    const id = genDepositId();
    stmt.createDeposit.run(id, req.phone, amount, reference, method || 'Telebirr', 'pending', Date.now());
    logger.info(`💰 Deposit request: ${req.phone} ${amount} ETB ref:${reference}`);
    res.json({ success: true, depositId: id, message: 'ጥያቄ ተልኳል — አስተዳዳሪ ያረጋግጣል' });
  } catch (e) {
    logger.error('Deposit error:', e);
    res.status(500).json({ success: false, message: 'ስህተት' });
  }
});

app.get('/api/pending-deposits', adminMiddleware, (req, res) => {
  res.json({ success: true, deposits: stmt.getPendingDeposits.all() });
});

app.post('/api/verify-deposit', adminMiddleware, (req, res) => {
  const { depositId } = req.body;
  const d = stmt.getDeposit.get(depositId);
  if (!d) return res.json({ success: false, message: 'ጥያቄ አልተገኘም' });
  if (d.status !== 'pending') return res.json({ success: false, message: 'ጥያቄ ቀድሞ ተረጋግጧል' });

  stmt.approveDeposit.run(depositId, Date.now(), req.ip || 'admin');
  stmt.updateBalance.run(d.amount, d.phone);
  const newBal = stmt.getUser.get(d.phone).balance;
  stmt.addTransaction.run(d.phone, 'deposit', d.amount, newBal, depositId, 'completed', Date.now());

  logger.info(`✅ Deposit approved: ${depositId} ${d.amount} ETB to ${d.phone}`);
  res.json({ success: true, message: 'ተረጋግጧል', phone: d.phone, amount: d.amount });
});

// ════════════════════════════════════════════════
//   REAL PAYMENT GATEWAY ENDPOINTS
// ════════════════════════════════════════════════

// Create Telebirr payment order
app.post('/api/payment/telebirr/create', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 100 || amount > 10000) {
      return res.json({ success: false, message: 'ከ100-10,000 ብር ብቻ' });
    }
    const orderId = 'TB' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const result = await telebirr.createOrder({
      orderId,
      amount,
      subject: 'Ultra Bingo Top-up',
      phone: req.phone,
      returnUrl: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/wallet?deposit=success`,
      notifyUrl: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/payment/telebirr/webhook`
    });
    if (result.success) {
      stmt.createPaymentOrder.run(orderId, req.phone, amount, 'Telebirr', orderId, 'pending', result.checkoutUrl, Date.now());
    }
    res.json(result);
  } catch (e) {
    logger.error('Telebirr create error:', e);
    res.status(500).json({ success: false, message: 'ስህተት' });
  }
});

// Telebirr webhook
app.post('/api/payment/telebirr/webhook', (req, res) => {
  try {
    const sig = req.headers['x-telebirr-signature'];
    if (!telebirr.verifyWebhook(req.body, sig)) {
      return res.status(403).json({ success: false });
    }
    const { orderId, status } = req.body;
    const order = stmt.getPaymentOrderByExternal.get(orderId);
    if (!order) return res.json({ success: false, message: 'order not found' });
    if (order.status !== 'pending') return res.json({ success: true, message: 'already processed' });
    if (status === 'SUCCESS' || status === 'paid') {
      stmt.completePaymentOrder.run(Date.now(), order.id);
      stmt.updateBalance.run(order.amount, order.phone);
      const user = stmt.getUser.get(order.phone);
      stmt.addTransaction.run(order.phone, 'deposit', order.amount, user.balance, order.id, 'completed', Date.now());
      logger.info(`💰 Telebirr deposit: ${order.phone} +${order.amount} ETB`);
    }
    res.json({ success: true });
  } catch (e) {
    logger.error('Telebirr webhook error:', e);
    res.status(500).json({ success: false });
  }
});

// Create CBE payment order
app.post('/api/payment/cbe/create', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 100 || amount > 10000) {
      return res.json({ success: false, message: 'ከ100-10,000 ብር ብቻ' });
    }
    const orderId = 'CBE' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const result = await cbe.createOrder({
      orderId,
      amount,
      subject: 'Ultra Bingo Top-up',
      phone: req.phone,
      returnUrl: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/wallet?deposit=success`,
      notifyUrl: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/payment/cbe/webhook`
    });
    if (result.success) {
      stmt.createPaymentOrder.run(orderId, req.phone, amount, 'CBE', orderId, 'pending', result.checkoutUrl, Date.now());
    }
    res.json(result);
  } catch (e) {
    logger.error('CBE create error:', e);
    res.status(500).json({ success: false, message: 'ስህተት' });
  }
});

// CBE webhook
app.post('/api/payment/cbe/webhook', (req, res) => {
  try {
    const sig = req.headers['x-cbe-signature'];
    if (!cbe.verifyWebhook(req.body, sig)) {
      return res.status(403).json({ success: false });
    }
    const { orderId, status } = req.body;
    const order = stmt.getPaymentOrderByExternal.get(orderId);
    if (!order) return res.json({ success: false, message: 'order not found' });
    if (order.status !== 'pending') return res.json({ success: true, message: 'already processed' });
    if (status === 'SUCCESS' || status === 'paid') {
      stmt.completePaymentOrder.run(Date.now(), order.id);
      stmt.updateBalance.run(order.amount, order.phone);
      const user = stmt.getUser.get(order.phone);
      stmt.addTransaction.run(order.phone, 'deposit', order.amount, user.balance, order.id, 'completed', Date.now());
      logger.info(`💰 CBE deposit: ${order.phone} +${order.amount} ETB`);
    }
    res.json({ success: true });
  } catch (e) {
    logger.error('CBE webhook error:', e);
    res.status(500).json({ success: false });
  }
});

// Query payment status
app.get('/api/payment/status/:orderId', authMiddleware, async (req, res) => {
  const order = stmt.getPaymentOrder.get(req.params.orderId);
  if (!order) return res.json({ success: false, message: 'አልተገኘም' });
  if (order.phone !== req.phone) return res.status(403).json({ success: false, message: 'የተከለከለ' });
  res.json({
    success: true,
    order: {
      id: order.id,
      amount: order.amount,
      method: order.method,
      status: order.status,
      checkoutUrl: order.checkout_url,
      createdAt: order.created_at,
      completedAt: order.completed_at
    }
  });
});

app.post('/api/withdraw', authMiddleware, (req, res) => {
  try {
    const { amount, withdrawPhone, pin, method } = req.body;
    if (!amount || amount < 100) {
      return res.json({ success: false, message: 'ዝቅተኛ 100 ብር' });
    }
    if (amount > 50000) {
      return res.json({ success: false, message: 'ከ50,000 ብር በላይ አይቻልም' });
    }
    if (pin !== WITHDRAW_PIN) {
      return res.json({ success: false, message: 'የተሳሳተ ፒን' });
    }
    const user = stmt.getUser.get(req.phone);
    if (!user || user.balance < amount) {
      return res.json({ success: false, message: 'በቂ ገንዘብ የለም' });
    }

    // Deduct immediately
    const newBal = user.balance - amount;
    stmt.setBalance.run(newBal, req.phone);

    const id = genWithdrawalId();
    stmt.createWithdrawal.run(id, req.phone, amount, withdrawPhone || req.phone, method || 'Telebirr', 'pending', Date.now());
    stmt.addTransaction.run(req.phone, 'withdraw', amount, newBal, id, 'pending', Date.now());

    logger.info(`💸 Withdrawal: ${req.phone} ${amount} ETB to ${withdrawPhone}`);
    res.json({ success: true, newBalance: newBal, message: 'ጥያቄ ተልኳል' });
  } catch (e) {
    logger.error('Withdraw error:', e);
    res.status(500).json({ success: false, message: 'ስህተት' });
  }
});

app.get('/api/transactions', authMiddleware, (req, res) => {
  res.json({ success: true, transactions: stmt.getTransactions.all(req.phone) });
});

app.get('/api/leaderboard', (req, res) => {
  const top = stmt.getTopWinners.all();
  res.json({ success: true, leaderboard: top });
});

// ════════════════════════════════════════════════
//   ADMIN DASHBOARD API
// ════════════════════════════════════════════════
const adminQueryStmt = {
  allUsers: db.prepare('SELECT phone, name, balance, wins, total_won, ref_code, created_at FROM users ORDER BY created_at DESC LIMIT 500'),
  searchUsers: db.prepare('SELECT phone, name, balance, wins, total_won, ref_code, created_at FROM users WHERE phone LIKE ? OR name LIKE ? LIMIT 100'),
  allRooms: db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM room_players WHERE room_id = r.id) as player_count
    FROM rooms r ORDER BY created_at DESC LIMIT ?
  `),
  allTransactions: db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT ?'),
  pendingWithdrawals: db.prepare("SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY created_at ASC"),
  stats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) as user_count,
      (SELECT COUNT(*) FROM rooms WHERE status = 'running') as active_rooms,
      (SELECT COALESCE(SUM(amount), 0) FROM deposits WHERE status = 'approved') as total_deposits,
      (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE status = 'approved') as total_withdrawals,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'win') as total_payouts
  `)
};

app.get('/api/admin/stats', adminMiddleware, (req, res) => {
  const s = adminQueryStmt.stats.get();
  res.json({
    success: true,
    stats: {
      users: s.user_count,
      rooms: s.active_rooms,
      totalDeposits: s.total_deposits,
      totalWithdrawals: s.total_withdrawals,
      totalPayouts: s.total_payouts
    }
  });
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const q = (req.query.q || '').trim();
  const users = q ? adminQueryStmt.searchUsers.all('%' + q + '%', '%' + q + '%') : adminQueryStmt.allUsers.all();
  res.json({ success: true, users });
});

app.get('/api/admin/rooms', adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  res.json({ success: true, rooms: adminQueryStmt.allRooms.all(limit) });
});

app.get('/api/admin/transactions', adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json({ success: true, transactions: adminQueryStmt.allTransactions.all(limit) });
});

app.get('/api/admin/withdrawals', adminMiddleware, (req, res) => {
  res.json({ success: true, withdrawals: adminQueryStmt.pendingWithdrawals.all() });
});

app.post('/api/admin/withdrawals/:id/approve', adminMiddleware, (req, res) => {
  const w = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
  if (!w) return res.json({ success: false, message: 'ጥያቄ አልተገኘም' });
  if (w.status !== 'pending') return res.json({ success: false, message: 'ቀድሞ ተሻሽሏል' });
  db.prepare("UPDATE withdrawals SET status = 'approved', processed_at = ? WHERE id = ?").run(Date.now(), w.id);
  logger.info(`✅ Withdrawal approved: ${w.id} ${w.amount} ETB to ${w.withdraw_phone}`);
  res.json({ success: true });
});

// ════════════════════════════════════════════════
//   SOCKET.IO
// ════════════════════════════════════════════════
const rooms = new Map(); // roomId -> Room

// Socket auth middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    // Allow guest connections for demo
    socket.user = null;
    socket.phone = null;
    return next();
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = stmt.getUser.get(decoded.phone);
    if (user) {
      socket.user = user;
      socket.phone = user.phone;
    }
  } catch (e) {}
  next();
});

io.on('connection', (socket) => {
  logger.info(`🔌 connect: ${socket.id} (user:${socket.phone || 'guest'})`);

  socket.on('createRoom', ({ playerName, price, roomName }) => {
    if (!socket.phone) {
      return socket.emit('errorMessage', { message: 'መጀመሪያ ይመዝገቡ' });
    }
    const user = stmt.getUser.get(socket.phone);
    if (user.balance < price) {
      return socket.emit('errorMessage', { message: 'በቂ ገንዘብ የለም' });
    }
    if (price < 5 || price > 100) {
      return socket.emit('errorMessage', { message: 'ዋጋ ከ5-100 ብር ብቻ' });
    }

    const id = genRoomId();
    const room = new Room(id, roomName, price, socket.phone);
    rooms.set(id, room);
    socket.join(id);
    stmt.createRoom.run(id, roomName, price, socket.phone, Date.now());

    socket.emit('roomCreated', {
      roomId: id,
      roomName,
      price,
      isHost: true,
      takenCards: Array.from(room.takenCards)
    });
  });

  socket.on('selectCard', ({ roomId, cardNumber }) => {
    if (!socket.phone) {
      return socket.emit('errorMessage', { message: 'መጀመሪያ ይመዝገቡ' });
    }
    const room = rooms.get(roomId);
    if (!room) return socket.emit('errorMessage', { message: 'ክፍል አልተገኘም' });
    if (room.status !== 'waiting') {
      return socket.emit('errorMessage', { message: 'ጨዋታ ጀምሯል — መቀላቀል አይቻልም' });
    }

    const user = stmt.getUser.get(socket.phone);
    if (user.balance < room.price) {
      return socket.emit('errorMessage', { message: 'በቂ ገንዘብ የለም' });
    }
    if (!Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > 400) {
      return socket.emit('errorMessage', { message: 'ካርቴላ 1-400 ብቻ' });
    }

    const r = room.addPlayer(socket.id, socket.phone, user.name, cardNumber);
    if (!r.ok) return socket.emit('errorMessage', { message: r.msg });

    // Deduct entry fee
    const newBal = user.balance - room.price;
    stmt.setBalance.run(newBal, socket.phone);
    stmt.addTransaction.run(socket.phone, 'bet', -room.price, newBal, roomId, 'completed', Date.now());

    // Notify all
    room.broadcastPlayersList();
    socket.emit('cardConfirmed', { cardNumber });
    io.to(roomId).emit('takenUpdate', {
      taken: Array.from(room.takenCards),
      playerCount: room.players.size
    });

    // Start countdown if 2+ players
    if (room.players.size === 2) {
      room.startCountdown(30);
    }
  });

  socket.on('markNumber', ({ roomId, row, col }) => {
    const room = rooms.get(roomId);
    if (room) room.markNumber(socket.id, row, col);
  });

  socket.on('claimBingo', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const p = Array.from(room.players.values()).find(x => x.socketId === socket.id);
    if (!p) return;
    room.checkPlayerBingo(p);
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.hostPhone === socket.phone) {
      if (room.countdownTimer) clearInterval(room.countdownTimer);
      room.startGame();
    }
  });

  socket.on('leaveRoom', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    // Refund if game hasn't started
    if (room.status === 'waiting' && socket.phone) {
      const p = room.players.get(socket.phone);
      if (p) {
        const user = stmt.getUser.get(socket.phone);
        if (user) {
          const newBal = user.balance + room.price;
          stmt.setBalance.run(newBal, socket.phone);
          stmt.addTransaction.run(socket.phone, 'refund', room.price, newBal, roomId, 'completed', Date.now());
        }
      }
    }
    room.removePlayer(socket.phone);
    if (room.players.size === 0) {
      rooms.delete(roomId);
    } else {
      room.broadcastPlayersList();
    }
  });

  socket.on('disconnect', () => {
    logger.info(`❌ disconnect: ${socket.id} (user:${socket.phone || 'guest'})`);
    for (const room of rooms.values()) {
      const p = Array.from(room.players.values()).find(x => x.socketId === socket.id);
      if (p) {
        // Refund if game hasn't started
        if (room.status === 'waiting' && socket.phone) {
          const user = stmt.getUser.get(socket.phone);
          if (user) {
            const newBal = user.balance + room.price;
            stmt.setBalance.run(newBal, socket.phone);
            stmt.addTransaction.run(socket.phone, 'refund', room.price, newBal, room.id, 'completed', Date.now());
          }
        }
        room.removePlayer(socket.phone);
        if (room.players.size === 0) {
          rooms.delete(room.id);
        } else {
          room.broadcastPlayersList();
        }
      }
    }
  });
});

// ════════════════════════════════════════════════
//   GRACEFUL SHUTDOWN
// ════════════════════════════════════════════════
function shutdown(signal) {
  logger.info(`📴 ${signal} received, shutting down gracefully`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ════════════════════════════════════════════════
//   CLEANUP EXPIRED SESSIONS (hourly)
// ════════════════════════════════════════════════
setInterval(() => {
  const r = stmt.cleanExpired.run(Date.now());
  if (r.changes > 0) logger.info(`🧹 Cleaned ${r.changes} expired sessions`);
}, 60 * 60 * 1000);

// ════════════════════════════════════════════════
//   START
// ════════════════════════════════════════════════
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`🎯 ULTRA BINGO running on port ${PORT}`);
  logger.info(`📡 Open: http://localhost:${PORT}`);
  logger.info(`🌍 Env: ${NODE_ENV}`);
  logger.info(`💾 DB: ${DB_PATH}`);
});
