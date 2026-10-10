// Word's in-front-of / behind-text (wp:wrapNone + behindDoc) and ODF's run-through:
// the text runs over or under the frame, so it reserves neither width nor height.
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { buildOdt } from '../../src/lib/export/odt';
import { buildDocx } from '../../src/lib/export/docx';
import { importOdt } from '../../src/lib/import/odt';
import { importDocx } from '../../src/lib/import/docx';
import { droppedFrameAttrs, restackFrame, stackZ } from '../../src/lib/editor/extensions/image';
import { getSchema } from '@tiptap/core';
import { EditorState, NodeSelection } from '@tiptap/pm/state';
import { zoneExtensions } from '../../src/lib/editor/extensions';

type N = any;

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNwaDgAAAKEAYEml6crAAAAAElFTkSuQmCC';
const IMG = (attrs: N): N => ({ type: 'image', attrs: { src: PNG, width: 200, height: 120, ...attrs } });

const docWith = (attrs: N): N => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [IMG(attrs), { type: 'text', text: 'anchor text' }] }],
});

const frame = (d: N) => d.content[0].content.find((n: N) => n.type === 'image');
const margins = { top: 2, bottom: 2, left: 2, right: 2 };

describe('a run-through frame', () => {
  it('round-trips the mode and its z-order through ODF', async () => {
    const front = frame((await importOdt(await buildOdt(docWith({ wrap: 'through', inFront: true }), margins, 'portrait'))).content);
    expect(front.attrs.wrap).toBe('through');
    expect(front.attrs.inFront).toBe(true);
    const behind = frame((await importOdt(await buildOdt(docWith({ wrap: 'through' }), margins, 'portrait'))).content);
    expect(behind.attrs.wrap).toBe('through');
    expect(behind.attrs.inFront).not.toBe(true);
  });

  it('round-trips the mode and its z-order through DOCX', async () => {
    const front = frame(importDocx(await buildDocx(docWith({ wrap: 'through', inFront: true }), margins, 'portrait')).content);
    expect(front.attrs.wrap).toBe('through');
    expect(front.attrs.inFront).toBe(true);
    const behind = frame(importDocx(await buildDocx(docWith({ wrap: 'through' }), margins, 'portrait')).content);
    expect(behind.attrs.wrap).toBe('through');
    expect(behind.attrs.inFront).toBe(false);
  });

  it('keeps its offsets, which place it against the anchor rather than reserve space', async () => {
    const img = frame((await importOdt(await buildOdt(docWith({ wrap: 'through', wrapOffset: 1.5, wrapOffsetY: 4.25 }), margins, 'portrait'))).content);
    expect(img.attrs.wrapOffset).toBeCloseTo(1.5, 2);
    expect(img.attrs.wrapOffsetY).toBeCloseTo(4.25, 2);
  });

  // ODF's `none` is the one that means above-and-below; only run-through reserves nothing.
  it('is not what ODF style:wrap="none" means', async () => {
    const img = frame((await importOdt(await buildOdt(docWith({ wrap: 'topBottom' }), margins, 'portrait'))).content);
    expect(img.attrs.wrap).toBe('topBottom');
  });
});

// Picking a mode by hand is "put it there": the offsets go, and so do the coordinate
// systems they were measured in — a page-placed frame set to a side wrap would
// otherwise export as vertical-rel="page" with an offset that now counts from a paragraph.
// LibreOffice reads an absent style:run-through by the frame's style chain (probed).
describe('a run-through text box that names no side of the text', () => {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
    + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
    + 'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';
  const inFront = (parent: string) => {
    const styles = `<?xml version="1.0"?><office:document-styles ${NS}><office:styles>
      <style:style style:name="Frame" style:family="graphic"><style:graphic-properties style:wrap="none"/></style:style>
    </office:styles></office:document-styles>`;
    const content = `<?xml version="1.0"?><office:document-content ${NS}><office:automatic-styles>
      <style:style style:name="fr1" style:family="graphic"${parent}><style:graphic-properties style:wrap="run-through"/></style:style>
    </office:automatic-styles><office:body><office:text><text:p><draw:frame draw:style-name="fr1" text:anchor-type="paragraph"
      svg:width="3cm" svg:height="2cm"><draw:text-box><text:p>box</text:p></draw:text-box></draw:frame>text</text:p></office:text></office:body></office:document-content>`;
    const doc = importOdt(zipSync({ 'content.xml': strToU8(content), 'styles.xml': strToU8(styles) })).content;
    const box = (doc.content[0].content as N[]).find((n: N) => n.type === 'textBox');
    return box.attrs.wrap === 'through' && box.attrs.inFront === true;
  };

  it('sits in front under a common style and behind on a lone automatic one', () => {
    expect(inFront(' style:parent-style-name="Frame"')).toBe(true);
    expect(inFront('')).toBe(false);
  });

  it('stays behind the text through our own ODT, which names the Frame parent', async () => {
    const box: N = { type: 'textBox', attrs: { width: 120, height: 80, wrap: 'through' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'box' }] }] };
    const doc: N = { type: 'doc', content: [{ type: 'paragraph', content: [box, { type: 'text', text: 'anchor' }] }] };
    const back = (importOdt(await buildOdt(doc, margins, 'portrait')).content.content[0].content as N[]).find((n: N) => n.type === 'textBox');
    expect(back.attrs.wrap).toBe('through');
    expect(back.attrs.inFront).not.toBe(true);
  });

  // LibreOffice paints its surroundings' background into a text frame without a fill under
  // a common style, hiding the text it runs over; draw:opacity or a lone automatic style
  // lets it show (probed).
  const fill = (props: string, parent = ' style:parent-style-name="Frame"') => {
    const styles = `<?xml version="1.0"?><office:document-styles ${NS}><office:styles>
      <style:style style:name="Frame" style:family="graphic"><style:graphic-properties style:wrap="none"/></style:style>
    </office:styles></office:document-styles>`;
    const content = `<?xml version="1.0"?><office:document-content ${NS} xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"><office:automatic-styles>
      <style:style style:name="fr1" style:family="graphic"${parent}><style:graphic-properties style:wrap="run-through" ${props}/></style:style>
    </office:automatic-styles><office:body><office:text><text:p><draw:frame draw:style-name="fr1" text:anchor-type="paragraph"
      svg:width="3cm" svg:height="2cm"><draw:text-box><text:p>box</text:p></draw:text-box></draw:frame>text</text:p></office:text></office:body></office:document-content>`;
    const doc = importOdt(zipSync({ 'content.xml': strToU8(content), 'styles.xml': strToU8(styles) })).content;
    return (doc.content[0].content as N[]).find((n: N) => n.type === 'textBox').attrs.fillColor;
  };

  it('covers the text without a fill under a common style, and shows it otherwise', async () => {
    expect(fill('draw:fill="none" fo:background-color="transparent"')).toBeUndefined();
    expect(fill('draw:fill="none" fo:background-color="transparent" draw:opacity="0%"')).toBeNull();
    expect(fill('draw:fill="none" fo:background-color="transparent"', '')).toBeNull();
    const box: N = { type: 'textBox', attrs: { width: 120, height: 80, wrap: 'through', inFront: true, fillColor: null }, content: [{ type: 'paragraph' }] };
    const doc: N = { type: 'doc', content: [{ type: 'paragraph', content: [box, { type: 'text', text: 'anchor' }] }] };
    const back = (importOdt(await buildOdt(doc, margins, 'portrait')).content.content[0].content as N[]).find((n: N) => n.type === 'textBox');
    expect(back.attrs.fillColor).toBeNull();
  });
});

