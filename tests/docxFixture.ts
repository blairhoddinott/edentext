// Minimal DOCX packages for import tests: the body and the parts the importer reads by
// fixed path, with the namespaces a fixture's markup commonly uses already declared.
import { zipSync, strToU8 } from 'fflate';
import { importDocx } from '../src/lib/import/docx';
import { importOdt } from '../src/lib/import/odt';
import { buildDocx } from '../src/lib/export/docx';
import { buildOdt } from '../src/lib/export/odt';
import type { StyleSheet } from '../src/lib/styles/styleSheet';

type N = any;

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS = `xmlns:w="${W_NS}"`
  + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
  + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  + ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
  + ' xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"'
  + ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
  + ' xmlns:v="urn:schemas-microsoft-com:vml"'
  + ' xmlns:o="urn:schemas-microsoft-com:office:office"'
  + ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

export interface DocxParts {
  /** Inner XML of w:styles, w:numbering and w:settings. */
  styles?: string;
  numbering?: string;
  settings?: string;
  /** Further package entries, verbatim. */
  files?: Record<string, string | Uint8Array>;
}

export function docxOf(body: string, parts: DocxParts = {}): Uint8Array {
  const xml = (root: string, inner: string) => strToU8(`<?xml version="1.0"?><w:${root} ${NS}>${inner}</w:${root}>`);
  const entries: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/document.xml': xml('document', `<w:body>${body}</w:body>`),
  };
  if (parts.styles !== undefined) entries['word/styles.xml'] = xml('styles', parts.styles);
  if (parts.numbering !== undefined) entries['word/numbering.xml'] = xml('numbering', parts.numbering);
  if (parts.settings !== undefined) entries['word/settings.xml'] = xml('settings', parts.settings);
  for (const [path, data] of Object.entries(parts.files ?? {})) entries[path] = typeof data === 'string' ? strToU8(data) : data;
  return zipSync(entries);
}

/** The imported document's top-level blocks. */
export const blocksOf = (body: string, parts?: DocxParts): N[] => (importDocx(docxOf(body, parts)).content as N).content;
export const firstBlock = (body: string, parts?: DocxParts): N => blocksOf(body, parts)[0];

/** The document read back from its own DOCX and ODT export, in that order. */
export async function roundTrips(doc: N, styles?: StyleSheet): Promise<[N, N]> {
  const args = [undefined, 'portrait', undefined, null, 'A4', styles] as const;
  return [importDocx(await buildDocx(doc, ...args)).content, importOdt(await buildOdt(doc, ...args)).content];
}
