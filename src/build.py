#!/usr/bin/env python3
"""Builds the static Ziso site into ../dist (plus preview.html for the Claude artifact)."""
import json, os, re, shutil, html, datetime
from content import *

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "..", "dist")
TODAY = datetime.date.today().isoformat()
import urllib.parse
WA_VISIT = "https://wa.me/%s?text=%s" % (WA, urllib.parse.quote("שלום, אשמח לקבוע פגישת ייעוץ ועיצוב באולם"))
ADDR_Q = "%D7%A2%D7%95%D7%A6%D7%9E%D7%94%205%20%D7%98%D7%99%D7%A8%D7%AA%20%D7%9B%D7%A8%D7%9E%D7%9C"
HOURS_HTML = 'א׳–ה׳ 08:00–18:00<br>ו׳ 08:00–13:30<br>שבת סגור'

SIZE_RE = re.compile(r"(\d+(?:\.\d+)?×\d+)")
def ltr_sizes(s): return SIZE_RE.sub(r'<span class="ltr">\1</span>', s)

def strip_tags(s): return re.sub(r"<[^>]+>", "", s)

BUSINESS = {
  "@context": "https://schema.org", "@type": "HomeAndConstructionBusiness", "@id": SITE + "#business",
  "name": "זיסו קרמיקה", "legalName": LEGAL, "alternateName": ["Ziso Ceramics", "ZISO CERAMICS LTD"], "taxID": COMPANY_ID,
  "slogan": "תרגיש בבית לעצב את הבית", "url": SITE, "foundingDate": "1985",
  "openingHoursSpecification": [{"@type": "OpeningHoursSpecification", "dayOfWeek": ["Sunday","Monday","Tuesday","Wednesday","Thursday"], "opens": "08:00", "closes": "18:00"}, {"@type": "OpeningHoursSpecification", "dayOfWeek": "Friday", "opens": "08:00", "closes": "13:30"}], "telephone": "+972-50-477-0040", "email": EMAIL,
  "address": {"@type": "PostalAddress", "streetAddress": "עוצמה 5", "addressLocality": "טירת כרמל", "postalCode": "3903005", "addressRegion": "חיפה", "addressCountry": "IL"},
  "areaServed": [{"@type": "City", "name": a} for a in AREAS],
  "sameAs": ["https://www.instagram.com/ziso_ceramics/", "https://www.facebook.com/zisoceramics"],
  "makesOffer": {"@type": "Offer", "price": "0", "priceCurrency": "ILS", "itemOffered": {"@type": "Service", "name": "פגישת ייעוץ ועיצוב פנים באולם", "description": "פגישה חינם עם מעצבת פנים מוסמכת לבחירת ריצוף, חיפוי ואמבטיה"}},
  "employee": [{"@type": "Person", "name": "אילת זיסו", "jobTitle": "מעצבת פנים"}, {"@type": "Person", "name": "שיר זיסו", "jobTitle": "מעצבת פנים"}],
  "hasOfferCatalog": {"@type": "OfferCatalog", "name": "מוצרים באולם",
    "itemListElement": [{"@type": "OfferCatalog", "name": c["name"], "url": SITE + c["slug"] + ".html"} for c in CATS]},
}

def faq_schema(items):
  return {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
    {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": strip_tags(a)}} for q, a in items]}

GALLERY_DIR = os.path.join(HERE, "img", "gallery")
CAT_PHOTOS = {"porcelain": "2026-04-20-travertine-copper.jpg", "sanitary": "2026-06-24-picket-tiles.jpg", "vanities": "2026-09-01-blue-vanity-neve-yam.jpg",
              "showers": "2026-05-28-shower-graphite.jpg", "faucets": "2026-05-28-black-tub.jpg", "bricks": "2026-06-24-blue-tub.jpg", "parquet": "2026-07-15-parquet-fishbone.jpg"}
def gallery_items():
  """Photos dropped in src/img/gallery/ (jpg/jpeg/png/webp), newest name first; captions from src/gallery.txt as 'file|caption'."""
  caps = {}
  cp = os.path.join(HERE, "gallery.txt")
  if os.path.exists(cp):
    for line in open(cp, encoding="utf-8"):
      if "|" in line: f, c = line.split("|", 1); caps[f.strip()] = c.strip()
  files = sorted([f for f in os.listdir(GALLERY_DIR) if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))], reverse=True) if os.path.isdir(GALLERY_DIR) else []
  return [(f, caps.get(f, "")) for f in files]
GALLERY = gallery_items()

# Short films generated from the real project photos (fetched/compressed by .github/workflows/fetch-video.yml into src/img/video/).
VIDEO_DIR = os.path.join(HERE, "img", "video")
VIDEOS = [  # name (src/img/video/<name>.mp4 + .jpg poster), caption
  ("showroom-shir", "באולם התצוגה בטירת כרמל: בוחרים חומרים עם שיר"),
  ("travertine-copper", "חדר רחצה בחיפוי טרוורטין עם כיורי נחושת"),
  ("parquet-fishbone", "פרקט פישבון מול הים, מושב הבונים"),
  ("blue-vanity", "ארון אמבטיה כחול בייצור אישי, נוה ים"),
  ("blue-tub", "אמבטיה עם אריחי מטרו בתכלת"),
  ("black-tub", "ברזים שחורים וריצוף מעוטר"),
  ("garden-path", "אריחים דקורטיביים בשביל הגינה"),
]
def has_video(name): return os.path.exists(os.path.join(VIDEO_DIR, name + ".mp4"))
VIDEOS = [v for v in VIDEOS if has_video(v[0])]
HERO_CLIP = "img/video/hero.mp4" if has_video("hero") else HERO_VIDEO
CAT_VIDEOS = {"porcelain": "travertine-copper", "vanities": "blue-vanity", "faucets": "black-tub", "bricks": "blue-tub", "parquet": "parquet-fishbone"}
def video_tag(name, cls="", label="", preload="none"):
  """Muted looping clip with a poster; site.js plays it only while on screen (and never under reduced motion)."""
  return '<video class="%s" muted loop playsinline preload="%s" poster="img/video/%s.jpg" data-auto aria-label="%s"><source src="img/video/%s.mp4" type="video/mp4"></video>' % (cls, preload, name, html.escape(label), name)
def reel_html():
  if not VIDEOS: return ""
  cards = "".join('<figure class="vcard" data-reveal style="--d:%.2fs"><button class="vopen" type="button" data-light="img/video/%s.mp4" aria-label="%s, הגדלה">%s</button><figcaption aria-hidden="true">%s</figcaption></figure>' % (i*.08, n, html.escape(c), video_tag(n, "clip", c), html.escape(c)) for i, (n, c) in enumerate(VIDEOS))
  return ('<section id="films" class="dark"><div class="wrap">'
    '<div class="head" data-reveal><div><p class="eyebrow">מהפרויקטים שלנו</p><h2>סרטים קצרים מבתים שעיצבנו יחד</h2>'
    '<p class="lede">כל סרט נולד מתמונה אמיתית של עבודה שלנו: האולם בטירת כרמל, חדרי רחצה, פרקטים וגינות של לקוחות.</p></div><a class="btn ghost" href="gallery.html">לכל העבודות</a></div>'
    '</div><div class="reel" tabindex="0" aria-label="סרטים קצרים, גלילה לצדדים">%s</div></section>') % cards
