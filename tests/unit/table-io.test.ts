// Table properties through ODF: alignment against the margins and rows kept together.
import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { buildOdt } from '../../src/lib/export/odt';
import { importOdt } from '../../src/lib/import/odt';

type N = any;

// table:align="margins" is a table stretched between the text margins. Its style:width is
// the width the producing page had, so deriving a margin from it against ours would leave
// the table narrow.
describe('a table aligned to the margins', () => {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
    + 'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';
  const attrsOf = (tableProps: string): Record<string, unknown> => (importOdt(zipSync({
    'styles.xml': strToU8(`<?xml version="1.0"?><office:document-styles ${NS}><office:styles><style:style style:name="Standard" style:family="paragraph"/></office:styles>
      <office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-left="3.6cm" fo:margin-right="2.7cm"/></style:page-layout></office:automatic-styles>
      <office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>`),
    'content.xml': strToU8(`<?xml version="1.0"?><office:document-content ${NS}><office:automatic-styles>
      <style:style style:name="T1" style:family="table"><style:table-properties ${tableProps}/></style:style></office:automatic-styles>
      <office:body><office:text><table:table table:name="T" table:style-name="T1"><table:table-column/>
      <table:table-row><table:table-cell><text:p text:style-name="Standard">a</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>`),
  })).content as N).content?.[0]?.attrs ?? {};

  it.each([
    ['keeps the full text width whatever width the producer wrote', 'style:width="14.7cm" table:align="margins"', [undefined, undefined]],
    ['still honours the margins the file declares itself', 'style:width="12cm" table:align="margins" fo:margin-left="1.5cm"', [1.5, undefined]],
    ['leaves a centred table centred', 'style:width="10.7cm" table:align="center"', [2, 2]],
  ])('%s', (_name, props, want) => {
    const { marginLeft, marginRight } = attrsOf(props);
    expect([marginLeft, marginRight]).toEqual(want);
  });
});

// style:may-break-between-rows="false": the table moves whole rather than break.
describe('table keep-rows', () => {
  const cell = (text: string): N => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const roundTrip = async (attrs: N) => {
    const bytes = await buildOdt({ type: 'doc', content: [{ type: 'table', attrs, content: [0, 1].map((r) => ({ type: 'tableRow', content: [cell(`a${r}`), cell(`b${r}`)] })) }] } as N);
    return { xml: strFromU8(unzipSync(bytes)['content.xml']), keepRows: (importOdt(bytes).content as N).content?.[0]?.attrs?.keepRows ?? null };
  };
  it('round-trips style:may-break-between-rows', async () => {
    const { xml, keepRows } = await roundTrip({ keepRows: true });
    expect(xml).toContain('style:may-break-between-rows="false"');
    expect(keepRows).toBe(true);
  });
  it('leaves a table that may break without the attribute', async () => {
    const { xml, keepRows } = await roundTrip({});
    expect(xml).not.toContain('may-break-between-rows');
    expect(keepRows).toBe(null);
  });
});
