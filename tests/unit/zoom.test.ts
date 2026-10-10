// Ctrl+wheel / touchpad two-finger zoom feeds wheelZoomFactor. The deltas differ wildly
// per device and browser, so the conversion has to stay bounded and correctly signed.
import { describe, it, expect } from 'vitest';
import { clampZoom, wheelZoomFactor, MIN_ZOOM, MAX_ZOOM, fitPagesZoom } from '../../src/lib/utils/zoom';

describe('wheelZoomFactor', () => {
  it('zooms in on a negative delta, out on a positive one', () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it('keeps one mouse notch to a moderate step', () => {
    const step = wheelZoomFactor(-100); // Chrome, deltaMode 0
    expect(step).toBeGreaterThan(1.05);
    expect(step).toBeLessThan(1.5);
  });

  it("lands Firefox's line-mode notch in the same range", () => {
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-100), 5);
  });

  it('scales small touchpad deltas finely', () => {
    expect(wheelZoomFactor(-2)).toBeLessThan(wheelZoomFactor(-20));
    expect(wheelZoomFactor(-2)).toBeGreaterThan(1);
  });
});

describe('clampZoom', () => {
  it('clamps to the slider range and rounds to whole percent', () => {
    expect(clampZoom(5)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(104.4)).toBe(104);
  });
});

// The zoom the page grid fits itself to: one whole row of pages, gaps included, has to
// fit the window, or the reader is left scrolling a row sideways (Editor.svelte).

// A4 across (page + the gap beside it) and down (page + the gap below it), document px.
const A4 = { width: 794 + 20, cycle: 1123 + 20 };

describe('fitPagesZoom', () => {
  it('fits a whole row into the window', () => {
    for (const box of [{ width: 1400, height: 900 }, { width: 900, height: 1400 }, { width: 640, height: 480 }]) {
      for (const n of [1, 2, 3, 4]) {
        const percent = fitPagesZoom(box, A4, n);
        if (percent === MIN_ZOOM) continue; // a window too small for the count: the floor wins
        const z = percent / 100;
        expect(A4.cycle * z).toBeLessThanOrEqual(box.height);
        expect(A4.width * z * n).toBeLessThanOrEqual(box.width);
      }
    }
  });

  it('takes whichever of the two the row runs out of first', () => {
    // Wide and short: the height binds and the column count changes nothing.
    expect(fitPagesZoom({ width: 4000, height: 600 }, A4, 2)).toBe(fitPagesZoom({ width: 4000, height: 600 }, A4, 3));
    // Narrow and tall: the width binds, so a column more is a zoom step down.
    expect(fitPagesZoom({ width: 1200, height: 4000 }, A4, 3))
      .toBeLessThan(fitPagesZoom({ width: 1200, height: 4000 }, A4, 2));
  });

  it('stays inside the zoom range', () => {
    expect(fitPagesZoom({ width: 40, height: 40 }, A4, 4)).toBe(MIN_ZOOM);
    expect(fitPagesZoom({ width: 40000, height: 40000 }, A4, 1)).toBe(MAX_ZOOM);
  });
});