describe('picking a wrap mode by hand', () => {
  it('drops the offsets and the frame of reference they belonged to', () => {
    const dropped = droppedFrameAttrs('left', false, 'through');
    expect(dropped).toMatchObject({ wrapOffset: null, wrapOffsetY: null, wrapFromPage: false, anchorPage: null });
  });

  it('keeps inFront for run-through alone', () => {
    expect(droppedFrameAttrs('through', true, 'left').inFront).toBe(true);
    expect(droppedFrameAttrs('through', false, 'inline').inFront).toBe(false);
    expect(droppedFrameAttrs('topBottom', true, 'through').inFront).toBe(false);
  });

  it('keeps the place between behind and in front of the text, one mode', () => {
    expect(droppedFrameAttrs('through', true, 'through')).toEqual({ inFront: true });
  });
});

describe('the order of free frames', () => {
  const schema = getSchema(zoneExtensions());
  // Three pictures behind the text, then one in front; the second is selected.
  const start = (): EditorState => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        IMG({ wrap: 'through' }), IMG({ wrap: 'through' }), IMG({ wrap: 'through' }), IMG({ wrap: 'through', inFront: true }),
      ] }],
    });
    return EditorState.create({ doc, selection: NodeSelection.create(doc, 2) });
  };
  const ranks = (s: EditorState) => s.doc.firstChild!.content.content.map((n) => n.attrs.zIndex);
  const run = (s: EditorState, to: 'forward' | 'backward' | 'front' | 'back') => {
    let out = s;
    const ok = restackFrame(s, (tr) => (out = s.apply(tr)), to);
    return { ok, ranks: ranks(out) };
  };

  it('moves one step or to the end among those on its side of the text', () => {
    expect(run(start(), 'forward')).toEqual({ ok: true, ranks: [0, 2, 1, 3] });
    expect(run(start(), 'backward')).toEqual({ ok: true, ranks: [1, 0, 2, 3] });
    expect(run(start(), 'front')).toEqual({ ok: true, ranks: [0, 2, 1, 3] });
    expect(run(start(), 'back')).toEqual({ ok: true, ranks: [1, 0, 2, 3] });
    const s0 = start();
    const last = s0.apply(s0.tr.setSelection(NodeSelection.create(s0.doc, 3)));
    expect(run(last, 'forward').ok).toBe(false);
    expect(run(last, 'back')).toEqual({ ok: true, ranks: [1, 2, 0, 3] });
  });

  it('stacks by rank, behind the text every picture over every shape', () => {
    expect(stackZ(true, 3, false)).toBe('4');
    expect(stackZ(true, 99, true)).toBe('21');
    expect(Number(stackZ(false, 0, true))).toBeGreaterThan(Number(stackZ(false, 99, false)));
    expect(Number(stackZ(false, 99, true))).toBeLessThan(-1);
  });

  it('keeps the order through both formats', async () => {
    const doc: N = { type: 'doc', content: [{ type: 'paragraph', content: [
      IMG({ wrap: 'through', zIndex: 2 }), IMG({ wrap: 'through', zIndex: 0 }), IMG({ wrap: 'through', zIndex: 1 }),
    ] }] };
    const order = (d: N) => d.content[0].content.filter((n: N) => n.type === 'image').map((n: N) => n.attrs.zIndex ?? 0);
    expect(order((await importOdt(await buildOdt(doc, margins, 'portrait'))).content)).toEqual([2, 0, 1]);
    expect(order(importDocx(await buildDocx(doc, margins, 'portrait')).content)).toEqual([2, 0, 1]);
  });
});
