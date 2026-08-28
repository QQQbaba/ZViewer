import { create } from 'zustand'
import { apiFetch, safeJson } from '@/lib/api'

export type RegistrationMode = 'open' | 'approval' | 'closed'
export type RoomCreationMode = 'admin-only' | 'all-users'
export type WasmCoreSource = 'author' | 'server' | 'custom'

/** 作者提供的 ffmpeg.wasm 核心 CDN 直链（wasmCoreSource=author 时使用） */
export const AUTHOR_WASM_CORE_URL =
  'https://github.cdn.zero251.xyz/Zero-wyc/ZViewer/main/frontend/public/ffmpeg/ffmpeg-core.wasm'

/**
 * 解析当前设置下 wasm 核心的实际下载 URL。
 * - author：作者 CDN 直链
 * - server：服务器 /ffmpeg 静态路由
 * - custom：自定义直链（无效时回退服务器路由）
 */
export function resolveWasmCoreUrl(): string {
  const { wasmCoreSource, wasmCoreCustomUrl } =
    useSystemSettingsStore.getState()
  if (wasmCoreSource === 'author') return AUTHOR_WASM_CORE_URL
  if (wasmCoreSource === 'custom') {
    const url = wasmCoreCustomUrl.trim()
    if (/^https?:\/\//i.test(url)) return url
  }
  return '/ffmpeg/ffmpeg-core.wasm'
}

export interface SystemSettings {
  autoDeleteInactiveRooms: boolean
  autoDeleteAfterHours: number
  registrationMode: RegistrationMode
  /** 房间创建权限模式：admin-only=仅管理员，all-users=所有登录用户（不含 guest） */
  roomCreationMode: RoomCreationMode
  betaFeaturesEnabled: boolean
  /** 禁用服务器端 DASH 模式，强制 MP4（仅服务器端，不影响 CLI） */
  dashDisabled: boolean
  /** 更新 CDN 加速开关：true 时更新检测和下载走 CDN 代理 */
  cdnAccelerate: boolean
  /** CDN 代理地址（如 https://gh-proxy.com），对所有 GitHub 请求使用前缀代理 */
  cdnProxyUrl: string
  /** 音频转码全局许可开关：Emby/Jellyfin 源由其媒体服务器转码；其余来源需影片级勾选 wasmEngine 才触发前端 ffmpeg.wasm 转码 */
  audioTranscodeEnabled: boolean
  /** wasm 转码核心（约 32MB）下载来源：author=作者 CDN 直链 / server=服务器中转 / custom=自定义直链 */
  wasmCoreSource: WasmCoreSource
  /** 自定义 wasm 核心直链（wasmCoreSource=custom 时生效） */
  wasmCoreCustomUrl: string
  dataSourceConfig?: Record<string, unknown> | null
}

interface SystemSettingsState extends SystemSettings {
  loading: boolean
  fetched: boolean
  /**
   * 拉取公开设置（无需鉴权）：仅包含 registrationMode / roomCreationMode / betaFeaturesEnabled。
   * App 启动时调用，用于 HomePage 决定是否显示「开始共享」按钮。
   */
  fetchSettings: () => Promise<void>
  /**
   * 拉取完整设置（需管理员鉴权）：包含 autoDelete / dataSourceConfig 等敏感字段。
   * AdminPage 设置页调用。
   */
  fetchAdminSettings: () => Promise<void>
  invalidate: () => void
}

const DEFAULT_SETTINGS: SystemSettings = {
  autoDeleteInactiveRooms: true,
  autoDeleteAfterHours: 24,
  registrationMode: 'approval',
  roomCreationMode: 'admin-only',
  betaFeaturesEnabled: false,
  dashDisabled: true,
  cdnAccelerate: false,
  cdnProxyUrl: 'https://gh-proxy.com',
  audioTranscodeEnabled: false,
  wasmCoreSource: 'author',
  wasmCoreCustomUrl: '',
  dataSourceConfig: null,
}

export const useSystemSettingsStore = create<SystemSettingsState>(
  (set, get) => ({
    ...DEFAULT_SETTINGS,
    loading: false,
    fetched: false,
    fetchSettings: async () => {
      if (get().loading || get().fetched) return
      set({ loading: true })
      try {
        // 公开接口：所有用户（含 guest）均可访问，仅返回非敏感字段。
        // 用于 HomePage 决定是否显示「开始共享」按钮。
        const res = await apiFetch('/api/auth/public-settings')
        const data = await safeJson<{
          success: boolean
          settings?: Partial<SystemSettings>
          message?: string
        }>(res, { success: false })
        if (data.success && data.settings) {
          set({
            ...DEFAULT_SETTINGS,
            ...data.settings,
            fetched: true,
          })
        }
      } catch (err) {
        console.error('[systemSettingsStore] fetch settings error:', err)
      } finally {
        set({ loading: false })
      }
    },
    fetchAdminSettings: async () => {
      set({ loading: true })
      try {
        const res = await apiFetch('/api/admin/settings')
        const data = await safeJson<{
          success: boolean
          settings?: Partial<SystemSettings>
          message?: string
        }>(res, { success: false })
        if (data.success && data.settings) {
          set({
            ...DEFAULT_SETTINGS,
            ...data.settings,
            fetched: true,
          })
        }
      } catch (err) {
        console.error('[systemSettingsStore] fetch admin settings error:', err)
      } finally {
        set({ loading: false })
      }
    },
    invalidate: () => set({ fetched: false }),
  })
)
