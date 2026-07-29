async function login() {
  const res = await fetch('http://localhost:3333/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'root' }),
  });
  const data = await res.json();
  return data.accessToken;
}

async function main() {
  const token = await login();
  console.log('got token', token.slice(0, 20));

  const { io } = require('socket.io-client');
  const socket = io('http://localhost:3333', {
    auth: { token },
    query: { token },
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    console.log('connected', socket.id);
    socket.emit('join-room', { roomId: 'B2NGpwoL' });
    setTimeout(() => {
      socket.emit('cli-list-agents', 'B2NGpwoL');
    }, 1000);
  });

  socket.on('cli-agents', (payload) => {
    console.log('cli-agents:', JSON.stringify(payload, null, 2));
    socket.disconnect();
    process.exit(0);
  });

  socket.on('connect_error', (err) => {
    console.error('connect_error', err.message);
  });

  setTimeout(() => {
    console.log('timeout');
    process.exit(1);
  }, 5000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
