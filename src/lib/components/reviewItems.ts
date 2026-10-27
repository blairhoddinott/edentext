import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { comments, commentRanges, type CommentRange } from '../editor/extensions/comment';
import { revisions, type Revision } from '../editor/extensions/trackChanges';
import { markupView } from '../storage/markup.svelte';

// What the review views may show, in one place: bars, balloons, leader line and both
// panes ask here instead of each carrying its own reading of the markup settings.
// A resolved comment is not this rule's business — every caller handles it as it did.

export function visibleComments(doc: PMNode): CommentRange[] {
  return markupView().comments ? comments(doc) : [];
}

export function visibleCommentRanges(doc: PMNode): CommentRange[] {
  return markupView().comments ? commentRanges(doc) : [];
}

export function visibleRevisions(doc: PMNode): Revision[] {
  return markupView().changes ? revisions(doc) : [];
}

/** Select a marked range and scroll it smoothly into view — what a click on any of its
 *  cards does. `scroll: false` for a card beside the page, which stays under the pointer. */
export function selectRange(editor: Editor, from: number, to: number, scroll = true): void {
  const { state, view } = editor;
  const tr = state.tr.setSelection(TextSelection.create(state.doc, from, to));
  const scroller = (view.dom as HTMLElement).closest('.editor');
  view.dispatch(scroll && !scroller ? tr.scrollIntoView() : tr);
  view.focus();
  if (!scroll || !scroller) return;
  // Glides rather than jumps, and only when the line is not already well in view; it
  // lands a third of the way down, where the eye looks for it.
  const line = view.coordsAtPos(from);
  const box = scroller.getBoundingClientRect();
  const inY = line.top >= box.top + 40 && line.bottom <= box.bottom - 40;
  const inX = line.left >= box.left + 20 && line.right <= box.right - 20;
  if (inY && inX) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  scroller.scrollBy({
    top: inY ? 0 : line.top - (box.top + box.height / 3),
    left: inX ? 0 : line.left - (box.left + box.width / 3),
    behavior: reduce ? 'auto' : 'smooth',
  });
}

/** The entry after the caret, wrapping at the end — Word's Next in both review groups. */
export function step<T extends { from: number; to: number }>(
  list: T[], pos: number, dir: 1 | -1,
): T | null {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a.from - b.from);
  const hit = dir === 1
    ? sorted.find((r) => r.from > pos)
    : [...sorted].reverse().find((r) => r.from < pos);
  return hit ?? (dir === 1 ? sorted[0] : sorted[sorted.length - 1]);
}
