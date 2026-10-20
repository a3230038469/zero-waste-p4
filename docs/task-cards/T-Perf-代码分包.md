# T-Perf · 首屏包体拆分

> 归属：**前端（谁接谁做）** · 状态：**📋 待排期，未开工**
> 来源：`feat-yuey-visual` 收尾时的体检发现（2026-10-20，月月记录）
> 与视觉任务的关系：**不属于交互/视觉范畴**，独立成卡，避免混进视觉 PR

---

## 一、问题

生产构建后，主包单文件 **1095 KB（gzip 约 372 KB）**，浏览器必须下载并解析完它，首屏才有内容。

```
1095 KB  index-CQt5SHMa.js      ← 主包，全部第三方库都在这
  79 KB  ask-*.js
  32 KB  DocDetailView-*.js
  15 KB  AdminKnowledgeView-*.js
```

页面级代码其实已经按路由拆开了（`DocDetailView` 只有 32 KB），**问题不在业务代码，在主包里堆的第三方库**。

移动端 4G 下，372 KB 的 gzip 大约要 2–4 秒，且解析会占用主线程 —— 这段时间用户看到的是白屏或骨架屏。

## 二、目标

| 指标 | 现在 | 目标 |
|---|---|---|
| 主包（未压缩） | 1095 KB | **≤ 300 KB** |
| 主包（gzip） | 372 KB | **≤ 120 KB** |
| 首屏可见时间（Fast 3G 模拟） | 未测 | 比现在快 40% 以上 |
| 页面功能 | — | 零变化，不改任何业务逻辑 |

## 三、方案（分两期，第一期风险极低）

### 一期：只做拆包，不改任何引用方式

改 `frontend/vite.config.ts`，在 `build.rollupOptions.output` 里加 `manualChunks`，把第三方库按「变更频率」分成几个文件：

| 分组 | 内容 | 理由 |
|---|---|---|
| `vendor-vue` | `vue`、`vue-router`、`pinia` | 版本稳定，可长期缓存 |
| `vendor-element` | `element-plus`、`@element-plus/*` | 体积最大头，单独成文件后主包立刻瘦下来 |
| `vendor-misc` | 其余 `node_modules`（axios 等） | 兜底，避免全塞进主包 |

要点：

- 只影响**构建产物**，开发模式不变，页面代码一行不用动。
- 拆出来的文件能并行下载，且 `vendor-*` 带 hash，发版后用户不必重复下载。
- 注意**不要**把 `element-plus` 拆成几十个碎文件（会变成几十个请求），按包拆即可。

### 二期（可选，收益更大但有改造量）

Element Plus 现在是**全量引入**（`main.ts` 里 `app.use(ElementPlus)`）。改成按需引入（`unplugin-vue-components` + `unplugin-auto-import`）后，`vendor-element` 通常能从 800 KB 级降到 300 KB 级。

风险点：按需引入后，**用到的组件必须能被自动扫描到**；模板里动态拼的组件名、`ElMessage`/`ElMessageBox` 这类函数式调用需要手动引入，漏一个就是运行时白屏。所以建议一期上线观察一周、确认稳定后再动二期。

## 四、验收

```bash
npm run build:frontend
ls -S frontend/dist/assets/*.js | head -5     # 看主包是否降到目标值
npm run verify:all                            # 必须全绿
```

外加人工走查（构建产物 + `npm run preview`）：

1. 首页、资料库、详情、投稿、审核、数据概览、AI 问答、404 全部能正常打开
2. 浏览器 Network 面板确认 `vendor-*` 返回 `200`，无 404
3. 断网重进，确认 Service Worker / 缓存策略没被破坏（如果后续上了 PWA）

## 五、风险与注意事项

| 风险 | 说明 | 应对 |
|---|---|---|
| 拆包后循环依赖报警 | Rollup 会提示 `Circular dependency` | 只看是否影响产物，必要时把循环的两者放同一组 |
| 首屏请求数变多 | HTTP/1.1 下 3 个 JS 并发有开销 | 站点已上 HTTP/2 则无影响；未上则控制在 3 个文件内 |
| 与视觉 PR 冲突 | `vite.config.ts` 也被视觉侧改过（已回滚临时副本） | 本卡单独开分支，不合进 `feat-yuey-visual` |
| 二期白屏 | 按需引入漏组件 | 二期必须全页面走查，不能只跑构建 |

## 六、为什么当时没有直接做

视觉任务的验收标准是「交互态、令牌一致性、响应式、端到端流程」，包体积不在其中。混进视觉 PR 会让评审范围失焦，也容易在验收时被当成"视觉改动引入了性能风险"。所以这里只记录、不施工。
