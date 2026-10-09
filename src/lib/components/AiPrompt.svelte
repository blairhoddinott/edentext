<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import { t } from '../i18n/i18n.svelte';
  import { dragWindow } from '../utils/dragWindow';
  import { aiConfig, OPEN_AI_PROMPT_EVENT } from '../storage/ai.svelte';
  import { LANGUAGES } from '../storage/documentLanguage';
  import { streamChat, aiErrorText, isAbort } from '../ai/client';
  import { contentToDom, htmlToSlice } from '../ai/doc';
  import { REWRITE_PRESETS, startRequest, endRequest } from '../ai/tools';
  import { COMMANDS, captureTarget, commandRequest, insertBelowTarget, replaceTarget, uiLanguage, type Target } from '../ai/commands';
  import Icon from './ribbon/Icon.svelte';

  // Quick inline rewrite of the selection; drafting and longer work happen in the chat.
  // The reply streams into a preview and touches the document only when the user takes
  // it, so a half-written answer never lands in the text or the history.
  let { editor }: { editor: Editor | null } = $props();

  type Preset = keyof typeof REWRITE_PRESETS;
  const PRESETS: Preset[] = ['rephrase', 'shorten', 'formal', 'fix', 'translate'];
  const TARGETS = [...new Set(LANGUAGES.map((l) => l.label))];

  let open = $state(false);
  let instruction = $state('');
  let language = $state('');
  let reply = $state('');
  let error = $state('');
  let busy = $state(false);
  let win = $state<HTMLElement | null>(null);
  let input = $state<HTMLTextAreaElement | null>(null);
  let preview = $state<HTMLElement | null>(null);
  let pos = $state<{ left: number; top: number } | null>(null);
  // What the window works on, fixed when it opens.
  let target: Target = { from: 0, to: 0, original: '', html: '' };
  let request: AbortController | null = null;

  function show() {
    if (!editor) return;
    const { state, view } = editor;
    if (state.selection.empty) return;
    stop();
    target = captureTarget(state);
    instruction = '';
    reply = '';
    error = '';
    language ||= uiLanguage();
    const at = view.coordsAtPos(target.to);
    pos = { left: Math.max(8, Math.min(window.innerWidth - 440, at.left)), top: Math.max(8, Math.min(window.innerHeight - 380, at.bottom + 8)) };
    open = true;
    queueMicrotask(() => input?.focus());
  }

  $effect(() => {
    const onOpen = () => show();
    window.addEventListener(OPEN_AI_PROMPT_EVENT, onOpen);
    return () => { window.removeEventListener(OPEN_AI_PROMPT_EVENT, onOpen); stop(); };
  });

  $effect(() => {
    if (!win) return;
    if (open && !win.matches(':popover-open')) win.showPopover();
    else if (!open && win.matches(':popover-open')) win.hidePopover();
  });

  // The streamed reply re-parsed once a frame, through the schema like the final insert.
  let frame = 0;
  $effect(() => {
    const text = reply;
    if (!preview || !editor) return;
    const el = preview;
    const ed = editor;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => el.replaceChildren(text ? contentToDom(htmlToSlice(text, ed.state).content, ed.schema) : ''));
  });

  function stop() {
    request?.abort();
    if (request) endRequest(request);
    request = null;
    busy = false;
  }

  function close() {
    stop();
    open = false;
    editor?.commands.focus();
  }

  async function generate(preset?: Preset) {
    if (!editor || busy) return;
    const cfg = aiConfig();
    if (!cfg) { error = t().ai.notConfigured; return; }
    const command = COMMANDS.find((c) => (preset ? c.preset === preset : c.name === 'rewrite'))!;
    const made = commandRequest(command, preset ? '' : instruction.trim(), editor.state, target, language);
    if (!made) return;
    reply = '';
    error = '';
    busy = true;
    const mine = (request = startRequest());
    try {
      await streamChat(cfg, made.request, (d) => (reply += d), mine.signal);
    } catch (e) {
      if (!isAbort(e)) error = aiErrorText(e, t().ai.errors, cfg.endpoint);
    } finally {
      endRequest(mine);
      if (request === mine) { request = null; busy = false; }
    }
  }

  function take(apply: typeof replaceTarget) {
    if (!editor || !reply) return;
    if (apply(editor, target, reply)) close();
    else error = t().ai.selectionChanged;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && !e.shiftKey && e.target === input) { e.preventDefault(); void generate(); }
  }
</script>

<div
  bind:this={win}
  class="aip"
  popover="manual"
  role="dialog"
  aria-label={t().ai.rewriteHeading}
  tabindex="-1"
  onkeydown={onKeydown}
  style={pos ? `left:${pos.left}px; top:${pos.top}px;` : undefined}
