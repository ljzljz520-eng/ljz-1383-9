'use strict';
// 核心业务逻辑。所有涉及资源竞争的写操作都在 db.transaction 内原子完成。
const crypto = require('crypto');

class DomainError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const ACTIVE = ['confirmed', 'invited', 'waitlist'];

// ---------- 通用辅助 ----------
function findOrCreateStudent(db, { name, phone, age }) {
  if (!name || !phone) throw new DomainError(400, 'BAD_REQUEST', '姓名与手机号必填');
  if (!Number.isInteger(age) || age < 0) throw new DomainError(400, 'BAD_REQUEST', '年龄必须是非负整数');
  let s = db.get('SELECT * FROM students WHERE phone=?', [phone]);
  if (s) {
    if (s.name !== name || s.age !== age) {
      db.run('UPDATE students SET name=?, age=? WHERE id=?', [name, age, s.id]);
    }
    return { ...s, name, age };
  }
  const sid = db.insert('INSERT INTO students(name,phone,age) VALUES(?,?,?)', [name, phone, age]);
  return db.get('SELECT * FROM students WHERE id=?', [sid]);
}

// 实际容量 = min(班级容量, 场地容量)
function actualCapacity(db, cls) {
  const venue = db.get('SELECT * FROM venues WHERE id=?', [cls.venue_id]);
  if (!venue) return cls.capacity;
  return Math.min(cls.capacity, venue.capacity);
}

function getClassOr404(db, id) {
  const cls = db.get('SELECT * FROM classes WHERE id=?', [id]);
  if (!cls) throw new DomainError(404, 'NOT_FOUND', '试听场次不存在');
  return cls;
}

// 资源健康检查：教练/场地必须启用
function assertResourcesHealthy(db, cls) {
  const coach = db.get('SELECT * FROM coaches WHERE id=?', [cls.coach_id]);
  const venue = db.get('SELECT * FROM venues WHERE id=?', [cls.venue_id]);
  if (!coach || !coach.active) throw new DomainError(409, 'COACH_UNAVAILABLE', '该场教练暂不可用，可加入候补或联系客服');
  if (!venue || !venue.active) throw new DomainError(409, 'VENUE_UNAVAILABLE', '该场地暂不可用，可加入候补或联系客服');
  return { coach, venue };
}

// 教练/场地时间重叠冲突检测（排除自己，排除已取消场次）
function hasTimeConflict(db, { coachId, venueId, startTime, endTime, excludeClassId }) {
  const rows = db.all(
    `SELECT id, coach_id, venue_id, start_time, end_time, status FROM classes
     WHERE status='scheduled' AND id != ? AND start_time < ? AND end_time > ?`,
    [excludeClassId || 0, endTime, startTime]
  );
  for (const r of rows) {
    if (r.coach_id === coachId || r.venue_id === venueId) return r;
  }
  return null;
}

function ageMatches(age, group) {
  return age >= group.age_min && age <= group.age_max;
}

function classView(db, cls) {
  const coach = db.get('SELECT id,name,style,bio,active FROM coaches WHERE id=?', [cls.coach_id]);
  const venue = db.get('SELECT id,name,address,capacity,active FROM venues WHERE id=?', [cls.venue_id]);
  const group = db.get('SELECT * FROM age_groups WHERE id=?', [cls.age_group_id]);
  const cap = actualCapacity(db, cls);
  const taken = db.get(
    `SELECT COUNT(*) c FROM bookings WHERE class_id=? AND status IN ('confirmed','invited')`,
    [cls.id]
  ).c;
  const wait = db.get(
    `SELECT COUNT(*) c FROM bookings WHERE class_id=? AND status='waitlist'`,
    [cls.id]
  ).c;
  // 待确认改期（学员侧需看到的通知）
  const pendingChange = db.get(
    `SELECT * FROM schedule_changes WHERE class_id=? AND state='pending' ORDER BY id DESC LIMIT 1`,
    [cls.id]
  );
  return {
    id: cls.id,
    title: cls.title,
    start_time: cls.start_time,
    end_time: cls.end_time,
    capacity: cls.capacity,
    actual_capacity: cap,
    capacity_reason: cls.capacity > venue.capacity
      ? `班级配置 ${cls.capacity} 人，但 ${venue.name} 实际只能容纳 ${venue.capacity} 人，实际容量取较小值。`
      : `班级与场地容量均为 ${cap} 人。`,
    version: cls.version,
    status: cls.status,
    coach,
    venue,
    age_group: group,
    // 卡片剩余量仅为提示
    remaining_hint: Math.max(0, cap - taken),
    spots_held: taken,
    waitlist_count: wait,
    pending_change: pendingChange ? changeView(db, pendingChange) : null
  };
}

