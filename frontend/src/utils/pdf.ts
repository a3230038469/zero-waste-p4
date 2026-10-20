/**
 * PDF 小工具 —— 只做「数页数」这一件事（2026-10-19 新增）
 *
 * 为什么要单独一个文件：资料管理页在上传前要自检页数（MinerU 云实测硬限 200 页，
 * 见互通角信-30/31），而 pdf.js 的 worker 必须在用之前显式指一次路 ——
 * 各页各写一份容易漏。真正渲染 PDF 的是 `components/PdfViewer.vue`（它自己也指了一次，
 * 值相同、互不冲突）。
 */
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
}

/**
 * MinerU 云解析的实测硬限（A 侧打官方接口实测，不是照官网文档抄的：
 * 官网写「≤200MB / ≤600 页」，实测页数上限就是 200 页）。
 */
export const LARGE_FILE_LIMIT_BYTES = 200 * 1024 * 1024
export const LARGE_PAGE_LIMIT = 200

/** 文件是不是 PDF（非 PDF 只按大小判断，数页数对它们没意义） */
export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

/**
 * 读页数。只读文件头，很快。
 *
 * ⚠️ 数不出来就返回 0，调用方**不能**因为数不出页数就卡住上传
 * （信-31 明确要求：那就退回「只看大小」）。
 */
export async function countPdfPages(file: File): Promise<number> {
  try {
    const buf = await file.arrayBuffer()
    const task = pdfjsLib.getDocument({ data: new Uint8Array(buf) })
    const doc = await task.promise
    const pages = doc.numPages
    // v6 里 PDFDocumentProxy 没有 destroy()，要销毁的是 loadingTask
    await task.destroy()
    return pages
  } catch {
    return 0
  }
}
