// A DATE/TIME field whose picture the catalog does not list: it stays a live field,
// keyed by the picture itself, and renders and re-exports the same.
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { importDocx } from '../../src/lib/import/docx';
import { buildDocx } from '../../src/lib/export/docx';
import { findFormat, renderFormat, docxPicture, defaultDateFormat, DEFAULT_DATE_FORMAT } from '../../src/lib/utils/dateTime';
import { docxOf } from '../docxFixture';

const BODY = `<w:p>
<w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText xml:space="preserve"> DATE  \\@ "MMMM d"  \\* MERGEFORMAT </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r>
<w:r><w:t>July 10</w:t></w:r>
<w:r><w:fldChar w:fldCharType="end"/></w:r>
</w:p>`;

const file = docxOf(BODY);

const walk = (n: any, type: string, out: any[] = []): any[] => {
  for (const c of n.content ?? []) { if (c.type === type) out.push(c); walk(c, type, out); }
  return out;
};

describe('a date field format the catalog does not list', () => {
  it('imports as a live field keyed by its own picture', () => {
    const fields = walk(importDocx(file).content, 'dateTimeField');
    expect(fields).toHaveLength(1);
    expect(fields[0].attrs).toMatchObject({ kind: 'date', format: 'MMMM d', fixed: false });
  });

  it('renders the current date in that format', () => {
    const fmt = findFormat('MMMM d')!;
    expect(renderFormat(fmt, new Date(2026, 8, 10), 'en-US')).toBe('September 10');
    // A Slavic locale declines the month beside a day; the stand-alone form is "сентябрь".
    expect(renderFormat(fmt, new Date(2026, 8, 10), 'ru-RU')).toBe('сентября 10');
    expect(docxPicture(fmt)).toBe('MMMM d');
  });

  it('exports the picture back, so the field stays live in Word', async () => {
    const doc = importDocx(file).content;
    const xml = strFromU8(unzipSync(await buildDocx(doc as any))['word/document.xml']);
    expect(xml).toMatch(/<w:fldSimple[^>]*w:instr="[^"]*DATE[^"]*MMMM d/);
  });
});

// The picture a new date field takes follows the UI language; a stored field keeps its own,
// which is what DEFAULT_DATE_FORMAT stays for.
describe('East Asian date pictures', () => {
  const day = new Date(2026, 2, 15);

  it('renders the CJK pictures', () => {
    expect(renderFormat(findFormat('ymd_cjk')!, day, 'zh-CN')).toBe('2026年3月15日');
    expect(renderFormat(findFormat('ymd_slash')!, day, 'zh-CN')).toBe('2026/03/15');
  });

  it('preselects one per locale, and leaves the fallback alone', () => {
    expect(defaultDateFormat('zh-Hans')).toBe('ymd_cjk');
    expect(defaultDateFormat('zh-Hant')).toBe('ymd_cjk');
    expect(defaultDateFormat('ja')).toBe('ymd_cjk');
    expect(defaultDateFormat('en')).toBe('mdy_slash');
    expect(defaultDateFormat('de')).toBe(DEFAULT_DATE_FORMAT);
  });
});
