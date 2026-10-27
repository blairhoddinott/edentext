<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import type { CommentRange } from '../editor/extensions/comment';
  import { t } from '../i18n/i18n.svelte';
  import { aiAnswering, aiEnabled, AI_COMMENT_EVENT } from '../storage/ai.svelte';
  import { mentionsAi } from '../ai/tools';

  // One comment thread as both reviewing views show it: the quote it hangs on, its text,
  // the answers to it and a box to add one. Resolve and the ⋯ menu (edit, remove) sit in
  // the head. Shared by the pane's row and the margin balloon, so the commands exist once.
  let { editor, c, author, onSelect, compact = false }: {
    editor: Editor | null;
    c: CommentRange;
    author: string;
    onSelect: () => void;
    /** A balloon not in use: its text cut to a few lines, its answers counted. */
    compact?: boolean;
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let replying = $state(false);
  let reply = $state('');
  let menu = $state(false);
  // Anything being done in the card shows all of it.
  let full = $derived(!compact || editing || replying || menu);

  function startEdit() {
    draft = c.text;
    editing = true;
    menu = false;
  }

  function commit() {
    editor?.chain().focus().updateComment(c.id, { text: draft.trim() }).run();
    editing = false;
  }

  function sendReply() {
    if (!reply.trim()) return;
    editor?.chain().focus().replyToComment(c.id, { author, text: reply }).run();
    if (aiEnabled() && mentionsAi(reply)) window.dispatchEvent(new CustomEvent(AI_COMMENT_EVENT, { detail: { id: c.id } }));
    reply = '';
    replying = false;
  }

  // The stored ISO date, in the reader's locale — an imported file may carry any format.
  function when(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  // Close the ⋯ menu on an outside click or Escape (as HistoryButton's popover does).
  function popover(node: HTMLElement) {
    const onDown = (e: MouseEvent) => { if (!node.contains(e.target as Node)) menu = false; };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') menu = false; };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return {
      destroy() {
        window.removeEventListener('mousedown', onDown);
        window.removeEventListener('keydown', onKey);
      },
    };
  }

  function focus(node: HTMLTextAreaElement) {
    node.focus();
  }

  // A box as tall as what is typed in it: the card grows instead of scrolling inside.
  function autosize(node: HTMLTextAreaElement) {
    const fit = () => { node.style.height = 'auto'; node.style.height = `${node.scrollHeight + 2}px`; };
    node.addEventListener('input', fit);
    requestAnimationFrame(fit);
    return { destroy: () => node.removeEventListener('input', fit) };
  }
</script>

<div class="popover" use:popover>
<div class="head">
  <button class="card" onclick={onSelect}>
    <div class="meta">
      <b>{c.author || author || t().revisions.unknownAuthor}</b>
      <span>{when(c.date)}</span>
    </div>
  </button>
  <button
    class="tool"
    class:on={c.resolved}
    aria-label={c.resolved ? t().comments.reopen : t().comments.resolve}
    title={c.resolved ? t().comments.reopen : t().comments.resolve}
    aria-pressed={c.resolved}
    onclick={() => editor?.chain().focus().updateComment(c.id, { resolved: !c.resolved }).run()}
  >✓</button>
  <button
    class="tool more"
    aria-label={t().comments.more}
    title={t().comments.more}
    aria-expanded={menu}
    onclick={() => (menu = !menu)}
  >⋯</button>
</div>
{#if menu}
  <!-- In the flow, not floating: the balloon clips what leaves it, and a menu of three
       rows fits under the head in either view. -->
  <div class="menu">
    <button onclick={startEdit}>{t().comments.edit}</button>
    <button onclick={() => { menu = false; editor?.chain().focus().removeComment(c.id).run(); }}>{t().common.remove}</button>
  </div>
{/if}
</div>
<button class="card" onclick={onSelect}>
  <div class="quote">{c.quote}</div>
</button>
{#if editing}
  <textarea
    rows="2"
    use:focus
    use:autosize
    bind:value={draft}
    onkeydown={(e) => { if (e.key === 'Escape') editing = false; }}
  ></textarea>
  <div class="actions">
    <button onclick={() => (editing = false)}>{t().common.cancel}</button>
    <button class="primary" onclick={commit}>{t().common.ok}</button>
  </div>
{:else if full}
  <p class="body">{c.text}</p>
{:else}
  <!-- Cut to a few lines; a click opens the card, as clicking its text does. -->
  <button class="card body clamp" onclick={onSelect}>{c.text}</button>
{/if}

{#if full}
  {#each c.replies as r, i (i)}
    <div class="reply">
      <div class="meta"><b>{r.author || author || t().revisions.unknownAuthor}</b><span>{when(r.date)}</span></div>
      <p class="body">{r.text}</p>
    </div>
  {/each}
{:else if c.replies.length}
  <button class="card replies" onclick={onSelect}>{t().comments.replies(c.replies.length)}</button>
{/if}

{#if aiAnswering.get(c.id) === ''}
  <div class="reply ai-working" role="status"><span class="spinner" aria-hidden="true"></span>{t().ai.answering}</div>
{:else if aiAnswering.has(c.id)}
  <div class="reply ai-error" role="alert">{aiAnswering.get(c.id)}</div>
{/if}

{#if replying}
  <textarea
    rows="1"
    use:focus
    use:autosize
    bind:value={reply}
    placeholder={t().comments.reply}
    onkeydown={(e) => { if (e.key === 'Escape') replying = false; }}
  ></textarea>
  <div class="actions">
    <button onclick={() => { replying = false; reply = ''; }}>{t().common.cancel}</button>
    <button class="primary" onclick={sendReply}>{t().comments.reply}</button>
  </div>
{:else if !editing}
  <div class="actions">
    <button onclick={() => (replying = true)}>{t().comments.reply}</button>
  </div>
{/if}

<style>
  .ai-error { color: #e5534b; }
  .ai-working { display: flex; align-items: center; gap: 6px; color: var(--color-text-muted); }
  .spinner { width: 10px; height: 10px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Head and menu form one popover, so a press on a menu row is not an outside click. */
  .popover { display: contents; }
  .head { display: flex; align-items: flex-start; gap: 2px; }
  .head .card { flex: 1; min-width: 0; }

  .card {
    display: block;
    width: 100%;
    border: none;
    background: none;
    color: inherit;
    padding: 0;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }

  /* Author over date: a name of any length keeps the date on a line of its own. */
  .meta { display: flex; flex-direction: column; color: var(--color-text-muted); }
  .meta b { color: var(--color-text); }
  .reply .meta { flex-direction: row; flex-wrap: wrap; column-gap: 6px; }

  /* Always drawn in the text colour: an action the reader cannot see is not offered. */
  .tool {
    flex: none;
    width: 22px;
    height: 22px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: none;
    color: var(--color-text);
    padding: 0;
    font: inherit;
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }
  .tool.more { font-size: 16px; }
  .tool:hover { background: var(--color-btn-hover); }
  .tool.on { border-color: var(--color-primary); background: var(--color-primary); color: #fff; }

  .menu { display: flex; flex-direction: column; align-items: stretch; margin: 2px 0; }
  .menu button {
    border: none;
    border-radius: var(--radius);
    background: none;
    color: var(--color-text);
    padding: 3px 6px;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .menu button:hover { background: var(--color-btn-hover); }

  .quote {
    margin: 3px 0;
    padding-left: 6px;
    border-left: 2px solid rgba(200, 140, 0, 0.7);
    color: var(--color-text-muted);
    /* Two lines of the annotated text is enough to recognise it. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .body { margin: 4px 0; white-space: pre-wrap; }
  .body.clamp {
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .replies { margin-top: 2px; color: var(--color-text-muted); }

  /* An answer is indented under the comment it belongs to, as in a threaded pane. */
  .reply {
    margin-top: 4px;
    padding-left: 6px;
    border-left: 1px solid var(--color-border);
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface);
    color: var(--color-text);
    padding: 4px 6px;
    font: inherit;
    resize: none;
    overflow: hidden;
  }

  /* Wraps: the balloon is as wide as it is and a locale's labels are as long as they
     are — an unwrapped row would push its first button out of the card. */
  .actions { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
  .actions button {
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: none;
    color: var(--color-text-muted);
    padding: 2px 6px;
    font: inherit;
    cursor: pointer;
  }
  .actions button:hover { background: var(--color-btn-hover); color: var(--color-text); }
  .actions .primary { border-color: var(--color-primary); background: var(--color-primary); color: #fff; }
</style>
