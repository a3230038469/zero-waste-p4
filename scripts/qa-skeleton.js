/**
 * 骨架屏（加载态）截图 —— 产出 docs/shots/ 下的 PNG。
 *
 * 难点：本地接口太快（几十毫秒就回来），加载态一闪而过，截不到。
 * 以前的解法是「求后端同学给接口加人为延迟」，那要改业务代码、还得记得删，不划算。
 *
 * 这里的解法：不动后端一行代码，只在浏览器这一侧把 /api/ 请求**拖慢**再放行。
 * 加载态被人为拉长到 2 秒，足够截图，且脚本可重复跑，不污染仓库。
 *
 * 前置：
 *   1. 起服务：npm run dev:backend  |  npm run dev:frontend
 *   2. 装驱动：npm i -D puppeteer-core
 *   3. 拍图：  node scripts/qa-skeleton.js
 */
const { CHROME, puppeteer, sleep, BASE, OUT, LAUNCH } = require('./qa-utils')

/** 把接口拖慢多少毫秒。太短拍不到，太长脚本跑得慢，2000 是实测舒服的值 */
const DELAY_MS = 2000

// [文件名, 路径, 骨架屏选择器]
const TARGETS = [
  ['15-state-loading-shelf', '/shelf', '.zw-skeleton, .el-skeleton'],
  ['16-state-loading-insights', '/insights', '.zw-skeleton, .el-skeleton'],
  ['17-state-loading-doc', '/doc/k-16', '.zw-skeleton, .el-skeleton']
]

;(async () => {
  const browser = await puppeteer().launch({ executablePath: CHROME(), ...LAUNCH })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })

  // 关键：拦截请求，命中接口的先睡一会儿再放行。
  // 判断用 pathname 而不是 includes('/api/')，理由同 qa-shots.js：
  // Vite 的模块路径 /src/api/auth.ts 也含 '/api/'，会误伤导致白屏。
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    let isApi = false
    try {
      isApi = new URL(req.url()).pathname.startsWith('/api/')
    } catch {
      isApi = false
    }
    if (isApi) setTimeout(() => req.continue().catch(() => {}), DELAY_MS)
    else req.continue().catch(() => {})
  })

  for (const [name, path, sel] of TARGETS) {
    // 用 domcontentloaded 而不是 networkidle：接口被我们拖慢了，networkidle 要等更久
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const ok = await page
      .waitForSelector(sel, { visible: true, timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    if (!ok) {
      console.warn(`  ! ${name} 没等到骨架屏（${sel}），仍然截图`)
      await sleep(600)
    } else {
      await sleep(300) // 让骨架的呼吸动画走到一个稳定帧
    }
    await page.screenshot({ path: `${OUT}/${name}.png` })
    console.log(`  ${name}.png`)
  }

  await browser.close()
  console.log(`done -> ${OUT}（接口被人为拖慢 ${DELAY_MS}ms，仅为截图，未改后端）`)
})().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
