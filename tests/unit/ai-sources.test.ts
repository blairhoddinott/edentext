// Attached files as chat material: read to text in the browser, cut to the budget, and
// sent with their one turn but never kept in the history.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { extensions } from '../../src/lib/editor/extensions';
import { readSource, sourcesBlock, SourceError } from '../../src/lib/ai/sources';
import { runTurn } from '../../src/lib/ai/tools';

const makeEditor = (html: string) => new Editor({ element: document.body.appendChild(document.createElement('div')), extensions, content: html });

afterEach(() => vi.unstubAllGlobals());

describe('sources', () => {
  it('reads text and HTML files and refuses what it cannot read', async () => {
    const editor = makeEditor('<p>x</p>');
    expect(await readSource(new File(['notes\nline 2'], 'notes.txt'), editor.schema)).toEqual({ name: 'notes.txt', text: 'notes\nline 2' });
    expect((await readSource(new File(['<p>Hello <b>web</b></p>'], 'page.html'), editor.schema)).text).toContain('Hello web');
    await expect(readSource(new File(['%PDF'], 'scan.pdf'), editor.schema)).rejects.toBeInstanceOf(SourceError);
    await expect(readSource(new File(['not a zip'], 'broken.docx'), editor.schema)).rejects.toBeInstanceOf(SourceError);
    editor.destroy();
  });

  it('cuts each file to its share of the budget', () => {
    const out = sourcesBlock([{ name: 'a.txt', text: 'x'.repeat(5000) }, { name: 'b.txt', text: 'short' }], 4000);
    expect(out).toMatch(/^Attached file «a\.txt»:\nx{2000}\n\[… rest of the file cut\]\n\nAttached file «b\.txt»:\nshort$/);
  });

  it('sends the files with the turn but keeps only the question in the history', async () => {
    const editor = makeEditor('<p>x</p>');
    const bodies: { messages: { content: string }[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`);
    }));
    const history: { role: string; content: string }[] = [];
    const cfg = { provider: 'openai' as const, endpoint: 'http://mock.test/v1', apiKey: '', model: 'm', contextTokens: 32000, mode: 'chat' as const, side: 'right' as const };
    await runTurn({ cfg, editor, history, question: 'Summarize it', author: 'AI', context: 'Attached file «n.txt»:\nsecret plan', onText: () => {}, onTool: () => {}, signal: new AbortController().signal });
    expect(bodies[0].messages.at(-1)!.content).toMatch(/secret plan\n\n---\n\nSummarize it$/);
    expect(JSON.stringify(history)).not.toContain('secret plan');
    editor.destroy();
  });
});
