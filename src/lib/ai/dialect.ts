// The HTML a model writes anyway — semantic tags and plain CSS — turned into the data-*
// form the schema parses, so one reply can carry a whole document: paragraph spacing,
// table widths, text boxes, picture placeholders, fields. A pure DOM pass on the inert
// document; what it does not know it leaves to the schema, which drops it as before.

import { normalizeColor } from '../utils/color';

export type DialectOptions = {
  /** A paragraph style by internal or display name, case-insensitive. */
  style?: (name: string) => string | null;
  tableStyle?: (name: string) => string | null;
};

const PT_PER: Record<string, number> = { pt: 1, px: 0.75, cm: 72 / 2.54, mm: 72 / 25.4, in: 72, em: 12, rem: 12, pc: 12 };
const PX_PER_CM = 96 / 2.54;
// The text width of A4 at 2cm margins, which a percentage of a frame refers to.
const TEXT_WIDTH_CM = 17;

/** A CSS length in points; a bare number counts as `bare` units. */
export function toPt(v: string | null | undefined, bare = 'px'): number | null {
  const m = /^\s*(-?[\d.]+)\s*([a-z%]*)\s*$/i.exec(v ?? '');
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || bare).toLowerCase();
  if (unit === '%') return null;
  return Number.isFinite(n) && PT_PER[unit] ? n * PT_PER[unit] : null;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const toCm = (v: string | null | undefined, bare = 'px') => { const pt = toPt(v, bare); return pt == null ? null : round(pt / PT_PER.cm); };
const toPx = (v: string | null | undefined, bare = 'px') => { const pt = toPt(v, bare); return pt == null ? null : Math.round(pt / PT_PER.px); };

