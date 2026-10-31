// The edits every recording leg runs, unit and LibreOffice alike.
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { extensions } from '../src/lib/editor/extensions';

// jsdom has none, and a text box's view observes its size.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

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
  ['a note inserted', THREE, [(e) => select(e, 3), (e) => e.commands.insertNote('footnote')]],
  ['a text box inserted', THREE, [(e) => select(e, 3), (e) => e.commands.insertTextBox()]],
  ['Enter in a cell', TABLE, [inCell(5), (e) => e.commands.splitBlock()]],
  ['a table inserted', THREE, [(e) => select(e, 7), (e) => e.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })]],
];

const ranged = (from: number, to: number, act: Act): Act[] => [(e) => select(e, from, to), act];
const STYLED = '<p>a<strong>bb</strong>c <em>dd</em></p><p>tail</p>';

/** Edits of a run's format. */
export const FORMAT_CASES: [string, string, Act[]][] = [
  ['bold set', THREE, ranged(2, 4, (e) => e.commands.setBold())],
  ['bold across paragraphs', THREE, ranged(3, 9, (e) => e.commands.setBold())],
  ['bold taken off', STYLED, ranged(2, 4, (e) => e.commands.unsetBold())],
  ['bold over mixed runs', STYLED, ranged(1, 8, (e) => e.commands.toggleBold())],
  ['a font size changed', STYLED, ranged(2, 8, (e) => e.commands.setMark('textStyle', { fontSize: '20pt' }))],
  ['formatting cleared', STYLED, ranged(1, 8, (e) => e.commands.clearDirectFormatting())],
  ['two formats, one after the other', STYLED, [...ranged(2, 4, (e) => e.commands.setItalic()), (e) => e.commands.setUnderline()]],
];

/** Edits of a block's own format. */
export const BLOCK_FORMAT_CASES: [string, string, Act[]][] = [
  ['alignment set', THREE, ranged(2, 2, (e) => e.commands.setTextAlign('center'))],
  ['alignment over two paragraphs', THREE, ranged(3, 9, (e) => e.commands.setTextAlign('right'))],
  ['a paragraph style', THREE, ranged(2, 2, (e) => e.commands.setParagraphStyle('Heading 1'))],
  ['a heading made a paragraph', '<h2>head</h2><p>body</p>', ranged(2, 2, (e) => e.commands.setParagraph())],
  ['an indent and a line height', THREE, [...ranged(2, 2, (e) => e.commands.updateAttributes('paragraph', { indent: 1.25 })), (e) => e.commands.updateAttributes('paragraph', { lineHeight: '1.5' })]],
];

const ITEMS = '<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul><p>tail</p>';
const LEVELS = '<ul><li><p>one</p><ul><li><p>sub</p></li></ul></li><li><p>two</p></li></ul>';

/** Edits of what lists a block is in. */
export const LIST_CASES: [string, string, Act[]][] = [
  ['a paragraph made a list', THREE, ranged(2, 2, (e) => e.commands.toggleBulletList())],
  ['paragraphs made a list', THREE, ranged(2, 8, (e) => e.commands.toggleOrderedList())],
  ['a paragraph joining the list before it', ITEMS.replace('<p>tail</p>', '<p>more</p>'), ranged(24, 24, (e) => e.commands.toggleBulletList())],
  ['the middle item out of its list', ITEMS, ranged(9, 9, (e) => e.commands.toggleBulletList())],
  ['the first item out of its list', ITEMS, ranged(4, 4, (e) => e.commands.toggleBulletList())],
  ['the whole list off', ITEMS, ranged(4, 17, (e) => e.commands.toggleBulletList())],
  ['a list of the other type', ITEMS, ranged(4, 4, (e) => e.commands.toggleOrderedList())],
  ['an item one level down', ITEMS, ranged(11, 11, (e) => e.commands.sinkListItem('listItem'))],
  ['a nested list off', LEVELS, ranged(4, 20, (e) => e.commands.toggleBulletList())],
  ['an item one level up', LEVELS, ranged(11, 11, (e) => e.commands.liftListItem('listItem'))],
  ['a paragraph made a list, joining the one after it', '<p>more</p><ul data-list-style-name="Named"><li><p>one</p></li><li><p>two</p></li></ul>', ranged(2, 2, (e) => e.commands.toggleBulletList())],
  ['another bullet', ITEMS, ranged(4, 4, (e) => e.commands.setBulletChar('*'))],
  ['another numbering', ITEMS.replace(/ul>/g, 'ol>'), ranged(4, 4, (e) => e.commands.setOrderedListType('lower-alpha'))],
];

