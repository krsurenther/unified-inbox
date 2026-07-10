import type { AppConfig } from '../config/Config';
import { channelConfig } from '../config/Config';
import type { DraftRequest, DraftResult, LLMProvider } from './LLMProvider';

/**
 * Maps a channel to its configured LLMProvider. This is the ONLY place that
 * knows which provider serves which channel — business logic just calls
 * `router.draft(channelId, req)` and never sees a vendor. Swapping a channel
 * from local→cloud is a config edit, not a code change.
 */
export class LlmRouter {
  constructor(
    private readonly config: AppConfig,
    private readonly providers: Record<string, LLMProvider>,
  ) {}

  providerFor(channelId: string): LLMProvider {
    const wanted = channelConfig(this.config, channelId).llm;
    const provider = this.providers[wanted] ?? this.providers[this.config.defaultProvider];
    if (!provider) {
      throw new Error(
        `No LLM provider registered for '${wanted}' (channel '${channelId}'); ` +
          `known: ${Object.keys(this.providers).join(', ') || '(none)'}`,
      );
    }
    return provider;
  }

  draft(channelId: string, req: DraftRequest): Promise<DraftResult> {
    const provider = this.providerFor(channelId);
    // Per-provider prompt override (tailor each AI); else the global systemPrompt in req.
    const override = this.config.providerPrompts?.[provider.id];
    return provider.draftReply(override ? { ...req, systemPrompt: override } : req);
  }
}
