// Finds the pictures drawn on a PDF page and turns one into a small JPEG (thumbnail). Pure code, no network or db,
// so the same file runs in the edge function and in a local test.
//
// Where a picture sits on the page comes from the page's content stream: the graphics state (q/Q) and the matrix
// (cm) in force when the picture is painted (Do). A form XObject is a group that brings its own matrix and resources,
// so it is walked the same way. Decoding: DCTDecode is a JPEG file as is; FlateDecode is raw pixels (gray, RGB,
// CMYK, ICC with 1/3/4 channels, or an 8 bit palette). A soft mask (transparent background, typical of product
// cutouts) is laid over white. JPXDecode is a JPEG 2000 file (Dor Rafael's shower catalog, 17.11.2026), decoded in
// plain JavaScript: gray or RGB, any number of tiles. A JPEG at print size (above MAX_PX) is not unpacked: its small
// picture is read straight from the file's numbers (smallJpeg). Anything else (CCITT, 1 bit masks) is skipped.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from "npm:pdf-lib@1.17.1";
import jpeg from "npm:jpeg-js@0.4.4";
import jpx2k from "npm:jpeg2000@1.1.1";
import { Buffer } from "node:buffer";

type M = [number, number, number, number, number, number];
export type Draw = {
  ref: string; // object number of the picture in this file
  sig: string; // size in bytes and pixels: the same picture on many pages (a logo, a frame) has the same sig, also in page files cut out of the catalog
  stream: PDFRawStream;
  box: [number, number, number, number]; // left, top, right, bottom as fractions of the page, top-left origin
  w: number; h: number; // pixels
  filter: string; cs: string; bpc: number; smask: boolean;
  inv: boolean; // /Decode [1 0 ...]: the samples are stored inverted
};

const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const ID: M = [1, 0, 0, 1, 0, 0];

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ( ) < > [ ] { } / %
const isWs = (c: number) => WS.has(c);

// Calls op(name, operands) for every operator in a content stream. Strings, arrays, dicts and inline images are
// skipped; numbers and names are kept as operands, since only cm and Do matter here.
function scan(b: Uint8Array, op: (name: string, args: (number | string | null)[]) => void) {
  const args: (number | string | null)[] = [];
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i];
    if (isWs(c)) { i++; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; } // % comment
    if (c === 40) { // (string), nested parens, backslash escapes
      let depth = 0;
      for (; i < n; i++) {
        const d = b[i];
        if (d === 92) { i++; continue; }
        if (d === 40) depth++;
        else if (d === 41 && --depth === 0) { i++; break; }
      }
      args.push(null); continue;
    }
    if (c === 60) {
      if (b[i + 1] === 60) { i += 2; continue; } // <<
      while (i < n && b[i] !== 62) i++; i++; args.push(null); continue; // <hex>
    }
    if (c === 62) { i += b[i + 1] === 62 ? 2 : 1; continue; } // >>
    if (c === 91 || c === 93 || c === 123 || c === 125) { i++; continue; }
    if (c === 47) { // /Name
      let j = i + 1; while (j < n && !isWs(b[j]) && !DELIM.has(b[j])) j++;
      args.push("/" + new TextDecoder().decode(b.subarray(i + 1, j))); i = j; continue;
    }
    let j = i; while (j < n && !isWs(b[j]) && !DELIM.has(b[j])) j++;
    if (j === i) { i++; continue; }
    const word = String.fromCharCode(...b.subarray(i, Math.min(j, i + 32)));
    i = j;
    if (/^[+\-]?(\d+\.?\d*|\.\d+)$/.test(word)) { args.push(Number(word)); continue; }
    if (word === "true" || word === "false" || word === "null") { args.push(null); continue; }
    if (word === "BI") { // inline image: skip the binary data up to whitespace EI whitespace
      let k = i; while (k + 1 < n && !(b[k] === 73 && b[k + 1] === 68 && isWs(b[k - 1]) && (k + 2 >= n || isWs(b[k + 2])))) k++; // ID
      k += 3;
      while (k + 2 < n && !(isWs(b[k]) && b[k + 1] === 69 && b[k + 2] === 73 && (k + 3 >= n || isWs(b[k + 3]) || DELIM.has(b[k + 3])))) k++;
      i = k + 3; args.length = 0; continue;
    }
    op(word, args);
    args.length = 0;
  }
}

const nameOf = (o: unknown) => (o instanceof PDFName ? o.decodeText() : "");
const numOf = (o: unknown) => (o instanceof PDFNumber ? o.asNumber() : 0);
const sigOf = (s: PDFRawStream) => `${s.contents.length}:${numOf(s.dict.lookup(PDFName.of("Width")))}x${numOf(s.dict.lookup(PDFName.of("Height")))}`;

