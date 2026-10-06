'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server/src/services');
const { startHarness } = require('./helpers');

// 验收场景 1：两人争最后名额 —— 同一事务边界原子核对，恰好一人确认
test('两人争最后名额：恰好一人确认，另一人转候补', async () => {
  const h = await startHarness();
  try {
    const { c1, vSmall, g1 } = h.seedResource();
    // 小屋容量 2；班级设定 5 -> 实际容量 = min(5,2)=2
    const cls = h.makeClass({ coach: c1.id, venue: vSmall.id, group: g1.id, capacity: 5 });

    const a = await h.book(cls.id, h.student('甲', 7, '13800000001'));
    const b = await h.book(cls.id, h.student('乙', 7, '13800000002'));
    assert.equal(a.status, 200); assert.equal(a.json.status, 'confirmed');
    assert.equal(b.status, 200); assert.equal(b.json.status, 'confirmed');

    // 卡片提示此时为 0；丙、丁同时打最后一个……名额已满，第三个人只看到提示
    const list = await h.call('GET', '/api/classes');
    const card = list.json.classes.find((c) => c.id === cls.id);
    assert.equal(card.remaining_hint, 0);
    assert.equal(card.actual_capacity, 2);

    // 两个请求在同一 Node 事件循环里“几乎同时”发出；写事务串行化，只能一个先进
    const [c, d] = await Promise.all([
      h.book(cls.id, h.student('丙', 7, '13800000003'), { join_waitlist: true }),
      h.book(cls.id, h.student('丁', 7, '13800000004'), { join_waitlist: true })
    ]);
    const statuses = [c.json.status, d.json.status].sort();
    // 无空位 -> 两人都候补（演示业务规则：满员即候补）
    assert.deepEqual(statuses, ['waitlist', 'waitlist']);

    // 真正的“争最后名额”：新场实际容量 1，戊、己并发，两人都勾选“满员则候补”
    const cls2 = h.makeClass({
      coach: c1.id, venue: vSmall.id, group: g1.id, capacity: 1,
      start: '2026-12-02T11:00:00.000Z', end: '2026-12-02T12:30:00.000Z', title: '一对一体验'
    });
    const [x, y] = await Promise.all([
      h.book(cls2.id, h.student('戊', 7, '13800000005'), { join_waitlist: true }),
      h.book(cls2.id, h.student('己', 7, '13800000006'), { join_waitlist: true })
    ]);
    const oneConfirmed = [x.json.status, y.json.status].filter((s) => s === 'confirmed').length;
    const oneWaits = [x.json.status, y.json.status].filter((s) => s === 'waitlist').length;
    assert.equal(oneConfirmed, 1, '恰好一人确认最后名额');
    assert.equal(oneWaits, 1, '另一人自动进入候补');
    const loser = x.json.status === 'waitlist' ? x : y;
    assert.equal(loser.json.waitlist_rank, 1);

    // 未勾选候补的后来者：收到 409 CLASS_FULL，绝不超卖
    const noWait = await h.book(cls2.id, h.student('庚', 7, '13800000007'));
    assert.equal(noWait.status, 409);
    assert.equal(noWait.json.error, 'CLASS_FULL');
  } finally { await h.stop(); }
});

