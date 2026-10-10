// The chat's slash commands, which run a fixed prompt without tools so small local models
// manage them too, and the helpers that put a reply into the document: like a paste, so
// recording, when on, tracks it under the user's own name.

import type { Editor } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import type { Messages } from '../i18n/locales/en';
import { locale } from '../i18n/i18n.svelte';
import { LANGUAGES } from '../storage/documentLanguage';
import type { CustomCommand } from '../storage/ai.svelte';
import type { ChatRequest } from './client';
import { fillNotes, htmlToSlice, selectionHtml, serializeDoc, stripFences } from './doc';
import { splitDocumentHtml, type NoteText } from './dialect';
import { REWRITE_PROMPT, REWRITE_PRESETS, applyDocumentParts, draftPrompt, type AiHost } from './tools';

type Preset = keyof typeof REWRITE_PRESETS;
export type Command = { name: string; kind: 'draft' | 'rewrite'; preset?: Preset };

export const COMMANDS: Command[] = [
  { name: 'draft', kind: 'draft' },
  { name: 'rewrite', kind: 'rewrite' },
  ...(['rephrase', 'shorten', 'formal', 'fix', 'translate'] as const).map((preset) => ({ name: preset, kind: 'rewrite' as const, preset })),
];

export function commandLabel(c: Command, m: Messages['ai']): string {
  return c.preset ? m.presets[c.preset] : c.kind === 'draft' ? m.draftHeading : m.rewriteHeading;
}

/** The UI's language, which translate falls back to. */
export function uiLanguage(): string {
  return LANGUAGES.find((l) => l.code === locale() || l.code.startsWith(locale().split('-')[0]))?.label ?? 'English (US)';
}

/** `/name arg` as a known command, `{ unknown }` for any other `/word`, null for plain text. */
export function parseCommand(text: string): { command: Command; arg: string } | { unknown: string } | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const command = COMMANDS.find((c) => c.name === m[1].toLowerCase());
  return command ? { command, arg: m[2].trim() } : { unknown: m[1] };
}

/** A saved command's name as typed after `/`: one lower-case word. */
export const commandName = (s: string): string => s.trim().replace(/^\/+/, '').toLowerCase().replace(/\s+/g, '-');

/** `/name more` for a saved command, as the chat message it stands for; a built-in wins. */
export function expandCustom(text: string, saved: CustomCommand[]): string | null {
  const parsed = parseCommand(text);
  if (!parsed || !('unknown' in parsed)) return null;
  const c = saved.find((s) => commandName(s.name) === parsed.unknown.toLowerCase() && s.prompt.trim());
  return c ? `${c.prompt.trim()}\n\n${text.trim().slice(parsed.unknown.length + 1).trim()}`.trim() : null;
}

/** What a rewrite works on, fixed when it is asked for. */
export type Target = { from: number; to: number; original: string; html: string };

export function captureTarget(state: EditorState): Target {
  const { from, to, empty } = state.selection;
  return { from, to, original: state.doc.textBetween(from, to, '\n', ''), html: empty ? '' : selectionHtml(state) };
}

/**
 * The request a command sends, and the question it leaves in the chat history; null
 * while an instruction is missing. A preset takes `arg` as an addition, translate as the language.
 */
/** `context`: attached files' text, sent ahead of the request but not kept as `asked`. */
export function commandRequest(command: Command, arg: string, state: EditorState, target: Target, language: string, budget?: number, context = ''): { request: ChatRequest; asked: string } | null {
  const preface = context ? `${context}\n\n---\n\n` : '';
  if (command.kind === 'draft') {
    if (!arg) return null;
    const asked = `Write this at the cursor: ${arg}`;
    // An empty document is no context; small models would only echo its outline back.
    const empty = state.doc.childCount <= 1 && !state.doc.textContent.trim();
    return { request: { system: draftPrompt(empty), messages: [{ role: 'user', content: empty ? preface + asked : `${serializeDoc(state, undefined, budget)}\n\n---\n\n${preface}${asked}` }] }, asked };
  }
  const p = command.preset;
  const ask = p === 'translate' ? REWRITE_PRESETS.translate(arg || language) : p ? `${REWRITE_PRESETS[p]} ${arg}`.trim() : arg;
  if (!ask) return null;
  const asked = `${ask}\n\nPassage:\n${target.html}`;
  return { request: { system: REWRITE_PROMPT, messages: [{ role: 'user', content: preface + asked }] }, asked };
}

/** The range must still hold the text the reply was written for. */
export function targetIntact(editor: Editor, { from, to, original }: Target): boolean {
  const { doc } = editor.state;
  return to <= doc.content.size && doc.textBetween(from, to, '\n', '') === original;
}

/** Replaces the target with the reply; false when the text changed meanwhile. */
export function replaceTarget(editor: Editor, target: Target, html: string): boolean {
  if (!targetIntact(editor, target)) return false;
  editor.chain().focus().setTextSelection({ from: target.from, to: target.to }).run();
  const notes: NoteText[] = [];
  editor.view.dispatch(editor.state.tr.replaceSelection(htmlToSlice(html, editor.state, [], notes)).scrollIntoView());
  fillNotes(editor, notes);
  return true;
}

/** Inserts the reply as paragraphs after the target's block; false when the text changed meanwhile. */
export function insertBelowTarget(editor: Editor, target: Target, html: string): boolean {
  if (!targetIntact(editor, target)) return false;
  const end = editor.state.doc.resolve(target.to);
  const at = end.after(end.depth);
  const notes: NoteText[] = [];
  const slice = htmlToSlice(html, editor.state, [], notes);
  const tr = editor.state.tr.replace(at, at, new Slice(slice.content, 0, 0));
  editor.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(at, 1)))).scrollIntoView());
  fillNotes(editor, notes);
  editor.commands.focus();
  return true;
}

/** Inserts a draft at the cursor; its header, footer and page setup go to `host`. */
export function insertAtCursor(editor: Editor, html: string, host?: AiHost): void {
  // A header or page setup that cannot be applied (an unknown size) still leaves the text.
  let body: string;
  try { body = host ? applyDocumentParts(html, host).body : splitDocumentHtml(stripFences(html)).body; }
  catch { body = splitDocumentHtml(stripFences(html)).body; }
  editor.commands.focus();
  if (!body.trim()) return;
  const notes: NoteText[] = [];
  editor.view.dispatch(editor.state.tr.replaceSelection(htmlToSlice(body, editor.state, [], notes)).scrollIntoView());
  fillNotes(editor, notes);
}
