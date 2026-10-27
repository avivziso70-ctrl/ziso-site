// In-memory catalog search for the save-nothing "do you have X?" question. Token overlap with a few normalizations
// (sizes 60/120 = 60×120 = 60x120, singular/plural, common synonyms); returns family + description, nothing else.
import { CATALOG, FAMILIES } from "./catalog.ts";

const SYN: Record<string, string[]> = {
  "אריח": ["אריחים", "קרמיקה", "פורצלן", "גרניט", "ריצוף", "חיפוי"], "ארון": ["ארונות", "ארונית"], "ברז": ["ברזים", "מיקסר", "אינטרפוץ"],
  "מקלחון": ["מקלחונים", "ויטרינה"], "כיור": ["כיורים"], "מראה": ["מראות"], "אסלה": ["אסלות", "ניאגרה", "ניאגרות"], "פרקט": ["פרקטים", "למינציה"],
  "אמבטיה": ["אמבטיות", "אמבט"], "אגנית": ["אגניות"], "בריק": ["בריקים"], "לחצן": ["לחצנים"], "זהב": ["גולד", "מוזהב"], "שחור": ["בלאק"], "לבן": ["וייט"],
  "אפור": ["גריי", "גרפיט"], "מבריק": ["פוליש", "לאפטו"], "מט": ["מאט"], "עץ": ["פרקט", "וונגה", "אלון"], "שיש": ["קררה", "קלקטה", "סטטוריו"], "בטון": ["סמנט"],
};
const norm = (s: string) => s.toLowerCase().replace(/[×x*]/g, "/").replace(/[^\p{L}\p{N}\/\. ]/gu, " ").replace(/\s+/g, " ").trim();
function expand(tok: string): string[] {
  const out = new Set([tok]);
  for (const [k, vs] of Object.entries(SYN)) if (tok === k || vs.includes(tok)) { out.add(k); vs.forEach((v) => out.add(v)); }
  if (tok.startsWith("ה") && tok.length > 3) out.add(tok.slice(1));
  return [...out];
}
const index = Object.entries(CATALOG).flatMap(([fam, descs]) => descs.map((desc) => ({ fam, desc, text: " " + norm(fam + " " + desc) + " " })));

export function searchCatalog(query: string, limit = 12): { family: string; items: string[] }[] {
  const toks = norm(query).split(" ").filter((t) => t.length > 1);
  if (!toks.length) return [];
  const scored = index.map((e) => {
    let s = 0;
    for (const t of toks) {
      const alts = expand(t);
      if (alts.some((a) => e.text.includes(" " + a + " "))) s += 2;       // whole word
      else if (alts.some((a) => a.length > 2 && e.text.includes(a))) s += 1; // part of a word
    }
    return { e, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const top = scored.slice(0, limit);
  const byFam: Record<string, string[]> = {};
  for (const { e } of top) (byFam[e.fam] ||= []).push(e.desc);
  return Object.entries(byFam).map(([family, items]) => ({ family, items }));
}
export const familySummary = () => Object.entries(FAMILIES).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} (${n})`).join(", ");
