/* 信用卡管家 · 自用版
 * 纯前端，无框架、无外部依赖，直接调用 Supabase REST 接口
 */
(function () {
'use strict';

var CFG = window.APP_CONFIG || {};
var BASE = (CFG.SUPABASE_URL || '').replace(/\/+$/, '');
var ANON = CFG.SUPABASE_ANON_KEY || '';
var LS_KEY = 'ccm_session_v1';

var S = { cards: [], bills: [], reps: [], fixed: [], frecs: [], page: 'home', billTab: 'card' };
var SESSION = null;

/* ============ 工具 ============ */
function $(s) { return document.querySelector(s); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function p2(n) { return String(n).padStart(2, '0'); }
function iso(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
function todayISO() { return iso(new Date()); }
function periodOf(s) { return String(s || '').slice(0, 7); }
function fmt(cents) {
  var n = (Number(cents) || 0) / 100;
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function toCents(v) {
  var n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100);
}
function lastDay(y, m) { return new Date(y, m, 0).getDate(); }
function dueDateOf(period, day) {
  var y = parseInt(period.slice(0, 4), 10), m = parseInt(period.slice(5, 7), 10);
  var d = Math.min(parseInt(day, 10) || 1, lastDay(y, m));
  return y + '-' + p2(m) + '-' + p2(d);
}
function daysFromToday(dateStr) {
  if (!dateStr) return null;
  var p = dateStr.split('-').map(Number);
  var t = new Date(); t.setHours(0, 0, 0, 0);
  var g = new Date(p[0], p[1] - 1, p[2]);
  return Math.round((g - t) / 86400000);
}
function shiftPeriod(period, delta) {
  var y = parseInt(period.slice(0, 4), 10), m = parseInt(period.slice(5, 7), 10) - 1 + delta;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + '-' + p2(m + 1);
}
function toast(msg) {
  var t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2200);
}
function cardById(id) { for (var i = 0; i < S.cards.length; i++) if (S.cards[i].id === id) return S.cards[i]; return null; }
function cardName(id) { var c = cardById(id); return c ? (c.alias || c.bank || '信用卡') : '已删除卡'; }
function billRemain(b) { return Math.max(0, (b.amount_cents || 0) - (b.paid_cents || 0)); }

/* ============ 网络 ============ */
function sbUrl(path) { return BASE + path; }
function headers(extra) {
  var h = { apikey: ANON, 'Content-Type': 'application/json' };
  h.Authorization = 'Bearer ' + (SESSION && SESSION.access_token ? SESSION.access_token : ANON);
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}
async function sb(path, opt) {
  opt = opt || {};
  var res = await fetch(sbUrl(path), {
    method: opt.method || 'GET',
    headers: headers(opt.headers),
    body: opt.body ? JSON.stringify(opt.body) : undefined
  });
  var txt = await res.text();
  var data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!res.ok) {
    var msg = (data && (data.message || data.error_description || data.msg || data.hint)) || ('HTTP ' + res.status);
    var err = new Error(msg); err.status = res.status; throw err;
  }
  return data;
}

/* ============ 登录态 ============ */
function loadSession() {
  try { SESSION = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { SESSION = null; }
}
function saveSession(s) { SESSION = s; try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {} }
function clearSession() { SESSION = null; try { localStorage.removeItem(LS_KEY); } catch (e) {} }

async function authPost(path, body) {
  var res = await fetch(sbUrl(path), {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  var txt = await res.text();
  var data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!res.ok) {
    var m = (data && (data.error_description || data.msg || data.message)) || ('HTTP ' + res.status);
    if (data && data.error_code === 'email_not_confirmed') m = '邮箱还没确认，请到邮箱点确认链接';
    if (data && data.error_code === 'invalid_credentials') m = '邮箱或密码不对';
    throw new Error(m);
  }
  return data;
}
function toSession(d) {
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: Date.now() + (d.expires_in || 3600) * 1000 - 60000,
    email: (d.user && d.user.email) || (SESSION && SESSION.email) || '',
    user_id: d.user && d.user.id
  };
}
async function signIn(email, pass) {
  var d = await authPost('/auth/v1/token?grant_type=password', { email: email, password: pass });
  saveSession(toSession(d));
}
async function signUp(email, pass) {
  var d = await authPost('/auth/v1/signup', { email: email, password: pass });
  if (d && d.access_token) { saveSession(toSession(d)); return true; }
  return false; // 需要邮箱确认
}
async function refresh() {
  if (!SESSION || !SESSION.refresh_token) throw new Error('登录已过期');
  var d = await authPost('/auth/v1/token?grant_type=refresh_token', { refresh_token: SESSION.refresh_token });
  saveSession(toSession(d));
}
async function ensureAuth() {
  if (!SESSION) throw new Error('未登录');
  if (SESSION.expires_at && Date.now() > SESSION.expires_at) {
    try { await refresh(); } catch (e) { clearSession(); throw new Error('登录已过期，请重新登录'); }
  }
}

/* ============ 数据 ============ */
async function loadAll() {
  await ensureAuth();
  var r = await Promise.all([
    sb('/rest/v1/credit_cards?select=*&order=created_at.asc'),
    sb('/rest/v1/bills?select=*&order=period.desc'),
    sb('/rest/v1/repayments?select=*&order=paid_at.desc'),
    sb('/rest/v1/fixed_payments?select=*&order=created_at.asc'),
    sb('/rest/v1/fixed_payment_records?select=*&order=period.desc')
  ]);
  S.cards = r[0] || []; S.bills = r[1] || []; S.reps = r[2] || [];
  S.fixed = r[3] || []; S.frecs = r[4] || [];
}

/* ============ 提醒计算 ============ */
function reminders() {
  var out = [];
  S.bills.forEach(function (b) {
    var rem = billRemain(b);
    if (rem <= 0) return;
    var c = cardById(b.card_id);
    var due = b.due_date || (b.period ? dueDateOf(b.period, (c && c.due_day) || 23) : null);
    if (!due) return;
    var d = daysFromToday(due);
    if (d < -60) return;
    out.push({
      kind: 'bill', key: 'b:' + b.id, title: cardName(b.card_id),
      sub: (b.period || '') + ' 账单', due: due, days: d, amount: rem, bill: b
    });
  });
  var cur = periodOf(todayISO());
  var periods = [];
  for (var i = -12; i <= 1; i++) periods.push(shiftPeriod(cur, i));
  S.fixed.forEach(function (f) {
    if (!f.is_active) return;
    periods.forEach(function (p) {
      if (f.start_period && p < f.start_period) return;
      if (f.end_period && p > f.end_period) return;
      var due = dueDateOf(p, f.pay_day);
      var rec = null;
      for (var j = 0; j < S.frecs.length; j++) {
        if (S.frecs[j].fixed_payment_id === f.id && S.frecs[j].period === p) { rec = S.frecs[j]; break; }
      }
      if (rec && rec.status === 'paid') return;
      var d = daysFromToday(due);
      if (d < -60) return;
      out.push({
        kind: 'fixed', key: 'f:' + f.id + ':' + p, title: f.name,
        sub: p + ' 月供', due: due, days: d, amount: f.amount_cents,
        fixed: f, period: p, rec: rec
      });
    });
  });
  out.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
  return out;
}
function statusTag(days) {
  if (days < 0) return '<span class="tag red">逾期 ' + (-days) + ' 天</span>';
  if (days === 0) return '<span class="tag orange">今天到期</span>';
  if (days <= 5) return '<span class="tag orange">还有 ' + days + ' 天</span>';
  return '<span class="tag gray">还有 ' + days + ' 天</span>';
}

/* ============ 渲染：首页 ============ */
function renderHome() {
  var list = reminders();
  var box = $('#homeAlert');
  if (!list.length) {
    box.innerHTML = '<div class="alert ok"><div class="lbl">当前状态</div><div class="big">暂无待还</div><div class="small" style="margin-top:4px">所有账单和月供都已结清</div></div>';
  } else {
    var n = list[0];
    var cls = n.days < 0 ? 'danger' : (n.days <= 5 ? 'warn' : 'ok');
    var head = n.days < 0 ? ('已逾期 ' + (-n.days) + ' 天') : (n.days === 0 ? '今天到期' : ('还有 ' + n.days + ' 天'));
    box.innerHTML =
      '<div class="alert ' + cls + '">' +
      '<div class="lbl">' + esc(n.title) + ' · ' + esc(n.sub) + ' · ' + esc(n.due) + '</div>' +
      '<div class="row"><div><div class="big">¥' + fmt(n.amount) + '</div><div class="small" style="margin-top:2px">' + head + '</div></div>' +
      '<button class="btn sm" data-pay="' + esc(n.key) + '">标记已还</button></div></div>';
  }

  var cur = periodOf(todayISO());
  var monthBill = 0, monthPaid = 0, overdue = 0;
  S.bills.forEach(function (b) {
    if (periodOf(b.period) === cur) { monthBill += b.amount_cents || 0; monthPaid += b.paid_cents || 0; }
    if (billRemain(b) > 0) {
      var due = b.due_date || dueDateOf(b.period, (cardById(b.card_id) || {}).due_day || 23);
      if (daysFromToday(due) < 0) overdue++;
    }
  });
  var monthFixed = 0;
  S.fixed.forEach(function (f) { if (f.is_active) monthFixed += f.amount_cents || 0; });

  $('#homeKpi').innerHTML =
    kpi('本月账单', '¥' + fmt(monthBill)) +
    kpi('本月已还', '¥' + fmt(monthPaid)) +
    kpi('本月固定支出', '¥' + fmt(monthFixed)) +
    kpi('逾期笔数', overdue + ' 笔');

  var host = $('#homeList');
  if (!list.length) { host.innerHTML = '<div class="empty"><span class="ico">✅</span>没有待还项目</div>'; return; }
  host.innerHTML = list.slice(0, 12).map(function (n) {
    return '<div class="item"><div class="grow"><div class="t1">' + esc(n.title) + statusTag(n.days) + '</div>' +
      '<div class="t2">' + esc(n.sub) + ' · 到期 ' + esc(n.due) + '</div></div>' +
      '<div style="text-align:right"><div class="amt">¥' + fmt(n.amount) + '</div>' +
      '<button class="btn sm" data-pay="' + esc(n.key) + '" style="margin-top:4px">已还</button></div></div>';
  }).join('');
}
function kpi(k, v) { return '<div class="box"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>'; }

/* ============ 渲染：账单 ============ */
function renderBills() {
  var host = $('#billList');
  if (!S.bills.length) { host.innerHTML = '<div class="empty"><span class="ico">🧾</span>还没有账单记录</div>'; }
  else {
    host.innerHTML = S.bills.map(function (b) {
      var rem = billRemain(b);
      var c = cardById(b.card_id);
      var due = b.due_date || (b.period ? dueDateOf(b.period, (c && c.due_day) || 23) : '');
      var tag = rem <= 0 ? '<span class="tag green">已还清</span>'
        : (b.paid_cents > 0 ? '<span class="tag orange">部分已还</span>' : '<span class="tag gray">未还</span>');
      return '<div class="item"><div class="grow"><div class="t1">' + esc(cardName(b.card_id)) + ' · ' + esc(b.period) + tag + '</div>' +
        '<div class="t2">账单 ¥' + fmt(b.amount_cents) + ' · 待还 ¥' + fmt(rem) + (due ? ' · 到期 ' + esc(due) : '') + '</div></div>' +
        '<div style="text-align:right"><button class="btn sm" data-bill="' + esc(b.id) + '">编辑</button></div></div>';
    }).join('');
  }
  renderFixedList();
}
function renderFixedList() {
  var host = $('#fixedList');
  if (!S.fixed.length) { host.innerHTML = '<div class="card"><div class="empty"><span class="ico">🏠</span>还没有房贷 / 房租记录</div></div>'; return; }
  var cur = periodOf(todayISO());
  host.innerHTML = S.fixed.map(function (f) {
    var recs = S.frecs.filter(function (r) { return r.fixed_payment_id === f.id; })
      .sort(function (a, b) { return a.period < b.period ? 1 : -1; });
    var curRec = null;
    for (var i = 0; i < recs.length; i++) if (recs[i].period === cur) { curRec = recs[i]; break; }
    var due = dueDateOf(cur, f.pay_day);
    var paid = curRec && curRec.status === 'paid';
    var overdue = !paid && daysFromToday(due) < 0 && (!f.end_period || cur <= f.end_period);
    var tag = !f.is_active ? '<span class="tag gray">已停用</span>'
      : paid ? '<span class="tag green">本月已还</span>'
        : overdue ? '<span class="tag red">本月逾期</span>' : '<span class="tag orange">本月待还</span>';
    var typeName = { mortgage: '房贷', rent: '房租', other: '其他' }[f.type] || '其他';
    var hist = recs.slice(0, 6).map(function (r) {
      return '<div class="item" style="padding:6px 0"><div class="grow"><div class="t2" style="margin:0">' + esc(r.period) +
        ' · 到期 ' + esc(r.due_date) + '</div></div><div class="small ' + (r.status === 'paid' ? 'muted' : '') + '">' +
        (r.status === 'paid' ? ('已还 ¥' + fmt(r.paid_cents || r.due_cents)) : '未还') + '</div></div>';
    }).join('');
    return '<div class="card"><div class="item" style="border:none;padding:0 0 8px">' +
      '<div class="grow"><div class="t1">' + esc(f.name) + tag + '</div>' +
      '<div class="t2">' + typeName + ' · 每月 ' + esc(f.pay_day) + ' 号 · ¥' + fmt(f.amount_cents) + '</div></div>' +
      '<button class="btn sm" data-fixed="' + esc(f.id) + '">编辑</button></div>' +
      (paid
        ? '<button class="btn sm block" data-unpay="' + esc(f.id) + ':' + esc(cur) + '">撤销本月已还</button>'
        : '<button class="btn sm primary block" data-fpay="' + esc(f.id) + ':' + esc(cur) + '">标记本月已还</button>') +
      (hist ? '<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:6px">' + hist + '</div>' : '') +
      '</div>';
  }).join('');
}

/* ============ 渲染：还款 ============ */
function renderReps() {
  var host = $('#repList');
  if (!S.reps.length) { host.innerHTML = '<div class="empty"><span class="ico">💳</span>还没有还款记录</div>'; return; }
  host.innerHTML = S.reps.map(function (r) {
    return '<div class="item"><div class="grow"><div class="t1">' + esc(cardName(r.card_id)) + '</div>' +
      '<div class="t2">' + esc(r.paid_at) + (r.period ? ' · 账期 ' + esc(r.period) : '') + (r.method ? ' · ' + esc(r.method) : '') + '</div></div>' +
      '<div style="text-align:right"><div class="amt">¥' + fmt(r.amount_cents) + '</div>' +
      '<button class="btn sm" data-delrep="' + esc(r.id) + '" style="margin-top:4px">删除</button></div></div>';
  }).join('');
}

/* ============ 渲染：分析 ============ */
function renderStats() {
  var cur = periodOf(todayISO());
  var year = cur.slice(0, 4);
  var mBill = 0, mPaid = 0, yRep = 0, yFixed = 0;
  S.bills.forEach(function (b) {
    if (periodOf(b.period) === cur) mBill += b.amount_cents || 0;
  });
  S.reps.forEach(function (r) {
    if (periodOf(r.paid_at) === cur) mPaid += r.amount_cents || 0;
    if (String(r.paid_at || '').slice(0, 4) === year) yRep += r.amount_cents || 0;
  });
  S.frecs.forEach(function (r) {
    if (r.status === 'paid' && String(r.paid_at || '').slice(0, 4) === year) yFixed += r.paid_cents || r.due_cents || 0;
  });
  $('#statsKpi').innerHTML =
    kpi('本月账单', '¥' + fmt(mBill)) + kpi('本月已还', '¥' + fmt(mPaid)) +
    kpi('本年还款合计', '¥' + fmt(yRep)) + kpi('本年固定支出', '¥' + fmt(yFixed));

  // 额度使用率
  var ch = $('#statsCards');
  if (!S.cards.length) ch.innerHTML = '<div class="empty">还没有信用卡</div>';
  else {
    ch.innerHTML = S.cards.map(function (c) {
      var used = 0;
      S.bills.forEach(function (b) { if (b.card_id === c.id) used += b.amount_cents || 0; });
      var lim = c.credit_limit_cents || 0;
      var pct = lim > 0 ? Math.min(100, used / lim * 100) : 0;
      var cls = pct > 80 ? 'danger' : pct > 50 ? 'warn' : '';
      return '<div class="bar-row"><div class="lab"><span>' + esc(c.alias || c.bank) + '</span>' +
        '<span>¥' + fmt(used) + ' / ¥' + fmt(lim) + ' · ' + pct.toFixed(1) + '%</span></div>' +
        '<div class="bar-track"><div class="bar-fill ' + cls + '" style="width:' + pct.toFixed(1) + '%"></div></div></div>';
    }).join('');
  }

  // 近 12 个月账单
  var periods = [];
  for (var i = 11; i >= 0; i--) periods.push(shiftPeriod(cur, -i));
  var sums = periods.map(function (p) {
    var s = 0;
    S.bills.forEach(function (b) { if (b.period === p) s += b.amount_cents || 0; });
    return s;
  });
  var max = Math.max.apply(null, sums.concat([1]));
  $('#statsTrend').innerHTML = '<div class="chart">' + periods.map(function (p, idx) {
    var h = Math.max(2, sums[idx] / max * 100);
    return '<div class="col"><div class="b" style="height:' + h + '%"></div><div class="x">' + p.slice(5) + '</div></div>';
  }).join('') + '</div><div class="small muted" style="margin-top:6px">最高 ' + periods[sums.indexOf(max)] + ' ¥' + fmt(max) + '</div>';

  // 固定月供构成
  var byType = { mortgage: 0, rent: 0, other: 0 };
  S.fixed.forEach(function (f) { if (f.is_active) byType[f.type] = (byType[f.type] || 0) + (f.amount_cents || 0); });
  var total = byType.mortgage + byType.rent + byType.other;
  var names = { mortgage: '房贷', rent: '房租', other: '其他' };
  var fh = $('#statsFixed');
  if (!total) fh.innerHTML = '<div class="empty">还没有固定月供</div>';
  else {
    fh.innerHTML = Object.keys(byType).filter(function (k) { return byType[k] > 0; }).map(function (k) {
      var pct = byType[k] / total * 100;
      return '<div class="bar-row"><div class="lab"><span>' + names[k] + '</span><span>¥' + fmt(byType[k]) + ' · ' + pct.toFixed(0) + '%</span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div></div>';
    }).join('') + '<div class="small muted">每月固定支出合计 ¥' + fmt(total) + '</div>';
  }
}

/* ============ 渲染：设置 ============ */
function renderSettings() {
  $('#userEmail').textContent = (SESSION && SESSION.email) || '-';
  var host = $('#cardList');
  if (!S.cards.length) { host.innerHTML = '<div class="empty">还没有信用卡</div>'; return; }
  host.innerHTML = S.cards.map(function (c) {
    return '<div class="item"><div class="grow"><div class="t1">' + esc(c.alias || c.bank) + (c.is_active === false ? '<span class="tag gray">停用</span>' : '') + '</div>' +
      '<div class="t2">' + esc(c.bank) + (c.last4 ? ' · 尾号 ' + esc(c.last4) : '') +
      ' · 额度 ¥' + fmt(c.credit_limit_cents) + ' · ' + esc(c.bill_day) + ' 账单日 / ' + esc(c.due_day) + ' 还款日</div></div>' +
      '<button class="btn sm" data-card="' + esc(c.id) + '">编辑</button></div>';
  }).join('');
}

/* ============ 页面切换 ============ */
var TITLES = { home: '首页', bills: '账单', reps: '还款', stats: '分析', settings: '设置' };
function showPage(p) {
  S.page = p;
  ['home', 'bills', 'reps', 'stats', 'settings'].forEach(function (k) {
    var el = document.getElementById('page-' + k);
    if (el) el.classList.toggle('hidden', k !== p);
  });
  Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) {
    b.classList.toggle('on', b.dataset.page === p);
  });
  $('#pageTitle').textContent = TITLES[p] || '';
  $('#pageSub').textContent = p === 'home' ? todayISO() : '';
  render();
  window.scrollTo(0, 0);
}
function render() {
  if (S.page === 'home') renderHome();
  if (S.page === 'bills') renderBills();
  if (S.page === 'reps') renderReps();
  if (S.page === 'stats') renderStats();
  if (S.page === 'settings') renderSettings();
}

/* ============ 弹层表单 ============ */
function fieldHTML(f) {
  var id = 'f_' + f.key, inner;
  if (f.type === 'select') {
    inner = '<select id="' + id + '">' + f.options.map(function (o) {
      return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(f.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('') + '</select>';
  } else if (f.type === 'bool') {
    inner = '<select id="' + id + '"><option value="1"' + (f.value ? ' selected' : '') + '>是</option><option value="0"' + (!f.value ? ' selected' : '') + '>否</option></select>';
  } else {
    var t = f.type === 'date' ? 'date' : (f.type === 'money' || f.type === 'number') ? 'number' : 'text';
    var extra = f.type === 'money' ? ' step="0.01" inputmode="decimal"' : (f.type === 'number' ? ' inputmode="numeric"' : '');
    inner = '<input id="' + id + '" type="' + t + '"' + extra + ' value="' + esc(f.value == null ? '' : f.value) + '" placeholder="' + esc(f.placeholder || '') + '">';
  }
  return '<label class="field"><span>' + esc(f.label) + '</span>' + inner + '</label>';
}
function openSheet(title, fields, onSubmit, footHTML) {
  var root = $('#sheetRoot');
  root.innerHTML = '<div class="sheet-mask" id="mask"><div class="sheet"><h3>' + esc(title) + '</h3><form id="sheetForm">' +
    fields.map(fieldHTML).join('') +
    (footHTML || '') +
    '<div class="btn-row" style="margin-top:10px"><button type="button" class="btn" id="sheetCancel">取消</button>' +
    '<button type="submit" class="btn primary">保存</button></div></form></div></div>';
  $('#sheetCancel').onclick = closeSheet;
  $('#mask').onclick = function (e) { if (e.target.id === 'mask') closeSheet(); };
  $('#sheetForm').onsubmit = async function (e) {
    e.preventDefault();
    var vals = {};
    fields.forEach(function (f) {
      var v = document.getElementById('f_' + f.key).value;
      if (f.type === 'money') vals[f.key] = toCents(v);
      else if (f.type === 'number') vals[f.key] = v === '' ? null : parseInt(v, 10);
      else if (f.type === 'bool') vals[f.key] = v === '1';
      else vals[f.key] = String(v || '').trim() || null;
    });
    try { await onSubmit(vals); closeSheet(); }
    catch (err) { toast('保存失败：' + err.message); }
  };
}
function closeSheet() { $('#sheetRoot').innerHTML = ''; }

/* ============ 业务动作 ============ */
async function addCard(c) {
  await sb('/rest/v1/credit_cards', { method: 'POST', headers: { Prefer: 'return=representation' }, body: c });
  await loadAll(); render();
}
function cardForm(c) {
  c = c || {};
  var fields = [
    { key: 'bank', label: '银行', type: 'text', value: c.bank, placeholder: '招商银行' },
    { key: 'alias', label: '别名', type: 'text', value: c.alias, placeholder: '招行主卡' },
    { key: 'last4', label: '卡号后四位', type: 'text', value: c.last4, placeholder: '1234' },
    { key: 'credit_limit', label: '信用额度（元）', type: 'money', value: c.credit_limit_cents ? (c.credit_limit_cents / 100) : '' },
    { key: 'bill_day', label: '账单日（每月几号）', type: 'number', value: c.bill_day || 5 },
    { key: 'due_day', label: '还款日（每月几号）', type: 'number', value: c.due_day || 23 },
    { key: 'auto_pay', label: '自动还款', type: 'bool', value: !!c.auto_pay },
    { key: 'is_active', label: '启用', type: 'bool', value: c.is_active !== false }
  ];
  openSheet(c.id ? '编辑信用卡' : '添加信用卡', fields, async function (v) {
    var body = {
      bank: v.bank, alias: v.alias, last4: v.last4,
      credit_limit_cents: v.credit_limit, bill_day: v.bill_day, due_day: v.due_day,
      auto_pay: v.auto_pay, is_active: v.is_active
    };
    if (!body.bank) throw new Error('银行必填');
    if (c.id) await sb('/rest/v1/credit_cards?id=eq.' + c.id, { method: 'PATCH', body: body });
    else await addCard(body);
    await loadAll(); render();
  }, c.id ? '<button type="button" class="btn danger block" id="delCard">删除这张卡</button>' : '');
  if (c.id) {
    $('#delCard').onclick = async function () {
      if (!confirm('删除后这张卡的账单和还款记录会一起删掉，确定？')) return;
      await sb('/rest/v1/credit_cards?id=eq.' + c.id, { method: 'DELETE' });
      closeSheet(); await loadAll(); render();
    };
  }
}
function billForm(b) {
  b = b || {};
  if (!S.cards.length) { toast('请先在设置里添加信用卡'); return; }
  var fields = [
    {
      key: 'card_id', label: '信用卡', type: 'select', value: b.card_id || S.cards[0].id,
      options: S.cards.map(function (c) { return { value: c.id, label: c.alias || c.bank }; })
    },
    { key: 'period', label: '账期（YYYY-MM）', type: 'text', value: b.period || periodOf(todayISO()), placeholder: '2026-11' },
    { key: 'amount', label: '账单金额（元）', type: 'money', value: b.amount_cents ? (b.amount_cents / 100) : '' },
    { key: 'min', label: '最低还款（元）', type: 'money', value: b.min_cents ? (b.min_cents / 100) : '' },
    { key: 'due_date', label: '到期还款日', type: 'date', value: b.due_date || '' },
    { key: 'note', label: '备注', type: 'text', value: b.note || '' }
  ];
  openSheet(b.id ? '编辑账单' : '记一笔账单', fields, async function (v) {
    if (!v.period || !/^\d{4}-\d{2}$/.test(v.period)) throw new Error('账期格式应为 2026-11');
    var body = {
      card_id: v.card_id, period: v.period, amount_cents: v.amount, min_cents: v.min || 0,
      due_date: v.due_date, note: v.note
    };
    if (b.id) {
      body.paid_cents = b.paid_cents || 0;
      body.status = body.paid_cents >= body.amount_cents ? 'paid' : (body.paid_cents > 0 ? 'partial' : 'unpaid');
      await sb('/rest/v1/bills?id=eq.' + b.id, { method: 'PATCH', body: body });
    } else {
      await sb('/rest/v1/bills', { method: 'POST', body: body });
    }
    await loadAll(); render();
  }, b.id ? '<button type="button" class="btn danger block" id="delBill">删除这笔账单</button>' : '');
  if (b.id) {
    $('#delBill').onclick = async function () {
      if (!confirm('确定删除这笔账单？')) return;
      await sb('/rest/v1/bills?id=eq.' + b.id, { method: 'DELETE' });
      closeSheet(); await loadAll(); render();
    };
  }
}
function repForm() {
  if (!S.cards.length) { toast('请先添加信用卡'); return; }
  var unpaid = S.bills.filter(function (b) { return billRemain(b) > 0; });
  var fields = [
    {
      key: 'card_id', label: '信用卡', type: 'select', value: unpaid.length ? unpaid[0].card_id : S.cards[0].id,
      options: S.cards.map(function (c) { return { value: c.id, label: c.alias || c.bank }; })
    },
    {
      key: 'bill_id', label: '对应账单', type: 'select', value: unpaid.length ? unpaid[0].id : '',
      options: [{ value: '', label: '不指定' }].concat(unpaid.map(function (b) {
        return { value: b.id, label: b.period + ' · 待还 ¥' + fmt(billRemain(b)) };
      }))
    },
    { key: 'amount', label: '还款金额（元）', type: 'money', value: unpaid.length ? (billRemain(unpaid[0]) / 100) : '' },
    { key: 'paid_at', label: '还款日期', type: 'date', value: todayISO() },
    { key: 'method', label: '还款方式', type: 'text', value: '手机银行', placeholder: '手机银行 / 自动扣款' },
    { key: 'note', label: '备注', type: 'text', value: '' }
  ];
  openSheet('记一笔还款', fields, async function (v) {
    if (!v.amount) throw new Error('金额必填');
    var bill = null;
    if (v.bill_id) { for (var i = 0; i < S.bills.length; i++) if (S.bills[i].id === v.bill_id) bill = S.bills[i]; }
    await sb('/rest/v1/repayments', {
      method: 'POST',
      body: {
        card_id: v.card_id, bill_id: v.bill_id || null, period: bill ? bill.period : null,
        amount_cents: v.amount, paid_at: v.paid_at || todayISO(), method: v.method, note: v.note
      }
    });
    if (bill) await syncBillPaid(bill.id);
    await loadAll(); render();
  });
}
async function syncBillPaid(billId) {
  var rows = await sb('/rest/v1/repayments?select=amount_cents&bill_id=eq.' + billId);
  var sum = 0;
  (rows || []).forEach(function (r) { sum += r.amount_cents || 0; });
  var bill = null;
  for (var i = 0; i < S.bills.length; i++) if (S.bills[i].id === billId) bill = S.bills[i];
  if (!bill) return;
  var status = sum >= (bill.amount_cents || 0) ? 'paid' : (sum > 0 ? 'partial' : 'unpaid');
  await sb('/rest/v1/bills?id=eq.' + billId, { method: 'PATCH', body: { paid_cents: sum, status: status } });
}
function fixedForm(f) {
  f = f || {};
  var fields = [
    { key: 'name', label: '名称', type: 'text', value: f.name, placeholder: '房贷 / 房租' },
    {
      key: 'type', label: '类型', type: 'select', value: f.type || 'mortgage',
      options: [{ value: 'mortgage', label: '房贷' }, { value: 'rent', label: '房租' }, { value: 'other', label: '其他' }]
    },
    { key: 'amount', label: '每月金额（元）', type: 'money', value: f.amount_cents ? (f.amount_cents / 100) : '' },
    { key: 'pay_day', label: '每月几号还款', type: 'number', value: f.pay_day || 15 },
    { key: 'remind_days', label: '提前几天提醒', type: 'number', value: f.remind_days || 5 },
    { key: 'start_period', label: '开始年月（可空）', type: 'text', value: f.start_period || '', placeholder: '2024-01' },
    { key: 'end_period', label: '结束年月（可空）', type: 'text', value: f.end_period || '', placeholder: '2044-01' },
    { key: 'auto_pay', label: '自动扣款', type: 'bool', value: f.auto_pay !== false },
    { key: 'is_active', label: '启用', type: 'bool', value: f.is_active !== false }
  ];
  openSheet(f.id ? '编辑固定月供' : '添加固定月供', fields, async function (v) {
    if (!v.name) throw new Error('名称必填');
    if (!v.amount) throw new Error('金额必填');
    if (!v.pay_day || v.pay_day < 1 || v.pay_day > 31) throw new Error('日期需在 1-31 之间');
    var body = {
      name: v.name, type: v.type, amount_cents: v.amount, pay_day: v.pay_day,
      remind_days: v.remind_days || 5, start_period: v.start_period, end_period: v.end_period,
      auto_pay: v.auto_pay, is_active: v.is_active
    };
    if (f.id) await sb('/rest/v1/fixed_payments?id=eq.' + f.id, { method: 'PATCH', body: body });
    else await sb('/rest/v1/fixed_payments', { method: 'POST', body: body });
    await loadAll(); render();
  }, f.id ? '<button type="button" class="btn danger block" id="delFixed">删除这条月供</button>' : '');
  if (f.id) {
    $('#delFixed').onclick = async function () {
      if (!confirm('删除后历史记录一起删掉，确定？')) return;
      await sb('/rest/v1/fixed_payments?id=eq.' + f.id, { method: 'DELETE' });
      closeSheet(); await loadAll(); render();
    };
  }
}

/* 标记已还 */
async function payBill(bill) {
  var rem = billRemain(bill);
  openSheet('标记已还 · ' + cardName(bill.card_id) + ' ' + bill.period, [
    { key: 'amount', label: '实还金额（元）', type: 'money', value: (rem / 100).toFixed(2) },
    { key: 'paid_at', label: '还款日期', type: 'date', value: todayISO() }
  ], async function (v) {
    await sb('/rest/v1/repayments', {
      method: 'POST',
      body: {
        card_id: bill.card_id, bill_id: bill.id, period: bill.period,
        amount_cents: v.amount, paid_at: v.paid_at || todayISO(), method: '快捷标记'
      }
    });
    await syncBillPaid(bill.id);
    await loadAll(); render();
  });
}
async function payFixed(f, period) {
  var due = dueDateOf(period, f.pay_day);
  openSheet('标记已还 · ' + f.name + ' ' + period, [
    { key: 'amount', label: '实还金额（元）', type: 'money', value: (f.amount_cents / 100).toFixed(2) },
    { key: 'paid_at', label: '还款日期', type: 'date', value: todayISO() }
  ], async function (v) {
    await sb('/rest/v1/fixed_payment_records?on_conflict=fixed_payment_id,period', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: {
        fixed_payment_id: f.id, period: period, due_date: due,
        due_cents: f.amount_cents, paid_cents: v.amount, paid_at: v.paid_at || todayISO(), status: 'paid'
      }
    });
    await loadAll(); render();
  });
}
async function unpayFixed(fid, period) {
  if (!confirm('撤销本月已还？')) return;
  await sb('/rest/v1/fixed_payment_records?fixed_payment_id=eq.' + fid + '&period=eq.' + period, { method: 'DELETE' });
  await loadAll(); render();
}

/* 找提醒项 */
function findReminder(key) {
  var list = reminders();
  for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
  return null;
}

/* ============ 事件绑定 ============ */
function bind() {
  Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) {
    b.onclick = function () { showPage(b.dataset.page); };
  });
  $('#btnRefresh').onclick = async function () {
    try { await loadAll(); render(); toast('已刷新'); } catch (e) { toast('刷新失败：' + e.message); }
  };
  $('#btnAddCard').onclick = function () { cardForm(null); };
  $('#btnAddBill').onclick = function () { billForm(null); };
  $('#btnAddRep').onclick = function () { repForm(); };
  $('#btnAddFixed').onclick = function () { fixedForm(null); };

  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.onclick = function () {
      S.billTab = b.dataset.tab;
      Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (x) { x.classList.toggle('on', x === b); });
      $('#billsCard').classList.toggle('hidden', S.billTab !== 'card');
      $('#billsFixed').classList.toggle('hidden', S.billTab !== 'fixed');
    };
  });

  document.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-pay],[data-bill],[data-fixed],[data-fpay],[data-unpay],[data-delrep],[data-card]');
    if (!t) return;
    try {
      if (t.dataset.pay) {
        var n = findReminder(t.dataset.pay);
        if (!n) return;
        if (n.kind === 'bill') payBill(n.bill); else payFixed(n.fixed, n.period);
      } else if (t.dataset.bill) {
        var b = null; for (var i = 0; i < S.bills.length; i++) if (S.bills[i].id === t.dataset.bill) b = S.bills[i];
        if (b) billForm(b);
      } else if (t.dataset.fixed) {
        var f = null; for (var j = 0; j < S.fixed.length; j++) if (S.fixed[j].id === t.dataset.fixed) f = S.fixed[j];
        if (f) fixedForm(f);
      } else if (t.dataset.fpay) {
        var p = t.dataset.fpay.split(':');
        var ff = null; for (var k = 0; k < S.fixed.length; k++) if (S.fixed[k].id === p[0]) ff = S.fixed[k];
        if (ff) payFixed(ff, p[1]);
      } else if (t.dataset.unpay) {
        var q = t.dataset.unpay.split(':');
        await unpayFixed(q[0], q[1]);
      } else if (t.dataset.delrep) {
        if (!confirm('删除这条还款记录？账单已还金额会重新计算。')) return;
        var rep = null; for (var m = 0; m < S.reps.length; m++) if (S.reps[m].id === t.dataset.delrep) rep = S.reps[m];
        await sb('/rest/v1/repayments?id=eq.' + t.dataset.delrep, { method: 'DELETE' });
        if (rep && rep.bill_id) await syncBillPaid(rep.bill_id);
        await loadAll(); render();
      } else if (t.dataset.card) {
        var c = null; for (var z = 0; z < S.cards.length; z++) if (S.cards[z].id === t.dataset.card) c = S.cards[z];
        if (c) cardForm(c);
      }
    } catch (err) { toast('操作失败：' + err.message); }
  });

  // 导出 / 导入
  $('#btnExport').onclick = function () {
    var data = { version: 1, exported_at: new Date().toISOString(), cards: S.cards, bills: S.bills, repayments: S.reps, fixed_payments: S.fixed, fixed_records: S.frecs };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '信用卡管家备份_' + todayISO() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  };
  $('#btnImport').onclick = function () {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json';
    inp.onchange = function () {
      var file = inp.files[0]; if (!file) return;
      var reader = new FileReader();
      reader.onload = async function () {
        try {
          var d = JSON.parse(reader.result);
          if (!confirm('导入会把备份数据合并进当前账号，确定？')) return;
          await restore(d);
          await loadAll(); render(); toast('导入完成');
        } catch (e) { toast('导入失败：' + e.message); }
      };
      reader.readAsText(file);
    };
    inp.click();
  };
  $('#btnLogout').onclick = function () {
    if (!confirm('退出登录？')) return;
    clearSession(); location.reload();
  };
}
async function restore(d) {
  var mapCard = {}, mapBill = {}, mapFixed = {};
  var uid = SESSION.user_id;
  for (var i = 0; i < (d.cards || []).length; i++) {
    var c = d.cards[i];
    var r = await sb('/rest/v1/credit_cards', { method: 'POST', headers: { Prefer: 'return=representation' }, body: { bank: c.bank, alias: c.alias, last4: c.last4, credit_limit_cents: c.credit_limit_cents, bill_day: c.bill_day, due_day: c.due_day, auto_pay: c.auto_pay, is_active: c.is_active, note: c.note } });
    mapCard[c.id] = r[0].id;
  }
  for (var j = 0; j < (d.bills || []).length; j++) {
    var b = d.bills[j]; if (!mapCard[b.card_id]) continue;
    var r2 = await sb('/rest/v1/bills', { method: 'POST', headers: { Prefer: 'return=representation' }, body: { card_id: mapCard[b.card_id], period: b.period, amount_cents: b.amount_cents, min_cents: b.min_cents, paid_cents: b.paid_cents, due_date: b.due_date, status: b.status, note: b.note } });
    mapBill[b.id] = r2[0].id;
  }
  for (var k = 0; k < (d.fixed_payments || []).length; k++) {
    var f = d.fixed_payments[k];
    var r3 = await sb('/rest/v1/fixed_payments', { method: 'POST', headers: { Prefer: 'return=representation' }, body: { name: f.name, type: f.type, pay_day: f.pay_day, amount_cents: f.amount_cents, start_period: f.start_period, end_period: f.end_period, auto_pay: f.auto_pay, remind_days: f.remind_days, is_active: f.is_active, note: f.note } });
    mapFixed[f.id] = r3[0].id;
  }
  for (var m = 0; m < (d.repayments || []).length; m++) {
    var rp = d.repayments[m]; if (!mapCard[rp.card_id]) continue;
    await sb('/rest/v1/repayments', { method: 'POST', body: { card_id: mapCard[rp.card_id], bill_id: mapBill[rp.bill_id] || null, period: rp.period, amount_cents: rp.amount_cents, paid_at: rp.paid_at, method: rp.method, note: rp.note } });
  }
  for (var n = 0; n < (d.fixed_records || []).length; n++) {
    var fr = d.fixed_records[n]; if (!mapFixed[fr.fixed_payment_id]) continue;
    await sb('/rest/v1/fixed_payment_records?on_conflict=fixed_payment_id,period', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: { fixed_payment_id: mapFixed[fr.fixed_payment_id], period: fr.period, due_date: fr.due_date, due_cents: fr.due_cents, paid_cents: fr.paid_cents, paid_at: fr.paid_at, status: fr.status, note: fr.note } });
  }
}

