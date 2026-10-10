// Widow-orphan control is on by default in the editor, so only "off" travels on a block:
// DOCX w:widowControl (direct or inherited), ODF fo:widows/fo:orphans="0" — or, in ODF,
// neither declared anywhere, which LibreOffice lays out without the control.
// jsdom (vitest `environment`) supplies the global DOMParser.
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { buildOdt } from '../../src/lib/export/odt';
import { buildDocx } from '../../src/lib/export/docx';
import { importOdt } from '../../src/lib/import/odt';
import { importDocx } from '../../src/lib/import/docx';

type N = any;

const P = (text: string, attrs?: N): N =>
  ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content: [{ type: 'text', text }] });

const doc: N = {
  type: 'doc',
  content: [P('guarded'), P('unguarded', { widowControl: false })],
};

const margins = { top: 2, bottom: 2, left: 2, right: 2 };
const widowOf = (d: N, i: number) => d.content[i].attrs?.widowControl ?? null;

describe('widow-orphan control', () => {
  it('round-trips through ODF', async () => {
    const bytes = await buildOdt(doc, margins, 'portrait');
    const xml = strFromU8(unzipSync(bytes)['content.xml']);
    expect(xml).toMatch(/fo:orphans="0" fo:widows="0"/);

    const back = importOdt(bytes).content as N;
    expect(widowOf(back, 0)).toBe(null);
    expect(widowOf(back, 1)).toBe(false);
  });

  it('is off in an ODF file that declares it nowhere', () => {
    const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';
    const bytes = zipSync({
      mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }],
      'content.xml': strToU8(`<office:document-content ${NS}><office:body><office:text><text:p>bare</text:p></office:text></office:body></office:document-content>`),
    });
    expect(widowOf(importOdt(bytes).content as N, 0)).toBe(false);
  });

  it('round-trips through DOCX', async () => {
    const bytes = await buildDocx(doc, margins, 'portrait');
    const back = importDocx(bytes).content as N;
    expect(widowOf(back, 0)).toBe(null);
    expect(widowOf(back, 1)).toBe(false);
  });
});
