import { create } from 'zustand'
import { apiFetch, API_URL } from '@/lib/api'

export type RegistrationMode = 'open' | 'approval' | 'closed'

export interface SystemSettings {
  autoDeleteInactiveRooms: boolean
  autoDeleteAfterHours: number
  registrationMode: RegistrationMode
  betaFeaturesEnabled: boolean
  dataSourceConfig?: Record<string, unknown> | null
}

interface SystemSettingsState extends SystemSettings {
  loading: boolean
  fetched: boolean
  fetchSettings: () => Promise<void>
  invalidate: () => void
}

const DEFAULT_SETTINGS: SystemSettings = {
  autoDeleteInactiveRooms: true,
  autoDeleteAfterHours: 24,
  registrationMode: 'approval',
  betaFeaturesEnabled: false,
  dataSourceConfig: null,
}

export const useSystemSettingsStore = create<SystemSettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  loading: false,
  fetched: false,
  fetchSettings: async () => {
    if (get().loading || get().fetched) return
    set({ loading: true })
    try {
      const res = await apiFetch(`${API_URL}/api/admin/settings`)
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
  invalidate: () => set({ fetched: false }),
}))
