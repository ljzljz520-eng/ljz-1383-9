import { db, tx } from '../db/index.js';
import { config } from '../config.js';
import { HttpError, now, overlaps } from '../util/helpers.js';

const HOLD_STATUSES = ['booked', 'invited', 'pending_change'];
const ACTIVE_STATUSES = ['booked', 'invited', 'pending_change', 'waitlisted'];

/* ----------------------------- 基础查询 ----------------------------- */

function getSessionOrThrow(id) {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!s) throw new HttpError(404, '场次不存在', 'SESSION_NOT_FOUND');
  return s;
}

function holdCount(sessionId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM bookings
       WHERE session_id = ? AND status IN ('booked','invited','pending_change')`
    )
    .get(sessionId).c;
}

function waitlistCount(sessionId) {
  return db
    .prepare(`SELECT COUNT(*) AS c FROM bookings WHERE session_id = ? AND status = 'waitlisted'`)
    .get(sessionId).c;
}

function sessionActiveConflicts({ coachId, venueId, startAt, endAt, excludeSessionId = null }) {
  // 同一教练或同一场地，时间重叠的其他开放场次
  const rows = db
    .prepare(
      `SELECT id, title, coach_id, venue_id, start_at, end_at FROM sessions
       WHERE status = 'open' AND id IS NOT ? AND start_at < ? AND end_at > ?`
    )
    .all(excludeSessionId, endAt, startAt);
  return rows.filter(
    (r) =>
      (coachId != null && r.coach_id === coachId) ||
      (venueId != null && r.venue_id === venueId)
  );
}

function assertResourcesReady(session) {
  if (session.status !== 'open') throw new HttpError(409, '该场次已取消', 'SESSION_CANCELLED');
  const coach = db.prepare('SELECT * FROM coaches WHERE id = ?').get(session.coach_id);
  const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(session.venue_id);
  if (!coach || !coach.active) throw new HttpError(409, '教练不可用（离职或代课未安排）', 'COACH_UNAVAILABLE');
  if (!venue || !venue.active) throw new HttpError(409, '场地不可用', 'VENUE_UNAVAILABLE');
  return { coach, venue };
}

function studentActiveHolds(studentId, excludeBookingId = null) {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM bookings b JOIN sessions s ON s.id = b.session_id
       WHERE b.student_id = ? AND b.status IN ('booked','invited','pending_change')
         AND s.status = 'open' AND b.id IS NOT ?`
    )
    .get(studentId, excludeBookingId).c;
}

/* ----------------------------- 对外 DTO ----------------------------- */

export function sessionCardDTO(session) {
  const holds = holdCount(session.id);
  const coach = db.prepare('SELECT id,name,style FROM coaches WHERE id=?').get(session.coach_id);
  const venue = db.prepare('SELECT id,name,address FROM venues WHERE id=?').get(session.venue_id);
  const ageGroup = db.prepare('SELECT id,name FROM age_groups WHERE id=?').get(session.age_group_id);
  return {
    id: session.id,
    title: session.title,
    style: session.style,
    coach,
    venue,
    ageGroup,
    startAt: session.start_at,
    endAt: session.end_at,
    capacity: session.capacity,
    // 注意：剩余量仅为卡片提示；并发下以确认瞬间事务内核对结果为准。
    holds,
    remainingHint: Math.max(0, session.capacity - holds),
    waitlist: waitlistCount(session.id),
    waitlistMode: session.waitlist_mode,
    status: session.status,
    scheduleVersion: session.schedule_version,
  };
}

