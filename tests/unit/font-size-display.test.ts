import { describe, it, expect } from 'vitest';
import { blockFontSize, DEFAULT_FONT_SIZE } from '../../src/lib/utils/fontSize';
import { builtinStyleSheet, resolveStyle } from '../../src/lib/styles/styleSheet';
import { importDocx } from '../../src/lib/import/docx';
import { importOdt } from '../../src/lib/import/odt';
import { buildDocx } from '../../src/lib/export/docx';
import { buildOdt } from '../../src/lib/export/odt';

// The toolbar's size box shows blockFontSize() for text without its own size mark, while
// the page renders the block's named style — the two must not drift apart.
describe('toolbar font size vs. rendered font size', () => {
  const sheet = builtinStyleSheet();

  it('shows the paragraph-mark size, else the block style default', () => {
    const para = { type: { name: 'paragraph' }, attrs: {} };
    expect(blockFontSize(para)).toBe(DEFAULT_FONT_SIZE);
    expect(blockFontSize({ ...para, attrs: { fontSize: '22pt' } })).toBe('22pt');
    expect(blockFontSize(null)).toBe(DEFAULT_FONT_SIZE);
  });

  it('reads a heading from its style, by name or by level', () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const expected = `${resolveStyle(sheet, `Heading ${level}`).text.fontSizePt}pt`;
      expect(blockFontSize({ type: { name: 'heading' }, attrs: { level } })).toBe(expected);
      expect(blockFontSize({ type: { name: 'paragraph' }, attrs: { styleName: `Heading ${level}` } })).toBe(expected);
    }
    // An explicit paragraph-mark size beats the style (direct formatting wins).
    expect(blockFontSize({ type: { name: 'heading' }, attrs: { level: 1, fontSize: '9pt' } })).toBe('9pt');
  });
});

// The block's size renders its unmarked text; a saved file has to give that text the size
// too, since a run without its own takes the style's — in a cell, where no paragraph style
// carries it, as much as in the body.
describe("a block's own size on its unmarked text", () => {
  const block = (type: string) => ({ type, attrs: { level: 3, fontSize: '9pt' }, content: [{ type: 'text', text: 'x' }] });
  const cell = (b: unknown) => ({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [b] }] }] });
  const rendered = (doc: any): string | undefined => {
    const find = (n: any): any => n.content?.[0]?.type === 'text' ? n : (n.content ?? []).map(find).find(Boolean);
    const b = find(doc);
    return b.content[0].marks?.find((m: any) => m.type === 'textStyle')?.attrs?.fontSize ?? b.attrs?.fontSize;
  };
  const margins = { top: 2, bottom: 2, left: 2, right: 2 };
  it.each([
    ['a body paragraph', block('paragraph')], ['a cell paragraph', cell(block('paragraph'))], ['a cell heading', cell(block('heading'))],
  ])('survives DOCX and ODT for %s', async (_name, node) => {
    const doc = { type: 'doc', content: [node] } as any;
    const sheet = builtinStyleSheet();
    expect(rendered(importDocx(await buildDocx(doc, margins as any, 'portrait', undefined, null, 'A4', sheet)).content)).toBe('9pt');
    expect(rendered(importOdt(await buildOdt(doc, margins as any, 'portrait', undefined, null, 'A4', sheet)).content)).toBe('9pt');
  });
});
