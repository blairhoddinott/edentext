import type { EditorState } from '@tiptap/pm/state';
import { findColumns, DEFAULT_COLUMN_GAP_CM } from '../editor/extensions/columns';
import { EMPTY_HF_SET, type HfSet } from '../storage/headerFooter';
import type { PageMargins } from '../storage/pageMargins';

// Page setup both chromes edit: the section the cursor is in, its own page setup, the
// margin presets and the columns around the cursor.

/** The section the cursor is in: every top-level block carrying `sectionBreak` opens the
 *  next one. 0 is the document's own first section, which has no HfSet of its own. */
export function sectionAt(state: EditorState): number {
  const at = state.selection.from;
  let n = 0;
  state.doc.forEach((node, pos) => {
    if (pos < at && node.attrs?.sectionBreak === true) n++;
  });
  return n;
}

/** A section's own setting, or null where it takes the document's. */
export function sectionValue<K extends keyof HfSet>(sections: HfSet[], section: number, key: K): HfSet[K] | null {
  return section > 0 ? sections[section - 1]?.[key] ?? null : null;
}

/** Sets a section's own page setup, so every other section keeps the document's. */
export function withSectionProps(sections: HfSet[], section: number, props: Partial<HfSet>): HfSet[] {
  if (section < 1) return sections;
  const out = sections.slice();
  while (out.length < section) out.push({ ...EMPTY_HF_SET });
  out[section - 1] = { ...out[section - 1], ...props };
  return out;
}

// Named after the value they set, so no preset hides what it does.
export const MARGIN_PRESETS: { key: 'normal' | 'narrow' | 'wide'; m: PageMargins }[] = [
  { key: 'normal', m: { top: 2, bottom: 2, left: 2, right: 2 } },
  { key: 'narrow', m: { top: 1.27, bottom: 1.27, left: 1.27, right: 1.27 } },
  { key: 'wide', m: { top: 2.54, bottom: 2.54, left: 5.08, right: 5.08 } },
];

/** Count and gap of the columns section around the cursor; count 1 outside one. */
export function columnState(state: EditorState | null): { count: number; gapCm: number; inColumns: boolean } {
  const found = state && findColumns(state);
  return found
    ? { count: found.node.attrs.count as number, gapCm: found.node.attrs.gapCm as number, inColumns: true }
    : { count: 1, gapCm: DEFAULT_COLUMN_GAP_CM, inColumns: false };
}