function contentBytes(doc: PDFDocument, contents: unknown): Uint8Array {
  const parts: Uint8Array[] = [];
  const add = (o: unknown) => {
    const s = o instanceof PDFRef ? doc.context.lookup(o) : o;
    if (s instanceof PDFRawStream) { try { parts.push(decodePDFRawStream(s).decode()); } catch { /* unreadable stream */ } }
    else if (s instanceof PDFArray) for (let k = 0; k < s.size(); k++) add(s.get(k));
  };
  add(contents);
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length + 1, 0));
  let off = 0; for (const p of parts) { out.set(p, off); off += p.length; out[off++] = 10; }
  return out;
}

function colorSpace(doc: PDFDocument, cs: unknown): string {
  const o = cs instanceof PDFRef ? doc.context.lookup(cs) : cs;
  if (o instanceof PDFName) return o.decodeText();
  if (o instanceof PDFArray) {
    const kind = nameOf(o.lookup(0));
    if (kind === "ICCBased") { const s = o.lookup(1); const nn = s instanceof PDFStream ? numOf(s.dict.lookup(PDFName.of("N"))) : 3; return nn === 1 ? "DeviceGray" : nn === 4 ? "DeviceCMYK" : "DeviceRGB"; }
    if (kind === "Indexed") return "Indexed";
    if (kind === "CalRGB" || kind === "Lab") return "DeviceRGB";
    if (kind === "CalGray") return "DeviceGray";
    return kind;
  }
  return "";
}

// Every picture painted on the page, with its place. A picture painted twice on a page is listed once.
export function pageDraws(doc: PDFDocument, page: PDFPage): Draw[] {
  const mb = page.getCropBox();
  const out: Draw[] = [];
  const seen = new Set<string>();
  const walk = (bytes: Uint8Array, res: PDFDict | undefined, base: M, depth: number) => {
    const stack: M[] = [];
    let ctm = base;
    const xobj = res?.lookup(PDFName.of("XObject"));
    scan(bytes, (op, a) => {
      if (op === "q") stack.push(ctm);
      else if (op === "Q") ctm = stack.pop() || base;
      else if (op === "cm" && a.length >= 6 && a.slice(-6).every((x) => typeof x === "number")) ctm = mul(a.slice(-6) as M, ctm);
      else if (op === "Do" && typeof a[a.length - 1] === "string" && xobj instanceof PDFDict) {
        const key = (a[a.length - 1] as string).slice(1);
        const ref = xobj.get(PDFName.of(key));
        const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
        if (!(s instanceof PDFRawStream)) return;
        const sub = nameOf(s.dict.lookup(PDFName.of("Subtype")));
        if (sub === "Form" && depth < 4) {
          const mx = s.dict.lookup(PDFName.of("Matrix"));
          const fm: M = mx instanceof PDFArray && mx.size() === 6 ? [0, 1, 2, 3, 4, 5].map((k) => numOf(mx.lookup(k))) as M : ID;
          const fr = s.dict.lookup(PDFName.of("Resources"));
          let body: Uint8Array; try { body = decodePDFRawStream(s).decode(); } catch { return; }
          walk(body, fr instanceof PDFDict ? fr : res, mul(fm, ctm), depth + 1);
        } else if (sub === "Image") {
          const id = ref instanceof PDFRef ? String(ref.objectNumber) : key;
          if (seen.has(id)) return;
          const d = s.dict;
          if (d.lookup(PDFName.of("ImageMask"))?.toString() === "true") return;
          const xs: number[] = [], ys: number[] = [];
          for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { xs.push(ctm[0] * x + ctm[2] * y + ctm[4]); ys.push(ctm[1] * x + ctm[3] * y + ctm[5]); }
          const fx = (v: number) => Math.min(1, Math.max(0, (v - mb.x) / mb.width));
          const fy = (v: number) => Math.min(1, Math.max(0, 1 - (v - mb.y) / mb.height));
          const box: [number, number, number, number] = [fx(Math.min(...xs)), fy(Math.max(...ys)), fx(Math.max(...xs)), fy(Math.min(...ys))];
          const f = d.lookup(PDFName.of("Filter"));
          const filter = f instanceof PDFArray ? Array.from({ length: f.size() }, (_, k) => nameOf(f.lookup(k))).join("+") : nameOf(f);
          seen.add(id);
          out.push({
            ref: id, sig: sigOf(s), stream: s, box, w: numOf(d.lookup(PDFName.of("Width"))), h: numOf(d.lookup(PDFName.of("Height"))),
            filter, cs: colorSpace(doc, d.get(PDFName.of("ColorSpace"))), bpc: numOf(d.lookup(PDFName.of("BitsPerComponent"))) || 8,
            smask: !!d.get(PDFName.of("SMask")),
            inv: (() => { const dc = d.lookup(PDFName.of("Decode")); return dc instanceof PDFArray && dc.size() >= 2 && numOf(dc.lookup(0)) > numOf(dc.lookup(1)); })(),
          });
        }
      }
    });
  };
  walk(contentBytes(doc, page.node.Contents()), page.node.Resources(), ID, 0);
  return out;
}

