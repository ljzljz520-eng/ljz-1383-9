'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const S = require('./services');

function createApp(db, { adminToken = process.env.ADMIN_TOKEN || 'dev-admin-token' } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  const handle = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (res.headersSent || out === undefined) return; // handler 已自行响应或无需响应体
      res.json(out);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof S.DomainError) {
        return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
      }
      console.error(err);
      res.status(500).json({ error: 'INTERNAL', message: err.message });
    }
  };

  function requireAdmin(req, res, next) {
    const token = req.get('x-admin-token') || (req.body && req.body.admin_token);
    if (token !== adminToken) return res.status(401).json({ error: 'UNAUTHORIZED', message: '需要管理员令牌（X-Admin-Token）' });
    next();
  }

  // 幂等中间件：相同 Idempotency-Key + 相同请求体只执行一次（防重复点击挤名额）
  function idempotent(category) {
    return (req, res, next) => {
      const key = req.get('idempotency-key') || (req.body && req.body.idempotency_key);
      if (!key) return next();
      const fullKey = `${category}:${key}`;
      const hash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
      const existing = db.get('SELECT * FROM idempotency WHERE idem_key=?', [fullKey]);
      if (existing) {
        if (existing.request_hash !== hash) {
          return res.status(409).json({ error: 'IDEMPOTENCY_KEY_REUSED', message: '相同的幂等键被用于不同请求' });
        }
        res.status(existing.response_code);
        res.set('Idempotent-Replay', 'true');
        return res.send(existing.response_body);
      }
      const origJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode < 500) {
          try {
            db.run('INSERT INTO idempotency(idem_key,request_hash,response_code,response_body) VALUES(?,?,?,?)',
              [fullKey, hash, res.statusCode, JSON.stringify(body)]);
            db.persist();
          } catch (_) { /* 并发重复插入时回退为重放 */ }
        }
        return origJson(body);
      };
      next();
    };
  }

  // ---------- 公开：展示数据 ----------
  app.get('/api/styles', handle(() => ({
    styles: [
      { name: 'Hip-Hop', desc: '律动、节奏与街头态度的根基' },
      { name: 'Popping / Locking', desc: '肌肉震动与经典锁舞框架' },
      { name: 'Breaking', desc: 'Footwork、Freeze 与 Toprock' },
      { name: 'Choreography', desc: '舞台成品舞段与 MV 编舞' }
    ]
  })));

  app.get('/api/coaches', handle(() => ({ coaches: db.all('SELECT * FROM coaches WHERE active=1 ORDER BY id') })));
  app.get('/api/age-groups', handle(() => ({ age_groups: db.all('SELECT * FROM age_groups ORDER BY age_min') })));
  app.get('/api/venues', handle(() => ({ venues: db.all('SELECT * FROM venues WHERE active=1 ORDER BY id') })));

  // 列表：卡片剩余量仅提示
  app.get('/api/classes', handle(() => {
    // 卡片数据仅为提示；过期邀请的清理与递补在写事务里发生，这里只做只读渲染
    const now = new Date().toISOString();
    const rows = db.all("SELECT * FROM classes WHERE status='scheduled' ORDER BY start_time");
    return { classes: rows.map((c) => S.classView(db, c)), server_time: now };
  }));

  app.get('/api/classes/:id', handle((req, res) => {
    const c = db.get('SELECT * FROM classes WHERE id=?', [req.params.id]);
    if (!c) { res.status(404).json({ error: 'NOT_FOUND', message: '场次不存在' }); return; }
    const view = S.classView(db, c);
    view.bookings = db.all(
      `SELECT b.id,b.status,b.waitlist_rank,b.invite_expires_at,st.name,st.age
       FROM bookings b JOIN students st ON st.id=b.student_id
       WHERE b.class_id=? ORDER BY b.id`, [c.id]
    );
    return view;
  }));

  // ---------- 公开：报名 / 取消 / 邀请回应 / 改期回应 ----------
  app.post('/api/bookings', idempotent('booking'), handle((req) => {
    const out = S.createBooking(db, req.body, { idemKey: req.get('idempotency-key') });
    return {
      status: out.booking.status,
      booking_id: out.booking.id,
      waitlist_rank: out.booking.waitlist_rank,
      message: out.booking.status === 'confirmed' ? '试听名额已确认锁定' : '已满员，你已加入候补队列，有名额时将按顺位递补',
      class: out.class
    };
  }));

  app.post('/api/bookings/:id/cancel', idempotent('cancel'), handle((req) => {
    const out = S.cancelBooking(db, Number(req.params.id));
    return { ok: true, promoted: out.promoted.map((b) => ({ booking_id: b.id, mode: 'auto' })) };
  }));

  app.post('/api/invitations/:id/:action', idempotent('invite'), handle((req) => {
    const out = S.respondInvitation(db, Number(req.params.id), req.params.action);
    return { ok: true, status: out.booking.status, reused: !!out.reused, promoted: (out.promoted || []).map((b) => b.id) };
  }));

  // 学员查自己的邀请（演示用：手机号查询）
  app.get('/api/my-invitations', handle((req) => {
    const phone = req.query.phone;
    if (!phone) throw new S.DomainError(400, 'BAD_REQUEST', '需要 phone 查询参数');
    const st = db.get('SELECT * FROM students WHERE phone=?', [phone]);
    if (!st) return { invitations: [] };
    const rows = db.all(
      `SELECT b.id,b.status,b.invited_at,b.invite_expires_at,c.id class_id,c.title,c.start_time,c.end_time,
              co.name coach_name, v.name venue_name
       FROM bookings b
       JOIN classes c ON c.id=b.class_id
       JOIN coaches co ON co.id=c.coach_id
       JOIN venues v ON v.id=c.venue_id
       WHERE b.student_id=? AND b.status='invited'
       ORDER BY b.id DESC`, [st.id]);
    return { invitations: rows };
  }));

  app.post('/api/schedule-changes/:id/respond', idempotent('chgresp'), handle((req) => {
    const out = S.respondReschedule(db, Number(req.params.id), Number(req.body.booking_id), req.body.response);
    return { ok: true, promoted: out.promoted.map((b) => b.id) };
  }));

  // ---------- 公开：成果视频（只暴露授权有效内容；受控流 410） ----------
  app.get('/api/achievements', handle(() => {
    const now = new Date().toISOString();
    const videos = S.publicVideos(db, now).map((v) => ({
      id: v.id, title: v.title, student_name: v.student_name,
      age_group_id: v.age_group_id, consent_expires_at: v.consent_expires_at,
      has_cover: !!v.cover_path
    }));
    return { videos, note: '仅展示监护人授权有效且未撤下的少儿成果视频' };
  }));

  // 受控媒体流：撤下/过期后返回 410，而不是 404 或继续输出
  app.get('/api/media/videos/:id/stream', handle((req, res) => {
    const now = new Date().toISOString();
    const v = db.get('SELECT * FROM videos WHERE id=?', [req.params.id]);
    if (!v) return res.status(404).json({ error: 'NOT_FOUND' });
    const live = v.state === 'published' && v.consent_status === 'granted' && (!v.consent_expires_at || v.consent_expires_at > now);
    if (!live) {
      return res.status(410).json({
        error: 'MEDIA_TAKEN_DOWN',
        message: v.state === 'taken_down'
          ? '该视频已被监护人撤下或授权到期，封面、片段与分享入口均已处理'
          : '该视频尚未授权公开',
        taken_down_at: v.takedown_at
      });
    }
    // 分享令牌校验（若带 token）
    if (req.query.token) {
      const link = db.get('SELECT * FROM share_links WHERE token=? AND video_id=? AND active=1', [req.query.token, v.id]);
      if (!link) return res.status(410).json({ error: 'SHARE_LINK_INACTIVE', message: '分享链接已失效' });
    }
    // 真实项目此处输出字节流（鉴权+Range）。演示环境返回受控清单。
    res.json({ media: 'stream-ok', video_id: v.id, source: v.source_path, note: '受访问控制的视频流；撤下后此处返回 410' });
  }));

  app.get('/api/share/:token', handle((req, res) => {
    const link = db.get('SELECT * FROM share_links WHERE token=?', [req.params.token]);
    if (!link || !link.active) return res.status(410).json({ error: 'SHARE_LINK_INACTIVE', message: '分享链接不存在或已停用（撤下授权时统一关闭）' });
    const v = db.get('SELECT * FROM videos WHERE id=?', [link.video_id]);
    const now = new Date().toISOString();
    if (v.state !== 'published' || v.consent_status !== 'granted' || (v.consent_expires_at && v.consent_expires_at <= now)) {
      return res.status(410).json({ error: 'MEDIA_TAKEN_DOWN', message: '授权已失效' });
    }
    res.json({ video: { id: v.id, title: v.title, student_name: v.student_name }, stream_url: `/api/media/videos/${v.id}/stream?token=${link.token}` });
  }));

  // ---------- 管理后台 API ----------
  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get('/health', (req, res) => res.json({ ok: true }));

  // 场地 CRUD
  admin.get('/venues', (req, res) => res.json({ venues: db.all('SELECT * FROM venues ORDER BY id') }));
  admin.post('/venues', (req, res) => {
    const { name, address = '', capacity } = req.body;
    if (!name || !(Number(capacity) > 0)) return res.status(400).json({ error: 'BAD_REQUEST', message: '名称与容量必填' });
    const id = db.insert('INSERT INTO venues(name,address,capacity) VALUES(?,?,?)', [name, address, Number(capacity)]);
    db.persist();
    res.status(201).json({ venue: db.get('SELECT * FROM venues WHERE id=?', [id]) });
  });
  admin.patch('/venues/:id', (req, res) => {
    const v = db.get('SELECT * FROM venues WHERE id=?', [req.params.id]);
    if (!v) return res.status(404).json({ error: 'NOT_FOUND' });
    db.run('UPDATE venues SET name=?, address=?, capacity=?, active=? WHERE id=?',
      [req.body.name ?? v.name, req.body.address ?? v.address, req.body.capacity != null ? Number(req.body.capacity) : v.capacity,
       req.body.active != null ? Number(req.body.active) : v.active, v.id]);
    db.persist();
    res.json({ venue: db.get('SELECT * FROM venues WHERE id=?', [v.id]) });
  });

  // 教练 CRUD
  admin.get('/coaches', (req, res) => res.json({ coaches: db.all('SELECT * FROM coaches ORDER BY id') }));
  admin.post('/coaches', (req, res) => {
    const { name, style = '', bio = '' } = req.body;
    if (!name) return res.status(400).json({ error: 'BAD_REQUEST', message: '教练名必填' });
    const id = db.insert('INSERT INTO coaches(name,style,bio) VALUES(?,?,?)', [name, style, bio]);
    db.persist();
    res.status(201).json({ coach: db.get('SELECT * FROM coaches WHERE id=?', [id]) });
  });
  admin.patch('/coaches/:id', (req, res) => {
    const c = db.get('SELECT * FROM coaches WHERE id=?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'NOT_FOUND' });
    db.run('UPDATE coaches SET name=?, style=?, bio=?, active=? WHERE id=?',
      [req.body.name ?? c.name, req.body.style ?? c.style, req.body.bio ?? c.bio,
       req.body.active != null ? Number(req.body.active) : c.active, c.id]);
    db.persist();
    res.json({ coach: db.get('SELECT * FROM coaches WHERE id=?', [c.id]) });
  });

  // 年龄分组 CRUD
  admin.get('/age-groups', (req, res) => res.json({ age_groups: db.all('SELECT * FROM age_groups ORDER BY age_min') }));
  admin.post('/age-groups', (req, res) => {
    const { name, age_min, age_max } = req.body;
    if (!name || !(Number(age_max) >= Number(age_min))) return res.status(400).json({ error: 'BAD_REQUEST', message: '名称与合法年龄区间必填' });
    const id = db.insert('INSERT INTO age_groups(name,age_min,age_max) VALUES(?,?,?)', [name, Number(age_min), Number(age_max)]);
    db.persist();
    res.status(201).json({ age_group: db.get('SELECT * FROM age_groups WHERE id=?', [id]) });
  });

  // 班级管理
  admin.get('/classes', (req, res) => {
    const rows = db.all('SELECT * FROM classes ORDER BY start_time');
    res.json({ classes: rows.map((c) => S.classView(db, c)) });
  });
  admin.post('/classes', (req, res) => {
    const { title, coach_id, venue_id, age_group_id, start_time, end_time, capacity } = req.body;
    if (!title || !coach_id || !venue_id || !age_group_id || !start_time || !end_time || !(capacity > 0)) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: '班级字段不完整' });
    }
    if (end_time <= start_time) return res.status(400).json({ error: 'BAD_REQUEST', message: '结束时间需晚于开始时间' });
    const venue = db.get('SELECT * FROM venues WHERE id=?', [venue_id]);
    const coach = db.get('SELECT * FROM coaches WHERE id=?', [coach_id]);
    if (!venue || !venue.active) return res.status(400).json({ error: 'VENUE_UNAVAILABLE' });
    if (!coach || !coach.active) return res.status(400).json({ error: 'COACH_UNAVAILABLE' });
    const conflict = checkConflict(db, { coachId: coach_id, venueId: venue_id, startTime: start_time, endTime: end_time });
    if (conflict) return res.status(409).json({ error: 'RESOURCE_CONFLICT', message: `教练/场地与 #${conflict.id} 场冲突` });
    const id = db.insert('INSERT INTO classes(title,coach_id,venue_id,age_group_id,start_time,end_time,capacity) VALUES(?,?,?,?,?,?,?)',
      [title, coach_id, venue_id, age_group_id, start_time, end_time, Number(capacity)]);
    db.persist();
    const c = db.get('SELECT * FROM classes WHERE id=?', [id]);
    res.status(201).json(S.classView(db, c));
  });
  admin.post('/classes/:id/cancel', (req, res) => {
    const id = Number(req.params.id);
    db.transaction(() => {
      db.run("UPDATE classes SET status='cancelled', version=version+1 WHERE id=?", [id]);
      db.run("UPDATE bookings SET status='cancelled', updated_at=? WHERE class_id=? AND status IN ('confirmed','invited','waitlist')",
        [new Date().toISOString(), id]);
    });
    res.json({ ok: true });
  });

  // 排课调整：换场 / 代课 / 改期提案 / 确认 / 撤销
  admin.post('/classes/:id/swap-venue', handle((req) => {
    const apply = req.body.apply !== false;
    return S.swapVenue(db, Number(req.params.id), Number(req.body.venue_id), { apply, note: req.body.note || '' });
  }));
  admin.post('/classes/:id/substitute-coach', handle((req) =>
    S.substituteCoach(db, Number(req.params.id), Number(req.body.coach_id), { note: req.body.note || '' })));
  admin.post('/classes/:id/propose-reschedule', handle((req) =>
    S.proposeReschedule(db, Number(req.params.id), {
      new_start_time: req.body.new_start_time,
      new_end_time: req.body.new_end_time,
      new_venue_id: req.body.new_venue_id ? Number(req.body.new_venue_id) : null,
      note: req.body.note || ''
    })));

  admin.get('/schedule-changes', (req, res) => {
    const rows = db.all('SELECT * FROM schedule_changes ORDER BY id DESC');
    res.json({ changes: rows.map((ch) => ({ ...S.changeView(db, ch), responses: db.all('SELECT * FROM schedule_change_responses WHERE change_id=?', [ch.id]) })) });
  });
  admin.post('/schedule-changes/:id/apply', handle((req) => S.applyReschedule(db, Number(req.params.id))));
  admin.post('/schedule-changes/:id/cancel', handle((req) => S.cancelReschedule(db, Number(req.params.id))));

  // 预约总览 / 人工邀请（对比自动递补）
  admin.get('/bookings', (req, res) => {
    const rows = db.all(
      `SELECT b.*, c.title class_title, s.name student_name, s.phone student_phone, s.age student_age
       FROM bookings b JOIN classes c ON c.id=b.class_id JOIN students s ON s.id=b.student_id
       ORDER BY b.id DESC`);
    res.json({ bookings: rows });
  });
  admin.post('/bookings/:id/invite', handle((req) => S.adminInvite(db, Number(req.params.id))));
  admin.post('/bookings/:id/cancel', handle((req) => S.cancelBooking(db, Number(req.params.id))));

  // 设置：邀请有效期、多场占场上限、自动递补开关
  admin.get('/settings', (req, res) => res.json({
    invitation_ttl_hours: Number(db.setting('invitation_ttl_hours')),
    max_active_spots_per_student: Number(db.setting('max_active_spots_per_student')),
    auto_promote: db.setting('auto_promote') === '1'
  }));
  admin.put('/settings', (req, res) => {
    for (const k of ['invitation_ttl_hours', 'max_active_spots_per_student', 'auto_promote']) {
      if (req.body[k] != null) db.setSetting(k, typeof req.body[k] === 'boolean' ? (req.body[k] ? '1' : '0') : String(req.body[k]));
    }
    res.json({ ok: true });
  });

  // 媒体：创建视频 / 授权 / 转码 / 撤下 / 分享
  admin.get('/videos', (req, res) => {
    const rows = db.all('SELECT * FROM videos ORDER BY id DESC');
    res.json({
      videos: rows.map((v) => ({
        ...v,
        clips: db.all('SELECT * FROM video_clips WHERE video_id=?', [v.id]),
        jobs: db.all('SELECT id,state,kind,finished_at FROM transcode_jobs WHERE video_id=?', [v.id]),
        share_links: db.all('SELECT id,token,active FROM share_links WHERE video_id=?', [v.id]),
        takedown_steps: db.all('SELECT * FROM takedown_steps WHERE video_id=? ORDER BY id', [v.id])
      }))
    });
  });
  admin.post('/videos', handle((req) => S.createVideo(db, req.body)));
  admin.post('/videos/:id/consent', handle((req) => S.grantConsent(db, Number(req.params.id), {
    expires_at: req.body.expires_at || null, guardian_note: req.body.guardian_note || ''
  })));
  admin.post('/videos/:id/transcode', handle((req) => S.enqueueTranscode(db, Number(req.params.id))));
  admin.post('/transcodes/:id/complete', handle((req) => S.completeTranscode(db, Number(req.params.id), req.body.output_path || 'media/out/fake.mp4')));
  admin.post('/videos/:id/takedown', handle((req) => S.takedownVideo(db, Number(req.params.id), req.body.reason || 'revoked')));
  admin.post('/videos/:id/share', handle((req) => S.createShareLink(db, Number(req.params.id))));
  admin.post('/videos/:id/clip', (req, res) => {
    const v = db.get('SELECT * FROM videos WHERE id=?', [req.params.id]);
    if (!v) return res.status(404).json({ error: 'NOT_FOUND' });
    const id = db.insert('INSERT INTO video_clips(video_id,title,clip_path) VALUES(?,?,?)',
      [v.id, req.body.title || '片段', req.body.clip_path || `media/clips/${v.id}-${Date.now()}.mp4`]);
    db.persist();
    res.status(201).json({ clip: db.get('SELECT * FROM video_clips WHERE id=?', [id]) });
  });
  admin.post('/videos/:id/cover', (req, res) => {
    const v = db.get('SELECT * FROM videos WHERE id=?', [req.params.id]);
    if (!v) return res.status(404).json({ error: 'NOT_FOUND' });
    db.run('UPDATE videos SET cover_path=? WHERE id=?', [req.body.cover_path || `media/covers/${v.id}.jpg`, v.id]);
    db.persist();
    res.json({ video: db.get('SELECT * FROM videos WHERE id=?', [v.id]) });
  });
  admin.post('/maintenance/expire-consents', handle((req) => ({ results: S.sweepConsentExpiry(db) })));

  app.use('/api/admin', admin);

  // ---------- 管理页 ----------
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin.html')));

  // 错误兜底
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  });

  return app;
}

function checkConflict(db, { coachId, venueId, startTime, endTime, excludeClassId = 0 }) {
  const rows = db.all(
    `SELECT * FROM classes WHERE status='scheduled' AND id != ? AND start_time < ? AND end_time > ?`,
    [excludeClassId, endTime, startTime]
  );
  return rows.find((r) => r.coach_id === coachId || r.venue_id === venueId) || null;
}

module.exports = { createApp };
