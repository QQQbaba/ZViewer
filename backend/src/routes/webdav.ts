import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount } from '../entities/UserMount';
import { Movie } from '../entities/Movie';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  statWebDAVFile,
  createWebDAVReadStreamWithRange,
  buildWebDAVDirectUrl,
  listWebDAVDirectoryCached,
  listWebDAVDirectory,
  WebDAVError,
  type WebDAVConnectionParams,
} from '../services/webdav';
import { detectMediaFormat, getContentType } from '../services/mediaFormat';
import { resolveUserMount, pipeRangeStream } from '../services/proxy';

const router = Router();

const userMountRepository = () => AppDataSource.getRepository(UserMount);

function stripPassword(mount: UserMount): Omit<UserMount, 'password'> {
  const { password: _password, ...rest } = mount;
  return rest;
}

// 将 UserMount 记录转换为 WebDAVConnectionParams
function mountToParams(mount: UserMount): WebDAVConnectionParams {
  return {
    serverUrl: mount.serverUrl!,
    path: mount.path || '/',
    username: mount.username || undefined,
    password: mount.password || undefined,
  };
}

// 从异常中提取错误码
function extractErrorCode(err: unknown): string {
  if (err instanceof WebDAVError) return err.code;
  return 'UNREACHABLE';
}

function extractErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

router.use(authenticateToken);

// 2.1 挂载 CRUD - GET /mounts
router.get('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const mounts = await userMountRepository().find({
      where: { userId, type: 'webdav' },
      order: { createdAt: 'DESC' },
    });

    res.json({
      success: true,
      mounts: mounts.map(stripPassword),
    });
  } catch (err) {
    console.error('[webdav] list mounts error:', err);
    res.status(500).json({ success: false, message: '获取 WebDAV 挂载列表失败' });
  }
});

// 2.2 测试连接 - POST /mounts/test（必须在 /:id 之前注册）
router.post('/mounts/test', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { serverUrl, path, username, password } = req.body ?? {};
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
      return;
    }

    const params: WebDAVConnectionParams = {
      serverUrl: serverUrl.trim(),
      path: typeof path === 'string' && path.trim() ? path.trim() : '/',
      username: typeof username === 'string' && username ? username : undefined,
      password: typeof password === 'string' && password ? password : undefined,
    };

    try {
      const entries = await listWebDAVDirectory(params, '/');
      res.json({
        success: true,
        itemCount: entries.length,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, 'WebDAV 不可访问'),
        code: extractErrorCode(err),
      });
    }
  } catch (err) {
    console.error('[webdav] test mount error:', err);
    res.status(500).json({ success: false, message: '测试 WebDAV 连接失败' });
  }
});

// 2.1 挂载 CRUD - POST /mounts
router.post('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { name, serverUrl, path, username, password, directLink } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, message: '挂载名称不能为空' });
      return;
    }
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
      return;
    }

    const params: WebDAVConnectionParams = {
      serverUrl: serverUrl.trim(),
      path: typeof path === 'string' && path.trim() ? path.trim() : '/',
      username: typeof username === 'string' && username ? username : undefined,
      password: typeof password === 'string' && password ? password : undefined,
    };

    // 测试连通性
    try {
      await listWebDAVDirectory(params, '/');
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, 'WebDAV 不可访问'),
        code: extractErrorCode(err),
      });
      return;
    }

    const repo = userMountRepository();
    const mount = repo.create({
      type: 'webdav',
      name: name.trim(),
      serverUrl: params.serverUrl,
      path: params.path,
      username: params.username || null,
      password: params.password || null,
      directLink: directLink === true,
      userId: req.user!.userId,
    } as UserMount);
    await repo.save(mount);

    res.status(201).json({
      success: true,
      mount: stripPassword(mount),
    });
  } catch (err) {
    console.error('[webdav] create mount error:', err);
    res.status(500).json({ success: false, message: '创建 WebDAV 挂载失败' });
  }
});

