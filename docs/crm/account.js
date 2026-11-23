/* Account card for every customer and every supplier (Aviv 19.11.2026: "כרטיס לקוח עם חשבון לקוח, כמו פריוריטי... וכל ספק").
   One card for the whole system: any page loads this file and calls ZisoAccount.open(sb, 'customer' | 'supplier', id).
   It opens as a sheet over the page, in place; nothing navigates. Read only. Data: crm_account() (crm-ai/crm_account.sql). */
(function () {
'use strict';
var CSS = '' +
'.za{--band:#17191c;--band-ink:#f4f1ea;--band-mute:#bdb7ab;--brass:#d2b27a;--ground:#eceff0;--tile:#fff;--tile-2:#f5f7f7;--grout:#d3d8da;--hair:#e3e7e9;--ink:#1b1d1f;--mute:#555b60;--deep:#6f5325;--red:#a83422;--red-soft:#f8e4df;--green:#2a7048;--green-soft:#e2f0e6;--amber-soft:#f3e8d2;--g:#2c6975;' +
  'position:fixed;inset:0;margin:0;padding:0;border:0;width:100%;max-width:none;height:100%;max-height:none;background:var(--ground);color:var(--ink);font-family:"Assistant","Segoe UI",Arial,sans-serif;font-size:17px;line-height:1.45;font-variant-numeric:tabular-nums;direction:rtl;text-align:start;overflow:hidden}' +
'.za[data-kind="supplier"]{--g:#8a5a2b}' +
'.za::backdrop{background:rgba(23,25,28,.5)}' +
'.za *{box-sizing:border-box}' +
'.za button{font:inherit;color:inherit}' +
'.za :focus-visible{outline:3px solid var(--deep);outline-offset:2px;border-radius:6px}' +
'.za .zh :focus-visible{outline-color:var(--brass)}' +
'.za .zin{display:flex;flex-direction:column;height:100%}' +
'.za .zh{background:var(--band);color:var(--band-ink);padding:calc(12px + env(safe-area-inset-top)) 16px 16px;box-shadow:inset 0 -4px 0 var(--g);flex:none}' +
'.za .ztop{display:flex;justify-content:space-between;align-items:center;gap:12px}' +
'.za .zk{color:var(--band-mute);font-size:15px;font-weight:600}' +
'.za .zx{width:44px;height:44px;border-radius:50%;border:1px solid #4a5056;background:transparent;display:grid;place-items:center;cursor:pointer;padding:0}' +
'.za .zx:hover{background:#22262a}' +
'.za .zx svg,.za .zi{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;flex:none}' +
'.za h2{font-family:"Bellefair","Times New Roman",serif;font-weight:400;font-size:30px;line-height:1.15;margin:6px 0 0;letter-spacing:.01em}' +
'.za h2:focus{outline:0}' +
'.za .zsub{margin:4px 0 0;color:var(--band-mute);font-size:15px}' +
'.za .zb{flex:1;overflow:auto;padding:16px 16px calc(28px + env(safe-area-inset-bottom));-webkit-overflow-scrolling:touch}' +
'.za .ltr{direction:ltr;unicode-bidi:isolate;display:inline-block}' +
'.za .zstats{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--grout);border:1px solid var(--grout);border-radius:14px;overflow:hidden}' +
'.za .zs{background:var(--tile);padding:14px 16px;display:flex;flex-direction:column;gap:3px;min-width:0}' +
'.za .zs.big{grid-column:1/-1;padding:18px 16px}' +
'.za .zs:last-child:nth-child(even){grid-column:1/-1}' +
'.za .zs .lb{color:var(--mute);font-size:15px;font-weight:600;line-height:1.3}' +
'.za .zs .fig{font-weight:700;font-size:22px;line-height:1.15}' +
'.za .zs.big .fig{font-size:48px;line-height:1.05;letter-spacing:-.01em}' +
'.za .zs .sb{color:var(--mute);font-size:15px;line-height:1.35}' +
'.za .chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-weight:700;font-size:15px;background:var(--amber-soft);color:var(--deep)}' +
'.za .chip.red{background:var(--red-soft);color:var(--red)}' +
'.za .chip.ok{background:var(--green-soft);color:var(--green)}' +
'.za .chip.q{background:#e6eaec;color:var(--mute)}' +
'.za .chip .zi{width:18px;height:18px}' +
'.za .zage{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}' +
'.za .zseg{display:flex;background:#dde2e4;border-radius:999px;padding:3px;margin:18px 0 10px;overflow-x:auto;scrollbar-width:none}' +
'.za .zseg::-webkit-scrollbar{display:none}' +
'.za .zseg button{flex:1 0 auto;min-height:44px;padding:0 12px;border-radius:999px;border:0;background:transparent;color:var(--mute);font-weight:600;font-size:16px;cursor:pointer;white-space:nowrap}' +
'.za .zseg button[aria-pressed="true"]{background:var(--tile);color:var(--ink);box-shadow:0 1px 2px rgba(30,27,23,.12)}' +
'.za .slab{background:var(--tile);border:1px solid var(--grout);border-radius:14px;overflow:hidden}' +
'.za .slab + .slab,.za .zhd + .slab{margin-top:0}' +
'.za .zhd{margin:18px 2px 8px;font-weight:700;font-size:15px;color:var(--mute)}' +
'.za .empty{padding:18px 16px;color:var(--mute)}' +
'.za table{width:100%;border-collapse:collapse;font-size:15px}' +
'.za th,.za td{padding:10px 8px;text-align:start;border-top:1px solid var(--hair);vertical-align:top}' +
'.za th:first-child,.za td:first-child{padding-inline-start:16px}' +
'.za th:last-child,.za td:last-child{padding-inline-end:16px}' +
'.za thead th{border-top:0;background:var(--tile-2);color:var(--mute);font-weight:700;font-size:14px;white-space:nowrap;position:sticky;top:0}' +
'.za td.n,.za th.n{text-align:end;white-space:nowrap}' +
'.za td.b{font-weight:700}' +
'.za .dl{display:block;font-weight:600;line-height:1.3}' +
'.za .ds{display:block;color:var(--mute);font-size:14px;line-height:1.3}' +
'.za tr.op td{background:var(--tile-2);font-weight:600}' +
'.za tr.late td:first-child{box-shadow:inset -3px 0 0 var(--red)}' +
'.za .znote{display:flex;gap:10px;align-items:flex-start;margin:12px 0 0;padding:12px 14px;border-radius:12px;background:var(--amber-soft);color:var(--deep);font-weight:600;font-size:16px;line-height:1.35}' +
'.za .znote .zi{margin-top:1px}' +
'.za details.zd{border-top:1px solid var(--grout)}' +
'.za details.zd:first-child{border-top:0}' +
'.za details.zd > summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:minmax(0,1fr) auto 20px;gap:10px;align-items:center;min-height:64px;padding:10px 16px}' +
'.za details.zd > summary::-webkit-details-marker{display:none}' +
'.za details.zd > summary:hover{background:var(--tile-2)}' +
'.za details.zd > summary .zi{width:20px;height:20px;color:#7d8388;transition:transform .16s}' +
'.za details.zd[open] > summary .zi{transform:rotate(180deg)}' +
'.za details.zd .a{font-weight:700;white-space:nowrap}' +
'.za .zinn{background:var(--tile-2);border-top:1px solid var(--hair)}' +
'.za .zrow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;min-height:60px;padding:10px 16px;border-top:1px solid var(--grout)}' +
'.za .zrow:first-child{border-top:0}' +
'.za a.zrow{color:inherit;text-decoration:none}' +
'.za a.zrow:hover{background:var(--tile-2)}' +
'.za .zrow .a{font-weight:700;white-space:nowrap}' +
'.za .more{display:block;width:100%;min-height:48px;border:0;border-top:1px solid var(--grout);background:var(--tile);color:var(--deep);font-weight:600;cursor:pointer}' +
'.za .zact{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}' +
'.za .btn{display:inline-flex;align-items:center;gap:8px;min-height:46px;padding:0 18px;border-radius:999px;border:1px solid var(--grout);background:var(--tile);font-weight:600;font-size:16px;cursor:pointer;text-decoration:none;color:var(--ink)}' +
'.za .btn:hover{background:var(--tile-2)}' +
'.za .src{color:var(--mute);font-size:14px;margin:16px 2px 0;line-height:1.4}' +
'.za .sk{height:16px;border-radius:8px;background:#e3e7e9;margin:14px 16px}' +
'@media (min-width:760px){.za{inset:0 auto 0 0;width:620px;height:100%;box-shadow:8px 0 40px rgba(23,25,28,.25)}.za .zh{padding:18px 24px 20px}.za .zb{padding:20px 24px 32px}.za h2{font-size:34px}.za .zstats{grid-template-columns:repeat(3,1fr)}.za .zs:last-child:nth-child(even){grid-column:auto}.za .zs.big .fig{font-size:56px}}' +
'@media (prefers-reduced-motion:no-preference){.za[open]{animation:zaIn .2s ease-out}@keyframes zaIn{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:none}}}';

var MIN = '−', dlg = null, D = null, tab = '', sbRef = null, shown = 60, back = null, from = '';
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function sh(n) { n = Math.round(Number(n) || 0); return (n < 0 ? MIN : '') + '₪' + Math.abs(n).toLocaleString('en-US'); }
function amt(n) { return '<span class="ltr">' + sh(n) + '</span>'; }
function cell(n) { return Math.abs(Number(n) || 0) < 0.005 ? '' : amt(n); }
function dmy(iso) { if (!iso) return ''; var s = String(iso).slice(0, 10); return Number(s.slice(8, 10)) + '.' + Number(s.slice(5, 7)) + '.' + s.slice(2, 4); }
function when(t) { if (!t) return ''; var d = new Date(t), now = new Date(); return (d.toDateString() === now.toDateString() ? 'היום' : dmy(d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2))) + ' ב-' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
function cnt(n, one, many) { return n === 1 ? one : n + ' ' + many; }
function ic(d) { return '<svg class="zi" viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>'; }
var I = { x: '<path d="M6 6l12 12M18 6L6 18"/>', chev: '<path d="M6 9l6 6 6-6"/>', alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2h.01"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', down: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>', go: '<path d="M14 6l-6 6 6 6"/>' };
var TYPES = { 'חל': 'חשבונית', 'חלז': 'חשבונית זיכוי', 'ק': 'קבלה', 'בטל': 'קבלה שבוטלה', 'העב': 'העברה', 'הת': 'התאמה', 'פ': 'פקודת יומן', 'תשצ': 'תשלום בצ׳ק', 'חס': 'חשבונית ספק', 'חסמ': 'חשבונית ספק מרכזת', 'חסז': 'זיכוי מספק', '2/3': 'חשבונית ספק' };
var METHODS = { cash: 'מזומן', cheque: 'צ׳ק', card: 'אשראי', transfer: 'העברה', bit: 'ביט' };
var DEAL = { open: 'פתוחה', draft: 'טיוטה', closed: 'סגורה', won: 'נסגרה', cancelled: 'בוטלה' };

function ensure() {
  if (dlg) return;
  var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  dlg = document.createElement('dialog'); dlg.className = 'za'; dlg.setAttribute('aria-labelledby', 'zaName');
  dlg.innerHTML = '<div class="zin"><div class="zh"><div class="ztop"><span class="zk" id="zaKind"></span><button class="zx" type="button" id="zaX" aria-label="לסגור את כרטיס החשבון">' + ic(I.x) + '</button></div><h2 id="zaName" tabindex="-1"></h2><p class="zsub" id="zaSub"></p></div><div class="zb" id="zaBody"></div></div>';
  document.body.appendChild(dlg);
  dlg.querySelector('#zaX').addEventListener('click', close);
  dlg.addEventListener('click', function (e) {
    if (e.target === dlg) { close(); return; }
    if (e.target.closest('a[href]')) { close(); return; }
    var b = e.target.closest('[data-tab],[data-more],[data-csv],[data-retry],[data-acct]'); if (!b) return;
    if (b.dataset.tab) { tab = b.dataset.tab; shown = 60; body(); var nb = dlg.querySelector('[data-tab="' + tab + '"]'); if (nb) nb.focus(); }
    else if (b.dataset.more) { shown += 200; body(); }
    else if (b.dataset.csv) csv();
    else if (b.dataset.retry) load(D.kind, D.id);
    else if (b.dataset.acct) { var p = b.dataset.acct.split(':'); load(p[0], p[1]); }
  });
  dlg.addEventListener('close', function () { document.documentElement.style.overflow = ''; if (back && back.focus) back.focus(); });
}
function close() { if (dlg && dlg.open) dlg.close(); }
function $(id) { return dlg.querySelector('#' + id); }

function open(sb, kind, id, opt) {
  ensure(); sbRef = sb; back = document.activeElement; from = (opt && opt.from) || '';
  if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); document.documentElement.style.overflow = 'hidden'; }
  load(kind, id, opt);
}
function load(kind, id, opt) {
  D = { kind: kind, id: String(id) }; tab = ''; shown = 60;
  dlg.dataset.kind = kind;
  $('zaKind').textContent = 'כרטיס חשבון · ' + (kind === 'supplier' ? 'ספק' : 'לקוח');
  $('zaName').textContent = (opt && opt.name) || 'טוען…'; $('zaSub').textContent = 'מספר ' + D.id;
  $('zaBody').innerHTML = '<div class="slab"><div class="sk" style="width:55%"></div><div class="sk" style="width:35%"></div><div class="sk" style="width:70%"></div></div>';
  $('zaBody').scrollTop = 0; $('zaName').focus({ preventScroll: true });
  var want = D;
  Promise.resolve(sbRef.rpc('crm_account', { p_kind: kind, p_id: String(id) })).then(function (r) {
    if (want !== D) return;
    if (!r || r.error) { fail(r && r.error && (r.error.code === '42501' || /owner only|not allowed/.test(r.error.message || ''))); return; }
    if (!r.data || r.data.missing) { $('zaName').textContent = 'לא נמצא כרטיס'; $('zaBody').innerHTML = '<div class="slab"><div class="empty">אין כרטיס עם המספר הזה.</div></div>'; return; }
    D = r.data; draw();
  }, function () { if (want === D) fail(false); });
}
function fail(denied) {
  $('zaName').textContent = denied ? 'הכרטיס הזה סגור' : 'הכרטיס לא נטען';
  $('zaBody').innerHTML = '<div class="slab"><div class="empty">' + (denied ? 'הכרטיס הזה פתוח לאביב בלבד.' : 'הנתונים לא נטענו.') + '</div></div>' + (denied ? '' : '<div class="zact"><button class="btn" type="button" data-retry="1">לנסות שוב</button></div>');
}
function draw() {
  $('zaName').textContent = D.name || '';
  var ph = String(D.phone || '').replace(/\D/g, '');
  $('zaSub').innerHTML = 'מספר <span class="ltr">' + esc(D.id) + '</span>' + (D.city ? ' · ' + esc(D.city) : '') + (ph.length >= 9 ? ' · <span class="ltr">' + esc(D.phone) + '</span>' : '');
  if (!tab) tab = D.kind === 'supplier' ? ((D.open || []).length ? 'open' : 'pay') : ((D.moves || []).length ? 'moves' : 'open');
  body();
}
function seg(list) { return '<div class="zseg" role="group" aria-label="מה להציג">' + list.map(function (t) { return '<button type="button" data-tab="' + t[0] + '" aria-pressed="' + (t[0] === tab) + '">' + t[1] + (t[2] ? ' <span aria-hidden="true">· ' + t[2] + '</span>' : '') + '</button>'; }).join('') + '</div>'; }
function body() { $('zaBody').innerHTML = D.kind === 'supplier' ? supplier() : customer(); }

/* ---------- customer ---------- */
function customer() {
  var b = Number(D.balance) || 0, ag = D.aging || {}, moves = D.moves || [], open = D.open || [];
  var h = '<div class="zstats"><div class="zs big"><span class="lb">' + (b > 0.5 ? 'הלקוח חייב לנו' : b < -0.5 ? 'יתרת זכות: שילם יותר ממה שחויב' : 'היתרה בכרטיס') + '</span><span class="fig">' + amt(Math.abs(b) < 0.5 ? 0 : Math.abs(b)) + '</span>' +
    '<span class="sb">' + (Math.abs(b) < 0.5 ? '<span class="chip ok">' + ic(I.check) + 'הכרטיס מאוזן</span>' : b < 0 ? 'בדרך כלל מקדמה על הזמנה שעוד לא יצאה לה חשבונית' : ageChips(ag)) + '</span></div>' +
    '<div class="zs"><span class="lb">חויב ב-' + D.year + '</span><span class="fig">' + amt(D.debit_ytd) + '</span><span class="sb">חשבוניות, כולל מע״מ</span></div>' +
    '<div class="zs"><span class="lb">שילם ב-' + D.year + '</span><span class="fig">' + amt(D.credit_ytd) + '</span><span class="sb">קבלות וזיכויים</span></div>' +
    '<div class="zs"><span class="lb">יתרת פתיחה ' + D.year + '</span><span class="fig">' + amt(D.opening) + '</span><span class="sb">מחושבת מהתנועות</span></div></div>';
  var wait = (D.takings || []).filter(function (k) { return !k.closed; });
  if (wait.length) h += '<p class="znote">' + ic(I.alert) + '<span>' + cnt(wait.length, 'תשלום אחד נלקח בקופה ועוד לא יצאה לו קבלה, ולכן הוא עוד לא ביתרה שלמעלה.', 'תשלומים נלקחו בקופה ועוד לא יצאה להם קבלה, ולכן הם עוד לא ביתרה שלמעלה.') + '</span></p>';
  var docsN = (D.orders || []).length + (D.quotes || []).length + (D.deals || []).length;
  h += seg([['moves', 'כל התנועות', moves.length || ''], ['open', 'פתוחים', open.length || ''], ['docs', 'הזמנות', docsN || '']]);
  if (tab === 'moves') h += movesTable(moves);
  else if (tab === 'open') h += openTable(open, false);
  else h += custDocs();
  var act = (tab === 'moves' && moves.length ? '<button class="btn" type="button" data-csv="1">' + ic(I.down) + 'להוריד כקובץ אקסל</button>' : '') + (D.tail9 && from !== 'card' ? '<a class="btn" href="index.html#card/' + encodeURIComponent(D.tail9) + '">לדף הלקוח והשיחות</a>' : '');
  if (act) h += '<div class="zact">' + act + '</div>';
  h += '<p class="src">הנתונים מפריוריטי' + (D.synced && D.synced.receipts ? ', עודכנו ' + esc(when(D.synced.receipts)) : '') + '. התנועות הן של ' + D.year + ', והסכומים כוללים מע״מ.</p>';
  return h;
}
function ageChips(a) {
  var parts = [['future', 'עוד לא הגיע מועד', 'q'], ['d30', 'עד 30 יום', ''], ['d60', '31 עד 60', ''], ['d90', '61 עד 90', ''], ['d90p', 'מעל 90 יום', 'red']].filter(function (p) { return Math.abs(Number(a[p[0]]) || 0) > 0.5; });
  return parts.length ? '<span class="zage">' + parts.map(function (p) { return '<span class="chip ' + p[2] + '">' + (p[2] === 'red' ? ic(I.alert) : '') + p[1] + ' ' + amt(a[p[0]]) + '</span>'; }).join('') + '</span>' : '';
}
function movesTable(moves) {
  if (!moves.length) return '<div class="slab"><div class="empty">אין תנועות השנה בכרטיס הזה.</div></div>';
  var rows = moves.slice().reverse(), part = rows.slice(0, shown);
  return '<div class="slab"><table><thead><tr><th scope="col">מסמך</th><th scope="col" class="n">חובה</th><th scope="col" class="n">זכות</th><th scope="col" class="n">יתרה</th></tr></thead><tbody>' +
    part.map(function (m) { return '<tr><td><span class="dl">' + esc(m.label) + (m.method ? ' · ' + esc(m.method) : '') + '</span><span class="ds">' + dmy(m.date) + ' · <span class="ltr">' + esc(m.doc) + '</span></span></td><td class="n">' + cell(m.debit) + '</td><td class="n">' + cell(m.credit) + '</td><td class="n b">' + amt(m.bal) + '</td></tr>'; }).join('') +
    (rows.length <= shown ? '<tr class="op"><td>יתרת פתיחה 1.1.' + String(D.year).slice(2) + '</td><td class="n"></td><td class="n"></td><td class="n">' + amt(D.opening) + '</td></tr>' : '') +
    '</tbody></table>' + (rows.length > shown ? '<button class="more" type="button" data-more="1">להציג עוד ' + (rows.length - shown) + ' תנועות</button>' : '') + '</div>';
}
function openTable(open, sup) {
  if (!open.length) return '<div class="slab"><div class="empty">אין שורות פתוחות. הכול סגור.</div></div>';
  var tot = 0; open.forEach(function (o) { tot += Number(sup ? o.open : o.amount) || 0; });
  return '<div class="slab"><table><thead><tr><th scope="col">מסמך</th><th scope="col">לתשלום עד</th><th scope="col" class="n">פתוח</th></tr></thead><tbody>' +
    open.map(function (o) { var v = Number(sup ? o.open : o.amount) || 0, late = Number(o.late) > 0 && v > 0;
      return '<tr' + (late ? ' class="late"' : '') + '><td><span class="dl">' + esc(TYPES[o.type] || o.details || 'מסמך') + '</span><span class="ds">' + dmy(o.date) + (o.doc ? ' · <span class="ltr">' + esc(o.doc) + '</span>' : '') + (sup && o.sup_doc ? ' · אצל הספק <span class="ltr">' + esc(o.sup_doc) + '</span>' : '') + '</span></td>' +
        '<td>' + dmy(o.due) + (late ? '<span class="ds" style="color:var(--red);font-weight:700">איחור ' + cnt(Number(o.late), 'יום', 'ימים') + '</span>' : '') + '</td><td class="n b">' + amt(v) + '</td></tr>'; }).join('') +
    '<tr class="op"><td>סך הכול פתוח</td><td></td><td class="n">' + amt(tot) + '</td></tr></tbody></table></div>';
}
function custDocs() {
  var h = '', dl = D.deals || [], or = D.orders || [], qu = D.quotes || [], tk = D.takings || [];
  if (!dl.length && !or.length && !qu.length && !tk.length) return '<div class="slab"><div class="empty">אין הזמנות או הצעות מחיר ללקוח הזה.</div></div>';
  if (dl.length) h += '<div class="zhd">הזמנות במערכת שלנו</div><div class="slab">' + dl.map(function (d) { return '<a class="zrow" href="order.html?d=' + encodeURIComponent(d.id) + '"><span><span class="dl"><span class="ltr">' + esc(d.deal_no || '') + '</span> · ' + esc(DEAL[d.status] || d.status || '') + '</span><span class="ds">עודכנה ' + dmy(d.at) + '</span></span><span class="a">' + (Number(d.total) ? amt(d.total) : '') + '</span></a>'; }).join('') + '</div>';
  if (tk.length) h += '<div class="zhd">תשלומים שנלקחו בקופה</div><div class="slab">' + tk.map(function (k) { return '<div class="zrow"><span><span class="dl">' + esc(METHODS[k.method] || k.method || 'תשלום') + (k.doc_no ? ' · קבלה <span class="ltr">' + esc(k.doc_no) + '</span>' : '') + '</span><span class="ds">' + dmy(k.at) + ' · ' + (k.closed ? 'יצאה קבלה' : 'מחכה לקבלה') + '</span></span><span class="a">' + amt(k.amount) + '</span></div>'; }).join('') + '</div>';
  if (or.length) h += '<div class="zhd">הזמנות בפריוריטי</div><div class="slab">' + or.map(function (o) { return '<div class="zrow"><span><span class="dl"><span class="ltr">' + esc(o.so) + '</span> · ' + esc(o.status || '') + '</span><span class="ds">' + dmy(o.date) + '</span></span><span class="a">' + (Number(o.open_total) ? 'פתוח ' + amt(o.open_total) : '') + '</span></div>'; }).join('') + '</div>';
  if (qu.length) h += '<div class="zhd">הצעות מחיר</div><div class="slab">' + qu.map(function (q) { return '<div class="zrow"><span><span class="dl"><span class="ltr">' + esc(q.pq) + '</span> · ' + esc(q.status || '') + '</span><span class="ds">' + dmy(q.date) + '</span></span><span class="a">' + (Number(q.total) ? amt(q.total) : '') + '</span></div>'; }).join('') + '</div>';
  return h;
}

/* ---------- supplier ---------- */
function supplier() {
  var b = Number(D.balance) || 0, ch = D.cheques || [], chSum = 0, late = Number(D.late) || 0; ch.forEach(function (c) { chSum += Number(c.net) || 0; });
  var h = '<div class="zstats"><div class="zs big"><span class="lb">' + (b > 0.5 ? 'אנחנו חייבים לספק' : b < -0.5 ? 'יתרת זכות אצל הספק' : 'היתרה בכרטיס') + '</span><span class="fig">' + amt(Math.abs(b) < 0.5 ? 0 : Math.abs(b)) + '</span>' +
    '<span class="sb">' + (late > 0.5 ? '<span class="chip red">' + ic(I.alert) + 'מזה ' + amt(late) + ' עבר מועד התשלום</span>' : Math.abs(b) < 0.5 ? '<span class="chip ok">' + ic(I.check) + 'אין חשבוניות פתוחות</span>' : 'חשבוניות שעוד לא שולמו ולא נמסר עליהן צ׳ק') + '</span></div>' +
    '<div class="zs"><span class="lb">צ׳קים שעוד לא נפרעו</span><span class="fig">' + amt(chSum) + '</span><span class="sb">' + (ch.length ? cnt(ch.length, 'צ׳ק אחד', 'צ׳קים') : 'אין צ׳קים עתידיים') + '</span></div>' +
    '<div class="zs"><span class="lb">שולם ב-' + D.year + '</span><span class="fig">' + amt(D.paid_ytd) + '</span><span class="sb">כולל צ׳קים שנמסרו</span></div>' +
    '<div class="zs"><span class="lb">סך הכול מולו</span><span class="fig">' + amt(b + chSum) + '</span><span class="sb">פתוח ועוד צ׳קים עתידיים</span></div></div>';
  var buy = (D.po_open || []).length + (D.our_po || []).length + (D.our_inv || []).length;
  h += seg([['open', 'פתוחים', (D.open || []).length || ''], ['pay', 'תשלומים', (D.payments || []).length || ''], ['chq', 'צ׳קים', ch.length || ''], ['buy', 'רכש', buy || '']]);
  if (tab === 'open') h += openTable(D.open || [], true);
  else if (tab === 'pay') h += payments();
  else if (tab === 'chq') h += ch.length ? '<div class="slab"><table><thead><tr><th scope="col">נפרע ב</th><th scope="col">צ׳ק</th><th scope="col" class="n">סכום</th></tr></thead><tbody>' + ch.map(function (c) { return '<tr><td>' + dmy(c.due) + '</td><td><span class="ltr">' + esc(c.no || '') + '</span></td><td class="n b">' + amt(c.net) + '</td></tr>'; }).join('') + '<tr class="op"><td>סך הכול</td><td></td><td class="n">' + amt(chSum) + '</td></tr></tbody></table></div>' : '<div class="slab"><div class="empty">אין צ׳קים עתידיים לספק הזה.</div></div>';
  else h += supBuy();
  h += '<p class="src">הנתונים מפריוריטי' + (D.synced && D.synced.supplier_aging ? ', עודכנו ' + esc(when(D.synced.supplier_aging)) : '') + '. צ׳ק דחוי נחשב שם כתשלום ביום שנמסר, ולכן הוא לא בתוך היתרה הפתוחה.</p>';
  return h;
}
function payments() {
  var ps = D.payments || []; if (!ps.length) return '<div class="slab"><div class="empty">אין תשלומים רשומים לספק הזה.</div></div>';
  return '<div class="slab">' + ps.map(function (p) {
    var future = p.due && new Date(String(p.due).slice(0, 10) + 'T23:59:59') >= new Date();
    return '<details class="zd"><summary><span><span class="dl">' + (p.no ? 'צ׳ק <span class="ltr">' + esc(p.no) + '</span>' : 'העברה') + ' · ' + dmy(p.pay_date) + '</span><span class="ds">' + (p.no ? (future ? 'ייפרע ב-' : 'נפרע ב-') + dmy(p.due) + ' · ' : '') + cnt((p.lines || []).length, 'חשבונית אחת', 'חשבוניות') + '</span></span><span class="a">' + amt(p.net) + '</span>' + ic(I.chev) + '</summary>' +
      '<div class="zinn"><table><tbody>' + (p.lines || []).map(function (l) { return '<tr><td><span class="dl">חשבונית <span class="ltr">' + esc(l.sup_inv || l.inv || '') + '</span></span><span class="ds">' + dmy(l.date) + (l.inv && l.sup_inv ? ' · אצלנו <span class="ltr">' + esc(l.inv) + '</span>' : '') + '</span></td><td class="n b">' + amt(l.amount) + '</td></tr>'; }).join('') + '</tbody></table></div></details>';
  }).join('') + '</div>';
}
function supBuy() {
  var h = '', po = D.po_open || [], our = D.our_po || [], inv = D.our_inv || [];
  if (!po.length && !our.length && !inv.length) return '<div class="slab"><div class="empty">אין הזמנות רכש פתוחות ואין חשבוניות שהוקלדו אצלנו.</div></div>';
  if (our.length) h += '<div class="zhd">הזמנות רכש מהמערכת שלנו</div><div class="slab">' + our.map(function (p) { return '<div class="zrow"><span><span class="dl"><span class="ltr">' + esc(p.po_no) + '</span>' + (p.cancelled ? ' · בוטלה' : '') + '</span><span class="ds">' + dmy(p.at) + '</span></span><span class="a">' + (Number(p.total) ? amt(p.total) : '') + '</span></div>'; }).join('') + '</div>';
  if (po.length) h += '<div class="zhd">הזמנות רכש פתוחות בפריוריטי</div><div class="slab">' + po.map(function (p) { return '<div class="zrow"><span><span class="dl"><span class="ltr">' + esc(p.po) + '</span></span><span class="ds">' + dmy(p.date) + ' · ' + cnt(Number(p.n), 'שורה אחת פתוחה', 'שורות פתוחות') + '</span></span><span class="a">' + (Number(p.open_value) ? amt(p.open_value) : '') + '</span></div>'; }).join('') + '</div>';
  if (inv.length) h += '<div class="zhd">חשבוניות שהוקלדו אצלנו</div><div class="slab">' + inv.map(function (i) { return '<div class="zrow"><span><span class="dl">חשבונית <span class="ltr">' + esc(i.inv_no || '') + '</span></span><span class="ds">' + dmy(i.date) + ' · ' + ({ draft: 'מחכה לאישור', approved: 'אושרה', rejected: 'נדחתה', posted: 'בספרים' }[i.status] || esc(i.status || '')) + '</span></span><span class="a">' + amt(i.total) + '</span></div>'; }).join('') + '</div>';
  return h;
}

/* the movements as a file that opens in Excel (UTF-8 with a mark, so the Hebrew reads) */
function csv() {
  var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  var rows = [['תאריך', 'מסמך', 'סוג', 'אמצעי', 'חובה', 'זכות', 'יתרה'], [D.year + '-01-01', '', 'יתרת פתיחה', '', '', '', D.opening]];
  (D.moves || []).forEach(function (m) { rows.push([m.date, m.doc, m.label, m.method || '', m.debit || '', m.credit || '', m.bal]); });
  var blob = new Blob(['﻿' + rows.map(function (r) { return r.map(q).join(','); }).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'zisoceramics-account-' + String(D.id).replace(/[^\w-]/g, '') + '.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
}

window.ZisoAccount = { open: open, close: close };
})();
