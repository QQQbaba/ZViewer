import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FC } from 'react'
import { Maximize2, Search } from 'lucide-react'
import { Text } from '@/components/ui/Typography'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useDanmakuStore } from '@/store/danmakuStore'
import { useRoomStore } from '@/store/roomStore'
import { cn } from '@/lib/utils'

const WINDOW_SIZE = 5 // 秒，用于当前时间高亮范围
const AUTO_SCROLL_RESUME_MS = 2000

// 紧凑列表单项估算高度（px），包含 flex gap 的等效值。
// 实际 item 高约 24px，加上 gap-0.5 后按 26px 估算，虚拟滚动对少量误差不敏感。
const COMPACT_ITEM_HEIGHT = 26
// 展开模式（Modal）下单项估算高度，内容换行时允许少量误差。
const EXPANDED_ITEM_HEIGHT = 34
// 上下缓冲行数，避免快速滚动时出现白边
const OVERSCAN = 8

interface RealtimeDanmakuItem {
  id: string
  content: string
  time: number
  actualTime: number
  trackLabel: string
  mode: number
  color: number
}

function getDanmakuTypeLabel(
  mode: number,
  color: number
): { label: string; variant: 'default' | 'primary' | 'warning' | 'success' } {
  if (mode === 5) return { label: '顶部', variant: 'primary' }
  if (mode === 4) return { label: '底部', variant: 'primary' }
  if (color !== 16777215) return { label: '彩色', variant: 'warning' }
  return { label: '滚动', variant: 'default' }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * 单条弹幕项 — 用 React.memo 包裹，只在 isHighlighted 变化时重渲染。
 */
const DanmakuListItem: FC<{
  item: RealtimeDanmakuItem
  isHighlighted: boolean
  expanded?: boolean
}> = memo(function DanmakuListItem({ item, isHighlighted, expanded = false }) {
  const type = getDanmakuTypeLabel(item.mode, item.color)
  return (
    <div
      className={cn(
        'flex min-w-0 gap-1.5 rounded-sm border px-1.5 py-0.5',
        expanded ? 'items-start' : 'items-center'
      )}
      style={{
        backgroundColor: isHighlighted
          ? 'var(--md-sys-color-primary-container)'
          : 'var(--glass-bg)',
        borderColor: 'var(--md-sys-color-outline-variant)',
      }}
    >
      <Text
        type="secondary"
        className={cn(
          'shrink-0 text-[10px] leading-5 tabular-nums',
          isHighlighted && 'text-[var(--md-sys-color-on-primary-container)]'
        )}
      >
        {formatTime(item.actualTime)}
      </Text>
      <span
        className={cn(
          'shrink-0 truncate rounded px-1 text-[10px] leading-5',
          expanded ? 'max-w-[140px]' : 'max-w-[80px]',
          isHighlighted
            ? 'text-[var(--md-sys-color-on-primary-container)]'
            : 'text-[var(--md-sys-color-on-surface-variant)]'
        )}
        style={{
          backgroundColor: 'var(--glass-bg)',
        }}
        title={item.trackLabel}
      >
        {item.trackLabel}
      </span>
      <Text
        className={cn(
          'min-w-0 flex-1 text-[11px] leading-5',
          expanded ? 'break-words' : 'truncate',
          isHighlighted && 'text-[var(--md-sys-color-on-primary-container)]'
        )}
        title={item.content}
      >
        {item.content}
      </Text>
      <span
        className={cn(
          'shrink-0 rounded px-1 text-[10px] leading-5',
          type.variant === 'primary' &&
            'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]',
          type.variant === 'warning' &&
            'bg-[var(--md-sys-color-tertiary-container)] text-[var(--md-sys-color-on-tertiary-container)]',
          type.variant === 'success' &&
            'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]',
          type.variant === 'default' &&
            'bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface-variant)]'
        )}
      >
        {type.label}
      </span>
    </div>
  )
})

interface VirtualRange {
  start: number
  end: number
  totalHeight: number
  topPadding: number
  bottomPadding: number
}

/**
 * 固定高度虚拟滚动核心逻辑。
 *
 * 只渲染视口内 + 上下缓冲区的节点，将 5000+ 条弹幕的 DOM 节点数量
 * 控制在固定几十条，避免大量 DOM 导致的渲染与滚动卡顿。
 */
function useVirtualList(
  itemCount: number,
  itemHeight: number,
  listRef: React.RefObject<HTMLDivElement | null>,
  overscan = OVERSCAN
) {
  const [listHeight, setListHeight] = useState(320)
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    const el = listRef.current
    if (!el) return

    const updateHeight = () => {
      const height = el.clientHeight
      if (height > 0) setListHeight(height)
    }
    updateHeight()

    const observer = new ResizeObserver(updateHeight)
    observer.observe(el)
    return () => observer.disconnect()
  }, [listRef])

  const range: VirtualRange = useMemo(() => {
    const totalHeight = itemCount * itemHeight
    const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan)
    const visibleCount = Math.ceil(listHeight / itemHeight)
    const end = Math.min(itemCount, start + visibleCount + overscan * 2)
    return {
      start,
      end,
      totalHeight,
      topPadding: start * itemHeight,
      bottomPadding: Math.max(0, (itemCount - end) * itemHeight),
    }
  }, [itemCount, itemHeight, listHeight, scrollTop, overscan])

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  return { ...range, scrollTop, onScroll, listHeight }
}

