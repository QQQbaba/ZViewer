#!/usr/bin/env node

/**
 * ZViewer 一键编译脚本。
 *
 * 交互式选择目标平台，自动完成前后端编译、pkg 打包、原生模块复制。
 *
 * 支持的目标平台：
 *   1) Windows  (win-x64)
 *   2) Linux    (linux-x64)
 *   3) 全平台   (以上全部)
 *   4) 自定义   (手动输入逗号分隔的 pkg target 列表)
 *
 * 用法：
 *   node build-all.js                # 交互式菜单
 *   node build-all.js --win          # 直接打包 Windows
 *   node build-all.js --linux        # 直接打包 Linux
 *   node build-all.js --all          # 直接打包全平台
 *   node build-all.js --skip-build   # 跳过 tsc/vite 编译
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ==================== 配置 ====================

const ROOT = path.resolve(__dirname);
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');
const FRONTEND_SERVER = path.join(ROOT, 'frontend-server');
const DIST_EXE = path.join(ROOT, 'dist');
const PKG_CONFIG = path.join(ROOT, 'package.json');
const PACKAGING_DIR = path.join(ROOT, 'packaging');

// pkg target 定义
const PLATFORM_TARGETS = {
  win: {
    label: 'Windows',
    folder: 'win',
    targets: ['node22-win-x64'],
  },
  linux: {
    label: 'Linux',
    folder: 'linux',
    targets: ['node22-linux-x64'],
  },
}

// 预定义平台组
const PLATFORM_PRESETS = [
  {
    key: 'win',
    label: 'Windows',
    description: 'node22-win-x64',
    platforms: ['win'],
  },
  {
    key: 'linux',
    label: 'Linux',
    description: 'node22-linux-x64',
    platforms: ['linux'],
  },
  {
    key: 'all',
    label: '全平台',
    description: 'Windows + Linux',
    platforms: ['win', 'linux'],
  },
]

const SKIP_BUILD = process.argv.includes('--skip-build');

// 命令行快捷方式
const CLI_SHORTCUTS = {
  '--win': ['win'],
  '--linux': ['linux'],
  '--all': ['win', 'linux'],
}

// 解析 --custom 参数
let CUSTOM_TARGETS = null;
const customIdx = process.argv.indexOf('--custom');
if (customIdx !== -1 && customIdx + 1 < process.argv.length) {
  CUSTOM_TARGETS = process.argv[customIdx + 1];
}

// ==================== 工具函数 ====================

function log(msg) {
  console.log(`  ${msg}`);
}

function warn(msg) {
  console.log(`  ⚠ ${msg}`);
}

function success(msg) {
  console.log(`  ✔ ${msg}`);
}

function error(msg) {
  console.log(`  ✘ ${msg}`);
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

function getDirSize(dir) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // 使用 entry.parentPath（Node.js 20+）构建完整路径
      const fullPath = entry.parentPath
        ? path.join(entry.parentPath, entry.name)
        : path.join(dir, entry.name);
      size += fs.statSync(fullPath).size;
    }
  } catch { /* ignore */ }
  return size > 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(1)} MB`
    : `${(size / 1024).toFixed(0)} KB`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ==================== 交互式菜单 ====================

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function showInteractiveMenu() {
  const rl = createInterface();

  console.log('');
  console.log('========================================');
  console.log('  ZViewer 一键编译');
  console.log('========================================');
  console.log('');

  // 第一步：选择平台
  console.log('请选择目标平台：');
  PLATFORM_PRESETS.forEach((p, i) => {
    console.log(`  ${i + 1}) ${p.label.padEnd(10)} ${p.description}`);
  });
  console.log('  4) 自定义 (手动输入 pkg target)');
  console.log('');

  let platformKeys = [];
  let valid = false;

  while (!valid) {
    const answer = await askQuestion(rl, '请输入编号 (1-4) [默认: 1]: ');
    const choice = answer || '1';
    const num = parseInt(choice, 10);

    if (num >= 1 && num <= 3) {
      platformKeys = PLATFORM_PRESETS[num - 1].platforms;
      valid = true;
    } else if (num === 5) {
      const custom = await askQuestion(rl, '请输入 pkg target (逗号分隔，如 "node22-win-x64,node22-linux-x64"): ');
      if (custom) {
        // 将自定义 target 映射到 platformKeys
        const targets = custom.split(',').map(t => t.trim());
        // 尝试匹配已知平台
        for (const target of targets) {
          let matched = false;
          for (const [key, def] of Object.entries(PLATFORM_TARGETS)) {
            if (def.targets.includes(target)) {
              if (!platformKeys.includes(key)) platformKeys.push(key);
              matched = true;
              break;
            }
          }
          if (!matched) {
            // 未知 target，创建临时平台定义
            const folderName = target.replace(/[^a-z0-9]/g, '-');
            PLATFORM_TARGETS[`custom-${folderName}`] = {
              label: target,
              folder: `custom-${folderName}`,
              targets: [target],
            };
            platformKeys.push(`custom-${folderName}`);
          }
        }
        valid = true;
      }
    } else {
      console.log('  无效输入，请输入 1-4');
    }
  }

  // 第二步：确认是否构建前端
  const buildFrontend = await askQuestion(rl, '是否构建前端 (y/n) [默认: y]: ');
  const shouldBuildFrontend = buildFrontend !== 'n' && buildFrontend !== 'N';

  // 第三步：确认是否构建后端
  const buildBackend = await askQuestion(rl, '是否构建后端 (y/n) [默认: y]: ');
  const shouldBuildBackend = buildBackend !== 'n' && buildBackend !== 'N';

  rl.close();

  return { platformKeys, shouldBuildFrontend, shouldBuildBackend };
}

// ==================== 构建逻辑 ====================

function getPlatformDetails(platformKeys) {
  return platformKeys.map(key => {
    const def = PLATFORM_TARGETS[key];
    if (!def) throw new Error(`未知平台: ${key}`);
    return def;
  });
}

function buildFrontend() {
  console.log('');
  console.log('>>> 构建前端静态资源...');
  const frontendDist = path.join(FRONTEND, 'dist');
  if (!SKIP_BUILD) {
    log('运行 vite build...');
    execSync('npm run build -w frontend', { cwd: ROOT, stdio: 'inherit' });
    success('前端构建完成');
  } else {
    if (!fs.existsSync(frontendDist) || !fs.existsSync(path.join(frontendDist, 'index.html'))) {
      error('前端构建产物不存在，无法跳过构建');
      process.exit(1);
    }
    log('跳过前端构建 (--skip-build)');
  }

  // 确认产物存在
  if (!fs.existsSync(frontendDist) || !fs.existsSync(path.join(frontendDist, 'index.html'))) {
    error('前端构建失败：未生成 index.html');
    process.exit(1);
  }
  return frontendDist;
}

function buildBackend() {
  console.log('');
  console.log('>>> 编译后端 TypeScript...');
  const backendDist = path.join(BACKEND, 'dist', 'index.js');
  if (!SKIP_BUILD) {
    log('运行 tsc...');
    execSync('npm run build', { cwd: BACKEND, stdio: 'inherit' });
    success('TypeScript 编译完成');
  } else {
    if (!fs.existsSync(backendDist)) {
      error('后端编译产物不存在，无法跳过构建');
      process.exit(1);
    }
    log('跳过后端编译 (--skip-build)');
  }

  if (!fs.existsSync(backendDist)) {
    error('后端编译失败：未生成 dist/index.js');
    process.exit(1);
  }
  return backendDist;
}

function packageFrontend(targetPlatforms, frontendDist) {
  console.log('');
  console.log('>>> 打包前端服务 exe...');

  // 清理 frontend-server/node_modules 残留
  const frontendServerNodeModules = path.join(FRONTEND_SERVER, 'node_modules');
  if (fs.existsSync(frontendServerNodeModules)) {
    log('清理 frontend-server/node_modules...');
    fs.rmSync(frontendServerNodeModules, { recursive: true, force: true });
  }

  const entry = path.join(FRONTEND_SERVER, 'server.js');
  if (!fs.existsSync(entry)) {
    error(`前端服务入口不存在: ${entry}`);
    process.exit(1);
  }

  const results = [];

  for (const platform of targetPlatforms) {
    for (const target of platform.targets) {
      const outputFolder = path.join(DIST_EXE, platform.folder);
      const outputName = `zviewer-frontend${target.includes('win') ? '.exe' : ''}`;
      const outputPath = path.join(outputFolder, outputName);

      fs.mkdirSync(outputFolder, { recursive: true });

      log(`打包前端 → ${target} (${platform.label})...`);

      const cmd = [
        'npx', 'pkg',
        JSON.stringify(entry),
        '--targets', target,
        '--output', JSON.stringify(outputPath),
      ].join(' ');

      try {
        execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
      } catch (e) {
        warn(`前端打包失败 (${target}): ${e.message}`);
        continue;
      }

      if (!fs.existsSync(outputPath)) {
        warn(`前端打包失败：未生成 ${outputPath}`);
        continue;
      }

      // 复制前端静态资源
      const outputFrontendDist = path.join(outputFolder, 'frontend', 'dist');
      if (fs.existsSync(outputFrontendDist)) {
        fs.rmSync(outputFrontendDist, { recursive: true, force: true });
      }
      copyDirSync(frontendDist, outputFrontendDist);

      const stats = fs.statSync(outputPath);
      results.push({
        type: '前端',
        platform: platform.label,
        target,
        path: outputPath,
        size: stats.size,
      });
      success(`前端 ${target}: ${outputPath} (${formatBytes(stats.size)})`);
    }
  }

  return results;
}

function packageBackend(targetPlatforms) {
  console.log('');
  console.log('>>> 打包后端 exe...');

  const entry = path.join(BACKEND, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    error(`后端入口不存在: ${entry}`);
    process.exit(1);
  }

  // 原生模块复制
  const sqliteSrc = path.join(ROOT, 'node_modules', 'better-sqlite3');
  const hasSqlite = fs.existsSync(sqliteSrc);

  const results = [];

  for (const platform of targetPlatforms) {
    for (const target of platform.targets) {
      const outputFolder = path.join(DIST_EXE, platform.folder);
      const outputName = `zviewer-backend${target.includes('win') ? '.exe' : ''}`;
      const outputPath = path.join(outputFolder, outputName);

      fs.mkdirSync(outputFolder, { recursive: true });

      log(`打包后端 → ${target} (${platform.label})...`);

      const cmd = [
        'npx', 'pkg',
        JSON.stringify(entry),
        '--targets', target,
        '--output', JSON.stringify(outputPath),
        '-c', JSON.stringify(PKG_CONFIG),
      ].join(' ');

      try {
        execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
      } catch (e) {
        warn(`后端打包失败 (${target}): ${e.message}`);
        continue;
      }

      if (!fs.existsSync(outputPath)) {
        warn(`后端打包失败：未生成 ${outputPath}`);
        continue;
      }

      // 复制 better-sqlite3 原生模块
      if (hasSqlite) {
        const sqliteDest = path.join(outputFolder, 'node_modules', 'better-sqlite3');
        log('复制 better-sqlite3 原生模块...');
        if (fs.existsSync(sqliteDest)) {
          fs.rmSync(sqliteDest, { recursive: true, force: true });
        }
        copyDirSync(sqliteSrc, sqliteDest);
        success('已复制 better-sqlite3');
      }

      // 复制后端 .env（如果存在）；单文件版端口已固定，过滤掉 PORT 行
      const envSrc = path.join(BACKEND, '.env');
      const envDest = path.join(outputFolder, '.env');
      if (fs.existsSync(envSrc) && !fs.existsSync(envDest)) {
        const envContent = fs.readFileSync(envSrc, 'utf8');
        const filtered = envContent
          .split('\n')
          .filter((line) => !/^\s*PORT\s*=/.test(line))
          .join('\n');
        fs.writeFileSync(envDest, filtered, 'utf8');
        log('已复制 .env 配置模板（已移除 PORT，端口固定为 3333）');
      }

      const stats = fs.statSync(outputPath);
      results.push({
        type: '后端',
        platform: platform.label,
        target,
        path: outputPath,
        size: stats.size,
      });
      success(`后端 ${target}: ${outputPath} (${formatBytes(stats.size)})`);
    }
  }

  return results;
}

// 打包证书生成工具（zviewer-cert），供产物目录的一键启动脚本签证书使用
function packageCertTool(targetPlatforms) {
  console.log('');
  console.log('>>> 打包证书工具 zviewer-cert...');

  const entry = path.join(ROOT, 'scripts', 'generate-cert.js');
  if (!fs.existsSync(entry)) {
    warn(`证书工具入口不存在: ${entry}`);
    return;
  }

  for (const platform of targetPlatforms) {
    for (const target of platform.targets) {
      const outputFolder = path.join(DIST_EXE, platform.folder);
      const outputName = `zviewer-cert${target.includes('win') ? '.exe' : ''}`;
      const outputPath = path.join(outputFolder, outputName);

      fs.mkdirSync(outputFolder, { recursive: true });

      log(`打包证书工具 → ${target}...`);

      const cmd = [
        'npx', 'pkg',
        JSON.stringify(entry),
        '--targets', target,
        '--output', JSON.stringify(outputPath),
      ].join(' ');

      try {
        execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
        success(`证书工具 ${target}: ${outputPath}`);
      } catch (e) {
        warn(`证书工具打包失败 (${target}): ${e.message}`);
      }
    }
  }
}

// Copy per-platform one-click start scripts into the output folders.
function copyStartScripts(targetPlatforms) {
  // 每个平台可复制多个文件（Windows: bat 转发器 + ps1 主逻辑）
  const scriptMap = {
    win: [
      { src: 'start-win.bat', dest: 'start.bat' },
      { src: 'start-win.ps1', dest: 'start.ps1' },
    ],
    linux: [{ src: 'start-linux.sh', dest: 'start.sh' }],
  };

  const folders = [];
  for (const p of targetPlatforms) {
    if (!folders.includes(p.folder)) folders.push(p.folder);
  }

  for (const folder of folders) {
    const files = scriptMap[folder];
    if (!files) {
      warn(`skip start script: unknown folder ${folder}`);
      continue;
    }
    const outputFolder = path.join(DIST_EXE, folder);
    fs.mkdirSync(outputFolder, { recursive: true });

    for (const mapping of files) {
      const srcPath = path.join(PACKAGING_DIR, mapping.src);
      if (!fs.existsSync(srcPath)) {
        warn(`start script template not found: ${srcPath}`);
        continue;
      }
      const destPath = path.join(outputFolder, mapping.dest);
      fs.copyFileSync(srcPath, destPath);
      // Set executable permission on Unix-like build hosts (no-op on Windows)
      if (mapping.dest.endsWith('.sh') || mapping.dest.endsWith('.command')) {
        try { fs.chmodSync(destPath, 0o755); } catch { /* ignore on non-Unix hosts */ }
      }
      success(`start script: ${folder}/${mapping.dest}`);
    }
  }
}

function printSummary(allResults) {
  console.log('');
  console.log('========================================');
  console.log('  编译完成');
  console.log('========================================');

  // 按文件夹分组
  const grouped = {};
  for (const r of allResults) {
    const folder = path.dirname(r.path);
    if (!grouped[folder]) grouped[folder] = { files: [], folder };
    grouped[folder].files.push(r);
  }

  for (const [folderPath, group] of Object.entries(grouped)) {
    const folderName = path.relative(DIST_EXE, folderPath);
    const totalSize = group.files.reduce((sum, f) => sum + f.size, 0);
    console.log('');
    console.log(`  📁 ${folderName}/`);
    console.log(`     大小: ${formatBytes(totalSize)}`);

    for (const f of group.files) {
      const filename = path.basename(f.path);
      console.log(`      ${f.type.padEnd(6)} ${filename.padEnd(30)} ${formatBytes(f.size)}`);
    }
  }

  console.log('');
  console.log('  输出目录: ' + DIST_EXE);
  console.log('========================================');
}

// ==================== 主入口 ====================

async function main() {
  console.log('========================================');
  console.log('  ZViewer 一键编译工具');
  console.log('========================================');
  console.log(`  工作目录: ${ROOT}`);
  console.log(`  编译模式: ${SKIP_BUILD ? '跳过编译 (--skip-build)' : '完整编译'}`);
  console.log('========================================');

  // 解析命令行参数或交互式选择
  let platformKeys = null;
  let shouldBuildFrontend = true;
  let shouldBuildBackend = true;
  let isCustom = false;

  // 优先处理 --custom 自定义 target
  if (CUSTOM_TARGETS) {
    isCustom = true;
    platformKeys = [];
    const targets = CUSTOM_TARGETS.split(',').map(t => t.trim());
    for (const target of targets) {
      let matched = false;
      for (const [key, def] of Object.entries(PLATFORM_TARGETS)) {
        if (def.targets.includes(target)) {
          if (!platformKeys.includes(key)) platformKeys.push(key);
          matched = true;
          break;
        }
      }
      if (!matched) {
        const folderName = target.replace(/[^a-z0-9]/g, '-');
        PLATFORM_TARGETS[`custom-${folderName}`] = {
          label: target,
          folder: `custom-${folderName}`,
          targets: [target],
        };
        platformKeys.push(`custom-${folderName}`);
      }
    }
    console.log(`  命令行模式: --custom ${CUSTOM_TARGETS}`);
    console.log(`  目标平台: ${targets.join(', ')}`);
    console.log('');
  }

  if (!platformKeys) {
    for (const [flag, keys] of Object.entries(CLI_SHORTCUTS)) {
      if (process.argv.includes(flag)) {
        platformKeys = keys;
        break;
      }
    }
  }

  if (platformKeys && !isCustom) {
    console.log(`  命令行模式: ${process.argv.find(a => a.startsWith('--') && a !== '--skip-build')}`);
    console.log(`  目标平台: ${platformKeys.map(k => PLATFORM_TARGETS[k]?.label || k).join(', ')}`);
    console.log('');
  } else if (!platformKeys) {
    const menu = await showInteractiveMenu();
    platformKeys = menu.platformKeys;
    shouldBuildFrontend = menu.shouldBuildFrontend;
    shouldBuildBackend = menu.shouldBuildBackend;
  }

  const targetPlatforms = getPlatformDetails(platformKeys);
  console.log('');
  console.log(`目标平台: ${targetPlatforms.map(p => p.label).join(', ')}`);
  console.log(`pkg targets: ${targetPlatforms.flatMap(p => p.targets).join(', ')}`);
  console.log('');

  const allResults = [];

  // 1. 构建前端
  let frontendDist = null;
  if (shouldBuildFrontend) {
    frontendDist = buildFrontend();
  } else {
    frontendDist = path.join(FRONTEND, 'dist');
    if (!fs.existsSync(frontendDist) || !fs.existsSync(path.join(frontendDist, 'index.html'))) {
      error('前端构建产物不存在');
      process.exit(1);
    }
    log('使用现有前端构建产物');
  }

  // 2. 构建后端
  if (shouldBuildBackend) {
    buildBackend();
  } else {
    const backendDist = path.join(BACKEND, 'dist', 'index.js');
    if (!fs.existsSync(backendDist)) {
      error('后端编译产物不存在');
      process.exit(1);
    }
    log('使用现有后端编译产物');
  }

  // 3. 打包前端 exe
  if (shouldBuildFrontend) {
    const frontendResults = packageFrontend(targetPlatforms, frontendDist);
    allResults.push(...frontendResults);
  }

  // 4. 打包后端 exe
  if (shouldBuildBackend) {
    const backendResults = packageBackend(targetPlatforms);
    allResults.push(...backendResults);
  }

  // 5. 输出汇总

  // 打包证书生成工具（一键启动脚本用它签证书）
  packageCertTool(targetPlatforms);

  // 复制各平台一键启动脚本到产物目录
  copyStartScripts(targetPlatforms);

  if (allResults.length > 0) {
    printSummary(allResults);
  } else {
    warn('没有生成任何文件');
  }
}

main().catch((err) => {
  console.error('');
  console.error('  错误:', err.message);
  process.exit(1);
});