// The pictures listed in a page's resources (by sig), without reading the content: a picture that sits in the
// resources of many pages is a logo, a frame or a background, not a product.
export function pageImageSigs(doc: PDFDocument, page: PDFPage): string[] {
  const ids: string[] = [];
  const visit = (res: unknown, depth: number) => {
    const r = res instanceof PDFRef ? doc.context.lookup(res) : res;
    if (!(r instanceof PDFDict)) return;
    const x = r.lookup(PDFName.of("XObject"));
    if (!(x instanceof PDFDict)) return;
    for (const [, ref] of x.entries()) {
      const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      if (!(s instanceof PDFRawStream)) continue;
      const sub = nameOf(s.dict.lookup(PDFName.of("Subtype")));
      if (sub === "Image") ids.push(sigOf(s));
      else if (sub === "Form" && depth < 3) visit(s.dict.get(PDFName.of("Resources")), depth + 1);
    }
  };
  visit(page.node.Resources(), 0);
  return ids;
}

// Bytes of the pictures and groups a page's resources point to: about what the page weighs as a file of its own.
// Some files give every page the pictures of the whole catalog, and such a page must not be copied out.
export function pageWeight(doc: PDFDocument, page: PDFPage): number {
  let sum = 0;
  const seen = new Set<unknown>();
  const visit = (res: unknown, depth: number) => {
    const r = res instanceof PDFRef ? doc.context.lookup(res) : res;
    if (!(r instanceof PDFDict)) return;
    const x = r.lookup(PDFName.of("XObject"));
    if (!(x instanceof PDFDict)) return;
    for (const [, ref] of x.entries()) {
      const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      if (!(s instanceof PDFRawStream) || seen.has(s)) continue;
      seen.add(s); sum += s.contents.length;
      const m = s.dict.lookup(PDFName.of("SMask"));
      if (m instanceof PDFRawStream && !seen.has(m)) { seen.add(m); sum += m.contents.length; }
      if (nameOf(s.dict.lookup(PDFName.of("Subtype"))) === "Form" && depth < 3) visit(s.dict.get(PDFName.of("Resources")), depth + 1);
    }
  };
  visit(page.node.Resources(), 0);
  return sum;
}

type Px = { data: Uint8Array; w: number; h: number }; // RGBA

function rawPixels(doc: PDFDocument, s: PDFRawStream, w: number, h: number, cs: string, bpc: number): Px | null {
  if (bpc !== 8) return null;
  let raw: Uint8Array; try { raw = decodePDFRawStream(s).decode(); } catch { return null; }
  const out = new Uint8Array(w * h * 4);
  if (cs === "Indexed") {
    const a = s.dict.lookup(PDFName.of("ColorSpace"));
    const arr = a instanceof PDFArray ? a : null;
    if (!arr) return null;
    const base = colorSpace(doc, arr.get(1)), lk = arr.lookup(3);
    let pal: Uint8Array;
    if (lk instanceof PDFRawStream) { try { pal = decodePDFRawStream(lk).decode(); } catch { return null; } }
    else if (lk && "asBytes" in (lk as object)) pal = (lk as unknown as { asBytes(): Uint8Array }).asBytes();
    else return null;
    const nc = base === "DeviceGray" ? 1 : base === "DeviceCMYK" ? 4 : 3;
    if (raw.length < w * h) return null;
    for (let p = 0; p < w * h; p++) {
      const o = raw[p] * nc;
      if (nc === 1) out.set([pal[o], pal[o], pal[o], 255], p * 4);
      else if (nc === 3) out.set([pal[o], pal[o + 1], pal[o + 2], 255], p * 4);
      else { const k = 255 - pal[o + 3]; out.set([(255 - pal[o]) * k / 255, (255 - pal[o + 1]) * k / 255, (255 - pal[o + 2]) * k / 255, 255], p * 4); }
    }
    return { data: out, w, h };
  }
  const nc = cs === "DeviceGray" ? 1 : cs === "DeviceCMYK" ? 4 : cs === "DeviceRGB" ? 3 : 0;
  if (!nc || raw.length < w * h * nc) return null;
  for (let p = 0, q = 0; p < w * h; p++, q += nc) {
    const o = p * 4;
    if (nc === 1) { out[o] = out[o + 1] = out[o + 2] = raw[q]; }
    else if (nc === 3) { out[o] = raw[q]; out[o + 1] = raw[q + 1]; out[o + 2] = raw[q + 2]; }
    else { const k = 255 - raw[q + 3]; out[o] = (255 - raw[q]) * k / 255; out[o + 1] = (255 - raw[q + 1]) * k / 255; out[o + 2] = (255 - raw[q + 2]) * k / 255; }
    out[o + 3] = 255;
  }
  return { data: out, w, h };
}

