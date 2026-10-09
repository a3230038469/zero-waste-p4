/**
 * 极简 zip 读取器（取第一个「文件」条目）—— 2026-10-08 本地演示版新增
 *
 * 为什么需要它：WeKnora 没有「下载单份原件」的接口，只有
 *   POST /api/v1/knowledge-bases/{id}/knowledge/batch-download（返回 zip）。
 * 为了让书架的「在线预览 / 下载原件」在引擎模式下也能用，这里把 zip 拆开、
 * 取出里面那一份文件，再按普通文件流出去。
 *
 * 范围：只支持非 zip64 的普通 zip（引擎实际就是这么产出的，已实测）。
 * 不引入第三方依赖 —— 解压用 Node 内置 zlib。
 *
 * ⚠️ 两个关键点：
 *   1. 引擎产出的 zip 用了 data descriptor（local header 里的长度字段是 0），
 *      所以长度必须从**中央目录**读，不能读 local header。
 *   2. 中央目录里可能有目录条目（名字以 `/` 结尾），必须跳过 —— 否则会取到
 *      0 字节的目录记录，用户下载到空文件。
 */
import { inflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

/** 中央目录条目的固定部分长度（不含变长的名字/扩展/注释） */
const CENTRAL_HEADER_SIZE = 46

export interface ZipEntry {
  /** 条目在 zip 内的完整名字（引擎给的是「文件夹/子文件夹/文件名」整串） */
  name: string
  data: Buffer
}

/**
 * 从 zip 里取出第一个**文件**条目（跳过目录）。
 * 取不到就抛错，绝不返回空内容假装成功。
 */
export function unzipFirstEntry(buf: Buffer): ZipEntry {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是合法的 zip（找不到结尾标记）')

  const entryCount = buf.readUInt16LE(eocd + 10)
  const centralOffset = buf.readUInt32LE(eocd + 16)
  if (entryCount === 0) throw new Error('zip 里没有任何文件')
  if (centralOffset <= 0 || centralOffset >= buf.length) {
    throw new Error('zip 中央目录偏移不合法（可能是 zip64，暂不支持）')
  }

  let off = centralOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (off + CENTRAL_HEADER_SIZE > buf.length || buf.readUInt32LE(off) !== SIG_CENTRAL) {
      throw new Error('zip 中央目录格式不符合预期')
    }
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')

    // 目录条目跳过，继续看下一个
    if (!name.endsWith('/')) {
      return { name, data: readEntry(buf, off) }
    }
    off += CENTRAL_HEADER_SIZE + nameLen + extraLen + commentLen
  }
  throw new Error('zip 里没有文件（只有目录条目）')
}

/** 按中央目录里的一条记录，把数据取出来（必要时解压） */
function readEntry(buf: Buffer, centralOff: number): Buffer {
  const method = buf.readUInt16LE(centralOff + 10)
  const compressedSize = buf.readUInt32LE(centralOff + 20)
  const localOffset = buf.readUInt32LE(centralOff + 42)

  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new Error('zip 条目头格式不符合预期')
  }
  const localNameLen = buf.readUInt16LE(localOffset + 26)
  const localExtraLen = buf.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + localNameLen + localExtraLen
  const dataEnd = dataStart + compressedSize
  if (dataEnd > buf.length) throw new Error('zip 条目数据越界')

  const raw = buf.slice(dataStart, dataEnd)
  if (method === 0) return raw
  if (method === 8) return inflateRawSync(raw)
  throw new Error(`zip 使用了不支持的压缩方式（method=${method}）`)
}

/** 从尾部向前找 EOCD（结尾标记），最多回看 64KB + 22 字节 */
function findEocd(buf: Buffer): number {
  if (buf.length < 22) return -1
  const lowest = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= lowest; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/** 从 zip 条目名里取最后一段当文件名（引擎给的是完整路径） */
export function baseNameOf(zipEntryName: string): string {
  const parts = zipEntryName.split(/[\\/]/)
  return parts[parts.length - 1] || zipEntryName
}
