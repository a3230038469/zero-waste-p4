/**
 * 游客权限 —— T11（2026-10-14 新增）
 *
 * 落盘位置：backend/data/guest-permissions.json（运行时文件，已 gitignore）
 *
 * 为什么自己存：这一层改的既不是引擎、也不是数据库，就是「老师后台那排开关」的当前值。
 * 与 `weknora/qa-settings.ts` 同一风格 —— 小 JSON + 每次请求现读（不缓存）：
 * 老师点一次「保存」，下一次访客请求就该生效，不用重启后端。
 *
 * 🔴 这一层只是**配置的真相**；真正「拦」在路由里（routes/ask.ts、docs.ts、track.ts），
 *    前端置灰只是体验。详见 docs/T11-游客权限与使用明细-任务单.md 第二节。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ *
 * 取值定义（开关清单顺序 = 界面顺序，真相只此一份）
 * ------------------------------------------------------------------ */

/** 落盘的一组开关 */
export interface GuestPermissions {
  /** 游客能不能用 AI 问答 */
  aiAsk: boolean
  /** 游客每日提问上限；0 = 不限（🔴 不限会被白刷，耗模型额度） */
  aiAskDailyLimit: number
  /** 游客能不能在线预览 */
  preview: boolean
  /** 分享（纯前端功能，这里只记录配置，供前端置灰） */
  share: boolean
  /** 游客能不能提意见反馈 */
  feedback: boolean
  /** 游客能不能下载原件（默认关：下载是「拿走」，且要留痕引导注册） */
  download: boolean
  /** ISO 时间戳；空串 = 从没保存过（一直用默认值） */
  updatedAt: string
}

/** 开关的呈现方式：readonly = 只读展示不给开关；number = 数字输入；switch = 开关 */
export type GuestSwitchType = 'readonly' | 'switch' | 'number'

/** 开关清单的一项（GET 时原样下发给前端，界面照这个顺序排） */
export interface GuestSwitchItem {
  key: string
  label: string
  /** 界面上要显示的一句说明 */
  hint: string
  type: GuestSwitchType
  /** 建议默认值（默认值不是当前值；当前值在 values 里） */
  default: boolean | number
  /** 能不能改。`browse` 是最低门槛入口，永远开放 → false */
  editable: boolean
}

/**
 * 开关清单（**顺序即界面顺序**，任务单 2.2 定稿）。
 *
 * 🔴 `browse` 只读：它是站点的最低门槛入口（不登录也能看目录），
 *    关掉等于把对外展示站关掉，所以这一项**只读展示、不给开关**，提交了也会被忽略。
 */
export const GUEST_SWITCHES: readonly GuestSwitchItem[] = [
  {
    key: 'browse',
    label: '浏览书架与搜索',
    hint: '不登录也能看目录，是最低门槛入口；这一项始终开放，不能关闭。',
    type: 'readonly',
    default: true,
    editable: false
  },
  {
    key: 'aiAsk',
    label: 'AI 问答',
    hint: '产品亮点。关闭后游客提问会被后端直接拒绝，并提示需要登录。',
    type: 'switch',
    default: true,
    editable: true
  },
  {
    key: 'aiAskDailyLimit',
    label: '└ 游客每日问答上限',
    hint: '配合上一项，按「当天 + 游客」计数；0 = 不限（会被白刷，耗模型额度，建议保持有限）。',
    type: 'number',
    default: 5,
    editable: true
  },
  {
    key: 'preview',
    label: '在线预览',
    hint: '看到内容才有价值。关闭后游客点预览会被后端拒绝。',
    type: 'switch',
    default: true,
    editable: true
  },
  {
    key: 'share',
    label: '分享',
    hint: '传播要零门槛。关闭后资料详情页的分享入口置灰，引导去登录。',
    type: 'switch',
    default: true,
    editable: true
  },
  {
    key: 'feedback',
    label: '意见反馈',
    hint: '有问题就该能说，不必先注册。关闭后游客的反馈提交会被后端拒收（其他埋点不受影响）。',
    type: 'switch',
    default: true,
    editable: true
  },
  {
    key: 'download',
    label: '下载原件',
    hint: '下载是「拿走」，且留痕引导注册，所以默认要求登录。关闭后游客下载会被后端拒绝。',
    type: 'switch',
    default: false,
    editable: true
  }
] as const

