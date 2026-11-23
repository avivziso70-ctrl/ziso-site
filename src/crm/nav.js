/* nav.js: one navigation shell for every internal screen of the system (23.11.2026, Aviv: "הכל תחת קורת גג אחת,
   לנווט בין התפריטים בצורה יעילה, ומכל מקום לחזור לבית").
   Each internal page holds <span data-zn>...fallback בית link...</span> in its header. This script fills it with the same two buttons
   everywhere: "בית" (always back to home.html, the one home screen) and "כל המסכים" (one menu, grouped by department).
   - Who sees what: home.html writes localStorage zisoWho (owner / eilat / moshe / shir). Money and bank: owner and Moshe.
     Books and the control board: owner only. The data itself is guarded by the database; the menu only hides doors.
   - The main office PC (localStorage zisoStation=1, the customer-visible screen) never shows money, accounts, books or the board.
   - books.html is also used by the bookkeeper (not staff): with no zisoWho on the device nothing is drawn there.
   - Keys: Ctrl+K (or ⌘K) opens the menu with its search, Esc closes, Alt+Home goes home.
   Public surfaces (shop, supplier portal, pay, my) do not load this file. */
(function () {
  'use strict';
  var slots = document.querySelectorAll('[data-zn]');
  if (!slots.length) return;
  var who = '', station = false;
  try { who = localStorage.getItem('zisoWho') || ''; station = localStorage.getItem('zisoStation') === '1'; } catch (e) {}
  var base = /\/dashboard\//.test(location.pathname) ? '../crm/' : '';
  var file = (location.pathname.split('/').pop() || 'index.html');
  if (/\/dashboard\//.test(location.pathname)) file = 'dashboard';
  if (file === 'books.html' && !who) return; /* the bookkeeper's own console stays as it is */

  /* the whole system, one tree. o = owner only, m = owner + Moshe, $ = hidden on the station screen */
  var TREE = [
    { g: 'מכירות ולקוחות', items: [
      { t: 'שיחות וואטסאפ', h: 'index.html#chats', i: 'chat' },
      { t: 'לקוחות', h: 'index.html#search', i: 'users' },
      { t: 'משימות היום', h: 'index.html#today', i: 'cal' },
      { t: 'הזמנות', h: 'order.html', i: 'deal' },
      { t: 'הזמנה חדשה', h: 'order.html?new=1', i: 'plus' },
      { t: 'קופה', h: 'kupa.html', i: 'cash' },
      { t: 'לשאול את קלוד', h: 'index.html#ask', i: 'spark' }
    ] },
    { g: 'רכש וסחורה', items: [
      { t: 'מחירון ספקים ורכש', h: 'prices.html', i: 'list' },
      { t: 'הגיעה סחורה', h: 'receive.html', i: 'box' }
    ] },
    { g: 'החנות באתר', items: [
      { t: 'ניהול החנות', h: 'shop.html', i: 'bag' },
      { t: 'החנות כמו שהלקוח רואה', h: '../shop/', i: 'out', ext: 1 }
    ] },
    { g: 'כספים והנהלת חשבונות', items: [
      { t: 'חשבוניות ספק', h: 'receive.html#invoices', i: 'inv', s: '$' },
      { t: 'כרטיסי חשבון', h: 'home.html#accounts', i: 'ledger', s: '$' },
      { t: 'כסף ובנק', h: 'home.html#money', i: 'bank', s: 'm$' },
      { t: 'ספרים', h: 'books.html', i: 'book', s: 'o$' },
      { t: 'לוח בקרה', h: '../dashboard/', i: 'chart', s: 'o$' }
    ] }
  ];
  function allowed(x) {
    var s = x.s || '';
    if (station && s.indexOf('$') >= 0) return false;
    if (s.indexOf('o') >= 0) return who === 'owner';
    if (s.indexOf('m') >= 0) return who === 'owner' || who === 'moshe';
    return true;
  }
  function here(x) {
    var p = x.h.split('#'), f = p[0].split('?')[0], hs = p[1] ? '#' + p[1] : '';
    if (f === '../dashboard/') return file === 'dashboard';
    if (f !== file) return false;
    if (f === 'index.html') return (location.hash || '#chats').split('/')[0] === hs;
    if (f === 'home.html' || f === 'receive.html') return location.hash.split('/')[0] === hs;
    if (f === 'order.html') return !/[?&]new=1/.test(location.search) === !/new=1/.test(x.h);
    return true;
  }
  var ICON = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.9.8 3.1 2.5 3.5 5.2"/>',
    cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    deal: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4M10 12h5M10 16h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    cash: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9.5v5M17.5 9.5v5"/>',
    spark: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2-5.2-1.8 5.2-1.8z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
    list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1"/><circle cx="4.8" cy="12" r="1"/><circle cx="4.8" cy="17.5" r="1"/>',
    box: '<path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z"/><path d="M3.5 7.5 12 11.5l8.5-4M12 11.5v9"/>',
    bag: '<path d="M5 8h14l-1 12.5H6z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
    out: '<path d="M13.5 4.5H19.5V10.5M19.5 4.5l-8 8"/><path d="M17 14v5.5H4.5V7H10"/>',
    inv: '<path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2z"/><path d="M9 8.5h6M9 12.5h6"/>',
    ledger: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M10 9v11"/>',
    bank: '<path d="M3.5 9 12 4l8.5 5z"/><path d="M5.5 9.5v8M10 9.5v8M14 9.5v8M18.5 9.5v8M3.5 20h17"/>',
    book: '<path d="M5 4.5h10.5a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z"/><path d="M5 16.5a3 3 0 0 1 3-3h10.5"/>',
    chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16l4-5 3 3 4.5-6"/>'
  };
  function svg(n) { return '<svg class="zn-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICON[n] || '') + '</svg>'; }
  function href(h) { return /^\.\.\//.test(h) ? (base ? h.replace(/^\.\.\/dashboard\//, './') : h) : base + h; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var css = document.createElement('style');
  css.textContent =
    '.zn{display:inline-flex;gap:8px;align-items:center;flex:none}' +
    '.zn-b{display:inline-flex;align-items:center;gap:7px;min-height:44px;padding:0 14px;border-radius:999px;border:1px solid #c9cfd2;background:#fff;color:#1b1d1f;' +
      'font:600 16px/1 "Assistant","Segoe UI",Arial,sans-serif;text-decoration:none;cursor:pointer;white-space:nowrap;-webkit-tap-highlight-color:transparent}' +
    '.zn-b:hover{background:#f1f4f5}.zn-b:focus-visible,.zn-d a:focus-visible,.zn-d button:focus-visible,.zn-d input:focus-visible{outline:3px solid #7a5c2c;outline-offset:2px}' +
    '.zn-b.home{background:#23282c;border-color:#23282c;color:#f4f1ea}.zn-b.home:hover{background:#363c41}' +
    '.zn-ic{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex:none}' +
    '@media (max-width:560px){.zn-b .zn-l2{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.zn-b{padding:0 12px}}' +
    '.zn-sh{position:fixed;inset:0;background:rgba(23,25,28,.42);z-index:2147483000;display:flex;justify-content:flex-start}' +
    '.zn-sh[hidden]{display:none}' +
    '.zn-d{direction:rtl;width:min(380px,100%);height:100%;background:#eceff0;color:#1b1d1f;display:flex;flex-direction:column;box-shadow:-12px 0 40px rgba(0,0,0,.22);' +
      'font:400 17px/1.4 "Assistant","Segoe UI",Arial,sans-serif;animation:znIn .18s ease-out}' +
    '@keyframes znIn{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}@media (prefers-reduced-motion:reduce){.zn-d{animation:none}}' +
    '.zn-top{display:flex;align-items:center;gap:10px;padding:14px 16px 10px;padding-top:max(14px,env(safe-area-inset-top))}' +
    '.zn-top h2{margin:0;flex:1;font:400 26px/1.1 "Bellefair","Times New Roman",serif}' +
    '.zn-x{width:44px;height:44px;border-radius:999px;border:1px solid #c9cfd2;background:#fff;color:#1b1d1f;display:grid;place-items:center;cursor:pointer}' +
    '.zn-f{margin:0 16px 8px;position:relative}.zn-f .zn-ic{position:absolute;inset-inline-start:14px;top:12px;color:#555b60}' +
    '.zn-f input{width:100%;box-sizing:border-box;min-height:44px;border-radius:999px;border:1px solid #c9cfd2;background:#fff;color:#1b1d1f;padding:0 44px 0 14px;font:inherit}' +
    '.zn-sc{overflow:auto;padding:0 16px 24px;flex:1;-webkit-overflow-scrolling:touch}' +
    '.zn-home{display:flex;align-items:center;gap:12px;min-height:52px;padding:0 14px;margin:4px 0 6px;border-radius:14px;background:#23282c;color:#f4f1ea;text-decoration:none;font-weight:700;font-size:18px}' +
    '.zn-g{margin:16px 0 6px;font-size:14px;font-weight:700;color:#555b60;letter-spacing:.02em}' +
    '.zn-ul{list-style:none;margin:0;padding:0;background:#fff;border:1px solid #d3d8da;border-radius:14px;overflow:hidden}' +
    '.zn-ul li+li{border-top:1px solid #d3d8da}' +
    '.zn-ul a{display:flex;align-items:center;gap:12px;min-height:50px;padding:0 14px;color:#1b1d1f;text-decoration:none}' +
    '.zn-ul a:hover{background:#f5f7f7}.zn-ul a .zn-ic{color:#6f5325}' +
    '.zn-ul a[aria-current="page"]{background:#f3ece0;font-weight:700;box-shadow:inset -4px 0 0 #7a5c2c}' +
    '.zn-ul a .zn-ext{margin-inline-start:auto;font-size:13px;color:#555b60}' +
    '.zn-none{padding:14px;color:#555b60}.zn-hint{margin:14px 0 0;font-size:13px;color:#555b60}';
  document.head.appendChild(css);

  var onHome = file === 'home.html' && !/^#(money|accounts|acct)/.test(location.hash);
  var homeUrl = base + 'home.html';
  slots.forEach(function (slot) {
    var compact = slot.hasAttribute('data-zn-menu-only');
    slot.className = (slot.className ? slot.className + ' ' : '') + 'zn';
    slot.innerHTML = (onHome || compact ? '' : '<a class="zn-b home" href="' + homeUrl + '" aria-label="בית: למסך הבית">' + svg('home') + '<span>בית</span></a>') +
      '<button class="zn-b zn-open" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="znSheet" title="כל המסכים (Ctrl+K)">' + svg('grid') + '<span class="zn-l2">כל המסכים</span></button>';
  });

  var sheet = document.createElement('div');
  sheet.className = 'zn-sh'; sheet.id = 'znSheet'; sheet.hidden = true;
  document.body.appendChild(sheet);
  var q = null;
  function draw() {
  var body = '<div class="zn-d" role="dialog" aria-modal="true" aria-labelledby="znH">' +
    '<div class="zn-top"><h2 id="znH">כל המסכים</h2><button class="zn-x" type="button" aria-label="לסגור">' + svg('x') + '</button></div>' +
    '<div class="zn-f">' + svg('search') + '<label for="znQ" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">לחפש מסך</label>' +
      '<input id="znQ" type="search" placeholder="לחפש מסך" autocomplete="off" enterkeyhint="go"></div>' +
    '<div class="zn-sc"><a class="zn-home" href="' + homeUrl + '"' + (onHome ? ' aria-current="page"' : '') + '>' + svg('home') + 'בית</a>';
  TREE.forEach(function (grp) {
    var its = grp.items.filter(allowed);
    if (!its.length) return;
    body += '<div class="zn-grp"><h3 class="zn-g">' + esc(grp.g) + '</h3><ul class="zn-ul">' + its.map(function (x) {
      return '<li><a href="' + href(x.h) + '"' + (x.ext ? ' target="_blank" rel="noopener"' : '') + (here(x) ? ' aria-current="page"' : '') + ' data-k="' + esc(x.t + ' ' + grp.g) + '">' +
        svg(x.i) + '<span>' + esc(x.t) + '</span>' + (x.ext ? '<span class="zn-ext">נפתח בחלון חדש</span>' : '') + '</a></li>';
    }).join('') + '</ul></div>';
  });
  body += '<p class="zn-none" hidden>לא נמצא מסך בשם הזה.</p><p class="zn-hint">קיצור: Ctrl+K פותח את התפריט, Esc סוגר.</p></div></div>';
  sheet.innerHTML = body;
  q = sheet.querySelector('#znQ');
  q.addEventListener('input', filter);
  q.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var a = sheet.querySelector('.zn-grp:not([hidden]) li:not([hidden]) a');
    if (a) { e.preventDefault(); a.click(); }
  });
  }
  draw();
  /* home.html calls this once it knows who signed in, so the menu is right from the first visit */
  window.zisoNav = { refresh: function () { try { who = localStorage.getItem('zisoWho') || ''; } catch (e) {} if (sheet.hidden) draw(); } };

  var opener = null;
  function open(from) {
    opener = from || document.activeElement; sheet.hidden = false; q.value = ''; filter();
    document.querySelectorAll('.zn-open').forEach(function (b) { b.setAttribute('aria-expanded', 'true'); });
    document.documentElement.style.overflow = 'hidden';
    var cur = sheet.querySelector('a[aria-current="page"]');
    (matchMedia('(pointer:fine)').matches ? q : (cur || q)).focus();
  }
  function close() {
    if (sheet.hidden) return;
    sheet.hidden = true; document.documentElement.style.overflow = '';
    document.querySelectorAll('.zn-open').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    if (opener && opener.focus) opener.focus();
  }
  function filter() {
    var v = q.value.trim(), any = false;
    sheet.querySelectorAll('.zn-grp').forEach(function (g) {
      var vis = 0;
      g.querySelectorAll('li').forEach(function (li) { var ok = !v || li.firstChild.getAttribute('data-k').indexOf(v) >= 0; li.hidden = !ok; if (ok) vis++; });
      g.hidden = !vis; if (vis) any = true;
    });
    sheet.querySelector('.zn-none').hidden = any;
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.zn-open');
    if (b) { e.preventDefault(); open(b); return; }
    if (e.target === sheet || (e.target.closest && e.target.closest('.zn-x'))) close();
    /* a link to another view of the same page (index.html#chats while on index.html) only changes the hash: close the menu */
    var a = e.target.closest && e.target.closest('.zn-d a');
    if (a && !a.target) setTimeout(close, 0);
  });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.key === 'ל')) { e.preventDefault(); sheet.hidden ? open() : close(); return; }
    if (e.altKey && e.key === 'Home') { e.preventDefault(); location.href = homeUrl; return; }
    if (sheet.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') { /* keep focus inside the open menu */
      var f = Array.prototype.filter.call(sheet.querySelectorAll('a,button,input'), function (n) { return n.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('hashchange', function () {
    sheet.querySelectorAll('.zn-ul a').forEach(function (a) { a.removeAttribute('aria-current'); });
    TREE.forEach(function (grp) { grp.items.filter(allowed).forEach(function (x) {
      if (here(x)) { var a = sheet.querySelector('.zn-ul a[href="' + href(x.h) + '"]'); if (a) a.setAttribute('aria-current', 'page'); }
    }); });
  });
})();
