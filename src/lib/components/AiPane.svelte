<script module lang="ts">
  import type { ChatMessage } from '../ai/client';
  import type { Command, Target } from '../ai/commands';

  // A command's reply is a proposal: it reaches the document by its buttons only.
  type Proposal = { kind: Command['kind']; target: Target; applied: boolean };
  type Entry = { role: 'user' | 'assistant'; text: string; tools: string[]; error: string; proposal?: Proposal };

  // The conversation outlives the pane being closed, not a reload: nothing is stored.
  let entries = $state<Entry[]>([]);
  let history: ChatMessage[] = [];
  let prefill = $state<string | null>(null);

  /** Fills the chat field, as the pane opens or while it is open. */
  export function askAi(text: string): void {
    prefill = text;
  }

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
  import { aiErrorText, isAbort, streamChat } from '../ai/client';
  import { contentToDom, htmlToSlice, stripFences } from '../ai/doc';
  import { splitDocumentHtml } from '../ai/dialect';
  import { COMMANDS, captureTarget, commandLabel, commandRequest, insertAtCursor, insertBelowTarget, parseCommand, replaceTarget, uiLanguage } from '../ai/commands';
  import { runTurn, startRequest, endRequest, type AiHost } from '../ai/tools';
  import Icon from './ribbon/Icon.svelte';

  // Copilot's chat pane: questions about the document with the document as context, and
  // changes the assistant makes through its tools — text edits as tracked changes under
  // its own author, which the Review pane accepts or rejects like anyone else's.
  let { editor, host, onClose }: { editor: Editor | null; host?: AiHost; onClose: () => void } = $props();

  let question = $state('');
  let busy = $state(false);
  let list = $state<HTMLElement | null>(null);
  let field = $state<HTMLTextAreaElement | null>(null);
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

  // Dragged wider or narrower by its left edge, as an editor's side bar; kept per browser.
  const WIDTH_KEY = 'edentext-ai-width';
  const MIN_WIDTH = 260;
  const maxWidth = () => Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.6));
  const clampWidth = (w: number) => Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, w)));
  let width = $state(clampWidth((() => { try { return Number(localStorage.getItem(WIDTH_KEY)) || 320; } catch { return 320; } })()));

  function setWidth(w: number) {
    width = clampWidth(w);
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* not kept */ }
  }

  function startResize(e: PointerEvent) {
    const handle = e.currentTarget as HTMLElement;
    const x0 = e.clientX;
    const w0 = width;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setWidth(w0 + x0 - ev.clientX);
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    e.preventDefault();
  }

  function resizeKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') setWidth(width + step);
    else if (e.key === 'ArrowRight') setWidth(width - step);
    else return;
    e.preventDefault();
  }

  $effect(() => {
    if (prefill === null || !field) return;
    const el = field;
    question = prefill;
    prefill = null;
    menuIndex = 0;
    queueMicrotask(() => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  });

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
    const parsed = parseCommand(q);
    if (parsed) return command(q, parsed);
    entries.push({ role: 'user', text: q, tools: [], error: '' }, { role: 'assistant', text: '', tools: [], error: '' });
    const reply = entries[entries.length - 1];
    const author = t().ai.author;
    const before = revisions(editor.state.doc).filter((r) => r.author === author).length;
    busy = true;
    const mine = (request = startRequest());
    try {
      await runTurn({
        cfg, editor, history, question: q, author, host,
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

  async function command(q: string, parsed: NonNullable<ReturnType<typeof parseCommand>>) {
    const cfg = aiConfig();
    if (!cfg || !editor) return;
    entries.push({ role: 'user', text: q, tools: [], error: '' }, { role: 'assistant', text: '', tools: [], error: '' });
    const reply = entries[entries.length - 1];
    if ('unknown' in parsed) return void (reply.error = t().ai.unknownCommand(parsed.unknown));
    const target = captureTarget(editor.state);
    if (parsed.command.kind === 'rewrite' && !target.html) return void (reply.error = t().ai.needSelection);
    const made = commandRequest(parsed.command, parsed.arg, editor.state, target, uiLanguage());
    if (!made) return void (reply.error = t().ai.needInstruction);
    reply.proposal = { kind: parsed.command.kind, target, applied: false };
    busy = true;
    const mine = (request = startRequest());
    try {
      await streamChat(cfg, made.request, (d) => (reply.text += d), mine.signal);
      // A follow-up such as "more formal still" reads as a chat turn about this one.
      history.push({ role: 'user', content: made.asked }, { role: 'assistant', content: reply.text });
    } catch (e) {
      if (!isAbort(e)) reply.error = aiErrorText(e, t().ai.errors, cfg.endpoint);
    } finally {
      endRequest(mine);
      if (request === mine) { request = null; busy = false; }
    }
  }

  function apply(e: Entry, place: typeof replaceTarget) {
    if (!editor || !e.proposal) return;
    if (place(editor, e.proposal.target, e.text)) e.proposal.applied = true;
    else e.error = t().ai.selectionChanged;
  }

  // Typing `/` lists the commands, filtered by name or label; Esc hides the list.
  let menuIndex = $state(0);
  let menuHidden = $state(false);
  let matches = $derived.by(() => {
    if (menuHidden || !/^\/\S*$/.test(question)) return [];
    const q = question.slice(1).toLowerCase();
    return COMMANDS.filter((c) => c.name.startsWith(q) || commandLabel(c, t().ai).toLowerCase().includes(q));
  });

  function pick(i: number) {
    question = `/${matches[i].name} `;
    field?.focus();
  }

  // A reply as document content: parsed through the schema, re-rendered once a frame.
  function render(node: HTMLElement, html: string) {
    let frame = 0;
    const paint = (h: string) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!editor) return;
        // A draft's header and footer show as a small line above and below its body.
        const { body, zones } = splitDocumentHtml(stripFences(h));
        const line = (z: (typeof zones)[number]) => Object.assign(document.createElement('div'), { className: 'zone-line', textContent: new DOMParser().parseFromString(z.html, 'text/html').body.textContent ?? '' });
        node.replaceChildren(
          ...zones.filter((z) => z.zone === 'header').map(line),
          ...(body ? [contentToDom(htmlToSlice(body, editor.state).content, editor.schema)] : []),
          ...zones.filter((z) => z.zone === 'footer').map(line),
        );
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
    if (matches.length) {
      const by = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (by) { e.preventDefault(); menuIndex = (menuIndex + by + matches.length) % matches.length; return; }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pick(Math.min(menuIndex, matches.length - 1)); return; }
      if (e.key === 'Escape') { e.preventDefault(); menuHidden = true; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
    else if (e.key === 'ArrowUp') step(e, -1);
    else if (e.key === 'ArrowDown') step(e, 1);
  }
</script>

<aside class="ai-pane" aria-label={t().ai.name} style:flex-basis="{width}px">
  <!-- A focusable separator is a widget (ARIA), which Svelte does not know. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="resize" role="separator" aria-orientation="vertical" aria-label={t().ai.paneWidth}
    aria-valuenow={width} aria-valuemin={MIN_WIDTH} tabindex="0" title={t().ai.paneWidth}
    onpointerdown={startResize} onkeydown={resizeKey} ondblclick={() => setWidth(320)}></div>
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
            {#if e.proposal?.applied}
              <div class="tool">✓ {t().ai.applied}</div>
            {:else if e.proposal?.kind === 'rewrite'}
              <div class="acts">
                <button class="act primary" onclick={() => apply(e, replaceTarget)}>{t().ai.replace}</button>
                <button class="act" onclick={() => apply(e, insertBelowTarget)}>{t().ai.insertBelow}</button>
              </div>
            {:else}
              <button class="link" onclick={() => { if (editor) { insertAtCursor(editor, e.text, host); if (e.proposal) e.proposal.applied = true; } }}>{t().ai.insertAtCursor}</button>
            {/if}
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <footer>
    {#if !configured}
      <p class="notice">{t().ai.notConfigured}</p>
    {:else}
      {#if matches.length}
        <div class="menu" role="listbox" aria-label={t().ai.commandsTitle}>
          {#each matches as c, k (c.name)}
            <button role="option" aria-selected={k === menuIndex} class:on={k === menuIndex} onmousedown={(ev) => ev.preventDefault()} onclick={() => pick(k)}>
              <span class="cmd">/{c.name}</span><span class="label">{commandLabel(c, t().ai)}</span>
            </button>
          {/each}
        </div>
      {/if}
      <div class="ask">
        {#if selected}
          <div class="sel">
            <span class="sel-text"><b>{t().ai.selection}:</b> «{selected}»</span>
            <button class="icon" onclick={clearSelection} title={t().ai.clearSelection} aria-label={t().ai.clearSelection}>
              <Icon name="close" size={12} />
            </button>
          </div>
        {/if}
        <textarea bind:this={field} bind:value={question} rows="3" placeholder={t().ai.placeholder} onkeydown={onKeydown} oninput={() => { menuIndex = 0; menuHidden = false; }}></textarea>
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
    position: relative;
    flex: 0 0 320px;
    min-width: 0;
    border-left: 1px solid var(--color-border);
    background: var(--color-surface);
    font-family: var(--font-sans);
    font-size: 0.8rem;
    /* As the Navigator: the modern chrome's island overlays the top of the row. */
    margin-top: var(--toolbar-overlay-h, 0px);
  }

  /* The grab strip straddles the border, wider than it looks. */
  .resize {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    width: 6px;
    cursor: col-resize;
    z-index: 1;
    touch-action: none;
  }
  .resize:hover, .resize:focus-visible { background: var(--color-primary); opacity: 0.6; outline: none; }

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
  .content :global(.zone-line) { margin: 0.3em 0; padding: 0.2em 0; border-block: 1px dashed var(--w-border); font-size: 0.85em; opacity: 0.75; }
  .content :global(h1), .content :global(h2), .content :global(h3) { margin: 0.4em 0; font-size: 1em; }
  .content :global(ul), .content :global(ol) { margin: 0 0 0.5em; padding-left: 1.4em; }
  .content :global(table) { border-collapse: collapse; margin-bottom: 0.5em; }
  .content :global(td), .content :global(th) { border: 1px solid var(--color-border); padding: 2px 4px; }
  .tool { color: var(--color-text-muted); font-size: 0.75rem; }
  .error { color: #e5534b; }
  .working { display: flex; align-items: center; gap: 6px; color: var(--color-text-muted); }
  .link { align-self: flex-start; padding: 2px 0; color: var(--w-accent); font-size: 0.75rem; }
  .link:hover { text-decoration: underline; }

  .acts { display: flex; gap: 6px; }
  .act {
    padding: 3px 10px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-size: 0.75rem;
  }
  .act:hover { background: var(--color-btn-hover); }
  .act.primary { border-color: var(--w-accent-fill); background: var(--w-accent-fill); color: #fff; font-weight: 600; }
  .act.primary:hover { background: var(--w-accent-fill-open); }

  footer { position: relative; padding: 8px 10px; border-top: 1px solid var(--color-border); }
  .menu {
    position: absolute;
    inset: auto 10px calc(100% - 4px) 10px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-surface);
    box-shadow: var(--w-menu-shadow, 0 8px 28px rgba(0, 0, 0, 0.22));
  }
  .menu button { display: flex; gap: 8px; align-items: baseline; padding: 5px 8px; text-align: left; }
  .menu button.on { background: var(--w-accent-soft); }
  .menu .cmd { font-weight: 600; color: var(--w-accent); }
  .menu .label { color: var(--color-text-muted); }
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
