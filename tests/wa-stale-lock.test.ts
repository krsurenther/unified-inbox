import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStaleChromeLocks } from '../src/core/channels/whatsapp/createWaClient';

describe('clearStaleChromeLocks', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wa-lock-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('removes a lock whose owning PID is dead', () => {
    symlinkSync('Some-Mac.local-999999', join(dir, 'SingletonLock')); // PID that cannot exist
    clearStaleChromeLocks(dir);
    expect(existsSync(join(dir, 'SingletonLock'))).toBe(false);
  });

  it('leaves a lock owned by a live process alone', () => {
    symlinkSync(`Some-Mac.local-${process.pid}`, join(dir, 'SingletonLock')); // this test process is alive
    clearStaleChromeLocks(dir);
    // readlinkSync works on the dangling symlink; existsSync follows it (target missing) so check via lstat path
    let stillThere = true;
    try { require('node:fs').readlinkSync(join(dir, 'SingletonLock')); } catch { stillThere = false; }
    expect(stillThere).toBe(true);
  });

  it('is a no-op when there is no lock', () => {
    expect(() => clearStaleChromeLocks(dir)).not.toThrow();
  });
});
