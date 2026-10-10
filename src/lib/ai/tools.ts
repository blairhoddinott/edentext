// What the assistant may do to the document, and the chat turn that lets it. Text edits
// are tracked changes under the assistant's own author, for the user to accept or reject
// in the Review pane; formatting cannot be tracked and applies directly (undoable).

import type { Editor } from '@tiptap/core';
import { Fragment, Slice, type Mark, type Node as PMNode } from '@tiptap/pm/model';
import { Mapping } from '@tiptap/pm/transform';
import { NodeSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { isPaginating } from '../editor/extensions/pageBreaks';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { trackedReplace } from '../editor/extensions/trackChanges';
import { applyFormat, FORMAT_MARKS, type FormatSpec } from '../editor/extensions/searchReplace';
import { comments } from '../editor/extensions/comment';
import { putStyle, setOutline, styleSheet } from '../styles/sheet.svelte';
import { decimalOutline, romanOutline } from '../styles/outlineNumbering';
import { DEFAULT_BORDER_COLOR, DEFAULT_BORDER_WIDTH_PT } from '../editor/extensions/tableCellBorders';
import { normalizeColor } from '../utils/color';
import { BOX_WRAP_GAP, PICTURE_WRAP_GAP, droppedFrameAttrs, restackFrame, wrapGap, wrapGapAttr, type WrapMode } from '../editor/extensions/image';
import { CAPTION_STYLE } from '../editor/extensions/caption';
import { DEFAULT_STYLE, visibleStyles, type Style } from '../styles/styleSheet';
import { styleLabel, t } from '../i18n/i18n.svelte';
import { docBudget, type AiConfig, type AiMode } from '../storage/ai.svelte';
import { streamChat, parseArgs, type ChatMessage, type ToolCall, type ToolDef } from './client';
import { blockLine, blockText, blockTexts, cellAt, isFrame, htmlToSlice, type CellAt, inlineContent, pageLayout, serializeDoc, stripFences, zoneDocFromHtml, fillNotes, type Block } from './doc';
import { borderAttr, nameLookup, parseMargins, splitDocumentHtml, type NoteText, type PageSpec } from './dialect';
import { PAGE_FORMAT_CM, type PageFormat } from '../storage/pageFormat';
import type { Orientation } from '../storage/pageOrientation';
import type { PageMargins } from '../storage/pageMargins';
import type { HfDoc, HfVariant, HfZone } from '../storage/headerFooter';
import { LANGUAGES, codeForTag, findLanguage, odfFromTag, tagForLanguage, type DocumentLanguage } from '../storage/documentLanguage';

// What a model writes anyway (semantic tags, plain CSS); ai/dialect.ts maps it onto the
// editor's nodes. Short enough for a small local model to keep in view.
export const HTML_GUIDE = [
  'Write content as HTML: no markdown, no code fences, no wrapper element. Use p, h1–h3, strong, em, u, s, sub, sup, mark, a, br, ul, ol, li, table, tr, th, td.',
  'Paragraph style: <p class="…"> with a style name listed below. Paragraph CSS: text-align, margin-top/margin-bottom (pt), margin-left, text-indent (cm), line-height, background, border, border-bottom, font-size, font-family, color.',
  'Run CSS on <span>: font-size, font-family, color. <hr> starts a new page.',
  'Tables: <td width="30%"> or <col width="30%"> sets column widths; <table border="0"> removes the lines; td takes background and vertical-align.',
  'A text box: <aside style="width:5cm;height:6cm;float:right">…</aside>, anchored to the paragraph after it; margin sets a frame\'s space to the text. A picture placeholder: <img alt="Photo" width="4cm" height="5cm"> without src (no other images).',
  'A footnote: <sup class="footnote">its text</sup> where the anchor goes (class="endnote" for an endnote). A fill-in field: <input placeholder="Your name">. Today\'s date: <time></time>. Text columns: <section columns="2">…</section>. A table of contents: <nav></nav>. Tabs stay tabs.',
  'Page header and footer: <header>…</header>, <footer>…</footer>, with {page} and {pages} as page fields; data-page="first" or "even" for those pages only. Page setup: <page size="A4" orientation="portrait" margin="2cm">, with the size (A5, letter, …), orientation (landscape) and margins the request asks for.',
  'Shape of a CV (fill in the real content, never these dots): <h1>…</h1><aside style="width:4cm;height:5cm;float:right"><p><img alt="Photo" width="3.5cm" height="4.5cm"></p></aside><p><input placeholder="…"></p><h2>…</h2><table border="0"><tr><td width="25%">…</td><td><strong>…</strong> …</td></tr></table>',
].join('\n');

export function chatSystemPrompt(mode: AiMode = 'edit'): string {
  const styles = visibleStyles(styleSheet()).map((s) => styleLabel(s.name)).join(', ');
  const edit = mode === 'edit';
  return [
    'You are the writing assistant in edentext, a word processor that runs in the browser and saves .odt and .docx. Each user message starts with the document, one numbered paragraph per line.',
    'Answer in the language the user writes in, briefly.',
    HTML_GUIDE,
    'Formatting follows a paragraph in braces, as {bold: "word"; style "Quote"}; "all" means the whole paragraph. It is not part of the text and lists only what the paragraph style does not already give.',
    'In the text, {image "alt text"} is a picture (you see only its alt text), ‹Name› a placeholder to fill in and {date} a date field; replace_text can replace each as a whole.',
    'A number after li or a heading level, as [57 li VI], is the number the page shows. [12–28] (empty) stands for empty paragraphs 12 to 28. — page 2 — lines mark where a page starts.',
    `— 2 columns — lines mark where text columns start or end${edit ? '; set_columns changes them' : ''}. The page setup, the language and the page headers and footers are shown after the document${edit ? '; set_page, set_language and set_header_footer change them' : ''}.`,
    edit ? 'Comments follow the document as [C1 …]; answer one with reply_comment, close it with resolve_comment.' : 'Comments follow the document as [C1 …].',
    'A table cell\'s paragraph is marked [n cell T1 r2 c3]: table 1, row 2, column 3, and a text box\'s [n box 1].',
    ...(edit ? EDIT_LINES : CHAT_LINES),
    'When your answer refers to a place in the document, cite the paragraph as ¶12 (¶12–14 for a range); the user can click it to go there.',
    `Style names for <p class="…"> (never text of their own): ${styles}.`,
  ].join('\n');
}

// Chat mode offers no tool that changes the document; a reply is text the user may copy.
const CHAT_LINES = [
  'You cannot change the document in this mode. When asked for a change, write the new text in your answer as HTML the user can copy, or tell them to switch to Edit mode.',
];

const EDIT_LINES = [
  'Change a table (rows, columns, widths, merging, shading, borders) with the table tool, never by rebuilding it.',
  'Formatting meant for every paragraph of a kind (a rule under each heading, a colour, spacing) goes into its style with set_style, not onto each paragraph. Frames (a text box, a picture placeholder) go in with insert_frame or in the HTML, and the frame tool changes, moves, stacks, captions or deletes one listed as frame 1 in its paragraph\'s formatting.',
  'To change the document, call the tools. Paragraph numbers refer to the latest document and stay valid for the whole reply; paragraphs you insert are numbered from the next message on, so give inserted content its formatting in its HTML.',
  'Text changes become tracked changes the user accepts or rejects. After changing the document, say in one sentence what you did, and say so when you assumed something the document does not state.',
];

const READ_TOOLS = new Set(['read_paragraphs']);

export const REWRITE_PROMPT = `You rewrite a passage from a document. The passage comes as HTML. Reply with the rewritten passage only, keeping its formatting tags. Write HTML, no markdown, no code fences, no wrapper element. Keep its language unless told to translate. No explanation.`;

/** The draft prompt; only a draft into an empty document sets its header, footer and page. */
export function draftPrompt(emptyDocument = false): string {
  const styles = visibleStyles(styleSheet()).map((s) => styleLabel(s.name)).join(', ');
  const parts = emptyDocument ? 'The document is empty: write the whole document, with its page setup, header and footer where it needs them.' : 'Do not write <header>, <footer> or <page>: the document has its own.';
  return `You write new content for a document at the cursor; the document follows for context. Reply with the content only. Write in the document's language unless told otherwise. No preface, no explanation.\n${HTML_GUIDE}\n${parts}\nStyle names for <p class="…"> (never text of their own): ${styles}.`;
}

export const REWRITE_PRESETS = {
  rephrase: 'Rephrase it, keeping the meaning.',
  shorten: 'Make it shorter.',
  formal: 'Make it more formal.',
  fix: 'Correct spelling, grammar and punctuation; change nothing else.',
  translate: (language: string) => `Translate it into ${language}.`,
};

const TABLE_ACTIONS = ['row_above', 'row_below', 'column_left', 'column_right', 'delete_row', 'delete_column', 'widths', 'merge_right', 'shade', 'borders', 'style'];

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
        highlight: str('Highlight colour, #rrggbb, or none'),
        style: str('Paragraph style name'),
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        space_before_pt: { type: 'number' },
        space_after_pt: { type: 'number' },
        indent_cm: { type: 'number' },
        line_height: { type: 'number', description: 'Line spacing, 1 = single' },
        background: str('Paragraph shading, #rrggbb, or none'),
        page_break_before: { type: 'boolean' },
        list: { type: 'string', enum: ['bullet', 'number', 'none'] },
      },
      required: ['from'],
    },
  },
  {
    name: 'set_style',
    description: 'Creates or changes a paragraph style; every paragraph in it follows.',
    parameters: {
      type: 'object',
      properties: {
        name: str('Style name'),
        based_on: str('Parent style of a new style'),
        font: str('Font family'),
        size_pt: { type: 'number' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        color: str('#rrggbb'),
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        space_before_pt: { type: 'number' },
        space_after_pt: { type: 'number' },
        border: str('A rule on all four sides as CSS, 1pt solid #4b5563; none removes it'),
        border_top: str('The rule above, as border'),
        border_bottom: str('The rule below, as border'),
        heading_numbers: { type: 'string', enum: ['none', '1.1', 'I.'], description: 'Numbering of all heading levels' },
      },
      required: ['name'],
    },
  },
  {
    name: 'insert_frame',
    description: 'Anchors a text box or a picture placeholder at the start of a paragraph.',
    parameters: {
      type: 'object',
      properties: {
        paragraph: num('Paragraph number'),
        kind: { type: 'string', enum: ['text_box', 'picture'] },
        width_cm: { type: 'number' },
        height_cm: { type: 'number' },
        wrap: { type: 'string', enum: ['left', 'right', 'inline'], description: 'Which side the frame floats to' },
        gap_cm: str('Space between the frame and the text: one number, or four: top right bottom left'),
        html: str('Text box content as HTML, or the picture\'s label'),
      },
      required: ['paragraph', 'kind'],
    },
  },
  {
    name: 'frame',
    description: 'Changes a frame (picture or text box) in a paragraph: wrap, size, position, rotation, stacking order, anchor paragraph, a picture\'s caption, or deletes it.',
    parameters: {
      type: 'object',
      properties: {
        paragraph: num('Paragraph number'),
        frame: num('The frame\'s number in the paragraph, as frame 1; 1 by default'),
        wrap: { type: 'string', enum: ['left', 'right', 'top_bottom', 'inline', 'in_front', 'behind'], description: 'left/right: text flows beside it; top_bottom: text only above and below; inline: in the line like a character; in_front/behind: free, over or under the text' },
        width_cm: { type: 'number' },
        height_cm: { type: 'number' },
        gap_cm: str('Space between the frame and the text: one number, or four: top right bottom left'),
        x_cm: num('Its left edge, in cm from the left edge of the text column'),
        y_cm: num('Its top edge, in cm below what y_from names'),
        y_from: { type: 'string', enum: ['paragraph', 'page', 'margin'], description: 'What y_cm counts from: the anchor paragraph (default), the top of the page, or the top of the page\'s text area' },
        rotation: num('Degrees clockwise'),
        stack: { type: 'string', enum: ['front', 'back', 'forward', 'backward'], description: 'Order among the frames in front of or behind the text' },
        move_to: num('Anchors the frame at the start of this paragraph instead'),
        caption: str('A caption under a picture: picture and caption then form one frame'),
        delete: { type: 'boolean', description: 'Deletes the frame' },
      },
      required: ['paragraph'],
    },
  },
  {
    name: 'reply_comment',
    description: 'Replies to a comment thread.',
    parameters: { type: 'object', properties: { comment: num('Comment number, as C1 → 1'), text: str('The reply') }, required: ['comment', 'text'] },
  },
  {
    name: 'resolve_comment',
    description: 'Marks a comment thread as resolved.',
    parameters: { type: 'object', properties: { comment: num('Comment number, as C1 → 1') }, required: ['comment'] },
  },
  {
    name: 'table',
    description: 'Changes the table around a paragraph\'s cell: rows, columns, widths, merging, shading, borders, style.',
    parameters: {
      type: 'object',
      properties: {
        paragraph: num('A paragraph in the cell'),
        action: { type: 'string', enum: TABLE_ACTIONS },
        cells: { type: 'array', items: { type: 'string' }, description: 'New row or column: its cells as HTML, in order; a cell takes several paragraphs or a list' },
        widths: { type: 'array', items: { type: 'number' }, description: 'widths: one relative width per column, as 25, 75' },
        color: str('shade: the cell\'s background, #rrggbb, or none'),
        borders: { type: 'string', enum: ['all', 'outer', 'inner', 'none'] },
        style: str('style: a table style name'),
      },
      required: ['paragraph', 'action'],
    },
  },
  {
    name: 'set_header_footer',
    description: 'Sets or removes (empty html) the page header or footer.',
    parameters: {
      type: 'object',
      properties: {
        zone: { type: 'string', enum: ['header', 'footer'] },
        pages: { type: 'string', enum: ['all', 'first', 'even'], description: 'Which pages, all by default' },
        html: str('Content as HTML; {page} and {pages} are page fields'),
      },
      required: ['zone', 'html'],
    },
  },
  {
    name: 'set_language',
    description: 'Sets the language of the document, or of paragraphs from…to; spelling and hyphenation follow it.',
    parameters: { type: 'object', properties: { language: str('A language name or tag, as English (UK) or en-GB'), from: num('First paragraph, for only some'), to: num('Last paragraph') }, required: ['language'] },
  },
  {
    name: 'set_page',
    description: 'Changes the page size, orientation, margins or first page number.',
    parameters: {
      type: 'object',
      properties: {
        size: { type: 'string', enum: Object.keys(PAGE_FORMAT_CM) },
        orientation: { type: 'string', enum: ['portrait', 'landscape'] },
        margins_cm: str('One number for all sides, or four: top right bottom left'),
        page_numbers_start: num('The first page\'s number'),
      },
    },
  },
  {
    name: 'set_columns',
    description: 'Sets the text of paragraphs from…to in 1 to 3 columns. Inside a section that already has columns it changes the whole section; 1 removes the columns.',
    parameters: { type: 'object', properties: { from: num('First paragraph'), to: num('Last paragraph'), count: num('Number of columns, 1–3') }, required: ['from', 'count'] },
  },
  {
    name: 'add_comment',
    description: 'Adds a comment to a paragraph, or to the text find inside it.',
    parameters: { type: 'object', properties: { paragraph: num('Paragraph number'), find: str('Text to comment on'), text: str('The comment') }, required: ['paragraph', 'text'] },
  },
];

