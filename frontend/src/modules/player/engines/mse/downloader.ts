/**
 * HTTP Range 下载器（v2 重写）。
 *
 * 职责单一：发起 Range 请求，处理代理包装、重试与 abort。
 * 不涉及 SourceBuffer、moof 扫描、缓冲管理等逻辑。
 *
 * 三个层级：
 * - downloadHead       下载文件头部（0..HEAD_SIZE），供 init/sidx 解析
 * - downloadRange      下载闭区间字节块，供 seek 快速路径
 * - downloadStream(WithRetry)  开放式流下载（bytes=start-），供主下载循环
 *
 * 缓存说明：仅依赖 SourceBuffer 实时缓冲（MSE 原生），不再做 IndexedDB 持久化。
 * 刷新页面后会重新下载 init/sidx，但播放过程中的实时缓冲仍由 MSE 管理。
 */
import { apiFetch } from '@/lib/api'
import { isBilibiliMediaUrl, buildProxyUrl } from '../../services/url-proxy'
import { HEAD_SIZE, MAX_FETCH_RETRIES } from './types'
import type { DownloadOptions } from './types'

/**
 * 检测错误是否为 SourceBuffer 不可恢复状态错误。
 *
 * 两种情况都会抛出此错误：
 * 1. video.error 已设置 → appendBuffer 永久失败
 * 2. MediaSource 已被 detach/close → SourceBuffer 不再可用
 */
export function isInvalidStateError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'InvalidStateError')
    return true
  if (
    err instanceof Error &&
    err.message.includes('HTMLMediaElement.error attribute is not null')
  )
    return true
  return false
}

/** 判断错误是否为 abort（用户取消 / 实例被取代），不应重试。 */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** 请求被中止或实例被取代时静默退出。 */
export interface DownloadAbortCheck {
  signal: AbortSignal
  superseded?: () => boolean
}

/** 下载结果。 */
export interface DownloadResult {
  response: Response
  /** 实际请求的字节起始位置 */
  startByte: number
}

/** B站 CDN URL 统一走后端代理（防盗链 + CORS），其余直连。 */
function resolveTargetUrl(url: string): string {
  return isBilibiliMediaUrl(url) ? buildProxyUrl(url) : url
}

/**
 * 核心 Range 请求（无缓存、无重试）。
 *
 * @param endByte 闭区间终点；省略时开放式下载（bytes=start-）
 */
async function fetchRange(
  url: string,
  startByte: number,
  endByte: number | undefined,
  signal: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = {
    Range: `bytes=${startByte}-${endByte ?? ''}`,
  }
  const response = await apiFetch(resolveTargetUrl(url), { headers, signal })
  if (!response.ok && response.status !== 206) {
    throw new Error(`获取媒体失败: ${response.status} ${response.statusText}`)
  }
  return response
}

/**
 * 下载文件头部（0..HEAD_SIZE），返回 Response 与已读入内存的数据。
 *
 * 注意：返回的 Response.body 已被消费（网络路径），调用方必须使用 data 字段
 * 而非再次调用 response.arrayBuffer()，否则抛 "Body has already been consumed"。
 * response 仅用于读取 headers（Content-Range / Content-Length）。
 */
export async function downloadHead(
  url: string,
  signal: AbortSignal
): Promise<{ response: Response; data: Uint8Array }> {
  return downloadRange(url, 0, HEAD_SIZE - 1, signal)
}

/**
 * 下载指定字节范围（闭区间），返回 Response 与已读入内存的数据。
 * 用于 head 下载与 seek 快速路径（先下小块找 moof 立即 flush）。
 */
export async function downloadRange(
  url: string,
  startByte: number,
  endByte: number,
  signal: AbortSignal
): Promise<{ response: Response; data: Uint8Array }> {
  const response = await fetchRange(url, startByte, endByte, signal)
  const data = new Uint8Array(await response.arrayBuffer())
  return { response, data }
}

/**
 * 从指定字节位置开始开放式下载媒体流（bytes=start-）。
 *
 * 支持断点续传重试，遇到 video.error / InvalidStateError / abort 时立即失败不重试。
 */
export async function downloadStream(
  url: string,
  options: DownloadOptions
): Promise<DownloadResult> {
  const { startByte = 0, signal } = options
  const response = await fetchRange(url, startByte, undefined, signal)
  if (!response.body) {
    throw new Error('响应体为空')
  }
  return { response, startByte }
}

/**
 * 带重试的媒体流下载。
 *
 * 返回 Response，调用方自行读取 body。
 * 重试策略：指数退避（500ms × 2^n，最多 MAX_FETCH_RETRIES 次）。
 * 当 signal.aborted / superseded / AbortError / InvalidStateError 时立即退出不重试。
 */
export async function downloadStreamWithRetry(
  url: string,
  options: DownloadOptions & { check?: DownloadAbortCheck }
): Promise<DownloadResult> {
  const { startByte = 0, signal, check } = options
  let attempt = 0

  while (true) {
    if (signal.aborted || check?.superseded?.()) {
      throw new Error('下载被取消')
    }

    try {
      return await downloadStream(url, { startByte, signal })
    } catch (err) {
      if (signal.aborted || isAbortError(err)) throw err
      if (check?.superseded?.()) throw err
      // 不可恢复错误不重试
      if (isInvalidStateError(err)) throw err

      attempt += 1
      if (attempt > MAX_FETCH_RETRIES) {
        throw new Error(
          `媒体流下载失败（已重试 ${MAX_FETCH_RETRIES} 次）: ${(err as Error).message}`,
          { cause: err }
        )
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)))
    }
  }
}
