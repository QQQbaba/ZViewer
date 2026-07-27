/**
 * 服务器文件管理路由。
 *
 * 仅超级管理员（root）可用。提供：
 * - GET  /roots         列出所有可用根（uploads + 自定义）
 * - POST /roots         添加自定义根目录
 * - DELETE /roots/:id   删除自定义根目录
 * - GET  /browse        浏览目录
 * - GET  /browse-system 浏览服务器全盘目录（仅目录，用于添加根目录时选取）
 * - POST /upload        上传文件（multipart/form-data）
 * - POST /folder        新建文件夹
 * - POST /rename        重命名文件/文件夹
 * - DELETE /file        删除文件或文件夹
 * - GET  /resolve       解析文件 → 返回代理播放 URL + 格式
 * - GET  /proxy         流式代理播放（支持 Range）
 *
 * 路径参数采用前缀式：'uploads:/path' 或 'custom:<id>:/path'。
 * 旧式 '/path' 默认归属 uploads 根（向后兼容）。
 */
import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { AppDataSource } from '../data-source';
import { ServerFolder } from '../entities/ServerFolder';
import { authenticateToken, requireRoot, AuthenticatedRequest } from '../middleware/auth';
import { detectMediaFormat, getContentType } from '../services/mediaFormat';
import { parseRangeHeader, pipeRangeStream } from '../services/proxy';
import {
  UPLOADS_ROOT,
  UPLOADS_ROOT_KEY,
  resolveSafePath,
  toPrefixedPath,
  getUploadsRoot,
  basename,
  type RootRegistry,
} from '../services/server-files/pathResolver';

const router = Router();

// 全局校验：仅 root 可访问
router.use(authenticateToken, requireRoot);

// 上传文件大小上限：10GB
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024;

/** ServerFolder 仓库。 */
const folderRepo = () => AppDataSource.getRepository(ServerFolder);

/**
 * 加载所有根目录到注册表。
 * uploads 根始终存在；自定义根按数据库记录注册。
 */
async function loadRootRegistry(): Promise<RootRegistry> {
  const map: RootRegistry = new Map();
  map.set(UPLOADS_ROOT_KEY, getUploadsRoot());
  const folders = await folderRepo().find({ order: { id: 'ASC' } });
  for (const f of folders) {
    const key = `custom:${f.id}`;
    map.set(key, {
      key,
      name: f.name,
      absPath: path.resolve(f.absPath),
      readonly: !!f.readonly,
    });
  }
  return map;
}

/** multer 存储：写到目标目录（运行时按 root 解析）。 */
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const targetDir = typeof req.body.targetDir === 'string' ? req.body.targetDir : '/';
    loadRootRegistry()
      .then((roots) => {
        try {
          const { abs, root } = resolveSafePath(targetDir, roots);
          if (root.readonly) {
            cb(new Error('该根目录为只读'), '');
            return;
          }
          if (!fs.existsSync(abs)) {
            fs.mkdirSync(abs, { recursive: true });
          }
          // 把目标目录绝对路径暂存到 req 上，filename 阶段读取以处理重名。
          // multer 保证 filename 在 destination 之后调用。
          (req as Request & { __targetDirAbs?: string }).__targetDirAbs = abs;
          cb(null, abs);
        } catch (err) {
          cb(err as Error, '');
        }
      })
      .catch((err) => cb(err as Error, ''));
  },
  filename: (req, file, cb) => {
    const dirAbs = (req as Request & { __targetDirAbs?: string }).__targetDirAbs;
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (!dirAbs) {
      cb(null, original);
      return;
    }
    // 重名时追加序号，避免覆盖已有文件
    cb(null, uniqueFilename(dirAbs, original));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE },
});

