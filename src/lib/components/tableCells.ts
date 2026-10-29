import type { EditorState } from '@tiptap/pm/state';
import { CellSelection, isInTable, selectedRect } from '@tiptap/pm/tables';
import { DEFAULT_CELL_PADDING, parseCellPadding, type CellPadding } from '../editor/extensions/tableCellPadding';

// What the table chrome reads from the cells under the cursor, for the ribbon's table
// tabs and the floating table toolbar alike.

/** One attribute over the selected cells: the shared value, '' if they disagree, null
 *  outside a cell. */
export function cellAttr(state: EditorState, name: string): string | null {
  const sel = state.selection;
  const values = new Set<string | null>();
  if (sel instanceof CellSelection) {
    sel.forEachCell((cell) => values.add((cell.attrs[name] as string) ?? null));
  } else {
    const from = sel.$from;
    for (let d = from.depth; d > 0; d--) {
      const role = from.node(d).type.spec.tableRole;
      if (role === 'cell' || role === 'header_cell') {
        values.add((from.node(d).attrs[name] as string) ?? null);
        break;
      }
    }
  }
  if (values.size === 0) return null;
  return values.size > 1 ? '' : ([...values][0] ?? null);
}

/** The cell's margins in cm, [top, right, bottom, left]; a cell that never set them
 *  shows the format default. Null outside a table. */
export function cellPadding(state: EditorState): CellPadding | null {
  if (!isInTable(state)) return null;
  return parseCellPadding(cellAttr(state, 'cellPadding')) ?? DEFAULT_CELL_PADDING;
}

/** The structural header: the first row repeated on every page the table continues on. */
export function repeatsHeader(state: EditorState): boolean {
  return isInTable(state) && selectedRect(state).table.attrs.repeatHeader === true;
}
