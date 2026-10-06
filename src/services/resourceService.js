import { db } from '../db/index.js';
import { HttpError, now } from '../util/helpers.js';

/* 场地 */
export const listVenues = (all = false) =>
  db.prepare(all ? 'SELECT * FROM venues ORDER BY id' : 'SELECT * FROM venues WHERE active=1 ORDER BY id').all();
export function createVenue({ name, address = '', capacity = 12, notes = '' }) {
  if (!name) throw new HttpError(400, '场地名称必填');
  const id = db.prepare('INSERT INTO venues (name, address, capacity, notes, active, created_at) VALUES (?,?,?,?,1,?)')
    .run(name, address, Math.max(1, capacity || 12), notes, now()).lastInsertRowid;
  return db.prepare('SELECT * FROM venues WHERE id=?').get(id);
}
export function updateVenue(id, patch) {
  const v = db.prepare('SELECT * FROM venues WHERE id=?').get(id);
  if (!v) throw new HttpError(404, '场地不存在');
  db.prepare('UPDATE venues SET name=?, address=?, capacity=?, notes=?, active=? WHERE id=?').run(
    patch.name ?? v.name, patch.address ?? v.address,
    Math.max(1, patch.capacity ?? v.capacity), patch.notes ?? v.notes,
    patch.active == null ? v.active : (patch.active ? 1 : 0), id);
  return db.prepare('SELECT * FROM venues WHERE id=?').get(id);
}

/* 教练 */
export const listCoaches = (all = false) =>
  db.prepare(all ? 'SELECT * FROM coaches ORDER BY id' : 'SELECT * FROM coaches WHERE active=1 ORDER BY id').all();
export function createCoach({ name, style = '', bio = '' }) {
  if (!name) throw new HttpError(400, '教练姓名必填');
  const id = db.prepare('INSERT INTO coaches (name, style, bio, active, created_at) VALUES (?,?,?,1,?)')
    .run(name, style, bio, now()).lastInsertRowid;
  return db.prepare('SELECT * FROM coaches WHERE id=?').get(id);
}
export function updateCoach(id, patch) {
  const c = db.prepare('SELECT * FROM coaches WHERE id=?').get(id);
  if (!c) throw new HttpError(404, '教练不存在');
  db.prepare('UPDATE coaches SET name=?, style=?, bio=?, active=? WHERE id=?').run(
    patch.name ?? c.name, patch.style ?? c.style, patch.bio ?? c.bio,
    patch.active == null ? c.active : (patch.active ? 1 : 0), id);
  return db.prepare('SELECT * FROM coaches WHERE id=?').get(id);
}

/* 年龄分组 */
export const listAgeGroups = () => db.prepare('SELECT * FROM age_groups ORDER BY min_age, id').all();
export function createAgeGroup({ name, minAge = 0, maxAge = 99 }) {
  if (!name) throw new HttpError(400, '分组名称必填');
  const id = db.prepare('INSERT INTO age_groups (name, min_age, max_age, created_at) VALUES (?,?,?,?)')
    .run(name, minAge, maxAge, now()).lastInsertRowid;
  return db.prepare('SELECT * FROM age_groups WHERE id=?').get(id);
}
export function updateAgeGroup(id, patch) {
  const g = db.prepare('SELECT * FROM age_groups WHERE id=?').get(id);
  if (!g) throw new HttpError(404, '年龄分组不存在');
  db.prepare('UPDATE age_groups SET name=?, min_age=?, max_age=? WHERE id=?').run(
    patch.name ?? g.name, patch.minAge ?? g.min_age, patch.maxAge ?? g.max_age, id);
  return db.prepare('SELECT * FROM age_groups WHERE id=?').get(id);
}
