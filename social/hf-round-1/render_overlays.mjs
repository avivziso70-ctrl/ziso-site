// Renders transparent 1080x1920 PNG overlays (hook, captions, CTA, end card, brand) for one reel spec.
// usage: node render_overlays.mjs SPEC.json OUT_DIR
import fs from 'fs'; import path from 'path';
import {chromium} from '/opt/node-tools/node_modules/playwright/index.mjs';
const spec=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); const out=path.resolve(process.argv[3]); fs.mkdirSync(out,{recursive:true});
const F=path.resolve(path.dirname(new URL(import.meta.url).pathname),'fonts');
const css=`
@font-face{font-family:FR;font-weight:700;src:url(file://${F}/FrankRuhlLibre-700.ttf)}
@font-face{font-family:HB;font-weight:400;src:url(file://${F}/Heebo-400.ttf)}
@font-face{font-family:HB;font-weight:500;src:url(file://${F}/Heebo-500.ttf)}
@font-face{font-family:HB;font-weight:700;src:url(file://${F}/Heebo-700.ttf)}
:root{--ink:#15120f;--bone:#f4efe8;--brass:#c3a06a;--brass-l:#dcc096;--wa:#25d366;--wa-ink:#06210f}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:1920px;overflow:hidden;background:transparent}
#s{position:relative;width:1080px;height:1920px;direction:rtl;font-family:HB,sans-serif;-webkit-font-smoothing:antialiased}
.abs{position:absolute}
.brand{right:70px;top:190px;font:500 30px/1 HB;letter-spacing:.08em;color:var(--brass-l);text-shadow:0 2px 12px rgba(0,0,0,.6)}
.brand i{display:inline-block;width:44px;height:2px;background:var(--brass);vertical-align:middle;margin-left:16px}
.scrim{left:0;right:0;bottom:0;height:900px;background:linear-gradient(0deg,rgba(15,12,10,.86) 0%,rgba(15,12,10,.62) 40%,rgba(15,12,10,.2) 72%,rgba(15,12,10,0) 100%)}
.scrimtop{left:0;right:0;top:0;height:760px;background:linear-gradient(180deg,rgba(15,12,10,.72) 0%,rgba(15,12,10,.35) 55%,rgba(15,12,10,0) 100%)}
.hook{right:70px;left:70px;top:300px;text-align:right;font-family:FR,serif;font-weight:700;color:var(--bone);font-size:132px;line-height:1.06;letter-spacing:-.01em;text-shadow:0 4px 30px rgba(0,0,0,.55)}
.hook .b{color:var(--brass-l)}
.cap{right:70px;left:70px;top:1270px;text-align:center;font:700 66px/1.25 HB;color:var(--bone);text-shadow:0 3px 18px rgba(0,0,0,.7)}
.cap .k{color:var(--brass-l)}
.pill{left:70px;right:70px;top:1380px;height:140px;border-radius:70px;background:var(--wa);color:var(--wa-ink);font:700 58px/140px HB;text-align:center;box-shadow:0 14px 40px rgba(0,0,0,.45)}
.sub{left:70px;right:70px;top:1545px;text-align:center;font:500 40px/1.2 HB;color:var(--bone);opacity:.92}
.endbg{inset:0;background:var(--ink)}
.e1{left:70px;right:70px;top:700px;text-align:center;font:500 44px/1 HB;letter-spacing:.1em;color:var(--brass-l)}
.e2{left:70px;right:70px;top:790px;text-align:center;font-family:FR,serif;font-weight:700;font-size:118px;line-height:1.1;color:var(--bone)}
.e3{left:70px;right:70px;top:1120px;text-align:center;font:700 72px/1.2 HB;color:var(--brass)}
.e4{left:70px;right:70px;top:1240px;text-align:center;font:400 44px/1.3 HB;color:var(--bone);opacity:.8;direction:ltr}
.hair{left:70px;right:70px;top:1060px;height:2px;background:var(--brass);opacity:.7}
`;
const page=(body)=>`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="s">${body}</div></body></html>`;
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
const mark=s=>esc(s).replace(/\*(.+?)\*/g,'<span class="k">$1</span>');
const shots={
  base:`<div class="abs scrim"></div><div class="abs scrimtop"></div><div class="abs brand"><i></i>זיסו קרמיקה</div>`,
  hook:`<div class="abs hook">${spec.hook.map((l,i)=>`<div class="${i?'b':''}">${esc(l)}</div>`).join('')}</div>`,
  cta:`<div class="abs pill">${esc(spec.cta||'פגישת תכנון חינם · וואטסאפ 050-4770040')}</div><div class="abs sub">${esc(spec.sub||'עם המעצבות המוסמכות של זיסו · טירת כרמל · מאז 1985')}</div>`,
  end:`<div class="abs endbg"></div><div class="abs e1">פרק הבא</div><div class="abs e2">${esc(spec.next)}</div><div class="abs hair"></div><div class="abs e3">עקבו ${esc(spec.handle||'@ziso_ceramics')}</div><div class="abs e4">${esc(spec.handleSub||'Instagram · TikTok · Facebook')}</div>`
};
spec.caps.forEach((c,i)=>{shots['cap'+i]=`<div class="abs cap">${mark(c.text)}</div>`});
const br=await chromium.launch({args:['--no-sandbox']});
const pg=await br.newPage({viewport:{width:1080,height:1920},deviceScaleFactor:1});
for(const [k,b] of Object.entries(shots)){
  await pg.setContent(page(b),{waitUntil:'load'}); await pg.evaluate(()=>document.fonts.ready);
  await pg.screenshot({path:path.join(out,k+'.png'),omitBackground:true,type:'png'});
}
await br.close(); console.log('overlays',Object.keys(shots).length);