>
  <div class="aip-bar" use:dragWindow={(p) => (pos = p)}>
    <Icon name="sparkle" size={16} />
    <span>{t().ai.rewriteHeading}</span>
    <button class="aip-x" onclick={close} aria-label={t().common.close}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
    </button>
  </div>

  <div class="aip-presets">
    {#each PRESETS as p (p)}
      <button class="aip-chip" disabled={busy} onclick={() => generate(p)}>{t().ai.presets[p]}</button>
    {/each}
    <select bind:value={language} disabled={busy} aria-label={t().ai.presets.translate}>
      {#each TARGETS as l (l)}<option value={l}>{l}</option>{/each}
    </select>
  </div>

  <div class="aip-ask">
    <textarea
      bind:this={input}
      bind:value={instruction}
      rows="2"
      placeholder={t().ai.rewritePlaceholder}
    ></textarea>
    {#if busy}
      <button onclick={stop}>{t().ai.stop}</button>
    {:else}
      <button class="aip-go" disabled={!instruction.trim()} onclick={() => generate()}>{t().ai.generate}</button>
    {/if}
  </div>

  <div class="aip-preview" class:empty={!reply} bind:this={preview} aria-live="polite"></div>
  {#if error}<div class="aip-error" role="alert">{error}</div>{/if}

  <div class="aip-actions">
    {#if busy}
      <span class="aip-note aip-working" role="status"><span class="spinner" aria-hidden="true"></span>{t().ai.working}</span>
    {:else}
      <span class="aip-note">{t().ai.disclaimer}</span>
    {/if}
    <button class="aip-go" disabled={!reply || busy} onclick={() => take(replaceTarget)}>{t().ai.replace}</button>
    <button disabled={!reply || busy} onclick={() => take(insertBelowTarget)}>{t().ai.insertBelow}</button>
    <button onclick={close}>{t().ai.discard}</button>
  </div>
</div>

<style>
  /* The ribbon's accent tokens, so both themes and a picked accent stay readable. */
  .aip {
    position: fixed;
    inset: 9rem 2rem auto auto;
    margin: 0;
    z-index: 300;
    width: 28rem;
    max-width: calc(100vw - 16px);
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-toolbar-bg, #fff);
    color: var(--color-text);
    box-shadow: var(--w-menu-shadow, 0 8px 28px rgba(0, 0, 0, 0.22));
    font-size: 0.8rem;
  }
  .aip::before { content: ''; display: block; height: 3px; background: var(--brand-gradient); }
  .aip[style] { right: auto; }

  .aip-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.5rem 0.2rem 0.8rem;
    color: var(--w-accent);
    font-weight: 600;
    cursor: move;
    touch-action: none;
  }
  .aip-bar span { flex: 1; color: var(--color-text); font-size: 0.85rem; }
  .aip-x {
    display: flex;
    height: auto;
    padding: 0.3rem;
    border: none;
    color: var(--color-text-muted);
  }
  .aip-x:hover { color: var(--color-text); }

  .aip-presets { display: flex; flex-wrap: wrap; gap: 0.35rem; padding: 0.5rem 0.8rem 0; }
  .aip-chip, .aip-presets select { border-radius: 999px; }
  .aip-chip:hover:not(:disabled) { border-color: var(--w-accent); background: var(--w-accent-soft); }
  .aip-ask { display: flex; gap: 0.4rem; align-items: flex-end; padding: 0.6rem 0.8rem; }
  textarea {
    flex: 1;
    resize: vertical;
    min-height: 2.6rem;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
  }
  textarea:focus { outline: none; border-color: var(--w-accent); box-shadow: 0 0 0 3px var(--w-accent-soft); }

  .aip-preview {
    max-height: 16rem;
    overflow-y: auto;
    margin: 0 0.8rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--w-accent);
    border-radius: 8px;
    background: var(--color-page-bg, #fff);
    color: #000;
    font-family: var(--font-serif, serif);
    font-size: 0.9rem;
    line-height: 1.4;
  }
  .aip-preview.empty { display: none; }
  .aip-preview :global(p) { margin: 0 0 0.4em; }
  .aip-preview :global(table) { border-collapse: collapse; }
  .aip-preview :global(td), .aip-preview :global(th) { border: 1px solid #999; padding: 2px 4px; }
  .aip-error { margin: 0.5rem 0.8rem 0; color: #e5534b; }

  .aip-actions { display: flex; align-items: center; gap: 0.4rem; padding: 0.6rem 0.8rem 0.8rem; }
  .aip-note { flex: 1; color: var(--color-text-muted); font-size: 0.72rem; }
  .aip-working { display: flex; align-items: center; gap: 6px; }

  button, select {
    height: 1.9rem;
    padding: 0 0.7rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: transparent;
    color: var(--color-text);
    font-size: 0.8rem;
    cursor: pointer;
  }
  .aip-presets select { max-width: 9rem; }
  button:hover:not(:disabled) { background: var(--color-btn-hover); }
  button:disabled, select:disabled { opacity: 0.45; cursor: default; }
  .aip-go { border-color: var(--w-accent-fill); background: var(--w-accent-fill); color: #fff; font-weight: 600; }
  .aip-go:hover:not(:disabled) { border-color: var(--w-accent-fill-open); background: var(--w-accent-fill-open); }
</style>
