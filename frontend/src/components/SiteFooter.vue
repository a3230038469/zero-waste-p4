<script setup lang="ts">
/**
 * 页脚 —— 对外展示站版（2026-10-10 新增）
 *
 * 对外站点必须有页脚：它是「这是谁办的、数据哪来的、能不能引用、怎么联系」的落脚点，
 * 也是「管理后台」这类内部入口该待的地方（不占导航条，但找得到）。
 *
 * ⚠️ 页脚里的机构描述与联系方式目前只写**可核实的事实**（数据来自台账、份数、年份跨度）。
 *    机构使命、地址、电话等属于基金会对外口径，未经确认一律留占位符，
 *    绝不由我编一段听起来很合理的话填进去（见 docs/对外展示站改造说明 第五节）。
 *    2026-10-19：这几项改由管理台「机构信息」页填写；页脚只取其中的**版权行**
 *    （`GET /api/site-info`，取不到或没填就用下面这行默认文案）。
 *
 * 2026-10-12（B09）：补「意见反馈」入口——页脚是访客找不到路时的最后一站，
 * 站点级反馈放这里最合适；弹窗与资料详情页共用同一组件。
 *
 * 🔴 T11（2026-10-14）：反馈入口按「游客权限」的 feedback 开关联动 ——
 *    关闭时按钮置灰，点一下提示并跳登录页（后端也会拒收游客的反馈）。
 *
 * 2026-10-18（task-5，按 docs/前端改版方案-2026-10-18.md §4.4）：
 *   1. 4 列 → 3 列：整列删掉「站点」——其中 4 个入口带「（内部）」字样，不该挂在每一页公众页脚上（X13）。
 *      ⚠️ 连带影响：该列里的「登录 / 注册」也一起没了（方案只说删整列、没说把它搬去哪）；
 *      顶部导航与手机汉堡菜单里仍各有登录入口，公众没有失去登录的路。
 *   2. 「浏览」列补上「AI 问答」（此前页脚 0 个 AI 入口，只有一句文案）；
 *      该列顺序与顶部导航保持一致。
 *   3. 简介从 3 行压成 1 行（它的重复出现在 17 个渲染面上，见 D1）。
 *   4. 删掉「已收录 {{total}} 份资料」那行数字与随之而来的 getOverview 请求（数字只归首页数据条，见 D2）。
 *   5. 手机端不再退化成「一行一列」：≤480px 也维持两列（品牌独占一行 + 两列链接）。
 *   ⚠️ 本次只动「排版与文字」：颜色令牌一个没改，MouseGlow 一个数值没碰。
 *
 * 2026-10-18（task-6，用户口述「老页面不要了」）：`/about`、`/insights` 两个页面连同路由
 *   一并删除，内容整页搬进首页分隔线以下。本文件的旧链接同步改到首页锚点：
 *   「浏览」列按新导航对齐成 3 项；「使用」列三条改为 `/#distribution`、`/#cite`、`/#coop`。
 *   ⚠️ 锚点写在 HomeView.vue 的 section id 上（intro / coop / foundation / distribution / cite）。
 *
 * 2026-10-19（用户贴页脚截图要求重设计「底部这一块」）：
 *   **只改界面表现，页脚的所有入口、锚点、跳转逻辑与文字一处未动。**
 *   1. 品牌列升格为「Logo + 站名 + 机构名 + 一句话」：复用顶部导航同一套
 *      `zero-logo.png` + `.brand-mark` 圆角薄荷底，页脚与导航在视觉上终于是一个牌子；
 *      站名同时是回首页的链接（原来这一列没有可点的东西，白占最宽的一格）。
 *   2. 顶部加一道 2px 绿→薄荷的渐隐压边，页脚背景从薄荷色浅浅过渡到白（120px 内收干），
 *      让「内容区结束 / 页脚开始」有分界，不必靠加边框或换底色。
 *   3. 列标题加 18px 短绿色下划线；链接与按钮统一 hover（变深绿 + 下划线 + 右移 2px）
 *      与按下反馈，链接行高到 1.9，手指点得准。
 *   4. 底部版权行改实线发丝分隔 + 两行结构（手机上不再左右挤成一行）。
 *   5. 手机（≤860px）维持「品牌独占一行 + 两列链接」；≤480px 列间距收到 20px，
 *      仍保持两列（旧版一行一列会把页脚顶到 817px，是 §4.4 要压掉的主因）。
 *   ⚠️ 该组件是全局的：除「AI 问答页」（App.vue 里 `isFullBleed` 时不渲染页脚）外，
 *      其余页面都会用上这一版；所有色值都取自既有令牌，没有引入新的设计体系。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useGuestPermissions } from '../composables/useGuestPermissions'
import { fetchSiteInfo } from '../api/site'
import { defaultCopyright } from '../constants/site-defaults'
import FeedbackDialog from './FeedbackDialog.vue'

const router = useRouter()
const { ensure: ensureGuestPermissions, guestAllowed } = useGuestPermissions()

/** 站点级反馈弹窗 */
const feedbackVisible = ref(false)

