import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Slice, type Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { isHistoryTransaction } from '@tiptap/pm/history';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { AddMarkStep, Mapping, RemoveMarkStep, ReplaceStep, type Step, type StepMap } from '@tiptap/pm/transform';
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
// probed — see src/lib/export/CLAUDE.md.

export type RevisionKind = 'insertion' | 'deletion';

export type Revision = {
  kind: RevisionKind;
  id: string;
  author: string;
  date: string;
  from: number;
  to: number;
  /** The text the change covers — a deletion's is what would come back on reject. */
  text: string;
};

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

// Every recorded change in document order, adjacent runs of one id merged. Text one author
// inserted and another struck through is in both: the insertion and its deletion.
export function revisions(doc: PMNode): Revision[] {
  const out: Revision[] = [];
  const last: Record<RevisionKind, Revision | null> = { insertion: null, deletion: null };
  doc.descendants((node, pos) => {
    // A line break or field is inline as text is, and a recorded one goes with its change.
    const inline = node.isInline && node.isLeaf;
    for (const kind of ['insertion', 'deletion'] as const) {
      const mark = inline ? node.marks.find((m) => m.type.name === kind) : undefined;
      if (!mark) { last[kind] = null; continue; }
      const id = String(mark.attrs.id ?? ''), prev = last[kind];
      if (prev && prev.id === id && prev.to === pos) {
        prev.to = pos + node.nodeSize;
        prev.text += node.text ?? '';
        continue;
      }
      out.push(last[kind] = {
        kind, id,
        author: String(mark.attrs.author ?? ''),
        date: String(mark.attrs.date ?? ''),
        from: pos, to: pos + node.nodeSize, text: node.text ?? '',
      });
    }
    return !inline;
  });
  return out;
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
function apply(state: EditorState, tr: Transaction, list: Revision[], accept: boolean): void {
  const drop = accept ? 'deletion' : 'insertion';
  for (const r of [...list].sort((a, b) => b.from - a.from)) {
    const from = tr.mapping.map(r.from, 1), to = tr.mapping.map(r.to, -1);
    if (to <= from) continue;
    if (r.kind === drop) tr.delete(from, to);
    else tr.removeMark(from, to, state.schema.marks[r.kind]);
  }
  tr.setMeta(RECORDING, true);
}

export const TrackChanges = Extension.create<{ recording: () => boolean; author: () => string; plain: () => boolean }>({
  name: 'trackChanges',

  addOptions() {
    return { recording: () => false, author: () => '', plain: () => false };
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
            const set = DecorationSet.create(state.doc, list.map((r) =>
              Decoration.inline(r.from, r.to, {
                class: `pm-rev-${r.kind === 'insertion' ? 'ins' : 'del'}`,
                style: `color: ${authorColor(colors, r.author)}`,
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
          if (!ranges.length) return null;
          const tr = newState.tr;
          const author = options.author();
          const { insertion, deletion } = newState.schema.marks;
          for (const [from, to] of ranges) {
            // Anything freshly in the document is this author's insertion — never struck
            // through or another's, which typing inside such a run would inherit. Typing
            // joins the run it continues, so a sentence is one change.
            tr.removeMark(from, to, deletion).removeMark(from, to, insertion);
            tr.addMark(from, to, insertion.create(adjacentInsertion(tr.doc, from, author) ?? revisionAttrs(author)));
          }
          // In the history with the edit it marks, so undo and redo take both together.
          return tr.setMeta(RECORDING, true);
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
    if (restyled(tr.steps[i], tr.docs[i])) continue;
    const rest = tr.mapping.slice(i + 1);
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
  tr.steps.forEach((s, i) => { if (!restyled(s, tr.docs[i])) s.getMap().forEach((os, oe) => { if (oe > os) gone = true; }); });
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
  const marked = state.tr;
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
      if (end > from) markDeleted(marked, from, end, adjacentDeletion(marked.doc, from, end, author) ?? revisionAttrs(author));
      end = marked.mapping.slice(before).map(end, -1);
      back = { pos: marked.mapping.slice(before).map(from, 1), steps: marked.steps.length };
    }
    const start = end;
    if (step.slice.size) end = insertTracked(marked, start, step.slice, revisionAttrs(author));
    const steady = marked.steps.length, { from, to } = step, size = step.slice.size;
    at = (p, a) => {
      if (p < from) return prev(p, a);
      if (p > from + size) return prev(p - size + (to - from), a);
      return marked.mapping.slice(steady).map(size ? Math.min(start + (p - from), end) : end, a);
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
    // Mapping.invert ignores a slice's bounds: the maps before this step, copied.
    const back = new Mapping(tr.mapping.maps.slice(0, i)).invert();
    step.getMap().forEach((oldStart, oldEnd) => {
      const from = marked.mapping.map(back.map(oldStart, 1), 1), to = marked.mapping.map(back.map(oldEnd, -1), -1);
      let inline = false;
      if (to > from) marked.doc.nodesBetween(from, to, (n) => { inline ||= n.isInline; return !inline; });
      if (!inline) return;
      content = true;
      markDeleted(marked, from, to, attrs);
    });
  });
  return content ? marked : null;
}

// The attrs of the insertion the text just before `pos` belongs to, when the same author
// made it — what makes consecutive typing one change rather than one per keystroke.
function adjacentInsertion(doc: PMNode, pos: number, author: string): Record<string, string> | null {
  const before = pos > 0 ? doc.resolve(pos).nodeBefore : null;
  const mark = before?.marks.find((m) => m.type.name === 'insertion');
  if (!mark || String(mark.attrs.author ?? '') !== author) return null;
  return { id: String(mark.attrs.id), author, date: String(mark.attrs.date) };
}

// The attrs of the deletion right beside [from,to), when the same author made it — what
// makes a run of Backspace or Delete one change rather than one per key.
function adjacentDeletion(doc: PMNode, from: number, to: number, author: string): Record<string, string> | null {
  for (const node of [doc.resolve(from).nodeBefore, doc.resolve(to).nodeAfter]) {
    const mark = node?.marks.find((m) => m.type.name === 'deletion');
    if (mark && String(mark.attrs.author ?? '') === author) return { id: String(mark.attrs.id), author, date: String(mark.attrs.date) };
  }
  return null;
}

// A transaction that only removes content (backspace, delete, cut) — a replacement
// inserts as well, and its insertion half must still run.
function isPureDelete(tr: Transaction, state: EditorState): boolean {
  if (!tr.steps.length) return false;
  return tr.doc.content.size < state.doc.content.size
    && tr.steps.every((step) => {
      let inserted = 0;
      step.getMap().forEach((_os, _oe, ns, ne) => { inserted += ne - ns; });
      return inserted === 0;
    });
}

function revisionAttrs(author: string) {
  return { id: newRevisionId(), author, date: new Date().toISOString() };
}

// Strike [from,to) through as one change; the author's own pending insertion inside goes
// for real, and text already struck through stays as it is.
function markDeleted(tr: Transaction, from: number, to: number, attrs: Record<string, string>): void {
  const { kept, own } = deleteRanges(tr.doc, from, to, attrs.author);
  for (const keep of kept) tr.addMark(keep[0], keep[1], tr.doc.type.schema.marks.deletion.create(attrs));
  for (const range of [...own].reverse()) tr.delete(range[0], range[1]);
}

// The new content lands at `at` (after any text it replaces, which stays struck out),
// marked as an insertion. Returns where it ends.
function insertTracked(tr: Transaction, at: number, slice: Slice, attrs: Record<string, string>): number {
  const before = tr.steps.length;
  tr.replace(at, at, slice);
  // The ranges the fitted replace actually inserted: it may close and reopen blocks
  // around the slice, so its size says nothing about where the new content lies.
  const { insertion, deletion } = tr.doc.type.schema.marks;
  for (const [from, to] of newRanges(tr, before)) {
    tr.removeMark(from, to, deletion).removeMark(from, to, insertion).addMark(from, to, insertion.create(attrs));
  }
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

// The parts of [from,to) a delete strikes through, and the author's own pending insertions
// it removes outright; text already struck through is in neither.
function deleteRanges(doc: PMNode, from: number, to: number, author: string): { kept: [number, number][]; own: [number, number][] } {
  const kept: [number, number][] = [], own: [number, number][] = [];
  let cursor = from;
  doc.nodesBetween(from, to, (node, pos) => {
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
  return { kept, own };
}
