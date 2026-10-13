/**
 * 分享卡片 meta 注入 —— B09 公众互动模块（2026-10-13）
 *
 * 为什么这件事必须做在**后端**：
 *   微信 / QQ / 钉钉在转发一个链接时，是由它们的**抓取程序**去读这个 URL 返回的 HTML，
 *   取 <title>、<meta name="description">、og:image 拼成聊天里的卡片。这个抓取程序
 *   **不执行 JavaScript** —— 而我们的前端是 Vue SPA，dist/index.html 里标题永远写着
 *   「零废弃知识库」。也就是说：不在服务端按 URL 换标签，转发 617 份资料里的任何一份，
 *   卡片都是一行没有信息量的站名，缩略图也没有。
 *
 * 做法与回退路径（要改这里请先读懂这四行）：
 *   1. frontend/index.html 里用 `<!-- share-meta:start -->` / `end` 标出一段默认标签；
 *   2. 本模块按请求路径算出该页的真实标题/摘要，把那一段**整段替换**；
 *   3. /doc/:id 能查到资料 → 注入资料级 meta；查不到或其他页面 → 注入页面级 meta；
 *   4. 任何一步失败（dist 不存在、数据源没就绪）→ 原样回 index.html，**绝不 500**。
 *      分享卡片只是锦上添花，不能把正常访问搞挂。
 *
 * 如实说明边界：微信里要 100% 自定义卡片（指定缩略图、摘要）需要公众号 JS-SDK 签名
 * （要 appid + 后端签名接口 + 已认证公众号），当前项目没有这些。本模块做到的是
 * 「链接被抓取时标题/摘要/配图正确」——这在微信外的 QQ、钉钉、浏览器收藏是完全生效的，
 * 在微信内分享也给抓取程序提供了它需要的全部字段。
 */
import { readFileSync, statSync } from 'node:fs'
import type { Request } from 'express'

import { getDataSource, listFiles, loadLocalDocs, loadSnapshotDocs } from '../weknora/index.js'
import type { KbDocInternal } from '../weknora/types.js'

/** 站点名（og:site_name 与标题后缀） */
const SITE_NAME = '零废弃知识库'

/** 默认分享封面：frontend/public/share-cover.png，构建后在站点根路径 */
const COVER_PATH = '/share-cover.png'

export interface ShareMeta {
  title: string
  description: string
  url: string
  image: string
  /** og:type：文章页 article，其他 website */
  ogType: 'article' | 'website'
}

/* ------------------------------------------------------------------ *
 * 站点绝对地址
 * ------------------------------------------------------------------ */

/**
 * 算出站点对外的绝对地址。
 *
 * 优先级：.env 的 SITE_BASE_URL（公网部署时务必配，比如 https://kb.xxx.org）
 * → 反向代理头 → 请求本身的协议+域名。本地演示（localhost:4000）不配也能工作。
 */
export function siteOrigin(req: Request): string {
  const configured = (process.env.SITE_BASE_URL ?? '').trim().replace(/\/+$/, '')
  if (configured) return configured

  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost'
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http'
  return `${String(proto).split(',')[0].trim()}://${String(host).split(',')[0].trim()}`
}

/* ------------------------------------------------------------------ *
 * 资料查找（给 /doc/:id 用）
 * ------------------------------------------------------------------ */

/**
 * 按数据来源找资料。引擎来源走 listFiles()（内部有缓存），本地/快照是同步读、零网络。
 * 任何异常都吞掉返回 null —— meta 找不到就回默认卡片，不影响页面本身。
 */
