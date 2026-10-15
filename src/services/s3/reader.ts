import {
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  ListBucketsCommand,
  type Bucket,
  type CORSRule,
  type FilterRule,
  type LifecycleRule as SdkLifecycleRule,
  type LifecycleRuleFilter,
  type NotificationConfigurationFilter,
  type S3Client,
} from '@aws-sdk/client-s3';
import { errorCode, result, type ScanResult } from '../../core/result.js';
import { S3BucketSchema, type S3Bucket } from '../../snapshot/schema.js';
import { mapLimit } from '../../util/concurrency.js';
import type { ReadContext, ReadOutput } from '../types.js';

const BUCKET_CONCURRENCY = 8;

/** "This setting is not configured" — the bucket simply doesn't have it. */
const NOT_CONFIGURED = new Set([
  'NoSuchBucketPolicy',
  'NoSuchCORSConfiguration',
  'NoSuchTagSet',
  'NoSuchTagSetError',
  'NoSuchLifecycleConfiguration',
]);

type Field<T> = { value: T | undefined } | { error: string };

async function readField<T>(fn: () => Promise<T | undefined>): Promise<Field<T>> {
  try {
    return { value: await fn() };
  } catch (err) {
    const code = errorCode(err);
    if (NOT_CONFIGURED.has(code)) return { value: undefined };
    return { error: code };
  }
}

/** GetBucketLocation returns "" (or nothing) for us-east-1 and "EU" for the oldest eu-west-1 buckets. */
export function normalizeLocation(constraint: string | undefined | null): string {
  if (!constraint) return 'us-east-1';
  return constraint === 'EU' ? 'eu-west-1' : constraint;
}

function iso(date: Date | undefined): string | undefined {
  return date ? date.toISOString() : undefined;
}

function nonEmpty<T>(items: T[] | undefined): T[] | undefined {
  return items && items.length > 0 ? items : undefined;
}

export function toCorsRule(rule: CORSRule): NonNullable<S3Bucket['cors']>[number] {
  return {
    ID: rule.ID,
    AllowedMethods: (rule.AllowedMethods ?? []) as ('GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD')[],
    AllowedOrigins: rule.AllowedOrigins ?? [],
    AllowedHeaders: nonEmpty(rule.AllowedHeaders),
    ExposeHeaders: nonEmpty(rule.ExposeHeaders),
    MaxAgeSeconds: rule.MaxAgeSeconds,
  };
}

type Lifecycle = NonNullable<S3Bucket['lifecycle']>[number];

/** An empty filter, `{}` and `{ Prefix: "" }` all mean "whole bucket"; all three read back as absent. */
function toLifecycleFilter(filter: LifecycleRuleFilter | undefined): Lifecycle['Filter'] {
  if (!filter) return undefined;
  const out: NonNullable<Lifecycle['Filter']> = {
    Prefix: filter.Prefix || undefined,
    Tag: filter.Tag ? { Key: filter.Tag.Key ?? '', Value: filter.Tag.Value ?? '' } : undefined,
    ObjectSizeGreaterThan: filter.ObjectSizeGreaterThan,
    ObjectSizeLessThan: filter.ObjectSizeLessThan,
    And: filter.And
      ? {
          Prefix: filter.And.Prefix || undefined,
          Tags: nonEmpty(filter.And.Tags?.map((t) => ({ Key: t.Key ?? '', Value: t.Value ?? '' }))),
          ObjectSizeGreaterThan: filter.And.ObjectSizeGreaterThan,
          ObjectSizeLessThan: filter.And.ObjectSizeLessThan,
        }
      : undefined,
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

export function toLifecycleRule(rule: SdkLifecycleRule): Lifecycle {
  // The deprecated rule-level Prefix is equivalent to Filter.Prefix.
  const filter = rule.Filter ?? (rule.Prefix !== undefined ? { Prefix: rule.Prefix } : undefined);
  return {
    ID: rule.ID,
    Status: rule.Status as Lifecycle['Status'],
    Filter: toLifecycleFilter(filter),
    Expiration: rule.Expiration
      ? {
          Days: rule.Expiration.Days,
          Date: iso(rule.Expiration.Date),
          ExpiredObjectDeleteMarker: rule.Expiration.ExpiredObjectDeleteMarker,
        }
      : undefined,
    Transitions: nonEmpty(
      rule.Transitions?.map((t) => ({ Days: t.Days, Date: iso(t.Date), StorageClass: t.StorageClass ?? '' })),
    ),
    NoncurrentVersionExpiration: rule.NoncurrentVersionExpiration
      ? {
          NoncurrentDays: rule.NoncurrentVersionExpiration.NoncurrentDays,
          NewerNoncurrentVersions: rule.NoncurrentVersionExpiration.NewerNoncurrentVersions,
        }
      : undefined,
    NoncurrentVersionTransitions: nonEmpty(
      rule.NoncurrentVersionTransitions?.map((t) => ({
        NoncurrentDays: t.NoncurrentDays,
        NewerNoncurrentVersions: t.NewerNoncurrentVersions,
        StorageClass: t.StorageClass ?? '',
      })),
    ),
    AbortIncompleteMultipartUpload: rule.AbortIncompleteMultipartUpload
      ? { DaysAfterInitiation: rule.AbortIncompleteMultipartUpload.DaysAfterInitiation ?? 0 }
      : undefined,
  };
}

/** AWS returns filter rule names as "Prefix"/"Suffix" but accepts lowercase; store lowercase. */
function toKeyFilter(filter: NotificationConfigurationFilter | undefined) {
  const rules = filter?.Key?.FilterRules ?? [];
  if (rules.length === 0) return undefined;
  return {
    Key: {
      FilterRules: rules.map((r: FilterRule) => ({
        Name: (r.Name ?? '').toLowerCase() as 'prefix' | 'suffix',
        Value: r.Value ?? '',
      })),
    },
  };
}

async function readNotifications(s3: S3Client, bucket: string): Promise<S3Bucket['notifications']> {
  const n = await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: bucket }));
  const notifications = {
    queues: (n.QueueConfigurations ?? []).map((q) => ({
      Id: q.Id,
      QueueArn: q.QueueArn ?? '',
      Events: q.Events ?? [],
      Filter: toKeyFilter(q.Filter),
    })),
    topics: (n.TopicConfigurations ?? []).map((t) => ({
      Id: t.Id,
      TopicArn: t.TopicArn ?? '',
      Events: t.Events ?? [],
      Filter: toKeyFilter(t.Filter),
    })),
    lambdas: (n.LambdaFunctionConfigurations ?? []).map((l) => ({
      Id: l.Id,
      LambdaFunctionArn: l.LambdaFunctionArn ?? '',
      Events: l.Events ?? [],
      Filter: toKeyFilter(l.Filter),
    })),
    eventBridge: n.EventBridgeConfiguration !== undefined,
  };
  const empty =
    !notifications.eventBridge &&
    notifications.queues.length + notifications.topics.length + notifications.lambdas.length === 0;
  return empty ? undefined : notifications;
}

