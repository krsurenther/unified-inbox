import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface DuokeToken {
  /** The raw Duoke session JWT. Treat as a secret — never log it. */
  token: string;
  /** ISO expiry decoded from the JWT `exp` claim, if present. */
  expiresAt?: string;
}

/** Default location of Duoke's Chromium cookie store on macOS. */
export function defaultDuokeCookiesPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Duoke', 'Cookies');
}

/**
 * Reads Duoke's reusable backend credential — a plaintext, effectively
 * non-expiring JWT stored in Duoke's own Chromium cookie store. We read it live
 * at runtime (copying the locked DB first); it is never copied into this repo.
 *
 * If a future Duoke build encrypts the cookie (non-empty `encrypted_value`, empty
 * `value`), this returns undefined — decryption via the macOS Keychain would be a
 * separate step. Recon confirmed the current build stores it in plaintext.
 */
export class DuokeTokenReader {
  constructor(private readonly cookiesPath: string = defaultDuokeCookiesPath()) {}

  read(): DuokeToken | undefined {
    if (!existsSync(this.cookiesPath)) return undefined;

    // Chromium holds the cookie DB locked while Duoke runs — copy, then read.
    const scratch = mkdtempSync(join(tmpdir(), 'duoke-cookies-'));
    const copy = join(scratch, 'Cookies');
    try {
      copyFileSync(this.cookiesPath, copy);
      const db = new DatabaseSync(copy);
      try {
        const row = db
          .prepare(
            `SELECT value FROM cookies
             WHERE name = 'token' AND host_key LIKE '%duoke.com%' AND value <> ''
             ORDER BY LENGTH(value) DESC
             LIMIT 1`,
          )
          .get() as { value?: string } | undefined;

        const token = typeof row?.value === 'string' ? row.value : '';
        if (!token) return undefined;
        return { token, expiresAt: jwtExpiry(token) };
      } finally {
        db.close();
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

function jwtExpiry(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: number };
    if (typeof payload.exp === 'number') return new Date(payload.exp * 1000).toISOString();
  } catch {
    /* not a decodable JWT payload — fine, expiry is optional */
  }
  return undefined;
}
