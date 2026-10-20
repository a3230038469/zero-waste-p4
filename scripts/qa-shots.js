/**
 * 截图存档 —— 用本机浏览器拍页面与交互态，产出 docs/shots/ 下的 PNG。
 *
 * 为什么不用 `chrome --headless --screenshot`：
 * 那个方式不推进 requestAnimationFrame，Vue 的页面过渡会卡在
 * `fade-slide-enter-from`（opacity:0），拍出来是一片空白。
 *
 * 前置：
 *   1. 起服务：npm run dev:backend  |  npm run dev:frontend
 *   2. 装驱动：npm i -D puppeteer-core
 *   3. 拍图：  node scripts/qa-shots.js
 */
const { CHROME, puppeteer, sleep, BASE, OUT, LAUNCH } = require('./qa-utils')

// [文件名, 路径]
const PAGES = [
  ['01-home', '/'],
  ['02-shelf', '/shelf'],
  ['03-doc-detail', '/doc/k-16'],
  ['04-auth', '/auth'],
  ['05-contribute', '/contribute'],
  ['06-insights', '/insights'],
  ['07-404', '/404-not-exist']
]

/** 等懒加载路由的内容真正挂进 <main>，拍到空壳没意义 */
async function waitContent(page, name) {
  return page
    .waitForFunction(
      () => {
        const m = document.querySelector('.app-main')
        return m && m.children.length > 0
      },
      { timeout: 15000 }
    )
    .catch(() => console.warn(`  ! ${name} 内容等待超时，仍然截图`))
}

;(async () => {
  const browser = await puppeteer().launch({ executablePath: CHROME(), ...LAUNCH })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })

  // 1) 基础页面
  for (const [name, p] of PAGES) {
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitContent(page, name)
    await sleep(1200) // 等进场动画结束，否则拍到半透明
    await page.screenshot({ path: `${OUT}/${name}.png` })
    console.log(`  ${name}.png`)
  }

  // 2) 悬停态：首页类型卡片
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  const card = await page.$('.type-card')
  if (card) {
    await card.hover()
    await sleep(500)
    await page.screenshot({ path: `${OUT}/08-state-hover.png` })
    console.log('  08-state-hover.png')
  }

  // 3) 键盘焦点态：资料库页 Tab 走位
  await page.goto(BASE + '/shelf', { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
  await sleep(500)
  await page.screenshot({ path: `${OUT}/09-state-focus.png` })
  console.log('  09-state-focus.png')

  // 4) 空态：搜一个必然没有结果的词
  await page.goto(BASE + '/shelf?q=zzzzzznotfound', { waitUntil: 'domcontentloaded' })
  await sleep(2000)
  await page.screenshot({ path: `${OUT}/10-state-empty.png` })
  console.log('  10-state-empty.png')

  await browser.close()
  console.log(`done -> ${OUT}`)
})().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
