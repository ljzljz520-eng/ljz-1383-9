'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

let TOKEN = localStorage.getItem('ng-admin-token') || '';
let TAB = 'overview';

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.style.borderColor = bad ? 'var(--bad)' : 'var(--neon-cyan)';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN, ...(opts.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { localStorage.removeItem('ng-admin-token'); location.reload(); throw new Error('未登录'); }
  if (!res.ok) throw new Error(data.message || res.statusText);
  return data;
}

function fmt(iso) { return iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
function statusPill(s) {
  const map = { confirmed: ['ok', '已确认'], invited: ['warn', '邀请占位'], waitlist: ['info', '候补中'], declined: ['bad', '已拒绝'], cancelled: ['bad', '已取消'], expired: ['bad', '邀请过期'] };
  const [cls, label] = map[s] || ['info', s];
  return `<span class="pill ${cls}">${label}</span>`;
}

// ---------- 登录 ----------
$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  TOKEN = new FormData(e.target).get('token').trim();
  api('/api/admin/health').then(() => {
    localStorage.setItem('ng-admin-token', TOKEN);
    $('#loginMask').hidden = true;
    render();
  }).catch(() => toast('令牌无效', true));
});
if (TOKEN) api('/api/admin/health').then(() => { $('#loginMask').hidden = true; render(); }).catch(() => {});

$('#adminNav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  TAB = btn.dataset.tab;
  $$('#adminNav button').forEach((b) => b.classList.toggle('active', b === btn));
  render();
});

async function render() {
  const main = $('#adminMain');
  main.innerHTML = '<p class="muted">加载中…</p>';
  try {
    if (TAB === 'overview') await renderOverview();
    else if (TAB === 'classes') await renderClasses();
    else if (TAB === 'changes') await renderChanges();
    else if (TAB === 'resources') await renderResources();
    else if (TAB === 'media') await renderMedia();
    else if (TAB === 'settings') await renderSettings();
  } catch (e) { main.innerHTML = `<p class="pill bad">加载失败：${esc(e.message)}</p>`; }
}

