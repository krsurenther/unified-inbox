import { describe, it, expect } from 'vitest';
import { InboxStore } from '../src/core/store/InboxStore';

describe('InboxStore settings k/v', () => {
  it('roundtrips and overwrites', () => {
    const s = new InboxStore(':memory:');
    expect(s.getSetting('wa.kill')).toBeUndefined();
    s.setSetting('wa.kill', '1');
    expect(s.getSetting('wa.kill')).toBe('1');
    s.setSetting('wa.kill', '0');
    expect(s.getSetting('wa.kill')).toBe('0');
  });
});
