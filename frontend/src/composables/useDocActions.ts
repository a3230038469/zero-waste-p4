/**
 * 资料的「在线预览 / 下载原件」—— 全站唯一实现（2026-10-18 新增）
 *
 * 为什么单独抽出来：这两个动作原先只长在资料详情页里，首页卡片、资料库列表卡
 * 想给同一个按钮，就得把「登录判断 / 游客权限开关 / 大文件限制 / 失败文案」
 * 整套再抄一遍。抄第二遍就会长出「详情页要登录、卡片不用」这种同一件事两种口径
 * 的毛病 —— 抽到这里之后谁想用谁调，口径只有一处。
 *
 * 用法：
 *   const { preview, download, previewUrl, previewVisible, locked } = useDocActions()
 *   onMounted(() => { void initGuestPermissions() })   // 拉一次游客开关
 *
 * 说明：游客开关是模块级单例（见 useGuestPermissions），十几个卡片各调一次
 *      `initGuestPermissions()` 也只会真的发一个请求。
 */
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import { LARGE_FILE_LIMIT, downloadDoc, getPreviewUrl } from '../api/docs'
import type { GuestFeature } from '../api/guest'
import type { DocItem } from '../api/types'
import { formatBytes } from '../utils/format'
import { useAuth } from './useAuth'
import { useGuestPermissions } from './useGuestPermissions'

export function useDocActions() {
  const route = useRoute()
  const router = useRouter()
  const { user, isLoggedIn, fetchMe } = useAuth()
  const { ensure: ensureGuestPermissions, guestAllowed } = useGuestPermissions()

  /** 预览状态（谁用谁有一份，互不干扰） */
  const previewUrl = ref('')
  const previewVisible = ref(false)
  const previewLoading = ref(false)

  /** 正在下载的那一份 id —— 列表里只让被点的那张卡转圈，不是所有卡一起转 */
  const downloadingId = ref('')

  /** 某一项当前是否被锁（游客且后台把该功能关了）—— 按钮置灰用它 */
  function locked(feature: GuestFeature): boolean {
    return !guestAllowed(feature)
  }

  /** 读一次游客权限开关（模块级单例，多个卡片一起调也只发一个请求） */
  async function initGuestPermissions(): Promise<void> {
    await ensureGuestPermissions()
  }

  /**
   * 门槛判断：未登录且游客开关关着 → 说一句人话并跳登录页，带回跳地址。
   *
   * 门槛只看 isLoggedIn（本地有 token 即算登录），不看 user：
   * 云端 /me 可能取不回用户信息，若卡 user 会让已登录用户点不动下载/预览。
   * 已登录用户不看任何游客开关。
   */
  async function requireAccess(feature: GuestFeature): Promise<boolean> {
    if (isLoggedIn.value) {
      if (!user.value) await fetchMe()
      return true
    }
    if (guestAllowed(feature)) return true
    ElMessage.warning('该功能需要登录后使用，已为你跳到登录页')
    void router.push({ path: '/auth', query: { redirect: route.fullPath } })
    return false
  }

  function revokePreview(): void {
    if (previewUrl.value) {
      URL.revokeObjectURL(previewUrl.value)
      previewUrl.value = ''
    }
  }

  /** 在线预览：先把文件取回来，失败给出中文原因（iframe 自己拿不到 HTTP 状态码） */
  async function preview(doc: DocItem): Promise<void> {
    if (!(await requireAccess('preview'))) return
    if (doc.size > LARGE_FILE_LIMIT) {
      ElMessage.warning(`文件较大（${formatBytes(doc.size)}），建议下载后查看`)
      return
    }
    previewLoading.value = true
    try {
      revokePreview()
      previewUrl.value = await getPreviewUrl(doc)
      previewVisible.value = true
    } catch (err) {
      ElMessage.error(err instanceof Error ? err.message : '预览失败，请稍后再试')
    } finally {
      previewLoading.value = false
    }
  }

  /** 下载原件：超 20MB 先确认；成功才提示成功，失败把原因说清楚 */
  async function download(doc: DocItem): Promise<void> {
    if (!(await requireAccess('download'))) return
    if (doc.size > LARGE_FILE_LIMIT) {
      try {
        await ElMessageBox.confirm(
          `文件较大（${formatBytes(doc.size)}），下载可能需要一些时间，确定下载吗？`,
          '大文件下载',
          { confirmButtonText: '继续下载', cancelButtonText: '取消', type: 'warning' }
        )
      } catch {
        return // 用户取消
      }
    }
    downloadingId.value = doc.id
    try {
      await downloadDoc(doc)
      ElMessage.success('已开始下载')
    } catch (err) {
      ElMessage.error(err instanceof Error ? err.message : '下载失败，请稍后再试')
    } finally {
      downloadingId.value = ''
    }
  }

  return {
    previewUrl,
    previewVisible,
    previewLoading,
    downloadingId,
    locked,
    initGuestPermissions,
    requireAccess,
    revokePreview,
    preview,
    download
  }
}
