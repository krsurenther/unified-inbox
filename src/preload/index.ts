import { contextBridge, ipcRenderer } from 'electron';
import type { InboxApi, WaNumberState } from '../shared/inbox-api';

// Thin, typed bridge. The renderer never touches ipcRenderer directly.
const api: InboxApi = {
  listThreads: () => ipcRenderer.invoke('inbox:listThreads'),
  getHistory: (threadId) => ipcRenderer.invoke('inbox:getHistory', threadId),
  health: () => ipcRenderer.invoke('inbox:health'),
  markRead: (threadId) => ipcRenderer.invoke('inbox:markRead', threadId),
  setThreadStatus: (threadId, status) => ipcRenderer.invoke('inbox:setThreadStatus', threadId, status),
  setThreadMuted: (threadId, muted) => ipcRenderer.invoke('inbox:setThreadMuted', threadId, muted),
  regenerateDraft: (threadId) => ipcRenderer.invoke('inbox:regenerateDraft', threadId),
  updateDraft: (draftId, body) => ipcRenderer.invoke('inbox:updateDraft', draftId, body),
  approveAndSend: (threadId, body) => ipcRenderer.invoke('inbox:approveAndSend', threadId, body),
  onSendUpdate: (cb) => {
    const listener = (_e: unknown, evt: Parameters<typeof cb>[0]) => cb(evt);
    ipcRenderer.on('send:update', listener);
    return () => ipcRenderer.removeListener('send:update', listener);
  },
  simulateIncoming: () => ipcRenderer.invoke('inbox:simulateIncoming'),

  listWhatsApp: () => ipcRenderer.invoke('wa:list'),
  connectWhatsApp: (id) => ipcRenderer.invoke('wa:connect', id),
  disconnectWhatsApp: (id) => ipcRenderer.invoke('wa:disconnect', id),
  onWaUpdate: (cb) => {
    const listener = (_e: unknown, states: WaNumberState[]) => cb(states);
    ipcRenderer.on('wa:update', listener);
    return () => ipcRenderer.removeListener('wa:update', listener);
  },

  whatsappGuard: () => ipcRenderer.invoke('wa:guardStatus'),
  setWhatsappKill: (on) => ipcRenderer.invoke('wa:setKill', on),

  onSelectThread: (cb) => {
    const listener = (_e: unknown, threadId: string) => cb(threadId);
    ipcRenderer.on('inbox:select', listener);
    return () => ipcRenderer.removeListener('inbox:select', listener);
  },
};

contextBridge.exposeInMainWorld('inbox', api);
