import type { DraftRequest, DraftResult, LLMProvider } from './LLMProvider';

/**
 * Phase-1 stand-in for a real model. Produces a deterministic, obviously-draft
 * reply so the approve / edit / send pipeline can be proven without any model.
 * Replaced in Phase 4 by OllamaProvider / ClaudeProvider / OpenAIProvider behind
 * this same interface — no business-logic change.
 */
export class EchoProvider implements LLMProvider {
  readonly id = 'echo';

  async draftReply(req: DraftRequest): Promise<DraftResult> {
    const lastCustomer = [...req.history].reverse().find((h) => h.role === 'customer');
    const name = req.thread.customerName?.trim() || 'there';
    const text = lastCustomer
      ? `Hi ${name}, thanks for your message — to make sure I understand, you said: ` +
        `"${truncate(lastCustomer.text, 160)}". Here's a draft reply for you to review and edit before sending.`
      : `Hi ${name}, thanks for reaching out! (draft — edit me before sending.)`;
    return { text, providerId: this.id, model: 'echo-1', finishReason: 'stop' };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
