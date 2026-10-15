import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readSnapshot,
  serializeSnapshot,
  SnapshotValidationError,
  writeSnapshot,
} from '../../src/snapshot/io.js';
import { bucket, snapshot } from '../helpers/fixtures.js';

describe('serializeSnapshot', () => {
  it('is independent of key order and resource order', () => {
    const a = snapshot({
      resources: {
        s3: {
          buckets: [bucket({ name: 'b-bucket', tags: { z: '1', a: '2' } }), bucket({ name: 'a-bucket' })],
        },
      },
    });
    const b = snapshot({
      resources: {
        s3: {
          buckets: [bucket({ name: 'a-bucket' }), bucket({ tags: { a: '2', z: '1' }, name: 'b-bucket' })],
        },
      },
    });
    expect(serializeSnapshot(a)).toBe(serializeSnapshot(b));
  });

  it('sorts resources by name and keys alphabetically', () => {
    const text = serializeSnapshot(
      snapshot({ resources: { s3: { buckets: [bucket({ name: 'zeta' }), bucket({ name: 'alpha' })] } } }),
    );
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"zeta"'));
    expect(text.indexOf('"createdAt"')).toBeLessThan(text.indexOf('"region"'));
  });

  it('keeps CORS rule order, which is significant', () => {
    const cors = [
      { AllowedMethods: ['PUT' as const], AllowedOrigins: ['https://admin.example.com'] },
      { AllowedMethods: ['GET' as const], AllowedOrigins: ['*'] },
    ];
    const parsed = JSON.parse(
      serializeSnapshot(snapshot({ resources: { s3: { buckets: [bucket({ cors })] } } })),
    );
    expect(parsed.resources.s3.buckets[0].cors).toEqual(cors);
  });

  it('uses two-space indentation and ends with a newline', () => {
    const text = serializeSnapshot(snapshot());
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.split('\n')[1]).toMatch(/^ {2}"/);
  });

  it('refuses to serialize an invalid snapshot', () => {
    expect(() => serializeSnapshot({ ...snapshot(), sourceAccountId: '111111111111' })).toThrow(
      SnapshotValidationError,
    );
  });
});

describe('readSnapshot / writeSnapshot', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cloudfork-io-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips through disk', async () => {
    const path = join(dir, 'cloudfork.json');
    const original = snapshot();
    await writeSnapshot(path, original);
    expect(await readSnapshot(path)).toEqual(original);
    expect(await readFile(path, 'utf8')).toBe(serializeSnapshot(original));
  });

  it('leaves no temp file behind', async () => {
    await writeSnapshot(join(dir, 'cloudfork.json'), snapshot());
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual(['cloudfork.json']);
  });

  it('reports a missing snapshot clearly', async () => {
    await expect(readSnapshot(join(dir, 'missing.json'))).rejects.toThrow(
      /not found. Run `cloudfork scan` first/,
    );
  });

  it('reports invalid JSON', async () => {
    const path = join(dir, 'broken.json');
    await writeFile(path, '{ not json');
    await expect(readSnapshot(path)).rejects.toThrow(/not valid JSON/);
  });

  it('validates on read and names the failing field', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, JSON.stringify({ ...snapshot(), region: 'mars-1' }));
    await expect(readSnapshot(path)).rejects.toThrow(/region/);
  });
});
