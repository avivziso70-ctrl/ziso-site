// Porcelain slabs: each canvas gets seeded marble veining so the wall looks the same on every visit.
(function(){
  function rng(seed){return function(){seed=(seed*16807)%2147483647;return (seed-1)/2147483646}}
  function slab(c,seed){
    var r=rng(seed),d=window.devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;
    if(!w||!h)return; c.width=w*d;c.height=h*d;var x=c.getContext('2d');x.scale(d,d);
    var g=x.createLinearGradient(0,0,w,h);g.addColorStop(0,'#f1eee8');g.addColorStop(1,'#ddd7cd');x.fillStyle=g;x.fillRect(0,0,w,h);
    for(var v=0;v<5;v++){
      var px=r()*w,py=-10,ang=Math.PI/2+(r()-.5)*1.2,main=v<2;
      x.beginPath();x.moveTo(px,py);
      for(var s=0;s<140;s++){ang+=(r()-.5)*.35;px+=Math.cos(ang)*6;py+=Math.sin(ang)*6;x.lineTo(px,py);if(py>h+10)break}
      x.strokeStyle=main?'rgba(120,104,82,.38)':'rgba(140,128,110,.22)';x.lineWidth=main?1.4+r()*1.2:.6;x.stroke();
      if(main){x.strokeStyle='rgba(148,115,61,.18)';x.lineWidth=5;x.stroke()}
    }
  }
  function all(){document.querySelectorAll('.slabs canvas').forEach(function(c,i){slab(c,1307*(i+3))})}
  if(document.readyState!=='loading')all();else document.addEventListener('DOMContentLoaded',all);
  var t;window.addEventListener('resize',function(){clearTimeout(t);t=setTimeout(all,150)});
})();

// Tile quantity calculator.
(function(){
  var f=document.getElementById('calc');if(!f)return;
  var $=function(id){return document.getElementById(id)};
  function num(id){var v=parseFloat(String($(id).value).replace(',','.'));return isFinite(v)&&v>0?v:0}
  function fmt(n,dp){return n.toLocaleString('he-IL',{minimumFractionDigits:dp,maximumFractionDigits:dp})}
  function run(){
    var mode=f.querySelector('input[name=mode]:checked').value;
    $('dims').hidden=mode!=='dims';$('direct').hidden=mode!=='area';
    var area=mode==='dims'?num('len')*num('wid'):num('area');
    var size=$('size').value.split('x'),tw=+size[0],th=+size[1];
    var waste=+f.querySelector('input[name=lay]:checked').value;
    var need=area*(1+waste/100);
    var tileM2=tw*th/10000,tiles=tileM2?Math.ceil(need/tileM2):0;
    var box=num('box'),boxes=box?Math.ceil(need/box):0;
    $('o-m2').textContent=area?fmt(box?boxes*box:need,2):'0';
    $('o-net').textContent=fmt(area,2)+' מ"ר';
    $('o-waste').textContent=waste+'%';
    $('o-tiles').textContent=area?fmt(tiles,0):'0';
    $('o-boxes').textContent=box?(area?fmt(boxes,0):'0'):'הזינו כמה מ"ר בקרטון';
  }
  f.addEventListener('input',run);f.addEventListener('submit',function(e){e.preventDefault();run()});run();
})();

// Tracking (dormant until IDs are filled): GTM container holds GA4 + Meta Pixel "Ziso Web".
(function(){
  var GTM_ID=window.ZISO_GTM_ID||''; // e.g. GTM-XXXXXXX, set in build.py
  window.dataLayer=window.dataLayer||[];
  function push(ev,extra){var o=Object.assign({event:ev},extra||{});window.dataLayer.push(o)}
  // GTM itself is loaded by the consent block below, only after the visitor agrees.
  document.addEventListener('click',function(e){
    var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href')||'';
    if(/wa\.me|api\.whatsapp\.com/.test(h))push('whatsapp_click',{link_url:h});
    else if(/^tel:/.test(h))push('phone_click',{link_url:h});
    else if(/waze\.com|google\.com\/maps|maps\.app\.goo\.gl/.test(h))push('directions_click',{link_url:h});
  },true);
  var item=document.body&&document.body.getAttribute('data-item');
  if(item)push('view_item',{item_name:item,item_category:'ziso'});
  // Lead from the embedded intake form (Apps Script iframe) or the thank-you page.
  window.addEventListener('message',function(e){if(e.data&&e.data.type==='ziso_lead')push('generate_lead',{lead_id:e.data.id||'',existing:!!e.data.existing,method:'form'})});
  if(document.body&&document.body.getAttribute('data-lead'))push('generate_lead',{method:new URLSearchParams(location.search).get('src')||'toda'});
  // Intake iframe: forward utm_* from this page's URL (the iframe cannot read it).
  var f=document.getElementById('intake');
  if(f){var src=f.getAttribute('data-src')||'';var q=new URLSearchParams(location.search),keep=[];
    q.forEach(function(v,k){if(/^utm_/.test(k))keep.push(encodeURIComponent(k)+'='+encodeURIComponent(v))});
    if(src){f.src=src+(src.indexOf('?')>-1?'&':'?')+keep.join('&')}else{f.hidden=true;var n=document.getElementById('intake-missing');if(n)n.hidden=false}}
})();

