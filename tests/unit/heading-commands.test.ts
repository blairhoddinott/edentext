// Editing commands on a heading: its style name, Enter, and the list and numbering toggles.
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Heading from '@tiptap/extension-heading';
import ListItem from '@tiptap/extension-list-item';
import { extensions } from '../../src/lib/editor/extensions';
import { outline } from '../../src/lib/editor/extensions/outline';
import { OrderedList } from '../../src/lib/editor/extensions/orderedList';
import { setOutline, styleSheet } from '../../src/lib/styles/sheet.svelte';
import { decimalOutline, type OutlineNumbering } from '../../src/lib/styles/outlineNumbering';

type N = any;

// Each editor is destroyed, or its DOM observer fires after jsdom is gone.
const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); });

function makeEditor(content: N) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({ element: el, extensions, content });
  editors.push(editor);
  return editor;
}

// A heading is a named style plus the node type, and the two must never drift apart:
// a paragraph carrying "Heading 2" looks like a heading, is none, and drops out of the
// navigator's outline. Drives a real body editor.
describe('heading style name', () => {
  const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const blocks = (editor: Editor) =>
    (editor.getJSON().content as N[]).map((n) => `${n.type}:${n.attrs?.level ?? ''}:${n.attrs?.styleName ?? ''}`);
  // Ctrl+Alt+N runs off event.code, not the keymap — so does this.
  const press = (editor: Editor, code: string, init: KeyboardEventInit = {}) =>
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init }));

  it('Ctrl+Alt+N applies the level and its style, 1 through 6', () => {
    const editor = makeEditor({ type: 'doc', content: [p('x')] });
    for (const level of [1, 2, 3, 4, 5, 6]) {
      editor.commands.focus('end');
      press(editor, `Digit${level}`, { ctrlKey: true, altKey: true });
      expect(blocks(editor)).toEqual([`heading:${level}:Heading ${level}`]);
    }
    press(editor, 'Digit0', { ctrlKey: true, altKey: true });
    expect(blocks(editor)).toEqual(['paragraph::Standard']);
  });

  it('Enter at the end of a heading starts a body paragraph', () => {
    const editor = makeEditor({ type: 'doc', content: [{ type: 'heading', attrs: { level: 2, styleName: 'Heading 2' }, content: [{ type: 'text', text: 'A' }] }] });
    editor.commands.focus('end');
    editor.commands.splitBlock();
    expect(blocks(editor)).toEqual(['heading:2:Heading 2', 'paragraph::']);
  });

  it('lists two consecutive headings of one level', () => {
    const editor = makeEditor({ type: 'doc', content: [p('x')] });
    editor.commands.focus('end');
    press(editor, 'Digit2', { ctrlKey: true, altKey: true });
    editor.commands.insertContent('A');
    editor.commands.splitBlock();
    press(editor, 'Digit2', { ctrlKey: true, altKey: true });
    editor.commands.insertContent('B');
    expect(outline(editor.state.doc).map((e) => `${e.level}:${e.text}`)).toEqual(['2:xA', '2:B']);
  });
});

// A bullet keeps the heading in the item, as in LibreOffice; the wrap must not reach it
// through a text box. Numbering a heading numbers the chapters and leaves the heading.
describe('list toggle on a heading', () => {
  const headingEditor = () => {
    const editor = makeEditor({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] }] });
    editor.commands.setTextSelection(2);
    return editor;
  };

  it('toggleBulletList', () => {
    const editor = headingEditor();
    editor.commands.toggleBulletList();
    const list = editor.state.doc.firstChild!;
    expect(list.type.name).toBe('bulletList');
    expect(list.firstChild!.firstChild!.type.name).toBe('heading');
    expect(JSON.stringify(editor.getJSON())).not.toContain('textBox');
    expect(editor.state.doc.textContent).toBe('Title');
    // Enter at its end opens a bulleted paragraph; the bullet again lifts the heading out.
    editor.commands.setTextSelection(8);
    editor.commands.splitListItem('listItem');
    expect(editor.state.doc.firstChild!.childCount).toBe(2);
    expect(editor.state.doc.firstChild!.lastChild!.firstChild!.type.name).toBe('paragraph');
    editor.commands.setTextSelection(4);
    editor.commands.toggleBulletList();
    expect(editor.state.doc.firstChild!.type.name).toBe('heading');
  });

  it('toggleOrderedList numbers the chapters through the style sheet', () => {
    const editor = headingEditor();
    editor.commands.toggleOrderedList();
    expect(editor.state.doc.firstChild!.type.name).toBe('heading');
    expect(styleSheet().outline?.[0]?.format).toBe('1');
    setOutline(null);
  });
});

// The numbering commands on a heading number the chapters instead of wrapping the heading
// in a list item, through whatever chapter numbering the extension is given.
describe('the numbering commands on a heading', () => {
  function setup() {
    let numbering: OutlineNumbering | null = null;
    const editor = new Editor({
      extensions: [Document, Paragraph, Text, Heading, ListItem,
        OrderedList.configure({ headingNumbering: { get: () => numbering, set: (o) => { numbering = o; } } })],
      content: '<h1>Chapter</h1><p>Body</p>',
    });
    editors.push(editor);
    return { editor, numbering: () => numbering };
  }

  it('toggle the chapter numbering and keep the heading', () => {
    const { editor, numbering } = setup();
    editor.commands.setTextSelection(2);
    editor.commands.toggleOrderedList();
    expect(numbering()).toEqual(decimalOutline());
    expect(editor.getJSON().content?.[0].type).toBe('heading');
    editor.commands.toggleOrderedList();
    expect(numbering()).toBeNull();
  });

  it('take a picked format for every level', () => {
    const { editor, numbering } = setup();
    editor.commands.setTextSelection(2);
    editor.commands.setOrderedListType('upper-alpha');
    expect(numbering()?.[1]).toMatchObject({ format: 'A', suffix: '. ', displayLevels: 1 });
  });

  it('still make a list of a paragraph', () => {
    const { editor, numbering } = setup();
    editor.commands.setTextSelection(11);
    editor.commands.toggleOrderedList();
    expect(editor.getJSON().content?.[1].type).toBe('orderedList');
    expect(numbering()).toBeNull();
  });
});
