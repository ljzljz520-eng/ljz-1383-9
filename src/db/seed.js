import { db, tx } from './index.js';
import { now } from '../util/helpers.js';
import { saveAsset } from '../services/mediaService.js';
import {
  createVenue, createCoach, createAgeGroup,
} from '../services/resourceService.js';
import { createSession } from '../services/bookingService.js';

const DAY = 1000 * 60 * 60 * 24;
const HOUR = 1000 * 60 * 60;

function svgCover(title, sub, c1 = '#ff2d78', c2 = '#00e5ff') {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="#0b0d17"/>
  <rect x="0" y="250" width="640" height="110" fill="url(#g)" opacity="0.85"/>
  <g fill="none" stroke="${c2}" stroke-width="3" opacity="0.75">
    <path d="M120 250 C150 180 90 150 130 90"/>
    <circle cx="130" cy="80" r="16"/>
    <path d="M130 110 L200 160 M130 110 L70 170 M150 180 L230 230 M150 180 L95 250"/>
    <path d="M360 250 C390 190 330 160 370 110"/>
    <circle cx="370" cy="100" r="15"/>
    <path d="M370 128 L430 170 M370 128 L310 180 M388 190 L455 235 M388 190 L335 250"/>
  </g>
  <text x="40" y="60" font-family="Arial, sans-serif" font-size="34" font-weight="bold" fill="#fff">${title}</text>
  <text x="40" y="96" font-family="Arial, sans-serif" font-size="18" fill="${c2}">${sub}</text>
  <text x="40" y="320" font-family="Arial, sans-serif" font-size="16" fill="#0b0d17" font-weight="bold">GROOVE LAB · 成果展示（演示素材）</text>
</svg>`);
}

export function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM venues').get().c;
  if (count > 0) return false;

  return tx(() => {
    const v1 = createVenue({ name: 'Groove Lab 主馆', address: '解放路 88 号 3F（地铁 A 口）', capacity: 20, notes: '弹性地板，专业音响' });
    const v2 = createVenue({ name: '滨江分点', address: '滨江天街 B 座 501', capacity: 12, notes: '落地镜墙' });
    const v3 = createVenue({ name: '老城练习室', address: '中山中路 12 号 2F', capacity: 8, notes: '小班精品课' });

    const c1 = createCoach({ name: 'Kai 凯哥', style: 'Breaking', bio: '12 年舞龄，擅长少儿地板基础与安全训练。' });
    const c2 = createCoach({ name: 'Momo', style: 'Popping / Locking', bio: '青少年律动启蒙，节奏拆解教学。' });
    const c3 = createCoach({ name: 'Luna', style: 'HipHop / Jazz', bio: '舞台编排与成果汇演指导。' });
    const c4 = createCoach({ name: 'D-Soul', style: 'HipHop', bio: '成人入门课，零基础友好。' });

    const a1 = createAgeGroup({ name: '少儿萌趣班', minAge: 4, maxAge: 7 });
    const a2 = createAgeGroup({ name: '少儿进阶班', minAge: 8, maxAge: 12 });
    const a3 = createAgeGroup({ name: '青少年/成人', minAge: 13, maxAge: 99 });

    const t = now();
    createSession({
      title: 'Breaking 少儿体验课', style: 'Breaking',
      coachId: c1.id, venueId: v1.id, ageGroupId: a1.id,
      startAt: t + 2 * DAY + 10 * HOUR, endAt: t + 2 * DAY + 11 * HOUR,
      capacity: 6, waitlistMode: 'auto',
    });
    createSession({
      title: 'Popping 律动试听', style: 'Popping',
      coachId: c2.id, venueId: v2.id, ageGroupId: a2.id,
      startAt: t + 3 * DAY + 14 * HOUR, endAt: t + 3 * DAY + 15 * HOUR,
      capacity: 2, waitlistMode: 'auto', // 故意只给 2 个名额，方便演示“争最后名额”
    });
    createSession({
      title: 'HipHop 零基础试听（人工候补）', style: 'HipHop',
      coachId: c4.id, venueId: v3.id, ageGroupId: a3.id,
      startAt: t + 4 * DAY + 19 * HOUR, endAt: t + 4 * DAY + 20 * HOUR,
      capacity: 2, waitlistMode: 'manual',
    });
    createSession({
      title: '少儿街舞编排工作坊', style: 'HipHop',
      coachId: c3.id, venueId: v1.id, ageGroupId: a2.id,
      startAt: t + 5 * DAY + 15 * HOUR, endAt: t + 5 * DAY + 16.5 * HOUR,
      capacity: 10, waitlistMode: 'auto',
    });

    // 演示学员 + 已授权的成果视频（演示素材为 SVG 动画封面）
    const sid = db.prepare('INSERT INTO students (name, contact, age, created_at) VALUES (?,?,?,?)')
      .run('演示学员 小宇', '13800000000', 9, t).lastInsertRowid;

    const cover1 = saveAsset({ kind: 'cover', mime: 'image/svg+xml', buffer: svgCover('Breaking 期末齐舞', '少儿进阶班 · Kai') });
    const source1 = saveAsset({ kind: 'source', mime: 'image/svg+xml', buffer: svgCover('Breaking 期末齐舞（正片占位）', '演示环境无 ffmpeg，正片为占位素材', '#7c4dff', '#00e5ff') });
    const clip1 = saveAsset({ kind: 'clip', mime: 'image/svg+xml', buffer: svgCover('高光片段：Freeze', '00:42 高光', '#ff2d78', '#ffb300') });
    const vid1 = db.prepare(
      `INSERT INTO videos (title, student_id, source_asset_id, consent_status, consent_granted_at, consent_expires_at, consent_epoch, published, created_at)
       VALUES (?,?,?, 'active', ?, NULL, 1, 1, ?)`
    ).run('Breaking 期末齐舞', sid, source1.id, t, t).lastInsertRowid;
    db.prepare('INSERT INTO video_assets (video_id, asset_id, role) VALUES (?,?,?)').run(vid1, cover1.id, 'cover');
    db.prepare('INSERT INTO video_assets (video_id, asset_id, role) VALUES (?,?,?)').run(vid1, clip1.id, 'clip');
    // 一个已完成的转码
    db.prepare(
      `INSERT INTO transcode_jobs (video_id, source_asset_id, output_asset_id, consent_epoch, status, created_at, finished_at)
       VALUES (?,?,?,1,'done',?,?)`
    ).run(vid1, source1.id, source1.id, t, t);

    const cover2 = saveAsset({ kind: 'cover', mime: 'image/svg+xml', buffer: svgCover('Popping 节奏小考', '少儿进阶班 · Momo', '#ffb300', '#ff2d78') });
    const source2 = saveAsset({ kind: 'source', mime: 'image/svg+xml', buffer: svgCover('Popping 节奏小考（正片占位）', '演示素材', '#ffb300', '#7c4dff') });
    // 授权 30 天后到期，演示“可以到期”
    const vid2 = db.prepare(
      `INSERT INTO videos (title, student_id, source_asset_id, consent_status, consent_granted_at, consent_expires_at, consent_epoch, published, created_at)
       VALUES (?,?,?, 'active', ?, ?, 1, 1, ?)`
    ).run('Popping 节奏小考', sid, source2.id, t, t + 30 * DAY, t).lastInsertRowid;
    db.prepare('INSERT INTO video_assets (video_id, asset_id, role) VALUES (?,?,?)').run(vid2, cover2.id, 'cover');

    return true;
  });
}
