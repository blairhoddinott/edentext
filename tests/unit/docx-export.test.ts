import { describe, it, expect, beforeAll } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildDocx } from '../../src/lib/export/docx';
import { importDocx } from '../../src/lib/import/docx';
import { HEADER_SHADE } from '../../src/lib/editor/extensions/tableHeaderRow';

// 1×1 transparent PNG.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNwaDgAAAKEAYEml6crAAAAAElFTkSuQmCC';

const text = (t: string, marks?: any[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const para = (content: any, attrs: any = {}) => ({ type: 'paragraph', attrs, content: Array.isArray(content) ? content : [text(content)] });
const heading = (level: number, t: string, attrs: any = {}) => ({ type: 'heading', attrs: { level, ...attrs }, content: [text(t)] });
const li = (...content: any[]) => ({ type: 'listItem', content });
const cell = (t: string, attrs: any = {}) => ({ type: 'tableCell', attrs, content: [para(t)] });
const headerCell = (t: string, attrs: any = {}) => ({ type: 'tableHeader', attrs: { backgroundColor: HEADER_SHADE, ...attrs }, content: [para(t)] });

const fixture = {
  type: 'doc',
  content: [
    heading(1, 'Title', { textAlign: 'center' }),
    para(
      [
        text('plain '),
        text('bold', [{ type: 'bold' }]),
        text(' '),
        text('red', [{ type: 'textStyle', attrs: { color: '#FF0000' } }]),
        text(' '),
        text('hi', [{ type: 'highlight', attrs: { color: '#00FF00' } }]),
        text(' '),
        text('site', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
      ],
      { spaceBefore: 6, spaceAfter: 6, lineHeight: '1.5', indent: 1 },
    ),
    para([text('a\tb')]),
    para([text('line1'), { type: 'hardBreak' }, text('line2')]),
    { type: 'bulletList', attrs: { indent: 0, bulletChar: '❖' }, content: [
      li(para('one')),
      li(para('two'), { type: 'bulletList', content: [li(para('nested'))] }),
    ] },
    { type: 'orderedList', attrs: { listStyleType: 'lower-alpha' }, content: [li(para('alpha'))] },
    { type: 'orderedList', attrs: { listStyleType: 'multilevel' }, content: [
      li(para('legal'), { type: 'orderedList', content: [li(para('legal sub'))] }),
    ] },
    para([{ type: 'image', attrs: { src: PNG, width: 100, height: 80, wrap: 'left', alt: 'pic' } }]),
    para([{ type: 'textBox', attrs: { width: 288, height: 96, wrap: 'right', shapeKind: 'ellipse', fillColor: '#FFEE00', strokeColor: '#FF0000', strokeWidthPt: 2.25, rotation: 30 }, content: [para('box text')] }]),
    { type: 'table', content: [
      { type: 'tableRow', content: [headerCell('Name', { colwidth: [6] }), headerCell('Qty', { colwidth: [3] })] },
      { type: 'tableRow', attrs: { rowHeight: 40 }, content: [cell('Widget', { backgroundColor: '#FFFF00', rowspan: 2 }), cell('1')] },
      { type: 'tableRow', content: [cell('2')] },
    ] },
  ],
} as any;

const hf = {
  header: { type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: 'right' }, content: [text('My header')] }] },
  footer: { type: 'doc', content: [{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [text('Page '), { type: 'pageNumber' }, text(' of '), { type: 'pageCount' }] }] },
  pageCount: 1,
} as any;

