/**
 * 游客权限 · 共享状态（T11 新增）
 *
 * 资料详情页、页脚、设置页都要读同一份开关，但**不该各拉一次**（一次标签页里
 * 十几个组件各发一遍请求没道理）。所以照 useAuth 的写法做成模块级单例：
 * 第一次用的人负责拉，之后直接读。
 *
 * 用法：
 *   const { values, loaded, ensure, allows } = useGuestPermissions()
 *   onMounted(() => { void ensure() })          // 拉一次
 *   allows('preview')                            // 游客能不能预览
 *
 * 🔴 「游客能不能用」这件事必须同时看登录态：**已登录用户不受游客开关限制**
 *    （后端也是这么判的）。所以调用处一般写成 `guestAllowed(feature)`，
 *    它内部会带上 `isLoggedIn` 判断 —— 见 guestAllowed 的注释。
 */
import { computed, ref } from 'vue'

import {
  fetchGuestPermissions,
  GUEST_FALLBACK_VALUES,
  type GuestFeature,
  type GuestPermissionsPayload
} from '../api/guest'
import { useAuth } from './useAuth'

/** 模块级单例：多个组件共享同一份开关状态 */
const payload = ref<GuestPermissionsPayload | null>(null)
const loading = ref(false)
const loaded = ref(false)

let inflight: Promise<void> | null = null

/** 拉一次开关（并发调用只会真的发一次请求） */
async function ensure(): Promise<void> {
  if (loaded.value) return
  if (inflight) return inflight
  loading.value = true
  inflight = fetchGuestPermissions()
    .then((data) => {
      payload.value = data
      loaded.value = true
    })
    .finally(() => {
      loading.value = false
      inflight = null
    })
  return inflight
}

export function useGuestPermissions() {
  const { isLoggedIn } = useAuth()

  /** 当前开关值；还没拉到时给默认值（宁可先按开放走，后端会兜住） */
  const values = computed(() => payload.value?.values ?? GUEST_FALLBACK_VALUES)

  /** 这一项对「游客」开不开（不管登录态） */
  function allows(feature: GuestFeature): boolean {
    return values.value[feature] === true
  }

  /**
   * 当前这个访客能不能用某项功能。
   *
   * 已登录 → 一律 true（游客开关只管游客）；
   * 未登录 → 看开关。关闭时调用方据此把按钮置灰并引导去登录。
   */
  function guestAllowed(feature: GuestFeature): boolean {
    if (isLoggedIn.value) return true
    return allows(feature)
  }

  return { values, loading, loaded, ensure, allows, guestAllowed }
}