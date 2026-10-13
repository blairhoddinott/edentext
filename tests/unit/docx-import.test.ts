// DOCX import of paragraphs, runs, styles and sections, each read through importDocx.
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { getSchema } from '@tiptap/core';
import { extensions } from '../../src/lib/editor/extensions';
import { importDocx } from '../../src/lib/import/docx';
import { importOdt } from '../../src/lib/import/odt';
import { buildOdt } from '../../src/lib/export/odt';
import { buildDocx } from '../../src/lib/export/docx';
import { DocxStyles } from '../../src/lib/import/docxStyles';
import { builtinStyleSheet } from '../../src/lib/styles/styleSheet';
import { outlineCss, outlineLabel } from '../../src/lib/styles/outlineNumbering';
import { formatOrdinal } from '../../src/lib/utils/orderedListTypes';
import { docxOf, firstBlock, blocksOf, W_NS } from '../docxFixture';

type N = any;

const para = (text: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const runText = (p: N) => (p.content as N[]).map((n) => n.text).join('');
const marksOf = (p: N): N[] => p.content?.[0]?.marks ?? [];

// w:spacing in lines: a nonzero line count wins over the twips, a line being 12pt.
describe('paragraph spacing', () => {
  it.each([
    ['lets a nonzero line count win over the twips', 'w:before="0" w:beforeLines="50" w:after="0" w:afterLines="100"', { spaceBefore: 6, spaceAfter: 12 }],
    ['keeps the twips beside a zero line count', 'w:after="160" w:afterLines="0"', { spaceBefore: undefined, spaceAfter: 8 }],
  ])('%s', (_name, attrs, want) => {
    const { spaceBefore, spaceAfter } = firstBlock(para('x', `<w:spacing ${attrs}/>`)).attrs ?? {};
    expect({ spaceBefore, spaceAfter }).toEqual(want);
  });
});

// The highlighter pen is w:highlight (a palette name), not the w:shd hex fill.
describe('w:highlight', () => {
  const run = (rPr: string, styles?: string) => marksOf(firstBlock(`<w:p><w:r><w:rPr>${rPr}</w:rPr><w:t>x</w:t></w:r></w:p>`, { styles }))
    .filter((m) => m.type === 'highlight');
  it('resolves a palette name to its hex', () => {
    expect(run('<w:highlight w:val="yellow"/>')).toEqual([{ type: 'highlight', attrs: { color: '#FFFF00' } }]);
  });
  it("lets a run's w:highlight none cancel the character style's pen", () => {
    const styles = '<w:style w:type="character" w:styleId="Pen"><w:name w:val="Pen"/><w:rPr><w:highlight w:val="green"/></w:rPr></w:style>';
    expect(run('<w:rStyle w:val="Pen"/>', styles)).toHaveLength(1);
    expect(run('<w:rStyle w:val="Pen"/><w:highlight w:val="none"/>', styles)).toEqual([]);
  });
  it('ignores an unknown name rather than inventing a colour', () => {
    expect(run('<w:highlight w:val="chartreuse"/>')).toEqual([]);
  });
});

// Two hyphens are elements rather than characters; dropping them loses a character the
// line is measured with.
describe('hyphen elements', () => {
  it.each([
    ['w:noBreakHyphen', '<w:noBreakHyphen/>', 'text‑only'],
    ['w:softHyphen', '<w:softHyphen/>', 'text­only'],
  ])('reads %s', (_name, el, want) => {
    expect(runText(firstBlock(`<w:p><w:r><w:t>text</w:t>${el}<w:t>only</w:t></w:r></w:p>`))).toBe(want);
  });
});

// A paragraph mark larger or smaller than the runs it ends sets neither their size nor
// the block's line height: LibreOffice sets a line with text by its runs alone.
describe('a paragraph mark whose runs agree on another size', () => {
  const sized = (mark: number, run: number | null) =>
    `<w:p><w:pPr><w:rPr><w:sz w:val="${mark}"/></w:rPr></w:pPr>`
    + `<w:r>${run ? `<w:rPr><w:sz w:val="${run}"/></w:rPr>` : ''}<w:t>text</w:t></w:r></w:p>`;
  it('takes the runs size', () => {
    expect(firstBlock(sized(28, 26)).attrs?.fontSize).toBe('13pt');
  });
  it('keeps the style size where the runs state none', () => {
    const p = firstBlock(sized(56, null));
    expect(p.attrs?.fontSize ?? null).toBeNull();
    expect(marksOf(p).find((m) => m.type === 'textStyle')?.attrs?.fontSize ?? null).toBeNull();
  });
  it('still sets an empty paragraph', () => {
    expect(firstBlock('<w:p><w:pPr><w:rPr><w:sz w:val="28"/></w:rPr></w:pPr></w:p>').attrs?.fontSize).toBe('14pt');
  });
});

// The VML horizontal line (o:hr) in a paragraph of its own becomes that paragraph's
// bottom rule instead of a dropped shape.
describe('horizontal line', () => {
  const HR = '<w:p><w:r><w:pict><v:rect id="_x0000_i1025" style="width:0;height:1.5pt"'
    + ' o:hralign="center" o:hr="t" fillcolor="#a0a0a0" stroked="f"/></w:pict></w:r></w:p>';
  it('becomes the paragraph bottom rule, with no warning', () => {
    const res = importDocx(docxOf(`${para('Text')}${HR}`));
    expect((res.content as N).content[1].attrs.borderBottom).toBe('1.5pt solid #A0A0A0');
    expect([...res.warnings]).not.toContain('Drawings were removed');
  });
  it('leaves a real w:pBdr bottom border alone', () => {
    const bdr = '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="24" w:color="FF0000"/></w:pBdr></w:pPr>';
    expect(firstBlock(HR.replace('<w:r>', `${bdr}<w:r>`)).attrs.borderBottom).toBe('3pt solid #FF0000');
  });
});

// Toggles are ST_OnOff: w:val="false"/"0"/"off" turns an element off.
describe('on/off toggles', () => {
  const build = (setting: string) => importDocx(docxOf(
    `${para('Body')}<w:sectPr><w:headerReference w:type="default" r:id="rH"/><w:titlePg w:val="false"/></w:sectPr>`,
    {
      settings: setting,
      files: {
        'word/_rels/document.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>',
        'word/header1.xml': `<?xml version="1.0"?><w:hdr xmlns:w="${W_NS}"><w:p><w:r><w:t>Running head</w:t></w:r></w:p></w:hdr>`,
      },
    }));
  it('reads an explicit false as off', () => {
    const r = build('<w:evenAndOddHeaders w:val="false"/>');
    expect(r.header).not.toBeNull();
    expect(r.differentOddEven).toBe(false);
    expect(r.differentFirstPage).toBe(false);
  });
  it('still reads a bare element as on', () => {
    expect(build('<w:evenAndOddHeaders/>').differentOddEven).toBe(true);
  });
});

// The w:default="1" paragraph style carries the real body font, while docDefaults may
// still name another.
describe('DocxStyles.paragraphRun', () => {
  const parse = (inner: string) => new DOMParser().parseFromString(`<w:styles xmlns:w="${W_NS}">${inner}</w:styles>`, 'application/xml');
  const TNR = '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr></w:rPrDefault></w:docDefaults>';
  const styles = new DocxStyles(parse(TNR
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Standard"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Listenabsatz"><w:name w:val="List Paragraph"/><w:basedOn w:val="Standard"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr></w:style>'), null);
  it('applies the default paragraph style to a paragraph with no w:pStyle', () => {
    expect(styles.paragraphRun(null)).toMatchObject({ font: 'Arial', sizeHalfPt: 22 });
  });
  it('resolves a pStyle through its basedOn chain to the default style', () => {
    expect(styles.paragraphRun('Listenabsatz')).toMatchObject({ font: 'Arial', sizeHalfPt: 22 });
  });
  it("lets a pStyle's own font win over the default style", () => {
    expect(styles.paragraphRun('Quote').font).toBe('Georgia');
  });
  it('falls back to docDefaults when there is no default paragraph style', () => {
    expect(new DocxStyles(parse(TNR), null).paragraphRun(null).font).toBe('Times New Roman');
  });
  it('has empty spacing when no layer sets it', () => {
    expect(styles.paragraphSpacing(null)).toEqual({});
  });
  it("reads docDefaults spacing and a style's override of it", () => {
    const s = new DocxStyles(parse('<w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="NoSpacing"><w:name w:val="No Spacing"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>'), null);
    expect(s.paragraphSpacing(null)).toMatchObject({ after: 160, line: 259 });
    expect(s.paragraphSpacing('NoSpacing')).toMatchObject({ after: 0, line: 240 });
  });
});

// What a paragraph style chain sets must arrive and survive both formats: a style's
// first-line offset, a page break inherited through w:basedOn (a direct w:val="0" turns it
// off), and a direct w:ind w:left="0" that beats the style's indent.
describe('the paragraph style chain', () => {
  const NORMAL = '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>';
  const style = (id: string, base: string, pPr = '') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="${base}"/>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}</w:style>`;
  const styled = (id: string, pPr = '') => para('x', `<w:pStyle w:val="${id}"/>${pPr}`);
  const attr = (key: string) => (r: N) => r.content.content.map((b: N) => b.attrs?.[key] ?? null);
  it.each([
    ['a first-line offset, a derived style inheriting it',
      style('Hang', 'Normal', '<w:ind w:left="850" w:hanging="680"/>') + style('Hang2', 'Hang', '<w:ind w:left="1191"/>') + style('First', 'Normal', '<w:ind w:firstLine="567"/>'),
      styled('Hang') + styled('Hang2') + styled('First'),
      (r: N) => ['Hang', 'Hang2', 'First'].map((n) => r.styles.paragraph[n]?.para?.indentFirst), [-1.2, undefined, 1]],
    ['a page break before from the chain',
      style('Base', 'Normal', '<w:pageBreakBefore/>') + style('Chapter', 'Base'),
      para('lead') + styled('Chapter') + styled('Chapter', '<w:pageBreakBefore w:val="0"/>'),
      attr('breakBefore'), [null, 'page', null]],
    ['a direct zero left indent over a style that indents',
      style('Deep', 'Normal', '<w:ind w:left="1948"/>'),
      styled('Deep', '<w:ind w:left="0"/>') + styled('Deep'),
      attr('indent'), [0, null]],
  ])('%s', async (_name, styles, body, pick, want) => {
    const imported = importDocx(docxOf(body, { styles: NORMAL + styles }));
    expect(pick(imported)).toEqual(want);
    const docx = await buildDocx(imported.content as N, undefined, 'portrait', undefined, null, 'A4', imported.styles);
    const odt = await buildOdt(imported.content as N, undefined, 'portrait', undefined, null, 'A4', imported.styles);
    expect(pick(importDocx(docx)), 'DOCX').toEqual(want);
    expect(pick(importOdt(odt)), 'ODT').toEqual(want);
  });
});

// A style's w:numId and w:ilvl inherit along w:basedOn one by one; a level left open is
// the one whose w:pStyle names the style.
describe("a paragraph style's numbering", () => {
  const parse = (x: string) => new DOMParser().parseFromString(x, 'application/xml');
  const lvl = (i: number, ps = '') => `<w:lvl w:ilvl="${i}"><w:numFmt w:val="decimal"/>${ps ? `<w:pStyle w:val="${ps}"/>` : ''}</w:lvl>`;
  const s = new DocxStyles(parse(`<w:styles xmlns:w="${W_NS}">
    <w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:numPr><w:ilvl w:val="3"/></w:numPr></w:pPr></w:style>
    <w:style w:type="paragraph" w:styleId="H4"><w:basedOn w:val="Base"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
    <w:style w:type="paragraph" w:styleId="Linked"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
    <w:style w:type="paragraph" w:styleId="Plain"><w:basedOn w:val="Base"/></w:style></w:styles>`),
  parse(`<w:numbering xmlns:w="${W_NS}"><w:abstractNum w:abstractNumId="0">${lvl(0)}${lvl(1)}${lvl(2, 'Linked')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`));
  it.each([
    ['takes the numId and the level from different styles of the chain', 'H4', { numId: 1, ilvl: 3 }],
    ['takes an open level from the level that names the style', 'Linked', { numId: 1, ilvl: 2 }],
    ['is none without a numId anywhere in the chain', 'Plain', null],
  ])('%s', (_name, id, want) => {
    expect(s.styleNumPr(id)).toEqual(want);
  });
});

// Chapter numbering stated on the heading style and again on every heading paragraph.
describe('a heading that states its numbering on itself', () => {
  const NUMPR = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
  const docx = (styleNum: boolean, body = `<w:p><w:pPr><w:pStyle w:val="2"/>${NUMPR}</w:pPr><w:r><w:t>chapter</w:t></w:r></w:p>`) => docxOf(`${body}<w:sectPr/>`, {
    styles: `<w:style w:type="paragraph" w:default="1" w:styleId="1"><w:name w:val="Normal"/></w:style>
      <w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/>${styleNum ? NUMPR : ''}</w:pPr></w:style>`,
    numbering: `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/>
      <w:numFmt w:val="chineseCountingThousand"/><w:lvlText w:val="%1、"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
  });
  const schema = getSchema(extensions);
  it('stays a heading and opens', () => {
    const { content } = importDocx(docx(true));
    expect(() => schema.nodeFromJSON(content).check()).not.toThrow();
    expect(content.content?.[0].type).toBe('heading');
  });
  it('stays a heading inside a table cell', () => {
    const { content } = importDocx(docx(true, `<w:tbl><w:tr><w:tc><w:p><w:pPr><w:pStyle w:val="2"/>${NUMPR}</w:pPr><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`));
    expect(() => schema.nodeFromJSON(content).check()).not.toThrow();
    expect(JSON.stringify(content)).not.toContain('orderedList');
  });
  it('keeps the CJK chapter numbering', () => {
    const outline = importDocx(docx(true)).styles?.outline;
    expect(outline?.[0]).toMatchObject({ format: '一, 二, 三, ...', suffix: '、' });
    expect(outlineLabel(outline, 1, [2], formatOrdinal)).toBe('二、');
    expect(outlineCss(outline)).toContain('simp-chinese-informal');
  });
  it('numbers chapters from the paragraph where the style carries none', () => {
    expect(importDocx(docx(false)).styles?.outline?.[0].format).toBe('一, 二, 三, ...');
  });
  it('carries the CJK chapter numbering through both formats', async () => {
    const sheet = { ...builtinStyleSheet(), outline: importDocx(docx(true)).styles!.outline };
    const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'chapter' }] }] };
    const margins = { top: 2, bottom: 2, left: 2, right: 2 };
    const odt = await buildOdt(doc as never, margins as never, 'portrait', undefined, null, 'A4', sheet);
    expect(strFromU8(unzipSync(odt)['styles.xml'])).toContain('style:num-format="一, 二, 三, ..."');
    expect(importOdt(odt).styles?.outline?.[0].format).toBe('一, 二, 三, ...');
    const back = await buildDocx(doc as never, margins as never, 'portrait', undefined, null, 'A4', sheet);
    expect(importDocx(back).styles?.outline?.[0]).toMatchObject({ format: '一, 二, 三, ...', suffix: '、' });
  });
});

