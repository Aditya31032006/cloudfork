import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import type { SourceSession } from '../../src/aws/clients.js';
import { normalizeLocation, readS3 } from '../../src/services/s3/reader.js';
import type { ReadContext } from '../../src/services/types.js';
import { silentLogger } from '../../src/util/logger.js';
import { awsError, fakeS3 } from '../helpers/fakeS3.js';

function context(client: S3Client, region = 'us-east-1'): ReadContext {
  return {
    session: { region, s3: () => client } as unknown as SourceSession,
    region,
    logger: silentLogger,
    capture(schema, raw) {
      const parsed = schema.safeParse(raw);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: parsed.error.message };
    },
  };
}

/** Handlers for a bucket with no optional configuration, as real S3 answers. */
const bareBucket = {
  ListBuckets: () => ({ Buckets: [{ Name: 'chaicart-photos' }] }),
  GetBucketLocation: () => ({ LocationConstraint: undefined }),
  GetBucketVersioning: () => ({}),
  GetBucketPolicy: () => {
    throw awsError('NoSuchBucketPolicy');
  },
  GetBucketCors: () => {
    throw awsError('NoSuchCORSConfiguration');
  },
  GetBucketTagging: () => {
    throw awsError('NoSuchTagSet');
  },
  GetBucketLifecycleConfiguration: () => {
    throw awsError('NoSuchLifecycleConfiguration');
  },
  GetBucketNotificationConfiguration: () => ({}),
};

describe('readS3', () => {
  it('captures a bucket without optional config as just its name', async () => {
    const { client } = fakeS3(bareBucket);
    const out = await readS3(context(client));
    expect(out.resources.buckets).toEqual([{ name: 'chaicart-photos' }]);
    expect(out.results).toEqual([
      { service: 's3', type: 'bucket', name: 'chaicart-photos', status: 'captured', reasons: [] },
    ]);
  });

  it('maps every supported setting into snapshot form', async () => {
    const policy = { Version: '2012-10-17', Statement: [] };
    const { client } = fakeS3({
      ...bareBucket,
      GetBucketVersioning: () => ({ Status: 'Enabled' }),
      GetBucketPolicy: () => ({ Policy: JSON.stringify(policy) }),
      GetBucketCors: () => ({
        CORSRules: [
          { AllowedMethods: ['GET'], AllowedOrigins: ['*'], AllowedHeaders: [], MaxAgeSeconds: 300 },
        ],
      }),
      GetBucketTagging: () => ({ TagSet: [{ Key: 'team', Value: 'growth' }] }),
      GetBucketLifecycleConfiguration: () => ({
        Rules: [
          { ID: 'legacy', Status: 'Enabled', Prefix: 'tmp/', Expiration: { Days: 1 } },
          {
            ID: 'whole-bucket',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          },
          {
            ID: 'archive',
            Status: 'Disabled',
            Filter: { And: { Prefix: 'old/', Tags: [{ Key: 'archive', Value: 'yes' }] } },
            Transitions: [{ Date: new Date('2027-01-01T00:00:00Z'), StorageClass: 'GLACIER' }],
          },
        ],
      }),
      GetBucketNotificationConfiguration: () => ({
        QueueConfigurations: [
          {
            Id: 'new-photo',
            QueueArn: 'arn:aws:sqs:us-east-1:111111111111:kitchen-orders',
            Events: ['s3:ObjectCreated:*'],
            Filter: { Key: { FilterRules: [{ Name: 'Suffix', Value: '.jpg' }] } },
          },
        ],
        EventBridgeConfiguration: {},
      }),
    });

    const [b] = (await readS3(context(client))).resources.buckets;
    expect(b).toEqual({
      name: 'chaicart-photos',
      versioning: 'Enabled',
      policy,
      cors: [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'], MaxAgeSeconds: 300 }],
      tags: { team: 'growth' },
      lifecycle: [
        { ID: 'legacy', Status: 'Enabled', Filter: { Prefix: 'tmp/' }, Expiration: { Days: 1 } },
        { ID: 'whole-bucket', Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } },
        {
          ID: 'archive',
          Status: 'Disabled',
          Filter: { And: { Prefix: 'old/', Tags: [{ Key: 'archive', Value: 'yes' }] } },
          Transitions: [{ Date: '2027-01-01T00:00:00.000Z', StorageClass: 'GLACIER' }],
        },
      ],
      notifications: {
        queues: [
          {
            Id: 'new-photo',
            QueueArn: 'arn:aws:sqs:us-east-1:111111111111:kitchen-orders',
            Events: ['s3:ObjectCreated:*'],
            Filter: { Key: { FilterRules: [{ Name: 'suffix', Value: '.jpg' }] } },
          },
        ],
        topics: [],
        lambdas: [],
        eventBridge: true,
      },
    });
  });

  it('marks a bucket partial when a setting cannot be read, without logging the message', async () => {
    const { client } = fakeS3({
      ...bareBucket,
      GetBucketPolicy: () => {
        throw awsError('AccessDenied');
      },
    });
    const out = await readS3(context(client));
    expect(out.resources.buckets[0]?.unreadable).toEqual([{ field: 'policy', reason: 'AccessDenied' }]);
    expect(out.results[0]).toMatchObject({
      status: 'partial',
      reasons: ['policy could not be read (AccessDenied)'],
    });
    expect(JSON.stringify(out)).not.toContain('must never be logged');
  });

  it('skips buckets outside the scan region with a reason', async () => {
    const { client, ops } = fakeS3({
      ...bareBucket,
      GetBucketLocation: () => ({ LocationConstraint: 'eu-west-1' }),
    });
    const out = await readS3(context(client));
    expect(out.resources.buckets).toEqual([]);
    expect(out.results[0]).toMatchObject({
      status: 'skipped',
      reasons: ['bucket is in eu-west-1; this scan covers us-east-1'],
    });
    expect(ops()).not.toContain('GetBucketPolicy');
  });

  it('falls back to the ListBuckets region when GetBucketLocation is denied', async () => {
    const { client } = fakeS3({
      ...bareBucket,
      ListBuckets: () => ({ Buckets: [{ Name: 'chaicart-photos', BucketRegion: 'us-east-1' }] }),
      GetBucketLocation: () => {
        throw awsError('AccessDenied');
      },
    });
    expect((await readS3(context(client))).results[0]?.status).toBe('captured');
  });

  it('skips a bucket whose region cannot be determined', async () => {
    const { client } = fakeS3({
      ...bareBucket,
      GetBucketLocation: () => {
        throw awsError('AccessDenied');
      },
    });
    expect((await readS3(context(client))).results[0]).toMatchObject({
      status: 'skipped',
      reasons: ['could not determine bucket region (AccessDenied)'],
    });
  });

  it('follows ListBuckets pagination', async () => {
    const { client } = fakeS3({
      ...bareBucket,
      ListBuckets: (input: { ContinuationToken?: string }) =>
        input.ContinuationToken
          ? { Buckets: [{ Name: 'second-bucket' }] }
          : { Buckets: [{ Name: 'first-bucket' }], ContinuationToken: 'next' },
    });
    const out = await readS3(context(client));
    expect(out.resources.buckets.map((b) => b.name)).toEqual(['first-bucket', 'second-bucket']);
  });
});

describe('normalizeLocation', () => {
  it.each([
    [undefined, 'us-east-1'],
    ['', 'us-east-1'],
    ['EU', 'eu-west-1'],
    ['ap-south-1', 'ap-south-1'],
  ])('%j → %s', (input, expected) => expect(normalizeLocation(input)).toBe(expected));
});
