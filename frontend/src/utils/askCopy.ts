/**
 * 问答的对外文案（单一真相来源）—— 2026-10-13 精进批次
 *
 * 为什么单独一个文件：这几句话要同时出现在「首页右下角问答窗口」与 `/chat` 独立页，
 * 复制两份必然漂移（改一处忘一处），而它们又都是对外发布口径，不能各写各的。
 *
 * 三条文案对应 PRD 的三条硬边界：
 *   1. ASK_DISCLAIMER    常驻免责 —— 「答案由 AI 依据库内资料生成，仅供参考」
 *   2. ASK_SCOPE_NOTE    作答范围 —— 「仅基于知识库内已收录资料作答」
 *   3. NO_ANSWER_TEXT    查不到明说 —— 固定拒答模板 + 引导（不编内容）
 *   4. NO_SOURCE_NOTE    引用缺失 —— 没匹配到来源卡片时如实提示，不改模型输出
 *
 * ⚠️ 文案里**不写份数**：份数会变（当前 617，引擎补传后还会变），
 *    写死一个数字等于给对外站点埋一个必然过期的说法。要份数的地方去 `/api/overview` 动态取。
 */

/** 常驻免责声明：问答界面上一直可见 */
export const ASK_DISCLAIMER = '回答由 AI 依据知识库内资料生成，仅供参考；请以资料原文为准。'

/** 作答范围说明：常驻在免责声明前面 */
export const ASK_SCOPE_NOTE = '仅基于零废弃知识库内已收录资料作答'

/** 库内没有可用资料时的固定说法（不是模型自由发挥） */
export const NO_ANSWER_TEXT =
  '知识库里暂时没有检索到能回答这个问题的资料。你可以换个说法再问一次，或者去资料库按主题浏览；如果手上有相关资料，也欢迎通过页脚的「意见反馈」推荐给我们。'

/** 拒答气泡上的短标签（气泡内提示，与 NO_ANSWER_TEXT 配套） */
export const NO_ANSWER_LABEL = '库内暂未收录'

/**
 * 引擎/智能体自带的「答不上来」兜底正文特征。
 *
 * 2026-10-23 实测：问库外问题（“今天北京天气怎么样”）时，引擎**没有**返回空正文，
 * 而是把一段兜底说明当成 answer 正文吐出来（“本助手只回答与零废弃……没有找到能回答这个问题的内容”），
 * 同时照常下发 sources。如果只看“正文为空”判断，就会把这轮当成正常回答，挂上不相关引用。
 */
const NO_ANSWER_TEXT_PATTERNS: RegExp[] = [
  /没有找到能回答/,
  /本助手只回答/,
  /资料库中暂未找到/,
  /暂未找到能回答/
]

/** 这段正文是不是「答不上来」的兜底说明？（限短文本，避免误伤正常长回答） */
export function looksLikeNoAnswerText(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return true
  if (t.length > 600) return false
  return NO_ANSWER_TEXT_PATTERNS.some((p) => p.test(t))
}

/** 有回答但没匹配到来源卡片时的如实提示（不篡改模型输出，只补一句） */
export const NO_SOURCE_NOTE = '本条回答未关联到库内资料原文，建议以原文为准或自行核实。'

/**
 * 落库前缀 —— 必须与 backend/src/routes/ask.ts 里的 STORED_*_PREFIX **一字不差**。
 *
 * 为什么用前缀编码而不是加字段：Message 表只有 content 一列，
 * 加字段要改 schema + 迁移，代价远大于收益；前缀是纯文本，老数据不受影响。
 * 两边各写一份常量（前后端不共用构建），改的时候必须同步改。
 */
export const STORED_FAILED_PREFIX = '【问答失败】'
export const STORED_NO_ANSWER_PREFIX = '【库内暂无】'
export const STORED_CANCELLED_PREFIX = '【已取消】'

/** 从库里读回来的一条助手消息（可能是正文，也可能是失败/拒答/取消标记） */
export interface StoredAnswer {
  /** 给公众看的正文（失败/拒答时是中文提示） */
  text: string
  /** 这一轮是失败（引擎报错 / 断网 / 超时） */
  failed?: boolean
  /** 这一轮库里没有资料 */
  noAnswer?: boolean
  /** 这一轮被用户取消了 */
  cancelled?: boolean
}

