import { describe, it, expect } from 'vitest';
import { LlmRouter } from '../src/core/llm/LlmRouter';
import { AppConfigSchema } from '../src/core/config/Config';
import type { DraftRequest, DraftResult, LLMProvider } from '../src/core/llm/LLMProvider';

const req = (): DraftRequest => ({ thread: { id: 't', channelId: 'ch', channelKind: 'whatsapp' }, history: [], systemPrompt: 'GLOBAL' });

describe('LlmRouter per-provider prompt', () => {
  it('uses the provider override when set, else the request systemPrompt', async () => {
    let seen = '';
    const provider: LLMProvider = { id: 'p1', async draftReply(r): Promise<DraftResult> { seen = r.systemPrompt; return { text: 'x', providerId: 'p1', model: 'm' }; } };

    const withOverride = new LlmRouter(AppConfigSchema.parse({ defaultProvider: 'p1', providerPrompts: { p1: 'OVERRIDE' } }), { p1: provider });
    await withOverride.draft('ch', req());
    expect(seen).toBe('OVERRIDE');

    const noOverride = new LlmRouter(AppConfigSchema.parse({ defaultProvider: 'p1' }), { p1: provider });
    await noOverride.draft('ch', req());
    expect(seen).toBe('GLOBAL');
  });
});
