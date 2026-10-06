'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server/src/services');
const { startHarness } = require('./helpers');

// 验收场景 2：临时换场 —— 原子核对新场地冲突与容量；版本+1，旧卡片确认被拒
test('临时换场：冲突拒绝、版本递增、旧 expected_version 被拦截；小场地收缩实际容量', async () => {
  const h = await startHarness();
  try {
    const { c1, c2, vBig, vMid, vSmall, g1 } = h.seedResource();
    // 场 A：12-01 大仓库 阿凯；场 B：同一时段 镜厅 反弹（占用镜厅）
    const clsA = h.makeClass({ coach: c1.id, venue: vBig.id, group: g1.id, capacity: 5 });
    const clsB = h.makeClass({ coach: c2.id, venue: vMid.id, group: g1.id, capacity: 5 });

    // A 临时换到镜厅：镜厅同时段已被 B 占用 -> 409 资源冲突
    const conflict = await h.call('POST', `/api/admin/classes/${clsA.id}/swap-venue`,
      { venue_id: vMid.id, apply: true }, { admin: true });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error, 'RESOURCE_CONFLICT');

    // 换到小屋（容量 2，空闲）成功；版本 1 -> 2；实际容量从 5 收缩为 2
    const ok = await h.call('POST', `/api/admin/classes/${clsA.id}/swap-venue`,
      { venue_id: vSmall.id, apply: true }, { admin: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.class.version, 2);
    assert.equal(ok.json.class.actual_capacity, 2);
    assert.ok(ok.json.class.capacity_reason.includes('实际只能容纳'));

    // 旧卡片（expected_version=1）确认报名 -> RESOURCE_CHANGED，并返回最新视图
    const stale = await h.book(clsA.id, h.student('甲', 7, '13800000001'), { expected_version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, 'RESOURCE_CHANGED');
    assert.equal(stale.json.current.version, 2);

    // 用新卡片版本可以报名
    const fresh = await h.book(clsA.id, h.student('甲', 7, '13800000001'), { expected_version: 2 });
    assert.equal(fresh.status, 200);
  } finally { await h.stop(); }
});

// 验收场景 3：教练代课 —— 原子核对新教练时间冲突
test('教练代课：新教练时间冲突时拒绝；无冲突则立即生效并留痕', async () => {
  const h = await startHarness();
  try {
    const { c1, c2, vBig, vMid, g1 } = h.seedResource();
    const clsA = h.makeClass({ coach: c1.id, venue: vBig.id, group: g1.id });
    // 反弹同时段在镜厅有课
    h.makeClass({ coach: c2.id, venue: vMid.id, group: g1.id });

    const bad = await h.call('POST', `/api/admin/classes/${clsA.id}/substitute-coach`,
      { coach_id: c2.id }, { admin: true });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.error, 'RESOURCE_CONFLICT');

    // 先停用反弹模拟不可用
    await h.call('PATCH', `/api/admin/coaches/${c2.id}`, { active: 0 }, { admin: true });
    const bad2 = await h.call('POST', `/api/admin/classes/${clsA.id}/substitute-coach`,
      { coach_id: c2.id }, { admin: true });
    assert.equal(bad2.status, 404);

    await h.call('PATCH', `/api/admin/coaches/${c2.id}`, { active: 1 }, { admin: true });
    // 把冲突课换时间后再代课：成功
    const cls = h.db.get('SELECT * FROM classes WHERE coach_id=?', [c2.id]);
    h.db.run("UPDATE classes SET start_time=?, end_time=? WHERE id=?", ['2026-12-02T11:00:00.000Z', '2026-12-02T12:30:00.000Z', cls.id]);
    h.db.persist();
    const ok = await h.call('POST', `/api/admin/classes/${clsA.id}/substitute-coach`,
      { coach_id: c2.id, note: '阿凯出差' }, { admin: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.class.coach.id, c2.id);
    assert.equal(ok.json.class.version, 2);

    const changes = (await h.call('GET', '/api/admin/schedule-changes', undefined, { admin: true })).json.changes;
    assert.ok(changes.some((c) => c.kind === 'coach_substitute' && c.state === 'applied'));
  } finally { await h.stop(); }
});

// 验收场景 6(改期部分)：待确认改期提案 -> 学员退出 -> 确认时重新核对冲突
test('待确认改期：学员拒绝即退出并递补；确认时若资源已被占用则拒绝生效', async () => {
  const h = await startHarness();
  try {
    const { c1, c2, vSmall, vMid, g1 } = h.seedResource();
    const cls = h.makeClass({ coach: c1.id, venue: vSmall.id, group: g1.id, capacity: 2 });
    await h.book(cls.id, h.student('甲', 7, '13800000001'));
    await h.book(cls.id, h.student('乙', 7, '13800000002'));
    await h.book(cls.id, h.student('丙', 7, '13800000003'), { join_waitlist: true });

    // 提案改到 12-05 镜厅
    const prop = await h.call('POST', `/api/admin/classes/${cls.id}/propose-reschedule`, {
      new_start_time: '2026-12-05T11:00:00.000Z',
      new_end_time: '2026-12-05T12:30:00.000Z',
      new_venue_id: vMid.id
    }, { admin: true });
    assert.equal(prop.status, 200);
    const changeId = prop.json.change.id;

    // 学员侧卡片出现 pending_change
    const card = (await h.call('GET', '/api/classes')).json.classes.find((c) => c.id === cls.id);
    assert.equal(card.pending_change.id, changeId);

    // 甲拒绝改期 -> 甲退出（cancelled），丙自动递补
    const jia = h.db.get(`SELECT b.id FROM bookings b JOIN students s ON s.id=b.student_id WHERE s.name='甲' AND b.class_id=?`, [cls.id]);
    const resp = await h.call('POST', `/api/schedule-changes/${changeId}/respond`,
      { booking_id: jia.id, response: 'rejected' });
    assert.equal(resp.status, 200);
    const bing = h.db.get(`SELECT b.status FROM bookings b JOIN students s ON s.id=b.student_id WHERE s.name='丙' AND b.class_id=?`, [cls.id]);
    assert.equal(bing.status, 'invited');

    // 在确认前，让目标时段的镜厅被别的课占用 -> apply 时 409
    h.makeClass({ coach: c2.id, venue: vMid.id, group: g1.id,
      start: '2026-12-05T11:00:00.000Z', end: '2026-12-05T12:30:00.000Z', title: '撞车课' });
    const blocked = await h.call('POST', `/api/admin/schedule-changes/${changeId}/apply`, {}, { admin: true });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error, 'RESOURCE_CONFLICT');

    // 移除撞车课后确认生效
    const blocker = h.db.get("SELECT id FROM classes WHERE title='撞车课'");
    h.db.run("UPDATE classes SET status='cancelled' WHERE id=?", [blocker.id]);
    h.db.persist();
    const applied = await h.call('POST', `/api/admin/schedule-changes/${changeId}/apply`, {}, { admin: true });
    assert.equal(applied.status, 200);
    assert.equal(applied.json.class.start_time, '2026-12-05T11:00:00.000Z');
    assert.equal(applied.json.class.venue.id, vMid.id);
    assert.equal(applied.json.class.version, 2);
  } finally { await h.stop(); }
});

// 建课时教练/场地冲突直接拒绝
test('建课排期冲突被拒绝', async () => {
  const h = await startHarness();
  try {
    const { c1, vBig, vMid, g1 } = h.seedResource();
    h.makeClass({ coach: c1.id, venue: vBig.id, group: g1.id });
    const r = await h.call('POST', '/api/admin/classes', {
      title: '撞车', coach_id: c1.id, venue_id: vMid.id, age_group_id: g1.id,
      start_time: '2026-12-01T12:00:00.000Z', end_time: '2026-12-01T13:00:00.000Z', capacity: 5
    }, { admin: true });
    assert.equal(r.status, 409);
  } finally { await h.stop(); }
});
