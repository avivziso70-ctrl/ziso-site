/* The money pig: a short treat after money is saved, a payment link goes out, or a card charge is approved.
   window.zisoPiggy() plays it. It never blocks anything: no pointer events, no focus change, hidden from
   screen readers, gone after 2 s. With "reduce motion" on (IS 5568 / WCAG 2.3.3) the pig just sits there,
   full and still, for a moment, with no movement at all. */
(function () {
  'use strict';
  var DUR = 2000, timer = null, styled = false;

  var CSS = '' +
    '.zp{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));width:180px;height:210px;margin-left:-90px;pointer-events:none;z-index:2147483000;direction:ltr}' +
    '.zp svg{position:absolute;overflow:visible}' +
    '.zp .zpPig{left:0;bottom:0;width:180px;height:180px}' +
    '.zp .zpIt{position:absolute;left:65px;bottom:16px;width:50px;height:50px;opacity:0}.zp .zpIt svg{position:static;width:100%;height:100%}' +
    '.zp .zpSay{position:absolute;top:0;right:-18px;background:#fff;color:#7a2340;font:700 18px/1 "Assistant","Segoe UI",Arial,sans-serif;padding:7px 11px;border-radius:14px;border:2px solid #e07aa0;direction:rtl;opacity:0}' +
    '.zp .zpMouth,.zp .zpBody{transform-box:fill-box;transform-origin:50% 50%}' +
    '@media (prefers-reduced-motion: no-preference){' +
      '.zp .zpPig{animation:zpIn ' + DUR + 'ms cubic-bezier(.3,1.4,.5,1) both}' +
      '.zp .zpBody{animation:zpPuff ' + DUR + 'ms ease-out both}' +
      '.zp .zpMouth{animation:zpChomp ' + DUR + 'ms linear both}' +
      '.zp .zpIt{animation:zpFall 520ms cubic-bezier(.5,0,.9,.6) both}' +
      '.zp .zpSay{animation:zpSay ' + DUR + 'ms ease-out both}' +
    '}' +
    '@media (prefers-reduced-motion: reduce){.zp .zpSay{opacity:1}.zp .zpBody{transform:scale(1.06)}}' +
    '@keyframes zpIn{0%{transform:translateY(60px) scale(.5);opacity:0}12%{transform:none;opacity:1}92%{transform:none;opacity:1}100%{transform:translateY(40px) scale(.7);opacity:0}}' +
    '@keyframes zpPuff{0%,36%{transform:none}42%{transform:scale(1.04)}55%{transform:scale(1.08)}68%{transform:scale(1.1)}81%{transform:scale(1.15,1.12)}86%{transform:scale(1.03)}90%,100%{transform:scale(1.06)}}' +
    '@keyframes zpChomp{0%{transform:scaleY(.5)}24%{transform:scaleY(1.3)}38%{transform:scaleY(1.3)}41%{transform:scaleY(.15)}47%{transform:scaleY(1.3)}52%{transform:scaleY(1.3)}55%{transform:scaleY(.15)}60%{transform:scaleY(1.3)}65%{transform:scaleY(1.3)}68%{transform:scaleY(.15)}72%{transform:scaleY(1.3)}78%{transform:scaleY(1.3)}81%{transform:scaleY(.15)}100%{transform:scaleY(.5)}}' +
    '@keyframes zpFall{0%{transform:translate(var(--dx),-190px) rotate(var(--r)) scale(1);opacity:0}10%{opacity:1}85%{opacity:1}100%{transform:translate(0,0) rotate(0) scale(.25);opacity:0}}' +
    '@keyframes zpSay{0%,80%{opacity:0;transform:scale(.6)}84%{opacity:1;transform:scale(1.08)}87%,95%{opacity:1;transform:none}100%{opacity:0}}';

  // Front-facing fat pink piggy bank: coin slot on top, mouth under the snout (that is where the food goes).
  var PIG = '<svg class="zpPig" viewBox="0 0 200 200" aria-hidden="true" focusable="false"><g class="zpBody">' +
    '<path d="M40 70 L52 26 L82 54 Z" fill="#f48fb1" stroke="#d96b93" stroke-width="3" stroke-linejoin="round"/>' +
    '<path d="M160 70 L148 26 L118 54 Z" fill="#f48fb1" stroke="#d96b93" stroke-width="3" stroke-linejoin="round"/>' +
    '<ellipse cx="62" cy="180" rx="18" ry="11" fill="#e98bb0"/><ellipse cx="138" cy="180" rx="18" ry="11" fill="#e98bb0"/>' +
    '<ellipse cx="100" cy="115" rx="84" ry="70" fill="#f9b4cd" stroke="#d96b93" stroke-width="3"/>' +
    '<rect x="84" y="49" width="32" height="7" rx="3.5" fill="#b9456f"/>' +
    '<ellipse cx="52" cy="128" rx="13" ry="8" fill="#f27fa8" opacity=".7"/><ellipse cx="148" cy="128" rx="13" ry="8" fill="#f27fa8" opacity=".7"/>' +
    '<circle cx="70" cy="96" r="7" fill="#2b1a22"/><circle cx="130" cy="96" r="7" fill="#2b1a22"/>' +
    '<circle cx="72.5" cy="93.5" r="2.4" fill="#fff"/><circle cx="132.5" cy="93.5" r="2.4" fill="#fff"/>' +
    '<ellipse cx="100" cy="122" rx="27" ry="18" fill="#f48fb1" stroke="#d96b93" stroke-width="3"/>' +
    '<ellipse cx="91" cy="122" rx="4.5" ry="6.5" fill="#b9456f"/><ellipse cx="109" cy="122" rx="4.5" ry="6.5" fill="#b9456f"/>' +
    '<g class="zpMouth"><ellipse cx="100" cy="156" rx="17" ry="11" fill="#7a2340"/><ellipse cx="100" cy="161" rx="9" ry="4.5" fill="#f06292"/></g>' +
    '</g></svg>';

  // What the pig eats: a shekel bill, a shawarma in laffa, a Romanian kebab on a skewer, a coin.
  var BILL = '<svg viewBox="0 0 60 60" aria-hidden="true" focusable="false"><rect x="4" y="16" width="52" height="28" rx="4" fill="#7cc58b" stroke="#3f8a53" stroke-width="2.5"/><circle cx="30" cy="30" r="9" fill="#bfe5c7"/><text x="30" y="35.5" text-anchor="middle" font-size="15" font-weight="700" fill="#2f6b40" font-family="Arial,sans-serif">₪</text></svg>';
  var SHAWARMA = '<svg viewBox="0 0 60 60" aria-hidden="true" focusable="false"><path d="M14 14 L46 14 L33 56 L27 56 Z" fill="#f2d39b" stroke="#c9a165" stroke-width="2.5" stroke-linejoin="round"/><path d="M18 24 L42 24 M21 34 L39 34 M24 44 L36 44" stroke="#c9a165" stroke-width="2"/><ellipse cx="30" cy="13" rx="17" ry="7" fill="#9c5a2e"/><circle cx="21" cy="9" r="3.2" fill="#e53935"/><circle cx="38" cy="10" r="3" fill="#43a047"/><circle cx="30" cy="7" r="2.6" fill="#7cb342"/></svg>';
  var KEBAB = '<svg viewBox="0 0 60 60" aria-hidden="true" focusable="false"><line x1="6" y1="54" x2="54" y2="6" stroke="#9e9e9e" stroke-width="3" stroke-linecap="round"/><g fill="#8d4a22" stroke="#5d2e12" stroke-width="2"><rect x="10" y="36" width="18" height="10" rx="5" transform="rotate(-45 19 41)"/><rect x="21" y="25" width="18" height="10" rx="5" transform="rotate(-45 30 30)"/><rect x="32" y="14" width="18" height="10" rx="5" transform="rotate(-45 41 19)"/></g><circle cx="47" cy="13" r="2" fill="#e53935"/></svg>';
  var COIN = '<svg viewBox="0 0 60 60" aria-hidden="true" focusable="false"><circle cx="30" cy="30" r="17" fill="#f6c945" stroke="#c99a1a" stroke-width="3"/><text x="30" y="36" text-anchor="middle" font-size="17" font-weight="700" fill="#8a6500" font-family="Arial,sans-serif">₪</text></svg>';
  var ITEMS = [[BILL, -70, -25], [SHAWARMA, 60, 20], [KEBAB, -40, -35], [COIN, 70, 30]];

  function style() {
    if (styled) return; styled = true;
    var s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
  }
  function stop() { clearTimeout(timer); var o = document.querySelector('.zp'); if (o) o.remove(); }

  window.zisoPiggy = function () {
    try {
      style(); stop();
      var calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      var w = document.createElement('div');
      w.className = 'zp'; w.setAttribute('aria-hidden', 'true');
      var h = PIG + '<div class="zpSay">יאמי!</div>';
      if (!calm) ITEMS.forEach(function (it, i) {
        h += '<div class="zpIt" style="--dx:' + it[1] + 'px;--r:' + it[2] + 'deg;animation-delay:' + (230 + i * 250) + 'ms">' + it[0] + '</div>';
      });
      w.innerHTML = h;
      document.body.appendChild(w);
      timer = setTimeout(stop, calm ? 1400 : DUR + 50);
    } catch (_) { /* a treat, never a failure */ }
  };
})();