/** What the app holds beside the text and lets the assistant set (App.svelte). */
export type PageSetup = { format?: PageFormat; orientation?: Orientation; margins?: Partial<PageMargins>; start?: number };
export type AiHost = {
  setZone: (zone: HfZone, variant: HfVariant, doc: HfDoc) => void;
  setPage: (page: PageSetup) => void;
  /** The document's language, a code from LANGUAGES. */
  setLanguage?: (code: DocumentLanguage) => void;
};

/** One turn's view of the document: numbers from its snapshot, positions mapped since. */
export type TurnContext = { editor: Editor; blocks: Block[]; mapping: Mapping; author: string; commentIds?: string[]; host?: AiHost; allowed?: Set<string> };

const pageFormat = (name: unknown) => (Object.keys(PAGE_FORMAT_CM) as PageFormat[]).find((f) => f.toLowerCase() === String(name).trim().toLowerCase().replace(/^iso\s*/, 'iso'));

/** A `<page>` spec as the setup to apply; an unknown size or orientation is an error. */
function pageSetup(spec: PageSpec): PageSetup {
  const out: PageSetup = {};
  if (spec.size) {
    out.format = pageFormat(spec.size);
    if (!out.format) throw new ToolError(`unknown page size "${spec.size}"; sizes are: ${Object.keys(PAGE_FORMAT_CM).join(', ')}`);
  }
  if (spec.orientation) {
    if (spec.orientation !== 'portrait' && spec.orientation !== 'landscape') throw new ToolError('orientation is portrait or landscape');
    out.orientation = spec.orientation;
  }
  if (spec.margins) out.margins = spec.margins;
  if (spec.start != null) out.start = spec.start;
  return out;
}

