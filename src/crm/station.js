/* The main office PC (station): whatever screen was left open goes back to the home screen after 5 quiet minutes,
   so the PC always rests on one home (home.html?wall=1, which then shows the screensaver).
   Runs only in the station's own Chrome window (flag zisoStation, set by home.html?wall=1). Nothing happens on phones or other PCs.
   A screen with something half typed, or an open order, is left alone. */
(function () {
  'use strict';
  var on = false;
  try { on = localStorage.getItem('zisoStation') === '1'; } catch (e) {}
  if (!on) return;
  var last = Date.now();
  ['pointerdown', 'keydown', 'wheel', 'input'].forEach(function (ev) { document.addEventListener(ev, function () { last = Date.now(); }, { passive: true, capture: true }); });
  /* touch screen: a long press must not open the browser menu */
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  function busy() {
    if (document.body.classList.contains('deal')) return true;
    var f = document.querySelectorAll('input, textarea');
    for (var i = 0; i < f.length; i++) {
      var t = (f[i].type || '').toLowerCase();
      if (/^(search|hidden|checkbox|radio|range|button|submit|file|color)$/.test(t) || f[i].readOnly || f[i].disabled) continue;
      if (f[i].offsetParent && String(f[i].value || '').trim() && f[i].value !== f[i].defaultValue) return true;
    }
    return !!document.querySelector('dialog[open]');
  }
  setInterval(function () {
    if (Date.now() - last < 5 * 60000 || busy()) return;
    location.replace('home.html?wall=1&idle=1');
  }, 30000);
})();