// ===== motion layer =====
(function(){
  var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  // compact header on scroll
  var top=document.querySelector('.top');
  function onS(){if(top)top.classList.toggle('scrolled',scrollY>40)}
  addEventListener('scroll',onS,{passive:true});onS();
  // split hero headline into words
  var h1=document.querySelector('.hero h1');
  if(h1&&!reduce){var i=0;h1.innerHTML=h1.innerHTML.split(/(<br\s*\/?>)/).map(function(part){
    if(/^<br/.test(part))return part;
    return part.replace(/(<em>[^<]*<\/em>|[^\s<>]+)/g,function(w){return '<span class="w"><span style="--i:'+(i++)+'">'+w+'</span></span>'})}).join('')}
  // reveal on scroll
  var io='IntersectionObserver' in window?new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{rootMargin:'0px 0px -10% 0px'}):null;
  document.querySelectorAll('[data-reveal],.tiles,.steps,.family').forEach(function(el){if(io&&!reduce)io.observe(el);else el.classList.add('in')});
  document.querySelectorAll('.tiles .tile,.steps li').forEach(function(el,i){el.style.setProperty('--i',i%8)});
  // category slab tilt
  var slab=document.querySelector('.hero.inner .sw');
  if(slab&&!reduce&&matchMedia('(hover:hover)').matches){
    slab.addEventListener('mousemove',function(e){var r=slab.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
      slab.style.transform='perspective(900px) rotateY('+((x-.5)*-10)+'deg) rotateX('+((y-.5)*8)+'deg)';slab.style.setProperty('--mx',x*100+'%');slab.style.setProperty('--my',y*100+'%')});
    slab.addEventListener('mouseleave',function(){slab.style.transform=''})}
  // live tile wall
  var c=document.querySelector('canvas.tilewall');if(!c)return;
  var x=c.getContext('2d'),d=Math.min(devicePixelRatio||1,2),W,H,tiles=[],t0=performance.now(),mx=.7,my=.35,raf,TW=150,TH=75,gap=3;
  function rng(s){return function(){s=(s*16807)%2147483647;return (s-1)/2147483646}}
  function slabImg(seed,w,h){var o=document.createElement('canvas');o.width=w;o.height=h;var g=o.getContext('2d'),r=rng(seed);
    var lg=g.createLinearGradient(0,0,w,h);var k=r();lg.addColorStop(0,k<.5?'#f0ede7':'#e6e2da');lg.addColorStop(1,k<.5?'#dcd6cb':'#cfc9be');g.fillStyle=lg;g.fillRect(0,0,w,h);
    for(var v=0;v<3;v++){var px=r()*w,py=-4,a=Math.PI/2+(r()-.5)*1.4;g.beginPath();g.moveTo(px,py);
      for(var s=0;s<60;s++){a+=(r()-.5)*.5;px+=Math.cos(a)*4;py+=Math.sin(a)*4;g.lineTo(px,py);if(py>h+4)break}
      g.strokeStyle=v?'rgba(140,128,110,.22)':'rgba(120,104,82,.4)';g.lineWidth=v?.6:1.2;g.stroke()}
    return o}
  function build(){W=c.clientWidth;H=c.clientHeight;c.width=W*d;c.height=H*d;x.setTransform(d,0,0,d,0,0);tiles=[];
    var cols=Math.ceil(W/(TW+gap))+1,rows=Math.ceil(H/(TH+gap))+1,n=0;
    for(var r=0;r<rows;r++)for(var q=0;q<cols;q++){var ox=(r%2)?-(TW+gap)/2:0,px=q*(TW+gap)+ox,py=r*(TH+gap);
      tiles.push({x:px,y:py,img:slabImg(97+n*13,TW,TH),delay:reduce?0:(px/W*.9+py/H*.5)*900+Math.random()*250});n++}
    t0=performance.now();loop()}
  function ease(t){return 1-Math.pow(1-t,3)}
  function draw(now){x.fillStyle='#1c1f22';x.fillRect(0,0,W,H);var busy=false;
    for(var i=0;i<tiles.length;i++){var t=tiles[i],p=Math.min(1,Math.max(0,(now-t0-t.delay)/700));if(p<1)busy=true;if(p<=0)continue;var e=ease(p);
      x.globalAlpha=e;var s=.92+.08*e;x.drawImage(t.img,t.x+TW*(1-s)/2,t.y+TH*(1-s)/2,TW*s,TH*s)}
    x.globalAlpha=1;
    // light that follows the cursor, soft
    var g=x.createRadialGradient(mx*W,my*H,0,mx*W,my*H,Math.max(W,H)*.6);g.addColorStop(0,'rgba(255,245,225,.22)');g.addColorStop(.5,'rgba(255,245,225,.05)');g.addColorStop(1,'rgba(0,0,0,.35)');
    x.fillStyle=g;x.fillRect(0,0,W,H);return busy}
  var tx=.7,ty=.35;
  function loop(){var now=performance.now();mx+=(tx-mx)*.06;my+=(ty-my)*.06;var busy=draw(now);
    if(busy||Math.abs(tx-mx)>.002||Math.abs(ty-my)>.002)raf=requestAnimationFrame(loop);else raf=null}
  function kick(){if(!raf)raf=requestAnimationFrame(loop)}
  if(!reduce){addEventListener('mousemove',function(e){var r=c.getBoundingClientRect();if(e.clientY>r.bottom)return;tx=(e.clientX-r.left)/r.width;ty=(e.clientY-r.top)/r.height;kick()},{passive:true});
    addEventListener('scroll',function(){var r=c.getBoundingClientRect();if(r.bottom<0)return;ty=.35+(-r.top/r.height)*.6;kick()},{passive:true})}
  var rt;addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(build,200)});build();
})();

