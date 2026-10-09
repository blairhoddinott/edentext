// The assistant's tools on a real body editor: numbered paragraphs, tracked text edits
// under its own author, direct formatting, numbers that survive earlier edits, and the
// chat turn's tool loop against a scripted provider.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { Mapping } from '@tiptap/pm/transform';
import { extensions } from '../../src/lib/editor/extensions';
import { revisions, trackedReplace } from '../../src/lib/editor/extensions/trackChanges';
import { blockLine, blockTexts, htmlToSlice, serializeDoc } from '../../src/lib/ai/doc';
import { runTool, runTurn, type TurnContext } from '../../src/lib/ai/tools';
import type { ToolCall } from '../../src/lib/ai/client';

const AI = 'AI';

function makeEditor(html: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({ element: el, extensions, content: html });
}

function turn(editor: Editor): TurnContext {
  const ctx: TurnContext = { editor, blocks: blockTexts(editor.state.doc), mapping: new Mapping(), author: AI };
  editor.on('transaction', ({ transaction }) => ctx.mapping.appendMapping(transaction.mapping));
  return ctx;
}

const call = (name: string, args: unknown): ToolCall => ({ id: name, name, args: JSON.stringify(args) });
const texts = (e: Editor) => blockTexts(e.state.doc).map((b) => b.text);

afterEach(() => vi.unstubAllGlobals());

