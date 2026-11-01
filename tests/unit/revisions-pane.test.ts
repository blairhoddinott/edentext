// What the reviewing pane needs: a colour per author, in order of first appearance and
// shared by revisions and comments, and
// accept/reject by change id — a change split by a paragraph boundary is one row there
// and must be applied whole. Drives a real editor with just the track-changes extension.
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { TrackChanges, Insertion, Deletion, revisions } from '../../src/lib/editor/extensions/trackChanges';
import { Comment, commentIdAt, comments } from '../../src/lib/editor/extensions/comment';
import { authorColors } from '../../src/lib/editor/authorColors';
import { filterRevisions, goToMarkup, selectRange, settleRevisions, shownStats } from '../../src/lib/components/reviewItems';
import { blockText } from '../../src/lib/editor/extensions/outline';
import { setMarkupMode, type MarkupMode } from '../../src/lib/storage/markup.svelte';

type N = any;

const R = (kind: string, id: string, author: string, text: string): N =>
  ({ type: 'text', text, marks: [{ type: kind, attrs: { id, author, date: '2026-08-14T10:00:00.000Z' } }] });

function makeEditor(content: N) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({ element: el, extensions: [Document, Paragraph, Text, Insertion, Deletion, TrackChanges, Comment], content });
}

// One change (r1) split over two paragraphs, plus a second author's deletion.
const doc: N = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'a ' }, R('insertion', 'r1', 'Ada', 'one')] },
    { type: 'paragraph', content: [R('insertion', 'r1', 'Ada', 'two'), { type: 'text', text: ' b ' }, R('deletion', 'r2', 'Grace', 'gone')] },
  ],
};

describe('revisions for the reviewing pane', () => {
  it('gives each author one colour of its own, revisions and comments alike', () => {
    // A comment by a new author, answered by one already seen and by another new one.
    const replies = [{ author: 'Grace', date: '', text: 'yes' }, { author: 'Linus', date: '', text: 'no' }];
    const commented: N = { ...doc, content: [...doc.content, { type: 'paragraph', content: [
      { type: 'text', text: 'note', marks: [{ type: 'comment', attrs: { id: 'c1', author: 'Edsger', text: 'why?', replies } }] },
      R('insertion', 'r3', 'Ada', 'more'),
    ] }] };
    const editor = makeEditor(commented);
    const colors = authorColors(editor.state.doc);
    expect([...colors.keys()]).toEqual(['Ada', 'Grace', 'Edsger', 'Linus']);
    expect(new Set(colors.values()).size).toBe(4);
    editor.destroy();
  });

  it('keeps several comments on one text apart', () => {
    const editor = makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one word here' }] }] });
    const shown = () => comments(editor.state.doc).map((c) => [c.text, c.quote, c.replies.length]);
    const add = (from: number, to: number, text: string) =>
      editor.chain().setTextSelection({ from, to }).addComment({ author: 'Ada', text }).run();
    add(5, 9, 'first');
    add(5, 9, 'second');
    add(1, 14, 'around');
    expect(shown()).toEqual([['around', 'one word here', 0], ['first', 'word', 0], ['second', 'word', 0]]);
    const [around, first, second] = comments(editor.state.doc);
    editor.view.scrollToSelection = () => {}; // jsdom has no layout to scroll by

    // Only a card tells two ranges alike apart; a plain click finds the innermost.
    editor.commands.setTextSelection(6);
    expect(commentIdAt(editor.state)).toBe(first.id);
    selectRange(editor, second.from, second.to, false, second.id);
    expect(commentIdAt(editor.state)).toBe(second.id);
    goToMarkup(editor, 'comment', -1);
    expect(commentIdAt(editor.state)).toBe(first.id);
    goToMarkup(editor, 'comment', -1);
    expect(commentIdAt(editor.state)).toBe(around.id);

    editor.commands.replyToComment(first.id, { author: 'Grace', text: 'yes' });
    expect(shown()).toEqual([['around', 'one word here', 0], ['first', 'word', 1], ['second', 'word', 0]]);
    editor.commands.removeComment(first.id);
    expect(shown()).toEqual([['around', 'one word here', 0], ['second', 'word', 0]]);
    editor.destroy();
  });

  it('accepts every range of one change and leaves the others', () => {
    const editor = makeEditor(doc);
    editor.commands.acceptRevision('r1');
    const left = revisions(editor.state.doc);
    expect(left.map((r) => r.id)).toEqual(['r2']);
    expect(editor.state.doc.textContent).toBe('a onetwo b gone');
    editor.destroy();
  });

  it('filters by author, kind and day, and settles what is left in one step', () => {
    const editor = makeEditor(doc);
    const list = revisions(editor.state.doc);
    const none = { author: null, kind: null, since: '' };
    const ids = (filter: Parameters<typeof filterRevisions>[1]) => [...new Set(filterRevisions(list, filter).map((r) => r.id))];
    expect(ids(none)).toEqual(['r1', 'r2']);
    expect(ids({ ...none, author: 'Grace' })).toEqual(['r2']);
    expect(ids({ ...none, kind: 'insertion' })).toEqual(['r1']);
    expect(ids({ ...none, kind: 'moved' })).toEqual([]);
    expect(ids({ ...none, since: '2026-08-14' })).toEqual(['r1', 'r2']);
    expect(ids({ ...none, since: '2026-08-15' })).toEqual([]);

    // The second change's positions lie behind what the first one removes.
    let steps = 0;
    editor.on('transaction', () => steps++);
    settleRevisions(editor, list, false);
    expect(editor.state.doc.textContent).toBe('a  b gone');
    expect(revisions(editor.state.doc)).toHaveLength(0);
    expect(steps).toBe(1);
    editor.destroy();
  });

  it.each([['all', ['a one', 'two b gone'], 5], ['none', ['a one', 'two b'], 4], ['original', ['a', 'b gone'], 3]] as [MarkupMode, string[], number][])(
    'reads as the view does: %s', (mode, blocks, words) => {
      const editor = makeEditor(doc);
      setMarkupMode(mode);
      const stats = shownStats(editor.state.doc);
      expect([blockText(editor.state.doc.child(0)), blockText(editor.state.doc.child(1))]).toEqual(blocks);
      expect(stats).toMatchObject({ words, paragraphs: 2, charsNoSpaces: blocks.join('').replace(/\s/g, '').length });
      setMarkupMode('all');
      editor.destroy();
    });

  it('rejects a change by id: an insertion goes, a deletion comes back', () => {
    const editor = makeEditor(doc);
    editor.commands.rejectRevision('r1');
    expect(editor.state.doc.textContent).toBe('a  b gone');
    editor.commands.acceptRevision('r2');
    expect(editor.state.doc.textContent).toBe('a  b ');
    expect(revisions(editor.state.doc)).toHaveLength(0);
    editor.destroy();
  });
});
