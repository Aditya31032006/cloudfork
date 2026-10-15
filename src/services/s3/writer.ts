import {
  BucketLocationConstraint,
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  type Event,
  type LifecycleRule as SdkLifecycleRule,
  type S3Client,
} from '@aws-sdk/client-s3';
import { parseArn } from '../../core/arn.js';
import { errorCode, result, writeFailure, type ResourceRef, type UpResult } from '../../core/result.js';
import type { S3Bucket } from '../../snapshot/schema.js';
import { taskId, type WriteContext, type WriteTask } from '../types.js';

type Lifecycle = NonNullable<S3Bucket['lifecycle']>[number];

function date(value: string | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

export function toSdkLifecycleRule(rule: Lifecycle): SdkLifecycleRule {
  return {
    ...rule,
    // AWS requires a Filter (or the deprecated Prefix); an empty prefix means the whole bucket.
    Filter: rule.Filter ?? { Prefix: '' },
    Expiration: rule.Expiration && { ...rule.Expiration, Date: date(rule.Expiration.Date) },
    Transitions: rule.Transitions?.map((t) => ({
      ...t,
      Date: date(t.Date),
      StorageClass: t.StorageClass as NonNullable<SdkLifecycleRule['Transitions']>[number]['StorageClass'],
    })),
    NoncurrentVersionTransitions: rule.NoncurrentVersionTransitions?.map((t) => ({
      ...t,
      StorageClass: t.StorageClass as NonNullable<
        SdkLifecycleRule['NoncurrentVersionTransitions']
      >[number]['StorageClass'],
    })),
  };
}

async function createBucket(s3: S3Client, name: string, region: string): Promise<void> {
  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: name,
        ...(region === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }),
      }),
    );
  } catch (err) {
    // Re-running `up` against an existing twin is fine.
    if (errorCode(err) !== 'BucketAlreadyOwnedByYou') throw err;
  }
}

export async function writeBucket(s3: S3Client, bucket: S3Bucket, region: string): Promise<UpResult> {
  const ref: ResourceRef = { service: 's3', type: 'bucket', name: bucket.name };
  try {
    await createBucket(s3, bucket.name, region);
  } catch (err) {
    return result(ref, 'skipped', [writeFailure('CreateBucket', err)]);
  }

  const Bucket = bucket.name;
  const steps: [string, (() => Promise<unknown>) | undefined][] = [
    [
      'versioning',
      bucket.versioning &&
        (() =>
          s3.send(
            new PutBucketVersioningCommand({
              Bucket,
              VersioningConfiguration: { Status: bucket.versioning },
            }),
          )),
    ],
    [
      'policy',
      bucket.policy &&
        (() => s3.send(new PutBucketPolicyCommand({ Bucket, Policy: JSON.stringify(bucket.policy) }))),
    ],
    [
      'cors',
      bucket.cors &&
        (() => s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: bucket.cors } }))),
    ],
    [
      'tags',
      bucket.tags &&
        (() =>
          s3.send(
            new PutBucketTaggingCommand({
              Bucket,
              Tagging: { TagSet: Object.entries(bucket.tags ?? {}).map(([Key, Value]) => ({ Key, Value })) },
            }),
          )),
    ],
    [
      'lifecycle',
      bucket.lifecycle &&
        (() =>
          s3.send(
            new PutBucketLifecycleConfigurationCommand({
              Bucket,
              LifecycleConfiguration: { Rules: (bucket.lifecycle ?? []).map(toSdkLifecycleRule) },
            }),
          )),
    ],
  ];

  const reasons: string[] = (bucket.unreadable ?? []).map(
    (u) => `${u.field}: not copied, could not be read from the source (${u.reason})`,
  );
  for (const [field, step] of steps) {
    if (!step) continue;
    try {
      await step();
    } catch (err) {
      reasons.push(writeFailure(field, err));
    }
  }
  return result(ref, reasons.length ? 'partial' : 'recreated', reasons);
}

/** SQS task ID for a queue ARN in the twin account, if the ARN points at one. */
function queueTaskId(queueArn: string, twinAccount: string): string | undefined {
  const arn = parseArn(queueArn);
  if (!arn || arn.service !== 'sqs' || arn.account !== twinAccount) return undefined;
  return taskId('sqs', 'queue', arn.resource);
}

export async function writeNotifications(
  s3: S3Client,
  bucket: S3Bucket,
  twinAccount: string,
  done: ReadonlyMap<string, UpResult>,
): Promise<UpResult> {
  const ref: ResourceRef = { service: 's3', type: 'bucket-notifications', name: bucket.name };
  const n = bucket.notifications;
  if (!n) return result(ref, 'recreated');

  const bucketResult = done.get(taskId('s3', 'bucket', bucket.name));
  if (!bucketResult || bucketResult.status === 'skipped') {
    return result(ref, 'skipped', ['bucket was not recreated']);
  }

  const reasons: string[] = [];
  const queues = n.queues.filter((q) => {
    const id = queueTaskId(q.QueueArn, twinAccount);
    const queueName = parseArn(q.QueueArn)?.resource ?? 'unknown queue';
    if (!id) {
      reasons.push(`queue notification to ${queueName}: queue belongs to another account`);
      return false;
    }
    const queueResult = done.get(id);
    if (!queueResult || queueResult.status === 'skipped') {
      reasons.push(`queue notification to ${queueName}: queue was not recreated in the twin`);
      return false;
    }
    return true;
  });
  for (const t of n.topics) {
    reasons.push(
      `topic notification to ${parseArn(t.TopicArn)?.resource ?? 'unknown topic'}: SNS not supported yet`,
    );
  }
  for (const l of n.lambdas) {
    const fn = parseArn(l.LambdaFunctionArn)?.resource.replace(/^function:/, '') ?? 'unknown function';
    reasons.push(`lambda notification to ${fn}: Lambda not supported yet`);
  }

  if (queues.length === 0 && !n.eventBridge) return result(ref, 'skipped', reasons);

  try {
    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket.name,
        NotificationConfiguration: {
          QueueConfigurations: queues.length
            ? queues.map((q) => ({ ...q, Events: q.Events as Event[] }))
            : undefined,
          EventBridgeConfiguration: n.eventBridge ? {} : undefined,
        },
      }),
    );
  } catch (err) {
    return result(ref, 'skipped', [...reasons, writeFailure('notifications', err)]);
  }
  return result(ref, reasons.length ? 'partial' : 'recreated', reasons);
}

export function planS3(resources: { buckets: S3Bucket[] }, ctx: WriteContext): WriteTask[] {
  const s3 = ctx.session.s3();
  const buckets = resources.buckets.map((bucket): WriteTask => ({
    id: taskId('s3', 'bucket', bucket.name),
    ref: { service: 's3', type: 'bucket', name: bucket.name },
    dependsOn: [],
    run: () => writeBucket(s3, bucket, ctx.target.region),
  }));
  // Notifications go last: they point at queues that must exist first.
  const notifications = resources.buckets
    .filter((bucket) => bucket.notifications)
    .map((bucket): WriteTask => ({
      id: taskId('s3', 'bucket-notifications', bucket.name),
      ref: { service: 's3', type: 'bucket-notifications', name: bucket.name },
      dependsOn: [
        taskId('s3', 'bucket', bucket.name),
        ...(bucket.notifications?.queues ?? []).flatMap((q) => {
          const id = queueTaskId(q.QueueArn, ctx.target.accountId);
          return id ? [id] : [];
        }),
      ],
      run: (done) => writeNotifications(s3, bucket, ctx.target.accountId, done),
    }));
  return [...buckets, ...notifications];
}