export function listPublicSessions({ from = 0 } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM sessions WHERE status='open' AND end_at >= ? ORDER BY start_at ASC`
    )
    .all(from || now() - 1000 * 60 * 60 * 24 * 14);
  return rows.map(sessionCardDTO);
}

export function adminSessionDetail(id) {
  const s = getSessionOrThrow(id);
  const dto = sessionCardDTO(s);
  dto.bookings = db
    .prepare(
      `SELECT b.*, st.name AS student_name, st.contact AS student_contact
       FROM bookings b JOIN students st ON st.id = b.student_id
       WHERE b.session_id = ?
       ORDER BY CASE b.status
         WHEN 'booked' THEN 0 WHEN 'pending_change' THEN 1 WHEN 'invited' THEN 2
         WHEN 'waitlisted' THEN 3 ELSE 9 END,
         b.position, b.id`
    )
    .all(id)
    .map((b) => ({
      id: b.id,
      studentId: b.student_id,
      studentName: b.student_name,
      studentContact: b.student_contact,
      status: b.status,
      position: b.position,
      invitedAt: b.invited_at,
      inviteExpiresAt: b.invite_expires_at,
      inviteMode: b.invite_mode,
      staleSchedule: b.schedule_version != null && b.schedule_version < s.schedule_version,
      oldSessionSnapshot: b.old_session_snapshot ? JSON.parse(b.old_session_snapshot) : null,
      updatedAt: b.updated_at,
    }));
  dto.pendingChanges = dto.bookings.filter((b) => b.status === 'pending_change').length;
  return dto;
}

/* ----------------------------- 学员报名 ----------------------------- */

export function createStudent({ name, contact, age }) {
  if (!name || !contact) throw new HttpError(400, '姓名和联系方式必填');
  const info = db
    .prepare('INSERT INTO students (name, contact, age, created_at) VALUES (?,?,?,?)')
    .run(name, contact, age ?? null, now());
  return db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid);
}

/* --------------------- 名额释放后的自动递补（auto） --------------------- */

function promoteFromWaitlist(sessionId) {
  const promoted = [];
  const session = () => db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
  // 仅自动模式：有空位就直接把候补最前且仍有资格的人递补为 booked
  // 人工模式不在此自动邀请。
  let guard = 0;
  for (;;) {
    if (guard++ > 500) break;
    const s = session();
    if (!s || s.status !== 'open' || s.waitlist_mode !== 'auto') break;
    if (holdCount(sessionId) >= s.capacity) break;
    const candidate = db
      .prepare(
        `SELECT * FROM bookings WHERE session_id = ? AND status = 'waitlisted'
         ORDER BY position ASC, id ASC LIMIT 1`
      )
      .get(sessionId);
    if (!candidate) break;
    if (studentActiveHolds(candidate.student_id) >= config.maxActiveHoldsPerStudent) {
      // 该学员占位已达上限：跳过（不递增其位置，等其取消后下一轮再递补）
      break;
    }
    db.prepare(
      `UPDATE bookings SET status='booked', invited_at=NULL, invite_expires_at=NULL,
         invite_mode=NULL, schedule_version=?, updated_at=? WHERE id=?`
    ).run(s.schedule_version, now(), candidate.id);
    promoted.push(candidate.id);
  }
  return promoted;
}

/* ----------------------------- 预约（试听） ----------------------------- */

export function bookSession({ sessionId, studentId, idemKey }) {
  return tx(() => {
    const session = getSessionOrThrow(sessionId);
    assertResourcesReady(session);

    if (idemKey) {
      const existing = db
        .prepare('SELECT * FROM bookings WHERE idem_key = ?')
        .get(idemKey);
      if (existing) {
        return { booking: existing, deduped: true, waitlisted: existing.status === 'waitlisted' };
      }
    }

    const dup = db
      .prepare(
        `SELECT * FROM bookings WHERE session_id=? AND student_id=?
         AND status IN ('booked','invited','pending_change','waitlisted')`
      )
      .get(sessionId, studentId);
    if (dup) throw new HttpError(409, '该学员已在本场次名单或候补中，请勿重复提交', 'ALREADY_IN_SESSION');

    const holds = holdCount(sessionId);
    // 候补不占位，因此只有在“会真正占名额”时才校验每人占位上限；满员时允许加入候补。
    if (holds < session.capacity && studentActiveHolds(studentId) >= config.maxActiveHoldsPerStudent) {
      throw new HttpError(
        409,
        `同一学员最多同时占位 ${config.maxActiveHoldsPerStudent} 场，请先取消其他占位（仍可加入本场候补）`,
        'HOLD_LIMIT'
      );
    }

    let status;
    let position = null;
    let waitlisted = false;
    if (holds < session.capacity) {
      status = 'booked';
    } else {
      status = 'waitlisted';
      waitlisted = true;
      const row = db
        .prepare(
          `SELECT COALESCE(MAX(position),0)+1 AS p FROM bookings
           WHERE session_id=? AND status IN ('waitlisted','invited')`
        )
        .get(sessionId);
      position = row.p;
    }
    const ts = now();
    const info = db
      .prepare(
        `INSERT INTO bookings
           (session_id, student_id, status, position, schedule_version, idem_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(sessionId, studentId, status, position, session.schedule_version, idemKey ?? null, ts, ts);
    return { booking: db.prepare('SELECT * FROM bookings WHERE id=?').get(info.lastInsertRowid), deduped: false, waitlisted };
  });
}