const CHAPTERS = '<h1>A</h1><p>aa</p><h1>B</h1><p>bb</p><h1>C</h1><p>cc</p>';
// A drop deletes the selection and puts it down elsewhere, as ProseMirror does.
const drop = (from: number, to: number, at: number): Act => (e) => {
  const { tr, doc } = e.state, slice = doc.slice(from, to);
  tr.delete(from, to).insert(tr.mapping.map(at), slice.content);
  e.view.dispatch(tr.setMeta('uiEvent', 'drop'));
};

/** Edits that carry content elsewhere: a deletion and an insertion that are one change. */
export const MOVE_CASES: [string, string, Act[]][] = [
  ['a chapter moved down', CHAPTERS, [(e) => e.commands.moveChapter(0, 1)]],
  ['a chapter moved up', CHAPTERS, [(e) => e.commands.moveChapter(7, -1)]],
  ['the last chapter moved up', CHAPTERS, [(e) => e.commands.moveChapter(14, -1)]],
  ['words dropped elsewhere', THREE, [drop(2, 4, 9)]],
  ['words dropped into another paragraph, across a mark', THREE, [drop(4, 9, 14)]],
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
  ['Enter over one\'s own empty paragraph', THREE, [...enter(7), (e) => select(e, 7, 9), (e) => e.commands.splitBlock()]],
  ['text over one\'s own empty paragraph', THREE, [...enter(7), (e) => select(e, 7, 9), (e) => e.commands.insertContent('new')]],
  ['Enter over one\'s own paragraph and the next text', THREE, [...enter(7), (e) => select(e, 7, 10), (e) => e.commands.splitBlock()]],
  ['paragraphs over one\'s own empty paragraph', THREE, [...enter(7), (e) => select(e, 7, 9), (e) => e.commands.insertContent('<p>x</p><p>y</p>')]],
  ['several paragraphs inserted', THREE, [(e) => e.commands.insertContentAt(3, '<p>xx</p><p>yy</p>')]],
  ['typing over two paragraphs', THREE, [(e) => select(e, 3, 9), (e) => e.commands.insertContent('z')]],
  ['Enter in a list item', LIST, enter(5)],
  ['a selection across list items', LIST, del(5, 11)],
  ['a whole list item', LIST, del(3, 10)],
  ['from a list into the text after it', LIST, del(10, 17)],
  ['from an item into its sub-list', NESTED, del(5, 12)],
  ['Enter before a sub-list', NESTED, enter(6)],
];

const TALL = '<table><tbody><tr><td colspan="2"><p>a</p></td></tr><tr><td><p>b</p></td><td><p>c</p></td></tr></tbody></table><p>t</p>';

/** Commands that regroup what is there: unrecorded, and no change left behind. */
export const REBUILD_CASES: [string, string, Act[]][] = [
  ['columns over the document', THREE, [(e) => select(e, 2), (e) => e.commands.setColumns(2)]],
  ['columns over a selection', THREE, [(e) => select(e, 2, 9), (e) => e.commands.setColumns(2)]],
  ['columns taken off', '<div data-columns="2" data-column-gap="0.5"><p>aa</p><p>bb</p></div><p>t</p>', [(e) => select(e, 3), (e) => e.commands.setColumns(1)]],
  ['a merged cell split', TALL, [(e) => select(e, 4), (e) => e.commands.splitCell()]],
  ['a cell split into two', TALL, [(e) => select(e, 4), (e) => e.commands.splitCellInto(2, 1)]],
  ['an index at a heading start', '<h1>Head</h1><p>x</p>', [(e) => select(e, 1), (e) => e.commands.setTableOfContents()]],
  ['an index in a paragraph', THREE, [(e) => select(e, 7), (e) => e.commands.setTableOfContents()]],
];
