// A paragraph style's own rule line (Word's w:pBdr, ODF fo:border-*) and the gap it keeps
// to the text (w:space / fo:padding). Both live in the style registry, not on the block.
import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { importDocx } from '../../src/lib/import/docx';
import { importOdt } from '../../src/lib/import/odt';
import { buildOdt } from '../../src/lib/export/odt';
import { styleCss } from '../../src/lib/styles/styleSheet';

type N = any;

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const styles = (pBdr: string) => `<?xml version="1.0"?><w:styles xmlns:w="${W}">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
    <w:pPr>${pBdr}</w:pPr></w:style>
</w:styles>`;

const doc = `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Heading</w:t></w:r></w:p>
</w:body></w:document>`;

const imported = (pBdr: string) =>
  importDocx(zipSync({ 'word/document.xml': strToU8(doc), 'word/styles.xml': strToU8(styles(pBdr)) })).styles.paragraph['Title'].para;

describe('a paragraph style’s rule line', () => {
  const rule = '<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="4F81BD"/></w:pBdr>';

  it('is read from the style, not only from direct formatting', () => {
    const para = imported(rule);
    expect(para.borderBottom).toBe('1pt solid #4F81BD');
    expect(para.borderTop).toBeUndefined();
    expect(para.borderPadding).toBe(4);
  });

  it('keeps no padding where it draws no rule', () => {
    expect(imported('').borderBottom).toBeUndefined();
    expect(imported('<w:pBdr><w:bottom w:val="nil"/></w:pBdr>').borderPadding).toBeUndefined();
  });

  it('round-trips through an ODF export as fo:border + fo:padding on that side', async () => {
    const res = importDocx(zipSync({ 'word/document.xml': strToU8(doc), 'word/styles.xml': strToU8(styles(rule)) }));
    const bytes = await buildOdt(
      res.content as N, { top: 2, bottom: 2, left: 2, right: 2 }, 'portrait',
      undefined, null, 'A4', res.styles,
    );
    const xml = strFromU8(unzipSync(bytes)['styles.xml']);
    expect(xml).toContain('fo:border-bottom="1pt solid #4F81BD"');
    expect(xml).toContain('fo:padding-bottom="4pt"');
    expect(xml).not.toContain('fo:padding-top');

    const back = importOdt(bytes).styles.paragraph['Title'].para;
    expect(back.borderBottom).toBe('1pt solid #4F81BD');
    expect(back.borderPadding).toBe(4);
  });

  it('starts where a hanging first line does, as LibreOffice draws it', () => {
    const hang = '<w:ind w:left="1134" w:hanging="567"/>';
    const sheet = importDocx(zipSync({ 'word/document.xml': strToU8(doc), 'word/styles.xml': strToU8(styles(rule + hang)) })).styles;
    const css = styleCss(sheet).split('\n\n').find((r) => r.includes('[data-style="Title"]'))!;
    expect(css).toContain('--box-hang: min(0px, var(--indent-first, 0px))');
    expect(css).toContain('margin-left: calc(var(--sec-inset-left, 0px) + var(--ind, 0px) + var(--box-hang, 0px))');
    // A unitless 0 in that calc() would void the whole padding shorthand, the rule's gap with it.
    expect(css).toContain('--pad-left: 0px');
    expect(css).toContain('padding: 0px 0px 4pt calc(var(--pad-left, 0px) - var(--box-hang, 0px))');
  });
});
