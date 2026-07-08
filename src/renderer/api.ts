import type { InboxApi } from '../shared/inbox-api';

declare global {
  interface Window {
    inbox: InboxApi;
  }
}

export const inbox: InboxApi = window.inbox;