// 验收场景 4：自动递补 vs 人工邀请；邀请有效期与取消竞争
test('取消释放 -> 自动递补；关闭自动后人工邀请；邀请接受时再核对资源', async () => {
  const h = await startHarness();
  try {
    const { c1, vSmall, g1 } = h.seedResource();
    const cls = h.makeClass({ coach: c1.id, venue: vSmall.id, group: g1.id, capacity: 2 }); // 实际 2
    await h.book(cls.id, h.student('甲', 7, '13800000001'));
    await h.book(cls.id, h.student('乙', 7, '13800000002'));
    const w1 = await h.book(cls.id, h.student('丙', 7, '13800000003'), { join_waitlist: true });
    const w2 = await h.book(cls.id, h.student('丁', 7, '13800000004'), { join_waitlist: true });
    assert.equal(w1.json.status, 'waitlist');

    // 甲取消 -> 丙自动成为 invited
    const bookingsBefore = (await h.call('GET', `/api/classes/${cls.id}`)).json.bookings;
    const jia = bookingsBefore.find((b) => b.name === '甲');
    const canceled = await h.call('POST', `/api/bookings/${jia.id}/cancel`);
    assert.equal(canceled.status, 200);
    assert.deepEqual(canceled.json.promoted.map((p) => p.booking_id).length >= 1, true);

    const after = (await h.call('GET', `/api/classes/${cls.id}`)).json;
    const bing = after.bookings.find((b) => b.name === '丙');
    assert.equal(bing.status, 'invited');
    assert.ok(bing.invite_expires_at);

    // 丁仍 waitlist；此时关闭自动递补，乙取消 -> 不自动邀请
    await h.call('PUT', '/api/admin/settings', { auto_promote: false }, { admin: true });
    const yi = (await h.call('GET', `/api/classes/${cls.id}`)).json.bookings.find((b) => b.name === '乙');
    await h.call('POST', `/api/bookings/${yi.id}/cancel`);
    const ding = (await h.call('GET', `/api/classes/${cls.id}`)).json.bookings.find((b) => b.name === '丁');
    assert.equal(ding.status, 'waitlist', '自动递补关闭后保持候补');

    // 后台人工邀请丁
    const invited = await h.call('POST', `/api/admin/bookings/${ding.id}/invite`, {}, { admin: true });
    assert.equal(invited.status, 200);
    assert.equal(invited.json.mode, 'manual');
    assert.equal(invited.json.ttl_hours, 24);

    // 丁接受 -> confirmed（接受瞬间事务重核容量与资源）
    const acc = await h.call('POST', `/api/invitations/${ding.id}/accept`);
    assert.equal(acc.json.status, 'confirmed');
    // 重复点击接受：幂等，不产生副作用
    const acc2 = await h.call('POST', `/api/invitations/${ding.id}/accept`);
    assert.equal(acc2.json.reused, true);
  } finally { await h.stop(); }
});

// 验收场景 5：候补邀请过期 -> 自动顺延；过期接受返回 410
test('邀请过期：接受返回 410 且队首自动递补（过期处理已落库不回滚）', async () => {
  const h = await startHarness();
  try {
    const { c1, vSmall, g1 } = h.seedResource();
    const cls = h.makeClass({ coach: c1.id, venue: vSmall.id, group: g1.id, capacity: 1 });
    await h.book(cls.id, h.student('甲', 7, '13800000001'));
    await h.book(cls.id, h.student('乙', 7, '13800000002'), { join_waitlist: true });
    await h.book(cls.id, h.student('丙', 7, '13800000003'), { join_waitlist: true });

    const now = '2026-12-01T13:00:00.000Z';
    // 服务层：甲取消，乙被自动邀请（用固定 now）
    let rows = h.db.get(`SELECT b.id FROM bookings b JOIN students s ON s.id=b.student_id WHERE s.name='甲' AND b.class_id=?`, [cls.id]);
    S.cancelBooking(h.db, rows.id, { now });
    let yi = h.db.get(`SELECT b.id FROM bookings b JOIN students s ON s.id=b.student_id WHERE s.name='乙' AND b.class_id=?`, [cls.id]);
    let bYi = h.db.get('SELECT * FROM bookings WHERE id=?', [yi.id]);
    assert.equal(bYi.status, 'invited');

    // 时间推进到过期之后，乙来接受：410，且丙已自动递补
    const later = '2026-12-03T00:00:00.000Z';
    assert.throws(
      () => S.respondInvitation(h.db, yi.id, 'accept', { now: later }),
      (e) => e.status === 410 && e.code === 'INVITE_EXPIRED'
    );
    bYi = h.db.get('SELECT * FROM bookings WHERE id=?', [yi.id]);
    assert.equal(bYi.status, 'expired');
    const bing = h.db.get(`SELECT b.* FROM bookings b JOIN students s ON s.id=b.student_id WHERE s.name='丙' AND b.class_id=?`, [cls.id]);
    assert.equal(bing.status, 'invited', '过期后名额顺延给丙');
  } finally { await h.stop(); }
});

