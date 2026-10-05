// What the assistant may do to the document, and the chat turn that lets it. Text edits
// are tracked changes under the assistant's own author, for the user to accept or reject
// in the Review pane; formatting cannot be tracked and applies directly (undoable).

import type { Editor } from '@tiptap/core';
import { Fragment, Slice, type Mark, type Node as PMNode } from '@tiptap/pm/model';
import { Mapping } from '@tiptap/pm/transform';
import type { Transaction } from '@tiptap/pm/state';
import { trackedReplace } from '../editor/extensions/trackChanges';
import { applyFormat, FORMAT_MARKS, type FormatSpec } from '../editor/extensions/searchReplace';
import { styleSheet } from '../styles/sheet.svelte';
import { visibleStyles } from '../styles/styleSheet';
import { t } from '../i18n/i18n.svelte';
import type { AiConfig } from '../storage/ai.svelte';
import { streamChat, parseArgs, type ChatMessage, type ToolCall, type ToolDef } from './client';
import { blockLine, blockText, blockTexts, htmlToSlice, inlineContent, serializeDoc, type Block } from './doc';

const HTML_RULE = 'Write content as HTML using only p, h1, h2, h3, strong, em, u, s, ul, ol, li, table, tr, th, td, br and a — no markdown, no code fences, no wrapper element.';

export function chatSystemPrompt(): string {
  const styles = visibleStyles(styleSheet()).map((s) => s.name).join(', ');
  return [
    'You are the writing assistant of a word processor. Each user message starts with the document, one numbered paragraph per line.',
    'Answer in the language the user writes in, briefly. ' + HTML_RULE,
    'To change the document, call the tools. Paragraph numbers refer to the latest document and stay valid for the whole reply; paragraphs you insert are numbered from the next message on, so give inserted content its formatting in its HTML.',
    'Text changes become tracked changes the user accepts or rejects. After changing the document, say in one sentence what you did.',
    `Paragraph styles: ${styles}.`,
  ].join('\n');
}

export const REWRITE_PROMPT = `You rewrite a passage from a document. The passage comes as HTML. Reply with the rewritten passage only, keeping its formatting tags. ${HTML_RULE} Keep its language unless told to translate. No explanation.`;

export function draftPrompt(): string {
  return `You write new content for a document at the cursor; the document follows for context. Reply with the content only. ${HTML_RULE} Write in the document's language unless told otherwise. No preface, no explanation.`;
}

export const REWRITE_PRESETS = {
  rephrase: 'Rephrase it, keeping the meaning.',
  shorten: 'Make it shorter.',
  formal: 'Make it more formal.',
  fix: 'Correct spelling, grammar and punctuation; change nothing else.',
  translate: (language: string) => `Translate it into ${language}.`,
};

const num = (description: string) => ({ type: 'integer', description });
const str = (description: string) => ({ type: 'string', description });

export const TOOLS: ToolDef[] = [
  {
    name: 'read_paragraphs',
    description: 'Returns the numbered paragraphs from…to, for parts the document message omits.',
    parameters: { type: 'object', properties: { from: num('First paragraph'), to: num('Last paragraph') }, required: ['from', 'to'] },
  },
  {
    name: 'replace_text',
    description: 'Replaces a passage inside one paragraph; the replacement keeps the formatting of the passage. An empty replacement deletes it.',
    parameters: {
      type: 'object',
      properties: {
        paragraph: num('Paragraph number'),
        find: str('Exact text to replace, as it appears in the paragraph'),
        replace: str('Plain replacement text'),
        occurrence: num('Which occurrence of find, 1 by default'),
      },
      required: ['paragraph', 'find', 'replace'],
    },
  },
  {
    name: 'rewrite_paragraph',
    description: 'Replaces the whole text of one paragraph.',
    parameters: { type: 'object', properties: { paragraph: num('Paragraph number'), html: str('New text, inline HTML (strong, em, u, s, a, br)') }, required: ['paragraph', 'html'] },
  },
  {
    name: 'insert_paragraphs',
    description: 'Inserts new content after a paragraph (0 = at the start of the document).',
    parameters: { type: 'object', properties: { after: num('Paragraph number, or 0'), html: str('The content as HTML') }, required: ['after', 'html'] },
  },
  {
    name: 'delete_paragraphs',
    description: 'Deletes the text of the paragraphs from…to.',
    parameters: { type: 'object', properties: { from: num('First paragraph'), to: num('Last paragraph') }, required: ['from', 'to'] },
  },
  {
    name: 'format',
    description: 'Formats paragraphs from…to (to defaults to from), or only the occurrences of find in them. Booleans set (true) or clear (false); style sets the paragraph style.',
    parameters: {
      type: 'object',
      properties: {
        from: num('First paragraph'),
        to: num('Last paragraph'),
        find: str('Only this text inside the paragraphs'),
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        font: str('Font family'),
        size_pt: { type: 'number', description: 'Font size in points' },
        color: str('Font colour, #rrggbb'),
        style: str('Paragraph style name'),
      },
      required: ['from'],
    },
  },
  {
    name: 'add_comment',
    description: 'Adds a comment to a paragraph, or to the text find inside it.',
    parameters: { type: 'object', properties: { paragraph: num('Paragraph number'), find: str('Text to comment on'), text: str('The comment') }, required: ['paragraph', 'text'] },
  },
];