/** 每日上限的合法范围（0 = 不限；封顶 9999，别让人填个天文数字以为限住了） */
export const AI_ASK_DAILY_LIMIT_MAX = 9999

/**
 * 默认值。
 *
 * 🔴 与 `REQUIRE_LOGIN_FOR_ASK` 兼容（任务单第七节的硬要求）：
 *    那个环境变量保留，**作为 `aiAsk` 的初值** —— 它为 true 时默认「游客不能问」，
 *    为 false（.env.example 的默认值）时默认「游客能问」。
 *    一旦老师在设置页保存过，以**文件里的值为准**（显式选择 > 环境默认值）。
 */
export function defaultGuestPermissions(): GuestPermissions {
  const requireLoginByEnv = (process.env.REQUIRE_LOGIN_FOR_ASK ?? '').trim().toLowerCase() === 'true'
  return {
    aiAsk: !requireLoginByEnv,
    aiAskDailyLimit: 5,
    preview: true,
    share: true,
    feedback: true,
    download: false,
    updatedAt: ''
  }
}

/* ------------------------------------------------------------------ *
 * 读写
 * ------------------------------------------------------------------ */

/** 与 qa-settings.ts 的 DEFAULT_DATA_DIR 同解法：src 与 dist 两种布局都落到 backend/data */
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url))