def gallery_html(items, lazy=True, videos=()):
  vids = "".join('<figure class="isvideo"><button class="vopen" type="button" data-light="img/video/%s.mp4" aria-label="סרט: %s, הגדלה">%s<span class="badge" aria-hidden="true">סרט</span></button><figcaption>%s</figcaption></figure>' % (n, html.escape(c), video_tag(n, "", c), html.escape(c)) for n, c in videos)
  return '<div class="gallery">' + vids + "".join('<figure><button class="vopen" type="button" data-light="img/gallery/%s" aria-label="%s, הגדלה"><img src="img/gallery/%s" alt="%s"%s></button>%s</figure>' % (
    f, html.escape(c or "עבודה של זיסו קרמיקה"), f, html.escape(c or "עבודה של זיסו קרמיקה"), ' loading="lazy"' if lazy else "", ('<figcaption>%s</figcaption>' % html.escape(c)) if c else "") for f, c in items) + '</div>'

def crumbs_schema(name, slug):
  return {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
    {"@type": "ListItem", "position": 1, "name": "זיסו קרמיקה", "item": SITE},
    {"@type": "ListItem", "position": 2, "name": name, "item": SITE + slug + ".html"}]}

def header(active=""):
  links = [("./#products", "מוצרים", "products"), ("calculator.html", "מחשבון כמויות", "calculator"), ("tik-lakoach.html", "תיק לקוח", "tik"),
           ("about.html", "עלינו", "about"), ("contact.html", "צור קשר", "contact"), ("./#client", "אזור לקוחות", "")]
  if GALLERY: links.insert(1, ("gallery.html", "עבודות", "gallery"))
  nav = "".join('<a href="%s"%s>%s</a>' % (h, ' aria-current="page"' if k and k == active else "", t) for h, t, k in links)
  return '''<a class="skip" href="#main">דילוג לתוכן הראשי</a>
<header class="top"><div class="wrap">
<a class="mark" href="./" title="לדף הבית"><b>ZISO</b><span>קרמיקה</span></a>
<nav class="nav" aria-label="ניווט ראשי">%s<a class="cta" href="./#visit">ביקור באולם</a></nav>
</div></header>''' % nav

FOOTER = '''<footer><div class="wrap">
<div class="legal"><strong style="color:var(--wall-ink)">זיסו קרמיקה</strong>
<span>%s · <span class="ltr">ZISO CERAMICS LTD</span> · ח.פ. <span class="ltr">%s</span> · עוצמה 5, טירת כרמל</span>
<span><span class="ltr">%s</span> · <span class="ltr">%s</span></span></div>
<nav class="social" aria-label="מוצרים ורשתות">%s<a href="https://www.instagram.com/ziso_ceramics/" target="_blank" rel="noopener">Instagram</a><a href="https://www.facebook.com/zisoceramics" target="_blank" rel="noopener">Facebook</a></nav>
<nav class="legal-links" aria-label="מידע משפטי"><a href="accessibility.html">הצהרת נגישות</a><a href="privacy.html">מדיניות פרטיות ועוגיות</a><a href="terms.html">תנאי שימוש</a><button type="button" class="linkbtn" data-cookie-settings>הגדרות עוגיות</button></nav>
</div></footer>
<aside class="floating" aria-label="כלים צפים">
<button class="a11y-btn" type="button" aria-expanded="false" aria-controls="a11y" aria-label="תפריט נגישות"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="currentColor"><circle cx="12" cy="4" r="2"/><path d="M19 8.5c-2.3.5-4.6.8-7 .8s-4.7-.3-7-.8l-.4 1.9c1.7.4 3.4.6 5.1.7v2.2L7.4 21l1.8.6L12 15.8l2.8 5.8 1.8-.6-2.3-7.7v-2.2c1.7-.1 3.4-.3 5.1-.7L19 8.5z"/></svg></button>
<div class="a11y" id="a11y" hidden role="dialog" aria-label="הגדרות נגישות">
<div class="a11y-head"><strong>נגישות</strong><button class="x" type="button" aria-label="סגירת תפריט נגישות">×</button></div>
<div class="a11y-grid">
<button type="button" data-a11y="font-up">הגדלת טקסט</button><button type="button" data-a11y="font-down">הקטנת טקסט</button>
<button type="button" data-a11y="contrast" aria-pressed="false">ניגודיות גבוהה</button><button type="button" data-a11y="links" aria-pressed="false">הדגשת קישורים</button>
<button type="button" data-a11y="readable" aria-pressed="false">גופן קריא</button><button type="button" data-a11y="motion" aria-pressed="false">עצירת תנועה</button>
<button type="button" data-a11y="reset" class="wide">איפוס</button>
</div>
<a href="accessibility.html">הצהרת הנגישות של האתר</a></div>
</aside>
<div class="cookie" id="cookie" hidden role="region" aria-label="הודעת עוגיות"><p>האתר משתמש בעוגיות של מדידה כדי להבין איך משתמשים בו ולשפר אותו. אפשר להסכים או לדחות; האתר עובד גם בלי. <a href="privacy.html">למדיניות הפרטיות</a></p><div class="actions"><button class="btn brass" type="button" data-consent="yes">מסכים/ה</button><button class="btn line" type="button" data-consent="no">לא תודה</button></div></div>
<a class="wa" href="https://wa.me/%s" target="_blank" rel="noopener" aria-label="שליחת הודעה בוואטסאפ">וואטסאפ</a>
<dialog class="light" id="light" aria-label="תצוגה מוגדלת"><button class="x" type="button" aria-label="סגירה">×</button><div class="lightbody"></div></dialog>''' % (
  LEGAL, COMPANY_ID, PHONE, EMAIL, "".join('<a href="%s.html">%s</a>' % (c["slug"], c["name"]) for c in CATS[:4]), WA)

def head(title, desc, canon, schemas):
  ld = "".join('<script type="application/ld+json">%s</script>\n' % json.dumps(s, ensure_ascii=False) for s in schemas)
  return '''<title>{t}</title>
<meta name="description" content="{d}">
<link rel="canonical" href="{c}">
<meta property="og:type" content="website"><meta property="og:site_name" content="זיסו קרמיקה">
<meta property="og:title" content="{t}"><meta property="og:description" content="{d}"><meta property="og:url" content="{c}"><meta property="og:locale" content="he_IL"><meta property="og:image" content="https://www.zisoceramics.com/img/logo.jpg"><meta property="og:image:width" content="1440"><meta property="og:image:height" content="1440"><link rel="apple-touch-icon" href="img/logo.jpg">
<meta name="theme-color" content="#25292c">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%2325292c'/%3E%3Cpath d='M9 9h14L9 23h14' stroke='%2394733d' stroke-width='2.5' fill='none'/%3E%3C/svg%3E">
<link rel="preload" href="fonts/assistant-400-hebrew.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="fonts/bellefair-400-hebrew.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="fonts.css">
<link rel="stylesheet" href="styles.css">
<script src="site.js" defer></script>
{ld}'''.format(t=html.escape(title), d=html.escape(desc), c=canon, ld=ld)