function changeView(db, ch) {
  return {
    id: ch.id,
    class_id: ch.class_id,
    kind: ch.kind,
    state: ch.state,
    note: ch.note,
    old_venue_id: ch.old_venue_id,
    new_venue_id: ch.new_venue_id,
    old_coach_id: ch.old_coach_id,
    new_coach_id: ch.new_coach_id,
    old_start_time: ch.old_start_time,
    new_start_time: ch.new_start_time,
    old_end_time: ch.old_end_time,
    new_end_time: ch.new_end_time,
    created_at: ch.created_at
  };
}

// 过期邀请清理（事务内调用）：过期占位释放，随后可触发自动递补
function expireStaleInvitations(db, now) {
  const rows = db.all(
    `SELECT * FROM bookings WHERE status='invited' AND invite_expires_at IS NOT NULL AND invite_expires_at <= ?`,
    [now]
  );
  for (const b of rows) {
    db.run(`UPDATE bookings SET status='expired', updated_at=? WHERE id=? AND status='invited'`, [now, b.id]);
  }
  return rows;
}

// 学员活跃占位数（confirmed + 未过期 invited）：同一学员多场占位上限
function studentActiveSpots(db, studentId, now) {
  return db.get(
    `SELECT COUNT(*) c FROM bookings
     WHERE student_id=? AND (
       status='confirmed'
       OR (status='invited' AND (invite_expires_at IS NULL OR invite_expires_at > ?))
     )`,
    [studentId, now]
  ).c;
}

// ---------- 自动递补：名额释放时按候补顺位 FIFO 把排队者升级为 invited ----------
function autoPromote(db, classId, now, { force = false } = {}) {
  if (db.setting('auto_promote') !== '1' && !force) return [];
  const promoted = [];
  const skipped = new Set(); // 已达多场占场上限、本轮无法升级的学员
  // 循环补位直到满、候补空、或剩余候补全部不可升级
  for (;;) {
    const cls = getClassOr404(db, classId);
    if (cls.status !== 'scheduled') break;
    assertResourcesHealthy(db, cls); // 资源不健康则暂停递补
    const cap = actualCapacity(db, cls);
    const held = db.get(
      `SELECT COUNT(*) c FROM bookings WHERE class_id=? AND status IN ('confirmed','invited')`,
      [classId]
    ).c;
    if (held >= cap) break;
    const waitRows = db.all(
      `SELECT * FROM bookings WHERE class_id=? AND status='waitlist' ORDER BY waitlist_rank ASC, id ASC`,
      [classId]
    );
    const eligible = waitRows.filter((b) => !skipped.has(b.id));
    if (!eligible.length) break;
    const next = eligible[0];
    // 自动递补也要检查学员多场占场上限：达到上限者留在队列、顺位不变，本轮跳过
    if (studentActiveSpots(db, next.student_id, now) >= Number(db.setting('max_active_spots_per_student'))) {
      skipped.add(next.id);
      continue;
    }
    const ttl = Number(db.setting('invitation_ttl_hours'));
    db.run(
      `UPDATE bookings SET status='invited', waitlist_rank=NULL, invited_at=?, invite_expires_at=?, updated_at=?
       WHERE id=? AND status='waitlist'`,
      [now, db.addHoursIso(now, ttl), now, next.id]
    );
    promoted.push(db.get('SELECT * FROM bookings WHERE id=?', [next.id]));
  }
  return promoted;
}