/* ----------------------------- 学员取消 ----------------------------- */

export function cancelBooking(bookingId, studentId) {
  return tx(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
    if (!b) throw new HttpError(404, '预约不存在');
    if (b.student_id !== studentId) throw new HttpError(403, '只能取消本人预约');
    if (b.status === 'cancelled' || b.status === 'declined' || b.status === 'expired') {
      throw new HttpError(409, '该预约已结束，无需取消');
    }
    const wasHolding = HOLD_STATUSES.includes(b.status);
    db.prepare(
      `UPDATE bookings SET status='cancelled', updated_at=?, invite_expires_at=NULL WHERE id=?`
    ).run(now(), b.id);
    let promoted = [];
    if (wasHolding) promoted = promoteFromWaitlist(b.session_id);
    return { cancelled: true, promoted };
  });
}

/* --------------------- 人工邀请（manual waitlist） --------------------- */

export function inviteWaitlisted(sessionId, { bookingId } = {}) {
  return tx(() => {
    const session = getSessionOrThrow(sessionId);
    assertResourcesReady(session);
    if (session.waitlist_mode !== 'manual') {
      throw new HttpError(409, '该场次为自动递补模式，空出的名额会自动分配', 'AUTO_MODE');
    }
    if (holdCount(sessionId) >= session.capacity) {
      throw new HttpError(409, '当前没有可邀请的空位', 'NO_SLOT');
    }
    let candidate;
    if (bookingId) {
      candidate = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
      if (!candidate || candidate.session_id !== sessionId || candidate.status !== 'waitlisted') {
        throw new HttpError(404, '指定候补不存在');
      }
    } else {
      candidate = db
        .prepare(
          `SELECT * FROM bookings WHERE session_id=? AND status='waitlisted'
           ORDER BY position ASC, id ASC LIMIT 1`
        )
        .get(sessionId);
    }
    if (!candidate) throw new HttpError(404, '候补名单为空', 'NO_WAITLIST');
    if (studentActiveHolds(candidate.student_id, candidate.id) >= config.maxActiveHoldsPerStudent) {
      throw new HttpError(409, '该学员占位已达上限，无法邀请（请先邀请其他人或让其取消占位）', 'HOLD_LIMIT');
    }
    const ts = now();
    db.prepare(
      `UPDATE bookings SET status='invited', invited_at=?, invite_expires_at=?, invite_mode='manual', updated_at=?
       WHERE id=?`
    ).run(ts, ts + config.manualInviteTtlMs, ts, candidate.id);
    return db.prepare('SELECT * FROM bookings WHERE id=?').get(candidate.id);
  });
}

// 惰性过期 + 定时清扫：把过期邀请置为 expired 并释放名额。
// 自动模式下不会产生 invited；人工模式下不自动递补下一位（由管理员再次邀请）。
export function sweepExpiredInvites() {
  return tx(() => {
    const ts = now();
    const rows = db
      .prepare(`SELECT * FROM bookings WHERE status='invited' AND invite_expires_at <= ?`)
      .all(ts);
    for (const b of rows) {
      db.prepare(`UPDATE bookings SET status='expired', updated_at=? WHERE id=?`).run(ts, b.id);
    }
    return rows.map((b) => b.id);
  });
}

function getLiveInvite(token) {
  // 优先按邀请令牌（id 即对外令牌的简化实现：使用 I... 前缀 token 存 idem?）
  // 这里邀请链接携带 booking id；真实系统应使用随机 token，学生身份以联系方式校验。
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(Number(token));
  if (!b) throw new HttpError(404, '邀请不存在');
  return b;
}