# Legal pages required or expected in Israel: accessibility statement (תקנות שוויון זכויות לאנשים עם מוגבלות, התאמות נגישות לשירות, תקן 5568 / WCAG 2.0 AA),
# privacy policy incl. cookies (חוק הגנת הפרטיות ותיקון 13), terms of use. Written in content; edit here.
A11Y_DATE = "7 באוקטובר 2026"
LEGAL_PAGES = [
  ("accessibility.html", "הצהרת נגישות", "הצהרת הנגישות של אתר זיסו קרמיקה: רמת הנגישות, ההתאמות שבוצעו, פרטי רכז הנגישות ודרכי פנייה.", "הצהרת נגישות",
   "אנחנו רואים בנגישות חלק מהשירות, באולם ובאתר. העמוד מפרט מה נעשה באתר, איך משתמשים בכלי הנגישות ולמי פונים אם משהו לא עובד.", '''
<h2>מחויבות לנגישות</h2>
<p>זיסו קרמיקה בע"מ פועלת כדי שהאתר והשירות יהיו נגישים לאנשים עם מוגבלות, בהתאם לחוק שוויון זכויות לאנשים עם מוגבלות, התשנ"ח-1998, ולתקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות), התשע"ג-2013.</p>
<h2>רמת הנגישות באתר</h2>
<p>האתר נבנה כך שיעמוד בדרישות התקן הישראלי ת"י 5568 "קווים מנחים לנגישות תכנים באינטרנט" ברמה AA, המבוסס על הנחיות WCAG 2.0 של ארגון W3C, ונבדק גם מול הנחיות WCAG 2.1 ברמה AA. הבדיקה נעשתה בדפדפני Chrome, Safari ו-Firefox עדכניים, במחשב ובטלפון, ובכלי בדיקה אוטומטיים, ועודכנה לאחרונה ב-%s.</p>
<h2>מה נעשה באתר</h2>
<ul>
<li>האתר כולו בעברית, בכיוון ימין לשמאל, עם מבנה כותרות הגיוני ואזורי ניווט מסומנים (ראשי, ניווט, תוכן, כותרת תחתונה). בראש כל עמוד קישור "דילוג לתוכן הראשי".</li>
<li>ניווט מלא במקלדת: כל הקישורים, הכפתורים, המחשבון, הגלריה והחלונות הקופצים נגישים ב-Tab וב-Enter, עם סימון פוקוס ברור. חלון ההגדלה נסגר ב-Esc.</li>
<li>ניגודיות צבעים של 4.5:1 לפחות לטקסט, גם במצב כהה של המכשיר. מצב "ניגודיות גבוהה" זמין בתפריט הנגישות.</li>
<li>לכל התמונות טקסט חלופי; לסרטונים הקצרים (שאין בהם קול) כיתוב מתאר. הסרטונים מתנגנים בלי קול, ואפשר לעצור כל תנועה באתר בלחיצה אחת בכפתור "עצירת הסרט" או "עצירת תנועה". משתמשים שהגדירו במכשיר "הפחתת תנועה" מקבלים את האתר בלי אנימציות באופן אוטומטי.</li>
<li>הטקסט ניתן להגדלה עד 200%% בלי אובדן תוכן, והאתר מותאם לכל רוחב מסך.</li>
<li>שדות הטופס והמחשבון מסומנים בתוויות ברורות, ושגיאות מוצגות בטקסט.</li>
<li>תפריט נגישות (הכפתור העגול בתחתית המסך) מאפשר: הגדלת והקטנת טקסט, ניגודיות גבוהה, הדגשת קישורים, גופן קריא ועצירת תנועה. ההעדפות נשמרות במכשיר שלכם בלבד.</li>
</ul>
<h2>מה עדיין לא מושלם</h2>
<p>טופס "תיק לקוח" מוטמע מתוך מערכת Google, ואנחנו עובדים על בדיקת הנגישות המלאה שלו. אם נתקלתם בקושי במילוי הטופס, אפשר לשלוח את אותם פרטים בוואטסאפ או בטלפון ונפתח את התיק בשבילכם.</p>
<h2>נגישות אולם התצוגה</h2>
<p>אולם התצוגה נמצא ברחוב עוצמה 5, טירת כרמל. לפרטים על חניה, גישה וסידורי נגישות במקום, וכדי שנכין את הביקור מראש, מוזמנים לפנות לרכז הנגישות. פגישת הייעוץ באולם מתואמת מראש וניתנת בקצב ובאופן שנוחים לכם.</p>
<h2>רכז נגישות ודרכי פנייה</h2>
<p>רכז הנגישות של זיסו קרמיקה: <strong>אביב זיסו</strong>. טלפון וואטסאפ <a class="ltr" href="tel:%s">%s</a>, אימייל <a class="ltr" href="mailto:%s">%s</a>, כתובת למשלוח דואר: עוצמה 5, טירת כרמל.</p>
<p>אם נתקלתם בבעיית נגישות באתר או בשירות, נשמח לדעת. נשתדל להשיב בתוך 7 ימי עסקים ולתקן בהקדם. אפשר לפנות גם לנציבות שוויון זכויות לאנשים עם מוגבלות במשרד המשפטים.</p>
<p class="small">ההצהרה עודכנה לאחרונה ב-%s.</p>
''' % (A11Y_DATE, PHONE_INTL, PHONE, EMAIL, EMAIL, A11Y_DATE)),

  ("privacy.html", "מדיניות פרטיות ועוגיות", "איזה מידע אתר זיסו קרמיקה אוסף, למה, מי מקבל אותו, אילו עוגיות יש באתר ומה הזכויות שלכם לפי חוק הגנת הפרטיות.", "מדיניות פרטיות ועוגיות",
   "בקצרה: האתר עצמו לא אוסף עליכם מידע אישי בלי שתמסרו אותו. כאן מפורט מה נשמר כשאתם פונים אלינו, ומה הזכויות שלכם.", '''
<h2>מי אנחנו</h2>
<p>בעלת האתר <span class="ltr">www.zisoceramics.com</span> היא זיסו קרמיקה בע"מ, ח.פ. <span class="ltr">%s</span>, עוצמה 5, טירת כרמל, טלפון <span class="ltr">%s</span>, אימייל <span class="ltr">%s</span> ("אנחנו"). המדיניות מנוסחת בלשון זכר מטעמי נוחות ופונה לכולם.</p>
<h2>איזה מידע נאסף ולמה</h2>
<ul>
<li><b>גלישה באתר.</b> האתר סטטי ומאוחסן בשירות GitHub Pages. כמו בכל אתר, שרת האחסון מקבל את כתובת ה-IP וסוג הדפדפן לצורך אספקת העמודים ואבטחה; אנחנו לא מקבלים ולא שומרים נתונים אלה. הגופנים באתר מאוחסנים אצלנו, ולא נשלחת בקשה לשירותי גופנים חיצוניים.</li>
<li><b>פנייה בוואטסאפ, בטלפון או במייל.</b> כשאתם פונים אלינו, אנחנו שומרים את הפרטים שמסרתם (שם, טלפון, תוכן הפנייה) כדי לענות, לתאם ביקור באולם ולהכין הצעת מחיר. השיחה בוואטסאפ כפופה גם למדיניות הפרטיות של WhatsApp (Meta).</li>
<li><b>טופס "תיק לקוח".</b> הפרטים שאתם ממלאים (שם, טלפון, אימייל, פרטי הפרויקט, תמונות ותוכניות אם צירפתם) נשמרים במערכות Google Workspace שלנו ובמערכת ניהול הלקוחות שלנו, ומשמשים להכנת הפגישה, להצעת מחיר ולניהול ההזמנה. מסירת המידע תלויה ברצונכם; בלי שם וטלפון לא נוכל לחזור אליכם.</li>
<li><b>אזור הלקוחות.</b> הכניסה נעשית עם מספר הטלפון ומספר הלקוח או ההזמנה, ומציגה רק את הנתונים של אותה הזמנה ממערכת הניהול שלנו. לא נשמר מידע נוסף מעבר לרישום הגישה.</li>
<li><b>דיוור שיווקי.</b> לא נשלח אליכם הודעות פרסומת בלי הסכמה מפורשת, בהתאם לסעיף 30א לחוק התקשורת (בזק ושידורים). בכל הודעה כזו תהיה דרך פשוטה להסרה.</li>
</ul>
<h2>מי מקבל את המידע</h2>
<p>המידע נשמר אצלנו ואצל ספקי השירות שמפעילים את המערכות שלנו: Google (Workspace, Drive), Meta (WhatsApp), ספקית תוכנת ניהול העסק, וחברת הסליקה כשמבצעים תשלום. חלק מספקים אלה שומרים מידע מחוץ לישראל, במדינות עם רמת הגנה מוכרת. אנחנו לא מוכרים ולא מעבירים מידע לצדדים שלישיים לצורכי שיווק. נמסור מידע אם נידרש לכך לפי דין או כדי לממש זכויות משפטיות.</p>
<h2>כמה זמן שומרים</h2>
<p>פניות שלא הבשילו לעסקה נשמרות עד שנתיים. מסמכי עסקה (הזמנות, חשבוניות, קבלות) נשמרים לפי חובות הדיווח והנהלת החשבונות (שבע שנים לפחות).</p>
<h2>הזכויות שלכם</h2>
<p>לפי חוק הגנת הפרטיות, התשמ"א-1981, יש לכם זכות לעיין במידע שנשמר עליכם, לבקש לתקן אותו או למחוק אותו, ולהתנגד לדיוור. פונים לכתובת <span class="ltr">%s</span> או בטלפון, ונטפל בבקשה בתוך 30 יום. אם לדעתכם זכותכם לפרטיות נפגעה, אפשר לפנות גם לרשות להגנת הפרטיות.</p>
<h2>אבטחת מידע</h2>
<p>האתר מוגש בחיבור מוצפן (HTTPS). המערכות שלנו מוגנות בסיסמאות ובאימות דו-שלבי, והגישה למידע ניתנת רק למי שצריך אותו לעבודתו. אין אבטחה מושלמת, ואנחנו משתדלים לפעול לפי הנהוג בתחום.</p>
<h2>עוגיות ומדידה</h2>
<p>האתר שומר בדפדפן שלכם רק הגדרות שבחרתם בעצמכם (למשל העדפות הנגישות ותשובתכם להודעת העוגיות), בשימוש ב-localStorage; הן לא נשלחות אלינו. כלי מדידה (Google Analytics / Google Tag Manager, פיקסל של Meta) יופעלו רק אחרי שתאשרו זאת בהודעה שתוצג בתחתית העמוד, ואפשר לשנות את הבחירה בכל רגע בלחיצה על "הגדרות עוגיות" בתחתית כל עמוד. בלי הסכמה לא מופעלת שום מדידה. ניתן גם לחסום עוגיות בהגדרות הדפדפן.</p>
<h2>קישורים חיצוניים</h2>
<p>האתר מקשר לשירותים כמו Waze, Google Maps, Instagram ו-Facebook. השימוש בהם כפוף למדיניות הפרטיות שלהם.</p>
<h2>עדכונים</h2>
<p>נעדכן את המדיניות כשיהיה צורך, ותאריך העדכון יופיע כאן. עודכן לאחרונה ב-%s.</p>
''' % (COMPANY_ID, PHONE, EMAIL, EMAIL, A11Y_DATE)),

  ("terms.html", "תנאי שימוש", "תנאי השימוש באתר זיסו קרמיקה: תוכן המידע, מחשבון הכמויות, זכויות יוצרים ודין חל.", "תנאי שימוש",
   "האתר נועד להציג את האולם ואת המוצרים ולעזור לכם להתכונן לביקור. כמה דברים שכדאי לדעת.", '''
<h2>כללי</h2>
<p>האתר מופעל על ידי זיסו קרמיקה בע"מ (ח.פ. <span class="ltr">%s</span>). השימוש באתר מהווה הסכמה לתנאים אלה. התנאים מנוסחים בלשון זכר מטעמי נוחות ופונים לכולם.</p>
<h2>מידע על מוצרים ומחירים</h2>
<p>המידע באתר הוא מידע כללי לצורך התרשמות והכנה לביקור, ואינו הצעה מחייבת. המבחר, הזמינות, הגוונים והמחירים נקבעים באולם ובהצעת המחיר שתקבלו בכתב. גוון אריח על מסך עשוי להיות שונה מהמוצר האמיתי. עסקאות כפופות לחוק הגנת הצרכן, התשמ"א-1981, ולתנאי ההזמנה שייחתמו באולם.</p>
<h2>מחשבון הכמויות</h2>
<p>המחשבון נותן הערכה בלבד לפי המידות שהזנתם ואחוזי פחת מקובלים. הכמות הסופית נקבעת עם הרצף ולפי המידות בפועל, ואיננו אחראים להפרשים הנובעים משימוש במחשבון.</p>
<h2>קניין רוחני</h2>
<p>התמונות, הסרטונים, הטקסטים והעיצוב באתר שייכים לזיסו קרמיקה או לבעלי זכויות שאישרו את השימוש. תמונות של פרויקטים פורסמו בהסכמת הלקוחות. אין להעתיק או להשתמש בתכנים בלי אישור בכתב.</p>
<h2>אחריות</h2>
<p>אנחנו משתדלים שהמידע באתר יהיה מדויק ועדכני, אך ייתכנו טעויות. האתר ניתן כפי שהוא, ולא נישא באחריות לנזק עקיף שנגרם מהסתמכות על המידע באתר או מתקלה בזמינותו. אין באמור כדי לגרוע מזכויות שאינן ניתנות להתניה לפי דין.</p>
<h2>פרטיות ונגישות</h2>
<p>ראו את <a href="privacy.html">מדיניות הפרטיות והעוגיות</a> ואת <a href="accessibility.html">הצהרת הנגישות</a>.</p>
<h2>דין וסמכות שיפוט</h2>
<p>על תנאים אלה חל הדין הישראלי, וסמכות השיפוט נתונה לבתי המשפט המוסמכים במחוז חיפה. עודכן לאחרונה ב-%s.</p>
''' % (COMPANY_ID, A11Y_DATE)),
]

