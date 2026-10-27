<script lang="ts" module>
  // Page edge → balloon, and the balloon itself: the strip Editor.svelte reserves beside
  // the page for this layer.
  export const BALLOON_GAP_CM = 0.5;
  // Wide enough that author, date and time share one line, as they do in the balloon
  // both word processors draw — roughly a third of the page, which is Word's own strip.
  export const BALLOON_W_CM = 6.5;
  export const REVIEW_MARGIN_CM = BALLOON_GAP_CM + BALLOON_W_CM;
</script>

<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import { untrack } from 'svelte';
  import { cmToPx } from '../storage/pageMargins';
  import { commentIdAt, type CommentRange } from '../editor/extensions/comment';
  import { revisionIdAt, authorColorIndex, REVISION_AUTHOR_COLORS, type Revision } from '../editor/extensions/trackChanges';
  import { selectRange, visibleComments, visibleRevisions } from './reviewItems';
  import { changesInMargin, commentsInMargin } from '../storage/markup.svelte';
  import { stackTops } from '../utils/balloonStack';
  import CommentCard from './CommentCard.svelte';
  import RevisionCard from './RevisionCard.svelte';

  // The margin balloons both word processors draw beside the page: one card per comment
  // and per recorded change, at the height of the line it belongs to, with a dashed
  // leader to it. It sits OUTSIDE .paper — that box clips horizontally and its width is
  // the one pagination measures — but carries the same scale, so it zooms with the page.
  let { editor, tick, pageBoxes, paperWidth, zoom, author }: {
    editor: Editor | null;
    tick: number;
    /** One box per page (Editor.svelte): a section on its own paper differs in size. */
    pageBoxes: { top: number; left: number; height: number; width: number }[];
    paperWidth: number;
    zoom: number;
    author: string;
  } = $props();

  const COMMENT_COLOR = 'rgba(200, 140, 0, 0.9)';
  const STACK_GAP_PX = 8;

  type Balloon = {
    key: string;
    color: string;
    active: boolean;
    /** The page its line is on: its card stacks in that page's band, beside it. */
    page: number;
    /** Where its line is, and where the leader leaves the text. */
    want: number;
    anchorX: number;
    anchorY: number;
    left: number;
    comment?: CommentRange;
    revision?: Revision;
  };

  let balloons = $state<Balloon[]>([]);
  let heights = $state<number[]>([]);
  // Each card's height while not active: the slot the stack keeps for the opened one.
  const compactHeights = new Map<string, number>();
  let host = $state<HTMLElement | null>(null);
  let els: (HTMLElement | null)[] = [];
  let scheduled = false;

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; measure(); });
  };

  $effect(() => {
    // Re-measure on every edit, every selection move, each pagination settle — and when
    // a kind moves out of the margin or back into it.
    void tick;
    void pageBoxes;
    void zoom;
    void commentsInMargin();
    void changesInMargin();
    schedule();
  });

  $effect(() => {
    const el = host;
    if (!el) return;
    const scaler = el.parentElement;
    scaler?.addEventListener('pm-pagecount', schedule);
    return () => scaler?.removeEventListener('pm-pagecount', schedule);
  });

  // A card's height is its content's, and editing one changes it — so it is measured,
  // not computed, and the stack follows.
  $effect(() => {
    const list = balloons;
    const read = () => els.slice(0, list.length).map((e, i) => {
      const h = e?.offsetHeight ?? 0;
      if (!list[i].active) compactHeights.set(list[i].key, h);
      return h;
    });
    const ro = new ResizeObserver(() => { heights = read(); });
    for (const e of els.slice(0, list.length)) if (e) ro.observe(e);
    untrack(() => { heights = read(); });
    return () => ro.disconnect();
  });

  // One entry per page, in page order: the cards beside a page stack among themselves.
  let groups = $derived.by(() => {
    const by = new Map<number, number[]>();
    balloons.forEach((b, i) => {
      const g = by.get(b.page);
      if (g) g.push(i);
      else by.set(b.page, [i]);
    });
    return [...by.entries()].map(([page, idx]) => ({ box: pageBoxes[page], idx }));
  });

  // Stacked inside the page band: a card pushed down by the ones above it stops at the
  // sheet's bottom edge, and a column too long for its page starts the next one below it.
  // The active card overlays the stack at its line and keeps its compact slot there.
  let tops = $derived.by(() => {
    const out = new Array<number>(balloons.length).fill(0);
    let floor = -Infinity;
    for (const { box, idx } of groups) {
      const slot = idx.map((i) => (balloons[i].active ? compactHeights.get(balloons[i].key) : undefined) ?? heights[i] ?? 0);
      const got = stackTops(
        idx.map((i) => balloons[i].want),
        slot,
        STACK_GAP_PX,
        Math.max(box ? box.top : -Infinity, floor),
        box ? box.top + box.height : Infinity,
      );
      const last = got.length - 1;
      if (last >= 0) floor = got[last] + slot[last] + STACK_GAP_PX;
      idx.forEach((i, k) => {
        const { want, active } = balloons[i];
        out[i] = !active ? got[k]
          : box ? Math.max(box.top, Math.min(want, box.top + box.height - (heights[i] ?? 0))) : want;
      });
    }
    return out;
  });

  function measure(): void {
    const view = editor?.view;
    if (!view || !host?.isConnected) { balloons = []; return; }
    const state = view.state;
    const open = commentsInMargin() ? visibleComments(state.doc).filter((c) => !c.resolved) : [];
    const seen = new Set<string>();
    const revs = changesInMargin()
      ? visibleRevisions(state.doc).filter((r) => !seen.has(r.id) && seen.add(r.id)) : [];
    if (!open.length && !revs.length) { balloons = []; return; }
    const order = authorColorIndex(revs);
    const activeComment = commentIdAt(state);
    const activeRevision = revisionIdAt(state);
    const dom = view.dom as HTMLElement;
    const rect = dom.getBoundingClientRect();
    // Client rects are in zoom-scaled screen space; page boxes and this layer's own
    // coordinates are unscaled document px, so divide the scale back out.
    const scale = dom.offsetWidth ? rect.width / dom.offsetWidth : 1;

    const out: Balloon[] = [];
    const add = (from: number, to: number, part: Omit<Balloon, 'page' | 'want' | 'anchorX' | 'anchorY' | 'left'>) => {
      let want: number;
      let anchorX: number;
      let anchorY: number;
      try {
        const a = view.coordsAtPos(from);
        const b = view.coordsAtPos(to, -1);
        // An anchor inside text the display mode hides has no box of its own; its card
        // would otherwise stack at the top of the page, pointing nowhere.
        if (a.bottom - a.top < 1) return;
        want = (a.top - rect.top) / scale;
        anchorX = (b.left - rect.left) / scale;
        // The bottom of the line box, not its middle: both word processors run the leader
        // through the gap between two lines, where it crosses no letters.
        anchorY = (b.bottom - rect.top) / scale;
      } catch { return; }
      // The page the line sits on: a narrower section's page is centred in the sheet,
      // so the balloon follows that page's own right edge.
      const found = pageBoxes.findIndex((p) => want >= p.top && want < p.top + p.height);
      const page = found < 0 ? pageBoxes.length - 1 : found;
      const box = pageBoxes[page];
      const left = (box ? box.left + box.width : paperWidth) + cmToPx(BALLOON_GAP_CM);
      out.push({ ...part, page, want, anchorX, anchorY, left });
    };

    for (const c of open) {
      add(c.from, c.to, { key: `c${c.id}`, color: COMMENT_COLOR, active: c.id === activeComment, comment: c });
    }
    for (const r of revs) {
      add(r.from, r.to, {
        key: `r${r.id}`,
        color: REVISION_AUTHOR_COLORS[order.get(r.author) ?? 0],
        active: r.id === activeRevision,
        revision: r,
      });
    }
    out.sort((a, b) => a.want - b.want);
    balloons = out;
  }

  // Clicking a balloon selects the range it belongs to, as clicking a pane card does.
  function select(b: Balloon): void {
    const from = b.comment?.from ?? b.revision?.from;
    const to = b.comment?.to ?? b.revision?.to;
    if (!editor || from === undefined || to === undefined) return;
    selectRange(editor, from, to);
  }

  // The leader: along the gap under the anchor's line, then eased into the balloon's own
  // left edge. It meets the card at the anchor's own height wherever the card reaches
  // that far, so a balloon sitting at its line is joined by one straight line.
  let leaders = $derived(balloons.map((b, i) => {
    const top = tops[i] ?? b.want;
    const h = heights[i] ?? 0;
    const y = b.anchorY;
    const to = h ? Math.min(Math.max(y, top + 10), top + h - 10) : top + 10;
    const turn = Math.max(b.anchorX + 6, b.left - 30);
    const c = Math.max(0, (b.left - turn) / 2);
    return {
      d: `M ${b.anchorX} ${y} H ${turn} C ${turn + c} ${y} ${b.left - c} ${to} ${b.left} ${to}`,
      color: b.color,
      active: b.active,
    };
  }));

  let width = $derived(paperWidth + cmToPx(REVIEW_MARGIN_CM));
  let height = $derived(pageBoxes.length ? pageBoxes[pageBoxes.length - 1].top + pageBoxes[pageBoxes.length - 1].height : 0);
