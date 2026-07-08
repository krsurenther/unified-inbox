import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuokeTokenReader } from '../src/core/channels/duoke/DuokeTokenReader';

// A JWT with `exp` in the year ~2048 (Duoke's real token is effectively non-expiring).
const FAR_FUTURE_EXP = 2472449666;
function makeJwt(exp: number): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ id: 123, exp })}.signature`;
}

function writeCookies(path: string, rows: Array<{ host: string; name: string; value: string }>): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)');
  const stmt = db.prepare('INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, ?)');
  for (const r of rows) stmt.run(r.host, r.name, r.value, Buffer.alloc(0));
  db.close();
}

describe('DuokeTokenReader', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duoke-test-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the plaintext Duoke JWT from the cookies store', () => {
    const p = join(dir, 'Cookies');
    writeCookies(p, [
      { host: 'app.duoke.com', name: 'token', value: makeJwt(FAR_FUTURE_EXP) },
      { host: 'app.duoke.com', name: 'other', value: 'irrelevant' },
    ]);
    const t = new DuokeTokenReader(p).read();
    expect(t?.token.split('.')).toHaveLength(3);
  });

  it('surfaces token expiry decoded from the JWT', () => {
    const p = join(dir, 'Cookies');
    writeCookies(p, [{ host: 'app.duoke.com', name: 'token', value: makeJwt(FAR_FUTURE_EXP) }]);
    expect(new DuokeTokenReader(p).read()?.expiresAt).toBe(new Date(FAR_FUTURE_EXP * 1000).toISOString());
  });

  it('returns undefined when there is no Duoke token cookie', () => {
    const p = join(dir, 'Cookies');
    writeCookies(p, [{ host: 'app.duoke.com', name: 'unrelated', value: 'x' }]);
    expect(new DuokeTokenReader(p).read()).toBeUndefined();
  });

  it('returns undefined when the cookies file does not exist', () => {
    expect(new DuokeTokenReader(join(dir, 'Nope')).read()).toBeUndefined();
  });
});
