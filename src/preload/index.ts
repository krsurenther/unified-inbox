import { contextBridge, ipcRenderer } from 'electron';
import type { InboxApi, WaNumberState } from '../shared/inbox-api';

// Thin, typed bridge. The renderer never touches ipcRenderer directly.
const api: InboxApi = {
  listThreads: () => ipcRenderer.invoke('inbox:listThreads'),
  searchThreads: (q) => ipcRenderer.invoke('inbox:search', q),
  listChannels: () => ipcRenderer.invoke('inbox:channels'),
  triageCounts: () => ipcRenderer.invoke('inbox:triageCounts'),
  relatedThreads: (threadId) => ipcRenderer.invoke('inbox:related', threadId),
  assignThread: (threadId, assignee) => ipcRenderer.invoke('inbox:assign', threadId, assignee),
  setThreadNote: (threadId, note) => ipcRenderer.invoke('inbox:note', threadId, note),
  getQuickReplies: () => ipcRenderer.invoke('qr:get'),
  setQuickReplies: (replies) => ipcRenderer.invoke('qr:set', replies),
  listStaff: () => ipcRenderer.invoke('staff:get'),
  setStaff: (staff, me) => ipcRenderer.invoke('staff:set', staff, me),
  getUiPrefs: () => ipcRenderer.invoke('ui:get'),
  setUiPrefs: (patch) => ipcRenderer.invoke('ui:set', patch),
  getHistory: (threadId) => ipcRenderer.invoke('inbox:getHistory', threadId),
  health: () => ipcRenderer.invoke('inbox:health'),
  threadOrders: (threadId) => ipcRenderer.invoke('duoke:orders', threadId),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  setProvider: (id) => ipcRenderer.invoke('providers:set', id),
  setProviderKey: (id, key) => ipcRenderer.invoke('providers:setKey', id, key),
  getPrompts: () => ipcRenderer.invoke('prompts:get'),
  setPrompts: (systemPrompt, providerPrompts) => ipcRenderer.invoke('prompts:set', systemPrompt, providerPrompts),
  getMcp: () => ipcRenderer.invoke('mcp:get'),
  setMcp: (url, token) => ipcRenderer.invoke('mcp:set', url, token),
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

  listWhatsApp: () => ipcRenderer.invoke('wa:list'),
  connectWhatsApp: (id) => ipcRenderer.invoke('wa:connect', id),
  disconnectWhatsApp: (id) => ipcRenderer.invoke('wa:disconnect', id),
  renameWhatsApp: (id, label) => ipcRenderer.invoke('wa:rename', id, label),
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
