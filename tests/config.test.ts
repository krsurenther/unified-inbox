import { describe, it, expect } from 'vitest';
import { AppConfigSchema, ChannelConfigSchema, channelConfig, loadConfig } from '../src/core/config/Config';

describe('config', () => {
  it('defaults a channel to auto-send OFF (human-in-the-loop safety invariant)', () => {
    expect(ChannelConfigSchema.parse({ llm: 'ollama' }).autoSend).toBe(false);
  });

  it('resolves an unconfigured channel to the default provider, auto-send OFF', () => {
    const cfg = AppConfigSchema.parse({ defaultProvider: 'echo' });
    const cc = channelConfig(cfg, 'webstore');
    expect(cc.llm).toBe('echo');
    expect(cc.autoSend).toBe(false);
  });

  it('loads an explicit JSON config file', () => {
    const cfg = loadConfig({ path: 'config.example.json', env: {} as NodeJS.ProcessEnv });
    expect(cfg.defaultProvider).toBe('echo');
    expect(cfg.channels['fake:demo']?.autoSend).toBe(false);
  });
});
