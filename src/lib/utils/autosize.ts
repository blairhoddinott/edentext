// A box as tall as what is typed in it, which `value` passes in: the card grows instead
// of scrolling inside.
export function autosize(node: HTMLTextAreaElement, _value: string) {
  const fit = () => { node.style.height = 'auto'; node.style.height = `${node.scrollHeight + 2}px`; };
  requestAnimationFrame(fit);
  return { update: fit };
}

/** In a box where Enter is a new line, the key that sends it. */
export const isSubmitKey = (e: KeyboardEvent): boolean => e.key === 'Enter' && (e.ctrlKey || e.metaKey);
