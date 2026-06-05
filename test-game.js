// Real-time game test - 2 players joining and playing
const { io } = require('socket.io-client');
const API = 'http://localhost:3000';

async function getToken(phone) {
  // Login
  let res = await fetch(API + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password: 'test1234' })
  });
  let data = await res.json();
  if (data.success) return data.token;

  // Register
  res = await fetch(API + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Player ' + phone.slice(-3), phone, password: 'test1234' })
  });
  data = await res.json();
  if (!data.success) throw new Error('Auth failed: ' + JSON.stringify(data));
  return data.token;
}

async function addBalance(phone, amount, token) {
  // Create deposit
  let res = await fetch(API + '/api/deposit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ amount, reference: 'TEST_' + Date.now(), method: 'Telebirr' })
  });
  let data = await res.json();
  if (!data.success) throw new Error('Deposit failed: ' + JSON.stringify(data));

  // Approve as admin
  await fetch(API + '/api/verify-deposit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ depositId: data.depositId, adminKey: '8084877485' })
  });
}

function connectPlayer(token, name) {
  return new Promise((resolve) => {
    const sock = io(API, { auth: { token } });
    sock.on('connect', () => {
      console.log(`  ✅ ${name} connected (${sock.id})`);
      resolve(sock);
    });
  });
}

async function main() {
  console.log('\n🎯 ULTRA BINGO - Real-time Game Test\n');

  // Setup 2 players with money
  const phoneA = '922222001';
  const phoneB = '922222002';

  console.log('1️⃣  Setting up players...');
  const tokenA = await getToken(phoneA);
  const tokenB = await getToken(phoneB);
  await addBalance(phoneA, 1000, tokenA);
  await addBalance(phoneB, 1000, tokenB);
  console.log('  ✅ Both players have 1000 ETB');

  // Connect both
  console.log('\n2️⃣  Connecting to socket...');
  const sockA = await connectPlayer(tokenA, 'PlayerA');
  const sockB = await connectPlayer(tokenB, 'PlayerB');

  // Track events
  const events = { A: [], B: [] };
  sockA.onAny((e, d) => events.A.push({ e, d }));
  sockB.onAny((e, d) => events.B.push({ e, d }));

  // Player A creates room
  console.log('\n3️⃣  Player A creating 10 ETB room...');
  await new Promise(r => {
    sockA.once('roomCreated', (data) => {
      console.log('  ✅ Room:', data.roomId, 'isHost:', data.isHost);
      r();
    });
    sockA.emit('createRoom', { playerName: 'PlayerA', price: 10, roomName: '10 ብር' });
  });

  // Player B joins (creates new room — for the test, both will play in B's room)
  console.log('\n4️⃣  Player B creating 10 ETB room...');
  await new Promise(r => {
    sockB.once('roomCreated', (data) => {
      console.log('  ✅ Room:', data.roomId, 'isHost:', data.isHost);
      r();
    });
    sockB.emit('createRoom', { playerName: 'PlayerB', price: 10, roomName: '10 ብር' });
  });

  // Both pick cards
  console.log('\n5️⃣  Both players picking cards...');
  const roomBId = events.B[events.B.length - 1].d.roomId;
  await new Promise(r => {
    sockB.once('cardConfirmed', () => {
      console.log('  ✅ PlayerB card confirmed');
      r();
    });
    sockB.emit('selectCard', { roomId: roomBId, cardNumber: 100 });
  });
  await new Promise(r => {
    sockA.once('cardConfirmed', () => {
      console.log('  ✅ PlayerA card confirmed');
      r();
    });
    sockA.emit('selectCard', { roomId: roomBId, cardNumber: 50 });
  });

  // Wait for countdown
  console.log('\n6️⃣  Waiting 32s for countdown + first numbers...');
  await new Promise(r => setTimeout(r, 32000));

  // Count events
  const numbersA = events.A.filter(e => e.e === 'numberCalled').length;
  const numbersB = events.B.filter(e => e.e === 'numberCalled').length;
  const startA = events.A.find(e => e.e === 'gameStarted');
  const startB = events.B.find(e => e.e === 'gameStarted');

  console.log('\n📊 Results:');
  console.log(`  Player A: gameStarted=${!!startA}, numbersCalled=${numbersA}`);
  console.log(`  Player B: gameStarted=${!!startB}, numbersCalled=${numbersB}`);

  if (startA && startB && numbersA > 0 && numbersB > 0) {
    console.log('\n✅ ALL TESTS PASSED — Real-time multiplayer working!');
  } else {
    console.log('\n❌ TEST FAILED — Game not progressing');
    console.log('A events:', events.A.map(e => e.e).join(', '));
    console.log('B events:', events.B.map(e => e.e).join(', '));
  }

  // Cleanup
  sockA.disconnect();
  sockB.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('Test error:', e); process.exit(1); });
