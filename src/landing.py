# Marketing landing page (showroom.html): the one loud page on the site, for ad traffic.
# Built on the scroll-craft engine (scrollcraft.js). Real photos and clips only.
# Rules: every word readable without JS and under reduced motion (cues are hidden
# only once html.sc-js is set), no prices, no Saturday phone promise, WhatsApp is the CTA.
import html

JOURNEY = [  # (photo in img/gallery, label, line)
  ("2026-04-20-travertine-copper.jpg", "הרצפה והקיר", "גרניט פורצלן וחיפויים בגודל מלא על קירות האולם, כדי לראות איך זה נראה באמת."),
  ("2026-05-28-shower-graphite.jpg", "המקלחון", "מקלחונים לפי מידה, עם זכוכית ופרזול שמתאימים לחדר שלכם."),
  ("2026-09-01-blue-vanity-neve-yam.jpg", "הארון", "ארונות אמבטיה, כולל ייצור אישי בגוון ובמידה שבחרתם."),
  ("2026-05-28-black-tub.jpg", "הברז", "ברזים וכלים סניטריים בגימורים שמשלימים את כל החדר."),
  ("2026-07-15-parquet-fishbone.jpg", "ומשם לכל הבית", "פרקט, בריקים ואריחים לסלון, למטבח ולגינה."),
]

