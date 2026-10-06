import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = path.resolve(process.cwd(), config.dbFile);
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

export const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// 立即事务：开始即获取 RESERVED 写锁，把“读-判断-写”串行化，
// 两人争最后名额时第二个事务会等到第一个提交后再读到最新计数。
export function tx(fn) {
  const t = db.transaction(fn);
  return t.immediate ? t.immediate() : t();
}
// better-sqlite3 事务对象始终支持 immediate()
