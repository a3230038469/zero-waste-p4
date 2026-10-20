#!/usr/bin/env node
/**
 * audit.mjs —— 零依赖页面取证工具（Node 内置 WebSocket 直连 CDP）
 *
 * 为什么不用 playwright：本项目没装，装它要动 package.json 和网络。
 * 本机已有 ms-playwright 缓存的 chromium 二进制 + Node 24 自带 WebSocket，够用。
 *
 * 用法（环境变量驱动）：
 *   CHROME_PATH   chromium.exe 路径
 *   CDP_PORT      调试端口，默认 9333
 *   SHOT_OUT      输出目录，默认 .agent/audit/shots
 *   ROUTES        JSON 数组：[{ "path": "/", "tag": "home", "vps": [[1440,900],[390,844]] }]
 *   MODE          "shot" | "dump" | "both"，默认 both
 *
 * 产出：
 *   <SHOT_OUT>/<tag>-<width>.png     整页长图
 *   <SHOT_OUT>/<tag>.dump.json       渲染后的文本/结构/体检数据
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Users\\a3230\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe'
const PORT = Number(process.env.CDP_PORT || 9333)
const OUT = resolve(process.env.SHOT_OUT || '.agent/audit/shots')
const MODE = process.env.MODE || 'both'
const ROUTES = JSON.parse(process.env.ROUTES || '[]')
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4000'

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

/** 最小 CDP 客户端 */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      } else if (msg.method) {
        const hs = this.handlers.get(msg.method)
        if (hs) hs.forEach((h) => h(msg.params, msg.sessionId))
      }
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          rej(new Error(`CDP timeout: ${method}`))
        }
      }, 45000)
    })
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(fn)
  }
  once(method) {
    return new Promise((res) => {
      const fn = (p) => {
        this.handlers.set(
          method,
          (this.handlers.get(method) || []).filter((h) => h !== fn)
        )
        res(p)
      }
      this.on(method, fn)
    })
  }
}

async function waitForCdp() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return await r.json()
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('CDP 没起来：chrome 启动失败或端口被占')
}

const chromeArgs = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--disable-lcd-text',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(OUT, '..', 'chrome-profile')}`,
  'about:blank'
]

const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore', windowsHide: true })
let browserWsUrl
try {
  const v = await waitForCdp()
  browserWsUrl = v.webSocketDebuggerUrl
  log(`[cdp] chrome up: ${v.Browser}`)
} catch (e) {
  log('[cdp] FATAL', e.message)
  chrome.kill()
  process.exit(1)
}

const ws = new WebSocket(browserWsUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})
const cdp = new Cdp(ws)

/** 页面里跑的取证脚本（返回纯数据，无 DOM 依赖） */
const PROBE = `(() => {
  const t = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const heads = [...document.querySelectorAll('h1,h2,h3')].map(h => ({
    tag: h.tagName, text: t(h).slice(0, 120),
    fs: getComputedStyle(h).fontSize, top: Math.round(h.getBoundingClientRect().top + scrollY)
  }));
  // 顶层区块：取 main/#app 下的直接子元素 + section/article，去重
  const roots = [...document.querySelectorAll('main > *, #app > * > *, section, article')];
  const blocks = [];
  const seen = new Set();
  for (const el of roots) {
    const r = el.getBoundingClientRect();
    if (r.height < 24) continue;
    const key = Math.round(r.top + scrollY) + 'x' + Math.round(r.height);
    if (seen.has(key)) continue;
    seen.add(key);
    const cs = getComputedStyle(el);
    blocks.push({
      cls: (el.className || '').toString().slice(0, 90),
      tag: el.tagName,
      top: Math.round(r.top + scrollY),
      h: Math.round(r.height),
      mb: cs.marginBottom, mt: cs.marginTop,
      text: t(el).slice(0, 200)
    });
  }
  blocks.sort((a,b) => a.top - b.top);
  const imgs = [...document.querySelectorAll('img')].map(i => ({
    src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0,
    w: i.naturalWidth, h: i.naturalHeight,
    rw: Math.round(i.getBoundingClientRect().width)
  }));
  return {
    url: location.pathname + location.search,
    title: document.title,
    docH: document.documentElement.scrollHeight,
    docW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    hOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    linkCount: document.querySelectorAll('a').length,
    btnCount: document.querySelectorAll('button').length,
    imgCount: imgs.length,
    brokenImgs: imgs.filter(i => i.src && !i.ok),
    heads, blocks,
    innerText: document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 20000),
    placeholder: /\\{\\{|TODO|待补充|Lorem ipsum|undefined|NaN|占位/.test(document.body.innerText)
  };
})()`

const results = []

for (const route of ROUTES) {
  const url = BASE + route.path
  const page = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const att = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  const sid = att.sessionId
  await cdp.send('Page.enable', {}, sid)
  await cdp.send('Runtime.enable', {}, sid)
  await cdp.send('Network.enable', {}, sid)

  let consoleErrs = []
  cdp.on('Runtime.consoleAPICalled', (p, s) => {
    if (s === sid && p.type === 'error') consoleErrs.push((p.args || []).map((a) => a.value || a.description).join(' ').slice(0, 200))
  })
  cdp.on('Runtime.exceptionThrown', (p, s) => {
    if (s === sid) consoleErrs.push('EXC: ' + (p.exceptionDetails?.exception?.description || '').slice(0, 200))
  })

  log(`\n[route] ${route.path}  (${route.tag})`)
  for (const [w, h] of route.vps || [[1440, 900]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 }, sid)
    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url }, sid)
    await Promise.race([loaded, sleep(12000)])
    await sleep(2200) // SPA 异步数据 + 过渡动画

    // 滚一遍触发懒加载，再回顶
    await cdp.send('Runtime.evaluate', {
      expression: `(async()=>{const H=document.documentElement.scrollHeight;for(let y=0;y<H;y+=600){scrollTo(0,y);await new Promise(r=>setTimeout(r,60));}scrollTo(0,0);})()`,
      awaitPromise: true
    }, sid)
    await sleep(600)

    if (MODE === 'both' || MODE === 'shot') {
      const shot = await cdp.send('Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: true, optimizeForSpeed: false }, sid)
      const f = join(OUT, `${route.tag}-${w}.png`)
      writeFileSync(f, Buffer.from(shot.data, 'base64'))
      const kb = Math.round(Buffer.from(shot.data, 'base64').length / 1024)
      log(`  [shot] ${w}x${h} -> ${f} (${kb} KB)`)
    }
    if (MODE === 'both' || MODE === 'dump') {
      const r = await cdp.send('Runtime.evaluate',
        { expression: PROBE, returnByValue: true }, sid)
      const data = { ...r.result.value, vp: `${w}x${h}`, consoleErrs: [...new Set(consoleErrs)] }
      writeFileSync(join(OUT, `${route.tag}-${w}.dump.json`), JSON.stringify(data, null, 1))
      results.push({ tag: route.tag, vp: `${w}x${h}`, ...data, innerText: undefined })
      log(`  [dump] docH=${data.docH} docW=${data.docW} hOverflow=${data.hOverflow} blocks=${data.blocks.length} heads=${data.heads.length} imgs=${data.imgCount} broken=${data.brokenImgs.length} links=${data.linkCount} btns=${data.btnCount} placeholder=${data.placeholder} errs=${data.consoleErrs.length}`)
    }
  }
  await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {})
}

writeFileSync(join(OUT, '_summary.json'), JSON.stringify(results, null, 1))
log(`\n[done] ${results.length} 条路由/视口记录 -> ${join(OUT, '_summary.json')}`)
ws.close()
chrome.kill()
process.exit(0)
