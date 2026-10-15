import { describe, expect, it } from 'vitest';
import type { TargetSession } from '../../src/aws/clients.js';
import { result, type UpResult } from '../../src/core/result.js';
import { planS3, writeBucket, writeNotifications } from '../../src/services/s3/writer.js';
import type { S3Bucket } from '../../src/snapshot/schema.js';
import { silentLogger } from '../../src/util/logger.js';
import { awsError, fakeS3 } from '../helpers/fakeS3.js';
import { bucket } from '../helpers/fixtures.js';

const ok = () => ({});
const allOk = {
  CreateBucket: ok,
  PutBucketVersioning: ok,
  PutBucketPolicy: ok,
  PutBucketCors: ok,
  PutBucketTagging: ok,
  PutBucketLifecycleConfiguration: ok,
  PutBucketNotificationConfiguration: ok,
};

const fullBucket: S3Bucket = bucket({
  versioning: 'Enabled',
  policy: { Version: '2012-10-17', Statement: [] },
  cors: [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'] }],
  tags: { team: 'growth' },
  lifecycle: [{ ID: 'tmp', Status: 'Enabled', Expiration: { Date: '2027-01-01T00:00:00.000Z' } }],
});

describe('writeBucket', () => {
  it('creates the bucket and applies every setting', async () => {
    const { client, calls, ops } = fakeS3(allOk);
    const out = await writeBucket(client, fullBucket, 'us-east-1');
    expect(out).toEqual(result({ service: 's3', type: 'bucket', name: 'chaicart-photos' }, 'recreated'));
    expect(ops()).toEqual([
      'CreateBucket',
      'PutBucketVersioning',
      'PutBucketPolicy',
      'PutBucketCors',
      'PutBucketTagging',
      'PutBucketLifecycleConfiguration',
    ]);
    expect(calls[0]?.input).toEqual({ Bucket: 'chaicart-photos' }); // us-east-1: no LocationConstraint
    expect(calls[4]?.input.Tagging.TagSet).toEqual([{ Key: 'team', Value: 'growth' }]);
    const rule = calls[5]?.input.LifecycleConfiguration.Rules[0];
    expect(rule.Filter).toEqual({ Prefix: '' }); // AWS requires a filter
    expect(rule.Expiration.Date).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });

  it('only calls Put for settings the bucket has', async () => {
    const { client, ops } = fakeS3(allOk);
    await writeBucket(client, bucket(), 'us-east-1');
    expect(ops()).toEqual(['CreateBucket']);
  });

  it('sets the location constraint outside us-east-1', async () => {
    const { client, calls } = fakeS3(allOk);
    await writeBucket(client, bucket(), 'ap-south-1');
    expect(calls[0]?.input.CreateBucketConfiguration).toEqual({ LocationConstraint: 'ap-south-1' });
  });

  it('reports partial with a reason when the emulator does not support a setting, and keeps going', async () => {
    const { client, ops } = fakeS3({
      ...allOk,
      PutBucketCors: () => {
        throw awsError('NotImplemented');
      },
    });
    const out = await writeBucket(client, fullBucket, 'us-east-1');
    expect(out.status).toBe('partial');
    expect(out.reasons).toEqual(['cors: not supported by the emulator (NotImplemented)']);
    expect(ops()).toContain('PutBucketLifecycleConfiguration');
  });

  it('skips the bucket if it cannot be created', async () => {
    const { client, ops } = fakeS3({
      ...allOk,
      CreateBucket: () => {
        throw awsError('InvalidBucketName');
      },
    });
    const out = await writeBucket(client, fullBucket, 'us-east-1');
    expect(out).toMatchObject({ status: 'skipped', reasons: ['CreateBucket: failed (InvalidBucketName)'] });
    expect(ops()).toEqual(['CreateBucket']);
  });

  it('is idempotent when the bucket already exists in the twin', async () => {
    const { client } = fakeS3({
      ...allOk,
      CreateBucket: () => {
        throw awsError('BucketAlreadyOwnedByYou');
      },
    });
    expect((await writeBucket(client, fullBucket, 'us-east-1')).status).toBe('recreated');
  });

  it('reports settings that could not be read from the source', async () => {
    const { client } = fakeS3(allOk);
    const out = await writeBucket(
      client,
      bucket({ unreadable: [{ field: 'policy', reason: 'AccessDenied' }] }),
      'us-east-1',
    );
    expect(out).toMatchObject({
      status: 'partial',
      reasons: ['policy: not copied, could not be read from the source (AccessDenied)'],
    });
  });
});

describe('writeNotifications', () => {
  const twin = '222222222222';
  const queueArn = `arn:aws:sqs:us-east-1:${twin}:kitchen-orders`;
  const withNotifications = (n: Partial<NonNullable<S3Bucket['notifications']>>) =>
    bucket({ notifications: { queues: [], topics: [], lambdas: [], eventBridge: false, ...n } });
  const queueNotification = { Id: 'new-photo', QueueArn: queueArn, Events: ['s3:ObjectCreated:*'] };
  const bucketDone = (status: UpResult['status'] = 'recreated'): [string, UpResult] => [
    's3:bucket:chaicart-photos',
    result({ service: 's3', type: 'bucket', name: 'chaicart-photos' }, status),
  ];
  const queueDone: [string, UpResult] = [
    'sqs:queue:kitchen-orders',
    result({ service: 'sqs', type: 'queue', name: 'kitchen-orders' }, 'recreated'),
  ];

  it('skips queue notifications whose queue was not recreated', async () => {
    const { client, ops } = fakeS3(allOk);
    const out = await writeNotifications(
      client,
      withNotifications({ queues: [queueNotification] }),
      twin,
      new Map([bucketDone()]),
    );
    expect(out).toMatchObject({
      status: 'skipped',
      reasons: ['queue notification to kitchen-orders: queue was not recreated in the twin'],
    });
    expect(ops()).toEqual([]);
  });

  it('writes queue notifications once the queue exists', async () => {
    const { client, calls } = fakeS3(allOk);
    const out = await writeNotifications(
      client,
      withNotifications({ queues: [queueNotification] }),
      twin,
      new Map([bucketDone(), queueDone]),
    );
    expect(out.status).toBe('recreated');
    expect(calls[0]?.input.NotificationConfiguration.QueueConfigurations).toEqual([queueNotification]);
  });

  it('reports SNS and Lambda targets as not supported, but still writes the rest', async () => {
    const { client, calls } = fakeS3(allOk);
    const out = await writeNotifications(
      client,
      withNotifications({
        eventBridge: true,
        topics: [{ TopicArn: `arn:aws:sns:us-east-1:${twin}:alerts`, Events: ['s3:ObjectRemoved:*'] }],
        lambdas: [
          {
            LambdaFunctionArn: `arn:aws:lambda:us-east-1:${twin}:function:resize`,
            Events: ['s3:ObjectCreated:*'],
          },
        ],
      }),
      twin,
      new Map([bucketDone()]),
    );
    expect(out).toMatchObject({
      status: 'partial',
      reasons: [
        'topic notification to alerts: SNS not supported yet',
        'lambda notification to resize: Lambda not supported yet',
      ],
    });
    expect(calls[0]?.input.NotificationConfiguration).toEqual({ EventBridgeConfiguration: {} });
  });

  it('skips cross-account queue targets', async () => {
    const { client } = fakeS3(allOk);
    const out = await writeNotifications(
      client,
      withNotifications({
        queues: [{ ...queueNotification, QueueArn: 'arn:aws:sqs:us-east-1:999999999999:partner' }],
      }),
      twin,
      new Map([bucketDone()]),
    );
    expect(out.reasons).toEqual(['queue notification to partner: queue belongs to another account']);
  });

  it('skips notifications for a bucket that was not recreated', async () => {
    const { client } = fakeS3(allOk);
    const out = await writeNotifications(
      client,
      withNotifications({ eventBridge: true }),
      twin,
      new Map([bucketDone('skipped')]),
    );
    expect(out).toMatchObject({ status: 'skipped', reasons: ['bucket was not recreated'] });
  });
});

describe('planS3', () => {
  it('orders buckets before notifications, and notifications depend on their queues', () => {
    const { client } = fakeS3(allOk);
    const ctx = {
      session: { s3: () => client } as unknown as TargetSession,
      target: { accountId: '222222222222', region: 'us-east-1', partition: 'aws' },
      logger: silentLogger,
    };
    const tasks = planS3(
      {
        buckets: [
          bucket({
            notifications: {
              queues: [
                {
                  QueueArn: 'arn:aws:sqs:us-east-1:222222222222:kitchen-orders',
                  Events: ['s3:ObjectCreated:*'],
                },
              ],
              topics: [],
              lambdas: [],
              eventBridge: false,
            },
          }),
          bucket({ name: 'chaicart-exports' }),
        ],
      },
      ctx,
    );
    expect(tasks.map((t) => t.id)).toEqual([
      's3:bucket:chaicart-photos',
      's3:bucket:chaicart-exports',
      's3:bucket-notifications:chaicart-photos',
    ]);
    expect(tasks[2]?.dependsOn).toEqual(['s3:bucket:chaicart-photos', 'sqs:queue:kitchen-orders']);
  });
});
