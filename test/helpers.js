'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { openDatabase } = require('../server/src/db');
const { createApp } = require('../server/src/app');

async function startHarness() {
  const file = path.join(os.tmpdir(), `ng-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = await openDatabase(file);
  const app = createApp(db, { adminToken: 'test-token' });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  function seedResource() {
    const ensureVenue = (name, address, capacity) => {
      let v = db.get('SELECT * FROM venues WHERE name=?', [name]);
      if (!v) { const id = db.insert('INSERT INTO venues(name,address,capacity) VALUES(?,?,?)', [name, address, capacity]); v = db.get('SELECT * FROM venues WHERE id=?', [id]); }
      return v;
    };
    const ensureCoach = (name, style) => {
      let c = db.get('SELECT * FROM coaches WHERE name=?', [name]);
      if (!c) { const id = db.insert('INSERT INTO coaches(name,style,bio) VALUES(?,?,?)', [name, style, '']); c = db.get('SELECT * FROM coaches WHERE id=?', [id]); }
      return c;
    };
    const ensureGroup = (name, age_min, age_max) => {
      let g = db.get('SELECT * FROM age_groups WHERE name=?', [name]);
      if (!g) { const id = db.insert('INSERT INTO age_groups(name,age_min,age_max) VALUES(?,?,?)', [name, age_min, age_max]); g = db.get('SELECT * FROM age_groups WHERE id=?', [id]); }
      return g;
    };
    const vBig = ensureVenue('大仓库', 'A路1号', 12);
    const vMid = ensureVenue('镜厅', 'B路2号', 8);
    const vSmall = ensureVenue('小屋', 'C路3号', 2);
    const c1 = ensureCoach('阿凯', 'Hip-Hop');
    const c2 = ensureCoach('反弹', 'Breaking');
    const g1 = ensureGroup('少儿', 6, 9);
    const g2 = ensureGroup('少年', 10, 13);
    db.persist();
    return { vBig, vMid, vSmall, c1, c2, g1, g2 };
  }

  function makeClass({ coach, venue, group, capacity = 10, start = '2026-12-01T11:00:00.000Z', end = '2026-12-01T12:30:00.000Z', title = '试听' }) {
    const id = db.insert(`INSERT INTO classes(title,coach_id,venue_id,age_group_id,start_time,end_time,capacity) VALUES(?,?,?,?,?,?,?)`,
      [title, coach, venue, group, start, end, capacity]);
    db.persist();
    return db.get('SELECT * FROM classes WHERE id=?', [id]);
  }

  async function call(method, url, body, { admin = false, idem } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(admin ? { 'X-Admin-Token': 'test-token' } : {}),
        ...(idem ? { 'Idempotency-Key': idem } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, replay: res.headers.get('idempotent-replay') === 'true' };
  }

  const student = (name, age, phone) => ({ name, age, phone });
  const book = (classId, who, extra = {}, opts = {}) =>
    call('POST', '/api/bookings', { class_id: classId, student: who, ...extra }, opts);

  async function stop() {
    await new Promise((r) => server.close(r));
    db.close();
    try { fs.unlinkSync(file); } catch (_) {}
  }

  return { db, base, call, book, seedResource, makeClass, student, stop, adminToken: 'test-token' };
}

module.exports = { startHarness };
