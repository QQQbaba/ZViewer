const { chromium } = require('playwright')
const path = require('path')

;(async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()

  await page.goto('http://localhost:5175/room/s4XJkPNu', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)

  const outDir = 'c:\\Users\\Zero_\\AppData\\Local\\Temp\\trae\\screenshots'
  await page.screenshot({ path: path.join(outDir, 'playwright-initial.png'), fullPage: true })

  // 点击右上角侧栏按钮（展开侧栏图标）
  const toggleBtn = page.locator('button[title="展开侧栏"]').first()
  if (await toggleBtn.isVisible().catch(() => false)) {
    await toggleBtn.click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(outDir, 'playwright-open.png'), fullPage: true })
    console.log('clicked open')
  } else {
    console.log('open button not visible')
  }

  await browser.close()
})()