// The section marker is ordinal: the blocks carrying `sectionBreak` index the
// header/footer sets, so a section opening with a table or an index must still carry one.
describe('section markers', () => {
  const table = (text: string) => `<w:tbl><w:tr><w:tc><w:tcPr><w:tcW w:w="5000" w:type="dxa"/></w:tcPr>${para(text)}</w:tc></w:tr></w:tbl>`;
  const sect = (orient: 'portrait' | 'landscape') => orient === 'landscape'
    ? '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr>'
    : '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
  const ends = (orient: 'portrait' | 'landscape') => `<w:p><w:pPr>${sect(orient)}</w:pPr></w:p>`;
  const END = '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  const index = () => '<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>'
    + '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText xml:space="preserve">TOC \\o "1-3"</w:instrText><w:fldChar w:fldCharType="separate"/></w:r></w:p>'
    + `${END}</w:sdtContent></w:sdt>`;
  // Word may put the sectPr on the index's own last paragraph, inside the control.
  const indexEnding = (orient: 'portrait' | 'landscape') => index().replace(END, `<w:p><w:pPr>${sect(orient)}</w:pPr><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`);
  const build = (body: string) => importDocx(docxOf(body + sect('portrait'))) as N;
  const marks = (r: N): N[] => r.content.content.filter((b: N) => b.attrs?.sectionBreak === true);

  it('keeps the marker count and the header/footer sets aligned', () => {
    const r = build(para('one') + ends('portrait') + para('two') + ends('portrait')
      + table('three') + ends('portrait') + para('four') + ends('landscape') + para('five'));
    expect(marks(r)).toHaveLength(4);
    expect(r.hfSections).toHaveLength(5);
    expect(r.hfSections?.[3].orientation).toBe('landscape');
    // Null where the section is on the document's own paper.
    expect(r.hfSections?.[2].orientation).toBeNull();
  });
  it('marks a table that opens a section, and breaks the page in front of it', () => {
    const r = build(para('one') + ends('portrait') + table('two') + para('two tail') + ends('landscape') + para('three'));
    const [marked] = marks(r);
    expect(marked.type).toBe('table');
    expect(marked.attrs.breakBefore).toBe('page');
    expect(marks(r)).toHaveLength(2);
    expect(r.hfSections).toHaveLength(3);
    expect(r.hfSections?.[1].orientation).toBe('landscape');
  });
  it('marks an index that opens a section', () => {
    const r = build(para('one') + ends('portrait') + index() + para('after the index') + ends('landscape') + para('three'));
    const [marked] = marks(r);
    expect(marked.type).toBe('tableOfContents');
    expect(marked.attrs.breakBefore).toBe('page');
    expect(r.hfSections).toHaveLength(3);
    expect(r.hfSections?.[1].orientation).toBe('landscape');
  });
  it('ends a section on the sectPr the index carries', () => {
    const r = build(para('one') + ends('portrait') + indexEnding('portrait') + para('after the index') + ends('landscape') + para('three'));
    const [first, second] = marks(r);
    expect(first.type).toBe('tableOfContents');
    expect(second.content?.[0]?.text).toBe('after the index');
    expect(second.attrs.breakBefore).toBe('page');
    expect(r.hfSections).toHaveLength(4);
    expect(r.hfSections?.[2].orientation).toBe('landscape');
  });
  it('never marks a block that is not the section’s first', () => {
    const blocks = blocksOf(para('one') + ends('portrait') + table('two') + para('two tail') + ends('landscape') + para('three') + sect('portrait'));
    expect(blocks.find((b: N) => b.attrs?.sectionBreak && b.type === 'paragraph' && b.content?.[0]?.text === 'two tail')).toBeUndefined();
  });
});

