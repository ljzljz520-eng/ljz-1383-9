'use strict';
// 持久化数据库层：sql.js（WASM SQLite），每次写事务结束后落盘到 data/app.db
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 场地
CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 教练
CREATE TABLE IF NOT EXISTS coaches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '',          -- 擅长舞种
  bio TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 年龄分组
CREATE TABLE IF NOT EXISTS age_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,               -- 如：少儿启蒙 6-9
  age_min INTEGER NOT NULL CHECK (age_min >= 0),
  age_max INTEGER NOT NULL
);

-- 试听班级（一场排课）
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  coach_id INTEGER NOT NULL REFERENCES coaches(id),
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  age_group_id INTEGER NOT NULL REFERENCES age_groups(id),
  start_time TEXT NOT NULL,                -- ISO UTC
  end_time TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  version INTEGER NOT NULL DEFAULT 1,      -- 资源版本：换场/换教练即 +1
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_classes_time ON classes(start_time, end_time);

-- 学员
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  age INTEGER NOT NULL
);

-- 预约（confirmed 已确认 / invited 候补邀请占位待接受 / waitlist 排队 / declined 拒绝邀请 / cancelled 取消 / expired 邀请过期）
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id),
  status TEXT NOT NULL,
  waitlist_rank INTEGER,                  -- waitlist 顺位
  invited_at TEXT,
  invite_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 同一学员在同一场只能有一个“活跃占位”（confirmed/invited/waitlist），取消/过期后可再次报名
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_active
  ON bookings(class_id, student_id)
  WHERE status IN ('confirmed','invited','waitlist');

-- 改期/换场/代课提案：applied 立即生效；pending 待确认；cancelled 撤销
CREATE TABLE IF NOT EXISTS schedule_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                      -- reschedule | venue_swap | coach_substitute
  old_venue_id INTEGER, new_venue_id INTEGER,
  old_coach_id INTEGER, new_coach_id INTEGER,
  old_start_time TEXT, new_start_time TEXT,
  old_end_time TEXT, new_end_time TEXT,
  note TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending',   -- pending | applied | cancelled
  created_by TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 学员对“待确认改期”的回应：accepted / rejected；拒绝=请求退出该场
CREATE TABLE IF NOT EXISTS schedule_change_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id INTEGER NOT NULL REFERENCES schedule_changes(id) ON DELETE CASCADE,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (change_id, booking_id)
);

-- 少儿成果视频（授权独立于列表展示）
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  student_name TEXT NOT NULL,
  age_group_id INTEGER REFERENCES age_groups(id),
  source_path TEXT NOT NULL,              -- 仅服务端可访问的原始文件位置标识
  cover_path TEXT,                        -- 封面（撤下时移动到隔离区并断开）
  consent_status TEXT NOT NULL DEFAULT 'pending', -- granted | expired | revoked | pending
  consent_granted_at TEXT,
  consent_expires_at TEXT,                -- 授权可以到期
  guardian_note TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'private',  -- private | processing | published | taken_down
  takedown_reason TEXT,
  takedown_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 视频片段
CREATE TABLE IF NOT EXISTS video_clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  clip_path TEXT,
  state TEXT NOT NULL DEFAULT 'ready'     -- ready | quarantined | removed
);

-- 转码任务：迟到完成时必须重新核对授权
CREATE TABLE IF NOT EXISTS transcode_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'transcode',
  state TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | discarded
  output_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

-- 分享入口（分享链接）
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 撤下进度清单：封面 / 片段 / 分享入口 / 原始与转码产物
CREATE TABLE IF NOT EXISTS takedown_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done
  detail TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 全局设置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 幂等键：防重复点击
CREATE TABLE IF NOT EXISTS idempotency (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  response_code INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const DEFAULTS = {
  invitation_ttl_hours: '24',
  max_active_spots_per_student: '2',
  auto_promote: '1'
};

function nowIso() {
  return new Date().toISOString();
}
function addHoursIso(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * 3600e3).toISOString();
}
function toIso(sqliteMaybe) {
  if (!sqliteMaybe) return sqliteMaybe;
  // datetime('now') 形如 "2026-10-06 12:00:00"，转 ISO（按 UTC）
  return typeof sqliteMaybe === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(sqliteMaybe)
    ? sqliteMaybe.replace(' ', 'T') + 'Z'
    : sqliteMaybe;
}

async function openDatabase(file) {
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', f)
  });
  let db;
  if (file && fs.existsSync(file)) {
    db = new SQL.Database(fs.readFileSync(file));
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  for (const [k, v] of Object.entries(DEFAULTS)) {
    db.run('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)', [k, v]);
  }

  let inTx = false;
  const persist = () => {
    if (file) {
      const data = db.export();
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, Buffer.from(data));
      fs.renameSync(tmp, file);
    }
  };

  function wrapStmt(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    return stmt;
  }
  // 查询：返回对象数组，并把默认时间戳转为 ISO
  function all(sql, params = []) {
    const stmt = wrapStmt(sql, params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  function get(sql, params = []) {
    return all(sql, params)[0] || null;
  }
  function run(sql, params = []) {
    db.run(sql, params);
  }
  // 插入并立即取回自增主键（避免在 persist/export 后 last_insert_rowid 连接状态失效）
  function insert(sql, params = []) {
    db.run(sql, params);
    const row = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
    return Number(row);
  }
  // 同步事务：抛错回滚，成功则落盘（原子持久化语义边界）
  function transaction(fn) {
    if (inTx) return fn(); // 嵌套复用
    db.run('BEGIN IMMEDIATE');
    inTx = true;
    try {
      const result = fn();
      db.run('COMMIT');
      inTx = false;
      persist();
      return result;
    } catch (err) {
      if (inTx) { try { db.run('ROLLBACK'); } catch (_) {} }
      inTx = false;
      throw err;
    }
  }

  return {
    raw: db,
    all, get, run, insert, transaction, persist,
    nowIso, addHoursIso, toIso,
    setting(key) {
      const row = get('SELECT value FROM settings WHERE key=?', [key]);
      return row ? row.value : DEFAULTS[key];
    },
    setSetting(key, value) {
      run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);
      persist();
    },
    close() { db.close(); }
  };
}

module.exports = { openDatabase, nowIso, addHoursIso, toIso };
