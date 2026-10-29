<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import IslandButton from './IslandButton.svelte';
  import IslandMenu from './IslandMenu.svelte';
  import CaptionDialog from '../CaptionDialog.svelte';
  import BibliographyDialog from '../BibliographyDialog.svelte';
  import IndexUpdateDialog from '../IndexUpdateDialog.svelte';
  import { closeMenu } from '../ribbon/menu.svelte';
  import { findBibliography, findToc, hasIndex, markIndexEntry, setIndexAttrs } from '../referenceState';
  import type { IndexKind } from '../../editor/extensions/tableOfContents';
  import type { HfZone } from '../../storage/headerFooter';
  import { HEADING_LEVELS } from '../../styles/headings';
  import { CITATION_STYLES } from '../../utils/citationStyle';
  import { t } from '../../i18n/i18n.svelte';
  import { shortcutHint } from '../../editor/shortcuts';

  // The References category, as the ribbon's References tab.
  let { editor, tick, hfActive = null, onNoteOptions, onHeadingNumbering }: {
    editor: Editor | null;
    tick: number;
    hfActive?: HfZone | null;
    onNoteOptions?: () => void;
    onHeadingNumbering?: () => void;
  } = $props();

  const INDEX_KINDS: IndexKind[] = ['toc', 'figures', 'tables', 'alphabetical', 'bibliography'];
  let toc = $derived(tick >= 0 && editor ? findToc(editor.state.doc) : null);
  let anyIndex = $derived(tick >= 0 && !!editor && hasIndex(editor.state.doc));
  let bibliography = $derived(tick >= 0 && editor ? findBibliography(editor.state.doc) : null);
  let hasSelection = $derived(tick >= 0 && !!editor && !editor.state.selection.empty);

  let captionOpen = $state(false);
  let citationOpen = $state(false);
  let updateOpen = $state(false);
</script>

<div class="toolbar-group">
  <IslandMenu id="indexKind" icon="toc" cmd="toc" title={hfActive ? t().toolbarExpanded.tocNotInHf : t().toolbarExpanded.insertToc} disabled={!editor || !!hfActive}>
    {#each INDEX_KINDS as k}
      <button data-cmd={`toc-${k}`} onclick={() => { closeMenu(); editor?.chain().focus().setTableOfContents(k).run(); }}>{t().ribbon.indexes[k]}</button>
    {/each}
  </IslandMenu>
  <!-- The menu stays open on a change, as the Layout menus' checkboxes do. -->
  <IslandMenu id="tocLevels" icon="tocLevels" cmd="tocOptions" title={`${t().ribbon.indexes.toc} – ${t().ribbon.tocOptions}`} disabled={!toc}>
    <div class="im-label">{t().ribbon.tocMaxLevel}</div>
    <div class="levels">
      {#each HEADING_LEVELS as l}
        <button class="lvl" class:selected={toc?.maxLevel === l} onclick={() => { closeMenu(); if (editor && toc) setIndexAttrs(editor, toc.pos, { maxLevel: l }); }}>{l}</button>
      {/each}
    </div>
    <label class="im-row">
      <input type="checkbox" checked={toc?.pageNumbers} onchange={(e) => editor && toc && setIndexAttrs(editor, toc.pos, { pageNumbers: e.currentTarget.checked })} />
      {t().ribbon.tocPageNumbers}
    </label>
  </IslandMenu>
  <IslandButton icon="update" cmd="tocUpdate" title={t().ribbon.tocUpdateTitle} disabled={!anyIndex} onclick={() => (updateOpen = true)} />
  <IslandButton icon="headingNumbering" cmd="headingNumbering" title={t().ribbon.headingNumbering} disabled={!onHeadingNumbering} onclick={() => onHeadingNumbering?.()} />
</div>

<div class="toolbar-separator"></div>

<div class="toolbar-group">
  <IslandButton icon="footnote" cmd="footnote" title={hfActive ? t().toolbarExpanded.noteNotInHf : `${t().toolbarExpanded.insertFootnote} (${shortcutHint('footnote')})`} disabled={!editor || !!hfActive} onclick={() => editor?.chain().focus().insertNote('footnote').run()} />
  <IslandButton icon="endnote" cmd="endnote" title={hfActive ? t().toolbarExpanded.noteNotInHf : `${t().toolbarExpanded.insertEndnote} (${shortcutHint('endnote')})`} disabled={!editor || !!hfActive} onclick={() => editor?.chain().focus().insertNote('endnote').run()} />
  <IslandButton icon="settings" cmd="noteOptions" title={t().notesDialog.title} disabled={!onNoteOptions} onclick={() => onNoteOptions?.()} />
</div>

<div class="toolbar-separator"></div>

<div class="toolbar-group">
  <IslandButton icon="citation" cmd="citation" title={t().bibliography.title} disabled={!editor || !!hfActive} onclick={() => (citationOpen = true)} />
  <IslandMenu id="citeStyle" label={t().bibliography.style} cmd="citationStyle" title={bibliography ? t().bibliography.style : t().bibliography.styleNeedsIndex} disabled={!editor || !bibliography}>
    {#each CITATION_STYLES as cs}
      <button class:selected={bibliography?.style === cs} onclick={() => { closeMenu(); if (editor && bibliography) setIndexAttrs(editor, bibliography.pos, { citationStyle: cs }); }}>
        {t().bibliography.styles[cs]}
      </button>
    {/each}
  </IslandMenu>
</div>

<div class="toolbar-separator"></div>

<div class="toolbar-group">
  <IslandButton icon="caption" cmd="caption" title={t().caption.title} disabled={!editor || !!hfActive} onclick={() => (captionOpen = true)} />
  <IslandButton icon="bookmark" cmd="indexEntry" title={hasSelection ? t().ribbon.indexEntry : t().ribbon.indexEntryNeedsSelection} disabled={!editor || !!hfActive || !hasSelection} onclick={() => editor && markIndexEntry(editor)} />
</div>

<CaptionDialog bind:open={captionOpen} {editor} />
<BibliographyDialog bind:open={citationOpen} {editor} />
<IndexUpdateDialog bind:open={updateOpen} onPick={(mode) => editor?.chain().focus().updateIndexes(mode).run()} />

<style>
  /* The levels as one strip of keys: as rows they would be the whole menu. */
  .levels { display: flex; gap: 2px; padding: 2px 6px 4px; }
  .levels .lvl { width: 24px; height: 24px; padding: 0; justify-content: center; }
</style>
