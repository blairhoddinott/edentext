import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { zipSync, strToU8 } from 'fflate';
import { extensions } from '../../src/lib/editor/extensions';
import { importOdt } from '../../src/lib/import/odt';
import {
  bibliographyEntries, bibliographyRows, bibRowText, bibTypeFromDocx, citationText,
} from '../../src/lib/editor/extensions/bibliographyEntry';

const schema = getSchema(extensions);

const cite = (identifier: string, type: string, fields: Record<string, string>) =>
  ({ type: 'bibliographyEntry', attrs: { identifier, type, fields, text: '' } });
const KAF = { author: 'Kafka, Franz', title: 'Der Process', year: '1925' };
const MEY = { author: 'Meyer, Anna', title: 'Zur Sache', year: '1999' };

const doc = PMNode.fromJSON(schema, { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'a ' }, cite('KAF01', 'book', KAF)] },
  { type: 'paragraph', content: [{ type: 'text', text: 'b ' }, cite('MEY99', 'article', MEY), cite('KAF01', 'book', KAF)] },
] });

describe('bibliography', () => {
  it('collects every citation in document order', () => {
    expect(bibliographyEntries(doc).map(e => e.identifier)).toEqual(['KAF01', 'MEY99', 'KAF01']);
  });

  it('shows [key] where the file names no text of its own', () => {
    expect(bibliographyEntries(doc)[0].text).toBe(citationText('KAF01'));
  });

  it('lists one row per source, in document order', () => {
    expect(bibliographyRows(bibliographyEntries(doc))).toEqual([
      { identifier: 'KAF01', text: 'KAF01: Kafka, Franz, Der Process, 1925' },
      { identifier: 'MEY99', text: 'MEY99: Meyer, Anna, Zur Sache, 1999' },
    ]);
  });

  it('leaves out a field the source has not got', () => {
    expect(bibRowText({ identifier: 'X', type: 'misc', fields: { title: 'Nur ein Titel' } }))
      .toBe('X: Nur ein Titel');
    expect(bibRowText({ identifier: 'X', type: 'misc', fields: {} })).toBe('X');
  });

  it('reads a Word field code LibreOffice left as an ODF identifier as its tag', () => {
    const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';
    const odt = zipSync({ 'content.xml': strToU8(`<office:document-content ${NS}><office:body><office:text><text:p>see`
      + '<text:bibliography-mark text:identifier=" CITATION Bam00 \\l 1031 " text:bibliography-type="article" text:title="[4]"> [4]</text:bibliography-mark>'
      + '</text:p><text:bibliography text:name="B"><text:index-body/></text:bibliography></office:text></office:body></office:document-content>') });
    const doc = importOdt(odt).content as any;
    // The space before the cached [4] stays text; the cached numbers make the style numbered.
    expect(doc.content[0].content.map((n: any) => n.text ?? n.type)).toEqual(['see ', 'bibliographyEntry']);
    expect(doc.content[0].content[1].attrs).toMatchObject({ identifier: 'Bam00', fields: {} });
    expect(doc.content[1].attrs.citationStyle).toBe('numbered');
  });

  it('maps Word source types back, unknown ones to misc', () => {
    expect(bibTypeFromDocx('Book')).toBe('book');
    expect(bibTypeFromDocx('JournalArticle')).toBe('article');
    expect(bibTypeFromDocx('Patent')).toBe('misc');
  });
});
