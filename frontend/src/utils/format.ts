/**
 * 展示用的小格式化工具 —— 2026-10-10 新增
 *
 * 为什么单开一份：书架页、详情页、概览页都要显示「体积 / 年份 / 大数字」，
 * 各写一遍最容易出现同一个数在不同页面显示成不同样子（如 2.4 GB 与 2524 MB）。
 */

/** 字节 → 人看的体积。对外展示只用 GB / MB 两档，够用且好读。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  const mb = bytes / 1024 ** 2
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * 年份展示。
 * ⚠️ `year === 0` 是「台账未填年份」的内部表示，不是公元 0 年 ——
 * 直接显示 0 会让人以为资料很古老，必须转成「年份不详」。
 */
export function formatYear(year: number): string {
  return year > 0 ? `${year} 年` : '年份不详'
}

/** 年份区间文字：`1990–2026` */
export function formatYearSpan(range: { min: number; max: number } | null): string {
  return range ? `${range.min}–${range.max}` : '—'
}

/** 千分位大数字（统计条用） */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—'
}
