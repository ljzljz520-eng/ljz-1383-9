// 全局配置（邀请有效期、占位上限等）
export const config = {
  port: Number(process.env.PORT || 3000),
  dbFile: process.env.DB_FILE || 'data/app.db',
  adminToken: process.env.ADMIN_TOKEN || 'dev-admin-token',
  // 邀请有效期（毫秒）。自动递补通常较短，人工邀请默认 24h。
  autoInviteTtlMs: Number(process.env.AUTO_INVITE_TTL_MS || 1000 * 60 * 30), // 30 分钟
  manualInviteTtlMs: Number(process.env.MANUAL_INVITE_TTL_MS || 1000 * 60 * 60 * 24), // 24 小时
  // 同一学员允许同时“占位”的场次上限（booked + invited + pending_change + confirmed）。
  // 候补 waitlisted 不占位，不计入。
  maxActiveHoldsPerStudent: Number(process.env.MAX_ACTIVE_HOLDS || 2),
  // 过期邀请/授权的后台清扫间隔
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS || 1000 * 30),
};
