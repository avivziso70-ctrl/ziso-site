# אתר zisoceramics.com (מחליף את Wix)

- `src/content.py`: כל הטקסטים (קטגוריות, שאלות נפוצות, פרטי העסק). עורכים כאן.
- `src/build.py`: בונה את האתר. הרצה: `python3 src/build.py` → `dist/`.
- `src/styles.css`, `src/site.js`: עיצוב וסקריפט (לוחות פורצלן בהירו, מחשבון אריחים).
- `dist/`: האתר המוכן להעלאה (GitHub Pages / Vercel / כל אירוח סטטי). כולל sitemap.xml, robots.txt, CNAME, 404.
- `preview.html` / `site-body.html`: דף הבית לתצוגה כארטיפקט ב-Claude (ללא עטיפת html).
- `ziso-site.zip`: ה-dist ארוז.

פתוחים: שעות פתיחה, שנת ייסוד, תמונות ולוגו, קישור לטופס תיק לקוח, אירוח (Vercel חוסם יצירת פרויקט; תוכנית: GitHub Pages).
