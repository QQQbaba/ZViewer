import { chromium } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const FRONTEND_URL = 'http://localhost:5175/'
const BILIBILI_VIDEO_URL = 'https://www.bilibili.com/video/BV1HQTs6FEos'

const result = {
  sidxFound: false,
  sidxRange: null,
  sidxReferences: 0,
  seek300Success: false,
  seek300Details: null,
  seek720Success: false,
  seek720Details: null,
  seekEndSuccess: false,
  seekEndDetails: null,
  has206Requests: false,
  rangeRequests: [],
  seekTimeoutErrors: [],
  consoleErrors: [],
  consoleLogs: [],
  screenshots: {},
}

const screenshotDir = 'test-screenshots'
if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getVideoState(page) {
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
      currentSrc: v.currentSrc ? v.currentSrc.substring(0, 100) : '',
      networkState: v.networkState,
    }
  })
}

async function takeScreenshot(page, name) {
  const filePath = path.join(screenshotDir, `${name}.png`)
  await page.screenshot({ path: filePath })
  result.screenshots[name] = filePath
  console.log(`[截图] ${name} -> ${filePath}`)
}

async function main() {
  console.log('========== Dash.js 长视频 Seek 测试 ==========\n')
  
  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  })
  
  const context = await browser.newContext({
    viewport: null,
    ignoreHTTPSErrors: true,
  })
  
  const page = await context.newPage()

  page.on('console', msg => {
    const text = msg.text()
    const type = msg.type()
    
    if (type === 'error') {
      result.consoleErrors.push(text)
    }
    
    if (text.includes('sidx') || text.includes('Sidx') || text.includes('SIDX')) {
      console.log(`[控制台-${type}] [sidx相关] ${text.substring(0, 300)}`)
      result.consoleLogs.push({ type, text: text.substring(0, 500) })
      
      if (text.includes('找到 sidx') || text.includes('Found sidx')) {
        result.sidxFound = true
        const rangeMatch = text.match(/range=([\d-]+)/)
        if (rangeMatch) {
          result.sidxRange = rangeMatch[1]
        }
        const refMatch = text.match(/references=(\d+)/)
        if (refMatch) {
          result.sidxReferences = parseInt(refMatch[1], 10)
        }
      }
    }
    
    if (text.includes('seek 超时') || text.includes('seek 失败') || text.includes('seek timeout')) {
      console.log(`[控制台-${type}] [seek错误] ${text.substring(0, 300)}`)
      result.seekTimeoutErrors.push(text)
    }
  })

  page.on('response', response => {
    const url = response.url()
    if (url.includes('proxy') && (url.includes('.m4s') || url.includes('m4s'))) {
      const status = response.status()
      const headers = response.headers()
      if (status === 206) {
        result.has206Requests = true
        result.rangeRequests.push({
          url: url.substring(0, 120),
          status,
          range: headers['content-range'] || '',
        })
      }
    }
  })

  try {
    // 步骤1：打开页面并刷新
    console.log('[步骤1] 打开前端页面...')
    await page.goto(FRONTEND_URL, { waitUntil: 'networkidle' })
    await delay(2000)
    
    console.log('[步骤1] 刷新页面确保加载新代码...')
    await page.reload({ waitUntil: 'networkidle' })
    await delay(2000)
    
    await takeScreenshot(page, 'step1-homepage')
    console.log('[步骤1] 完成\n')

    // 步骤2：进入房间
    console.log('[步骤2] 进入房间...')
    const currentUrl = page.url()
    console.log('[步骤2] 当前 URL:', currentUrl)

    if (!currentUrl.includes('/room')) {
      console.log('[步骤2] 尝试点击"开始共享"按钮...')
      
      const allButtons = await page.$$('button')
      console.log(`[步骤2] 页面有 ${allButtons.length} 个按钮`)
      
      for (let i = 0; i < Math.min(allButtons.length, 10); i++) {
        const text = await allButtons[i].innerText()
        console.log(`  按钮 ${i}: ${text.substring(0, 30)}`)
      }
      
      const startBtn = page.getByRole('button', { name: /开始共享|创建房间/ })
      if (await startBtn.count() > 0) {
        await startBtn.first().click()
        console.log('[步骤2] 已点击开始共享')
        await page.waitForLoadState('networkidle')
        await delay(5000)
      } else {
        console.log('[步骤2] 没找到开始共享按钮，尝试直接访问 /room')
        await page.goto(FRONTEND_URL + 'room', { waitUntil: 'networkidle' })
        await delay(5000)
      }
    }
    
    console.log('[步骤2] 房间页面 URL:', page.url())
    await takeScreenshot(page, 'step2-room')
    console.log('[步骤2] 完成\n')

    // 步骤3：添加 B 站视频
    console.log('[步骤3] 添加 B 站视频...')
    
    const inputs = await page.$$('input')
    console.log(`[步骤3] 页面有 ${inputs.length} 个输入框`)
    
    let urlInputFound = false
    
    for (const input of inputs) {
      const placeholder = await input.getAttribute('placeholder') || ''
      const type = await input.getAttribute('type') || ''
      if (placeholder.includes('视频') || placeholder.includes('B站') || placeholder.includes('bilibili') || placeholder.includes('地址') || placeholder.includes('链接')) {
        console.log(`[步骤3] 找到输入框: placeholder="${placeholder}", type="${type}"`)
        
        await input.fill(BILIBILI_VIDEO_URL)
        urlInputFound = true
        console.log('[步骤3] 已填入视频链接')
        
        await delay(1000)
        
        const resolveBtn = page.getByRole('button', { name: /解析|获取|添加|播放/ })
        if (await resolveBtn.count() > 0) {
          await resolveBtn.first().click()
          console.log('[步骤3] 已点击解析按钮')
        }
        break
      }
    }
    
    if (!urlInputFound) {
      console.log('[步骤3] 没找到直接的输入框，尝试点击侧边栏按钮...')
      
      const allButtons = await page.$$('button')
      for (const btn of allButtons) {
        const text = await btn.innerText()
        if (text.includes('影片') || text.includes('添加') || text.includes('推送') || text.includes('列表')) {
          console.log(`[步骤3] 找到候选按钮: ${text.substring(0, 30)}`)
        }
      }
      
      const movieBtn = page.getByRole('button', { name: /影片|添加|推送/ })
      if (await movieBtn.count() > 0) {
        await movieBtn.first().click()
        await delay(2000)
        console.log('[步骤3] 已点击影片相关按钮')
        
        const inputs2 = await page.$$('input')
        for (const input of inputs2) {
          const placeholder = await input.getAttribute('placeholder') || ''
          if (placeholder.includes('视频') || placeholder.includes('B站') || placeholder.includes('地址') || placeholder.includes('链接')) {
            console.log(`[步骤3] 在面板中找到输入框: ${placeholder}`)
            await input.fill(BILIBILI_VIDEO_URL)
            urlInputFound = true
            console.log('[步骤3] 已填入视频链接')
            
            const resolveBtn2 = page.getByRole('button', { name: /解析|获取|添加/ })
            if (await resolveBtn2.count() > 0) {
              await resolveBtn2.first().click()
              console.log('[步骤3] 已点击解析按钮')
            }
            break
          }
        }
      }
    }
    
    console.log('[步骤3] 等待解析和加载...')
    await delay(10000)
    
    await takeScreenshot(page, 'step3-after-add')
    console.log('[步骤3] 完成\n')

    // 步骤4：检查初始状态和 sidx 日志
    console.log('[步骤4] 检查初始状态...')
    console.log('[步骤4] sidx 找到:', result.sidxFound)
    if (result.sidxRange) console.log('[步骤4] sidx range:', result.sidxRange)
    if (result.sidxReferences > 0) console.log('[步骤4] sidx references:', result.sidxReferences)
    
    const initialState = await getVideoState(page)
    console.log('[步骤4] 视频初始状态:')
    if (initialState) {
      console.log('  currentTime:', initialState.currentTime)
      console.log('  duration:', initialState.duration)
      console.log('  readyState:', initialState.readyState)
      console.log('  paused:', initialState.paused)
      console.log('  buffered:', initialState.buffered)
      console.log('  networkState:', initialState.networkState)
    } else {
      console.log('  未找到 video 元素')
    }
    
    await takeScreenshot(page, 'step4-initial')
    console.log('[步骤4] 完成\n')

    // 步骤5：测试 seek 到 5 分钟 (300s)
    console.log('[测试1] 测试 seek 到 5 分钟 (300s)...')
    
    const before300 = await getVideoState(page)
    console.log('[测试1] seek 前 currentTime:', before300?.currentTime)
    
    await page.evaluate(() => {
      const v = document.querySelector('video')
      if (v) v.currentTime = 300
    })
    
    console.log('[测试1] 已设置 currentTime = 300，等待 8 秒...')
    await delay(8000)
    
    const after300 = await getVideoState(page)
    result.seek300Details = after300
    console.log('[测试1] seek 后状态:')
    if (after300) {
      console.log('  currentTime:', after300.currentTime)
      console.log('  duration:', after300.duration)
      console.log('  readyState:', after300.readyState)
      console.log('  paused:', after300.paused)
      console.log('  buffered:', after300.buffered)
      console.log('  error:', after300.error)
    }
    
    if (after300 && Math.abs(Number(after300.currentTime) - 300) < 60 && after300.buffered && after300.buffered.length > 0 && after300.readyState >= 2) {
      result.seek300Success = true
      console.log('[测试1] ✅ seek 到 300s 成功')
    } else {
      console.log('[测试1] ❌ seek 到 300s 可能失败')
    }
    
    await takeScreenshot(page, 'step5-seek-300s')
    console.log('[测试1] 完成\n')

    // 步骤6：测试 seek 到 12 分钟 (720s)
    console.log('[测试2] 测试 seek 到 12 分钟 (720s)...')
    
    await page.evaluate(() => {
      const v = document.querySelector('video')
      if (v) v.currentTime = 720
    })
    
    console.log('[测试2] 已设置 currentTime = 720，等待 10 秒...')
    await delay(10000)
    
    const after720 = await getVideoState(page)
    result.seek720Details = after720
    console.log('[测试2] seek 后状态:')
    if (after720) {
      console.log('  currentTime:', after720.currentTime)
      console.log('  duration:', after720.duration)
      console.log('  readyState:', after720.readyState)
      console.log('  paused:', after720.paused)
      console.log('  buffered:', after720.buffered)
      console.log('  error:', after720.error)
    }
    
    if (after720 && Math.abs(Number(after720.currentTime) - 720) < 120 && after720.buffered && after720.buffered.length > 0 && after720.readyState >= 2) {
      result.seek720Success = true
      console.log('[测试2] ✅ seek 到 720s 成功')
    } else {
      console.log('[测试2] ❌ seek 到 720s 可能失败')
    }
    
    await takeScreenshot(page, 'step6-seek-720s')
    console.log('[测试2] 完成\n')

    // 步骤7：测试 seek 到接近末尾
    console.log('[测试3] 测试 seek 到接近末尾...')
    
    const duration = await page.evaluate(() => {
      const v = document.querySelector('video')
      return v ? v.duration : 0
    })
    
    console.log('[测试3] 视频时长:', duration, '秒')
    
    if (duration > 120) {
      await page.evaluate(() => {
        const v = document.querySelector('video')
        if (v && v.duration) v.currentTime = v.duration - 60
      })
      
      console.log('[测试3] 已设置到末尾前 60 秒，等待 10 秒...')
      await delay(10000)
      
      const afterEnd = await getVideoState(page)
      result.seekEndDetails = afterEnd
      console.log('[测试3] seek 后状态:')
      if (afterEnd) {
        console.log('  currentTime:', afterEnd.currentTime)
        console.log('  duration:', afterEnd.duration)
        console.log('  readyState:', afterEnd.readyState)
        console.log('  paused:', afterEnd.paused)
        console.log('  buffered:', afterEnd.buffered)
        console.log('  error:', afterEnd.error)
      }
      
      if (afterEnd && duration && Number(afterEnd.currentTime) > duration - 180 && afterEnd.buffered && afterEnd.buffered.length > 0 && afterEnd.readyState >= 2) {
        result.seekEndSuccess = true
        console.log('[测试3] ✅ seek 到末尾成功')
      } else {
        console.log('[测试3] ❌ seek 到末尾可能失败')
      }
    } else {
      console.log('[测试3] 视频时长不足，跳过末尾测试')
    }
    
    await takeScreenshot(page, 'step7-seek-end')
    console.log('[测试3] 完成\n')

    // 步骤8：检查 Network 和控制台
    console.log('[步骤8] 检查 Network 和控制台...')
    console.log('[步骤8] 206 Range 请求数:', result.rangeRequests.length)
    result.rangeRequests.forEach((req, i) => {
      console.log(`  [${i}] status=${req.status}, range=${req.range}`)
      console.log(`      url=${req.url}`)
    })
    
    console.log('[步骤8] seek 超时/错误数:', result.seekTimeoutErrors.length)
    result.seekTimeoutErrors.forEach((e, i) => {
      console.log(`  [${i}] ${e.substring(0, 200)}`)
    })
    
    console.log('[步骤8] 控制台错误数:', result.consoleErrors.length)
    if (result.consoleErrors.length > 0) {
      console.log('  前 5 个错误:')
      result.consoleErrors.slice(0, 5).forEach((e, i) => {
        console.log(`    [${i}] ${e.substring(0, 200)}`)
      })
    }
    
    console.log('[步骤8] 完成\n')

  } catch (err) {
    console.error('测试过程中发生错误:', err)
    await takeScreenshot(page, 'error')
  } finally {
    console.log('\n========== 测试结果汇总 ==========')
    console.log('1. 是否找到 sidx:', result.sidxFound ? '✅ 是' : '❌ 否')
    if (result.sidxRange) console.log('   sidx range:', result.sidxRange)
    if (result.sidxReferences > 0) console.log('   sidx references:', result.sidxReferences)
    console.log('')
    console.log('2. seek 到 300s (5分钟):', result.seek300Success ? '✅ 成功' : '❌ 失败/不确定')
    if (result.seek300Details) {
      console.log('   currentTime:', result.seek300Details.currentTime)
      console.log('   buffered:', result.seek300Details.buffered)
      console.log('   readyState:', result.seek300Details.readyState)
    }
    console.log('')
    console.log('3. seek 到 720s (12分钟):', result.seek720Success ? '✅ 成功' : '❌ 失败/不确定')
    if (result.seek720Details) {
      console.log('   currentTime:', result.seek720Details.currentTime)
      console.log('   buffered:', result.seek720Details.buffered)
      console.log('   readyState:', result.seek720Details.readyState)
    }
    console.log('')
    console.log('4. seek 到接近末尾:', result.seekEndSuccess ? '✅ 成功' : '❌ 失败/不确定')
    if (result.seekEndDetails) {
      console.log('   currentTime:', result.seekEndDetails.currentTime)
      console.log('   buffered:', result.seekEndDetails.buffered)
      console.log('   readyState:', result.seekEndDetails.readyState)
    }
    console.log('')
    console.log('5. seek 时有 206 Range 请求:', result.has206Requests ? '✅ 是' : '❌ 否')
    console.log('   请求数量:', result.rangeRequests.length)
    console.log('')
    console.log('6. seek 超时错误数:', result.seekTimeoutErrors.length)
    console.log('7. 控制台错误数:', result.consoleErrors.length)
    console.log('8. 截图位置:', result.screenshots)
    console.log('========================================\n')

    const outputPath = path.join(screenshotDir, 'test-result.json')
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2))
    console.log(`详细结果已保存到: ${outputPath}`)
    
    await delay(5000)
    await browser.close()
  }
}

main().catch(console.error)
