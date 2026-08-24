const { chromium } = require('E:/ProgramData/deepseek-harness/DSH_Anything/dsh-better-sidebar/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core')
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.goto('http://127.0.0.1:3202/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(9000)
  await page.evaluate(() => { localStorage.setItem('dsh.sidebarFloat.fixed', '0'); window.dispatchEvent(new Event('storage')) })
  await page.waitForTimeout(700)
  // 悬停热区展开
  await page.mouse.move(8, 450)
  await page.waitForTimeout(900)
  // 读侧边栏列内部布局宽度
  const r1 = await page.evaluate(() => {
    const frame = document.querySelector('div:has(> [data-shell-overlay])')
    const col = frame.children[0]
    const cw = col.getBoundingClientRect().width
    // 找列内第一个有宽度的内容元素
    const content = [...col.querySelectorAll('*')].find(el => {
      const r = el.getBoundingClientRect(); return r.width > 30 && r.width < cw - 10
    })
    return { colWidth: Math.round(cw), contentWidth: content ? Math.round(content.getBoundingClientRect().width) : 'none', contentCls: content ? (typeof content.className==='string'?content.className.slice(0,40):'') : '' }
  })
  console.log('BEFORE RESIZE:', JSON.stringify(r1))
  // 拖拽手柄改宽（模拟拖到 400）
  await page.evaluate(() => {
    const handle = document.querySelector('.dsh-sidebar-resize')
    if (handle) {
      const r = handle.getBoundingClientRect()
      window.__handleX = r.left + r.width/2
      window.__startW = document.querySelector('div:has(> [data-shell-overlay])').children[0].getBoundingClientRect().width
    }
  })
  // 用 pointer 事件模拟拖拽
  await page.mouse.move(await page.evaluate(() => window.__handleX), 450)
  await page.mouse.down()
  await page.mouse.move(await page.evaluate(() => window.__handleX + 120), 450, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const r2 = await page.evaluate(() => {
    const frame = document.querySelector('div:has(> [data-shell-overlay])')
    const col = frame.children[0]
    const cw = col.getBoundingClientRect().width
    const content = [...col.querySelectorAll('*')].find(el => {
      const r = el.getBoundingClientRect(); return r.width > 30 && r.width < cw - 10
    })
    return { colWidth: Math.round(cw), contentWidth: content ? Math.round(content.getBoundingClientRect().width) : 'none', contentCls: content ? (typeof content.className==='string'?content.className.slice(0,40):'') : '' }
  })
  console.log('AFTER RESIZE:', JSON.stringify(r2))
  await browser.close()
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