/** Reads every setting of one bucket. A setting that fails is recorded, not fatal. */
export async function readBucketConfig(s3: S3Client, name: string): Promise<unknown> {
  const Bucket = name;
  const [versioning, policy, cors, tags, lifecycle, notifications] = await Promise.all([
    readField(async () => (await s3.send(new GetBucketVersioningCommand({ Bucket }))).Status),
    readField(async () => {
      const raw = (await s3.send(new GetBucketPolicyCommand({ Bucket }))).Policy;
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    }),
    readField(async () =>
      nonEmpty((await s3.send(new GetBucketCorsCommand({ Bucket }))).CORSRules)?.map(toCorsRule),
    ),
    readField(async () => {
      const tagSet = (await s3.send(new GetBucketTaggingCommand({ Bucket }))).TagSet ?? [];
      return tagSet.length ? Object.fromEntries(tagSet.map((t) => [t.Key ?? '', t.Value ?? ''])) : undefined;
    }),
    readField(async () =>
      nonEmpty((await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }))).Rules)?.map(
        toLifecycleRule,
      ),
    ),
    readField(() => readNotifications(s3, Bucket)),
  ]);

  const fields = { versioning, policy, cors, tags, lifecycle, notifications };
  const config: Record<string, unknown> = { name };
  const unreadable: { field: string; reason: string }[] = [];
  for (const [field, outcome] of Object.entries(fields)) {
    if ('error' in outcome) unreadable.push({ field, reason: outcome.error });
    else if (outcome.value !== undefined) config[field] = outcome.value;
  }
  if (unreadable.length) config.unreadable = unreadable;
  return config;
}

async function bucketRegion(s3: S3Client, bucket: Bucket): Promise<{ region: string } | { error: string }> {
  try {
    const out = await s3.send(new GetBucketLocationCommand({ Bucket: bucket.Name }));
    return { region: normalizeLocation(out.LocationConstraint) };
  } catch (err) {
    // ListBuckets also reports the region on newer APIs; use it if GetBucketLocation is denied.
    if (bucket.BucketRegion) return { region: bucket.BucketRegion };
    return { error: errorCode(err) };
  }
}

async function listBuckets(s3: S3Client): Promise<Bucket[]> {
  const buckets: Bucket[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListBucketsCommand({ ContinuationToken: token }));
    buckets.push(...(page.Buckets ?? []));
    token = page.ContinuationToken;
  } while (token);
  return buckets;
}

export async function readS3(ctx: ReadContext): Promise<ReadOutput<{ buckets: S3Bucket[] }>> {
  const s3 = ctx.session.s3();
  const listed = (await listBuckets(s3)).filter((b) => b.Name);

  const outcomes = await mapLimit(listed, BUCKET_CONCURRENCY, async (bucket) => {
    const name = bucket.Name as string;
    const ref = { service: 's3' as const, type: 'bucket', name };
    ctx.logger.debug(`s3: reading bucket ${name}`);

    const location = await bucketRegion(s3, bucket);
    if ('error' in location) {
      return { result: result(ref, 'skipped', [`could not determine bucket region (${location.error})`]) };
    }
    if (location.region !== ctx.region) {
      return {
        result: result(ref, 'skipped', [`bucket is in ${location.region}; this scan covers ${ctx.region}`]),
      };
    }

    const captured = ctx.capture(S3BucketSchema, await readBucketConfig(s3, name));
    if (!captured.ok) return { result: result(ref, 'skipped', [captured.reason]) };

    const bucketConfig = captured.value;
    const reasons = (bucketConfig.unreadable ?? []).map((u) => `${u.field} could not be read (${u.reason})`);
    const scan: ScanResult = result(ref, reasons.length ? 'partial' : 'captured', reasons);
    return { bucket: bucketConfig, result: scan };
  });

  return {
    resources: { buckets: outcomes.flatMap((o) => (o.bucket ? [o.bucket] : [])) },
    results: outcomes.map((o) => o.result),
  };
}
