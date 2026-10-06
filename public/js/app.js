const state = {
  sessions: [], coaches: [], venues: [], ageGroups: [], videos: [],
  filterAgeId: null,
  booking: null, // {session, studentId?, idemKey}
};

async function loadAll() {
  try {
    const [coaches, venues, ages, sessions, videos] = await Promise.all([
      api('/api/coaches'), api('/api/venues'), api('/api/age-groups'),
      api('/api/sessions'), api('/api/videos'),
    ]);
    state.coaches = coaches; state.venues = venues; state.ageGroups = ages;
    state.sessions = sessions; state.videos = videos;
    renderCoaches(); renderVenues(); renderAges(); renderFilters(); renderSessions(); renderVideos();
  } catch (e) {
    document.getElementById('sessionGrid').innerHTML =
      `<p class="tag red">加载失败：${esc(e.message)}（信息读取不依赖动画，但需要网络）</p>`;
  }
}

function renderCoaches() {
  document.getElementById('coachGrid').innerHTML = state.coaches.map((c) => `
    <article class="card fade-up">
      <h3>${esc(c.name)} <span class="tag pink">${esc(c.style || '—')}</span></h3>
      <p class="muted">${esc(c.bio || '资深街舞教练')}</p>
    </article>`).join('');
}
function renderVenues() {
  document.getElementById('venueGrid').innerHTML = state.venues.map((v) => `
    <article class="card fade-up">
      <h3>${esc(v.name)}</h3>
      <p class="muted">${esc(v.address)}</p>
      <p class="muted-small">场地容量 ${v.capacity} 人 · ${esc(v.notes || '')}</p>
    </article>`).join('');
}
function renderAges() {
  document.getElementById('ageGrid').innerHTML = state.ageGroups.map((a) => `
    <article class="card fade-up">
      <h3>${esc(a.name)}</h3>
      <p class="muted">适龄 ${a.min_age}–${a.max_age >= 99 ? '不限' : a.max_age} 岁</p>
    </article>`).join('');
}
function renderFilters() {
  const el = document.getElementById('ageFilter');
  el.innerHTML = `<button class="chip ${state.filterAgeId == null ? 'active' : ''}" data-age="">全部年龄</button>` +
    state.ageGroups.map((a) =>
      `<button class="chip ${state.filterAgeId === a.id ? 'active' : ''}" data-age="${a.id}">${esc(a.name)}</button>`).join('');
  el.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.age; state.filterAgeId = v ? Number(v) : null; renderFilters(); renderSessions();
  }));
}

function renderSessions() {
  const list = state.sessions.filter((s) => !state.filterAgeId || s.ageGroup?.id === state.filterAgeId);
  const grid = document.getElementById('sessionGrid');
  if (!list.length) { grid.innerHTML = '<p class="muted">近期没有符合条件的公开试听。</p>'; return; }
  grid.innerHTML = list.map((s) => {
    const ratio = Math.min(100, Math.round((s.holds / s.capacity) * 100));
    const full = s.holds >= s.capacity;
    const capText = full
      ? `已满 · 候补 ${s.waitlist} 人`
      : `剩余 ${s.remainingHint} / ${s.capacity}（提示值）`;
    return `
    <article class="card session-card fade-up">
      <div>
        <h3>${esc(s.title)} <span class="tag ${s.style ? 'pink' : ''}">${esc(s.style || '')}</span></h3>
        <div class="session-meta">
          <span>🕒 ${fmtTime(s.startAt)}–${String(new Date(s.endAt).getHours()).padStart(2, '0')}:${String(new Date(s.endAt).getMinutes()).padStart(2, '0')}</span>
          <span>👟 ${esc(s.coach?.name || '待定')}</span>
          <span>📍 ${esc(s.venue?.name)}</span>
          <span>👧 ${esc(s.ageGroup?.name || '全年龄')}</span>
        </div>
      </div>
      <div>
        <div class="cap-bar ${full ? 'full' : ''}" role="img" aria-label="已占位 ${s.holds} 人，上限 ${s.capacity} 人"><i style="width:${ratio}%"></i></div>
        <div class="cap-note">${capText} · 候补方式：${s.waitlistMode === 'auto' ? '空位自动递补' : '管理员人工邀请（有效期 24 小时）'}</div>
      </div>
      <div class="row" style="align-items:center">
        <button class="btn btn-primary" data-book="${s.id}">${full ? '加入候补' : '预约试听'}</button>
        <span class="muted-small">确认时原子核对：容量/教练/场地/每人 2 场上限</span>
      </div>
    </article>`;
  }).join('');
  grid.querySelectorAll('[data-book]').forEach((b) =>
    b.addEventListener('click', () => openBookModal(Number(b.dataset.book))));
}

