/**
 * B站解析设置（按影片独立配置）。
 *
 * 每个哔哩哔哩影片独享一份解析偏好（preferMp4 / bufferMode / p2pEnabled / cliEnabled），
 * 配置存储在 localStorage 中，以 movieId 为 key，仅对该影片生效。
 * 编码格式由后端自动适配，无需用户手动选择。
 *
 * 折叠展开式，默认收起。修改后立即写入 localStorage 持久化，
 * 若该影片正在播放（即 currentMovieId === movieId）则触发重新解析以即时生效。
 *
 * 房主可操作全部选项；观众端仅可查看房主选择的播放模式 / 缓冲模式，
 * 并独立开启自己的 CLI 高画质代理以降低服务器带宽和提升画质。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Settings2,
  ChevronDown,
  MonitorSmartphone,
  ExternalLink,
} from 'lucide-react'
import { useRoomStore } from '@/store/roomStore'
import { Button } from '@/components/ui/Button'
import {
  useBilibiliParsePreferences,
  setBilibiliParseOptions,
  getBilibiliParseOptions,
} from '@/modules/bilibili/parseOptions'
import {
  useP2PStatsStore,
  formatKBytes,
} from '@/modules/player/services/p2p-stats-store'
import { useCliAgent } from '@/hooks/useCliAgent'
import { API_URL } from '@/lib/api'
import { cn } from '@/lib/utils'

export interface BilibiliParseSettingsProps {
  /** 影片 ID，配置按此 key 独立存储 */
  movieId: number
  /** 当前房间 ID，用于检测本地 CLI 代理 */
  roomId: string
  /** 当前用户是否为房主（决定选项是否可操作） */
  isHost: boolean
}

