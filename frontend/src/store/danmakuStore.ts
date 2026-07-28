import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DanmakuItem, DanmakuSource } from '@/modules/danmaku/types'

export interface DanmakuTrack {
  trackId: string
  label: string
  source: DanmakuSource
  items: DanmakuItem[]
  offset: number
  /** 是否暂时隐藏该轨道的弹幕 */
  hidden?: boolean
}

export interface DanmakuTypeFilters {
  scroll: boolean
  fixed: boolean
  color: boolean
  advanced: boolean
}

export interface DanmakuAdvancedStyle {
  fontFamily: string
  strokeWidth: number
  shadowBlur: number
  density: number
}

export interface DanmakuStyleState {
  filters: DanmakuTypeFilters
  scaleWithScreen: boolean
  displayArea: number
  opacity: number
  fontSize: number
  speed: number
  advanced: DanmakuAdvancedStyle
}

export const DEFAULT_DANMAKU_STYLE: DanmakuStyleState = {
  filters: {
    scroll: true,
    fixed: true,
    color: true,
    advanced: true,
  },
  // 默认不随屏幕缩放：弹幕字号固定为用户设置的 fontSize，
  // 不根据视频容器尺寸自动放大，避免不同分辨率下字号不可预测
  scaleWithScreen: false,
  displayArea: 0.75,
  opacity: 1,
  fontSize: 25,
  speed: 1,
  advanced: {
    fontFamily:
      '"Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif',
    strokeWidth: 0,
    shadowBlur: 2,
    density: 1,
  },
}

/** 实时弹幕记录（房间内用户互发），用于弹幕列表面板展示 */
export interface RealtimeDanmakuEntry {
  id: string
  content: string
  sender?: string
  /** 发送时的播放进度（秒） */
  time: number
  /** 是否本人发送 */
  self?: boolean
}

/** 实时弹幕记录上限（超出后丢弃最旧的） */
const REALTIME_LOG_LIMIT = 500
/** 已删除弹幕记录上限 */
const DELETED_LOG_LIMIT = 200

/** 已删除弹幕记录（用于管理面板展示与恢复） */
export interface DeletedDanmakuEntry {
  trackId: string
  trackLabel: string
  item: DanmakuItem
}

interface DanmakuState {
  tracks: DanmakuTrack[]
  style: DanmakuStyleState
  /** 实时弹幕记录（会话级，不持久化） */
  realtimeLog: RealtimeDanmakuEntry[]
  /** 弹幕屏蔽关键词（会话级，不持久化） */
  blockKeywords: string[]
  /** 已删除弹幕记录（会话级，不持久化） */
  deletedLog: DeletedDanmakuEntry[]
  /** 弹幕层刷新信号（侧栏屏蔽/删除后通知播放器弹幕层清屏重载） */
  refreshSignal: number
  triggerDanmakuRefresh: () => void
  addTrack: (
    trackId: string,
    label: string,
    source: DanmakuSource,
    items: DanmakuItem[],
    offset?: number
  ) => void
  removeTrack: (trackId: string) => void
  updateTrackOffset: (trackId: string, offset: number) => void
  toggleTrackHidden: (trackId: string) => void
  setDefaultTrack: (items: DanmakuItem[]) => void
  setStyle: (updates: Partial<DanmakuStyleState>) => void
  setFilters: (updates: Partial<DanmakuTypeFilters>) => void
  setAdvancedStyle: (updates: Partial<DanmakuAdvancedStyle>) => void
  resetStyle: () => void
  addRealtime: (entry: RealtimeDanmakuEntry) => void
  clearRealtime: () => void
  removeRealtime: (id: string) => void
  addBlockKeyword: (keyword: string) => void
  removeBlockKeyword: (keyword: string) => void
  /** 从时间轴轨道中删除指定弹幕项（本地生效，用于弹幕列表管理） */
  removeTrackItem: (trackId: string, itemId: string) => void
  restoreTrackItem: (trackId: string, item: DanmakuItem) => void
  addDeletedLog: (entry: DeletedDanmakuEntry) => void
  removeDeletedLog: (trackId: string, itemId: string) => void
  clearDeletedLog: () => void
}

