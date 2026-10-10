// Paragraph spacing settings through import and export: the default, the model and page starts.
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildOdt } from '../../src/lib/export/odt';
import { DEFAULT_MARGINS } from '../../src/lib/storage/pageMargins';
import { importOdt } from '../../src/lib/import/odt';
import { buildDocx } from '../../src/lib/export/docx';
import { importDocx } from '../../src/lib/import/docx';

type N = any;

// The editor renders no paragraph spacing (editor.css), like LibreOffice and Word. odf-kit's
// Standard style carries 0.212cm, which every paragraph and list item inherits — so the
// export must zero it, or LibreOffice shows ~6pt per block that the preview never had.
describe('exported Standard style', () => {
  it('has no bottom margin, so the export matches the preview', async () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }],
        },
      ],
    };
    const bytes = await buildOdt(json as never, DEFAULT_MARGINS, 'portrait');
    const styles = strFromU8(unzipSync(bytes)['styles.xml']);

    const standard = styles.match(/<style:style style:name="Standard"[\s\S]*?<\/style:style>/)![0];
    // The Standard style declares its zero spacing (LibreOffice's Default Paragraph Style).
    expect(standard).toMatch(/fo:margin-bottom="0(pt|cm)"/);
    expect(standard).not.toContain('0.212cm');
  });
});

// LibreOffice adds the space below a block to the space above the next one, but takes
// only the larger of the two for a Word document — probed against soffice, and carried
// per document in settings.xml (AddParaTableSpacing).
const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] };

describe('paragraph spacing model', () => {
  it('round-trips the model through the ODF export', async () => {
    const max = await buildOdt(doc as never, undefined, 'portrait', undefined, null, 'A4', undefined, undefined, 'max');
    expect(strFromU8(unzipSync(max)['settings.xml'])).toContain('"AddParaTableSpacing" config:type="boolean">false<');
    expect(importOdt(max).spacingModel).toBe('max');

    // A file that says nothing gets LibreOffice's own default, which is to add them.
    const add = await buildOdt(doc as never, undefined, 'portrait');
    expect(strFromU8(unzipSync(add)['settings.xml'])).not.toContain('AddParaTableSpacing');
    expect(importOdt(add).spacingModel).toBe('add');
  });
});

// LibreOffice's "add spacing at the beginning of pages" (ODF AddParaTableSpacingAtStart,
// Word's w:suppressSpBfAfterPgBrk): off, the block opening a page loses its space above.
describe('spacing at the start of a page', () => {
  const doc: N = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] };
  const margins = { top: 2, bottom: 2, left: 2, right: 2 };
  const args = [margins, 'portrait' as const, undefined, null, 'A4' as const] as const;
  it('is on unless the file turns it off', async () => {
    const on = await buildOdt(doc, ...args);
    expect(strFromU8(unzipSync(on)['settings.xml'] ?? new Uint8Array())).not.toContain('AddParaTableSpacingAtStart');
    expect(importOdt(on).spacingAtPageStart).toBe(true);
    expect(importDocx(await buildDocx(doc, ...args)).spacingAtPageStart).toBe(true);
  });

  it('rides both formats when it is off', async () => {
    const rest = [undefined, undefined, 'add' as const, false, undefined, undefined, false,
      undefined, undefined, undefined, false, false, false] as const;
    const odt = await buildOdt(doc, ...args, ...rest);
    expect(strFromU8(unzipSync(odt)['settings.xml'])).toContain('AddParaTableSpacingAtStart');
    expect(importOdt(odt).spacingAtPageStart).toBe(false);

    const docx = await buildDocx(doc, ...args, ...rest);
    expect(strFromU8(unzipSync(docx)['word/settings.xml'])).toContain('<w:suppressSpBfAfterPgBrk/>');
    expect(importDocx(docx).spacingAtPageStart).toBe(false);
  });
});
