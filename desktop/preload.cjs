// The one bridge: documents the system hands the app open by path, and only those, and
// the print page rendered to PDF.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('edentextDesktop', {
  takeOpenedFile: () => ipcRenderer.invoke('desktop:take-file'),
  readFile: (path) => ipcRenderer.invoke('desktop:read', path),
  writeFile: (path, bytes) => ipcRenderer.invoke('desktop:write', path, bytes),
  printToPdf: (html) => ipcRenderer.invoke('desktop:print-pdf', html),
});
