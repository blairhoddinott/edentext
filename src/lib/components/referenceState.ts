import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isCitationStyle, type CitationStyle } from '../utils/citationStyle';
import { shownRange } from '../editor/extensions/trackChanges';
import { askText } from './PromptDialog.svelte';
import { t } from '../i18n/i18n.svelte';

// The indexes both chromes read and set: the document holds at most one table of
// contents and one bibliography, so the first hit is it.

export type TocInfo = { pos: number; maxLevel: number; pageNumbers: boolean };

/** The table of contents: a caption index has one level, so only this one has levels. */
export function findToc(doc: PMNode): TocInfo | null {
  let found: TocInfo | null = null;
  doc.descendants((node, pos) => {
    if (found || node.type.name !== 'tableOfContents' || node.attrs.index !== 'toc') return;
    found = { pos, maxLevel: (node.attrs.maxLevel ?? 5) as number, pageNumbers: node.attrs.pageNumbers !== false };
  });
  return found;
}

export function hasIndex(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => { if (node.type.name === 'tableOfContents') found = true; return !found; });
  return found;
}

/** The bibliography holds the citation style in both formats, so without one citations
 *  read by key and there is no style to pick. */
export function findBibliography(doc: PMNode): { pos: number; style: CitationStyle } | null {
  let found: { pos: number; style: CitationStyle } | null = null;
  doc.descendants((node, pos) => {
    if (found || node.type.name !== 'tableOfContents' || node.attrs.index !== 'bibliography') return;
    found = { pos, style: isCitationStyle(node.attrs.citationStyle) ? node.attrs.citationStyle : 'key' };
  });
  return found;
}

/** Sets an attribute of the index node at `pos`. */
export function setIndexAttrs(editor: Editor, pos: number, attrs: Record<string, unknown>): void {
  editor.chain().focus().setNodeSelection(pos).updateAttributes('tableOfContents', attrs).run();
}

/** The selected text is the term unless the reader gives another — the prompt both word
 *  processors open, filled from the selection. */
export async function markIndexEntry(editor: Editor): Promise<void> {
  const { from, to } = editor.state.selection;
  const term = await askText(t().ribbon.indexEntryPrompt, shownRange(editor.state.doc, from, to, ' '));
  if (term?.trim()) editor.chain().focus().setTextSelection(to).insertIndexEntry(term).run();
}
