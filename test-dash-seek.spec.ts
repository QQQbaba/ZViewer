import { test, expect, chromium, type Page, type BrowserContext } from '@playwright/test'

const FRONTEND_URL = 'http://localhost:5175/'
const BILIBILI_VIDEO_URL = 'https://www.bilibili.com/video/BV1HQTs6FEos'

interface TestResult {
  sidxFound: boolean
  sidxRange?: string
  seek300Success: boolean
  seek300Details?: any
  seek720Success: boolean
  seek720Details?: any
  seekEndSuccess: boolean
  seekEndDetails?: any
  has206Requests: boolean
  rangeRequests?: any[]
  seekTimeoutErrors: string[]
  consoleErrors: string[]
  screenshots: Record<string, string>
}

const result: TestResult = {
  sidxFound: false,
  seek300Success: false,
  seek720Success: false,
  seekEndSuccess: false,
  has206Requests: false,
  rangeRequests: [],
  seekTimeoutErrors: [],
  consoleErrors: [],
  screenshots: {},
}

async function getVideoState(page: Page) {
  return await page.evaluate(() => {
    const v = document.querySelector('video')
    if (!v) return null
    return {
      currentTime: v.currentTime.toFixed(1),
      duration: v.duration,
      readyState: v.readyState,
      paused: v.paused,
      error: v.error ? { code: v.error.code, message: v.error.message } : null,
      buffered: Array.from({ length: v.buffered.length }, (_, i) => 
        `${v.buffered.start(i).toFixed(1)}-${v.buffered.end(i).toFixed(1)}`
      ).join(', '),
      currentSrc: v.currentSrc,
    }
  })
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test.describe('Dash.js 长视频 Seek 测试', () => {
  let page: Page
  let context: BrowserContext

  test.beforeAll(async () => {
    const browser = await chromium.launch({
      headless: false,
      args: ['--start-maximized'],
    })
    context = await browser.newContext({
      viewport: null,
      ignoreHTTPSErrors: true,
    })
    page = await context.newPage()

    page.on('console', msg => {
      const text = msg.text()
      if (msg.type() === 'error') {
        result.consoleErrors.push(text)
      }
      if (text.includes('sidx') || text.includes('Sidx') || text.includes('SIDX')) {
        console.log('[sidx 日志]', text)
        if (text.includes('找到 sidx')) {
          result.sidxFound = true
          const match = text.match(/range=([\d-]+)/)
          if (match) {
            result.sidxRange = match[1]
          }
        }
      }
      if (text.includes('seek 超时') || text.includes('seek 失败')) {
        result.seekTimeoutErrors.push(text)
      }
    })

    page.on('response', response => {
      const url = response.url()
      if (url.includes('proxy') && url.includes('.m4s')) {
        const status = response.status()
        const headers = response.headers()
        if (status === 206) {
          result.has206Requests = true
          result.rangeRequests.push({
            url: url.substring(0, 100),
            status,
            range: headers['content-range'] || '',
          })
        }
      }
    })
  })

  test.afterAll(async () => {
    console.log('\n========== 测试结果汇总 ==========')
    console.log('1. sidx 找到:', result.sidxFound)
    if (result.sidxRange) console.log('   sidx range:', result.sidxRange)
    console.log('2. seek 到 300s 成功:', result.seek300Success)
    if (result.seek300Details) console.log('   详情:', JSON.stringify(result.seek300Details, null, 2))
    console.log('3. seek 到 720s 成功:', result.seek720Success)
    if (result.seek720Details) console.log('   详情:', JSON.stringify(result.seek720Details, null, 2))
    console.log('4. seek 到末尾成功:', result.seekEndSuccess)
    if (result.seekEndDetails) console.log('   详情:', JSON.stringify(result.seekEndDetails, null, 2))
    console.log('5. 有 206 Range 请求:', result.has206Requests)
    console.log('   请求数:', result.rangeRequests.length)
    console.log('6. seek 超时错误数:', result.seekTimeoutErrors.length)
    if (result.seekTimeoutErrors.length > 0) {
      result.seekTimeoutErrors.forEach(e => console.log('   -', e.substring(0, 200)))
    }
    console.log('7. 控制台错误数:', result.consoleErrors.length)
    console.log('8. 截图:', result.screenshots)
    console.log('========================================\n')

    await context.close()
  })

  test('步骤1：打开前端页面并刷新', async () => {
    await page.goto(FRONTEND_URL)
    await page.waitForLoadState('networkidle')
    await delay(2000)
    
    await page.reload()
    await page.waitForLoadState('networkidle')
    await delay(2000)
    
    console.log('[步骤1] 页面已加载并刷新')
  })

  test('步骤2：进入房间', async () => {
    const currentUrl = page.url()
    console.log('[步骤2] 当前 URL:', currentUrl)

    if (currentUrl.includes('/room')) {
      console.log('[步骤2] 已在房间页面')
    } else {
      const startButton = page.getByRole('button', { name: /开始共享|创建房间|一起看/ })
      if (await startButton.isVisible({ timeout: 3000 })) {
        await startButton.click()
        await page.waitForLoadState('networkidle')
        await delay(3000)
        console.log('[步骤2] 已点击开始共享按钮')
      } else {
        const roomsButton = page.getByRole('button', { name: /房间列表/ })
        if (await roomsButton.isVisible({ timeout: 3000 })) {
          await roomsButton.click()
          await page.waitForLoadState('networkidle')
          await delay(2000)
          
          const joinButtons = page.getByRole('button', { name: /加入房间/ })
          const count = await joinButtons.count()
          if (count > 0) {
            await joinButtons.first().click()
            await page.waitForLoadState('networkidle')
            await delay(3000)
            console.log('[步骤2] 已加入第一个房间')
          } else {
            console.log('[步骤2] 没有可用房间，尝试直接访问 /room')
            await page.goto(FRONTEND_URL + 'room')
            await page.waitForLoadState('networkidle')
            await delay(3000)
          }
        } else {
          console.log('[步骤2] 尝试直接访问房间页面')
          await page.goto(FRONTEND_URL + 'room')
          await page.waitForLoadState('networkidle')
          await delay(3000)
        }
      }
    }

    const finalUrl = page.url()
    console.log('[步骤2] 最终 URL:', finalUrl)
    
    await page.screenshot({ path: 'test-screenshots/step2-room-page.png', fullPage: true })
    result.screenshots['step2-room'] = 'test-screenshots/step2-room-page.png'
  })

  test('步骤3：添加 B站视频', async () => {
    await delay(2000)
    
    const urlInput = page.getByPlaceholder(/请输入视频地址|B站链接|视频链接/)
    if (await urlInput.isVisible({ timeout: 5000 })) {
      await urlInput.fill(BILIBILI_VIDEO_URL)
      console.log('[步骤3] 已输入视频链接')
      
      const resolveButton = page.getByRole('button', { name: /解析|获取|添加|播放/ })
      if (await resolveButton.first().isVisible({ timeout: 3000 })) {
        await resolveButton.first().click()
        console.log('[步骤3] 已点击解析按钮')
        await delay(8000)
      }
    } else {
      console.log('[步骤3] 没找到输入框，尝试点击影片相关按钮')
      const movieButtons = page.getByRole('button', { name: /影片|添加|推送|movie/i })
      const count = await movieButtons.count()
      for (let i = 0; i < count; i++) {
        console.log(`[步骤3] 找到按钮 ${i}:`, await movieButtons.nth(i).textContent())
      }
      
      if (count > 0) {
        await movieButtons.first().click()
        await delay(2000)
        
        const urlInput2 = page.getByPlaceholder(/请输入视频地址|B站链接|视频链接/)
        if (await urlInput2.isVisible({ timeout: 3000 })) {
          await urlInput2.fill(BILIBILI_VIDEO_URL)
          console.log('[步骤3] 已在面板中输入视频链接')
          
          const resolveButton2 = page.getByRole('button', { name: /解析|获取|添加/ })
          if (await resolveButton2.first().isVisible({ timeout: 3000 })) {
            await resolveButton2.first().click()
            console.log('[步骤3] 已点击解析按钮')
            await delay(8000)
          }
        }
      }
    }

    await page.screenshot({ path: 'test-screenshots/step3-after-add.png', fullPage: true })
    result.screenshots['step3-after-add'] = 'test-screenshots/step3-after-add.png'
  })

  test('步骤4：等待视频加载并检查 sidx 日志', async () => {
    console.log('[步骤4] 等待视频加载...')
    await delay(5000)
    
    const videoState = await getVideoState(page)
    console.log('[步骤4] 视频初始状态:', JSON.stringify(videoState, null, 2))
    
    console.log('[步骤4] sidx 找到:', result.sidxFound)
    if (result.sidxRange) {
      console.log('[步骤4] sidx range:', result.sidxRange)
    }
    
    await page.screenshot({ path: 'test-screenshots/step4-initial-state.png' })
    result.screenshots['step4-initial'] = 'test-screenshots/step4-initial-state.png'
  })

  test('步骤5：测试 seek 到 5 分钟（300s）', async () => {
    console.log('[测试1] 开始 seek 到 300s...')
    
    const beforeState = await getVideoState(page)
    console.log('[测试1] seek 前状态:', JSON.stringify(beforeState, null, 2))
    
    await page.evaluate(() => {
      const v = document.querySelector('video')
      if (v) v.currentTime = 300
    })
    
    console.log('[测试1] 已设置 currentTime = 300，等待 8 秒...')
    await delay(8000)
    
    const afterState = await getVideoState(page)
    console.log('[测试1] seek 后状态:', JSON.stringify(afterState, null, 2))
    
    result.seek300Details = afterState
    if (afterState && Math.abs(Number(afterState.currentTime) - 300) < 30 && afterState.buffered && afterState.buffered.length > 0) {
      result.seek300Success = true
    }
    
    await page.screenshot({ path: 'test-screenshots/step5-seek-300s.png' })
    result.screenshots['step5-seek300'] = 'test-screenshots/step5-seek-300s.png'
  })

  test('步骤6：测试 seek 到 12 分钟（720s）', async () => {
    console.log('[测试2] 开始 seek 到 720s...')
    
    await page.evaluate(() => {
      const v = document.querySelector('video')
      if (v) v.currentTime = 720
    })
    
    console.log('[测试2] 已设置 currentTime = 720，等待 10 秒...')
    await delay(10000)
    
    const afterState = await getVideoState(page)
    console.log('[测试2] seek 后状态:', JSON.stringify(afterState, null, 2))
    
    result.seek720Details = afterState
    if (afterState && Math.abs(Number(afterState.currentTime) - 720) < 60 && afterState.buffered && afterState.buffered.length > 0) {
      result.seek720Success = true
    }
    
    await page.screenshot({ path: 'test-screenshots/step6-seek-720s.png' })
    result.screenshots['step6-seek720'] = 'test-screenshots/step6-seek-720s.png'
  })

  test('步骤7：测试 seek 到接近末尾', async () => {
    console.log('[测试3] 开始 seek 到接近末尾...')
    
    const duration = await page.evaluate(() => {
      const v = document.querySelector('video')
      return v ? v.duration : 0
    })
    
    console.log('[测试3] 视频时长:', duration, '秒')
    
    await page.evaluate(() => {
      const v = document.querySelector('video')
      if (v && v.duration) v.currentTime = v.duration - 60
    })
    
    console.log('[测试3] 已设置到末尾前 60 秒，等待 10 秒...')
    await delay(10000)
    
    const afterState = await getVideoState(page)
    console.log('[测试3] seek 后状态:', JSON.stringify(afterState, null, 2))
    
    result.seekEndDetails = afterState
    if (afterState && duration && Number(afterState.currentTime) > duration - 120 && afterState.buffered && afterState.buffered.length > 0) {
      result.seekEndSuccess = true
    }
    
    await page.screenshot({ path: 'test-screenshots/step7-seek-end.png' })
    result.screenshots['step7-seekend'] = 'test-screenshots/step7-seek-end.png'
  })

  test('步骤8：检查 Network 和控制台', async () => {
    console.log('[步骤8] 206 Range 请求数:', result.rangeRequests.length)
    result.rangeRequests.forEach((req, i) => {
      console.log(`  [${i}] ${req.url} - ${req.status} - ${req.range}`)
    })
    
    console.log('[步骤8] seek 超时错误:', result.seekTimeoutErrors)
    console.log('[步骤8] 控制台错误数:', result.consoleErrors.length)
  })
})
