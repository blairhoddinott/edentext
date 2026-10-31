# Recorded changes

Text changes are the `insertion`/`deletion` marks (`editor/extensions/trackChanges.ts`, described in its `CLAUDE.md`). This document holds what a mark cannot carry and the file forms, each probed against LibreOffice 26.2 with its own recorded edits.

## Paragraph marks

`revMark` on a paragraph or heading is the mark that ends it: `{ insertion?, deletion? }`, both when one author struck what another inserted. `revisions()` merges it with the text of its change, so a change spans blocks: `spans` are its inline stretches, `marks` its blocks, and `text` shows the mark as a newline. Touching stretches of one author and date are one change, since a file numbers each run and mark separately.

Only a mark with a next paragraph can be recorded (`nextParagraph`): a cell, a frame or the document ends in a block with nothing to join, and a block a table follows stays.

Removing a mark follows LibreOffice (probed, accept and reject alike):

- a block left empty goes, and the next stays unchanged;
- otherwise the next block's text joins it, under the first block's format and the second's mark.

Deleted `Heading first` + `body second` across the mark gives one heading; with the whole heading deleted, the body keeps its own format. The author's own pending mark goes at once.

## Tables

A row carries a `revMark` as a paragraph does; so does each cell of a column, recorded only when every row got a new cell, which tells a column from a split cell. A row or column change gathers all its cells and text into one revision (`gatherTableChanges`), and removing one takes the line with `removeRow`/`removeColumn`, with the last line the table. A deleted row a merged cell runs through rebuilds that cell and passes unrecorded; a column through one only narrows it and is recorded. In ODF the line's style says `loext:text-changes-only="false"`, the change sits on the text in it, and only a line without text gets the tracked U+200D LibreOffice writes.

A table cutting a paragraph records the split as a mark in front of it, which no file can hold: LibreOffice's reject and ours after a reload keep the two halves. The list cut of a table inserted in a list is not recorded.

## Notes and text boxes

A note anchor and a text box take a change as an atom does: `revisions()` treats a recorded box as one inline piece with everything in it, and a mark step never reaches a box, so `markRange` sets it with `setNodeMarkup`. The note's body follows its anchor through the notes' own repair. In ODF a deletion's registry block holds the whole `text:note` or frame, and a region around a frame says nothing about the paragraphs in it.

## Formatting

The `formatChange` mark holds the format marks its run had (`old`, JSON). A mark step of a transaction is the record (`recordFormats`): each run it touches keeps what it had before the transaction, the first record stands, a run back at its old format loses the change, and the author's own insertion takes none. One transaction is one change, however many runs and blocks it covers (`gatherChanges`, by id).

A block's own format (type, style, alignment, spacing, indents, tabs: all attrs but `UNFORMATTED_ATTRS`) is its `revFormat`, read from attr, markup and swap steps the same way: the first record stands and a block back at it has none.

Lists are part of a block's format: `old.list` holds the lists around it, outermost first, so toggling a list, moving an item a level and changing the list type are all a `revFormat`, read from any `ReplaceAroundStep`. Rejecting lifts the block out and wraps it back, into the lists beside it (`restoreLists`), from the document start so nested items find their parents.

Accepting drops the mark; rejecting puts `old` back run by run, a block's attrs and type with it. "Original" shows the current format, since a mark cannot be undone by CSS; the print path prints `settledDoc`.

## Views

"No markup" and "Original" hide a kind of change with CSS. A block with nothing left, all its text and a paragraph mark on either end being of that kind, goes too (`goneBlocks`, the classes `pm-gone-*`), with a list item holding only it.

A merge whose two sides keep text stays two lines on the page: `display: inline` on both blocks loses alignment, indents and spacing, which belong to the block, and cannot join list items. Accepting and rejecting are right regardless, and the print path really merges: it prints `settledDoc`. The raster PDF copies the page and shows what the page shows.

## Formats

**DOCX:** `w:ins`/`w:del` in `w:pPr/w:rPr`, a move's ends `w:moveFrom`/`w:moveTo`.

**Character format:** DOCX `w:rPrChange`; ODF a `text:format-change` region around the run, with no old values, so rejecting after a reload drops the direct formatting, as in LibreOffice (probed: `old` null). A deleted run's format change goes unsaved in ODF.

**Paragraph format:** DOCX `w:pPrChange`. The paragraph mark's run and the flags the package cannot write are outside it, so the importer takes those from the current block. Of list changes only a paragraph made a list has a form (no `w:numPr` in the old properties); any other is saved as done, unrecorded. ODF has no form LibreOffice reads back: the new format is saved, the record is not.

**ODF insertion:** the region runs from a `text:change-start` at the end of one paragraph to the `text:change-end` at the start of the next.

**ODF deletion:** the body holds **one** paragraph with `text:change` where the mark was, and the registry one block per side, the last holding what came after the mark. LibreOffice splits a selection: the region `[tail, empty]` and a second region `[head]`. Over list items the registry wraps both in `text:list`, the body keeps one item. LibreOffice's body keeps the first block's style, or the second's when the first is deleted whole; it loses the other's format on save, while the registry can carry it.

Our export writes LibreOffice's form with each side's real format in its registry block, which is what the import parts the paragraph by (`withParagraphMarks`). A mark across a change of list level (a list and the text beside it, an item and its sub-list) keeps no list side in ODF, as in LibreOffice: that structure survives DOCX only.

`tests/lo-revisions.test.ts` has LibreOffice open what we write for every edit of `tests/trackChangesCases.ts`, accept and reject all, and compares the paragraphs with ours.

## Not recorded yet

The list cut of a table inserted in a list passes unrecorded; the monkey's recording pass skips it. A link autolink sets on what typing made of the text before it stays when the typing is rejected.

## Probed for later steps

- **Column in DOCX:** LibreOffice drops `w:cellIns`/`w:cellDel`.
- **Header and footer:** a `text:tracked-changes` of its own as first child of `style:header`/`style:footer` in `styles.xml`.
- **Moves:** `loext:move-id` in the region's change info.

The UNO API removes rows and columns unrecorded; a probe needs the dispatcher. pyuno does not run on macOS here, so the leg and the probes are Basic macros in a fresh profile's `Standard` library.
