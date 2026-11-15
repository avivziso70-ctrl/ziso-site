(function () {
  'use strict';
  var SB_URL = 'https://ppnjosyraosrdephsksu.supabase.co';
  var FN = SB_URL + '/functions/v1/shop';
  var sb = window.supabase ? supabase.createClient(SB_URL, 'sb_publishable_yjpTHQkvH5-l4v-HCcEj4w_ofAYpQmV', { auth: { persistSession: true, autoRefreshToken: true } }) : null;
  var PAGE = 48;
  var $ = function (id) { return document.getElementById(id); };
  var state = { items: [], byId: {}, live: false, fee: null, group: '', q: '', sort: '', shown: PAGE, session: null };
  var cart = load();

  // A few broad groups over the supplier's many small categories
  var GROUPS = [
    ['מראות', /מרא/],
    ['ארונות אמבטיה', /ארון|ארונות|תחתון|מזנון|עמוד/],
    ['כיורים', /כיור/],
    ['אסלות', /אסל|מושב|ניאגרה|מיכל הדחה/],
    ['ברזים ומקלחות', /ברז|מזלף|ראש מקלחת|מערכת קיר|סוללה|BATHROOM|מוט/i],
    ['מקלחונים', /מקלחון|WALK IN|מחיצ|דלת/i],
  ];
  function groupOf(it) {
    var t = (it.category || '') + ' ' + (it.name || '');
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i][1].test(t)) return GROUPS[i][0];
    return 'אביזרים ועוד';
  }
  function money(n) { return '₪' + Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function load() { try { return JSON.parse(localStorage.getItem('ziso_cart') || '{}') || {}; } catch (e) { return {}; } }
  function save() { try { localStorage.setItem('ziso_cart', JSON.stringify(cart)); } catch (e) {} renderCount(); }
  function post(body, jwt) {
    var h = { 'content-type': 'application/json' };
    if (jwt) h.authorization = 'Bearer ' + jwt;
    return fetch(FN, { method: 'POST', headers: h, body: JSON.stringify(body) }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }

  function start() {
    var sess = sb ? sb.auth.getSession().then(function (r) { return r.data && r.data.session; }) : Promise.resolve(null);
    sess.then(function (s) { state.session = s; return post({ action: 'catalog' }, s && s.access_token); }).then(function (c) {
      $('loading').hidden = true;
      if (!c || !c.ok) { $('loading').hidden = false; $('loading').textContent = 'לא הצלחנו לטעון את המוצרים. נסו לרענן, או התקשרו 050-4770040.'; return; }
      state.live = !!c.live; state.fee = c.delivery_fee;
      document.querySelectorAll('#leadText,.leadText').forEach(function (e) { e.textContent = c.lead_text; });
      state.items = c.items.map(function (it) { it.group = groupOf(it); it.hay = ((it.name || '') + ' ' + (it.code || '') + ' ' + (it.category || '') + ' ' + (it.size || '')).toLowerCase(); state.byId[it.id] = it; return it; });
      // items that left the catalog drop out of a saved cart
      Object.keys(cart).forEach(function (id) { if (!state.byId[id]) delete cart[id]; }); save();
      if (state.fee != null) { $('delivRow').hidden = false; $('delivFee').textContent = money(state.fee); }
      if (!state.live) $('previewBar').hidden = false;
      if (c.gated) { $('gate').hidden = false; return; }
      openStore();
    });
  }
  function openStore() {
    $('gate').hidden = true; $('store').hidden = false;
    var names = ['הכל'].concat(GROUPS.map(function (g) { return g[0]; }), ['אביזרים ועוד']);
    $('chips').innerHTML = names.map(function (n, i) { return '<button type="button" aria-pressed="' + (i === 0) + '" data-g="' + (i ? esc(n) : '') + '">' + esc(n) + '</button>'; }).join('');
    render();
  }

  function filtered() {
    var q = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var list = state.items.filter(function (it) {
      if (state.group && it.group !== state.group) return false;
      for (var i = 0; i < q.length; i++) if (it.hay.indexOf(q[i]) < 0) return false;
      return true;
    });
    if (state.sort === 'asc') list.sort(function (a, b) { return a.price - b.price; });
    else if (state.sort === 'desc') list.sort(function (a, b) { return b.price - a.price; });
    else list.sort(function (a, b) { return (b.img ? 1 : 0) - (a.img ? 1 : 0); }); // products with a picture first
    return list;
  }
  function card(it) {
    var opts = ''; for (var n = 1; n <= 10; n++) opts += '<option>' + n + '</option>';
    return '<li class="card"><div class="ph">' + (it.img ? '<img loading="lazy" src="' + esc(it.img) + '" alt="' + esc(it.name) + '">' : '<span class="none" aria-hidden="true">זיסו</span>') + '</div>' +
      '<div class="body"><h2>' + esc(it.name) + '</h2>' +
      (it.size ? '<span class="small">מידה: ' + esc(it.size) + '</span>' : '') +
      (it.code ? '<span class="small">מק״ט ' + esc(it.code) + '</span>' : '') +
      '<div class="price">' + money(it.price) + ' <small>כולל מע״מ</small></div>' +
      '<div class="add"><select aria-label="כמות עבור ' + esc(it.name) + '" data-qty="' + it.id + '">' + opts + '</select>' +
      '<button class="btn brass" type="button" data-add="' + it.id + '">הוספה לסל</button></div></div></li>';
  }
  function render() {
    var list = filtered();
    $('grid').innerHTML = list.slice(0, state.shown).map(card).join('');
    $('meta').textContent = list.length ? list.length.toLocaleString('he-IL') + ' מוצרים' : '';
    if (!list.length) $('grid').innerHTML = '<li class="empty" style="grid-column:1/-1">לא מצאנו מוצר כזה. נסו מילה אחרת, או <a href="https://wa.me/972504770040">שאלו אותנו בוואטסאפ</a>.</li>';
    $('moreBtn').hidden = list.length <= state.shown;
  }
  function renderCount() { var n = 0; Object.keys(cart).forEach(function (k) { n += cart[k]; }); $('cartCount').textContent = n; }

  function renderCart() {
    var ids = Object.keys(cart).filter(function (id) { return state.byId[id]; });
    if (!ids.length) { $('lines').innerHTML = '<p class="empty">הסל ריק.</p>'; $('totals').innerHTML = ''; $('checkout').hidden = true; return; }
    var sum = 0;
    $('lines').innerHTML = ids.map(function (id) {
      var it = state.byId[id], q = cart[id]; sum += it.price * q;
      return '<div class="line">' + (it.img ? '<img src="' + esc(it.img) + '" alt="">' : '<span class="thumb"></span>') +
        '<div><div>' + esc(it.name) + '</div><div class="small">' + money(it.price) + ' ליחידה' + (it.size ? ' · ' + esc(it.size) : '') + '</div></div>' +
        '<div class="q"><button type="button" data-dec="' + id + '" aria-label="הפחתה">−</button><span aria-live="polite">' + q + '</span><button type="button" data-inc="' + id + '" aria-label="הוספה">+</button></div></div>';
    }).join('');
    var deliv = document.querySelector('input[name=delivery]:checked');
    var fee = deliv && deliv.value === 'delivery' && state.fee != null ? Number(state.fee) : 0;
    $('totals').innerHTML = '<div class="tot"><span>מוצרים</span><span>' + money(sum) + '</span></div>' +
      '<div class="tot"><span>' + (fee ? 'משלוח' : 'איסוף עצמי') + '</span><span>' + (fee ? money(fee) : 'ללא עלות') + '</span></div>' +
      '<div class="tot big"><span>סה״כ לתשלום (כולל מע״מ)</span><span>' + money(sum + fee) + '</span></div>' +
      (state.live ? '' : '<p class="small">תצוגה מקדימה: בתשלום יחויבו ₪5 בדיקה בלבד.</p>');
    $('checkout').hidden = false;
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.dataset.add) {
      var id = t.dataset.add, sel = document.querySelector('[data-qty="' + id + '"]');
      cart[id] = Math.min(50, (cart[id] || 0) + Number(sel ? sel.value : 1)); save();
      t.textContent = 'נוסף ✓'; setTimeout(function () { t.textContent = 'הוספה לסל'; }, 1400);
    } else if (t.dataset.inc) { cart[t.dataset.inc] = Math.min(50, cart[t.dataset.inc] + 1); save(); renderCart(); }
    else if (t.dataset.dec) { if (--cart[t.dataset.dec] <= 0) delete cart[t.dataset.dec]; save(); renderCart(); }
    else if (t.dataset.g !== undefined) {
      state.group = t.dataset.g; state.shown = PAGE;
      document.querySelectorAll('#chips button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === t)); });
      render();
    } else if (t.hasAttribute('data-close')) $('cartDlg').close();
  });
  $('cartBtn').addEventListener('click', function () { renderCart(); $('cartDlg').showModal(); });
  $('moreBtn').addEventListener('click', function () { state.shown += PAGE; render(); });
  var tm; $('q').addEventListener('input', function (e) { clearTimeout(tm); tm = setTimeout(function () { state.q = e.target.value; state.shown = PAGE; render(); }, 150); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
  document.querySelectorAll('input[name=delivery]').forEach(function (r) { r.addEventListener('change', function () { $('addr').hidden = r.value !== 'delivery' || !r.checked; renderCart(); }); });

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); var f = e.target; $('loginMsg').textContent = '';
    sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value }).then(function (r) {
      if (r.error || !r.data.session) { $('loginMsg').textContent = 'הכניסה נכשלה. בדקו מייל וסיסמה.'; return; }
      state.session = r.data.session; $('gate').hidden = true; $('loading').hidden = false; start();
    });
  });

  $('checkout').addEventListener('submit', function (e) {
    e.preventDefault(); var f = e.target, msg = $('payMsg'); msg.className = 'msg'; msg.textContent = '';
    var bad = function (el, text) { msg.className = 'msg err'; msg.textContent = text; el.focus(); return false; };
    var phone = f.phone.value.replace(/\D/g, '');
    if (f.name.value.trim().length < 2) return bad(f.name, 'נא למלא שם מלא.');
    if (!/^0(5\d|[2-9])\d{7}$/.test(phone)) return bad(f.phone, 'נא למלא מספר טלפון תקין.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.value.trim())) return bad(f.email, 'נא למלא כתובת מייל תקינה.');
    var deliv = f.delivery.value;
    if (deliv === 'delivery' && (f.address.value.trim().length < 3 || f.city.value.trim().length < 2)) return bad(f.address, 'נא למלא כתובת ועיר למשלוח.');
    if (!f.terms.checked) return bad(f.terms, 'כדי להמשיך יש לאשר את התקנון ותנאי הביטול.');
    var items = Object.keys(cart).map(function (id) { return { id: Number(id), qty: cart[id] }; });
    $('payBtn').disabled = true; msg.textContent = 'פותחים את דף התשלום המאובטח…';
    var jwt = state.session && state.session.access_token;
    post({ action: 'checkout', items: items, name: f.name.value, phone: phone, email: f.email.value, delivery: deliv, address: f.address.value, city: f.city.value, notes: f.notes.value, terms: true, marketing: f.marketing.checked }, jwt).then(function (r) {
      if (!r.ok) { $('payBtn').disabled = false; msg.className = 'msg err'; msg.textContent = r.error || 'משהו השתבש. נסו שוב או התקשרו 050-4770040.'; return; }
      try { localStorage.setItem('ziso_last_order', r.token); } catch (x) {}
      cart = {}; save();
      location.href = r.pr_link;
    }).catch(function () { $('payBtn').disabled = false; msg.className = 'msg err'; msg.textContent = 'אין חיבור. נסו שוב.'; });
  });

  renderCount(); start();
})();
