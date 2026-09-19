'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  /** The main process sends the room's settings, then the list of sources. */
  onSources: (handler) => {
    ipcRenderer.on('picker:sources', (_event, payload) => handler(payload));
  },
  /**
   * The whole decision in one message: which source, and what to share it
   * with. null cancels, which getDisplayMedia reports to the page as a denial.
   */
  choose: (choice) => ipcRenderer.send('picker:choose', choice),
});
