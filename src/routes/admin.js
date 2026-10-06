import { Router } from 'express';
import { asyncHandler, HttpError } from '../util/helpers.js';
import { config } from '../config.js';
import * as booking from '../services/bookingService.js';
import * as resources from '../services/resourceService.js';
import * as media from '../services/mediaService.js';

export const adminRouter = Router();

/* ---------- 场地 / 教练 / 年龄分组 ---------- */
adminRouter.get('/venues', asyncHandler(async (_req, res) => res.json(resources.listVenues(true))));
adminRouter.post('/venues', asyncHandler(async (req, res) => res.status(201).json(resources.createVenue(req.body || {}))));
adminRouter.patch('/venues/:id', asyncHandler(async (req, res) => res.json(resources.updateVenue(Number(req.params.id), req.body || {}))));

adminRouter.get('/coaches', asyncHandler(async (_req, res) => res.json(resources.listCoaches(true))));
adminRouter.post('/coaches', asyncHandler(async (req, res) => res.status(201).json(resources.createCoach(req.body || {}))));
adminRouter.patch('/coaches/:id', asyncHandler(async (req, res) => res.json(resources.updateCoach(Number(req.params.id), req.body || {}))));

adminRouter.get('/age-groups', asyncHandler(async (_req, res) => res.json(resources.listAgeGroups())));
adminRouter.post('/age-groups', asyncHandler(async (req, res) => res.status(201).json(resources.createAgeGroup(req.body || {}))));
adminRouter.patch('/age-groups/:id', asyncHandler(async (req, res) => res.json(resources.updateAgeGroup(Number(req.params.id), req.body || {}))));

/* ---------- 场次 ---------- */
adminRouter.post('/sessions', asyncHandler(async (req, res) => res.status(201).json(booking.createSession(req.body || {}))));
adminRouter.get('/sessions', asyncHandler(async (_req, res) => res.json(booking.listPublicSessions({ from: 0 }))));
adminRouter.get('/sessions/:id', asyncHandler(async (req, res) => res.json(booking.adminSessionDetail(Number(req.params.id)))));
adminRouter.patch('/sessions/:id', asyncHandler(async (req, res) => {
  const r = booking.editSession(Number(req.params.id), req.body || {});
  res.json({ ok: true, ...r, session: booking.adminSessionDetail(Number(req.params.id)) });
}));
adminRouter.post('/sessions/:id/cancel', asyncHandler(async (req, res) => {
  res.json(booking.cancelSession(Number(req.params.id), req.body?.reason || ''));
}));

adminRouter.get('/pending-changes', asyncHandler(async (_req, res) => res.json(booking.adminListPendingChanges())));

/* ---------- 候补：人工邀请 / 撤下邀请 ---------- */
adminRouter.post('/sessions/:id/invite', asyncHandler(async (req, res) => {
  const b = booking.inviteWaitlisted(Number(req.params.id), { bookingId: req.body?.bookingId ? Number(req.body.bookingId) : undefined });
  res.status(201).json({
    id: b.id, status: b.status, position: b.position,
    studentId: b.student_id, invitedAt: b.invited_at,
    inviteExpiresAt: b.invite_expires_at,
    acceptPath: `/api/invites/${b.id}/accept`,
    ttlMs: config.manualInviteTtlMs,
  });
}));
adminRouter.post('/bookings/:id/revoke-invite', asyncHandler(async (req, res) => {
  res.json(booking.revokeInvite(Number(req.params.id)));
}));
adminRouter.post('/sweep/invites', asyncHandler(async (_req, res) => res.json({ expired: booking.sweepExpiredInvites() })));

/* ---------- 学员 / 预约只读 ---------- */
adminRouter.get('/students/:id/bookings', asyncHandler(async (req, res) => {
  res.json(booking.listStudentBookings(Number(req.params.id)));
}));

/* ---------- 少儿成果视频：授权 / 撤销 / 分享 / 转码 ---------- */
adminRouter.get('/videos', asyncHandler(async (_req, res) => res.json(media.adminListVideos())));
adminRouter.get('/videos/:id', asyncHandler(async (req, res) => res.json(media.adminGetVideo(Number(req.params.id)))));
adminRouter.post('/videos', asyncHandler(async (req, res) => {
  const v = media.createVideo(req.body || {});
  res.status(201).json(media.adminGetVideo(v.id));
}));
adminRouter.post('/videos/:id/source', asyncHandler(async (req, res) => {
  // body: { assetId } 或原始二进制上传（Content-Type: application/octet-stream + X-Mime）
  const id = Number(req.params.id);
  let assetId;
  if (Buffer.isBuffer(req.body) && req.body.length) {
    const mime = req.get('x-mime') || 'video/mp4';
    const asset = media.saveAsset({ kind: 'source', mime, buffer: req.body });
    assetId = asset.id;
  } else if (req.body?.assetId) {
    assetId = Number(req.body.assetId);
  } else throw new HttpError(400, '请上传二进制文件或提供 assetId');
  media.attachSource(id, assetId);
  res.json(media.adminGetVideo(id));
}));
adminRouter.post('/videos/:id/assets', asyncHandler(async (req, res) => {
  const { role = 'clip', mime = 'image/svg+xml' } = req.body || {};
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, '请上传二进制素材');
  const id = Number(req.params.id);
  const asset = media.saveAsset({ kind: role === 'cover' ? 'cover' : 'clip', mime, buffer: req.body });
  media.attachAsset(id, asset.id, role);
  res.status(201).json(media.adminGetVideo(id));
}));
adminRouter.post('/videos/:id/consent', asyncHandler(async (req, res) => {
  res.json(media.grantConsent(Number(req.params.id), { expiresAt: req.body?.expiresAt ?? null }));
}));
adminRouter.post('/videos/:id/revoke', asyncHandler(async (req, res) => {
  res.json(media.revokeConsent(Number(req.params.id), req.body?.reason || ''));
}));
adminRouter.post('/videos/:id/publish', asyncHandler(async (req, res) => {
  res.json(media.setPublished(Number(req.params.id), !!(req.body?.published ?? true)));
}));
adminRouter.post('/videos/:id/shares', asyncHandler(async (req, res) => {
  res.status(201).json(media.createShare(Number(req.params.id)));
}));
adminRouter.get('/shares', asyncHandler(async (_req, res) => {
  const { db } = await import('../db/index.js');
  res.json(db.prepare('SELECT * FROM shares ORDER BY id DESC').all());
}));
adminRouter.post('/shares/:id/revoke', asyncHandler(async (req, res) => {
  res.json(media.revokeShare(Number(req.params.id)));
}));
adminRouter.post('/videos/:id/transcode', asyncHandler(async (req, res) => {
  res.status(202).json(media.enqueueTranscode(Number(req.params.id)));
}));
adminRouter.get('/jobs', asyncHandler(async (_req, res) => res.json(media.listJobs())));
adminRouter.post('/jobs/:id/complete', asyncHandler(async (req, res) => {
  res.json(media.completeTranscode(Number(req.params.id)));
}));
adminRouter.post('/sweep/consents', asyncHandler(async (_req, res) => res.json({ expired: media.sweepExpiredConsents() })));

/* ---------- 审计日志 ---------- */
adminRouter.get('/audit', asyncHandler(async (_req, res) => {
  const { db } = await import('../db/index.js');
  res.json(db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').all());
}));