/**
 * Puts a reply's header, footer and page setup in place through the host; returns their
 * summaries and leaves the body HTML. Without a host they are refused.
 */
export function applyDocumentParts(html: string, host: AiHost | undefined, dropped: string[] = []): { body: string; summaries: string[] } {
  const { body, zones, page } = splitDocumentHtml(stripFences(html));
  const summaries: string[] = [];
  if ((zones.length || page) && !host) throw new ToolError('headers, footers and the page setup cannot be changed here');
  for (const z of zones) {
    const doc = zoneDocFromHtml(z.html, dropped);
    host!.setZone(z.zone, z.variant, doc);
    summaries.push(t().ai.tools.zone(z.zone === 'footer', !doc));
  }
  if (page) {
    host!.setPage(pageSetup(page));
    summaries.push(t().ai.tools.page);
  }
  return { body, summaries };
}

// Small models send numbers and booleans as strings too.
const numArg = (v: unknown): number | undefined => (v === '' || v == null || !Number.isFinite(Number(v)) ? undefined : Number(v));
const gapArg = (v: unknown) => (v == null || v === '' ? undefined : parseMargins(Array.isArray(v) ? v.join(' ') : String(v)));
const boolArg = (v: unknown): boolean | undefined => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);
const colorArg = (v: unknown, what: string): string | null | undefined => {
  if (v == null || v === '') return undefined;
  if (/^(none|transparent)$/i.test(String(v))) return null;
  const c = normalizeColor(String(v));
  if (!c) throw new ToolError(`${what} is a colour as #rrggbb, or none`);
  return c;
};
const ALIGNS = ['left', 'center', 'right', 'justify'];
const alignArg = (v: unknown) => {
  if (v == null || v === '') return undefined;
  const a = String(v).toLowerCase().replace('centre', 'center');
  if (!ALIGNS.includes(a)) throw new ToolError(`align is one of ${ALIGNS.join(', ')}`);
  return a as 'left' | 'center' | 'right' | 'justify';
};

const withDropped = (dropped: string[]) => (dropped.length ? `ok; left out: ${dropped.join('; ')}` : 'ok');
export type ToolResult = { result: string; summary: string | null };

class ToolError extends Error {}

// The paragraph as it is now: the snapshot's node, followed through every edit since.
const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

/** A language name ("English (UK)", "German") or tag ("en-GB") as a code from LANGUAGES. */
function languageCode(asked: string): DocumentLanguage | null {
  const q = asked.toLowerCase();
  const hit = LANGUAGES.find((l) => [l.label, l.code, tagForLanguage(l.code) ?? '', LANGUAGE_NAMES.of(l.code) ?? ''].some((n) => n.toLowerCase() === q));
  return hit?.code ?? (odfFromTag(asked) ? codeForTag(asked) : null)
    ?? LANGUAGES.find((l) => (LANGUAGE_NAMES.of(l.code) ?? '').toLowerCase().startsWith(q))?.code ?? null;
}

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

// A form's blank (a run of dots, an ellipsis or underscores) matches any such run, since
// a model cannot be relied on to copy 136 dots exactly.
const BLANK = /[.…_]{3,}|…+/g;

