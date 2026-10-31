// What comparing promises: however two documents differ, the recorded changes lead from one
// to the other, and from the other back, with what is the same left untouched.
import { describe, it, expect } from 'vitest';
import { open } from '../trackChangesCases';
import { recordDifferences } from '../../src/lib/editor/compare';
import { revisions } from '../../src/lib/editor/extensions/trackChanges';

const LIST = '<ul><li><p>one</p></li><li><p>two</p></li></ul><p>tail</p>';
const TABLE = (a: string) => `<table><tbody><tr><td><p>${a}</p></td><td><p>b</p></td></tr></tbody></table><p>x</p>`;

const CASES: [string, string, string, number][] = [
  ['a word changed', '<p>the quick fox</p>', '<p>the slow fox</p>', 1],
  ['a word added', '<p>the fox</p>', '<p>the quick fox</p>', 1],
  ['a word removed', '<p>the quick fox</p>', '<p>the fox</p>', 1],
  ['the same', '<p>same</p><p>text</p>', '<p>same</p><p>text</p>', 0],
  ['a block added', '<p>aa</p><p>cc</p>', '<p>aa</p><p>bb</p><p>cc</p>', 1],
  ['a block removed', '<p>aa</p><p>bb</p><p>cc</p>', '<p>aa</p><p>cc</p>', 1],
  ['the last block removed', '<p>aa</p><p>bb</p>', '<p>aa</p>', 1],
  ['a block added at the end', '<p>aa</p>', '<p>aa</p><p>bb</p>', 1],
  ['a block added at the start', '<p>bb</p>', '<p>aa</p><p>bb</p>', 1],
  ['a block turned heading', '<p>aa</p><p>tail</p>', '<h1>aa</h1><p>tail</p>', 2],
  ['a list item changed', LIST, LIST.replace('two', 'three'), 1],
  ['a list item added', LIST, LIST.replace('<li><p>two', '<li><p>new</p></li><li><p>two'), 1],
  ['a list item removed', LIST, LIST.replace('<li><p>two</p></li>', ''), 1],
  ['a cell changed', TABLE('aa'), TABLE('zz'), 1],
  ['a table added', '<p>aa</p><p>bb</p>', `<p>aa</p>${TABLE('t')}<p>bb</p>`, 1],
  ['two places', '<p>one two three</p><p>keep</p><p>four five</p>', '<p>one 2 three</p><p>keep</p><p>four 5</p>', 2],
];

const paragraphs = (e: ReturnType<typeof open>) => {
  const out: string[] = [];
  e.state.doc.descendants((n) => { if (n.isTextblock) out.push(`${n.type.name}:${n.textContent}`); return !n.isTextblock; });
  return out;
};

describe('comparing two documents', () => {
  it.each(CASES)('%s', (_name, before, after, changes) => {
    const [from, to] = [open(before), open(after)];
    const run = (theirs: boolean) => {
      const e = open(before), { tr } = e.state;
      expect(recordDifferences(tr, e.schema.nodeFromJSON(to.getJSON()), 'Ann', theirs)).toBe(changes > 0);
      e.view.dispatch(tr);
      const seen = revisions(e.state.doc);
      expect(seen.every((r) => r.author === 'Ann')).toBe(true);
      return e;
    };

    // This document the older: accepting gives the other, rejecting this one.
    const merged = run(true);
    expect(revisions(merged.state.doc).length > 0).toBe(changes > 0);
    const merge = merged.getJSON();
    merged.commands.acceptRevisions(true);
    expect(paragraphs(merged)).toEqual(paragraphs(to));
    const back = open(merge);
    back.commands.rejectRevisions(true);
    expect(back.getJSON()).toEqual(from.getJSON());

    // This document the newer: the other way round, and its own text still reads as it did.
    const compared = run(false);
    const both = compared.getJSON();
    compared.commands.rejectRevisions(true);
    expect(paragraphs(compared)).toEqual(paragraphs(to));
    const kept = open(both);
    kept.commands.acceptRevisions(true);
    expect(kept.getJSON()).toEqual(from.getJSON());
  });

  it('leaves the format of what is the same, and text already struck', () => {
    const e = open('<p><strong>keep</strong> this</p><p>and <span data-deletion="d" data-rev-author="B" data-rev-date="2020-01-01T00:00:00Z">gone </span>that</p>');
    const { tr } = e.state;
    recordDifferences(tr, e.schema.nodeFromJSON(open('<p>keep this</p><p>and those</p>').getJSON()), 'Ann', true);
    e.view.dispatch(tr);
    const json = JSON.stringify(e.getJSON());
    expect(json).toContain('"bold"');
    expect(revisions(e.state.doc).map((r) => [r.kind, r.author, r.text])).toEqual([
      ['deletion', 'B', 'gone '], ['deletion', 'Ann', 'that'], ['insertion', 'Ann', 'those'],
    ]);
  });
});
