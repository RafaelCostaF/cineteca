'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Only the desktop window gets this; browsers on other devices do not.
contextBridge.exposeInMainWorld('cineteca', {
  quit: () => ipcRenderer.send('cineteca:quit'),
});
