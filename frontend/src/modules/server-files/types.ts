/** 服务器文件目录条目。 */
export interface ServerFileEntry {
  name: string
  /** 前缀式路径（如 'uploads:/movies/a.mp4' 或 'custom:3:/videos/b.mp4'）。 */
  path: string
  type: 'directory' | 'file'
  size?: number
  modifiedAt?: string
}

/** 浏览目录返回结果。 */
export interface ServerBrowseResult {
  entries: ServerFileEntry[]
  /** 当前目录的前缀式路径。 */
  currentPath: string
  /** 当前根是否只读。 */
  readonly?: boolean
}

/** 解析文件返回结果。 */
export interface ServerFileResolved {
  title: string
  videoUrl: string
  format: string
  size: number
}

/** 上传成功的文件信息。 */
export interface UploadedFile {
  name: string
  path: string
  size: number
}

/** 服务器文件根目录描述。 */
export interface ServerFileRoot {
  /** 唯一标识：'uploads' 或 'custom:<id>'。 */
  key: string
  /** 显示名称。 */
  name: string
  /** 服务器上的真实绝对路径。 */
  absPath: string
  /** 是否只读。 */
  readonly: boolean
  /** 目录是否真实存在。 */
  exists: boolean
}

/** 系统目录浏览返回的条目（仅目录）。 */
export interface SystemDirEntry {
  name: string
  absPath: string
}

/** 系统目录浏览返回结果。 */
export interface SystemDirBrowseResult {
  entries: SystemDirEntry[]
  /** 当前目录的绝对路径（系统根时为空字符串或 '/'）。 */
  currentPath: string
  /** 父目录的绝对路径（用于返回上一级，系统根时为空）。 */
  parentPath: string
  /** 是否为系统根（Windows 盘符列表 / Unix 根目录）。 */
  isRoot: boolean
}