// Area average down to at most `max` pixels on the long side (never up).
// A JPEG 2000 picture as RGBA. The decoder gives each tile as interleaved samples, already in RGB.
function jpxPixels(b: Uint8Array): Px | null {
  // deno-lint-ignore no-explicit-any
  const im = new (jpx2k as any).JpxImage();
  im.parse(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  const n: number = im.componentsCount, w: number = im.width, h: number = im.height;
  if ((n !== 1 && n !== 3) || !(w > 0 && h > 0)) return null;
  const out = new Uint8Array(w * h * 4).fill(255);
  // deno-lint-ignore no-explicit-any
  for (const t of im.tiles as any[]) {
    const tw: number = t.width, th: number = t.height, x0: number = t.left || 0, y0: number = t.top || 0, s = t.items;
    for (let y = 0; y < th && y0 + y < h; y++) {
      let o = ((y0 + y) * w + x0) * 4, i = y * tw * n;
      for (let x = 0; x < tw && x0 + x < w; x++, o += 4, i += n) {
        out[o] = s[i]; out[o + 1] = n === 1 ? s[i] : s[i + 1]; out[o + 2] = n === 1 ? s[i] : s[i + 2];
      }
    }
  }
  return { data: out, w, h };
}

function shrink(src: Px, max: number): Px {
  const k = Math.max(src.w, src.h) / max;
  if (k <= 1) return src;
  const w = Math.max(1, Math.round(src.w / k)), h = Math.max(1, Math.round(src.h / k));
  const out = new Uint8Array(w * h * 4);
  const sum = new Float64Array(w * 4), cnt = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    sum.fill(0); cnt.fill(0);
    const y0 = Math.floor(y * src.h / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * src.h / h));
    for (let sy = y0; sy < y1; sy++) {
      let row = sy * src.w * 4;
      for (let sx = 0; sx < src.w; sx++, row += 4) {
        const x = Math.min(w - 1, Math.floor(sx * w / src.w)), o = x * 4;
        sum[o] += src.data[row]; sum[o + 1] += src.data[row + 1]; sum[o + 2] += src.data[row + 2]; cnt[x]++;
      }
    }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4, c = cnt[x] || 1; out[o] = sum[x * 4] / c; out[o + 1] = sum[x * 4 + 1] / c; out[o + 2] = sum[x * 4 + 2] / c; out[o + 3] = 255; }
  }
  return { data: out, w, h };
}

// Transparent parts over white, using the soft mask (any size, sampled to the picture's size).
function overWhite(doc: PDFDocument, px: Px, s: PDFRawStream) {
  const m = s.dict.lookup(PDFName.of("SMask"));
  if (!(m instanceof PDFRawStream)) return;
  const mw = numOf(m.dict.lookup(PDFName.of("Width"))), mh = numOf(m.dict.lookup(PDFName.of("Height")));
  let a: Uint8Array;
  try { a = decodePDFRawStream(m).decode(); } catch { return; }
  if (numOf(m.dict.lookup(PDFName.of("BitsPerComponent"))) !== 8 || a.length < mw * mh) return;
  for (let y = 0; y < px.h; y++) {
    const my = Math.min(mh - 1, Math.floor(y * mh / px.h));
    for (let x = 0; x < px.w; x++) {
      const al = a[my * mw + Math.min(mw - 1, Math.floor(x * mw / px.w))] / 255, o = (y * px.w + x) * 4;
      px.data[o] = px.data[o] * al + 255 * (1 - al); px.data[o + 1] = px.data[o + 1] * al + 255 * (1 - al); px.data[o + 2] = px.data[o + 2] * al + 255 * (1 - al);
    }
  }
}

