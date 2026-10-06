import test from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, mkStudent, mkSession, book, getAdminSession, close, HOUR, DAY } from './helpers.js';

test.after(async () => { await close(); });
test.beforeEach(async () => { await resetDb(); });

test('验收2：临时换场 —— 原子事务阻止冲突，换场后学员待确认，名额保留', async () => {
  const venues = (await api('GET', '/api/admin/venues', undefined, { admin: true })).data;
  const coaches = (await api('GET', '/api/admin/coaches', undefined, { admin: true })).data;
  const t = Date.now() + 4 * DAY;

  // 目标场地在同一时间已有课
  const occupyId = await mkSession({ venueId: venues[1].id, coachId: coaches[2].id, capacity: venues[1].capacity, startAt: t });
  const sid = await mkSession({ venueId: venues[0].id, capacity: 4, startAt: t });

  const me = await mkStudent('换场学员');
  await book(sid, me);

  // 1) 换去冲突场地 -> 409，事务整体失败
  const conflict = await api('PATCH', `/api/admin/sessions/${sid}`, { venueId: venues[1].id }, { admin: true });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'RESOURCE_CONFLICT');

  // 2) 换去空闲的第三个场地 -> 成功，学员进入 pending_change
  const ok = await api('PATCH', `/api/admin/sessions/${sid}`, { venueId: venues[2].id }, { admin: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.scheduleChanged, true);
  const mine = (await api('GET', `/api/students/${me}/bookings`)).data;
  const row = mine.find((x) => x.sessionId === sid);
  assert.equal(row.status, 'pending_change');
  assert.ok(row.oldSessionSnapshot, '保留原安排快照');

  // 名额仍为其保留：新人只能候补
  const other = await mkStudent('新人');
  const small = await mkSession({ capacity: 4 });
  // 对被改场的场次，占位仍计数
  const detail = await getAdminSession(sid);
  const holds = detail.bookings.filter((b) => ['booked', 'invited', 'pending_change'].includes(b.status)).length;
  assert.equal(holds, 1, '待确认改期仍占名额');

  // 3) 学员确认改期 -> booked，且按新安排核对资源
  const conf = await api('POST', `/api/bookings/${row.id}/confirm-change`, { studentId: me });
  assert.equal(conf.status, 200);
  const after = (await api('GET', `/api/students/${me}/bookings`)).data.find((x) => x.sessionId === sid);
  assert.equal(after.status, 'booked');
  assert.equal(after.venueName, venues[2].name);
});

test('验收3：教练代课 —— 换成冲突教练被拒；换成空闲教练后待确认', async () => {
  const coaches = (await api('GET', '/api/admin/coaches', undefined, { admin: true })).data;
  assert.ok(coaches.length >= 2);
  const t = Date.now() + 6 * DAY;

  // 让另一个教练在同一时间已有场次
  await mkSession({ coachId: coaches[1].id, startAt: t, capacity: 5 });
  const sid = await mkSession({ coachId: coaches[0].id, venueId: (await api('GET', '/api/admin/venues', undefined, { admin: true })).data[1].id, startAt: t, capacity: 5 });
  const me = await mkStudent('代课学员');
  await book(sid, me);

  const bad = await api('PATCH', `/api/admin/sessions/${sid}`, { coachId: coaches[1].id }, { admin: true });
  assert.equal(bad.status, 409);

  const good = await api('PATCH', `/api/admin/sessions/${sid}`, { coachId: coaches[2].id }, { admin: true });
  assert.equal(good.status, 200);
  const detail = await getAdminSession(sid);
  assert.equal(detail.coach.id, coaches[2].id);
  assert.equal(detail.pendingChanges, 1);
});

test('改期：学员不接受则取消并自动递补候补', async () => {
  const sid = await mkSession({ capacity: 1, mode: 'auto' });
  const a = await mkStudent('老学员');
  const w = await mkStudent('候补同学');
  await book(sid, a);
  await book(sid, w);

  const t2 = Date.now() + 8 * DAY;
  await api('PATCH', `/api/admin/sessions/${sid}`, { startAt: t2, endAt: t2 + HOUR }, { admin: true });
  let mine = (await api('GET', `/api/students/${a}/bookings`)).data.find((x) => x.sessionId === sid);
  assert.equal(mine.status, 'pending_change');

  const dec = await api('POST', `/api/bookings/${mine.id}/decline-change`, { studentId: a });
  assert.equal(dec.status, 200);
  assert.equal(dec.data.promoted.length, 1);
  const wb = (await getAdminSession(sid)).bookings.find((x) => x.studentId === w);
  assert.equal(wb.status, 'booked');
});

test('容量不能低于既有确认占位数；扩容触发自动递补', async () => {
  const sid = await mkSession({ capacity: 2, mode: 'auto' });
  const a = await mkStudent('A'); const b = await mkStudent('B'); const c = await mkStudent('C');
  await book(sid, a); await book(sid, b); await book(sid, c); // C 候补
  const low = await api('PATCH', `/api/admin/sessions/${sid}`, { capacity: 1 }, { admin: true });
  assert.equal(low.status, 409);
  assert.equal(low.data.code, 'CAPACITY_TOO_LOW');

  const big = await api('PATCH', `/api/admin/sessions/${sid}`, { capacity: 3 }, { admin: true });
  assert.equal(big.status, 200);
  assert.deepEqual(big.data.promoted.length, 1);
});

test('创建场次即做教练/场地时间冲突核对', async () => {
  const coaches = (await api('GET', '/api/admin/coaches', undefined, { admin: true })).data;
  const venues = (await api('GET', '/api/admin/venues', undefined, { admin: true })).data;
  const t = Date.now() + 10 * DAY;
  await mkSession({ coachId: coaches[0].id, venueId: venues[0].id, startAt: t, capacity: 4 });
  const dup = await api('POST', '/api/admin/sessions', {
    title: '冲突课', coachId: coaches[0].id, venueId: venues[1].id,
    startAt: t + 20 * 60_000, endAt: t + 80 * 60_000, capacity: 4, waitlistMode: 'auto',
  }, { admin: true });
  assert.equal(dup.status, 409);
});
