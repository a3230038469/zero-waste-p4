/**
 * 整库概览数据层（GET /api/overview）—— 2026-10-10 新增
 *
 * 对外展示站的首页统计条与「数据概览」页都读这一份数据。
 *
 * 失败时**返回 null 而不是抛错**：概览是锦上添花的内容，
 * 后端没起 / 引擎没连上时，页面应该安静地少一块，而不是弹一个红字报错框。
 */
import http from './http'
import type { DocOverview } from './types'

export async function getOverview(): Promise<DocOverview | null> {
  try {
    const res = await http.get<DocOverview>('/overview', { silent: true })
    return res.data
  } catch {
    return null
  }
}