/* ============ 启动 ============ */
function showAuth() {
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
}
function showApp() {
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
}
function authMsg(text, ok) {
  var m = $('#authMsg');
  m.textContent = text;
  m.className = 'msg show ' + (ok ? 'ok' : 'err');
}
async function boot() {
  loadSession();
  if (!BASE || !ANON || BASE.indexOf('__') === 0) {
    showAuth();
    authMsg('还没配置数据库，请先填 config.js');
    return;
  }
  if (!SESSION) { showAuth(); return; }

  $('#btnLogin').onclick = async function () {
    var email = $('#authEmail').value.trim(), pass = $('#authPass').value;
    if (!email || !pass) { authMsg('请填邮箱和密码'); return; }
    try { await signIn(email, pass); await startApp(); }
    catch (e) { authMsg(e.message); }
  };
  $('#btnSignup').onclick = async function () {
    var email = $('#authEmail').value.trim(), pass = $('#authPass').value;
    if (!email || !pass || pass.length < 6) { authMsg('请填邮箱和至少 6 位密码'); return; }
    try {
      var logged = await signUp(email, pass);
      if (logged) { await startApp(); }
      else { authMsg('注册成功，请去邮箱点确认链接，然后回来登录', true); }
    } catch (e) { authMsg(e.message); }
  };

  try { await startApp(); }
  catch (e) {
    showAuth();
    authMsg(e.message === '未登录' ? '' : ('连接失败：' + e.message));
  }
}
async function startApp() {
  await loadAll();
  showApp();
  bind();
  showPage('home');
}

document.addEventListener('DOMContentLoaded', boot);
})();