const dec = (b: Uint8Array) => jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 60, maxMemoryUsageInMB: 200 });

// A copy of a JPEG in which the given components (by position in the frame header) decode to flat mid gray: they are
// pointed at an extra quantization table of zeros, placed last so nothing redefines it. When all four table numbers are
// taken (each component then has its own), the components' own tables are zeroed instead.
function flat(b: Uint8Array, comps: number[]): Uint8Array {
  const tables: [number, number, number][] = []; // table number, where its values start, how many bytes
  let sof = -1, i = 2;
  for (; i + 4 < b.length && b[i] === 0xff && b[i + 1] !== 0xda;) {
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0xdb) for (let k = i + 4; k < i + 2 + len;) { const n = (b[k] >> 4) ? 128 : 64; tables.push([b[k] & 15, k + 1, n]); k += 1 + n; }
    if ((m === 0xc0 || m === 0xc1 || m === 0xc2) && sof < 0) sof = i;
    i += 2 + len;
  }
  if (sof < 0 || b[i + 1] !== 0xda) throw new Error(`jpeg header: frame ${sof}, stopped at ${i} on ${b[i]?.toString(16)} ${b[i + 1]?.toString(16)}`);
  const nc = b[sof + 9], tq = (c: number) => sof + 10 + c * 3 + 2;
  const taken = new Set(Array.from({ length: nc }, (_, c) => b[tq(c)] & 15));
  const free = [0, 1, 2, 3].find((t) => !taken.has(t));
  if (free === undefined) {
    const out = new Uint8Array(b), mine = new Set(comps.map((c) => b[tq(c)] & 15));
    for (const [id, off, n] of tables) if (mine.has(id)) out.fill(0, off, off + n);
    return out;
  }
  const out = new Uint8Array(b.length + 69);
  out.set(b.subarray(0, i), 0);
  out.set([0xff, 0xdb, 0, 67, free], i); // 64 zeros follow
  out.set(b.subarray(i), i + 69);
  for (const c of comps) out[tq(c)] = free;
  return out;
}

// A four-ink JPEG whose samples are the ink amounts as they are (a PDF without /Decode [1 0 ...]). jpeg-js only knows
// the Adobe way round (255 = no ink) and returns colour x black mixed, so it is decoded twice: once with black flat,
// once with the three colours flat, and the right mix is computed from the two.
function plainCmyk(b: Uint8Array): Px {
  const A = dec(flat(b, [3])), B = dec(flat(b, [0, 1, 2])), a = A.data as Uint8Array, k = B.data as Uint8Array;
  for (let o = 0; o < a.length; o += 4) {
    const w = Math.max(0, 255 - k[o] * 2); // white left by the black ink
    a[o] = Math.max(0, 255 - a[o] * 2) * w / 255; a[o + 1] = Math.max(0, 255 - a[o + 1] * 2) * w / 255; a[o + 2] = Math.max(0, 255 - a[o + 2] * 2) * w / 255;
  }
  return { data: a, w: A.width, h: A.height };
}