/** One turn's view of the document: numbers from its snapshot, positions mapped since. */
export type TurnContext = { editor: Editor; blocks: Block[]; mapping: Mapping; author: string };
export type ToolResult = { result: string; summary: string | null };

class ToolError extends Error {}

// The paragraph as it is now: the snapshot's node, followed through every edit since.
function current(ctx: TurnContext, n: unknown): { node: PMNode; pos: number; text: string; map: number[] } {
  const b = ctx.blocks[Number(n) - 1];
  if (!b) throw new ToolError(`no paragraph ${String(n)}; the document has ${ctx.blocks.length}`);
  const pos = ctx.mapping.map(b.from - 1, 1);
  const node = ctx.editor.state.doc.nodeAt(pos);
  if (!node?.isTextblock) throw new ToolError(`paragraph ${String(n)} no longer exists`);
  return { node, pos, ...blockText(node, pos) };
}

function contentRange(p: { node: PMNode; pos: number }): [number, number] {
  return [p.pos + 1, p.pos + 1 + p.node.content.size];
}

function findIn(p: { text: string; map: number[] }, find: string, occurrence = 1): [number, number] {
  let at = -1;
  for (let k = 0; k < Math.max(1, occurrence); k++) {
    at = p.text.indexOf(find, at + 1);
    if (at < 0) throw new ToolError(`text not found: "${find}"`);
  }
  return [p.map[at], p.map[at + find.length - 1] + 1];
}

function findAll(p: { text: string; map: number[] }, find: string): [number, number][] {
  const out: [number, number][] = [];
  for (let at = p.text.indexOf(find); at >= 0 && find; at = p.text.indexOf(find, at + find.length)) {
    out.push([p.map[at], p.map[at + find.length - 1] + 1]);
  }
  return out;
}

// A pending change by someone else in the range would be swallowed by a tracked edit
// over it (an insertion deleted outright, a deletion re-attributed), so it is refused.
function guardRevisions(ctx: TurnContext, from: number, to: number): void {
  let foreign = false;
  ctx.editor.state.doc.nodesBetween(from, to, (node) => {
    foreign ||= node.marks.some((m) => (m.type.name === 'insertion' || m.type.name === 'deletion') && m.attrs.author !== ctx.author);
    return !foreign;
  });
  if (foreign) throw new ToolError('the passage holds tracked changes by someone else; ask the user to accept or reject them first');
}

const plainMarks = (marks: readonly Mark[]) => marks.filter((m) => !['insertion', 'deletion', 'comment'].includes(m.type.name));

function dispatch(ctx: TurnContext, build: (tr: Transaction) => void): void {
  const tr = ctx.editor.state.tr;
  build(tr);
  ctx.editor.view.dispatch(tr);
}

