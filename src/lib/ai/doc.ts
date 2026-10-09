// The document as the model reads it, and the model's HTML as editor content. Every
// textblock is one numbered line, so a tool can name a paragraph by its number; text
// struck through as a deletion is left out — the model sees the text as it would read.

import { getSchema, type Editor } from '@tiptap/core';
import { DOMParser as PMDOMParser, DOMSerializer, Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { TableMap } from '@tiptap/pm/tables';
import { fitPastedSlice } from '../editor/paste';
import { zoneExtensions } from '../editor/extensions';
import { comments } from '../editor/extensions/comment';
import { headingNumbers } from '../editor/extensions/outline';
import { listNumberAt } from '../editor/extensions/listStyle';
import { pageOfElement, readVerticalMargins, topInEditor } from '../editor/extensions/pageBreaks';
import { styleSheet } from '../styles/sheet.svelte';
import { styleLabel } from '../i18n/i18n.svelte';
import { nameLookup, normalizeAiHtml, pageFields, type NoteText } from './dialect';
import { newNoteId } from '../editor/extensions/notes';
import { trackedReplace } from '../editor/extensions/trackChanges';
import { loadPageFormat } from '../storage/pageFormat';
import { loadOrientation } from '../storage/pageOrientation';
import { loadPageMargins } from '../storage/pageMargins';
import { loadDifferentFirstPage, loadDifferentOddEven, loadHfDoc, type HfDoc, type HfZone, type HfVariant } from '../storage/headerFooter';
import { headingStyleName, resolveStyle, type ResolvedStyle, type StyleSheet } from '../styles/styleSheet';

export type Block = {
  /** 1-based, as the model sees it. */
  n: number;
  kind: string;
  text: string;
  /** Content start and end of the textblock. */
  from: number;
  to: number;
  /** map[i] = document position of text character i. */
  map: number[];
  /** Style and direct formatting, ` {bold: "x"; style "Quote"}`, or ''. */
  fmt: string;
  /** Text columns of the section it is in, 1 outside one. */
  columns: number;
};

export function blockText(node: PMNode, pos: number): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  node.forEach((child, offset) => {
    const at = pos + 1 + offset;
    if (child.isText) {
      if (child.marks.some((m) => m.type.name === 'deletion')) return;
      const t = child.text ?? '';
      for (let k = 0; k < t.length; k++) { text += t[k]; map.push(at + k); }
    } else {
      // An inline atom reads as a token that covers it whole, so find can name it.
      const name = child.type.name;
      const token = name === 'hardBreak' ? '\n'
        : name === 'placeholderField' ? `‹${child.attrs.text}›`
        : name === 'dateTimeField' ? `{${child.attrs.kind}}`
        : name === 'image' ? (child.attrs.alt ? `{image ${JSON.stringify(clip(child.attrs.alt, 60))}}` : '{image}')
        : '';
      for (const ch of token) { text += ch; map.push(at); }
    }
  });
  return { text, map };
}

/** Where a cell sits: its table (numbered in document order), row and column, 1-based. */
export type CellAt = { table: number; tablePos: number; row: number; col: number };

