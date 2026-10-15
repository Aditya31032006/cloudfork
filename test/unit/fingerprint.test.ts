import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintAccount, loadOrCreateSalt } from '../../src/snapshot/fingerprint.js';

const ACCOUNT = '111111111111';

describe('fingerprintAccount', () => {
  const salt = Buffer.alloc(32, 1);

  it('is deterministic for the same salt', () => {
    expect(fingerprintAccount(ACCOUNT, salt)).toBe(fingerprintAccount(ACCOUNT, salt));
    expect(fingerprintAccount(ACCOUNT, salt)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('differs between salts, so the hash alone does not identify the account', () => {
    expect(fingerprintAccount(ACCOUNT, salt)).not.toBe(fingerprintAccount(ACCOUNT, Buffer.alloc(32, 2)));
  });

  it('is not an unsalted SHA-256 of the account ID', () => {
    const plain = createHash('sha256').update(ACCOUNT).digest('hex');
    expect(fingerprintAccount(ACCOUNT, salt)).not.toBe(plain);
  });

  it('differs between accounts', () => {
    expect(fingerprintAccount(ACCOUNT, salt)).not.toBe(fingerprintAccount('222222222222', salt));
  });

  it('rejects malformed account IDs', () => {
    expect(() => fingerprintAccount('1234', salt)).toThrow(/12 digits/);
  });
});

describe('loadOrCreateSalt', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'cloudfork-salt-')), 'config', 'cloudfork');
  });
  afterEach(async () => {
    await rm(join(dir, '..', '..'), { recursive: true, force: true });
  });

  it('creates a 32-byte random salt on first run', async () => {
    const salt = await loadOrCreateSalt(dir);
    expect(salt).toHaveLength(32);
    expect((await readFile(join(dir, 'salt'), 'utf8')).trim()).toBe(salt.toString('hex'));
  });

  it('reuses the same salt on later runs', async () => {
    const first = await loadOrCreateSalt(dir);
    expect((await loadOrCreateSalt(dir)).equals(first)).toBe(true);
  });

  it('agrees on one salt when first runs race', async () => {
    const salts = await Promise.all(Array.from({ length: 5 }, () => loadOrCreateSalt(dir)));
    expect(new Set(salts.map((s) => s.toString('hex'))).size).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('is readable only by the owner', async () => {
    await loadOrCreateSalt(dir);
    expect((await stat(join(dir, 'salt'))).mode & 0o777).toBe(0o600);
  });

  it('refuses to silently replace a corrupt salt', async () => {
    await loadOrCreateSalt(dir);
    await writeFile(join(dir, 'salt'), 'garbage\n');
    await expect(loadOrCreateSalt(dir)).rejects.toThrow(/corrupt/);
    expect(await readFile(join(dir, 'salt'), 'utf8')).toBe('garbage\n');
  });
});
