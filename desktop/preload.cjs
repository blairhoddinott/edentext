// The one bridge: documents the system hands the app open by path, and only those.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('edentextDesktop', {
  takeOpenedFile: () => ipcRenderer.invoke('desktop:take-file'),
  readFile: (path) => ipcRenderer.invoke('desktop:read', path),
  writeFile: (path, bytes) => ipcRenderer.invoke('desktop:write', path, bytes),
});