export function blockTexts(doc: PMNode, sheet: StyleSheet = styleSheet()): Block[] {
  const out: Block[] = [];
  const tables: number[] = [];
  const headings = headingNumbers(doc, sheet.outline);
  const boxes: number[] = [];
  let section = { end: -1, count: 1 };
  doc.descendants((node, pos, parent, index) => {
    if (node.type.spec.tableRole === 'table') tables.push(pos);
    if (node.type.name === 'textBox') boxes.push(pos);
    if (node.type.name === 'columns') section = { end: pos + node.nodeSize, count: node.attrs.count };
    if (!node.isTextblock) return true;
    const p = parent?.type.name ?? '';
    // Where it sits (a text box, a cell, both), then what it is: a list item in a cell is both.
    const box = boxAt(doc, pos, boxes);
    const at = cellAt(doc, pos, tables);
    // The number the page shows ("VI", "2.1"), which the text refers to and the model can't count.
    const label = node.type.name === 'heading' ? headings.get(pos)?.label.trim()
      : p === 'listItem' && index === 0 ? listNumberAt(doc, pos, sheet)?.parts.join('.') : undefined;
    const kind = [box ? `box ${box}` : '', at ? `cell T${at.table} r${at.row} c${at.col}` : '',
      node.type.name === 'heading' ? `h${node.attrs.level}` : p === 'listItem' ? 'li' : '', label ?? ''].filter(Boolean).join(' ');
    out.push({ n: out.length + 1, kind, from: pos + 1, to: pos + 1 + node.content.size, ...blockText(node, pos), fmt: formatNote(node, sheet), columns: pos < section.end ? section.count : 1 });
    // A text box rides in the text; its paragraphs follow the one it is anchored in.
    let framed = false;
    node.forEach((child) => { framed ||= child.type.name === 'textBox'; });
    return framed;
  });
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

const MARK_LABELS = ['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript', 'highlight'];

// The formatting a run carries beyond its paragraph style, as the labels the model reads.
function runLabels(child: PMNode, base: ResolvedStyle): string[] {
  const out: string[] = [];
  for (const m of child.marks) {
    if (MARK_LABELS.includes(m.type.name)) out.push(m.type.name);
    else if (m.type.name === 'textStyle') {
      if (m.attrs.fontFamily && m.attrs.fontFamily.toLowerCase() !== base.text.fontFamily?.toLowerCase()) out.push(`font "${m.attrs.fontFamily}"`);
      if (m.attrs.fontSize && parseFloat(m.attrs.fontSize) !== base.text.fontSizePt) out.push(`size ${m.attrs.fontSize}`);
      if (m.attrs.color) out.push(`color ${m.attrs.color}`);
    }
  }
  return out;
}

/**
 * A textblock's style and the direct formatting its style does not already give,
 * quoting the runs that carry it.
 */
export function formatNote(node: PMNode, sheet: StyleSheet = styleSheet()): string {
  const parts: string[] = [];
  const heading = node.type.name === 'heading';
  const base = resolveStyle(sheet, node.attrs.styleName ?? (heading ? headingStyleName(node.attrs.level) : null));
  if (node.attrs.styleName && !heading) parts.push(`style "${node.attrs.styleName}"`);
  const align = node.attrs.textAlign;
  if (align && !['left', 'start'].includes(align) && align !== base.para.textAlign) parts.push(`align ${align}`);
  const runs = new Map<string, string[]>();
  let whole = '';
  let prev: string[] = [];
  node.forEach((child) => {
    if (!child.isText || child.marks.some((m) => m.type.name === 'deletion')) return;
    const text = child.text ?? '';
    whole += text;
    const labels = runLabels(child, base);
    for (const l of labels) {
      const list = runs.get(l) ?? [];
      if (prev.includes(l) && list.length) list[list.length - 1] += text;
      else list.push(text);
      runs.set(l, list);
    }
    prev = labels;
  });
  for (const [label, list] of runs) {
    const quoted = list.length === 1 && list[0] === whole ? 'all'
      : list.slice(0, 4).map((x) => JSON.stringify(x.length > 30 ? x.slice(0, 30) + '…' : x)).join(', ') + (list.length > 4 ? ', …' : '');
    parts.push(`${label}: ${quoted}`);
  }
  return parts.length ? ` {${parts.join('; ')}}` : '';
}

/** The cell around the textblock at `pos`; `tables` holds the table positions seen so far. */
export function cellAt(doc: PMNode, pos: number, tables: number[] = []): CellAt | null {
  const $p = doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) {
    if ($p.node(d).type.spec.tableRole !== 'table') continue;
    const tablePos = $p.before(d);
    const rect = TableMap.get($p.node(d)).findCell($p.before(d + 2) - $p.start(d));
    const index = tables.indexOf(tablePos);
    return { table: index < 0 ? 0 : index + 1, tablePos, row: rect.top + 1, col: rect.left + 1 };
  }
  return null;
}

/** The text box around `pos`, numbered in document order (`boxes` holds those seen so far); 0 outside one. */
function boxAt(doc: PMNode, pos: number, boxes: number[]): number {
  const $p = doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'textBox') return boxes.indexOf($p.before(d)) + 1;
  return 0;
}