async function findDocForMeta(id: string): Promise<KbDocInternal | null> {
  try {
    if (getDataSource() === 'engine') {
      const docs = await listFiles()
      return docs.find((d) => d.id === id) ?? null
    }
    const docs = getDataSource() === 'snapshot' ? loadSnapshotDocs() : loadLocalDocs()
    return docs.find((d) => d.id === id) ?? null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * meta 组装
 * ------------------------------------------------------------------ */

/** HTML 属性值转义：标题里有引号/尖括号也不能破坏 HTML 结构 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 摘要里不能出现换行，压成一行再截 */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 资料页 meta：标题=资料名，摘要=机构/年份/类型/主题（全部来自台账字段，不编内容） */
function docShareMeta(doc: KbDocInternal, origin: string): ShareMeta {
  const year = doc.year > 0 ? `${doc.year}年` : ''
  const bits = [
    oneLine(`${doc.org}发布`, 42),
    year,
    oneLine(doc.type, 12),
    doc.tags.length ? `主题：${doc.tags.slice(0, 3).join('、')}` : ''
  ].filter(Boolean)

  return {
    title: oneLine(`${doc.title} · ${SITE_NAME}`, 80),
    description: oneLine(`${bits.join('，')}。在线预览与下载请访问${SITE_NAME}。`, 90),
    url: `${origin}/doc/${doc.id}`,
    image: `${origin}${COVER_PATH}`,
    ogType: 'article'
  }
}

/** 非 /doc/:id 页面的 meta：给主要路由配一句中性的描述（不写未核实的机构信息） */
function routeShareMeta(pathname: string, origin: string): ShareMeta {
  const routes: Array<[RegExp, string, string]> = [
    [/^\/shelf\b/, '资料库', '按类型、发布机构、年份、主题筛选查找全部公开资料。'],
    [/^\/insights\b/, '数据概览', '收录数量、类型分布、访问统计等整库数据一览。'],
    [/^\/chat\b/, 'AI 问答', '基于知识库内容的 AI 问答，支持多轮对话。'],
    [/^\/about\b/, '关于项目', '项目背景、数据来源与口径、引用与转载说明。'],
    [/^\/auth\b/, '注册登录', '注册后可在线预览与下载原件。']
  ]
  const hit = routes.find(([re]) => re.test(pathname))
  const title = hit ? `${hit[1]} · ${SITE_NAME}` : SITE_NAME
  const description = hit ? hit[2] : '零废弃领域公开资料索引：政策法规、案例工具、研究报告、标准规范。'
  return {
    title,
    description,
    url: `${origin}${pathname}`,
    image: `${origin}${COVER_PATH}`,
    ogType: 'website'
  }
}

/* ------------------------------------------------------------------ *
 * index.html 读取（带 mtime 缓存）与注入
 * ------------------------------------------------------------------ */

let htmlCache: { mtimeMs: number; html: string } | null = null

/** 读 dist/index.html。读到 null 时上层直接 sendFile 兜底 */
export function loadIndexHtml(distDir: string): string | null {
  try {
    const file = `${distDir}/index.html`
    const mtimeMs = statSync(file).mtimeMs
    if (htmlCache?.mtimeMs === mtimeMs) return htmlCache.html
    const html = readFileSync(file, 'utf8')
    htmlCache = { mtimeMs, html }
    return html
  } catch {
    return null
  }
}

/**
 * 把 index.html 里 share-meta 区段替换成该页的真实标签。
 *
 * 有标记 → 整段替换（推荐路径）；没有标记（老构建）→ 退回「换 <title> + 在 </head> 前补」。
 */
export function injectShareMeta(html: string, meta: ShareMeta): string {
  const block = [
    `<!-- share-meta:start -->`,
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}" />`,
    `<meta property="og:type" content="${meta.ogType}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    `<meta property="og:url" content="${esc(meta.url)}" />`,
    `<meta property="og:image" content="${esc(meta.image)}" />`,
    `<!-- share-meta:end -->`
  ].join('\n    ')

  const re = /<!--\s*share-meta:start\s*-->[\s\S]*?<!--\s*share-meta:end\s*-->/
  if (re.test(html)) return html.replace(re, block)

  const fallbackTags = block
    .split('\n    ')
    .filter((line) => !line.startsWith('<!--'))
    .join('\n    ')
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(meta.title)}</title>`)
    .replace('</head>', `${fallbackTags}\n  </head>`)
}

/**
 * 对外主入口：按请求路径算 meta 并注入。
 * 返回 null 表示「这条路走不通，请调用方直接 sendFile 兜底」。
 */
export async function renderSpaHtml(
  distDir: string,
  pathname: string,
  origin: string
): Promise<string | null> {
  const html = loadIndexHtml(distDir)
  if (!html) return null

  const match = /^\/doc\/([A-Za-z0-9_-]+)/.exec(pathname)
  let meta: ShareMeta
  if (match) {
    const doc = await findDocForMeta(match[1])
    // 查得到 → 资料级卡片；查不到（下架/链接错）→ 站点默认卡片，别空着
    meta = doc ? docShareMeta(doc, origin) : routeShareMeta(pathname, origin)
  } else {
    meta = routeShareMeta(pathname, origin)
  }
  return injectShareMeta(html, meta)
}
