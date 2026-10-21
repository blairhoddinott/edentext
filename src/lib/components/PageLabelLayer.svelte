<script lang="ts">
  // The sheet number beside each page's bottom right corner, as Word for the web shows
  // it. Outside .paper, which clips horizontally, so it scales positions but not its text;
  // `width` ends the layer where the scroller does, so a label never adds a scrollbar.
  let { pageBoxes, zoom, width }: {
    pageBoxes: { top: number; left: number; height: number; width: number }[];
    zoom: number;
    width: number;
  } = $props();
</script>

<div class="page-label-layer" aria-hidden="true" style:width="{width}px">
  {#each pageBoxes as box, i}
    <span class="page-label" style="top: {Math.round((box.top + box.height) * zoom / 100) - 18}px; left: {Math.round((box.left + box.width) * zoom / 100) + 8}px;">{i + 1}</span>
  {/each}
</div>

<style>
  .page-label-layer {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    overflow: clip;
    pointer-events: none;
  }

  .page-label {
    position: absolute;
    font-size: 11px;
    line-height: 11px;
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
    user-select: none;
  }
</style>
