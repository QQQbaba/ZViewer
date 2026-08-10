// 详细抓取 401 请求来源与 socket 状态
const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const page = await browser.newPage();

  const badResponses = [];
  page.on('response', (res) => {
    if (res.status() === 401) {
      badResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[console.${msg.type()}] ${msg.text().slice(0, 150)}`);
    }
  });

  await page.goto('http://localhost:4173', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // 登录
  await page.goto('http://localhost:4173/login', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const inputs = page.locator('input');
  await inputs.nth(0).fill('root');
  await inputs.nth(1).fill('root');
  await page.getByRole('button', { name: '登录' }).first().click();
  await page.waitForTimeout(6000);

  console.log('最终 URL:', page.url());
  console.log('\n=== 401 请求 ===');
  badResponses.forEach((r) => console.log(r));
  if (badResponses.length === 0) console.log('(无)');

  // socket 状态
  const socketState = await page.evaluate(() => {
    // 尝试读取页面上的 socket 状态（全局变量可能不存在）
    return { url: window.location.href, ready: document.readyState };
  }).catch(() => ({}));
  console.log('页面状态:', JSON.stringify(socketState));

  // localStorage
  const tokens = await page.evaluate(() => ({
    access: !!localStorage.getItem('zviewer-access-token'),
    refresh: !!localStorage.getItem('zviewer-refresh-token'),
  })).catch(() => ({}));
  console.log('tokens 存在:', JSON.stringify(tokens));

  await browser.close();
}
main().catch((e) => { console.error('异常:', e.message); process.exit(1); });