function renderVideos() {
  const grid = document.getElementById('videoGrid');
  if (!state.videos.length) { grid.innerHTML = '<p class="muted">暂无可展示的成果视频。</p>'; return; }
  grid.innerHTML = state.videos.map((v) => `
    <article class="card video-card fade-up">
      ${v.coverAssetId
        ? `<img class="video-cover" src="/api/assets/${v.coverAssetId}" alt="${esc(v.title)} 封面">`
        : '<div class="video-cover"></div>'}
      <div class="video-body">
        <h3>${esc(v.title)}</h3>
        <p class="muted-small">${v.clipAssetIds.length} 个高光片段 · 授权${v.consentExpiresAt ? '至 ' + fmtTime(v.consentExpiresAt) : '长期有效'}</p>
        <button class="btn btn-cyan small play-btn" data-video="${v.id}">观看片段</button>
        <div class="consent-note">监护人独立授权 · 到期/撤销后封面、片段、分享入口同步关闭</div>
      </div>
    </article>`).join('');
  grid.querySelectorAll('[data-video]').forEach((b) =>
    b.addEventListener('click', () => openVideo(Number(b.dataset.video))));
}

/* ---------------- 预约弹层 ---------------- */

function openBookModal(sessionId) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  state.booking = { session: s };
  document.getElementById('bookSessionInfo').textContent =
    `${s.title}｜${fmtTime(s.startAt)}｜${s.coach?.name}｜${s.venue?.name}｜${s.ageGroup?.name || '全年龄'}`;
  ['bkName', 'bkAge', 'bkContact'].forEach((id) => (document.getElementById(id).value = ''));
  const result = document.getElementById('bookResult');
  result.className = 'result'; result.textContent = '';
  document.getElementById('bookModal').classList.add('open');
}
function closeBookModal() { document.getElementById('bookModal').classList.remove('open'); }

