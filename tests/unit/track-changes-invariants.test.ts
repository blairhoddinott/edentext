// What recording promises, for every kind of edit: accepting all gives what the same edit
// gives unrecorded, rejecting all gives the document back.
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { extensions } from '../../src/lib/editor/extensions';
import { revisions } from '../../src/lib/editor/extensions/trackChanges';
import { setRecordChanges } from '../../src/lib/storage/trackChanges.svelte';
import { buildDocx } from '../../src/lib/export/docx';
import { importDocx } from '../../src/lib/import/docx';
import { buildOdt } from '../../src/lib/export/odt';
import { importOdt } from '../../src/lib/import/odt';
import { DEFAULT_MARGINS } from '../../src/lib/storage/pageMargins';

type Act = (e: Editor) => unknown;

const settled = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

function open(content: unknown) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({ element, extensions, content: content as string });
}

const FORMATS: [string, (doc: any) => Promise<unknown>][] = [
  ['DOCX', async (doc) => importDocx(await buildDocx(doc, DEFAULT_MARGINS)).content],
  ['ODT', async (doc) => importOdt(await buildOdt(doc, DEFAULT_MARGINS)).content],
];

const select = (e: Editor, from: number, to = from) =>
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, from, to)));

async function edit(e: Editor, steps: Act[]) {
  for (const step of steps) { step(e); await settled(); }
}

const THREE = '<p>aaaa</p><p>bbbb</p><p>cccc</p>';
const LIST = '<ul><li><p>one</p></li><li><p>two</p></li></ul><p>tail</p>';

const del = (from: number, to: number): Act[] => [(e) => select(e, from, to), (e) => e.commands.deleteSelection()];
const enter = (at: number): Act[] => [(e) => select(e, at), (e) => e.commands.splitBlock()];

const CASES: [string, string, Act[]][] = [
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
];

afterEach(() => setRecordChanges(false));

describe('recording keeps its promise', () => {
  it.each(CASES)('%s', async (_name, html, steps) => {
    const plain = open(html);
    await edit(plain, steps);
    const start = open(html).getJSON();

    setRecordChanges(true);
    const accepted = open(html);
    await edit(accepted, steps);
    const recorded = accepted.getJSON();
    expect(revisions(accepted.state.doc).length).toBeGreaterThan(0);
    setRecordChanges(false);

    const rejected = open(recorded);
    rejected.commands.rejectRevisions(true);
    expect(rejected.getJSON()).toEqual(start);
    for (const [format, through] of FORMATS) {
      // ODF has no mark between a list and the text beside it: LibreOffice's form loses which side was the list.
      if (format === 'ODT' && _name.includes('from a list')) continue;
      const reread = open(await through(recorded));
      reread.commands.rejectRevisions(true);
      expect(reread.getJSON(), `${format}, rejected`).toEqual(open(await through(start)).getJSON());
      const rereadAccepted = open(await through(recorded));
      rereadAccepted.commands.acceptRevisions(true);
      expect(rereadAccepted.getJSON(), `${format}, accepted`).toEqual(open(await through(plain.getJSON())).getJSON());
    }

    accepted.commands.acceptRevisions(true);
    expect(accepted.getJSON()).toEqual(plain.getJSON());
  });

  it('one typed passage over a paragraph break is one change', async () => {
    setRecordChanges(true);
    const e = open('<p>x</p>');
    await edit(e, [(ed) => select(ed, 2), (ed) => ed.commands.insertContent('one'), (ed) => ed.commands.splitBlock(), (ed) => ed.commands.insertContent('two')]);
    expect(revisions(e.state.doc).map((r) => r.text)).toEqual(['one\ntwo']);
  });

  it('taking back the own paragraph break leaves nothing recorded', async () => {
    setRecordChanges(true);
    const e = open('<p>abcd</p>');
    await edit(e, [(ed) => select(ed, 3), (ed) => ed.commands.splitBlock(), (ed) => ed.commands.joinBackward()]);
    expect(revisions(e.state.doc)).toEqual([]);
    expect(e.getJSON()).toEqual(open('<p>abcd</p>').getJSON());
  });

  it('a block split in two hands its mark to the second half', async () => {
    setRecordChanges(true);
    const e = open(THREE);
    await edit(e, [...del(5, 7), ...enter(3)]);
    setRecordChanges(false);
    e.commands.rejectRevisions(true);
    expect(e.getJSON()).toEqual(open(THREE).getJSON());
  });
});