function findIn(p: { text: string; map: number[] }, find: string, occurrence = 1): [number, number] {
  const pattern = find.split(BLANK).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(`(?:${BLANK.source})`);
  const re = new RegExp(pattern, 'g');
  let m: RegExpExecArray | null = null;
  for (let k = 0; k < Math.max(1, occurrence); k++) {
    m = re.exec(p.text);
    if (!m || !m[0]) throw new ToolError(`text not found: "${find}"`);
  }
  return [p.map[m!.index], p.map[m!.index + m![0].length - 1] + 1];
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

function setList(ctx: TurnContext, from: number, to: number, kind: string): void {
  const ed = ctx.editor;
  ed.commands.setTextSelection({ from, to });
  if (kind === 'none') {
    for (let i = 0; i < 10 && ed.isActive('listItem'); i++) if (!ed.commands.liftListItem('listItem')) break;
    return;
  }
  const type = ['number', 'numbered', 'ordered'].includes(kind) ? 'orderedList' : ['bullet', 'bullets', 'unordered'].includes(kind) ? 'bulletList' : null;
  if (!type) throw new ToolError('list is bullet, number or none');
  if (!ed.isActive(type) && !(type === 'orderedList' ? ed.commands.toggleOrderedList() : ed.commands.toggleBulletList())) throw new ToolError('these paragraphs cannot become a list');
}

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The table actions other than inserting: they apply directly, like the ribbon's. */
function tableChange(ctx: TurnContext, pos: number, at: CellAt, action: string, a: Record<string, unknown>): string {
  const ed = ctx.editor;
  const into = () => ed.chain().setTextSelection(pos + 1);
  const ok = (done: boolean, why: string) => { if (!done) throw new ToolError(why); return 'ok'; };
  switch (action) {
    case 'delete_row': return ok(into().deleteRow().run(), 'the row cannot be deleted');
    case 'delete_column': return ok(into().deleteColumn().run(), 'the column cannot be deleted');
    case 'merge_right': {
      const table = ed.state.doc.nodeAt(at.tablePos)!;
      const map = TableMap.get(table);
      const start = at.tablePos + 1;
      const here = map.map[(at.row - 1) * map.width + at.col - 1];
      const rect = map.findCell(here);
      if (rect.right >= map.width) throw new ToolError('there is no cell to the right');
      const right = map.map[(at.row - 1) * map.width + rect.right];
      ed.view.dispatch(ed.state.tr.setSelection(CellSelection.create(ed.state.doc, start + here, start + right)));
      return ok(ed.commands.mergeCells(), 'the cells cannot be merged');
    }
    case 'shade': {
      const color = colorArg(a.color, 'color');
      if (color === undefined) throw new ToolError('give color');
      return ok(into().setCellAttribute('backgroundColor', color).run(), 'the cell cannot be shaded');
    }
    case 'borders': {
      const kind = String(a.borders ?? 'all').toLowerCase();
      if (!['all', 'outer', 'inner', 'none'].includes(kind)) throw new ToolError('borders is all, outer, inner or none');
      const table = ed.state.doc.nodeAt(at.tablePos)!;
      ed.view.dispatch(ed.state.tr.setSelection(CellSelection.create(ed.state.doc, at.tablePos + 2, at.tablePos + table.nodeSize - 2 - table.lastChild!.lastChild!.nodeSize)));
      const spec = { widthPt: DEFAULT_BORDER_WIDTH_PT, color: DEFAULT_BORDER_COLOR };
      return ok(kind === 'none' ? ed.commands.setTableBorders('all', null) : ed.commands.setTableBorders(kind as 'all' | 'outer' | 'inner', spec), 'the borders cannot be set');
    }
    case 'style': {
      const name = nameLookup(Object.keys(styleSheet().table), styleLabel)(String(a.style ?? ''));
      if (!name) throw new ToolError(`unknown table style "${String(a.style ?? '')}"; styles are: ${Object.keys(styleSheet().table).map(styleLabel).join(', ')}`);
      return ok(into().setTableStyle(name).run(), 'the style cannot be set');
    }
    case 'widths': {
      const widths = (Array.isArray(a.widths) ? a.widths : String(a.widths ?? '').split(/[\s,]+/)).map(Number);
      const table = ed.state.doc.nodeAt(at.tablePos)!;
      const map = TableMap.get(table);
      if (widths.length !== map.width || widths.some((w) => !(w > 0))) throw new ToolError(`give ${map.width} positive widths, one per column`);
      dispatch(ctx, (tr) => {
        const seen = new Set<number>();
        for (let i = 0; i < map.map.length; i++) {
          const cellPos = map.map[i];
          if (seen.has(cellPos)) continue;
          seen.add(cellPos);
          const rect = map.findCell(cellPos);
          tr.setNodeAttribute(at.tablePos + 1 + cellPos, 'colwidth', widths.slice(rect.left, rect.right).map((w) => Math.round(w)));
        }
      });
      return 'ok';
    }
  }
  throw new ToolError(`unknown action "${action}"`);
}

function dispatch(ctx: TurnContext, build: (tr: Transaction) => void): void {
  const tr = ctx.editor.state.tr;
  build(tr);
  ctx.editor.view.dispatch(tr);
}

// A captioned picture is one frame, as LibreOffice draws it: a borderless text box in
// the picture's place holding the picture in its line and the caption under it.
function captionFrame(ctx: TurnContext, pos: number, text: string): number {
  const { schema, doc } = ctx.editor.state;
  const pic = doc.nodeAt(pos)!;
  const keep = ['width', 'wrap', 'wrapOffset', 'wrapOffsetY', 'wrapFromPage', 'wrapFromBody', 'wrapDist', 'anchorPage', 'zIndex', 'inFront'] as const;
  const boxAttrs: Record<string, unknown> = { fillColor: null, strokeColor: null, paddingCm: 0 };
  for (const k of keep) boxAttrs[k] = pic.attrs[k];
  if (boxAttrs.wrap === 'inline') boxAttrs.wrap = 'topBottom';
  // At least the picture and a caption line; it grows with a longer caption.
  boxAttrs.height = (pic.attrs.height as number) + Math.round(0.8 * (96 / 2.54));
  const inner = pic.type.create({ ...pic.attrs, wrap: 'inline', ...droppedFrameAttrs('inline', false, pic.attrs.wrap), wrapDist: null, zIndex: 0 }, null, pic.marks);
  const box = schema.nodes.textBox.create(boxAttrs, [
    schema.nodes.paragraph.create(null, inner),
    schema.nodes.paragraph.create({ styleName: CAPTION_STYLE }, schema.text(text)),
  ], pic.marks);
  dispatch(ctx, (tr) => tr.replaceWith(pos, pos + pic.nodeSize, box));
  return pos;
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
      const notes: NoteText[] = [];
      const content = inlineContent(htmlToSlice(String(a.html ?? ''), ctx.editor.state, [], notes), schema);
      dispatch(ctx, (tr) => trackedReplace(tr, from, to, content.size ? new Slice(content, 0, 0) : null, ctx.author));
      fillNotes(ctx.editor, notes, ctx.author);
      return { result: 'ok', summary: m.rewrite(Number(a.paragraph)) };
    }
    case 'insert_paragraphs': {
      const dropped: string[] = [];
      const parts = applyDocumentParts(String(a.html ?? ''), ctx.host, dropped);
      if (!parts.body.trim()) {
        if (!parts.summaries.length) throw new ToolError('nothing to insert');
        return { result: withDropped(dropped), summary: parts.summaries.join('; ') };
      }
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
      const notes: NoteText[] = [];
      const slice = htmlToSlice(parts.body, ctx.editor.state, dropped, notes);
      if (!slice.size) throw new ToolError(dropped.length ? `nothing to insert: ${dropped.join('; ')}` : 'nothing to insert');
      dispatch(ctx, (tr) => trackedReplace(tr, at, at, new Slice(slice.content, 0, 0), ctx.author));
      fillNotes(ctx.editor, notes, ctx.author);
      return { result: withDropped(dropped), summary: [m.insert(after), ...parts.summaries].join('; ') };
    }
    case 'delete_paragraphs': {
      const fromN = Number(a.from);
      const toN = Number(a.to) || fromN;
      const from = contentRange(current(ctx, fromN))[0];
      const to = contentRange(current(ctx, toN))[1];
      guardRevisions(ctx, from, to);
      if (to > from) dispatch(ctx, (tr) => trackedReplace(tr, from, to, null, ctx.author));
      // Nothing tracks a paragraph's own removal, so one left empty goes directly (undoable);
      // a cell or a frame keeps its last paragraph.
      const empty: number[] = [];
      for (let n = toN; n >= fromN; n--) {
        const p = current(ctx, n);
        if (!p.node.content.size && ctx.editor.state.doc.resolve(p.pos).parent.childCount > 1) empty.push(p.pos);
      }
      if (to <= from && !empty.length) throw new ToolError('empty range');
      if (empty.length) dispatch(ctx, (tr) => { for (const pos of empty) tr.delete(pos, pos + tr.doc.nodeAt(pos)!.nodeSize); });
      return { result: 'ok', summary: m.delete(fromN, toN) };
    }
    case 'format': {
      const fromN = Number(a.from);
      const toN = Math.max(fromN, Number(a.to) || fromN);
      const sheet = styleSheet();
      const style = typeof a.style === 'string' ? nameLookup(Object.keys(sheet.paragraph), styleLabel)(a.style) ?? undefined : undefined;
      if (typeof a.style === 'string' && !style) throw new ToolError(`unknown paragraph style "${a.style}"; styles are: ${visibleStyles(sheet).map((x) => styleLabel(x.name)).join(', ')}`);
      const spec: FormatSpec = {
        bold: boolArg(a.bold) === true, italic: boolArg(a.italic) === true, underline: boolArg(a.underline) === true,
        font: typeof a.font === 'string' ? a.font : undefined,
        sizePt: numArg(a.size_pt),
        color: typeof a.color === 'string' ? a.color : undefined,
        style,
      };
      const highlight = colorArg(a.highlight, 'highlight');
      // What a paragraph holds as its own attributes, whatever `find` narrows the runs to.
      const block: Record<string, unknown> = {};
      const align = alignArg(a.align);
      if (align) block.textAlign = align;
      if (numArg(a.space_before_pt) != null) block.spaceBefore = numArg(a.space_before_pt);
      if (numArg(a.space_after_pt) != null) block.spaceAfter = numArg(a.space_after_pt);
      if (numArg(a.indent_cm) != null) block.indent = numArg(a.indent_cm) || null;
      if (numArg(a.line_height) != null) block.lineHeight = String(numArg(a.line_height));
      const bg = colorArg(a.background, 'background');
      if (bg !== undefined) block.backgroundColor = bg;
      const breakBefore = boolArg(a.page_break_before);
      if (breakBefore != null) block.breakBefore = breakBefore ? 'page' : null;
      const paras = Array.from({ length: toN - fromN + 1 }, (_, k) => current(ctx, fromN + k));
      const ranges: [number, number][] = [];
      for (const p of paras) {
        if (typeof a.find === 'string' && a.find) ranges.push(...findAll(p, a.find));
        else ranges.push(contentRange(p));
      }
      if (!ranges.length) throw new ToolError(`text not found: "${String(a.find)}"`);
      dispatch(ctx, (tr) => {
        for (const [from, to] of ranges) {
          applyFormat(tr, schema, from, to, spec, styleSheet());
          for (const name of FORMAT_MARKS) if (boolArg(a[name]) === false && schema.marks[name]) tr.removeMark(from, to, schema.marks[name]);
          if (highlight === null) tr.removeMark(from, to, schema.marks.highlight);
          else if (highlight) tr.addMark(from, to, schema.marks.highlight.create({ color: highlight }));
        }
        for (const p of paras) {
          const pos = tr.mapping.map(p.pos);
          for (const [attr, value] of Object.entries(block)) if (attr in p.node.attrs) tr.setNodeAttribute(pos, attr, value);
        }
      });
      if (a.list != null && a.list !== '') setList(ctx, current(ctx, fromN).pos + 1, contentRange(current(ctx, toN))[1], String(a.list).toLowerCase());
      return { result: 'ok', summary: m.format(fromN, toN) };
    }
    case 'table':
    case 'table_insert': {
      const p = current(ctx, a.paragraph);
      const at = cellAt(ctx.editor.state.doc, p.pos);
      if (!at) throw new ToolError(`paragraph ${String(a.paragraph)} is not in a table`);
      const where = String(a.action ?? a.where ?? '').toLowerCase();
      if (!TABLE_ACTIONS.includes(where)) throw new ToolError(`action is one of ${TABLE_ACTIONS.join(', ')}`);
      if (!where.startsWith('row_') && !where.startsWith('column_')) return { result: tableChange(ctx, p.pos, at, where, a), summary: m.table(at.table) };
      const chain = ctx.editor.chain().setTextSelection(p.pos + 1);
      const done = where === 'row_above' ? chain.addRowBefore().run()
        : where === 'row_below' ? chain.addRowAfter().run()
        : where === 'column_left' ? chain.addColumnBefore().run()
        : chain.addColumnAfter().run();
      if (!done) throw new ToolError('the table cannot take a row or column there');
      // The structure cannot be tracked; the new cells' text is, as any insertion.
      const table = ctx.editor.state.doc.nodeAt(at.tablePos)!;
      const map = TableMap.get(table);
      const row = where.startsWith('row');
      const line = row ? (where === 'row_above' ? at.row - 1 : at.row) : (where === 'column_left' ? at.col - 1 : at.col);
      const cells = [...new Set(Array.from({ length: row ? map.width : map.height }, (_, k) => map.map[row ? line * map.width + k : k * map.width + line]))];
      const texts = Array.isArray(a.cells) ? a.cells.map(String) : [];
      dispatch(ctx, (tr) => {
        for (let k = Math.min(cells.length, texts.length) - 1; k >= 0; k--) {
          const slice = htmlToSlice(texts[k], ctx.editor.state);
          const into = at.tablePos + 1 + cells[k] + 2;
          // Several paragraphs or a list take the new cell's empty paragraph's place; inline
          // content goes into it and keeps the formatting the row copied.
          const blocks = slice.content;
          if (blocks.childCount > 1 || (blocks.firstChild && !blocks.firstChild.isInline && !blocks.firstChild.isTextblock)) {
            const para = tr.doc.nodeAt(into - 1)!;
            trackedReplace(tr, into - 1 + para.nodeSize, into - 1 + para.nodeSize, new Slice(blocks, 0, 0), ctx.author);
            tr.delete(into - 1, into - 1 + para.nodeSize);
            continue;
          }
          const content = inlineContent(slice, schema);
          if (content.size) trackedReplace(tr, into, into, new Slice(content, 0, 0), ctx.author);
        }
      });
      return { result: 'ok', summary: row ? m.row(at.table) : m.column(at.table) };
    }
    case 'set_columns': {
      const count = Math.round(Number(a.count));
      if (!(count >= 1 && count <= 3)) throw new ToolError('count must be 1, 2 or 3');
      const p = current(ctx, a.from);
      const q = current(ctx, a.to ?? a.from);
      const [from, to] = [p.pos + 1, q.pos + 1 + q.node.content.size];
      // A bare cursor would give the whole document columns.
      if (from >= to) throw new ToolError('the paragraphs are empty; name a range that holds text');
      if (!ctx.editor.chain().setTextSelection({ from, to }).setColumns(count).run()) throw new ToolError('columns cannot be set there (a table or frame in the range, or no columns to remove)');
      return { result: 'ok', summary: m.textColumns(count) };
    }
    case 'set_style': {
      const sheet = styleSheet();
      const lookup = nameLookup(Object.keys(sheet.paragraph), styleLabel);
      const name = String(a.name ?? '').trim();
      if (!name) throw new ToolError('name the style');
      const known = lookup(name);
      const parent = a.based_on ? lookup(String(a.based_on)) : null;
      if (a.based_on && !parent) throw new ToolError(`unknown style "${String(a.based_on)}"; styles are: ${visibleStyles(sheet).map((x) => styleLabel(x.name)).join(', ')}`);
      const base: Style = known ? sheet.paragraph[known] : { name, parent: parent ?? DEFAULT_STYLE, next: null, para: {}, text: {} };
      const text = { ...base.text };
      const para = { ...base.para };
      if (typeof a.font === 'string' && a.font) text.fontFamily = a.font;
      if (numArg(a.size_pt)) text.fontSizePt = numArg(a.size_pt);
      if (boolArg(a.bold) != null) text.bold = boolArg(a.bold);
      if (boolArg(a.italic) != null) text.italic = boolArg(a.italic);
      const color = colorArg(a.color, 'color');
      if (color !== undefined) text.color = color ?? undefined;
      const align = alignArg(a.align);
      if (align) para.textAlign = align;
      if (numArg(a.space_before_pt) != null) para.spaceBefore = numArg(a.space_before_pt);
      if (numArg(a.space_after_pt) != null) para.spaceAfter = numArg(a.space_after_pt);
      for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
        const css = a[`border_${side.toLowerCase()}`] ?? a.border;
        if (typeof css !== 'string' || !css.trim()) continue;
        const v = borderAttr(css);
        if (v === 'none' || !v) delete para[`border${side}`];
        else para[`border${side}`] = v;
      }
      putStyle({ ...base, ...(known || !parent ? {} : { parent }), para, text });
      const numbers = a.heading_numbers == null || a.heading_numbers === '' ? null : String(a.heading_numbers);
      if (numbers) setOutline(numbers === 'none' ? null : /^i/i.test(numbers) ? romanOutline() : decimalOutline());
      return { result: 'ok', summary: m.style(styleLabel(known ?? name)) };
    }
    case 'insert_frame': {
      const p = current(ctx, a.paragraph);
      const kind = /pic|image|photo|img/i.test(String(a.kind)) ? 'picture' : 'text_box';
      const w = numArg(a.width_cm) ?? (kind === 'picture' ? 4 : 6);
      const h = numArg(a.height_cm) ?? (kind === 'picture' ? 5 : 3);
      const wrap = String(a.wrap ?? '').toLowerCase();
      const gap = gapArg(a.gap_cm);
      const float = wrap === 'left' || wrap === 'right'
        ? `float:${wrap}${gap ? `;margin:${gap.top}cm ${gap.right}cm ${gap.bottom}cm ${gap.left}cm` : ''}` : '';
      const label = String(a.html ?? '').trim();
      const frameHtml = kind === 'picture'
        ? `<img alt="${escapeAttr(label.replace(/<[^>]*>/g, '') || 'Picture')}" width="${w}cm" height="${h}cm" style="${float}">`
        : `<aside style="width:${w}cm;height:${h}cm;${float}">${label || '<p></p>'}</aside>`;
      let frame: PMNode | null = null;
      htmlToSlice(`<p>${frameHtml}</p>`, ctx.editor.state).content.descendants((n) => {
        frame ??= n.type.name === 'textBox' || n.type.name === 'image' ? n : null;
        return !frame;
      });
      if (!frame) throw new ToolError('the frame could not be built');
      dispatch(ctx, (tr) => tr.insert(p.pos + 1, frame!));
      return { result: 'ok', summary: m.frame(Number(a.paragraph)) };
    }
    case 'frame': {
      const p = current(ctx, a.paragraph);
      const want = Math.max(1, Math.round(numArg(a.frame) ?? 1));
      let found: { pos: number; node: PMNode } | null = null;
      let count = 0;
      p.node.forEach((child, offset) => {
        if (!isFrame(child)) return;
        if (++count === want) found = { pos: p.pos + 1 + offset, node: child };
      });
      if (!found) throw new ToolError(count ? `paragraph ${a.paragraph} has ${count} frame(s)` : `paragraph ${a.paragraph} has no frame`);
      const { pos, node } = found as { pos: number; node: PMNode };
      if (boolArg(a.delete)) {
        dispatch(ctx, (tr) => trackedReplace(tr, pos, pos + node.nodeSize, null, ctx.author));
        return { result: 'ok', summary: m.frameSet(Number(a.paragraph)) };
      }
      const attrs: Record<string, unknown> = { ...node.attrs };
      if (a.wrap != null && a.wrap !== '') {
        const w = String(a.wrap).toLowerCase().replace(/[^a-z]/g, '');
        const free = w.startsWith('infront') || w.startsWith('front') || w.startsWith('behind') || w === 'through';
        const mode: WrapMode = w === 'left' || w === 'right' || w === 'inline' ? w : w.startsWith('top') ? 'topBottom' : free ? 'through'
          : (() => { throw new ToolError('wrap is left, right, top_bottom, inline, in_front or behind'); })();
        Object.assign(attrs, { wrap: mode }, droppedFrameAttrs(mode, w.includes('front'), node.attrs.wrap));
        // A frame that starts to wrap without a gap of its own takes a new frame's.
        if (mode !== 'inline' && mode !== 'through' && attrs.wrapDist == null) attrs.wrapDist = node.type.name === 'image' ? PICTURE_WRAP_GAP : BOX_WRAP_GAP;
      }
      const px = (cm?: number) => (cm != null && cm > 0 ? Math.round(cm * (96 / 2.54)) : null);
      const w = px(numArg(a.width_cm)), h = px(numArg(a.height_cm));
      if (w) attrs.width = w;
      if (h) attrs.height = h;
      if (a.gap_cm != null && a.gap_cm !== '') {
        const gap = gapArg(a.gap_cm);
        if (!gap) throw new ToolError('gap_cm is one number, or four: top right bottom left');
        attrs.wrapDist = wrapGapAttr(wrapGap(gap));
      }
      const x = numArg(a.x_cm), y = numArg(a.y_cm), turn = numArg(a.rotation);
      if ((x != null || y != null) && attrs.wrap === 'inline') throw new ToolError('a frame in the line has no position; set wrap first');
      if (x != null) attrs.wrapOffset = Math.round(x * 100) / 100;
      if (y != null) attrs.wrapOffsetY = Math.round(y * 100) / 100;
      if (a.y_from != null && a.y_from !== '') {
        const from = String(a.y_from).toLowerCase();
        Object.assign(attrs, { wrapFromPage: from.startsWith('page'), wrapFromBody: from.startsWith('margin') || from.startsWith('text'), anchorPage: null });
      }
      if (turn != null) attrs.rotation = ((turn % 360) + 360) % 360;
      const to = a.stack == null || a.stack === '' ? null : String(a.stack).toLowerCase() as 'front' | 'back' | 'forward' | 'backward';
      if (to && !['front', 'back', 'forward', 'backward'].includes(to)) throw new ToolError('stack is front, back, forward or backward');
      if (to && attrs.wrap !== 'through') throw new ToolError('only a frame in front of or behind the text has a stacking order; set wrap to in_front or behind');
      dispatch(ctx, (tr) => tr.setNodeMarkup(pos, undefined, attrs));
      if (to) {
        const { state } = ctx.editor;
        restackFrame(state.apply(state.tr.setSelection(NodeSelection.create(state.doc, pos))), (tr) => ctx.editor.view.dispatch(tr), to);
      }
      let at = pos;
      const caption = String(a.caption ?? '').trim();
      if (caption) {
        if (node.type.name !== 'image') throw new ToolError('only a picture takes a caption; a text box takes it as one of its paragraphs');
        at = captionFrame(ctx, pos, caption);
      }
      if (a.move_to != null && a.move_to !== '') {
        const target = current(ctx, a.move_to);
        dispatch(ctx, (tr) => {
          const moved = tr.doc.nodeAt(at)!;
          tr.delete(at, at + moved.nodeSize);
          tr.insert(tr.mapping.map(target.pos + 1), moved);
        });
      }
      return { result: 'ok', summary: m.frameSet(Number(a.paragraph)) };
    }
    case 'set_header_footer': {
      if (!ctx.host) throw new ToolError('headers and footers cannot be changed here');
      const zone = String(a.zone).toLowerCase().startsWith('f') ? 'footer' : 'header';
      const pages = String(a.pages ?? 'all').toLowerCase();
      const variant: HfVariant = pages === 'first' ? 'first' : pages === 'even' ? 'even' : 'default';
      const dropped: string[] = [];
      const doc = zoneDocFromHtml(String(a.html ?? ''), dropped);
      ctx.host.setZone(zone, variant, doc);
      return { result: withDropped(dropped), summary: m.zone(zone === 'footer', !doc) };
    }
    case 'set_language': {
      const asked = String(a.language ?? '').trim();
      const code = languageCode(asked);
      if (a.from == null || a.from === '') {
        if (!ctx.host?.setLanguage) throw new ToolError('the document language cannot be changed here');
        if (!code) throw new ToolError(`unknown language "${asked}"; languages are: ${LANGUAGES.map((l) => l.label).join(', ')}`);
        ctx.host.setLanguage(code);
        return { result: 'ok', summary: m.language(findLanguage(code)!.label) };
      }
      // A paragraph may be in any language a tag names, also one without a dictionary.
      const tag = code ? tagForLanguage(code) : odfFromTag(asked) ? asked : null;
      if (!tag) throw new ToolError(`unknown language "${asked}"; give a name from ${LANGUAGES.map((l) => l.label).join(', ')} or a tag such as en-GB`);
      const p = current(ctx, a.from);
      const q = current(ctx, a.to ?? a.from);
      if (!ctx.editor.chain().setTextSelection({ from: p.pos + 1, to: q.pos + 1 + q.node.content.size }).setBlockLanguage(tag).run()) throw new ToolError('the language cannot be set there');
      return { result: 'ok', summary: m.language(code ? findLanguage(code)!.label : tag) };
    }
    case 'set_page': {
      if (!ctx.host) throw new ToolError('the page setup cannot be changed here');
      const margins = a.margins_cm == null || a.margins_cm === '' ? undefined
        : parseMargins(Array.isArray(a.margins_cm) ? a.margins_cm.join(' ') : String(a.margins_cm));
      if (a.margins_cm != null && a.margins_cm !== '' && !margins) throw new ToolError('margins_cm is one number, or four: top right bottom left');
      const start = a.page_numbers_start == null || a.page_numbers_start === '' ? undefined : Math.round(Number(a.page_numbers_start));
      if (start != null && !(start >= 0)) throw new ToolError('page_numbers_start is a whole number');
      const setup = pageSetup({ size: a.size ? String(a.size) : undefined, orientation: a.orientation ? String(a.orientation).toLowerCase() : undefined, margins, start });
      if (!Object.keys(setup).length) throw new ToolError('give size, orientation, margins_cm or page_numbers_start');
      ctx.host.setPage(setup);
      return { result: 'ok', summary: m.page };
    }
    case 'reply_comment':
    case 'resolve_comment': {
      const n = Number(a.comment);
      const id = (ctx.commentIds ?? comments(ctx.editor.state.doc).map((c) => c.id))[n - 1];
      if (!id) throw new ToolError(`no comment C${String(a.comment)}`);
      const done = call.name === 'reply_comment'
        ? ctx.editor.commands.replyToComment(id, { author: ctx.author, text: String(a.text ?? '') })
        : ctx.editor.commands.updateComment(id, { resolved: true });
      if (!done) throw new ToolError(`comment C${n} no longer exists, or the reply is empty`);
      return { result: 'ok', summary: call.name === 'reply_comment' ? m.reply(n) : m.resolve(n) };
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
  // A model may call a tool it was not offered.
  if (ctx.allowed && !ctx.allowed.has(call.name)) return { result: 'error: chat mode cannot change the document; tell the user to switch to Edit mode', summary: '' };
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
/**
 * Waits until no pagination pass runs or is queued; false after 3s or in a hidden tab,
 * which runs no frames: a stale page count misleads more than none.
 */
async function layoutSettled(view: EditorView): Promise<boolean> {
  const end = Date.now() + 3000;
  // A text change queues its pass on the next frame; a page setup change reaches the
  // editor through a Svelte effect that dispatches in a frame of its own, one later.
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  while (!document.hidden && Date.now() < end) {
    if (!isPaginating(view)) return true;
    await new Promise((done) => { requestAnimationFrame(done); setTimeout(done, 100); });
  }
  return false;
}

export async function runTurn(opts: {
  cfg: AiConfig;
  editor: Editor;
  history: ChatMessage[];
  question: string;
  author: string;
  host?: AiHost;
  onText: (delta: string) => void;
  onTool: (summary: string) => void;
  signal: AbortSignal;
  /** Messages the user sent while the turn runs; read after each round of tools. */
  takeQueued?: () => string[];
  /** Attached files' text: sent with this turn only, never kept in the history. */
  context?: string;
  /** Tools chat mode offers beyond reading, as a comment's question needs reply_comment. */
  allow?: string[];
}): Promise<string> {
  const { editor } = opts;
  const chat = opts.cfg.mode === 'chat';
  const allowed = chat ? new Set([...READ_TOOLS, ...(opts.allow ?? [])]) : undefined;
  const tools = allowed ? TOOLS.filter((d) => allowed.has(d.name)) : TOOLS;
  const blocks = blockTexts(editor.state.doc);
  // A page, zone or language change reflows the pages without touching the text.
  let reflowed = false;
  const h = opts.host;
  const host: AiHost | undefined = h && {
    setZone: (...z) => { reflowed = true; h.setZone(...z); },
    setPage: (p) => { reflowed = true; h.setPage(p); },
    setLanguage: h.setLanguage && ((c) => { reflowed = true; h.setLanguage!(c); }),
  };
  const ctx: TurnContext = { editor, blocks, mapping: new Mapping(), author: opts.author, commentIds: comments(editor.state.doc).map((c) => c.id), host, allowed };
  const track = ({ transaction }: { transaction: Transaction }) => ctx.mapping.appendMapping(transaction.mapping);
  editor.on('transaction', track);
  const preface = opts.context ? `${opts.context}\n\n---\n\n` : '';
  const turn: ChatMessage[] = [{ role: 'user', content: `${serializeDoc(editor.state, blocks, docBudget(opts.cfg), pageLayout(editor.view, blocks))}\n\n---\n\n${preface}${opts.question}` }];
  let answer = '';
  const asked = [opts.question];
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await streamChat(opts.cfg, { system: chatSystemPrompt(chat ? 'chat' : 'edit'), messages: [...opts.history, ...turn], tools }, opts.onText, opts.signal);
      answer += res.text;
      turn.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
      if (!res.toolCalls.length) break;
      const before = editor.state.doc;
      reflowed = false;
      for (const call of res.toolCalls) {
        if (opts.signal.aborted) break;
        const r = runTool(ctx, call);
        // A style changes the layout without touching the document.
        if (call.name === 'set_style' && r.result.startsWith('ok')) reflowed = true;
        if (r.summary) opts.onTool(r.summary);
        turn.push({ role: 'tool', id: call.id, content: r.result });
      }
      // After a round that changed the text or the page, the settled layout tells the
      // model how long the document now is, so "two pages" is something it can check.
      if ((reflowed || !editor.state.doc.eq(before)) && typeof requestAnimationFrame === 'function' && await layoutSettled(editor.view)) {
        const layout = pageLayout(editor.view, blockTexts(editor.state.doc));
        const last = turn[turn.length - 1];
        if (layout && last.role === 'tool') last.content += `\n(document now ${layout.pages[layout.pages.length - 1]} pages, last page about ${layout.lastFill}% full)`;
      }
      // A message sent meanwhile rides the tool result, the one place a provider takes
      // text before the model's next step; the last round would leave it unread.
      const last = turn[turn.length - 1];
      const added = round < MAX_ROUNDS - 1 && !opts.signal.aborted ? opts.takeQueued?.() ?? [] : [];
      if (added.length && last.role === 'tool') {
        last.content += `\n\n(The user adds while you work: ${added.join('\n\n')})`;
        asked.push(...added);
      }
    }
  } finally {
    editor.off('transaction', track);
  }
  opts.history.push({ role: 'user', content: asked.join('\n\n') }, { role: 'assistant', content: answer });
  return answer;
}

