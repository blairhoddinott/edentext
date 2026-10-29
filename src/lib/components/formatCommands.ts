import type { Editor } from '@tiptap/core';
import { listContext } from '../editor/extensions/indent';
import type { LineStyle } from '../editor/extensions/textEffects';

// Character and paragraph commands both chromes run with more to them than one call.

export const LINE_STYLES: LineStyle[] = ['solid', 'double', 'dotted', 'dashed', 'wavy'];

/** The mark has to exist before its line style means anything, so this turns it on too. */
export function setLineStyle(editor: Editor, mark: 'underline' | 'strike', style: LineStyle): void {
  const chain = editor.chain().focus();
  // A bare caret inside a line restyles that whole run, not just the next typed text.
  // With no run to extend over (an empty line) the mark is only stored, and moving
  // the selection would drop it.
  const caret = editor.state.selection.empty && editor.isActive(mark) ? editor.state.selection.from : null;
  if (caret !== null) chain.extendMarkRange(mark);
  chain.setMark(mark, { lineStyle: style });
  if (caret !== null) chain.command(({ tr, commands }) => tr.selection.empty || commands.setTextSelection(caret));
  chain.run();
}

/** In a list the point steps a level (the Tab keymap's commands); elsewhere the
 *  paragraph's left indent steps. */
export function changeIndent(editor: Editor, dir: 1 | -1): void {
  const chain = editor.chain().focus();
  if (listContext(editor.state).inList) (dir > 0 ? chain.indentListForward() : chain.indentListBackward()).run();
  else (dir > 0 ? chain.indentMore() : chain.indentLess()).run();
}
