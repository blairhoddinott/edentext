<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import { revisionIdAt, type Revision } from '../editor/extensions/trackChanges';
  import { authorColor, authorColors } from '../editor/authorColors';
  import { listedRevisions, selectRange } from './reviewItems';
  import { openZone } from '../editor/zoneReview';
  import RevisionCard from './RevisionCard.svelte';
  import { t } from '../i18n/i18n.svelte';

  // The reviewing pane both word processors list revisions in, beside the comments one:
  // every recorded change in document order, click to jump, accept or reject in place.
  // The balloons beside the page are the other view; both build their card from RevisionCard.
  let { editor, tick, author, onClose }: {
    editor: Editor | null;
    tick: number;
    author: string;
    onClose: () => void;
  } = $props();

  // One row per change, not per range: a paragraph boundary splits one change in two.
  let list = $derived.by<Revision[]>(() => {
    if (tick < 0 || !editor) return [];
    const seen = new Set<string>();
    return listedRevisions(editor.state.doc).filter((r) => {
      const key = r.moved ? r.moveId! : r.id;
      return !seen.has(key) && seen.add(key);
    });
  });

  let colors = $derived.by(() => (tick < 0 || !editor ? new Map<string, string>() : authorColors(editor.state.doc)));

  // The change the caret sits in: its card is marked and pulled into view, so the
  // margin bar beside the text and the row here name each other.
  let activeId = $derived.by<string | null>(() => {
    if (tick < 0 || !editor) return null;
    return revisionIdAt(editor.state);
  });

  let cards: Record<string, HTMLElement | null> = {};
  $effect(() => {
    if (activeId) cards[activeId]?.scrollIntoView({ block: 'nearest' });
  });

  function colorOf(r: Revision): string {
    return authorColor(colors, r.author);
  }

  function jumpTo(r: Revision) {
    if (r.zone) openZone(r.zone, (zone) => selectRange(zone, r.from, r.to));
    else if (editor) selectRange(editor, r.from, r.to);
  }
</script>

<aside class="revisions-pane" aria-label={t().revisions.pane}>
  <header>
    <span class="title">{t().revisions.pane}</span>
    <span class="count">{list.length}</span>
    <button class="close" onclick={onClose} aria-label={t().common.close} title={t().common.close}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
    </button>
  </header>

  {#if !list.length}
    <p class="empty">{t().revisions.empty}</p>
  {/if}

  <ul>
    {#each list as r (r.id)}
      <li bind:this={cards[r.id]} class:active={r.id === activeId} style:box-shadow={r.id === activeId ? `inset 3px 0 0 ${colorOf(r)}` : null}>
        <RevisionCard {editor} {r} {author} color={colorOf(r)} onSelect={() => jumpTo(r)} />
      </li>
    {/each}
  </ul>
</aside>

<style>
  .revisions-pane {
    display: flex;
    flex-direction: column;
    flex: 0 0 260px;
    min-width: 0;
    overflow-y: auto;
    border-left: 1px solid var(--color-border);
    background: var(--color-surface);
    font-family: var(--font-sans);
    font-size: 0.8rem;
  }

  header {
    display: flex;
    align-items: center;
    gap: 6px;
    position: sticky;
    top: 0;
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
  }
  .title { flex: 1; font-weight: 600; }
  .count { color: var(--color-text-muted); }
  .close {
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: none;
    color: var(--color-text-muted);
    padding: 2px 6px;
    font: inherit;
    cursor: pointer;
  }
  .close:hover { background: var(--color-btn-hover); color: var(--color-text); }

  .empty { padding: 12px 10px; color: var(--color-text-muted); }

  ul { list-style: none; margin: 0; padding: 0; }

  li {
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-border);
  }
  /* The accent is the author's colour, set inline — the same one the margin bar takes. */
  li.active { background: var(--color-btn-hover); }
</style>
