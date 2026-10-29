import { describe, it, expect } from 'vitest';
import { deckAround, deckHeights, stackTops } from '../../src/lib/utils/balloonStack';

describe('the margin balloon stack', () => {
  it('leaves a balloon at its anchor where there is room', () => {
    expect(stackTops([0, 200, 400], [50, 50, 50], 6)).toEqual([0, 200, 400]);
  });

  it('pushes an overlapping balloon below its predecessor', () => {
    expect(stackTops([0, 10, 20], [50, 50, 50], 6)).toEqual([0, 56, 112]);
  });

  it('never lifts one above the anchor it belongs to', () => {
    expect(stackTops([100, 0], [20, 20], 4)).toEqual([100, 124]);
  });

  it('pulls the column up so it ends inside the page', () => {
    expect(stackTops([0, 70], [40, 40], 6, 0, 100)).toEqual([0, 60]);
  });

  it('keeps the cards apart where the page cannot hold them all', () => {
    expect(stackTops([10, 20], [50, 50], 6, 0, 80)).toEqual([10, 66]);
  });

  it('puts the active balloon at its line and stacks the others around it', () => {
    expect(stackTops([100, 110, 120], [50, 50, 50], 6, 0, 1000, 2)).toEqual([8, 64, 120]);
    expect(stackTops([100, 110, 120], [50, 50, 50], 6, 0, 1000, 0)).toEqual([100, 156, 212]);
  });

  it('moves the active balloon down only as far as the ones above it need the page', () => {
    expect(stackTops([0, 10, 20], [50, 50, 50], 6, 0, 1000, 2)).toEqual([0, 56, 112]);
  });

  it('decks a column too long for its page: it fits, every head shows, the last card whole', () => {
    const heights = [40, 120, 90, 200, 60, 150];
    const want = [0, 5, 10, 15, 20, 25];
    for (const keep of [undefined, 2]) {
      const deck = keep === undefined ? deckHeights(heights, 6, 400, 18) : deckAround(want, heights, 6, 0, 400, 18, keep);
      const tops = stackTops(want, deck, 6, 0, 400, keep);
      expect(tops[5] + heights[5]).toBeLessThanOrEqual(400);
      tops.slice(1).forEach((t, i) => expect(t - tops[i]).toBeGreaterThanOrEqual(18 + 6));
      if (keep !== undefined) expect(tops[keep + 1] - tops[keep]).toBeGreaterThanOrEqual(heights[keep]);
    }
    expect(deckHeights([40, 50], 6, 400, 18)).toEqual([40, 50]);
    // An active card low on a crowded page stays at its line, the deck above it closing up.
    const low = [0, 10, 20, 30, 300];
    const tall = [100, 100, 100, 100, 80];
    expect(stackTops(low, deckAround(low, tall, 6, 0, 400, 18, 4), 6, 0, 400, 4)[4]).toBe(300);
  });

  it('holds an empty list', () => {
    expect(stackTops([], [], 6)).toEqual([]);
  });
});