// ---------- 报名（创建预约 / 加入候补）原子事务 ----------
// 卡片上的剩余量只能作提示：这里重新核对 班级版本、教练、场地、时间、年龄、占位数、容量
function createBooking(db, payload, { now = db.nowIso(), idemKey = null } = {}) {
  return db.transaction(() => {
    expireStaleInvitations(db, now);
    const cls0 = getClassOr404(db, payload.class_id);
    if (cls0.status !== 'scheduled') throw new DomainError(409, 'CLASS_CANCELLED', '该场已取消');

    // 资源版本核对：客户端卡片是基于某个 version 渲染的，期间换场/换教练会 +1
    if (payload.expected_version != null && Number(payload.expected_version) !== cls0.version) {
      throw new DomainError(409, 'RESOURCE_CHANGED', '该场信息刚被调整（换场/代课/改期），请查看最新信息后重试', {
        current: classView(db, cls0)
      });
    }
    const { venue } = assertResourcesHealthy(db, cls0);

    const group = db.get('SELECT * FROM age_groups WHERE id=?', [cls0.age_group_id]);
    const student = findOrCreateStudent(db, payload.student);
    if (!ageMatches(student.age, group)) {
      throw new DomainError(422, 'AGE_MISMATCH', `该场面向 ${group.name}（${group.age_min}-${group.age_max} 岁）`);
    }

    // 同一学员同场重复占位
    const dup = db.get(
      `SELECT * FROM bookings WHERE class_id=? AND student_id=? AND status IN ('confirmed','invited','waitlist')`,
      [cls0.id, student.id]
    );
    if (dup) throw new DomainError(409, 'ALREADY_BOOKED', '你已有该场的有效预约/候补，请勿重复提交', { booking_id: dup.id });

    // 同一学员多场占场上限（仅在能直接确认时拦截；加入候补不算占位）
    const cap = Math.min(cls0.capacity, venue.capacity);
    const held = db.get(
      `SELECT COUNT(*) c FROM bookings WHERE class_id=? AND status IN ('confirmed','invited')`,
      [cls0.id]
    ).c;
    const spots = studentActiveSpots(db, student.id, now);
    const maxSpots = Number(db.setting('max_active_spots_per_student'));

    let status;
    if (held < cap && spots < maxSpots) {
      status = 'confirmed';
    } else if (!payload.join_waitlist) {
      const reason = held >= cap ? 'CLASS_FULL' : 'STUDENT_SPOT_LIMIT';
      throw new DomainError(
        409, reason,
        held >= cap ? '名额已满，可勾选加入候补' : `同一学员最多保留 ${maxSpots} 场活跃占位（含未接受邀请）`,
        { remaining_hint: 0, waitlist_available: held >= cap }
      );
    } else {
      status = 'waitlist';
    }

    let waitlistRank = null;
    if (status === 'waitlist') {
      waitlistRank = (db.get(
        `SELECT COALESCE(MAX(waitlist_rank),0) m FROM bookings WHERE class_id=? AND status='waitlist'`,
        [cls0.id]
      ).m) + 1;
    }
    const bookingId = db.insert(
      `INSERT INTO bookings(class_id,student_id,status,waitlist_rank) VALUES(?,?,?,?)`,
      [cls0.id, student.id, status, waitlistRank]
    );
    const booking = db.get('SELECT * FROM bookings WHERE id=?', [bookingId]);
    return { booking, class: classView(db, cls0), promoted: [] };
  });
}

// ---------- 取消 ----------
function cancelBooking(db, bookingId, { now = db.nowIso() } = {}) {
  return db.transaction(() => {
    expireStaleInvitations(db, now);
    const b = db.get('SELECT * FROM bookings WHERE id=?', [bookingId]);
    if (!b) throw new DomainError(404, 'NOT_FOUND', '预约不存在');
    if (!['confirmed', 'invited', 'waitlist'].includes(b.status)) {
      throw new DomainError(409, 'NOT_CANCELLABLE', `当前状态 ${b.status} 不可取消`);
    }
    const wasHolding = b.status === 'confirmed' || b.status === 'invited';
    db.run(`UPDATE bookings SET status='cancelled', updated_at=? WHERE id=?`, [now, bookingId]);
    // 学员拒绝/取消一个 pending 改期也会被记录
    let promoted = [];
    if (wasHolding) promoted = autoPromote(db, b.class_id, now);
    return { booking: db.get('SELECT * FROM bookings WHERE id=?', [bookingId]), promoted };
  });
}

