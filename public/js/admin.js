const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let token = localStorage.getItem('groove:adminToken') || 'dev-admin-token';
$('#adminToken').value = token;

const A = async (path, options = {}) =>
  api('/api/admin' + path, {
    ...options,
    headers: { ...(options.headers || {}), 'X-Admin-Token': token },
  });

const cache = { sessions: [], venues: [], coaches: ages0(), ages: [], videos: [] };
function ages0() { return []; }

function toast(el, msg, kind = 'info') {
  el.className = 'result show ' + kind;
  el.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
}

/* Tabs */
$$('.admin-tab').forEach((t) => t.addEventListener('click', () => {
  $$('.admin-tab').forEach((x) => x.classList.remove('active'));
  $$('.admin-panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.add('active');
  refresh();
}));

$('#saveToken').addEventListener('click', () => {
  token = $('#adminToken').value.trim(); localStorage.setItem('groove:adminToken', token);
  refresh();
});
$('#refreshAll').addEventListener('click', refresh);

/* ---------------- 加载 ---------------- */
async function refresh() {
  try {
    const [sessions, venues, coaches, ages, videos] = await Promise.all([
      A('/sessions'), A('/venues'), A('/coaches'), A('/age-groups'), A('/videos'),
    ]);
    cache.sessions = sessions; cache.venues = venues; cache.coaches = coaches;
    cache.ages = ages; cache.videos = videos;
    renderOverview(); renderSessionsAdmin(); renderPending(); renderWaitlist();
    renderVideos(); renderResources(); fillSelects();
  } catch (e) {
    if (e.status === 401) alert('管理令牌无效，请在顶部输入正确令牌。');
    else console.error(e);
  }
}

function fillSelects() {
  const optsVenue = cache.venues.map((v) => `<option value="${v.id}">${esc(v.name)}（容量${v.capacity}）</option>`).join('');
  const optsCoach = cache.coaches.map((c) => `<option value="${c.id}">${esc(c.name)} · ${esc(c.style)}</option>`).join('');
  const optsAge = '<option value="">不限</option>' + cache.ages.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  $('#nsVenue').innerHTML = optsVenue; $('#nsCoach').innerHTML = optsCoach; $('#nsAge').innerHTML = optsAge;
}

/* ---------------- 总览 / 实际容量 ---------------- */
function countsFor(s) {
  return {
    cap: s.capacity,
    holds: s.holds,                 // booked + invited + pending_change
    remaining: Math.max(0, s.capacity - s.holds),
    waitlist: s.waitlist,
  };
}
function renderOverview() {
  const open = cache.sessions;
  const totalCap = open.reduce((a, s) => a + s.capacity, 0);
  const totalHolds = open.reduce((a, s) => a + s.holds, 0);
  const totalWait = open.reduce((a, s) => a + s.waitlist, 0);
  $('#kpis').innerHTML = [
    ['开放场次', open.length],
    ['总容量上限', totalCap],
    ['实际占位', totalHolds],
    ['真正剩余', totalCap - totalHolds],
    ['候补人数（不占位）', totalWait],
  ].map(([k, v]) => `<div class="kpi"><b>${v}</b><span class="muted-small">${k}</span></div>`).join('');

  $('#overviewSessions').innerHTML = `<table class="admin-table">
    <thead><tr><th>场次</th><th>时间</th><th>教练 / 场地</th><th>容量</th><th>实际占位</th><th>真正剩余</th><th>候补</th><th>说明</th></tr></thead>
    <tbody>${open.map((s) => {
      const c = countsFor(s);
      return `<tr>
        <td>${esc(s.title)}<br><span class="muted-small">${esc(s.ageGroup?.name || '全年龄')} · ${s.waitlistMode === 'auto' ? '自动递补' : '人工邀请'}</span></td>
        <td>${fmtTime(s.startAt)}</td>
        <td>${esc(s.coach?.name)}<br><span class="muted-small">${esc(s.venue?.name)}</span></td>
        <td>${c.cap}</td>
        <td><b>${c.holds}</b><div class="muted-small">booked/invited/待改期</div></td>
        <td><b class="${c.remaining === 0 ? '' : ''}" style="color:${c.remaining === 0 ? 'var(--amber)' : 'var(--green)'}">${c.remaining}</b></td>
        <td>${c.waitlist}</td>
        <td class="muted-small">前台卡片剩余仅提示；<br>确认时以事务核对为准</td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

/* ---------------- 场次管理 ---------------- */
function renderSessionsAdmin() {
  $('#sessionAdminList').innerHTML = cache.sessions.map((s) => `
    <details class="sub" data-sid="${s.id}">
      <summary>${esc(s.title)} · ${fmtTime(s.startAt)} · 占位 ${s.holds}/${s.capacity} · 候补 ${s.waitlist}</summary>
      <div style="margin-top:10px">
        <div class="row">
          <div><label>教练（可改=代课）</label>
            <select data-f="coachId">${cache.coaches.map((c) => `<option value="${c.id}" ${c.id === s.coach?.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div><label>场地（可改=临时换场）</label>
            <select data-f="venueId">${cache.venues.map((v) => `<option value="${v.id}" ${v.id === s.venue?.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>
        </div>
        <div class="row">
          <div><label>开始</label><input type="datetime-local" data-f="startAt" value="${toLocal(s.startAt)}"></div>
          <div><label>结束</label><input type="datetime-local" data-f="endAt" value="${toLocal(s.endAt)}"></div>
        </div>
        <div class="row">
          <div><label>容量</label><input type="number" data-f="capacity" value="${s.capacity}"></div>
          <div><label>候补方式</label><select data-f="waitlistMode">
            <option value="auto" ${s.waitlistMode === 'auto' ? 'selected' : ''}>自动递补</option>
            <option value="manual" ${s.waitlistMode === 'manual' ? 'selected' : ''}>人工邀请</option>
          </select></div>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn btn-cyan small" data-act="save">保存修改</button>
          <button class="btn btn-ghost small" data-act="cancel-session">取消整场</button>
        </div>
        <div class="result" data-role="msg"></div>
        <h4 style="margin-top:12px">名单（${s.holds + s.waitlist} 人活动中）</h4>
        <div data-role="bookings">加载中…</div>
      </div>
    </details>`).join('');

  $$('#sessionAdminList details').forEach((d) => {
    const sid = Number(d.dataset.sid);
    d.addEventListener('toggle', function () {
      if (this.open) loadBookings(sid, this);
    }, { once: false });
    d.querySelector('[data-act="save"]').addEventListener('click', () => saveSession(sid, d));
    d.querySelector('[data-act="cancel-session"]').addEventListener('click', async () => {
      if (!confirm('确定取消整场？所有预约与候补都会被取消。')) return;
      try {
        await A(`/sessions/${sid}/cancel`, { method: 'POST', body: { reason: '管理员取消整场' } });
        await refresh();
      } catch (e) { alert(e.message); }
    });
  });
}

async function loadBookings(sid, root) {
  const detail = await A('/sessions/' + sid);
  root.querySelector('[data-role="bookings"]').innerHTML = detail.bookings.length
    ? `<table class="admin-table"><thead><tr><th>学员</th><th>联系方式</th><th>状态</th><th>候补位/到期</th><th>操作</th></tr></thead>
      <tbody>${detail.bookings.map((b) => `
        <tr>
          <td>${esc(b.studentName)}</td><td>${esc(b.studentContact)}</td>
          <td><span class="status-pill s-${b.status}">${b.status}</span>${b.staleSchedule ? '<div class="muted-small">基于旧版安排</div>' : ''}</td>
          <td>${b.position ? '#' + b.position : ''}${b.inviteExpiresAt ? '<br>' + fmtTime(b.inviteExpiresAt) : ''}</td>
          <td>${b.status === 'waitlisted' && detail.waitlistMode === 'manual'
              ? `<button class="btn btn-cyan small" data-invite="${b.id}">邀请</button>` : ''}
            ${b.status === 'invited'
              ? `<button class="btn btn-ghost small" data-revoke="${b.id}">撤下邀请</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>`
    : '<p class="muted-small">无</p>';
  root.querySelectorAll('[data-invite]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      const inv = await A(`/sessions/${sid}/invite`, { method: 'POST', body: { bookingId: Number(btn.dataset.invite) } });
      toast(root.querySelector('[data-role="msg"]'),
        `已邀请（${fmtCountdown(inv.inviteExpiresAt)}）。接受链接（演示用）：${location.origin}/#sessions  学员在“我的预约”接受；接口路径 POST ${inv.acceptPath}`, 'ok');
      await loadBookings(sid, root);
    } catch (e) { alert(e.message); }
  }));
  root.querySelectorAll('[data-revoke]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await A(`/bookings/${btn.dataset.revoke}/revoke-invite`, { method: 'POST', body: {} });
      await loadBookings(sid, root);
    } catch (e) { alert(e.message); }
  }));
}