export const useDanmakuStore = create<DanmakuState>()(
  persist(
    (set, get) => ({
      tracks: [],
      style: DEFAULT_DANMAKU_STYLE,
      realtimeLog: [],
      blockKeywords: [],
      deletedLog: [],
      refreshSignal: 0,
      triggerDanmakuRefresh: () => {
        set((state) => ({ refreshSignal: state.refreshSignal + 1 }))
      },

      addTrack: (trackId, label, source, items, offset = 0) => {
        set((state) => {
          const exists = state.tracks.findIndex((t) => t.trackId === trackId)
          const next: DanmakuTrack = {
            trackId,
            label,
            source,
            items: [...items].sort((a, b) => a.time - b.time),
            offset,
          }
          if (exists >= 0) {
            const tracks = [...state.tracks]
            tracks[exists] = next
            return { tracks }
          }
          return { tracks: [...state.tracks, next] }
        })
      },

      removeTrack: (trackId) => {
        set((state) => ({
          tracks: state.tracks.filter((t) => t.trackId !== trackId),
        }))
      },

      updateTrackOffset: (trackId, offset) => {
        set((state) => ({
          tracks: state.tracks.map((t) =>
            t.trackId === trackId ? { ...t, offset } : t
          ),
        }))
      },

      toggleTrackHidden: (trackId) => {
        set((state) => ({
          tracks: state.tracks.map((t) =>
            t.trackId === trackId ? { ...t, hidden: !t.hidden } : t
          ),
        }))
      },

      setDefaultTrack: (items) => {
        get().addTrack('default', '当前视频', 'bilibili-video', items, 0)
      },

      setStyle: (updates) => {
        set((state) => ({ style: { ...state.style, ...updates } }))
      },

      setFilters: (updates) => {
        set((state) => ({
          style: {
            ...state.style,
            filters: { ...state.style.filters, ...updates },
          },
        }))
      },

      setAdvancedStyle: (updates) => {
        set((state) => ({
          style: {
            ...state.style,
            advanced: { ...state.style.advanced, ...updates },
          },
        }))
      },

      resetStyle: () => {
        set({ style: DEFAULT_DANMAKU_STYLE })
      },

      addRealtime: (entry) => {
        set((state) => {
          const next = [...state.realtimeLog, entry]
          if (next.length > REALTIME_LOG_LIMIT) {
            next.splice(0, next.length - REALTIME_LOG_LIMIT)
          }
          return { realtimeLog: next }
        })
      },

      clearRealtime: () => {
        set({ realtimeLog: [] })
      },

      removeRealtime: (id) => {
        set((state) => ({
          realtimeLog: state.realtimeLog.filter((entry) => entry.id !== id),
        }))
      },

      addBlockKeyword: (keyword) => {
        const trimmed = keyword.trim()
        if (!trimmed) return
        set((state) =>
          state.blockKeywords.includes(trimmed)
            ? state
            : { blockKeywords: [...state.blockKeywords, trimmed] }
        )
      },

      removeBlockKeyword: (keyword) => {
        set((state) => ({
          blockKeywords: state.blockKeywords.filter((k) => k !== keyword),
        }))
      },

      removeTrackItem: (trackId, itemId) => {
        set((state) => ({
          tracks: state.tracks.map((t) =>
            t.trackId === trackId
              ? { ...t, items: t.items.filter((item) => item.id !== itemId) }
              : t
          ),
          // 同步触发刷新信号，确保播放器弹幕层在删除后立即清屏重载
          refreshSignal: state.refreshSignal + 1,
        }))
      },

      restoreTrackItem: (trackId, item) => {
        set((state) => ({
          tracks: state.tracks.map((t) => {
            if (t.trackId !== trackId) return t
            if (t.items.some((i) => i.id === item.id)) return t
            const next = [...t.items, item]
            next.sort((a, b) => a.time - b.time)
            return { ...t, items: next }
          }),
          // 同步触发刷新信号，确保恢复的弹幕立即生效
          refreshSignal: state.refreshSignal + 1,
        }))
      },

      addDeletedLog: (entry) => {
        set((state) => {
          const exists = state.deletedLog.some(
            (d) => d.trackId === entry.trackId && d.item.id === entry.item.id
          )
          if (exists) return state
          const next = [...state.deletedLog, entry]
          if (next.length > DELETED_LOG_LIMIT) {
            next.splice(0, next.length - DELETED_LOG_LIMIT)
          }
          return { deletedLog: next }
        })
      },

      removeDeletedLog: (trackId, itemId) => {
        set((state) => ({
          deletedLog: state.deletedLog.filter(
            (d) => !(d.trackId === trackId && d.item.id === itemId)
          ),
        }))
      },

      clearDeletedLog: () => {
        set({ deletedLog: [] })
      },
    }),
    {
      name: 'danmaku-storage',
      version: 1,
      partialize: (state) => ({ style: state.style }),
      migrate: (persisted: unknown): Partial<DanmakuState> => {
        const data = (persisted ?? {}) as Partial<DanmakuState>
        const style = { ...(data.style ?? {}) } as Record<string, unknown>
        // v0 -> v1: 清除已删除的 avoidSubtitle 字段，
        // 并重置 scaleWithScreen 让其回退到新默认值 false
        delete style.avoidSubtitle
        delete style.scaleWithScreen
        return { ...data, style: style as unknown as DanmakuStyleState }
      },
    }
  )
)