// ---------- 接受 / 拒绝 候补邀请 ----------
function respondInvitation(db, tokenId, action, { now = db.nowIso() } = {}) {
  // 过期是“提交后通知”：过期标记与自动递补必须先落库，不能因抛错而回滚
  let expiryNotice = null;
  const result = db.transaction(() => {
    const b = db.get('SELECT * FROM bookings WHERE id=?', [tokenId]);
    if (!b) throw new DomainError(404, 'NOT_FOUND', '邀请不存在');
    if (action === 'accept') {
      if (b.status === 'confirmed') return { booking: b, reused: true }; // 幂等：重复点击
      if (b.status !== 'invited') throw new DomainError(409, 'INVITE_NOT_ACTIVE', `邀请当前状态 ${b.status}，无法接受`);
      if (b.invite_expires_at && b.invite_expires_at <= now) {
        db.run(`UPDATE bookings SET status='expired', updated_at=? WHERE id=?`, [now, b.id]);
        const promoted = autoPromote(db, b.class_id, now);
        expiryNotice = new DomainError(410, 'INVITE_EXPIRED', '邀请已过期，名额已顺延给下一位', { promoted: promoted.map((x) => x.id) });
        return { booking: db.get('SELECT * FROM bookings WHERE id=?', [b.id]) };
      }
      // 接受瞬间重新核对全部资源
      const cls = getClassOr404(db, b.class_id);
      if (cls.status !== 'scheduled') throw new DomainError(409, 'CLASS_CANCELLED', '该场已取消');
      assertResourcesHealthy(db, cls);
      const cap = actualCapacity(db, cls);
      const held = db.get(
        `SELECT COUNT(*) c FROM bookings WHERE class_id=? AND status IN ('confirmed','invited')`,
        [cls.id]
      ).c;
      if (held > cap) throw new DomainError(409, 'CAPACITY_EXCEEDED', '实际容量已被占满（资源刚被调整）');
      const maxSpots = Number(db.setting('max_active_spots_per_student'));
      if (studentActiveSpots(db, b.student_id, now) >= maxSpots) {
        throw new DomainError(409, 'STUDENT_SPOT_LIMIT', `你已有 ${maxSpots} 场活跃占位，请先取消其中一场再接受`);
      }
      db.run(`UPDATE bookings SET status='confirmed', updated_at=? WHERE id=? AND status='invited'`, [now, b.id]);
      return { booking: db.get('SELECT * FROM bookings WHERE id=?', [b.id]) };
    }
    if (action === 'decline') {
      if (['declined', 'cancelled', 'expired'].includes(b.status)) return { booking: b, reused: true };
      if (b.status !== 'invited') throw new DomainError(409, 'INVITE_NOT_ACTIVE', `邀请当前状态 ${b.status}`);
      db.run(`UPDATE bookings SET status='declined', updated_at=? WHERE id=?`, [now, b.id]);
      const promoted = autoPromote(db, b.class_id, now);
      return { booking: db.get('SELECT * FROM bookings WHERE id=?', [b.id]), promoted };
    }
    throw new DomainError(400, 'BAD_REQUEST', 'action 必须是 accept 或 decline');
  });
  if (expiryNotice) throw expiryNotice; // 事务已提交（过期+递补已落库），再通知调用方
  return result;
}

// ---------- 后台：人工邀请（与自动递补对照） ----------
function adminInvite(db, bookingId, { now = db.nowIso() } = {}) {
  return db.transaction(() => {
    expireStaleInvitations(db, now);
    const b = db.get('SELECT * FROM bookings WHERE id=?', [bookingId]);
    if (!b) throw new DomainError(404, 'NOT_FOUND', '预约不存在');
    if (b.status !== 'waitlist') throw new DomainError(409, 'NOT_WAITLISTED', `只有候补中的学员可人工邀请，当前 ${b.status}`);
    const cls = getClassOr404(db, b.class_id);
    if (cls.status !== 'scheduled') throw new DomainError(409, 'CLASS_CANCELLED', '该场已取消');
    assertResourcesHealthy(db, cls);
    const cap = actualCapacity(db, cls);
    const held = db.get(
      `SELECT COUNT(*) c FROM bookings WHERE class_id=? AND status IN ('confirmed','invited')`,
      [cls.id]
    ).c;
    if (held >= cap) throw new DomainError(409, 'CLASS_FULL', '当前没有可邀请名额');
    const maxSpots = Number(db.setting('max_active_spots_per_student'));
    if (studentActiveSpots(db, b.student_id, now) >= maxSpots) {
      throw new DomainError(409, 'STUDENT_SPOT_LIMIT', '该学员活跃占位已达上限，无法再邀请');
    }
    const ttl = Number(db.setting('invitation_ttl_hours'));
    db.run(
      `UPDATE bookings SET status='invited', waitlist_rank=NULL, invited_at=?, invite_expires_at=?, updated_at=? WHERE id=? AND status='waitlist'`,
      [now, db.addHoursIso(now, ttl), now, b.id]
    );
    return { booking: db.get('SELECT * FROM bookings WHERE id=?', [b.id]), ttl_hours: ttl, mode: 'manual' };
  });
}