async function saveSession(sid, d) {
  const body = {
    coachId: Number(d.querySelector('[data-f="coachId"]').value),
    venueId: Number(d.querySelector('[data-f="venueId"]').value),
    startAt: new Date(d.querySelector('[data-f="startAt"]').value).getTime(),
    endAt: new Date(d.querySelector('[data-f="endAt"]').value).getTime(),
    capacity: Number(d.querySelector('[data-f="capacity"]').value),
    waitlistMode: d.querySelector('[data-f="waitlistMode"]').value,
  };
  const msg = d.querySelector('[data-role="msg"]');
  try {
    const r = await A('/sessions/' + sid, { method: 'PATCH', body });
    toast(msg,
      (r.scheduleChanged ? '安排已变更：已确认学员进入待确认改期、邀请退回候补。' : '场次信息已更新。') +
      (r.promoted?.length ? ` 自动递补了 ${r.promoted.length} 人。` : ''), 'ok');
    await refresh();
  } catch (e) { toast(msg, '保存失败：' + e.message, 'err'); }
}

function toLocal(ts) {
  const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

$('#nsCreate').addEventListener('click', async () => {
  const body = {
    title: $('#nsTitle').value.trim(), style: $('#nsStyle').value.trim(),
    coachId: Number($('#nsCoach').value), venueId: Number($('#nsVenue').value),
    ageGroupId: $('#nsAge').value ? Number($('#nsAge').value) : null,
    startAt: new Date($('#nsStart').value).getTime(),
    endAt: new Date($('#nsEnd').value).getTime(),
    capacity: Number($('#nsCap').value), waitlistMode: $('#nsMode').value,
  };
  try {
    await A('/sessions', { method: 'POST', body });
    toast($('#nsResult'), '已创建', 'ok');
    await refresh();
  } catch (e) { toast($('#nsResult'), e.message, 'err'); }
});

/* ---------------- 待确认改期 ---------------- */
async function renderPending() {
  try {
    const list = await A('/pending-changes');
    $('#pendingList').innerHTML = list.length
      ? list.map((p) => `
        <div class="booking-row">
          <strong>${esc(p.studentName)}</strong> <span class="muted-small">${esc(p.contact)}</span>
          <div class="muted-small">${esc(p.sessionTitle)} → 新时间 ${fmtTime(p.newStartAt)}（自 ${fmtTime(p.since)} 起等待确认）</div>
          <div class="muted-small">名额保留中；学员接受前不会被候补拿走。学员拒绝则释放并按模式递补。</div>
        </div>`).join('')
      : '<p class="muted">没有待确认的改期。</p>';
  } catch { /* ignore until tab active */ }
}

/* ---------------- 候补视图 ---------------- */
function renderWaitlist() {
  const manual = cache.sessions;
  $('#waitlistView').innerHTML = manual.map((s) => {
    const c = countsFor(s);
    return `<details class="sub"><summary>${esc(s.title)}（${s.waitlistMode === 'auto' ? '自动递补' : '人工邀请'}）占位 ${c.holds}/${c.cap}，候补 ${c.waitlist}</summary>
      <div data-wl="${s.id}" style="margin-top:8px">打开查看并操作候补…</div></details>`;
  }).join('');
  $$('#waitlistView details').forEach((d) => {
    d.addEventListener('toggle', function () {
      if (this.open) {
        const sid = Number(this.dataset.wl || this.querySelector('[data-wl]').dataset.wl);
        loadWaitlist(sid, this.querySelector('[data-wl]'));
      }
    });
  });
}
async function loadWaitlist(sid, el) {
  const detail = await A('/sessions/' + sid);
  el.innerHTML = detail.bookings.length
    ? detail.bookings.map((b) => `
      <div class="booking-row">
        <strong>${esc(b.studentName)}</strong> <span class="status-pill s-${b.status}">${b.status}</span>
        <div class="muted-small">${esc(b.studentContact)}${b.position ? ' · 候补位 #' + b.position : ''}${b.inviteExpiresAt ? ' · 邀请到期 ' + fmtTime(b.inviteExpiresAt) + '（' + fmtCountdown(b.inviteExpiresAt) + '）' : ''}</div>
        <div class="actions">
          ${b.status === 'waitlisted' && detail.waitlistMode === 'manual' ? `<button class="btn btn-cyan small" data-act="invite" data-id="${b.id}">邀请（占位 24h）</button>` : ''}
          ${b.status === 'invited' ? `<button class="btn btn-ghost small" data-act="revoke" data-id="${b.id}">撤下邀请（退回候补）</button>` : ''}
          ${detail.waitlistMode === 'auto' ? '<span class="muted-small">自动模式：空位出现即自动递补，无需人工操作。</span>' : ''}
        </div>
      </div>`).join('')
    : '<p class="muted-small">无名单</p>';
  el.querySelectorAll('[data-act="invite"]').forEach((btn) => btn.addEventListener('click', async () => {
    try { await A(`/sessions/${sid}/invite`, { method: 'POST', body: { bookingId: Number(btn.dataset.id) } }); await loadWaitlist(sid, el); await refresh(); }
    catch (e) { alert(e.message); }
  }));
  el.querySelectorAll('[data-act="revoke"]').forEach((btn) => btn.addEventListener('click', async () => {
    try { await A(`/bookings/${btn.dataset.id}/revoke-invite`, { method: 'POST', body: {} }); await loadWaitlist(sid, el); await refresh(); }
    catch (e) { alert(e.message); }
  }));
}
$('#sweepInvites').addEventListener('click', async () => {
  const r = await A('/sweep/invites', { method: 'POST' });
  alert('过期邀请已清扫：' + (r.expired.length ? r.expired.join(', ') : '无'));
  refresh();
});

/* ---------------- 视频管理 / 撤下进度 ---------------- */
function renderVideos() {
  $('#videoAdminList').innerHTML = cache.videos.map((v) => {
    const rm = v.removal || {};
    const revoked = v.consentStatus === 'revoked';
    const steps = [
      ['分享入口', rm.shares], ['封面', rm.cover], ['片段', rm.clips], ['服务端文件', rm.files],
    ].map(([name, ts]) => `<span class="step ${ts ? 'done' : ''}">${ts ? '✓' : '○'} ${name}${ts ? ' ' + fmtTime(ts) : ''}</span>`).join('');
    return `
    <details class="sub" data-vid="${v.id}" ${revoked ? 'open' : ''}>
      <summary>#${v.id} ${esc(v.title)}
        <span class="tag ${v.consentStatus === 'active' ? 'green' : v.consentStatus === 'revoked' ? 'red' : 'amber'}">${v.consentStatus}</span>
        ${v.published ? '<span class="tag cyan">已发布</span>' : ''}</summary>
      <div style="margin-top:10px">
        <div class="muted-small">源文件：${v.hasSource ? '已上传' : '缺失'} · 授权轮次 epoch=${v.consentEpoch} ·
          ${v.consentExpiresAt ? '到期 ' + fmtTime(v.consentExpiresAt) : '长期授权'}</div>
        <div class="clip-list" style="margin:8px 0">
          ${v.coverAssetId ? `<img src="/api/assets/${v.coverAssetId}" style="width:160px;border-radius:8px;border:1px solid var(--line)" alt="封面">` : '<span class="muted-small">无封面</span>'}
          ${v.clipAssetIds.map((id) => `<img src="/api/assets/${id}" style="width:160px;border-radius:8px;border:1px solid var(--line)" alt="片段">`).join('')}
        </div>
        <div class="row">
          <label>授权有效期（留空=长期；用于“可到期”）<input type="datetime-local" data-f="expiry"></label>
        </div>
        <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          ${!revoked ? `<button class="btn btn-cyan small" data-act="grant">${v.consentStatus === 'active' ? '重新授权(轮次+1)' : '授予独立授权并发布'}</button>` : ''}
          <button class="btn btn-ghost small" data-act="transcode">发起转码</button>
          <button class="btn btn-ghost small" data-act="complete">模拟转码完成（测试迟到任务）</button>
          <button class="btn btn-ghost small" data-act="share">生成分享入口</button>
          ${!revoked ? `<button class="btn btn-ghost small" data-act="unpublish">下架（仅取消发布）</button>
          <button class="btn btn-cyan small" style="border-color:var(--red);color:var(--red)" data-act="revoke">撤销授权并彻底撤下</button>` : ''}
        </div>
        <label>撤销原因（会进入审计日志）<input data-f="reason" placeholder="如：监护人撤回授权"></label>
        <div class="result" data-role="msg"></div>
        ${revoked ? `<div class="notice red" style="margin-top:10px">
          撤下进度：<div class="progress-steps">${steps}</div>
          <div class="muted-small" style="margin-top:6px">撤销时间 ${fmtTime(rm.revokedAt)}；原因：${esc(rm.reason || '—')}</div>
          <div class="muted-small">⚠ ${esc(rm.externalCopiesNotice)}</div>
        </div>` : ''}
        <div data-role="detail" style="margin-top:10px"></div>
      </div>
    </details>`;
  }).join('');

  $$('#videoAdminList details').forEach((d) => {
    const vid = Number(d.dataset.vid);
    d.addEventListener('toggle', function () { if (this.open) loadVideoDetail(vid, this); });
    const act = (name, fn) => d.querySelector(`[data-act="${name}"]`)?.addEventListener('click', fn);
    act('grant', async () => {
      const v = d.querySelector('[data-f="expiry"]').value;
      try {
        await A(`/videos/${vid}/consent`, { method: 'POST', body: { expiresAt: v ? new Date(v).getTime() : null } });
        await refreshAfterVideo(vid, d, '授权已生效（新轮次），旧转码任务将作废');
      } catch (e) { alert(e.message); }
    });
    act('transcode', async () => {
      try { await A(`/videos/${vid}/transcode`, { method: 'POST' }); await loadVideoDetail(vid, d); } catch (e) { alert(e.message); }
    });
    act('complete', async () => {
      try {
        const detail = await A('/videos/' + vid);
        const queued = detail.jobs.find((j) => j.status === 'queued' || j.status === 'processing');
        if (!queued) return alert('没有 queued/processing 的任务');
        const r = await A(`/jobs/${queued.id}/complete`, { method: 'POST' });
        alert(r.status === 'rejected' ? '任务被作废：' + r.reject_reason : '转码完成，产出 asset #' + r.output_asset_id);
        await loadVideoDetail(vid, d);
      } catch (e) { alert(e.message); }
    });
    act('share', async () => {
      try {
        const r = await A(`/videos/${vid}/shares`, { method: 'POST' });
        const url = `${location.origin}/share.html?token=${encodeURIComponent(r.token)}`;
        const msg = d.querySelector('[data-role="msg"]');
        toast(msg, `分享入口已生成：\n${url}`, 'ok');
        await loadVideoDetail(vid, d);
      } catch (e) { alert(e.message); }
    });
    act('unpublish', async () => { await A(`/videos/${vid}/publish`, { method: 'POST', body: { published: false } }); await refresh(); });
    act('revoke', async () => {
      const reason = d.querySelector('[data-f="reason"]').value.trim();
      if (!confirm('确认撤销？封面、片段、分享入口将立即关闭，服务端文件会被删除，且不可恢复授权。')) return;
      const r = await A(`/videos/${vid}/revoke`, { method: 'POST', body: { reason } });
      await refresh();
      alert(`已撤下。删除服务端文件 ${r.deletedFiles}/${r.totalFiles}。\n注意：外部已下载副本无法远程抹除，需联系持有人。`);
    });
  });
}

async function loadVideoDetail(vid, d) {
  const detail = await A('/videos/' + vid);
  d.querySelector('[data-role="detail"]').innerHTML = `
    <div class="muted-small">转码任务：</div>
    <table class="admin-table"><thead><tr><th>#</th><th>状态</th><th>epoch</th><th>产物</th><th>备注</th></tr></thead>
    <tbody>${detail.jobs.map((j) => `<tr><td>${j.id}</td><td>${j.status}</td><td>${j.consent_epoch}</td>
      <td>${j.output_asset_id ? 'asset #' + j.output_asset_id : '—'}</td>
      <td class="muted-small">${esc(j.reject_reason || '')}${j.finished_at ? '<br>' + fmtTime(j.finished_at) : ''}</td></tr>`).join('') || '<tr><td colspan=5>无</td></tr>'}</tbody></table>
    <div class="muted-small" style="margin-top:8px">分享入口：</div>
    ${detail.shares.map((s) => `<div class="booking-row">${s.status === 'active'
      ? `<a href="/share.html?token=${encodeURIComponent(s.token)}" target="_blank">${esc(s.token.slice(0, 18))}…</a> <span class="tag green">active</span>
         <button class="btn btn-ghost small" data-share-revoke="${s.id}">关闭该分享</button>`
      : `<span class="tag red">${s.status}</span>`}</div>`).join('') || '<div class="muted-small">无分享入口</div>'}`;
  d.querySelectorAll('[data-share-revoke]').forEach((b) => b.addEventListener('click', async () => {
    await A('/shares/' + b.dataset.shareRevoke + '/revoke', { method: 'POST' });
    await loadVideoDetail(vid, d); await refresh();
  }));
}

async function refreshAfterVideo(vid, d, msgText) {
  await refresh();
  const nd = document.querySelector(`#videoAdminList details[data-vid="${vid}"]`);
  if (nd) { nd.open = true; toast(nd.querySelector('[data-role="msg"]'), msgText, 'ok'); await loadVideoDetail(vid, nd); }
}

$('#nvCreate').addEventListener('click', async () => {
  const title = $('#nvTitle').value.trim();
  if (!title) return;
  await A('/videos', { method: 'POST', body: { title } });
  $('#nvTitle').value = '';
  await refresh();
});

/* ---------------- 基础资源 ---------------- */
function renderResources() {
  $('#resourceLists').innerHTML = `
    <div class="grid cols-3">
      <div class="card"><h3>场地</h3>${cache.venues.map((v) =>
        `<div class="booking-row">${esc(v.name)}<div class="muted-small">${esc(v.address)} · 容量 ${v.capacity} · ${v.active ? '启用' : '停用'}</div></div>`).join('')}</div>
      <div class="card"><h3>教练</h3>${cache.coaches.map((c) =>
        `<div class="booking-row">${esc(c.name)} <span class="tag pink">${esc(c.style)}</span><div class="muted-small">${c.active ? '启用' : '停用'}</div></div>`).join('')}</div>
      <div class="card"><h3>年龄分组</h3>${cache.ages.map((a) =>
        `<div class="booking-row">${esc(a.name)}<div class="muted-small">${a.min_age}–${a.max_age >= 99 ? '不限' : a.max_age} 岁</div></div>`).join('')}</div>
    </div>`;
}
$('#createVenue').addEventListener('click', async () => {
  await A('/venues', { method: 'POST', body: { name: $('#nvName').value, address: $('#nvAddr').value, capacity: Number($('#nvCap2').value) } });
  refresh();
});
$('#createCoach').addEventListener('click', async () => {
  await A('/coaches', { method: 'POST', body: { name: $('#ncName').value, style: $('#ncStyle').value, bio: $('#ncBio').value } });
  refresh();
});
$('#createAge').addEventListener('click', async () => {
  await A('/age-groups', { method: 'POST', body: { name: $('#naName').value, minAge: Number($('#naMin').value), maxAge: Number($('#naMax').value) } });
  refresh();
});

/* ---------------- 审计 ---------------- */
$('#loadAudit').addEventListener('click', loadAudit);
async function loadAudit() {
  const logs = await A('/audit');
  $('#auditList').innerHTML = `<table class="admin-table"><thead><tr><th>时间</th><th>事件</th><th>对象</th><th>详情</th></tr></thead>
    <tbody>${logs.map((l) => `<tr><td>${fmtTime(l.created_at)}</td><td>${esc(l.event)}</td><td>${esc(l.entity)} #${l.entity_id ?? ''}</td>
      <td class="muted-small">${esc(l.detail)}</td></tr>`).join('')}</tbody></table>`;
}

/* 周期性刷新（邀请倒计时、撤下状态）；纯信息更新，不依赖动画 */
setInterval(() => {
  const active = $('.admin-panel.active')?.id;
  if (active === 'tab-waitlist' || active === 'tab-overview') refresh();
}, 20000);

refresh();
