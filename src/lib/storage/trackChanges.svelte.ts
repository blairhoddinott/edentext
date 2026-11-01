import { docKey, docStore } from './docScope';

// Whether the editor records revisions, as a reactive singleton (same shape as
// autoCorrect.svelte.ts): the extension reads recordChanges() on every transaction, the
// Review tab flips it. Off by default, as in both word processors — and a document that
// records nothing writes no revision registry.

const KEY = docKey('edentext-record-changes');
const LOCK_KEY = docKey('edentext-record-lock');

/** Asks the app for a file to compare with (`detail` false) or merge in (true). */
export const OPEN_COMPARE_EVENT = 'edentext-open-compare';

/** Asks the app to set or lift the lock. */
export const OPEN_RECORD_LOCK_EVENT = 'edentext-open-record-lock';

/** What guards recording: `key` is the password's hash as LibreOffice keeps it (base64),
 *  `word` a DOCX file's own attributes. Without a key no password can be checked here. */
export type RecordLock = { key?: string; word?: string };

function storedLock(): RecordLock | null {
  try { return JSON.parse(docStore.getItem(LOCK_KEY) ?? 'null'); } catch { return null; }
}

let current = $state(docStore.getItem(KEY) === 'true');
let lock = $state<RecordLock | null>(storedLock());

export function recordChanges(): boolean {
  return current;
}

export function setRecordChanges(on: boolean): void {
  if (lock && !on) return;
  current = on;
  if (on) docStore.setItem(KEY, 'true');
  else docStore.removeItem(KEY);
}

/** Runs what settles changes; under protection the password comes first, then it runs. */
export function whenUnlocked(run: () => void): void {
  if (lock) window.dispatchEvent(new CustomEvent(OPEN_RECORD_LOCK_EVENT, { detail: run }));
  else run();
}

export function recordLock(): RecordLock | null {
  return lock;
}

export function setRecordLock(next: RecordLock | null): void {
  lock = next;
  if (next) docStore.setItem(LOCK_KEY, JSON.stringify(next));
  else docStore.removeItem(LOCK_KEY);
}
