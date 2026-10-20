<script setup lang="ts">
/**
 * 分享弹窗（二维码）—— B09 公众互动模块（2026-10-13）
 *
 * 为什么做这个：这是一份**对外**的公开资料库，链接是要发到微信群、贴进 PPT、
 * 印进宣传单的。原来的「复制分享链接」只解决了「发链接」，解决不了「线下看」——
 * 开会、摆摊、发传单时没法给人发一条链接，得有个能扫的码。
 *
 * 实现要点：
 *   1. 二维码**本地生成**（见 utils/qrcode.ts），不外发链接给第三方接口。
 *   2. 链接用大字号单行输入框展示：小屏上手动复制也不容易出错，点一下可全选。
 *   3. 「保存二维码」导出 PNG——发给设计做物料时不用他再自己生成一遍。
 *
 * 边界（如实说明，避免误解）：二维码指向的是**本页地址**，扫码只在手机上打开这一页；
 * 在线预览 / 下载原件仍需登录（全站规则）。所以弹窗里把这条写清楚，不然用户会以为扫码就能拿文件。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { createQrMatrix, drawQrToCanvas, qrSvgPath } from '../utils/qrcode'

const props = defineProps<{
  modelValue: boolean
  /** 资料标题（用于提示语与导出的文件名） */
  title: string
  /** 要分享的完整地址（含协议与域名） */
  url: string
}>()

const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

/** 二维码矩阵：生成失败（内容异常长等）时置空，模板会显示兜底文案，不白屏 */
const matrix = computed(() => {
  try {
    return createQrMatrix(props.url)
  } catch {
    return null
  }
})

/** viewBox 向外扩 4 个模块 = 二维码规范要求的静区（留白不足会明显降低扫码率） */
const viewBox = computed(() =>
  matrix.value ? `-4 -4 ${matrix.value.count + 8} ${matrix.value.count + 8}` : '0 0 1 1'
)
const qrPath = computed(() => (matrix.value ? qrSvgPath(matrix.value) : ''))

const linkInput = ref<HTMLInputElement | null>(null)

/** 微信内置浏览器里，系统分享菜单才是主路径，提示语要不一样 */
const inWechat = computed(() => /MicroMessenger/i.test(typeof navigator === 'undefined' ? '' : navigator.userAgent))

watch(visible, (open) => {
  if (!open) return
  // 打开后选中链接，方便键盘直接复制
  void nextTick(() => linkInput.value?.select())
})

async function copyLink(): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(props.url)
    } else {
      // 非安全上下文（http 局域网演示）没有 clipboard API，退回旧办法
      const input = document.createElement('input')
      input.value = props.url
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      input.remove()
    }
    ElMessage.success('链接已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选中链接复制')
  }
}

/** 文件名清洗：导出 PNG 时不能带路径分隔符等非法字符，过长也存不下 */
function safeFileName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || '资料').slice(0, 40)
}

/** 导出二维码 PNG（打印物料用） */
function saveQrImage(): void {
  if (!matrix.value) return
  const canvas = document.createElement('canvas')
  drawQrToCanvas(canvas, matrix.value, { scale: 12, quietZone: 4 })
  const link = document.createElement('a')
  link.download = `${safeFileName(props.title)}-二维码.png`
  link.href = canvas.toDataURL('image/png')
  link.click()
}
</script>

<template>
  <el-dialog v-model="visible" title="分享这份资料" width="560px" append-to-body>
    <div v-if="!matrix" class="share-empty">
      这份资料的链接过长，二维码生成失败。请改用「复制分享链接」。
    </div>

    <div v-else class="share-body">
      <div class="qr-box">
        <svg class="qr-svg" :viewBox="viewBox" role="img" aria-label="资料二维码">
          <rect x="-4" y="-4" :width="matrix.count + 8" :height="matrix.count + 8" fill="#ffffff" />
          <path :d="qrPath" fill="#000000" />
        </svg>
        <p class="qr-caption">手机扫一扫，打开这份资料</p>
      </div>

      <div class="share-info">
        <p class="share-title">{{ title }}</p>

        <label class="link-label" for="share-link">页面链接</label>
        <input id="share-link" ref="linkInput" class="link-input zw-num" :value="url" readonly />

        <div class="share-btns">
          <el-button type="primary" @click="copyLink">复制链接</el-button>
          <el-button plain @click="saveQrImage">保存二维码</el-button>
        </div>

        <ul class="share-tips">
          <li v-if="inWechat">在微信里分享：点右上角「···」→ 发送给朋友 / 分享到朋友圈。</li>
          <li v-else>发到微信群：先复制链接，粘贴到群里即可；对方点开就是这一页。</li>
          <li>二维码可用于线下活动、PPT 或打印物料，扫码直达本页。</li>
          <li>在线预览与下载原件需登录（注册免费）。</li>
        </ul>
      </div>
    </div>

    <template #footer>
      <span class="foot-hint">著作权归原发布机构所有，转发请勿改动原始出处。</span>
    </template>
  </el-dialog>
</template>

<style scoped>
.share-body {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}

.qr-box {
  flex-shrink: 0;
  width: 196px;
  text-align: center;
}

.qr-svg {
  display: block;
  width: 196px;
  height: 196px;
  border: 1px solid var(--zw-line-strong);
  border-radius: var(--zw-radius-sm);
  background: var(--zw-surface);
}

.qr-caption {
  margin: 10px 0 0;
  font-size: var(--zw-fs-xs);
  color: var(--zw-muted);
}

.share-info {
  flex: 1;
  min-width: 0;
}

.share-title {
  margin: 0 0 12px;
  font-size: var(--zw-fs-body);
  line-height: 1.6;
  color: var(--zw-ink);
}

.link-label {
  display: block;
  font-size: var(--zw-fs-xs);
  color: var(--zw-muted);
  margin-bottom: 6px;
}

.link-input {
  width: 100%;
  padding: 8px 10px;
  font-size: var(--zw-fs-xs);
  color: var(--zw-text);
  background: var(--zw-mint-2);
  border: 1px solid var(--zw-line-strong);
  border-radius: var(--zw-radius-sm);
}

.share-btns {
  display: flex;
  gap: 10px;
  margin: 14px 0 12px;
}

.share-tips {
  margin: 0;
  padding-left: 18px;
  font-size: var(--zw-fs-xs);
  line-height: 1.9;
  color: var(--zw-muted);
}

.share-empty {
  font-size: var(--zw-fs-sm);
  line-height: 1.9;
  color: var(--zw-muted);
}

.foot-hint {
  font-size: var(--zw-fs-xs);
  color: var(--zw-faint);
}

@media (max-width: 640px) {
  .share-body {
    flex-direction: column;
    gap: 16px;
    align-items: center;
  }
}
</style>
