/**
 * 站点信息接口 —— 2026-10-19 新增（管理台「机构信息」页）
 *
 *   GET /api/site-info        公开只读：首页「合作与共建」与页脚用它渲染真实值
 *   PUT /api/admin/site-info  管理员写（需要管理员账号登录态，凭证由 http.ts 带上）
 *
 * 三条口径（与后端 backend/src/site/info.ts 一致）：
 *   1. **空串 = 没填**。没填的字段前端继续显示「待补充」，绝不用默认值假装成机构口径。
 *   2. 只认白名单字段，多传/拼错的字段后端直接 400（错别字要看得见，不能静默吞）。
 *   3. 字段清单由后端下发（`fields`），前端不自己抄一份，免得两边漂。
 *
 * 读接口在模块里缓存一份：首页与页脚在同一个页面里各调一次，不必打两次请求
 * （`fresh: true` 可强制重取；管理台保存成功后也会顺手把缓存刷新）。
 */
import http from './http'

/** 后端下发的字段说明（表单据此渲染，含中文标签、长度上限、填写提示） */
export interface SiteInfoField {
  key: string
  label: string
  max: number
  hint: string
}

/** 站点信息的当前值（key 与 fields[].key 对应；未填 = 空串） */
export type SiteInfoValues = Record<string, string>

export interface SiteInfoPayload {
  success: boolean
  info: SiteInfoValues
  fields: SiteInfoField[]
}

/** 模块级缓存：一次页面加载里首页 + 页脚只打一个请求 */
let cached: SiteInfoPayload | null = null
let inflight: Promise<SiteInfoPayload> | null = null

/** 公开读（任何访客都能调，用于首页与页脚） */
export async function fetchSiteInfo(options: { fresh?: boolean } = {}): Promise<SiteInfoPayload> {
  if (!options.fresh && cached) return cached
  if (!inflight) {
    inflight = http
      .get<SiteInfoPayload>('/site-info', { silent: true })
      .then((res) => {
        cached = res.data
        return res.data
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

export interface SiteInfoSaveResult {
  success: boolean
  info: SiteInfoValues
  /** 本次提交的字段（空串 = 清空该字段） */
  changed: string[]
}

/** 管理员保存（只传要改的字段；传空串 = 清空） */
export async function saveSiteInfo(patch: SiteInfoValues): Promise<SiteInfoSaveResult> {
  const res = await http.put<SiteInfoSaveResult>('/admin/site-info', patch, { silent: true })
  // 保存成功后同步缓存：老师切回首页时看到的就是刚填的值，不用等下一次请求
  if (cached) cached = { ...cached, info: res.data.info }
  return res.data
}
