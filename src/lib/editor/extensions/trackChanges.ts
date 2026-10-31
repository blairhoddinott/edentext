import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Mark as PMMark, NodeRange, Slice, type Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { isHistoryTransaction } from '@tiptap/pm/history';
import { EditorState, Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import { CellSelection, TableMap, removeColumn, removeRow } from '@tiptap/pm/tables';
import { AddMarkStep, AttrStep, Mapping, RemoveMarkStep, ReplaceAroundStep, ReplaceStep, liftTarget, type Step, type StepMap } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { authorColor, authorColors } from '../authorColors';

// Recorded revisions, as both word processors keep them: an insertion is text marked as
// added, a deletion is text still in the document but marked as removed — nothing is
// dropped until a change is accepted. Two marks carry it (author, date and a shared id
// per change), so a revision survives every editing operation the way a comment does.
//
// ODF stores the pair in a <text:tracked-changes> registry and points at it from the
// body; a deletion's text lives in the registry, an insertion's stays inline. Word wraps
// runs in <w:ins>/<w:del> instead, keeping a deletion's text in <w:delText>. Both are
// probed — see docs/architecture/review.md.
//
// A paragraph mark is no text, so a mark cannot carry its change: the `revMark` attr of the
// block it ends does, holding the insertion, the deletion or both. A table row and a cell of
// a recorded column carry theirs the same way.
//
// A format change is the `formatChange` mark, which holds the marks its text had before;
// a block's own format change is its `revFormat` attr.

export type RevisionKind = 'insertion' | 'deletion' | 'formatChange';
type MarkedKind = 'insertion' | 'deletion';
const KINDS = ['insertion', 'deletion'] as const;

export type Revision = {
  kind: RevisionKind;
  id: string;
  author: string;
  date: string;
  from: number;
  to: number;
  /** The text the change covers — a deletion's is what would come back on reject; a
   *  paragraph mark in it reads as a newline. */
  text: string;
  /** The inline stretches of the change, each within one textblock. */
  spans: [number, number][];
  /** The blocks whose paragraph mark belongs to the change, with the rows and cells. */
  marks: number[];
  /** Set when the change is a table's: its rows, or a column of cells. */
  table?: 'row' | 'column';
  /** A format change: the names of the marks that differ from what the text had. */
  changed?: string[];
};

export type RevisionAttrs = { id: string; author: string; date: string };
export type RevMark = { insertion?: RevisionAttrs; deletion?: RevisionAttrs };
/** One list around a block, outermost first. */
export type ListLevel = { type: string; attrs: Record<string, unknown> };
/** A block's own format: its type, every attr that shows and the lists around it; `list`
 *  is absent where a file does not say. */
export type BlockFormat = { type: string; attrs: Record<string, unknown>; list?: ListLevel[] };
export type RevFormat = RevisionAttrs & { old: BlockFormat | null };

export function newRevisionId(): string {
  return `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

// Whether the editor is recording. A document-level switch, like LibreOffice's Edit ▸
// Track Changes ▸ Record; the extension reads it through this option so the toolbar can
// flip it without rebuilding the editor.
export const RECORDING = new PluginKey<boolean>('trackChangesRecording');
// Set on an edit that passed unrecorded because it only moves content, so none is marked.
const MOVED = 'trackChangesMoved';

function revisionMark(name: RevisionKind, attr: string) {
  return Mark.create({
    name,
    // The range is fixed: typing at either end is its own change, as in Word.
    inclusive: false,
    excludes: '',

    addAttributes() {
      return {
        id: { default: '', parseHTML: (el) => el.getAttribute(attr) || '', renderHTML: (a) => ({ [attr]: String(a.id ?? '') }) },
        author: { default: '', parseHTML: (el) => el.getAttribute('data-rev-author') || '', renderHTML: (a) => ({ 'data-rev-author': String(a.author ?? '') }) },
        date: { default: '', parseHTML: (el) => el.getAttribute('data-rev-date') || '', renderHTML: (a) => ({ 'data-rev-date': String(a.date ?? '') }) },
      };
    },

    parseHTML() {
      return [{ tag: `span[${attr}]` }];
    },

    renderHTML({ HTMLAttributes }) {
      return ['span', mergeAttributes(HTMLAttributes, { class: `pm-${name}` }), 0];
    },
  });
}

export const Insertion = revisionMark('insertion', 'data-insertion');
export const Deletion = revisionMark('deletion', 'data-deletion');

// `old` is the marks the text had, as JSON; null when the file does not say (ODF).
export const FormatChange = revisionMark('formatChange', 'data-format-change').extend({
  excludes: 'formatChange',
  addAttributes() {
    return {
      ...this.parent?.(),
      old: {
        default: null,
        parseHTML: (el) => { try { return JSON.parse(el.getAttribute('data-rev-old') ?? 'null'); } catch { return null; } },
        renderHTML: (a) => (a.old ? { 'data-rev-old': JSON.stringify(a.old) } : {}),
      },
    };
  },
});

/** Marks that say nothing about how text looks. */
export const UNFORMATTED_MARKS = new Set(['link', 'bookmark', 'comment', 'insertion', 'deletion', 'formatChange']);
const formatOf = (marks: readonly PMMark[]) => marks.filter((m) => !UNFORMATTED_MARKS.has(m.type.name));

const UNFORMATTED_ATTRS = new Set(['revMark', 'revFormat', 'joinPrev', 'sectionBreak']);
export function blockFormat(type: string, attrs: Record<string, unknown>): BlockFormat {
  return { type, attrs: Object.fromEntries(Object.entries(attrs).filter(([k, v]) => !UNFORMATTED_ATTRS.has(k) && v != null)) };
}
const LISTS = new Set(['bulletList', 'orderedList']);
function listChain(doc: PMNode, pos: number): ListLevel[] {
  const $pos = doc.resolve(pos), out: ListLevel[] = [];
  for (let d = 1; d <= $pos.depth; d++) {
    const { type, attrs } = $pos.node(d);
    if (LISTS.has(type.name)) out.push({ type: type.name, attrs });
  }
  return out;
}
const sameLists = (a: ListLevel[] | undefined, b: ListLevel[]) => !a || a.map((l) => l.type).join() === b.map((l) => l.type).join();
export const sameBlockFormat = (a: BlockFormat, b: BlockFormat) => a.type === b.type
  && Object.keys({ ...a.attrs, ...b.attrs }).every((k) => JSON.stringify(a.attrs[k]) === JSON.stringify(b.attrs[k]));

// A file numbers each run and paragraph mark of one edit on its own: touching stretches
// by one author at one moment are one change, as both word processors show them.
function sameChange(prev: Revision, attrs: RevisionAttrs): boolean {
  return prev.id === String(attrs.id ?? '') || (!!prev.date && prev.date === attrs.date && prev.author === attrs.author);
}

const tableLine = (node: PMNode): 'row' | 'column' | null => {
  const role = node.type.spec.tableRole;
  return role === 'row' ? 'row' : role === 'cell' || role === 'header_cell' ? 'column' : null;
};

// Every recorded change in document order, adjacent runs of one change merged, across a
// paragraph mark of it too. Text one author inserted and another struck through is in
// both: the insertion and its deletion.
export function revisions(doc: PMNode): Revision[] {
  const out: Revision[] = [];
  const last: Record<RevisionKind, Revision | null> = { insertion: null, deletion: null, formatChange: null };
  // The changes whose paragraph mark closed the block before: they reach the next one's start.
  let bridging: Revision[] = [];
  const inline = (node: PMNode, pos: number) => {
    for (const kind of [...KINDS, 'formatChange'] as const) {
      const mark = node.marks.find((m) => m.type.name === kind);
      if (!mark) { last[kind] = null; continue; }
      const prev = last[kind];
      if (prev && sameChange(prev, mark.attrs as RevisionAttrs) && prev.to === pos) {
        const span = prev.spans[prev.spans.length - 1];
        if (span?.[1] === pos) span[1] = pos + node.nodeSize;
        else prev.spans.push([pos, pos + node.nodeSize]);
        prev.to = pos + node.nodeSize;
        prev.text += node.text ?? '';
        continue;
      }
      out.push(last[kind] = {
        kind,
        id: String(mark.attrs.id ?? ''),
        author: String(mark.attrs.author ?? ''),
        date: String(mark.attrs.date ?? ''),
        from: pos, to: pos + node.nodeSize, text: node.text ?? '',
        spans: [[pos, pos + node.nodeSize]], marks: [],
        ...(kind === 'formatChange' ? { changed: changedMarks(node, mark) } : {}),
      });
    }
  };
  const visit = (node: PMNode, pos: number): boolean => {
    if (!node.isTextblock) {
      const table = tableLine(node), rev = node.attrs.revMark as RevMark | null | undefined;
      if (table && rev) for (const kind of KINDS) {
        const attrs = rev[kind];
        if (attrs) out.push({ kind, ...attrs, from: pos, to: pos + node.nodeSize, text: '', spans: [], marks: [pos], table });
      }
      return true;
    }
    for (const r of bridging) r.to = pos + 1;
    bridging = [];
    const format = node.attrs.revFormat as RevFormat | null | undefined;
    if (format) {
      const { id, author, date } = format;
      out.push({ kind: 'formatChange', id, author, date, from: pos + 1, to: pos + node.nodeSize - 1, text: node.textContent, spans: [], marks: [pos], changed: [] });
    }
    node.forEach((child, offset) => {
      const at = pos + 1 + offset;
      // A line break or field is inline as text is, and a recorded one goes with its change;
      // so does a text box, with everything in it.
      const recorded = child.marks.some((m) => m.type.name === 'insertion' || m.type.name === 'deletion');
      if (child.isLeaf || recorded) { inline(child, at); return; }
      last.insertion = last.deletion = last.formatChange = null;
      child.descendants((n, p) => visit(n, at + 1 + p));
    });
    const end = pos + node.nodeSize - 1, marks = node.attrs.revMark as RevMark | null | undefined;
    for (const kind of KINDS) {
      const attrs = marks?.[kind];
      if (!attrs) { last[kind] = null; continue; }
      const prev = last[kind];
      if (prev && sameChange(prev, attrs) && prev.to === end) {
        prev.marks.push(pos);
        prev.text += '\n';
      } else {
        out.push(last[kind] = { kind, ...attrs, from: end, to: end, text: '', spans: [], marks: [pos] });
      }
      bridging.push(last[kind]!);
    }
    return false;
  };
  doc.descendants(visit);
  return gatherChanges(out);
}

// The marks a format change put on or took off `node`.
function changedMarks(node: PMNode, change: PMMark): string[] {
  const old = (change.attrs.old ?? []) as { type: string }[], now = formatOf(node.marks).map((m) => m.toJSON() as { type: string });
  const has = (list: unknown[], m: unknown) => list.some((o) => JSON.stringify(o) === JSON.stringify(m));
  return [...new Set([...now.filter((m) => !has(old, m)), ...old.filter((m) => !has(now, m))].map((m) => m.type))];
}

// A row or column change is one change over its cells and all the text in them, which no
// adjacency in the document joins; so is one format change over runs it left out.
function gatherChanges(list: Revision[]): Revision[] {
  const hosts: Revision[] = [];
  const hostOf = (r: Revision) => hosts.find((h) => h.kind === r.kind && (r.kind === 'formatChange' ? h.id === r.id : sameChange(h, r)));
  for (const r of list) if ((r.table || r.kind === 'formatChange') && !hostOf(r)) hosts.push(r);
  return list.filter((r) => {
    const host = hostOf(r);
    if (!host || host === r) return true;
    host.spans.push(...r.spans);
    host.marks.push(...r.marks);
    host.text += r.text;
    if (r.changed) host.changed = [...new Set([...host.changed!, ...r.changed])];
    host.from = Math.min(host.from, r.from);
    host.to = Math.max(host.to, r.to);
    return false;
  });
}

/** The change the selection lies within — what the pane highlights and the bar thickens. */
export function revisionIdAt(state: EditorState, list?: Revision[]): string | null {
  const { from, to } = state.selection;
  // By range, not by the marks at the caret: both marks are non-inclusive, so a selection
  // over the whole change — what a click on the pane's card makes — carries none.
  return (list ?? revisions(state.doc)).find((r) => r.from <= from && to <= r.to)?.id ?? null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackChanges: {
      /** Accept the change under the cursor, or every one when `all`. */
      acceptRevisions: (all?: boolean) => ReturnType;
      /** Reject the change under the cursor, or every one when `all`. */
      rejectRevisions: (all?: boolean) => ReturnType;
      /** Accept every range of one change, wherever the reviewing pane lists it. */
      acceptRevision: (id: string) => ReturnType;
      /** Reject every range of one change. */
      rejectRevision: (id: string) => ReturnType;
    };
  }
}

// The revisions a command applies to: all of them, or the ones the selection touches
// (an empty selection takes the change the caret sits in).
function targets(state: EditorState, all: boolean): Revision[] {
  const list = revisions(state.doc);
  if (all) return list;
  const { from, to } = state.selection;
  return list.filter((r) => (from === to ? r.from <= from && from <= r.to : r.from < to && from < r.to));
}

// Applying changes runs from the end, mapped. The RECORDING meta keeps the plugin's hands
// off it: without it the delete below is read as a fresh user deletion and marked up again.
// One change by id — every range of it, which is what a paragraph boundary splits a
// change into and what the pane lists as a single revision.
function byId(state: EditorState, tr: Transaction, dispatch: unknown, id: string, accept: boolean): boolean {
  const list = revisions(state.doc).filter((r) => r.id === id);
  if (!list.length) return false;
  if (dispatch) apply(state, tr, list, accept);
  return true;
}

// An insertion and the deletion struck through it share their range, hence the mapping.
// Paragraph marks go last, from the end: whether a block merges or goes depends on the text
// left in it, and a merge takes over the mark of the block it swallowed.
function apply(state: EditorState, tr: Transaction, list: Revision[], accept: boolean): void {
  const drop = accept ? 'deletion' : 'insertion';
  const stretches = list.flatMap((r) => r.spans.map(([from, to]) => ({ r, from, to })));
  for (const { r, from: f, to: t } of stretches.sort((a, b) => b.from - a.from)) {
    const from = tr.mapping.map(f, 1), to = tr.mapping.map(t, -1);
    if (to <= from) continue;
    if (r.kind === drop) tr.delete(from, to);
    else {
      if (r.kind === 'formatChange' && !accept) restoreFormat(tr, from, to);
      tr.removeMark(from, to, state.schema.marks[r.kind]);
    }
  }
  const marks = list.flatMap((r) => (r.kind === 'formatChange' ? [] : r.marks.map((pos) => ({ pos, kind: r.kind as MarkedKind }))));
  marks.sort((a, b) => b.pos - a.pos || Number(a.kind === drop) - Number(b.kind === drop));
  for (const { pos, kind } of marks) {
    const { pos: at, deleted } = tr.mapping.mapResult(pos, 1);
    const rev = tr.doc.nodeAt(at)?.attrs.revMark as RevMark | null | undefined;
    if (deleted || !rev?.[kind]) continue;
    if (kind === drop) removeParagraphMark(tr, at);
    else {
      const { [kind]: _gone, ...rest } = rev;
      tr.setNodeAttribute(at, 'revMark', Object.keys(rest).length ? rest : null);
    }
  }
  // From the start: a block going back into a list joins the lists before it.
  const formats = list.flatMap((r) => (r.kind === 'formatChange' ? r.marks : []));
  for (const pos of formats.sort((a, b) => a - b)) settleBlockFormat(tr, pos, accept);
  tr.setMeta(RECORDING, true);
}

// Puts back what each run of a format change held. Without a record it loses its direct
// formatting, as in LibreOffice after a reload (probed).
function restoreFormat(tr: Transaction, from: number, to: number): void {
  const { schema } = tr.doc.type;
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!isMarkable(node)) return true;
    const a = Math.max(pos, from), b = Math.min(pos + node.nodeSize, to);
    const change = node.marks.find((m) => m.type.name === 'formatChange');
    for (const mark of formatOf(node.marks)) tr.removeMark(a, b, mark);
    for (const old of (change?.attrs.old ?? []) as Record<string, unknown>[]) tr.addMark(a, b, schema.markFromJSON(old));
    return false;
  });
}

function settleBlockFormat(tr: Transaction, pos: number, accept: boolean): void {
  const { pos: at, deleted } = tr.mapping.mapResult(pos, 1), node = tr.doc.nodeAt(at);
  const old = (node?.attrs.revFormat as RevFormat | null | undefined)?.old;
  if (deleted || !node?.attrs.revFormat) return;
  if (accept || !old) { tr.setNodeAttribute(at, 'revFormat', null); return; }
  const kept = Object.fromEntries([...UNFORMATTED_ATTRS].map((k) => [k, node.attrs[k]]));
  tr.setNodeMarkup(at, tr.doc.type.schema.nodes[old.type], { ...old.attrs, ...kept, revFormat: null });
  if (!sameLists(old.list, listChain(tr.doc, at))) restoreLists(tr, at, old.list!);
}

// Takes the block at `pos` out of its lists and back into `levels`, inside the lists beside it.
function restoreLists(tr: Transaction, pos: number, levels: ListLevel[]): void {
  const { nodes } = tr.doc.type.schema, start = tr.steps.length;
  const here = () => tr.mapping.slice(start).map(pos, 1);
  const rangeAt = (at: number) => {
    const $at = tr.doc.resolve(at);
    return new NodeRange($at, tr.doc.resolve(at + tr.doc.nodeAt(at)!.nodeSize), $at.depth);
  };
  while (listChain(tr.doc, here()).length) {
    const range = rangeAt(here()), target = liftTarget(range);
    if (target == null) return;
    tr.lift(range, target);
  }
  if (!levels.length) return;
  tr.wrap(rangeAt(here()), levels.flatMap((l) => [{ type: nodes[l.type], attrs: l.attrs }, { type: nodes.listItem }]));
  const sameBeside = (a: PMNode | null | undefined, b: PMNode | null | undefined) => !!a && !!b && a.type === b.type;
  // Inner levels join the list and item before them; the block's own item stays its own.
  const first = tr.doc.resolve(here()).depth - levels.length * 2 + 1;
  for (let d = first; d < first + levels.length * 2 - 1; d++) {
    const $at = tr.doc.resolve(here()), at = $at.before(d);
    if (sameBeside(tr.doc.resolve(at).nodeBefore, $at.node(d))) tr.join(at);
  }
  for (let d = tr.doc.resolve(here()).depth - 1; d > 0; d--) {
    const $at = tr.doc.resolve(here());
    if (!LISTS.has($at.node(d).type.name)) continue;
    const at = $at.after(d);
    if (sameBeside(tr.doc.resolve(at).nodeAfter, $at.node(d))) tr.join(at);
  }
}

const LIST_NODES = new Set(['listItem', 'bulletList', 'orderedList']);
const hasParagraphMark = (node: PMNode) => node.type.name === 'paragraph' || node.type.name === 'heading';

// The start of the textblock a paragraph mark at `end` runs into, null where none can: the
// last block of a cell, a frame or the document, or one a table follows.
function nextParagraph(doc: PMNode, end: number): number | null {
  const $end = doc.resolve(end);
  for (let depth = $end.depth; depth > 0; depth--) {
    const parent = $end.node(depth - 1), index = $end.index(depth - 1);
    if (index + 1 < parent.childCount) {
      let node = parent.child(index + 1), at = $end.after(depth);
      while (!node.isTextblock) {
        if (!LIST_NODES.has(node.type.name) || !node.childCount) return null;
        node = node.firstChild!;
        at++;
      }
      return hasParagraphMark(node) ? at + 1 : null;
    }
    if (!LIST_NODES.has(parent.type.name)) return null;
  }
  return null;
}

// A paragraph mark gone for good, as LibreOffice does it (probed): a block left empty goes
// and the next stays as it is; else the next one's text joins it, under the first block's
// format and the second's mark. Where nothing follows, the block just loses its mark.
function removeParagraphMark(tr: Transaction, pos: number): void {
  const block = tr.doc.nodeAt(pos)!, end = pos + block.nodeSize - 1;
  const line = tableLine(block);
  if (line) { removeTableLine(tr, pos, line); return; }
  const next = nextParagraph(tr.doc, end), $pos = tr.doc.resolve(pos);
  if (!block.content.size && (next !== null || $pos.parent.childCount > 1)) {
    tr.deleteRange(pos, pos + block.nodeSize);
    return;
  }
  const taken = next === null ? null : tr.doc.resolve(next).parent.attrs.revMark;
  const before = tr.steps.length;
  if (next !== null) tr.delete(end, next);
  tr.setNodeAttribute(pos, 'revMark', tr.steps.length > before ? taken ?? null : null);
}

// The blocks nothing of which is left once a kind of change is out: all their text belongs
// to it, and so does a paragraph mark on either end. The page drops them in a view that
// hides the kind; a block with text left beside such a mark stays a block of its own.
function goneBlocks(doc: PMNode): { pos: number; size: number; kind: RevisionKind }[] {
  const out: { pos: number; size: number; kind: RevisionKind }[] = [];
  let before: RevMark | null = null;
  doc.descendants((node, pos) => {
    const line = tableLine(node);
    if (line) for (const kind of KINDS) {
      if ((node.attrs.revMark as RevMark | null)?.[kind]) out.push({ pos, size: node.nodeSize, kind });
    }
    if (!hasParagraphMark(node)) return true;
    const rev = node.attrs.revMark as RevMark | null;
    for (const kind of KINDS) {
      let all = !!(rev?.[kind] ?? before?.[kind]);
      node.forEach((child) => { all &&= child.marks.some((m) => m.type.name === kind); });
      if (all) out.push({ pos, size: node.nodeSize, kind });
    }
    before = rev;
    return true;
  });
  return out;
}

/** The document with every change accepted or rejected, for a page built from it. */
export function settledDoc(doc: PMNode, accept: boolean): PMNode {
  const state = EditorState.create({ doc }), tr = state.tr;
  apply(state, tr, revisions(doc), accept);
  return tr.doc;
}

// A row or column gone for good; with its last one the table goes.
function removeTableLine(tr: Transaction, pos: number, line: 'row' | 'column'): void {
  const $pos = tr.doc.resolve(pos), depth = line === 'row' ? $pos.depth : $pos.depth - 1;
  const table = $pos.node(depth), tableStart = $pos.start(depth), map = TableMap.get(table);
  if ((line === 'row' ? map.height : map.width) === 1) {
    tr.delete($pos.before(depth), $pos.after(depth));
    return;
  }
  const rect = { map, table, tableStart, left: 0, top: 0, right: 0, bottom: 0 };
  if (line === 'row') removeRow(tr, rect, $pos.index(depth));
  else removeColumn(tr, rect, map.colCount(pos - tableStart));
}

export const TrackChanges = Extension.create<{ recording: () => boolean; author: () => string; plain: () => boolean }>({
  name: 'trackChanges',

  addOptions() {
    return { recording: () => false, author: () => '', plain: () => false };
  },

  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading', 'tableRow', 'tableCell', 'tableHeader'],
      attributes: {
        revMark: {
          default: null,
          keepOnSplit: false,
          parseHTML: (el: HTMLElement) => {
            try { return JSON.parse(el.getAttribute('data-rev-mark') ?? 'null'); } catch { return null; }
          },
          renderHTML: (a: Record<string, unknown>) => (a.revMark ? { 'data-rev-mark': JSON.stringify(a.revMark) } : {}),
        },
      },
    }, {
      types: ['paragraph', 'heading'],
      attributes: {
        // Both halves of a split block were the block that changed.
        revFormat: {
          default: null,
          parseHTML: (el: HTMLElement) => {
            try { return JSON.parse(el.getAttribute('data-rev-format') ?? 'null'); } catch { return null; }
          },
          renderHTML: (a: Record<string, unknown>) => (a.revFormat ? { 'data-rev-format': JSON.stringify(a.revFormat) } : {}),
        },
      },
    }];
  },

  addCommands() {
    return {
      acceptRevisions: (all = false) => ({ state, tr, dispatch }) => {
        const list = targets(state, all);
        if (!list.length) return false;
        if (dispatch) apply(state, tr, list, true);
        return true;
      },
      rejectRevisions: (all = false) => ({ state, tr, dispatch }) => {
        const list = targets(state, all);
        if (!list.length) return false;
        if (dispatch) apply(state, tr, list, false);
        return true;
      },
      acceptRevision: (id) => ({ state, tr, dispatch }) => byId(state, tr, dispatch, id, true),
      rejectRevision: (id) => ({ state, tr, dispatch }) => byId(state, tr, dispatch, id, false),
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    // The mark cannot know the document's other authors, so the colour is a decoration
    // (`authorColors`). Cached on the doc — the walk is the whole document, and this runs
    // on every view update.
    let cache: { doc: PMNode; plain: boolean; set: DecorationSet } | null = null;
    // An IME composes over a selection in place: that composition's steps (ProseMirror's
    // `composition` meta) pass unrecorded, and once it ends what it took out of the selection
    // (`kept` is the rest) goes back struck through, in the same history event.
    let composed: { pos: number; slice: Slice; kept: [number, number]; id: unknown; changed: boolean } | null = null;
    const settle = (view: EditorView) => {
      if (!composed || view.composing) return;
      const { pos, slice, kept: [from, to], id, changed } = composed;
      composed = null;
      if (!changed || to - from === slice.size) return;
      const tr = view.state.tr;
      if (to > from) tr.delete(from, to);
      const at = tr.mapping.map(pos, -1);
      tr.insert(at, slice.content);
      markDeleted(tr, at, at + slice.size, revisionAttrs(options.author()));
      view.dispatch(tr.setMeta(RECORDING, true).setMeta('composition', id));
    };
    return [
      new Plugin({
        props: {
          decorations(state) {
            // `plain` is in the key: a display mode changes what this draws without
            // touching the document, and the cached set would otherwise stand.
            const plain = options.plain();
            if (cache?.doc === state.doc && cache.plain === plain) return cache.set;
            const list = plain ? [] : revisions(state.doc);
            const colors = authorColors(state.doc);
            const gone = goneBlocks(state.doc).map(({ pos, size, kind }) => Decoration.node(pos, pos + size, { class: `pm-gone-${kind}` }));
            const set = DecorationSet.create(state.doc, gone.concat(list.flatMap((r) => {
              const cls = `pm-rev-${r.kind === 'insertion' ? 'ins' : 'del'}`, color = authorColor(colors, r.author);
              if (r.kind === 'formatChange') return [
                ...r.spans.map(([from, to]) => Decoration.inline(from, to, { class: 'pm-rev-format', style: `--rev-color: ${color}` })),
                ...r.marks.map((pos) => Decoration.node(pos, pos + state.doc.nodeAt(pos)!.nodeSize, { class: 'pm-block-format', style: `--rev-color: ${color}` })),
              ];
              return [
                ...r.spans.map(([from, to]) => Decoration.inline(from, to, { class: cls, style: `color: ${color}` })),
                // A widget factory: a split view draws the decoration twice.
                ...r.marks.map((pos) => (tableLine(state.doc.nodeAt(pos)!) ? Decoration.node(pos, pos + state.doc.nodeAt(pos)!.nodeSize, { class: `pm-line-${r.kind}`, style: `--rev-color: ${color}` }) : Decoration.widget(pos + state.doc.nodeAt(pos)!.nodeSize - 1, () => {
                  const el = document.createElement('span');
                  el.className = `pm-para-mark ${cls}`;
                  el.style.color = color;
                  return el;
                }, { side: -1, ignoreSelection: true, key: `${r.kind}${pos}${color}` }))),
              ];
            })));
            cache = { doc: state.doc, plain, set };
            return set;
          },
        },
      }),
      new Plugin({
        key: RECORDING,
        props: {
          handleDOMEvents: {
            compositionstart: (view) => {
              settle(view);
              const sel = view.state.selection;
              if (!options.recording() || sel.empty || !inlineOnly(view.state.doc, sel.from, sel.to)) return false;
              composed = { pos: sel.from, slice: view.state.doc.slice(sel.from, sel.to), kept: [sel.from, sel.to], id: null, changed: false };
              return false;
            },
            // After ProseMirror has read the composition's last change (a microtask).
            compositionend: (view) => { setTimeout(() => settle(view)); return false; },
          },
        },
        // Typing is intercepted here rather than by a keymap: every path that inserts
        // text — a paste, an input rule, a drop — goes through appendTransaction, and
        // each would otherwise need its own hook.
        appendTransaction: (transactions, _oldState, newState) => {
          if (composed) for (const t of transactions) {
            composed.pos = t.mapping.map(composed.pos, -1);
            for (const map of t.mapping.maps) composed.kept = keptThrough(map, composed.kept);
          }
          if (!options.recording()) return null;
          if (!transactions.some((t) => t.docChanged)) return null;
          // Our own accept/reject and the mark pass below must not recurse, and undo/redo
          // restore a recorded state: the history carries the marks along.
          if (transactions.some((t) => t.getMeta(RECORDING) || fromHistory(t))) return null;
          const ranges = insertedRanges(transactions);
          const tr = newState.tr;
          const author = options.author(), fresh = revisionAttrs(author);
          const { insertion, deletion, formatChange } = newState.schema.marks;
          for (const [from, to] of ranges) {
            // Anything freshly in the document is this author's insertion — never struck
            // through or another's, which typing inside such a run would inherit. Typing
            // joins the run it continues, so a sentence is one change.
            const attrs = adjacentInsertion(tr.doc, from, author) ?? fresh;
            tr.removeMark(from, to, deletion).removeMark(from, to, insertion).removeMark(from, to, formatChange);
            markRange(tr, from, to, insertion.create(attrs));
            markInsertedParagraphs(tr, from, to, attrs);
          }
          markInsertedLines(tr, ranges, fresh);
          recordFormats(tr, transactions, fresh);
          // In the history with the edit it marks, so undo and redo take both together.
          return tr.steps.length ? tr.setMeta(RECORDING, true) : null;
        },

        // A deletion must not reach the document: mark the range instead. Text already
        // marked as the author's own insertion is simply removed, which is what both
        // word processors do.
        filterTransaction: (tr, state) => {
          if (!options.recording() || tr.getMeta(RECORDING) || !tr.docChanged || fromHistory(tr)) return true;
          // A plugin's repair after an edit (the notes' own section, say) is no edit of
          // the user's; replayed, the repair would run again on the replay, without end.
          // It is filtered against the state the edit made, not the view's.
          if (state !== this.editor.view.state) return true;
          const composition = tr.getMeta('composition');
          if (composed && composition != null && (composed.id ?? composition) === composition) {
            composed.id = composition;
            composed.changed = true;
            return true;
          }
          const author = options.author();
          // Taking back one's own pending text goes as it is (appendTransaction marks what
          // replaces it): a replay a microtask later would break an IME's running composition.
          if (ownOnly(tr, author)) return true;
          const marked = pasteCells(tr, state, author) ?? replayTracked(tr, state, author) ?? clearCells(tr, state, author)
            ?? replaceSelection(tr, state, author) ?? markPureDelete(tr, state, author);
          // What passes and removes content only moves or rebuilds it (a sort, merged
          // cells): its output is no insertion either.
          if (!marked) { if (removes(tr)) tr.setMeta(MOVED, true); return true; }
          queueMicrotask(() => this.editor.view.dispatch(marked.setMeta(RECORDING, true)));
          return false;
        },
      }),
    ];
  },
});

// What a mark step reaches: text and inline atoms.
const isMarkable = (node: PMNode) => node.isInline && node.isAtom;

// Every run a formatting step touched keeps the format it had before the edit: the first
// record stands, text the author just inserted is new anyway, and text back at its old
// format has no change left.
function recordFormats(tr: Transaction, transactions: readonly Transaction[], attrs: RevisionAttrs): void {
  const { formatChange } = tr.doc.type.schema.marks;
  const changeOf = (node: PMNode) => node.marks.find((m) => m.type === formatChange);
  const touched: [number, number][] = [];
  transactions.forEach((t, ti) => {
    if (t.getMeta('appendedTransaction')) return;
    t.steps.forEach((step, i) => {
      const onward = [t.mapping.slice(i), ...transactions.slice(ti + 1).map((u) => u.mapping), tr.mapping];
      const final = (pos: number, assoc: number) => onward.reduce((at, m) => m.map(at, assoc), pos);
      const doc = t.docs[i];
      const block = formattedBlock(step, doc);
      if (block != null) { recordBlockFormat(tr, final(block, 1), doc, block, attrs); return; }
      // What moves in or out of a list, or under another list type.
      if (step instanceof ReplaceAroundStep) {
        doc.nodesBetween(step.from, step.to, (node, pos) => {
          if (hasParagraphMark(node)) recordBlockFormat(tr, final(pos, 1), doc, pos, attrs);
          return !node.isTextblock;
        });
        return;
      }
      if (!(step instanceof AddMarkStep || step instanceof RemoveMarkStep) || UNFORMATTED_MARKS.has(step.mark.type.name)) return;
      t.docs[i].nodesBetween(step.from, step.to, (node, pos) => {
        if (!isMarkable(node)) return true;
        const from = final(Math.max(pos, step.from), 1), to = final(Math.min(pos + node.nodeSize, step.to), -1);
        if (to <= from) return false;
        const mark = formatChange.create({ ...attrs, old: formatOf(node.marks).map((m) => m.toJSON()) });
        tr.doc.nodesBetween(from, to, (now, at) => {
          if (!isMarkable(now)) return true;
          const own = now.marks.some((m) => m.type.name === 'insertion' && m.attrs.author === attrs.author);
          if (!own && !changeOf(now)) tr.addMark(Math.max(at, from), Math.min(at + now.nodeSize, to), mark);
          return false;
        });
        touched.push([from, to]);
        return false;
      });
    });
  });
  for (const [from, to] of touched) tr.doc.nodesBetween(from, to, (node, at) => {
    if (!isMarkable(node)) return true;
    const old = changeOf(node)?.attrs.old as Record<string, unknown>[] | null | undefined;
    const schema = tr.doc.type.schema;
    if (old && PMMark.sameSet(formatOf(node.marks), PMMark.setFrom(old.map((m) => schema.markFromJSON(m))))) {
      tr.removeMark(Math.max(at, from), Math.min(at + node.nodeSize, to), formatChange);
    }
    return false;
  });
}

// The position of the paragraph or heading a step changes the format of, if any.
function formattedBlock(step: Step, doc: PMNode): number | null {
  const pos = step instanceof AttrStep ? (UNFORMATTED_ATTRS.has(step.attr) ? null : step.pos)
    : retagged(step) || swap(step, doc) ? (step as ReplaceStep).from : null;
  return pos != null && hasParagraphMark(doc.nodeAt(pos)!) ? pos : null;
}

// The first record stands, and a block back at it has no change left.
function recordBlockFormat(tr: Transaction, at: number, doc: PMNode, pos: number, attrs: RevisionAttrs): void {
  const now = tr.doc.nodeAt(at), before = doc.nodeAt(pos)!;
  if (!now || !hasParagraphMark(now)) return;
  const rec = now.attrs.revFormat as RevFormat | null;
  const old = rec ? rec.old : { ...blockFormat(before.type.name, before.attrs), list: listChain(doc, pos) };
  const same = !!old && sameBlockFormat(blockFormat(now.type.name, now.attrs), old) && sameLists(old.list, listChain(tr.doc, at));
  if (rec && same) tr.setNodeAttribute(at, 'revFormat', null);
  else if (!rec && !same) tr.setNodeAttribute(at, 'revFormat', { ...attrs, old });
}

// Undo and redo, and what other plugins append to them.
function fromHistory(tr: Transaction): boolean {
  const root = tr.getMeta('appendedTransaction') as Transaction | undefined;
  return isHistoryTransaction(tr) || (!!root && isHistoryTransaction(root));
}

// What the edits inserted, in the last transaction's coordinates: each step's range mapped
// through the steps and transactions after it. A plugin's repair only moves what is there
// (the notes rebuild their section), so what it puts back is no insertion of the user's.
function insertedRanges(transactions: readonly Transaction[]): [number, number][] {
  const out: [number, number][] = [];
  transactions.forEach((t, ti) => {
    if (t.getMeta('appendedTransaction') || t.getMeta(MOVED)) return;
    const later = transactions.slice(ti + 1).map((u) => u.mapping);
    for (let [from, to] of newRanges(t)) {
      for (const m of later) { from = m.map(from, 1); to = m.map(to, -1); }
      if (to > from) out.push([from, to]);
    }
  });
  return out;
}

// What the steps of `tr` from `first` on inserted, in its final document.
function newRanges(tr: Transaction, first = 0): [number, number][] {
  const out: [number, number][] = [];
  for (let i = first; i < tr.steps.length; i++) {
    if (restyled(tr.steps[i], tr.docs[i]) || retagged(tr.steps[i])) continue;
    // A retagged node stays where it is, and its range with it.
    const rest = new Mapping(tr.steps.slice(i + 1).filter((s) => !retagged(s)).map((s) => s.getMap()));
    tr.steps[i].getMap().forEach((_os, _oe, ns, ne) => {
      const from = rest.map(ns, 1), to = rest.map(ne, -1);
      if (to > from) out.push([from, to]);
    });
  }
  return out;
}

// The node a step swaps whole for one of its type, and its replacement: a setNodeMarkup
// on a picture or a formula, or a command rebuilding a block (a sorted table).
function swap(step: Step, doc: PMNode): [PMNode, PMNode] | null {
  if (!(step instanceof ReplaceStep) || step.slice.openStart || step.slice.openEnd || step.slice.content.childCount !== 1) return null;
  const old = doc.nodeAt(step.from), next = step.slice.content.firstChild!;
  // Text is content itself: a run swapped for another is an edit, never a restyle.
  return old && !old.isText && step.from + old.nodeSize === step.to && old.type === next.type ? [old, next] : null;
}

// A node given other attributes around the same content (`setNodeMarkup`).
function retagged(step: Step): boolean {
  return step instanceof ReplaceAroundStep && step.gapFrom - step.from === 1 && step.to - step.gapTo === 1 && step.slice.size === 2;
}

// A container rebuilt whole (a sorted table, an updated index): its content only moves.
function rebuilt(step: Step, doc: PMNode): boolean {
  const pair = swap(step, doc);
  return !!pair && !pair[0].isTextblock && !pair[0].isLeaf;
}

// A swap with other attributes only: no content changes hands.
function restyled(step: Step, doc: PMNode): boolean {
  const pair = swap(step, doc);
  return !!pair && pair[0].content.eq(pair[1].content);
}

// Whether a transaction takes anything out of the document, restyled nodes aside.
function removes(tr: Transaction): boolean {
  let gone = false;
  tr.steps.forEach((s, i) => { if (!restyled(s, tr.docs[i]) && !retagged(s)) s.getMap().forEach((os, oe) => { if (oe > os) gone = true; }); });
  return gone;
}

// [from,to) is text of one textblock: what a replace command (find & replace, AutoText,
// a spelling suggestion) takes out, unlike a command moving blocks.
function inlineOnly(doc: PMNode, from: number, to: number): boolean {
  const $from = doc.resolve(from);
  return $from.parent.isTextblock && $from.sameParent(doc.resolve(to));
}

// What is left of [from,to) after a step: an end whose character the step replaced moves to
// that replacement's far side, so nothing the step put in counts as left.
function keptThrough(map: StepMap, [from, to]: [number, number]): [number, number] {
  let start = map.map(from, 1), end = map.map(to, -1);
  map.forEach((os, oe, ns, ne) => {
    if (from >= os && from < oe) start = ne;
    if (to > os && to <= oe) end = ns;
  });
  return [start, Math.max(start, end)];
}

// Every step removes only text of one textblock that `author` inserted and nobody struck.
function ownOnly(tr: Transaction, author: string): boolean {
  return tr.steps.length > 0 && tr.steps.every((step, i) => {
    if (!(step instanceof ReplaceStep)) return false;
    if (step.to === step.from) return true;
    if (!inlineOnly(tr.docs[i], step.from, step.to)) return false;
    let own = true;
    tr.docs[i].nodesBetween(step.from, step.to, (node) => {
      if (!node.isInline) return true;
      const ins = node.marks.find((m) => m.type.name === 'insertion');
      if (!ins || String(ins.attrs.author ?? '') !== author || node.marks.some((m) => m.type.name === 'deletion')) own = false;
      return false;
    });
    return own;
  }) && tr.steps.some((s) => (s as ReplaceStep).to > (s as ReplaceStep).from);
}

// A user edit that removes text — a delete, typing or pasting over a selection, Enter over
// one, a drop — replayed step by step: each removed range is struck through and stays, and
// what the step inserts lands after it as an insertion. Null for anything else.
function replayTracked(tr: Transaction, state: EditorState, author: string): Transaction | null {
  // Formatting steps ride along (find & replace with a format): applied, not recorded.
  const steps = tr.steps.filter((s): s is ReplaceStep => s instanceof ReplaceStep);
  if (tr.steps.some((s) => !(s instanceof ReplaceStep || s instanceof AddMarkStep || s instanceof RemoveMarkStep))) return null;
  const docs = tr.steps.flatMap((s, i) => (s instanceof ReplaceStep ? [tr.docs[i]] : []));
  const swapped = steps.map((s, i) => restyled(s, docs[i]));
  if (!steps.some((s, i) => !swapped[i] && s.to > s.from)) return null;
  const sel = state.selection, ui = tr.getMeta('uiEvent');
  // One step is the user's edit over the selection, unless it rebuilds a block whole.
  const user = (steps.length === 1 && !rebuilt(steps[0], docs[0])) || isPureDelete(tr, state) || ui === 'paste' || ui === 'drop' || ui === 'cut'
    || (!sel.empty && steps[0].from === sel.from && steps[0].to === sel.to)
    || steps.every((s, i) => swapped[i] || s.to === s.from || inlineOnly(docs[i], s.from, s.to));
  if (!user) return null;
  const marked = state.tr, line = revisionAttrs(author);
  // A position of the document before the current step, in the marked one as it stands.
  let at: (p: number, assoc: number) => number = (p, a) => marked.mapping.map(p, a);
  let back: { pos: number; steps: number } | null = null;
  let i = -1;
  for (const step of tr.steps) {
    const prev = at;
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      const from = prev(step.from, 1), to = prev(step.to, -1);
      if (to > from) step instanceof AddMarkStep ? marked.addMark(from, to, step.mark) : marked.removeMark(from, to, step.mark);
      continue;
    }
    if (!(step instanceof ReplaceStep)) continue;
    if (swapped[++i]) {
      const before = marked.steps.length;
      marked.replace(prev(step.from, 1), prev(step.to, -1), step.slice);
      at = (p, a) => marked.mapping.slice(before).map(prev(p, a), a);
      continue;
    }
    let end = prev(step.to, -1);
    if (step.to > step.from) {
      const from = prev(step.from, 1), before = marked.steps.length;
      const node = marked.doc.nodeAt(from);
      if (end > from) markDeleted(marked, from, end, adjacentDeletion(marked.doc, from, end, author) ?? (node && tableLine(node) ? line : revisionAttrs(author)));
      end = marked.mapping.slice(before).map(end, -1);
      back = { pos: marked.mapping.slice(before).map(from, 1), steps: marked.steps.length };
    }
    const start = end;
    if (step.slice.size && !reopensOnly(step.slice)) end = insertTracked(marked, start, step.slice, revisionAttrs(author));
    const steady = marked.steps.length, { from, to } = step, size = step.slice.size;
    at = (p, a) => {
      if (p < from) return prev(p, a);
      if (p > from + size) return prev(p - size + (to - from), a);
      // The fitted replace may close and reopen blocks before the slice.
      const fit = p > from ? Math.max(0, end - start - size) : 0;
      return marked.mapping.slice(steady).map(size ? Math.min(start + fit + (p - from), end) : end, a);
    };
  }
  // Backspace leaves the caret before the text it struck, so the next one strikes on;
  // everything else leaves it after, where the edit continues.
  const backspace = steps.length === 1 && !steps[0].slice.size && sel.empty && sel.head === steps[0].to;
  const caret = backspace && back ? marked.mapping.slice(back.steps).map(back.pos, -1) : at(tr.selection.head, 1);
  marked.setSelection(TextSelection.near(marked.doc.resolve(caret)));
  if (tr.scrolledIntoView) marked.scrollIntoView();
  return marked;
}

// Deleting up to a list's second item replaces the first with an open list: what remains of
// the list, not new content. A split's slice holds two blocks.
function reopensOnly(slice: Slice): boolean {
  let inline = false;
  slice.content.descendants((n) => { inline ||= n.isInline; return !inline; });
  return !inline && slice.content.childCount === 1 && !slice.openStart;
}

// A paste over cells replaces each row's run of them whole (prosemirror-tables'
// insertCells): each new cell takes, struck through before the pasted content, what the old
// cell at its column held. The table growing or merged cells splitting to fit is structure.
function pasteCells(tr: Transaction, state: EditorState, author: string): Transaction | null {
  const isCell = (n: PMNode) => n.type.spec.tableRole === 'cell' || n.type.spec.tableRole === 'header_cell';
  const cellsOnly = (f: Fragment) => {
    let all = f.childCount > 0;
    f.forEach((n) => { all &&= isCell(n); });
    return all;
  };
  const isRow = (step: Step, doc: PMNode): step is ReplaceStep => {
    if (!(step instanceof ReplaceStep) || step.slice.openStart || step.slice.openEnd || step.to <= step.from) return false;
    const $from = doc.resolve(step.from);
    return $from.parent.type.spec.tableRole === 'row' && $from.sameParent(doc.resolve(step.to))
      && cellsOnly(step.slice.content) && cellsOnly(doc.slice(step.from, step.to).content);
  };
  if (!tr.steps.some((s, i) => isRow(s, tr.docs[i]))) return null;
  const marked = state.tr, attrs = revisionAttrs(author), { insertion, deletion } = state.schema.marks;
  const span = (n: PMNode) => Number(n.attrs.colspan ?? 1) || 1;
  // From the document before tr's next step to the marked one as it stands.
  let toMarked = new Mapping();
  for (const [i, step] of tr.steps.entries()) {
    const before = marked.steps.length, mapped = step.map(toMarked);
    if (!mapped || marked.maybeStep(mapped).failed) return null;
    if (isRow(step, tr.docs[i])) {
      const old = new Map<number, PMNode>();
      let col = 0;
      tr.docs[i].slice(step.from, step.to).content.forEach((n) => { old.set(col, n); col += span(n); });
      const cells: [number, PMNode | undefined][] = [];
      let pos = (mapped as ReplaceStep).from;
      col = 0;
      step.slice.content.forEach((n) => { cells.push([pos, old.get(col)]); pos += n.nodeSize; col += span(n); });
      // Back to front, so each cell's position holds while the ones after it change.
      for (const [at, gone] of cells.reverse()) {
        const end = at + marked.doc.nodeAt(at)!.nodeSize - 1;
        marked.removeMark(at + 1, end, deletion).removeMark(at + 1, end, insertion).addMark(at + 1, end, insertion.create(attrs));
        let inline = false;
        gone?.descendants((n) => { inline ||= n.isInline; return !inline; });
        if (!gone || !inline) continue;
        // The struck text runs on into the pasted paragraph, as typing over it would.
        const open = gone.lastChild?.isTextblock && marked.doc.nodeAt(at)!.firstChild?.isTextblock ? 1 : 0;
        const from = marked.steps.length;
        marked.replace(at + 1, at + 1 + open, new Slice(gone.content, 0, open));
        markDeleted(marked, at + 1, marked.mapping.slice(from).map(at + 1 + open, 1), attrs);
      }
    }
    // A position in what the step put in maps to its copy in the marked document (mirror).
    const next = new Mapping();
    next.appendMap(step.getMap().invert());
    next.appendMapping(toMarked);
    marked.mapping.maps.slice(before).forEach((m, k) => next.appendMap(m, k ? undefined : 0));
    toMarked = next;
  }
  marked.setSelection(TextSelection.near(marked.doc.resolve(toMarked.map(tr.selection.to, -1)), -1));
  return marked;
}

// Delete over a cell selection empties each cell: its text is struck through instead.
function clearCells(tr: Transaction, state: EditorState, author: string): Transaction | null {
  const sel = state.selection;
  if (!(sel instanceof CellSelection) || tr.doc.textContent.length >= state.doc.textContent.length) return null;
  // Deleting rows or columns over the selection takes the cells away: another change.
  const takesLines = tr.steps.some((s, i) => {
    const step = s as ReplaceStep, node = tr.docs[i].nodeAt(step.from);
    return !!node && !!tableLine(node) && step.from + node.nodeSize <= step.to;
  });
  if (takesLines) return null;
  if (!tr.steps.every((s) => s instanceof ReplaceStep && !s.slice.content.textBetween(0, s.slice.content.size))) return null;
  const marked = state.tr, attrs = revisionAttrs(author);
  sel.forEachCell((cell, pos) => {
    const from = marked.mapping.map(pos + 1), to = marked.mapping.map(pos + cell.nodeSize - 1);
    if (to > from) markDeleted(marked, from, to, attrs);
  });
  return marked;
}

// Typing, Enter or a paste over a selection reaching across list items or cells: one
// step that merges the blocks around the new content. The selection is struck through and
// what the edit left in its place lands after it, the merge left out.
function replaceSelection(tr: Transaction, state: EditorState, author: string): Transaction | null {
  const sel = state.selection;
  const first = tr.steps[0] as Step & { from?: number };
  // Only an edit that removes the selected content: a mark or a block attribute set over
  // the selection starts there too.
  if (sel.empty || first.from !== sel.from || isPureDelete(tr, state) || !tr.mapping.mapResult(sel.from, 1).deletedAfter) return null;
  const slice = editedContent(tr.doc, tr.mapping.map(sel.from, -1), tr.mapping.map(sel.to, 1));
  const marked = state.tr;
  trackedReplace(marked, sel.from, sel.to, slice, author);
  const end = marked.mapping.map(sel.to, 1);
  marked.setSelection(TextSelection.near(marked.doc.resolve(end), -1));
  if (tr.scrolledIntoView) marked.scrollIntoView();
  return marked;
}

// What an edit left in [from,to): the inline content alone where it sits in one block —
// the blocks it merged are no part of it — else the whole range, splits included.
function editedContent(doc: PMNode, from: number, to: number): Slice | null {
  if (to <= from) return null;
  let first = -1, last = -1;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return true;
    if (first < 0) first = Math.max(pos, from);
    last = Math.min(pos + node.nodeSize, to);
    return false;
  });
  return first >= 0 && doc.resolve(first).sameParent(doc.resolve(last)) ? doc.slice(first, last) : doc.slice(from, to);
}

// A delete made of other steps (a join): its ranges struck through, in the document it
// started from. Null when the transaction inserts as well, or takes out no inline content
// (a lift only unwraps blocks: structure, which passes unrecorded).
function markPureDelete(tr: Transaction, state: EditorState, author: string): Transaction | null {
  if (!isPureDelete(tr, state)) return null;
  const marked = state.tr;
  const attrs = revisionAttrs(author);
  let content = false;
  tr.steps.forEach((step, i) => {
    if (retagged(step)) return;
    // Mapping.invert ignores a slice's bounds: the maps before this step, copied.
    const back = new Mapping(tr.mapping.maps.slice(0, i)).invert();
    step.getMap().forEach((oldStart, oldEnd) => {
      const from = marked.mapping.map(back.map(oldStart, 1), 1), to = marked.mapping.map(back.map(oldEnd, -1), -1);
      let inline = false;
      if (to > from) marked.doc.nodesBetween(from, to, (n) => { inline ||= n.isInline; return !inline; });
      // A join takes a paragraph mark out; a lift's ReplaceAroundStep only unwraps.
      if (!inline && !(step instanceof ReplaceStep && deleteRanges(marked.doc, from, to, author).blocks.length)) return;
      content = true;
      markDeleted(marked, from, to, attrs);
    });
  });
  return content ? marked : null;
}

// The block before the one `$pos` opens, where `$pos` is the start of a textblock.
function blockBefore($pos: ReturnType<PMNode['resolve']>): PMNode | null {
  if ($pos.depth === 0 || !$pos.parent.isTextblock || $pos.parentOffset) return null;
  const sel = TextSelection.findFrom($pos.doc.resolve($pos.before()), -1, true);
  return sel?.$from.parent ?? null;
}

// The attrs of the insertion the text just before `pos` belongs to, when the same author
// made it — what makes consecutive typing one change rather than one per keystroke, over
// a paragraph just started too.
function adjacentInsertion(doc: PMNode, pos: number, author: string): RevisionAttrs | null {
  const $pos = doc.resolve(pos), before = pos > 0 ? $pos.nodeBefore : null;
  const mark = before?.marks.find((m) => m.type.name === 'insertion');
  const attrs = mark?.attrs ?? (blockBefore($pos)?.attrs.revMark as RevMark | null | undefined)?.insertion;
  if (!attrs || String(attrs.author ?? '') !== author) return null;
  return { id: String(attrs.id), author, date: String(attrs.date) };
}

// The attrs of the deletion right beside [from,to), when the same author made it — what
// makes a run of Backspace or Delete one change rather than one per key, across a
// paragraph mark too.
function adjacentDeletion(doc: PMNode, from: number, to: number, author: string): RevisionAttrs | null {
  const $from = doc.resolve(from), $to = doc.resolve(to);
  const atEnd = $to.parent.isTextblock && $to.parentOffset === $to.parent.content.size;
  const beside = [
    $from.nodeBefore?.marks.find((m) => m.type.name === 'deletion')?.attrs,
    $to.nodeAfter?.marks.find((m) => m.type.name === 'deletion')?.attrs,
    (blockBefore($from)?.attrs.revMark as RevMark | null | undefined)?.deletion,
    atEnd ? ($to.parent.attrs.revMark as RevMark | null | undefined)?.deletion : undefined,
  ];
  for (const attrs of beside) {
    if (attrs && String(attrs.author ?? '') === author) return { id: String(attrs.id), author, date: String(attrs.date) };
  }
  return null;
}

// A transaction that only removes content (backspace, delete, cut) — a replacement
// inserts as well, and its insertion half must still run.
function isPureDelete(tr: Transaction, state: EditorState): boolean {
  if (!tr.steps.length) return false;
  return tr.doc.content.size < state.doc.content.size
    && tr.steps.every((step) => {
      // A merged cell a deleted column runs through only gets narrower.
      if (retagged(step)) return true;
      let inserted = 0;
      step.getMap().forEach((_os, _oe, ns, ne) => { inserted += ne - ns; });
      return inserted === 0;
    });
}

function revisionAttrs(author: string): RevisionAttrs {
  return { id: newRevisionId(), author, date: new Date().toISOString() };
}

// A change's mark over a range. A mark step only reaches text and atoms, so a text box in
// the range takes it as well as the text in it.
function markRange(tr: Transaction, from: number, to: number, mark: PMMark): void {
  tr.addMark(from, to, mark);
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isInline && !node.isLeaf && pos >= from && pos + node.nodeSize <= to) tr.setNodeMarkup(pos, null, node.attrs, mark.addToSet(node.marks));
    return !node.isInline;
  });
}

// Strike [from,to) through as one change, the paragraph marks in it too; the author's own
// pending insertion inside goes for real, and what is already struck through stays as it is.
function markDeleted(tr: Transaction, from: number, to: number, attrs: RevisionAttrs): void {
  const { kept, own, blocks } = deleteRanges(tr.doc, from, to, attrs.author);
  for (const keep of kept) markRange(tr, keep[0], keep[1], tr.doc.type.schema.marks.deletion.create(attrs));
  const start = tr.steps.length;
  for (const range of [...own].reverse()) tr.delete(range[0], range[1]);
  for (const block of [...blocks].reverse()) {
    const at = tr.mapping.slice(start).map(block, 1);
    const rev = (tr.doc.nodeAt(at)?.attrs.revMark ?? null) as RevMark | null;
    if (rev?.deletion) continue;
    if (rev?.insertion?.author === attrs.author) removeParagraphMark(tr, at);
    else tr.setNodeAttribute(at, 'revMark', { ...rev, deletion: attrs });
  }
}

// Each paragraph mark that came in with [from,to) is an insertion. A block split in two
// hands the mark it had to its second half, the one that now ends with it.
function markInsertedParagraphs(tr: Transaction, from: number, to: number, attrs: RevisionAttrs): void {
  const blocks: { pos: number; end: number; rev: unknown }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock || !hasParagraphMark(node)) return true;
    const end = pos + node.nodeSize - 1;
    // Before a table only what came in with the range can go again: it, or what split from it.
    const fresh = pos >= from || end + 1 < to;
    if (end >= from && end < to && (fresh || nextParagraph(tr.doc, end) !== null)) blocks.push({ pos, end, rev: node.attrs.revMark });
    return false;
  });
  if (!blocks.length) return;
  for (const { pos } of blocks) tr.setNodeAttribute(pos, 'revMark', { insertion: attrs });
  // A block that came in whole is new, whatever it was before.
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.attrs.revFormat && pos >= from && pos + node.nodeSize <= to) tr.setNodeAttribute(pos, 'revFormat', null);
    return !node.isTextblock;
  });
  const first = blocks[0].rev, after = nextParagraph(tr.doc, blocks[blocks.length - 1].end);
  if (first && after !== null) tr.setNodeAttribute(tr.doc.resolve(after).before(), 'revMark', first);
}

// The rows and the columns that came in whole: a column only as a new cell in every row,
// which tells it from a split cell. One transaction's lines are one change.
function markInsertedLines(tr: Transaction, ranges: [number, number][], attrs: RevisionAttrs): void {
  const cells = new Map<number, { rows: Set<number>; cells: number[]; height: number }>();
  for (const [from, to] of ranges) {
    tr.doc.nodesBetween(from, to, (node, pos) => {
      const line = tableLine(node), whole = pos >= from && pos + node.nodeSize <= to;
      if (!line || !whole) return true;
      if (line === 'row') tr.setNodeAttribute(pos, 'revMark', { insertion: attrs });
      else {
        const $pos = tr.doc.resolve(pos), table = $pos.before($pos.depth - 1);
        const entry = cells.get(table) ?? { rows: new Set(), cells: [], height: $pos.node($pos.depth - 1).childCount };
        entry.rows.add($pos.before());
        entry.cells.push(pos);
        cells.set(table, entry);
      }
      return false;
    });
  }
  for (const entry of cells.values()) {
    if (entry.rows.size === entry.height) for (const pos of entry.cells) tr.setNodeAttribute(pos, 'revMark', { insertion: attrs });
  }
}

// The new content lands at `at` (after any text it replaces, which stays struck out),
// marked as an insertion. Returns where it ends.
function insertTracked(tr: Transaction, at: number, slice: Slice, attrs: RevisionAttrs): number {
  const before = tr.steps.length;
  tr.replace(at, at, slice);
  // The ranges the fitted replace actually inserted: it may close and reopen blocks
  // around the slice, so its size says nothing about where the new content lies.
  const { insertion, deletion, formatChange } = tr.doc.type.schema.marks;
  const ranges = newRanges(tr, before);
  for (const [from, to] of ranges) {
    tr.removeMark(from, to, deletion).removeMark(from, to, insertion).removeMark(from, to, formatChange);
    markRange(tr, from, to, insertion.create(attrs));
    markInsertedParagraphs(tr, from, to, attrs);
  }
  markInsertedLines(tr, ranges, attrs);
  return tr.mapping.slice(before).map(at, 1);
}

/**
 * A replacement recorded by `author` whether or not recording is on: [from,to) struck
 * through, `slice` inserted after it. Either half may be empty.
 */
export function trackedReplace(tr: Transaction, from: number, to: number, slice: Slice | null, author: string): Transaction {
  const start = tr.steps.length;
  if (to > from) markDeleted(tr, from, to, revisionAttrs(author));
  if (slice?.size) insertTracked(tr, tr.mapping.slice(start).map(to), slice, revisionAttrs(author));
  return tr.setMeta(RECORDING, true);
}

/** Records the formatting steps `tr` holds as `author`'s, whether or not recording is on. */
export function trackedFormat(tr: Transaction, author: string): Transaction {
  recordFormats(tr, [tr], revisionAttrs(author));
  return tr.setMeta(RECORDING, true);
}

// The parts of [from,to) a delete strikes through, the author's own pending insertions it
// removes outright (text already struck through is in neither), and the blocks whose
// paragraph mark lies inside, with the rows and cells it covers whole.
function deleteRanges(doc: PMNode, from: number, to: number, author: string): { kept: [number, number][]; own: [number, number][]; blocks: number[] } {
  const kept: [number, number][] = [], own: [number, number][] = [], blocks: number[] = [];
  let cursor = from, rowEnd = 0;
  doc.nodesBetween(from, to, (node, pos) => {
    const line = tableLine(node);
    if (line && pos >= from && pos + node.nodeSize <= to && pos >= rowEnd) {
      blocks.push(pos);
      if (line === 'row') rowEnd = pos + node.nodeSize;
    }
    if (hasParagraphMark(node)) {
      const end = pos + node.nodeSize - 1;
      if (end >= from && end < to && nextParagraph(doc, end) !== null) blocks.push(pos);
    }
    // A picture or field is inline as text is: one still pending goes as its text would.
    if (!node.isInline) return true;
    const s = Math.max(from, pos), e = Math.min(to, pos + node.nodeSize);
    const ins = node.marks.find((m) => m.type.name === 'insertion');
    const skip = ins && String(ins.attrs.author ?? '') === author ? own
      : node.marks.some((m) => m.type.name === 'deletion') ? [] : null;
    if (skip) {
      if (s > cursor) kept.push([cursor, s]);
      skip.push([s, e]);
      cursor = e;
    }
    return false;
  });
  if (cursor < to) kept.push([cursor, to]);
  return { kept, own, blocks };
}
