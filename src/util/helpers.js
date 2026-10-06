import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || undefined;
  }
}

export const now = () => Date.now();

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

// 简单的时间重叠判断：半开区间 [start,end)
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function audit(event, entity, entityId, detail = '') {
  const { db } = requireDb();
  db.prepare(
    `INSERT INTO audit_logs (event, entity, entity_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(event, entity, entityId ?? null, typeof detail === 'string' ? detail : JSON.stringify(detail), now());
}

// 避免在 helpers 顶层循环依赖
import { db } from '../db/index.js';
function requireDb() { return { db }; }
