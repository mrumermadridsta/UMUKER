require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const bodyParser = require('body-parser');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');

// Create needed directories
['logs', 'data'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ══════════════════════════════
//   CONFIG
// ══════════════════════════════
const PORT         = process.env.PORT || 3000;
const NODE_ENV     = process.env.NODE_ENV || 'development';
const JWT_SECRET   = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_KEY    = process.env.ADMIN_KEY  || '8084877485';
const WITHDRAW_PIN = process.env.WITHDRAW_PIN || '1234';
const JWT_EXPIRY   = '30d';

if (NODE_ENV === 'production' && JWT_SECRET === 'dev-secret-change-me') {
  console.warn('⚠️  WARNING: Set JWT_SECRET in environment variables!');
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

// ══════════════════════════════
//   IN-MEMORY STORE
// ══════════════════════════════
const users       = new Map(); // phone  → user
const sessions    = new Map(); // token  → phone
const rooms       = new Map(); // roomId → Room
const deposits    = new Map(); // id     → deposit
const withdrawals = [];
const socketToPhone = new Map(); // socketId → phone

// ══════════════════════════════
//   HELPERS
// ══════════════════════════════
const hashPw       = async (pw) => bcrypt.hash(pw, 10);
const comparePw    = async (pw, hash) => bcrypt.compare(pw, hash);
const genRefCode   = () => 'UB-' + crypto.randomBytes(3).toString('hex').toUpperCase();
const genToken     = () => crypto.randomBytes(20).toString('hex');
const genRoomId    = () => 'R'  + crypto.randomBytes(3).toString('hex').toUpperCase();
const genDepositId = () => 'D'  + crypto.randomBytes(4).toString('hex').toUpperCase();

function getDailySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function seededRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
}
function generateCard(cardNum) {
  const rng = seededRng(getDailySeed() * 997 + cardNum * 31);
  return [[1,15],[16,30],[31,45],[46,60],[61,75]].map(([mn, mx]) => {
    const pool = Array.from({ length: mx-mn+1 }, (_, i) => mn+i);
    const col  = [];
    while (col.length < 5) { const i = Math.floor(rng() * pool.length); col.push(pool.splice(i,1)[0]); }
    return col;
  });
}
function getLetter(n) {
  if (n <= 15) return 'B'; if (n <= 30) return 'I';
  if (n <= 45) return 'N'; if (n <= 60) return 'G'; return 'O';
}

// ══════════════════════════════
//   AUTH MIDDLEWARE
// ══════════════════════════════
function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  const phone = sessions.get(token);
  if (!token || !phone) return res.status(401).json({ success: false, message: 'ያልተረጋገጠ' });
  req.phone = phone;
  req.user  = users.get(phone);
  next();
}

// ══════════════════════════════
//   ROOM CLASS
// ══════════════════════════════
class Room {
  constructor(id, name, price, hostPhone) {
    this.id             = id;
    this.name           = name;
    this.price          = price;
    this.hostPhone      = hostPhone;
    this.hostSocketId   = null;
    this.players        = new Map(); // phone → player
    this.takenCards     = new Set();
    this.status         = 'waiting';
    this.calledNumbers  = [];
    this.winners        = [];
    this.gameTimer      = null;
    this.countdownTimer = null;
    this.countdownActive = false;
  }

  addPlayer(socketId, phone, name, cardNumber) {
    if (this.players.size >= 100)         return { ok: false, msg: 'ክፍሉ ሞልቷል' };
    if (this.takenCards.has(cardNumber))  return { ok: false, msg: 'ካርቴላ ተወስዷል' };
    if (this.players.has(phone))          return { ok: false, msg: 'ቀድሞ ተቀላቅለዋል' };
    this.takenCards.add(cardNumber);
    const player = {
      socketId, phone, name, cardNumber,
      marked:   Array(5).fill(null).map(() => Array(5).fill(false)),
      lines: 0, linesSet: new Set()
    };
    player.marked[2][2] = true;
    this.players.set(phone, player);
    return { ok: true };
  }

  removePlayer(phone) {
    const p = this.players.get(phone);
    if (p) { this.takenCards.delete(p.cardNumber); this.players.delete(phone); }
  }

  broadcast(event, data) {
    this.players.forEach(p => io.to(p.socketId).emit(event, data));
  }