export function acceptInvite({ token, studentId }) {
  return tx(() => {
    const b = getLiveInvite(token);
    if (b.status !== 'invited') {
      if (b.status === 'expired') throw new HttpError(410, '邀请已过期', 'INVITE_EXPIRED');
      throw new HttpError(409, `当前状态 ${b.status}，不能接受邀请`);
    }
    if (b.invite_expires_at <= now()) {
      db.prepare(`UPDATE bookings SET status='expired', updated_at=? WHERE id=?`).run(now(), b.id);
      throw new HttpError(410, '邀请已过期', 'INVITE_EXPIRED');
    }
    if (b.student_id !== studentId) throw new HttpError(403, '这不是发给该学员的邀请');
    const session = getSessionOrThrow(b.session_id);
    assertResourcesReady(session);
    if (b.schedule_version !== session.schedule_version) {
      throw new HttpError(409, '场次安排已更新，请查看最新改期邀请', 'STALE_SCHEDULE');
    }
    if (studentActiveHolds(studentId, b.id) >= config.maxActiveHoldsPerStudent) {
      throw new HttpError(409, `已达每人 ${config.maxActiveHoldsPerStudent} 场占位上限`, 'HOLD_LIMIT');
    }
    // invited 本身已占名额，转 booked 不改变计数；仍在事务内复核，保证并发下不超额。
    if (holdCount(session.id) > session.capacity) {
      throw new HttpError(409, '名额已满', 'NO_SLOT');
    }
    db.prepare(
      `UPDATE bookings SET status='booked', updated_at=? WHERE id=?`
    ).run(now(), b.id);
    return db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  });
}

export function declineInvite({ token, studentId }) {
  return tx(() => {
    const b = getLiveInvite(token);
    if (b.student_id !== studentId) throw new HttpError(403, '只能处理本人邀请');
    if (b.status === 'declined' || b.status === 'expired') {
      throw new HttpError(409, '邀请已结束');
    }
    if (b.status !== 'invited') throw new HttpError(409, '没有待处理的邀请');
    db.prepare(
      `UPDATE bookings SET status='declined', invite_expires_at=NULL, updated_at=? WHERE id=?`
    ).run(now(), b.id);
    // 人工模式：名额释放后不自动递补，等待管理员邀请。
    return { declined: true };
  });
}

/* -------------- 管理员撤下邀请（取消竞争）：邀请作废，空位保留 -------------- */

export function revokeInvite(bookingId) {
  return tx(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
    if (!b) throw new HttpError(404, '预约不存在');
    if (b.status !== 'invited') throw new HttpError(409, '该预约当前不是邀请状态');
    db.prepare(
      `UPDATE bookings SET status='waitlisted', invited_at=NULL, invite_expires_at=NULL,
         invite_mode=NULL, updated_at=? WHERE id=?`
    ).run(now(), b.id);
    return { revoked: true };
  });
}

/* --------------------- 管理员：改期 / 临时换场 / 代课 --------------------- */