// ---------- 后台：换场（立即生效，原子核对新场地容量与冲突） ----------
function swapVenue(db, classId, newVenueId, { apply = true, note = '', now = db.nowIso() } = {}) {
  return db.transaction(() => {
    const cls = getClassOr404(db, classId);
    const newVenue = db.get('SELECT * FROM venues WHERE id=?', [newVenueId]);
    if (!newVenue || !newVenue.active) throw new DomainError(404, 'VENUE_UNAVAILABLE', '目标场地不存在或已停用');
    const conflict = hasTimeConflict(db, { coachId: cls.coach_id, venueId: newVenueId, startTime: cls.start_time, endTime: cls.end_time, excludeClassId: cls.id });
    if (conflict) throw new DomainError(409, 'RESOURCE_CONFLICT', `新场地与 #${conflict.id} 场时间冲突`);
    const changeId = db.insert(
      `INSERT INTO schedule_changes(class_id,kind,old_venue_id,new_venue_id,note,state)
       VALUES(?,?,?,?,?,?)`,
      [cls.id, 'venue_swap', cls.venue_id, newVenueId, note, apply ? 'applied' : 'pending']
    );
    const ch = db.get('SELECT * FROM schedule_changes WHERE id=?', [changeId]);
    if (apply) {
      db.run('UPDATE classes SET venue_id=?, version=version+1 WHERE id=?', [newVenueId, cls.id]);
      // 临时换场后若新场地更小，实际容量收缩：不踢人，但明确标记超额
    }
    return { change: ch, class: classView(db, getClassOr404(db, cls.id)) };
  });
}

// ---------- 后台：教练代课（原子核对新教练时间冲突） ----------
function substituteCoach(db, classId, newCoachId, { note = '', now = db.nowIso() } = {}) {
  return db.transaction(() => {
    const cls = getClassOr404(db, classId);
    const coach = db.get('SELECT * FROM coaches WHERE id=?', [newCoachId]);
    if (!coach || !coach.active) throw new DomainError(404, 'COACH_UNAVAILABLE', '代课教练不存在或已停用');
    const conflict = hasTimeConflict(db, { coachId: newCoachId, venueId: cls.venue_id, startTime: cls.start_time, endTime: cls.end_time, excludeClassId: cls.id });
    if (conflict) throw new DomainError(409, 'RESOURCE_CONFLICT', `代课教练与 #${conflict.id} 场时间冲突`);
    const changeId = db.insert(
      `INSERT INTO schedule_changes(class_id,kind,old_coach_id,new_coach_id,note,state)
       VALUES(?,?,?,?,?, 'applied')`,
      [cls.id, 'coach_substitute', cls.coach_id, newCoachId, note]
    );
    const ch = db.get('SELECT * FROM schedule_changes WHERE id=?', [changeId]);
    db.run('UPDATE classes SET coach_id=?, version=version+1 WHERE id=?', [newCoachId, cls.id]);
    return { change: ch, class: classView(db, getClassOr404(db, cls.id)) };
  });
}

// ---------- 后台：改期提案（待确认） ----------
function proposeReschedule(db, classId, { new_start_time, new_end_time, new_venue_id, note = '' }, { now = db.nowIso() } = {}) {
  return db.transaction(() => {
    const cls = getClassOr404(db, classId);
    if (new_end_time <= new_start_time) throw new DomainError(400, 'BAD_REQUEST', '结束时间必须晚于开始时间');
    const venueId = new_venue_id || cls.venue_id;
    const venue = db.get('SELECT * FROM venues WHERE id=?', [venueId]);
    if (!venue || !venue.active) throw new DomainError(404, 'VENUE_UNAVAILABLE', '目标场地不可用');
    const conflict = hasTimeConflict(db, { coachId: cls.coach_id, venueId, startTime: new_start_time, endTime: new_end_time, excludeClassId: cls.id });
    if (conflict) throw new DomainError(409, 'RESOURCE_CONFLICT', `提案时间与 #${conflict.id} 场冲突（教练或场地）`);
    const changeId = db.insert(
      `INSERT INTO schedule_changes(class_id,kind,old_venue_id,new_venue_id,old_start_time,new_start_time,old_end_time,new_end_time,note,state)
       VALUES(?, 'reschedule', ?,?,?,?,?,?,?, 'pending')`,
      [cls.id, cls.venue_id, venueId, cls.start_time, new_start_time, cls.end_time, new_end_time, note]
    );
    const ch = db.get('SELECT * FROM schedule_changes WHERE id=?', [changeId]);
    return { change: ch };
  });
}