  broadcastPlayersList() {
    const list = [...this.players.values()].map(p => ({
      id: p.socketId, name: p.name, lines: p.lines, cardNumber: p.cardNumber
    }));
    this.broadcast('playersList', list);
  }

  startCountdown(secs = 30) {
    if (this.countdownActive) return;
    this.countdownActive = true;
    let rem = secs;
    this.broadcast('countdown', { remaining: rem });
    this.countdownTimer = setInterval(() => {
      rem--;
      this.broadcast('countdown', { remaining: rem });
      if (rem <= 0) { clearInterval(this.countdownTimer); this.startGame(); }
    }, 1000);
  }

  startGame() {
    if (this.status !== 'waiting') return;
    if (this.players.size < 2) { this.broadcast('errorMessage', { message: 'ቢያንስ 2 ተጫዋቾች ያስፈልጋሉ' }); return; }
    this.status = 'running';
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    this.calledNumbers = [];
    this.winners = [];
    this.players.forEach(p => {
      p.marked = Array(5).fill(null).map(() => Array(5).fill(false));
      p.marked[2][2] = true; p.lines = 0; p.linesSet = new Set();
      io.to(p.socketId).emit('gameStarted', { cardNumber: p.cardNumber, cardMatrix: generateCard(p.cardNumber) });
    });
    this.callNext();
  }

  callNext() {
    if (this.status !== 'running') return;
    if (this.calledNumbers.length >= 75) { this.endGame(null); return; }
    let num;
    do { num = Math.floor(Math.random() * 75) + 1; } while (this.calledNumbers.includes(num));
    this.calledNumbers.push(num);
    const letter = getLetter(num);
    this.broadcast('numberCalled', { letter, number: num, calledCount: this.calledNumbers.length });
    if (this.calledNumbers.length < 75) {
      this.gameTimer = setTimeout(() => this.callNext(), 3000);
    } else { setTimeout(() => this.endGame(null), 4000); }
  }

  markNumber(phone, row, col) {
    const p = this.players.get(phone);
    if (!p || this.status !== 'running') return;
    const num = generateCard(p.cardNumber)[col][row];
    if (!this.calledNumbers.includes(num) || p.marked[row][col]) return;
    p.marked[row][col] = true;
    this.checkBingo(p);
  }

  checkBingo(player) {
    let newLine = false;
    for (let i = 0; i < 5; i++) {
      let r = true, c = true;
      for (let j = 0; j < 5; j++) { if (!player.marked[i][j]) r=false; if (!player.marked[j][i]) c=false; }
      if (r && !player.linesSet.has('r'+i)) { player.linesSet.add('r'+i); newLine=true; }
      if (c && !player.linesSet.has('c'+i)) { player.linesSet.add('c'+i); newLine=true; }
    }
    let d1=true, d2=true;
    for (let i=0;i<5;i++) { if(!player.marked[i][i]) d1=false; if(!player.marked[i][4-i]) d2=false; }
    if (d1 && !player.linesSet.has('d0')) { player.linesSet.add('d0'); newLine=true; }
    if (d2 && !player.linesSet.has('d1')) { player.linesSet.add('d1'); newLine=true; }
    if (newLine) {
      player.lines = player.linesSet.size;
      io.to(player.socketId).emit('linesUpdate', { lines: player.lines });
      this.broadcastPlayersList();
      if (player.lines >= 2 && this.winners.length === 0) {
        const prize = Math.floor(this.players.size * this.price * 0.8);
        this.winners.push(player.phone);
        const u = users.get(player.phone);
        if (u) { u.balance += prize; u.wins = (u.wins||0)+1; }
        this.endGame({ winner: player.name, phone: player.phone, prize, players: this.players.size });
      }
    }
  }

  endGame(data) {
    if (this.status === 'finished') return;
    this.status = 'finished';
    if (this.gameTimer)      { clearTimeout(this.gameTimer);    this.gameTimer=null; }
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer=null; }
    this.broadcast('gameEnded', data || { winner: null });
  }
}

