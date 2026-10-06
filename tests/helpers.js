
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.resolve('data', `test-${process.pid}-${Date.now()}.db`);
process.env.PORT = '0';
process.env.SWEEP_INTERVAL_MS = '99999999'; // 测试中手动清扫，避免定时器干扰
process.env.MANUAL_INVITE_TTL_MS = String(1000 * 60 * 60 * 24);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let slotCounter = 0;
const mod = await import('../src/server.js');
export const { app, server, db } = mod;

await new Promise((r) => server.once('listening', r));
const base = () => `http://127.0.0.1:${server.address().port}`;
export const ADMIN = 'dev-admin-token';

export async function api(method, url, body, { admin = false, raw = null, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (admin) opts.headers['x-admin-token'] = ADMIN;
  if (raw) { opts.body = raw; opts.headers['Content-Type'] = headers['Content-Type'] || 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(base() + url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { rawText: text }; }
  return { status: res.status, data, headers: res.headers };
}

export async function resetDb() {
  // 保留场地/教练/年龄分组等 seed 基础资源，只清空业务数据（避免自增外键错位）
  const tables = ['bookings', 'sessions', 'students', 'videos', 'shares', 'transcode_jobs', 'video_assets', 'media_assets', 'audit_logs'];
  db.pragma('foreign_keys = OFF');
  for (const t of tables) db.prepare('DELETE FROM ' + t).run();
  db.pragma('foreign_keys = ON');
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export async function mkStudent(name) {
  const r = await api('POST', '/api/students', { name, contact: name + '@test', age: 9 });
  return r.data.id;
}

export async function mkSession({ capacity = 2, mode = 'auto', startAt, coachId, venueId, ageGroupId } = {}) {
  const coaches = (await api('GET', '/api/admin/coaches', undefined, { admin: true })).data;
  const venues = (await api('GET', '/api/admin/venues', undefined, { admin: true })).data;
  const ages = (await api('GET', '/api/admin/age-groups', undefined, { admin: true })).data;
  slotCounter = (slotCounter + 1) % 200;
  const start = startAt || Date.now() + 3 * DAY + slotCounter * 3 * HOUR;
  const r = await api('POST', '/api/admin/sessions', {
    title: '测试场次 ' + Math.random().toString(36).slice(2, 7),
    style: 'HipHop',
    coachId: coachId ?? coaches[0].id,
    venueId: venueId ?? venues[0].id,
    ageGroupId: ageGroupId ?? ages[0]?.id ?? null,
    startAt: start, endAt: start + HOUR,
    capacity, waitlistMode: mode,
  }, { admin: true });
  if (r.status !== 201) throw new Error('mkSession failed: ' + JSON.stringify(r.data));
  return r.data.id;
}

export async function book(sessionId, studentId, idemKey) {
  return api('POST', '/api/bookings', { sessionId, studentId, idemKey });
}

export async function getAdminSession(id) {
  return (await api('GET', '/api/admin/sessions/' + id, undefined, { admin: true })).data;
}

export async function close() {
  server.close();
  await new Promise((r) => server.on('close', r));
  const file = process.env.DB_FILE;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(file + suffix); } catch {}
  }
}
