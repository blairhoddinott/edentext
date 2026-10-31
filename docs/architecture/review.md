# Recorded changes

Text changes are the `insertion`/`deletion` marks (`editor/extensions/trackChanges.ts`, described in its `CLAUDE.md`). This document holds what a mark cannot carry and the file forms, each probed against LibreOffice 26.2 with its own recorded edits.

## Paragraph marks

`revMark` on a paragraph or heading is the mark that ends it: `{ insertion?, deletion? }`, both when one author struck what another inserted. `revisions()` merges it with the text of its change, so a change spans blocks: `spans` are its inline stretches, `marks` its blocks, and `text` shows the mark as a newline. Touching stretches of one author and date are one change, since a file numbers each run and mark separately.

Only a mark with a next paragraph can be recorded (`nextParagraph`): a cell, a frame or the document ends in a block with nothing to join, and a block a table follows stays.

Removing a mark follows LibreOffice (probed, accept and reject alike):

- a block left empty goes, and the next stays unchanged;
- otherwise the next block's text joins it, under the first block's format and the second's mark.

Deleted `Heading first` + `body second` across the mark gives one heading; with the whole heading deleted, the body keeps its own format. The author's own pending mark goes at once.

## Views

"No markup" and "Original" hide a kind of change with CSS. A block with nothing left, all its text and a paragraph mark on either end being of that kind, goes too (`goneBlocks`, the classes `pm-gone-*`), with a list item holding only it.

A merge whose two sides keep text stays two lines on the page: `display: inline` on both blocks loses alignment, indents and spacing, which belong to the block, and cannot join list items. Accepting and rejecting are right regardless, and the print path really merges: it prints `settledDoc`. The raster PDF copies the page and shows what the page shows.

## Formats

**DOCX:** `w:ins`/`w:del` in `w:pPr/w:rPr`, a move's ends `w:moveFrom`/`w:moveTo`.

**ODF insertion:** the region runs from a `text:change-start` at the end of one paragraph to the `text:change-end` at the start of the next.

**ODF deletion:** the body holds **one** paragraph with `text:change` where the mark was, and the registry one block per side, the last holding what came after the mark. LibreOffice splits a selection: the region `[tail, empty]` and a second region `[head]`. Over list items the registry wraps both in `text:list`, the body keeps one item. LibreOffice's body keeps the first block's style, or the second's when the first is deleted whole; it loses the other's format on save, while the registry can carry it.

Our export writes LibreOffice's form with each side's real format in its registry block, which is what the import parts the paragraph by (`withParagraphMarks`). A mark across a change of list level (a list and the text beside it, an item and its sub-list) keeps no list side in ODF, as in LibreOffice: that structure survives DOCX only.

`tests/lo-revisions.test.ts` has LibreOffice open what we write for every edit of `tests/trackChangesCases.ts`, accept and reject all, and compares the paragraphs with ours.

## Not recorded yet

Lifting an item out of its list (Backspace at its start) and other list structure pass unrecorded; the monkey's recording pass skips them.

## Probed for later steps

- **Row:** `loext:text-changes-only="false"` on the row style, kind read from the cells' changes. A new empty row carries a tracked U+200D in its first cell.
- **Column:** the same attribute on the cell style, U+200D in each new cell. LibreOffice drops `w:cellIns`/`w:cellDel` from DOCX.
- **Note:** a deletion's registry block holds the whole `text:note`.
- **Header and footer:** a `text:tracked-changes` of its own as first child of `style:header`/`style:footer` in `styles.xml`.
- **Character format:** a `text:format-change` region around the run, with no old values. Rejecting it after a reload drops the direct formatting.
- **Paragraph format:** LibreOffice writes `text:UnknownChange`, reads it back as nothing and is outside the schema. Such a change survives only DOCX.
- **Moves:** `loext:move-id` in the region's change info.

The UNO API removes rows and columns unrecorded; a probe needs the dispatcher. pyuno does not run on macOS here, so the leg and the probes are Basic macros in a fresh profile's `Standard` library.