// ===== films: clips play only while on screen, never under reduced motion; click opens the lightbox =====
(function(){
  var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hero=document.querySelector('video[data-hero]');
  if(hero){if(reduce){hero.removeAttribute('autoplay');hero.pause();hero.classList.add('off')}
    else{hero.addEventListener('canplay',function(){hero.classList.add('ready')},{once:true});var p=hero.play&&hero.play();if(p&&p.catch)p.catch(function(){})}}
  var vids=document.querySelectorAll('video[data-auto]');
  if(vids.length&&!reduce&&'IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){var v=e.target;
      if(e.isIntersecting){if(v.preload==='none')v.preload='auto';var p=v.play();if(p&&p.catch)p.catch(function(){})}else v.pause()})},{rootMargin:'120px 0px',threshold:.15});
    vids.forEach(function(v){io.observe(v)});
  }
  var dlg=document.getElementById('light');if(!dlg||!dlg.showModal)return;
  var body=dlg.querySelector('.lightbody');
  function open(src){body.innerHTML='';var el;
    if(/\.mp4$/i.test(src)){el=document.createElement('video');el.src=src;el.controls=true;el.autoplay=true;el.loop=true;el.muted=true;el.playsInline=true}
    else{el=document.createElement('img');el.src=src;el.alt=''}
    body.appendChild(el);dlg.showModal();window.dataLayer&&window.dataLayer.push({event:'view_media',media_url:src})}
  function close(){dlg.close();body.innerHTML=''}
  document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-light]');if(b){e.preventDefault();open(b.getAttribute('data-light'))}});
  dlg.querySelector('.x').addEventListener('click',close);
  dlg.addEventListener('click',function(e){if(e.target===dlg)close()});
  dlg.addEventListener('close',function(){body.innerHTML=''});
  // drag-to-scroll on the reel for mouse users
  var reel=document.querySelector('.reel');
  if(reel&&matchMedia('(hover:hover)').matches){var down=false,sx=0,sl=0,moved=false;
    reel.addEventListener('pointerdown',function(e){down=true;moved=false;sx=e.clientX;sl=reel.scrollLeft});
    reel.addEventListener('pointermove',function(e){if(!down)return;var dx=e.clientX-sx;if(Math.abs(dx)>4)moved=true;reel.scrollLeft=sl-dx});
    ['pointerup','pointerleave'].forEach(function(t){reel.addEventListener(t,function(){down=false})});
    reel.addEventListener('click',function(e){if(moved){e.stopPropagation();e.preventDefault()}},true)}
})();