function permissionsFile(): string {
  const override = (process.env.KB_DATA_DIR ?? '').trim()
  return join(override || DEFAULT_DATA_DIR, 'guest-permissions.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boolOf(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  // 兼容有人手改文件写成 "true"/1 的情况；其余一律回落默认值，不猜
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  return fallback
}

function limitOf(value: unknown, fallback: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return fallback
  return Math.min(Math.trunc(n), AI_ASK_DAILY_LIMIT_MAX)
}

/**
 * 🔴 降级口径：**全部关闭**（安全默认）。
 *
 * 配置文件坏了的时候绝不能回落成「默认全开」——那等于把游客能预览、能下载、
 * 能白刷问答一次性全放开，比报错更糟。所以这里给的是「什么都不给」，
 * 并且由调用方写日志提示管理员去修文件。
 */
export function safeGuestPermissions(): GuestPermissions {
  return {
    aiAsk: false,
    aiAskDailyLimit: 0,
    preview: false,
    share: false,
    feedback: false,
    download: false,
    updatedAt: ''
  }
}

/** 这次读到的是哪一种情况 */
export type GuestPermissionsSource =
  /** 正常：文件在、解析成功 */
  | 'file'
  /** 第一次跑：文件还不存在，用出厂默认 */
  | 'missing'
  /** 文件坏了：降级为「全部关闭」的安全默认 */
  | 'fallback'

/** 读设置的结果 + 这次是从哪儿来的 */
export interface GuestPermissionsState {
  permissions: GuestPermissions
  source: GuestPermissionsSource
  /** source === 'fallback' 时的原因（内部细节，只给服务端日志） */
  error?: string
}

/**
 * 读设置（带来源标记）。
 *
 * ⚠️ 故意**永不抛异常**：这个文件坏了最多降级，
 *    绝不能让整个站点挂掉（权限是附加项，问答/预览/下载才是主功能）。
 *    但「降级」不等于「默认全开」—— 坏了就全部关闭（见 safeGuestPermissions）。
 */
export function loadGuestPermissionsWithState(): GuestPermissionsState {
  const file = permissionsFile()
  if (!existsSync(file)) {
    return { permissions: defaultGuestPermissions(), source: 'missing' }
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(parsed)) {
      return {
        permissions: safeGuestPermissions(),
        source: 'fallback',
        error: '权限文件内容不是一个对象'
      }
    }
    const fallback = defaultGuestPermissions()
    return {
      permissions: {
        aiAsk: boolOf(parsed.aiAsk, fallback.aiAsk),
        aiAskDailyLimit: limitOf(parsed.aiAskDailyLimit, fallback.aiAskDailyLimit),
        preview: boolOf(parsed.preview, fallback.preview),
        share: boolOf(parsed.share, fallback.share),
        feedback: boolOf(parsed.feedback, fallback.feedback),
        download: boolOf(parsed.download, fallback.download),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
      },
      source: 'file'
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { permissions: safeGuestPermissions(), source: 'fallback', error: detail }
  }
}

/**
 * 读设置（只要值，不要来源）。
 * 保持老签名：routes/ask.ts、routes/docs.ts、routes/admin.ts 都在用它。
 */
export function loadGuestPermissions(): GuestPermissions {
  return loadGuestPermissionsWithState().permissions
}

/** PUT 的请求体：字段全可选，只改传了的那些 */
export type GuestPermissionPatch = Partial<Omit<GuestPermissions, 'updatedAt'>>

/** 回读校验的一项（与智能体设置 / 解析引擎设置同一套写法：哪一项没过就写哪一项） */
export interface GuestPermissionCheck {
  key: string
  label: string
  expected: string
  actual: string
  ok: boolean
}

/** 一次保存的结果 */
export interface GuestPermissionSaveResult {
  settings: GuestPermissions
  /** 本次真正改动过的键 */
  changed: string[]
  /** 被忽略的键（只读项 / 白名单之外） */
  ignored: string[]
  /** 回读校验：逐项比对「写下去的」与「重新读回来的」 */
  checks: GuestPermissionCheck[]
}

/** 可改的键白名单（`browse` 不在里面：它永远开放，给了开关也没用） */
const EDITABLE_KEYS = ['aiAsk', 'aiAskDailyLimit', 'preview', 'share', 'feedback', 'download'] as const

/**
 * 校验请求体 → 得出 patch。
 * 类型不对一律抛错（不猜、不兜底改写）：老师存了个错的却以为存上了，比报错更糟。
 */
export function parseGuestPermissionPatch(raw: unknown): {
  patch: GuestPermissionPatch
  ignored: string[]
} {
  if (!isRecord(raw)) {
    throw new Error('请求体得是一个对象')
  }
  const patch: GuestPermissionPatch = {}
  const ignored: string[] = []

  for (const [key, value] of Object.entries(raw)) {
    if (!(EDITABLE_KEYS as readonly string[]).includes(key)) {
      ignored.push(key)
      continue
    }
    if (value === undefined || value === null) continue
    if (key === 'aiAskDailyLimit') {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
        throw new Error('游客每日问答上限得是 0 或正整数（0 = 不限）')
      }
      patch.aiAskDailyLimit = Math.min(Math.trunc(n), AI_ASK_DAILY_LIMIT_MAX)
      continue
    }
    if (typeof value !== 'boolean') {
      throw new Error(`${key} 得是开关（true / false）`)
    }
    // 上面已把键收窄到可改的布尔键，这里逐个搬运（不用 as any，AGENTS.md 禁 any）
    switch (key) {
      case 'aiAsk':
        patch.aiAsk = value
        break
      case 'preview':
        patch.preview = value
        break
      case 'share':
        patch.share = value
        break
      case 'feedback':
        patch.feedback = value
        break
      default:
        patch.download = value
    }
  }

  return { patch, ignored }
}

/** 开关清单里的中文名（回读校验与报错都用它，不另抄一份） */
function labelOf(key: string): string {
  return GUEST_SWITCHES.find((item) => item.key === key)?.label ?? key
}