async function submitBooking() {
  const { session } = state.booking;
  const name = document.getElementById('bkName').value.trim();
  const age = Number(document.getElementById('bkAge').value) || null;
  const contact = document.getElementById('bkContact').value.trim();
  const result = document.getElementById('bookResult');
  if (!name || !contact) {
    result.className = 'result show err'; result.textContent = '请填写姓名与监护人联系方式。';
    return;
  }
  const btn = document.getElementById('bookSubmit');
  btn.disabled = true; // 锁定按钮，避免重复点击挤满名额
  try {
    // 同一浏览器内同一提交生成稳定幂等键；后端也有唯一索引兜底
    const idemKey = `idem_${session.id}_${name}_${contact}_${new Date().toDateString()}`;
    let studentId = Number(sessionStorage.getItem('groove:studentId')) || null;
    if (!studentId) {
      const st = await api('/api/students', { method: 'POST', body: { name, contact, age } });
      studentId = st.id; sessionStorage.setItem('groove:studentId', String(studentId));
    }
    const r = await api('/api/bookings', {
      method: 'POST',
      body: { sessionId: session.id, studentId, idemKey },
    });
    result.className = 'result show ' + (r.waitlisted ? 'info' : 'ok');
    let msg = r.hint + `\n学员编号：${studentId}（可在“我的预约”查询）\n预约编号：${r.booking.id}，状态：${r.status || r.booking.status}`;
    if (r.deduped) msg = '该提交已处理（幂等返回），未重复占位。\n' + msg;
    result.textContent = msg;
    await loadAll();
  } catch (e) {
    result.className = 'result show err';
    result.textContent = `预约未成功：${e.message}${e.status === 409 ? '\n（后台已保证不会超额占位，可重试或加入候补）' : ''}`;
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- 视频弹层 ---------------- */

async function openVideo(videoId) {
  const v = await api('/api/videos/' + videoId);
  document.getElementById('vmTitle').textContent = v.title;
  const sourceNote = v.hasSource
    ? '<p class="muted-small">演示环境正片为占位素材；生产环境此处为转码后的正片播放器。</p>'
    : '<p class="muted-small">正片转码中，当前可观看已授权的封面与片段。</p>';
  document.getElementById('vmPlayer').innerHTML =
    (v.coverAssetId ? `<img class="player" src="/api/assets/${v.coverAssetId}" alt="${esc(v.title)}（授权展示封面）">` : '<div class="player"></div>') + sourceNote;
  document.getElementById('vmClips').innerHTML = v.clipAssetIds
    .map((id) => `<button class="clip-thumb" data-asset="${id}"><img src="/api/assets/${id}" alt="片段封面"><span>已授权片段 ▶</span></button>`)
    .join('');
  document.getElementById('vmClips').querySelectorAll('[data-asset]').forEach((b) =>
    b.addEventListener('click', () => { window.open('/api/assets/' + b.dataset.asset, '_blank', 'noopener'); }));
  document.getElementById('vmConsent').textContent =
    `授权状态：${v.consentStatus === 'active' ? '有效' : v.consentStatus}` +
    (v.consentExpiresAt ? `；有效期至 ${fmtTime(v.consentExpiresAt)}；撤销后封面/片段/分享立即失效。` : '；长期授权，可随时撤销。');
  const shareBox = document.getElementById('vmShare');
  shareBox.innerHTML = `
    <div class="notice cyan">需要把成果发给亲友？请让管理员为该视频生成<strong>分享入口</strong>（撤销授权时所有分享链接同时失效）。
    也可访问 <a href="/share.html">分享页</a> 输入 token。</div>`;
  document.getElementById('videoModal').classList.add('open');
}

/* ---------------- 我的预约 ---------------- */

const STATUS_TEXT = {
  booked: '已确认占位', waitlisted: '候补中', invited: '邀请中（待接受）',
  pending_change: '场次改期待确认', cancelled: '已取消', declined: '已拒绝邀请',
  expired: '邀请已过期', confirmed: '已确认',
};
async function loadMine() {
  const studentId = Number(document.getElementById('myId').value) ||
    Number(sessionStorage.getItem('groove:studentId'));
  const el = document.getElementById('mineList');
  if (!studentId) { el.innerHTML = '<p class="tag amber">请输入学员编号</p>'; return; }
  try {
    const list = await api(`/api/students/${studentId}/bookings`);
    if (!list.length) { el.innerHTML = '<p class="muted">暂无预约记录。</p>'; return; }
    el.innerHTML = list.map((b) => {
      let actions = '';
      if (b.status === 'invited') {
        actions = `
          <div class="notice">您收到候补递补邀请（${fmtCountdown(b.inviteExpiresAt)}）。接受前后台会再次核对名额与资源。</div>
          <button class="btn btn-cyan small" data-act="acceptInvite" data-id="${b.id}">接受邀请</button>
          <button class="btn btn-ghost small" data-act="declineInvite" data-id="${b.id}">婉拒</button>`;
      } else if (b.status === 'pending_change') {
        const old = b.oldSessionSnapshot;
        actions = `
          <div class="notice">原安排：${old ? fmtTime(old.startAt) + ' · ' + esc(old.coach?.name || '') + ' · ' + esc(old.venue?.name || '') : ''}<br>
          新安排：${fmtTime(b.startAt)} · ${esc(b.coachName)} · ${esc(b.venueName)}。名额为你保留至确认。</div>
          <button class="btn btn-cyan small" data-act="confirmChange" data-id="${b.id}">接受改期</button>
          <button class="btn btn-ghost small" data-act="declineChange" data-id="${b.id}">无法参加，取消</button>`;
      } else if (['booked', 'waitlisted'].includes(b.status)) {
        actions = `<button class="btn btn-ghost small" data-act="cancel" data-id="${b.id}">取消${b.status === 'waitlisted' ? '候补' : '预约'}</button>`;
      }
      return `
      <div class="booking-row">
        <strong>${esc(b.sessionTitle)}</strong>
        <span class="status-pill s-${b.status}">${STATUS_TEXT[b.status] || b.status}</span>
        <div class="muted-small">${fmtTime(b.startAt)} 开始 · ${esc(b.coachName || '')} · ${esc(b.venueName || '')}${b.inviteExpiresAt ? ' · ' + fmtCountdown(b.inviteExpiresAt) : ''}</div>
        <div class="actions">${actions}</div>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-act]').forEach((btn) =>
      btn.addEventListener('click', () => actMine(btn.dataset.act, btn.dataset.id, studentId)));
  } catch (e) {
    el.innerHTML = `<p class="tag red">查询失败：${esc(e.message)}</p>`;
  }
}
async function actMine(act, id, studentId) {
  const map = {
    acceptInvite: ['POST', `/api/invites/${id}/accept`],
    declineInvite: ['POST', `/api/invites/${id}/decline`],
    confirmChange: ['POST', `/api/bookings/${id}/confirm-change`],
    declineChange: ['POST', `/api/bookings/${id}/decline-change`],
    cancel: ['POST', `/api/bookings/${id}/cancel`],
  };
  const [method, url] = map[act];
  try {
    await api(url, { method, body: { studentId } });
    await loadMine();
    await loadAll();
  } catch (e) {
    alert('操作失败：' + e.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('bookCancel').addEventListener('click', closeBookModal);
  document.getElementById('bookSubmit').addEventListener('click', submitBooking);
  document.getElementById('vmClose').addEventListener('click', () =>
    document.getElementById('videoModal').classList.remove('open'));
  document.getElementById('loadMine').addEventListener('click', loadMine);
  document.querySelectorAll('.modal-backdrop').forEach((m) =>
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); }));
  const savedId = sessionStorage.getItem('groove:studentId');
  if (savedId) document.getElementById('myId').value = savedId;
  loadAll();
});
