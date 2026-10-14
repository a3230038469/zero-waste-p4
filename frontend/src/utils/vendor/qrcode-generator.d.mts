/**
 * qrcode-generator.mjs 的类型声明（B09，2026-10-13）
 *
 * 原包自带 dist/qrcode.d.ts（声明成 `declare module 'qrcode-generator'`，对应 CommonJS 入口），
 * 但我们是**文件内置**，不走包名解析，所以这里按实际用到的能力补一份最小声明。
 * 字段名与上游 d.ts 保持一致，方便以后换成正式依赖时直接删掉本文件。
 */
export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H'

/** 0 = 按数据长度自动选版本 */
export type TypeNumber = number

export interface QRCode {
  addData(data: string, mode?: 'Numeric' | 'Alphanumeric' | 'Byte' | 'Kanji'): void
  make(): void
  getModuleCount(): number
  isDark(row: number, col: number): boolean
}

export interface QRCodeFactory {
  (typeNumber: TypeNumber, errorCorrectionLevel: ErrorCorrectionLevel): QRCode
  stringToBytes(s: string): number[]
  stringToBytesFuncs: Record<string, (s: string) => number[]>
}

declare const qrcode: QRCodeFactory
export default qrcode
