// The ONE interface the AI reply engine hides behind. Business logic calls
// `provider.draftReply()` and never imports a model SDK. Cloud (Claude/OpenAI)
// and local (Ollama) adapters are interchangeable; selection is per-channel config.

export interface DraftHistoryItem {
  role: 'customer' | 'agent';
  text: string;
  at: string;
}

export interface DraftRequest {
  thread: {
    id: string;
    channelId: string;
    channelKind: string;
    customerName?: string;
  };
  history: DraftHistoryItem[]; // oldest-first
  systemPrompt: string;
  context?: { notes?: string; kb?: string[] };
}

export interface DraftResult {
  text: string;
  providerId: string;
  model: string;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface LLMProvider {
  readonly id: string;
  draftReply(req: DraftRequest): Promise<DraftResult>;
  /** Optional token streaming for the UI; falls back to draftReply if absent. */
  draftReplyStream?(req: DraftRequest): AsyncIterable<string>;
}
