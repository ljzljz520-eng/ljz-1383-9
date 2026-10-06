PRAGMA foreign_keys = ON;

-- 场地
CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL DEFAULT 12,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- 教练
CREATE TABLE IF NOT EXISTS coaches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '',          -- 擅长风格：Breaking/Popping/HipHop...
  bio TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- 年龄分组（少儿/青少年/成人等）
CREATE TABLE IF NOT EXISTS age_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  min_age INTEGER NOT NULL DEFAULT 0,
  max_age INTEGER NOT NULL DEFAULT 99,
  created_at INTEGER NOT NULL
);

-- 试听场次（一节课实例：某时某地某教练，班级人数上限）
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '',
  coach_id INTEGER REFERENCES coaches(id),
  venue_id INTEGER REFERENCES venues(id),
  age_group_id INTEGER REFERENCES age_groups(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  capacity INTEGER NOT NULL,               -- 班级人数上限（以确认瞬间原子核对为准）
  waitlist_mode TEXT NOT NULL DEFAULT 'auto', -- auto=自动递补 | manual=人工邀请
  schedule_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',     -- open | cancelled
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(start_at, end_at);

-- 学员（少儿由监护人报名）
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,                   -- 监护人手机/微信
  age INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- 预约/占位
-- 状态机：
--   booked          已确认占位（占名额）
--   waitlisted      候补排队（不占名额）
--   invited         被邀请占位（占名额，等待学员接受，有有效期）
--   pending_change  场次改期/换场/代课待学员确认（保留名额）
--   confirmed       接受改期后回到已确认（保留 schedule_version）
--   cancelled       学员/管理员取消（终态，不占名额）
--   declined        拒绝邀请（终态，不占名额）
--   expired         邀请超时（终态，不占名额；手动模式）/ 自动递补错过
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  status TEXT NOT NULL,
  position INTEGER,                       -- waitlisted/invited 时的候补序号
  invited_at INTEGER,
  invite_expires_at INTEGER,
  invite_mode TEXT,                        -- auto | manual
  schedule_version INTEGER,               -- 预约所基于的场次版本；与 sessions.schedule_version 不一致 => 待确认改期
  old_session_snapshot TEXT,              -- pending_change 时保存原场次信息（JSON）
  idem_key TEXT,                           -- 幂等键，防重复点击
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- 一个学员在一场次只允许一个“活动占位”（booked/invited/pending_change/confirmed/waitlisted）
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_active
  ON bookings(session_id, student_id)
  WHERE status IN ('booked','invited','pending_change','confirmed','waitlisted');
CREATE INDEX IF NOT EXISTS idx_bookings_session ON bookings(session_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_student ON bookings(student_id);

-- 少儿成果视频（需要独立授权，可到期，可撤销）
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  student_id INTEGER REFERENCES students(id),
  source_asset_id INTEGER REFERENCES media_assets(id),
  -- 授权状态：none 未授权 | active 有效 | expired 已到期 | revoked 已撤销（终态）
  consent_status TEXT NOT NULL DEFAULT 'none',
  consent_granted_at INTEGER,
  consent_expires_at INTEGER,              -- NULL = 长期有效（直到撤销）
  consent_epoch INTEGER NOT NULL DEFAULT 0,-- 授权轮次：重新授权 +1，旧转码任务据此作废
  revoked_at INTEGER,
  revoke_reason TEXT NOT NULL DEFAULT '',
  -- 撤下进度阶段：cover（封面）/ clips（片段）/ shares（分享入口）/ files（后台文件）
  removal_cover_at INTEGER,
  removal_clips_at INTEGER,
  removal_shares_at INTEGER,
  removal_files_at INTEGER,
  published INTEGER NOT NULL DEFAULT 0,    -- 是否对成果墙公开
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_pub ON videos(published, consent_status);

-- 媒体资产（封面、正片、片段、转码输出）
CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                      -- source | cover | clip | output
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  filename TEXT NOT NULL,                  -- 存储相对路径
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready',    -- ready | removed
  created_at INTEGER NOT NULL
);

-- 转码任务（可能在撤销后才完成——迟到任务必须作废）
CREATE TABLE IF NOT EXISTS transcode_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  source_asset_id INTEGER NOT NULL REFERENCES media_assets(id),
  output_asset_id INTEGER REFERENCES media_assets(id),
  consent_epoch INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | processing | done | rejected
  reject_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON transcode_jobs(status);

-- 分享入口（可单独撤销，撤销视频时全部失效）
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',   -- active | revoked
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT NOT NULL DEFAULT ''
);

-- 审计日志（授权、撤销、分享等）
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- 视频与资产的关联（封面/片段）
CREATE TABLE IF NOT EXISTS video_assets (
  video_id INTEGER NOT NULL REFERENCES videos(id),
  asset_id INTEGER NOT NULL REFERENCES media_assets(id),
  role TEXT NOT NULL,                      -- cover | clip
  PRIMARY KEY (video_id, asset_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_video_cover ON video_assets(video_id) WHERE role='cover';
