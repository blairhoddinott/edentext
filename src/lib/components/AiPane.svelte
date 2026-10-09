<script module lang="ts">
  import type { ChatMessage } from '../ai/client';

  type Entry = { role: 'user' | 'assistant'; text: string; tools: string[]; error: string };

  // The conversation outlives the pane being closed, not a reload: nothing is stored.
  let entries = $state<Entry[]>([]);
  let history: ChatMessage[] = [];

  /** A new document starts a new chat — the old one talks about other paragraphs. */
  export function resetAiChat(): void {
    entries = [];
    history = [];
  }
</script>

<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import { t } from '../i18n/i18n.svelte';
  import { aiConfig } from '../storage/ai.svelte';
  import { showChanges, setShowChanges } from '../storage/markup.svelte';
  import { revisions } from '../editor/extensions/trackChanges';
  import { aiErrorText, isAbort } from '../ai/client';
  import { contentToDom, htmlToSlice } from '../ai/doc';
  import { runTurn, startRequest, endRequest } from '../ai/tools';
  import Icon from './ribbon/Icon.svelte';

  // Copilot's chat pane: questions about the document with the document as context, and
  // changes the assistant makes through its tools — text edits as tracked changes under
  // its own author, which the Review pane accepts or rejects like anyone else's.
  let { editor, onClose }: { editor: Editor | null; onClose: () => void } = $props();

  let question = $state('');
  let busy = $state(false);
  let list = $state<HTMLElement | null>(null);
  let request: AbortController | null = null;
  let configured = $derived(!!aiConfig());
  // The selection goes with every question (serializeDoc); the chip shows that it does.
  let selected = $state('');

  $effect(() => {
    const ed = editor;
    if (!ed) return;
    const read = () => {
      const { from, to } = ed.state.selection;
      const text = ed.state.doc.textBetween(from, to, ' ', ' ').replace(/\s+/g, ' ').trim();
      selected = text.length > 40 ? text.slice(0, 40) + '…' : text;
    };
    read();
    ed.on('selectionUpdate', read);
    ed.on('update', read);
    return () => { ed.off('selectionUpdate', read); ed.off('update', read); };
  });

  function clearSelection() {
    if (editor) editor.commands.setTextSelection(editor.state.selection.to);
  }

  const SUGGESTIONS = ['summarize', 'keyPoints', 'proofread'] as const;

  // Keeps the newest message in view while it streams.
  $effect(() => {
    void entries.length;
    void entries[entries.length - 1]?.text;
    if (list) list.scrollTop = list.scrollHeight;
  });

  $effect(() => () => stop());

  function stop() {
    request?.abort();
    if (request) endRequest(request);
    request = null;
    busy = false;
  }

  async function send(text = question) {
    const q = text.trim();
    const cfg = aiConfig();
    if (!q || !cfg || !editor || busy) return;
    question = '';
    recall = -1;
    entries.push({ role: 'user', text: q, tools: [], error: '' }, { role: 'assistant', text: '', tools: [], error: '' });
    const reply = entries[entries.length - 1];
    const author = t().ai.author;
    const before = revisions(editor.state.doc).filter((r) => r.author === author).length;
    busy = true;
    const mine = (request = startRequest());
    try {
      await runTurn({
        cfg, editor, history, question: q, author,
        onText: (d) => (reply.text += d),
        onTool: (s) => reply.tools.push(s),
        signal: mine.signal,
      });
    } catch (e) {
      if (!isAbort(e)) reply.error = aiErrorText(e, t().ai.errors, cfg.endpoint);
    } finally {
      endRequest(mine);
      if (request === mine) { request = null; busy = false; }
    }
    // Tracked edits nobody can see would look like nothing happened.
    if (!showChanges() && revisions(editor.state.doc).filter((r) => r.author === author).length > before) setShowChanges(true);
  }

  function insertAtCursor(html: string) {
    if (!editor) return;
    editor.commands.focus();
    editor.view.dispatch(editor.state.tr.replaceSelection(htmlToSlice(html, editor.state)).scrollIntoView());
  }

  // A reply as document content: parsed through the schema, re-rendered once a frame.
  function render(node: HTMLElement, html: string) {
    let frame = 0;
    const paint = (h: string) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (editor) node.replaceChildren(h ? contentToDom(htmlToSlice(h, editor.state).content, editor.schema) : '');
      });
    };
    paint(html);
    return { update: paint, destroy: () => cancelAnimationFrame(frame) };
  }

  // Up and Down on the field's first or last line step through the questions sent, as a
  // shell does; stepping past the newest brings back the draft.
  let recall = -1;
  let draft = '';

  function step(e: KeyboardEvent, by: number) {
    const sent = entries.filter((x) => x.role === 'user').map((x) => x.text);
    const field = e.currentTarget as HTMLTextAreaElement;
    const caret = field.selectionStart;
    if (caret !== field.selectionEnd) return;
    if (by < 0 ? question.slice(0, caret).includes('\n') : question.slice(caret).includes('\n')) return;
    const at = recall < 0 ? sent.length : recall;
    const next = Math.min(sent.length, Math.max(0, at + by));
    if (next === at) return;
    e.preventDefault();
    if (recall < 0) draft = question;
    recall = next === sent.length ? -1 : next;
    question = recall < 0 ? draft : sent[next];
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
    else if (e.key === 'ArrowUp') step(e, -1);
    else if (e.key === 'ArrowDown') step(e, 1);
  }
