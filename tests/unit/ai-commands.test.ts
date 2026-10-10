// The chat's slash commands: parsing, the prompt each one sends, and putting the reply
// in place of the selection or below it, refused once the selected text has changed.
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { extensions } from '../../src/lib/editor/extensions';
import { blockTexts } from '../../src/lib/ai/doc';
import { REWRITE_PROMPT } from '../../src/lib/ai/tools';
import { captureTarget, commandRequest, insertAtCursor, expandCustom, insertBelowTarget, parseCommand, replaceTarget } from '../../src/lib/ai/commands';

function makeEditor(html: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({ element: el, extensions, content: html });
}

const texts = (e: Editor) => blockTexts(e.state.doc).map((b) => b.text);

describe('parseCommand', () => {
  it('reads a known command and its argument, flags an unknown one, ignores plain text', () => {
    expect(parseCommand(' /Translate  Greek ')).toMatchObject({ command: { name: 'translate', preset: 'translate' }, arg: 'Greek' });
    expect(parseCommand('/draft a poem\nabout foxes')).toMatchObject({ command: { name: 'draft' }, arg: 'a poem\nabout foxes' });
    expect(parseCommand('/shorten')).toMatchObject({ command: { name: 'shorten' }, arg: '' });
    expect(parseCommand('/foo bar')).toEqual({ unknown: 'foo' });
    expect(parseCommand('what is /draft?')).toBeNull();
  });

  it('expands a saved command to its prompt plus what follows, a built-in winning', () => {
    const saved = [{ name: 'Sum Up', prompt: 'Summarize the document.\n' }, { name: 'draft', prompt: 'never' }, { name: 'empty', prompt: ' ' }];
    expect(expandCustom('/sum-up in three bullets', saved)).toBe('Summarize the document.\n\nin three bullets');
    expect(expandCustom('/SUM-UP', saved)).toBe('Summarize the document.');
    expect(expandCustom('/draft a poem', saved)).toBeNull();
    expect(expandCustom('/empty', saved)).toBeNull();
    expect(expandCustom('plain /sum-up', saved)).toBeNull();
  });
});

describe('commandRequest', () => {
  it('sends the selection to a rewrite and the document to a draft', () => {
    const editor = makeEditor('<p>The <strong>quick</strong> fox</p><p>Second</p>');
    editor.commands.setTextSelection({ from: 1, to: 14 });
    const target = captureTarget(editor.state);
    const cmd = (s: string) => (parseCommand(s) as { command: never }).command;

    const shorten = commandRequest(cmd('/shorten'), 'a lot', editor.state, target, 'German')!;
    expect(shorten.request.system).toBe(REWRITE_PROMPT);
    expect(shorten.asked).toBe('Make it shorter. a lot\n\nPassage:\nThe <strong>quick</strong> fox');
    expect(commandRequest(cmd('/translate'), '', editor.state, target, 'German')!.asked).toMatch(/^Translate it into German\./);
    expect(commandRequest(cmd('/rewrite'), '', editor.state, target, 'German')).toBeNull();

    const draft = commandRequest(cmd('/draft'), 'a title', editor.state, target, 'German')!;
    expect(draft.asked).toBe('Write this at the cursor: a title');
    expect(draft.request.messages[0].content).toContain('[2] Second');
    editor.destroy();
  });
});

describe('placing the reply', () => {
  it('replaces the selection or inserts below it, and refuses a changed target', () => {
    const editor = makeEditor('<p>The quick fox</p><p>End</p>');
    editor.commands.setTextSelection({ from: 5, to: 10 });
    const target = captureTarget(editor.state);
    expect(insertBelowTarget(editor, target, '<p>New</p>')).toBe(true);
    expect(texts(editor)).toEqual(['The quick fox', 'New', 'End']);
    expect(replaceTarget(editor, target, 'slow')).toBe(true);
    expect(texts(editor)).toEqual(['The slow fox', 'New', 'End']);
    expect(replaceTarget(editor, target, 'fast')).toBe(false);
    expect(texts(editor)).toEqual(['The slow fox', 'New', 'End']);
    editor.destroy();
  });

  it('drafts into an empty document without a paragraph per line break of the reply', () => {
    const editor = makeEditor('<p></p>');
    insertAtCursor(editor, '<h1>CV</h1>\n<p>Ada</p>\n');
    expect(texts(editor)).toEqual(['CV', 'Ada']);
    editor.destroy();
  });
});
