import type { Node as PMNode } from '@tiptap/pm/model';

// One colour per author, as both word processors draw review markup: LibreOffice's own
// author palette, handed out in order of first appearance. Beyond nine, authors share again.
export const AUTHOR_COLORS = [
  '#c69200', '#0646a2', '#579d1c', '#692b9d', '#c5000b', '#008080', '#8c8400', '#35556b', '#d17600',
];

// Walks the marks itself rather than revisions()/comments(): both extensions colour by it.
const colorsOf = new WeakMap<PMNode, Map<string, string>>();

/**
 * Author → colour over the whole document, revisions and comments (with their answers)
 * alike, so one reviewer keeps one colour everywhere and hiding markup recolours nothing.
 */
export function authorColors(doc: PMNode): Map<string, string> {
  const known = colorsOf.get(doc);
  if (known) return known;
  const out = new Map<string, string>();
  const add = (author: unknown) => {
    const a = String(author ?? '');
    if (!out.has(a)) out.set(a, AUTHOR_COLORS[out.size % AUTHOR_COLORS.length]);
  };
  doc.descendants((node) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      const name = m.type.name;
      if (name !== 'insertion' && name !== 'deletion' && name !== 'comment') continue;
      add(m.attrs.author);
      if (name === 'comment') for (const r of repliesOf(m.attrs.replies)) add(r?.author);
    }
    return false;
  });
  colorsOf.set(doc, out);
  return out;
}

export function authorColor(colors: Map<string, string>, author: string): string {
  return colors.get(author) ?? AUTHOR_COLORS[0];
}

function repliesOf(value: unknown): { author?: unknown }[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const list: unknown = JSON.parse(value);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
