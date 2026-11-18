/* ZisoPay: card payment inside our own pages (store, customer page, till). One script, no dependencies.
   ZisoPay.mount(el, { pay: <public token of a crm_pay_requests row>, onPaid(info), onError(msg) }) -> { destroy() }
   The card fields live only inside Tranzila's frame; this script never sees them. "Paid" is decided by the server
   (crm-pay-notify checks the payment with Tranzila); here we only ask crm-pay for the row's status.
   Look: CSS variables on el: --zp-ink, --zp-mute, --zp-line, --zp-accent, --zp-surface. */
(function () {
  'use strict';
  var FN = 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-pay';
  var KEY = 'sb_publishable_yjpTHQkvH5-l4v-HCcEj4w_ofAYpQmV';
  var CSS = '.zp{font:inherit;color:var(--zp-ink,#1e1b17);text-align:right;direction:rtl}' +
    '.zp-sum{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:0 0 12px;border-bottom:1px solid var(--zp-line,#ddd6c8);margin-bottom:12px}' +
    '.zp-sum b{font-size:1.5em;font-weight:700}.zp-sum span{color:var(--zp-mute,#5f5a52)}' +
    '.zp-box{position:relative;border:1px solid var(--zp-line,#ddd6c8);border-radius:12px;background:var(--zp-surface,#fff);overflow:hidden;min-height:330px}' +
    '.zp-box iframe{display:block;width:100%;height:330px;border:0;background:#fff}' +
    '.zp-wait{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--zp-surface,#fff);padding:16px;text-align:center}' +
    '.zp-wait[hidden],.zp-err[hidden]{display:none}' +
    '.zp-spin{width:34px;height:34px;border:3px solid var(--zp-line,#ddd6c8);border-top-color:var(--zp-accent,#8a6a35);border-radius:50%;animation:zp-r 1s linear infinite}' +
    '@keyframes zp-r{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.zp-spin{animation:none}}' +
    '.zp-note{color:var(--zp-mute,#5f5a52);font-size:.86em;margin:10px 0 0;display:flex;gap:6px;align-items:flex-start}' +
    '.zp-err{color:#a23b2c;font-weight:600;margin:10px 0 0}.zp-again{font:inherit;color:var(--zp-accent,#8a6a35);background:none;border:0;padding:0;text-decoration:underline;cursor:pointer}';
  function call(body) {
    return fetch(FN, { method: 'POST', headers: { 'content-type': 'application/json', apikey: KEY }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).catch(function () { return { ok: false, net: true }; });
  }
  function money(n) { return '₪' + Number(n || 0).toLocaleString('he-IL', { maximumFractionDigits: 2 }); }
  function mount(el, o) {
    if (!document.getElementById('zp-css')) { var s = document.createElement('style'); s.id = 'zp-css'; s.textContent = CSS; document.head.appendChild(s); }
    var dead = false, timer = null, done = false, frameUrl = '';
    el.innerHTML = '<div class="zp"><div class="zp-sum"><span>לתשלום</span><b class="zp-amt"></b></div>' +
      '<div class="zp-box"><div class="zp-wait" role="status"><div class="zp-spin"></div><span class="zp-msg">פותחים טופס תשלום מאובטח…</span></div></div>' +
      '<p class="zp-err" role="alert" hidden></p>' +
      '<p class="zp-note"><span aria-hidden="true">🔒</span><span>פרטי הכרטיס מוזנים ישירות אצל חברת הסליקה טרנזילה, בחיבור מוצפן. אנחנו לא רואים ולא שומרים אותם.</span></p></div>';
    var box = el.querySelector('.zp-box'), wait = el.querySelector('.zp-wait'), msg = el.querySelector('.zp-msg'), err = el.querySelector('.zp-err');
    function paid(info) { if (done || dead) return; done = true; stop(); if (o.onPaid) o.onPaid(info || {}); }
    function fail(text) { if (dead) return; stop(); if (o.onError) o.onError(text); }
    function stop() { clearInterval(timer); window.removeEventListener('message', onMsg); }
    function showFrame() {
      var old = box.querySelector('iframe'); if (old) old.remove();
      var f = document.createElement('iframe'); f.title = 'טופס תשלום מאובטח'; f.setAttribute('allow', 'payment'); f.src = frameUrl;
      f.addEventListener('load', function () { if (!wait.dataset.hold) wait.hidden = true; });
      wait.hidden = false; delete wait.dataset.hold; msg.textContent = 'פותחים טופס תשלום מאובטח…'; box.appendChild(f);
      setTimeout(function () { if (!wait.dataset.hold) wait.hidden = true; }, 4000);
    }
    function onMsg(e) {
      if (e.origin !== location.origin || !e.data || e.data.zisoPay === undefined) return;
      if (e.data.zisoPay === 'done') { wait.dataset.hold = '1'; wait.hidden = false; msg.textContent = 'התשלום התקבל, מאשרים את ההזמנה…'; err.hidden = true; poll(); }
      else { err.hidden = false; err.innerHTML = 'התשלום לא עבר. אפשר לבדוק את פרטי הכרטיס ו<button type="button" class="zp-again">לנסות שוב</button>.'; err.querySelector('button').onclick = function () { err.hidden = true; showFrame(); }; showFrame(); }
    }
    function poll() { call({ action: 'pay_state', t: o.pay }).then(function (r) { if (r && r.ok && r.status === 'paid') paid({ amount: r.amount }); }); }
    call({ action: 'pay_info', t: o.pay }).then(function (r) {
      if (dead) return;
      if (!r || !r.ok) return fail(r && r.net ? 'אין חיבור. נסו שוב.' : 'טופס התשלום לא נפתח.');
      el.querySelector('.zp-amt').textContent = money(r.amount);
      if (r.status === 'paid') return paid({ amount: r.amount });
      if (!r.frame_url) return fail('טופס התשלום לא נפתח.');
      frameUrl = r.frame_url; window.addEventListener('message', onMsg); showFrame();
      timer = setInterval(poll, 2500);
    });
    return { destroy: function () { dead = true; stop(); el.innerHTML = ''; } };
  }
  window.ZisoPay = { mount: mount };
})();
