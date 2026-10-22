import type { EditorView } from '@tiptap/pm/view';

// A click that focuses a view: ProseMirror puts its own selection back 20 ms after the
// focus unless a selectionchange read the clicked caret in first, which a busy page
// delays. Reading the DOM selection in right after the click wins that race.
export function readClickCaret(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0 || view.hasFocus()) return false;
  setTimeout(() => {
    if (!view.isDestroyed && view.hasFocus()) (view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
  });
  return false;
}
