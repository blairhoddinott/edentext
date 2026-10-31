// What recording promises, for every kind of edit: accepting all gives what the same edit
// gives unrecorded, rejecting all gives the document back.
import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { CASES, FORMAT_CASES, TABLE_CASES, THREE, del, edit, enter, open, select } from '../trackChangesCases';
import { revisions, settledDoc } from '../../src/lib/editor/extensions/trackChanges';
import { setRecordChanges } from '../../src/lib/storage/trackChanges.svelte';
import { buildDocx } from '../../src/lib/export/docx';
import { importDocx } from '../../src/lib/import/docx';
import { buildOdt } from '../../src/lib/export/odt';
import { importOdt } from '../../src/lib/import/odt';
import { DEFAULT_MARGINS } from '../../src/lib/storage/pageMargins';

// A file always states column widths; what a removed column leaves of them is the same
// edit. A new note or box draws its own id.
const shape = (e: Editor) => JSON.parse(JSON.stringify(e.getJSON(), (k, v) => (k === 'colwidth' || k === 'id' ? undefined : v)));

const FORMATS: [string, (doc: any) => Promise<unknown>][] = [
  ['DOCX', async (doc) => importDocx(await buildDocx(doc, DEFAULT_MARGINS)).content],
  ['ODT', async (doc) => importOdt(await buildOdt(doc, DEFAULT_MARGINS)).content],
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
      // ODF has no mark across a change of list level: LibreOffice's form loses the list side.
      if (format === 'ODT' && /from a list|sub-list$/.test(_name) && !_name.startsWith('Enter')) continue;
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

  it.each(FORMAT_CASES)('%s', async (_name, html, steps) => {
    const plain = open(html);
    await edit(plain, steps);
    setRecordChanges(true);
    const e = open(html);
    await edit(e, steps);
    expect(revisions(e.state.doc).map((r) => r.kind)).toEqual(['formatChange']);
    setRecordChanges(false);
    const rejected = open(e.getJSON());
    rejected.commands.rejectRevisions(true);
    expect(rejected.getJSON()).toEqual(open(html).getJSON());
    e.commands.acceptRevisions(true);
    expect(e.getJSON()).toEqual(plain.getJSON());
  });

  it('a format put back leaves no change, and the first record stands', async () => {
    setRecordChanges(true);
    const e = open(THREE);
    await edit(e, [(ed) => select(ed, 2, 4), (ed) => ed.commands.setBold(), (ed) => ed.commands.unsetBold()]);
    expect(revisions(e.state.doc)).toEqual([]);
    await edit(e, [(ed) => ed.commands.setBold(), (ed) => ed.commands.setItalic()]);
    e.commands.rejectRevisions(true);
    expect(e.getJSON()).toEqual(open(THREE).getJSON());
  });

  it('formatting the own insertion is no change of its own', async () => {
    setRecordChanges(true);
    const e = open(THREE);
    await edit(e, [(ed) => select(ed, 3), (ed) => ed.commands.insertContent('new'), (ed) => select(ed, 3, 6), (ed) => ed.commands.setBold()]);
    expect(revisions(e.state.doc).map((r) => r.kind)).toEqual(['insertion']);
  });

  it.each(TABLE_CASES)('%s', async (_name, html, steps) => {
    const plain = open(html);
    await edit(plain, steps);
    setRecordChanges(true);
    const e = open(html);
    await edit(e, steps);
    const recorded = e.getJSON();
    expect(revisions(e.state.doc)).toHaveLength(1);
    setRecordChanges(false);
    const rejected = open(recorded);
    rejected.commands.rejectRevisions(true);
    expect(rejected.getJSON()).toEqual(open(html).getJSON());
    for (const [format, through] of FORMATS) {
      const reread = open(await through(recorded));
      expect(revisions(reread.state.doc), `${format}, read`).toHaveLength(1);
      reread.commands.rejectRevisions(true);
      expect(shape(reread), `${format}, rejected`).toEqual(shape(open(await through(open(html).getJSON()))));
      const rereadAccepted = open(await through(recorded));
      rereadAccepted.commands.acceptRevisions(true);
      expect(shape(rereadAccepted), `${format}, accepted`).toEqual(shape(open(await through(plain.getJSON()))));
    }
    e.commands.acceptRevisions(true);
    expect(shape(e)).toEqual(shape(plain));
  });

  it.each<[string, (e: Editor) => unknown]>([
    ['note', (e) => e.commands.insertNote('footnote')],
    ['text box', (e) => e.commands.insertTextBox()],
  ])('a deleted %s comes back and goes', async (_name, insert) => {
    const e = open(THREE);
    await edit(e, [(ed) => select(ed, 3), insert]);
    const start = e.getJSON();
    const end = 3 + e.state.doc.child(0).child(1).nodeSize;
    setRecordChanges(true);
    await edit(e, del(2, end + 1));
    const recorded = e.getJSON();
    setRecordChanges(false);
    for (const [, through] of [['here', async (d: unknown) => d], ...FORMATS] as typeof FORMATS) {
      const rejected = open(await through(recorded));
      rejected.commands.rejectRevisions(true);
      expect(shape(rejected)).toEqual(shape(open(await through(start))));
      const accepted = open(await through(recorded));
      accepted.commands.acceptRevisions(true);
      expect(accepted.getJSON().content?.[0].content?.map((n) => n.type)).toEqual(['text']);
    }
  });

  // No file holds a paragraph mark in front of a table: the split itself survives only here.
  it('a table splitting a paragraph goes with the split', async () => {
    setRecordChanges(true);
    const e = open(THREE);
    await edit(e, [(ed) => select(ed, 9), (ed) => ed.commands.insertTable({ rows: 1, cols: 1, withHeaderRow: false })]);
    expect(revisions(e.state.doc)).toHaveLength(1);
    setRecordChanges(false);
    e.commands.rejectRevisions(true);
    expect(e.getJSON()).toEqual(open(THREE).getJSON());
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

  it('a paragraph style leaves the recorded mark alone', async () => {
    setRecordChanges(true);
    const e = open(THREE);
    await edit(e, [...del(5, 7), (ed) => select(ed, 2), (ed) => ed.commands.setParagraphStyle('Heading 1')]);
    expect(e.state.doc.firstChild!.attrs.revMark?.deletion).toBeTruthy();
    expect(e.state.doc.firstChild!.attrs.styleName).toBe('Heading 1');
  });

  it('a settled copy is what accepting or rejecting gives', async () => {
    setRecordChanges(true);
    const e = open(THREE);
    await edit(e, del(3, 9));
    const [doc, accepted] = [e.state.doc, open(e.getJSON())];
    setRecordChanges(false);
    accepted.commands.acceptRevisions(true);
    expect(settledDoc(doc, true).toJSON()).toEqual(accepted.getJSON());
    expect(settledDoc(doc, false).toJSON()).toEqual(open(THREE).getJSON());
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