/** The block the position lies in, or the last one before it. */
export function blockAt(blocks: Block[], pos: number): Block | undefined {
  let found: Block | undefined;
  for (const b of blocks) {
    if (b.from - 1 > pos) break;
    found = b;
  }
  return found;
}

export function blockLine(b: Block): string {
  return `[${b.n}${b.kind ? ' ' + b.kind : ''}] ${b.text.replace(/\n/g, ' ⏎ ')}${b.fmt}`;
}

/** The page each block starts on, and how full the last page is, from the last layout pass. */
export type PageLayout = { pages: number[]; lastFill: number };

export function pageLayout(view: EditorView, blocks: Block[]): PageLayout | null {
  const { grid } = readVerticalMargins(view.dom as HTMLElement);
  const els = blocks.map((b) => view.nodeDOM(b.from - 1) as HTMLElement | null);
  // No layout (a headless test, a view not yet painted): say nothing rather than "page 1".
  if (!(grid.heightOf(1) > 0) || !els.some((el) => el?.offsetHeight)) return null;
  const pages = els.map((el, i) => (el ? pageOfElement(view, el, grid) : i ? 0 : 1));
  for (let i = 1; i < pages.length; i++) pages[i] ||= pages[i - 1];
  // Trailing empty paragraphs fill nothing a reader sees.
  let k = blocks.length - 1;
  while (k > 0 && !(els[k] && (blocks[k].text.trim() || blocks[k].fmt))) k--;
  const last = els[k];
  let lastFill = 0;
  if (last) {
    const bottom = topInEditor(view, last) + last.offsetHeight;
    const page = grid.pageAt(bottom);
    lastFill = Math.round((100 * (bottom - grid.contentTopOf(page))) / (grid.contentBottomOf(page) - grid.contentTopOf(page)));
  }
  return { pages, lastFill: Math.max(0, Math.min(100, lastFill)) };
}

type ZoneNode = { type?: string; text?: string; content?: ZoneNode[] };
const ZONE_FIELDS: Record<string, string> = { pageNumber: '{page}', pageCount: '{pages}', chapterField: '{chapter}' };

function zoneText(doc: HfDoc): string {
  const lines: string[] = [];
  const inline = (n: ZoneNode) => (n.type === 'text' ? n.text ?? '' : n.type === 'hardBreak' ? ' ⏎ ' : ZONE_FIELDS[n.type ?? ''] ?? '');
  const walk = (n: ZoneNode) => {
    if (n.type === 'paragraph' || n.type === 'heading') lines.push((n.content ?? []).map(inline).join('').trim());
    else n.content?.forEach(walk);
  };
  if (doc) walk(doc as ZoneNode);
  return lines.filter(Boolean).join(' ⏎ ');
}

/** The page headers and footers as text, `{page}` standing for the page-number field. */
export function zoneLines(): string[] {
  const variants: [HfVariant, string][] = [['default', '']];
  if (loadDifferentFirstPage()) variants.push(['first', 'First-page ']);
  if (loadDifferentOddEven()) variants.push(['even', 'Even-page ']);
  const out: string[] = [];
  for (const [variant, prefix] of variants) {
    for (const zone of ['header', 'footer'] as HfZone[]) {
      const text = zoneText(loadHfDoc(zone, variant));
      if (text) out.push(`${prefix ? prefix + zone : zone === 'header' ? 'Header' : 'Footer'}: ${text}`);
    }
  }
  return out;
}

// A fixed character budget (~15k tokens); small local models may want less.
const BUDGET = 60_000;

/**
 * The numbered document plus where the selection is. Over budget, the head and the
 * paragraphs around the selection stay; the gaps say how to fetch them.
 */
