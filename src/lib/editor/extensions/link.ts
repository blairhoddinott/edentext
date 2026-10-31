import LinkBase from '@tiptap/extension-link';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { AddMarkStep, ReplaceStep } from '@tiptap/pm/transform';
import { changedRanges } from './spellCheck';
import { recordChanges } from '../../storage/trackChanges.svelte';
import { DEFAULT_SHORTCUTS } from '../shortcuts';
import { autoCorrect } from '../../storage/autoCorrect.svelte';

// Event the toolbar listens for to open the link dialog (Ctrl/Cmd+K). The extension
// can't reach Svelte state directly, so it dispatches this on window instead.
export const OPEN_LINK_DIALOG_EVENT = 'odf-open-link-dialog';

// A link stands outside the review, so rejecting would leave it on what typing made of
// the text before it: while recording, only what is all new text links by itself.
function tracedLinks(tr: Transaction, trs: readonly Transaction[], state: EditorState): Transaction {
  const fresh = trs.flatMap(changedRanges);
  const isNew = (from: number, to: number) => {
    let all = true;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isInline) return true;
      const start = Math.max(pos, from), end = Math.min(pos + node.nodeSize, to);
      all &&= node.marks.some((m) => m.type.name === 'insertion') || fresh.some((r) => r.from <= start && end <= r.to);
      return false;
    });
    return all;
  };
  const out = state.tr;
  for (const step of tr.steps) if (!(step instanceof AddMarkStep && !isNew(step.from, step.to))) out.step(step);
  return out;
}

// Hyperlink mark. Round-trips to ODF <text:a xlink:href> (odf-kit's native run path
// and export/odt.ts applyRuns; import/odt.ts convertInline). openOnClick is off so a
// click just places the cursor — Ctrl/Cmd+click opens the URL (Editor.svelte).
export const Link = LinkBase.configure({
  openOnClick: false,
  autolink: true,
  // LibreOffice's AutoCorrect ▸ URL recognition, switchable in its dialog.
  shouldAutoLink: () => autoCorrect().urls,
  linkOnPaste: true,
  defaultProtocol: 'https',
  HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
}).extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // A link a file gives no look of its own (Word writes the blue as a character
      // style, so a run without one is drawn like the text around it). ODF has no such
      // link: LibreOffice paints every text:a, styled or not — probed.
      plain: {
        default: false,
        parseHTML: (el: HTMLElement) => el.hasAttribute('data-plain'),
        renderHTML: (attrs: Record<string, unknown>) => (attrs.plain ? { 'data-plain': '' } : {}),
      },
    };
  },
  // Autolinking reads only typed or pasted text, and its changed-range walk is quadratic
  // in steps: a format or language change across a long document took seconds in it.
  addProseMirrorPlugins() {
    const plugins = this.parent?.() ?? [];
    for (const p of plugins) {
      const append = p.spec.appendTransaction;
      if (!append || !(p as unknown as { key: string }).key.startsWith('autolink')) continue;
      p.spec.appendTransaction = (trs, oldState, newState) => {
        if (!trs.some((tr) => tr.steps.some((s) => s instanceof ReplaceStep))) return undefined;
        const tr = append(trs, oldState, newState);
        return tr && recordChanges() ? tracedLinks(tr, trs, newState) : tr;
      };
    }
    return plugins;
  },
  addKeyboardShortcuts() {
    return {
      [DEFAULT_SHORTCUTS.link]: () => {
        window.dispatchEvent(new CustomEvent(OPEN_LINK_DIALOG_EVENT));
        return true;
      },
    };
  },
});
