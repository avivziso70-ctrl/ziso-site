/* Shop measurement: GA4 + Meta pixel, loaded ONLY after the visitor agrees (same "ziso_consent" choice as the main site,
   same origin, so a yes/no given on the site counts here too). Nothing is sent before consent; events wait in a queue.
   No personal data in any event: no name, phone, email or address. Only product ids/names, quantities, prices and the
   order number. Staff (signed in to the staff system) and ?test=1 sessions are never measured. Approved by Aviv 19.11.2026. */
(function () {
  var GA = 'G-M02XKGDM7H', META = '774998039816486', CK = 'ziso_consent';
  var q = [], send = null, off = /[?&]test=1/.test(location.search);
  try { if (localStorage.getItem('sb-ppnjosyraosrdephsksu-auth-token')) off = true; } catch (e) {}
  function consent() { try { return localStorage.getItem(CK); } catch (e) { return null; } }

  // utm_* / click ids from the social posts, kept for this tab so GA4 still gets the campaign when consent comes later
  try {
    var p = new URLSearchParams(location.search), c = {};
    ['source', 'medium', 'campaign', 'content', 'term', 'id'].forEach(function (k) { var v = p.get('utm_' + k); if (v) c[k] = v; });
    ['gclid', 'fbclid'].forEach(function (k) { var v = p.get(k); if (v) c[k] = v; });
    if (Object.keys(c).length) { c.landing = location.pathname; c.ref = document.referrer || ''; sessionStorage.setItem('ziso_utm', JSON.stringify(c)); }
  } catch (e) {}

  var FB = { view_item: 'ViewContent', add_to_cart: 'AddToCart', begin_checkout: 'InitiateCheckout', purchase: 'Purchase', search: 'Search' };
  function load() {
    if (off || send) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted' });
    gtag('js', new Date());
    var cfg = { anonymize_ip: true };
    try { var u = JSON.parse(sessionStorage.getItem('ziso_utm') || 'null'); if (u) { if (u.source) cfg.campaign_source = u.source; if (u.medium) cfg.campaign_medium = u.medium; if (u.campaign) cfg.campaign_name = u.campaign; if (u.content) cfg.campaign_content = u.content; if (u.term) cfg.campaign_term = u.term; } } catch (e) {}
    gtag('config', GA, cfg);
    var s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA; document.head.appendChild(s);
    !function (f, b, e, v, n, t, x) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
      x = b.getElementsByTagName(e)[0]; x.parentNode.insertBefore(t, x); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', META); fbq('track', 'PageView');   // no advanced matching
    send = function (ev, x) {
      gtag('event', ev, x);
      var m = FB[ev]; if (!m) return;
      var d = {};
      if (x.value != null) { d.value = x.value; d.currency = 'ILS'; }
      if (x.items) { d.content_ids = x.items.map(function (i) { return String(i.item_id); }); d.content_type = 'product'; d.num_items = x.items.reduce(function (a, i) { return a + (i.quantity || 1); }, 0); }
      if (x.search_term) d.search_string = x.search_term;
      fbq('track', m, d);
    };
    var w = q; q = []; w.forEach(function (e) { send(e[0], e[1]); });
  }

  window.shopTrack = function (ev, x) { if (off) return; x = x || {}; if (send) send(ev, x); else if (q.length < 50) q.push([ev, x]); };

  // the consent box (same text as the main site) and the "cookie settings" link in the footer
  function box() { return document.getElementById('cookie'); }
  document.addEventListener('DOMContentLoaded', function () {
    var b = box(); if (!b) return;
    if (!consent()) b.hidden = false;
    b.addEventListener('click', function (e) { var t = e.target.closest('[data-consent]'); if (!t) return; var v = t.getAttribute('data-consent');
      try { localStorage.setItem(CK, v); } catch (err) {} b.hidden = true; if (v === 'yes') load(); else q = []; });
    document.querySelectorAll('[data-cookie-settings]').forEach(function (s) { s.addEventListener('click', function () {
      try { localStorage.removeItem(CK); } catch (e) {} b.hidden = false; b.querySelector('button').focus(); }); });
  });
  if (consent() === 'yes') load();
})();
