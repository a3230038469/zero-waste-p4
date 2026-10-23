/**
 * 整库概览数据层（GET /api/overview）—— 2026-10-10 新增
 *
 * 对外展示站的首页统计条与「数据概览」页都读这一份数据。
 *
 * ⚠️ 2026-10-21（T3 · P1-11）改法：**失败时抛错，不再返回 null**。
 *   之前这里 catch 掉一切返回 null，调用方拿到 null 与「真的没有数据」分不开 ——
 *   首页于是永远停在骨架屏（转圈），看不出是后端挂了。
 *   现在：失败会抛，调用方自己决定怎么表达（首页渲染「暂时读不到 + 重试」，
 *   管理台看板用 Promise.allSettled 单独吞这一段，安静少一块）。
 *
 *   silent: true 保留：不要弹全局红字 toast，各页面自己画错误态。
 */
import http from './http'
import type { DocOverview } from './types'

export async function getOverview(): Promise<DocOverview> {
  const res = await http.get<DocOverview>('/overview', { silent: true })
  return res.data
}
