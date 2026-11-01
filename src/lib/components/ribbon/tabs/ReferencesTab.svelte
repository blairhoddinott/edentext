<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import RibbonGroup from '../RibbonGroup.svelte';
  import RibbonButton from '../RibbonButton.svelte';
  import CaptionDialog from '../../CaptionDialog.svelte';
  import BibliographyDialog from '../../BibliographyDialog.svelte';
  import IndexUpdateDialog from '../../IndexUpdateDialog.svelte';
  import type { IndexKind } from '../../../editor/extensions/tableOfContents';
  import { anchored, clickOutside, isMenuOpen, toggleMenu, closeMenu } from '../menu.svelte';
  import type { HfZone } from '../../../storage/headerFooter';
  import { t } from '../../../i18n/i18n.svelte';
  import { shortcutHint } from '../../../editor/shortcuts';
  import { HEADING_LEVELS } from '../../../styles/headings';
  import { CITATION_STYLES, type CitationStyle } from '../../../utils/citationStyle';
  import { findBibliography, findToc, hasIndex as hasAnyIndex, markIndexEntry, setIndexAttrs } from '../../referenceState';

  let { editor, tick, hfActive = null, onNoteOptions, onHeadingNumbering }: {
    editor: Editor | null;
    tick: number;
    hfActive?: HfZone | null;
    onNoteOptions?: () => void;
    onHeadingNumbering?: () => void;
  } = $props();

  // The levels button drives a table of contents only — a caption index has one level.
  let toc = $derived(tick >= 0 && editor ? findToc(editor.state.doc) : null);
  let hasIndex = $derived(tick >= 0 && !!editor && hasAnyIndex(editor.state.doc));
  const LEVELS = HEADING_LEVELS;
  const INDEX_KINDS: IndexKind[] = ['toc', 'figures', 'tables', 'alphabetical', 'bibliography'];
  let captionOpen = $state(false);
  let citationOpen = $state(false);
  let updateOpen = $state(false);
  let hasSelection = $derived(tick >= 0 && !!editor && !editor.state.selection.empty);

  function setMaxLevel(level: number) {
    closeMenu();
    if (editor && toc) setIndexAttrs(editor, toc.pos, { maxLevel: level });
  }

  // Word's "Show page numbers" — and what a file's own TOC \n switches off. The menu
  // stays open, as it does for the Layout tab's checkboxes.
  function setPageNumbers(on: boolean) {
    if (editor && toc) setIndexAttrs(editor, toc.pos, { pageNumbers: on });
  }

  // Without a bibliography a document cites by key, and the button stays disabled.
  let bibliography = $derived(tick >= 0 && editor ? findBibliography(editor.state.doc) : null);

  function setCitationStyle(style: CitationStyle) {
    closeMenu();
    if (editor && bibliography) setIndexAttrs(editor, bibliography.pos, { citationStyle: style });
  }
</script>