// ══════════════════════════════
//   AUTH API
// ══════════════════════════════
app.post('/api/register', async (req, res) => {
  const { name, phone, password, refCode } = req.body;
  if (!name || !phone || !password) return res.json({ success:false, message:'ስም፣ ስልክ እና ፓስዎርድ ያስፈልጋል' });
  if (phone.length < 9)             return res.json({ success:false, message:'ስልክ ቁጥር ትክክል አይደለም' });
  if (users.has(phone))             return res.json({ success:false, message:'ይህ ስልክ ቀድሞ ተመዝግቷል' });
  const hashed   = await hashPw(password);
  const refCode2 = genRefCode();
  users.set(phone, { name, phone, password: hashed, balance: 10, refCode: refCode2, wins: 0 });
  if (refCode) {
    for (const u of users.values()) { if (u.refCode === refCode) { u.balance += 5; break; } }
  }
  const token = genToken();
  sessions.set(token, phone);
  res.json({ success:true, token, user:{ name, phone, balance:10, refCode:refCode2, wins:0 } });
});

app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.json({ success:false, message:'ስልክ እና ፓስዎርድ ያስፈልጋል' });
  const user = users.get(phone);
  if (!user)                       return res.json({ success:false, message:'ስልክ ወይም ፓስዎርድ ትክክል አይደለም' });
  const ok = await comparePw(password, user.password);
  if (!ok)                         return res.json({ success:false, message:'ስልክ ወይም ፓስዎርድ ትክክል አይደለም' });
  const token = genToken();
  sessions.set(token, phone);
  res.json({ success:true, token, user:{ name:user.name, phone, balance:user.balance, refCode:user.refCode, wins:user.wins } });
});

app.get('/api/user/:phone', authMiddleware, (req, res) => {
  const u = users.get(req.params.phone);
  if (!u) return res.json({ success:false, message:'ተጠቃሚ አልተገኘም' });
  res.json({ success:true, user:{ name:u.name, phone:u.phone, balance:u.balance, refCode:u.refCode, wins:u.wins } });
});

// ══════════════════════════════
//   WALLET API
// ══════════════════════════════
app.post('/api/deposit', authMiddleware, (req, res) => {
  const { amount, reference } = req.body;
  if (!amount || amount < 100 || amount > 10000) return res.json({ success:false, message:'ከ100-10,000 ብር ብቻ' });
  if (!reference) return res.json({ success:false, message:'የክፍያ ማጣቀሻ ያስፈልጋል' });
  const id = genDepositId();
  deposits.set(id, { id, phone:req.phone, amount:parseFloat(amount), reference, status:'pending', createdAt:Date.now() });
  res.json({ success:true, depositId:id, message:'ጥያቄ ጠብቆ ነው' });
});

app.get('/api/pending-deposits', (req, res) => {
  if (req.query.adminKey !== ADMIN_KEY) return res.status(403).json({ success:false, message:'የተከለከለ' });
  res.json({ success:true, deposits:[...deposits.values()].filter(d => d.status==='pending') });
});

app.post('/api/verify-deposit', (req, res) => {
  const { depositId, adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ success:false, message:'የተከለከለ' });
  const d = deposits.get(depositId);
  if (!d || d.status !== 'pending') return res.json({ success:false, message:'ጥያቄ አልተገኘም ወይም ቀድሞ ተረጋግጧል' });
  d.status = 'approved';
  const u = users.get(d.phone);
  if (u) u.balance += d.amount;
  res.json({ success:true, message:'ተረጋግጧል', phone:d.phone, newBalance:u?u.balance:0 });
});

app.post('/api/withdraw', authMiddleware, (req, res) => {
  const { amount, withdrawPhone, pin } = req.body;
  const u = req.user;
  if (!amount || amount < 100)    return res.json({ success:false, message:'ዝቅተኛ 100 ብር' });
  if (pin !== WITHDRAW_PIN)       return res.json({ success:false, message:'የተሳሳተ ፒን' });
  if (u.balance < amount)         return res.json({ success:false, message:'በቂ ገንዘብ የለም' });
  u.balance -= amount;
  withdrawals.push({ phone:req.phone, withdrawPhone:withdrawPhone||req.phone, amount:parseFloat(amount), status:'pending', createdAt:Date.now() });
  res.json({ success:true, newBalance:u.balance, message:'ጥያቄ ተልኳል' });
});

app.get('/api/health', (req, res) => {
  res.json({ status:'ok', users:users.size, rooms:rooms.size, uptime:process.uptime() });
});

// ══════════════════════════════
//   SOCKET.IO
// ══════════════════════════════
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    const phone = sessions.get(token);
    if (phone) { socket.phone = phone; socketToPhone.set(socket.id, phone); }
  }
  socket.phone = socket.phone || null;
  next();
});