/** "@KI" (the assistant's localized name) or "@AI" in a comment asks the assistant. */
export function mentionsAi(text: string): boolean {
  const names = [...new Set([t().ai.author, 'AI'])].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(^|\\s)@(${names.join('|')})(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * Answers the newest message of comment thread `id` in the thread, as a turn of its own:
 * no chat history, the change asked for made first where the mode allows. A reply the
 * model wrote as text instead of through reply_comment is posted for it.
 */
export async function answerComment(opts: { cfg: AiConfig; editor: Editor; id: string; host?: AiHost; signal: AbortSignal }): Promise<void> {
  const { editor, id } = opts;
  const list = comments(editor.state.doc);
  const n = list.findIndex((c) => c.id === id) + 1;
  const c = list[n - 1];
  if (!c) return;
  const last = c.replies.at(-1) ?? { author: c.author, text: c.text };
  const author = t().ai.author;
  const question = [
    `In comment C${n}, ${last.author || 'the user'} asks you: «${last.text}».`,
    opts.cfg.mode === 'chat'
      ? `Answer in that thread with reply_comment, in their language.`
      : `If they ask for a change to the document, make it first. Then answer in that thread with reply_comment, in their language, saying briefly what you did.`,
  ].join(' ');
  const before = c.replies.length;
  const answer = await runTurn({
    cfg: opts.cfg, editor, history: [], question, author, host: opts.host, allow: ['reply_comment'],
    onText: () => {}, onTool: () => {}, signal: opts.signal,
  });
  const now = comments(editor.state.doc).find((x) => x.id === id);
  const replied = now?.replies.slice(before).some((r) => r.author === author);
  const text = new DOMParser().parseFromString(stripFences(answer), 'text/html').body.textContent?.trim();
  if (now && !replied && text && !opts.signal.aborted) editor.commands.replyToComment(id, { author, text });
}