/** 把落库文本还原成「正文 + 状态标记」 */
export function parseStoredAnswer(raw: string): StoredAnswer {
  const text = typeof raw === 'string' ? raw : ''
  if (text.startsWith(STORED_FAILED_PREFIX)) {
    return {
      text:
        text.slice(STORED_FAILED_PREFIX.length).trim() ||
        'AI 问答服务暂时不可用，请稍后再试',
      failed: true
    }
  }
  if (text.startsWith(STORED_CANCELLED_PREFIX)) {
    return {
      text: text.slice(STORED_CANCELLED_PREFIX.length).trim() || '本次提问已取消',
      cancelled: true
    }
  }
  if (text.startsWith(STORED_NO_ANSWER_PREFIX)) {
    return { text: NO_ANSWER_TEXT, noAnswer: true }
  }
  // 老数据/引擎兜底正文：正文非空但其实是“答不上来”，同样按拒答处理（不挂引用）
  if (text.trim() && looksLikeNoAnswerText(text)) {
    return { text, noAnswer: true }
  }
  return { text }
}

/**
 * 失败态的对外文案：按「错在哪」分类。
 *
 * 🔴 以前断网时页面上直接冒出英文 'Failed to fetch'（浏览器原话），对外站来说等于故障外露；
 *    现在按 kind 分类，一律给中文。
 */
export const ASK_ERROR_TEXT = {
  /** 断网 / 后端没起来 / 跨域被拦 */
  network: '网络连接失败，请检查网络后重试',
  /** 客户端等太久 */
  timeout: '回答超时了，请稍后再试',
  /** 用户自己中止的（不算失败） */
  aborted: '本次提问已取消',
  /** 后端返回了非 2xx */
  http: '提问失败，请稍后再试',
  /** 说不好 */
  unknown: '请求失败，请稍后再试'
} as const

/**
 * 内部细节泄漏检查：这些内容绝不该出现在公众界面上。
 *
 * 后端已经尽量只给中文，但引擎原文 / 内部 URL 可能从别的路径漏进来 —— 这里双保险：
 * 命中任一模式就换成通用中文，不给公众看内部报错。
 */
const LEAK_PATTERNS: RegExp[] = [
  /request[_-]?id/i,
  /insufficient balance/i,
  /per-response output limit/i,
  /API request failed/i,
  /create chat completion/i,
  /https?:\/\//,
  /\/api\//,
  /EngineError/,
  /\bstatus \d{3}\b/,
  /at [A-Za-z_$][\w$]*\s*\(/
]

/** 这段文字适合直接给公众看吗？ */
export function isPublicSafeText(text: string): boolean {
  if (!text) return false
  return !LEAK_PATTERNS.some((p) => p.test(text))
}

/**
 * 引擎把「报错」当「答案正文」吐出来的已知英文文案。
 *
 * 2026-10-21 实测：上游模型达到单次输出上限时，SSE 里来的是 **answer 帧**，
 * 正文是一句英文 "Sorry, this answer hit the model's per-response output limit before any text was produced."，
 * 公众会直接看到这句英文。后端已经拦一道，这里再拦一道（前端也要能对付老后端）。
 */
const ENGINE_ERROR_PATTERNS: RegExp[] = [
  /per-response output limit/i,
  /output limit/i,
  /maximum context length/i,
  /insufficient balance/i,
  /\b429\b/,
  /rate limit/i,
  /API request failed/i
]

/** 这段正文是不是「引擎把报错当答案」？（宁可漏判，不误伤正常回答） */
export function looksLikeEngineError(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t || t.length > 400) return false
  // 带中文的肯定不是引擎报错原文
  if (/[\u4e00-\u9fa5]/.test(t)) return false
  return ENGINE_ERROR_PATTERNS.some((p) => p.test(t))
}

/** 引擎报错正文 → 面向公众的中文提示 */
export function engineErrorText(raw: string): string {
  const t = raw ?? ''
  if (/insufficient balance|\u4f59\u989d|quota/i.test(t)) return 'AI 服务的调用额度暂时用尽，请稍后再试'
  if (/per-response output limit|output limit|maximum context length/i.test(t)) {
    return '这次回答超出了模型单次输出上限，请换个问法再试一次'
  }
  if (/\b429\b|rate limit/i.test(t)) return 'AI 服务当前请求过多，请稍后再试'
  if (/timeout|timed out/i.test(t)) return '回答超时了，请稍后重试'
  return 'AI 问答服务暂时不可用，请稍后再试'
}
