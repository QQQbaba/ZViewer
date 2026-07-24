/**
 * HTTP Range 下载器（v2 重写）。
 *
 * 职责单一：发起 Range 请求，处理代理包装、IndexedDB 缓存读写、重试与 abort。
 * 不涉及 SourceBuffer、moof 扫描、缓冲管理等逻辑。
 *
 * 三个层级：
 * - downloadHead       下载文件头部（0..HEAD_SIZE），带缓存，供 init/sidx 解析
 * - downloadRange      下载闭区间字节块，带缓存，供 seek 快速路径
 * - downloadStream(WithRetry)  开放式流下载（bytes=start-），不带缓存，供主下载循环
 */
import { apiFetch } from '@/lib/api'
import { isBilibiliMediaUrl, buildProxyUrl } from '../../services/url-proxy'
import { HEAD_SIZE, MAX_FETCH_RETRIES } from './types'
import type { DownloadOptions } from './types'
import { parseTotalSize } from './parser'
import { cacheRange, getCachedRange } from './stream-cache'

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
 * 下载文件头部（0..HEAD_SIZE），返回 Response 供解析 Content-Range / Content-Length。
 *
 * 优先命中 IndexedDB 缓存，刷新页面后无需重复下载 init segment / sidx。
 */
export async function downloadHead(
  url: string,
  signal: AbortSignal
): Promise<Response> {
  const { response } = await downloadRange(url, 0, HEAD_SIZE - 1, signal)
  return response
}

/**
 * 下载指定字节范围（闭区间），返回 Response 与已读入内存的数据。
 * 用于 head 下载与 seek 快速路径（先下小块找 moof 立即 flush）。
 *
 * 优先命中 IndexedDB 缓存；未命中则网络下载并写入缓存。
 */
export async function downloadRange(
  url: string,
  startByte: number,
  endByte: number,
  signal: AbortSignal
): Promise<{ response: Response; data: Uint8Array }> {
  // 1. 先查缓存（含覆盖匹配）
  const cached = await getCachedRange(url, startByte, endByte)
  if (cached) {
    const rangeHeader =
      cached.totalSize !== null
        ? `bytes ${startByte}-${startByte + cached.data.byteLength - 1}/${cached.totalSize}`
        : `bytes ${startByte}-${startByte + cached.data.byteLength - 1}/*`
    const response = new Response(cached.data.buffer as ArrayBuffer, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Length': String(cached.data.byteLength),
        'Content-Range': rangeHeader,
      },
    })
    return { response, data: cached.data }
  }

  // 2. 网络下载
  const response = await fetchRange(url, startByte, endByte, signal)
  const data = new Uint8Array(await response.arrayBuffer())

  // 3. 写入缓存（忽略失败，不影响播放）
  void cacheRange(url, startByte, data, parseTotalSize(response))

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