</script>

<aside class="ai-pane" aria-label={t().ai.name}>
  <header>
    <Icon name="sparkle" size={16} />
    <span class="title">{t().ai.name}</span>
    <button class="icon" onclick={resetAiChat} disabled={busy || !entries.length} title={t().ai.newChat} aria-label={t().ai.newChat}>
      <Icon name="newDoc" size={16} />
    </button>
    <button class="icon" onclick={onClose} title={t().common.close} aria-label={t().common.close}>
      <Icon name="close" size={16} />
    </button>
  </header>

  <div class="messages" bind:this={list}>
    {#if !entries.length}
      <p class="intro">{t().ai.intro}</p>
      <div class="chips">
        {#each SUGGESTIONS as s (s)}
          <button class="chip" disabled={!configured || busy} onclick={() => send(t().ai.suggestions[s])}>{t().ai.suggestions[s]}</button>
        {/each}
      </div>
    {/if}
    {#each entries as e, i (i)}
      {#if e.role === 'user'}
        <div class="msg user">{e.text}</div>
      {:else}
        <div class="msg assistant">
          {#if e.text}<div class="content" use:render={e.text}></div>{/if}
          {#each e.tools as line, k (k)}<div class="tool">✓ {line}</div>{/each}
          {#if e.error}<div class="error" role="alert">{e.error}</div>{/if}
          {#if busy && i === entries.length - 1}<div class="working" role="status"><span class="spinner" aria-hidden="true"></span>{t().ai.working}</div>{/if}
          {#if e.text && !(busy && i === entries.length - 1)}
            <button class="link" onclick={() => insertAtCursor(e.text)}>{t().ai.insertAtCursor}</button>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <footer>
    {#if !configured}
      <p class="notice">{t().ai.notConfigured}</p>
    {:else}
      <div class="ask">
        {#if selected}
          <div class="sel">
            <span class="sel-text"><b>{t().ai.selection}:</b> «{selected}»</span>
            <button class="icon" onclick={clearSelection} title={t().ai.clearSelection} aria-label={t().ai.clearSelection}>
              <Icon name="close" size={12} />
            </button>
          </div>
        {/if}
        <textarea bind:value={question} rows="3" placeholder={t().ai.placeholder} onkeydown={onKeydown}></textarea>
        {#if busy}
          <button class="send" onclick={stop}>{t().ai.stop}</button>
        {:else}
          <button class="send" disabled={!question.trim()} onclick={() => send()}>{t().ai.send}</button>
        {/if}
      </div>
    {/if}
    <p class="note">{t().ai.disclaimer}</p>
  </footer>
</aside>

<style>
  .ai-pane {
    display: flex;
    flex-direction: column;
    flex: 0 0 320px;
    min-width: 0;
    border-left: 1px solid var(--color-border);
    background: var(--color-surface);
    font-family: var(--font-sans);
    font-size: 0.8rem;
    /* As the Navigator: the modern chrome's island overlays the top of the row. */
    margin-top: var(--toolbar-overlay-h, 0px);
  }

  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-border);
    color: var(--w-accent);
  }
  .title { flex: 1; color: var(--color-text); font-weight: 600; }

  button {
    border: none;
    border-radius: var(--radius);
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  button:disabled { opacity: 0.45; cursor: default; }
  .icon { display: grid; place-items: center; padding: 3px; color: var(--color-text-muted); }
  .icon:hover:not(:disabled) { background: var(--color-btn-hover); color: var(--color-text); }

  .messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
  }
  .intro { margin: 0; color: var(--color-text-muted); line-height: 1.4; }
  .chips { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
  .chip {
    padding: 6px 12px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    text-align: left;
  }
  .chip:hover:not(:disabled) { border-color: var(--w-accent); background: var(--w-accent-soft); }

  .msg { max-width: 100%; line-height: 1.4; overflow-wrap: anywhere; }
  .msg.user {
    align-self: flex-end;
    max-width: 85%;
    padding: 7px 11px;
    border-radius: 14px 14px 4px 14px;
    background: var(--w-accent-soft, var(--color-btn-hover));
    white-space: pre-wrap;
  }
  .msg.assistant { display: flex; flex-direction: column; gap: 4px; }
  .content :global(p) { margin: 0 0 0.5em; }
  .content :global(h1), .content :global(h2), .content :global(h3) { margin: 0.4em 0; font-size: 1em; }
  .content :global(ul), .content :global(ol) { margin: 0 0 0.5em; padding-left: 1.4em; }
  .content :global(table) { border-collapse: collapse; margin-bottom: 0.5em; }
  .content :global(td), .content :global(th) { border: 1px solid var(--color-border); padding: 2px 4px; }
  .tool { color: var(--color-text-muted); font-size: 0.75rem; }
  .error { color: #e5534b; }
  .working { display: flex; align-items: center; gap: 6px; color: var(--color-text-muted); }
  .link { align-self: flex-start; padding: 2px 0; color: var(--w-accent); font-size: 0.75rem; }
  .link:hover { text-decoration: underline; }

  footer { padding: 8px 10px; border-top: 1px solid var(--color-border); }
  /* One composer box: the field and its button share the border and the focus ring. */
  .ask {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-surface);
  }
  .sel {
    display: flex;
    align-items: center;
    gap: 4px;
    align-self: flex-start;
    max-width: 100%;
    padding: 2px 4px 2px 8px;
    border-radius: 999px;
    background: var(--w-accent-soft);
    font-size: 0.72rem;
  }
  .sel-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sel b { color: var(--w-accent); font-weight: 600; }
  .ask:focus-within { border-color: var(--w-accent); box-shadow: 0 0 0 3px var(--w-accent-soft); }
  textarea {
    resize: none;
    padding: 2px 4px;
    border: none;
    outline: none;
    background: transparent;
    color: var(--color-text);
    font: inherit;
  }
  .send {
    align-self: flex-end;
    padding: 5px 12px;
    border-radius: 8px;
    background: var(--w-accent-fill);
    color: #fff;
    font-weight: 600;
  }
  .send:hover:not(:disabled) { background: var(--w-accent-fill-open); }
  .notice { margin: 0; color: var(--color-text-muted); }
  .note { margin: 6px 0 0; color: var(--color-text-muted); font-size: 0.7rem; }
</style>
