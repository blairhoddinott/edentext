# AI assistant

A Copilot-style assistant on a provider the user brings: an OpenAI-compatible
`/chat/completions` server (OpenAI, Mistral, OpenRouter, Gemini, Ollama, LM Studio) or
Anthropic's `/messages`. There is no edentext server; the browser talks to the provider
directly with the key from Settings ▸ AI.

## Kill switch

`storage/ai.svelte.ts` holds one app-wide key, `edentext-ai`, with `{enabled, provider,
endpoint, apiKey, model, contextTokens, mode, side, commands}`. Off is the default. `aiEnabled()` gates every surface:

- the Home tab's AI group (`aiPane`, `aiDraft`, `aiRewrite`) and their command-search entries;
- the two context-menu items (body editor only);
- `Alt+I`, the pane and the popover.

`App.svelte` aborts every request in flight when the switch goes off. The network is gated
in the types as well: `ai/client.ts` is the only `fetch`, and it needs an `AiConfig`, which
`aiConfig()` only returns while the switch is on and an endpoint and model are set.

The key is stored unencrypted, like every other setting. Every repo on the same GitHub
Pages origin can read it, and the settings row says so.

## Modules

| File | Role |
|---|---|
| `ai/client.ts` | `streamChat`: request builders, SSE parsing and stream reducers for both providers; `AiError` and its user text |
| `ai/doc.ts` | The document as numbered lines (`blockTexts`, `serializeDoc`); the model's HTML as a slice (`htmlToSlice`) |
| `ai/tools.ts` | Tool schemas, `runTool`, the chat turn `runTurn`, prompts, and the abort registry |
| `ai/commands.ts` | Slash commands (`parseCommand`, `commandRequest`) and the helpers that place a reply |
| `components/AiPane.svelte` | Docked chat, right of the pages or left (`side` in `edentext-ai`, Settings ▸ AI; `order: -1` in the editor row). The history survives closing the pane and a reload (`storage/aiChat.ts`, doc-scoped `edentext-ai-chat`, written once a reply is complete); a new or opened document starts a new one |
| `components/AiPrompt.svelte` | Popover for a quick rewrite of the selection, with a preview first |

## Document in, content out

**Input.** Every textblock is one line, `[n kind] text`; a cell's kind names its table, row
and column (`cell T1 r2 c3`, from `TableMap`, so merged cells count once); a list item or
numbered heading also carries the number the page shows (`li VI`, from `listNumberAt` and
`headingNumbers`), since the text refers to it; a text box's paragraphs follow their anchor
as `box 1`, and a list item in a cell carries both (`cell T1 r1 c2 li`). Inline atoms read as
tokens that cover them whole (`{image "alt"}`, `‹Name›` for a placeholder, `{date}`), so
`replace_text` can replace one. Style (by its shown name), alignment, page break, spacing, rules,
background, language and the direct formatting the paragraph style does not already give
follow in braces (`formatNote`), quoting the runs, colours as hex, so `find` still matches the
bare text; a page break or extra space explains a page the model cannot see. A run
of empty paragraphs folds to `[12–28] (empty)`. Lines mark where a page starts (`— page 2 —`,
from the last layout pass, `pageLayout`), how full the last page is, and where text columns
begin and end; the page setup (`Page: A4 portrait, margins …`), the document language and the headers and footers
(`{page}` for the field) follow. Comment threads follow the document as `[C1 on paragraph 4 «quote», by Ada,
open]` with their replies; their numbers come from the turn's snapshot. Text marked as a deletion is
left out, so the model reads the text as it will look once accepted. Past the budget
(`docBudget`: half the context size set in Settings ▸ AI, at four characters a token), the
head and the paragraphs around the selection are kept, and `read_paragraphs` returns
the rest. The selection goes along as quoted text; a chip above the chat field shows it
and its × deselects.