describe('serializeDoc', () => {
  it('numbers every textblock, marks headings and hides deleted text', () => {
    const editor = makeEditor('<h1>Title</h1><p>The quick fox</p><ul><li><p>item</p></li></ul>');
    const { view, state } = editor;
    view.dispatch(trackedReplace(state.tr, 12, 18, null, 'Ada'));
    editor.commands.setTextSelection(3);
    expect(serializeDoc(editor.state)).toBe('Document, one paragraph per line, numbered:\n[1 h1] Title\n[2] The fox\n[3 li] item\n\nThe cursor is in paragraph 1.');
    editor.destroy();
  });

  it('notes style, alignment and the runs that carry direct formatting', () => {
    const editor = makeEditor('<p style="text-align:center"><strong>all bold</strong></p><p>a <em>b</em> c <em>d</em><strong><em>e</em></strong></p><p><span style="font-size:14pt">big</span> x</p>');
    expect(blockTexts(editor.state.doc).map(blockLine)).toEqual([
      '[1] all bold {align center; bold: all}',
      '[2] a b c de {italic: "b", "de"; bold: "e"}',
      '[3] big x {size 14pt: "big"}',
    ]);
    const pic = makeEditor('<p>see <img src="data:image/png;base64,AA==" alt="A red logo"> and <img src="data:image/png;base64,AA=="></p>');
    expect(blockTexts(pic.state.doc).map(blockLine)).toEqual(['[1] see {image "A red logo"} and {image}']);
    pic.destroy();
    editor.destroy();
  });

  it('shows list numbers, leaves out what the style gives, folds empty runs and marks columns', () => {
    const editor = makeEditor('<ol><li><p>one</p></li><li><p>two</p></li></ol><p><span style="font-size:12pt">plain</span></p><p></p><p></p><p></p><p>end</p>');
    editor.chain().setTextSelection({ from: editor.state.doc.content.size - 4, to: editor.state.doc.content.size - 1 }).setColumns(2).run();
    expect(serializeDoc(editor.state)).toMatch(/^Document[^\n]*\n\[1 li 1\] one\n\[2 li 2\] two\n\[3\] plain\n\[4–6\] \(empty\)\n— 2 columns —\n\[7\] end\n/);
    editor.destroy();
  });

  it('keeps the head and the selection when over budget', () => {
    const editor = makeEditor(Array.from({ length: 200 }, (_, i) => `<p>paragraph number ${i + 1}</p>`).join(''));
    const last = blockTexts(editor.state.doc)[149];
    editor.commands.setTextSelection(last.from);
    const out = serializeDoc(editor.state, undefined, 2000);
    expect(out).toContain('[1] paragraph number 1\n');
    expect(out).toContain('[150] paragraph number 150');
    expect(out).toMatch(/\[… paragraphs \d+–\d+ omitted/);
    expect(out.length).toBeLessThan(2400);
    editor.destroy();
  });
});

describe('tools', () => {
  it('replaces text as a tracked change by the assistant, and reject restores it', () => {
    const editor = makeEditor('<p>One</p><p>The <strong>quick</strong> fox</p>');
    const ctx = turn(editor);
    expect(runTool(ctx, call('replace_text', { paragraph: 2, find: 'quick', replace: 'slow' })).result).toBe('ok');
    expect(revisions(editor.state.doc).map((r) => [r.kind, r.text, r.author])).toEqual([['deletion', 'quick', AI], ['insertion', 'slow', AI]]);
    // The replacement keeps the passage's own formatting.
    const slow = revisions(editor.state.doc)[1];
    expect(editor.state.doc.nodeAt(slow.from)?.marks.some((m) => m.type.name === 'bold')).toBe(true);
    editor.commands.rejectRevisions(true);
    expect(texts(editor)).toEqual(['One', 'The quick fox']);
    editor.destroy();
  });

  it('keeps numbers valid after an earlier insertion', () => {
    const editor = makeEditor('<p>alpha</p><p>beta</p><p>gamma</p>');
    const ctx = turn(editor);
    expect(runTool(ctx, call('insert_paragraphs', { after: 0, html: '<p>new one</p><p>new two</p>' })).result).toBe('ok');
    expect(runTool(ctx, call('replace_text', { paragraph: 3, find: 'gamma', replace: 'delta' })).result).toBe('ok');
    editor.commands.acceptRevisions(true);
    expect(texts(editor)).toEqual(['new one', 'new two', 'alpha', 'beta', 'delta']);
    editor.destroy();
  });

  it('deletes and rewrites paragraphs as tracked changes', () => {
    const editor = makeEditor('<p>keep</p><p>drop me</p><p>old text</p>');
    const ctx = turn(editor);
    runTool(ctx, call('delete_paragraphs', { from: 2, to: 2 }));
    runTool(ctx, call('rewrite_paragraph', { paragraph: 3, html: 'new <em>text</em>' }));
    expect(texts(editor)).toEqual(['keep', '', 'new text']);
    editor.commands.rejectRevisions(true);
    expect(texts(editor)).toEqual(['keep', 'drop me', 'old text']);
    // Plain text and a whole <p> are a paragraph's new text too.
    runTool(ctx, call('rewrite_paragraph', { paragraph: 1, html: 'plain' }));
    runTool(ctx, call('rewrite_paragraph', { paragraph: 2, html: '<p>wrapped</p>' }));
    editor.commands.acceptRevisions(true);
    expect(texts(editor)).toEqual(['plain', 'wrapped', 'old text']);
    editor.destroy();
  });

  it('formats directly, without a revision, and sets a heading style', () => {
    const editor = makeEditor('<p>Summary line</p><p>body</p>');
    const ctx = turn(editor);
    expect(runTool(ctx, call('format', { from: 1, bold: true })).result).toBe('ok');
    expect(editor.state.doc.firstChild?.firstChild?.marks.map((m) => m.type.name)).toContain('bold');
    expect(runTool(ctx, call('format', { from: 1, bold: false, style: 'Heading 2' })).result).toBe('ok');
    const first = editor.state.doc.firstChild!;
    expect(first.type.name).toBe('heading');
    expect(first.attrs.level).toBe(2);
    expect(first.firstChild?.marks.some((m) => m.type.name === 'bold')).toBe(false);
    expect(revisions(editor.state.doc)).toEqual([]);
    editor.destroy();
  });

  it('refuses to edit over somebody else’s pending change', () => {
    const editor = makeEditor('<p>The quick fox</p>');
    editor.view.dispatch(trackedReplace(editor.state.tr, 5, 10, null, 'Ada'));
    const ctx = turn(editor);
    const r = runTool(ctx, call('rewrite_paragraph', { paragraph: 1, html: 'other' }));
    expect(r.result).toMatch(/^error: .*tracked changes/);
    expect(revisions(editor.state.doc).map((x) => x.author)).toEqual(['Ada']);
    editor.destroy();
  });

  it('labels cells by table, row and column, and inserts a filled row or column', () => {
    const editor = makeEditor('<p>x</p><table><tr><td><p>A</p></td><td><p>B</p></td></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></table>');
    expect(blockTexts(editor.state.doc).map((b) => b.kind)).toEqual(['', 'cell T1 r1 c1', 'cell T1 r1 c2', 'cell T1 r2 c1', 'cell T1 r2 c2']);
    const listed = makeEditor('<table><tr><td><p>A</p></td><td><ul><li><p>B</p></li></ul></td></tr></table>');
    expect(blockTexts(listed.state.doc).map((b) => b.kind)).toEqual(['cell T1 r1 c1', 'cell T1 r1 c2 li']);
    listed.destroy();
    const ctx = turn(editor);
    expect(runTool(ctx, call('table_insert', { paragraph: 3, where: 'column_right', cells: ['<strong>C</strong>', '3'] })).result).toBe('ok');
    expect(runTool(ctx, call('table_insert', { paragraph: 2, where: 'row_above', cells: ['h'] })).result).toBe('ok');
    expect(revisions(editor.state.doc).map((r) => [r.kind, r.text, r.author])).toEqual([['insertion', 'h', AI], ['insertion', 'C', AI], ['insertion', '3', AI]]);
    expect(blockTexts(editor.state.doc).map((b) => `${b.kind}=${b.text}`).slice(1, 10)).toEqual([
      'cell T1 r1 c1=h', 'cell T1 r1 c2=', 'cell T1 r1 c3=',
      'cell T1 r2 c1=A', 'cell T1 r2 c2=B', 'cell T1 r2 c3=C',
      'cell T1 r3 c1=1', 'cell T1 r3 c2=2', 'cell T1 r3 c3=3',
    ]);
    expect(runTool(ctx, call('table_insert', { paragraph: 1, where: 'row_below' })).result).toMatch(/not in a table/);
    editor.destroy();
  });

  it('gives a new row the formatting of the row it was inserted from', () => {
    const editor = makeEditor('<table><tr><td style="background-color:#ffcc00"><p style="text-align:justify">a</p></td><td><p style="text-align:right">1</p></td></tr></table>');
    expect(runTool(turn(editor), call('table_insert', { paragraph: 2, where: 'row_below', cells: ['b', '2'] })).result).toBe('ok');
    const cells: string[] = [];
    editor.state.doc.descendants((n) => { if (n.type.name === 'tableCell') cells.push(`${n.attrs.backgroundColor} ${n.firstChild!.attrs.textAlign} ${n.textContent}`); });
    expect(cells.slice(2)).toEqual(['rgb(255, 204, 0) justify b', 'null right 2']);
    editor.destroy();
  });

  it('fills a form blank however many dots the model copies, and sets columns', () => {
    const editor = makeEditor(`<p>Name: ${'.'.repeat(40)} (employee)</p><p>Second</p><p></p>`);
    const ctx = turn(editor);
    expect(runTool(ctx, call('replace_text', { paragraph: 1, find: 'Name: ……', replace: 'Name: Ada Byron' })).result).toBe('ok');
    expect(texts(editor)[0]).toBe('Name: Ada Byron (employee)');
    expect(runTool(ctx, call('set_columns', { from: 3, count: 2 })).result).toMatch(/empty/);
    expect(runTool(ctx, call('set_columns', { from: 1, to: 2, count: 2 })).result).toBe('ok');
    expect(blockTexts(editor.state.doc).map((b) => b.columns)).toEqual([2, 2, 1]);
    editor.destroy();
  });

  it('lists comment threads, replies to one and resolves it', () => {
    const editor = makeEditor('<p>alpha</p><p>beta gamma</p>');
    editor.chain().setTextSelection({ from: 8, to: 12 }).addComment({ author: 'Ada', text: 'Why beta?' }).run();
    editor.commands.setTextSelection(1);
    expect(serializeDoc(editor.state)).toContain('Comments, numbered:\n[C1 on paragraph 2 «beta», by Ada, open] Why beta?');
    const ctx = { ...turn(editor), commentIds: undefined };
    expect(runTool(ctx, call('reply_comment', { comment: 1, text: 'It is the second letter.' })).result).toBe('ok');
    expect(runTool(ctx, call('resolve_comment', { comment: 1 })).result).toBe('ok');
    expect(runTool(ctx, call('resolve_comment', { comment: 2 })).result).toMatch(/no comment C2/);
    expect(serializeDoc(editor.state)).toContain('[C1 on paragraph 2 «beta», by Ada, resolved] Why beta?\n  ↳ AI: It is the second letter.');
    editor.destroy();
  });

  it('returns failures to the model as text', () => {
    const editor = makeEditor('<p>x</p>');
    const ctx = turn(editor);
    expect(runTool(ctx, call('replace_text', { paragraph: 9, find: 'a', replace: 'b' })).result).toMatch(/^error: no paragraph 9/);
    expect(runTool(ctx, { id: '1', name: 'format', args: '{oops' }).result).toMatch(/^error:/);
    expect(runTool(ctx, call('nope', {})).result).toBe('error: unknown tool nope');
    editor.destroy();
  });
});

describe('htmlToSlice', () => {
  it('keeps only what the schema knows', () => {
    const editor = makeEditor('<p></p>');
    const slice = htmlToSlice('<p onclick="x()">a<script>alert(1)</script><img src="https://evil.test/x.png" onerror="y()"><strong>b</strong></p>', editor.state);
    const json = JSON.stringify(slice.content.toJSON());
    expect(json).not.toMatch(/script|onerror|onclick|evil/);
    expect(slice.content.textBetween(0, slice.content.size)).toBe('ab');
    expect(htmlToSlice('```html\n<p>x</p>\n```', editor.state).content.textBetween(0, 3)).toBe('x');
    editor.destroy();
  });

  it('reads markdown emphasis as marks, but not a product', () => {
    const editor = makeEditor('<p></p>');
    const marks = (html: string) => {
      const out: string[] = [];
      htmlToSlice(html, editor.state).content.descendants((n) => { if (n.isText) out.push(`${n.marks.map((m) => m.type.name).join('+')}:${n.text}`); });
      return out;
    };
    expect(marks('<p>**Summary:** a *b*</p>')).toEqual(['bold:Summary:', ': a ', 'italic:b']);
    expect(marks('**x** and 2 * 3 * 4')).toEqual(['bold:x', ': and 2 * 3 * 4']);
    editor.destroy();
  });
});

describe('runTurn', () => {
  const cfg = { provider: 'openai' as const, endpoint: 'http://mock.test/v1', apiKey: '', model: 'm' };
  const reply = (delta: unknown) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);

  it('runs tool rounds until the model answers, and records the turn', async () => {
    const editor = makeEditor('<p>Hello world</p>');
    const bodies: { messages: { role: string; content?: string }[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return bodies.length === 1
        ? reply({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'replace_text', arguments: '{"paragraph":1,"find":"world","replace":"there"}' } }] })
        : reply({ content: '<p>Changed it.</p>' });
    }));
    const history: never[] = [];
    const tools: string[] = [];
    const answer = await runTurn({ cfg, editor, history, question: 'Change it', author: AI, onText: () => {}, onTool: (s) => tools.push(s), signal: new AbortController().signal });
    expect(answer).toBe('<p>Changed it.</p>');
    expect(tools).toHaveLength(1);
    expect(bodies[0].messages[1].content).toContain('[1] Hello world');
    expect(bodies[1].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
    expect(history).toEqual([{ role: 'user', content: 'Change it' }, { role: 'assistant', content: '<p>Changed it.</p>' }]);
    editor.commands.acceptRevisions(true);
    expect(texts(editor)).toEqual(['Hello there']);
    editor.destroy();
  });

  it('stops after a bounded number of rounds', async () => {
    const editor = makeEditor('<p>x</p>');
    const fetch = vi.fn(async () => reply({ tool_calls: [{ index: 0, id: 'r', function: { name: 'read_paragraphs', arguments: '{"from":1,"to":1}' } }] }));
    vi.stubGlobal('fetch', fetch);
    await runTurn({ cfg, editor, history: [], question: 'loop', author: AI, onText: () => {}, onTool: () => {}, signal: new AbortController().signal });
    expect(fetch).toHaveBeenCalledTimes(8);
    editor.destroy();
  });

  it('aborts', async () => {
    const editor = makeEditor('<p>x</p>');
    const ctrl = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      ctrl.abort();
      throw init.signal?.reason ?? new DOMException('aborted', 'AbortError');
    }));
    await expect(runTurn({ cfg, editor, history: [], question: 'q', author: AI, onText: () => {}, onTool: () => {}, signal: ctrl.signal })).rejects.toBeDefined();
    editor.destroy();
  });

  it('reads placeholders, fields and text boxes, and replaces a placeholder by its token', () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
    const editor = makeEditor('<p>Dear <span data-placeholder-field="Name"></span>, <span data-datetime-field="date"></span></p>');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertTextBox();
    const blocks = blockTexts(editor.state.doc);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([['', 'Dear ‹Name›, {date}'], ['box 1', '']]);
    expect(runTool(turn(editor), call('replace_text', { paragraph: 1, find: '‹Name›', replace: 'Ada' })).result).toBe('ok');
    expect(editor.state.doc.firstChild!.textContent).toContain('Ada');
    editor.destroy();
  });
});
