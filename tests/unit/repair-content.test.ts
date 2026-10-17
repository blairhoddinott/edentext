import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { extensions } from '../../src/lib/editor/extensions';
import { repairContent } from '../../src/lib/import/repairContent';

const schema = getSchema(extensions);
const text = (t: string) => ({ type: 'text', text: t });

describe('repairContent', () => {
  it('returns valid content untouched', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [text('a')] }] };
    const r = repairContent(doc, schema);
    expect(r).toEqual({ content: doc, error: null });
  });

  it('keeps the text of a table a list item cannot hold', () => {
    const cell = { type: 'tableCell', content: [{ type: 'paragraph', content: [text('cell')] }] };
    const doc = { type: 'doc', content: [{ type: 'orderedList', content: [{ type: 'listItem', content: [
      { type: 'paragraph', content: [text('item ')] },
      { type: 'table', content: [{ type: 'tableRow', content: [cell] }] },
    ] }] }] };
    const r = repairContent(doc, schema);
    expect(r.error).toBeTruthy();
    expect(() => schema.nodeFromJSON(r.content).check()).not.toThrow();
    expect(schema.nodeFromJSON(r.content).textContent).toBe('item cell');
  });

  it('wraps loose text in a paragraph', () => {
    const r = repairContent({ type: 'doc', content: [text('loose')] }, schema);
    expect(r.content.content?.[0].type).toBe('paragraph');
    expect(() => schema.nodeFromJSON(r.content).check()).not.toThrow();
    expect(schema.nodeFromJSON(r.content).textContent).toBe('loose');
  });
});
