import { CreateBucketCommand, ListBucketsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedChaiCartS3 } from '../../examples/chaicart/seed.js';
import { createSourceSession, createTargetSession } from '../../src/aws/clients.js';
import { scan, type ScanOutput } from '../../src/core/scan.js';
import { up } from '../../src/core/up.js';
import { ReadOnlyViolationError } from '../../src/safety/readOnlyGuard.js';
import { readSnapshot, serializeSnapshot, writeSnapshot } from '../../src/snapshot/io.js';
import {
  credentialsFor,
  PROD_ACCOUNT,
  rawS3,
  REGION,
  startFloci,
  TWIN_ACCOUNT,
  type Floci,
} from '../helpers/floci.js';

const salt = Buffer.alloc(32, 7);

describe('S3: scan prod → up into twin → scan twin', () => {
  let floci: Floci;
  let dir: string;
  let prod: ScanOutput;

  const scanAccount = async (accountId: string) => {
    const session = createSourceSession({
      region: REGION,
      endpoint: floci.endpoint,
      credentials: credentialsFor(accountId),
    });
    try {
      return await scan({ session, services: ['s3'], salt });
    } finally {
      session.destroy();
    }
  };

  beforeAll(async () => {
    floci = await startFloci();
    dir = await mkdtemp(join(tmpdir(), 'cloudfork-it-'));
    await seedChaiCartS3(rawS3(floci.endpoint, PROD_ACCOUNT), PROD_ACCOUNT);
    prod = await scanAccount(PROD_ACCOUNT);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await floci?.stop();
  });

  it('captures every seeded bucket and setting', () => {
    expect(prod.results.map((r) => [r.name, r.status])).toEqual([
      ['chaicart-exports', 'captured'],
      ['chaicart-photos', 'captured'],
    ]);
    const photos = prod.snapshot.resources.s3?.buckets.find((b) => b.name === 'chaicart-photos');
    expect(photos).toMatchObject({
      versioning: 'Enabled',
      tags: { app: 'chaicart', env: 'prod', owner: 'platform-{{cloudfork:account}}' },
    });
    expect(photos?.cors).toHaveLength(2);
    expect(photos?.lifecycle?.map((r) => r.ID)).toEqual(['expire-old-versions', 'tmp-uploads']);
    expect(photos?.policy).toBeDefined();
  });

  it('never writes the raw account ID into the snapshot', () => {
    expect(serializeSnapshot(prod.snapshot)).not.toContain(PROD_ACCOUNT);
  });

  it('recreates the snapshot in the twin and the twin scans back identical', async () => {
    // Through disk, as the CLI does.
    const file = join(dir, 'cloudfork.json');
    await writeSnapshot(file, prod.snapshot);
    const snapshot = await readSnapshot(file);

    const twinBefore = await rawS3(floci.endpoint, TWIN_ACCOUNT).send(new ListBucketsCommand({}));
    expect(twinBefore.Buckets ?? []).toEqual([]);

    const session = createTargetSession({
      endpoint: floci.endpoint,
      accountId: TWIN_ACCOUNT,
      region: REGION,
    });
    const results = await up({ snapshot, session });
    session.destroy();
    expect(results.map((r) => [r.name, r.status, r.reasons])).toEqual([
      ['chaicart-exports', 'recreated', []],
      ['chaicart-photos', 'recreated', []],
    ]);

    const twin = await scanAccount(TWIN_ACCOUNT);
    expect(twin.snapshot.resources).toEqual(prod.snapshot.resources);
    expect(twin.snapshot.sourceAccountId).not.toBe(prod.snapshot.sourceAccountId);
  });

  it('rewrites account IDs into the twin account', async () => {
    const { GetBucketPolicyCommand, GetBucketTaggingCommand } = await import('@aws-sdk/client-s3');
    const twinS3 = rawS3(floci.endpoint, TWIN_ACCOUNT);
    const policy = await twinS3.send(new GetBucketPolicyCommand({ Bucket: 'chaicart-photos' }));
    expect(policy.Policy).toContain(`arn:aws:iam::${TWIN_ACCOUNT}:root`);
    expect(policy.Policy).not.toContain(PROD_ACCOUNT);
    const tags = await twinS3.send(new GetBucketTaggingCommand({ Bucket: 'chaicart-photos' }));
    expect(tags.TagSet).toContainEqual({ Key: 'owner', Value: `platform-${TWIN_ACCOUNT}` });
  });

  it('is idempotent: running up again changes nothing', async () => {
    const session = createTargetSession({
      endpoint: floci.endpoint,
      accountId: TWIN_ACCOUNT,
      region: REGION,
    });
    const results = await up({ snapshot: prod.snapshot, session });
    session.destroy();
    expect(results.every((r) => r.status === 'recreated')).toBe(true);
    expect((await scanAccount(TWIN_ACCOUNT)).snapshot.resources).toEqual(prod.snapshot.resources);
  });

  it('the source session cannot write to the account it scans', async () => {
    const session = createSourceSession({
      region: REGION,
      endpoint: floci.endpoint,
      credentials: credentialsFor(PROD_ACCOUNT),
    });
    await expect(
      session.s3().send(new CreateBucketCommand({ Bucket: 'should-not-exist' })),
    ).rejects.toBeInstanceOf(ReadOnlyViolationError);
    await expect(
      session.s3().send(new PutObjectCommand({ Bucket: 'chaicart-photos', Key: 'x.txt', Body: 'x' })),
    ).rejects.toBeInstanceOf(ReadOnlyViolationError);
    session.destroy();

    const buckets = await rawS3(floci.endpoint, PROD_ACCOUNT).send(new ListBucketsCommand({}));
    expect(buckets.Buckets?.map((b) => b.Name)).not.toContain('should-not-exist');
  });

  it('`cloudfork up` works end to end from the CLI', async () => {
    const file = join(dir, 'cli.json');
    await writeSnapshot(file, prod.snapshot);
    const cliTwin = '333333333333';
    const { stderr } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'up',
        '--snapshot',
        file,
        '--endpoint',
        floci.endpoint,
        '--account',
        cliTwin,
      ],
      { env: { ...process.env, FORCE_COLOR: '0' } },
    );
    expect(stderr).toContain('2 recreated');
    expect(stderr).not.toContain(PROD_ACCOUNT);
    expect((await scanAccount(cliTwin)).snapshot.resources).toEqual(prod.snapshot.resources);
  });

  it('`cloudfork up` refuses a real AWS endpoint', async () => {
    const file = join(dir, 'cli.json');
    await writeSnapshot(file, prod.snapshot);
    const run = promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'up', '--snapshot', file, '--endpoint', 'https://s3.amazonaws.com'],
      { env: { ...process.env, FORCE_COLOR: '0' } },
    );
    await expect(run).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('real AWS endpoint'),
    });
  });
});