function run(ctx: TurnContext, call: ToolCall): ToolResult {
  const a = parseArgs(call.args);
  const m = t().ai.tools;
  const { schema } = ctx.editor.state;
  switch (call.name) {
    case 'read_paragraphs': {
      const from = Math.max(1, Number(a.from) || 1);
      const lines = ctx.blocks.slice(from - 1, Math.min(ctx.blocks.length, Number(a.to) || from)).map(blockLine);
      return { result: lines.join('\n') || 'no such paragraphs', summary: null };
    }
    case 'replace_text': {
      const p = current(ctx, a.paragraph);
      const [from, to] = findIn(p, String(a.find ?? ''), Number(a.occurrence) || 1);
      guardRevisions(ctx, from, to);
      const replace = String(a.replace ?? '');
      const marks = plainMarks(ctx.editor.state.doc.nodeAt(from)?.marks ?? []);
      const slice = replace ? new Slice(Fragment.from(schema.text(replace, marks)), 0, 0) : null;
      dispatch(ctx, (tr) => trackedReplace(tr, from, to, slice, ctx.author));
      return { result: 'ok', summary: m.replace(Number(a.paragraph)) };
    }
    case 'rewrite_paragraph': {
      const p = current(ctx, a.paragraph);
      const [from, to] = contentRange(p);
      guardRevisions(ctx, from, to);
      const content = inlineContent(htmlToSlice(String(a.html ?? ''), ctx.editor.state), schema);
      dispatch(ctx, (tr) => trackedReplace(tr, from, to, content.size ? new Slice(content, 0, 0) : null, ctx.author));
      return { result: 'ok', summary: m.rewrite(Number(a.paragraph)) };
    }
    case 'insert_paragraphs': {
      const after = Number(a.after) || 0;
      let at: number;
      if (after <= 0) at = current(ctx, 1).pos;
      else {
        const p = current(ctx, after);
        // After a list item's or a cell's paragraph comes the whole list or table.
        const $p = ctx.editor.state.doc.resolve(p.pos);
        const top = $p.depth ? $p.node(1).type.name : '';
        at = $p.depth && top !== 'noteSection' && top !== 'textBox' ? $p.after(1) : p.pos + p.node.nodeSize;
      }
      const slice = htmlToSlice(String(a.html ?? ''), ctx.editor.state);
      if (!slice.size) throw new ToolError('nothing to insert');
      dispatch(ctx, (tr) => trackedReplace(tr, at, at, new Slice(slice.content, 0, 0), ctx.author));
      return { result: 'ok', summary: m.insert(after) };
    }
    case 'delete_paragraphs': {
      const fromN = Number(a.from);
      const toN = Number(a.to) || fromN;
      const from = contentRange(current(ctx, fromN))[0];
      const to = contentRange(current(ctx, toN))[1];
      if (to <= from) throw new ToolError('empty range');
      guardRevisions(ctx, from, to);
      dispatch(ctx, (tr) => trackedReplace(tr, from, to, null, ctx.author));
      return { result: 'ok', summary: m.delete(fromN, toN) };
    }
    case 'format': {
      const fromN = Number(a.from);
      const toN = Math.max(fromN, Number(a.to) || fromN);
      const style = typeof a.style === 'string' ? a.style : undefined;
      if (style && !styleSheet().paragraph[style]) throw new ToolError(`unknown paragraph style "${style}"`);
      const spec: FormatSpec = {
        bold: a.bold === true, italic: a.italic === true, underline: a.underline === true,
        font: typeof a.font === 'string' ? a.font : undefined,
        sizePt: typeof a.size_pt === 'number' ? a.size_pt : undefined,
        color: typeof a.color === 'string' ? a.color : undefined,
        style,
      };
      const ranges: [number, number][] = [];
      for (let n = fromN; n <= toN; n++) {
        const p = current(ctx, n);
        if (typeof a.find === 'string' && a.find) ranges.push(...findAll(p, a.find));
        else ranges.push(contentRange(p));
      }
      if (!ranges.length) throw new ToolError(`text not found: "${String(a.find)}"`);
      dispatch(ctx, (tr) => {
        for (const [from, to] of ranges) {
          applyFormat(tr, schema, from, to, spec, styleSheet());
          for (const name of FORMAT_MARKS) if (a[name] === false && schema.marks[name]) tr.removeMark(from, to, schema.marks[name]);
        }
      });
      return { result: 'ok', summary: m.format(fromN, toN) };
    }
    case 'add_comment': {
      if (!schema.marks.comment) throw new ToolError('comments are not available here');
      const p = current(ctx, a.paragraph);
      const [from, to] = typeof a.find === 'string' && a.find ? findIn(p, a.find) : contentRange(p);
      if (to <= from) throw new ToolError('empty paragraph');
      ctx.editor.chain().setTextSelection({ from, to }).addComment({ author: ctx.author, text: String(a.text ?? '') }).run();
      return { result: 'ok', summary: m.comment(Number(a.paragraph)) };
    }
    default:
      throw new ToolError(`unknown tool ${call.name}`);
  }
}

/** Runs one tool call; a failure goes back to the model as text, not as an exception. */
export function runTool(ctx: TurnContext, call: ToolCall): ToolResult {
  try {
    return run(ctx, call);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: `error: ${msg}`, summary: t().ai.tools.failed(msg) };
  }
}

// Every request in flight, so switching the assistant off stops them all at once.
const running = new Set<AbortController>();

export function startRequest(): AbortController {
  const c = new AbortController();
  running.add(c);
  return c;
}

export function endRequest(c: AbortController): void {
  running.delete(c);
}

export function abortAll(): void {
  for (const c of running) c.abort();
  running.clear();
}

const MAX_ROUNDS = 8;

/**
 * One chat turn: the question with the current document, then tool rounds until the
 * model answers without tools. `history` gains the question and the final answer.
 */
export async function runTurn(opts: {
  cfg: AiConfig;
  editor: Editor;
  history: ChatMessage[];
  question: string;
  author: string;
  onText: (delta: string) => void;
  onTool: (summary: string) => void;
  signal: AbortSignal;
}): Promise<string> {
  const { editor } = opts;
  const blocks = blockTexts(editor.state.doc);
  const ctx: TurnContext = { editor, blocks, mapping: new Mapping(), author: opts.author };
  const track = ({ transaction }: { transaction: Transaction }) => ctx.mapping.appendMapping(transaction.mapping);
  editor.on('transaction', track);
  const turn: ChatMessage[] = [{ role: 'user', content: `${serializeDoc(editor.state, blocks)}\n\n---\n\n${opts.question}` }];
  let answer = '';
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await streamChat(opts.cfg, { system: chatSystemPrompt(), messages: [...opts.history, ...turn], tools: TOOLS }, opts.onText, opts.signal);
      answer += res.text;
      turn.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
      if (!res.toolCalls.length) break;
      for (const call of res.toolCalls) {
        if (opts.signal.aborted) break;
        const r = runTool(ctx, call);
        if (r.summary) opts.onTool(r.summary);
        turn.push({ role: 'tool', id: call.id, content: r.result });
      }
    }
  } finally {
    editor.off('transaction', track);
  }
  opts.history.push({ role: 'user', content: opts.question }, { role: 'assistant', content: answer });
  return answer;
}
