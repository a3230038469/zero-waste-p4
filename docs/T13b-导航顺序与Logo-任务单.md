# T13b · 补做：导航顺序调整 + 品牌 Logo 换新图标（任务单）

> 派给：OpenCode（执行方）｜ 主控：本对话（亲跑验收）
> 工作分支：`feat/merge-dingzi-ui`（T13 已提交为 `f2ac233`）
> 回退点：`f2ac233`（T13 成果）；更早 `backup-before-dingzi-merge-20261015`（= 60a7951）

## 〇、为什么有这一单

T13 任务单**漏写了** `SiteNav.vue`（主控失误，不是你的问题）：小志已批准的 D 组两项——**导航顺序**与**换品牌 Logo**——没落地。
本单只补这两件事，**范围极小，不许顺手改别的**。

## 一、要做什么（就两个文件里的两件事）

### ① `frontend/src/components/SiteNav.vue` —— 导航顺序

把 `NAV` 数组顺序改为（**关于项目提前到第一位**，其余保持现有相对次序）：

```
关于项目 → 首页 → 资料库 → 我要投稿 → 数据概览 → AI 问答
```

- ✅ **必须保留**现有的 `{ to: '/contribute', label: '我要投稿' }` 这一项（B09 的公众投稿入口，不能丢）
- ✅ `exact` 字段、每一项的 `to` / `label` 一律照旧，**只调顺序**
- ✅ 顶部注释里那句"放在「关于项目」旁边"的说明已过期 —— 同步改成如实描述新顺序（一句话即可）
- ❌ 不动样式、不动 hover / 高亮逻辑、不动登录态那一段

### ② `frontend/src/components/SiteNav.vue` —— 品牌 Logo 换新图标

把 `.brand-mark` 里那段内联 SVG（盾牌+对勾）换成：

```html
<span class="brand-mark" aria-hidden="true">
  <img src="/zero-logo.png" alt="" class="brand-logo-img" width="32" height="32" />
</span>
```

样式改法（照丁梓柔那份，见快照 `<她>\frontend\src\components\SiteNav.vue`）：
`.brand-mark` 去掉 `color/background/box-shadow`，改 `overflow: hidden;`；新增

```css
.brand-mark img {
  width: 32px;
  height: 32px;
  object-fit: contain;
}
```

- `zero-logo.png` 已在 `frontend/public/`（T13 已落盘），**不要**再复制文件
- ❌ 不动 `.brand-text`、不动导航项样式

## 二、红线

1. ❌ 只许改 `frontend/src/components/SiteNav.vue` **这一个文件**。其他任何文件一行都不许动。
2. ❌ 不许动 `backend/**`、`SiteFooter.vue`、`Admin*`、`api/`、`composables/`、`router/`、`package*.json`。
3. ✅ 改完必须跑通 `npm run verify`（四条零错误零警告）+ `npm run build`。

## 三、交付要求

1. `git status --short` 必须**只有一个文件**（`SiteNav.vue`）
2. 自证：`grep -n "关于项目\|/contribute\|zero-logo" frontend/src/components/SiteNav.vue` 回显贴进交付说明
3. 把结果写进 `docs/T13b-交付说明.md`（做了什么 / 命令 / 结果 / 有无报错）

## 四、止损

`npm run verify` 修不过或需要动别的文件才能继续 → **立刻停手**，执行
`git checkout -- frontend/src/components/SiteNav.vue` 回到本单基线，如实报告卡点。