</script>

<div
  class="review-margin-layer"
  bind:this={host}
  style="width: {width}px; height: {height}px; transform: scale({zoom / 100});"
>
  {#if balloons.length}
    <svg width={width} height={height} aria-hidden="true">
      {#each leaders as l}
        <path
          d={l.d}
          fill="none"
          stroke={l.color}
          stroke-width={l.active ? 1.4 : 1}
          stroke-dasharray="3 3"
          stroke-linecap="round"
          opacity={l.active ? 1 : 0.7}
        />
      {/each}
    </svg>
  {/if}
  {#each balloons as b, i (b.key)}
    <div
      bind:this={els[i]}
      class="balloon"
      class:active={b.active}
      style="top: {tops[i] ?? b.want}px; left: {b.left}px; width: {cmToPx(BALLOON_W_CM)}px; border-color: {b.color};"
    >
      {#if b.comment}
        <CommentCard {editor} c={b.comment} {author} compact={!b.active} onSelect={() => select(b)} />
      {:else if b.revision}
        <RevisionCard {editor} r={b.revision} {author} color={b.color} onSelect={() => select(b)} />
      {/if}
    </div>
  {/each}
</div>

<style>
  /* A sibling of .paper inside .paper-scaler, sharing its scale and its origin — the
     page boxes are measured in the same unscaled document px. */
  .review-margin-layer {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: top left;
    pointer-events: none;
  }

  svg {
    position: absolute;
    top: 0;
    left: 0;
  }

  .balloon {
    position: absolute;
    box-sizing: border-box;
    padding: 6px 8px;
    border: 1px solid;
    border-left-width: 3px;
    border-radius: var(--radius);
    background: var(--color-surface);
    color: var(--color-text);
    font-family: var(--font-sans);
    font-size: 11px;
    line-height: 1.35;
    pointer-events: auto;
    /* Nothing may leave the card sideways: a long word in a comment, a wide button row,
       an author name without spaces. Down it grows with its text and never scrolls. */
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  .balloon.active {
    z-index: 1;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
  }

  /* The date beside the author is the balloon's second line of information, not its
     first: smaller than the name it follows. */
  .balloon :global(.meta span) {
    font-size: 10px;
  }
</style>