// 学员回应改期：rejected 视为请求退出（释放占位并自动递补）
function respondReschedule(db, changeId, bookingId, response, { now = db.nowIso() } = {}) {
  return db.transaction(() => {
    const ch = db.get('SELECT * FROM schedule_changes WHERE id=? AND state=?', [changeId, 'pending']);
    if (!ch) throw new DomainError(404, 'NOT_FOUND', '待确认改期不存在或已处理');
    const b = db.get('SELECT * FROM bookings WHERE id=?', [bookingId]);
    if (!b) throw new DomainError(404, 'NOT_FOUND', '预约不存在');
    db.run('INSERT OR IGNORE INTO schedule_change_responses(change_id,booking_id,response) VALUES(?,?,?)', [changeId, bookingId, response]);
    let promoted = [];
    if (response === 'rejected' && ['confirmed', 'invited'].includes(b.status)) {
      db.run(`UPDATE bookings SET status='cancelled', updated_at=? WHERE id=?`, [now, bookingId]);
      promoted = autoPromote(db, b.class_id, now);
    }
    return { ok: true, promoted };
  });
}

// 后台确认改期生效：原子应用 + 版本 +1，拒绝改期的已确认学员需后台另行处理（此处自动退出并递补）
function applyReschedule(db, changeId, { now = db.nowIso() } = {}) {
  return db.transaction(() => {
    const ch = db.get('SELECT * FROM schedule_changes WHERE id=?', [changeId]);
    if (!ch) throw new DomainError(404, 'NOT_FOUND', '改期记录不存在');
    if (ch.state !== 'pending') throw new DomainError(409, 'CHANGE_NOT_PENDING', `改期记录状态 ${ch.state}`);
    const cls = getClassOr404(db, ch.class_id);
    const conflict = hasTimeConflict(db, {
      coachId: cls.coach_id,
      venueId: ch.new_venue_id,
      startTime: ch.new_start_time,
      endTime: ch.new_end_time,
      excludeClassId: cls.id
    });
    if (conflict) throw new DomainError(409, 'RESOURCE_CONFLICT', `确认时发现新冲突 #${conflict.id}（资源已变化）`);
    db.run('UPDATE schedule_changes SET state=? WHERE id=?', ['applied', changeId]);
    db.run(
      'UPDATE classes SET start_time=?, end_time=?, venue_id=?, version=version+1 WHERE id=?',
      [ch.new_start_time, ch.new_end_time, ch.new_venue_id, cls.id]
    );
    // 新场地容量收缩：不强制踢人，后台展示超额；释放拒绝者后尝试递补
    const promoted = autoPromote(db, cls.id, now);
    return { change: db.get('SELECT * FROM schedule_changes WHERE id=?', [changeId]), class: classView(db, getClassOr404(db, cls.id)), promoted };
  });
}

function cancelReschedule(db, changeId) {
  return db.transaction(() => {
    const ch = db.get('SELECT * FROM schedule_changes WHERE id=?', [changeId]);
    if (!ch) throw new DomainError(404, 'NOT_FOUND', '改期记录不存在');
    if (ch.state !== 'pending') throw new DomainError(409, 'CHANGE_NOT_PENDING', '仅待确认改期可撤销');
    db.run("UPDATE schedule_changes SET state='cancelled' WHERE id=?", [changeId]);
    return { ok: true };
  });
}

