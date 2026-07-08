import { contextBridge, ipcRenderer } from 'electron';
import type { InboxApi, WaNumberState } from '../shared/inbox-api';

// Thin, typed bridge. The renderer never touches ipcRenderer directly.
const api: InboxApi = {
  listThreads: () => ipcRenderer.invoke('inbox:listThreads'),
  getHistory: (threadId) => ipcRenderer.invoke('inbox:getHistory', threadId),
  regenerateDraft: (threadId) => ipcRenderer.invoke('inbox:regenerateDraft', threadId),
  approveAndSend: (threadId, body) => ipcRenderer.invoke('inbox:approveAndSend', threadId, body),
  simulateIncoming: () => ipcRenderer.invoke('inbox:simulateIncoming'),

  listWhatsApp: () => ipcRenderer.invoke('wa:list'),
  connectWhatsApp: (id) => ipcRenderer.invoke('wa:connect', id),
  disconnectWhatsApp: (id) => ipcRenderer.invoke('wa:disconnect', id),
  onWaUpdate: (cb) => {
    const listener = (_e: unknown, states: WaNumberState[]) => cb(states);
    ipcRenderer.on('wa:update', listener);
    return () => ipcRenderer.removeListener('wa:update', listener);
  },
};

contextBridge.exposeInMainWorld('inbox', api);
