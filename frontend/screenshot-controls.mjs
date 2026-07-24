import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const url = process.argv[2] || 'http://localhost:5175/room/pdu13AEg'
const outPath = process.argv[3] || 'f:/Code/ZControl/frontend/screenshot-controls.png'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 })
  await page.waitForTimeout(3000)

  // 如果页面没有视频，尝试通过 localStorage / 直接调用接口添加一个测试视频，让播放器出现
  const hasVideo = await page.evaluate(() => {
    const video = document.querySelector('video')
    return !!video
  })

  if (!hasVideo) {
    console.log('No video element found; injecting a dummy video to reveal controls.')
    await page.evaluate(() => {
      const container = document.querySelector('[data-video-container]') || document.body
      const video = document.createElement('video')
      video.src = 'https://www.w3schools.com/html/mov_bbb.mp4'
      video.controls = false
      video.style.width = '100%'
      video.style.height = '100%'
      video.style.objectFit = 'contain'
      video.crossOrigin = 'anonymous'
      const target = document.querySelector('.video-player-container') ||
        document.querySelector('#video-player') ||
        document.querySelector('[class*="VideoPlayer"]') ||
        container.firstElementChild ||
        container
      if (target) {
        target.innerHTML = ''
        target.appendChild(video)
      }
    })
    await page.waitForTimeout(2000)
  }

  // 触发控制栏显示（模拟鼠标移动）
  await page.mouse.move(640, 600)
  await page.waitForTimeout(500)

  await page.screenshot({ path: outPath, fullPage: false })
  console.log('Screenshot saved to', outPath)
} catch (err) {
  console.error('Screenshot failed:', err)
  await page.screenshot({ path: outPath, fullPage: false })
} finally {
  await browser.close()
}