/**
 * 保存并**回读校验**（口径与 `weknora/agent-config.ts` 一致：写完重新读一遍，逐项比对）。
 *
 * 校验不过不抛错 —— 配置已经写进去了，抛错会让前端显示成「保存失败」。
 * 调用方按 checks[] 如实回报即可。
 */
export function saveGuestPermissions(patch: GuestPermissionPatch): GuestPermissionSaveResult {
  const current = loadGuestPermissions()
  const next: GuestPermissions = { ...current, ...patch, updatedAt: new Date().toISOString() }

  const file = permissionsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        aiAsk: next.aiAsk,
        aiAskDailyLimit: next.aiAskDailyLimit,
        preview: next.preview,
        share: next.share,
        feedback: next.feedback,
        download: next.download,
        updatedAt: next.updatedAt
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  // 回读：重新从文件读一遍（不信任刚写进去的那个对象）
  const readBack = loadGuestPermissions()
  const checks: GuestPermissionCheck[] = EDITABLE_KEYS.filter((key) => key in patch).map((key) => {
    const expected = next[key]
    const actual = readBack[key]
    return {
      key,
      label: labelOf(key),
      expected: String(expected),
      actual: String(actual),
      ok: String(expected) === String(actual)
    }
  })

  const changed = EDITABLE_KEYS.filter((key) => key in patch && current[key] !== next[key])
  return { settings: readBack, changed: [...changed], ignored: [], checks }
}

/* ------------------------------------------------------------------ *
 * 给界面 / 路由用的视图
 * ------------------------------------------------------------------ */

/**
 * 前端拿到的当前值。
 *
 * 🔴 刻意**不含** `updatedAt`：它是「这份配置何时存的」，不是一项开关，
 *    只在响应顶层单独给一次。混进 values 会让前端按开关遍历时多出一个键。
 */
export interface GuestPermissionValues {
  browse: true
  aiAsk: boolean
  aiAskDailyLimit: number
  preview: boolean
  share: boolean
  feedback: boolean
  download: boolean
}

/** GET /api/admin/guest-permissions 与 GET /api/guest/permissions 共用的响应体 */
export interface GuestPermissionsPayload {
  success: true
  /** 开关清单（含默认文案与顺序；界面照这个顺序排） */
  switches: GuestSwitchItem[]
  /** 当前值 */
  values: GuestPermissionValues
  updatedAt: string
  /**
   * true = 权限文件读不了，本次是「全部关闭」的安全降级值，不是管理员设的真实值。
   * 前端可以据此提示「功能暂时受限」，但**不能**把它当成管理员的真实配置。
   */
  degraded: boolean
  /** 这次值的来源：file（正常）/ missing（还没存过）/ fallback（文件坏了） */
  source: GuestPermissionsSource
}

export function guestPermissionsPayload(
  settings: GuestPermissions = loadGuestPermissions(),
  state?: { source?: GuestPermissionsSource }
): GuestPermissionsPayload {
  const source = state?.source ?? 'file'
  return {
    success: true,
    switches: GUEST_SWITCHES.map((item) => ({ ...item })),
    // 🔴 updatedAt 只在顶层给一次，不混进 values（它是「这一份配置何时存的」，不是一项开关）
    values: {
      browse: true,
      aiAsk: settings.aiAsk,
      aiAskDailyLimit: settings.aiAskDailyLimit,
      preview: settings.preview,
      share: settings.share,
      feedback: settings.feedback,
      download: settings.download
    },
    updatedAt: settings.updatedAt,
    degraded: source === 'fallback',
    source
  }
}

/** 路由里最常用的一句话判定：某项功能对游客开不开 */
export function guestAllows(feature: 'aiAsk' | 'preview' | 'share' | 'feedback' | 'download'): boolean {
  return loadGuestPermissions()[feature]
}