io.on('connection', (socket) => {
  console.log('🔌 connect:', socket.id, socket.phone || 'guest');

  // Re-auth if token sent late
  socket.on('authenticate', ({ token }) => {
    const phone = sessions.get(token);
    if (phone) { socket.phone = phone; socketToPhone.set(socket.id, phone); socket.emit('authenticated', { ok:true }); }
    else         socket.emit('authenticated', { ok:false });
  });

  // Auto-matchmaking: join existing room or create new
  socket.on('joinOrCreateRoom', ({ price }) => {
    if (!socket.phone) return socket.emit('errorMessage', { message:'እባክዎ እንደገና ይግቡ' });
    const u = users.get(socket.phone);
    if (!u)              return socket.emit('errorMessage', { message:'ተጠቃሚ አልተገኘም' });
    if (u.balance < price) return socket.emit('errorMessage', { message:'በቂ ገንዘብ የለም — ዲፖዚት ያድርጉ' });

    let targetRoom = null;
    for (const room of rooms.values()) {
      if (room.price === price && room.status === 'waiting' && room.players.size < 100) {
        targetRoom = room; break;
      }
    }
    if (!targetRoom) {
      const id = genRoomId();
      targetRoom = new Room(id, price + ' ብር', price, socket.phone);
      targetRoom.hostSocketId = socket.id;
      rooms.set(id, targetRoom);
      socket.join(id);
      socket.emit('roomCreated', { roomId:id, roomName:price+' ብር', price, isHost:true, takenCards:[] });
    } else {
      socket.join(targetRoom.id);
      socket.emit('roomJoined', { roomId:targetRoom.id, roomName:targetRoom.name, price:targetRoom.price, isHost:false, takenCards:Array.from(targetRoom.takenCards) });
    }
  });

  socket.on('selectCard', ({ roomId, cardNumber }) => {
    if (!socket.phone) return socket.emit('errorMessage', { message:'እባክዎ እንደገና ይግቡ' });
    const u = users.get(socket.phone);
    if (!u) return socket.emit('errorMessage', { message:'ተጠቃሚ አልተገኘም' });
    const room = rooms.get(roomId);
    if (!room)                      return socket.emit('errorMessage', { message:'ክፍል አልተገኘም' });
    if (room.status !== 'waiting')  return socket.emit('errorMessage', { message:'ጨዋታ ጀምሯል' });
    if (u.balance < room.price)     return socket.emit('errorMessage', { message:'በቂ ገንዘብ የለም' });
    if (!Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > 400)
      return socket.emit('errorMessage', { message:'ካርቴላ 1-400 ብቻ' });

    socket.join(roomId); // ensure player is in the IO room

    const r = room.addPlayer(socket.id, socket.phone, u.name, cardNumber);
    if (!r.ok) return socket.emit('errorMessage', { message:r.msg });

    u.balance -= room.price;
    room.broadcastPlayersList();
    socket.emit('cardConfirmed', { cardNumber });
    io.to(roomId).emit('takenUpdate', { taken:Array.from(room.takenCards), playerCount:room.players.size });

    if (room.players.size >= 2 && !room.countdownActive) room.startCountdown(30);
  });

  socket.on('markNumber', ({ roomId, row, col }) => {
    const room = rooms.get(roomId);
    if (room && socket.phone) room.markNumber(socket.phone, row, col);
  });

  socket.on('claimBingo', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !socket.phone) return;
    const p = room.players.get(socket.phone);
    if (p) room.checkBingo(p);
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && room.hostPhone === socket.phone) room.startGame();
  });

  socket.on('leaveRoom', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !socket.phone) return;
    room.removePlayer(socket.phone);
    socket.leave(roomId);
    if (room.players.size === 0) rooms.delete(roomId);
    else room.broadcastPlayersList();
  });

  socket.on('disconnect', () => {
    socketToPhone.delete(socket.id);
    for (const room of rooms.values()) {
      if (socket.phone && room.players.has(socket.phone)) {
        room.removePlayer(socket.phone);
        if (room.players.size === 0) rooms.delete(room.id);
        else room.broadcastPlayersList();
        break;
      }
    }
  });
});

// ══════════════════════════════
//   START
// ══════════════════════════════
server.listen(PORT, '0.0.0.0', () => {
  console.log('🎯 ULTRA BINGO on port', PORT);
});
