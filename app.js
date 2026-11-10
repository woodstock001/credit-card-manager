/* 信用卡管家 · 自用版
 * 纯前端，无框架、无外部依赖，直接调用 Supabase REST 接口
 */
(function () {
'use strict';

var CFG = window.APP_CONFIG || {};
var BASE = (CFG.SUPABASE_URL || '').replace(/\/+$/, '');
var ANON = CFG.SUPABASE_ANON_KEY || '';
var LS_KEY = 'ccm_session_v1';

var S = { cards: [], bills: [], reps: [], fixed: [], frecs: [], ledger: [], lmonth: null, ledgerErr: null, page: 'home', billTab: 'card' };
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
/* 由账期 + 日号算具体日期
 * 传了 billDay 就按信用卡规则处理跨月：
 *   还款日 <= 账单日 → 落在次月（例：5 号账单日 / 1 号还款日 → 次月 1 号）
 *   还款日 >  账单日 → 落在本月
 */
function dueDateOf(period, day, billDay) {
  var y = parseInt(period.slice(0, 4), 10), m = parseInt(period.slice(5, 7), 10);
  var d = parseInt(day, 10) || 1;
  var b = parseInt(billDay, 10) || 0;
  if (b > 0 && d <= b) { m += 1; if (m > 12) { m = 1; y += 1; } }
  d = Math.min(d, lastDay(y, m));
  return y + '-' + p2(m) + '-' + p2(d);
}
/* 还款日是否落在次月 */
function dueNextMonth(billDay, dueDay) {
  var b = parseInt(billDay, 10) || 5, d = parseInt(dueDay, 10) || 23;
  return d <= b;
}
/* 还款日的文字描述：当月23日 / 次月1日 */
function dueDayLabel(billDay, dueDay) {
  var d = parseInt(dueDay, 10) || 23;
  return (dueNextMonth(billDay, dueDay) ? '次月' : '当月') + d + '日';
}

/* ---------- 年费 ----------
 * annual_fee_month      每年几月扣年费（1-12），空 = 这张卡没有年费
 * annual_fee_rule       免年费条件，纯文字，自己录入（如「刷6次免」）
 * annual_fee_waived_year 标记「今年已免」时写入年份
 *
 * 「第二年自动变回未免」不靠定时任务：只存年份，渲染时跟当前年份比，
 * 等于今年才显示已免，跨年自动就是未免。
 */
function annualFeeState(c) {
  var m = parseInt(c && c.annual_fee_month, 10);
  if (!m || m < 1 || m > 12) return null;
  var y = new Date().getFullYear();
  var waived = parseInt(c.annual_fee_waived_year, 10) === y;
  var due = y + '-' + p2(m) + '-01';
  var days = daysFromToday(due);
  var endOfMonth = y + '-' + p2(m) + '-' + p2(lastDay(y, m));
  var daysToEnd = daysFromToday(endOfMonth);
  return {
    month: m, year: y, due: due, days: days, daysToEnd: daysToEnd,
    waived: waived, rule: (c.annual_fee_rule || '').trim(),
    /* 该进提醒：今年还没标已免，且落在「年费月前 5 天 ~ 该月最后一天」区间 */
    alert: !waived && days <= 5 && daysToEnd >= 0
  };
}
/* 年费在界面上的短描述：6月 · 刷6次免 */
function annualFeeText(c) {
  var fs = annualFeeState(c);
  if (!fs) return '';
  return fs.month + '月年费' + (fs.rule ? ' · ' + fs.rule : '');
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

  /* 记账表单独加载：万一还没建表，也不该把整个 App 拖垮 */
  try {
    S.ledger = (await sb('/rest/v1/ledger?select=*&order=entry_date.desc&limit=3000')) || [];
    S.ledgerErr = null;
  } catch (e) {
    S.ledger = []; S.ledgerErr = (e && e.message) || '加载失败';
  }
}

/* ============ 提醒计算 ============ */
function reminders() {
  var out = [];
  S.bills.forEach(function (b) {
    var rem = billRemain(b);
    if (rem <= 0) return;
    var c = cardById(b.card_id);
    var due = b.due_date || (b.period ? dueDateOf(b.period, (c && c.due_day) || 23, (c && c.bill_day) || 5) : null);
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
  /* 年费：到年费月前 5 天开始提示，标记「今年已免」后消失 */
  S.cards.forEach(function (c) {
    if (c.is_active === false) return;
    var fs = annualFeeState(c);
    if (!fs || !fs.alert) return;
    out.push({
      kind: 'annualfee', key: 'a:' + c.id,
      title: c.alias || c.bank || '信用卡',
      sub: annualFeeText(c), due: fs.due, days: fs.days,
      amount: 0, card: c, fee: fs
    });
  });
  out.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
  return out;
}
function feeTag(days) {
  if (days < 0) return '<span class="tag orange">年费月已到</span>';
  if (days === 0) return '<span class="tag orange">本月年费月</span>';
  if (days <= 5) return '<span class="tag orange">还有 ' + days + ' 天</span>';
  return '<span class="tag gray">还有 ' + days + ' 天</span>';
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
    var isFee = n.kind === 'annualfee';
    var cls = n.days < 0 ? 'danger' : (n.days <= 5 ? 'warn' : 'ok');
    var head = n.days < 0 ? ('已到年费月 ' + (-n.days) + ' 天') : (n.days === 0 ? '本月是年费月' : ('还有 ' + n.days + ' 天到年费月'));
    if (!isFee) head = n.days < 0 ? ('已逾期 ' + (-n.days) + ' 天') : (n.days === 0 ? '今天到期' : ('还有 ' + n.days + ' 天'));
    box.innerHTML =
      '<div class="alert ' + cls + '">' +
      '<div class="lbl">' + esc(n.title) + ' · ' + esc(n.sub) + ' · ' + esc(n.due) + '</div>' +
      '<div class="row"><div>' +
        (isFee ? '<div class="big" style="font-size:17px">年费月</div>' : '<div class="big">¥' + fmt(n.amount) + '</div>') +
        '<div class="small" style="margin-top:2px">' + esc(head) + '</div></div>' +
      (isFee
        ? '<button class="btn sm" data-feewaive="' + esc(n.card.id) + '">标记已免</button>'
        : '<button class="btn sm" data-pay="' + esc(n.key) + '">标记已还</button>') +
      '</div></div>';
  }

  var cur = periodOf(todayISO());
  var monthBill = 0, monthPaid = 0, overdue = 0;
  S.bills.forEach(function (b) {
    if (periodOf(b.period) === cur) { monthBill += b.amount_cents || 0; monthPaid += b.paid_cents || 0; }
    if (billRemain(b) > 0) {
      var c0 = cardById(b.card_id) || {};
      var due = b.due_date || dueDateOf(b.period, c0.due_day || 23, c0.bill_day || 5);
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
    var isFee = n.kind === 'annualfee';
    return '<div class="item"><div class="grow"><div class="t1">' + esc(n.title) + (isFee ? feeTag(n.days) : statusTag(n.days)) + '</div>' +
      '<div class="t2">' + esc(n.sub) + (isFee ? '' : ' · 到期 ' + esc(n.due)) + '</div></div>' +
      '<div style="text-align:right">' +
        (isFee ? '<div class="amt" style="font-size:13px;color:var(--muted)">年费</div>' : '<div class="amt">¥' + fmt(n.amount) + '</div>') +
        (isFee
          ? '<button class="btn sm" data-feewaive="' + esc(n.card.id) + '" style="margin-top:4px">已免</button>'
          : '<button class="btn sm" data-pay="' + esc(n.key) + '" style="margin-top:4px">已还</button>') +
      '</div></div>';
  }).join('');
}
function kpi(k, v) { return '<div class="box"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>'; }

/* ============ 账单页：按卡一屏（对齐 51 信用卡管家） ============ */

/* 银行主题色 */
var BANK_COLOR = [
  ['邮储', '#00713c'], ['邮政', '#00713c'], ['工行', '#c7000b'], ['工商', '#c7000b'],
  ['招行', '#e60012'], ['招商', '#e60012'], ['建行', '#0066b3'], ['建设', '#0066b3'],
  ['农行', '#00954e'], ['农业', '#00954e'], ['中行', '#a8121f'], ['中国', '#a8121f'],
  ['交行', '#0055a5'], ['交通', '#0055a5'], ['平安', '#e8590c'], ['中信', '#c8102e'],
  ['浦发', '#005bac'], ['民生', '#0b4ea2'], ['兴业', '#0056a4'], ['光大', '#7b2d8e'],
  ['华夏', '#c8102e'], ['广发', '#c8102e'], ['北京', '#c8102e'], ['上海', '#005bac'],
  ['宁波', '#005bac'], ['江苏', '#c8102e'], ['杭州', '#005bac'], ['成都', '#c8102e'],
  ['花旗', '#056dae'], ['渣打', '#0072aa']
];
function bankColor(name) {
  var s = String(name || '');
  for (var i = 0; i < BANK_COLOR.length; i++) if (s.indexOf(BANK_COLOR[i][0]) >= 0) return BANK_COLOR[i][1];
  return '#4a5a70';
}
function bankInitial(name) {
  var s = String(name || '').replace(/银行|信用卡|储蓄卡/g, '').trim();
  return s ? s.charAt(0) : '卡';
}

/* 最长免息天数
 * 公式：一个完整账单周期（约 31 天）+ 账单日到还款日的宽限天数
 * 例：账单日 5 号 / 还款日 23 号 → 31 + 18 = 49 天
 */
function graceDays(billDay, dueDay) {
  var b = parseInt(billDay, 10) || 5;
  var d = parseInt(dueDay, 10) || 23;
  var gap = d - b;
  if (gap <= 0) gap += 31;      /* 还款日落在次月 */
  return gap + 31;              /* 加一个完整账单周期 */
}

/* 某张卡的当前状态 */
function cardState(c) {
  var cur = periodOf(todayISO());
  var billDay = c.bill_day || 5;
  var dueDay = c.due_day || 23;
  var bills = S.bills.filter(function (b) { return b.card_id === c.id; })
    .sort(function (a, b) { return a.period < b.period ? 1 : a.period > b.period ? -1 : 0; });

  /* 1. 有未还清账单 → 取到期最早的那一期 */
  var unpaid = bills.filter(function (b) { return billRemain(b) > 0; });
  if (unpaid.length) {
    unpaid.sort(function (a, b) {
      var da = a.due_date || dueDateOf(a.period, dueDay, billDay);
      var db = b.due_date || dueDateOf(b.period, dueDay, billDay);
      return da < db ? -1 : da > db ? 1 : 0;
    });
    var b0 = unpaid[0];
    var due0 = b0.due_date || dueDateOf(b0.period, dueDay, billDay);
    return {
      type: 'unpaid', bill: b0, amount: billRemain(b0),
      label: (b0.paid_cents || 0) > 0 ? '剩余应还' : '本期账单',
      due: due0, days: daysFromToday(due0),
      btn: '还款', btnCls: 'pay'
    };
  }

  /* 2. 无欠款 → 看出账状态 */
  var thisBillDate = dueDateOf(cur, billDay);
  var dd = daysFromToday(thisBillDate);
  var hasThisMonth = false;
  for (var i = 0; i < bills.length; i++) if (periodOf(bills[i].period) === cur) { hasThisMonth = true; break; }

  if (hasThisMonth) {
    return {
      type: 'cleared', bill: bills[0], amount: 0, label: '本期已还清',
      due: thisBillDate, days: dd,
      mark: thisBillDate.slice(5), markUnit: '已出账',
      btn: '本期已还清', btnCls: 'done'
    };
  }
  if (dd <= 0) {
    return {
      type: 'missing', amount: 0, label: '待录入账单',
      due: thisBillDate, days: dd,
      mark: thisBillDate.slice(5), markUnit: '已出账',
      btn: '去录入', btnCls: 'todo'
    };
  }
  return {
    type: 'pending', amount: 0, label: '未出账单',
    due: thisBillDate, days: dd,
    mark: thisBillDate.slice(5), markUnit: '天后出账',
    btn: '本期无需还', btnCls: 'done'
  };
}

/* 某条固定支出的本月状态 */
function fixedState(f) {
  if (!f || f.is_active === false) return null;
  var cur = periodOf(todayISO());
  if (f.start_period && cur < f.start_period) return null;
  if (f.end_period && cur > f.end_period) return null;
  var due = dueDateOf(cur, f.pay_day);
  var rec = null;
  for (var i = 0; i < S.frecs.length; i++) {
    if (S.frecs[i].fixed_payment_id === f.id && S.frecs[i].period === cur) { rec = S.frecs[i]; break; }
  }
  var paid = !!(rec && rec.status === 'paid');
  return {
    type: paid ? 'fcleared' : 'funpaid', fixed: f, period: cur, rec: rec,
    amount: paid ? 0 : (f.amount_cents || 0),
    label: paid ? '本期已还清' : '本期应还',
    due: due, days: daysFromToday(due),
    mark: due.slice(5), markUnit: paid ? '已还' : '',
    btn: paid ? '本期已还' : '还款', btnCls: paid ? 'done' : 'pay'
  };
}

/* 组装混排列表：有欠款的在前，其余按到期日 */
/* 账单页分四档，档内再按各自日期排
 *   0 有欠款      → 按到期日（越早越靠上）
 *   1 待录入账单  → 按出账日（账单日已过但还没录）
 *   2 将要出账    → 按出账日
 *   3 已还清      → 沉到最下面
 */
function boardLevel(st) {
  if (st.type === 'unpaid' || st.type === 'funpaid') return 0;
  if (st.type === 'missing') return 1;
  if (st.type === 'pending') return 2;
  return 3;
}

function boardItems() {
  var out = [];
  S.cards.forEach(function (c) {
    if (c.is_active === false) return;
    var st = cardState(c);
    out.push({
      kind: 'card', card: c, st: st, key: st.due || '9999-99-99',
      lv: boardLevel(st)
    });
  });
  S.fixed.forEach(function (f) {
    var st = fixedState(f);
    if (!st) return;
    out.push({ kind: 'fixed', fixed: f, st: st, key: st.due || '9999-99-99', lv: boardLevel(st) });
  });
  out.sort(function (a, b) {
    if (a.lv !== b.lv) return a.lv - b.lv;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return out;
}

/* 右侧倒计时区域 */
function daysHTML(st) {
  var d = st.days;
  if (st.type === 'unpaid' || st.type === 'funpaid') {
    if (d === 0) return '<div class="cc-days"><div class="cc-d sm">今</div><div class="cc-dt">天到期<b>' + esc(st.due.slice(5)) + '</b></div></div>';
    if (d < 0) return '<div class="cc-days"><div class="cc-d red">' + (-d) + '</div><div class="cc-dt">天前逾期<b>' + esc(st.due.slice(5)) + '</b></div></div>';
    return '<div class="cc-days"><div class="cc-d">' + d + '</div><div class="cc-dt">天后到期<b>' + esc(st.due.slice(5)) + '</b></div></div>';
  }
  if (st.type === 'pending') {
    if (d === 0) return '<div class="cc-days"><div class="cc-d sm">今</div><div class="cc-dt">天出账<b>' + esc(st.mark) + '</b></div></div>';
    return '<div class="cc-days"><div class="cc-d">' + d + '</div><div class="cc-dt">天后出账<b>' + esc(st.mark) + '</b></div></div>';
  }
  return '<div class="cc-days"><div class="cc-d sm">' + esc(st.mark || '') + '</div><div class="cc-dt">' + esc(st.markUnit || '已出账') + '</div></div>';
}

/* 当前渲染出来的条目索引 */
var BOARD = {};

function renderBills() {
  BOARD = {};
  var items = boardItems();
  var host = $('#cardBoard');

  /* --- 汇总：全部待还 --- */
  var totalDue = 0;
  items.forEach(function (it) {
    if (it.st.type === 'unpaid' || it.st.type === 'funpaid') totalDue += it.st.amount;
  });
  var sd = $('#sumDue');
  if (sd) {
    sd.className = 's-item' + (totalDue > 0 ? '' : ' zero');
    sd.innerHTML = '<div class="s-k">全部待还</div><div class="s-v">¥' + fmt(totalDue) + '<span class="arw">\u203a</span></div>';
  }

  /* --- 汇总：最长免息 --- */
  var bestDays = 0, bestCard = null;
  S.cards.forEach(function (c) {
    if (c.is_active === false) return;
    var g = graceDays(c.bill_day, c.due_day);
    if (g > bestDays) { bestDays = g; bestCard = c; }
  });
  var sg = $('#sumGrace');
  if (sg) {
    sg.innerHTML = bestCard
      ? '<div class="s-k">最长免息</div><div class="s-v">' + bestDays + ' 天<span class="arw">\u203a</span></div>'
      : '<div class="s-k">最长免息</div><div class="s-v">--<span class="arw">\u203a</span></div>';
  }

  if (!items.length) {
    host.innerHTML = '<div class="card"><div class="empty"><span class="ico">\ud83d\udcb3</span>' +
      '还没有信用卡和固定支出<br><span class="small">去「设置」里添加第一张卡</span></div></div>';
    return;
  }

  host.innerHTML = items.map(function (it) {
    var st = it.st;
    var isCard = it.kind === 'card';
    var name, logoBg, logoCh;

    if (isCard) {
      var c = it.card;
      name = (c.alias || c.bank || '信用卡') + (c.last4 ? ' ' + c.last4 : '');
      logoBg = bankColor(c.bank || c.alias);
      logoCh = bankInitial(c.bank || c.alias);
    } else {
      name = it.fixed.name;
      logoBg = '#4a7ab5';
      logoCh = bankInitial(it.fixed.name);
    }

    var ov = ((st.type === 'unpaid' || st.type === 'funpaid') && st.days < 0);
    var dimmed = (st.btnCls === 'done') ? ' dimmed' : '';
    var id = (isCard ? 'c:' : 'f:') + (isCard ? it.card.id : it.fixed.id);
    BOARD[id] = it;

    var amt = st.amount > 0
      ? '<div class="cc-num">' + fmt(st.amount) + '</div>'
      : '<div class="cc-num dim">--</div>';

    return '<div class="cc' + (ov ? ' overdue' : '') + dimmed + '">' +
      '<div class="cc-head">' +
        '<span class="cc-logo" style="background:' + logoBg + '">' + esc(logoCh) + '</span>' +
        '<span class="cc-name">' + esc(name) + '</span>' +
        '<button class="cc-more" data-more="' + esc(id) + '">\u00b7\u00b7\u00b7</button>' +
      '</div>' +
      '<div class="cc-body">' +
        '<div class="cc-amt">' + amt + '<div class="cc-lab">' + esc(st.label) + '</div></div>' +
        daysHTML(st) +
        '<button class="cc-btn ' + st.btnCls + '" data-main="' + esc(id) + '">' + esc(st.btn) + '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

/* ---------- 全部待还明细 ---------- */
function showDueDetail() {
  var items = boardItems().filter(function (it) {
    return it.st.type === 'unpaid' || it.st.type === 'funpaid';
  });
  var body = items.length
    ? items.map(function (it) {
      var nm = it.kind === 'card'
        ? ((it.card.alias || it.card.bank) + (it.card.last4 ? ' ' + it.card.last4 : ''))
        : it.fixed.name;
      return '<div class="calc-row" style="padding:8px 0"><span>' + esc(nm) +
        '<br><span class="small muted">' + esc(it.st.due) +
        (it.st.days < 0 ? ' · 已逾期' : it.st.days === 0 ? ' · 今天到期' : ' · ' + it.st.days + ' 天后') +
        '</span></span><b>¥' + fmt(it.st.amount) + '</b></div>';
    }).join('')
    : '<div class="empty" style="padding:20px">全部结清，没有待还</div>';
  var total = items.reduce(function (s, it) { return s + it.st.amount; }, 0);
  var root = $('#sheetRoot');
  root.innerHTML = '<div class="sheet-mask" id="mask"><div class="sheet">' +
    '<h3>全部待还 ¥' + fmt(total) + '</h3>' +
    '<div class="calc" style="padding:6px 13px">' + body + '</div>' +
    '<button type="button" class="btn block" id="dClose">关闭</button>' +
    '</div></div>';
  $('#dClose').onclick = closeSheet;
  $('#mask').onclick = function (e) { if (e.target.id === 'mask') closeSheet(); };
}

/* ---------- 最长免息明细 ---------- */
function showGraceDetail() {
  var rows = S.cards.filter(function (c) { return c.is_active !== false; }).map(function (c) {
    return { card: c, g: graceDays(c.bill_day, c.due_day) };
  }).sort(function (a, b) { return b.g - a.g; });

  var body = rows.length
    ? rows.map(function (r) {
      var nm = (r.card.alias || r.card.bank) + (r.card.last4 ? ' ' + r.card.last4 : '');
      return '<div class="bar-row"><div class="lab"><span>' + esc(nm) +
        '</span><span>' + r.g + ' 天 · ' + esc(r.card.bill_day) + ' 日账单 / ' + esc(dueDayLabel(r.card.bill_day, r.card.due_day)) + '还款</span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' +
        Math.min(100, r.g / Math.max(1, rows[0].g) * 100).toFixed(1) + '%"></div></div></div>';
    }).join('')
    : '<div class="empty" style="padding:20px">还没有信用卡</div>';

  var root = $('#sheetRoot');
  root.innerHTML = '<div class="sheet-mask" id="mask"><div class="sheet">' +
    '<h3>免息期排行</h3>' +
    '<p class="small muted" style="margin:-6px 0 12px">= 一个完整账单周期（约 31 天）+ 账单日到还款日的宽限天数。天数越长，越适合把大额消费放这张卡。</p>' +
    '<div>' + body + '</div>' +
    '<button type="button" class="btn block" id="gClose" style="margin-top:12px">关闭</button>' +
    '</div></div>';
  $('#gClose').onclick = closeSheet;
  $('#mask').onclick = function (e) { if (e.target.id === 'mask') closeSheet(); };
}

/* ---------- 三点菜单 ---------- */
function openMenu(id) {
  var it = BOARD[id];
  if (!it) return;
  var st = it.st;
  var rows = [];

  if (it.kind === 'card') {
    if (st.type === 'unpaid') {
      rows.push({ a: 'pay', t: '标记已还金额', s: '输入已还金额，剩余未还会自动换算' });
    }
    if (st.bill) {
      rows.push({ a: 'bill', t: '修改本期账单', s: '账单金额、最低还款、到期日' });
    } else {
      rows.push({ a: 'bill', t: '录入本期账单', s: '本期还没出账，也可以提前录' });
    }
    var fs = annualFeeState(it.card);
    if (fs) {
      if (fs.waived) {
        rows.push({ a: 'feeunwaive', t: '撤销今年已免', s: fs.year + ' 年年费已标记为免，点这里改回未处理' });
      } else {
        rows.push({ a: 'feewaive', t: '标记今年年费已免', s: annualFeeText(it.card) });
      }
    }
    rows.push({ a: 'edit', t: '编辑卡片信息', s: '额度、账单日、还款日、年费' });
    rows.push({ a: 'reps', t: '查看还款记录' });
  } else {
    if (st.type === 'funpaid') {
      rows.push({ a: 'pay', t: '标记本月已还', s: '输入实还金额' });
    } else {
      rows.push({ a: 'unpay', t: '撤销本月已还' });
    }
    rows.push({ a: 'edit', t: '编辑这条固定支出', s: '金额、每月几号、起止年月' });
  }

  var html = rows.map(function (r) {
    return '<button class="act" data-m="' + r.a + '">' + esc(r.t) +
      (r.s ? '<span class="sub">' + esc(r.s) + '</span>' : '') + '</button>';
  }).join('') + '<button class="act cancel" data-m="cancel">取消</button>';

  var root = $('#sheetRoot');
  root.innerHTML = '<div class="sheet-mask" id="mask"><div class="sheet" style="padding:0">' +
    '<div class="acts">' + html + '</div></div></div>';
  $('#mask').onclick = function (e) { if (e.target.id === 'mask') closeSheet(); };
  Array.prototype.forEach.call(root.querySelectorAll('[data-m]'), function (b) {
    b.onclick = async function () {
      var a = b.dataset.m;
      closeSheet();
      if (a === 'cancel') return;
      if (a === 'pay') {
        if (it.kind === 'card') paySheet(st.bill);
        else payFixed(it.fixed, st.period);
      } else if (a === 'bill') {
        var cur = periodOf(todayISO());
        billForm(st.bill || {
          card_id: it.card.id, period: cur,
          due_date: dueDateOf(cur, it.card.due_day || 23, it.card.bill_day || 5)
        });
      } else if (a === 'edit') {
        if (it.kind === 'card') cardForm(it.card); else fixedForm(it.fixed);
      } else if (a === 'unpay') {
        unpayFixed(it.fixed.id, st.period);
      } else if (a === 'feewaive') {
        await setAnnualFeeWaived(it.card.id, true);
      } else if (a === 'feeunwaive') {
        await setAnnualFeeWaived(it.card.id, false);
      } else if (a === 'reps') {
        showPage('reps');
      }
    };
  });
}

/* 标记 / 撤销「今年年费已免」 */
async function setAnnualFeeWaived(cardId, waived) {
  var y = new Date().getFullYear();
  try {
    await sb('/rest/v1/credit_cards?id=eq.' + cardId, {
      method: 'PATCH', body: { annual_fee_waived_year: waived ? y : null }
    });
  } catch (e) {
    if (/annual_fee/.test(String(e && e.message))) { toast('年费字段还没建，先在 Supabase 跑升级 SQL'); return; }
    throw e;
  }
  await loadAll(); render();
  toast(waived ? (y + ' 年年费已标记为免') : ('已撤销，' + y + ' 年年费恢复未处理'));
}

/* 主按钮点击 */
function mainAction(id) {
  var it = BOARD[id];
  if (!it) return;
  var st = it.st;
  if (st.btnCls === 'pay') {
    if (it.kind === 'card') paySheet(st.bill);
    else payFixed(it.fixed, st.period);
  } else if (st.type === 'missing') {
    var cur = periodOf(todayISO());
    billForm({ card_id: it.card.id, period: cur, due_date: st.due });
  } else {
    openMenu(id);
  }
}

/* ---------- 标记已还金额（实时换算剩余） ---------- */
function paySheet(bill) {
  if (!bill) { toast('还没有本期账单，先录入金额'); return; }
  var rem = billRemain(bill);
  var prev = bill.paid_cents || 0;
  var title = cardName(bill.card_id) + ' · ' + bill.period + ' 账单';
  var root = $('#sheetRoot');

  root.innerHTML = '<div class="sheet-mask" id="mask"><div class="sheet">' +
    '<h3>' + esc(title) + '</h3>' +
    '<div class="calc">' +
      '<div class="calc-row"><span>本期账单</span><b>¥' + fmt(bill.amount_cents) + '</b></div>' +
      (prev > 0 ? '<div class="calc-row"><span>之前已还</span><b>¥' + fmt(prev) + '</b></div>' : '') +
      '<div class="calc-row"><span>当前剩余</span><b>¥' + fmt(rem) + '</b></div>' +
    '</div>' +
    '<label class="field"><span>本次已还金额（元）</span>' +
      '<input id="payAmt" type="number" step="0.01" inputmode="decimal" value="' + (rem / 100).toFixed(2) + '">' +
    '</label>' +
    '<div class="calc" style="margin-bottom:12px">' +
      '<div class="calc-row big" style="border-top:none;margin-top:0;padding-top:0">' +
        '<span>剩余未还</span><b id="payLeft">¥0.00</b></div>' +
    '</div>' +
    '<label class="field"><span>还款日期</span><input id="payDate" type="date" value="' + todayISO() + '"></label>' +
    '<div class="btn-row"><button type="button" class="btn" id="payCancel">取消</button>' +
    '<button type="button" class="btn primary" id="payOk">确认已还</button></div>' +
    '</div></div>';

  function recalc() {
    var v = toCents($('#payAmt').value);
    var left = Math.max(0, rem - v);
    var el = $('#payLeft');
    if (!el) return;
    el.textContent = '¥' + fmt(left);
    el.className = left === 0 ? 'ok' : '';
  }
  $('#payAmt').oninput = recalc;
  recalc();
  $('#payCancel').onclick = closeSheet;
  $('#mask').onclick = function (e) { if (e.target.id === 'mask') closeSheet(); };

  $('#payOk').onclick = async function () {
    var v = toCents($('#payAmt').value);
    if (!v || v <= 0) { toast('请输入大于 0 的金额'); return; }
    var btn = $('#payOk');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await sb('/rest/v1/repayments', {
        method: 'POST',
        body: {
          card_id: bill.card_id, bill_id: bill.id, period: bill.period,
          amount_cents: v, paid_at: $('#payDate').value || todayISO(), method: '标记已还'
        }
      });
      await syncBillPaid(bill.id);
      await loadAll();
      closeSheet();
      render();
      toast('已记录，剩余未还 ¥' + fmt(Math.max(0, rem - v)));
    } catch (e) {
      toast('保存失败：' + e.message);
      btn.disabled = false; btn.textContent = '确认已还';
    }
  };
}

/* ---------- 设置页：固定支出列表 ---------- */
function renderFixedSettingList() {
  var host = $('#fixedSettingList');
  if (!host) return;
  if (!S.fixed.length) { host.innerHTML = '<div class="empty" style="padding:20px">还没有固定支出</div>'; return; }
  var names = { mortgage: '房贷', rent: '房租', other: '其他' };
  host.innerHTML = S.fixed.map(function (f) {
    return '<div class="item"><div class="grow"><div class="t1">' + esc(f.name) +
      (f.is_active === false ? '<span class="tag gray">停用</span>' : '') + '</div>' +
      '<div class="t2">' + esc(names[f.type] || '其他') + ' · 每月 ' + esc(f.pay_day) + ' 号 · ¥' +
      fmt(f.amount_cents) + '</div></div>' +
      '<button class="btn sm" data-fixed="' + esc(f.id) + '">编辑</button></div>';
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
  if (!S.cards.length) {
    host.innerHTML = '<div class="empty" style="padding:20px">还没有信用卡</div>';
  } else {
    host.innerHTML = S.cards.map(function (c) {
      return '<div class="item"><div class="grow"><div class="t1">' + esc(c.alias || c.bank) + (c.is_active === false ? '<span class="tag gray">停用</span>' : '') + '</div>' +
        '<div class="t2">' + esc(c.bank) + (c.last4 ? ' · 尾号 ' + esc(c.last4) : '') +
        ' · 额度 ¥' + fmt(c.credit_limit_cents) + ' · ' + esc(c.bill_day) + ' 日账单 / ' + esc(dueDayLabel(c.bill_day, c.due_day)) + '还款' +
        (annualFeeState(c) ? '<br>年费 ' + esc(annualFeeState(c).month) + ' 月' +
          (annualFeeState(c).rule ? ' · ' + esc(annualFeeState(c).rule) : '') + ' · ' +
          (annualFeeState(c).waived
            ? '<span style="color:var(--ok)">' + annualFeeState(c).year + ' 年已免 ✓</span>'
            : '<span style="color:var(--warn)">' + annualFeeState(c).year + ' 年未处理</span>')
          : '') +
        '</div></div>' +
        '<button class="btn sm" data-card="' + esc(c.id) + '">编辑</button></div>';
    }).join('');
  }
  renderFixedSettingList();
}

/* ============ 页面切换 ============ */
/* ============ 记账（日常收支） ============
 * 只记当场付出去的钱（微信 / 支付宝 / 现金）。
 * 信用卡刷卡不记在这里 —— 那部分已经进「账单」页变成欠款了，
 * 再记一遍会让月度总支出翻倍。
 */
var LEDGER_CATS = {
  out: ['餐饮', '交通', '购物', '日用', '医疗', '教育', '人情', '娱乐', '居住', '其他'],
  'in': ['工资', '奖金', '报销', '理财', '其他']
};
var CAT_ICON = {
  '餐饮': '\ud83c\udf5c', '交通': '\ud83d\ude8c', '购物': '\ud83d\uded2', '日用': '\ud83e\uddf4', '医疗': '\ud83d\udc8a',
  '教育': '\ud83d\udcda', '人情': '\ud83c\udf81', '娱乐': '\ud83c\udfae', '居住': '\ud83c\udfe0',
  '工资': '\ud83d\udcb0', '奖金': '\ud83c\udfc6', '报销': '\ud83e\uddfe', '理财': '\ud83d\udcc8', '其他': '\ud83d\udccc'
};
function catIcon(c) { return CAT_ICON[c] || '\ud83d\udccc'; }
function ledgerMonth() { return S.lmonth || periodOf(todayISO()); }
function monthLabel(m) { return parseInt(m.slice(0, 4), 10) + ' 年 ' + parseInt(m.slice(5, 7), 10) + ' 月'; }

/* 某个月的汇总：收入、支出、结余、分类排行、按天分组 */
function ledgerSummary(m) {
  var rows = S.ledger.filter(function (e) { return periodOf(e.entry_date) === m; });
  var inc = 0, exp = 0, byCat = {}, byDay = {};
  rows.forEach(function (e) {
    var a = e.amount_cents || 0;
    var cat = e.category || '其他';
    var d = String(e.entry_date || '').slice(0, 10);
    if (!byDay[d]) byDay[d] = { out: 0, 'in': 0, rows: [] };
    if (e.kind === 'in') {
      inc += a; byDay[d]['in'] += a;
    } else {
      exp += a; byDay[d].out += a;
      byCat[cat] = (byCat[cat] || 0) + a;
    }
    byDay[d].rows.push(e);
  });
  var cats = Object.keys(byCat).map(function (k) {
    return { name: k, cents: byCat[k], pct: exp > 0 ? byCat[k] / exp * 100 : 0 };
  }).sort(function (a, b) { return b.cents - a.cents; });
  return { rows: rows, inc: inc, exp: exp, net: inc - exp, cats: cats, byDay: byDay };
}

function dayLabel(d) {
  var p = String(d).split('-');
  if (p.length < 3) return d;
  var mm = parseInt(p[1], 10), dd = parseInt(p[2], 10);
  if (d === todayISO()) return '今天 ' + mm + ' 月 ' + dd + ' 日';
  var y = new Date(); y.setDate(y.getDate() - 1);
  if (d === iso(y)) return '昨天 ' + mm + ' 月 ' + dd + ' 日';
  var wk = '日一二三四五六'.charAt(new Date(+p[0], +p[1] - 1, +p[2]).getDay());
  return mm + ' 月 ' + dd + ' 日 周' + wk;
}

function renderLedger() {
  var m = ledgerMonth();
  var lab = $('#ledMonthLab');
  if (lab) lab.textContent = monthLabel(m);

  var tip = $('#ledTip');
  if (tip) {
    tip.innerHTML = S.ledgerErr
      ? '<div class="alert warn"><div class="lbl">记账表还没建</div>' +
        '<div class="small" style="margin-top:4px">去 Supabase 后台 SQL Editor 跑一次建表 SQL 就好，其他功能不受影响</div></div>'
      : '';
  }

  var sm = ledgerSummary(m);
  var kp = $('#ledKpi');
  if (kp) {
    kp.innerHTML = kpi('本月收入', '¥' + fmt(sm.inc)) +
      kpi('本月支出', '¥' + fmt(sm.exp)) +
      kpi('本月结余', (sm.net < 0 ? '-¥' + fmt(-sm.net) : '¥' + fmt(sm.net)));
  }

  /* 和上月对比 */
  var cmp = $('#ledCompare');
  if (cmp) {
    var prev = ledgerSummary(shiftPeriod(m, -1));
    var diff = sm.exp - prev.exp;
    var line;
    if (!prev.exp && !sm.exp) line = '这个月和上月都还没记支出';
    else if (!prev.exp) line = '上月还没记账，这个月是第一个月';
    else if (diff === 0) line = '和上月持平（上月 ¥' + fmt(prev.exp) + '）';
    else {
      var pct = Math.abs(diff / prev.exp * 100);
      line = '本月支出比上月' + (diff > 0 ? '多' : '少') + ' ¥' + fmt(Math.abs(diff)) +
        '（' + (diff > 0 ? '+' : '-') + pct.toFixed(0) + '%），上月 ¥' + fmt(prev.exp);
    }
    cmp.innerHTML = '<p class="card-title">和上月对比</p><div class="small">' + esc(line) + '</div>';
  }

  /* 分类排行 */
  var cw = $('#ledCats');
  if (cw) {
    if (!sm.cats.length) {
      cw.innerHTML = '<p class="card-title">支出分类</p><div class="empty" style="padding:14px 0">这个月还没记支出</div>';
    } else {
      cw.innerHTML = '<p class="card-title">支出分类</p>' + sm.cats.map(function (c) {
        return '<div class="bar-row"><div class="lab"><span>' + catIcon(c.name) + ' ' + esc(c.name) + '</span>' +
          '<span>¥' + fmt(c.cents) + ' · ' + c.pct.toFixed(0) + '%</span></div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(2, c.pct).toFixed(1) + '%"></div></div></div>';
      }).join('');
    }
  }

  /* 每日流水 */
  var dw = $('#ledDays');
  if (dw) {
    var days = Object.keys(sm.byDay).sort().reverse();
    if (!days.length) {
      dw.innerHTML = '<div class="card"><div class="empty"><span class="ico">\u270f\ufe0f</span>' +
        '这个月还没记账<br><span class="small">点上面「记一笔」开始</span></div></div>';
    } else {
      dw.innerHTML = days.map(function (d) {
        var g = sm.byDay[d];
        var head = dayLabel(d) + (g.out ? ' · 支出 ¥' + fmt(g.out) : '') + (g['in'] ? ' · 收入 ¥' + fmt(g['in']) : '');
        var items = g.rows.slice().sort(function (a, b) {
          return String(b.created_at || '').localeCompare(String(a.created_at || ''));
        });
        return '<div class="card led-day"><div class="led-dhead">' + esc(head) + '</div>' +
          items.map(function (e) {
            var isIn = e.kind === 'in';
            return '<div class="led-item" data-ledger="' + esc(e.id) + '">' +
              '<span class="led-ico">' + catIcon(e.category) + '</span>' +
              '<span class="led-mid"><span class="led-cat">' + esc(e.category || '其他') + '</span>' +
              (e.note ? '<span class="led-note">' + esc(e.note) + '</span>' : '') + '</span>' +
              '<span class="led-amt ' + (isIn ? 'in' : 'out') + '">' + (isIn ? '+' : '-') + fmt(e.amount_cents) + '</span>' +
              '</div>';
          }).join('') + '</div>';
      }).join('');
    }
  }
}

/* 录入 / 修改一笔 */
function ledgerForm(e) {
  e = e || {};
  var st = {
    kind: e.kind || 'out',
    cat: e.category || '',
    date: String(e.entry_date || todayISO()).slice(0, 10),
    amt: e.amount_cents != null ? (e.amount_cents / 100).toFixed(2) : '',
    note: e.note || ''
  };
  if (LEDGER_CATS[st.kind].indexOf(st.cat) < 0) st.cat = LEDGER_CATS[st.kind][0];

  function paint() {
    var root = $('#sheetRoot');
    root.innerHTML = '<div class="sheet-mask" id="mask"><div class="sheet">' +
      '<h3>' + (e.id ? '改一笔' : '记一笔') + '</h3>' +
      '<div class="seg" id="ledKind">' +
        '<button type="button" data-k="out" class="' + (st.kind === 'out' ? 'on' : '') + '">支出</button>' +
        '<button type="button" data-k="in" class="' + (st.kind === 'in' ? 'on' : '') + '">收入</button>' +
      '</div>' +
      '<label class="field"><span>金额</span>' +
        '<input id="ledAmt" type="number" step="0.01" inputmode="decimal" class="led-amt-in" value="' +
        esc(st.amt) + '" placeholder="0.00"></label>' +
      '<div class="field"><span>分类</span><div class="cat-grid" id="ledCatGrid">' +
        LEDGER_CATS[st.kind].map(function (c) {
          return '<button type="button" class="cat-btn' + (c === st.cat ? ' on' : '') + '" data-c="' + esc(c) + '">' +
            catIcon(c) + ' ' + esc(c) + '</button>';
        }).join('') + '</div></div>' +
      '<label class="field"><span>日期</span><input id="ledDate" type="date" value="' + esc(st.date) + '"></label>' +
      '<label class="field"><span>备注</span><input id="ledNote" type="text" value="' + esc(st.note) +
        '" placeholder="可不填，比如「和同事吃面」"></label>' +
      '<div class="btn-row" style="margin-top:10px">' +
        (e.id ? '<button type="button" class="btn" id="ledDel" style="color:var(--danger)">删除</button>' : '') +
        '<button type="button" class="btn" id="ledCancel">取消</button>' +
        '<button type="button" class="btn primary" id="ledSave">保存</button>' +
      '</div></div></div>';

    $('#mask').onclick = function (ev) { if (ev.target.id === 'mask') closeSheet(); };
    $('#ledCancel').onclick = closeSheet;

    Array.prototype.forEach.call(root.querySelectorAll('#ledKind button'), function (b) {
      b.onclick = function () {
        st.kind = b.dataset.k;
        if (LEDGER_CATS[st.kind].indexOf(st.cat) < 0) st.cat = LEDGER_CATS[st.kind][0];
        paint();
      };
    });
    /* 点分类只切换高亮，不重绘，避免金额输入框丢焦点 */
    Array.prototype.forEach.call(root.querySelectorAll('.cat-btn'), function (b) {
      b.onclick = function () {
        st.cat = b.dataset.c;
        Array.prototype.forEach.call(root.querySelectorAll('.cat-btn'), function (x) {
          x.classList.toggle('on', x.dataset.c === st.cat);
        });
      };
    });

    var amtEl = $('#ledAmt');
    amtEl.oninput = function () { st.amt = amtEl.value; };
    $('#ledDate').onchange = function () { st.date = this.value; };
    $('#ledNote').oninput = function () { st.note = this.value; };

    $('#ledSave').onclick = async function () {
      var cents = toCents(st.amt);
      if (!cents) { toast('金额要大于 0'); return; }
      var body = {
        entry_date: st.date || todayISO(), kind: st.kind,
        amount_cents: cents, category: st.cat, note: st.note || null
      };
      try {
        if (e.id) await sb('/rest/v1/ledger?id=eq.' + e.id, { method: 'PATCH', body: body });
        else await sb('/rest/v1/ledger', { method: 'POST', body: body });
        S.lmonth = periodOf(body.entry_date);
        await loadAll(); closeSheet(); render();
        toast(e.id ? '改好了' : '已记下 ¥' + fmt(cents));
      } catch (err) {
        var msg = String((err && err.message) || '');
        toast(/relation|does not exist|schema cache/i.test(msg)
          ? '记账表还没建，先在 Supabase 跑建表 SQL'
          : ('保存失败：' + msg));
      }
    };

    if (e.id) {
      $('#ledDel').onclick = async function () {
        if (!confirm('删掉这笔？')) return;
        try {
          await sb('/rest/v1/ledger?id=eq.' + e.id, { method: 'DELETE' });
          await loadAll(); closeSheet(); render(); toast('已删除');
        } catch (err) { toast('删除失败：' + err.message); }
      };
    }

    setTimeout(function () { try { amtEl.focus(); } catch (x) {} }, 120);
  }
  paint();
}

var TITLES = { home: '首页', bills: '账单', ledger: '记账', reps: '还款', stats: '分析', settings: '设置' };
function showPage(p) {
  S.page = p;
  ['home', 'bills', 'ledger', 'reps', 'stats', 'settings'].forEach(function (k) {
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
  if (S.page === 'ledger') renderLedger();
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
    { key: 'due_day', label: '还款日（每月几号，小于账单日算次月）', type: 'number', value: c.due_day || 23 },
    { key: 'annual_fee_month', label: '年费月份（1-12，留空=没有年费）', type: 'number', value: c.annual_fee_month || '' },
    { key: 'annual_fee_rule', label: '免年费条件', type: 'text', value: c.annual_fee_rule, placeholder: '刷6次免 / 刚性不免' },
    { key: 'fee_waived', label: '今年年费已免（跨年自动重置）', type: 'bool', value: parseInt(c.annual_fee_waived_year, 10) === new Date().getFullYear() },
    { key: 'auto_pay', label: '自动还款', type: 'bool', value: !!c.auto_pay },
    { key: 'is_active', label: '启用', type: 'bool', value: c.is_active !== false }
  ];
  openSheet(c.id ? '编辑信用卡' : '添加信用卡', fields, async function (v) {
    var body = {
      bank: v.bank, alias: v.alias, last4: v.last4,
      credit_limit_cents: v.credit_limit, bill_day: v.bill_day, due_day: v.due_day,
      annual_fee_month: (v.annual_fee_month >= 1 && v.annual_fee_month <= 12) ? v.annual_fee_month : null,
      annual_fee_rule: v.annual_fee_rule,
      annual_fee_waived_year: v.fee_waived ? new Date().getFullYear() : null,
      auto_pay: v.auto_pay, is_active: v.is_active
    };
    if (!body.bank) throw new Error('银行必填');
    /* 年费字段还没在数据库建好时，降级保存其余字段并提示 */
    try {
      if (c.id) await sb('/rest/v1/credit_cards?id=eq.' + c.id, { method: 'PATCH', body: body });
      else await addCard(body);
    } catch (e1) {
      if (!/annual_fee/.test(String(e1 && e1.message))) throw e1;
      ['annual_fee_month', 'annual_fee_rule', 'annual_fee_waived_year'].forEach(function (k) { delete body[k]; });
      if (c.id) await sb('/rest/v1/credit_cards?id=eq.' + c.id, { method: 'PATCH', body: body });
      else await addCard(body);
      toast('年费字段还没建，先在 Supabase 跑一次升级 SQL');
    }
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
  var dCard = cardById(b.card_id || S.cards[0].id) || S.cards[0];
  var dPeriod = b.period || periodOf(todayISO());
  var dDue = b.due_date || dueDateOf(dPeriod, dCard.due_day || 23, dCard.bill_day || 5);
  var fields = [
    {
      key: 'card_id', label: '信用卡', type: 'select', value: b.card_id || S.cards[0].id,
      options: S.cards.map(function (c) { return { value: c.id, label: c.alias || c.bank }; })
    },
    { key: 'period', label: '账期（YYYY-MM）', type: 'text', value: b.period || periodOf(todayISO()), placeholder: '2026-11' },
    { key: 'amount', label: '账单金额（元）', type: 'money', value: b.amount_cents ? (b.amount_cents / 100) : '' },
    { key: 'min', label: '最低还款（元）', type: 'money', value: b.min_cents ? (b.min_cents / 100) : '' },
    { key: 'due_date', label: '到期还款日（自动算，可改）', type: 'date', value: dDue },
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

  /* 到期日跟着「信用卡 + 账期」自动变，手动改过就不再覆盖 */
  var dEl = $('#f_due_date'), cEl = $('#f_card_id'), pEl = $('#f_period');
  if (dEl) {
    dEl._touched = false;
    var syncDue = function () {
      if (dEl._touched) return;
      var cd = cardById(cEl ? cEl.value : null) || S.cards[0];
      var pd = pEl ? String(pEl.value || '').trim() : '';
      if (!cd || !/^\d{4}-\d{2}$/.test(pd)) return;
      dEl.value = dueDateOf(pd, cd.due_day || 23, cd.bill_day || 5);
    };
    dEl.onchange = function () { dEl._touched = true; };
    if (cEl) cEl.onchange = function () { dEl._touched = false; syncDue(); };
    if (pEl) pEl.oninput = function () { dEl._touched = false; syncDue(); };
    syncDue();
  }

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

/* 标记已还（统一走实时换算弹层） */
function payBill(bill) { paySheet(bill); }
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
  if (bind._done) return;
  bind._done = true;
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

  var bf2 = $('#btnAddFixed2');
  if (bf2) bf2.onclick = function () { fixedForm(null); };
  var sDue = $('#sumDue');
  if (sDue) sDue.onclick = showDueDetail;
  var sGr = $('#sumGrace');
  if (sGr) sGr.onclick = showGraceDetail;

  document.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-more],[data-main],[data-pay],[data-bill],[data-fixed],[data-fpay],[data-unpay],[data-delrep],[data-card],[data-feewaive],[data-ledger]');
    if (!t) return;
    try {
      if (t.dataset.more) {
        openMenu(t.dataset.more);
      } else if (t.dataset.main) {
        mainAction(t.dataset.main);
      } else if (t.dataset.pay) {
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
      } else if (t.dataset.feewaive) {
        await setAnnualFeeWaived(t.dataset.feewaive, true);
      } else if (t.dataset.ledger) {
        var le = null; for (var w = 0; w < S.ledger.length; w++) if (S.ledger[w].id === t.dataset.ledger) le = S.ledger[w];
        if (le) ledgerForm(le);
      } else if (t.dataset.card) {
        var c = null; for (var z = 0; z < S.cards.length; z++) if (S.cards[z].id === t.dataset.card) c = S.cards[z];
        if (c) cardForm(c);
      }
    } catch (err) { toast('操作失败：' + err.message); }
  });

  // 导出 / 导入
  var lp = $('#ledPrev'), ln = $('#ledNext'), la = $('#ledAdd');
  if (lp) lp.onclick = function () { S.lmonth = shiftPeriod(ledgerMonth(), -1); render(); };
  if (ln) ln.onclick = function () { S.lmonth = shiftPeriod(ledgerMonth(), 1); render(); };
  if (la) la.onclick = function () { ledgerForm(); };

  $('#btnExport').onclick = function () {
    var data = { version: 2, exported_at: new Date().toISOString(), cards: S.cards, bills: S.bills, repayments: S.reps, fixed_payments: S.fixed, fixed_records: S.frecs, ledger: S.ledger };
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
  for (var q = 0; q < (d.ledger || []).length; q++) {
    var le = d.ledger[q];
    await sb('/rest/v1/ledger', { method: 'POST', body: { entry_date: le.entry_date, kind: le.kind, amount_cents: le.amount_cents, category: le.category, note: le.note } });
  }
  for (var n = 0; n < (d.fixed_records || []).length; n++) {
    var fr = d.fixed_records[n]; if (!mapFixed[fr.fixed_payment_id]) continue;
    await sb('/rest/v1/fixed_payment_records?on_conflict=fixed_payment_id,period', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: { fixed_payment_id: mapFixed[fr.fixed_payment_id], period: fr.period, due_date: fr.due_date, due_cents: fr.due_cents, paid_cents: fr.paid_cents, paid_at: fr.paid_at, status: fr.status, note: fr.note } });
  }
}

/* ============ 启动 ============ */

function bindAuth() {
  var bl = $('#btnLogin'), bs = $('#btnSignup');
  if (!bl || bl._bound) return;
  bl._bound = true; bs._bound = true;
  bl.onclick = async function () {
    var email = $('#authEmail').value.trim(), pass = $('#authPass').value;
    if (!email || !pass) { authMsg('请填邮箱和密码'); return; }
    bl.textContent = '登录中…'; bl.disabled = true;
    try { await signIn(email, pass); await startApp(); }
    catch (e) { authMsg(e.message); }
    finally { bl.textContent = '登录'; bl.disabled = false; }
  };
  bs.onclick = async function () {
    var email = $('#authEmail').value.trim(), pass = $('#authPass').value;
    if (!email || !pass || pass.length < 6) { authMsg('请填邮箱和至少 6 位密码'); return; }
    bs.textContent = '处理中…'; bs.disabled = true;
    try {
      var logged = await signUp(email, pass);
      if (logged) { await startApp(); }
      else { authMsg('注册成功！请去邮箱点确认链接，然后回来点登录', true); }
    } catch (e) { authMsg(e.message); }
    finally { bs.textContent = '第一次用，注册账号'; bs.disabled = false; }
  };
}

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
  bindAuth();
  if (!BASE || !ANON || BASE.indexOf('__') === 0) {
    showAuth();
    authMsg('还没配置数据库，请先填 config.js');
    return;
  }
  if (!SESSION) { showAuth(); return; }

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
