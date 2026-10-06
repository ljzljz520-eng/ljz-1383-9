import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './db/index.js';
import { seed } from './db/seed.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { asyncHandler } from './util/helpers.js';
import * as mediaService from './services/mediaService.js';
import * as bookingService from './services/bookingService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '2mb' }));

// 媒体上传（原始二进制，需要放在 json 解析之后、按路径单独解析）
app.use('/api/admin/videos/:id/source', (req, res, next) => {
  if (req.method !== 'POST') return next();
  express.raw({ type: () => true, limit: '50mb' })(req, res, next);
});
app.use('/api/admin/videos/:id/assets', (req, res, next) => {
  if (req.method !== 'POST') return next();
  express.raw({ type: () => true, limit: '20mb' })(req, res, next);
});

// 管理鉴权（内联：上传路由在 router 之前也要校验）
app.use('/api/admin', (req, res, next) => {
  if (req.get('x-admin-token') !== config.adminToken) {
    return res.status(401).json({ error: '管理令牌无效', code: 'UNAUTHORIZED' });
  }
  next();
});

app.get('/api/assets/:id', asyncHandler(async (req, res) => {
  const asset = mediaService.getPublicAsset(Number(req.params.id));
  res.setHeader('Content-Type', asset.mime);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(mediaService.assetPath(asset));
}));

app.use('/api', publicRouter);
app.use('/api/admin', adminRouter);

// 统一错误
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || '服务器错误', code: err.code || undefined });
});

// 静态前台（/ 成果与试听，/admin.html 管理，/share.html 分享页）
app.use(express.static(path.resolve(__dirname, '../public'), {
  index: 'index.html',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

seed();

// 定时清扫：过期邀请、过期授权
const sweepTimer = setInterval(() => {
  try {
    bookingService.sweepExpiredInvites();
    mediaService.sweepExpiredConsents();
  } catch (e) {
    console.error('sweep error', e);
  }
}, config.sweepIntervalMs);
sweepTimer.unref?.();

const server = app.listen(config.port, () => {
  console.log(`Groove Lab 已启动: http://localhost:${config.port}`);
});

export { app, server, db };
