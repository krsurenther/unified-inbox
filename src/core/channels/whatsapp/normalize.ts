import type { WaChat, WaMessage } from './wa-types';
import type { ThreadDescriptor } from '../ChannelAdapter';

export interface NormalizedWaMessage {
  direction: 'inbound' | 'outbound';
  body: string;
  channelMessageId: string;
  timestamp: string; // ISO-8601 UTC
}

const MEDIA_LABEL: Record<string, string> = {
  image: '[image]',
  video: '[video]',
  audio: '[audio]',
  ptt: '[voice message]',
  document: '[document]',
  sticker: '[sticker]',
  location: '[location]',
  vcard: '[contact card]',
};

/** Strip the WhatsApp id suffix (`60123@c.us` → `60123`, `123@lid` → `123`). */
export function stripWaId(serialized: string): string {
  return serialized.replace(/@(c\.us|s\.whatsapp\.net|g\.us|lid|broadcast)$/, '');
}

// Message types with no conversational content — filtered out of the inbox so
// they don't show as blank bubbles (WhatsApp injects these into every chat).
const SYSTEM_TYPES = new Set([
  'e2e_notification',
  'notification',
  'notification_template',
  'gp2',
  'group_notification',
  'broadcast_notification',
  'security_notification',
  'call_log',
  'ciphertext',
  'protocol',
  'revoked',
]);

/** True for WhatsApp system/protocol messages that carry no reply-worthy content. */
export function isSystemWaMessage(type: string): boolean {
  return SYSTEM_TYPES.has(type);
}

export function normalizeWaMessage(msg: WaMessage): NormalizedWaMessage {
  const body = msg.body && msg.body.length > 0 ? msg.body : msg.hasMedia ? (MEDIA_LABEL[msg.type] ?? '[media]') : '';
  return {
    direction: msg.fromMe ? 'outbound' : 'inbound',
    body,
    channelMessageId: msg.id._serialized,
    timestamp: new Date(msg.timestamp * 1000).toISOString(),
  };
}

export function waChatToDescriptor(chat: WaChat): ThreadDescriptor {
  const phone = stripWaId(chat.id._serialized);
  return {
    threadKey: chat.id._serialized,
    participant: { externalId: phone, name: chat.name, phone },
    unread: chat.unreadCount,
    lastMessageAt: new Date(chat.timestamp * 1000).toISOString(),
    preview: chat.lastMessage ? normalizeWaMessage(chat.lastMessage).body : undefined,
  };
}
