// Where the margin balloons end up (ReviewMarginLayer.svelte). Each one wants to sit at
// its anchor's line; two anchors a line apart carry balloons far taller than a line, so
// a balloon that would overlap its predecessor is pushed down, as in both word processors.

/** Tops for balloons in document order: none closer than `gap`, all inside the band.
 *  `pin`: the active balloon sits at its own line and the others stack around it. */
export function stackTops(
  desired: number[],
  heights: number[],
  gap: number,
  bandTop = -Infinity,
  bandBottom = Infinity,
  pin?: number,
): number[] {
  if (pin !== undefined && pin >= 0 && pin < desired.length) return stackAround(desired, heights, gap, bandTop, bandBottom, pin);
  const out: number[] = [];
  let floor = bandTop;
  for (const [i, want] of desired.entries()) {
    const top = Math.max(want, floor);
    out.push(top);
    floor = top + (heights[i] ?? 0) + gap;
  }
  // More cards than the band holds: they keep their distance and run past its end —
  // overlapping them would hide the ones underneath. The caller caps heights so this
  // stays the rare case.
  const total = heights.slice(0, out.length).reduce((s, h) => s + (h ?? 0), 0) + Math.max(0, out.length - 1) * gap;
  if (total > bandBottom - bandTop) return out;
  // Back up again: the column may not hang past the band, and pulling the last card up
  // pulls its predecessors with it.
  let ceiling = bandBottom;
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = Math.min(out[i], ceiling - (heights[i] ?? 0));
    ceiling = out[i] - gap;
  }
  return out;
}

// The cards before the pinned one stack upwards from it, the ones after downwards; it
// leaves its line only as far as the cards above it need to stay on the page.
function stackAround(desired: number[], heights: number[], gap: number, bandTop: number, bandBottom: number, pin: number): number[] {
  const h = (i: number) => heights[i] ?? 0;
  let before = 0;
  for (let i = 0; i < pin; i++) before += h(i) + gap;
  let after = 0;
  for (let i = pin + 1; i < desired.length; i++) after += gap + h(i);
  const out = new Array<number>(desired.length);
  out[pin] = Math.max(Math.min(desired[pin], bandBottom - h(pin) - after), bandTop + before);
  let floor = out[pin] + h(pin) + gap;
  for (let i = pin + 1; i < desired.length; i++) {
    out[i] = Math.max(desired[i], floor);
    floor = out[i] + h(i) + gap;
  }
  // Above it: pushed down from the band's top as usual, then up under the pinned one.
  floor = bandTop;
  for (let i = 0; i < pin; i++) {
    out[i] = Math.max(desired[i], floor);
    floor = out[i] + h(i) + gap;
  }
  let ceiling = out[pin] - gap;
  for (let i = pin - 1; i >= 0; i--) {
    out[i] = Math.min(out[i], ceiling - h(i));
    ceiling = out[i] - gap;
  }
  return out;
}
