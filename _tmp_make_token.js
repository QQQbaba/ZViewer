const jwt = require('./node_modules/jsonwebtoken');
const token = jwt.sign({ userId: 1, role: 'root', username: 'root' }, 'dev-access-secret-change-in-production', { expiresIn: '10m' });
console.log(token);
