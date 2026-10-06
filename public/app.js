'use strict';
// 前台交互：渲染 + 报名（幂等键、提交锁、版本核对）+ 候补邀请
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

const state = {
  classes: [],
  settings: { max_active_spots_per_student: 2, invitation_ttl_hours: 24 },
  timers: []
};

// ---------- 动效开关：持久化 + 尊重系统偏好；关闭后信息不依赖动画 ----------
const motionKey = 'ng-motion';
function applyMotion(on) {
  document.body.classList.toggle('motion-off', !on);
  const btn = $('#motionToggle');
  btn.textContent = `动效：${on ? '开' : '关'}`;
  btn.setAttribute('aria-pressed', String(on));
  localStorage.setItem(motionKey, on ? 'on' : 'off');
  if (on) observeReveals(); else $$('.reveal').forEach((el) => el.classList.add('in'));
}
$('#motionToggle').addEventListener('click', () => {
  applyMotion(document.body.classList.contains('motion-off'));
});
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
applyMotion((localStorage.getItem(motionKey) || (prefersReduced ? 'off' : 'on')) === 'on');

function observeReveals() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: .12 });
  $$('.reveal').forEach((el) => io.observe(el));
}

// ---------- 移动端菜单 ----------
const navToggle = $('#navToggle');
const siteNav = $('#siteNav');
navToggle.addEventListener('click', () => {
  const open = siteNav.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', String(open));
});
$$('#siteNav a').forEach((a) => a.addEventListener('click', () => {
  siteNav.classList.remove('open');
  navToggle.setAttribute('aria-expanded', 'false');
}));

// ---------- 数据加载 ----------
async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || res.statusText), { status: res.status, data });
  return data;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

async function loadStyles() {
  const { styles } = await api('/api/styles');
  $('#styleGrid').innerHTML = styles.map((s) => `
    <article class="card reveal"><h3>${esc(s.name)}</h3><p class="muted">${esc(s.desc)}</p></article>`).join('');
  if (!document.body.classList.contains('motion-off')) observeReveals();
}
async function loadCoaches() {
  const { coaches } = await api('/api/coaches');
  $('#coachGrid').innerHTML = coaches.map((c) => `
    <article class="card reveal">
      <h3>${esc(c.name)}</h3>
      <p><span class="tag pink">${esc(c.style || 'Street Dance')}</span></p>
      <p class="muted">${esc(c.bio || '')}</p>
    </article>`).join('');
}
async function loadVideos() {
  const { videos } = await api('/api/achievements');
  $('#videoGrid').innerHTML = videos.length ? videos.map((v) => `
    <article class="card video-card reveal">
      <div class="cover" aria-hidden="true">▶</div>
      <h3>${esc(v.title)}</h3>
      <p class="muted">出演：${esc(v.student_name)}</p>
      <p class="consent">监护人独立授权有效${v.consent_expires_at ? ` · 授权至 ${esc(fmtTime(v.consent_expires_at))}` : ''}</p>
      <button class="btn btn-ghost btn-sm" onclick="watchVideo(${v.id})">受控播放</button>
    </article>`).join('')
    : '<p class="muted">当前暂无处于授权有效期内的成果视频。</p>';
}
window.watchVideo = async function (id) {
  try {
    const data = await api(`/api/media/videos/${id}/stream`);
    alert(`视频流鉴权通过（演示）\n来源标识：${data.source}\n撤下后此入口将返回 410。`);
  } catch (e) {
    alert(e.data?.message || '视频已不可播放');
  }
};

async function loadClasses() {
  const data = await api('/api/classes');
  state.serverTime = data.server_time;
  state.classes = data.classes;
  $('#classGrid').innerHTML = state.classes.map((c) => {
    const ratio = Math.min(1, c.spots_held / c.actual_capacity);
    const remainClass = c.remaining_hint === 0 ? 'full' : c.remaining_hint <= 2 ? 'few' : '';
    const change = c.pending_change ? `<span class="badge-change">⚠ 待确认改期：等待后台确认新安排${c.pending_change.new_venue_id ? '（含换场）' : ''}。你可在确认后选择接受或退出。</span>` : '';
    return `
    <article class="card class-card reveal" data-id="${c.id}">
      <h3>${esc(c.title)}</h3>
      <div class="meta">
        <span>🕒 ${esc(fmtTime(c.start_time))}</span>
        <span>🧑‍🏫 ${esc(c.coach.name)}</span>
        <span>📍 ${esc(c.venue.name)}</span>
      </div>
      <p><span class="tag">${esc(c.age_group.name)} · ${c.age_group.age_min}-${c.age_group.age_max}岁</span></p>
      <div class="capacity-bar" aria-hidden="true"><i style="width:${ratio * 100}%"></i></div>
      <p class="remain">剩余提示：<b class="${remainClass}">${c.remaining_hint}</b> / 实际容量 ${c.actual_capacity} · 候补 ${c.waitlist_count} 人 <br>
        <small>（实际容量解释：${esc(c.capacity_reason)}）</small></p>
      ${change}
      <button class="btn btn-primary btn-sm book-btn" data-id="${c.id}" data-version="${c.version}">${c.remaining_hint > 0 ? '预约试听' : '满员 · 候补报名'}</button>
    </article>`;
  }).join('');
  $$('.book-btn').forEach((btn) => btn.addEventListener('click', () => openModal(Number(btn.dataset.id))));
  if (!document.body.classList.contains('motion-off')) observeReveals();
}