<RibbonGroup label={t().ribbon.groups.toc}>
  <div class="rb-menu-wrap" use:clickOutside={'indexKind'}>
    <RibbonButton
      variant="big"
      icon="toc"
      cmd="toc"
      label={t().ribbon.toc}
      title={hfActive ? t().toolbarExpanded.tocNotInHf : t().toolbarExpanded.insertToc}
      disabled={!editor || !!hfActive}
      caret
      active={isMenuOpen('indexKind')}
      onclick={() => toggleMenu('indexKind')}
    />
    {#if isMenuOpen('indexKind')}
      <div class="ribbon-menu" use:anchored role="menu">
        {#each INDEX_KINDS as k}
          <button data-cmd={`toc-${k}`} onclick={() => { closeMenu(); editor?.chain().focus().setTableOfContents(k).run(); }}>
            {t().ribbon.indexes[k]}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  <div class="rb-menu-wrap" use:clickOutside={'tocLevels'}>
    <RibbonButton
      variant="big"
      icon="tocLevels"
      cmd="tocOptions"
      label={t().ribbon.tocOptions}
      title={toc ? `${t().ribbon.indexes.toc} – ${t().ribbon.tocOptions}` : t().ribbon.tocOptionsNeedsToc}
      disabled={!toc}
      caret
      active={isMenuOpen('tocLevels')}
      onclick={() => toggleMenu('tocLevels')}
    />
    {#if isMenuOpen('tocLevels')}
      <div class="ribbon-menu" use:anchored role="menu">
        <div class="rb-menu-label">{t().ribbon.indexes.toc}</div>
        <div class="field-label">{t().ribbon.tocMaxLevel}</div>
        <div class="levels">
          {#each LEVELS as l}
            <button class="lvl" class:selected={toc?.maxLevel === l} onclick={() => setMaxLevel(l)}>{l}</button>
          {/each}
        </div>
        <label class="check-row">
          <input type="checkbox" checked={toc?.pageNumbers}
            onchange={(e) => setPageNumbers(e.currentTarget.checked)} />
          {t().ribbon.tocPageNumbers}
        </label>
      </div>
    {/if}
  </div>
  <!-- An index shows what it last listed, as in both word processors, until this: the
       dialog offers Word's two choices, the whole index or its page numbers alone. -->
  <RibbonButton
    variant="big"
    icon="update"
    cmd="tocUpdate"
    label={t().ribbon.tocUpdate}
    title={hasIndex ? t().ribbon.tocUpdateTitle : t().ribbon.tocUpdateNeedsIndex}
    disabled={!hasIndex}
    onclick={() => (updateOpen = true)}
  />
  <RibbonButton
    variant="big"
    icon="headingNumbering"
    cmd="headingNumbering"
    label={t().ribbon.headingNumbering}
    title={t().ribbon.headingNumbering}
    disabled={!onHeadingNumbering}
    onclick={() => onHeadingNumbering?.()}
  />
</RibbonGroup>

<div class="ribbon-sep"></div>

<!-- The options ride the group's ↘ launcher as they do in both word processors, and a
     named button as well: the corner arrow alone is easy to miss. -->
<RibbonGroup label={t().ribbon.groups.notes} onLauncher={onNoteOptions} launcherTitle={t().notesDialog.title}>
  <RibbonButton
    variant="big"
    icon="footnote"
    cmd="footnote"
    label={t().toolbarExpanded.insertFootnote}
    title={hfActive ? t().toolbarExpanded.noteNotInHf : `${t().toolbarExpanded.insertFootnote} (${shortcutHint('footnote')})`}
    disabled={!editor || !!hfActive}
    onclick={() => editor?.chain().focus().insertNote('footnote').run()}
  />
  <RibbonButton
    variant="big"
    icon="endnote"
    cmd="endnote"
    label={t().toolbarExpanded.insertEndnote}
    title={hfActive ? t().toolbarExpanded.noteNotInHf : `${t().toolbarExpanded.insertEndnote} (${shortcutHint('endnote')})`}
    disabled={!editor || !!hfActive}
    onclick={() => editor?.chain().focus().insertNote('endnote').run()}
  />
  <RibbonButton
    variant="big"
    icon="settings"
    cmd="noteOptions"
    label={t().ribbon.noteOptions}
    title={t().notesDialog.title}
    disabled={!onNoteOptions}
    onclick={() => onNoteOptions?.()}
  />
</RibbonGroup>

<div class="ribbon-sep"></div>

<RibbonGroup label={t().ribbon.groups.citations}>
  <RibbonButton
    variant="big"
    icon="citation"
    cmd="citation"
    label={t().ribbon.citation}
    title={hfActive ? t().toolbarExpanded.citationNotInHf : t().bibliography.title}
    disabled={!editor || !!hfActive}
    onclick={() => (citationOpen = true)}
  />
  <div class="rb-menu-wrap" use:clickOutside={'citeStyle'}>
    <RibbonButton
      variant="small"
      icon="citation"
      cmd="citationStyle"
      label={t().bibliography.style}
      title={bibliography ? t().bibliography.style : t().bibliography.styleNeedsIndex}
      caret
      disabled={!editor || !bibliography}
      active={isMenuOpen('citeStyle')}
      onclick={() => toggleMenu('citeStyle')}
    />
    {#if isMenuOpen('citeStyle')}
      <div class="ribbon-menu" use:anchored role="menu">
        {#each CITATION_STYLES as cs}
          <button class:selected={bibliography?.style === cs} onclick={() => setCitationStyle(cs)}>
            {t().bibliography.styles[cs]}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</RibbonGroup>

<div class="ribbon-sep"></div>

<RibbonGroup label={t().ribbon.groups.captions}>
  <RibbonButton
    variant="big"
    icon="caption"
    cmd="caption"
    label={t().ribbon.insertCaption}
    title={hfActive ? t().toolbarExpanded.captionNotInHf : t().caption.title}
    disabled={!editor || !!hfActive}
    onclick={() => (captionOpen = true)}
  />
</RibbonGroup>

<div class="ribbon-sep"></div>

<RibbonGroup label={t().ribbon.groups.index}>
  <RibbonButton
    variant="big"
    icon="bookmark"
    cmd="indexEntry"
    label={t().ribbon.indexEntry}
    title={hasSelection ? t().ribbon.indexEntry : t().ribbon.indexEntryNeedsSelection}
    disabled={!editor || !!hfActive || !hasSelection}
    onclick={() => editor && markIndexEntry(editor)}
  />
</RibbonGroup>

<CaptionDialog bind:open={captionOpen} {editor} />
<BibliographyDialog bind:open={citationOpen} {editor} />
<IndexUpdateDialog bind:open={updateOpen} onPick={(mode) => editor?.chain().focus().updateIndexes(mode).run()} />

<style>
  .rb-menu-wrap { position: relative; }
  /* A toggle among the menu's rows of buttons, as in the Layout tab's own menus. */
  .check-row { display: flex; align-items: center; gap: 6px; padding: 6px 12px; white-space: nowrap; font-size: 13px; }
  .field-label { padding: 2px 12px; font-size: 13px; white-space: nowrap; }
  /* Ten levels as one strip of keys: as rows they were the whole menu. */
  .levels { display: flex; gap: 2px; padding: 2px 10px 4px; }
  .levels .lvl { width: 24px; height: 24px; padding: 0; justify-content: center; }
</style>
