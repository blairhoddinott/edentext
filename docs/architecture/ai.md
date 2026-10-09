# AI assistant

A Copilot-style assistant on a provider the user brings: an OpenAI-compatible
`/chat/completions` server (OpenAI, Mistral, OpenRouter, Gemini, Ollama, LM Studio) or
Anthropic's `/messages`. There is no edentext server; the browser talks to the provider
directly with the key from Settings ▸ AI.

## Kill switch

`storage/ai.svelte.ts` holds one app-wide key, `edentext-ai`, with `{enabled, provider,
endpoint, apiKey, model}`. Off is the default. `aiEnabled()` gates every surface:

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
| `components/AiPane.svelte` | Docked chat. The history lives in module state: it survives closing the pane, but not a reload or a new document |
| `components/AiPrompt.svelte` | Popover for a quick rewrite of the selection, with a preview first |

## Document in, content out

**Input.** Every textblock is one line, `[n kind] text`; a cell's kind names its table, row
and column (`cell T1 r2 c3`, from `TableMap`, so merged cells count once); a list item or
numbered heading also carries the number the page shows (`li VI`, from `listNumberAt` and
`headingNumbers`), since the text refers to it; a text box's paragraphs follow their anchor
as `box 1`, and a list item in a cell carries both (`cell T1 r1 c2 li`). Inline atoms read as
tokens that cover them whole (`{image "alt"}`, `‹Name›` for a placeholder, `{date}`), so
`replace_text` can replace one. Style, alignment and the direct formatting the paragraph style
does not already give follow in braces (`formatNote`), quoting the runs, so `find` still
matches the bare text. A run
of empty paragraphs folds to `[12–28] (empty)`. Lines mark where a page starts (`— page 2 —`,
from the last layout pass, `pageLayout`), how full the last page is, and where text columns
begin and end; the headers and footers follow as read-only text. Comment threads follow the document as `[C1 on paragraph 4 «quote», by Ada,
open]` with their replies; their numbers come from the turn's snapshot. Text marked as a deletion is
left out, so the model reads the text as it will look once accepted. Past 60k characters,
the head and the paragraphs around the selection are kept, and `read_paragraphs` returns
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
field, text columns and a table of contents. A remote image is dropped and reported back. Text
with a tab is parsed with whitespace preserved, after the dialect collapsed the rest itself.
`htmlToSlice` parses the result in an
inert `DOMParser` document, drops the whitespace between top-level blocks (each would become
a paragraph holding a space), then goes through the schema, then `fitPastedSlice` (the paste
path's fixes). That drops scripts, handlers, unknown tags and remote images. Previews
serialize the slice back with `DOMSerializer`, so they show only what would be inserted.

## Edits

- **Text tools** (`replace_text`, `rewrite_paragraph`, `insert_paragraphs`,
  `delete_paragraphs`) go through `trackedReplace` (`trackChanges.ts`). Each edit becomes
  a revision by the localized author `t().ai.author`, whether or not recording is on.
  The Review pane accepts or rejects it. An edit over another author's pending change
  is refused: `markDeleted` would delete their insertion outright.
- **`format`** uses `applyFormat`, the search-replace formatting, plus mark removal. Track
  changes cannot record formatting, so it applies directly and is undoable.
- **`add_comment`** comments as the assistant; **`reply_comment`** answers a thread and
  **`resolve_comment`** closes it, both directly and undoable.
- **`table_insert`** adds a row or column with the table commands; the structure applies
  directly, the new cells' text is tracked. Removing rows or columns is left to the user.
- **`set_columns`** runs `setColumns` over the paragraphs' range, which refuses a bare
  cursor's whole-document case; columns apply directly.
- **`replace_text`** lets a form blank (a run of dots or underscores, an ellipsis) in `find`
  match any such run: a model miscounts long ones.
- **Paragraph numbers** come from the turn's snapshot. Every transaction during the turn
  is appended to a `Mapping`, so a number still finds its paragraph after earlier edits.
  Inserted paragraphs only get a number in the next turn.
- **Commands and the popover** insert like a paste. While recording is on, the change is
  tracked under the user's own name.

## Slash commands

A chat message starting with `/` is a command: `/draft <what>`, `/rewrite <how>`, and the
presets `/rephrase`, `/shorten`, `/formal`, `/fix`, `/translate [language]` (a preset takes
extra words as an addition; translate falls back to the UI language). Typing `/` lists them,
filtered by name or localized label. A command sends its fixed prompt without tools, so
small local models manage it; the rewrite commands need a selection, captured when sent. The
reply is a proposal: Replace or Insert below for a rewrite, Insert at cursor for a draft,
refused once the selected text changed. It enters the chat history, so a follow-up refines it.

Drafting has no window of its own: the ribbon, the context menu and `Alt+I` open the chat
with `/draft ` filled in (`OPEN_AI_CHAT_EVENT`, `askAi`). The popover only rewrites.

## Providers

- **Anthropic** needs `anthropic-dangerous-direct-browser-access: true` to answer a browser.
- **Ollama** accepts `app://` (the desktop shell) by default. A web origin has to be
  listed in `OLLAMA_ORIGINS`; the network error says so for a localhost endpoint.
- **Models without tool support**: a 400 that mentions tools is retried once without tools,
  unless the turn already ran tools.
- **Gemini 3** attaches a thought signature to each tool call (`extra_content`); it goes back
  unchanged with the call, or the next round answers 400.

Signing in with a ChatGPT subscription (Codex OAuth, desktop only) is not built.