GTM_ID = ""  # fill when Aviv opens the GTM account (GTM-XXXXXXX); until then tracking stays dormant

def write(name, title, desc, body, schemas, canon=None, body_attrs=""):
  canon = canon or SITE + ("" if name == "index.html" else name)
  h = head(title, desc, canon, schemas)
  noindex = '<meta name="robots" content="noindex">\n' if name in ("toda.html", "404.html") else ""
  body = body.replace('<div class="wall', '<div role="region" aria-label="פתיח" class="wall', 1).replace('<main>', '<main id="main">', 1)
  if '<main' not in body: body = body.replace('<footer>', '<main id="main"></main>\n<footer>', 1)
  full = '<!doctype html>\n<html lang="he" dir="rtl">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<script>window.ZISO_GTM_ID=%s</script>\n%s%s</head>\n<body%s>\n%s\n</body>\n</html>\n' % (json.dumps(GTM_ID), noindex, h, body_attrs, body)
  open(os.path.join(DIST, name), "w").write(full)
  return h, body

def tiles_html():
  out = []
  for c in CATS:
    sz = '<small>%s</small>' % c["sizes"] if c["sizes"] else ""
    ph = CAT_PHOTOS.get(c["slug"])
    if ph and os.path.exists(os.path.join(GALLERY_DIR, ph)):
      sw = '<div class="sw photo"><img src="img/gallery/%s" alt="%s" loading="lazy" width="1200" height="900">%s</div>' % (ph, c["name"], sz)
    else:
      sw = '<div class="sw %s">%s</div>' % (c["sw"], sz)
    out.append('<article class="tile%s">%s<div class="tx"><h3><a href="%s.html">%s</a></h3><p>%s</p></div></article>'
               % (" wide" if c.get("wide") else "", sw, c["slug"], c["name"], c["card"]))
  return '<div class="tiles">%s</div>' % "".join(out)

def faq_html(items):
  return '<div class="faq">%s</div>' % "".join('<details><summary>%s</summary><p>%s</p></details>' % (q, a) for q, a in items)

