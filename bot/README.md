# העוזר של זיסו: בוט AI לפניות לקוחות

צ'אט באתר (ובהמשך וואטסאפ) שעונה מתוכן האתר ומקטלוג הפריטים, מחמם את הפנייה ושומר ליד. רץ על Claude (Anthropic API) מתוך Supabase Edge Function.

## קבצים
- `functions/ziso-bot/bot.ts`: הליבה, בלי תלות בערוץ. `runTurn(client, history, text, channel)` מחזיר טקסט + ליד (אם נשמר). כאן הכללים: בוט ולא אדם, בלי מחירים, טענות מאושרות בלבד, שאלות חימום (חדר, מ"ר, מועד, קבלן/מעצב), הצעת דומים מהקטלוג, בקשת שם וטלפון רק אחרי הסבר על השמירה.
- `functions/ziso-bot/index.ts`: נקודת הקצה לאתר. שומר שיחות ב-`chat_sessions`/`chat_messages`, מגביל 40 הודעות לשיחה ו-60 לשעה לכל גולש (hash של IP), כותב ליד דרך `public.upsert_lead` (ערוץ `site_form`, מקור "site chat bot").
- `functions/ziso-bot/knowledge.ts`: נוצר מ-`src/content.py` ומהמדריכים על ידי `build_knowledge.py`. להריץ אחרי כל שינוי תוכן.
- `functions/ziso-bot/catalog.ts` + `search.ts`: שמות פריטים ומשפחות בלבד מייצוא פריטים של פריוריטי, נוצר על ידי `build_catalog.py <xlsx>`. בלי מחיר, מלאי, עלות, ספק או מק"ט. הייצוא מוגבל ל-2,000 שורות, לכן הרשימה חלקית.
- `migrations/20261027_chat.sql`: הטבלאות ופונקציית הניקוי `chat_purge()` (90 יום, כמו שכתוב במדיניות הפרטיות).
- הווידג'ט באתר: `src/build.py` (CHAT_BTN, CHAT_PANEL), `src/site.js` (הלקוח), `src/styles.css`. מופיע רק כש-`CHAT_URL` ב-`src/content.py` לא ריק.

## פריסה
1. להריץ את המיגרציה ב-Supabase (ziso-whatsapp, ppnjosyraosrdephsksu).
2. לפרוס את הפונקציה `ziso-bot` עם `verify_jwt=false` (הקבצים: index.ts, bot.ts, knowledge.ts, catalog.ts, search.ts).
3. סוד `ANTHROPIC_API_KEY` ב-Supabase (אביב מדביק). בלי המפתח הפונקציה מחזירה 503 והווידג'ט מציג הפניה לוואטסאפ.
4. למזג ל-main: GitHub Pages מפרסם את `docs/`.

## וואטסאפ (אחרי אישור Meta)
`wa-webhook` יקרא ל-`runTurn(client, history, text, "whatsapp")` עם ההיסטוריה מ-`wa_messages` של אותו מספר, וישלח את התשובה דרך Graph API. הליד נכתב עם ערוץ `whatsapp`. הכללים זהים. לפני הפעלה: הודעת פתיחה שמסבירה שזה בוט ואיך מגיעים לאדם, וכיבוי אוטומטי כשנציג עונה מהאפליקציה (smb_message_echoes).

## עלות
Claude Opus 5.5 עם effort נמוך, הנחיות במטמון (cache). סדר גודל: אגורות בודדות להודעה, בדרך כלל מתחת ל-₪0.1 לשיחה. הקרדיטים: החשבון של אביב ב-Anthropic.