// 2.1 挂载 CRUD - PUT /mounts/:id
router.put('/mounts/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id,
      userId: req.user!.userId,
      type: 'webdav',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    const { name, serverUrl, path, username, password, directLink } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, message: '挂载名称不能为空' });
      return;
    }
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
      return;
    }

    const params: WebDAVConnectionParams = {
      serverUrl: serverUrl.trim(),
      path: typeof path === 'string' && path.trim() ? path.trim() : '/',
      username: typeof username === 'string' && username ? username : undefined,
      password: (typeof password === 'string' && password) || mount.password || undefined,
    };

    // 测试连通性
    try {
      await listWebDAVDirectory(params, '/');
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, 'WebDAV 不可访问'),
        code: extractErrorCode(err),
      });
      return;
    }

    mount.name = name.trim();
    mount.serverUrl = params.serverUrl;
    mount.path = params.path;
    mount.username = params.username || null;
    if (typeof password === 'string') {
      mount.password = password || null;
    }
    mount.directLink = directLink === true;
    await repo.save(mount);

    res.json({
      success: true,
      mount: stripPassword(mount),
    });
  } catch (err) {
    console.error('[webdav] update mount error:', err);
    res.status(500).json({ success: false, message: '更新 WebDAV 挂载失败' });
  }
});

// 2.1 挂载 CRUD - DELETE /mounts/:id
router.delete('/mounts/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id,
      userId: req.user!.userId,
      type: 'webdav',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    await repo.remove(mount);
    res.json({ success: true });
  } catch (err) {
    console.error('[webdav] delete mount error:', err);
    res.status(500).json({ success: false, message: '删除 WebDAV 挂载失败' });
  }
});

// 2.3 浏览 - GET /mounts/:id/browse?path=
router.get('/mounts/:id/browse', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id,
      userId: req.user!.userId,
      type: 'webdav',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    const browsePath = typeof req.query.path === 'string' ? req.query.path : undefined;
    const params = mountToParams(mount);

    try {
      const entries = await listWebDAVDirectoryCached(params, mount.id, browsePath);
      res.json({ success: true, entries });
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, '浏览 WebDAV 失败'),
        code: extractErrorCode(err),
      });
    }
  } catch (err) {
    console.error('[webdav] browse mount error:', err);
    res.status(500).json({ success: false, message: '浏览 WebDAV 挂载失败' });
  }
});

// 2.4 解析 - GET /resolve?mountId=&path=
router.get('/resolve', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountIdRaw = req.query.mountId;
    const pathRaw = req.query.path;
    if (mountIdRaw === undefined || (typeof pathRaw !== 'string' && pathRaw === undefined)) {
      res.status(400).json({ success: false, message: '缺少 mountId 或 path 参数', code: 'INVALID_PARAMS' });
      return;
    }

    const mountId = Number(mountIdRaw);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: 'mountId 不正确', code: 'INVALID_PARAMS' });
      return;
    }
    const targetPath = typeof pathRaw === 'string' ? pathRaw : '';
    if (!targetPath.trim()) {
      res.status(400).json({ success: false, message: 'path 不能为空', code: 'INVALID_PARAMS' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id: mountId,
      userId: req.user!.userId,
      type: 'webdav',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    const params: WebDAVConnectionParams = {
      serverUrl: mount.serverUrl,
      path: targetPath,
      username: mount.username || undefined,
      password: mount.password || undefined,
    };

    try {
      const info = await statWebDAVFile(params);
      // 使用相对路径，由前端根据当前页面 origin 自动解析，避免反向代理后协议错误（http vs https）
      const proxyUrl = `/api/webdav/proxy?mountId=${mountId}&path=${encodeURIComponent(targetPath)}`;
      const format = detectMediaFormat(info.name || targetPath);
      res.json({
        success: true,
        title: info.name,
        videoUrl: proxyUrl,
        format,
        duration: 0,
      });
    } catch (err) {
      res.status(400).json({
        success: false,
        message: extractErrorMessage(err, '解析 WebDAV 文件失败'),
        code: extractErrorCode(err),
      });
    }
  } catch (err) {
    console.error('[webdav] resolve error:', err);
    res.status(500).json({ success: false, message: '解析 WebDAV 文件失败' });
  }
});

