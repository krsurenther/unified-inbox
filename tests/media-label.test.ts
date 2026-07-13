import { describe, it, expect } from 'vitest';
import { mediaLabel } from '../src/renderer/mediaLabel';

describe('mediaLabel', () => {
  it('maps marketplace system codes', () => {
    expect(mediaLabel('[10007]')?.label).toBe('Sticker');
    expect(mediaLabel('[10015]')?.label).toBe('Photo');
  });
  it('maps bracket placeholders (with or without a leading emoji)', () => {
    expect(mediaLabel('[image]')?.label).toBe('Photo');
    expect(mediaLabel('🖼️ [image]')?.label).toBe('Photo');
    expect(mediaLabel('[interactive]')?.label).toBe('Card');
    expect(mediaLabel('[voice]')?.icon).toBe('phone');
  });
  it('returns null for real text so it renders as-is', () => {
    expect(mediaLabel('is the red one in stock?')).toBeNull();
    expect(mediaLabel('[10007] plus a real question')).toBeNull();
  });
  it('falls back to media kind when the body is empty', () => {
    expect(mediaLabel('', 'image')?.label).toBe('Photo');
  });
});
