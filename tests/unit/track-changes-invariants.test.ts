// What recording promises, for every kind of edit: accepting all gives what the same edit
// gives unrecorded, rejecting all gives the document back.
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { zoneExtensions } from '../../src/lib/editor/extensions';
import { BLOCK_FORMAT_CASES, CASES, FORMAT_CASES, LIST_CASES, MOVE_CASES, REBUILD_CASES, TABLE_CASES, THREE, del, edit, enter, open, select } from '../trackChangesCases';
import { revisions, settledDoc } from '../../src/lib/editor/extensions/trackChanges';
import { setRecordChanges } from '../../src/lib/storage/trackChanges.svelte';
import { searchKey } from '../../src/lib/editor/extensions/searchReplace';
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
    const recorded = e.getJSON(), start = open(html).getJSON();
    const rejected = open(recorded);
    rejected.commands.rejectRevisions(true);
    expect(rejected.getJSON()).toEqual(start);
    for (const [format, through] of FORMATS) {
      const reread = open(await through(recorded));
      expect(revisions(reread.state.doc).map((r) => r.kind), format).toContain('formatChange');
      reread.commands.rejectRevisions(true);
      // ODF holds no old values: rejecting there drops the run's direct formatting.
      if (format === 'DOCX') expect(reread.getJSON(), `${format}, rejected`).toEqual(open(await through(start)).getJSON());
      else expect(revisions(reread.state.doc)).toEqual([]);
      const taken = open(await through(recorded));
      taken.commands.acceptRevisions(true);
      expect(taken.getJSON(), `${format}, accepted`).toEqual(open(await through(plain.getJSON())).getJSON());
    }
    e.commands.acceptRevisions(true);
    expect(e.getJSON()).toEqual(plain.getJSON());
  });

  it.each(BLOCK_FORMAT_CASES)('%s', async (_name, html, steps) => {
    const plain = open(html);
    await edit(plain, steps);
    setRecordChanges(true);
    const e = open(html);
    await edit(e, steps);
    expect(revisions(e.state.doc).map((r) => r.kind)).toEqual(['formatChange']);
    setRecordChanges(false);
    const recorded = e.getJSON(), start = open(html).getJSON();
    const rejected = open(recorded);
    rejected.commands.rejectRevisions(true);
    expect(rejected.getJSON()).toEqual(start);
    const [[, docx], [, odt]] = FORMATS;
    const reread = open(await docx(recorded));
    expect(revisions(reread.state.doc).map((r) => r.kind)).toEqual(['formatChange']);
    reread.commands.rejectRevisions(true);
    expect(reread.getJSON(), 'DOCX, rejected').toEqual(open(await docx(start)).getJSON());
    const taken = open(await docx(recorded));
    taken.commands.acceptRevisions(true);
    expect(taken.getJSON(), 'DOCX, accepted').toEqual(open(await docx(plain.getJSON())).getJSON());
    // ODF has no form for it that LibreOffice reads back: the format stays, the record goes.
    expect(open(await odt(recorded)).getJSON()).toEqual(open(await odt(plain.getJSON())).getJSON());
    e.commands.acceptRevisions(true);
    expect(e.getJSON()).toEqual(plain.getJSON());
  });

  it.each(LIST_CASES)('%s', async (_name, html, steps) => {
    const plain = open(html);
    await edit(plain, steps);
    setRecordChanges(true);
    const e = open(html);
    await edit(e, steps);
    expect(revisions(e.state.doc).map((r) => r.kind)).toContain('formatChange');
    expect(revisions(e.state.doc).every((r) => r.kind === 'formatChange')).toBe(true);
    setRecordChanges(false);
    const recorded = e.getJSON();
    const rejected = open(recorded);
    rejected.commands.rejectRevisions(true);
    expect(rejected.getJSON()).toEqual(open(html).getJSON());
    const [[, docx]] = FORMATS;
    const reread = open(await docx(recorded));
    expect(revisions(reread.state.doc).length > 0).toBe(/made a list/.test(_name));
    if (/made a list/.test(_name)) {
      reread.commands.rejectRevisions(true);
      expect(reread.getJSON(), 'DOCX, rejected').toEqual(open(await docx(open(html).getJSON())).getJSON());
    }
    e.commands.acceptRevisions(true);
    expect(e.getJSON()).toEqual(plain.getJSON());
  });

  it.each(MOVE_CASES)('%s', async (_name, html, steps) => {
    const plain = open(html);
    await edit(plain, steps);
    setRecordChanges(true);
    const e = open(html);
    await edit(e, steps);
    setRecordChanges(false);
    const moved = revisions(e.state.doc);
    expect(moved.map((r) => r.moved)).toEqual([true, true]);
    expect(moved[0].moveId).toBe(moved[1].moveId);
    const recorded = e.getJSON();
    // One half settles the pair.
    const rejected = open(recorded);
    rejected.commands.rejectRevision(moved[1].id);
    expect(rejected.getJSON()).toEqual(open(html).getJSON());
    for (const [format, through] of FORMATS) {
      const reread = open(await through(recorded));
      const halves = revisions(reread.state.doc);
      expect(halves.every((r) => r.moved), format).toBe(true);
      expect(new Set(halves.map((r) => r.moveId)).size, format).toBe(1);
      reread.commands.acceptRevision(halves[0].id);
      expect(reread.getJSON(), `${format}, accepted`).toEqual(open(await through(plain.getJSON())).getJSON());
      const back = open(await through(recorded));
      back.commands.rejectRevision(halves[0].id);
      expect(back.getJSON(), `${format}, rejected`).toEqual(open(await through(open(html).getJSON())).getJSON());
    }
    e.commands.acceptRevision(moved[0].id);
    expect(e.getJSON()).toEqual(plain.getJSON());
  });

  it.each([...CASES, ...FORMAT_CASES, ...MOVE_CASES])('a comment stays on the change through ODT: %s', async (_name, html, steps) => {
    setRecordChanges(true);
    const e = open(html);
    await edit(e, steps);
    setRecordChanges(false);
    const start = revisions(e.state.doc);
    for (const r of start) e.commands.commentRevision(r.id, 'first\nsecond');
    const pending = e.getJSON();
    expect(revisions(e.state.doc).map((r) => r.comment)).toEqual(start.map(() => 'first\nsecond'));
    expect(revisions(open(await FORMATS[1][1](pending)).state.doc).every((r) => r.comment === 'first\nsecond')).toBe(true);
    // Taken off, nothing but the change is left.
    for (const r of start) e.commands.commentRevision(r.id, '');
    expect(revisions(e.state.doc).map((r) => [r.id, r.comment])).toEqual(start.map((r) => [r.id, undefined]));
  });

  // A header goes through both files by its own path: the same promise, there.
  it.each(CASES)('in a header: %s', async (_name, html, steps) => {
    const zone = (content: unknown, live = false) => {
      const element = document.body.appendChild(document.createElement('div'));
      return new Editor({ element, extensions: zoneExtensions('', live), content: content as string });
    };
    const plain = zone(html);
    await edit(plain, steps);
    setRecordChanges(true);
    const e = zone(html, true);
    await edit(e, steps);
    expect(revisions(e.state.doc).length).toBeGreaterThan(0);
    setRecordChanges(false);
    const recorded = e.getJSON(), start = zone(html).getJSON();
    const body = open('<p>body</p>').getJSON() as any;
    const hf = (header: unknown) => ({ header, footer: null, pageCount: 1 }) as any;
    const files: [string, (doc: unknown) => Promise<unknown>][] = [
      ['DOCX', async (doc) => importDocx(await buildDocx(body, DEFAULT_MARGINS, 'portrait', hf(doc))).header],
      ['ODT', async (doc) => importOdt(await buildOdt(body, DEFAULT_MARGINS, 'portrait', hf(doc))).header],
    ];
    for (const [format, through] of files) {
      if (format === 'ODT' && /from a list|sub-list$/.test(_name) && !_name.startsWith('Enter')) continue;
      const rejected = zone(await through(recorded));
      expect(revisions(rejected.state.doc).length, format).toBeGreaterThan(0);
      rejected.commands.rejectRevisions(true);
      expect(rejected.getJSON(), `${format}, rejected`).toEqual(zone(await through(start)).getJSON());
      const accepted = zone(await through(recorded));
      accepted.commands.acceptRevisions(true);
      expect(accepted.getJSON(), `${format}, accepted`).toEqual(zone(await through(plain.getJSON())).getJSON());
    }
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

  it.each(REBUILD_CASES)('nothing to record: %s', async (_name, html, steps) => {
    const plain = open(html);
    await edit(plain, steps);
    setRecordChanges(true);
    const e = open(html);
    await edit(e, steps);
    expect(revisions(e.state.doc)).toEqual([]);
    expect(shape(e)).toEqual(shape(plain));
  });

  it('a list a paragraph joins stays what it was', () => {
    const e = open('<p>more</p><ul data-list-style-name="Named"><li><p>one</p></li></ul>');
    select(e, 2);
    e.commands.toggleBulletList();
    expect(e.state.doc.firstChild!.attrs.listStyleName).toBe('Named');
    expect(e.state.doc.firstChild!.childCount).toBe(2);
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

// Struck text waits to go: whatever reads the document reads it as gone.
describe('struck text is not there', () => {
  const NUMS = '<table><tbody><tr><td><p>10</p></td></tr><tr><td><p>20</p></td></tr><tr><td><p></p></td></tr></tbody></table><p>tail</p>';
  const struck = async (html: string, from: number, to: number) => {
    setRecordChanges(true);
    const e = open(html);
    await edit(e, del(from, to));
    setRecordChanges(false);
    return e;
  };
  const texts = (e: Editor) => { const o: string[] = []; e.state.doc.descendants((n) => { if (n.isTextblock) o.push(n.textContent); return !n.isTextblock; }); return o; };
  const find = (e: Editor, term: string) => {
    e.commands.setSearch({ term, matchCase: false, wholeWord: false, useRegex: false });
    return searchKey.getState(e.state)!.matches.length;
  };

  it('a formula does not count it', async () => {
    const e = await struck(NUMS, 4, 5);
    await edit(e, [(ed) => select(ed, 20), (ed) => ed.commands.setCellFormula('=SUM(A1:A2)')]);
    await new Promise((r) => setTimeout(r));
    expect(texts(e)[2]).toBe('20');
  });

  it('typing does not read it', async () => {
    const e = await struck('<p>foo bar. now</p><p>t</p>', 5, 9);
    select(e, 13);
    e.view.someProp('handleTextInput', (f) => f(e.view, 13, 13, ' ', () => e.state.tr));
    expect(e.state.doc.firstChild!.textContent).not.toContain('Now');
  });

  it('a sort does not read it', async () => {
    const e = await struck('<table><tbody><tr><td><p>xb</p></td></tr><tr><td><p>a</p></td></tr></tbody></table><p>t</p>', 4, 5);
    await edit(e, [(ed) => select(ed, 4), (ed) => ed.commands.sortTable({ keys: [{ column: 0, type: 'text', descending: true }], headerRow: false })]);
    expect(texts(e)[0]).toBe('xb');
  });

  it('a search reads past it and leaves it', async () => {
    const e = await struck('<p>aXXb foo</p><p>t</p>', 2, 4);
    expect(find(e, 'xx')).toBe(0);
    expect(find(e, 'ab')).toBe(1);
    setRecordChanges(true);
    await edit(e, [(ed) => ed.commands.replaceAll('q')]);
    setRecordChanges(false);
    const rejected = open(e.getJSON()), accepted = open(e.getJSON());
    rejected.commands.rejectRevisions(true);
    accepted.commands.acceptRevisions(true);
    expect(texts(rejected)[0]).toBe('aXXb foo');
    expect(texts(accepted)[0]).toBe('q foo');
  });

  it.each([
    ['part of a selection', 1, 5, 'ab'],
    ['all of a selection', 2, 4, 'XX'],
  ])('a copy leaves it out: %s', async (_name, from, to, text) => {
    const e = await struck('<p>aXXb</p><p>t</p>', 2, 4);
    const { dom } = e.view.serializeForClipboard(e.state.doc.slice(from, to));
    const pasted = open('<p></p>');
    pasted.view.pasteHTML(dom.innerHTML, new Event('paste') as ClipboardEvent);
    expect(texts(pasted)[0]).toBe(text);
    expect(revisions(pasted.state.doc)).toEqual([]);
  });
});