// 2.5 代理 - GET /proxy?mountId=&path=
router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // 代理端点通过 query 暴露 mountId+path，但凭证仅从 DB 读取，不会出现在 URL 中
    const resolved = await resolveUserMount(req, res, 'webdav');
    if (!resolved) return;
    const { mount, targetPath } = resolved;

    const params: WebDAVConnectionParams = {
      serverUrl: mount.serverUrl!,
      path: targetPath,
      username: mount.username || undefined,
      password: mount.password || undefined,
    };

    const rangeHeader = req.headers.range;

    let stream: import('node:stream').Readable;
    let fileSize: number;
    let start: number;
    let end: number;
    try {
      const result = await createWebDAVReadStreamWithRange(params, rangeHeader);
      stream = result.stream;
      fileSize = result.fileSize;
      start = result.start;
      end = result.end;
    } catch (err) {
      const code = extractErrorCode(err);
      const status = code === 'AUTH_FAILED' ? 401 : code === 'NOT_FOUND' ? 404 : 400;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, '打开 WebDAV 流失败'),
        code,
      });
      return;
    }

    pipeRangeStream(res, {
      stream,
      contentType: getContentType(detectMediaFormat(targetPath)),
      fileSize,
      start,
      end,
      ranged: !!rangeHeader,
      logTag: 'webdav',
      errorMessage: 'WebDAV 代理流错误',
      errorCode: 'UNREACHABLE',
    });
  } catch (err) {
    console.error('[webdav] proxy error:', err);
    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        message: extractErrorMessage(err, '代理 WebDAV 媒体失败'),
      });
    } else {
      res.destroy();
    }
  }
});

// 2.6 获取直链 - GET /direct-url?mountId=&path=
// 房主添加影片时调用：后端使用挂载凭证返回直链 URL。
// 对 WebDAV：协议不支持生成真实直链，仅返回 serverUrl+path 拼接（浏览器可能无法直接播放，卡死就卡死）
router.get('/direct-url', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountIdRaw = req.query.mountId;
    const pathRaw = req.query.path;
    if (mountIdRaw === undefined || pathRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 mountId 或 path 参数' });
      return;
    }
    const mountId = Number(mountIdRaw);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: 'mountId 不正确' });
      return;
    }
    const targetPath = typeof pathRaw === 'string' ? pathRaw.trim() : '';
    if (!targetPath) {
      res.status(400).json({ success: false, message: 'path 不能为空' });
      return;
    }

    const repo = userMountRepository();
    const mount = await repo.findOneBy({
      id: mountId,
      userId: req.user!.userId,
      type: 'webdav',
    });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    if (!mount.serverUrl) {
      res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
      return;
    }

    // WebDAV 协议不支持获取真实直链，直接拼接 serverUrl+path
    const directUrl = buildWebDAVDirectUrl(mount.serverUrl, targetPath);
    res.json({ success: true, directUrl });
  } catch (err) {
    console.error('[webdav] direct-url error:', err);
    res.status(500).json({ success: false, message: '获取 WebDAV 直链失败' });
  }
});

// 2.7 基于影片 ID 的流代理 - GET /stream?movieId=
// 与 /proxy 的区别：/stream 不依赖 userId 查挂载，而是直接从 Movie 表读取凭证，
// 这样房间内任何成员（含观众）都能通过 movieId 访问影片流。
router.get('/stream', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const movieIdRaw = req.query.movieId;
    if (movieIdRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 movieId 参数' });
      return;
    }
    const movieId = Number(movieIdRaw);
    if (Number.isNaN(movieId)) {
      res.status(400).json({ success: false, message: 'movieId 不正确' });
      return;
    }

    const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
    if (!movie) {
      res.status(404).json({ success: false, message: '影片不存在' });
      return;
    }
    if (!movie.serverUrl || !movie.path) {
      res.status(400).json({ success: false, message: '该影片未挂载服务器信息' });
      return;
    }

    const params: WebDAVConnectionParams = {
      serverUrl: movie.serverUrl,
      path: movie.path,
      username: movie.username || undefined,
      password: movie.password || undefined,
    };

    const rangeHeader = req.headers.range;

    let stream: import('node:stream').Readable;
    let fileSize: number;
    let start: number;
    let end: number;
    try {
      const result = await createWebDAVReadStreamWithRange(params, rangeHeader);
      stream = result.stream;
      fileSize = result.fileSize;
      start = result.start;
      end = result.end;
    } catch (err) {
      const code = extractErrorCode(err);
      const status = code === 'AUTH_FAILED' ? 401 : code === 'NOT_FOUND' ? 404 : 400;
      res.status(status).json({
        success: false,
        message: extractErrorMessage(err, '打开 WebDAV 流失败'),
        code,
      });
      return;
    }

    pipeRangeStream(res, {
      stream,
      contentType: getContentType(detectMediaFormat(movie.path)),
      fileSize,
      start,
      end,
      ranged: !!rangeHeader,
      logTag: 'webdav-stream',
      errorMessage: 'WebDAV 影片流错误',
      errorCode: 'UNREACHABLE',
    });
  } catch (err) {
    console.error('[webdav] stream error:', err);
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: '代理 WebDAV 影片失败' });
    } else {
      res.destroy();
    }
  }
});

export default router;