export function createSession(payload) {
  return tx(() => {
    const { title, style = '', coachId, venueId, ageGroupId, startAt, endAt, capacity, waitlistMode = 'auto' } = payload;
    if (!title || coachId == null || venueId == null || !startAt || !endAt) {
      throw new HttpError(400, '标题、教练、场地、起止时间必填');
    }
    if (endAt <= startAt) throw new HttpError(400, '结束时间必须晚于开始时间');
    const coach = db.prepare('SELECT * FROM coaches WHERE id=?').get(coachId);
    const venue = db.prepare('SELECT * FROM venues WHERE id=?').get(venueId);
    if (!coach || !coach.active) throw new HttpError(400, '教练不可用');
    if (!venue || !venue.active) throw new HttpError(400, '场地不可用');
    const cap = Math.max(1, Number(capacity) || venue.capacity);
    if (cap > venue.capacity) throw new HttpError(400, `班级人数不能超过该场地容量 ${venue.capacity}`);
    const conflict = sessionActiveConflicts({ coachId, venueId, startAt, endAt })[0];
    if (conflict) throw new HttpError(409, `教练或场地与场次 #${conflict.id}「${conflict.title}」时间冲突`, 'RESOURCE_CONFLICT');
    const info = db
      .prepare(
        `INSERT INTO sessions (title, style, coach_id, venue_id, age_group_id, start_at, end_at, capacity, waitlist_mode, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(title, style, coachId, venueId, ageGroupId ?? null, startAt, endAt, cap, waitlistMode, now());
    return getSessionOrThrow(info.lastInsertRowid);
  });
}

export function editSession(sessionId, patch) {
  return tx(() => {
    const s = getSessionOrThrow(sessionId);
    const next = {
      title: patch.title ?? s.title,
      style: patch.style ?? s.style,
      coachId: patch.coachId ?? s.coach_id,
      venueId: patch.venueId ?? s.venue_id,
      ageGroupId: patch.ageGroupId ?? s.age_group_id,
      startAt: patch.startAt ?? s.start_at,
      endAt: patch.endAt ?? s.end_at,
      capacity: patch.capacity ?? s.capacity,
      waitlistMode: patch.waitlistMode ?? s.waitlist_mode,
    };
    if (next.endAt <= next.startAt) throw new HttpError(400, '结束时间必须晚于开始时间');
    const venue = db.prepare('SELECT * FROM venues WHERE id=?').get(next.venueId);
    const coach = db.prepare('SELECT * FROM coaches WHERE id=?').get(next.coachId);
    if (!venue || !venue.active) throw new HttpError(400, '场地不可用');
    if (!coach || !coach.active) throw new HttpError(400, '教练不可用');
    if (next.capacity > venue.capacity) throw new HttpError(400, `班级人数不能超过场地容量 ${venue.capacity}`);
    const conflict = sessionActiveConflicts({
      coachId: next.coachId, venueId: next.venueId,
      startAt: next.startAt, endAt: next.endAt, excludeSessionId: sessionId,
    })[0];
    if (conflict) throw new HttpError(409, `教练或场地与场次 #${conflict.id} 时间冲突`, 'RESOURCE_CONFLICT');

    const scheduleChanged =
      next.coachId !== s.coach_id ||
      next.venueId !== s.venue_id ||
      next.startAt !== s.start_at ||
      next.endAt !== s.end_at;

    // 容量收缩不得低于既有确认占位（含待确认改期；邀请会在下面退回候补）
    const protectedHolds = db
      .prepare(
        `SELECT COUNT(*) AS c FROM bookings WHERE session_id=?
         AND status IN ('booked','pending_change')`
      )
      .get(sessionId).c;
    if (next.capacity < protectedHolds) {
      throw new HttpError(409, `已有 ${protectedHolds} 个确认占位，容量不能低于该数`, 'CAPACITY_TOO_LOW');
    }

    db.prepare(
      `UPDATE sessions SET title=?, style=?, coach_id=?, venue_id=?, age_group_id=?, start_at=?, end_at=?,
        capacity=?, waitlist_mode=? WHERE id=?`
    ).run(
      next.title, next.style, next.coachId, next.venueId, next.ageGroupId,
      next.startAt, next.endAt, next.capacity, next.waitlistMode, sessionId
    );

    if (scheduleChanged) {
      db.prepare('UPDATE sessions SET schedule_version = schedule_version + 1 WHERE id=?').run(sessionId);
      const snapshot = JSON.stringify(sessionCardDTO(s));
      // 已确认 -> 待确认改期（保留名额）；已是 pending_change 的保留最初快照
      db.prepare(
        `UPDATE bookings SET status='pending_change', old_session_snapshot=COALESCE(old_session_snapshot, ?),
           updated_at=? WHERE session_id=? AND status='booked'`
      ).run(snapshot, now(), sessionId);
      // 已邀请（占名额）-> 退回候补，交还名额，保留候补位置
      db.prepare(
        `UPDATE bookings SET status='waitlisted', invited_at=NULL, invite_expires_at=NULL, invite_mode=NULL,
           updated_at=? WHERE session_id=? AND status='invited'`
      ).run(now(), sessionId);
      const promoted = promoteFromWaitlist(sessionId);
      return { scheduleChanged: true, promoted };
    }
    // 仅扩容/模式变化：自动模式下尝试递补
    const promoted = promoteFromWaitlist(sessionId);
    return { scheduleChanged: false, promoted };
  });
}

export function confirmChange(bookingId, studentId) {
  return tx(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
    if (!b) throw new HttpError(404, '预约不存在');
    if (b.student_id !== studentId) throw new HttpError(403, '只能处理本人预约');
    if (b.status !== 'pending_change') throw new HttpError(409, '没有待确认的改期');
    const session = getSessionOrThrow(b.session_id);
    assertResourcesReady(session);
    if (studentActiveHolds(studentId, b.id) >= config.maxActiveHoldsPerStudent) {
      throw new HttpError(409, `已达每人 ${config.maxActiveHoldsPerStudent} 场占位上限`, 'HOLD_LIMIT');
    }
    // pending_change 一直保留名额；仍在事务内核对容量与资源
    if (holdCount(session.id) > session.capacity) throw new HttpError(409, '名额超额', 'NO_SLOT');
    db.prepare(
      `UPDATE bookings SET status='booked', schedule_version=?, old_session_snapshot=NULL, updated_at=? WHERE id=?`
    ).run(session.schedule_version, now(), b.id);
    return { confirmed: true };
  });
}

