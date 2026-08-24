const { chromium } = require('E:/ProgramData/deepseek-harness/DSH_Anything/dsh-better-sidebar/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core')
;(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.goto('http://127.0.0.1:3216/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(9000)
  // 尝试打开设置：找 gear/设置按钮（含 svg 的按钮）
  const r = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const settingsBtn = btns.find(b => {
      const label = (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '') + (b.textContent || '')
      return /设置|settings|齿轮/.test(label)
    })
    if (settingsBtn) { settingsBtn.click(); return { clicked: true, label: (settingsBtn.getAttribute('aria-label')||'').slice(0,20) } }
    // 找带 gear icon 的按钮（svg 无文本）
    const iconBtn = btns.find(b => b.querySelector('svg') && b.textContent.trim() === '' && b.getBoundingClientRect().width < 40)
    if (iconBtn) { iconBtn.click(); return { clicked: 'icon', x: Math.round(iconBtn.getBoundingClientRect().left), y: Math.round(iconBtn.getBoundingClientRect().top) } }
    return { clicked: false }
  })
  console.log('OPEN SETTINGS:', JSON.stringify(r))
  await page.waitForTimeout(1000)
  const after = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
    if (!dialog) return 'no dialog'
    const d = dialog.getBoundingClientRect()
    return { dialogW: Math.round(d.width), dialogH: Math.round(d.height), cls: (typeof dialog.className==='string'?dialog.className.slice(0,40):'') }
  })
  console.log('DIALOG:', JSON.stringify(after))
  await browser.close()
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