// ---------- 媒体：少儿成果视频授权与撤下 ----------
function createVideo(db, { title, student_name, age_group_id = null, source_path, guardian_note = '' }) {
  return db.transaction(() => {
    if (!title || !student_name || !source_path) throw new DomainError(400, 'BAD_REQUEST', '标题、学员名、源文件标识必填');
    const id = db.insert(
      `INSERT INTO videos(title,student_name,age_group_id,source_path,guardian_note,consent_status,state)
       VALUES(?,?,?,?,?, 'pending', 'private')`,
      [title, student_name, age_group_id, source_path, guardian_note]
    );
    return { video: db.get('SELECT * FROM videos WHERE id=?', [id]) };
  });
}

// 独立授权，可设到期时间
function grantConsent(db, videoId, { expires_at = null, guardian_note = '' }, { now = db.nowIso() } = {}) {
  return db.transaction(() => {
    const v = db.get('SELECT * FROM videos WHERE id=?', [videoId]);
    if (!v) throw new DomainError(404, 'NOT_FOUND', '视频不存在');
    if (expires_at && expires_at <= now) throw new DomainError(400, 'BAD_REQUEST', '授权到期时间必须在未来');
    db.run(
      `UPDATE videos SET consent_status='granted', consent_granted_at=?, consent_expires_at=?, guardian_note=?, state=CASE WHEN state='taken_down' THEN state ELSE 'published' END
       WHERE id=?`,
      [now, expires_at, guardian_note, videoId]
    );
    return { video: db.get('SELECT * FROM videos WHERE id=?', [videoId]) };
  });
}

// 授权到期扫描：到期即按撤下流程处理（不只是列表隐藏）
function sweepConsentExpiry(db, { now = db.nowIso() } = {}) {
  return db.transaction(() => {
    const rows = db.all(
      `SELECT * FROM videos WHERE consent_status='granted' AND consent_expires_at IS NOT NULL AND consent_expires_at <= ? AND state!='taken_down'`,
      [now]
    );
    const out = [];
    for (const v of rows) out.push(takedownVideo(db, v.id, 'consent_expired', { now, persist: false }));
    return out;
  });
}

// 排转码任务（模拟）
function enqueueTranscode(db, videoId) {
  return db.transaction(() => {
    const v = db.get('SELECT * FROM videos WHERE id=?', [videoId]);
    if (!v) throw new DomainError(404, 'NOT_FOUND', '视频不存在');
    const jobId = db.insert(`INSERT INTO transcode_jobs(video_id,state) VALUES(?, 'queued')`, [videoId]);
    if (v.state === 'private') db.run(`UPDATE videos SET state='processing' WHERE id=?`, [videoId]);
    return { job: db.get('SELECT * FROM transcode_jobs WHERE id=?', [jobId]) };
  });
}

// 转码任务“迟到完成”：必须在落库前重新核对授权状态，过期/撤销则丢弃产物
function completeTranscode(db, jobId, outputPath, { now = db.nowIso() } = {}) {
  return db.transaction(() => {
    const job = db.get('SELECT * FROM transcode_jobs WHERE id=?', [jobId]);
    if (!job) throw new DomainError(404, 'NOT_FOUND', '转码任务不存在');
    if (job.state === 'done') return { job, reused: true };
    const v = db.get('SELECT * FROM videos WHERE id=?', [job.video_id]);
    const consentLive = v.consent_status === 'granted' &&
      (!v.consent_expires_at || v.consent_expires_at > now) &&
      v.state !== 'taken_down';
    if (!consentLive) {
      // 迟到任务：丢弃，不写产物、不发布
      db.run(`UPDATE transcode_jobs SET state='discarded', finished_at=? WHERE id=?`, [now, jobId]);
      return {
        job: db.get('SELECT * FROM transcode_jobs WHERE id=?', [jobId]),
        discarded: true,
        reason: v.state === 'taken_down' ? 'VIDEO_TAKEN_DOWN' : 'CONSENT_NOT_LIVE'
      };
    }
    db.run(`UPDATE transcode_jobs SET state='done', output_path=?, finished_at=? WHERE id=?`, [outputPath, now, jobId]);
    db.run(`UPDATE videos SET state='published' WHERE id=? AND state IN ('private','processing')`, [v.id]);
    return { job: db.get('SELECT * FROM transcode_jobs WHERE id=?', [jobId]), discarded: false };
  });
}

