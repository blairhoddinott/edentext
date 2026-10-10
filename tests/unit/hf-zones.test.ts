// A header or footer zone as the editor holds it: its schema, its helpers and its storage.
import { describe, it, expect, vi } from 'vitest';
import { Editor, getSchema } from '@tiptap/core';
import { zoneExtensions, extensions } from '../../src/lib/editor/extensions';
import { hfIsEmpty, hfUsesChapterField, EMPTY_HF_SET, type HfDoc } from '../../src/lib/storage/headerFooter';
import { fakeIndexedDb } from '../fakeIdb';

const p = (text?: string) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });

// A zone holds blocks like the body: Enter splits the paragraph, and the schema admits
// lists and tables but not the page flow's own nodes.
describe('the zone schema', () => {
  it('splits the paragraph on Enter', () => {
    const editor = new Editor({ element: document.body.appendChild(document.createElement('div')), extensions: zoneExtensions(), content: { type: 'doc', content: [p('Seite 1')] } });
    editor.commands.focus('end');
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const json = editor.getJSON();
    expect(json.content!.length).toBe(2);
    expect(JSON.stringify(json)).not.toContain('hardBreak');
    editor.destroy();
  });
  it('keeps the body blocks and drops the page flow', () => {
    const zone = getSchema(zoneExtensions());
    const body = getSchema(extensions);
    for (const n of ['table', 'bulletList', 'heading', 'textBox', 'image', 'pageNumber', 'chapterField']) expect(zone.nodes[n], n).toBeTruthy();
    for (const n of ['noteSection', 'pageBreak', 'columns', 'tableOfContents']) expect(zone.nodes[n], n).toBeUndefined();
    expect(zone.marks.comment).toBeUndefined();
    expect(Object.keys(body.nodes).filter((n) => !zone.nodes[n]).sort()).toEqual(['columns', 'note', 'noteRef', 'noteSection', 'tableOfContents']);
  });
});

describe('zone helpers over every block', () => {
  it('call a zone empty only when its one block carries nothing', () => {
    expect(hfIsEmpty({ type: 'doc', content: [p()] })).toBe(true);
    // Each blank line takes its height in the band.
    expect(hfIsEmpty({ type: 'doc', content: [p(), p()] })).toBe(false);
    expect(hfIsEmpty({ type: 'doc', content: [p(), p('second')] })).toBe(false);
    expect(hfIsEmpty({ type: 'doc', content: [p(), { type: 'table', content: [] }] })).toBe(false);
  });
  it('find a chapter field inside a table cell', () => {
    const header: HfDoc = { type: 'doc', content: [p(), { type: 'table', content: [{ type: 'tableRow', content: [
      { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'chapterField' }] }] }] }] }] };
    expect(hfUsesChapterField([{ ...EMPTY_HF_SET, header }])).toBe(true);
    expect(hfUsesChapterField([{ ...EMPTY_HF_SET, header: { type: 'doc', content: [p('x')] } }])).toBe(false);
  });
});

// A zone's pictures leave its stored JSON for the image store and come back on load.
it('stores zone pictures by key once the image store has them, and reads them back', async () => {
  const big = (fill: string) => `data:image/png;base64,${fill.repeat(5000)}`;
  const zone = (src: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src } }] }] });
  const idb = fakeIndexedDb();
  vi.stubGlobal('indexedDB', { open: idb.open });
  localStorage.clear();
  const { saveHfDoc, saveExtraHfSections, loadHfPictures } = await import('../../src/lib/storage/headerFooter');
  const { putImages } = await import('../../src/lib/storage/imageStore');
  saveHfDoc('header', zone(big('A')) as any);
  saveExtraHfSections([{ ...EMPTY_HF_SET, footer: zone(big('B')) as any }]);
  // Inline at once, so nothing is lost before the store answers.
  expect(localStorage.getItem('edentext-header')).toContain('data:image');
  await new Promise((r) => setTimeout(r, 20));
  expect(localStorage.getItem('edentext-header')).not.toContain('data:image');
  expect(localStorage.getItem('edentext-hf-sections')).not.toContain('data:image');
  // The body's sweep leaves them alone.
  await putImages(new Map());
  expect(idb.data.size).toBe(2);
  const stored = await loadHfPictures();
  expect(stored?.missing).toBe(0);
  expect(JSON.stringify(stored?.zones.header)).toContain(big('A'));
  expect(JSON.stringify(stored?.sections[0].footer)).toContain(big('B'));
});
