/**
 * 端到端验收 —— 真实用户流程 + 交互态可访问性检查。
 *
 * 覆盖：
 *  1. 首页搜索 -> 资料库结果
 *  2. 点开第一条 -> 详情页
 *  3. 键盘 Tab 走查：焦点环是否真的可见（computedStyle.boxShadow）
 *  4. 登录表单空提交 -> 前端校验是否拦截并给出人话
 *  5. UI 登录 -> 导航是否显示「XX，你好」-> 刷新是否掉登录态
 *  6. 404 兜底
 *  7. 移动端 375 宽是否横向溢出
 *
 * 前置：
 *   1. 起服务：npm run dev:backend  |  npm run dev:frontend
 *   2. 装驱动：npm i -D puppeteer-core
 *   3. 跑起来：node scripts/qa-e2e.js
 *
 * 副作用：会往 **开发库** 注册/复用一个测试账号（手机号见 PHONE）。
 *         不要对着生产库跑。
 */
const fs = require('fs')
const path = require('path')
const { CHROME, puppeteer, sleep, BASE, API, OUT, LAUNCH, ROOT } = require('./qa-utils')

const PHONE = process.env.QA_PHONE || '13900002020'
const PWD = process.env.QA_PWD || 'Test12345'
const NAME = process.env.QA_NAME || '月月验收'

const results = []
const pass = (name, detail) => {
  results.push({ name, ok: true, detail })
  console.log(`  PASS  ${name}  ${detail || ''}`)
}
const fail = (name, detail) => {
  results.push({ name, ok: false, detail })
  console.log(`  FAIL  ${name}  ${detail || ''}`)
}

;(async () => {
  // 0) 预置测试账号（已存在则忽略）
  try {
    const r = await fetch(`${API}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: NAME,
        org: '六尺巷基金会',
        occupation: '项目测试',
        topics: ['垃圾分类'],
        phone: PHONE,
        password: PWD
      })
    })
    console.log(`  [setup] 注册测试账号 HTTP ${r.status}（409 = 已存在，正常）`)
  } catch (e) {
    console.log('  [setup] 注册接口不可用:', e.message)
  }

  const browser = await puppeteer().launch({ executablePath: CHROME(), ...LAUNCH })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  page.on('pageerror', (e) => console.log('  [page error]', e.message))

  // 1) 搜索
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  await page.type('.search-input input', '塑料')
  await page.click('.search-btn')
  await sleep(2500)
  const url1 = page.url()
  const cards = await page
    .$$eval('.doc-card, .card, .cards > *', (els) => els.length)
    .catch(() => 0)
  if (url1.includes('/shelf') && cards > 0) pass('首页搜索跳转结果页', `${cards} 个结果`)
  else fail('首页搜索跳转结果页', `url=${url1} cards=${cards}`)

  // 2) 详情
  const firstLink = await page.$('.cards a[href^="/doc/"], .cards > * a, a[href^="/doc/"]')
  if (firstLink) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      firstLink.click()
    ])
    await sleep(1800)
    const hasTitle = await page.$eval('h1', (el) => el.textContent.trim()).catch(() => '')
    if (page.url().includes('/doc/') && hasTitle) pass('结果页点开详情', hasTitle.slice(0, 24))
    else fail('结果页点开详情', `url=${page.url()} h1=${hasTitle}`)
  } else {
    fail('结果页点开详情', '没找到结果卡片链接')
  }

  // 3) 键盘焦点走查
  await page.goto(BASE + '/shelf', { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  const focusLog = []
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab')
    await sleep(120)
    const info = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const cs = getComputedStyle(el)
      return {
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 30),
        shadow: cs.boxShadow,
        outline: cs.outlineStyle
      }
    })
    if (info) focusLog.push(info)
  }
  const visible = focusLog.filter((f) => f.shadow && f.shadow !== 'none').length
  if (focusLog.length >= 5 && visible === focusLog.length) {
    pass('键盘焦点环可见', `${visible}/${focusLog.length} 个聚焦元素有阴影环`)
  } else {
    fail('键盘焦点环可见', `${visible}/${focusLog.length}`)
  }
  await page.screenshot({ path: `${OUT}/09-state-focus.png` })

  // 4) 登录表单空提交校验
  await page.goto(BASE + '/auth', { waitUntil: 'domcontentloaded' })
  await sleep(1200)
  await page.click('.submit')
  await sleep(900)
  const errText = await page.evaluate(() => document.body.innerText)
  if (/请输入|不能为空|必填/.test(errText)) pass('登录空提交被前端拦截', '出现校验文案')
  else fail('登录空提交被前端拦截', '未见校验文案')

  // 5) UI 登录
  await page.type('input[placeholder="注册时填写的手机号"]', PHONE)
  await page.type('input[placeholder="请输入密码"]', PWD)
  await page.click('.submit')
  await sleep(2500)
  const bodyText = await page.evaluate(() => document.body.innerText)
  if (bodyText.includes(NAME) || bodyText.includes('你好')) pass('UI 登录成功且导航显示问候', NAME)
  else fail('UI 登录成功且导航显示问候', bodyText.slice(0, 60).replace(/\n/g, ' '))

  // 刷新是否掉登录态
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(1500)
  const afterReload = await page.evaluate(() => document.body.innerText)
  if (afterReload.includes(NAME) || afterReload.includes('你好')) pass('刷新后登录态保持', '')
  else fail('刷新后登录态保持', '刷新后问候消失')

  // 6) 404
  await page.goto(BASE + '/no-such-page', { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  const t404 = await page.evaluate(() => document.body.innerText)
  if (t404.includes('页面不存在')) pass('404 兜底渲染', '')
  else fail('404 兜底渲染', t404.slice(0, 60).replace(/\n/g, ' '))

  // 7) 移动端
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true })
  for (const [name, p] of [
    ['11-mobile-home', '/'],
    ['12-mobile-shelf', '/shelf']
  ]) {
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' })
    await sleep(2000)
    await page.screenshot({ path: `${OUT}/${name}.png` })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    if (overflow <= 1) pass(`移动端无横向溢出 ${p}`, `scrollWidth 超出 ${overflow}px`)
    else fail(`移动端无横向溢出 ${p}`, `超出 ${overflow}px`)
  }

  await browser.close()

  const okAll = results.every((r) => r.ok)
  const report = path.join(OUT, 'e2e-report.json')
  fs.writeFileSync(
    report,
    JSON.stringify(
      { date: new Date().toISOString().slice(0, 10), base: BASE, results, focusLog, okAll },
      null,
      1
    )
  )
  console.log(`\n===== ${results.filter((r) => r.ok).length}/${results.length} 通过 =====`)
  console.log(`明细：${path.relative(ROOT, report)}`)
  process.exit(okAll ? 0 : 1)
})().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
