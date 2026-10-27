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
  // A clicked card and where every card was: the view scrolls by as much as it moves.
  let hold: { key: string; top: number; from: Map<string, number> } | null = null;
  // While that scroll runs, each card glides from where it was on the same curve.
  let glide = $state<{ from: Map<string, number>; p: number } | null>(null);
  let glideFrame = 0;
  const GLIDE_MS = 300;
  // How far the wheel has moved the column on its own, without the page; a card made
  // active lines the stack up afresh.
  let shift = $state(0);
  let wheeling = $state(false);
  let wheelIdle = 0;
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
    const read = () => els.slice(0, list.length).map((e) => e?.offsetHeight ?? 0);
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
  // With a card active the column is one, as in both word processors: that card sits at
  // its line and every other one stacks around it, past page edges and the top if need be.
  let tops = $derived.by(() => {
    const pin = balloons.findIndex((b) => b.active);
    if (pin >= 0) return stackTops(balloons.map((b) => b.want), balloons.map((_, i) => heights[i] ?? 0), STACK_GAP_PX, -Infinity, Infinity, pin);
    const out = new Array<number>(balloons.length).fill(0);
    let floor = -Infinity;
    for (const { box, idx } of groups) {
      const h = idx.map((i) => heights[i] ?? 0);
      const got = stackTops(
        idx.map((i) => balloons[i].want),
        h,
        STACK_GAP_PX,
        Math.max(box ? box.top : -Infinity, floor),
        box ? box.top + box.height : Infinity,
      );
      const last = got.length - 1;
      if (last >= 0) floor = got[last] + h[last] + STACK_GAP_PX;
      idx.forEach((i, k) => { out[i] = got[k]; });
    }
    return out;
  });

  let placed = $derived(tops.map((t) => t + shift));
  let shown = $derived(glide
    ? placed.map((t, i) => { const was = glide!.from.get(balloons[i]?.key) ?? t; return t + (was - t) * (1 - glide!.p); })
    : placed);

  // A clicked card stays under the pointer: once the stack has moved it to its line, the
  // view scrolls smoothly by the same amount and the cards glide on the same curve, so
  // its text slides up beside it.
  $effect(() => {
    const t = placed;
    if (!hold) return;
    const i = balloons.findIndex((b) => b.key === hold?.key);
    if (i < 0 || !balloons[i].active) return;
    const delta = ((t[i] - hold.top) * zoom) / 100;
    const from = hold.from;
    hold = null;
    const scroller = host?.closest('.editor');
    if (!scroller || Math.abs(delta) < 0.5) return;
    const start = scroller.scrollTop;
    const begin = performance.now();
    const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : GLIDE_MS;
    cancelAnimationFrame(glideFrame);
    const step = (now: number) => {
      const x = ms ? Math.min(1, (now - begin) / ms) : 1;
      const p = 1 - (1 - x) ** 3;
      scroller.scrollTop = start + delta * p;
      glide = x < 1 ? { from, p } : null;
      if (x < 1) glideFrame = requestAnimationFrame(step);
    };
    glide = { from, p: 0 };
    glideFrame = requestAnimationFrame(step);
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
    if (out.find((b) => b.active)?.key !== balloons.find((b) => b.active)?.key) shift = 0;
    balloons = out;
  }

  // Clicking a balloon selects the range it belongs to, as clicking a pane card does; the
  // view follows the card (above) rather than jumping to the text.
  function select(b: Balloon): void {
    const from = b.comment?.from ?? b.revision?.from;
    const to = b.comment?.to ?? b.revision?.to;
    if (!editor || from === undefined || to === undefined) return;
    const i = balloons.indexOf(b);
    if (!b.active && i >= 0) hold = { key: b.key, top: placed[i], from: new Map(balloons.map((x, k) => [x.key, shown[k]])) };
    selectRange(editor, from, to, false);
  }

  // The leader: along the gap under the anchor's line, then eased into the balloon's own
  // left edge. It meets the card at the anchor's own height wherever the card reaches
  // that far, so a balloon sitting at its line is joined by one straight line.
  let leaders = $derived(balloons.map((b, i) => {
    const top = shown[i] ?? b.want;
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

  // The wheel over the column moves the stack, not the page, as a scroll box would: only
  // as far as its first and last card reach the edges of what is shown of the document.
  // Ctrl+wheel stays the zoom, sideways stays the page's.
  function wheel(node: HTMLElement) {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || !balloons.length) return;
      const scroller = node.closest('.editor');
      if (!scroller) return;
      e.preventDefault();
      cancelAnimationFrame(glideFrame);
      glide = null;
      const scale = zoom / 100;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1;
      const view = scroller.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const shownTop = Math.max(0, (view.top - box.top) / scale);
      const shownBottom = Math.min(height, (view.bottom - box.top) / scale);
      const last = balloons.length - 1;
      const bottom = tops[last] + (heights[last] ?? 0);
      const lo = Math.min(0, shownBottom - bottom);
      // Down no further than the document's end, unless the stack already runs past it.
      const hi = Math.max(0, Math.min(shownTop - tops[0], height - bottom));
      shift = Math.min(Math.max(shift - (e.deltaY * unit) / scale, lo), hi);
      wheeling = true;
      clearTimeout(wheelIdle);
      wheelIdle = window.setTimeout(() => { wheeling = false; }, 150);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', onWheel) };
  }

  // The column the wheel reaches: under the cards and the gaps between them.
  let strip = $derived(balloons.length ? Math.min(...balloons.map((b) => b.left)) : 0);

  let width = $derived(paperWidth + cmToPx(REVIEW_MARGIN_CM));
  let height = $derived(pageBoxes.length ? pageBoxes[pageBoxes.length - 1].top + pageBoxes[pageBoxes.length - 1].height : 0);
</script>

<div
  class="review-margin-layer"
  class:layer-instant={!!glide || wheeling}
  bind:this={host}
  use:wheel
  style="width: {width}px; height: {height}px; transform: scale({zoom / 100});"
>
  {#if balloons.length}
    <svg width={width} height={height} aria-hidden="true">
      {#each leaders as l}
        <path
          d={l.d}
          style:d={`path("${l.d}")`}
          fill="none"
          stroke={l.color}
          stroke-width={l.active ? 1.4 : 1}
          stroke-dasharray="3 3"
          stroke-linecap="round"
          opacity={l.active ? 1 : 0.7}
        />
      {/each}
    </svg>
    <div class="wheel-strip" style="left: {strip}px; width: {cmToPx(BALLOON_W_CM)}px; height: {height}px;"></div>
  {/if}
  {#each balloons as b, i (b.key)}
    <div
      bind:this={els[i]}
      class="balloon"
      class:active={b.active}
      class:instant={!!glide || wheeling}
      style="top: {shown[i] ?? b.want}px; left: {b.left}px; width: {cmToPx(BALLOON_W_CM)}px; border-color: {b.color};"
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

  /* Visible past its box: a card stacked beyond the document still gets its leader. */
  svg {
    position: absolute;
    top: 0;
    left: 0;
    overflow: visible;
  }

  .wheel-strip {
    position: absolute;
    top: 0;
    pointer-events: auto;
  }

  /* The stack slides into place around the active card; its leaders follow where the
     browser animates a path's geometry. */
  path,
  .balloon {
    transition: d 180ms ease, top 180ms ease;
  }

  .layer-instant path,
  .balloon.instant {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    path,
    .balloon {
      transition: none;
    }
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
