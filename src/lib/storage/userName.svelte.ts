// Who is working here, for this browser and not for one document: comments and recorded
// changes carry this name. The author in the document's properties says who wrote a
// file, and on a file from someone else that is them.

const KEY = 'edentext-user-name';

let current = $state(localStorage.getItem(KEY) ?? '');

export function userName(): string { return current.trim(); }

export function setUserName(name: string): void {
  current = name;
  if (name.trim()) localStorage.setItem(KEY, name);
  else localStorage.removeItem(KEY);
}
