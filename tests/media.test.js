import test from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, close } from './helpers.js';
import fs from 'node:fs';
import { saveAsset, getAsset, assetPath } from '../src/services/mediaService.js';
import { db } from '../src/db/index.js';

const SVG = (label) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><text>${label}</text></svg>`);

test.after(async () => { await close(); });
test.beforeEach(async () => { await resetDb(); });

async function mkVideoWithSource(label = 'test') {
  const vid = (await api('POST', '/api/admin/videos', { title: '少儿成果-' + label }, { admin: true })).data.id;
  const src = saveAsset({ kind: 'source', mime: 'image/svg+xml', buffer: SVG(label + '-source') });
  const cover = saveAsset({ kind: 'cover', mime: 'image/svg+xml', buffer: SVG(label + '-cover') });
  const clip = saveAsset({ kind: 'clip', mime: 'image/svg+xml', buffer: SVG(label + '-clip') });
  await api('POST', `/api/admin/videos/${vid}/source`, { assetId: src.id }, { admin: true });
  const coverResp = await api('POST', `/api/admin/videos/${vid}/assets`, SVG(label + '-cover2'), {
    admin: true, headers: { 'Content-Type': 'image/svg+xml', 'X-Mime': 'image/svg+xml' }, raw: true,
  });
  // 上面的 raw 方式走 raw 分支：用 role 默认 clip；封面直接用 db 关联以简化
  db.prepare('INSERT OR IGNORE INTO video_assets (video_id, asset_id, role) VALUES (?,?,?)').run(vid, cover.id, 'cover');
  db.prepare('INSERT OR IGNORE INTO video_assets (video_id, asset_id, role) VALUES (?,?,?)').run(vid, clip.id, 'clip');
  return { vid, sourceId: src.id, coverId: cover.id, clipId: clip.id };
}

test('未授权 / 到期 / 撤销的视频都不会出现在成果墙，资产接口也拒绝', async () => {
  const { vid, coverId } = await mkVideoWithSource('未授权');
  // 未授权：即使 published=0
  assert.deepEqual((await api('GET', '/api/videos')).data, []);
  const forbidden = await api('GET', '/api/assets/' + coverId);
  assert.notEqual(forbidden.status, 200, '未授权封面不可访问');
});

test('独立授权与分享：授权后可公开访问；分享链接可单独关闭', async () => {
  const { vid, coverId } = await mkVideoWithSource('已授权');
  const g = await api('POST', `/api/admin/videos/${vid}/consent`, {}, { admin: true });
  assert.equal(g.status, 200);
  assert.equal(g.data.consent_status, 'active');

  const pub = await api('GET', '/api/videos');
  assert.equal(pub.data.length, 1);
  const asset = await api('GET', '/api/assets/' + coverId);
  assert.equal(asset.status, 200);

  const share = (await api('POST', `/api/admin/videos/${vid}/shares`, {}, { admin: true })).data;
  const ok = await api('GET', '/api/shares/' + share.token);
  assert.equal(ok.status, 200);

  await api('POST', `/api/admin/shares/${share.id}/revoke`, {}, { admin: true });
  const gone = await api('GET', '/api/shares/' + share.token);
  assert.equal(gone.status, 404);
});

test('授权可以到期：到期后成果墙、封面、片段、分享全部失效（不只是列表隐藏）', async () => {
  const { vid, coverId, clipId } = await mkVideoWithSource('到期');
  const expiresAt = Date.now() + 100;
  await api('POST', `/api/admin/videos/${vid}/consent`, { expiresAt }, { admin: true });
  const share = (await api('POST', `/api/admin/videos/${vid}/shares`, {}, { admin: true })).data;

  await new Promise((r) => setTimeout(r, 140));
  // 触发惰性到期（成果墙）
  const pub = await api('GET', '/api/videos');
  assert.deepEqual(pub.data, [], '到期后成果墙不再返回');

  const detail = (await api('GET', `/api/admin/videos/${vid}`, undefined, { admin: true })).data;
  assert.equal(detail.consentStatus, 'expired');

  const cover = await api('GET', '/api/assets/' + coverId);
  assert.equal(cover.status, 403, '封面门禁失效');
  const clip = await api('GET', '/api/assets/' + clipId);
  assert.equal(clip.status, 403, '片段门禁失效');

  const shareRes = await api('GET', '/api/shares/' + share.token);
  assert.ok([404, 410].includes(shareRes.status), '分享入口关闭，实际 ' + shareRes.status);
  const sharesRow = db.prepare('SELECT status FROM shares WHERE id=?').get(share.id);
  assert.equal(sharesRow.status, 'revoked', '分享记录被作废而非仅隐藏');
});

test('验收5：撤销授权 —— 封面/片段/分享入口/服务端文件全部处理，且撤下进度可查', async () => {
  const { vid, sourceId, coverId, clipId } = await mkVideoWithSource('撤销');
  await api('POST', `/api/admin/videos/${vid}/consent`, {}, { admin: true });
  const share = (await api('POST', `/api/admin/videos/${vid}/shares`, {}, { admin: true })).data;
  const job = (await api('POST', `/api/admin/videos/${vid}/transcode`, {}, { admin: true })).data;

  // 文件在撤销前确实存在
  for (const id of [sourceId, coverId, clipId]) {
    const a = getAsset(id);
    assert.ok(fs.existsSync(assetPath(a)), '文件存在');
  }

  const r = await api('POST', `/api/admin/videos/${vid}/revoke`, { reason: '家长要求撤下' }, { admin: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.deletedFiles, r.data.totalFiles, '服务端文件全部删除');

  // 公开面全断
  assert.deepEqual((await api('GET', '/api/videos')).data, []);
  for (const id of [coverId, clipId, sourceId]) {
    const a = await api('GET', '/api/assets/' + id);
    assert.ok([403, 410].includes(a.status), `资产 ${id} 不可访问，实际 ${a.status}`);
    assert.ok(!fs.existsSync(assetPath(getAsset(id))), '物理文件已删除');
  }
  const shareRes = await api('GET', '/api/shares/' + share.token);
  assert.ok([404, 410].includes(shareRes.status));

  // 转码在途任务作废
  const jobAfter = db.prepare('SELECT * FROM transcode_jobs WHERE id=?').get(job.id);
  assert.equal(jobAfter.status, 'rejected');

  // 撤下进度在管理端可见
  const detail = (await api('GET', `/api/admin/videos/${vid}`, undefined, { admin: true })).data;
  const rm = detail.removal;
  assert.ok(rm.shares && rm.cover && rm.clips && rm.files, '四个阶段都有完成时间');
  assert.match(rm.externalCopiesNotice, /无法.*远程/);

  // 撤销为终态：不能重新授权
  const regrant = await api('POST', `/api/admin/videos/${vid}/consent`, {}, { admin: true });
  assert.equal(regrant.status, 409);
});

test('验收5续：旧视频转码任务“迟到”——在撤销/重新授权后完成，必须作废且不产出', async () => {
  const { vid } = await mkVideoWithSource('迟到');
  await api('POST', `/api/admin/videos/${vid}/consent`, {}, { admin: true });
  const job1 = (await api('POST', `/api/admin/videos/${vid}/transcode`, {}, { admin: true })).data;

  // 撤销后，转码任务才“跑完”
  await api('POST', `/api/admin/videos/${vid}/revoke`, { reason: '撤回' }, { admin: true });
  const late1 = await api('POST', `/api/admin/jobs/${job1.id}/complete`, {}, { admin: true });
  assert.equal(late1.status, 200);
  assert.equal(late1.data.status, 'rejected');
  assert.match(late1.data.reject_reason, /撤销/);
  assert.equal(late1.data.output_asset_id, null, '迟到任务不产出文件');
});

test('重新授权轮次 +1：上一轮的排队转码完成时因 epoch 不匹配被作废', async () => {
  const { vid } = await mkVideoWithSource('轮次');
  await api('POST', `/api/admin/videos/${vid}/consent`, {}, { admin: true });
  const oldJob = (await api('POST', `/api/admin/videos/${vid}/transcode`, {}, { admin: true })).data;

  // 授权自然到期后重新授权（轮次 +1）
  db.prepare('UPDATE videos SET consent_status=? WHERE id=?').run('expired', vid);
  await api('POST', `/api/admin/videos/${vid}/consent`, {}, { admin: true });
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(vid);
  assert.equal(v.consent_epoch, 2);

  const r = await api('POST', `/api/admin/jobs/${oldJob.id}/complete`, {}, { admin: true });
  assert.equal(r.data.status, 'rejected');
  assert.match(r.data.reject_reason, /epoch/);

  // 新轮次发起的任务可正常完成
  const newJob = (await api('POST', `/api/admin/videos/${vid}/transcode`, {}, { admin: true })).data;
  const done = await api('POST', `/api/admin/jobs/${newJob.id}/complete`, {}, { admin: true });
  assert.equal(done.data.status, 'done');
  assert.ok(done.data.output_asset_id);
});