export function serializeDoc(state: EditorState, blocks = blockTexts(state.doc), budget = BUDGET, layout: PageLayout | null = null): string {
  const { from, to, empty } = state.selection;
  const first = blockAt(blocks, from);
  const last = blockAt(blocks, to);
  const pages = layout?.pages;
  const lines = blocks.map((b, i) => (pages && i && pages[i] > pages[i - 1] ? `— page ${pages[i]} —\n` : '')
    + (b.columns !== (blocks[i - 1]?.columns ?? 1) ? `— ${b.columns > 1 ? `${b.columns} columns` : 'end of columns'} —\n` : '') + blockLine(b));
  let body: string;
  if (lines.reduce((s, l) => s + l.length + 1, 0) <= budget) body = collapseEmpty(lines).join('\n');
  else {
    const keep = new Set<number>();
    let used = 0;
    const take = (i: number) => {
      if (i < 0 || i >= lines.length || keep.has(i) || used + lines[i].length > budget) return false;
      keep.add(i);
      used += lines[i].length + 1;
      return true;
    };
    for (let i = 0; i < 20; i++) take(i);
    const focus = (first?.n ?? 1) - 1;
    for (let d = 0; d < lines.length; d++) if (!take(focus + d) && !take(focus - d) && used >= budget * 0.98) break;
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (keep.has(i)) { out.push(lines[i]); continue; }
      let j = i;
      while (j + 1 < lines.length && !keep.has(j + 1)) j++;
      out.push(`[… paragraphs ${i + 1}–${j + 1} omitted; read_blocks returns them]`);
      i = j;
    }
    body = collapseEmpty(out).join('\n');
  }
  if (layout) body += `\n— end of page ${pages![pages!.length - 1]}, about ${layout.lastFill}% full —`;
  const m = loadPageMargins();
  body += `\n\nPage: ${loadPageFormat()} ${loadOrientation()}, margins ${[m.top, m.right, m.bottom, m.left].join('/')} cm (top/right/bottom/left)`
    + (pages ? `, ${pages[pages.length - 1]} page${pages[pages.length - 1] > 1 ? 's' : ''}` : '');
  const zones = zoneLines();
  if (zones.length) body += `\nPage headers and footers:\n${zones.join('\n')}`;
  const notes = commentLines(state.doc, blocks);
  if (notes.length) body += `\n\nComments, numbered:\n${notes.join('\n')}`;
  const where = empty
    ? `The cursor is in paragraph ${first?.n ?? 1}.`
    : `Selected: paragraphs ${first?.n ?? 1}–${last?.n ?? 1}: «${state.doc.textBetween(from, to, '\n', '')}»`;
  return `Document, one paragraph per line, numbered:\n${body}\n\n${where}`;
}

/** A run of plain empty paragraphs as one line, `[12–28] (empty)`; their numbers stay. */
function collapseEmpty(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && /^\[\d+\] $/.test(lines[i]) && /^\[\d+\] $/.test(lines[j + 1])) j++;
    out.push(j > i ? `[${lines[i].slice(1, -2)}–${lines[j].slice(1, -2)}] (empty)` : lines[i]);
    i = j;
  }
  return out;
}

/** Every comment thread as `[C1 on paragraph 4 «quote», by Ada, open] text`, replies indented. */
export function commentLines(doc: PMNode, blocks = blockTexts(doc)): string[] {
  return comments(doc).flatMap((c, i) => [
    `[C${i + 1} on paragraph ${blockAt(blocks, c.from)?.n ?? 1} «${clip(c.quote, 60)}», by ${c.author || '?'}, ${c.resolved ? 'resolved' : 'open'}] ${c.text}`,
    ...c.replies.map((r) => `  ↳ ${r.author || '?'}: ${r.text}`),
  ]);
}

/** The selection as HTML, so its formatting reaches the model. */
export function selectionHtml(state: EditorState): string {
  const { from, to } = state.selection;
  const div = document.createElement('div');
  div.appendChild(DOMSerializer.fromSchema(state.schema).serializeFragment(state.doc.slice(from, to).content));
  return div.innerHTML;
}

/** A reply wrapped in a code fence despite the prompt, unwrapped. */
export function stripFences(text: string): string {
  return text.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Markdown emphasis that models mix into their HTML despite the prompt; `2 * 3 * 4` stays. */
function markdownEmphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, '<em>$1</em>');
}

/**
 * The model's HTML as a slice fitted for `state`'s selection. Parsed in an inert
 * document (no script runs, no image loads) and through the schema, which keeps only
 * what the editor knows; a reply without tags becomes one paragraph per line.
 */
