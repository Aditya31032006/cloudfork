import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Snapshots store HMAC-SHA256(accountId) keyed with a random per-user salt, never the raw ID.
 *
 * A plain SHA-256 of a 12-digit number can be brute-forced in minutes. With a secret salt that
 * only lives on the user's machine (outside any repo), someone holding just the snapshot file
 * can't recover the account ID, while the user's own machine can still recognise it.
 */

const SALT_FILE = 'salt';
const SALT_PATTERN = /^[a-f0-9]{64}$/;

export function defaultConfigDir(): string {
  if (process.env.CLOUDFORK_CONFIG_DIR) return process.env.CLOUDFORK_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cloudfork');
}

export async function loadOrCreateSalt(configDir = defaultConfigDir()): Promise<Buffer> {
  const path = join(configDir, SALT_FILE);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  try {
    // 'wx' fails if the file exists, so concurrent first runs can't overwrite each other.
    await writeFile(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const salt = (await readFile(path, 'utf8')).trim();
  if (!SALT_PATTERN.test(salt)) {
    // Never regenerate silently: a new salt would make existing snapshots unrecognisable.
    throw new Error(
      `The salt file at ${path} is corrupt (expected 64 hex characters). ` +
        'Restore it from a backup, or delete it to create a new one.',
    );
  }
  return Buffer.from(salt, 'hex');
}

export function fingerprintAccount(accountId: string, salt: Buffer): string {
  if (!/^\d{12}$/.test(accountId)) throw new Error('AWS account IDs are 12 digits.');
  return createHmac('sha256', salt).update(accountId).digest('hex');
}
