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

/** Heights to stack by where the full ones overrun the band: every card but those in
 *  `whole` is cut to one cap, the highest that fits and never below `least`, and the card
 *  after it covers the rest, so the column stays beside its page as a deck of cards. */
export function deckHeights(heights: number[], gap: number, band: number, least: number, whole: number[] = [heights.length - 1]): number[] {
  const n = heights.length;
  const total = heights.reduce((s, h) => s + h, 0) + Math.max(0, n - 1) * gap;
  if (total <= band) return heights.slice();
  let room = band - Math.max(0, n - 1) * gap - whole.reduce((s, i) => s + (heights[i] ?? 0), 0);
  const cut = heights.filter((_, i) => !whole.includes(i)).sort((a, b) => a - b);
  // Water-filling: the short cards stay whole, the tall ones share what is left alike.
  let cap = Infinity;
  for (const [k, h] of cut.entries()) {
    const rest = cut.length - k;
    if (h * rest > room) { cap = room / rest; break; }
    room -= h;
  }
  cap = Math.max(cap, least);
  return heights.map((h, i) => (whole.includes(i) ? h : Math.min(h, cap)));
}

/** The deck around an active card at its line: the cards before it share the band above
 *  that line, the ones after it the band below, so neither side pushes it off its line. */
export function deckAround(desired: number[], heights: number[], gap: number, bandTop: number, bandBottom: number, least: number, pin: number): number[] {
  const n = heights.length;
  const h = (i: number) => heights[i] ?? 0;
  const peek = (i: number) => Math.min(h(i), least) + gap;
  let above = 0;
  for (let i = 0; i < pin; i++) above += peek(i);
  let below = 0;
  for (let i = pin + 1; i < n; i++) below += i === n - 1 ? gap + h(i) : peek(i);
  const top = Math.max(Math.min(desired[pin], bandBottom - h(pin) - below), bandTop + above);
  const before = deckHeights(heights.slice(0, pin), gap, top - gap - bandTop, least, []);
  const after = deckHeights(heights.slice(pin + 1), gap, bandBottom - top - h(pin) - gap, least);
  return [...before, h(pin), ...after];
}