// ---- A print-size JPEG read small ----
// A photograph at print size (a catalog page that is one photo: 2,500 x 3,500 pixels of four inks, Dor Rafael's sale
// catalog, 17.11.2026) costs more memory and CPU than a worker has when it is unpacked in full. The same picture at
// 1/8 of the size is already in the file: the first number of every 8x8 block is the block's average. So the file's
// codes are only walked, nothing is unpacked into pixels, and that number is kept. For 1/4 of the size the three
// lowest waves of each block are kept too (a block gives 2x2 pixels). A progressive file gives 1/8 only (its first
// numbers come in passes of their own; the other passes are jumped over).
type Huff = { look: Uint16Array; max: Int32Array; ptr: Int32Array; min: Int32Array; vals: Uint8Array };
function huff(counts: Uint8Array, vals: Uint8Array): Huff {
  const look = new Uint16Array(256), max = new Int32Array(17).fill(-1), ptr = new Int32Array(17), min = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    ptr[l] = k; min[l] = code;
    for (let j = 0; j < counts[l - 1]; j++, k++, code++) if (l <= 8) look.fill((l << 8) | vals[k], code << (8 - l), (code + 1) << (8 - l));
    max[l] = counts[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  return { look, max, ptr, min, vals };
}
type Comp = { id: number; h: number; v: number; tq: number; bw: number; bh: number; co: Int16Array; pred: number };

export function smallJpeg(b: Uint8Array, quarter: boolean, plainInk: boolean): Px {
  const qt: Int32Array[] = [], dcT: Huff[] = [], acT: Huff[] = [], comps: Comp[] = [];
  let W = 0, H = 0, prog = false, ri = 0, adobeT = -1, hmax = 1, vmax = 1, mx = 0, my = 0, scans = 0;
  // bits, most significant first; a stuffed FF 00 is one FF, any other marker ends the data (zeros are fed after it)
  let pos = 0, buf = 0, cnt = 0, hit = false;
  const fill = () => {
    while (cnt <= 24) {
      let c = 0;
      if (!hit && pos < b.length) { c = b[pos++]; if (c === 0xff) { if (b[pos] === 0) pos++; else { hit = true; pos--; c = 0; } } }
      buf |= c << (24 - cnt); cnt += 8;
    }
  };
  const sym = (h: Huff): number => {
    fill();
    const e = h.look[buf >>> 24];
    if (e) { buf <<= e >> 8; cnt -= e >> 8; return e & 255; }
    for (let l = 9; l <= 16; l++) {
      const code = buf >>> (32 - l);
      if (code <= h.max[l]) { buf <<= l; cnt -= l; return h.vals[h.ptr[l] + code - h.min[l]]; }
    }
    throw new Error("jpeg: bad code");
  };
  const num = (s: number): number => { // s bits as a signed number, the JPEG way
    if (!s) return 0;
    fill();
    const v = buf >>> (32 - s);
    buf <<= s; cnt -= s;
    return v < (1 << (s - 1)) ? v - (1 << s) + 1 : v;
  };
  const marker = (from: number) => { let k = from; while (k + 1 < b.length && !(b[k] === 0xff && b[k + 1] !== 0 && b[k + 1] !== 0xff && (b[k + 1] < 0xd0 || b[k + 1] > 0xd7))) k++; return k; };

  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error("jpeg: no marker at " + i);
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd9) break;
    if (m >= 0xd0 && m <= 0xd7) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3], s = i + 4, e = i + 2 + len;
    if (m === 0xdb) {
      for (let k = s; k < e;) { const wide = b[k] >> 4, q = new Int32Array(64), t = b[k++] & 15; for (let j = 0; j < 64; j++) { q[j] = wide ? (b[k] << 8) | b[k + 1] : b[k]; k += wide ? 2 : 1; } qt[t] = q; }
    } else if (m === 0xc4) {
      for (let k = s; k < e;) { const counts = b.subarray(k + 1, k + 17); let n = 0; for (const c of counts) n += c; ((b[k] >> 4) ? acT : dcT)[b[k] & 15] = huff(counts, b.subarray(k + 17, k + 17 + n)); k += 17 + n; }
    } else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      if (b[s] !== 8 || comps.length) throw new Error("jpeg: frame");
      H = (b[s + 1] << 8) | b[s + 2]; W = (b[s + 3] << 8) | b[s + 4]; prog = m === 0xc2;
      const n = b[s + 5];
      if (!W || !H || ![1, 3, 4].includes(n)) throw new Error("jpeg: frame");
      for (let c = 0; c < n; c++) { const o = s + 6 + c * 3; comps.push({ id: b[o], h: b[o + 1] >> 4, v: b[o + 1] & 15, tq: b[o + 2] & 3, bw: 0, bh: 0, co: new Int16Array(0), pred: 0 }); }
      hmax = Math.max(...comps.map((c) => c.h)); vmax = Math.max(...comps.map((c) => c.v));
      mx = Math.ceil(W / (8 * hmax)); my = Math.ceil(H / (8 * vmax));
      if (prog) quarter = false;
      for (const c of comps) { c.bw = mx * c.h; c.bh = my * c.v; c.co = new Int16Array(c.bw * c.bh * (quarter ? 4 : 1)); }
    } else if (m >= 0xc3 && m <= 0xcf && m !== 0xc8 && m !== 0xcc) {
      throw new Error("jpeg: kind " + m.toString(16));
    } else if (m === 0xdd) {
      ri = (b[s] << 8) | b[s + 1];
    } else if (m === 0xee && len >= 14 && b[s] === 0x41 && b[s + 1] === 0x64) {
      adobeT = b[s + 11];
    } else if (m === 0xda) {
      if (!comps.length) throw new Error("jpeg: scan before frame");
      const ns = b[s], sc: { c: Comp; dc: Huff; ac: Huff }[] = [];
      for (let j = 0; j < ns; j++) {
        const c = comps.find((x) => x.id === b[s + 1 + j * 2]), t = b[s + 2 + j * 2];
        if (!c) throw new Error("jpeg: scan");
        sc.push({ c, dc: dcT[t >> 4], ac: acT[t & 15] });
      }
      const ss = b[s + 1 + ns * 2], ah = b[s + 3 + ns * 2] >> 4, al = b[s + 3 + ns * 2] & 15;
      if (prog && ss > 0) { i = marker(e); continue; } // a pass of the finer waves
      pos = e; buf = 0; cnt = 0; hit = false;
      const one = ns === 1 ? sc[0].c : null;
      const lw = one ? Math.ceil(Math.ceil(W * one.h / hmax) / 8) : mx, lh = one ? Math.ceil(Math.ceil(H * one.v / vmax) / 8) : my;
      const block = (t: { c: Comp; dc: Huff; ac: Huff }, at: number) => {
        const c = t.c;
        if (prog) {
          if (ah) { fill(); if (buf < 0) c.co[at] |= 1 << al; buf <<= 1; cnt--; }
          else { c.pred += num(sym(t.dc)); c.co[at] = c.pred << al; }
          return;
        }
        c.pred += num(sym(t.dc));
        if (quarter) c.co[at * 4] = c.pred; else c.co[at] = c.pred;
        for (let k = 1; k < 64;) {
          const rs = sym(t.ac), r = rs >> 4, n = rs & 15;
          if (!n) { if (r === 15) { k += 16; continue; } break; }
          k += r;
          if (quarter && (k === 1 || k === 2 || k === 4)) c.co[at * 4 + (k === 4 ? 3 : k)] = num(n);
          else { fill(); buf <<= n; cnt -= n; }
          k++;
        }
      };
      for (let u = 0, total = lw * lh; u < total; u++) {
        if (ri && u && u % ri === 0) { // restart: the codes begin again on a whole byte, after a marker
          buf = 0; cnt = 0; hit = false;
          while (b[pos] === 0xff && b[pos + 1] === 0xff) pos++;
          if (b[pos] !== 0xff || b[pos + 1] < 0xd0 || b[pos + 1] > 0xd7) throw new Error("jpeg: restart");
          pos += 2;
          for (const c of comps) c.pred = 0;
        }
        const ux = u % lw, uy = (u - ux) / lw;
        if (one) block(sc[0], uy * one.bw + ux);
        else for (const t of sc) for (let y = 0; y < t.c.v; y++) for (let x = 0; x < t.c.h; x++) block(t, (uy * t.c.v + y) * t.c.bw + ux * t.c.h + x);
      }
      for (const c of comps) c.pred = 0;
      scans++;
      i = marker(Math.max(e, pos - 6));
      continue;
    }
    i = e;
  }
  if (!scans) throw new Error("jpeg: no picture data");

  // every component as a plane of samples, 1 or 2x2 per block
  const m = quarter ? 2 : 1, w = Math.ceil(W / (8 / m)), h = Math.ceil(H / (8 / m));
  const A = 0.11326, D = 0.10262; // what the first wave across (or down), and the two together, add to each half of a block
  const planes = comps.map((c) => {
    const q = qt[c.tq];
    if (!q) throw new Error("jpeg: table");
    const pw = c.bw * m, out = new Uint8ClampedArray(pw * c.bh * m);
    for (let y = 0; y < c.bh; y++) for (let x = 0; x < c.bw; x++) {
      const k = y * c.bw + x;
      if (!quarter) { out[k] = 128 + c.co[k] * q[0] / 8; continue; }
      const a = 128 + c.co[k * 4] * q[0] / 8, hx = c.co[k * 4 + 1] * q[1] * A, vy = c.co[k * 4 + 2] * q[2] * A, d = c.co[k * 4 + 3] * q[4] * D, o = y * 2 * pw + x * 2;
      out[o] = a + hx + vy + d; out[o + 1] = a - hx + vy - d; out[o + pw] = a + hx - vy - d; out[o + pw + 1] = a - hx - vy + d;
    }
    return { out, pw, fx: c.h / hmax, fy: c.v / vmax };
  });
  const n = comps.length, ycc = n === 3 ? adobeT !== 0 : n === 4 && adobeT === 2, data = new Uint8Array(w * h * 4), v = [0, 0, 0, 0];
  const clamp = (x: number) => x < 0 ? 0 : x > 255 ? 255 : x;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < n; c++) { const p = planes[c]; v[c] = p.out[Math.floor(y * p.fy) * p.pw + Math.floor(x * p.fx)]; }
    let r = v[0], g = n === 1 ? v[0] : v[1], bl = n === 1 ? v[0] : v[2];
    if (ycc) { const cb = v[1] - 128, cr = v[2] - 128; r = clamp(v[0] + 1.402 * cr); g = clamp(v[0] - 0.3441363 * cb - 0.71413636 * cr); bl = clamp(v[0] + 1.772 * cb); }
    if (n === 4) {
      // the three colours as ink samples (a YCCK file keeps them as light), then ink over white with the black
      if (ycc) { r = 255 - r; g = 255 - g; bl = 255 - bl; }
      if (plainInk) { const kk = 255 - v[3]; r = (255 - r) * kk / 255; g = (255 - g) * kk / 255; bl = (255 - bl) * kk / 255; }
      else { r = r * v[3] / 255; g = g * v[3] / 255; bl = bl * v[3] / 255; }
    }
    const o = (y * w + x) * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = bl; data[o + 3] = 255;
  }
  return { data, w, h };
}

