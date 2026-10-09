// The document as the model reads it, and the model's HTML as editor content. Every
// textblock is one numbered line, so a tool can name a paragraph by its number; text
// struck through as a deletion is left out — the model sees the text as it would read.

import { DOMParser as PMDOMParser, DOMSerializer, Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { fitPastedSlice } from '../editor/paste';

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
    } else if (child.type.name === 'hardBreak') {
      text += '\n';
      map.push(at);
    }
  });
  return { text, map };
}

/** Where a cell sits: its table (numbered in document order), row and column, 1-based. */
export type CellAt = { table: number; tablePos: number; row: number; col: number };

export function blockTexts(doc: PMNode): Block[] {
  const out: Block[] = [];
  const tables: number[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.spec.tableRole === 'table') tables.push(pos);
    if (!node.isTextblock) return true;
    const p = parent?.type.name ?? '';
    const at = p === 'tableCell' || p === 'tableHeader' ? cellAt(doc, pos, tables) : null;
    const kind = node.type.name === 'heading' ? `h${node.attrs.level}`
      : p === 'listItem' ? 'li' : at ? `cell T${at.table} r${at.row} c${at.col}` : '';
    out.push({ n: out.length + 1, kind, from: pos + 1, to: pos + 1 + node.content.size, ...blockText(node, pos), fmt: formatNote(node) });
    return false;
  });
  return out;
}

const MARK_LABELS = ['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript', 'highlight'];

// The formatting a run carries, as the labels the model reads.
function runLabels(child: PMNode): string[] {
  const out: string[] = [];
  for (const m of child.marks) {
    if (MARK_LABELS.includes(m.type.name)) out.push(m.type.name);
    else if (m.type.name === 'textStyle') {
      if (m.attrs.fontFamily) out.push(`font "${m.attrs.fontFamily}"`);
      if (m.attrs.fontSize) out.push(`size ${m.attrs.fontSize}`);
      if (m.attrs.color) out.push(`color ${m.attrs.color}`);
    }
  }
  return out;
}

/** A textblock's style, alignment and direct formatting, quoting the runs that carry it. */
export function formatNote(node: PMNode): string {
  const parts: string[] = [];
  if (node.attrs.styleName && node.type.name !== 'heading') parts.push(`style "${node.attrs.styleName}"`);
  if (node.attrs.textAlign && !['left', 'start'].includes(node.attrs.textAlign)) parts.push(`align ${node.attrs.textAlign}`);
  const runs = new Map<string, string[]>();
  let whole = '';
  let prev: string[] = [];
  node.forEach((child) => {
    if (!child.isText || child.marks.some((m) => m.type.name === 'deletion')) return;
    const text = child.text ?? '';
    whole += text;
    const labels = runLabels(child);
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

// A fixed character budget (~15k tokens); small local models may want less.
const BUDGET = 60_000;

/**
 * The numbered document plus where the selection is. Over budget, the head and the
 * paragraphs around the selection stay; the gaps say how to fetch them.
 */
export function serializeDoc(state: EditorState, blocks = blockTexts(state.doc), budget = BUDGET): string {
  const { from, to, empty } = state.selection;
  const first = blockAt(blocks, from);
  const last = blockAt(blocks, to);
  const lines = blocks.map(blockLine);
  let body: string;
  if (lines.reduce((s, l) => s + l.length + 1, 0) <= budget) body = lines.join('\n');
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
    body = out.join('\n');
  }
  const where = empty
    ? `The cursor is in paragraph ${first?.n ?? 1}.`
    : `Selected: paragraphs ${first?.n ?? 1}–${last?.n ?? 1}: «${state.doc.textBetween(from, to, '\n', '')}»`;
  return `Document, one paragraph per line, numbered:\n${body}\n\n${where}`;
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
export function htmlToSlice(html: string, state: EditorState): Slice {
  const clean = stripFences(html).trim();
  const markup = /<\/?[a-z][\s\S]*>/i.test(clean)
    ? markdownEmphasis(clean)
    : clean.split(/\n+/).map((l) => `<p>${markdownEmphasis(escapeHtml(l))}</p>`).join('');
  const body = new DOMParser().parseFromString(markup, 'text/html').body;
  const slice = PMDOMParser.fromSchema(state.schema).parseSlice(body);
  return fitPastedSlice(slice, state);
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