describe('buildDocx', () => {
  let files: Record<string, Uint8Array>;
  let bytes: Uint8Array;
  let docXml: string;
  let names: string[];

  beforeAll(async () => {
    bytes = await buildDocx(fixture, { top: 2.54, bottom: 2.54, left: 2.12, right: 2.12 }, 'portrait', hf, { language: 'en', country: 'US' });
    files = unzipSync(bytes);
    names = Object.keys(files);
    docXml = strFromU8(files['word/document.xml']);
  });

  it('produces a valid zip (PK signature) with the core OOXML parts', () => {
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('word/document.xml');
    expect(names).toContain('word/numbering.xml');
    expect(names.some((n) => /^word\/media\/.*\.png$/.test(n))).toBe(true);
    expect(names.some((n) => /^word\/header\d*\.xml$/.test(n))).toBe(true);
    expect(names.some((n) => /^word\/footer\d*\.xml$/.test(n))).toBe(true);
  });

  it('emits well-formed XML in every part (Word rejects malformed XML)', () => {
    const parser = new DOMParser();
    for (const name of names.filter((n) => n.endsWith('.xml'))) {
      const doc = parser.parseFromString(strFromU8(files[name]), 'application/xml');
      expect(doc.getElementsByTagName('parsererror').length, `parse error in ${name}`).toBe(0);
    }
  });

  it('emits headings, alignment, spacing, indent and line spacing', () => {
    expect(docXml).toContain('w:pStyle w:val="Heading1"');
    expect(docXml).toContain('w:jc w:val="center"');
    expect(docXml).toContain('w:line="360"'); // 1.5 × 240
    expect(docXml).toMatch(/w:ind[^>]*w:left="567"/); // 1cm
  });

  it('emits run formatting: bold, color, highlight shading, hyperlink', () => {
    expect(docXml).toContain('<w:b/>');
    expect(docXml).toContain('w:color w:val="FF0000"');
    expect(docXml).toMatch(/w:shd[^>]*w:fill="00FF00"/); // highlight
    expect(docXml).toContain('<w:hyperlink');
  });

  it('emits tabs and hard breaks as elements', () => {
    expect(docXml).toContain('<w:tab/>');
    expect(docXml).toContain('<w:br/>');
  });

  it('emits numbered/bulleted paragraphs and a numbering definition', () => {
    expect(docXml).toContain('<w:numPr>');
    expect(docXml).toContain('<w:numId');
    const numXml = strFromU8(files['word/numbering.xml']);
    expect(numXml).toContain('w:val="bullet"');
    expect(numXml).toContain('w:val="lowerLetter"');
    // Custom bullet char → level 0 lvlText; nested default level keeps the cycle (◦)
    expect(numXml).toMatch(/w:lvlText[^>]*w:val="❖"/);
    expect(numXml).toMatch(/w:lvlText[^>]*w:val="◦"/);
    // Multilevel list → chained lvlText below level 0
    expect(numXml).toMatch(/w:lvlText[^>]*w:val="%1\.%2\."/);
  });

  it('emits a fixed-layout table with merged cells and shading', () => {
    expect(docXml).toContain('<w:tbl>');
    expect(docXml).toContain('<w:tblGrid>');
    expect(docXml).toContain('w:vMerge'); // rowspan
    expect(docXml).toMatch(/w:shd[^>]*w:fill="F2F2F2"/); // header shade
    expect(docXml).toMatch(/w:shd[^>]*w:fill="FFFF00"/); // custom cell fill
    expect(docXml).toMatch(/w:trHeight[^>]*w:val="600"/); // 40px → 600 twips
  });

  it('bakes bold onto header-row cells', () => {
    // The header cells carry no bold mark; bold must be baked into their runs.
    const tbl = docXml.slice(docXml.indexOf('<w:tbl>'));
    expect(tbl).toContain('<w:b/>');
  });

  it('embeds the image as a floating (wrapped) drawing', () => {
    expect(docXml).toContain('<w:drawing>');
    expect(docXml).toContain('wp:anchor'); // floating, not inline
  });

  it('rewrites the text-box marker into a DrawingML shape (post-pack pass)', () => {
    expect(docXml).toContain('<wps:wsp');
    expect(docXml).toContain('<wps:txbx><w:txbxContent>');
    expect(docXml).toContain('prst="ellipse"');
    expect(docXml).toMatch(/a:xfrm rot="1800000"/); // 30° × 60000
    expect(docXml).toMatch(/<wp:wrapSquare wrapText="left"\/>/); // box right ⇒ text left
    expect(docXml).not.toContain('\uE008'); // marker sentinel fully consumed
  });

  it('writes page geometry with header/footer distances', () => {
    expect(docXml).toMatch(/<w:pgSz[^>]*w:w="11906"[^>]*w:h="16838"/);
    expect(docXml).toMatch(/<w:pgMar[^>]*w:header="/);
  });

  it('puts page-number / page-count fields in the footer', () => {
    const footerName = names.find((n) => /^word\/footer\d*\.xml$/.test(n))!;
    const footerXml = strFromU8(files[footerName]);
    expect(footerXml).toContain('PAGE');
    expect(footerXml).toContain('NUMPAGES');
  });
});

// Formulas walk their own namespace beside the w:r runs; the docx library has no OMML,
// so they ride a sentinel run that a post-pack pass swaps out.
describe('DOCX formulas', () => {
  const formula = (latex: string, display = false) => ({ type: 'formula', attrs: { latex, display } });

  it('writes OMML for an inline formula and oMathPara for a display one', async () => {
    const files = unzipSync(await buildDocx({ type: 'doc', content: [
      para([text('Es gilt '), formula('E=mc^{2}'), text(' immer.')]),
      para([formula('\\frac{a}{b}', true)]),
    ] } as any));
    const xml = strFromU8(files['word/document.xml']);
    for (const el of ['<m:oMath', '<m:sSup>', '<m:oMathPara', '<m:f>', 'Es gilt ']) expect(xml).toContain(el);
    // The sentinel run must be gone, not merely wrapped.
    expect(xml).not.toContain('\uE012');
  });

  it('round-trips both through import', async () => {
    const res = importDocx(await buildDocx({ type: 'doc', content: [
      para([text('x '), formula('\\sum_{i=1}^{n} x_{i}')]),
      para([formula('\\sqrt{a+b}', true)]),
    ] } as any));
    const found: any[] = [];
    (function walk(n: any) { if (n.type === 'formula') found.push(n); for (const c of n.content ?? []) walk(c); })(res.content);
    expect(found.map((f) => [f.attrs.latex, f.attrs.display])).toEqual([['\\sum_{i=1}^{n} x_{i}', false], ['\\sqrt{a+b}', true]]);
  });

  // A math paragraph stands at its m:jc, not at w:jc; the editor at its paragraph's alignment.
  it('keeps a display formula at its paragraph alignment', async () => {
    const aligns = [undefined, 'center', 'right'];
    const bytes = await buildDocx({ type: 'doc', content: aligns.map((a) => para([formula('x', true)], a ? { textAlign: a } : {})) } as any);
    const files = unzipSync(bytes);
    const blocks = (res: any) => res.content.content.filter((n: any) => n.content?.[0]?.type === 'formula').map((n: any) => n.attrs?.textAlign ?? null);
    expect(blocks(importDocx(bytes))).toEqual([null, 'center', 'right']);
    // Without its own m:jc the document's m:defJc decides.
    const doc = strFromU8(files['word/document.xml']).replace(/<m:oMathParaPr>.*?<\/m:oMathParaPr>/g, '');
    const settings = strFromU8(files['word/settings.xml']).replace(/(<w:settings\b[^>]*>)/,
      '$1<m:mathPr xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:defJc m:val="right"/></m:mathPr>');
    const { zipSync, strToU8 } = await import('fflate');
    const res = importDocx(zipSync({ ...files, 'word/document.xml': strToU8(doc), 'word/settings.xml': strToU8(settings) }));
    expect(blocks(res)).toEqual(['right', 'right', 'right']);
  });
});
