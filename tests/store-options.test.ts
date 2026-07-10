import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxStore } from '../src/core/store/InboxStore';

describe('InboxStore options', () => {
  it('opens read-only: reads work, writes throw, schema exec is skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-ro-'));
    const dbPath = join(dir, 'inbox.sqlite');
    const writer = new InboxStore(dbPath); // applies schema
    writer.upsertChannel({ id: 'c1', kind: 'fake', label: 'C1' });
    writer.close();

    const ro = new InboxStore(dbPath, { readOnly: true });
    expect(ro.listThreads()).toEqual([]); // reads fine
    expect(() => ro.upsertChannel({ id: 'c2', kind: 'fake', label: 'C2' })).toThrow(/read.?only/i);
    ro.close();
  });

  it('sets a busy_timeout so cross-process locks wait instead of failing', () => {
    const store = new InboxStore(':memory:');
    expect(store.busyTimeoutMs()).toBe(5000);
    store.close();
  });
});
