// 用 Playwright 驱动真实浏览器测试 localhost 登录 + socket 连接
const { chromium } = require('playwright');

async function main() {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
  } catch (e) {
    console.log('chrome channel 失败，尝试默认 chromium:', e.message.slice(0, 60));
    browser = await chromium.launch();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleErrors.push(`[${msg.type()}] ${msg.text().slice(0, 200)}`);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message.slice(0, 200)}`));

  // 1. 打开首页
  console.log('打开 http://localhost:4173 ...');
  await page.goto('http://localhost:4173', { waitUntil: 'networkidle', timeout: 15000 }).catch((e) => console.log('goto:', e.message.slice(0, 80)));

  // 2. 截图首页
  await page.screenshot({ path: 'packaging/.e2e-home.png' }).catch(() => {});
  console.log('首页标题:', await page.title().catch(() => 'N/A'));

  // 3. 导航到登录页
  await page.goto('http://localhost:4173/login', { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // 4. 填表单登录
  const inputs = page.locator('input');
  const count = await inputs.count();
  console.log('输入框数量:', count);
  if (count >= 2) {
    await inputs.nth(0).fill('root');
    await inputs.nth(1).fill('root');
    await page.screenshot({ path: 'packaging/.e2e-login-filled.png' }).catch(() => {});

    // 点登录按钮
    const loginBtn = page.getByRole('button', { name: '登录' });
    if (await loginBtn.count()) {
      await loginBtn.first().click();
      console.log('已点击登录按钮');
    } else {
      console.log('未找到登录按钮');
    }
  } else {
    // 可能已自动登录（guest），直接检查状态
    console.log('输入框不足，可能已登录');
  }

  // 5. 等待登录结果（跳转首页 或 出现错误）
  await page.waitForTimeout(5000);
  const url = page.url();
  console.log('当前 URL:', url);

  // 6. 抓取页面文本判断状态
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const hasSocketError = bodyText.includes('Socket 尚未连接') || bodyText.includes('Socket');
  const hasLoginSuccess = bodyText.includes('登录成功');
  const hasUserMenu = bodyText.includes('root') || bodyText.includes('账户');
  console.log('包含"Socket"相关文本:', hasSocketError);
  console.log('包含"登录成功":', hasLoginSuccess);
  console.log('包含用户信息:', hasUserMenu);

  await page.screenshot({ path: 'packaging/.e2e-after-login.png', fullPage: false }).catch(() => {});

  // 7. 检查 localStorage 中的 token
  const tokens = await page.evaluate(() => ({
    access: localStorage.getItem('zviewer-access-token')?.slice(0, 20) || null,
    refresh: localStorage.getItem('zviewer-refresh-token')?.slice(0, 20) || null,
  })).catch(() => ({ access: 'eval-error', refresh: null }));
  console.log('localStorage tokens:', JSON.stringify(tokens));

  // 8. 输出 console 错误
  console.log('\n=== 控制台错误/警告 ===');
  consoleErrors.slice(0, 12).forEach((e) => console.log(e));
  if (consoleErrors.length === 0) console.log('(无)');

  await browser.close();
  console.log('\n测试完成');
}
main().catch((e) => { console.error('脚本异常:', e.message); process.exit(1); });