**Output.** The model writes the HTML it knows anyway, described in one short guide
(`HTML_GUIDE`, in the chat and draft prompts): semantic tags and plain CSS. `ai/dialect.ts`
(`normalizeAiHtml`) rewrites that into the data-* form the schema parses: paragraph CSS to
spacing, indent, line height, shading, borders and block font; a style class by internal or
display name; `<hr>` to a page break; `width` on `<td>`/`<col>` to every cell's `colwidth`
weight (the `<col>`s go, since TipTap reads them by cell index and skips the first);
`<aside>` to a text box anchored in the next paragraph; `<img alt>` without `src` to a
placeholder picture (a canvas PNG, which DOCX keeps; an SVG without a canvas); `<input
placeholder>`, `<time>`/`{date}`, `<section columns>` and `<nav>` to a placeholder, a date
field, text columns and a table of contents. `<sup class="footnote">` (or `endnote`) becomes
an anchor with a fresh id; its text cannot ride the slice, so `fillNotes` writes it into the
note the sync plugin made once the slice is in. A remote image is dropped and reported back.
Text with a tab is parsed with whitespace preserved, after the dialect collapsed the rest itself.
`htmlToSlice` parses the result in an
inert `DOMParser` document, drops the whitespace between top-level blocks (each would become
a paragraph holding a space), then goes through the schema, then `fitPastedSlice` (the paste
path's fixes). That drops scripts, handlers, unknown tags and remote images. Previews
serialize the slice back with `DOMSerializer`, so they show only what would be inserted.

## Edits

- **Modes.** A switch under the chat field picks Chat or Edit (`mode` in `edentext-ai`, Edit
  by default). Chat offers only `read_paragraphs` and a prompt without the editing lines, and
  `runTool` refuses any other call a model makes anyway; the user copies what a reply proposes.
- **Text tools** (`replace_text`, `rewrite_paragraph`, `insert_paragraphs`,
  `delete_paragraphs`) go through `trackedReplace` (`trackChanges.ts`). Each edit becomes
  a revision by the localized author `t().ai.author`, whether or not recording is on.
  The Review pane accepts or rejects it. An edit over another author's pending change
  is refused: `markDeleted` would delete their insertion outright. Track changes has no
  paragraph removal, so a paragraph `delete_paragraphs` leaves empty goes directly (a cell
  or frame keeps its last one).
- **`format`** uses `applyFormat`, the search-replace formatting, plus mark removal and the
  highlight; alignment, spacing, indent, line height, shading and a page break before are
  paragraph attributes set on the whole paragraphs, and `list` runs the list commands. Track
  changes cannot record formatting, so it applies directly and is undoable.
- **`set_style`** creates or changes a paragraph style (`putStyle`), by internal or display
  name; `border`/`border_top`/`border_bottom` take CSS (`borderAttr`), so a rule under every
  heading goes into its style, and `heading_numbers` sets the chapter numbering (`setOutline`).
- **`insert_frame`** builds the dialect's `<aside>` or `<img alt>` and inserts the frame at the
  start of the paragraph, directly; **`frame`** changes one's wrap, size and gap to the text.
  A paragraph's formatting lists its frames (`frame 1: picture 4×5cm right gap 0.32cm`), a
  sized picture in the line too, numbered as the tool takes them (deleted ones not counted); a frame's CSS `margin` is its gap, else a new
  frame's.
- Numbers and booleans may come as strings, and every error names what is accepted ("unknown
  style …; styles are: …"), for small models.
- After a round that changed the text, a style or went through the host (page, zone, language),
  `runTurn` waits until `isPaginating` is false (`layoutSettled`) and appends `document now N
  pages, last page about X% full` to the round's last tool result; after 3s or in a hidden
  tab it appends nothing, since a stale count misleads more than none.
- A chat message sent while a turn runs shows at once and is queued (`takeQueued`): after
  the next round of tools, `runTurn` appends it to that round's last tool result, the one
  place both providers take text before the model's next step, and the reply goes on below
  it. A turn that ends without another round sends the queue as the next turn. Commands
  wait until nothing runs; Stop drops the queue.
- **`add_comment`** comments as the assistant; **`reply_comment`** answers a thread and
  **`resolve_comment`** closes it, both directly and undoable.
- **`table`** (`table_insert` stays as an alias) adds a row or column with the table
  commands and tracks the new cells' text: inline HTML goes into the copied paragraph, a list or
  several paragraphs take its place; deleting rows or columns, `widths` (each cell's
  `colwidth` weights), `merge_right`, `shade`, `borders` and `style` apply directly.
- **`set_columns`** runs `setColumns` over the paragraphs' range, which refuses a bare
  cursor's whole-document case; columns apply directly.
- **`set_header_footer`**, **`set_page`** and a document-wide **`set_language`** go through the `AiHost` that `App.svelte` hands
  the pane, since zones and page setup are its `$state` (storage would be overwritten by the
  next effect). Setting a zone closes an open zone editor first; a first-page or even-page
  zone switches that variant on. A reply's `<header>`, `<footer>` (`data-page`) and `<page>`
  (`splitDocumentHtml`) take the same way from `insert_paragraphs` and from a draft's
  Insert at cursor; the draft preview shows them as a line above and below. Only a draft into
  an empty document is asked for them.
- **`set_language`** takes a name ("English (UK)", "German") or tag; for paragraphs
  `from`/`to` it runs `setBlockLanguage` with any valid tag, for the document only a
  `LANGUAGES` entry (`pickDocumentLanguage` in the host).
- **`replace_text`** lets a form blank (a run of dots or underscores, an ellipsis) in `find`
  match any such run: a model miscounts long ones.
- **Paragraph numbers** come from the turn's snapshot. Every transaction during the turn
  is appended to a `Mapping`, so a number still finds its paragraph after earlier edits.
  Inserted paragraphs only get a number in the next turn.
- **Commands and the popover** insert like a paste. While recording is on, the change is
  tracked under the user's own name.

## Reply actions

- **Citations.** The prompt asks for `¶12` / `¶12–14`; `linkCitations` turns them into buttons
  after rendering, and a click selects those paragraphs by `blockTexts` of the current
  document, so a reply's numbers drift once later edits insert paragraphs before them.
- **Copy** writes the rendered reply as HTML and plain text. Insert at cursor shows under a draft only: a chat reply is
  mostly explanation.
- **Regenerate** (last reply) and **edit** (any question) go through `resend`: the entries from
  that question on go, the tracked changes they left pending are rejected, and the history is
  cut to the question's `historyAt`; a command keeps the selection it was first sent with.
- **Keep / Undo** under a reply accept or reject the tracked changes that turn made (`revs`,
  the assistant's revision ids new after `runTurn`) in one step. Direct formatting is not a
  revision, so Undo leaves it; Ctrl+Z takes it back.

## Attached files

The paperclip or a drop onto the pane attaches files as material (`ai/sources.ts`): .docx and
.odt through the importers, .txt/.md/.csv and .html as text; a PDF or a protected file is
refused. Their text (`sourcesBlock`, half the document budget shared out) prefaces the next
question that starts a turn or command, and only that one: the history keeps the question,
and the stored chat the file names (`files`) but not the text (`context`), so Regenerate
and Edit resend the files within the session only.

## Comments

A new comment or a reply that names the assistant (`mentionsAi`: `@` plus its localized
name or `@AI`, case-insensitive, not inside a word or address) starts `answerComment`
from `App.svelte`; a reply dispatches `AI_COMMENT_EVENT` from `CommentCard`. It is a turn
of its own, without the chat history: the newest message of the thread is the question,
chat mode adds `reply_comment` to the read-only tools, edit mode asks for the change first.
A model that answers as text instead of through the tool gets its text posted as the reply.
`aiAnswering` (thread id → `''` while running, else the error) drives the card's status
line; the request joins `startRequest`, so switching off or opening another document aborts it.

## Slash commands

A chat message starting with `/` is a command: `/draft <what>`, `/rewrite <how>`, and the
presets `/rephrase`, `/shorten`, `/formal`, `/fix`, `/translate [language]` (a preset takes
extra words as an addition; translate falls back to the UI language). Typing `/` lists them,
filtered by name or localized label. A command sends its fixed prompt without tools, so
small local models manage it; the rewrite commands need a selection, captured when sent. The
reply is a proposal: Replace or Insert below for a rewrite, Insert at cursor for a draft,
refused once the selected text changed. It enters the chat history, so a follow-up refines it.

Own commands (Settings ▸ AI, `commands` in `edentext-ai`) are saved prompts. `/name more`
expands to the prompt plus the rest (`expandCustom`) and runs as an ordinary chat turn, so it
has the tools in Edit mode; the chat shows what was typed. A built-in name wins, and the row
says so; the `/` list shows own commands after the built-ins, labelled by the prompt's first line.

Drafting has no window of its own: the ribbon, the context menu and `Alt+I` open the chat
with `/draft ` filled in (`OPEN_AI_CHAT_EVENT`, `askAi`). The popover only rewrites.

## Providers

- **Anthropic** needs `anthropic-dangerous-direct-browser-access: true` to answer a browser.
- **Ollama** on its default port is spoken to natively (`/api/chat`, JSON lines): its `/v1`
  ignores a context size and loads the model with its own default, cutting a longer prompt
  silently; the native call sends `num_ctx` from the context size.
- **Ollama** accepts `app://` (the desktop shell) by default. A web origin has to be
  listed in `OLLAMA_ORIGINS`; the network error says so for a localhost endpoint.
- **Models without tool support**: a 400 that mentions tools is retried once without tools,
  unless the turn already ran tools.
- **Gemini 3** attaches a thought signature to each tool call (`extra_content`); it goes back
  unchanged with the call, or the next round answers 400.

Signing in with a ChatGPT subscription (Codex OAuth, desktop only) is not built.