function dialectBody(html: string, dropped: string[], notes: NoteText[] = []): { body: HTMLElement; tabs: boolean } {
  const clean = stripFences(html).trim();
  const markup = /<\/?[a-z][\s\S]*>/i.test(clean)
    ? markdownEmphasis(clean)
    : clean.split(/\n+/).map((l) => `<p>${markdownEmphasis(escapeHtml(l))}</p>`).join('');
  const body = new DOMParser().parseFromString(markup, 'text/html').body;
  // The line breaks between a reply's blocks are layout, not text: at the top they would
  // each become a paragraph holding a space.
  for (const n of [...body.childNodes]) if (n.nodeType === Node.TEXT_NODE && !n.textContent!.trim()) n.remove();
  const sheet = styleSheet();
  const dialect = normalizeAiHtml(body, {
    style: nameLookup(Object.keys(sheet.paragraph), styleLabel),
    tableStyle: nameLookup(Object.keys(sheet.table), styleLabel),
    noteId: newNoteId,
  });
  dropped.push(...dialect.dropped);
  notes.push(...dialect.notes);
  return { body, tabs: dialect.tabs };
}

let zoneSchema: Schema | null = null;

/** A header's or footer's HTML as its stored document ({page} a field); empty HTML removes the zone. */
export function zoneDocFromHtml(html: string, dropped: string[] = []): HfDoc {
  if (!html.trim()) return null;
  zoneSchema ??= getSchema(zoneExtensions());
  const { body, tabs } = dialectBody(html, dropped);
  pageFields(body);
  return PMDOMParser.fromSchema(zoneSchema).parse(body, { preserveWhitespace: tabs }).toJSON() as HfDoc;
}

export function htmlToSlice(html: string, state: EditorState, dropped: string[] = [], notes: NoteText[] = []): Slice {
  const { body, tabs } = dialectBody(html, dropped, notes);
  const parsed = PMDOMParser.fromSchema(state.schema).parseSlice(body, { preserveWhitespace: tabs });
  // A table of contents written as <nav> has no entries yet: null builds them on mount.
  const content: PMNode[] = [];
  parsed.content.forEach((n) => content.push(n.type.name === 'tableOfContents' && !n.attrs.entries?.length ? n.type.create({ ...n.attrs, entries: null }) : n));
  return fitPastedSlice(new Slice(Fragment.from(content), parsed.openStart, parsed.openEnd), state);
}

/**
 * Writes each note's text into the note its anchor got once inserted; with an `author`
 * as that author's tracked insertion.
 */
export function fillNotes(editor: Editor, notes: NoteText[], author?: string): void {
  for (const n of notes) {
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'note' && node.attrs.id === n.id) at = pos;
      return at < 0;
    });
    const note = at < 0 ? null : editor.state.doc.nodeAt(at);
    if (!note) continue;
    const content = inlineContent(htmlToSlice(n.html, editor.state), editor.schema);
    if (!content.size) continue;
    const tr = editor.state.tr;
    const [from, to] = [at + 1, at + 1 + note.content.size];
    if (author) trackedReplace(tr, from, to, new Slice(content, 0, 0), author);
    else tr.replaceWith(from, to, content);
    editor.view.dispatch(tr);
  }
}

/** Editor content as DOM for a preview: only nodes the schema knows, so nothing runs. */
export function contentToDom(content: Fragment, schema: Schema): HTMLElement | DocumentFragment {
  const dom = DOMSerializer.fromSchema(schema).serializeFragment(content);
  for (const a of dom.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener'; }
  return dom;
}

/** A slice's inline content, for a target that holds no blocks (one paragraph's text). */
export function inlineContent(slice: Slice, schema: Schema): Fragment {
  const out: PMNode[] = [];
  const br = schema.nodes.hardBreak;
  const take = (block: PMNode) => {
    if (out.length && br) out.push(br.create());
    block.forEach((n) => out.push(n));
  };
  slice.content.forEach((node) => {
    if (node.isInline) return void out.push(node);
    if (node.isTextblock) return take(node);
    node.descendants((child) => {
      if (child.isTextblock) take(child);
      return !child.isTextblock;
    });
  });
  return Fragment.fromArray(out);
}
