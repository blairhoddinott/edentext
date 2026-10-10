// Header/footer zones and watched stores (page setup, styles …) join the body's undo
// stack: one history for the whole document.
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions';
import { closeHistory, isHistoryTransaction } from '@tiptap/pm/history';
import { StateStep, StateHistory, ZoneHistory, addPending, removePending, pushState, watchState, noteState, rebaseStates, flushPending } from '../../src/lib/editor/extensions/stateHistory';
import { resetHistoryLog } from '../../src/lib/utils/historyLog.svelte';

const para = (text: string) => ({ type: 'doc', content: [text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }] });

// Destroyed after each test so no view's DOM-observer timer fires after the environment is torn down.
const editors: Editor[] = [];
afterEach(() => { for (const ed of editors.splice(0)) if (!ed.isDestroyed) ed.destroy(); });

function setup() {
  const body = new Editor({ extensions: [Document, Paragraph, Text, UndoRedo, StateHistory], content: para('body') });
  const zone = new Editor({ extensions: [Document, Paragraph, Text, ZoneHistory.configure({ body: () => body, id: 'hf:0:header' })], content: para('') });
  editors.push(body, zone);
  // What HeaderFooterLayer does: an undo or redo hands back the zone's content.
  const restored: unknown[] = [];
  body.on('transaction', ({ transaction }) => {
    if (!isHistoryTransaction(transaction)) return;
    for (const s of transaction.steps) if (s instanceof StateStep) restored.push(s.to);
  });
  const type = (ed: Editor, text: string, group = false) => {
    const tr = ed.state.tr.insertText(text, ed.state.doc.content.size - 1);
    ed.view.dispatch(group ? closeHistory(tr) : tr);
  };
  return { body, zone, restored, type };
}

describe('state history', () => {
  it('undoes a zone edit and a later body edit in order, from either editor', () => {
    const { body, zone, restored, type } = setup();
    type(zone, 'Head');
    zone.destroy(); // leaving the zone lands its last group on the body's stack
    expect(body.getText()).toBe('body');
    type(body, ' text');
    expect(body.commands.undo()).toBe(true);
    expect(body.getText()).toBe('body');
    expect(restored).toEqual([]);
    expect(body.commands.undo()).toBe(true);
    expect(restored).toEqual([para('')]);
    expect(body.commands.redo()).toBe(true);
    expect(restored).toEqual([para(''), para('Head')]);
  });

  it('keeps one undo step per zone group and undoes the pending one first', () => {
    const { zone, restored, type } = setup();
    type(zone, 'A');
    type(zone, 'B', true);
    expect(zone.can().undo()).toBe(true);
    expect(zone.can().redo()).toBe(false);
    zone.commands.undo();
    expect(restored).toEqual([para('A')]);
    zone.commands.undo();
    expect(restored).toEqual([para('A'), para('')]);
  });

  it('drops a zone group begun before the history was reset', () => {
    const { body, zone, type } = setup();
    type(zone, 'old');
    resetHistoryLog();
    zone.destroy();
    expect(body.can().undo()).toBe(false);
  });

  it('lands a pending change before an undo key steps back', () => {
    const { body, restored } = setup();
    const commit = () => pushState(body, 'layout', 'narrow-before', 'narrow');
    let held = true;
    const flush = () => { if (held) { held = false; commit(); } };
    addPending(flush);
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true });
    body.view.someProp('handleKeyDown', (f) => f(body.view, event));
    removePending(flush);
    expect(held).toBe(false);
    expect(restored).toEqual(['narrow-before']);
  });

  // A store as App holds one: replaced, not mutated, so `read` shows a change by reference.
  function watched(id: string, body: Editor) {
    const store = { v: { n: 1 } };
    const w = watchState(id, () => body, () => ({ v: store.v }), (to) => { store.v = to.v as { n: number }; });
    return { store, w };
  }

  it('joins a store set in the same task as a text change into that step', () => {
    const { body, type } = setup();
    const { store } = watched('same-task', body);
    store.v = { n: 2 };
    type(body, ' x');
    expect(body.commands.undo()).toBe(true);
    expect(body.getText()).toBe('body');
    expect(store.v).toEqual({ n: 1 });
    expect(body.can().undo()).toBe(false);
    expect(body.commands.redo()).toBe(true);
    expect(body.getText()).toBe('body x');
    expect(store.v).toEqual({ n: 2 });
  });

  it('lands a gathering store change before the text typed after it', () => {
    const { body, type } = setup();
    const { store, w } = watched('earlier', body);
    store.v = { n: 2 };
    noteState(w); // the effect, a microtask later
    body.view.someProp('handleDOMEvents', (h) => { h.keydown?.(body.view, new KeyboardEvent('keydown', { key: 'x' })); });
    type(body, ' x');
    body.commands.undo();
    expect(body.getText()).toBe('body');
    expect(store.v).toEqual({ n: 2 });
    body.commands.undo();
    expect(store.v).toEqual({ n: 1 });
  });

  it('takes a loaded document\'s values as the base, not as an edit', () => {
    const { body } = setup();
    const { store, w } = watched('loaded', body);
    store.v = { n: 2 };
    noteState(w);
    resetHistoryLog();
    store.v = { n: 3 };
    rebaseStates();
    flushPending();
    expect(body.can().undo()).toBe(false);
  });
});
