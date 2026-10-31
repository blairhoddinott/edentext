// The edits every recording leg runs, unit and LibreOffice alike.
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { extensions } from '../src/lib/editor/extensions';

type Act = (e: Editor) => unknown;

const settled = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

export function open(content: unknown) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({ element, extensions, content: content as string });
}

export const select = (e: Editor, from: number, to = from) =>
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, from, to)));

export async function edit(e: Editor, steps: Act[]) {
  for (const step of steps) { step(e); await settled(); }
}

export const THREE = '<p>aaaa</p><p>bbbb</p><p>cccc</p>';
const NESTED = '<ul><li><p>one</p><ul><li><p>sub</p></li></ul></li><li><p>two</p></li></ul>';
const LIST = '<ul><li><p>one</p></li><li><p>two</p></li></ul><p>tail</p>';

export const del = (from: number, to: number): Act[] => [(e) => select(e, from, to), (e) => e.commands.deleteSelection()];
export const enter = (at: number): Act[] => [(e) => select(e, at), (e) => e.commands.splitBlock()];

const TABLE = '<table><tbody><tr><td><p>a1</p></td><td><p>b1</p></td></tr><tr><td><p>a2</p></td><td><p>b2</p></td></tr></tbody></table><p>tail</p>';
const inCell = (at: number): Act => (e) => select(e, at);

/** Edits of a table's structure; `at` is inside its second row's first cell. */
export const TABLE_CASES: [string, string, Act[]][] = [
  ['a row deleted', TABLE, [inCell(14), (e) => e.commands.deleteRow()]],
  ['a column deleted', TABLE, [inCell(14), (e) => e.commands.deleteColumn()]],
  ['the table deleted', TABLE, [inCell(14), (e) => e.commands.deleteTable()]],
  ['a row inserted', TABLE, [inCell(14), (e) => e.commands.addRowAfter()]],
  ['a column inserted', TABLE, [inCell(14), (e) => e.commands.addColumnBefore()]],
  ['a table inserted', THREE, [(e) => select(e, 7), (e) => e.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })]],
];

export const CASES: [string, string, Act[]][] = [
  ['a selection across two paragraphs', THREE, del(3, 9)],
  ['a whole paragraph with its mark', THREE, del(7, 13)],
  ['only a paragraph mark', THREE, del(5, 7)],
  ['three paragraphs', THREE, del(2, 15)],
  ['Backspace at a block start', THREE, [(e) => select(e, 7), (e) => e.commands.joinBackward()]],
  ['Delete at a block end', THREE, [(e) => select(e, 5), (e) => e.commands.joinForward()]],
  ['Enter inside a paragraph', THREE, enter(3)],
  ['Enter at a paragraph start', THREE, enter(7)],
  ['Enter at a paragraph end, then text', THREE, [...enter(5), (e) => e.commands.insertContent('new')]],
  ['two Enters', THREE, [...enter(3), ...enter(4)]],
  ['several paragraphs inserted', THREE, [(e) => e.commands.insertContentAt(3, '<p>xx</p><p>yy</p>')]],
  ['typing over two paragraphs', THREE, [(e) => select(e, 3, 9), (e) => e.commands.insertContent('z')]],
  ['Enter in a list item', LIST, enter(5)],
  ['a selection across list items', LIST, del(5, 11)],
  ['a whole list item', LIST, del(3, 10)],
  ['from a list into the text after it', LIST, del(10, 17)],
  ['from an item into its sub-list', NESTED, del(5, 12)],
  ['Enter before a sub-list', NESTED, enter(6)],
];
