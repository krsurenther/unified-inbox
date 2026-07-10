import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * App config. Plain, declarative, validated. Holds NO secrets — API keys come
 * from environment variables only (see .env.example). The per-channel `llm` and
 * `autoSend` settings are how a human chooses a provider per channel and keeps
 * auto-send OFF until they explicitly turn it on.
 */
export const ChannelConfigSchema = z.object({
  /** LLMProvider id to use for this channel, e.g. 'echo' | 'ollama' | 'claude' | 'openai'. */
  llm: z.string().default('echo'),
  /** Optional model id passed to the provider. */
  model: z.string().optional(),
  /** Human-in-the-loop guard. OFF by default — nothing sends without approval. */
  autoSend: z.boolean().default(false),
});

export const WhatsAppNumberSchema = z.object({
  id: z.string(), // stable session id, e.g. 'num-1'
  label: z.string(), // shown in the UI, e.g. 'WhatsApp · Sales'
});

export const AppConfigSchema = z.object({
  systemPrompt: z
    .string()
    .default(
      'You are a helpful, concise customer-support agent for a retail business. ' +
        'Draft friendly, accurate replies. Never invent order, price, or stock details.',
    ),
  defaultProvider: z.string().default('echo'),
  /** Per-provider API keys entered in-app (local file only; env vars are the fallback). */
  apiKeys: z.record(z.string(), z.string()).default({}),
  channels: z.record(z.string(), ChannelConfigSchema).default({}),
  whatsapp: z
    .object({
      numbers: z.array(WhatsAppNumberSchema).default([]),
      /** Anti-ban: max sends per number per rolling 24h. Conservative default for aged numbers. */
      dailyCap: z.number().int().positive().default(200),
    })
    .default({ numbers: [], dailyCap: 200 }),
});

export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = AppConfigSchema.parse({});

/**
 * Load config from the first existing of: $UNIFIED_INBOX_CONFIG, ./config.local.json,
 * ./config.example.json — else built-in defaults. Invalid files throw (fail loud).
 */
export function loadConfig(opts?: { path?: string; env?: NodeJS.ProcessEnv }): AppConfig {
  const env = opts?.env ?? process.env;
  const candidates = [
    opts?.path,
    env.UNIFIED_INBOX_CONFIG,
    'config.local.json',
    'config.example.json',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return AppConfigSchema.parse(raw);
  }
  return DEFAULT_CONFIG;
}

/** Resolve the effective config for one channel, falling back to defaults. */
export function channelConfig(cfg: AppConfig, channelId: string): ChannelConfig {
  return (
    cfg.channels[channelId] ?? ChannelConfigSchema.parse({ llm: cfg.defaultProvider })
  );
}
