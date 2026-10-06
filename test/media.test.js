'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server/src/services');
const { startHarness } = require('./helpers');

async function setupVideo(h, { expires } = {}) {
  const { g2 } = h.seedResource();
  const created = await h.call('POST', '/api/admin/videos', {
    title: '成果视频', student_name: '朵朵', age_group_id: g2.id, source_path: 'media/src/dd.mp4'
  }, { admin: true });
  const id = created.json.video.id;
  const now = '2026-12-01T10:00:00.000Z';
  S.grantConsent(h.db, id, { expires_at: expires || null, guardian_note: '授权书 #001' }, { now });
  // 封面 + 片段 + 分享入口
  await h.call('POST', `/api/admin/videos/${id}/cover`, { cover_path: 'media/covers/dd.jpg' }, { admin: true });
  await h.call('POST', `/api/admin/videos/${id}/clip`, { title: '30秒片段', clip_path: 'media/clips/dd.mp4' }, { admin: true });
  const share = await h.call('POST', `/api/admin/videos/${id}/share`, {}, { admin: true });
  return { id, token: share.json.link.token };
}

// 验收场景 7：旧视频转码任务迟到 —— 授权仍在 -> 完成发布；已撤销/到期 -> 丢弃产物
test('转码任务迟到完成：授权有效才落库；撤销后迟到则丢弃，不发布', async () => {
  const h = await startHarness();
  try {
    // 情形 A：授权长期有效，迟到完成 -> 正常发布
    const a = await setupVideo(h);
    const job1 = (await h.call('POST', `/api/admin/videos/${a.id}/transcode`, {}, { admin: true })).json.job.id;
    const done1 = await h.call('POST', `/api/admin/transcodes/${job1}/complete`, { output_path: 'media/out/a.mp4' }, { admin: true });
    assert.equal(done1.json.discarded, false);
    const pub = (await h.call('GET', '/api/achievements')).json.videos;
    assert.ok(pub.some((v) => v.id === a.id));

    // 情形 B：先排队转码，随后撤销授权，再“迟到完成” -> discarded
    const b = await setupVideo(h);
    const job2 = (await h.call('POST', `/api/admin/videos/${b.id}/transcode`, {}, { admin: true })).json.job.id;
    const down = await h.call('POST', `/api/admin/videos/${b.id}/takedown`, { reason: 'revoked' }, { admin: true });
    assert.equal(down.status, 200);
    const late = await h.call('POST', `/api/admin/transcodes/${job2}/complete`, { output_path: 'media/out/b-late.mp4' }, { admin: true });
    assert.equal(late.json.discarded, true);
    assert.equal(late.json.reason, 'VIDEO_TAKEN_DOWN');
    const j = h.db.get('SELECT * FROM transcode_jobs WHERE id=?', [job2]);
    assert.equal(j.state, 'discarded');
    assert.equal(j.output_path, null, '丢弃时不得写入产物路径');

    // 情形 C：授权到期后迟到完成 -> discarded(CONSENT_NOT_LIVE)
    const c = await setupVideo(h, { expires: '2026-12-02T10:00:00.000Z' });
    const job3 = (await h.call('POST', `/api/admin/videos/${c.id}/transcode`, {}, { admin: true })).json.job.id;
    const late2 = S.completeTranscode(h.db, job3, 'media/out/c-late.mp4', { now: '2026-12-03T00:00:00.000Z' });
    assert.equal(late2.discarded, true);
    assert.equal(late2.reason, 'CONSENT_NOT_LIVE');
  } finally { await h.stop(); }
});

