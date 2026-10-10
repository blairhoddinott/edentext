import { docKey, docStore } from './docScope';

// The assistant's conversation, kept with the document so a reload does not lose it;
// a new or opened document starts a new one (resetAiChat). Absent while empty.

const KEY = docKey('edentext-ai-chat');

export function loadAiChat<T>(): T | null {
  try {
    return JSON.parse(docStore.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function saveAiChat(chat: { entries: unknown[]; history: unknown[] } | null): void {
  try {
    if (!chat?.entries.length) docStore.removeItem(KEY);
    else docStore.setItem(KEY, JSON.stringify(chat));
  } catch {
    // Over the quota: the chat is a convenience, the document's own keys come first.
  }
}
