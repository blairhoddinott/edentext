import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { findTextBox } from '../../editor/extensions/textBox';
import type { HfZone } from '../../storage/headerFooter';
import type { Tab } from './commands';

// Word's contextual tabs: they exist while the caret is in the object and vanish with it.
// The ribbon shows them as tabs, the island as its floating toolbars; the command search
// offers their commands only while they are there.

export function selectedNodeName(editor: Editor): string | null {
  const sel = editor.state.selection;
  return sel instanceof NodeSelection ? sel.node.type.name : null;
}

/** A text box is worked on with the caret inside it just as often as with the box
 *  selected, so it counts either way — unless a picture is the selection. */
export function inTextBox(editor: Editor): boolean {
  return !!findTextBox(editor.state) && selectedNodeName(editor) !== 'image';
}

export function contextualTabs(editor: Editor | null, hfActive: HfZone | null): Tab[] {
  if (!editor) return [];
  return [
    ...(editor.isActive('table') ? (['tableDesign', 'tableLayout'] as const) : []),
    ...(selectedNodeName(editor) === 'image' ? (['pictureFormat'] as const) : []),
    ...(inTextBox(editor) ? (['shapeFormat'] as const) : []),
    ...(hfActive ? (['headerFooter'] as const) : []),
  ];
}