// ---------- 报名弹窗 ----------
const modal = $('#bookingModal');
function openModal(classId) {
  const c = state.classes.find((x) => x.id === classId);
  if (!c) return;
  const f = $('#bookingForm');
  f.reset();
  f.class_id.value = c.id;
  f.expected_version.value = c.version;
  $('#modalClassInfo').textContent = `${c.title}｜${fmtTime(c.start_time)}｜${c.coach.name}｜${c.venue.name}｜${c.age_group.age_min}-${c.age_group.age_max}岁`;
  $('#spotLimitTip').textContent = state.settings.max_active_spots_per_student;
  $('#bookingResult').className = 'result-box';
  $('#bookingResult').textContent = '';
  modal.hidden = false;
  setTimeout(() => f.name.focus(), 50);
}
function closeModal() { modal.hidden = true; }
$$('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

function uuid() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

let submitting = false;
$('#bookingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting) return; // 防重复点击
  const f = e.target;
  const btn = $('#bookingSubmit');
  const result = $('#bookingResult');
  const payload = {
    class_id: Number(f.class_id.value),
    expected_version: Number(f.expected_version.value),
    join_waitlist: f.join_waitlist.checked,
    student: {
      name: f.name.value.trim(),
      phone: f.phone.value.trim(),
      age: Number(f.age.value)
    }
  };
  submitting = true;
  btn.disabled = true;
  btn.textContent = '提交中…';
  result.className = 'result-box show';
  result.textContent = '正在原子核对教练、场地、年龄分组与名额…';
  // 幂等键：防止重复点击/网络重试造成重复占位；失败后清除，允许用新键重试
  const idemStoreKey = `idem-${f.class_id.value}-${payload.student.phone}`;
  const idemKey = sessionStorage.getItem(idemStoreKey) || uuid();
  sessionStorage.setItem(idemStoreKey, idemKey);
  try {
    const data = await api('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
      body: JSON.stringify(payload)
    });
    result.className = 'result-box show ok';
    result.innerHTML = `✅ ${esc(data.message)}<br>预约号 <code>#${data.booking_id}</code>${data.waitlist_rank ? ` · 候补顺位 ${data.waitlist_rank}` : ''}`;
    btn.textContent = data.status === 'confirmed' ? '已确认' : '已加入候补';
    await loadClasses();
  } catch (err) {
    result.className = 'result-box show err';
    let msg = err.data?.message || err.message;
    if (err.data?.error === 'RESOURCE_CHANGED') msg += ' 页面将刷新为最新排课。';
    result.textContent = `❌ ${msg}`;
    if (err.data?.current) {
      // 版本不匹配：用服务端最新数据重渲染，允许用户基于新信息再决定
      setTimeout(loadClasses, 600);
    }
    btn.disabled = false;
    btn.textContent = '确认锁定名额';
    sessionStorage.removeItem(idemStoreKey); // 失败后换一个新幂等键，避免重放旧错误
    submitting = false;
  }
});

// ---------- 候补邀请查询 ----------
$('#inviteQueryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = new FormData(e.target).get('phone');
  const list = $('#inviteList');
  list.innerHTML = '<p class="muted">查询中…</p>';
  try {
    const { invitations } = await api(`/api/my-invitations?phone=${encodeURIComponent(phone)}`);
    if (!invitations.length) { list.innerHTML = '<p class="muted">没有待处理的邀请。若刚收到递补通知，请稍候刷新。</p>'; return; }
    const now = Date.now();
    list.innerHTML = invitations.map((inv) => {
      const exp = Date.parse(inv.invite_expires_at);
      const expired = exp <= now;
      const hours = Math.max(0, Math.round((exp - now) / 3600e3 * 10) / 10);
      return `
      <div class="invite-item ${expired ? 'expired' : ''}">
        <div>
          <strong>${esc(inv.title)}</strong>
          <div class="muted">${esc(fmtTime(inv.start_time))} · ${esc(inv.coach_name)} · ${esc(inv.venue_name)}</div>
          <div class="countdown">${expired ? '邀请已过期，名额已顺延' : `有效期剩余约 ${hours} 小时（至 ${fmtTime(inv.invite_expires_at)}）`}</div>
        </div>
        <div class="invite-actions">
          <button class="btn btn-primary btn-sm" ${expired ? 'disabled' : ''} onclick="answerInvite(${inv.id},'accept')">接受</button>
          <button class="btn btn-ghost btn-sm" ${expired ? 'disabled' : ''} onclick="answerInvite(${inv.id},'decline')">放弃</button>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<p class="muted">查询失败：${esc(err.message)}</p>`;
  }
});

window.answerInvite = async function (id, action) {
  const key = `invite-${action}-${id}`;
  const idem = sessionStorage.getItem(key) || uuid();
  sessionStorage.setItem(key, idem);
  try {
    const data = await api(`/api/invitations/${id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idem }
    });
    alert(data.reused ? '该邀请已处理（重复点击已忽略）' : (action === 'accept' ? '已接受，名额确认！' : '已放弃邀请，名额顺延给下一位。'));
    $$('#inviteQueryForm button')[0].click();
  } catch (err) {
    alert(err.data?.message || err.message);
    $$('#inviteQueryForm button')[0].click();
  }
};

// 启动
(async function init() {
  try {
    const s = await api('/api/age-groups'); // 预热
  } catch (_) {}
  await Promise.all([loadStyles(), loadCoaches(), loadVideos(), loadClasses()]);
})();
