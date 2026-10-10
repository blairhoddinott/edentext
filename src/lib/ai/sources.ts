// Files the user attaches to a chat message as material: read here, in the browser, to
// plain text that goes along with that one message. Nothing is uploaded but the text.

import type { Schema } from '@tiptap/pm/model';
import { isProtected } from '../crypto/protect';
import { repairContent } from '../import/repairContent';

export type Source = { name: string; text: string };

/** What the file picker offers; a PDF has no reader here. */
export const SOURCE_ACCEPT = '.docx,.dotx,.odt,.ott,.txt,.md,.csv,.html,.htm';

export class SourceError extends Error {}

export async function readSource(file: File, schema: Schema): Promise<Source> {
  const name = file.name;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['txt', 'md', 'csv'].includes(ext)) return { name, text: await file.text() };
  if (ext === 'html' || ext === 'htm') {
    const body = new DOMParser().parseFromString(await file.text(), 'text/html').body;
    return { name, text: body.innerText || body.textContent || '' };
  }
  if (!['docx', 'dotx', 'odt', 'ott'].includes(ext)) throw new SourceError(name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isProtected(bytes)) throw new SourceError(name);
  const [{ importOdt }, { importDocx }] = await Promise.all([import('../import/odt'), import('../import/docx')]);
  // As opening a file: the content decides when the extension is wrong.
  const docx = ext === 'docx' || ext === 'dotx';
  let result;
  try {
    result = docx ? importDocx(bytes) : importOdt(bytes);
  } catch {
    try { result = docx ? importOdt(bytes) : importDocx(bytes); } catch { throw new SourceError(name); }
  }
  const doc = schema.nodeFromJSON(repairContent(result.content, schema).content);
  return { name, text: doc.textBetween(0, doc.content.size, '\n', ' ') };
}

/** The sources as the message's preface, each cut to its share of `budget` characters. */
export function sourcesBlock(sources: Source[], budget: number): string {
  if (!sources.length) return '';
  const share = Math.max(1000, Math.floor(budget / sources.length));
  return sources.map(({ name, text }) => {
    const t = text.replace(/\n{3,}/g, '\n\n').trim();
    return `Attached file «${name}»:\n${t.length > share ? `${t.slice(0, share)}\n[… rest of the file cut]` : t}`;
  }).join('\n\n');
}
