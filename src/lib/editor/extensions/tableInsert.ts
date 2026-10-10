import type { Command, EditorState, Transaction } from '@tiptap/pm/state';
import { selectedRect, TableMap } from '@tiptap/pm/tables';
import { HEADER_SHADE } from './tableHeaderRow';

type PmCommand = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;

/**
 * A row or column insert whose new cells take the formatting of the row or column they
 * were inserted from — cell fill and borders, the paragraph's attrs and the row's height —
 * as in LibreOffice; prosemirror-tables creates them bare.
 */
export function inheritingInsert(insert: PmCommand, axis: 'row' | 'column', side: 'before' | 'after'): Command {
  return (state, dispatch) => {
    if (!dispatch || !insert(state)) return insert(state);
    const rect = selectedRect(state);
    return insert(state, (tr) => {
      const at = side === 'after' ? (axis === 'row' ? rect.bottom : rect.right) : (axis === 'row' ? rect.top : rect.left);
      inherit(tr, rect.tableStart, axis, at, side === 'after' ? at - 1 : at + 1);
      dispatch(tr);
    });
  };
}

function inherit(tr: Transaction, tableStart: number, axis: 'row' | 'column', line: number, source: number) {
  const table = tr.doc.nodeAt(tableStart - 1);
  if (!table) return;
  const map = TableMap.get(table);
  const row = axis === 'row';
  const cellsOf = (l: number) => Array.from({ length: row ? map.width : map.height }, (_, k) => table.nodeAt(map.map[row ? l * map.width + k : k * map.width + l])!);
  const isHeader = (l: number) => cellsOf(l).every((c) => c.type.name === 'tableHeader' || c.attrs.backgroundColor === HEADER_SHADE);
  // Below a header row (or right of a header column) the new line is body: copy the next one.
  if (source === 0 && line === 1 && 2 < (row ? map.height : map.width) && isHeader(0)) source = 2;
  if (row && source >= 0 && source < table.childCount) {
    let pos = tableStart;
    for (let i = 0; i < line; i++) pos += table.child(i).nodeSize;
    tr.setNodeMarkup(pos, null, table.child(source).attrs);
  }
  const done = new Set<number>();
  for (let k = 0; k < (row ? map.width : map.height); k++) {
    const cellPos = map.map[row ? line * map.width + k : k * map.width + line];
    const srcPos = map.map[row ? source * map.width + k : k * map.width + source];
    // A merged cell spanning the new line was only widened; it is not new.
    if (srcPos === undefined || cellPos === srcPos || done.has(cellPos)) continue;
    done.add(cellPos);
    const cell = table.nodeAt(cellPos)!;
    const src = table.nodeAt(srcPos)!;
    const { colspan: _c, rowspan: _r, colwidth: _w, ...look } = src.attrs;
    tr.setNodeMarkup(tableStart + cellPos, null, { ...cell.attrs, ...look });
    const para = cell.firstChild;
    const from = src.firstChild;
    if (para && from && para.type === from.type) tr.setNodeMarkup(tableStart + cellPos + 1, null, from.attrs);
  }
}