CALC = '''<div class="calc">
<form id="calc" novalidate>
  <div class="seg" role="radiogroup" aria-label="איך למדוד">
    <label><input type="radio" name="mode" value="dims" id="m-dims" checked> אורך × רוחב</label>
    <label><input type="radio" name="mode" value="area" id="m-area"> יש לי מ"ר</label>
  </div>
  <div class="row" id="dims"><label for="len">אורך החדר <small>במטרים</small><input id="len" inputmode="decimal" value="5"></label>
  <label for="wid">רוחב החדר <small>במטרים</small><input id="wid" inputmode="decimal" value="4"></label></div>
  <div class="row" id="direct" hidden><label for="area">שטח <small>במ"ר</small><input id="area" inputmode="decimal" value="20"></label></div>
  <div class="row"><label for="size">גודל אריח <small>בס"מ</small><select id="size">
    <option value="60x60">60×60</option><option value="60x120" selected>60×120</option><option value="120x120">120×120</option>
    <option value="80x160">80×160</option><option value="30x60">30×60</option><option value="20x120">20×120 (מראה פרקט)</option><option value="7.5x15">7.5×15 (בריק)</option></select></label>
  <label for="box">מ"ר בקרטון <small>כתוב על הקרטון</small><input id="box" inputmode="decimal" value="1.44"></label></div>
  <div class="seg" role="radiogroup" aria-label="שיטת הנחה">
    <label><input type="radio" name="lay" value="10" id="l-10" checked> הנחה ישרה · 10%</label>
    <label><input type="radio" name="lay" value="15" id="l-15"> אלכסון או אדרה · 15%</label>
  </div>
</form>
<div class="out" aria-live="polite">
  <p class="eyebrow" style="margin:0">להזמין</p>
  <div class="big"><span id="o-m2">0</span> <small>מ"ר</small></div>
  <dl><div><dt>שטח נטו</dt><dd id="o-net">0</dd></div><div><dt>פחת</dt><dd id="o-waste">10%</dd></div>
  <div><dt>מספר אריחים</dt><dd id="o-tiles">0</dd></div><div><dt>קרטונים</dt><dd id="o-boxes">0</dd></div></dl>
  <p class="note">חישוב משוער. לפני הזמנה נעבור איתכם על הכמות לפי התוכנית, ומומלץ להשאיר קרטון אחד לתיקונים.</p>
</div></div>'''

def sidebar(name):
  return '''<aside class="side">
<div class="panel"><h3>פגישת ייעוץ ועיצוב, בחינם</h3><p>%s מוצגים באולם בטירת כרמל, ומעצבת פנים מוסמכת עוזרת לכם לבחור.</p>
<a class="btn brass" href="%s" target="_blank" rel="noopener">לפגישת ייעוץ חינם</a>
<a class="btn line" href="https://waze.com/ul?q=%s&navigate=yes" target="_blank" rel="noopener">ניווט בוויז</a></div>
<div class="panel"><h3>כמה צריך?</h3><p>מחשבים מ"ר, אריחים וקרטונים כולל פחת.</p><a class="btn line" href="calculator.html">למחשבון</a></div>
</aside>''' % (name, WA_VISIT, ADDR_Q)

