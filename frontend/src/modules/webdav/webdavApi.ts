import { apiFetch } from '@/lib/api'
import { buildProxyUrl } from '@/modules/direct-link/directLinkApi'
import type {
  WebDAVMount,
  WebDAVMountFormPayload,
  WebDAVConnectionParams,
  WebDAVDirectoryEntry,
  WebDAVResolvedSource,
} from './types'
import type { MediaFormat } from '@/lib/mediaFormat'

export interface WebDAVTestResult {
  success: boolean
  itemCount: number
}

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

export async function getWebDAVMounts(): Promise<WebDAVMount[]> {
  const res = await apiFetch('/api/webdav/mounts')
  const data = (await res.json()) as {
    success: boolean
    mounts?: WebDAVMount[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取 WebDAV 挂载列表失败')
  }
  return data.mounts || []
}

export async function createWebDAVMount(
  payload: WebDAVMountFormPayload
): Promise<WebDAVMount> {
  const res = await apiFetch('/api/webdav/mounts', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: WebDAVMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '创建 WebDAV 挂载失败')
  }
  return data.mount
}

export async function updateWebDAVMount(
  id: number,
  payload: WebDAVMountFormPayload
): Promise<WebDAVMount> {
  const res = await apiFetch(`/api/webdav/mounts/${id}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: WebDAVMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '更新 WebDAV 挂载失败')
  }
  return data.mount
}

export async function deleteWebDAVMount(id: number): Promise<void> {
  const res = await apiFetch(`/api/webdav/mounts/${id}`, {
    method: 'DELETE',
  })
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '删除 WebDAV 挂载失败')
  }
}

export async function testWebDAVMount(
  params: WebDAVConnectionParams
): Promise<WebDAVTestResult> {
  const res = await apiFetch('/api/webdav/mounts/test', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(params),
  })
  const data = (await res.json()) as {
    success: boolean
    itemCount?: number
    message?: string
    code?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '测试 WebDAV 连接失败')
  }
  return {
    success: true,
    itemCount: data.itemCount ?? 0,
  }
}

export async function browseWebDAVMount(
  id: number,
  path?: string
): Promise<WebDAVDirectoryEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await apiFetch(`/api/webdav/mounts/${id}/browse${query}`)
  const data = (await res.json()) as {
    success: boolean
    entries?: WebDAVDirectoryEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '浏览 WebDAV 挂载失败')
  }
  return data.entries || []
}

export async function resolveWebDAV(
  mountId: number,
  path: string
): Promise<WebDAVResolvedSource> {
  const query = new URLSearchParams({
    mountId: String(mountId),
    path,
  }).toString()
  const res = await apiFetch(`/api/webdav/resolve?${query}`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    videoUrl?: string
    format?: MediaFormat
    duration?: number
  }
  if (!res.ok || !data.success || !data.videoUrl) {
    throw new Error(data.message || '解析 WebDAV 文件失败')
  }
  return {
    title: data.title || '',
    videoUrl: data.videoUrl,
    format: data.format || 'mp4',
    duration: data.duration ?? 0,
  }
}

export function buildWebDAVProxyUrl(mountId: number, path: string): string {
  return buildProxyUrl('webdav', { mountId, path })
}

/**
 * 调用后端 /api/webdav/direct-url 接口获取直链 URL。
 *
 * 后端使用挂载的账号密码：
 * - 对 WebDAV：协议不支持生成真实直链，仅返回 serverUrl+path 拼接（浏览器可能无法直接播放）
 * - 调用方仅房主添加影片时使用
 *
 * 返回可直接作为 movie.url 保存的字符串。
 */
export async function fetchWebDAVDirectUrl(
  mountId: number,
  path: string
): Promise<string> {
  const query = new URLSearchParams({
    mountId: String(mountId),
    path,
  }).toString()
  const res = await apiFetch(`/api/webdav/direct-url?${query}`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    directUrl?: string
  }
  if (!res.ok || !data.success || !data.directUrl) {
    throw new Error(data.message || '获取 WebDAV 直链失败')
  }
  return data.directUrl
}
