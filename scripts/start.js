const { spawn } = require('child_process');
const path = require('path');

const isWin = process.platform === 'win32';
const script = isWin ? 'start-prod.bat' : './start-prod.sh';
const knownCommands = ['start', 'stop', 'restart', 'status', 'logs', 'build', 'help'];

let args = process.argv.slice(2);

// npm 在 Windows 下传参时可能吞掉以 "-" 开头的开关（如 -Port）。
// 这里做两种兼容：
//   1. 如果第一个参数是已知子命令，直接透传；
//   2. 如果参数形如 [3334, 4174] 或 [3334]，自动补全为 -Port / -FrontendPort；
//   3. 否则默认执行 start 并透传其余参数。
const firstArg = args[0];
const isCommand = firstArg && knownCommands.includes(firstArg);

if (!isCommand && args.length > 0 && args.every((a) => /^\d+$/.test(a))) {
  const positional = [];
  if (args[0]) positional.push('-Port', args[0]);
  if (args[1]) positional.push('-FrontendPort', args[1]);
  args = positional;
}

const finalArgs = isCommand ? args : ['start', ...args];

const child = spawn(script, finalArgs, {
  stdio: 'inherit',
  shell: true,
  cwd: path.join(__dirname, '..')
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
