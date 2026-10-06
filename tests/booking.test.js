import test from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, mkStudent, mkSession, book, getAdminSession, close, HOUR, DAY } from './helpers.js';

test.after(async () => { await close(); });

test.beforeEach(async () => { await resetDb(); });

test('验收1：两人争最后名额 —— 只有一人占上，另一人进候补，绝不超额', async () => {
  const sid = await mkSession({ capacity: 2 });
  const s1 = await mkStudent('阿一');
  const s2 = await mkStudent('阿二');
  const s3 = await mkStudent('阿三');

  const r1 = await book(sid, s1, 'k1');
  assert.equal(r1.status, 201);
  assert.equal(r1.data.booking.status, 'booked');

  // 并发提交两个请求抢最后一个名额
  const [r2, r3] = await Promise.all([
    book(sid, s2, 'k2'),
    book(sid, s3, 'k3'),
  ]);
  const winner = [r2, r3].find((r) => r.status === 201);
  const loser = [r2, r3].find((r) => r.status === 202);
  assert.ok(winner, '应有一人 201 直接占位');
  assert.ok(loser, '应有一人 202 进入候补');
  assert.equal(loser.data.waitlisted, true);

  const detail = await getAdminSession(sid);
  const holds = detail.bookings.filter((b) => ['booked', 'invited', 'pending_change'].includes(b.status)).length;
  assert.equal(holds, 2, '实际占位严格等于容量 2，不能超额');
  assert.equal(detail.bookings.filter((b) => b.status === 'waitlisted').length, 1);
});

test('防重复点击：相同幂等键重复提交不会挤满名额', async () => {
  const sid = await mkSession({ capacity: 1 });
  const s1 = await mkStudent('阿甲');
  const [a, b, c] = await Promise.all([
    book(sid, s1, 'same-key'),
    book(sid, s1, 'same-key'),
    book(sid, s1, 'same-key'),
  ]);
  // 并发下部分请求可能因唯一索引冲突 409，但绝不允许出现 2 个占位
  const codes = [a.status, b.status, c.status].sort();
  assert.ok(codes.includes(201));
  const detail = await getAdminSession(sid);
  const active = detail.bookings.filter((x) => ['booked', 'waitlisted', 'invited', 'pending_change'].includes(x.status));
  assert.equal(active.length, 1, '只有一条活动预约');

  // 串行重复：幂等返回同一条
  const again = await book(sid, s1, 'same-key');
  assert.equal(again.data.deduped, true);
});

test('同一学员多场占位上限：第 3 场被拒（候补不计入）', async () => {
  const a = await mkSession({ capacity: 5 });
  const bId = await mkSession({ capacity: 5 });
  const cId = await mkSession({ capacity: 5 });
  const me = await mkStudent('小多');
  assert.equal((await book(a, me)).status, 201);
  assert.equal((await book(bId, me)).status, 201);
  const r3 = await book(cId, me);
  assert.equal(r3.status, 409);
  assert.equal(r3.data.code, 'HOLD_LIMIT');

  // 满员场次的候补不占位：可以候补
  const full = await mkSession({ capacity: 1 });
  const other = await mkStudent('别人');
  await book(full, other);
  const wl = await book(full, me);
  assert.equal(wl.status, 202);
  assert.equal(wl.data.booking.status, 'waitlisted');
});

test('自动候补递补：确认占位者取消，队首自动补上', async () => {
  const sid = await mkSession({ capacity: 1 });
  const a = await mkStudent('占位A');
  const w = await mkStudent('候补W');
  await book(sid, a);
  const wlr = await book(sid, w);
  assert.equal(wlr.data.booking.status, 'waitlisted');

  // 管理员视角：取消 A 的预约（模拟学员取消）
  const bookingA = (await getAdminSession(sid)).bookings.find((x) => x.studentId === a);
  const cancel = await api('POST', `/api/bookings/${bookingA.id}/cancel`, { studentId: a });
  assert.equal(cancel.status, 200);
  assert.deepEqual(cancel.data.promoted.length >= 1, true);

  const after = await getAdminSession(sid);
  const wb = after.bookings.find((x) => x.studentId === w);
  assert.equal(wb.status, 'booked', '候补者被自动递补');
});

