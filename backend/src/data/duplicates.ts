/**
 * 重复内容标记 —— 数据清洗配套（2026-10-10）
 *
 * 背景：617 份真实资料里，有 11 组共 12 份是**字节级完全相同**的文件（按 SHA-256 判定），
 * 同一份资料被重复建档、重复上传。对外展示站上并列出现两个一模一样的条目，会让人以为
 * 「库里有很多重复内容」。
 *
 * 本模块只做**标记**，不做删除：
 *   键 = 副本的索引 id（k-N），值 = 建议保留的那一份的 id。
 * 前端据此在卡片上打「另有相同副本」的小标，详情页给出提示；
 * 是否真正撤下重复件，属业务判断，由基金会拍板（见 docs/对外展示站改造说明）。
 *
 * 数据来源：backend/data/kb-duplicates.json（由 zwp-data/mark_duplicates.py 生成）。
 * 文件缺失时不报错、不阻断服务，只是没有标记 —— 对外展示不该因为一个可选标记文件而 500。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 资料数据目录（源码与 dist 两种布局都落到 backend/data） */
const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url))

interface DuplicatesFile {
  groupCount?: unknown
  copyCount?: unknown
  copies?: unknown
}

interface DuplicateIndex {
  copies: Map<string, string>
  groupCount: number
}

let cache: DuplicateIndex | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 读重复标记（带缓存）。读不出来就返回空表，绝不抛错。 */
function load(): DuplicateIndex {
  if (cache) return cache
  const empty: DuplicateIndex = { copies: new Map(), groupCount: 0 }

  const file = join(DATA_DIR, 'kb-duplicates.json')
  if (!existsSync(file)) {
    cache = empty
    return cache
  }

  let parsed: DuplicatesFile
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as DuplicatesFile
  } catch {
    console.warn(`[duplicates] 重复标记文件不是合法 JSON，已忽略：${file}`)
    cache = empty
    return cache
  }

  const copies = new Map<string, string>()
  if (isRecord(parsed.copies)) {
    for (const [copyId, keepId] of Object.entries(parsed.copies)) {
      if (typeof keepId === 'string' && keepId && keepId !== copyId) copies.set(copyId, keepId)
    }
  }
  const groupCount =
    typeof parsed.groupCount === 'number' && Number.isFinite(parsed.groupCount)
      ? parsed.groupCount
      : 0

  cache = { copies, groupCount }
  console.log(`[duplicates] 重复内容标记已载入：${groupCount} 组、${copies.size} 份副本`)
  return cache
}

/** 这份资料是副本时，返回它对应的「保留件」id；否则返回 undefined */
export function duplicateOf(id: string): string | undefined {
  return load().copies.get(id)
}

/** 重复内容组数（去重口径统计用） */
export function duplicateGroupCount(): number {
  return load().groupCount
}

/** 重复副本份数（去重口径统计用） */
export function duplicateCopyCount(): number {
  return load().copies.size
}

/** 当前所有被标记为副本的 id（概览页需要一次性拿到） */
export function duplicateCopyIds(): string[] {
  return [...load().copies.keys()]
}
