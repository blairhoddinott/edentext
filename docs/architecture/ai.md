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
| `components/AiPane.svelte` | Docked chat. The history lives in module state: it survives closing the pane, but not a reload or a new document |
| `components/AiPrompt.svelte` | Popover for rewriting the selection or drafting at the caret, with a preview first |

## Document in, content out

**Input.** Every textblock is one line, `[n kind] text`; a cell's kind names its table, row
and column (`cell T1 r2 c3`, from `TableMap`, so merged cells count once). Style, alignment
and direct formatting follow in braces (`formatNote`), quoting the runs, so `find` still
matches the bare text. Text marked as a deletion is
left out, so the model reads the text as it will look once accepted. Past 60k characters,
the head and the paragraphs around the selection are kept, and `read_paragraphs` returns
the rest. The selection goes along as quoted text; a chip above the chat field shows it
and its × deselects.

**Output.** The model is asked for a small HTML subset. `htmlToSlice` parses it in an
inert `DOMParser` document, then through the schema, then `fitPastedSlice` (the paste
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
- **`add_comment`** comments as the assistant.
- **`table_insert`** adds a row or column with the table commands; the structure applies
  directly, the new cells' text is tracked. Removing rows or columns is left to the user.
- **Paragraph numbers** come from the turn's snapshot. Every transaction during the turn
  is appended to a `Mapping`, so a number still finds its paragraph after earlier edits.
  Inserted paragraphs only get a number in the next turn.
- **Rewrite and draft** insert like a paste. While recording is on, the change is tracked
  under the user's own name.

## Providers

- **Anthropic** needs `anthropic-dangerous-direct-browser-access: true` to answer a browser.
- **Ollama** accepts `app://` (the desktop shell) by default. A web origin has to be
  listed in `OLLAMA_ORIGINS`; the network error says so for a localhost endpoint.
- **Models without tool support**: a 400 that mentions tools is retried once without tools,
  unless the turn already ran tools.
- **Gemini 3** attaches a thought signature to each tool call (`extra_content`); it goes back
  unchanged with the call, or the next round answers 400.

Signing in with a ChatGPT subscription (Codex OAuth, desktop only) is not built.