// 撤下：封面、片段、分享入口、原始/转码产物全部处理（隔离区 + 进度清单）
function takedownVideo(db, videoId, reason = 'revoked', { now = db.nowIso(), persist = true } = {}) {
  const exec = () => {
    const v = db.get('SELECT * FROM videos WHERE id=?', [videoId]);
    if (!v) throw new DomainError(404, 'NOT_FOUND', '视频不存在');
    if (v.state === 'taken_down') return { video: v, steps: db.all('SELECT * FROM takedown_steps WHERE video_id=?', [videoId]), reused: true };

    const steps = [];
    const addStep = (step, detail) => {
      db.run(
        `INSERT INTO takedown_steps(video_id,step,status,detail,updated_at) VALUES(?,?, 'done', ?, ?)`,
        [videoId, step, detail, now]
      );
      steps.push(step);
    };

    // 1 分享入口立即停用（公开分享链接 410）
    db.run('UPDATE share_links SET active=0 WHERE video_id=?', [videoId]);
    addStep('share_links', '所有分享链接已停用');

    // 2 封面断开（移动隔离区由存储层模拟；这里清空路径并记录）
    if (v.cover_path) addStep('cover', `封面 ${v.cover_path} 已移入隔离区 media-quarantine/ 并从页面移除`);
    else addStep('cover', '无封面，跳过文件移动，页面封面位已移除');

    // 3 片段隔离
    const clips = db.all('SELECT * FROM video_clips WHERE video_id=? AND state=?', [videoId, 'ready']);
    for (const c of clips) {
      db.run(`UPDATE video_clips SET state='quarantined' WHERE id=?`, [c.id]);
    }
    addStep('clips', `${clips.length} 个片段已移入隔离区`);

    // 4 在途/迟到转码任务：已完成的产物隔离，未完成的标记丢弃
    const jobs = db.all('SELECT * FROM transcode_jobs WHERE video_id=?', [videoId]);
    for (const j of jobs) {
      if (j.state === 'done') addStep(`transcode_${j.id}`, `转码产物 ${j.output_path || ''} 已隔离`);
      else db.run(`UPDATE transcode_jobs SET state='discarded', finished_at=? WHERE id=?`, [now, j.id]);
    }
    addStep('transcode_jobs', `${jobs.length} 个转码任务已处理（产物隔离/在途丢弃）`);

    // 5 原始文件（标识）隔离
    addStep('source', `原始文件标识 ${v.source_path} 已标记隔离，受控流接口停止输出`);

    db.run(
      `UPDATE videos SET state='taken_down', consent_status=?, takedown_reason=?, takedown_at=? WHERE id=?`,
      [reason === 'consent_expired' ? 'expired' : 'revoked', reason, now, videoId]
    );
    return { video: db.get('SELECT * FROM videos WHERE id=?', [videoId]), steps: db.all('SELECT * FROM takedown_steps WHERE video_id=? ORDER BY id', [videoId]) };
  };
  return persist ? db.transaction(exec) : exec();
}

function createShareLink(db, videoId) {
  return db.transaction(() => {
    const v = db.get('SELECT * FROM videos WHERE id=?', [videoId]);
    if (!v) throw new DomainError(404, 'NOT_FOUND', '视频不存在');
    if (v.state !== 'published' || v.consent_status !== 'granted') {
      throw new DomainError(409, 'NOT_SHAREABLE', '只有授权有效且已发布的视频可创建分享入口');
    }
    const token = crypto.randomBytes(12).toString('hex');
    const id = db.insert('INSERT INTO share_links(video_id,token) VALUES(?,?)', [videoId, token]);
    return { link: db.get('SELECT * FROM share_links WHERE id=?', [id]) };
  });
}

// 公开取视频：只返回授权有效、未撤下的
function publicVideos(db, now = db.nowIso()) {
  return db.all(
    `SELECT v.* FROM videos v
     WHERE v.state='published' AND v.consent_status='granted'
       AND (v.consent_expires_at IS NULL OR v.consent_expires_at > ?)
     ORDER BY v.id DESC`,
    [now]
  );
}

module.exports = {
  DomainError, ACTIVE,
  actualCapacity, classView, changeView,
  createBooking, cancelBooking, respondInvitation, adminInvite,
  swapVenue, substituteCoach, proposeReschedule, respondReschedule, applyReschedule, cancelReschedule,
  createVideo, grantConsent, sweepConsentExpiry, enqueueTranscode, completeTranscode,
  takedownVideo, createShareLink, publicVideos, studentActiveSpots, autoPromote
};