def landing_body(wa, phone, phone_intl, hours, addr_q, gallery):
  n = len(JOURNEY)
  layers, captions, ticks = [], [], []
  for i, (ph, label, line) in enumerate(JOURNEY):
    a, b = i / n, (i + 1) / n
    # first layer is present from the start, the last one stays to the end
    win = ("%.3f %.3f 0 0.25" % (a, b + .06)) if i == 0 else ("%.3f %.3f 0.25 0.25" % (a - .06, b + .06)) if i < n - 1 else ("%.3f 1.2 0.25 0" % (a - .06))
    layers.append('<figure class="lp-layer" data-sc-cue="%s" data-sc-rise="0"><img src="img/gallery/%s" alt="" loading="%s" width="1200" height="900"></figure>' % (win, ph, "eager" if i == 0 else "lazy"))
    cwin = ("%.3f %.3f 0.3 0.3" % (a, b))
    captions.append('<div class="lp-cap" data-sc-cue="%s"><span class="lp-n" aria-hidden="true">0%d</span><h3>%s</h3><p>%s</p></div>' % (cwin if i else "0 %.3f 0 0.3" % b, i + 1, label, line))
    ticks.append('<li>%s</li>' % label)
  rail = "".join('<figure class="lp-card"><img src="img/gallery/%s" alt="%s" loading="lazy" width="1200" height="900"><figcaption>%s</figcaption></figure>' % (f, html.escape(c), html.escape(c)) for f, c in gallery[:8])
  return '''<script>document.documentElement.classList.add('sc-js')</script><link rel="stylesheet" href="lp.css">
<main id="main" class="lp">
<section class="lp-hero" data-sc-act="scrub" data-sc-span="1.4" data-sc-dwell="0.3" aria-label="פתיח">
<div class="sc-stage">
<img class="sc-stage__poster" src="img/video/hero.jpg" alt="" width="720" height="1280">
<video data-sc-scrub muted playsinline preload="none" poster="img/video/hero.jpg" aria-hidden="true"><source src="img/video/hero.mp4" type="video/mp4"></video>
<div class="lp-scrim" aria-hidden="true"></div>
<div class="lp-hero-copy">
<h1 data-sc-cue="0 0.62 0 0.4" >חדר רחצה שנבחר<br>עם מעצבת פנים,<br><em>לא עם איש מכירות</em></h1>
<p data-sc-cue="0 0.6 0 0.4">אולם תצוגה לריצוף ואמבטיה בטירת כרמל, מאז 1985. פגישת ייעוץ ועיצוב באולם עם אילת או שיר, מעצבות פנים מוסמכות, בחינם.</p>
<div class="lp-actions" data-sc-cue="0 0.6 0 0.4"><a class="btn brass" href="{wa}" target="_blank" rel="noopener">לקביעת פגישת ייעוץ בוואטסאפ</a><a class="btn ghost" href="#lp-journey">מה יש באולם</a></div>
</div>
<div class="lp-hint" aria-hidden="true" data-sc-cue="0 0.25 0 0.5">גללו</div>
</div>
</section>

<section id="lp-journey" class="lp-journey" data-sc-act="pin" data-sc-span="4.2" aria-label="מהרצפה ועד הברז">
<div class="sc-stage">
<div class="lp-layers">{layers}</div>
<div class="lp-scrim side" aria-hidden="true"></div>
<div class="lp-journey-copy">
<h2>מהרצפה ועד הברז,<br>תחת קורת גג אחת</h2>
<div class="lp-caps">{captions}</div>
<ol class="lp-ticks" aria-hidden="true">{ticks}</ol>
</div>
<div class="lp-bar" aria-hidden="true"><span></span></div>
</div>
</section>

<section class="lp-designers" data-sc-act="flow" data-sc-drift="#1b1e21">
<div class="wrap lp-two">
<div class="lp-quote">
<h2 data-sc-in>מי שעוזרת לכם לבחור<br>היא <em>מעצבת פנים מוסמכת</em></h2>
<p data-sc-in>אילת ושיר עובדות איתכם מהתוכנית ועד ההצעה: מתאימות אריחים, כלים וברזים לסגנון ולתקציב, ומחשבות כמויות. אתם מקבלים הצעת מחיר אחת לכל הפרויקט תוך 24 שעות.</p>
<a class="btn brass" data-sc-in href="{wa}" target="_blank" rel="noopener">לקבוע פגישה עם מעצבת</a>
</div>
<div class="lp-portraits">
<figure data-sc-parallax="-30"><img src="img/family-2.jpg" alt="אילת זיסו" loading="lazy" width="312" height="369"><figcaption>אילת זיסו<small>מעצבת פנים</small></figcaption></figure>
<figure data-sc-parallax="30"><img src="img/family-3.jpg" alt="שיר זיסו" loading="lazy" width="720" height="720"><figcaption>שיר זיסו<small>מעצבת פנים</small></figcaption></figure>
</div>
</div>
</section>

<section class="lp-works" data-sc-act="pan" data-sc-span="2.6" aria-label="עבודות אחרונות">
<div class="sc-stage">
<div class="wrap lp-works-head"><h2>בתים שעיצבנו יחד</h2><a class="btn ghost" href="gallery.html">לכל העבודות</a></div>
<div class="lp-rail" data-sc-pan="0.2">{rail}</div>
</div>
</section>

<section class="lp-facts" data-sc-act="flow">
<div class="wrap">
<dl class="lp-nums">
<div><dt>שנים באולם</dt><dd><span data-sc-count="0 40">40</span>+</dd></div>
<div><dt>דירוג בגוגל</dt><dd><span data-sc-count="0 4.3">4.3</span></dd></div>
<div><dt>ביקורות בגוגל</dt><dd><span data-sc-count="0 85">85</span></dd></div>
<div><dt>שעות להצעת מחיר</dt><dd><span data-sc-count="0 24">24</span></dd></div>
</dl>
<ol class="lp-steps" data-sc-stagger="90">
<li><h3>שולחים הודעה</h3><p>קובעים בוואטסאפ מועד לפגישה באולם. אפשר להגיע עם האדריכל או הקבלן.</p></li>
<li><h3>פגישת עיצוב חינם</h3><p>בוחרים עם מעצבת פנים מוסמכת, מול האריחים והכלים עצמם.</p></li>
<li><h3>הצעה אחת מסודרת</h3><p>כל הפרויקט בהצעה אחת, עם מועדי אספקה לכל פריט.</p></li>
</ol>
</div>
</section>

<section class="lp-final" data-sc-act="flow" data-sc-drift="#0f1113">
<div class="wrap">
<h2 data-sc-kinetic="lines" data-sc-cue="0.1 1.2 0.4 0">בואו לראות ולגעת</h2>
<p>עוצמה 5, טירת כרמל. דקות מחיפה, נשר והקריות.</p>
<div class="lp-actions"><a class="btn brass big" href="{wa}" target="_blank" rel="noopener">לקביעת פגישת ייעוץ בוואטסאפ</a><a class="btn ghost" href="https://waze.com/ul?q={addr}&navigate=yes" target="_blank" rel="noopener">ניווט בוויז</a></div>
<dl class="lp-contact">
<div><dt>וואטסאפ וטלפון</dt><dd><a class="ltr" href="tel:{phone_intl}">{phone}</a></dd></div>
<div><dt>שעות פתיחה</dt><dd>{hours}</dd></div>
</dl>
</div>
</section>
</main>
<script src="scrollcraft.js" defer></script><script src="scroll.js" defer></script>
'''.format(wa=wa, phone=phone, phone_intl=phone_intl, hours=hours, addr=addr_q, layers="".join(layers), captions="".join(captions), ticks="".join(ticks), rail=rail)