/** 重名文件追加序号（a.mp4 → a (1).mp4）。 */
function uniqueFilename(dirAbs: string, filename: string): string {
  const target = path.join(dirAbs, filename);
  if (!fs.existsSync(target)) return filename;
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(dirAbs, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

// ============ 1. 根目录管理 ============

/** GET /roots — 列出所有根。 */
router.get('/roots', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const roots = await loadRootRegistry();
    const list = Array.from(roots.values()).map((r) => ({
      key: r.key,
      name: r.name,
      absPath: r.absPath,
      readonly: r.readonly,
      exists: fs.existsSync(r.absPath),
    }));
    res.json({ success: true, roots: list });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '加载根目录失败',
    });
  }
});

/** POST /roots — 添加自定义根目录。 */
router.post('/roots', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const absPath = typeof req.body.absPath === 'string' ? req.body.absPath.trim() : '';
    const readonly = req.body.readonly === true;
    if (!name) {
      res.status(400).json({ success: false, message: '名称不能为空' });
      return;
    }
    if (!absPath) {
      res.status(400).json({ success: false, message: '目录路径不能为空' });
      return;
    }
    // 规范化并禁止相对路径（避免误把工作目录拼进去）
    const resolved = path.resolve(absPath);
    // 禁止将 uploads 根自身重复添加
    if (resolved === UPLOADS_ROOT) {
      res.status(400).json({ success: false, message: '该目录已是默认空间' });
      return;
    }
    // 必须存在且为目录
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        res.status(400).json({ success: false, message: '路径不是目录' });
        return;
      }
    } catch {
      res.status(400).json({ success: false, message: '目录不存在或无访问权限' });
      return;
    }
    // 防止重复添加同一路径
    const existing = await folderRepo().findOne({ where: { absPath: resolved } });
    if (existing) {
      res.status(400).json({ success: false, message: '该目录已添加' });
      return;
    }
    const entity = folderRepo().create({ name, absPath: resolved, readonly });
    const saved = await folderRepo().save(entity);
    res.json({
      success: true,
      root: {
        key: `custom:${saved.id}`,
        name: saved.name,
        absPath: saved.absPath,
        readonly: saved.readonly,
        exists: true,
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '添加根目录失败',
    });
  }
});

/** DELETE /roots/:id — 删除自定义根目录（仅删除挂载，不删真实文件）。 */
router.delete('/roots/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ success: false, message: '无效的 ID' });
      return;
    }
    const entity = await folderRepo().findOne({ where: { id } });
    if (!entity) {
      res.status(404).json({ success: false, message: '根目录不存在' });
      return;
    }
    await folderRepo().remove(entity);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '删除根目录失败',
    });
  }
});

// ============ 2. 浏览目录 ============

router.get('/browse', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const roots = await loadRootRegistry();
    const { abs, root } = resolveSafePath(req.query.path as string | undefined, roots);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      res.json({
        success: true,
        entries: [],
        currentPath: toPrefixedPath(root, abs),
        readonly: root.readonly,
      });
      return;
    }
    const items = fs.readdirSync(abs, { withFileTypes: true });
    const entries = items
      .filter((item) => !item.name.startsWith('.'))
      .map((item) => {
        const childAbs = path.join(abs, item.name);
        const stat = fs.statSync(childAbs);
        return {
          name: item.name,
          path: toPrefixedPath(root, childAbs),
          type: item.isDirectory() ? 'directory' : 'file',
          size: item.isFile() ? stat.size : undefined,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
    res.json({
      success: true,
      entries,
      currentPath: toPrefixedPath(root, abs),
      readonly: root.readonly,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '浏览目录失败',
    });
  }
});

// ============ 2.5 系统级目录浏览（用于添加根目录时选取路径） ============

/**
 * GET /browse-system — 浏览服务器文件系统任意目录（仅返回子目录）。
 *
 * 不受已注册根目录限制，可浏览服务器全盘，用于"添加自定义根目录"时选取路径。
 * 仅返回目录（隐藏文件除外），不返回文件。
 *
 * 查询参数：
 * - absPath: 要浏览的绝对路径。不提供时返回系统根（Windows 盘符列表 / Unix 根目录）。
 */
