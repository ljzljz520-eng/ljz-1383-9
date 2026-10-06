'use strict';
const path = require('path');
const fs = require('fs');
const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');

(async () => {
  const db = await openDatabase(DB_FILE);
  const app = createApp(db);
  app.listen(PORT, () => {
    console.log(`街舞课程站已启动: http://localhost:${PORT}`);
    console.log(`管理后台:       http://localhost:${PORT}/admin  (默认令牌 dev-admin-token)`);
    console.log(`数据库文件:     ${DB_FILE}`);
  });
})().catch((e) => { console.error(e); process.exit(1); });
