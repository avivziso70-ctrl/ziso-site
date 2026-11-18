(function () {
  'use strict';
  var SB_URL = 'https://ppnjosyraosrdephsksu.supabase.co';
  var FN = SB_URL + '/functions/v1/shop';
  var sb = window.supabase ? supabase.createClient(SB_URL, 'sb_publishable_yjpTHQkvH5-l4v-HCcEj4w_ofAYpQmV', { auth: { persistSession: true, autoRefreshToken: true } }) : null;
  var PAGE = 48;
  var $ = function (id) { return document.getElementById(id); };
  var TEST = /[?&]test=1/.test(location.search);   // staff only: a ₪5 test order on the open store
  var state = { items: [], models: [], byKey: {}, byId: {}, live: false, ship: null, group: '', sub: '', color: '', q: '', sort: '', shown: PAGE, session: null };
  var cart = load();

  // ---------- catalogue brain: categories, models, colours ----------
  // Finishes the supplier prints at the end of a product name. One model in several finishes becomes one card.
  var COLORS = {
    'כרום': '#c9ced3', 'שחור מט': '#1d1d1f', 'שחור': '#1d1d1f', 'זהב מוברש': '#c8a45a', 'זהב מט': '#c8a45a', 'זהב מבריק': '#d9b354', 'זהב': '#d0aa55', 'ניקל מוברש': '#a9a8a2', 'ניקל מבריק': '#cfd2d4', 'ניקל כרום': '#c9ced3', 'כרום ניקל': '#c9ced3', 'כרום מוברש': '#b3b5b4', 'ניקל': '#bdbfbf', 'מוברש': '#a9a8a2', 'נירוסטה מוברש': '#a9a8a2',
    'רוז גולד מוברש': '#c98f7c', 'רוז גולד מט': '#c98f7c', 'רוז גולד': '#cf9684', 'רוז-גולד': '#cf9684', 'רוזגולד': '#cf9684', 'ברונזה': '#8a6a45', 'גאן מטאל': '#55585c',
    'לבן מבריק': '#ffffff', 'לבן מט': '#f1efe9', 'לבן': '#ffffff', 'אבן מט': '#b9b2a4', 'בטון כהה מט': '#6b6b69', 'בטון בהיר מט': '#b4b4b0', 'אפור גרפיט': '#4a4d50', 'גרפיט מט': '#3d4043', 'גרפיט': '#3d4043', 'אפור מט': '#8e8f8d', 'מוקה מט': '#7a6654', 'מוקה': '#7a6654', 'לאטה': '#cbb59a',
    'תכלת מט': '#a9c7d6', 'חאקי מט': '#8f8d6c', 'ורוד מט': '#e3b9b3', 'קרם': '#ece2cf', 'סלמון מט': '#e2a58f', 'ירוק מט': '#7f9a80', 'קשמיר מט': '#cdbfae', 'יסמין מט': '#efe9d8',
    'שחור מט קלקתא': '#2a2a2c', 'לבן מט קלקתא': '#eeeae2', 'גרפיט מוברש': '#55585c', 'סאטן מוברש': '#b0aea8', 'כחול קרח מט': '#bcd3de', 'אפור גרפיט מט': '#4a4d50',
    'גוונים מט': 'linear-gradient(135deg,#3d4043 0 25%,#7a6654 25% 50%,#cbb59a 50% 75%,#f1efe9 75%)'
  };
  var COLOR_NAMES = Object.keys(COLORS).sort(function (a, b) { return b.length - a.length; });
  var COLOR_RE = new RegExp('(?:\\s*[-,|]\\s*|\\s+)(' + COLOR_NAMES.join('|') + ')(?:\\s*\\([^)]*\\))?(?=\\s*(?:\\||$))');
  var SINK_SERIES = /^(רוז|נורית|ויקטוריה|סולי|אורלינס|מימוזה|ארתור|איילין|בוטיק|קוסמוס|רוקי|וונסה|ריקי)(\s|$)/;
  // [category, test on the product name, sub-categories]
  var TREE = [
    ['מראות', /מראה|מראת/, [['עם תאורת לד', /לד/], ['עגולות', /עגול/], ['מרובעות', /מרובע|מלבנ/]]],
    ['אסלות', /אסל|מונובלוק/, [['תלויות', /תלוי/], ['מונובלוק', /מונובלוק/]]],
    ['מקלחונים', /מקלחון|אמבטיון|WALK IN|דופן/i, [['חזית', /חזית/], ['פינתיים', /פינתי/], ['מעוגלים', /מעוגל/], ['אמבטיונים', /אמבטיון/], ['Walk in', /WALK IN/i]]],
    ['ארונות אמבטיה', /תחתון|ארון/, [['ארון עם כיור', /תחתון/], ['ארונות עמוד', /עמוד/]]],
    ['ברזים', /ברז|סוללה|מערכת קיר לכיור/, [['ברזי מטבח', /מטבח/], ['סוללות לאמבטיה', /סוללה|מהרצפה/], ['ברזי קיר', /קיר/], ['ברזי רחצה', /./]]],
    ['מקלחת', /ראש מקלחת|ראש טוש|ראש גשם|זרוע|מזלף|מולף|סט מקלחת|סט \d+ חלקים|מוט פינוק|מוט רחצה|מערכת|נקודת מים|צינור|אינטרפוץ|מתיזן/, [['סטים ומערכות', /סט מקלחת|סט \d+ חלקים|מערכת|מוט פינוק|מוט רחצה|Set/], ['אינטרפוץ ומתיזים', /אינטרפוץ|מתיזן/], ['ראשי מקלחת', /^(?!.*זרוע).*ראש (מקלחת|טוש|גשם)/], ['זרועות', /זרוע/], ['מזלפים וצינורות', /מזלף|מולף|צינור/], ['נקודות מים', /נקודת מים/]]],
    ['אביזרי אמבט', /קולב|מחזיק|מדף|סבוניה|דיספנסר|(^|\s)כוס(\s|$)|מעמד|מתל[הי]|(^|\s)תלי\s|מברשת|מתקן/, [['קולבים', /קולב/], ['מחזיקי נייר', /נייר/], ['מתלי מגבות', /מגבת|מגבות|תלי\s/], ['מדפים', /מדף/], ['סבוניות ודיספנסרים', /סבוניה|דיספנסר|סבון/], ['כוסות ומברשות', /כוס|מברשת/]]],
    ['כיורים', /כיור|קוריאן|ונטיל|ווטיל|סיפון/, [['ונטילים וסיפונים', /^(ונטיל|ווטיל|סיפון)/], ['כיורי מטבח', /מטבח|גרניט/], ['כיורי נירוסטה', /נירוסטה/], ['כיורי שירותים', /שירותים/], ['כיורים אינטגרליים', /אינטגרלי|קוריאן/], ['כיורים מונחים', /./]]]
  ];
  var OTHER = 'אביזרים ועוד';
  function classify(name, category) {
    for (var i = 0; i < TREE.length; i++) if (TREE[i][1].test(name)) return sub(TREE[i], name);
    if (/אסל/.test(category || '')) return sub(TREE[1], name);
    if (/כיור/.test(category || '') || SINK_SERIES.test(name)) return ['כיורים', 'כיורים מונחים'];
    return [OTHER, ''];
  }
  function sub(node, name) { for (var j = 0; j < node[2].length; j++) if (node[2][j][1].test(name)) return [node[0], node[2][j][0]]; return [node[0], '']; }
  function tidy(name) {
    return String(name || '').replace(/^כיורים מונחים לבחירה\s*-\s*/, '').replace(/אלומ(?:['׳’\-]\s*|\s+)(?=כסוף|שחור)/g, 'אלומיניום ').replace(/ווטיל/g, 'ונטיל').replace(/מימווה/g, 'מימוזה')
      .replace(/,?\s*גווני מט: ([^|]*)$/, function (t, list) { return ' - גוונים מט (' + list.trim() + ')'; }).replace(/\s+/g, ' ').trim();
  }
  function firstNum(s) { var m = /\d+(\.\d+)?/.exec(String(s || '')); return m ? Number(m[0]) : 1e9; }
  // Every catalogue row becomes a variant {item, attrs}; rows that are the same model in another colour, size, depth or top share one card.
  function buildModels(items) {
    var map = {}, list = [];
    items.forEach(function (it) {
      var name = tidy(it.name), attrs = {}, title = name, desc = '', m, size = it.size ? String(it.size).replace(/\s+/g, ' ').trim() : '';
      var cls = classify(name, it.category);
      if ((m = /^(.+?) (\d{2}) תחתון \+ (.+)$/.exec(name))) { title = 'ארון אמבטיה ' + m[1]; attrs['עומק'] = m[2] + ' ס״מ'; attrs['כיור / משטח'] = m[3]; if (size) attrs['רוחב'] = size; }
      else if ((m = /^(.+?) תחתון \+ (.+)$/.exec(name))) { title = 'ארון אמבטיה ' + m[1]; attrs['כיור / משטח'] = m[2]; if (size) attrs['רוחב'] = size; }
      else if (cls[0] === 'מראות') {
        // one mirror is listed again under every cabinet series and per height: one card, width and height as options
        title = name.replace(/^[^,]*? - (?=מראה)/, '').replace(/\s*\(סדרת [^)]*\)/, '').replace(/ - [^,\-]+$/, '');
        var hs = [], w = null, re = /,?\s*גובה(?: מראה)? (\d+)(?: ס"מ)?/g, x;
        while ((x = re.exec(title))) hs.push(x[1]);
        title = title.replace(re, '').replace(/[\s,]+$/, '');
        if ((x = /גובה (\d+)/.exec(size))) hs.push(x[1]);
        if ((x = /רוחב (\d+)/.exec(size)) || (x = /^(\d+)(?: ס"מ)?$/.exec(size))) w = x[1];
        if (w) attrs['רוחב'] = w + ' ס״מ'; else if (size) attrs['מידה'] = size;
        if (hs.length) attrs['גובה'] = hs[hs.length - 1] + ' ס״מ';
      }
      else if (/^ארון עמוד/.test(name) && (m = /^([^,]+), (.+)$/.exec(name))) { title = m[1]; desc = m[2]; if (size) attrs['מידה'] = size; }
      else if (cls[0] === 'מקלחונים') {
        // "model - description": the card shows the model, the description goes under it, the size becomes an option
        var nm = name.replace(/ - מחיר למידה .*$/, ''), i = nm.indexOf(' - ');
        if (i > 0) { var a = nm.slice(0, i), b = nm.slice(i + 3); if (/מקלחון|אמבטיון|דופן/.test(a)) { title = a; desc = b; } else { var c = b.indexOf(', '); title = a + ' - ' + (c > 0 ? b.slice(0, c) : b); desc = c > 0 ? b.slice(c + 2) : ''; } }
        else if ((i = nm.indexOf(', ')) > 0) { title = nm.slice(0, i); desc = nm.slice(i + 2); }
        else title = nm;
        var num = /\s(\d{2,3}(?:\.\d)?(?:\/\d{2,3}(?:\.\d)?)?)(?: ס"מ)?(?=\s|\)|$)/.exec(title), base = /במידות (\d+)/.exec(desc);
        if (num) { title = title.split(num[1]).join('').replace(/ ס"מ(?=\s|$)/, '').replace(/\s+\)/g, ')').replace(/\s+/g, ' ').trim(); attrs['מידה'] = num[1] + ' ס״מ'; }
        else if (base) { attrs['מידה'] = 'בסיס ' + base[1] + (size ? ' (פתח ' + size + ')' : ''); desc = desc.replace(/,? ?מתאים לבסיס[^,]*במידות \d+/, '').replace(/^, /, ''); }
        else if (size) attrs['מידה'] = size;
        if (num && size && !/כל המידות/.test(size)) desc = (desc ? desc + ' · ' : '') + size;
      }
      else {
        if (cls[0] === 'כיורים') {
          name = name.replace(/, ניתן לתליה ע"ג קיר$/, function (t) { desc = 'ניתן לתליה על הקיר'; return ''; })
            .replace(/^(\S+) - כיור רחצה מונח/, 'כיור $1').replace(/^כיור רחצה מונח (\S+)/, 'כיור $1').replace(/^(\S+) כיור רחצה מונח/, 'כיור $1')
            .replace(/^\S+(?: \S+)? (\d{2,3}(?:\/\d{2,3})?) (.+?) - ((?:כיור|משטח) .+)$/, '$3 $1 - $2');
        }
        if ((m = COLOR_RE.exec(name))) { attrs['צבע'] = m[1]; title = (name.slice(0, m.index) + name.slice(m.index + m[0].length)).replace(/\s+\|\s*$/, '').trim(); if (/גוונים מט/.test(m[1]) && /\(([^)]*)\)/.test(m[0])) desc = 'גוונים: ' + /\(([^)]*)\)/.exec(m[0])[1]; } else title = name;
        if (cls[0] === 'כיורים' && (m = /\s(\d{2,3}(?:\/\d{2,3})?)(?=\s|$)/.exec(title)) && !/שירותים/.test(title)) { title = title.replace(m[0], '').trim(); attrs['מידה'] = m[1] + ' ס״מ'; if (size) desc = (desc ? desc + ' · ' : '') + size; }
        else if (size) attrs['מידה'] = size;
      }
      if (cls[0] === 'כיורים' && !/כיור|משטח|קוריאן|ונטיל|ווטיל|סיפון/.test(title)) title = 'כיור ' + title;
      var key = cls[0] + '|' + title.toLowerCase().replace(/["'״׳.,()\-|\/]/g, ' ').replace(/\s+/g, ' ').trim();
      var mod = map[key];
      if (!mod) { mod = map[key] = { key: key, title: title, group: cls[0], sub: cls[1], variants: [] }; list.push(mod); }
      var sig = JSON.stringify(attrs), dup = null;
      mod.variants.forEach(function (v) { if (v.sig === sig) dup = v; });
      if (dup) {  if ((!dup.item.img && it.img) || (!!dup.item.img === !!it.img && it.id > dup.item.id)) dup.item = it; } // the same product listed in two catalogues: keep one
      else mod.variants.push({ item: it, attrs: attrs, sig: sig, desc: desc });
    });
    list.forEach(function (mod) {
      var dims = {};
      mod.variants.forEach(function (v) { Object.keys(v.attrs).forEach(function (k) { (dims[k] = dims[k] || []).indexOf(v.attrs[k]) < 0 && dims[k].push(v.attrs[k]); }); });
      mod.dims = ['צבע', 'עומק', 'כיור / משטח', 'רוחב', 'גובה', 'מידה'].filter(function (k) { return dims[k] && dims[k].length > 1; }).map(function (k) {
        if (k !== 'צבע' && k !== 'כיור / משטח') dims[k].sort(function (a, b) { return firstNum(a) - firstNum(b); });
        return { name: k, values: dims[k] };
      });
      mod.colors = dims['צבע'] || [];
      mod.min = Math.min.apply(null, mod.variants.map(function (v) { return v.item.price; }));
      mod.max = Math.max.apply(null, mod.variants.map(function (v) { return v.item.price; }));
      mod.img = mod.variants.some(function (v) { return v.item.img; });
      mod.cur = pick(mod, {});
      mod.hay = fold([mod.title, mod.group, mod.sub].concat(mod.variants.map(function (v) { return [v.item.name, v.item.code, v.item.category, v.item.size, v.attrs['צבע']].join(' '); })).join(' '));
      mod.words = mod.hay.split(' ').filter(function (w, i, a) { return w.length > 2 && a.indexOf(w) === i; });
    });
    return list;
  }
  // The variant that best fits the wanted options; `lead` is the option the shopper just changed and always wins.
  function pick(mod, want, lead) {
    var best = 0, score = -1;
    mod.variants.forEach(function (v, i) {
      if (lead && v.attrs[lead] !== want[lead]) return;
      var s = (v.item.img ? 0.5 : 0) - i / 1000;
      Object.keys(want).forEach(function (k) { if (v.attrs[k] === want[k]) s += 2; });
      if (s > score) { score = s; best = i; }
    });
    return best;
  }

  // ---------- free-language search ----------
  var FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
  function fold(s) {
    return String(s || '').toLowerCase().replace(/[֑-ׇ]/g, '').replace(/[ךםןףץ]/g, function (c) { return FINALS[c]; }).replace(/["'״׳`’]/g, '').replace(/[^0-9a-zא-ת.]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  var STOP = {}; 'אני מחפש מחפשת רוצה צריך צריכה יש לכם לכן אפשר בבקשה משהו איזה של עם את זה זו גם או על כמו שיהיה שתהיה לי לנו בצבע צבע מידה במידה גודל בגודל סמ ס.מ שקל שקלים שח ש.ח חדש חדשה יפה לבית'.split(' ').forEach(function (w) { STOP[fold(w)] = 1; });
  // everyday words -> the words the catalogue uses
  var SYN = { 'שירותים': 'אסל', 'אסלה': 'אסל', 'אסלות': 'אסל', 'ניאגרה': 'אסל', 'טוש': 'מקלחת', 'דוש': 'מקלחת', 'ראי': 'מראה', 'מראות': 'מראה', 'שידה': 'ארונ', 'ארונית': 'ארונ', 'ארונות': 'ארונ', 'קערה': 'כיור', 'כיורים': 'כיור', 'ברזים': 'ברז', 'מקלחונים': 'מקלחונ', 'זהוב': 'זהב', 'מוזהב': 'זהב', 'כסוף': 'ניקל', 'כסף': 'ניקל', 'נירוסטה': 'ניקל', 'אפור': 'גרפיט', 'ורוד': 'רוז', 'תאורה': 'לד', 'מואר': 'לד', 'מוארת': 'לד', 'led': 'לד', 'נשלפ': 'נשלפ', 'אמבט': 'אמבט', 'אמבטיה': 'אמבט', 'גשם': 'ראש מקלחת', 'טלפון': 'מזלפ', 'מזלף': 'מזלפ', 'מולף': 'מזלפ', 'מולפ': 'מזלפ', 'עגול': 'עגול', 'עגולה': 'עגול', 'מרובעת': 'מרובע', 'ריבועי': 'מרובע', 'תלויה': 'תלוי', 'פינתי': 'פינתי', 'פינה': 'פינתי' };
  Object.keys(SYN).forEach(function (k) { var f = fold(k); if (f !== k) { SYN[f] = SYN[k]; } });
  function near(a, b) { // one typo apart
    if (Math.abs(a.length - b.length) > 1) return false;
    var i = 0, j = 0, miss = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++miss > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return miss + (a.length - i) + (b.length - j) <= 1;
  }
  function forms(t) { // the word as typed, without a Hebrew prefix letter, without a plural ending, and its catalogue synonym
    var out = [t];
    if (t.length > 3 && /^[הלבושמכ]/.test(t)) out.push(t.slice(1));
    out.slice().forEach(function (w) { if (w.length > 4 && /(ימ|ות)$/.test(w)) out.push(w.slice(0, -2)); else if (w.length > 3 && /[הת]$/.test(w)) out.push(w.slice(0, -1)); });
    out.slice().forEach(function (w) { if (SYN[w]) out.push(fold(SYN[w])); });
    return out;
  }
  function parseQuery(raw) {
    var q = { tokens: [], min: null, max: null, sort: '' }, text = ' ' + fold(raw) + ' ', m;
    if ((m = /בינ (\d+) ל ?(\d+)/.exec(text))) { q.min = +m[1]; q.max = +m[2]; text = text.replace(m[0], ' '); }
    if ((m = /(?:עד|מתחת ל|פחות מ|לא יותר מ|מקסימומ) ?(\d+)/.exec(text))) { q.max = +m[1]; text = text.replace(m[0], ' '); }
    if ((m = /(?:מעל|יותר מ|לפחות|מ) ?(\d{3,})/.exec(text))) { q.min = +m[1]; text = text.replace(m[0], ' '); }
    if (/הכי זול|זול|זולה|זולימ|משתלמ/.test(text)) { q.sort = 'asc'; text = text.replace(/הכי זול\S*|זול\S*|משתלמ\S*/g, ' '); }
    if (/הכי יקר|יוקרתי|יוקרה|פרימיומ/.test(text)) { q.sort = 'desc'; text = text.replace(/הכי יקר\S*|יוקרתי\S*|יוקרה|פרימיומ/g, ' '); }
    text.split(' ').forEach(function (t) { if (t && !STOP[t] && !(t.length === 1 && !/\d/.test(t))) q.tokens.push(forms(t)); });
    return q;
  }
  function tokenScore(mod, alts) {
    for (var i = 0; i < alts.length; i++) if (mod.hay.indexOf(alts[i]) >= 0) return i === 0 ? 3 : 2;
    for (i = 0; i < alts.length; i++) if (alts[i].length >= 4) for (var j = 0; j < mod.words.length; j++) if (near(alts[i], mod.words[j])) return 1;
    return 0;
  }

  function money(n) { return '₪' + Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function load() { try { return JSON.parse(localStorage.getItem('ziso_cart') || '{}') || {}; } catch (e) { return {}; } }
  function save() { try { localStorage.setItem('ziso_cart', JSON.stringify(cart)); } catch (e) {} renderCount(); pushCart(); }
  // measurement (track.js): runs only after cookie consent; product data and totals only, never personal details
  function trk(ev, x) { if (window.shopTrack) window.shopTrack(ev, x); }
  function gi(it, q) { return { item_id: String(it.id), item_name: String(it.name || '').slice(0, 100), price: Number(it.price), quantity: q }; }
  function cartData() { var items = [], v = 0; Object.keys(cart).forEach(function (id) { var it = state.byId[id]; if (!it) return; items.push(gi(it, cart[id])); v += it.price * cart[id]; }); return { currency: 'ILS', value: Math.round(v * 100) / 100, items: items }; }
  function post(body, jwt) {
    var h = { 'content-type': 'application/json' };
    if (jwt) h.authorization = 'Bearer ' + jwt;
    return fetch(FN, { method: 'POST', headers: h, body: JSON.stringify(body) }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }

  function start() {
    var sess = sb ? sb.auth.getSession().then(function (r) { return r.data && r.data.session; }) : Promise.resolve(null);
    sess.then(function (s) { state.session = s; return post({ action: 'catalog' }, s && s.access_token); }).then(function (c) {
      $('loading').hidden = true;
      if (!c || !c.ok) { $('loading').hidden = false; $('loading').textContent = 'לא הצלחנו לטעון את המוצרים. נסו לרענן, או התקשרו 050-4770040.'; return; }
      state.live = !!c.live; state.ship = c.ship || null;
      document.querySelectorAll('#leadText,.leadText').forEach(function (e) { e.textContent = c.lead_text; });
      state.items = c.items; state.byId = {}; state.items.forEach(function (it) { state.byId[it.id] = it; });
      state.models = buildModels(state.items); state.byKey = {}; state.models.forEach(function (m, i) { m.n = i; state.byKey[i] = m; });
      // items that left the catalog drop out of a saved cart
      Object.keys(cart).forEach(function (id) { if (!state.byId[id]) delete cart[id]; }); save();
      if (state.ship) $('delivRow').hidden = false;
      if (!state.live || (TEST && state.session)) { $('previewBar').hidden = false; if (state.live) $('previewBar').textContent = 'מצב בדיקה לצוות: התשלום בהזמנה הזו הוא ₪5 בלבד, והיא לא יוצאת לספק.'; }
      if (c.gated) { $('gate').hidden = false; return; }
      openStore(); account();
    });
  }
  function openStore() { $('gate').hidden = true; $('store').hidden = false; render(); }

  function chip(label, attr, value, on, extra) { return '<button type="button" aria-pressed="' + !!on + '" ' + attr + '="' + esc(value) + '">' + (extra || '') + esc(label) + '</button>'; }
  function dot(color) { return '<span class="dot" aria-hidden="true" style="background:' + COLORS[color] + '"></span>'; }
  function search() {
    var q = parseQuery(state.q), strict = [], loose = [];
    state.models.forEach(function (m) {
      if (q.max != null && m.min > q.max) return;
      if (q.min != null && m.max < q.min) return;
      var score = 0, hit = 0;
      q.tokens.forEach(function (alts) { var sc = tokenScore(m, alts); if (sc) { hit++; score += sc; } });
      if (hit === q.tokens.length) strict.push([m, score]); else if (hit) loose.push([m, hit * 10 + score]);
    });
    // nothing has every word: show what comes closest instead of an empty page
    var pool = strict.length || !q.tokens.length ? strict : loose;
    return { rows: pool, close: !strict.length && q.tokens.length > 0 && loose.length > 0, sort: q.sort };
  }
  function filtered() {
    var res = search(), counts = {}, subs = {}, colors = {};
    var rows = res.rows.filter(function (r) {
      var m = r[0];
      counts[m.group] = (counts[m.group] || 0) + 1;
      if (state.group && m.group !== state.group) return false;
      if (m.sub) subs[m.sub] = (subs[m.sub] || 0) + 1;
      if (state.sub && m.sub !== state.sub) return false;
      m.colors.forEach(function (c) { colors[c] = (colors[c] || 0) + 1; });
      return !state.color || m.colors.indexOf(state.color) >= 0;
    });
    var sort = state.sort || res.sort;
    rows.sort(function (a, b) {
      if (sort === 'asc') return a[0].min - b[0].min;
      if (sort === 'desc') return b[0].max - a[0].max;
      return (b[1] - a[1]) || ((b[0].img ? 1 : 0) - (a[0].img ? 1 : 0)) || (a[0].n - b[0].n);
    });
    return { list: rows.map(function (r) { return r[0]; }), counts: counts, subs: subs, colors: colors, close: res.close, total: res.rows.length };
  }
  // A short inviting line per product, built only from what we know: the kind of product and its finish. No specs are invented.
  var BLURB = {
    'ברזי מטבח': ['ברז מטבח שעובד קשה כל יום ונראה טוב ליד כל כיור.', 'הברז שסביבו מתנהל המטבח: נוח לשטיפה, נקי במראה.'],
    'סוללות לאמבטיה': ['סוללה עם נוכחות, לאמבט שנעים להיכנס אליו בסוף היום.'],
    'ברזי קיר': ['ברז מהקיר משאיר את המשטח פנוי ונקי, ונותן לכיור מראה של מלון בוטיק.'],
    'ברזי רחצה': ['הפרט הקטן שסוגר את המראה של חדר הרחצה, ונוגעים בו כל בוקר.', 'ברז רחצה בקו נקי, שעושה את ההבדל ליד הכיור.'],
    'סטים ומערכות': ['מערכת מקלחת שלמה, כדי שכל מקלחת תרגיש קצת כמו חופשה.', 'כל מה שהמקלחת צריכה בסט אחד, באותו קו עיצובי.'],
    'אינטרפוץ ומתיזים': ['הלב של המקלחת: שליטה נוחה בזרם, בקו נקי על הקיר.'],
    'ראשי מקלחת': ['ראש מקלחת שעוטף במים, לפתיחה טובה של היום.', 'זרם רחב ונעים מלמעלה, כמו גשם פרטי.'],
    'זרועות': ['זרוע שמציבה את ראש המקלחת בדיוק בגובה ובמרחק הנכונים.'],
    'מזלפים וצינורות': ['נוח לאחיזה, לשטיפה מדויקת ולניקוי קל של המקלחת.'],
    'נקודות מים': ['נקודת חיבור למזלף, נקייה ושקטה על הקיר.'],
    'קולבים': ['לחלוק ולמגבת, בדיוק במקום שבו מושיטים יד.', 'קולב קטן שעושה סדר גדול מאחורי הדלת.'],
    'מחזיקי נייר': ['פרט קטן ומוקפד שמשלים את חדר השירותים.'],
    'מתלי מגבות': ['המגבת פרושה, יבשה ובהישג יד כשיוצאים מהמקלחת.'],
    'מדפים': ['מסדר את הבקבוקים והתכשירים, ומשאיר את האמבטיה נקייה לעין.'],
    'סבוניות ודיספנסרים': ['לסבון תמיד יש מקום, והמשטח נשאר יבש ומסודר.'],
    'כוסות ומברשות': ['פרט יומיומי שנראה טוב על השיש ושומר על סדר.'],
    'ונטילים וסיפונים': ['השלמה לכיור: פרט שרואים כל יום, אז כדאי שיהיה יפה.'],
    'כיורי מטבח': ['כיור מרווח לעבודה של כל יום, מהסירים הגדולים ועד כוס הקפה.'],
    'כיורי נירוסטה': ['נירוסטה, הקלאסיקה של מטבח שעובדים בו באמת.'],
    'כיורי שירותים': ['כיור קומפקטי לחדר השירותים, כשכל סנטימטר חשוב.'],
    'כיורים מונחים': ['כיור מונח שהופך את משטח הרחצה למרכז החדר.', 'צורה נקייה שיושבת על המשטח כמו פריט עיצוב.'],
    'אביזרי אמבט': ['אביזר משלים לחדר הרחצה, באותו קו עיצובי.'], 'כיורים': ['כיור לחדר הרחצה, בקו נקי ונעים לעין.'], 'ברזים': ['ברז בקו נקי, שעושה את ההבדל ליד הכיור.'], 'מקלחת': ['פרט שמשדרג את המקלחת של כל יום.']
  };
  var FINISH = [[/שחור/, 'בשחור, לקו חד ומודרני'], [/זהב|ברונזה|נחושת|רוז/, 'בגוון חם שמוסיף עומק לחדר'], [/ניקל|מוברש|אפור|גרפיט|גאן/, 'בגימור מוברש, רגוע ואלגנטי'], [/כרום|מבריק/, 'בכרום מבריק, קלאסי תמיד'], [/לבן/, 'בלבן נקי ורענן']];
  function blurb(m, v) {
    var list = BLURB[m.sub] || BLURB[m.group]; if (!list) return '';
    var h = 0, t = m.title; for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    var text = list[h % list.length];
    if (/נשלף/.test(t)) text += ' עם ראש נשלף שמגיע לכל פינה בכיור.';
    var c = v.attrs['צבע'] || '', fin = '';
    for (var k = 0; k < FINISH.length; k++) if (FINISH[k][0].test(c)) { fin = FINISH[k][1]; break; }
    if (fin) text += ' כאן ' + fin + '.';
    else if (m.colors.length > 1) text += ' בוחרים את הגימור שמתאים לבית.';
    return text;
  }
  function card(m) {
    var v = m.variants[m.cur], it = v.item, opts = '', controls = '';
    for (var n = 1; n <= 10; n++) opts += '<option>' + n + '</option>';
    m.dims.forEach(function (d) {
      var id = 'o' + m.n + '_' + d.name.replace(/[^א-ת]/g, '');
      if (d.name === 'צבע') {
        controls += '<div class="opt" role="group" aria-label="צבע"><span class="small">צבע: <b>' + esc(v.attrs['צבע'] || '') + '</b></span><div class="sw">' + d.values.map(function (c) {
          return '<button type="button" class="swatch" data-m="' + m.n + '" data-dim="צבע" data-val="' + esc(c) + '" aria-pressed="' + (v.attrs['צבע'] === c) + '" aria-label="' + esc(c) + '" title="' + esc(c) + '">' + dot(c) + '</button>';
        }).join('') + '</div></div>';
      } else {
        controls += '<label class="opt" for="' + id + '"><span class="small">' + esc(d.name) + '</span><select id="' + id + '" data-m="' + m.n + '" data-dim="' + esc(d.name) + '">' + d.values.map(function (x) {
          return '<option' + (v.attrs[d.name] === x ? ' selected' : '') + ' value="' + esc(x) + '">' + esc(x) + '</option>';
        }).join('') + '</select></label>';
      }
    });
    var facts = [];
    Object.keys(v.attrs).forEach(function (k) { if (!m.dims.some(function (d) { return d.name === k; })) facts.push(k + ': ' + v.attrs[k]); });
    if (it.code) facts.push('מק״ט ' + it.code);
    return '<li class="card" id="m' + m.n + '"><div class="ph">' + (it.img ? '<img loading="lazy" src="' + esc(it.img) + '" alt="' + esc(m.title) + '">' : '<span class="none" aria-hidden="true">זיסו</span>') +
      (m.variants.length > 1 ? '<span class="badge">' + (m.colors.length > 1 ? m.colors.length + ' צבעים' : m.variants.length + ' אפשרויות') + '</span>' : '') + '</div>' +
      '<div class="body"><span class="kicker">' + esc(m.sub || m.group) + '</span><h2>' + esc(m.title) + '</h2>' +
      (function (b) { return b ? '<p class="blurb">' + esc(b) + '</p>' : ''; })(blurb(m, v)) + (facts.length ? '<span class="small">' + esc(facts.join(' · ')) + '</span>' : '') + (v.desc ? '<p class="desc">' + esc(v.desc) + '</p>' : '') + controls +
      '<div class="price" aria-live="polite">' + money(it.price) + ' <small>כולל מע״מ</small></div>' +
      '<p class="perks"><span>אחריות יבואן</span> · <span>משלוח או איסוף חינם</span></p>' +
      '<div class="add"><select aria-label="כמות" data-qty="' + m.n + '">' + opts + '</select>' +
      '<button class="btn brass" type="button" data-add="' + m.n + '">הוספה לסל</button></div></div></li>';
  }
  function render() {
    var f = filtered(), all = 0;
    Object.keys(f.counts).forEach(function (k) { all += f.counts[k]; });
    var groups = TREE.map(function (t) { return t[0]; }).concat([OTHER]).filter(function (g) { return f.counts[g] || state.group === g; });
    $('chips').innerHTML = chip('הכל (' + all + ')', 'data-g', '', !state.group) + groups.map(function (g) { return chip(g + ' (' + (f.counts[g] || 0) + ')', 'data-g', g, state.group === g); }).join('');
    var subNames = Object.keys(f.subs);
    $('subs').hidden = !state.group || subNames.length < 2;
    $('subs').innerHTML = chip('כל ה' + state.group, 'data-s', '', !state.sub) + subNames.map(function (x) { return chip(x, 'data-s', x, state.sub === x); }).join('');
    var colorNames = COLOR_NAMES.filter(function (c) { return f.colors[c]; }).sort(function (a, b) { return f.colors[b] - f.colors[a]; });
    $('colors').hidden = colorNames.length < 2 && !state.color;
    $('colors').innerHTML = chip('כל הצבעים', 'data-c', '', !state.color) + colorNames.map(function (c) { return chip(c, 'data-c', c, state.color === c, dot(c)); }).join('');
    if (state.color) f.list.forEach(function (m) { if (m.variants[m.cur].attrs['צבע'] !== state.color) m.cur = pick(m, { 'צבע': state.color }, 'צבע'); });
    $('grid').innerHTML = f.list.slice(0, state.shown).map(card).join('');
    $('meta').textContent = !f.list.length ? '' : (f.close ? 'לא מצאנו בדיוק את זה. אלה התוצאות הקרובות ביותר: ' : '') + f.list.length.toLocaleString('he-IL') + ' דגמים';
    if (!f.list.length) $('grid').innerHTML = '<li class="empty" style="grid-column:1/-1">לא מצאנו מוצר כזה. נסו לתאר אחרת, למשל "ברז שחור לכיור" או "מראה עגולה עד 500", או <a href="https://wa.me/972504770040">שאלו אותנו בוואטסאפ</a>.</li>';
    $('moreBtn').hidden = f.list.length <= state.shown;
  }
  function renderCount() { var n = 0; Object.keys(cart).forEach(function (k) { n += cart[k]; }); $('cartCount').textContent = n; }

  function renderCart() {
    var ids = Object.keys(cart).filter(function (id) { return state.byId[id]; });
    if (!ids.length) { $('lines').innerHTML = '<p class="empty">הסל ריק.</p>'; $('totals').innerHTML = ''; $('checkout').hidden = true; return; }
    var sum = 0;
    $('lines').innerHTML = ids.map(function (id) {
      var it = state.byId[id], q = cart[id]; sum += it.price * q;
      return '<div class="line">' + (it.img ? '<img src="' + esc(it.img) + '" alt="">' : '<span class="thumb"></span>') +
        '<div><div>' + esc(it.name) + '</div><div class="small">' + money(it.price) + ' ליחידה' + (it.size ? ' · ' + esc(it.size) : '') + '</div></div>' +
        '<div class="q"><button type="button" data-dec="' + id + '" aria-label="הפחתה">−</button><span aria-live="polite">' + q + '</span><button type="button" data-inc="' + id + '" aria-label="הוספה">+</button></div></div>';
    }).join('');
    var deliv = document.querySelector('input[name=delivery]:checked');
    var nb = 0, nh = 0, S = state.ship; ids.forEach(function (id) { var c = state.byId[id].big; if (c === 'b') nb += cart[id]; else if (c === 'h') nh += cart[id]; });
    var ship = !S ? 0 : (!nb && !nh) ? Number(S.small) : nh * Number(S.heavy) + (nb ? Number(S.sink) + (nb - 1) * Number(S.extra_sink || 0) : 0);
    if (state.ship) $('delivFee').textContent = money(ship);
    var fee = deliv && deliv.value === 'delivery' ? ship : 0;
    $('totals').innerHTML = '<div class="tot"><span>מוצרים</span><span>' + money(sum) + '</span></div>' +
      '<div class="tot"><span>' + (fee ? 'משלוח עד הבית' : 'איסוף עצמי') + '</span><span>' + (fee ? money(fee) : 'ללא עלות') + '</span></div>' +
      '<div class="tot big"><span>סה״כ לתשלום (כולל מע״מ)</span><span>' + money(sum + fee) + '</span></div>' +
      (state.live ? '' : '<p class="small">תצוגה מקדימה: בתשלום יחויבו ₪5 בדיקה בלבד.</p>');
    $('checkout').hidden = false;
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.dataset.add) {
      var mod = state.byKey[t.dataset.add], id = mod.variants[mod.cur].item.id, sel = document.querySelector('[data-qty="' + mod.n + '"]');
      var addQ = Number(sel ? sel.value : 1), addIt = state.byId[id];
      cart[id] = Math.min(50, (cart[id] || 0) + addQ); save();
      if (addIt) trk('add_to_cart', { currency: 'ILS', value: addIt.price * addQ, items: [gi(addIt, addQ)] });
      t.textContent = 'נוסף ✓'; setTimeout(function () { t.textContent = 'הוספה לסל'; }, 1400);
    } else if (t.dataset.inc) { cart[t.dataset.inc] = Math.min(50, cart[t.dataset.inc] + 1); save(); renderCart(); }
    else if (t.dataset.dec) { if (--cart[t.dataset.dec] <= 0) delete cart[t.dataset.dec]; save(); renderCart(); }
    else if (t.dataset.dim) choose(t.dataset.m, t.dataset.dim, t.dataset.val, true);
    else if (t.dataset.g !== undefined) { state.group = t.dataset.g; state.sub = ''; state.shown = PAGE; render(); refocus('[data-g="' + t.dataset.g + '"]'); }
    else if (t.dataset.s !== undefined) { state.sub = t.dataset.s; state.shown = PAGE; render(); refocus('[data-s="' + t.dataset.s + '"]'); }
    else if (t.dataset.c !== undefined) { state.color = t.dataset.c; state.shown = PAGE; render(); refocus('[data-c="' + t.dataset.c + '"]'); }
    else if (t.hasAttribute('data-close')) $('cartDlg').close();
  });
  // keyboard users keep their place after the chips are redrawn
  function refocus(sel) { var el = document.querySelector(sel); if (el) el.focus(); }
  // One option of a model changed: find the matching variant and redraw only that card.
  function choose(n, dim, val, fromSwatch) {
    var mod = state.byKey[n], want = {}, cur = mod.variants[mod.cur].attrs;
    Object.keys(cur).forEach(function (k) { want[k] = cur[k]; }); want[dim] = val;
    mod.cur = pick(mod, want, dim);
    var li = $('m' + mod.n); if (!li) return;
    li.outerHTML = card(mod);
    refocus(fromSwatch ? '#m' + mod.n + ' .swatch[aria-pressed=true]' : '#m' + mod.n + ' select[data-dim="' + dim + '"]');
  }
  document.addEventListener('change', function (e) { var t = e.target; if (t.matches && t.matches('select[data-dim]')) choose(t.dataset.m, t.dataset.dim, t.value, false); });
  $('cartBtn').addEventListener('click', function () { renderCart(); $('cartDlg').showModal(); if (Object.keys(cart).length) trk('view_cart', cartData()); });
  $('moreBtn').addEventListener('click', function () { state.shown += PAGE; render(); });
  var tm, tmS; $('q').addEventListener('input', function (e) { clearTimeout(tm); tm = setTimeout(function () { state.q = e.target.value; state.shown = PAGE; render(); }, 150);
    clearTimeout(tmS); var term = e.target.value.trim(); if (term.length >= 2) tmS = setTimeout(function () { trk('search', { search_term: term.slice(0, 60) }); }, 1500); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
  document.querySelectorAll('input[name=delivery]').forEach(function (r) { r.addEventListener('change', function () { $('addr').hidden = r.value !== 'delivery' || !r.checked; renderCart(); }); });

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); var f = e.target; $('loginMsg').textContent = '';
    sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value }).then(function (r) {
      if (r.error || !r.data.session) { $('loginMsg').textContent = 'הכניסה נכשלה. בדקו מייל וסיסמה.'; return; }
      state.session = r.data.session; $('gate').hidden = true; $('loading').hidden = false; start();
    });
  });

  $('checkout').addEventListener('submit', function (e) {
    e.preventDefault(); var f = e.target, msg = $('payMsg'); msg.className = 'msg'; msg.textContent = '';
    var bad = function (el, text) { msg.className = 'msg err'; msg.textContent = text; el.focus(); return false; };
    var phone = f.phone.value.replace(/\D/g, '');
    if (f.name.value.trim().length < 2) return bad(f.name, 'נא למלא שם מלא.');
    if (!/^0(5\d|[2-9])\d{7}$/.test(phone)) return bad(f.phone, 'נא למלא מספר טלפון תקין.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.value.trim())) return bad(f.email, 'נא למלא כתובת מייל תקינה.');
    var deliv = f.delivery.value;
    if (deliv === 'delivery' && (f.address.value.trim().length < 3 || f.city.value.trim().length < 2)) return bad(f.address, 'נא למלא כתובת ועיר למשלוח.');
    if (!f.terms.checked) return bad(f.terms, 'כדי להמשיך יש לאשר את התקנון ותנאי הביטול.');
    var items = Object.keys(cart).map(function (id) { return { id: Number(id), qty: cart[id] }; });
    var bought = cartData(); trk('begin_checkout', bought);
    $('payBtn').disabled = true; msg.textContent = 'פותחים את דף התשלום המאובטח…';
    var jwt = state.session && state.session.access_token;
    post({ action: 'checkout', items: items, name: f.name.value, phone: phone, email: f.email.value, delivery: deliv, address: f.address.value, city: f.city.value, notes: f.notes.value, terms: true, marketing: f.marketing.checked, frame: !!window.ZisoPay, test: TEST && !!jwt, session: sess }, jwt).then(function (r) {
      if (!r.ok) { $('payBtn').disabled = false; msg.className = 'msg err'; msg.textContent = r.error || 'משהו השתבש. נסו שוב או התקשרו 050-4770040.'; return; }
      try { localStorage.setItem('ziso_last_order', r.token); } catch (x) {}
      if (r.session) { setSess(r.session); $('accLabel').textContent = f.name.value.trim().split(/\s+/)[0]; me = { email: f.email.value.trim(), name: f.name.value.trim(), phone: phone, orders: [], cart: {} }; }
      // payment inside the page (ZisoPay); the Tranzila link page is the fallback while a pay token is not given
      if (!r.pay || !window.ZisoPay) { cart = {}; save(); location.href = r.pr_link; return; }
      var mail = f.email.value.trim();
      step('pay'); $('payOrder').textContent = 'הזמנה ' + r.order + (r.test ? ' · תשלום בדיקה' : '');
      payUi = window.ZisoPay.mount($('payBox'), { pay: r.pay,
        onPaid: function () {
          if (!r.test) { bought.transaction_id = String(r.order); trk('purchase', bought); }
          cart = {}; save(); renderCount(); $('doneNum').textContent = r.order;
          $('doneText').textContent = 'התשלום התקבל. אישור הזמנה יגיע בדקות הקרובות למייל ' + mail + '. ' + (deliv === 'delivery' ? 'ההזמנה תגיע אליכם ' : 'ההזמנה תהיה מוכנה לאיסוף ') + (document.querySelector('.leadText') || {}).textContent + ', ונעדכן אתכם בטלפון. לכל שאלה: 050-4770040.';
          step('done'); $('doneStep').focus();
        },
        onError: function (text) { step('form'); $('payBtn').disabled = false; msg.className = 'msg err'; msg.textContent = (text || 'טופס התשלום לא נפתח.') + ' נסו שוב או התקשרו 050-4770040.'; } });
    }).catch(function () { $('payBtn').disabled = false; msg.className = 'msg err'; msg.textContent = 'אין חיבור. נסו שוב.'; });
  });

  /* ---------- customer account: sign-in link by mail, no password; the device keeps a session secret ---------- */
  var me = null, sess = null, cartTimer = null;
  try { sess = localStorage.getItem('ziso_session') || null; } catch (e) {}
  function setSess(t) { sess = t || null; try { if (sess) localStorage.setItem('ziso_session', sess); else localStorage.removeItem('ziso_session'); } catch (e) {} }
  function pushCart() { if (!sess) return; clearTimeout(cartTimer); cartTimer = setTimeout(function () { post({ action: 'cart_save', session: sess, cart: cart }); }, 1200); }
  function signedIn(profile, merge) {
    me = profile;
    if (merge) { Object.keys(me.cart || {}).forEach(function (id) { if (state.byId[id]) cart[id] = Math.max(cart[id] || 0, me.cart[id]); }); save(); }
    var first = String(me.name || '').trim().split(/\s+/)[0];
    $('accLabel').textContent = first || 'החשבון שלי'; $('accBtn').setAttribute('aria-label', 'החשבון שלי' + (first ? ': ' + first : ''));
    var f = $('checkout');
    [['name', me.name], ['phone', me.phone], ['email', me.email], ['address', me.address], ['city', me.city]].forEach(function (p) { if (p[1] && !f[p[0]].value) f[p[0]].value = p[1]; });
    drawAccount();
  }
  var OST = { paid: ['התקבלה, בטיפול', ''], sent: ['בדרך אליכם / מוכנה לאיסוף', 'ok'], done: ['נמסרה', 'ok'], cancelled: ['בוטלה', 'off'] };
  function drawAccount() {
    $('accOut').hidden = !!me; $('accIn').hidden = !me; if (!me) { $('accLabel').textContent = 'כניסה'; return; }
    $('accHello').textContent = 'שלום' + (me.name ? ' ' + me.name : '') + '. המכשיר הזה מחובר לחשבון שלך.';
    $('accInfo').innerHTML = esc(me.email) + (me.phone ? ' · <span dir="ltr">' + esc(me.phone) + '</span>' : '') + (me.address ? '<br>' + esc(me.address) + (me.city ? ', ' + esc(me.city) : '') : '');
    $('accOrders').innerHTML = (me.orders || []).length ? me.orders.map(function (o) {
      var st = OST[o.status] || [o.status, ''];
      return '<div class="ord"><b>הזמנה ' + o.id + '</b><span class="small">' + new Date(o.at).toLocaleDateString('he-IL') + ' · ' + o.n + ' פריטים</span><span class="grow"></span><span>' + money(o.total) + '</span><span class="tag ' + st[1] + '">' + st[0] + '</span>' +
        (o.tracking ? '<div class="small" style="flex-basis:100%">' + esc(o.courier || 'משלוח') + ' · מספר מעקב <span dir="ltr">' + esc(o.tracking) + '</span></div>' : '') + '</div>';
    }).join('') : '<p class="small">עוד אין הזמנות בחשבון.</p>';
  }
  function account() {
    var m = /[?&]in=([0-9a-f]{48})/.exec(location.search);
    if (m) {
      try { history.replaceState(null, '', location.pathname); } catch (e) {}
      post({ action: 'login_finish', code: m[1] }).then(function (r) {
        $('accDlg').showModal();
        if (!r.ok) { drawAccount(); $('accMsg').className = 'msg err'; $('accMsg').textContent = r.error || 'הכניסה לא הצליחה. אפשר לבקש קישור חדש.'; return; }
        setSess(r.session); signedIn(r.me, true);
      });
    } else if (sess) post({ action: 'me', session: sess }).then(function (r) { if (r.ok) signedIn(r.me, true); else if (r.error === 'session') setSess(null); });
  }
  $('accBtn').addEventListener('click', function () { drawAccount(); $('accDlg').showModal(); if (sess && me) post({ action: 'me', session: sess }).then(function (r) { if (r.ok) { me = r.me; drawAccount(); } }); });
  $('accDlg').addEventListener('click', function (e) { if (e.target.hasAttribute('data-close')) $('accDlg').close(); });
  $('accForm').addEventListener('submit', function (e) {
    e.preventDefault(); var mail = e.target.email.value.trim(), msg = $('accMsg');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { msg.className = 'msg err'; msg.textContent = 'נא למלא כתובת מייל תקינה.'; e.target.email.focus(); return; }
    $('accSend').disabled = true; msg.className = 'msg'; msg.textContent = 'שולחים…';
    post({ action: 'login_start', email: mail }).then(function (r) {
      $('accSend').disabled = false;
      if (!r.ok) { msg.className = 'msg err'; msg.textContent = r.error || 'משהו השתבש. נסו שוב.'; return; }
      msg.className = 'msg ok'; msg.textContent = 'שלחנו קישור כניסה ל-' + mail + '. הוא מגיע תוך כמה דקות ותקף ל-30 דקות. כדאי לבדוק גם בתיקיית הספאם.';
    });
  });
  $('logoutBtn').addEventListener('click', function () { post({ action: 'logout', session: sess }); setSess(null); me = null; drawAccount(); });

  var payUi = null;
  // the cart dialog has three faces: the cart + details form, the payment, the confirmation
  function step(which) {
    if (which !== 'pay' && payUi) { payUi.destroy(); payUi = null; }
    $('lines').hidden = $('totals').hidden = which !== 'form'; $('checkout').hidden = which !== 'form' || !Object.keys(cart).length;
    $('payStep').hidden = which !== 'pay'; $('doneStep').hidden = which !== 'done';
    $('cartH').textContent = which === 'pay' ? 'תשלום מאובטח' : which === 'done' ? 'תודה!' : 'הסל שלך';
    $('cartDlg').scrollTop = 0; var d = document.querySelector('#cartDlg .dlg'); if (d) d.scrollTop = 0;
  }
  $('cartDlg').addEventListener('close', function () { if (!$('payStep').hidden || !$('doneStep').hidden) { step('form'); $('payBtn').disabled = false; $('payMsg').textContent = ''; renderCart(); } });
  renderCount(); start();
})();