/** `1px solid red` as the border attr (`0.75pt solid #FF0000`), or 'none'. */
function borderAttr(css: string): string | null {
  const parts = css.trim().split(/\s+(?![^(]*\))/);
  if (!parts[0] || parts.some((p) => /^(none|hidden)$/i.test(p)) || parts.some((p) => toPt(p) === 0)) return 'none';
  let pt = 0.5;
  let color = '#000000';
  for (const p of parts) {
    const w = toPt(p, 'none');
    if (w != null) pt = Math.max(0.25, round(w));
    else { const c = normalizeColor(p); if (c?.startsWith('#')) color = c; }
  }
  return `${pt}pt solid ${color}`;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** Writes `prefix-top` … from `border` and `border-<side>`. */
function borders(el: HTMLElement, prefix: string): void {
  const all = el.style.getPropertyValue('border');
  for (const side of SIDES) {
    const v = el.style.getPropertyValue(`border-${side}`) || all;
    const attr = v && borderAttr(v);
    if (attr) el.setAttribute(`${prefix}-${side}`, attr);
  }
}

const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function paragraph(el: HTMLElement, o: DialectOptions, dropped: string[]): void {
  const s = el.style;
  const cls = el.getAttribute('class');
  if (cls && o.style) {
    const name = o.style(cls.trim());
    if (name) el.setAttribute('data-style', name);
    else dropped.push(`unknown paragraph style "${cls}"`);
  }
  const set = (attr: string, v: number | string | null | undefined) => { if (v != null && v !== '') el.setAttribute(attr, String(v)); };
  const pt = (v: string) => { const n = toPt(v); return n == null ? null : round(n, 1); };
  set('data-space-before', s.marginTop ? pt(s.marginTop) : null);
  set('data-space-after', s.marginBottom ? pt(s.marginBottom) : null);
  set('data-indent', s.marginLeft ? toCm(s.marginLeft) : null);
  set('data-indent-right', s.marginRight ? toCm(s.marginRight) : null);
  set('data-indent-first', s.textIndent ? toCm(s.textIndent) : null);
  const lh = s.lineHeight;
  if (lh) {
    const factor = /^[\d.]+$/.test(lh) ? parseFloat(lh) : /%$/.test(lh) ? parseFloat(lh) / 100 : null;
    const fixed = factor == null ? toPt(lh) : null;
    set('data-line-height', factor != null ? round(factor) : fixed != null ? `${round(fixed, 1)}pt` : null);
  }
  const bg = normalizeColor(s.backgroundColor || s.background);
  if (bg?.startsWith('#')) el.setAttribute('data-bg', bg);
  borders(el, 'data-pborder');
  if (s.fontSize) { const n = toPt(s.fontSize); if (n) el.setAttribute('data-block-font-size', `${round(n, 1)}pt`); }
  if (s.fontFamily) el.setAttribute('data-block-font-family', s.fontFamily.split(',')[0].replace(/["']/g, '').trim());
  if (s.color) {
    // A block has no colour of its own; its runs take it.
    const span = el.ownerDocument.createElement('span');
    span.style.color = s.color;
    span.append(...el.childNodes);
    el.append(span);
  }
  if (/always|page/.test(s.pageBreakBefore + s.breakBefore)) el.setAttribute('data-page-break-before', 'page');
}

/** Column weights from `<col width>` and the cells' own `width`, as percentages. */
function columnWeights(table: HTMLTableElement): (number | null)[] {
  const fromLength = (v: string | null) => {
    if (!v) return null;
    if (/%\s*$/.test(v)) return parseFloat(v) || null;
    const cm = toCm(v);
    return cm ? (100 * cm) / TEXT_WIDTH_CM : null;
  };
  const weights: (number | null)[] = [];
  const cols = [...table.querySelectorAll(':scope > colgroup > col, :scope > col')] as HTMLElement[];
  cols.forEach((c, i) => { weights[i] = fromLength(c.getAttribute('width') || c.style.width); });
  for (const row of table.rows) {
    let col = 0;
    for (const cell of row.cells) {
      const w = fromLength(cell.getAttribute('width') || cell.style.width);
      if (w != null && cell.colSpan === 1) weights[col] ??= w;
      col += cell.colSpan;
      weights.length = Math.max(weights.length, col);
    }
  }
  return weights;
}

function table(t: HTMLTableElement, o: DialectOptions, dropped: string[]): void {
  const cls = t.getAttribute('class');
  if (cls && o.tableStyle) {
    const name = o.tableStyle(cls.trim());
    if (name) t.setAttribute('data-table-style', name);
    else dropped.push(`unknown table style "${cls}"`);
  }
  const weights = columnWeights(t);
  const known = weights.filter((w): w is number => w != null);
  // Columns without a width share what the others leave.
  const rest = known.length && known.length < weights.length ? Math.max(5, (100 - known.reduce((a, b) => a + b, 0)) / (weights.length - known.length)) : null;
  const filled = known.length ? Array.from(weights, (w) => Math.round(w ?? rest ?? 0)) : null;
  const noBorder = t.getAttribute('border') === '0';
  for (const row of t.rows) {
    let col = 0;
    for (const cell of row.cells) {
      if (filled) cell.setAttribute('colwidth', filled.slice(col, col + cell.colSpan).join(','));
      col += cell.colSpan;
      if (noBorder) for (const side of SIDES) cell.setAttribute(`data-border-${side}`, 'none');
      borders(cell, 'data-border');
      cell.removeAttribute('width');
    }
  }
  // TipTap would read <col> widths by cell index, skipping the first column.
  t.querySelectorAll('colgroup, col').forEach((c) => c.remove());
}

const WRAPS: Record<string, string> = { left: 'left', right: 'right' };

/** `<aside>` as a text box, anchored at the start of the paragraph after it. */
function textBox(el: HTMLElement): void {
  const doc = el.ownerDocument;
  const box = doc.createElement('div');
  box.setAttribute('data-textbox', '');
  const s = el.style;
  const width = s.width && /%$/.test(s.width) ? Math.round((parseFloat(s.width) / 100) * TEXT_WIDTH_CM * PX_PER_CM) : toPx(s.width || el.getAttribute('width'));
  box.style.width = `${width ?? 280}px`;
  box.style.height = `${toPx(s.height || el.getAttribute('height')) ?? 96}px`;
  const wrap = WRAPS[s.cssFloat || s.getPropertyValue('float')];
  if (wrap) box.setAttribute('data-wrap', wrap);
  const fill = normalizeColor(s.backgroundColor || s.background);
  box.setAttribute('data-fill', fill ?? '#FFFFFF');
  const border = s.getPropertyValue('border');
  const stroke = border ? borderAttr(border) : '1pt solid #000000';
  if (stroke && stroke !== 'none') {
    const [w, , c] = stroke.split(' ');
    box.setAttribute('data-stroke', c);
    box.setAttribute('data-stroke-width', String(parseFloat(w)));
  }
  // A box holds blocks; loose text in it becomes a paragraph.
  let loose: HTMLElement | null = null;
  for (const n of [...el.childNodes]) {
    const block = n.nodeType === 1 && !/^(SPAN|STRONG|B|EM|I|U|S|A|BR|SUB|SUP|MARK|IMG|INPUT|TIME)$/.test((n as Element).tagName);
    if (block) { loose = null; box.append(n); continue; }
    if (n.nodeType === 3 && !n.textContent!.trim()) continue;
    if (!loose) { loose = doc.createElement('p'); box.append(loose); }
    loose.append(n);
  }
  if (!box.firstChild) box.append(doc.createElement('p'));
  const next = el.nextElementSibling as HTMLElement | null;
  if (el.closest('p, h1, h2, h3, h4, h5, h6, li, td, th')) el.replaceWith(box);
  else if (next && BLOCKS.has(next.tagName)) { next.prepend(box); el.remove(); }
  else { const p = doc.createElement('p'); p.append(box); el.replaceWith(p); }
}

/** A grey picture labelled with `label`: a PNG where a canvas draws, else an SVG. */
export function placeholderImage(label: string, w: number, h: number, doc: Document): string {
  const canvas = doc.createElement('canvas');
  let g: CanvasRenderingContext2D | null = null;
  try { g = canvas.getContext('2d'); } catch { /* jsdom has no canvas */ }
  if (g) {
    canvas.width = w;
    canvas.height = h;
    g.fillStyle = '#E5E7EB';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#6B7280';
    g.font = `${Math.max(10, Math.min(16, Math.round(w / 10)))}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, w / 2, h / 2, w - 8);
    return canvas.toDataURL('image/png');
  }
  const esc = label.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#E5E7EB"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="14" fill="#6B7280">${esc}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function image(img: HTMLImageElement, dropped: string[]): void {
  const src = img.getAttribute('src');
  if (src && /^(data:|idb:)/i.test(src)) return;
  if (src) {
    dropped.push(`image ${src.slice(0, 60)} ignored: only a placeholder (<img alt> without src) can be inserted`);
    img.remove();
    return;
  }
  const s = img.style;
  const w = toPx(img.getAttribute('width') || s.width) ?? 150;
  const h = toPx(img.getAttribute('height') || s.height) ?? Math.round(w * 1.3);
  img.setAttribute('src', placeholderImage(img.getAttribute('alt') || 'Image', w, h, img.ownerDocument));
  img.setAttribute('width', String(w));
  img.setAttribute('height', String(h));
  const wrap = WRAPS[s.cssFloat || s.getPropertyValue('float')];
  if (wrap) img.setAttribute('data-wrap', wrap);
}

const FIELD_TOKEN = /\{(date|time)\}/g;
const PAGE_TOKEN = /\{(page|pages|chapter)\}/g;
const PAGE_FIELD: Record<string, string> = { page: 'number', pages: 'count', chapter: 'chapter' };

/** Every `re` match in the text under `root` replaced by the element `make` builds. */
function replaceTokens(root: HTMLElement, re: RegExp, make: (token: string) => Node): void {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const t of texts) {
    if (!t.data.match(re)) continue;
    const parts = t.data.split(re);
    t.replaceWith(...parts.map((p, i) => (i % 2 ? make(p) : root.ownerDocument.createTextNode(p))));
  }
}

function field(doc: Document, kind: string): HTMLElement {
  const span = doc.createElement('span');
  span.setAttribute('data-datetime-field', kind);
  return span;
}

/**
 * Rewrites `body` in place. Returns what it had to leave out, for a tool to report, and
 * whether the text holds tabs, which the parser keeps only with whitespace preserved.
 */
export function normalizeAiHtml(body: HTMLElement, o: DialectOptions = {}): { dropped: string[]; tabs: boolean } {
  const doc = body.ownerDocument;
  const dropped: string[] = [];
  for (const el of [...body.querySelectorAll('*')] as HTMLElement[]) {
    const tag = el.tagName;
    if (BLOCKS.has(tag)) paragraph(el, o, dropped);
    else if (tag === 'TABLE') table(el as HTMLTableElement, o, dropped);
    else if (tag === 'IMG') image(el as HTMLImageElement, dropped);
    else if (tag === 'HR') {
      const next = el.nextElementSibling;
      if (next) next.setAttribute('data-page-break-before', 'page');
      el.remove();
    } else if (tag === 'INPUT') {
      const span = doc.createElement('span');
      span.setAttribute('data-placeholder-field', el.getAttribute('placeholder') || el.getAttribute('value') || '…');
      el.replaceWith(span);
    } else if (tag === 'TIME') {
      el.replaceWith(field(doc, /^\d\d:\d\d/.test(el.getAttribute('datetime') ?? '') ? 'time' : 'date'));
    } else if (tag === 'SECTION') {
      const n = parseInt(el.getAttribute('columns') || el.style.columnCount, 10);
      if (n >= 2) {
        const div = doc.createElement('div');
        div.setAttribute('data-columns', String(Math.min(3, n)));
        div.append(...el.childNodes);
        el.replaceWith(div);
      }
    } else if (tag === 'NAV') {
      const toc = doc.createElement('div');
      toc.setAttribute('data-toc', '');
      toc.setAttribute('data-entries', 'null');
      el.replaceWith(toc);
    }
  }
  // After the tables, so a paragraph inside a box keeps what it was given.
  for (const el of [...body.querySelectorAll('aside')] as HTMLElement[]) textBox(el);
  replaceTokens(body, FIELD_TOKEN, (kind) => field(doc, kind));
  const tabs = (body.textContent ?? '').includes('\t');
  if (tabs) collapseSpaces(body);
  return { dropped, tabs };
}

// What the parser does to whitespace, minus the tabs, for a parse that preserves it.
function collapseSpaces(body: HTMLElement): void {
  const walker = body.ownerDocument.createTreeWalker(body, 4);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const t of texts) {
    const parent = t.parentElement!;
    const inline = /^(SPAN|STRONG|B|EM|I|U|S|A|SUB|SUP|MARK|P|H[1-6]|LI|TD|TH)$/.test(parent.tagName);
    if (!t.data.replace(/[ \r\n\f]/g, '')) {
      if (!inline || !t.previousSibling || !t.nextSibling) { t.remove(); continue; }
    }
    t.data = t.data.replace(/[ \r\n\f]+/g, ' ');
    if (!t.previousSibling && /^(P|H[1-6]|LI|TD|TH)$/.test(parent.tagName)) t.data = t.data.replace(/^ +/, '');
    if (!t.nextSibling && /^(P|H[1-6]|LI|TD|TH)$/.test(parent.tagName)) t.data = t.data.replace(/ +$/, '');
  }
}

/** Looks a name up among `names` by itself or its display label, case-insensitively. */
export function nameLookup(names: string[], label: (name: string) => string): (name: string) => string | null {
  const by = new Map<string, string>();
  for (const n of names) {
    by.set(n.toLowerCase(), n);
    by.set(label(n).toLowerCase(), n);
  }
  return (name) => by.get(name.trim().toLowerCase()) ?? null;
}

/** `{page}`, `{pages}` and `{chapter}` in a header or footer as their fields. */
export function pageFields(root: HTMLElement): void {
  replaceTokens(root, PAGE_TOKEN, (name) => {
    const span = root.ownerDocument.createElement('span');
    span.setAttribute('data-page-field', PAGE_FIELD[name]);
    return span;
  });
}

export type ZonePart = { zone: 'header' | 'footer'; variant: 'default' | 'first' | 'even'; html: string };
export type PageSpec = { size?: string; orientation?: string; margins?: { top: number; right: number; bottom: number; left: number }; start?: number };

/** CSS shorthand margins (`2cm`, `2cm 2.5cm`, … four values), bare numbers in cm. */
export function parseMargins(v: string): PageSpec['margins'] | undefined {
  const cm = v.trim().split(/[\s,/]+/).map((x) => toCm(x, 'cm'));
  if (!cm.length || cm.length > 4 || cm.some((x) => x == null || x < 0)) return undefined;
  const [top, right = top, bottom = top, left = right] = cm as number[];
  return { top, right, bottom, left };
}

/**
 * A reply as the document's parts: the body, any `<header>`/`<footer>` (`data-page` first
 * or even) and a `<page>` with its setup.
 */
export function splitDocumentHtml(html: string): { body: string; zones: ZonePart[]; page: PageSpec | null } {
  if (!/<(header|footer|page)\b/i.test(html)) return { body: html, zones: [], page: null };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  let page: PageSpec | null = null;
  for (const el of [...body.querySelectorAll('page')]) {
    const spec: PageSpec = {};
    const size = el.getAttribute('size') ?? el.getAttribute('format');
    if (size) spec.size = size;
    const o = el.getAttribute('orientation');
    if (o) spec.orientation = o;
    const m = el.getAttribute('margin') ?? el.getAttribute('margins');
    if (m) spec.margins = parseMargins(m);
    const start = parseInt(el.getAttribute('start') ?? '', 10);
    if (start >= 0) spec.start = start;
    page = { ...(page ?? {}), ...spec };
    // `<page …/>` is no void element: what follows it parsed as its children.
    el.replaceWith(...el.childNodes);
  }
  const zones: ZonePart[] = [];
  for (const el of [...body.querySelectorAll('header, footer')] as HTMLElement[]) {
    const v = el.getAttribute('data-page') ?? el.getAttribute('page');
    zones.push({ zone: el.tagName === 'HEADER' ? 'header' : 'footer', variant: v === 'first' || v === 'even' ? v : 'default', html: el.innerHTML.trim() });
    el.remove();
  }
  return { body: body.innerHTML.trim(), zones, page };
}