export function RealtimeDanmakuCard() {
  const tracks = useDanmakuStore((state) => state.tracks)
  // currentTime 降为整数秒，避免房主广播频率（0.5-1s）中浮点变化每秒触发重渲染。
  const rawCurrentTime = useRoomStore(
    (state) => state.watchTogether.currentTime
  )
  const currentTime = Math.floor(rawCurrentTime)

  const listRef = useRef<HTMLDivElement>(null)
  const modalListRef = useRef<HTMLDivElement>(null)
  const [isUserScrolling, setIsUserScrolling] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const programmaticScrollRef = useRef(false)

  // allDanmaku 只依赖 tracks（低频变化），不依赖 currentTime
  const allDanmaku = useMemo<RealtimeDanmakuItem[]>(() => {
    const list: RealtimeDanmakuItem[] = []
    tracks.forEach((track) => {
      if (track.hidden) return
      track.items.forEach((item) => {
        list.push({
          id: `${track.trackId}-${item.id}`,
          content: item.content,
          time: item.time,
          actualTime: item.time + track.offset,
          trackLabel: track.label,
          mode: item.mode ?? 1,
          color: item.color ?? 16777215,
        })
      })
    })
    return list.sort((a, b) => a.actualTime - b.actualTime)
  }, [tracks])

  const filteredDanmaku = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return allDanmaku
    return allDanmaku.filter((item) => {
      if (item.content.toLowerCase().includes(query)) return true
      if (item.trackLabel.toLowerCase().includes(query)) return true
      if (formatTime(item.actualTime).includes(query)) return true
      return false
    })
  }, [allDanmaku, searchQuery])

  const activeIndex = useMemo(() => {
    if (allDanmaku.length === 0) return -1
    let best = 0
    let bestDiff = Math.abs(allDanmaku[0].actualTime - currentTime)
    for (let i = 1; i < allDanmaku.length; i++) {
      const diff = Math.abs(allDanmaku[i].actualTime - currentTime)
      if (diff < bestDiff) {
        best = i
        bestDiff = diff
      }
    }
    return best
  }, [allDanmaku, currentTime])

  const {
    start: visibleStart,
    end: visibleEnd,
    totalHeight,
    topPadding,
    bottomPadding,
    onScroll: handleVirtualScroll,
    listHeight,
  } = useVirtualList(allDanmaku.length, COMPACT_ITEM_HEIGHT, listRef)

  const {
    start: modalVisibleStart,
    end: modalVisibleEnd,
    totalHeight: modalTotalHeight,
    topPadding: modalTopPadding,
    bottomPadding: modalBottomPadding,
    onScroll: handleModalVirtualScroll,
  } = useVirtualList(filteredDanmaku.length, EXPANDED_ITEM_HEIGHT, modalListRef)

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      handleVirtualScroll(e)
      if (programmaticScrollRef.current) return
      setIsUserScrolling(true)
      if (resumeTimerRef.current) {
        clearTimeout(resumeTimerRef.current)
      }
      resumeTimerRef.current = setTimeout(() => {
        setIsUserScrolling(false)
      }, AUTO_SCROLL_RESUME_MS)
    },
    [handleVirtualScroll]
  )

  const handleModalScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      handleModalVirtualScroll(e)
    },
    [handleModalVirtualScroll]
  )

  useEffect(() => {
    return () => {
      if (resumeTimerRef.current) {
        clearTimeout(resumeTimerRef.current)
      }
    }
  }, [])

  // 自动滚动：将当前高亮项保持在列表可视区域中央。
  // 使用虚拟滚动后不再依赖 itemRefs，直接按索引计算 scrollTop。
  useEffect(() => {
    if (activeIndex < 0 || isUserScrolling || !listRef.current) return
    const list = listRef.current
    const targetScrollTop =
      activeIndex * COMPACT_ITEM_HEIGHT -
      listHeight / 2 +
      COMPACT_ITEM_HEIGHT / 2
    const clamped = Math.max(
      0,
      Math.min(targetScrollTop, totalHeight - listHeight)
    )
    if (Math.abs(list.scrollTop - clamped) <= 2) return

    programmaticScrollRef.current = true
    list.scrollTop = clamped
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [activeIndex, isUserScrolling, listHeight, totalHeight])

  const visibleDanmaku = useMemo(
    () => allDanmaku.slice(visibleStart, visibleEnd),
    [allDanmaku, visibleStart, visibleEnd]
  )

  const modalVisibleDanmaku = useMemo(
    () => filteredDanmaku.slice(modalVisibleStart, modalVisibleEnd),
    [filteredDanmaku, modalVisibleStart, modalVisibleEnd]
  )

  const renderEmpty = (minHeight?: string) => (
    <div
      className={cn(
        'flex items-center justify-center',
        minHeight ? '' : 'h-full min-h-[120px]'
      )}
      style={minHeight ? { minHeight } : undefined}
    >
      <Text type="secondary" className="text-xs">
        暂无弹幕
      </Text>
    </div>
  )

  return (
    <div className="glass flex min-h-0 min-w-0 flex-col gap-2 rounded-[var(--md-sys-shape-corner)] p-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <Text className="text-xs font-medium">实时弹幕</Text>
        <div className="flex items-center gap-2">
          <Text
            type="secondary"
            className="shrink-0 truncate text-[10px]"
            title={`全部弹幕（高亮当前 ±${WINDOW_SIZE}s）`}
          >
            {allDanmaku.length > 0
              ? `${allDanmaku.length} 条`
              : `高亮 ±${WINDOW_SIZE}s`}
          </Text>
          {allDanmaku.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              icon={<Maximize2 className="h-3 w-3" />}
              onClick={() => setModalOpen(true)}
            >
              查看全部
            </Button>
          )}
        </div>
      </div>

      <div
        ref={listRef}
        onScroll={handleScroll}
        className="max-h-[320px] min-h-[120px] overflow-y-auto overflow-x-hidden rounded-[var(--md-sys-shape-corner)] border p-1.5"
        style={{
          backgroundColor: 'var(--glass-bg)',
          borderColor: 'var(--md-sys-color-outline-variant)',
        }}
      >
        {allDanmaku.length === 0 ? (
          renderEmpty()
        ) : (
          <div
            className="flex flex-col gap-0.5"
            style={{
              paddingTop: topPadding,
              paddingBottom: bottomPadding,
              height: totalHeight,
            }}
          >
            {visibleDanmaku.map((item) => (
              <DanmakuListItem
                key={item.id}
                item={item}
                isHighlighted={
                  Math.abs(item.actualTime - currentTime) <= WINDOW_SIZE
                }
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false)
          setSearchQuery('')
        }}
        title={`实时弹幕 (${allDanmaku.length} 条)`}
        className="max-w-2xl"
      >
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-50" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索弹幕内容、轨道或时间 (如 01:23)"
              className="pl-8"
            />
          </div>

          <div
            ref={modalListRef}
            onScroll={handleModalScroll}
            className="max-h-[60vh] overflow-y-auto overflow-x-hidden rounded-[var(--md-sys-shape-corner)] border p-2"
            style={{
              backgroundColor: 'var(--glass-bg)',
              borderColor: 'var(--md-sys-color-outline-variant)',
            }}
          >
            {filteredDanmaku.length === 0 ? (
              <div className="flex h-32 items-center justify-center">
                <Text type="secondary" className="text-xs">
                  {searchQuery ? '未找到匹配弹幕' : '暂无弹幕'}
                </Text>
              </div>
            ) : (
              <div
                className="flex flex-col gap-1"
                style={{
                  paddingTop: modalTopPadding,
                  paddingBottom: modalBottomPadding,
                  height: modalTotalHeight,
                }}
              >
                {modalVisibleDanmaku.map((item) => (
                  <DanmakuListItem
                    key={item.id}
                    item={item}
                    isHighlighted={
                      Math.abs(item.actualTime - currentTime) <= WINDOW_SIZE
                    }
                    expanded
                  />
                ))}
              </div>
            )}
          </div>

          {searchQuery && (
            <Text type="secondary" className="text-[10px]">
              找到 {filteredDanmaku.length} 条匹配弹幕
            </Text>
          )}
        </div>
      </Modal>
    </div>
  )
}