export const MAX_PX = 5_000_000;
const BIG_PX = 20_000_000; // a JPEG read small: its codes are still walked one by one, and a worker has about a second
// Memory one pixel of a picture costs while it is decoded (bytes): a JPEG is unpacked into blocks, lines and pixels,
// a four-ink JPEG without /Decode twice (see plainCmyk); raw pixels are inflated and copied.
// A JPEG 2000 picture takes about twice the work of a JPEG of the same size (measured: 0.43 MP in about 200 ms).
// A JPEG above MAX_PX is read small (smallJpeg): little memory, and about a quarter of the work of unpacking it.
const big = (d: Draw) => d.filter === "DCTDecode" && d.w * d.h > MAX_PX;
export const cost = (d: Draw) => d.w * d.h * (big(d) ? 7 : d.filter === "JPXDecode" ? 60 : d.filter === "DCTDecode" ? (d.cs === "DeviceCMYK" ? (d.inv ? 36 : 64) : 28) : 14);
// A picture that can be decoded in `room` bytes of memory. The whole PDF sits in memory next to it, and a worker
// that runs out of memory is killed, so a picture that does not fit is left out.
export const fits = (d: Draw, room: number) => (d.w * d.h <= MAX_PX || (big(d) && d.w * d.h <= BIG_PX)) && cost(d) <= room;