router.get('/browse-system', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const rawPath = typeof req.query.absPath === 'string' ? req.query.absPath.trim() : '';
    const isWindows = process.platform === 'win32';

    // 无路径参数：返回系统根
    if (!rawPath) {
      if (isWindows) {
        // Windows: 枚举可用盘符
        const drives: Array<{ name: string; absPath: string }> = [];
        for (let code = 65; code <= 90; code++) {
          const letter = String.fromCharCode(code);
          const drivePath = `${letter}:\\`;
          try {
            if (fs.statSync(drivePath).isDirectory()) {
              drives.push({ name: `${letter}:`, absPath: drivePath });
            }
          } catch {
            // 盘符不存在或无权限，跳过
          }
        }
        res.json({ success: true, entries: drives, currentPath: '', isRoot: true });
        return;
      }
      // Unix: 返回 / 下的目录
      const items = fs.readdirSync('/', { withFileTypes: true });
      const entries = items
        .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
        .map((item) => ({ name: item.name, absPath: path.join('/', item.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      res.json({ success: true, entries, currentPath: '/', isRoot: true });
      return;
    }

    // 有路径参数：列出该路径下的子目录
    const resolved = path.resolve(rawPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      res.status(400).json({ success: false, message: '路径不存在或无访问权限' });
      return;
    }
    if (!stat.isDirectory()) {
      res.status(400).json({ success: false, message: '路径不是目录' });
      return;
    }

    const items = fs.readdirSync(resolved, { withFileTypes: true });
    const entries = items
      .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
      .map((item) => ({ name: item.name, absPath: path.join(resolved, item.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

    // 计算父目录路径（用于返回上一级），系统根时父目录为空
    let parentPath = '';
    if (isWindows) {
      // Windows: 如 D:\folder 的父级是 D:\，D:\ 的父级为空（系统根）
      const parsed = path.parse(resolved);
      if (parsed.dir && parsed.dir !== resolved) {
        parentPath = parsed.dir;
      }
    } else {
      if (resolved !== '/') {
        parentPath = path.dirname(resolved);
      }
    }

    res.json({
      success: true,
      entries,
      currentPath: resolved,
      parentPath,
      isRoot: false,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '浏览系统目录失败',
    });
  }
});

// ============ 3. 上传文件 ============

router.post('/upload', upload.array('files', 50), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) {
    res.status(400).json({ success: false, message: '未接收到文件' });
    return;
  }
  // multer storage 已在 destination 阶段校验只读、创建目录，
  // 并在 filename 阶段应用 uniqueFilename 避免覆盖。
  // 这里重新解析 targetDir 以构造前缀式返回路径。
  const targetDir = typeof req.body.targetDir === 'string' ? req.body.targetDir : '/';
  try {
    const roots = await loadRootRegistry();
    const { abs: dirAbs, root } = resolveSafePath(targetDir, roots);
    const uploaded = files.map((f) => {
      const name = path.basename(f.path);
      const childAbs = path.join(dirAbs, name);
      return {
        name,
        path: toPrefixedPath(root, childAbs),
        size: f.size,
      };
    });
    res.json({ success: true, files: uploaded });
  } catch (err) {
    // 解析失败时清理已写入文件
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch { /* ignore */ }
    }
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '上传失败',
    });
  }
});

// ============ 4. 新建文件夹 ============

router.post('/folder', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parent = typeof req.body.parent === 'string' ? req.body.parent : '/';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ success: false, message: '文件夹名称不能为空' });
      return;
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      res.status(400).json({ success: false, message: '文件夹名称包含非法字符' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: parentAbs, root } = resolveSafePath(parent, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    const targetAbs = path.join(parentAbs, name);
    if (targetAbs !== root.absPath && !targetAbs.startsWith(root.absPath + path.sep)) {
      res.status(400).json({ success: false, message: '路径越权' });
      return;
    }
    if (fs.existsSync(targetAbs)) {
      res.status(400).json({ success: false, message: '同名项目已存在' });
      return;
    }
    fs.mkdirSync(targetAbs, { recursive: true });
    res.json({ success: true, path: toPrefixedPath(root, targetAbs) });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '新建文件夹失败',
    });
  }
});

