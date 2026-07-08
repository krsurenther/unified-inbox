import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Find a COMPLETE Chrome in puppeteer's cache and return its executable path.
 *
 * Why: this machine's npm script-gating left puppeteer's pinned Chrome download
 * corrupt (empty framework), so we resolve a usable binary ourselves and pass it
 * to whatsapp-web.js as `executablePath`. macOS-arm specific for now; Phase 5 can
 * generalize or rely on puppeteer's default once the pinned download is healthy.
 */
export function resolveChromeExecutable(): string | undefined {
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome');
  if (!existsSync(base)) return undefined;
  for (const v of readdirSync(base).sort().reverse()) {
    const app = join(base, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents');
    const bin = join(app, 'MacOS', 'Google Chrome for Testing');
    const fwVersions = join(app, 'Frameworks', 'Google Chrome for Testing Framework.framework', 'Versions');
    try {
      if (existsSync(bin) && existsSync(fwVersions) && readdirSync(fwVersions).some((x) => /^\d/.test(x))) {
        return bin;
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  return undefined;
}
