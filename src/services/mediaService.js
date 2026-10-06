import fs from 'node:fs';
import path from 'node:path';
import { db, tx } from '../db/index.js';
import { HttpError, now, randomToken } from '../util/helpers.js';

const MEDIA_DIR = path.resolve(process.cwd(), 'data/media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

function log(event, entity, id, detail) {
  db.prepare(
    `INSERT INTO audit_logs (event, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?)`
  ).run(event, entity, id ?? null, typeof detail === 'string' ? detail : JSON.stringify(detail), now());
}

/* ----------------------------- 资产存储 ----------------------------- */

const EXT_BY_MIME = {
  'video/mp4': 'mp4',
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function saveAsset({ kind, mime, buffer, filenameExt = null }) {
  const info = db
    .prepare('INSERT INTO media_assets (kind, mime, filename, bytes, status, created_at) VALUES (?,?,?,?,?,?)')
    .run(kind, mime, '', buffer.length, 'ready', now());
  const id = info.lastInsertRowid;
  const ext = filenameExt || EXT_BY_MIME[mime] || 'bin';
  const filename = `a_${id}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
  db.prepare('UPDATE media_assets SET filename=? WHERE id=?').run(filename, id);
  return db.prepare('SELECT * FROM media_assets WHERE id=?').get(id);
}

// 种子数据直接写入资产
export function saveAssetFromBuffer(kind, mime, buffer) {
  return saveAsset({ kind, mime, buffer });
}

export function getAsset(id) {
  return db.prepare('SELECT * FROM media_assets WHERE id=?').get(id);
}

export function assetPath(asset) {
  return path.join(MEDIA_DIR, asset.filename);
}

function deleteAssetFile(asset) {
  if (!asset?.filename) return;
  try {
    fs.unlinkSync(path.join(MEDIA_DIR, asset.filename));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

function allVideoAssetIds(videoId) {
  const ids = new Set();
  const v = db.prepare('SELECT source_asset_id FROM videos WHERE id=?').get(videoId);
  if (v?.source_asset_id) ids.add(v.source_asset_id);
  for (const r of db.prepare('SELECT asset_id FROM video_assets WHERE video_id=?').all(videoId)) {
    ids.add(r.asset_id);
  }
  for (const r of db.prepare('SELECT output_asset_id FROM transcode_jobs WHERE video_id=? AND output_asset_id IS NOT NULL').all(videoId)) {
    ids.add(r.output_asset_id);
  }
  return [...ids];
}

/* ----------------------------- 视频 CRUD ----------------------------- */

export function createVideo({ title, studentId = null }) {
  if (!title) throw new HttpError(400, '标题必填');
  const id = db
    .prepare('INSERT INTO videos (title, student_id, consent_status, consent_epoch, published, created_at) VALUES (?,?,?,?,?,?)')
    .run(title, studentId, 'none', 0, 0, now()).lastInsertRowid;
  log('video.create', 'video', id, { title });
  return getVideo(id);
}

export function getVideo(id) {
  return db.prepare('SELECT * FROM videos WHERE id=?').get(id);
}

export function attachSource(videoId, assetId) {
  tx(() => {
    const v = getVideo(videoId);
    if (!v) throw new HttpError(404, '视频不存在');
    db.prepare('UPDATE videos SET source_asset_id=? WHERE id=?').run(assetId, videoId);
  });
}

export function attachAsset(videoId, assetId, role) {
  if (!['cover', 'clip'].includes(role)) throw new HttpError(400, '角色必须是 cover 或 clip');
  tx(() => {
    const v = getVideo(videoId);
    if (!v) throw new HttpError(404, '视频不存在');
    if (role === 'cover') {
      db.prepare(`DELETE FROM video_assets WHERE video_id=? AND role='cover'`).run(videoId);
    }
    db.prepare('INSERT OR IGNORE INTO video_assets (video_id, asset_id, role) VALUES (?,?,?)').run(videoId, assetId, role);
  });
}

/* ------------------------- 独立授权 / 到期 / 撤销 ------------------------- */

export function grantConsent(videoId, { expiresAt = null } = {}) {
  return tx(() => {
    const v = getVideo(videoId);
    if (!v) throw new HttpError(404, '视频不存在');
    if (v.consent_status === 'revoked') {
      throw new HttpError(409, '已撤销的视频不可恢复授权；如重新取得授权，请新建视频条目', 'REVOKED_TERMINAL');
    }
    if (!v.source_asset_id) throw new HttpError(409, '请先上传视频源文件再授权', 'NO_SOURCE');
    const ts = now();
    db.prepare(
      `UPDATE videos SET consent_status='active', consent_granted_at=?, consent_expires_at=?,
         consent_epoch=consent_epoch+1, revoked_at=NULL, revoke_reason='', published=1 WHERE id=?`
    ).run(ts, expiresAt, videoId);
    log('consent.grant', 'video', videoId, { expiresAt, epoch: v.consent_epoch + 1 });
    return getVideo(videoId);
  });
}

// 惰性到期：访问时检查；返回最新状态并在到期时切断访问与既有分享入口
function evaluateConsent(v) {
  if (v.consent_status === 'active' && v.consent_expires_at != null && v.consent_expires_at <= now()) {
    return tx(() => {
      const cur = getVideo(v.id);
      if (cur.consent_status !== 'active') return cur;
      db.prepare(`UPDATE videos SET consent_status='expired' WHERE id=?`).run(v.id);
      db.prepare(
        `UPDATE shares SET status='revoked', revoked_at=?, revoke_reason='授权到期，分享入口自动关闭'
         WHERE video_id=? AND status='active'`
      ).run(now(), v.id);
      log('consent.expire', 'video', v.id, { expiredAt: cur.consent_expires_at });
      return getVideo(v.id);
    });
  }
  return v;
}

/**
 * 撤销授权（终态）。不是只从列表隐藏：
 * 1) 立即切断公开访问（状态 revoked）——即使物理文件还没删，播放/封面/片段接口也返回 410；
 * 2) 全部有效分享入口作废；
 * 3) 在途/排队的转码任务立即作废；
 * 4) 封面、片段（及源/输出）物理文件删除并记录撤下进度时间戳。
 * 注意：监护人/第三方已下载到本地的外部副本，服务器无法远程抹除，只能提示联系删除。
 */
export function revokeConsent(videoId, reason = '') {
  const ts = now();
  // 阶段 1-3：状态与入口在同一事务内一次性切断
  tx(() => {
    const v = getVideo(videoId);
    if (!v) throw new HttpError(404, '视频不存在');
    if (v.consent_status === 'revoked') throw new HttpError(409, '该视频已撤销', 'ALREADY_REVOKED');
    db.prepare(
      `UPDATE videos SET consent_status='revoked', revoked_at=?, revoke_reason=?, published=0,
         removal_shares_at=? WHERE id=?`
    ).run(ts, reason, ts, videoId);
    db.prepare(
      `UPDATE shares SET status='revoked', revoked_at=?, revoke_reason=?
       WHERE video_id=? AND status='active'`
    ).run(ts, `视频授权撤销：${reason || '未填写原因'}`, videoId);
    db.prepare(
      `UPDATE transcode_jobs SET status='rejected', reject_reason='授权撤销，任务作废', finished_at=?
       WHERE video_id=? AND status IN ('queued','processing')`
    ).run(ts, videoId);
    log('consent.revoke', 'video', videoId, { reason });
  });

  // 阶段 4：封面与片段下线（先记录状态，保证任何时刻对外都拿不到）
  const assets = tx(() => {
    db.prepare(`UPDATE videos SET removal_cover_at=? WHERE id=? AND removal_cover_at IS NULL`).run(now(), videoId);
    db.prepare(`UPDATE videos SET removal_clips_at=? WHERE id=? AND removal_clips_at IS NULL`).run(now(), videoId);
    const ids = allVideoAssetIds(videoId);
    if (ids.length) {
      const q = `UPDATE media_assets SET status='removed' WHERE id IN (${ids.map(() => '?').join(',')})`;
      db.prepare(q).run(...ids);
    }
    return ids.map((id) => getAsset(id));
  });

  // 阶段 5：物理文件清理（数据库状态已不可访问，文件删除失败不影响下线结论）
  let deletedFiles = 0;
  const failed = [];
  for (const a of assets) {
    try {
      deleteAssetFile(a);
      deletedFiles += 1;
    } catch (e) {
      failed.push({ assetId: a.id, error: e.message });
    }
  }
  tx(() => {
    db.prepare('UPDATE videos SET removal_files_at=? WHERE id=?').run(now(), videoId);
    log('media.files-purged', 'video', videoId, { deletedFiles, total: assets.length, failed });
  });
  return { revoked: true, deletedFiles, totalFiles: assets.length, failed };
}

export function setPublished(videoId, published) {
  return tx(() => {
    const v = getVideo(videoId);
    if (!v) throw new HttpError(404, '视频不存在');
    if (published && v.consent_status !== 'active') {
      throw new HttpError(409, '仅在授权有效时可以公开发布', 'CONSENT_NOT_ACTIVE');
    }
    db.prepare('UPDATE videos SET published=? WHERE id=?').run(published ? 1 : 0, videoId);
    return getVideo(videoId);
  });
}

/* ----------------------------- 分享入口 ----------------------------- */

export function createShare(videoId) {
  return tx(() => {
    const v = evaluateConsent(getVideo(videoId));
    if (!v) throw new HttpError(404, '视频不存在');
    if (v.consent_status !== 'active') throw new HttpError(409, '授权无效，不能创建分享入口', 'CONSENT_NOT_ACTIVE');
    const token = randomToken(18);
    const id = db
      .prepare('INSERT INTO shares (video_id, token, status, created_at) VALUES (?,?,?,?)')
      .run(videoId, token, 'active', now()).lastInsertRowid;
    log('share.create', 'share', id, { videoId });
    return db.prepare('SELECT * FROM shares WHERE id=?').get(id);
  });
}

export function revokeShare(shareId) {
  return tx(() => {
    const s = db.prepare('SELECT * FROM shares WHERE id=?').get(shareId);
    if (!s) throw new HttpError(404, '分享不存在');
    db.prepare(`UPDATE shares SET status='revoked', revoked_at=?, revoke_reason='人工关闭分享' WHERE id=?`).run(now(), shareId);
    log('share.revoke', 'share', shareId, {});
    return { revoked: true };
  });
}

function rolesForVideo(videoId) {
  const out = { covers: [], clips: [] };
  for (const r of db.prepare('SELECT asset_id, role FROM video_assets WHERE video_id=?').all(videoId)) {
    (r.role === 'cover' ? out.covers : out.clips).push(r.asset_id);
  }
  return out;
}

function videoDTO(v, { includeProgress = false } = {}) {
  const roles = rolesForVideo(v.id);
  const dto = {
    id: v.id,
    title: v.title,
    studentId: v.student_id,
    consentStatus: v.consent_status,
    consentExpiresAt: v.consent_expires_at,
    consentEpoch: v.consent_epoch,
    published: !!v.published,
    coverAssetId: roles.covers[0] ?? null,
    clipAssetIds: roles.clips,
    hasSource: !!v.source_asset_id,
    createdAt: v.created_at,
  };
  if (includeProgress) {
    dto.removal = {
      shares: v.removal_shares_at,
      cover: v.removal_cover_at,
      clips: v.removal_clips_at,
      files: v.removal_files_at,
      revokedAt: v.revoked_at,
      reason: v.revoke_reason,
      // 明确告知：已被监护人/访客下载的外部副本无法远程抹除
      externalCopiesNotice: '已下载或转发到外部的副本无法由本站远程删除，需联系持有人手动删除。',
    };
  }
  return dto;
}

/* ----------------------------- 公开访问（含门禁） ----------------------------- */

export function listPublicVideos() {
  const rows = db.prepare(`SELECT * FROM videos WHERE published=1 ORDER BY created_at DESC`).all();
  const out = [];
  for (let v of rows) {
    v = evaluateConsent(v);
    if (v.consent_status === 'active') out.push(videoDTO(v));
  }
  return out;
}

export function getPublicVideo(id) {
  let v = getVideo(id);
  if (!v) throw new HttpError(404, '视频不存在');
  v = evaluateConsent(v);
  if (!v.published || v.consent_status !== 'active') {
    throw new HttpError(410, '视频暂不可观看（授权失效或已撤下）', 'MEDIA_UNAVAILABLE');
  }
  return videoDTO(v);
}

export function resolveShare(token) {
  const s = db.prepare('SELECT * FROM shares WHERE token=?').get(token);
  if (!s || s.status !== 'active') throw new HttpError(404, '分享链接不存在或已关闭');
  let v = evaluateConsent(getVideo(s.video_id));
  if (v.consent_status !== 'active') {
    throw new HttpError(410, '该视频授权已失效，分享无法观看', 'SHARE_EXPIRED');
  }
  return { share: s, video: videoDTO(v) };
}

// 公开资产门禁：仅当资产属于某个“已发布且授权有效”的视频时可取用
export function getPublicAsset(assetId) {
  const asset = getAsset(assetId);
  if (!asset) throw new HttpError(404, '素材不存在');
  if (asset.status !== 'ready') throw new HttpError(410, '素材已下线', 'ASSET_REMOVED');
  const videos = new Set();
  const v1 = db.prepare('SELECT id, consent_status, consent_expires_at, published FROM videos WHERE source_asset_id=?').all(assetId);
  v1.forEach((v) => videos.add(v.id));
  db.prepare('SELECT video_id FROM video_assets WHERE asset_id=?').all(assetId).forEach((r) => videos.add(r.video_id));
  db.prepare('SELECT video_id FROM transcode_jobs WHERE output_asset_id=?').all(assetId).forEach((r) => videos.add(r.video_id));
  for (const vid of videos) {
    const v = evaluateConsent(getVideo(vid));
    if (v.published && v.consent_status === 'active') return asset;
  }
  throw new HttpError(403, '该素材不处于可公开访问状态');
}

/* ----------------------------- 转码任务 ----------------------------- */

export function enqueueTranscode(videoId) {
  return tx(() => {
    let v = evaluateConsent(getVideo(videoId));
    if (!v) throw new HttpError(404, '视频不存在');
    if (v.consent_status !== 'active') {
      throw new HttpError(409, '未取得有效授权，不能对少儿视频发起转码', 'CONSENT_REQUIRED');
    }
    if (!v.source_asset_id) throw new HttpError(409, '缺少源文件');
    const id = db
      .prepare(
        `INSERT INTO transcode_jobs (video_id, source_asset_id, consent_epoch, status, created_at)
         VALUES (?,?,?,?,?)`
      )
      .run(videoId, v.source_asset_id, v.consent_epoch, 'queued', now()).lastInsertRowid;
    log('transcode.enqueue', 'job', id, { videoId, epoch: v.consent_epoch });
    return getJob(id);
  });
}

export function getJob(id) {
  return db.prepare('SELECT * FROM transcode_jobs WHERE id=?').get(id);
}

// 模拟异步转码“完成”。迟到任务（撤销后 / 授权轮次已变 / 授权到期）在此作废，且不产出资产。
export function completeTranscode(jobId) {
  return tx(() => {
    const job = getJob(jobId);
    if (!job) throw new HttpError(404, '任务不存在');
    if (job.status === 'done') return job;
    if (job.status === 'rejected') return job;
    const v = evaluateConsent(getVideo(job.video_id));
    let rejectReason = null;
    if (v.consent_status === 'revoked') rejectReason = '授权已撤销：迟到的转码任务作废，不产出文件';
    else if (v.consent_status === 'expired' || v.consent_status === 'none') rejectReason = '授权已失效：转码结果不得发布';
    else if (job.consent_epoch !== v.consent_epoch) rejectReason = `授权轮次已更新（任务 epoch=${job.consent_epoch}，当前 epoch=${v.consent_epoch}）：旧任务作废`;

    if (rejectReason) {
      db.prepare(
        `UPDATE transcode_jobs SET status='rejected', reject_reason=?, finished_at=? WHERE id=?`
      ).run(rejectReason, now(), jobId);
      log('transcode.reject', 'job', jobId, { reason: rejectReason });
      return getJob(jobId);
    }
    const source = getAsset(job.source_asset_id);
    if (!source || source.status !== 'ready') {
      db.prepare(
        `UPDATE transcode_jobs SET status='rejected', reject_reason='源文件已不存在', finished_at=? WHERE id=?`
      ).run(now(), jobId);
      return getJob(jobId);
    }
    // 模拟转码输出（实际环境调用 ffmpeg；此处复制源字节表示产物）
    const buf = fs.readFileSync(assetPath(source));
    const out = saveAsset({ kind: 'output', mime: source.mime, buffer: buf, filenameExt: path.extname(source.filename).slice(1) || null });
    db.prepare(
      `UPDATE transcode_jobs SET status='done', output_asset_id=?, finished_at=? WHERE id=?`
    ).run(out.id, now(), jobId);
    log('transcode.done', 'job', jobId, { outputAssetId: out.id });
    return getJob(jobId);
  });
}

/* ----------------------------- 管理端列表 ----------------------------- */

export function adminListVideos() {
  return db.prepare('SELECT * FROM videos ORDER BY id DESC').all().map((v) => videoDTO(v, { includeProgress: true }));
}

export function adminGetVideo(id) {
  const v = getVideo(id);
  if (!v) throw new HttpError(404, '视频不存在');
  const dto = videoDTO(evaluateConsent(v), { includeProgress: true });
  dto.jobs = db.prepare('SELECT * FROM transcode_jobs WHERE video_id=? ORDER BY id').all(id);
  dto.shares = db.prepare('SELECT * FROM shares WHERE video_id=? ORDER BY id').all(id).map((s) => ({
    id: s.id, token: s.token, status: s.status, createdAt: s.created_at, revokedAt: s.revoked_at,
  }));
  return dto;
}

export function listJobs() {
  return db.prepare('SELECT * FROM transcode_jobs ORDER BY id DESC').all();
}

export function sweepExpiredConsents() {
  const rows = db
    .prepare(`SELECT id FROM videos WHERE consent_status='active' AND consent_expires_at IS NOT NULL AND consent_expires_at <= ?`)
    .all(now());
  for (const r of rows) evaluateConsent(getVideo(r.id));
  return rows.map((r) => r.id);
}