// ============ 5. 重命名 ============

router.post('/rename', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const oldPath = typeof req.body.path === 'string' ? req.body.path : '';
    const newName = typeof req.body.newName === 'string' ? req.body.newName.trim() : '';
    if (!oldPath || !newName) {
      res.status(400).json({ success: false, message: '缺少 path 或 newName 参数' });
      return;
    }
    if (/[\\/:*?"<>|]/.test(newName)) {
      res.status(400).json({ success: false, message: '名称包含非法字符' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: oldAbs, root } = resolveSafePath(oldPath, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    if (!fs.existsSync(oldAbs)) {
      res.status(404).json({ success: false, message: '原文件不存在' });
      return;
    }
    const parentDir = path.dirname(oldAbs);
    const newAbs = path.join(parentDir, newName);
    if (newAbs !== root.absPath && !newAbs.startsWith(root.absPath + path.sep)) {
      res.status(400).json({ success: false, message: '路径越权' });
      return;
    }
    if (fs.existsSync(newAbs) && oldAbs !== newAbs) {
      res.status(400).json({ success: false, message: '同名项目已存在' });
      return;
    }
    fs.renameSync(oldAbs, newAbs);
    res.json({ success: true, path: toPrefixedPath(root, newAbs) });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '重命名失败',
    });
  }
});

// ============ 6. 删除文件/文件夹 ============

router.delete('/file', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target || target === '/' || target.endsWith(':/') || target.endsWith(':')) {
      res.status(400).json({ success: false, message: '不能删除根目录' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs, root } = resolveSafePath(target, roots);
    if (root.readonly) {
      res.status(400).json({ success: false, message: '该根目录为只读' });
      return;
    }
    if (targetAbs === root.absPath) {
      res.status(400).json({ success: false, message: '不能删除根目录' });
      return;
    }
    if (!fs.existsSync(targetAbs)) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    fs.rmSync(targetAbs, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '删除失败',
    });
  }
});

// ============ 7. 解析文件 → 返回代理播放 URL ============

router.get('/resolve', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    const name = basename(targetAbs);
    const format = detectMediaFormat(name);
    // 使用相对路径，由前端根据当前页面 origin 自动解析，避免反向代理后协议错误（http vs https）
    const proxyUrl = `/api/server-files/proxy?path=${encodeURIComponent(target)}`;
    res.json({
      success: true,
      title: name,
      videoUrl: proxyUrl,
      format,
      size: fs.statSync(targetAbs).size,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : '解析文件失败',
    });
  }
});

// ============ 8. 流式代理播放（支持 Range） ============

router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const target = typeof req.query.path === 'string' ? req.query.path : '';
    if (!target.trim()) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    const roots = await loadRootRegistry();
    const { abs: targetAbs } = resolveSafePath(target, roots);
    if (!fs.existsSync(targetAbs) || fs.statSync(targetAbs).isDirectory()) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }

    const fileSize = fs.statSync(targetAbs).size;
    const rangeHeader = req.headers.range;
    const format = detectMediaFormat(target);

    if (rangeHeader) {
      const parsed = parseRangeHeader(rangeHeader, fileSize);
      if (parsed === 'invalid') {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
        res.end();
        return;
      }
      const start = parsed?.start ?? 0;
      const end = parsed?.end ?? fileSize - 1;
      const stream = fs.createReadStream(targetAbs, { start, end });
      pipeRangeStream(res, {
        stream,
        contentType: getContentType(format),
        fileSize,
        start,
        end,
        ranged: true,
        logTag: 'server-files',
        errorMessage: '文件读取失败',
      });
    } else {
      const stream = fs.createReadStream(targetAbs);
      pipeRangeStream(res, {
        stream,
        contentType: getContentType(format),
        fileSize,
        ranged: false,
        logTag: 'server-files',
        errorMessage: '文件读取失败',
      });
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : '代理播放失败',
      });
    }
  }
});

export default router;
