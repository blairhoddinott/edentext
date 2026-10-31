import type { Editor } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { Node as PMNode, type Schema } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { HfDoc } from '../storage/headerFooter';
import { shareAuthors } from './authorColors';
import { zoneExtensions } from './extensions';
import { StateStep } from './extensions/stateHistory';
import { RECORDING, revisions, settledDoc, type Revision } from './extensions/trackChanges';

// A header's or footer's changes belong to the document's review, though most zones have no
// editor: they are read from the stored docs, and settled on the body's undo stack.
export type ZoneHost = {
  body: () => Editor | null;
  /** The zones the pages show, under the id the body's history names them by. */
  list: () => { id: string; doc: HfDoc }[];
  /** Opens a zone for editing and hands over its editor. */
  open: (id: string, ready: (editor: Editor) => void) => void;
};

/** On a body transaction that wrote zones: they go back into the open zone too. */
export const ZONE_SETTLED = 'zoneSettled';

let host: ZoneHost | null = null;
let schema: Schema | null = null;
const nodes = new WeakMap<object, PMNode | null>();

function nodeOf(doc: HfDoc): PMNode | null {
  if (!doc) return null;
  if (nodes.has(doc)) return nodes.get(doc)!;
  schema ??= getSchema(zoneExtensions());
  let node: PMNode | null = null;
  try { node = PMNode.fromJSON(schema, doc); } catch { /* a stored zone this schema cannot read holds no change */ }
  nodes.set(doc, node);
  return node;
}

export function connectZones(next: ZoneHost): () => void {
  host = next;
  shareAuthors(() => ({ body: next.body()?.state.doc ?? null, zones: next.list().flatMap(({ doc }) => nodeOf(doc) ?? []) }));
  return () => {
    if (host !== next) return;
    host = null;
    shareAuthors(null);
  };
}

export const bodyEditor = () => host?.body() ?? null;

/** Every change in the zones, a zone shared by two sections in each. */
export function zoneRevisions(): Revision[] {
  return (host?.list() ?? []).flatMap(({ id, doc }) => {
    const node = nodeOf(doc);
    return node ? revisions(node).map((r) => ({ ...r, zone: id })) : [];
  });
}

/** Settles one change of the zones, or all of them, within a body transaction. */
export function settleZones(tr: Transaction, accept: boolean, id?: string): void {
  for (const zone of host?.list() ?? []) {
    const node = nodeOf(zone.doc);
    if (!node || !revisions(node).some((r) => id == null || r.id === id)) continue;
    tr.step(new StateStep(zone.id, zone.doc, settledDoc(node, accept, id).toJSON()));
  }
  tr.setMeta(RECORDING, true).setMeta(ZONE_SETTLED, true);
}

export function openZone(id: string, ready: (editor: Editor) => void): void {
  host?.open(id, ready);
}
