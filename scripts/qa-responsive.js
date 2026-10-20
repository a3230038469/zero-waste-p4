/**
 * 响应式批量体检 —— 把所有页面 × 多个宽度跑一遍，找横向溢出。
 *
 * 用法：
 *   node scripts/qa-responsive.js              # 默认 320 / 375 / 768
 *   node scripts/qa-responsive.js 375 414      # 自定义宽度
 *
 * 退出码：0 = 全部无溢出；1 = 有页面溢出。
 *
 * 装饰层（光晕/背景）故意超框但被 overflow 裁掉的不算问题，
 * 判定逻辑与 qa-overflow 一致：向上找祖先有没有 overflow 裁剪。
 */
const { CHROME, puppeteer, sleep, BASE, LAUNCH } = require('./qa-utils')

const ROUTES = [
  '/',
  '/shelf',
  '/insights',
  '/about',
  '/chat',
  '/contribute',
  '/doc/k-16',
  '/auth',
  '/admin/stats',
  '/admin/knowledge',
  '/admin/users',
  '/admin/contributions'
]

const WIDTHS = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n > 0)
const widths = WIDTHS.length ? WIDTHS : [320, 375, 768]

const probe = () => {
  const vw = document.documentElement.clientWidth
  const isClipped = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX
      if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') return true
    }
    return false
  }
  const blame = []
  document.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && (r.right > vw + 1 || r.left < -1) && !isClipped(el)) {
      blame.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().split(' ')[0].slice(0, 28),
        right: Math.round(r.right),
        w: Math.round(r.width)
      })
    }
  })
  return { over: document.documentElement.scrollWidth - vw, blame: blame.slice(0, 3) }
}

;(async () => {
  const browser = await puppeteer().launch({ executablePath: CHROME(), ...LAUNCH })
  const page = await browser.newPage()
  let bad = 0

  for (const w of widths) {
    await page.setViewport({ width: w, height: 900, isMobile: w < 500, hasTouch: w < 500 })
    console.log(`\n===== ${w}px =====`)
    for (const r of ROUTES) {
      let res
      try {
        await page.goto(BASE + r, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await sleep(1800)
        res = await page.evaluate(probe)
      } catch (e) {
        console.log(`  ?  ${r.padEnd(24)} 跳过（${e.message.slice(0, 40)}）`)
        continue
      }
      if (res.over > 1) {
        bad++
        const who = res.blame.map((b) => `${b.tag}.${b.cls}(w=${b.w})`).join(', ')
        console.log(`  ✗  ${r.padEnd(24)} 溢出 ${res.over}px   ${who || '未定位到元素'}`)
      } else {
        console.log(`  ✓  ${r.padEnd(24)} 无溢出`)
      }
    }
  }

  await browser.close()
  console.log(`\n===== ${bad ? `发现 ${bad} 处溢出` : '全部通过，无横向溢出'} =====`)
  process.exit(bad ? 1 : 0)
})().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
