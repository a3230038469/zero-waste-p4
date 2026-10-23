/**
 * 游客权限 · 前端读口径（T11 新增）
 *
 *   GET /api/guest/permissions   公开只读，**不需要登录、也不需要管理员身份**
 *
 * 为什么是单独一个 api 文件：设置页走 `/admin/guest-permissions`（管理员身份，
 * 见 api/admin.ts），公众页面（资料详情页 / 页脚）只能用这条公开口径 ——
 * 公众页面本来就不该带任何管理凭证。
 *
 * 🔴 这里的「置灰」只是体验，真正的拦截在后端
 *    （routes/ask.ts / routes/docs.ts / routes/track.ts）。
 *    所以**读不到时一律按默认值（全部开放）走**，宁可让按钮可点、
 *    由后端给一句人话，也不要让整个页面瘫掉。
 */
import http from './http'

/** 一个开关的呈现方式（后端下发的，界面照此渲染，别在前端另抄一份文案） */
export type GuestSwitchType = 'readonly' | 'switch' | 'number'

/** 开关清单的一项 */
export interface GuestSwitchItem {
  key: string
  label: string
  /** 界面上要显示的一句说明 */
  hint: string
  type: GuestSwitchType
  /** 建议默认值（不是当前值；当前值在 values 里） */
  default: boolean | number
  /** 能不能改。browse 是最低门槛入口，永远 false */
  editable: boolean
}

/** 当前开关值（browse 恒为 true） */
export interface GuestPermissionValues {
  browse: boolean
  aiAsk: boolean
  aiAskDailyLimit: number
  preview: boolean
  share: boolean
  feedback: boolean
  download: boolean
}

/** 可被开关控制的五项功能（browse 不可关，所以不在这里） */
export type GuestFeature = 'aiAsk' | 'preview' | 'share' | 'feedback' | 'download'

/** GET /api/guest/permissions 与 GET /api/admin/guest-permissions 的响应体 */
export interface GuestPermissionsPayload {
  success: boolean
  switches: GuestSwitchItem[]
  values: GuestPermissionValues
  updatedAt: string
  /**
   * 2026-10-21（T3 · P1-14）：**这份开关是不是兜底值**。
   * true = 接口没读通，现在用的是默认口径（后端仍会真拦）。
   * 页面据此提示「开关状态暂时读不到」，而不是假装一切正常。
   */
  degraded?: boolean
}

/** 读不到接口时的兜底值（= 后端的建议默认；详见文件头注释） */
export const GUEST_FALLBACK_VALUES: GuestPermissionValues = {
  browse: true,
  aiAsk: true,
  aiAskDailyLimit: 5,
  preview: true,
  share: true,
  feedback: true,
  download: false
}

function fallbackPayload(): GuestPermissionsPayload {
  return {
    success: false,
    switches: [],
    values: { ...GUEST_FALLBACK_VALUES },
    updatedAt: '',
    degraded: true
  }
}

/** 读当前开关。**永不抛错**：失败按默认值兜底（真正拦截在后端） */
export async function fetchGuestPermissions(): Promise<GuestPermissionsPayload> {
  try {
    const res = await http.get<GuestPermissionsPayload>('/guest/permissions', { silent: true })
    const values = res.data?.values
    if (!values) return fallbackPayload()
    return {
      success: res.data.success === true,
      switches: res.data.switches ?? [],
      // 后端少给字段时按默认值补齐，别让页面因为少一个键就崩
      values: { ...GUEST_FALLBACK_VALUES, ...values },
      updatedAt: res.data.updatedAt ?? '',
      degraded: false
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // 2026-10-21（T3 · P1-14）：原来只 console.warn，等于**静默吞错** ——
    // 页面与日志都看不出「游客开关读不到」。现在升级成 console.error，
    // 并且返回的 payload 带 degraded:true，页面能区分「读到了」与「读不到」。
    console.error('[guest] 读游客权限失败（按默认开放处理，后端仍会真拦）：' + detail)
    return fallbackPayload()
  }
}