// The HTML a model writes (semantic tags, plain CSS) as the editor's own nodes: one case
// per construct the dialect knows, through htmlToSlice on the real schema.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { extensions } from '../../src/lib/editor/extensions';
import { htmlToSlice } from '../../src/lib/ai/doc';

let editor: Editor;
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({ element: el, extensions, content: '<p></p>' });
});
afterAll(() => editor.destroy());

function parse(html: string) {
  const dropped: string[] = [];
  const nodes: PMNode[] = [];
  htmlToSlice(html, editor.state, dropped).content.forEach((n) => nodes.push(n));
  return { nodes, dropped };
}
const find = (nodes: PMNode[], type: string) => {
  let hit: PMNode | null = null;
  for (const n of nodes) n.descendants((c) => { hit ??= c.type.name === type ? c : null; return !hit; });
  return hit ?? nodes.find((n) => n.type.name === type) ?? null;
};

describe('AI HTML dialect', () => {
  it('maps paragraph CSS and a style class to block attributes', () => {
    const [p] = parse('<p class="quotations" style="text-align:center;margin-top:12pt;margin-bottom:8px;margin-left:1cm;text-indent:5mm;line-height:150%;background:#eee;border-bottom:1pt solid #333;font-size:14pt;font-family:\'Liberation Sans\', sans-serif;page-break-before:always">Hi</p>').nodes;
    expect(p.attrs).toMatchObject({
      styleName: 'Quotations', textAlign: 'center', spaceBefore: 12, spaceAfter: 6, indent: 1, indentFirst: 0.5,
      lineHeight: '1.5', backgroundColor: '#EEEEEE', borderBottom: '1pt solid #333333', fontSize: '14pt',
      fontFamily: 'Liberation Sans', breakBefore: 'page',
    });
  });

  it('turns <hr> into a page break before the next block', () => {
    const { nodes } = parse('<p>a</p><hr><h2>b</h2>');
    expect(nodes.map((n) => [n.type.name, n.attrs.breakBefore ?? null])).toEqual([['paragraph', null], ['heading', 'page']]);
  });

  it('gives every cell its column weight, with borders off and a table style', () => {
    const { nodes } = parse('<table border="0" class="simple grid"><colgroup><col width="25%"><col></colgroup><tr><td>2020</td><td style="background:#ddd">Job</td></tr><tr><td>2021</td><td>More</td></tr></table>');
    const table = nodes[0];
    expect(table.attrs.tableStyle).toBe('Simple Grid');
    const cells: PMNode[] = [];
    table.descendants((c) => { if (c.type.name === 'tableCell') cells.push(c); return c.type.name !== 'tableCell'; });
    expect(cells.map((c) => c.attrs.colwidth)).toEqual([[25], [75], [25], [75]]);
    expect(cells[0].attrs.borderLeft).toBe('none');
    expect(cells[1].attrs.backgroundColor).toBeTruthy();
  });

  it('anchors an <aside> as a text box in the paragraph after it', () => {
    const { nodes } = parse('<aside style="width:5cm;height:6cm;float:right"><p>Photo</p></aside><p>Anchor</p>');
    expect(nodes.length).toBe(1);
    const box = find(nodes, 'textBox')!;
    expect(box.attrs).toMatchObject({ width: 189, height: 227, wrap: 'right', fillColor: '#FFFFFF', strokeColor: '#000000' });
    expect(box.textContent).toBe('Photo');
    expect(nodes[0].textContent).toContain('Anchor');
  });

  it('takes a floating frame\'s margin as its gap to the text, else a new frame\'s', () => {
    const img = find(parse('<p><img alt="P" width="4cm" height="5cm" style="float:left;margin:0.1cm 0.5cm"></p>').nodes, 'image')!;
    expect(img.attrs.wrapDist).toEqual({ top: 0.1, right: 0.5, bottom: 0.1, left: 0.5 });
    const plain = find(parse('<p><img alt="P" style="float:left"></p>').nodes, 'image')!;
    expect(plain.attrs.wrapDist).toEqual({ top: 0, right: 0.32, bottom: 0, left: 0.32 });
    const box = find(parse('<aside style="float:right"><p>x</p></aside><p>a</p>').nodes, 'textBox')!;
    expect(box.attrs.wrapDist).toEqual({ top: 0.2, right: 0.2, bottom: 0.2, left: 0.2 });
  });

  it('draws a picture placeholder for an <img> without src and drops a remote one', () => {
    const { nodes, dropped } = parse('<p><img alt="Photo" width="4cm" height="5cm"><img src="https://example.com/x.png"></p>');
    const img = find(nodes, 'image')!;
    expect(img.attrs).toMatchObject({ alt: 'Photo', width: 151, height: 189 });
    expect(img.attrs.src).toMatch(/^data:image\//);
    expect(nodes[0].childCount).toBe(1);
    expect(dropped[0]).toMatch(/ignored/);
  });

  it('makes placeholders, date fields, columns and a table of contents', () => {
    const { nodes } = parse('<p><input placeholder="Your name"> <time></time> {date}</p><section columns="2"><p>a</p><p>b</p></section><nav></nav>');
    expect(find(nodes, 'placeholderField')!.attrs.text).toBe('Your name');
    let fields = 0;
    nodes[0].forEach((c) => { fields += c.type.name === 'dateTimeField' ? 1 : 0; });
    expect(fields).toBe(2);
    expect(nodes[1].type.name).toBe('columns');
    expect(nodes[1].attrs.count).toBe(2);
    expect(nodes[2].type.name).toBe('tableOfContents');
    expect(nodes[2].attrs.entries).toBeNull();
  });

  it('keeps tabs in text', () => {
    const { nodes } = parse('<p>2020\tEngineer</p>\n<p>  plain   text  </p>');
    expect(nodes.map((n) => n.textContent)).toEqual(['2020\tEngineer', 'plain text']);
  });

  it('drops a table without cells, as a reply still streaming has one', () => {
    expect(parse('<p>a</p><table border="0">').nodes.map((n) => n.type.name)).toEqual(['paragraph']);
    expect(parse('<table><tr></tr><tr><td>x</td></tr></table>').nodes[0].childCount).toBe(1);
  });
});
