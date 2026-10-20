/**
 * 横向溢出定位 —— 找出窄屏下到底是谁撑破了视口。
 *
 * 用法：
 *   node scripts/diag-overflow.js              # 默认 375 宽扫 /shelf
 *   node scripts/diag-overflow.js / 320        # 指定路径与宽度
 *
 * 输出：所有 right 超出视口（或 left 为负）的元素，带 flex-wrap / min-width，
 *       方便一眼看出是「没换行」还是「写死了最小宽度」。
 */
const { CHROME, puppeteer, sleep, BASE, LAUNCH } = require('./qa-utils')

const target = process.argv[2] || '/shelf'
const width = Number(process.argv[3] || 375)

;(async () => {
  const browser = await puppeteer().launch({ executablePath: CHROME(), ...LAUNCH })
  const page = await browser.newPage()
  await page.setViewport({ width, height: 812, isMobile: true, hasTouch: true })
  await page.goto(BASE + target, { waitUntil: 'domcontentloaded' })
  await sleep(2500)

  const info = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth

    // 装饰层（光晕、背景图）常常故意超出视口，但被祖先 overflow 裁掉，
    // 并不产生滚动条。向上找一圈，被裁的就别报警，否则满屏假警报。
    const isClipped = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX
        if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') return true
      }
      return false
    }

    const blame = []
    const clipped = []
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
        const cs = getComputedStyle(el)
        const row = {
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 50),
          left: Math.round(r.left),
          right: Math.round(r.right),
          w: Math.round(r.width),
          flexWrap: cs.flexWrap,
          minW: cs.minWidth
        }
        ;(isClipped(el) ? clipped : blame).push(row)
      }
    })
    return {
      vw,
      scrollWidth: document.documentElement.scrollWidth,
      blame: blame.slice(0, 15),
      clipped: clipped.slice(0, 5)
    }
  })

  const over = info.scrollWidth - info.vw
  console.log(
    `\n${target} @ ${width}px  viewport=${info.vw}  scrollWidth=${info.scrollWidth}  溢出 ${over}px`
  )
  const show = (list, title) => {
    console.log(`\n${title} ${list.length} 个：`)
    list.forEach((i) =>
      console.log(
        `  ${i.tag}.${i.cls}  left=${i.left} right=${i.right} w=${i.w} flexWrap=${i.flexWrap} minW=${i.minW}`
      )
    )
    if (!list.length) console.log('  无')
  }
  show(info.blame, '真正撑破视口的元凶')
  show(info.clipped, '已 overflow 裁掉（装饰层，无害）')
  if (over > 1 && !info.blame.length) {
    console.log(
      '\n  溢出存在但没定位到元素：多半是 body/html 自身滚动，检查是否有 white-space: nowrap'
    )
  }

  await browser.close()
  process.exit(over > 1 ? 1 : 0)
})().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
