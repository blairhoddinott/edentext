// Autolinking runs for typed text only; a typed URL followed by a space still links.
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { extensions } from '../../src/lib/editor/extensions';
import { setRecordChanges } from '../../src/lib/storage/trackChanges.svelte';

describe('autolink', () => {
  it('links a typed URL once a space follows it', () => {
    const editor = new Editor({ element: document.createElement('div'), extensions, content: '<p></p>' });
    editor.commands.insertContent('see www.example.com');
    editor.commands.insertContent(' ');
    const link = editor.getJSON().content?.[0].content?.find((n) => n.marks?.some((m) => m.type === 'link'));
    expect(link?.text).toBe('www.example.com');
    editor.destroy();
  });

  const linked = (editor: Editor) => JSON.stringify(editor.getJSON()).includes('"type":"link"');

  it('while recording leaves text that rejecting would keep', async () => {
    setRecordChanges(true);
    const editor = new Editor({ element: document.createElement('div'), extensions, content: '<p>see www.exampl</p>' });
    editor.commands.setTextSelection(15);
    editor.commands.insertContent('e.com');
    editor.commands.insertContent(' ');
    await Promise.resolve();
    expect(linked(editor)).toBe(false);
    setRecordChanges(false);
    editor.destroy();
  });

  it('while recording links what is all new, and rejecting takes it along', async () => {
    setRecordChanges(true);
    const editor = new Editor({ element: document.createElement('div'), extensions, content: '<p>see</p>' });
    editor.commands.setTextSelection(4);
    editor.commands.insertContent(' www.example.com');
    editor.commands.insertContent(' ');
    await Promise.resolve();
    expect(linked(editor)).toBe(true);
    setRecordChanges(false);
    editor.commands.rejectRevisions(true);
    expect(linked(editor)).toBe(false);
    editor.destroy();
  });
});
