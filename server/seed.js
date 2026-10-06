'use strict';
// 种子数据：可重复运行（已存在同名数据则跳过）
const path = require('path');
const { openDatabase } = require('./src/db');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');

function iso(base, hOffset) {
  return new Date(Date.parse(base) + hOffset * 3600e3).toISOString();
}

(async () => {
  const db = await openDatabase(DB_FILE);
  const now = db.nowIso();

  function ensure(table, name, extraCols, extraVals) {
    let row = db.get(`SELECT * FROM ${table} WHERE name=?`, [name]);
    if (!row) {
      const id = db.insert(`INSERT INTO ${table}(name,${extraCols.join(',')}) VALUES(${['?', ...extraCols.map(() => '?')].join(',')})`,
        [name, ...extraVals]);
      row = db.get(`SELECT * FROM ${table} WHERE id=?`, [id]);
    }
    return row;
  }
  function ensureGroup(name, ageMin, ageMax) {
    let g = db.get('SELECT * FROM age_groups WHERE name=?', [name]);
    if (!g) {
      const id = db.insert('INSERT INTO age_groups(name,age_min,age_max) VALUES(?,?,?)', [name, ageMin, ageMax]);
      g = db.get('SELECT * FROM age_groups WHERE id=?', [id]);
    }
    return g;
  }

  db.transaction(() => {
    const v1 = ensure('venues', '霓虹仓库总店', ['address', 'capacity'], ['静安区延平路 88 号 B1', 12]);
    const v2 = ensure('venues', '西岸镜厅', ['address', 'capacity'], ['徐汇区龙腾大道 255 号 3F', 8]);

    const c1 = ensure('coaches', 'Kidd 阿凯', ['style', 'bio'], ['Hip-Hop / Freestyle', '12 年舞龄，街区赛事裁判']);
    const c2 = ensure('coaches', 'Luna 小月', ['style', 'bio'], ['Choreography / Jazz Funk', 'MV 编舞师，擅长少儿成品舞']);
    const c3 = ensure('coaches', 'Bounce 反弹', ['style', 'bio'], ['Breaking', 'Bboy 十年，专注少儿地板基础']);

    const g1 = ensureGroup('少儿启蒙 6-9', 6, 9);
    const g2 = ensureGroup('少儿进阶 10-13', 10, 13);
    const g3 = ensureGroup('青少年 14-17', 14, 17);
    const g4 = ensureGroup('成人 18+', 18, 99);

    // 明天 19:00（北京时间 = UTC 11:00）为基准排课
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11, 0, 0)).toISOString();

    const classSeeds = [
      ['少儿 Hip-Hop 启蒙试听', c1.id, v1.id, g1.id, 0, 1.5, 6],
      ['少儿 Breaking 地板体验', c3.id, v1.id, g2.id, 2, 1.5, 6],
      ['少儿成品舞 MV 班', c2.id, v2.id, g2.id, 4, 1, 8],
      ['青少年 Freestyle 夜训', c1.id, v2.id, g3.id, 26, 1.5, 8],
      ['成人 Urban 入门', c2.id, v1.id, g4.id, 28, 1.5, 12]
    ];
    for (const [title, coach, venue, grp, off, dur, cap] of classSeeds) {
      if (!db.get('SELECT * FROM classes WHERE title=?', [title])) {
        db.insert('INSERT INTO classes(title,coach_id,venue_id,age_group_id,start_time,end_time,capacity) VALUES(?,?,?,?,?,?,?)',
          [title, coach, venue, grp, iso(base, off), iso(base, off + dur), cap]);
      }
    }

    // 一个授权有效的示例视频 + 一个待授权（不公开）
    if (!db.get('SELECT * FROM videos WHERE title=?', ['年度公演《霓虹少年》'])) {
      const vid = db.insert(
        `INSERT INTO videos(title,student_name,age_group_id,source_path,cover_path,consent_status,consent_granted_at,consent_expires_at,state,guardian_note)
         VALUES('年度公演《霓虹少年》','朵朵（化名）',?, 'media/src/duoduo-show.mp4','media/covers/duoduo.jpg','granted',?,?, 'published','监护人已签独立授权书，含封面与30秒片段公开')`,
        [g2.id, now, db.addHoursIso(now, 24 * 90)]);
      db.insert('INSERT INTO video_clips(video_id,title,clip_path) VALUES(?,?,?)', [vid, '30 秒高光片段', 'media/clips/duoduo-30s.mp4']);
      db.insert('INSERT INTO share_links(video_id,token) VALUES(?,?)', [vid, 'seedsharedemotoken001']);
    }
    if (!db.get('SELECT * FROM videos WHERE title=?', ['夏季 Battle 集锦'])) {
      db.insert(
        `INSERT INTO videos(title,student_name,age_group_id,source_path,consent_status,state)
         VALUES('夏季 Battle 集锦','多名学员',?, 'media/src/summer-battle.mp4','pending','private')`, [g3.id]);
    }
  });

  console.log('种子数据就绪。');
  db.close();
})();