def build():
  if os.path.exists(DIST): shutil.rmtree(DIST)
  os.makedirs(DIST)
  shutil.copy(os.path.join(HERE, "styles.css"), DIST); shutil.copy(os.path.join(HERE, "site.js"), DIST); shutil.copy(os.path.join(HERE, "fonts.css"), DIST); shutil.copytree(os.path.join(HERE, "fonts"), os.path.join(DIST, "fonts")); shutil.copytree(os.path.join(HERE, "img"), os.path.join(DIST, "img"))

  # Home
  video = ('<video class="herovid" autoplay muted loop playsinline preload="auto" poster="img/video/hero.jpg" data-hero aria-hidden="true"><source src="%s" type="video/mp4"></video>' % HERO_CLIP) if HERO_CLIP else ''
  home = header() + '''
<div class="wall live" id="top"><canvas class="tilewall" aria-hidden="true"></canvas>{video}<div class="wrap hero home live">
<div>
<p class="eyebrow">אולם תצוגה לריצוף ואמבטיה · טירת כרמל</p>
<h1>תרגיש בבית<br>לעצב את <em>הבית</em></h1>
<p>גרניט פורצלן, כלים סניטריים, ארונות אמבטיה, מקלחונים וברזים, עם מעצבות פנים מוסמכות שעוזרות לכם לבחור. פגישת ייעוץ ועיצוב באולם בחינם, דקות מחיפה.</p>
<div class="actions"><a class="btn brass" href="{wa}" target="_blank" rel="noopener">לפגישת ייעוץ חינם בוואטסאפ</a><a class="btn ghost" href="#products">מה יש באולם</a></div>
<dl class="facts onwall">
<div><dt>כתובת</dt><dd>עוצמה 5, טירת כרמל</dd></div>
<div><dt>טלפון וואטסאפ</dt><dd class="ltr">{phone}</dd></div>
<div><dt>שעות פתיחה</dt><dd>{hours}</dd></div></dl>
</div>
</div><div class="scrollcue" aria-hidden="true"></div><button class="pause" type="button" data-pause aria-pressed="false" hidden>עצירת הסרט</button></div>
<div class="strip" aria-hidden="true"><div class="track">{strip}{strip}</div></div>
<main>
{reel}<section id="products"><div class="wrap">
<div class="head" data-reveal><div><p class="eyebrow">באולם</p><h2>כל מה שהשיפוץ צריך, תחת קורת גג אחת</h2>
<p class="lede">מהרצפה בסלון ועד הברז במקלחת. הרבה מהדגמים מוצגים באולם בגודל מלא, כדי שתראו איך אריח נראה על קיר אמיתי ולא רק בקטלוג.</p></div></div>
{tiles}
</div></section>
<section id="how"><div class="wrap">
<div class="head" data-reveal><div><p class="eyebrow">איך זה עובד</p><h2>מהביקור הראשון עד ההתקנה</h2></div></div>
<ol class="steps">
<li><h3>מגיעים לאולם</h3><p>מביאים תוכנית או תמונות של החדר. אפשר גם עם האדריכל או הקבלן.</p></li>
<li><h3>פגישת עיצוב חינם</h3><p>אילת ושיר, מעצבות פנים מוסמכות, מתאימות איתכם אריחים, כלים וברזים לסגנון ולתקציב, ומחשבות כמויות.</p></li>
<li><h3>מקבלים הצעה מסודרת</h3><p>הצעת מחיר אחת לכל הפרויקט, עם מועדי אספקה לכל פריט.</p></li>
<li><h3>עוקבים עד המסירה</h3><p>באזור הלקוחות רואים בכל רגע מה הוזמן, מה מוכן ומה כבר סופק.</p></li>
</ol></div></section>
<section id="calculator"><div class="wrap">
<div class="head" data-reveal><div><p class="eyebrow">מחשבון כמויות</p><h2>כמה אריחים צריך להזמין?</h2>
<p class="lede">מזינים את מידות החדר וגודל האריח, ומקבלים מ"ר להזמנה, מספר אריחים וקרטונים, כולל פחת.</p></div></div>
<div data-reveal>{calc}</div>
</div></section>
<section id="family"><div class="wrap family">
<blockquote>אצלנו אתם לא מספר הזמנה. אתם המשפחה שאנחנו עוזרים לה לבנות בית.</blockquote>
<div><p class="eyebrow">עסק משפחתי</p><h2>זיסו קרמיקה</h2>
<p>עסק משפחתי מטירת כרמל, שמלווה משפחות, קבלנים ואדריכלים מחיפה, הקריות וכל אזור הכרמל בבחירת ריצוף, חיפוי ואמבטיה. אילת ושיר הן מעצבות פנים עם דיפלומה, והייעוץ והעיצוב באולם הם בחינם. את מה שבאולם בחרנו בעצמנו, ואנחנו שם גם אחרי הקנייה כשצריך עוד קרטון, החלפה או עצה.</p>
<p class="since">מאז 1985 · 4.3 בגוגל על 85 ביקורות</p>
<div class="names"><span>משה</span><span>אילת</span><span>שיר</span><span>אביב</span></div></div>
<div class="portraits" aria-label="משפחת זיסו"><figure><img src="img/family-1.jpg" alt="משה זיסו" loading="lazy" width="693" height="653"><figcaption>משה זיסו</figcaption></figure><figure><img src="img/family-2.jpg" alt="אילת זיסו" loading="lazy" width="312" height="369"><figcaption>אילת זיסו<small>מעצבת פנים</small></figcaption></figure><figure><img src="img/family-3.jpg" alt="שיר זיסו" loading="lazy" width="720" height="720"><figcaption>שיר זיסו<small>מעצבת פנים</small></figcaption></figure><figure><img src="img/family-4.jpg" alt="אביב זיסו" loading="lazy" width="609" height="533"><figcaption>אביב זיסו</figcaption></figure></div>
</div></section>
{gallery}<section id="client"><div class="wrap">
<div class="head" data-reveal><div><p class="eyebrow">אזור לקוחות</p><h2>כבר קניתם אצלנו? הכל כאן</h2></div></div>
<div class="client" data-reveal>
<div class="panel"><h3>מעקב הזמנה</h3><p>נכנסים עם מספר הנייד ומספר ההזמנה, ורואים:</p>
<ul><li>סטטוס כל פריט בהזמנה</li><li>יתרה לתשלום</li><li>חשבוניות וקבלות</li></ul>
<a class="btn ink" href="{portal}" target="_blank" rel="noopener">כניסה לאזור האישי</a></div>
<div class="panel"><h3>פתיחת תיק לפרויקט חדש</h3><p>מתכננים שיפוץ? ממלאים כמה פרטים על הבית והפרויקט, ומגיעים לאולם כשאנחנו כבר מוכנים בשבילכם.</p>
<ul><li>סוג הפרויקט ושלב העבודה</li><li>אילו חדרים ומה מעניין אתכם</li><li>אפשר לצרף תוכניות ותמונות</li></ul>
<a class="btn line" href="tik-lakoach.html">למילוי הטופס</a></div>
</div></div></section>
<section id="faq"><div class="wrap">
<div class="head" data-reveal><div><p class="eyebrow">שאלות נפוצות</p><h2>מה שואלים אותנו הכי הרבה</h2></div></div>
{faq}
</div></section>
<section id="visit"><div class="wrap visit">
<div><p class="eyebrow">ביקור באולם</p><h2>בואו לראות ולגעת</h2>
<p class="lede">האולם נמצא בטירת כרמל, דקות מחיפה, נשר והקריות. פגישת ייעוץ ועיצוב עם מעצבת פנים מוסמכת היא בחינם. כדאי לתאם מראש כדי שנקדיש לכם את הזמן.</p>
<dl class="contact">
<div><dt>וואטסאפ וטלפון</dt><dd><a class="ltr" href="tel:{phone_intl}">{phone}</a></dd></div>
<div><dt>אימייל</dt><dd><a class="ltr" href="mailto:{email}">{email}</a></dd></div>
<div><dt>שעות פתיחה</dt><dd>{hours}</dd></div></dl>
<ul class="areas" aria-label="אזורים">{areas}</ul></div>
<div class="mapcard"><div><p class="eyebrow">כתובת</p><div class="addr">עוצמה 5<br>טירת כרמל</div></div>
<div class="actions"><a class="btn brass" href="https://waze.com/ul?q={addr}&navigate=yes" target="_blank" rel="noopener">ניווט בוויז</a>
<a class="btn ghost" href="https://www.google.com/maps/search/?api=1&query={addr}" target="_blank" rel="noopener">Google Maps</a></div></div>
</div></section>
</main>
'''.format(wa=WA_VISIT, phone=PHONE, phone_intl=PHONE_INTL, email=EMAIL, hours=HOURS_HTML, video=video, reel=reel_html(), gallery=('<section id="works"><div class="wrap"><div class="head" data-reveal><div><p class="eyebrow">מהאולם ומהלקוחות</p><h2>עבודות אחרונות</h2></div><a class="btn ghost" href="gallery.html">לכל העבודות</a></div>' + gallery_html(GALLERY[:6]) + '</div></section>') if GALLERY else '', strip=''.join('<span>%s</span>' % c['name'] for c in CATS), tiles=tiles_html(),
           calc=CALC, portal=PORTAL, faq=faq_html(HOME_FAQ), areas="".join("<li>%s</li>" % a for a in AREAS), addr=ADDR_Q) + FOOTER
  h, b = write("index.html", "זיסו קרמיקה | ריצוף, גרניט פורצלן ואמבטיה בטירת כרמל ליד חיפה",
    "אולם תצוגה לגרניט פורצלן, כלים סניטריים, ארונות אמבטיה, מקלחונים לפי מידה, ברזים, בריקים ופרקט בטירת כרמל, דקות מחיפה והקריות. עסק משפחתי עם ליווי לאורך כל השיפוץ.",
    home, [BUSINESS, faq_schema(HOME_FAQ)])
  # Artifact preview: same page without the document wrapper
  open(os.path.join(DIST, "..", "preview.html"), "w").write('<script>document.documentElement.lang="he";document.documentElement.dir="rtl"</script>\n' + h + b)

  # Category pages
  for c in CATS:
    parts = []
    for h2, content in c["body"]:
      parts.append("<h2>%s</h2>" % h2)
      if content == "TABLE":
        rows = c["table"]
        parts.append('<div class="tbl"><table><thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>' % (
          "".join("<th>%s</th>" % x for x in rows[0]),
          "".join("<tr>%s</tr>" % "".join("<td>%s</td>" % x for x in r) for r in rows[1:])))
        continue
      for p in content:
        parts.append("<ul>%s</ul>" % "".join("<li>%s</li>" % li for li in p) if isinstance(p, list) else "<p>%s</p>" % p)
    parts.append("<h2>שאלות נפוצות על %s</h2>" % c["name"]); parts.append(faq_html(c["faq"]))
    others = "".join('<li><a href="%s.html">%s</a></li>' % (o["slug"], o["name"]) for o in CATS if o is not c)
    sz = '<small>%s</small>' % c["sizes"] if c["sizes"] else ""
    vname = CAT_VIDEOS.get(c["slug"])
    cat_video = ('<div class="sw photo video" role="img" aria-label="%s">%s%s</div>' % (c["name"], video_tag(vname, "", c["name"], "metadata"), sz)) if vname and has_video(vname) else None
    body = header() + '''
<div class="wall"><div class="wrap hero inner">
<div><ol class="crumbs"><li><a href="./">זיסו קרמיקה</a></li><li aria-current="page">{name}</li></ol>
<h1>{h1}</h1><p>{lede}</p>
<div class="actions"><a class="btn brass" href="{wa}" target="_blank" rel="noopener">לפגישת ייעוץ חינם</a><a class="btn ghost" href="calculator.html">מחשבון כמויות</a></div></div>
{visual}
</div></div>
<main><section><div class="wrap article"><article class="prose">{parts}</article>{side}</div></section>
<section><div class="wrap"><p class="eyebrow">עוד באולם</p><ul class="areas">{others}</ul></div></section></main>
'''.format(name=c["name"], h1=c["h1"], lede=c["lede"], wa=WA_VISIT, visual=cat_video or (
      '<div class="sw photo" role="img" aria-label="%s"><img src="img/gallery/%s" alt="" width="1200" height="900">%s</div>' % (c["name"], CAT_PHOTOS[c["slug"]], sz)
      if c["slug"] in CAT_PHOTOS and os.path.exists(os.path.join(GALLERY_DIR, CAT_PHOTOS[c["slug"]])) else '<div class="sw %s" role="img" aria-label="%s">%s</div>' % (c["sw"], c["name"], sz)), parts=ltr_sizes("\n".join(parts)), side=sidebar(c["name"]), others=others) + FOOTER
    write(c["slug"] + ".html", c["title"], c["desc"], body, [{"@context": "https://schema.org", "@type": "WebPage", "name": c["title"], "about": {"@id": SITE + "#business"}}, crumbs_schema(c["name"], c["slug"]), faq_schema(c["faq"])], body_attrs=' data-item="%s"' % c["name"])

  # Calculator page
  calc_faq = [("כמה פחת להוסיף לאריחים?", "בהנחה ישרה 10%, ובהנחה אלכסונית, אדרה או חדר עם הרבה פינות 15%."),
              ("איך יודעים כמה מ\"ר יש בקרטון?", "זה כתוב על הקרטון ובמפרט של הסדרה. באולם נגיד לכם את המספר המדויק לכל אריח."),
              ("למה לשמור קרטון בצד?", "סדרות אריחים מתחלפות, וגוון הייצור משתנה בין אצוות. קרטון שמור חוסך חיפוש אם צריך להחליף אריח שנשבר.")]
  body = header("calculator") + '''
<div class="wall"><div class="wrap hero inner" style="grid-template-columns:1fr">
<div><ol class="crumbs"><li><a href="./">זיסו קרמיקה</a></li><li aria-current="page">מחשבון כמויות</li></ol>
<h1>מחשבון כמות אריחים</h1><p>כמה מ"ר, כמה אריחים וכמה קרטונים להזמין לרצפה או לקיר, כולל פחת.</p></div></div></div>
<main><section><div class="wrap">{calc}</div></section>
<section><div class="wrap"><h2 style="margin-bottom:20px">איך מחשבים</h2>{faq}</div></section></main>
'''.format(calc=CALC, faq=faq_html(calc_faq)) + FOOTER
  write("calculator.html", "מחשבון כמות אריחים: כמה מ\"ר וקרטונים להזמין | זיסו קרמיקה",
        "מחשבון אריחים חינמי: מזינים מידות חדר וגודל אריח ומקבלים מ\"ר להזמנה, מספר אריחים וקרטונים כולל 10% עד 15% פחת.",
        body, [crumbs_schema("מחשבון כמויות", "calculator"), faq_schema(calc_faq)])

  # 404
  write("404.html", "העמוד לא נמצא | זיסו קרמיקה", "העמוד לא נמצא.", header() + '''
<div class="wall"><div class="wrap hero inner" style="grid-template-columns:1fr"><div><h1>העמוד לא נמצא</h1>
<p>ייתכן שהקישור ישן, מהאתר הקודם. הכל נמצא בדף הבית.</p><div class="actions"><a class="btn brass" href="/">לדף הבית</a></div></div></div></div>''' + FOOTER, [])

  # About + Contact pages (Meta verification wants them as separate pages)
  about_video = ('<div class="sw photo video tall" role="img" aria-label="שיר באולם התצוגה">%s</div>' % video_tag("showroom-shir", "", "שיר באולם התצוגה", "metadata")) if has_video("showroom-shir") else ""
  about = header("about") + '''
<div class="wall"><div class="wrap hero inner about">
<div><ol class="crumbs"><li><a href="./">זיסו קרמיקה</a></li><li aria-current="page">עלינו</li></ol>
<h1>עסק משפחתי מטירת כרמל</h1><p>זיסו קרמיקה היא חנות ואולם תצוגה לריצוף, חיפוי ואמבטיה, שמנוהלת על ידי משפחת זיסו: משה, אילת, שיר ואביב. אילת ושיר הן מעצבות פנים מוסמכות, והפגישה איתן באולם בחינם.</p></div>%s</div></div>
<main><section><div class="wrap article"><article class="prose">
<h2>מי אנחנו</h2>
<p>עסק משפחתי שמנוהל על ידי משה ואילת מאז 1985, ארבעים שנה של ריצוף וחיפוי באזור הכרמל, עם מוניטין מבוסס (4.3 כוכבים בגוגל על 85 ביקורות). ליווינו משפחות רבות בתהליך השיפוץ, ואנחנו עובדים יחד באולם ברחוב עוצמה 5 בטירת כרמל, עם לקוחות, קבלנים ואדריכלים מחיפה, הקריות וכל אזור הכרמל: ריצוף, חיפוי, כלים סניטריים, ארונות אמבטיה, מקלחונים וברזים.</p>
<div class="portraits" aria-label="משפחת זיסו"><figure><img src="img/family-1.jpg" alt="משה זיסו" loading="lazy" width="693" height="653"><figcaption>משה זיסו</figcaption></figure><figure><img src="img/family-2.jpg" alt="אילת זיסו" loading="lazy" width="312" height="369"><figcaption>אילת זיסו<small>מעצבת פנים</small></figcaption></figure><figure><img src="img/family-3.jpg" alt="שיר זיסו" loading="lazy" width="720" height="720"><figcaption>שיר זיסו<small>מעצבת פנים</small></figcaption></figure><figure><img src="img/family-4.jpg" alt="אביב זיסו" loading="lazy" width="609" height="533"><figcaption>אביב זיסו</figcaption></figure></div>
<h2>ייעוץ ועיצוב בחינם</h2>
<p>אילת זיסו ושיר זיסו הן מעצבות פנים עם דיפלומה. בפגישה באולם הן עוברות איתכם על התוכנית או על תמונות החדר, מתאימות ריצוף, חיפוי, כלים וברזים לסגנון ולתקציב, ומחשבות את הכמויות. הפגישה והייעוץ בחינם, בלי התחייבות.</p>
<h2>איך אנחנו עובדים</h2>
<ul><li>בוחרים באולם, על לוחות בגודל מלא ולא רק בקטלוג.</li><li>הצעת מחיר אחת לכל הפרויקט, עם מועד אספקה לכל פריט.</li><li>מעקב הזמנה באזור הלקוחות באתר, ושירות גם אחרי הקנייה: קרטון נוסף, החלפה או עצה.</li></ul>
<h2>פרטי העסק</h2>
<div class="tbl"><table><tbody>
<tr><th>שם העסק</th><td>%s</td></tr><tr><th>ח.פ.</th><td class="ltr">%s</td></tr>
<tr><th>כתובת</th><td>עוצמה 5, טירת כרמל</td></tr><tr><th>טלפון</th><td class="ltr">%s</td></tr>
<tr><th>אימייל</th><td class="ltr">%s</td></tr></tbody></table></div>
</article>%s</div></section></main>
''' % (about_video, LEGAL, COMPANY_ID, PHONE, EMAIL, sidebar("כל המוצרים")) + FOOTER
  write("about.html", "עלינו | זיסו קרמיקה, עסק משפחתי בטירת כרמל", "זיסו קרמיקה בע\"מ: אולם תצוגה משפחתי לריצוף, חיפוי ואמבטיה בעוצמה 5, טירת כרמל. מי אנחנו, איך עובדים איתנו ופרטי העסק.", about, [crumbs_schema("עלינו", "about"), {"@context": "https://schema.org", "@type": "AboutPage", "about": {"@id": SITE + "#business"}}])

  contact = header("contact") + '''
<div class="wall"><div class="wrap hero inner" style="grid-template-columns:1fr">
<div><ol class="crumbs"><li><a href="./">זיסו קרמיקה</a></li><li aria-current="page">צור קשר</li></ol>
<h1>צור קשר</h1><p>הכי מהר בוואטסאפ. אפשר גם להתקשר, לשלוח מייל, או פשוט להגיע לאולם.</p></div></div></div>
<main><section><div class="wrap visit">
<div><dl class="contact">
<div><dt>וואטסאפ</dt><dd><a href="https://wa.me/{wa}" target="_blank" rel="noopener" class="ltr">{phone}</a></dd></div>
<div><dt>טלפון</dt><dd><a class="ltr" href="tel:{phone_intl}">{phone}</a></dd></div>
<div><dt>אימייל</dt><dd><a class="ltr" href="mailto:{email}">{email}</a></dd></div>
<div><dt>כתובת</dt><dd>עוצמה 5, טירת כרמל</dd></div>
<div><dt>שעות פתיחה</dt><dd>{hours}</dd></div>
<div><dt>אינסטגרם</dt><dd><a href="https://www.instagram.com/ziso_ceramics/" target="_blank" rel="noopener" class="ltr">@ziso_ceramics</a></dd></div>
<div><dt>פייסבוק</dt><dd><a href="https://www.facebook.com/zisoceramics" target="_blank" rel="noopener" class="ltr">zisoceramics</a></dd></div>
</dl>
<p class="lede">{legal} · ח.פ. <span class="ltr">{cid}</span></p></div>
<div class="mapcard"><div><p class="eyebrow">ניווט</p><div class="addr">עוצמה 5<br>טירת כרמל</div></div>
<div class="actions"><a class="btn brass" href="https://waze.com/ul?q={addr}&navigate=yes" target="_blank" rel="noopener">ניווט בוויז</a>
<a class="btn ghost" href="https://www.google.com/maps/search/?api=1&query={addr}" target="_blank" rel="noopener">Google Maps</a></div></div>
</div></section></main>
'''.format(wa=WA, phone=PHONE, phone_intl=PHONE_INTL, email=EMAIL, hours=HOURS_HTML, legal=LEGAL, cid=COMPANY_ID, addr=ADDR_Q) + FOOTER
  write("contact.html", "צור קשר | זיסו קרמיקה, עוצמה 5 טירת כרמל", "וואטסאפ וטלפון 050-4770040, אימייל info@zisoceramics.com, כתובת עוצמה 5 טירת כרמל. ניווט בוויז ושעות פתיחה.", contact, [crumbs_schema("צור קשר", "contact"), {"@context": "https://schema.org", "@type": "ContactPage", "about": {"@id": SITE + "#business"}}])

  # Intake form page (Apps Script iframe) + thank-you page
  intake = header("tik") + '''
<div class="wall"><div class="wrap hero inner" style="grid-template-columns:1fr">
<div><ol class="crumbs"><li><a href="./">זיסו קרמיקה</a></li><li aria-current="page">תיק לקוח</li></ol>
<h1>פתיחת תיק לפרויקט חדש</h1><p>כמה פרטים על הבית והפרויקט, ואנחנו מגיעים לפגישה באולם כשכבר הכנו בשבילכם הצעות. לוקח שתי דקות.</p></div></div></div>
<main><section><div class="wrap">
<iframe id="intake" data-src="{intake}" title="טופס תיק לקוח" style="width:100%;min-height:1400px;border:0;background:var(--surface)" loading="lazy" allow="camera"></iframe>
<div id="intake-missing" class="panel" hidden><h2>הטופס נפתח בקרוב</h2><p>בינתיים אפשר לכתוב לנו בוואטסאפ ונפתח לכם תיק יחד.</p><a class="btn brass" href="https://wa.me/{wa}" target="_blank" rel="noopener">לוואטסאפ</a></div>
</div></section></main>
'''.format(intake=INTAKE_URL, wa=WA) + FOOTER
  write("tik-lakoach.html", "פתיחת תיק לקוח | זיסו קרמיקה", "ממלאים כמה פרטים על הפרויקט ומגיעים לאולם בטירת כרמל כשההצעות כבר מוכנות.", intake, [crumbs_schema("תיק לקוח", "tik-lakoach")])

  toda = header() + '''
<div class="wall"><div class="wrap hero inner" style="grid-template-columns:1fr">
<div><h1>תודה, קיבלנו</h1><p>התיק שלכם אצלנו. נחזור אליכם בוואטסאפ או בטלפון לתיאום ביקור באולם.</p>
<div class="actions"><a class="btn brass" href="./">לדף הבית</a><a class="btn ghost" href="calculator.html">בינתיים: מחשבון כמויות</a></div></div></div></div>
''' + FOOTER
  write("toda.html", "תודה | זיסו קרמיקה", "קיבלנו את הפרטים, נחזור אליכם לתיאום ביקור באולם.", toda, [], body_attrs=' data-lead="1"')

  # SEO files
  if GALLERY:
    gal = header("gallery") + '''
<div class="wall"><div class="wrap hero inner" style="grid-template-columns:1fr">
<div><ol class="crumbs"><li><a href="./">זיסו קרמיקה</a></li><li aria-current="page">עבודות</li></ol>
<h1>עבודות אחרונות</h1><p>ריצוף, חיפוי ואמבטיות שנבחרו אצלנו באולם בטירת כרמל, אצל לקוחות מחיפה, הקריות והכרמל. עוד בעמוד האינסטגרם שלנו.</p></div></div></div>
<main><section><div class="wrap">''' + gallery_html(GALLERY, lazy=True, videos=VIDEOS) + '''
<p style="margin-top:32px"><a class="btn" href="%s">לפגישת ייעוץ ועיצוב חינם</a> <a class="btn ghost" href="https://www.instagram.com/ziso_ceramics/" target="_blank" rel="noopener">Instagram</a></p>
</div></section></main>''' % WA_VISIT + FOOTER
    write("gallery.html", "עבודות אחרונות | זיסו קרמיקה", "תמונות של ריצוף, חיפוי ואמבטיות מלקוחות זיסו קרמיקה בטירת כרמל, חיפה והקריות.", gal, [crumbs_schema("עבודות", "gallery")])
  for name, title, desc, h1, lede, body in LEGAL_PAGES:
    write(name, title + " | זיסו קרמיקה", desc, header() + '''
<div class="wall"><div class="wrap hero inner" style="grid-template-columns:1fr">
<div><ol class="crumbs"><li><a href="./">זיסו קרמיקה</a></li><li aria-current="page">%s</li></ol>
<h1>%s</h1><p>%s</p></div></div></div>
<main id="main"><section><div class="wrap article"><article class="prose legal">%s</article>%s</div></section></main>
''' % (title, h1, lede, body, sidebar("כל המוצרים")) + FOOTER, [crumbs_schema(title, name[:-5])])
  urls = ["", "about.html", "contact.html", "calculator.html", "tik-lakoach.html", "accessibility.html", "privacy.html", "terms.html"] + (["gallery.html"] if GALLERY else []) + [c["slug"] + ".html" for c in CATS]
  open(os.path.join(DIST, "sitemap.xml"), "w").write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n%s</urlset>\n' %
    "".join("  <url><loc>%s%s</loc><lastmod>%s</lastmod></url>\n" % (SITE, u, TODAY) for u in urls))
  open(os.path.join(DIST, "robots.txt"), "w").write("User-agent: *\nAllow: /\nDisallow: /toda\nSitemap: %ssitemap.xml\n" % SITE)
  open(os.path.join(DIST, "CNAME"), "w").write("www.zisoceramics.com\n")
  open(os.path.join(DIST, "googlee191b4da733a4939.html"), "w").write("google-site-verification: googlee191b4da733a4939.html")  # Search Console

if __name__ == "__main__":
  build(); print(sorted(os.listdir(DIST)))
