import { create } from 'zustand'
import { apiFetch } from '@/lib/api'

export type RegistrationMode = 'open' | 'approval' | 'closed'
export type RoomCreationMode = 'admin-only' | 'all-users'

export interface SystemSettings {
  autoDeleteInactiveRooms: boolean
  autoDeleteAfterHours: number
  registrationMode: RegistrationMode
  /** 房间创建权限模式：admin-only=仅管理员，all-users=所有登录用户（不含 guest） */
  roomCreationMode: RoomCreationMode
  betaFeaturesEnabled: boolean
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
        const data = (await res.json()) as {
          success: boolean
          settings?: Partial<SystemSettings>
          message?: string
        }
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
        const data = (await res.json()) as {
          success: boolean
          settings?: Partial<SystemSettings>
          message?: string
        }
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
