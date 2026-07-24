import { apiFetch, API_URL } from '@/lib/api'
import type {
  ServerBrowseResult,
  ServerFileEntry,
  ServerFileResolved,
  ServerFileRoot,
  SystemDirBrowseResult,
  UploadedFile,
} from './types'

/** 浏览服务器文件目录。path 为前缀式路径（如 'uploads:/' 或 'custom:3:/videos'）。 */
export async function browseServerFiles(
  path?: string
): Promise<ServerBrowseResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await apiFetch(`${API_URL}/api/server-files/browse${query}`)
  const data = (await res.json()) as {
    success: boolean
    entries?: ServerFileEntry[]
    currentPath?: string
    readonly?: boolean
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '浏览服务器文件失败')
  }
  return {
    entries: data.entries || [],
    currentPath: data.currentPath || '/',
    readonly: data.readonly,
  }
}

/** 上传文件到服务器。targetDir 为前缀式目录路径，支持 uploads 与 custom 根。 */
export async function uploadServerFiles(
  files: File[],
  targetDir: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<UploadedFile[]> {
  const formData = new FormData()
  formData.append('targetDir', targetDir)
  for (const file of files) {
    formData.append('files', file, file.name)
  }

  return new Promise<UploadedFile[]>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_URL}/api/server-files/upload`)
    xhr.withCredentials = true

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total)
      }
    }

    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText) as {
          success: boolean
          files?: UploadedFile[]
          message?: string
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.success) {
          resolve(data.files || [])
        } else {
          reject(new Error(data.message || '上传失败'))
        }
      } catch {
        reject(new Error('上传响应解析失败'))
      }
    }

    xhr.onerror = () => reject(new Error('网络错误，上传失败'))
    xhr.send(formData)
  })
}

/** 新建文件夹。parent 为前缀式路径。 */
export async function createFolder(
  parent: string,
  name: string
): Promise<string> {
  const res = await apiFetch(`${API_URL}/api/server-files/folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent, name }),
  })
  const data = (await res.json()) as {
    success: boolean
    path?: string
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '新建文件夹失败')
  }
  return data.path || ''
}

/** 重命名文件/文件夹。path 为前缀式路径。 */
export async function renameServerFile(
  path: string,
  newName: string
): Promise<string> {
  const res = await apiFetch(`${API_URL}/api/server-files/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, newName }),
  })
  const data = (await res.json()) as {
    success: boolean
    path?: string
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '重命名失败')
  }
  return data.path || ''
}

/** 删除文件或文件夹。path 为前缀式路径。 */
export async function deleteServerFile(path: string): Promise<void> {
  const res = await apiFetch(
    `${API_URL}/api/server-files/file?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' }
  )
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '删除失败')
  }
}

/** 解析文件 → 返回代理播放 URL + 格式。path 为前缀式路径。 */
export async function resolveServerFile(
  path: string
): Promise<ServerFileResolved> {
  const res = await apiFetch(
    `${API_URL}/api/server-files/resolve?path=${encodeURIComponent(path)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    videoUrl?: string
    format?: string
    size?: number
  }
  if (!res.ok || !data.success || !data.videoUrl) {
    throw new Error(data.message || '解析服务器文件失败')
  }
  return {
    title: data.title || '',
    videoUrl: data.videoUrl,
    format: data.format || 'mp4',
    size: data.size ?? 0,
  }
}

/** 构建服务器文件代理播放 URL（供 MoviePushPanel 直接拼装，免去 resolve 请求）。 */
export function buildServerFileProxyUrl(path: string): string {
  return `${API_URL}/api/server-files/proxy?path=${encodeURIComponent(path)}`
}

// ============ 根目录管理 ============

/**
 * 浏览服务器文件系统任意目录（仅返回子目录）。
 * 用于"添加自定义根目录"时选取路径，不受已注册根目录限制。
 * 不提供 absPath 时返回系统根（Windows 盘符 / Unix 根目录）。
 */
export async function browseSystemDirs(
  absPath?: string
): Promise<SystemDirBrowseResult> {
  const query = absPath ? `?absPath=${encodeURIComponent(absPath)}` : ''
  const res = await apiFetch(`${API_URL}/api/server-files/browse-system${query}`)
  const data = (await res.json()) as {
    success: boolean
    entries?: { name: string; absPath: string }[]
    currentPath?: string
    parentPath?: string
    isRoot?: boolean
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '浏览系统目录失败')
  }
  return {
    entries: data.entries || [],
    currentPath: data.currentPath || '',
    parentPath: data.parentPath || '',
    isRoot: data.isRoot === true,
  }
}

/** 列出所有可用根（uploads + 自定义）。 */
export async function listServerRoots(): Promise<ServerFileRoot[]> {
  const res = await apiFetch(`${API_URL}/api/server-files/roots`)
  const data = (await res.json()) as {
    success: boolean
    roots?: ServerFileRoot[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '加载根目录失败')
  }
  return data.roots || []
}

/** 添加自定义根目录。 */
export async function addServerRoot(
  name: string,
  absPath: string,
  readonly?: boolean
): Promise<ServerFileRoot> {
  const res = await apiFetch(`${API_URL}/api/server-files/roots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, absPath, readonly: !!readonly }),
  })
  const data = (await res.json()) as {
    success: boolean
    root?: ServerFileRoot
    message?: string
  }
  if (!res.ok || !data.success || !data.root) {
    throw new Error(data.message || '添加根目录失败')
  }
  return data.root
}

/** 删除自定义根目录（仅删除挂载，不删真实文件）。 */
export async function deleteServerRoot(key: string): Promise<void> {
  // key 形如 'custom:3'，提取数字 id
  const match = key.match(/^custom:(\d+)$/)
  if (!match) {
    throw new Error('默认空间不可删除')
  }
  const id = match[1]
  const res = await apiFetch(`${API_URL}/api/server-files/roots/${id}`, {
    method: 'DELETE',
  })
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '删除根目录失败')
  }
}

/**
 * 从前缀式路径提取根 key。
 * 'uploads:/x' → 'uploads'，'custom:3:/x' → 'custom:3'，'/x' → 'uploads'。
 */
export function extractRootKey(path: string | undefined): string {
  if (!path) return 'uploads'
  const m = path.match(/^(uploads|custom:\d+):/)
  return m ? m[1] : 'uploads'
}

/**
 * 替换路径中的根 key（用于切换根时构造新路径）。
 */
export function withRootKey(rootKey: string, _relPath?: string): string {
  // 切换根时总是回到该根的根目录
  return `${rootKey}:/`
}