/** 页脚版权行的年份（只在渲染时取一次，避免模板里 new Date 反复调） */
const year = new Date().getFullYear()

/**
 * 机构自填的版权行（管理台「机构信息」页，2026-10-19）：
 * 填了就用机构写的整行；没填沿用站点默认那句。取不到接口也走默认，页脚不该因此空掉。
 */
const customCopyright = ref('')

/** 反馈是否对当前访客关闭（已登录用户一律放行） */
function feedbackLocked(): boolean {
  return !guestAllowed('feedback')
}

function openFeedback(): void {
  if (!feedbackLocked()) {
    feedbackVisible.value = true
    return
  }
  ElMessage.warning('意见反馈需要登录后提交，已为你跳到登录页')
  void router.push({ path: '/auth' })
}

onMounted(() => {
  void ensureGuestPermissions()
  void loadSiteInfo()
})

/** 取机构信息（只用到版权行）；失败静默，保持默认文案 */
async function loadSiteInfo(): Promise<void> {
  try {
    const res = await fetchSiteInfo()
    customCopyright.value = (res.info?.copyright ?? '').trim()
  } catch {
    // 页脚不该因为一个可选接口失败而变形
  }
}
</script>

<template>
  <footer class="site-footer">
    <div class="zw-container">
      <div class="foot-grid">
        <div class="foot-brand">
          <!-- 品牌块与顶部导航同源：同一个 Logo、同一套「站名 + 机构名」两行结构 -->
          <RouterLink to="/" class="brand" title="回到首页" aria-label="回到首页">
            <span class="brand-mark" aria-hidden="true">
              <img src="/zero-logo.png" alt="" width="32" height="32" />
            </span>
            <span class="brand-text">
              <strong>零废弃知识库</strong>
              <em>六尺巷基金会</em>
            </span>
          </RouterLink>
          <!-- 简介压成一行：同一段话在站内出现 17 次（D1），页脚只留最短的一版 -->
          <p class="foot-lede">面向公众开放的零废弃资料库：分类浏览、关键词检索、直接问 AI。</p>
        </div>

        <nav class="foot-col" aria-label="浏览">
          <h4>浏览</h4>
          <!-- 与顶部导航同一套入口、同一顺序（首页在导航里，页脚不重复放） -->
          <RouterLink to="/shelf">资料库</RouterLink>
          <RouterLink to="/chat">AI 问答</RouterLink>
          <RouterLink to="/contribute">我要投稿</RouterLink>
        </nav>

        <nav class="foot-col" aria-label="使用">
          <h4>使用</h4>
          <!-- 三条都指向首页分隔线以下的对应板块（老页面 /about、/insights 已删） -->
          <RouterLink to="/#distribution">数据来源与口径</RouterLink>
          <RouterLink to="/#cite">引用与转载</RouterLink>
          <button
            type="button"
            class="foot-link-btn"
            :class="{ 'need-login': feedbackLocked() }"
            @click="openFeedback"
          >
            意见反馈
          </button>
          <RouterLink to="/#coop">联系与共建</RouterLink>
        </nav>
      </div>

      <div class="foot-bottom">
        <span class="foot-copy">{{ customCopyright || defaultCopyright(year) }}</span>
        <span class="foot-note">
          本站资料均为公开出版物或公开研究报告的收录与索引，权利归原作者与发布机构所有；
          引用请注明原始出处。
        </span>
      </div>
    </div>

    <!-- 站点级反馈：与资料详情页的资料级反馈共用同一个弹窗组件（B09） -->
    <FeedbackDialog v-model="feedbackVisible" scope="site" />
  </footer>
</template>

