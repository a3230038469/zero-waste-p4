/**
 * 资料接口 —— 负责人：韶茹
 *
 * 本文件要提供的接口（详见 docs/接口约定.md）：
 *   GET /api/docs              资料列表（四维筛选 + 搜索 + 分页 + 排序）
 *   GET /api/docs/facets       筛选项（各维度值 + 数量）
 *   GET /api/docs/:id          资料详情
 *   GET /api/docs/:id/preview  在线预览
 *   GET /api/docs/:id/download 下载原件（文件名「年份-机构-标题」）
 *
 * 依赖：./weknora 对接层（自己写）
 * 注意：只改本文件，不要动 auth.ts / embed.ts
 */
import { Router } from 'express'

const router = Router()

// TODO(韶茹): 实现上面 5 个接口

export default router
