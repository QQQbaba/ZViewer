import { Router, raw } from 'express';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import { getUpdateInfo, applyUpdate, applyUpdateFromFile } from '../services/updater';

const router = Router();

function rootOnly(
  req: AuthenticatedRequest,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  if (req.user?.role !== 'root') {
    res.status(403).json({ success: false, message: '无权限：仅 root 可操作' });
    return;
  }
  next();
}

router.use(authenticateToken, rootOnly);

/** 检查更新 */
router.get(
  '/check',
  async (
    _req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const info = await getUpdateInfo();
      res.json({ success: true, info });
    } catch (err) {
      console.error('update check error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '检查更新失败',
      });
    }
  },
);

/** 从 GitHub Releases 下载并应用更新 */
router.post(
  '/apply',
  async (
    _req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const result = await applyUpdate();
      res.json(result);
    } catch (err) {
      console.error('update apply error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '应用更新失败',
      });
    }
  },
);

/**
 * 上传压缩包并应用更新。
 *
 * 接收原始文件体（Content-Type: application/zip 或 application/gzip），
 * 不使用 multipart/form-data，避免引入 multer 依赖。
 * 前端直接将 File 对象作为 fetch body 发送。
 */
router.post(
  '/upload',
  // 使用 express.raw 接收二进制文件数据，支持 zip 和 gzip 格式
  // 限制 500MB 以容纳大型构建产物
  raw({
    type: [
      'application/zip',
      'application/gzip',
      'application/octet-stream',
      'application/x-zip-compressed',
    ],
    limit: '500mb',
  }),
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ success: false, message: '未收到有效的文件数据' });
        return;
      }

      // 从 Content-Type 或查询参数推断文件名
      const contentType = req.headers['content-type'] || '';
      let filename = 'uploaded-update.zip';
      if (contentType.includes('gzip') || contentType.includes('tar')) {
        filename = 'uploaded-update.tar.gz';
      }

      // 从查询参数获取文件名（优先）
      const queryName = req.query.filename as string | undefined;
      if (queryName) {
        filename = queryName;
      }

      const result = await applyUpdateFromFile(req.body, filename);
      res.json(result);
    } catch (err) {
      console.error('update upload error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '上传更新失败',
      });
    }
  },
);

export default router;
