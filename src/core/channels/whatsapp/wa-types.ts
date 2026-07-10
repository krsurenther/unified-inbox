// Minimal structural interfaces over whatsapp-web.js, so the adapter can be unit
// tested with a mock and the real Client is injected in production.

export interface WaId {
  _serialized: string;
}

export interface WaMedia {
  data: string; // base64
  mimetype: string;
  filename?: string;
}

export interface WaMessage {
  id: WaId;
  from: string;
  to: string;
  body: string;
  fromMe: boolean;
  timestamp: number; // epoch SECONDS
  type: string; // 'chat' | 'image' | 'ptt' | ...
  hasMedia: boolean;
  author?: string; // sender in a group
  /** whatsapp-web.js: download the attached media (base64). Absent on the mock unless set. */
  downloadMedia?(): Promise<WaMedia | undefined>;
}

export interface WaChat {
  id: WaId;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number; // epoch SECONDS
  lastMessage?: WaMessage;
  fetchMessages(opts: { limit: number }): Promise<WaMessage[]>;
}

/** The slice of whatsapp-web.js' Client the adapter depends on. */
export interface WaClient {
  on(event: 'qr', cb: (qr: string) => void): void;
  on(event: 'ready', cb: () => void): void;
  on(event: 'message', cb: (msg: WaMessage) => void | Promise<void>): void;
  on(event: 'disconnected', cb: (reason: string) => void): void;
  on(event: 'auth_failure', cb: (msg: string) => void): void;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  /** Unlink this device from the phone and clear the saved session. */
  logout(): Promise<void>;
  getChats(): Promise<WaChat[]>;
  getChatById(chatId: string): Promise<WaChat>;
  sendMessage(chatId: string, content: string): Promise<WaMessage>;
}
