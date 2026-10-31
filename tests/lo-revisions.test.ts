// Recorded changes against LibreOffice: it opens what we write, accepts and rejects all
// of it, and must arrive at the paragraphs we arrive at. Self-skips without soffice.
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Editor } from '@tiptap/core';
import { CASES, FORMAT_CASES, TABLE_CASES, edit, open } from './trackChangesCases';
import { setRecordChanges } from '../src/lib/storage/trackChanges.svelte';
import { buildOdt } from '../src/lib/export/odt';
import { buildDocx } from '../src/lib/export/docx';
import { DEFAULT_MARGINS } from '../src/lib/storage/pageMargins';

const SOFFICE = (() => {
  try { execSync('command -v soffice', { stdio: 'ignore' }); return true; } catch { return false; }
})();
const DIR = '/tmp/lo-revisions';
const PROFILE = `${DIR}/profile`;
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const soffice = (args: string, env: Record<string, string> = {}) => execSync(
  `soffice -env:UserInstallation=file://${PROFILE} --headless --norestore --nologo ${args}`,
  { stdio: 'ignore', timeout: 300000, env: { ...process.env, ...env } },
);

const paragraphs = (e: Editor) => {
  const out: string[] = [];
  e.state.doc.descendants((n) => { if (n.isTextblock) out.push(n.textContent); return !n.isTextblock; });
  return out;
};

afterEach(() => setRecordChanges(false));

describe.skipIf(!SOFFICE)('recorded changes in LibreOffice (needs soffice)', () => {
  it('accepts and rejects to our result', { timeout: 300000 }, async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    const want = new Map<string, string[]>();
    const cases = [...CASES, ...TABLE_CASES, ...FORMAT_CASES];
    for (const [i, [name, html, steps]] of cases.entries()) {
      const plain = open(html);
      await edit(plain, steps);
      setRecordChanges(true);
      const recorded = open(html);
      await edit(recorded, steps);
      setRecordChanges(false);
      const json = recorded.getJSON() as any;
      writeFileSync(`${DIR}/c${i}.odt`, await buildOdt(json, DEFAULT_MARGINS));
      writeFileSync(`${DIR}/c${i}.docx`, await buildDocx(json, DEFAULT_MARGINS));
      for (const ext of ['odt', 'docx']) {
        // Our notes are blocks at the end, LibreOffice's text shows the anchor's number.
        if (!name.includes('note')) want.set(`c${i}.${ext} .uno:AcceptAllTrackedChanges`, paragraphs(plain));
        want.set(`c${i}.${ext} .uno:RejectAllTrackedChanges`, paragraphs(open(html)));
      }
    }

    soffice('--terminate_after_init');
    const lib = `${PROFILE}/user/basic/Standard`;
    writeFileSync(`${lib}/script.xlb`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd">
<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false"><library:element library:name="Module1"/></library:library>`);
    writeFileSync(`${lib}/Module1.xba`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic" script:moduleType="normal">${xml(readFileSync('tests/lo/revisions.bas', 'utf8'))}</script:module>`);
    soffice('macro:///Standard.Module1.Main', { LO_REV_DIR: DIR, LO_REV_COUNT: String(cases.length) });

    const got = new Map(readFileSync(`${DIR}/out.txt`, 'utf8').trim().split('\n').map((line) => {
      const [name, cmd, ...rest] = line.split(' ');
      // LibreOffice keeps the U+200D it puts into a new empty cell.
      return [`${name} ${cmd}`, rest.join(' ').replace(/\u200D/g, '').split('|').slice(1)] as const;
    }));
    const wrong = [...want].filter(([key, paras]) => JSON.stringify(got.get(key)) !== JSON.stringify(paras))
      .map(([key, paras]) => `${cases[+key.match(/c(\d+)/)![1]][0]} — ${key}: LibreOffice ${JSON.stringify(got.get(key))}, ours ${JSON.stringify(paras)}`);
    expect(wrong).toEqual([]);
    const unread = FORMAT_CASES.flatMap(([name], i) => ['odt', 'docx'].flatMap((ext) => {
      const kinds = got.get(`c${cases.length - FORMAT_CASES.length + i}.${ext} Kinds`) ?? [];
      return kinds.length && kinds.every((k) => k === 'Format') ? [] : [`${name}, ${ext}: ${kinds}`];
    }));
    expect(unread).toEqual([]);
  });
});