// 同一学员多场占场上限（默认 2，含未接受邀请）
test('同一学员多场占位上限：第 3 场仅能候补，达到上限时不能再被邀请', async () => {
  const h = await startHarness();
  try {
    const { c1, vBig, vMid, g1 } = h.seedResource();
    const k1 = h.makeClass({ coach: c1.id, venue: vBig.id, group: g1.id, capacity: 10,
      start: '2026-12-10T11:00:00.000Z', end: '2026-12-10T12:00:00.000Z' });
    const k2 = h.makeClass({ coach: c1.id, venue: vMid.id, group: g1.id, capacity: 10,
      start: '2026-12-11T11:00:00.000Z', end: '2026-12-11T12:00:00.000Z' });
    const k3 = h.makeClass({ coach: c1.id, venue: vBig.id, group: g1.id, capacity: 10,
      start: '2026-12-12T11:00:00.000Z', end: '2026-12-12T12:00:00.000Z' });
    await h.book(k1.id, h.student('重复', 7, '13811111111'));
    await h.book(k2.id, h.student('重复', 7, '13811111111'));
    const third = await h.book(k3.id, h.student('重复', 7, '13811111111'));
    assert.equal(third.status, 409);
    assert.equal(third.json.error, 'STUDENT_SPOT_LIMIT');
    const thirdW = await h.book(k3.id, h.student('重复', 7, '13811111111'), { join_waitlist: true });
    assert.equal(thirdW.json.status, 'waitlist');

    // 即使后台手动邀请也被上限拦截
    const manualInvite = await h.call('POST', `/api/admin/bookings/${thirdW.json.booking_id}/invite`, {}, { admin: true });
    assert.equal(manualInvite.status, 409);
    assert.equal(manualInvite.json.error, 'STUDENT_SPOT_LIMIT');
  } finally { await h.stop(); }
});

// 幂等：同一幂等键 + 相同请求体重复提交，只执行一次
test('重复点击防护：相同幂等键重放首次结果，不产生第二个预约', async () => {
  const h = await startHarness();
  try {
    const { c1, vSmall, g1 } = h.seedResource();
    const cls = h.makeClass({ coach: c1.id, venue: vSmall.id, group: g1.id, capacity: 1 });
    const body = { class_id: cls.id, student: h.student('甲', 7, '13800000001') };
    const r1 = await h.call('POST', '/api/bookings', body, { idem: 'key-1' });
    const r2 = await h.call('POST', '/api/bookings', body, { idem: 'key-1' });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r2.replay, true);
    assert.equal(r2.json.booking_id, r1.json.booking_id);
    const count = h.db.get(`SELECT COUNT(*) c FROM bookings`).c;
    assert.equal(count, 1);
    // 同键不同体 -> 拒绝
    const r3 = await h.call('POST', '/api/bookings', { ...body, student: h.student('乙', 7, '13800000002') }, { idem: 'key-1' });
    assert.equal(r3.status, 409);
  } finally { await h.stop(); }
});

// 年龄分组校验
test('年龄不匹配分组：422', async () => {
  const h = await startHarness();
  try {
    const { c1, vBig, g1 } = h.seedResource();
    const cls = h.makeClass({ coach: c1.id, venue: vBig.id, group: g1.id }); // 6-9
    const r = await h.book(cls.id, h.student('大朋友', 15, '13822222222'));
    assert.equal(r.status, 422);
    assert.equal(r.json.error, 'AGE_MISMATCH');
  } finally { await h.stop(); }
});
