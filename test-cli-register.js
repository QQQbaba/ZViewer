const { io } = require('socket.io-client');

const socket = io('http://localhost:3333', {
  auth: { agent: 'zcontrol-cli' },
  transports: ['websocket'],
});

socket.on('connect', () => {
  console.log('connected as cli', socket.id);
  socket.emit('cli-register', {
    roomId: 'B2NGpwoL',
    proxyUrl: 'http://127.0.0.1:9333',
    agent: 'zcontrol-cli',
    version: 'test',
  });
});

socket.on('cli-registered', (payload) => {
  console.log('cli-registered:', JSON.stringify(payload, null, 2));
  setTimeout(() => {
    socket.disconnect();
    process.exit(0);
  }, 500);
});

socket.on('cli-error', (payload) => {
  console.error('cli-error:', JSON.stringify(payload, null, 2));
});

socket.on('connect_error', (err) => {
  console.error('connect_error', err.message);
});

setTimeout(() => {
  console.log('timeout');
  process.exit(1);
}, 5000);