export function declineChange(bookingId, studentId) {
  return tx(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
    if (!b) throw new HttpError(404, '预约不存在');
    if (b.student_id !== studentId) throw new HttpError(403, '只能处理本人预约');
    if (b.status !== 'pending_change') throw new HttpError(409, '没有待确认的改期');
    db.prepare(
      `UPDATE bookings SET status='cancelled', old_session_snapshot=NULL, updated_at=? WHERE id=?`
    ).run(now(), b.id);
    const promoted = promoteFromWaitlist(b.session_id);
    return { declined: true, promoted };
  });
}

export function cancelSession(sessionId, reason = '') {
  return tx(() => {
    const s = getSessionOrThrow(sessionId);
    db.prepare(`UPDATE sessions SET status='cancelled' WHERE id=?`).run(sessionId);
    db.prepare(
      `UPDATE bookings SET status='cancelled', updated_at=?
       WHERE session_id=? AND status IN ('booked','invited','pending_change','waitlisted')`
    ).run(now(), sessionId);
    return { cancelledSession: true, reason };
  });
}

/* ----------------------------- 学员视角查询 ----------------------------- */

export function listStudentBookings(studentId) {
  const rows = db
    .prepare(
      `SELECT b.*, s.title AS session_title, s.start_at, s.end_at, s.schedule_version AS current_version,
              s.status AS session_status, c.name AS coach_name, v.name AS venue_name
       FROM bookings b
       JOIN sessions s ON s.id = b.session_id
       LEFT JOIN coaches c ON c.id = s.coach_id
       LEFT JOIN venues v ON v.id = s.venue_id
       WHERE b.student_id = ? ORDER BY b.id DESC`
    )
    .all(studentId);
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    sessionTitle: r.session_title,
    startAt: r.start_at,
    endAt: r.end_at,
    coachName: r.coach_name,
    venueName: r.venue_name,
    status: r.status,
    inviteExpiresAt: r.invite_expires_at,
    needsDecision: r.status === 'pending_change' || r.status === 'invited',
    staleSchedule: r.schedule_version !== r.current_version,
    oldSessionSnapshot: r.old_session_snapshot ? JSON.parse(r.old_session_snapshot) : null,
  }));
}

export function adminListPendingChanges() {
  const rows = db
    .prepare(
      `SELECT b.id, b.session_id, b.student_id, b.updated_at, st.name AS student_name, st.contact,
              s.title, s.start_at, s.end_at, s.schedule_version
       FROM bookings b JOIN students st ON st.id=b.student_id JOIN sessions s ON s.id=b.session_id
       WHERE b.status='pending_change' ORDER BY b.updated_at DESC`
    )
    .all();
  return rows.map((r) => ({
    bookingId: r.id, sessionId: r.session_id, studentId: r.student_id,
    studentName: r.student_name, contact: r.contact,
    sessionTitle: r.title, newStartAt: r.start_at, newEndAt: r.end_at,
    version: r.schedule_version, since: r.updated_at,
  }));
}
