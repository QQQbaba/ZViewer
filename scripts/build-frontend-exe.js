/**
 * 前端编译为 exe 的构建脚本。
 *
 * 将前端静态文件服务（frontend-server/server.js）打包为独立的 exe，
 * 零外部依赖（全部使用 Node.js 内置模块）。
 *
 * 输出目录结构：
 *   dist-exe/
 *   ├── zviewer-frontend.exe   - 前端服务可执行程序
 *   └── frontend/
 *       └── dist/              - 前端构建产物（需 exe 同级或在 FRONTEND_DIST 指定）
 *
 * 用法：
 *   node scripts/build-frontend-exe.js                # 构建前端 + 打包
 *   node scripts/build-frontend-exe.js --skip-build   # 仅打包
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_SERVER = path.join(ROOT, 'frontend-server');
const FRONTEND = path.join(ROOT, 'frontend');
const DIST_EXE = path.join(ROOT, 'dist-exe');
const OUTPUT_NAME = 'zviewer-frontend.exe';
const OUTPUT_PATH = path.join(DIST_EXE, OUTPUT_NAME);
const SKIP_BUILD = process.argv.includes('--skip-build');

function log(msg) {
  console.log(`  ${msg}`);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  console.log('========================================');
  console.log('  ZViewer 前端 exe 构建');
  console.log('========================================');

  // 确保输出目录存在
  fs.mkdirSync(DIST_EXE, { recursive: true });

  // Step 1: 构建前端（如果 dist 不存在或未跳过）
  const frontendDist = path.join(FRONTEND, 'dist');
  if (!SKIP_BUILD) {
    if (!fs.existsSync(frontendDist)) {
      log('构建前端...');
      execSync('npm run build -w frontend', { cwd: ROOT, stdio: 'inherit' });
      log('前端构建完成');
    } else {
      log('前端构建产物已存在，跳过构建');
    }
  } else {
    log('跳过前端构建（--skip-build）');
  }

  // 确认前端构建产物存在
  if (!fs.existsSync(frontendDist) || !fs.existsSync(path.join(frontendDist, 'index.html'))) {
    console.error('  错误：前端构建产物不存在');
    console.error('  请先运行 npm run build -w frontend');
    process.exit(1);
  }

  // Step 2: 运行 pkg 打包（零外部依赖，无需安装任何包）
  const entry = path.join(FRONTEND_SERVER, 'server.js');
  log('打包为 exe（此过程可能耗时 1-3 分钟）...');
  log(`  入口: ${entry}`);
  log(`  输出: ${OUTPUT_PATH}`);

  const cmd = [
    'npx',
    'pkg',
    JSON.stringify(entry),
    `--targets`, `node22-win-x64`,
    `--output`, JSON.stringify(OUTPUT_PATH),
  ].join(' ');

  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });

  // Step 3: 验证
  if (!fs.existsSync(OUTPUT_PATH)) {
    console.error(`  错误：打包失败，未生成 ${OUTPUT_PATH}`);
    process.exit(1);
  }

  // Step 4: 复制前端构建产物到输出目录
  const outputFrontendDist = path.join(DIST_EXE, 'frontend', 'dist');
  log('复制前端构建产物...');
  if (fs.existsSync(outputFrontendDist)) {
    fs.rmSync(outputFrontendDist, { recursive: true, force: true });
  }
  copyDirSync(frontendDist, outputFrontendDist);
  log(`  已复制: frontend/dist/ (${getDirSize(outputFrontendDist)})`);

  const stats = fs.statSync(OUTPUT_PATH);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
  log(`构建完成！`);
  log(`  文件: ${OUTPUT_PATH}`);
  log(`  大小: ${sizeMB} MB`);
  log(`  前端静态文件: ${outputFrontendDist}`);
  console.log('========================================');
}

function getDirSize(dir) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile()) {
        size += fs.statSync(fullPath).size;
      }
    }
  } catch { /* ignore */ }
  return size > 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(1)} MB`
    : `${(size / 1024).toFixed(0)} KB`;
}

main();