// A JPEG of at most `max` pixels on the long side, or null when the picture's format is not supported.
// `strict` lets the reason for a picture that cannot be read come out as an error (used by the probe).
export function thumb(doc: PDFDocument, d: Draw, max = 240, quality = 72, strict = false): { jpg: Uint8Array; w: number; h: number } | null {
  let px: Px | null = null;
  if (big(d)) {
    try { px = smallJpeg(d.stream.contents, Math.max(d.w, d.h) < max * 8, d.cs === "DeviceCMYK" && !d.inv); } catch (e) { if (strict) throw e; return null; }
  } else if (d.filter === "DCTDecode") {
    try {
      if (d.cs === "DeviceCMYK" && !d.inv) px = plainCmyk(d.stream.contents);
      else { const r = dec(d.stream.contents); px = { data: r.data as Uint8Array, w: r.width, h: r.height }; }
    } catch (e) { if (strict) throw e; return null; }
  } else if (d.filter === "JPXDecode") {
    try { px = jpxPixels(d.stream.contents); } catch (e) { if (strict) throw e; return null; }
  } else if (d.filter === "FlateDecode" || d.filter === "") {
    px = rawPixels(doc, d.stream, d.w, d.h, d.cs, d.bpc);
  }
  if (!px) return null;
  if (d.smask) overWhite(doc, px, d.stream);
  const t = shrink(px, max);
  const enc = jpeg.encode({ data: t.data, width: t.w, height: t.h }, quality);
  return { jpg: new Uint8Array(enc.data), w: t.w, h: t.h };
}

// A rough text rendering of a thumbnail (dark = dense character), to check from a place that cannot open the picture.
export function ascii(jpg: Uint8Array, cols = 56): string[] {
  const r = jpeg.decode(jpg, { useTArray: true, formatAsRGBA: true });
  const rows = Math.max(1, Math.round(cols * r.height / r.width / 2)), ramp = " .:-=+*#%@", out: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < cols; x++) {
      const o = (Math.min(r.height - 1, Math.floor((y + 0.5) * r.height / rows)) * r.width + Math.min(r.width - 1, Math.floor((x + 0.5) * r.width / cols))) * 4;
      const l = (r.data[o] * 3 + r.data[o + 1] * 6 + r.data[o + 2]) / 10;
      line += ramp[Math.min(9, Math.floor((255 - l) / 25.6))];
    }
    out.push(line);
  }
  return out;
}