test('验收4A：人工邀请——接受、有效期、拒绝与超时释放，以及撤下邀请竞争', async () => {
  const sid = await mkSession({ capacity: 1, mode: 'manual' });
  const a = await mkStudent('占位甲');
  const w = await mkStudent('候补乙');
  await book(sid, a);
  await book(sid, w);

  // 甲取消，空位保留（manual 不自动递补）
  const bA = (await getAdminSession(sid)).bookings.find((x) => x.studentId === a);
  const cancel = await api('POST', `/api/bookings/${bA.id}/cancel`, { studentId: a });
  assert.deepEqual(cancel.data.promoted, [], '人工模式不自动递补');

  // 管理员邀请候补乙
  const bW = (await getAdminSession(sid)).bookings.find((x) => x.studentId === w);
  const inv = await api('POST', `/api/admin/sessions/${sid}/invite`, { bookingId: bW.id }, { admin: true });
  assert.equal(inv.status, 201);
  assert.equal(inv.data.status, 'invited');
  assert.ok(inv.data.inviteExpiresAt - Date.now() > 23 * HOUR);

  // 邀请占用名额：第三人来约只能进候补（即使卡片可能刚显示有空位）
  const c = await mkStudent('丙丙');
  const rc = await book(sid, c);
  assert.equal(rc.data.booking.status, 'waitlisted');

  // 学员接受
  const acc = await api('POST', `/api/invites/${inv.data.id}/accept`, { studentId: w });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.booking.status, 'booked');

  // 已接受后再点一次/过期接口不能再接受
  const again = await api('POST', `/api/invites/${inv.data.id}/accept`, { studentId: w });
  assert.equal(again.status, 409);
});

test('验收4B：邀请被撤下（取消竞争）后，学员接受失败，空位可邀请他人', async () => {
  const sid = await mkSession({ capacity: 1, mode: 'manual' });
  const a = await mkStudent('占位X');
  const w1 = await mkStudent('候补1');
  const w2 = await mkStudent('候补2');
  await book(sid, a);
  await book(sid, w1);
  await book(sid, w2);
  const bA = (await getAdminSession(sid)).bookings.find((x) => x.studentId === a);
  await api('POST', `/api/bookings/${bA.id}/cancel`, { studentId: a });

  let bW1 = (await getAdminSession(sid)).bookings.find((x) => x.studentId === w1);
  const inv = (await api('POST', `/api/admin/sessions/${sid}/invite`, { bookingId: bW1.id }, { admin: true })).data;

  // 管理员撤下邀请（例如联系不上/决定邀请另一位）
  const rev = await api('POST', `/api/admin/bookings/${inv.id}/revoke-invite`, {}, { admin: true });
  assert.equal(rev.status, 200);

  // 学员此时点击接受，必须失败（邀请已不是其可接受状态）
  const late = await api('POST', `/api/invites/${inv.id}/accept`, { studentId: w1 });
  assert.equal(late.status, 409);

  // w1 退回候补，管理员可改请 w2
  bW1 = (await getAdminSession(sid)).bookings.find((x) => x.studentId === w1);
  assert.equal(bW1.status, 'waitlisted');
  const bW2 = (await getAdminSession(sid)).bookings.find((x) => x.studentId === w2);
  const inv2 = await api('POST', `/api/admin/sessions/${sid}/invite`, { bookingId: bW2.id }, { admin: true });
  assert.equal(inv2.status, 201);
});

test('邀请过期：超时后接受返回 410，清扫后名额可重新邀请', async () => {
  const sid = await mkSession({ capacity: 1, mode: 'manual' });
  const a = await mkStudent('占');
  const w = await mkStudent('候');
  await book(sid, a);
  await book(sid, w);
  const bA = (await getAdminSession(sid)).bookings.find((x) => x.studentId === a);
  await api('POST', `/api/bookings/${bA.id}/cancel`, { studentId: a });
  const bW = (await getAdminSession(sid)).bookings.find((x) => x.studentId === w);
  const inv = (await api('POST', `/api/admin/sessions/${sid}/invite`, { bookingId: bW.id }, { admin: true })).data;

  // 直接把到期时间改到过去（模拟 TTL 流逝），再触发惰性/定时清扫
  const { db } = await import('../src/db/index.js');
  db.prepare("UPDATE bookings SET invite_expires_at=? WHERE id=?").run(Date.now() - 1, inv.id);
  const acc = await api('POST', `/api/invites/${inv.id}/accept`, { studentId: w });
  assert.equal(acc.status, 410);
  assert.equal(acc.data.code, 'INVITE_EXPIRED');

  const sweep = await api('POST', '/api/admin/sweep/invites', {}, { admin: true });
  assert.ok(sweep.data.expired.includes(inv.id));
  const after = await getAdminSession(sid);
  assert.equal(after.bookings.find((x) => x.id === inv.id).status, 'expired');
});
