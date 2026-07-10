import { describe, it, expect } from 'vitest';
import { formatRelative } from '../src/renderer/time';

describe('formatRelative', () => {
  const now = new Date('2026-07-10T12:00:00Z').getTime();
  it('renders compact relative times, then an absolute day', () => {
    expect(formatRelative('2026-07-10T11:59:30Z', now)).toBe('now');
    expect(formatRelative('2026-07-10T11:45:00Z', now)).toBe('15m');
    expect(formatRelative('2026-07-10T09:00:00Z', now)).toBe('3h');
    expect(formatRelative('2026-07-08T12:00:00Z', now)).toBe('2d');
    expect(formatRelative('2026-06-12T12:00:00Z', now)).toBe('12 Jun');
  });
  it('is safe on missing/garbage input', () => {
    expect(formatRelative(undefined, now)).toBe('');
    expect(formatRelative('not-a-date', now)).toBe('');
  });
});