// ---------- 总览：实际容量、待确认改期、媒体撤下进度 ----------
async function renderOverview() {
  const [{ classes }, { changes }, { videos }] = await Promise.all([
    api('/api/admin/classes'), api('/api/admin/schedule-changes'), api('/api/admin/videos')
  ]);
  const pending = changes.filter((c) => c.state === 'pending');
  const overbooked = classes.filter((c) => c.spots_held > c.actual_capacity);
  const takenDown = videos.filter((v) => v.state === 'taken_down');
  const processing = videos.filter((v) => v.state === 'processing' || v.consent_status === 'pending');

  $('#adminMain').innerHTML = `
    <h2>运营总览</h2>
    <div class="note-box">容量口径：每场的<b>实际容量 = min(班级设定容量, 场地容量)</b>；卡片剩余量只是提示，报名/接受邀请时由事务重新核对。临时换到更小场地可能出现“占位 &gt; 实际容量”，下表单独列出，不强制踢人。</div>

    <div class="panel-box">
      <h3>实际容量 vs 占位 ${overbooked.length ? '<span class="pill bad">存在超额场次</span>' : '<span class="pill ok">正常</span>'}</h3>
      <table class="data">
        <thead><tr><th>场次</th><th>设定/场地</th><th>实际容量</th><th>占位</th><th>候补</th><th>说明</th></tr></thead>
        <tbody>${classes.map((c) => `
          <tr>
            <td>${esc(c.title)}<br><small class="muted">${esc(fmt(c.startTime || c.start_time))} v${c.version}</small></td>
            <td>${c.capacity} / ${c.venue.capacity}</td>
            <td><b>${c.actual_capacity}</b></td>
            <td>${c.spots_held}${c.spots_held > c.actual_capacity ? ' <span class="pill bad">超额</span>' : ''}</td>
            <td>${c.waitlist_count}</td>
            <td><small>${esc(c.capacity_reason)}</small></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="panel-box">
      <h3>待确认改期 ${pending.length ? `<span class="pill warn">${pending.length} 条</span>` : ''}</h3>
      ${pending.length ? `<table class="data">
        <thead><tr><th>场次</th><th>类型</th><th>变更内容</th><th>学员回应</th><th>操作</th></tr></thead>
        <tbody>${pending.map((ch) => {
          const cls = classes.find((c) => c.id === ch.class_id);
          const detail = ch.kind === 'venue_swap' ? '换场' : ch.kind === 'coach_substitute' ? '代课'
            : `${fmt(ch.old_start_time)} → ${fmt(ch.new_start_time)}${ch.new_venue_id && ch.new_venue_id !== ch.old_venue_id ? '（含换场）' : ''}`;
          return `<tr>
            <td>${esc(cls?.title || ch.class_id)}</td><td>${detail}</td><td><small>${esc(ch.note || '')}</small></td>
            <td>${ch.responses.length ? ch.responses.map((r) => `<span class="pill ${r.response === 'accepted' ? 'ok' : 'bad'}">${r.response === 'accepted' ? '接受' : '退出'}</span>`).join(' ') : '暂无回应'}</td>
            <td><button class="btn btn-primary btn-sm" onclick="applyChange(${ch.id})">确认生效</button>
                <button class="btn btn-ghost btn-sm" onclick="cancelChange(${ch.id})">撤销提案</button></td>
          </tr>`;
        }).join('')}</tbody></table>` : '<p class="muted">没有待确认的改期提案。</p>'}
    </div>

    <div class="panel-box">
      <h3>媒体撤下进度</h3>
      ${takenDown.length ? takenDown.map((v) => `
        <details open style="margin-bottom:10px">
          <summary><b>${esc(v.title)}</b> <span class="pill bad">${v.takedown_reason === 'consent_expired' ? '授权到期' : '已撤销'}</span> <small class="muted">${esc(fmt(v.takedown_at))}</small></summary>
          <ul class="steps-list">${v.takedown_steps.map((s) => `<li class="${s.status}">${esc(s.step)}：${esc(s.detail)}</li>`).join('')}</ul>
          <p class="muted" style="font-size:.8rem">分享链接已全部停用，受控流返回 410；封面与片段已移入隔离区。<b>已被外部下载的副本无法远程抹除</b>，授权书中应预先告知监护人。</p>
        </details>`).join('') : '<p class="muted">暂无撤下记录。</p>'}
      ${processing.length ? `<p class="muted">另有 ${processing.length} 个视频处于待授权/转码中，不会公开展示。</p>` : ''}
    </div>`;
}

// ---------- 班级与预约 ----------
async function renderClasses() {
  const [{ classes }, { bookings }] = await Promise.all([api('/api/admin/classes'), api('/api/admin/bookings')]);
  const byClass = {};
  bookings.forEach((b) => { (byClass[b.class_id] = byClass[b.class_id] || []).push(b); });

  $('#adminMain').innerHTML = `
    <h2>班级与预约</h2>
    <p class="section-note">每个班级显示资源版本 v；临时换场/代课会使版本 +1，旧卡片确认时会收到 <code>RESOURCE_CHANGED</code>。人工邀请与自动递补共用邀请有效期与多场占场上限。</p>
    ${classes.map((c) => `
    <div class="panel-box">
      <h3>${esc(c.title)} <small class="muted">v${c.version}</small>
        ${c.status !== 'scheduled' ? '<span class="pill bad">已取消</span>' : ''}
        ${c.spots_held > c.actual_capacity ? '<span class="pill bad">容量超额</span>' : ''}
      </h3>
      <dl class="kv">
        <dt>时间</dt><dd>${esc(fmt(c.start_time))} – ${esc(fmt(c.end_time))}</dd>
        <dt>教练 / 场地</dt><dd>${esc(c.coach.name)}（${c.coach.active ? '启用' : '停用'}） / ${esc(c.venue.name)}（容量 ${c.venue.capacity}，${c.venue.active ? '启用' : '停用'}）</dd>
        <dt>年龄分组</dt><dd>${esc(c.age_group.name)} ${c.age_group.age_min}-${c.age_group.age_max}</dd>
        <dt>实际容量</dt><dd>${c.actual_capacity} 人（班级 ${c.capacity} 与场地 ${c.venue.capacity} 取小）· 占位 ${c.spots_held} · 候补 ${c.waitlist_count}</dd>
      </dl>
      <table class="data">
        <thead><tr><th>#</th><th>学员</th><th>年龄</th><th>状态</th><th>候补顺位/邀请到期</th><th>操作</th></tr></thead>
        <tbody>
          ${(byClass[c.id] || []).map((b) => `
          <tr>
            <td>${b.id}</td><td>${esc(b.student_name)}<br><small class="muted">${esc(b.student_phone)}</small></td>
            <td>${b.student_age}</td><td>${statusPill(b.status)}</td>
            <td>${b.waitlist_rank ? `#${b.waitlist_rank}` : ''}${b.invite_expires_at ? esc(fmt(b.invite_expires_at)) : ''}</td>
            <td>
              ${b.status === 'waitlist' ? `<button class="btn btn-ghost btn-sm" onclick="invite(${b.id})">人工邀请</button>` : ''}
              ${['confirmed', 'invited', 'waitlist'].includes(b.status) ? `<button class="btn btn-danger btn-sm" onclick="cancelBooking(${b.id})">取消</button>` : ''}
            </td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">暂无预约</td></tr>'}
        </tbody>
      </table>
      <div class="inline-form">
        <div class="field"><span>临时换到场地</span><select id="swap-${c.id}">${venueOptions(c.venue_id)}</select></div>
        <button class="btn btn-ghost btn-sm" onclick="swapVenue(${c.id})">立即换场（版本+1）</button>
        <div class="field"><span>安排代课教练</span><select id="sub-${c.id}">${coachOptions(c.coach_id)}</select></div>
        <button class="btn btn-ghost btn-sm" onclick="subCoach(${c.id})">立即代课（版本+1）</button>
      </div>
    </div>`).join('')}`;
}

window.invite = async (id) => {
  try { const r = await api(`/api/admin/bookings/${id}/invite`, { method: 'POST' }); toast(`已人工邀请，有效期 ${r.ttl_hours} 小时`); render(); }
  catch (e) { toast(e.message, true); }
};
window.cancelBooking = async (id) => {
  if (!confirm('确认取消该预约？释放的名额将按候补顺位自动递补。')) return;
  try { const r = await api(`/api/admin/bookings/${id}/cancel`, { method: 'POST' }); toast(`已取消${r.promoted.length ? `，自动递补 ${r.promoted.length} 人` : ''}`); render(); }
  catch (e) { toast(e.message, true); }
};
window.swapVenue = async (id) => {
  const venue_id = Number($(`#swap-${id}`).value);
  try { await api(`/api/admin/classes/${id}/swap-venue`, { method: 'POST', body: JSON.stringify({ venue_id, apply: true, note: '临时换场（后台立即生效）' }) }); toast('换场成功，资源版本已更新，旧卡片会被拦截'); render(); }
  catch (e) { toast(e.message, true); }
};
window.subCoach = async (id) => {
  const coach_id = Number($(`#sub-${id}`).value);
  try { await api(`/api/admin/classes/${id}/substitute-coach`, { method: 'POST', body: JSON.stringify({ coach_id, note: '教练代课' }) }); toast('代课安排成功'); render(); }
  catch (e) { toast(e.message, true); }
};

// ---------- 改期 ----------
async function renderChanges() {
  const [{ classes }, { changes }] = await Promise.all([api('/api/admin/classes'), api('/api/admin/schedule-changes')]);
  $('#adminMain').innerHTML = `
    <h2>改期提案（待学员/后台确认）</h2>
    <div class="note-box">“改期”先生成 <b>pending 提案</b>：学员可接受或选择退出（退出释放名额并自动递补）；后台最终确认时会再次原子核对教练与场地冲突，冲突则拒绝生效。换场与代课也会留痕在下表。</div>
    <div class="panel-box">
      <h3>发起改期提案</h3>
      <div class="inline-form">
        <div class="field"><span>场次</span><select id="rc-class">${classes.map((c) => `<option value="${c.id}">${esc(c.title)} (${esc(fmt(c.start_time))})</option>`).join('')}</select></div>
        <div class="field"><span>新开始</span><input id="rc-start" type="datetime-local"></div>
        <div class="field"><span>新结束</span><input id="rc-end" type="datetime-local"></div>
        <div class="field"><span>新场地（可选）</span><select id="rc-venue"><option value="">不变</option>${venueOptions()}</select></div>
        <button class="btn btn-primary btn-sm" onclick="proposeReschedule()">生成待确认提案</button>
      </div>
    </div>
    <div class="panel-box">
      <h3>变更记录</h3>
      <table class="data">
        <thead><tr><th>#</th><th>场次</th><th>类型</th><th>内容</th><th>状态</th><th>回应</th><th>操作</th></tr></thead>
        <tbody>${changes.map((ch) => {
          const cls = classes.find((c) => c.id === ch.class_id);
          const kindMap = { reschedule: '改期', venue_swap: '换场', coach_substitute: '代课' };
          const content = ch.kind === 'reschedule'
            ? `${fmt(ch.old_start_time)} → ${fmt(ch.new_start_time)}`
            : ch.kind === 'venue_swap' ? `场地 #${ch.old_venue_id} → #${ch.new_venue_id}` : `教练 #${ch.old_coach_id} → #${ch.new_coach_id}`;
          return `<tr>
            <td>${ch.id}</td><td>${esc(cls?.title || ch.class_id)}</td><td>${kindMap[ch.kind]}</td>
            <td>${content}<br><small class="muted">${esc(ch.note)}</small></td>
            <td><span class="pill ${ch.state === 'applied' ? 'ok' : ch.state === 'pending' ? 'warn' : 'bad'}">${ch.state}</span></td>
            <td>${ch.responses.length ? ch.responses.map((r) => (r.response === 'accepted' ? '✔接受' : '✖退出')).join(' ') : '—'}</td>
            <td>${ch.state === 'pending' ? `
              <button class="btn btn-primary btn-sm" onclick="applyChange(${ch.id})">确认</button>
              <button class="btn btn-ghost btn-sm" onclick="cancelChange(${ch.id})">撤销</button>` : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}
window.proposeReschedule = async () => {
  const class_id = Number($('#rc-class').value);
  const s = $('#rc-start').value, e = $('#rc-end').value;
  const venue = $('#rc-venue').value;
  if (!s || !e) return toast('请选择新的起止时间', true);
  try {
    await api(`/api/admin/classes/${class_id}/propose-reschedule`, {
      method: 'POST',
      body: JSON.stringify({ new_start_time: new Date(s).toISOString(), new_end_time: new Date(e).toISOString(), new_venue_id: venue || null, note: '后台发起改期，待确认' })
    });
    toast('改期提案已生成，学员侧已出现待确认通知'); render();
  } catch (err) { toast(err.message, true); }
};
window.applyChange = async (id) => {
  try { const r = await api(`/api/admin/schedule-changes/${id}/apply`, { method: 'POST' }); toast(`改期已生效，版本 v${r.class.version}${r.promoted.length ? `，递补 ${r.promoted.length} 人` : ''}`); render(); }
  catch (e) { toast(e.message, true); }
};
window.cancelChange = async (id) => {
  try { await api(`/api/admin/schedule-changes/${id}/cancel`, { method: 'POST' }); toast('提案已撤销'); render(); }
  catch (e) { toast(e.message, true); }
};

// ---------- 资源 CRUD ----------
async function renderResources() {
  const [{ venues }, { coaches }, { age_groups }] = await Promise.all([
    api('/api/admin/venues'), api('/api/admin/coaches'), api('/api/admin/age-groups')
  ]);
  window._venues = venues; window._coaches = coaches;
  $('#adminMain').innerHTML = `
    <h2>场地 · 教练 · 年龄分组</h2>
    <div class="panel-box">
      <h3>场地</h3>
      <table class="data"><thead><tr><th>#</th><th>名称</th><th>地址</th><th>容量</th><th>状态</th></tr></thead>
      <tbody>${venues.map((v) => `<tr><td>${v.id}</td><td>${esc(v.name)}</td><td>${esc(v.address)}</td><td>${v.capacity}</td>
        <td>${v.active ? '<span class="pill ok">启用</span>' : '<span class="pill bad">停用</span>'}
        <button class="btn btn-ghost btn-sm" onclick="toggleVenue(${v.id},${v.active ? 0 : 1})">${v.active ? '停用' : '启用'}</button></td></tr>`).join('')}</tbody></table>
      <div class="inline-form">
        <div class="field"><span>名称</span><input id="v-name"></div>
        <div class="field"><span>地址</span><input id="v-addr"></div>
        <div class="field"><span>容量</span><input id="v-cap" type="number" min="1" style="width:90px"></div>
        <button class="btn btn-primary btn-sm" onclick="addVenue()">新增场地</button>
      </div>
    </div>
    <div class="panel-box">
      <h3>教练</h3>
      <table class="data"><thead><tr><th>#</th><th>姓名</th><th>舞种</th><th>简介</th><th>状态</th></tr></thead>
      <tbody>${coaches.map((c) => `<tr><td>${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.style)}</td><td>${esc(c.bio)}</td>
        <td>${c.active ? '<span class="pill ok">启用</span>' : '<span class="pill bad">停用</span>'}
        <button class="btn btn-ghost btn-sm" onclick="toggleCoach(${c.id},${c.active ? 0 : 1})">${c.active ? '停用' : '启用'}</button></td></tr>`).join('')}</tbody></table>
      <div class="inline-form">
        <div class="field"><span>姓名</span><input id="c-name"></div>
        <div class="field"><span>舞种</span><input id="c-style"></div>
        <div class="field grow"><span>简介</span><input id="c-bio"></div>
        <button class="btn btn-primary btn-sm" onclick="addCoach()">新增教练</button>
      </div>
    </div>
    <div class="panel-box">
      <h3>年龄分组</h3>
      <table class="data"><thead><tr><th>#</th><th>名称</th><th>区间</th></tr></thead>
      <tbody>${age_groups.map((g) => `<tr><td>${g.id}</td><td>${esc(g.name)}</td><td>${g.age_min} - ${g.age_max}</td></tr>`).join('')}</tbody></table>
      <div class="inline-form">
        <div class="field"><span>名称</span><input id="g-name"></div>
        <div class="field"><span>最小</span><input id="g-min" type="number" min="0" style="width:80px"></div>
        <div class="field"><span>最大</span><input id="g-max" type="number" min="0" style="width:80px"></div>
        <button class="btn btn-primary btn-sm" onclick="addGroup()">新增分组</button>
      </div>
    </div>`;
}
function venueOptions(selected) { return (window._venues || []).map((v) => `<option value="${v.id}" ${v.id === selected ? 'selected' : ''}>${esc(v.name)}（容 ${v.capacity}）</option>`).join(''); }
function coachOptions(selected) { return (window._coaches || []).map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join(''); }

window.addVenue = async () => {
  try { await api('/api/admin/venues', { method: 'POST', body: JSON.stringify({ name: $('#v-name').value, address: $('#v-addr').value, capacity: Number($('#v-cap').value) }) }); toast('已新增场地'); render(); }
  catch (e) { toast(e.message, true); }
};
window.toggleVenue = async (id, active) => { try { await api(`/api/admin/venues/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }); render(); } catch (e) { toast(e.message, true); } };
window.addCoach = async () => {
  try { await api('/api/admin/coaches', { method: 'POST', body: JSON.stringify({ name: $('#c-name').value, style: $('#c-style').value, bio: $('#c-bio').value }) }); toast('已新增教练'); render(); }
  catch (e) { toast(e.message, true); }
};
window.toggleCoach = async (id, active) => { try { await api(`/api/admin/coaches/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }); render(); } catch (e) { toast(e.message, true); } };
window.addGroup = async () => {
  try { await api('/api/admin/age-groups', { method: 'POST', body: JSON.stringify({ name: $('#g-name').value, age_min: Number($('#g-min').value), age_max: Number($('#g-max').value) }) }); toast('已新增分组'); render(); }
  catch (e) { toast(e.message, true); }
};

// ---------- 媒体 ----------
async function renderMedia() {
  const { videos } = await api('/api/admin/videos');
  $('#adminMain').innerHTML = `
    <h2>少儿成果视频与独立授权</h2>
    <div class="note-box">授权独立于“是否在列表显示”：未授权/过期/撤销的视频一律不出现在公开成果页，受控流返回 410。撤销会逐项处理 <b>分享入口 → 封面 → 片段 → 在途转码 → 原始文件标识</b>。撤下前已下载的外部副本不可远程抹除。</div>
    <div class="panel-box">
      <h3>登记新视频（上传转码前登记）</h3>
      <div class="inline-form">
        <div class="field"><span>标题</span><input id="mv-title"></div>
        <div class="field"><span>学员（化名）</span><input id="mv-name"></div>
        <div class="field"><span>源文件标识</span><input id="mv-src" placeholder="media/src/xxx.mp4"></div>
        <button class="btn btn-primary btn-sm" onclick="addVideo()">登记（待授权）</button>
      </div>
    </div>
    ${videos.map((v) => {
      const granted = v.consent_status === 'granted';
      return `
    <div class="panel-box">
      <h3>${esc(v.title)} <span class="pill ${v.state === 'published' ? 'ok' : v.state === 'taken_down' ? 'bad' : 'warn'}">${v.state}</span>
        <span class="pill ${granted ? 'ok' : 'bad'}">授权：${v.consent_status}</span></h3>
      <dl class="kv">
        <dt>学员</dt><dd>${esc(v.student_name)}</dd>
        <dt>源文件 / 封面</dt><dd>${esc(v.source_path)} / ${v.cover_path ? esc(v.cover_path) : '无'}</dd>
        <dt>授权时间</dt><dd>${fmt(v.consent_granted_at)} ${v.consent_expires_at ? `→ 到期 ${fmt(v.consent_expires_at)}` : '（长期）'}</dd>
        <dt>监护人备注</dt><dd>${esc(v.guardian_note)}</dd>
        <dt>片段</dt><dd>${v.clips.map((c) => `${esc(c.title)} <span class="pill ${c.state === 'ready' ? 'ok' : 'bad'}">${c.state}</span>`).join('、') || '无'}</dd>
        <dt>转码任务</dt><dd>${v.jobs.map((j) => `#${j.id}:${j.state}`).join('、') || '无'}</dd>
        <dt>分享入口</dt><dd>${v.share_links.map((l) => `<span class="pill ${l.active ? 'ok' : 'bad'}">${l.token.slice(0, 8)}… ${l.active ? '有效' : '停用'}</span>`).join(' ') || '无'}</dd>
      </dl>
      ${v.state === 'taken_down' ? `<div class="note-box">撤下进度：
        <ul class="steps-list">${v.takedown_steps.map((s) => `<li class="${s.status}">${esc(s.step)}：${esc(s.detail)}</li>`).join('')}</ul></div>` : ''}
      <div class="inline-form" style="margin-top:10px">
        <div class="field"><span>授权到期（留空=长期）</span><input id="consent-${v.id}" type="datetime-local"></div>
        <button class="btn btn-primary btn-sm" onclick="grant(${v.id})">授予/更新独立授权</button>
        <button class="btn btn-ghost btn-sm" onclick="enqueue(${v.id})">排入转码</button>
        <button class="btn btn-ghost btn-sm" onclick="completeJobFor(${v.id})">模拟转码迟到完成</button>
        <button class="btn btn-ghost btn-sm" onclick="addClip(${v.id})">添加片段</button>
        <button class="btn btn-ghost btn-sm" onclick="addCover(${v.id})">设置封面</button>
        <button class="btn btn-ghost btn-sm" onclick="share(${v.id})">生成分享入口</button>
        <button class="btn btn-danger btn-sm" onclick="takedown(${v.id})">撤销授权并撤下</button>
      </div>
    </div>`;
    }).join('')}
    <button class="btn btn-ghost" onclick="sweepExpiry()">立即扫描授权到期</button>`;
}
window.addVideo = async () => {
  try { await api('/api/admin/videos', { method: 'POST', body: JSON.stringify({ title: $('#mv-title').value, student_name: $('#mv-name').value, source_path: $('#mv-src').value }) }); toast('已登记，等待监护人授权'); render(); }
  catch (e) { toast(e.message, true); }
};
window.grant = async (id) => {
  const val = $(`#consent-${id}`).value;
  try { await api(`/api/admin/videos/${id}/consent`, { method: 'POST', body: JSON.stringify({ expires_at: val ? new Date(val).toISOString() : null, guardian_note: '后台演示授权' }) }); toast('授权已记录'); render(); }
  catch (e) { toast(e.message, true); }
};
window.enqueue = async (id) => { try { await api(`/api/admin/videos/${id}/transcode`, { method: 'POST' }); toast('已排入转码队列'); render(); } catch (e) { toast(e.message, true); } };
window.completeJobFor = async (videoId) => {
  const { videos } = await api('/api/admin/videos');
  const v = videos.find((x) => x.id === videoId);
  const job = v.jobs.find((j) => j.state === 'queued' || j.state === 'running');
  if (!job) return toast('没有排队中的转码任务（先排入）', true);
  try {
    const r = await api(`/api/admin/transcodes/${job.id}/complete`, { method: 'POST', body: JSON.stringify({ output_path: `media/out/v${videoId}-late.mp4` }) });
    toast(r.discarded ? `迟到任务已丢弃：${r.reason}（授权失效，产物不落库）` : '转码完成并发布'); render();
  } catch (e) { toast(e.message, true); }
};
window.addClip = async (id) => { try { await api(`/api/admin/videos/${id}/clip`, { method: 'POST', body: JSON.stringify({ title: '演示片段' }) }); render(); } catch (e) { toast(e.message, true); } };
window.addCover = async (id) => { try { await api(`/api/admin/videos/${id}/cover`, { method: 'POST', body: JSON.stringify({}) }); render(); } catch (e) { toast(e.message, true); } };
window.share = async (id) => { try { const r = await api(`/api/admin/videos/${id}/share`, { method: 'POST' }); toast(`分享入口：/api/share/${r.link.token}`); render(); } catch (e) { toast(e.message, true); } };
window.takedown = async (id) => {
  if (!confirm('确认撤销授权？封面、片段、分享入口、转码产物将被隔离/停用（外部已下载副本无法远程抹除）。')) return;
  try { const r = await api(`/api/admin/videos/${id}/takedown`, { method: 'POST', body: JSON.stringify({ reason: 'revoked' }) }); toast(`已撤下，共 ${r.steps.length} 个清理步骤完成`); render(); }
  catch (e) { toast(e.message, true); }
};
window.sweepExpiry = async () => { try { const r = await api('/api/admin/maintenance/expire-consents', { method: 'POST' }); toast(r.results.length ? `已按到期撤下 ${r.results.length} 个视频` : '没有到期授权'); render(); } catch (e) { toast(e.message, true); } };

// ---------- 设置 ----------
async function renderSettings() {
  const s = await api('/api/admin/settings');
  $('#adminMain').innerHTML = `
    <h2>规则设置</h2>
    <div class="panel-box">
      <dl class="kv">
        <dt>候补邀请有效期</dt><dd><div class="inline-form"><div class="field"><input id="set-ttl" type="number" min="1" value="${s.invitation_ttl_hours}"></div> 小时
          <button class="btn btn-primary btn-sm" onclick="saveSetting('invitation_ttl_hours', Number($('#set-ttl').value))">保存</button></div></dd>
        <dt>同一学员多场占位上限</dt><dd><div class="inline-form"><div class="field"><input id="set-max" type="number" min="1" value="${s.max_active_spots_per_student}"></div> 场（含未接受邀请）
          <button class="btn btn-primary btn-sm" onclick="saveSetting('max_active_spots_per_student', Number($('#set-max').value))">保存</button></div></dd>
        <dt>名额释放时自动递补</dt><dd><label class="check"><input id="set-auto" type="checkbox" ${s.auto_promote ? 'checked' : ''}> 开启（关闭后只能由后台人工邀请）</label>
          <button class="btn btn-primary btn-sm" onclick="saveSetting('auto_promote', $('#set-auto').checked)">保存</button></dd>
      </dl>
      <p class="muted" style="font-size:.84rem">自动递补按候补顺位 FIFO，把队首升级为“邀请占位”并开始倒计时；人工邀请不改变其余候补顺位。接受邀请时仍会原子核对全部资源。</p>
    </div>`;
}
window.saveSetting = async (key, value) => { try { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ [key]: value }) }); toast('已保存'); } catch (e) { toast(e.message, true); } };