export function BilibiliParseSettings({
  movieId,
  roomId,
  isHost,
}: BilibiliParseSettingsProps) {
  const [expanded, setExpanded] = useState(false)
  const [pendingCliReload, setPendingCliReload] = useState(false)
  const { preferMp4, bufferMode, p2pEnabled, cliEnabled } =
    useBilibiliParsePreferences(movieId)
  const cliAgent = useCliAgent(roomId)
  const triggerReloadBilibili = useRoomStore(
    (state) => state.triggerReloadBilibili
  )
  const triggerViewerSourceReload = useRoomStore(
    (state) => state.triggerViewerSourceReload
  )
  const currentMovieId = useRoomStore((state) => state.currentMovieId)
  // 只订阅需要的字段，避免 watchTogether.currentTime 等高频更新导致整片重渲染
  const watchTogetherFormat = useRoomStore(
    (state) => state.watchTogether.format
  )
  const watchTogetherBufferMode = useRoomStore(
    (state) => state.watchTogether.bufferMode
  )
  const movie = useRoomStore((state) =>
    state.movies.find((m) => m.id === movieId)
  )

  // 生效的播放模式：CLI 代理启用后强制走 DASH（高画质由本地 CLI 提供），仅房主可决定；
  // 若 CLI 未连接则实际解析降级为 MP4。观众侧显示房主当前广播的格式。
  const cliUnavailable = cliEnabled && !cliAgent.available
  const hostEffectivePreferMp4 = cliUnavailable ? true : preferMp4
  const viewerDisplayPreferMp4 =
    movie?.format === 'mp4' ||
    (movieId === currentMovieId && watchTogetherFormat === 'mp4')
  const displayPreferMp4 = isHost
    ? hostEffectivePreferMp4
    : viewerDisplayPreferMp4

  // 缓冲模式：观众端显示房主当前广播的缓冲状态；房主侧显示本地偏好
  const viewerDisplayBufferMode =
    movieId === currentMovieId ? watchTogetherBufferMode : false
  const displayBufferMode = isHost ? bufferMode : viewerDisplayBufferMode

  // P2P 与 CLI 使用观众/房主各自独立的本地偏好
  const displayP2pEnabled = p2pEnabled
  const displayCliEnabled = cliEnabled

  // P2P 统计信息：仅在 P2P 引擎激活时显示
  const p2pEngineActive = useP2PStatsStore((s) => s.engineActive)
  const totalHTTPDownloaded = useP2PStatsStore((s) => s.totalHTTPDownloaded)
  const totalP2PDownloaded = useP2PStatsStore((s) => s.totalP2PDownloaded)
  const totalP2PUploaded = useP2PStatsStore((s) => s.totalP2PUploaded)
  const p2pDownloadSpeed = useP2PStatsStore((s) => s.p2pDownloadSpeed)

  // 仅当该影片正在播放时才触发重载，避免影响其他影片
  const isCurrentMovie = movieId === currentMovieId

  const handlePreferMp4Change = useCallback(
    (next: boolean) => {
      if (!isHost) return
      // 切换到 MP4 模式时强制关闭缓冲模式与 P2P（仅对 DASH 流生效）
      setBilibiliParseOptions(movieId, {
        preferMp4: next,
        bufferMode: next ? false : undefined,
        p2pEnabled: next ? false : undefined,
      })
      if (isCurrentMovie) {
        triggerReloadBilibili()
      }
    },
    [movieId, isHost, isCurrentMovie, triggerReloadBilibili]
  )

  const handleBufferModeChange = useCallback(
    (next: boolean) => {
      if (!isHost) return
      // 开启缓冲模式时关闭 P2P（视频已完整缓存到本地，P2P 无意义）
      setBilibiliParseOptions(movieId, {
        bufferMode: next,
        p2pEnabled: next ? false : undefined,
      })
      if (isCurrentMovie) {
        triggerReloadBilibili()
      }
    },
    [movieId, isHost, isCurrentMovie, triggerReloadBilibili]
  )

  const handleP2PChange = useCallback(
    (next: boolean) => {
      if (!isHost) return
      // P2P 与 CLI 代理互斥：P2P 要求所有客户端使用相同的 videoUrl 作为 channelId，
      // 而 CLI 代理是各客户端独立的 localhost 地址，无法匹配 peer。
      setBilibiliParseOptions(movieId, {
        p2pEnabled: next,
        cliEnabled: next ? false : undefined,
      })
      if (isCurrentMovie) {
        triggerReloadBilibili()
      }
    },
    [movieId, isHost, isCurrentMovie, triggerReloadBilibili]
  )

  const handleCliChange = useCallback(
    (next: boolean) => {
      // CLI 代理与 P2P 互斥；启用 CLI 后强制使用 DASH 模式（本地 CLI 提供高画质），
      // 关闭 CLI 时恢复启用前保存的 DASH/MP4 模式。
      // 观众端开启/关闭 CLI 后需要重新 attach 当前源。
      const current = getBilibiliParseOptions(movieId)
      if (next) {
        setBilibiliParseOptions(movieId, {
          cliEnabled: true,
          p2pEnabled: false,
          preferMp4: false,
          cliPrevPreferMp4: current.preferMp4,
        })
      } else {
        setBilibiliParseOptions(movieId, {
          cliEnabled: false,
          p2pEnabled: undefined,
          preferMp4: current.cliPrevPreferMp4 ?? true,
          cliPrevPreferMp4: undefined,
        })
      }
      if (!isCurrentMovie) return
      if (next && !cliAgent.available) {
        // CLI 启用但未就绪：标记待重载，等代理上线后由 effect 触发
        setPendingCliReload(true)
        return
      }
      if (isHost) {
        triggerReloadBilibili()
      } else {
        triggerViewerSourceReload()
      }
    },
    [
      movieId,
      isHost,
      isCurrentMovie,
      cliAgent.available,
      triggerReloadBilibili,
      triggerViewerSourceReload,
    ]
  )

  // CLI 启用后等待代理上线，一旦可用立即触发重载以切换到本地代理。
  // 10 秒内未上线则自动放弃，避免状态悬挂。
  useEffect(() => {
    if (!pendingCliReload) return
    if (cliAgent.available) {
      setPendingCliReload(false)
      if (isHost) {
        triggerReloadBilibili()
      } else {
        triggerViewerSourceReload()
      }
      return
    }
    const timer = setTimeout(() => {
      setPendingCliReload(false)
    }, 10000)
    return () => clearTimeout(timer)
  }, [
    pendingCliReload,
    cliAgent.available,
    isHost,
    triggerReloadBilibili,
    triggerViewerSourceReload,
  ])

  const handleOpenCliSetup = useCallback(() => {
    const url = new URL('http://127.0.0.1:9333/')
    url.searchParams.set('server', API_URL)
    url.searchParams.set('room', roomId)
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }, [roomId])

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between rounded-[var(--md-sys-shape-corner)] px-1.5 py-1 text-[10px] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
        style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-1">
          <Settings2 className="h-3 w-3" />
          B站解析设置
        </span>
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform',
            expanded && 'rotate-180'
          )}
        />
      </button>
      {expanded && (
        <div className="glass flex flex-col gap-1.5 rounded-[var(--md-sys-shape-corner)] p-1.5">
          <div>
            <div
              className="mb-0.5 text-[10px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              播放模式
            </div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                disabled={!isHost || cliEnabled}
                onClick={() => handlePreferMp4Change(false)}
                className={cn(
                  'rounded-md py-0.5 text-[10px] font-medium transition-all',
                  (!isHost || cliEnabled) && 'cursor-not-allowed opacity-40',
                  !displayPreferMp4
                    ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                    : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                DASH 高清
              </button>
              <button
                type="button"
                disabled={!isHost || cliEnabled}
                onClick={() => handlePreferMp4Change(true)}
                className={cn(
                  'rounded-md py-0.5 text-[10px] font-medium transition-all',
                  (!isHost || cliEnabled) && 'cursor-not-allowed opacity-40',
                  displayPreferMp4
                    ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                    : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                MP4 流畅
              </button>
            </div>
            <div
              className="mt-0.5 text-[9px] leading-tight"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              {!isHost
                ? displayPreferMp4
                  ? '房主当前使用 MP4 直链，seek 流畅，清晰度通常 480P/720P'
                  : '房主当前使用 DASH 高清，支持 1080P/4K，seek 需缓冲'
                : cliEnabled
                  ? cliAgent.available
                    ? 'CLI 代理已启用，当前使用本地 DASH 高画质解析'
                    : '已启用 CLI 但未连接本地代理，解析时将自动降级为 MP4；连接后恢复 DASH 高画质'
                  : displayPreferMp4
                    ? 'MP4 直链，seek 流畅，清晰度通常 480P/720P'
                    : 'DASH 分离流，支持 1080P/4K，seek 需缓冲'}
            </div>
          </div>

          {/* 缓冲模式开关：仅 DASH 模式可用，房主开启后所有用户先缓存到本地再播放 */}
          <div
            className={cn(
              'rounded-md p-1.5 transition-opacity',
              hostEffectivePreferMp4 && 'pointer-events-none opacity-40'
            )}
          >
            <div
              className="mb-0.5 text-[10px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              缓冲模式
            </div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                disabled={!isHost || hostEffectivePreferMp4}
                onClick={() => handleBufferModeChange(false)}
                className={cn(
                  'rounded-md py-0.5 text-[10px] font-medium transition-all',
                  (!isHost || hostEffectivePreferMp4) &&
                    'cursor-not-allowed opacity-40',
                  !displayBufferMode
                    ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                    : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                关闭
              </button>
              <button
                type="button"
                disabled={!isHost || hostEffectivePreferMp4}
                onClick={() => handleBufferModeChange(true)}
                className={cn(
                  'rounded-md py-0.5 text-[10px] font-medium transition-all',
                  (!isHost || hostEffectivePreferMp4) &&
                    'cursor-not-allowed opacity-40',
                  displayBufferMode
                    ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                    : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                开启
              </button>
            </div>
            <div
              className="mt-0.5 text-[9px] leading-tight"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              {!isHost
                ? '缓冲模式由房主统一管理'
                : hostEffectivePreferMp4
                  ? 'MP4 模式不支持缓冲，请切换到 DASH'
                  : displayBufferMode
                    ? '进入房间先缓存完整视频到本地，避免 URL 过期与卡顿'
                    : '直接流式播放，无需等待缓存'}
            </div>
          </div>

          {/* P2P 传输开关：仅 DASH 流模式可用，与缓冲模式 / CLI 代理互斥。
              启用后通过 SwarmCloud 在房间内观众间共享 m4s 分片，减少服务器代理流量。
              各客户端独立启用，无需房主协调。 */}
          <div
            className={cn(
              'rounded-md p-1.5 transition-opacity',
              (!isHost ||
                hostEffectivePreferMp4 ||
                displayBufferMode ||
                displayCliEnabled) &&
                'pointer-events-none opacity-40'
            )}
          >
            <div
              className="mb-0.5 text-[10px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              P2P 传输
            </div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                disabled={
                  !isHost ||
                  hostEffectivePreferMp4 ||
                  displayBufferMode ||
                  displayCliEnabled
                }
                onClick={() => handleP2PChange(false)}
                className={cn(
                  'rounded-md py-0.5 text-[10px] font-medium transition-all',
                  !displayP2pEnabled
                    ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                    : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                关闭
              </button>
              <button
                type="button"
                disabled={
                  !isHost ||
                  hostEffectivePreferMp4 ||
                  displayBufferMode ||
                  displayCliEnabled
                }
                onClick={() => handleP2PChange(true)}
                className={cn(
                  'rounded-md py-0.5 text-[10px] font-medium transition-all',
                  displayP2pEnabled
                    ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                    : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                开启
              </button>
            </div>
            <div
              className="mt-0.5 text-[9px] leading-tight"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              {!isHost
                ? 'P2P 传输由房主统一管理'
                : hostEffectivePreferMp4
                  ? 'MP4 模式不支持 P2P，请切换到 DASH'
                  : displayCliEnabled
                    ? 'CLI 代理与 P2P 互斥，请关闭 CLI 后再启用 P2P'
                    : displayBufferMode
                      ? '缓冲模式下视频已本地缓存，无需 P2P'
                      : displayP2pEnabled
                        ? '房间内观众间共享分片，减少服务器流量（需 WebRTC）'
                        : '所有流量走服务器代理'}
            </div>

            {/* P2P 实时统计信息：仅在 P2P 引擎激活时显示。
                字段单位 KB / KB/s，由 DashPlayer 通过 stats 回调写入 store。 */}
            {displayP2pEnabled && p2pEngineActive && (
              <div
                className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 rounded-md p-1.5 text-[9px]"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-high)',
                }}
              >
                <div className="flex items-center justify-between">
                  <span
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                  >
                    ↓HTTP
                  </span>
                  <span className="font-mono font-medium">
                    {formatKBytes(totalHTTPDownloaded)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                  >
                    ↓P2P
                  </span>
                  <span className="font-mono font-medium">
                    {formatKBytes(totalP2PDownloaded)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                  >
                    ↑P2P
                  </span>
                  <span className="font-mono font-medium">
                    {formatKBytes(totalP2PUploaded)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                  >
                    速度
                  </span>
                  <span className="font-mono font-medium">
                    {formatKBytes(p2pDownloadSpeed)}/s
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* CLI 本地高画质代理：手动开关，与 P2P 互斥，需要用户本地启动 zcontrol-cli */}
          <div
            className={cn(
              'rounded-[var(--md-sys-shape-corner)] p-2 transition-opacity',
              displayP2pEnabled && 'pointer-events-none opacity-40'
            )}
            style={{
              backgroundColor: 'var(--md-sys-color-surface-container-high)',
            }}
          >
            {/* 头部：渐变图标容器 + 标题 + 大写副标题 + 状态指示 */}
            <div className="flex items-center gap-2">
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                style={{
                  background:
                    'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-tertiary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-secondary) 18%, transparent))',
                }}
              >
                <MonitorSmartphone
                  className="h-3.5 w-3.5"
                  style={{ color: 'var(--md-sys-color-tertiary)' }}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span
                  className="text-xs font-medium leading-tight"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                >
                  CLI 高画质代理
                </span>
                <span
                  className="text-[9px] uppercase tracking-wide"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                >
                  LOCAL PROXY
                </span>
              </div>
              <div className="flex items-center gap-1">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor: cliAgent.available
                      ? 'var(--md-sys-color-tertiary)'
                      : displayCliEnabled
                        ? 'var(--md-sys-color-error)'
                        : 'var(--md-sys-color-outline)',
                    boxShadow: cliAgent.available
                      ? '0 0 6px var(--md-sys-color-tertiary)'
                      : 'none',
                  }}
                />
                <span
                  className="text-[9px]"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                >
                  {cliAgent.available
                    ? '已连接'
                    : displayCliEnabled
                      ? '未连接'
                      : '未启用'}
                </span>
              </div>
            </div>

            {/* 开关：使用项目统一 Button 组件 */}
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <Button
                variant={!displayCliEnabled ? 'primary' : 'secondary'}
                size="sm"
                disabled={displayP2pEnabled}
                onClick={() => handleCliChange(false)}
                block
              >
                关闭
              </Button>
              <Button
                variant={displayCliEnabled ? 'primary' : 'secondary'}
                size="sm"
                disabled={displayP2pEnabled}
                onClick={() => handleCliChange(true)}
                block
              >
                启用
              </Button>
            </div>

            {/* 状态说明 */}
            <div
              className={cn(
                'mt-1.5 text-[9px] leading-tight',
                cliUnavailable && 'text-[var(--md-sys-color-error)]'
              )}
              style={
                cliUnavailable
                  ? undefined
                  : { color: 'var(--md-sys-color-on-surface-variant)' }
              }
            >
              {displayP2pEnabled
                ? 'P2P 与 CLI 代理互斥，请关闭 P2P 后再启用 CLI'
                : displayCliEnabled
                  ? cliAgent.available
                    ? `已连接本地代理 ${cliAgent.agentInfo?.version ?? ''}`
                    : `已启用但未检测到本地 CLI，${isHost ? '已自动降级为 MP4 模式' : '当前源将走服务器代理直到连接成功'}`
                  : '使用本地 zcontrol-cli 获取大会员等高画质'}
            </div>

            {/* 配置入口 */}
            <Button
              variant="secondary"
              size="sm"
              block
              icon={<ExternalLink className="h-3.5 w-3.5" />}
              onClick={handleOpenCliSetup}
              className="mt-2"
            >
              打开 CLI 配置页
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
