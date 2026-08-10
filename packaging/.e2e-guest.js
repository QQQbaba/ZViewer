// 测试 guest 场景（未登录）的 socket 连接与页面状态
const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const page = await browser.newPage();

  const badResponses = [];
  const logs = [];
  page.on('response', (res) => {
    if (res.status() === 401 || res.status() === 403) {
      badResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });
  page.on('console', (msg) => {
    logs.push(`[${msg.type()}] ${msg.text().slice(0, 160)}`);
  });

  // 全新 context（无 token、无 cookie）→ guest 场景
  console.log('=== guest 场景（未登录访问首页）===');
  await page.goto('http://localhost:4173', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(8000);

  const bodyText = await page.locator('body').innerText().catch(() => '');
  console.log('URL:', page.url());
  console.log('包含"Socket 尚未连接":', bodyText.includes('Socket 尚未连接'));
  console.log('包含"Socket":', bodyText.includes('Socket'));

  const tokens = await page.evaluate(() => ({
    access: localStorage.getItem('zviewer-access-token')?.slice(0, 15) || null,
    refresh: localStorage.getItem('zviewer-refresh-token')?.slice(0, 15) || null,
  })).catch(() => ({}));
  console.log('guest tokens:', JSON.stringify(tokens));

  // socket 连接状态（通过 socket.io 客户端内部状态）
  const socketState = await page.evaluate(() => {
    // 尝试通过 performance 检查 socket.io 请求
    const entries = performance.getEntriesByType('resource')
      .filter((e) => e.name.includes('socket.io'))
      .map((e) => e.name.replace('http://localhost:4173', ''));
    return entries;
  }).catch(() => []);
  console.log('socket.io 请求:', JSON.stringify(socketState));

  await page.screenshot({ path: 'packaging/.e2e-guest.png' }).catch(() => {});

  console.log('\n=== 控制台日志（前 15 条）===');
  logs.slice(0, 15).forEach((l) => console.log(l));
  console.log('\n=== 401/403 请求 ===');
  badResponses.forEach((r) => console.log(r));

  await browser.close();
  console.log('\n测试完成');
}
main().catch((e) => { console.error('异常:', e.message); process.exit(1); });