<style scoped>
.site-footer {
  position: relative;
  margin-top: 56px;
  padding: 44px 0 26px;
  /* 顶部一薄层薄荷、120px 内收干成白：给「内容区结束」一个软边界，
     不用加深色块也不用加粗边框（色值都是既有令牌） */
  background: linear-gradient(180deg, var(--zw-mint-2), var(--zw-surface) 120px);
  border-top: 1px solid var(--zw-line);
}

/* 压边：2px 的绿→薄荷渐隐横条，两端淡出，与首页 hero 下方那条分隔线同一语言 */
.site-footer::before {
  content: '';
  position: absolute;
  inset: -1px 0 auto;
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--zw-green-soft) 22%,
    var(--zw-mint) 50%,
    var(--zw-green-soft) 78%,
    transparent
  );
  opacity: 0.7;
  pointer-events: none;
}

.foot-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) repeat(2, minmax(140px, 1fr));
  gap: 32px;
}

/* ---- 品牌列 ---- */
.foot-brand {
  min-width: 0;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  text-decoration: none;
  color: var(--zw-ink);
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--zw-surface);
  box-shadow: var(--zw-shadow-sm);
  overflow: hidden;
  flex-shrink: 0;
}

.brand-mark img {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.brand-text strong {
  font-size: 17px;
  font-weight: 600;
  color: var(--zw-green-deep);
}

.brand-text em {
  font-style: normal;
  font-size: 12px;
  color: var(--zw-faint);
  letter-spacing: 0.04em;
}

.brand:hover .brand-text strong {
  text-decoration: underline;
  text-underline-offset: 4px;
}

.foot-lede {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--zw-muted);
  /* 简介压成一行：34em（442px）会在几档窄桌面上逼它折行，放宽到 40em */
  max-width: 40em;
}

/* ---- 链接列 ---- */
.foot-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}

.foot-col h4 {
  position: relative;
  margin: 2px 0 8px;
  padding-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--zw-ink);
  letter-spacing: 0.08em;
}

/* 标题下的 18px 短绿线：三列一眼分清，不必靠加粗或加大字号 */
.foot-col h4::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 18px;
  height: 2px;
  border-radius: 2px;
  background: var(--zw-green-soft);
}

.foot-col a,
.foot-link-btn {
  font-size: 13px;
  line-height: 1.9;
  color: var(--zw-muted);
  text-decoration: none;
  transition: color 0.16s ease, transform 0.16s ease;
}

.foot-col a:hover,
.foot-link-btn:hover {
  color: var(--zw-green-deep);
  text-decoration: underline;
  text-underline-offset: 3px;
  transform: translateX(2px);
}

/* 点下去的反馈：轻微下沉，手机上没有 hover 也能看出点到了 */
.foot-col a:active,
.foot-link-btn:active {
  transform: translateY(1px);
  color: var(--zw-green-deep);
}

/* 「意见反馈」是按钮不是链接（点了开弹窗），样式上要跟同列的链接长得一样 */
.foot-link-btn {
  border: 0;
  background: none;
  padding: 0;
  text-align: left;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

/* T11：游客权限把反馈关掉时的置灰（仍可点，会提示并跳登录页） */
.foot-link-btn.need-login {
  opacity: 0.55;
}

/* ---- 版权行 ---- */
.foot-bottom {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  align-items: baseline;
  justify-content: space-between;
  margin-top: 36px;
  padding-top: 18px;
  border-top: 1px solid var(--zw-line);
  font-size: 12px;
  color: var(--zw-faint);
}

.foot-copy {
  white-space: nowrap;
}

.foot-note {
  max-width: 56em;
  line-height: 1.8;
}

/* 窄屏：品牌独占一行，下面「浏览 / 使用」并排两列。
   手机（≤480）也维持两列 —— 旧的「一行一列」把页脚顶到 817px，是这次要压掉的主因。 */
@media (max-width: 860px) {
  .foot-grid {
    grid-template-columns: 1fr 1fr;
    gap: 28px 24px;
  }

  .foot-brand {
    grid-column: 1 / -1;
  }
}

@media (max-width: 480px) {
  .site-footer {
    margin-top: 40px;
    padding: 34px 0 22px;
  }

  .foot-grid {
    gap: 24px 20px;
  }

  .foot-bottom {
    margin-top: 28px;
    padding-top: 16px;
  }

  /* 版权行在手机上分两行：年份与说明各占一行，别挤成一条 */
  .foot-copy {
    white-space: normal;
  }
}
</style>