describe('comment ranges inside a wrapper', () => {
  const comments = `<?xml version="1.0"?><w:comments xmlns:w="${W_NS}">`
    + [1, 2].map((id) => `<w:comment w:id="${id}" w:author="A"><w:p><w:r><w:t>c${id}</w:t></w:r></w:p></w:comment>`).join('')
    + '</w:comments>';
  const run = (t: string) => `<w:r><w:t>${t}</w:t></w:r>`;
  const wrap = (tag: string, inner: string) => `<w:${tag} w:id="9" w:author="A">${inner}</w:${tag.split(' ')[0]}>`;
  const commentOn = (nodes: N[], out: Record<string, string> = {}) => {
    for (const n of nodes) {
      const id = n.marks?.find((m: N) => m.type === 'comment')?.attrs.id ?? '';
      for (const ch of n.text ?? '') out[ch] = id;
      commentOn(n.content ?? [], out);
    }
    return out;
  };
  const later = `<w:p><w:commentRangeStart w:id="2"/>${run('f')}<w:commentRangeEnd w:id="2"/>${run('g')}</w:p>`;
  const got = (body: string) => commentOn(blocksOf(body + later, { files: { 'word/comments.xml': comments } }));
  // A field collapsed to one node drops b..e; the ranges inside it still open and close.
  it.each([
    ['ins'], ['del'], ['moveFrom'], ['moveTo'], ['hyperlink'], ['smartTag'], ['fldSimple w:instr=" AUTHOR "'],
    ['fldSimple w:instr=" SEQ Figure "', { a: '', x: 'w1', f: 'w2', g: '' }],
  ])('a range opening or closing inside w:%s still brackets its text', (tag, want = { a: '', b: '', c: 'w1', x: 'w1', d: 'w1', e: '', f: 'w2', g: '' }) => {
    const body = `<w:p>${run('a')}${wrap(tag, `${run('b')}<w:commentRangeStart w:id="1"/>${run('c')}`)}${run('x')}`
      + `${wrap(tag, `${run('d')}<w:commentRangeEnd w:id="1"/>${run('e')}`)}</w:p>`;
    expect(got(body)).toEqual(want);
  });
  it('a range opening and closing beside table rows and cells brackets the cells between', () => {
    const cell = (t: string) => `<w:tc><w:p>${run(t)}</w:p></w:tc>`;
    const body = `<w:p>${run('a')}</w:p><w:tbl><w:tr>${cell('b')}<w:commentRangeStart w:id="1"/>${cell('c')}</w:tr>`
      + `<w:tr>${cell('d')}</w:tr><w:commentRangeEnd w:id="1"/><w:tr>${cell('e')}</w:tr></w:tbl>`;
    expect(got(body)).toEqual({ a: '', b: '', c: 'w1', d: 'w1', e: '', f: 'w2', g: '' });
  });
});
