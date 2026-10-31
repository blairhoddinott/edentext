import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { claimRevisions, trackedReplace } from './extensions/trackChanges';

// Compare and merge: what separates this document from another, as recorded changes in this
// one. Blocks are aligned by their text, and those that differ word by word; hunks run from
// the end, so each still holds the positions of the document as it was.

type Hunk = { from: number; to: number; slice: Slice | null };
type Token = { key: string; from: number; to: number };

// Past this the table costs more than the answer is worth: the stretch is replaced whole.
const MAX_CELLS = 16_000_000;
const CONTAINERS = new Set(['bulletList', 'orderedList', 'listItem', 'tableRow', 'tableCell', 'tableHeader', 'taskList', 'taskItem']);
const WORD = /\s+|[\p{L}\p{N}_]+|./gu;

const struck = (node: PMNode) => node.marks.some((m) => m.type.name === 'deletion');

function shownText(node: PMNode): string {
  let text = '';
  node.descendants((child) => { if (child.isText && !struck(child)) text += child.text; return true; });
  return text;
}

// What makes two blocks the same one: their kind and text. Format is left out, so a block
// differing only in that stays as it is here; a block with no text of its own is its JSON.
function blockKey(node: PMNode): string {
  if (node.isTextblock) return `${node.type.name}:${String(node.attrs.level ?? '')}:${shownText(node)}:${tokens(node, 0).map((t) => (t.key.startsWith('\0') ? t.key : '')).join('')}`;
  return node.textContent ? `${node.type.name}:${shownText(node)}` : JSON.stringify(node.toJSON());
}

// A textblock's words, spaces and atoms; `start` is the position of its content.
function tokens(block: PMNode, start: number): Token[] {
  const out: Token[] = [];
  block.forEach((child, offset) => {
    const at = start + offset;
    if (struck(child)) return;
    if (!child.isText) { out.push({ key: `\0${child.type.name}:${JSON.stringify(child.attrs)}`, from: at, to: at + child.nodeSize }); return; }
    for (const m of child.text!.matchAll(WORD)) out.push({ key: m[0], from: at + m.index, to: at + m.index + m[0].length });
  });
  return out;
}

// The index pairs of a longest common subsequence, in order.
function align(a: string[], b: string[]): [number, number][] {
  let head = 0, tail = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const pairs: [number, number][] = Array.from({ length: head }, (_, i) => [i, i]);
  const n = a.length - head - tail, m = b.length - head - tail;
  if (n && m && n * m <= MAX_CELLS) {
    const lengths = new Uint32Array((n + 1) * (m + 1)), at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      lengths[at(i, j)] = a[head + i] === b[head + j] ? lengths[at(i + 1, j + 1)] + 1 : Math.max(lengths[at(i + 1, j)], lengths[at(i, j + 1)]);
    }
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[head + i] === b[head + j]) pairs.push([head + i++, head + j++]);
      else if (lengths[at(i + 1, j)] >= lengths[at(i, j + 1)]) i++;
      else j++;
    }
  }
  for (let i = tail; i > 0; i--) pairs.push([a.length - i, b.length - i]);
  return pairs;
}

function diffText(block: PMNode, start: number, other: PMNode, out: Hunk[]): void {
  const a = tokens(block, start), b = tokens(other, 0), pairs = align(a.map((t) => t.key), b.map((t) => t.key));
  let i = 0, j = 0;
  for (const [x, y] of [...pairs, [a.length, b.length] as [number, number]]) {
    if (x > i || y > j) {
      const from = i ? a[i - 1].to : start, to = x > i ? a[x - 1].to : from;
      const slice = y > j ? new Slice(other.slice(b[j].from, b[y - 1].to).content, 0, 0) : null;
      out.push({ from: x > i ? a[i].from : from, to, slice });
    }
    i = x + 1;
    j = y + 1;
  }
}

// Two blocks in the same place that can be told apart inside; a table only while its shape holds.
function comparable(a: PMNode, b: PMNode): boolean {
  if (a.type !== b.type) return false;
  if (a.isTextblock) return a.attrs.level === b.attrs.level;
  if (a.type.name === 'table') return a.childCount === b.childCount && a.firstChild?.childCount === b.firstChild?.childCount;
  return CONTAINERS.has(a.type.name) && (a.type.name !== 'tableRow' || a.childCount === b.childCount);
}

function diffChildren(parent: PMNode, start: number, other: PMNode, out: Hunk[]): void {
  const here: { node: PMNode; pos: number }[] = [], there: PMNode[] = [];
  parent.forEach((node, offset) => { here.push({ node, pos: start + offset }); });
  other.forEach((node) => { if (node.type.name !== 'noteSection') there.push(node); });
  const own = here.filter(({ node }) => node.type.name !== 'noteSection');
  const end = start + parent.content.size - (own.length < here.length ? here[here.length - 1].node.nodeSize : 0);
  const pairs = align(own.map(({ node }) => blockKey(node)), there.map(blockKey));
  let i = 0, j = 0;
  for (const [x, y] of [...pairs, [own.length, there.length] as [number, number]]) {
    while (i < x && j < y && comparable(own[i].node, there[j])) {
      const { node, pos } = own[i];
      if (node.isTextblock) diffText(node, pos + 1, there[j], out);
      else diffChildren(node, pos + 1, there[j], out);
      i++;
      j++;
    }
    if (i < x || j < y) {
      let from = i < own.length ? own[i].pos : end, to = i < x ? own[x - 1].pos + own[x - 1].node.nodeSize : from;
      if (j < y) out.push({ from: to, to, slice: new Slice(Fragment.fromArray(there.slice(j, y)), 0, 0) });
      // The last block has no mark of its own to strike: the one before it goes in its stead.
      else if (to === end && i > 0 && own[i - 1].node.isTextblock && to > from) { from--; to--; }
      if (to > from) out.push({ from, to, slice: null });
    }
    i = x + 1;
    j = y + 1;
  }
}

const WORKING = '\0compare';

/**
 * Records in `tr`, by `author`, what separates its document from `other`. `theirs` takes
 * this document as the older one: accepting gives `other`. Else this one is the newer:
 * accepting keeps it and rejecting gives `other`. Returns whether anything differs.
 */
export function recordDifferences(tr: Transaction, other: PMNode, author: string, theirs: boolean): boolean {
  const hunks: Hunk[] = [];
  diffChildren(tr.doc, 0, other, hunks);
  hunks.sort((a, b) => b.from - a.from || b.to - a.to);
  for (const { from, to, slice } of hunks) trackedReplace(tr, from, to, slice, WORKING);
  claimRevisions(tr, WORKING, author, !theirs);
  return hunks.length > 0;
}