// 验收：撤销授权不只是列表隐藏 —— 封面/片段/分享/受控流全部处理，410
test('撤销授权：封面、片段、分享入口同步撤下，受控流 410，且有进度清单', async () => {
  const h = await startHarness();
  try {
    const { id, token } = await setupVideo(h);
    // 撤下前：公开列表可见、分享可访问、受控流 200
    assert.ok((await h.call('GET', '/api/achievements')).json.videos.some((v) => v.id === id));
    assert.equal((await h.call('GET', `/api/share/${token}`)).status, 200);
    assert.equal((await h.call('GET', `/api/media/videos/${id}/stream`)).status, 200);

    const r = await h.call('POST', `/api/admin/videos/${id}/takedown`, { reason: 'revoked' }, { admin: true });
    assert.equal(r.status, 200);
    const stepNames = r.json.steps.map((s) => s.step);
    for (const must of ['share_links', 'cover', 'clips', 'transcode_jobs', 'source']) {
      assert.ok(stepNames.includes(must), `撤下步骤缺少 ${must}`);
    }

    // 列表不再出现（但这只是结果之一，不是唯一措施）
    assert.ok(!(await h.call('GET', '/api/achievements')).json.videos.some((v) => v.id === id));
    // 直接打受控流 -> 410
    const stream = await h.call('GET', `/api/media/videos/${id}/stream`);
    assert.equal(stream.status, 410);
    assert.equal(stream.json.error, 'MEDIA_TAKEN_DOWN');
    // 分享链接 -> 410
    const share = await h.call('GET', `/api/share/${token}`);
    assert.equal(share.status, 410);
    // 封面/片段已隔离
    const clip = h.db.get('SELECT * FROM video_clips WHERE video_id=?', [id]);
    assert.equal(clip.state, 'quarantined');
    const v = h.db.get('SELECT cover_path,state,consent_status FROM videos WHERE id=?', [id]);
    assert.equal(v.state, 'taken_down');
    assert.equal(v.consent_status, 'revoked');
    // 已隔离记录仍保留可审计的封面路径（文件已“移动”），服务端不再把它作为公开封面输出
    assert.ok(v.cover_path);

    // 重复撤下幂等
    const again = await h.call('POST', `/api/admin/videos/${id}/takedown`, {}, { admin: true });
    assert.equal(again.json.reused, true);
  } finally { await h.stop(); }
});

// 授权到期扫描：自动走撤下流程
test('授权到期扫描：到期视频被撤下且分享入口失效', async () => {
  const h = await startHarness();
  try {
    const { id, token } = await setupVideo(h, { expires: '2026-12-10T10:00:00.000Z' });
    const results = S.sweepConsentExpiry(h.db, { now: '2026-12-11T00:00:00.000Z' });
    assert.equal(results.length, 1);
    const v = h.db.get('SELECT * FROM videos WHERE id=?', [id]);
    assert.equal(v.state, 'taken_down');
    assert.equal(v.consent_status, 'expired');
    assert.equal((await h.call('GET', `/api/share/${token}`)).status, 410);
    // 未到期不受影响
    const before = (await h.call('GET', '/api/achievements')).json.videos.length;
    assert.equal(before, 0, '两个示例视频均不在公开列表（一个撤销一个到期）');
  } finally { await h.stop(); }
});

// 未授权视频不可分享、不出现在公开列表
test('未授权：不能创建分享入口；公开列表为空；受控流 410', async () => {
  const h = await startHarness();
  try {
    const { g2 } = h.seedResource();
    const created = await h.call('POST', '/api/admin/videos', {
      title: '待授权', student_name: '孩', age_group_id: g2.id, source_path: 'media/src/x.mp4'
    }, { admin: true });
    const id = created.json.video.id;
    const noShare = await h.call('POST', `/api/admin/videos/${id}/share`, {}, { admin: true });
    assert.equal(noShare.status, 409);
    assert.equal((await h.call('GET', '/api/achievements')).json.videos.length, 0);
    const stream = await h.call('GET', `/api/media/videos/${id}/stream`);
    assert.equal(stream.status, 410);
  } finally { await h.stop(); }
});

// 持久化：关闭重开数据库，数据仍在
test('数据库持久化：写入落盘后重新打开仍可读到', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { openDatabase } = require('../server/src/db');
  const file = path.join(os.tmpdir(), `ng-persist-${Date.now()}.db`);
  try {
    const db1 = await openDatabase(file);
    db1.run("INSERT INTO venues(name,address,capacity) VALUES('持久场地','X',9)");
    db1.persist();
    db1.close();
    assert.ok(fs.existsSync(file));
    const db2 = await openDatabase(file);
    const row = db2.get("SELECT * FROM venues WHERE name='持久场地'");
    assert.equal(row.capacity, 9);
    db2.close();
  } finally { try { fs.unlinkSync(file); } catch (_) {} }
});
