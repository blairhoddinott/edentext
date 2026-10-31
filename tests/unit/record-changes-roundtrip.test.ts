// Recording revisions is a property of the document, not of the editor: ODF keeps it on
// the change registry (text:track-changes), Word in settings.xml (w:trackRevisions) —
// both probed against soffice, which writes and reads exactly these two.
import { describe, it, expect } from 'vitest';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { buildOdt } from '../../src/lib/export/odt';
import { buildDocx } from '../../src/lib/export/docx';
import { importOdt } from '../../src/lib/import/odt';
import { importDocx } from '../../src/lib/import/docx';
import { DEFAULT_MARGINS } from '../../src/lib/storage/pageMargins';
import { recordChanges, setRecordChanges, setRecordLock } from '../../src/lib/storage/trackChanges.svelte';
import { recordKey, recordKeyMatches } from '../../src/lib/crypto/protect';
import { open } from '../trackChangesCases';

type N = any;

const doc: N = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ein Satz.' }] }] };
const m = DEFAULT_MARGINS;
// Everything up to the flag is the exporters' own default, so only the last one varies.
const args = (on: boolean) =>
  [m, 'portrait', undefined, null, 'A4', undefined, undefined, 'add', false, undefined, undefined,
    false, undefined, undefined, undefined, on] as const;

// The protection comes last, past the arguments that have no default worth naming here.
const locked = (lock: N) => [...args(true), false, true, [], undefined, false, lock] as const;

describe('protecting recorded changes', () => {
  it('keeps LibreOffice\'s key in ODT, and the lock with no password in DOCX', async () => {
    const key = await recordKey('secret');
    expect(key).toBe('K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols=');
    expect(await recordKeyMatches(key, 'secret')).toBe(true);
    expect(await recordKeyMatches(key, 'other')).toBe(false);
    // What LibreOffice stands in for a protection without a hash.
    const odt = unzipSync(await buildOdt(doc, ...locked({ key })));
    const stand = strToU8(strFromU8(odt['settings.xml']).replace(key, 'AQ=='));
    expect(importOdt(zipSync(odt)).recordLock).toEqual({ key });
    expect(importOdt(zipSync({ ...odt, 'settings.xml': stand })).recordLock).toEqual({});
    expect(importOdt(await buildOdt(doc, ...args(true))).recordLock).toBeNull();

    expect(importDocx(await buildDocx(doc, ...locked({ key }))).recordLock).toEqual({});
    const word = ' w:edit="trackedChanges" w:enforcement="1" w:hash="ab&amp;c" w:salt="de"';
    expect(importDocx(await buildDocx(doc, ...locked({ word }))).recordLock).toEqual({ word });
    expect(importDocx(await buildDocx(doc, ...args(true))).recordLock).toBeNull();
  });

  it('checks the SHA-1 keys of older files in each spelling', async () => {
    const { sha1 } = await import('@noble/hashes/legacy.js');
    const b64 = (b: number[]) => btoa(String.fromCharCode(...sha1(Uint8Array.from(b))));
    for (const bytes of [[0x61, 0x62], [0x61, 0, 0x62, 0], [0, 0x61, 0, 0x62]]) {
      expect(await recordKeyMatches(b64(bytes), 'ab')).toBe(true);
      expect(await recordKeyMatches(b64(bytes), 'ba')).toBe(false);
    }
  });

  it('holds recording on and refuses to settle a change', () => {
    const e = open('<p>text</p>');
    setRecordChanges(true);
    e.commands.insertContentAt(1, 'new ');
    expect(e.state.doc.textContent).toBe('new text');
    setRecordLock({});
    setRecordChanges(false);
    expect(recordChanges()).toBe(true);
    expect(e.can().acceptRevisions(true)).toBe(false);
    expect(e.commands.rejectRevisions(true)).toBe(false);
    expect(e.state.doc.textContent).toBe('new text');
    setRecordLock(null);
    setRecordChanges(false);
    expect(e.commands.rejectRevisions(true)).toBe(true);
    expect(e.state.doc.textContent).toBe('text');
  });
});

describe('recording revisions survives both round trips', () => {
  it('ODT: the registry carries the flag, with no change in it', async () => {
    const on = await buildOdt(doc, ...args(true));
    const content = strFromU8(unzipSync(on)['content.xml']);
    expect(content).toContain('<text:tracked-changes text:track-changes="true">');
    expect(importOdt(on).recordChanges).toBe(true);

    const off = await buildOdt(doc, ...args(false));
    expect(strFromU8(unzipSync(off)['content.xml'])).not.toContain('text:tracked-changes');
    expect(importOdt(off).recordChanges).toBe(false);
  });

  it('DOCX: w:trackRevisions in settings.xml', async () => {
    const on = await buildDocx(doc, ...args(true));
    expect(strFromU8(unzipSync(on)['word/settings.xml'])).toContain('<w:trackRevisions');
    expect(importDocx(on).recordChanges).toBe(true);

    const off = await buildDocx(doc, ...args(false));
    expect(strFromU8(unzipSync(off)['word/settings.xml'])).not.toContain('<w:trackRevisions');
    expect(importDocx(off).recordChanges).toBe(false);
  });

  it('a registry with no flag records, as ODF defaults it to true', async () => {
    // What another producer may write: the element is there, the attribute is not.
    const files = unzipSync(await buildOdt(doc, ...args(true)));
    files['content.xml'] = strToU8(strFromU8(files['content.xml']).replace(' text:track-changes="true"', ''));
    expect(importOdt(zipSync(files)).recordChanges).toBe(true);
  });
});
