/**
 * 检索等待文案轮换 —— 抽成共享层（T5-4）
 *
 * 为什么要抽：等待提示的文案与节奏原本内嵌在气泡组件里（`ChatBubble.vue`），
 * `/chat` 独立页（`ChatView.vue`）也要同样的提示，抽完只留一份文案、一份节奏、一份随机策略。
 * 抽两份的后果很实在：改一句文案要改两个文件，轮播策略各写各的还会跑偏。
 *
 * 随机策略（洗牌式，Fisher–Yates）：
 *   - 每轮把全部句子洗成一副新牌，按序发
 *   - **不与上一句连续重复**（发第一张前先把它挪到队尾）
 *   - 一轮发完重新洗牌
 * 为什么不直接 `Math.random()` 逐句取：那样「按顺序感」虽没了，
 * 但**间隔几句就撞上同一句**的概率不低（10 句里连着两次同句 ≈ 10%），
 * 读者会觉得卡住。洗牌保证「一轮之内每句都出现且互不重复」，观感更稳。
 *
 * 顺带：整个站点只用 200ms 级的短过渡，切句给 300ms 淡出→淡入；
 * 系统开了「减弱动态效果」时（见各组件的 prefers-reduced-motion）过渡被关掉，只剩换字。
 */
import { onUnmounted, ref, type Ref } from 'vue'

/** 每句一个意思，贴合零废弃 / 翻资料，不卖萌、不用 emoji（沿用 T4 的文案，不改口吻） */
export const WAITING_LINES: readonly string[] = [
  '正在垃圾堆里翻找答案……',
  '翻到第 382 页了，快好了……',
  '正在给资料做垃圾分类（检索中）……',
  '厨余堆肥需要时间，答案也一样……',
  '正在给知识库做一次断舍离……',
  '正在把 600 多份资料按年份归位……',
  '先把厨余和可回收分开，答案马上来……',
  '知识库正在深呼吸……',
  '正在翻《神奇的黑水虻》那一页……',
  '环保这件事，急不来……'
]

/** 换句节奏 */
export const WAITING_INTERVAL_MS = 2500

/**
 * 洗一副新牌（Fisher–Yates，就地交换版）。
 *
 * 抽出来单独写，是为了让人一眼看出「这是标准洗牌」而不是随手写的乱序 ——
 * 将来谁想换成 seeded RNG（便于复现）只改这一个函数。
 */
function shuffled(): string[] {
  const deck = [...WAITING_LINES]
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = deck[i] as string
    deck[i] = deck[j] as string
    deck[j] = tmp
  }
  return deck
}

export interface WaitingLines {
  /** 当前该显示的那句 */
  text: Ref<string>
  /** 开始轮换（已转则重置到第一张牌） */
  start: () => void
  /** 停轮换（没在转是空操作，所以每收到一个 answer 片段都能放心调一次） */
  stop: () => void
}

/**
 * 拿一个等待文案轮播器。
 *
 * ⚠️ 每次调用是**独立**的一份牌堆与定时器 —— 首页气泡与独立页各自一份，互不干扰
 * （一个页面关掉另一个不该跟着停）。
 */
export function useWaitingLines(): WaitingLines {
  const text = ref<string>(WAITING_LINES[0] ?? '')
  let deck: string[] = []
  /** 上一轮最后发出的那句，新一轮的第一张牌不许是它 */
  let lastLine = ''
  let timer: ReturnType<typeof setInterval> | null = null

  /** 发下一张牌；牌堆空了重新洗 */
  function nextLine(): string {
    if (deck.length === 0) {
      deck = shuffled()
      // 新一轮的第一张正好撞上上一轮最后一张 -> 把它挪到队尾，让这轮晚点出现
      //
      // ⚠️ 这里必须处理「它在 index 0」的情况：`deck[0] === lastLine` 成立时
      //    `indexOf(lastLine)` 返回的**就是 0**，所以不能拿 `at > 0` 当守卫 ——
      //    那样写等于整个去重永远不生效（2026-10-12 抽 300 句实测抓到 4 次跨轮重复）。
      //    正确写法：只要它在牌堆里就无条件挪走，挪到队尾后这一轮末尾再出现。
      if (deck.length > 1 && deck[0] === lastLine) {
        deck.shift()
        deck.push(lastLine)
      }
    }
    const line = deck.shift() ?? ''
    lastLine = line
    text.value = line
    return line
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function start(): void {
    stop()
    // 先立刻给一句：提问到出字之间可能有几秒空白，起手就空着会显得没响应
    nextLine()
    timer = setInterval(nextLine, WAITING_INTERVAL_MS)
  }

  // 组件没了就把定时器收掉，别让文案在没人看的页面上继续换
  onUnmounted(stop)

  return { text, start, stop }
}