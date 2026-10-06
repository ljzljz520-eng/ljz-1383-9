// 动效控制：默认跟随系统“减少动态效果”，用户可手动开关并记忆；关闭动效不损失任何信息。
(function () {
  const stored = localStorage.getItem('groove:motion');
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let motion = stored == null ? !prefersReduced : stored === 'on';
  function apply() {
    document.body.classList.toggle('motion', motion);
    const btn = document.getElementById('motionToggle');
    if (btn) {
      btn.setAttribute('aria-pressed', String(motion));
      btn.textContent = '动效：' + (motion ? '开' : '关');
    }
  }
  window.toggleMotion = function () {
    motion = !motion;
    localStorage.setItem('groove:motion', motion ? 'on' : 'off');
    apply();
  };
  window.getMotion = () => motion;
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('motionToggle')?.addEventListener('click', window.toggleMotion);

    // 移动端菜单（可被键盘操作；菜单展开状态不依赖动画）
    const t = document.getElementById('menuToggle');
    const links = document.getElementById('navLinks');
    t?.addEventListener('click', () => {
      const open = links.classList.toggle('open');
      t.setAttribute('aria-expanded', String(open));
    });
    links?.querySelectorAll('a').forEach((a) =>
      a.addEventListener('click', () => {
        links.classList.remove('open');
        t.setAttribute('aria-expanded', 'false');
      })
    );
  });
})();

window.api = async function (path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body !== undefined && !(body instanceof FormData) && typeof body !== 'string' && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { ...options, headers, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.error || ('请求失败 ' + res.status));
    err.status = res.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
};

window.esc = function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
};
window.fmtTime = function (ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
window.fmtDateTime = window.fmtTime;
window.fmtCountdown = function (expiresAt) {
  const ms = (expiresAt || 0) - Date.now();
  if (ms <= 0) return '已过期';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `剩余 ${h} 小时 ${m} 分` : `剩余 ${m} 分`;
};
