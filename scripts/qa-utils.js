/**
 * QA 脚本公共部分 —— Chrome 路径探测与统一配置。
 *
 * 为什么不用 puppeteer 自带的 Chromium：
 * 它要额外下载几百 MB，国内网络经常失败。本机已经有 Chrome / Edge，
 * 直接拿来用即可，puppeteer-core 就够了（它不自带浏览器）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

/** 仓库根目录：本文件在 <root>/scripts/ 下 */
const ROOT = path.resolve(__dirname, '..')

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser'
].filter(Boolean)

/** 找出一个真实存在的浏览器可执行文件；找不到就抛人话错误 */
function resolveChrome() {
  for (const p of CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p
    } catch {
      /* 路径非法就跳过 */
    }
  }
  throw new Error(
    '没找到浏览器。请先安装 Chrome / Edge，或用环境变量指定：\n' +
      '  PowerShell: $env:CHROME_PATH="C:/路径/chrome.exe"\n' +
      '  bash:       CHROME_PATH=/路径/chrome node scripts/qa-shots.js'
  )
}

/** 加载 puppeteer-core，没装时给出可复制的安装命令 */
function requirePuppeteer() {
  try {
    return require('puppeteer-core')
  } catch {
    throw new Error(
      '缺少 puppeteer-core。先装一下（只装驱动，不下载浏览器，很小）：\n  npm i -D puppeteer-core'
    )
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = {
  ROOT,
  CHROME: resolveChrome,
  puppeteer: requirePuppeteer,
  sleep,
  BASE: process.env.QA_BASE || 'http://localhost:5173',
  API: process.env.QA_API || 'http://localhost:4000',
  OUT: process.env.QA_OUT || path.join(ROOT, 'docs', 'shots'),
  LAUNCH: {
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none']
  },
  os
}
