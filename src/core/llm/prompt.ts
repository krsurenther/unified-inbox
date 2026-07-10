import type { DraftRequest } from './LLMProvider';

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  duoke: 'a marketplace (Lazada/TikTok/Shopee)',
  webstore: 'the webstore live chat',
  fake: 'a demo',
};

/** The system prompt shared by every provider — one voice regardless of model. */
export function buildSystemPrompt(req: DraftRequest): string {
  const channel = CHANNEL_LABEL[req.thread.channelKind] ?? req.thread.channelKind;
  const who = req.thread.customerName ? ` You are talking to ${req.thread.customerName}.` : '';
  return (
    `${req.systemPrompt}\n\n` +
    `You are drafting the seller's next reply in ${channel}.${who} ` +
    `Reply in the customer's language. Write ONLY the message to send — no quotes, ` +
    `no "Draft:" prefix, no explanation, no options. Keep it concise, warm, and helpful. ` +
    `If you don't have enough information (e.g. exact price, stock, or order status), don't invent it — ` +
    `say you'll check and get back to them.`
  );
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Map the thread history to user/assistant turns, nudging a final user turn so a chat model always replies. */
export function buildChatTurns(req: DraftRequest): ChatTurn[] {
  const turns: ChatTurn[] = req.history.map((h) => ({
    role: h.role === 'customer' ? ('user' as const) : ('assistant' as const),
    content: h.text,
  }));
  // Chat models return an empty turn when the last message is the assistant's; nudge one.
  if (turns[turns.length - 1]?.role !== 'user') {
    turns.push({ role: 'user', content: 'Draft the seller’s next reply to this customer now — output only the message text.' });
  }
  return turns;
}
