import { Router } from 'express';
import { asyncHandler, HttpError } from '../util/helpers.js';
import * as booking from '../services/bookingService.js';
import * as resources from '../services/resourceService.js';
import * as media from '../services/mediaService.js';

export const publicRouter = Router();

/* 展示信息 */
publicRouter.get('/coaches', asyncHandler(async (_req, res) => res.json(resources.listCoaches())));
publicRouter.get('/venues', asyncHandler(async (_req, res) => res.json(resources.listVenues())));
publicRouter.get('/age-groups', asyncHandler(async (_req, res) => res.json(resources.listAgeGroups())));
publicRouter.get('/sessions', asyncHandler(async (req, res) => {
  res.json(booking.listPublicSessions({ from: Number(req.query.from) || 0 }));
}));
publicRouter.get('/sessions/:id', asyncHandler(async (req, res) => {
  res.json(booking.adminSessionDetail(Number(req.params.id)));
}));

/* 学员（监护人提交报名信息；演示项目不做账号体系） */
publicRouter.post('/students', asyncHandler(async (req, res) => {
  const s = booking.createStudent(req.body || {});
  res.status(201).json(s);
}));

publicRouter.get('/students/:id/bookings', asyncHandler(async (req, res) => {
  res.json(booking.listStudentBookings(Number(req.params.id)));
}));

/* 预约试听：选课卡剩余量只是提示；这里在事务里原子核对容量/教练/场地/每人上限 */
publicRouter.post('/bookings', asyncHandler(async (req, res) => {
  const { sessionId, studentId, idemKey } = req.body || {};
  if (!sessionId || !studentId) throw new HttpError(400, 'sessionId 与 studentId 必填');
  const result = booking.bookSession({
    sessionId: Number(sessionId), studentId: Number(studentId),
    idemKey: idemKey ? String(idemKey) : null,
  });
  res.status(result.waitlisted ? 202 : 201).json({
    booking: {
      id: result.booking.id, sessionId: result.booking.session_id,
      studentId: result.booking.student_id, status: result.booking.status,
      position: result.booking.position,
      inviteExpiresAt: result.booking.invite_expires_at,
    },
    waitlisted: result.waitlisted,
    deduped: result.deduped,
    hint: result.waitlisted
      ? '当前已满，已加入候补；自动递补场次将在有名额时自动确认，人工邀请场次请等待管理员邀请。'
      : '预约成功（名额已在确认时原子核对）。',
  });
}));

publicRouter.post('/bookings/:id/cancel', asyncHandler(async (req, res) => {
  const { studentId } = req.body || {};
  if (!studentId) throw new HttpError(400, 'studentId 必填');
  const r = booking.cancelBooking(Number(req.params.id), Number(studentId));
  res.json(r);
}));

/* 候补邀请：接受 / 拒绝（学员凭预约归属操作） */
publicRouter.post('/invites/:token/accept', asyncHandler(async (req, res) => {
  const { studentId } = req.body || {};
  if (!studentId) throw new HttpError(400, 'studentId 必填');
  const b = booking.acceptInvite({ token: req.params.token, studentId: Number(studentId) });
  res.json({ accepted: true, booking: { id: b.id, status: b.status } });
}));
publicRouter.post('/invites/:token/decline', asyncHandler(async (req, res) => {
  const { studentId } = req.body || {};
  if (!studentId) throw new HttpError(400, 'studentId 必填');
  res.json(booking.declineInvite({ token: req.params.token, studentId: Number(studentId) }));
}));

/* 待确认改期：确认 / 不接受 */
publicRouter.post('/bookings/:id/confirm-change', asyncHandler(async (req, res) => {
  const { studentId } = req.body || {};
  if (!studentId) throw new HttpError(400, 'studentId 必填');
  res.json(booking.confirmChange(Number(req.params.id), Number(studentId)));
}));
publicRouter.post('/bookings/:id/decline-change', asyncHandler(async (req, res) => {
  const { studentId } = req.body || {};
  if (!studentId) throw new HttpError(400, 'studentId 必填');
  res.json(booking.declineChange(Number(req.params.id), Number(studentId)));
}));

/* 成果墙（仅返回已发布且授权有效视频；封面/片段需通过资产门禁） */
publicRouter.get('/videos', asyncHandler(async (_req, res) => res.json(media.listPublicVideos())));
publicRouter.get('/videos/:id', asyncHandler(async (req, res) => res.json(media.getPublicVideo(Number(req.params.id)))));
publicRouter.get('/shares/:token', asyncHandler(async (req, res) => res.json(media.resolveShare(req.params.token))));