// ===== accessibility menu, motion stop, consent-gated measurement =====
(function(){
  var root=document.documentElement,KEY='ziso_a11y';
  var st={};try{st=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
  function save(){try{localStorage.setItem(KEY,JSON.stringify(st))}catch(e){}}
  var hero=document.querySelector('video[data-hero]'),clips=document.querySelectorAll('video[data-auto]');
  function setMotion(on){root.classList.toggle('a11y-motion',!!on);
    [hero].concat([].slice.call(clips)).forEach(function(v){if(!v)return;if(on){v.pause();v.dataset.stopped='1'}else{delete v.dataset.stopped;if(v===hero){var p=v.play();if(p&&p.catch)p.catch(function(){})}}});
    var pb=document.querySelector('[data-pause]');if(pb)pb.setAttribute('aria-pressed',on?'true':'false')}
  function apply(){
    root.style.fontSize=st.font?(100+st.font*12.5)+'%':'';
    root.classList.toggle('a11y-contrast',!!st.contrast);root.classList.toggle('a11y-links',!!st.links);root.classList.toggle('a11y-readable',!!st.readable);
    setMotion(!!st.motion);
    document.querySelectorAll('[data-a11y]').forEach(function(b){var k=b.getAttribute('data-a11y');if(b.hasAttribute('aria-pressed'))b.setAttribute('aria-pressed',st[k]?'true':'false')})}
  apply();
  // in-view autoplay must respect a stopped state
  clips.forEach(function(v){v.addEventListener('play',function(){if(v.dataset.stopped)v.pause()})});
  var btn=document.querySelector('.a11y-btn'),panel=document.getElementById('a11y');
  if(btn&&panel){
    function toggle(open){panel.hidden=!open;btn.setAttribute('aria-expanded',open?'true':'false');if(open)panel.querySelector('button[data-a11y]').focus();else btn.focus()}
    btn.addEventListener('click',function(){toggle(panel.hidden)});
    panel.querySelector('.x').addEventListener('click',function(){toggle(false)});
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!panel.hidden)toggle(false)});
    panel.addEventListener('click',function(e){var b=e.target.closest('[data-a11y]');if(!b)return;var k=b.getAttribute('data-a11y');
      if(k==='font-up')st.font=Math.min(4,(st.font||0)+1);else if(k==='font-down')st.font=Math.max(-1,(st.font||0)-1);
      else if(k==='reset')st={};else st[k]=!st[k];save();apply()})}
  var pb=document.querySelector('[data-pause]');
  if(pb&&hero){pb.hidden=false;pb.addEventListener('click',function(){st.motion=!st.motion;save();apply()})}
  // consent: measurement tools load only after an explicit yes
  var CK='ziso_consent',box=document.getElementById('cookie'),gtm=window.ZISO_GTM_ID||'';
  function consent(){try{return localStorage.getItem(CK)}catch(e){return null}}
  function loadGtm(){if(!gtm||window.__gtm)return;window.__gtm=1;window.dataLayer=window.dataLayer||[];window.dataLayer.push({'gtm.start':Date.now(),event:'gtm.js'});
    var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtm.js?id='+gtm;document.head.appendChild(s)}
  if(box){
    if(gtm&&!consent())box.hidden=false;
    if(consent()==='yes')loadGtm();
    box.addEventListener('click',function(e){var b=e.target.closest('[data-consent]');if(!b)return;var v=b.getAttribute('data-consent');try{localStorage.setItem(CK,v)}catch(err){}box.hidden=true;if(v==='yes')loadGtm()});
    document.querySelectorAll('[data-cookie-settings]').forEach(function(b){b.addEventListener('click',function(){try{localStorage.removeItem(CK)}catch(e){}box.hidden=false;box.querySelector('button').focus()})});
  }
})();
