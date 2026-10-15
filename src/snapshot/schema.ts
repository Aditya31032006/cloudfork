import { z } from 'zod';

export const SNAPSHOT_VERSION = 1;

// Account IDs, regions and partitions inside resource config are replaced with these
// tokens at scan time and substituted by core/arn.ts at `up` time. The raw source account
// ID never reaches disk, and a prod snapshot and its twin's snapshot diff to empty.
export const ACCOUNT_TOKEN = '{{cloudfork:account}}';
export const REGION_TOKEN = '{{cloudfork:region}}';
export const PARTITION_TOKEN = '{{cloudfork:partition}}';

const int = z.number().int().nonnegative();
const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, 'expected 64 lowercase hex characters');
const Tags = z.record(z.string(), z.string());
/** IAM-style policy, stored parsed (not as a string) with sorted keys so diffs are readable. */
const PolicyDocument = z.record(z.string(), z.unknown());
/** Config we tried to read but couldn't (e.g. AccessDenied). `up` marks the resource `partial`. */
const Unreadable = z.array(z.object({ field: z.string(), reason: z.string() }).strict());

/** Names may embed the account token (e.g. `cdk-assets-{{cloudfork:account}}-us-east-1`). */
function resourceName(pattern: RegExp, what: string) {
  return z
    .string()
    .refine((s) => pattern.test(s.replaceAll(ACCOUNT_TOKEN, '000000000000')), `invalid ${what} name`);
}

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', path, message });
}

/* ───────────────────────── S3 ─────────────────────────
 * Nested blocks keep AWS's PascalCase shape so they map 1:1 onto Put* calls. */

const S3Tag = z.object({ Key: z.string(), Value: z.string() }).strict();

const CorsRule = z
  .object({
    ID: z.string().optional(),
    AllowedMethods: z.array(z.enum(['GET', 'PUT', 'POST', 'DELETE', 'HEAD'])).min(1),
    AllowedOrigins: z.array(z.string()).min(1),
    AllowedHeaders: z.array(z.string()).optional(),
    ExposeHeaders: z.array(z.string()).optional(),
    MaxAgeSeconds: int.optional(),
  })
  .strict();

const SizeBounds = { ObjectSizeGreaterThan: int.optional(), ObjectSizeLessThan: int.optional() };

const LifecycleFilter = z
  .object({
    Prefix: z.string().optional(),
    Tag: S3Tag.optional(),
    ...SizeBounds,
    And: z
      .object({ Prefix: z.string().optional(), Tags: z.array(S3Tag).optional(), ...SizeBounds })
      .strict()
      .optional(),
  })
  .strict();

const NoncurrentDays = { NoncurrentDays: int.optional(), NewerNoncurrentVersions: int.optional() };

const LifecycleRule = z
  .object({
    ID: z.string().optional(),
    Status: z.enum(['Enabled', 'Disabled']),
    Filter: LifecycleFilter.optional(), // absent = whole bucket
    Expiration: z
      .object({
        Days: int.optional(),
        Date: z.iso.datetime().optional(),
        ExpiredObjectDeleteMarker: z.boolean().optional(),
      })
      .strict()
      .optional(),
    Transitions: z
      .array(
        z
          .object({ Days: int.optional(), Date: z.iso.datetime().optional(), StorageClass: z.string() })
          .strict(),
      )
      .optional(),
    NoncurrentVersionExpiration: z.object(NoncurrentDays).strict().optional(),
    NoncurrentVersionTransitions: z
      .array(z.object({ ...NoncurrentDays, StorageClass: z.string() }).strict())
      .optional(),
    AbortIncompleteMultipartUpload: z.object({ DaysAfterInitiation: int }).strict().optional(),
  })
  .strict();

const KeyFilter = z
  .object({
    Key: z
      .object({
        FilterRules: z.array(z.object({ Name: z.enum(['prefix', 'suffix']), Value: z.string() }).strict()),
      })
      .strict(),
  })
  .strict();

const NotificationBase = z.object({
  Id: z.string().optional(),
  Events: z.array(z.string()).min(1),
  Filter: KeyFilter.optional(),
});

const S3Notifications = z
  .object({
    queues: z.array(NotificationBase.extend({ QueueArn: z.string() }).strict()),
    // Captured for completeness; the writer reports these `skipped` until SNS/Lambda are supported.
    topics: z.array(NotificationBase.extend({ TopicArn: z.string() }).strict()),
    lambdas: z.array(NotificationBase.extend({ LambdaFunctionArn: z.string() }).strict()),
    eventBridge: z.boolean(),
  })
  .strict();

export const S3BucketSchema = z
  .object({
    name: resourceName(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'S3 bucket'),
    versioning: z.enum(['Enabled', 'Suspended']).optional(), // absent = never enabled
    policy: PolicyDocument.optional(),
    cors: z.array(CorsRule).min(1).optional(), // rule order preserved: first match wins
    tags: Tags.optional(),
    lifecycle: z.array(LifecycleRule).min(1).optional(),
    notifications: S3Notifications.optional(),
    unreadable: Unreadable.optional(),
  })
  .strict();

/* ─────────────────────── DynamoDB ─────────────────────── */

const KeySchema = z
  .array(z.object({ AttributeName: z.string(), KeyType: z.enum(['HASH', 'RANGE']) }).strict())
  .min(1)
  .max(2)
  .superRefine((keys, ctx) => {
    if (keys[0]?.KeyType !== 'HASH') addIssue(ctx, [0, 'KeyType'], 'first key must be HASH');
    if (keys[1] && keys[1].KeyType !== 'RANGE') addIssue(ctx, [1, 'KeyType'], 'second key must be RANGE');
  });

const Projection = z
  .object({
    ProjectionType: z.enum(['ALL', 'KEYS_ONLY', 'INCLUDE']),
    NonKeyAttributes: z.array(z.string()).optional(),
  })
  .strict();

const Throughput = z
  .object({ read: z.number().int().positive(), write: z.number().int().positive() })
  .strict();

export const DynamoTableSchema = z
  .object({
    name: resourceName(/^[A-Za-z0-9_.-]{3,255}$/, 'DynamoDB table'),
    keySchema: KeySchema,
    attributeDefinitions: z
      .array(z.object({ AttributeName: z.string(), AttributeType: z.enum(['S', 'N', 'B']) }).strict())
      .min(1),
    billingMode: z.enum(['PROVISIONED', 'PAY_PER_REQUEST']),
    throughput: Throughput.optional(),
    globalSecondaryIndexes: z
      .array(
        z
          .object({
            name: z.string(),
            keySchema: KeySchema,
            projection: Projection,
            throughput: Throughput.optional(),
          })
          .strict(),
      )
      .optional(),
    localSecondaryIndexes: z
      .array(z.object({ name: z.string(), keySchema: KeySchema, projection: Projection }).strict())
      .optional(),
    stream: z
      .object({ viewType: z.enum(['KEYS_ONLY', 'NEW_IMAGE', 'OLD_IMAGE', 'NEW_AND_OLD_IMAGES']) })
      .strict()
      .optional(), // absent = disabled
    ttl: z.object({ attributeName: z.string() }).strict().optional(), // absent = disabled
    tableClass: z.enum(['STANDARD', 'STANDARD_INFREQUENT_ACCESS']).optional(),
    deletionProtection: z.boolean().optional(),
    tags: Tags.optional(),
    unreadable: Unreadable.optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const gsis = t.globalSecondaryIndexes ?? [];
    const lsis = t.localSecondaryIndexes ?? [];

    // PROVISIONED ⇔ throughput, on the table and on every GSI.
    const provisioned = t.billingMode === 'PROVISIONED';
    if (provisioned && !t.throughput) {
      addIssue(ctx, ['throughput'], 'PROVISIONED tables require throughput');
    }
    if (!provisioned && t.throughput) {
      addIssue(ctx, ['throughput'], 'PAY_PER_REQUEST tables must not set throughput');
    }
    gsis.forEach((gsi, i) => {
      if (provisioned && !gsi.throughput) {
        addIssue(
          ctx,
          ['globalSecondaryIndexes', i, 'throughput'],
          'GSIs of PROVISIONED tables require throughput',
        );
      }
      if (!provisioned && gsi.throughput) {
        addIssue(
          ctx,
          ['globalSecondaryIndexes', i, 'throughput'],
          'GSIs of PAY_PER_REQUEST tables must not set throughput',
        );
      }
    });

    // attributeDefinitions must be exactly the attributes used as keys (DynamoDB rejects extras).
    const defined = new Set<string>();
    t.attributeDefinitions.forEach((def, i) => {
      if (defined.has(def.AttributeName)) {
        addIssue(ctx, ['attributeDefinitions', i], `duplicate attribute definition "${def.AttributeName}"`);
      }
      defined.add(def.AttributeName);
    });
    const used = new Set(
      [t.keySchema, ...gsis.map((g) => g.keySchema), ...lsis.map((l) => l.keySchema)]
        .flat()
        .map((k) => k.AttributeName),
    );
    for (const name of used) {
      if (!defined.has(name)) {
        addIssue(ctx, ['attributeDefinitions'], `key attribute "${name}" has no attribute definition`);
      }
    }
    for (const name of defined) {
      if (!used.has(name)) {
        addIssue(ctx, ['attributeDefinitions'], `attribute definition "${name}" is not used by any key`);
      }
    }

    const indexNames = new Set<string>();
    [...gsis, ...lsis].forEach((index) => {
      if (indexNames.has(index.name)) addIssue(ctx, [], `duplicate index name "${index.name}"`);
      indexNames.add(index.name);
    });
  });

/* ───────────────────────── SQS ───────────────────────── */

const FIFO_ONLY_FIELDS = ['contentBasedDeduplication', 'deduplicationScope', 'fifoThroughputLimit'] as const;

export const SqsQueueSchema = z
  .object({
    name: resourceName(/^(?:[A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}\.fifo)$/, 'SQS queue'),
    fifo: z.boolean(),
    delaySeconds: int.max(900),
    maximumMessageSize: z.number().int().min(1024), // no max: AWS has raised it before
    messageRetentionPeriod: z.number().int().min(60).max(1_209_600),
    receiveMessageWaitTimeSeconds: int.max(20),
    visibilityTimeout: int.max(43_200),
    contentBasedDeduplication: z.boolean().optional(),
    deduplicationScope: z.enum(['messageGroup', 'queue']).optional(),
    fifoThroughputLimit: z.enum(['perQueue', 'perMessageGroupId']).optional(),
    sqsManagedSse: z.boolean().optional(),
    kmsMasterKeyId: z.string().optional(), // `up` reports partial: KMS keys aren't copied
    redrivePolicy: z
      .object({ deadLetterTargetArn: z.string(), maxReceiveCount: z.number().int().min(1) })
      .strict()
      .optional(),
    redriveAllowPolicy: z
      .object({
        redrivePermission: z.enum(['allowAll', 'denyAll', 'byQueue']),
        sourceQueueArns: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    policy: PolicyDocument.optional(),
    tags: Tags.optional(),
    unreadable: Unreadable.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const fifoName = q.name.endsWith('.fifo');
    if (q.fifo && !fifoName) addIssue(ctx, ['name'], 'FIFO queue names must end in ".fifo"');
    if (!q.fifo && fifoName) addIssue(ctx, ['fifo'], 'queues named "*.fifo" must be FIFO queues');
    if (!q.fifo) {
      for (const field of FIFO_ONLY_FIELDS) {
        if (q[field] !== undefined) addIssue(ctx, [field], `${field} is only valid on FIFO queues`);
      }
    }
  });

/* ─────────────────── Sample data index ───────────────────
 * The masked data itself lives in a sidecar directory, never inline. */

const SampleRef = z
  .object({
    file: z
      .string()
      .refine(
        (f) => !/^([a-zA-Z]:)?[\\/]/.test(f) && !f.split(/[\\/]/).includes('..'),
        'sample file must be a relative path inside the data directory',
      ),
    count: int,
    sha256: Sha256Hex,
  })
  .strict();

/* ───────────────────────── Root ───────────────────────── */

export const SnapshotSchema = z
  .object({
    version: z.literal(SNAPSHOT_VERSION),
    /** HMAC-SHA256 of the account ID, keyed with a per-user salt (see snapshot/fingerprint.ts). */
    sourceAccountId: Sha256Hex,
    region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, 'invalid AWS region'),
    createdAt: z.iso.datetime(),
    // Absent service key = not scanned. Empty array = scanned, found nothing.
    resources: z
      .object({
        s3: z
          .object({ buckets: z.array(S3BucketSchema) })
          .strict()
          .optional(),
        dynamodb: z
          .object({ tables: z.array(DynamoTableSchema) })
          .strict()
          .optional(),
        sqs: z
          .object({ queues: z.array(SqsQueueSchema) })
          .strict()
          .optional(),
      })
      .strict(),
    samples: z
      .object({
        dynamodb: z.record(z.string(), SampleRef).optional(), // table → JSONL of masked items
        s3: z.record(z.string(), SampleRef).optional(), // bucket → manifest of masked objects
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const named: [string, string, { name: string }[] | undefined][] = [
      ['s3', 'buckets', s.resources.s3?.buckets],
      ['dynamodb', 'tables', s.resources.dynamodb?.tables],
      ['sqs', 'queues', s.resources.sqs?.queues],
    ];
    for (const [service, kind, list] of named) {
      const seen = new Set<string>();
      list?.forEach((r, i) => {
        if (seen.has(r.name))
          addIssue(ctx, ['resources', service, kind, i, 'name'], `duplicate name "${r.name}"`);
        seen.add(r.name);
      });
    }

    const sampleTargets: [string, Record<string, unknown> | undefined, { name: string }[] | undefined][] = [
      ['dynamodb', s.samples?.dynamodb, s.resources.dynamodb?.tables],
      ['s3', s.samples?.s3, s.resources.s3?.buckets],
    ];
    for (const [service, samples, resources] of sampleTargets) {
      const names = new Set(resources?.map((r) => r.name));
      for (const key of Object.keys(samples ?? {})) {
        if (!names.has(key)) {
          addIssue(ctx, ['samples', service, key], `sample refers to unknown ${service} resource "${key}"`);
        }
      }
    }
  });

export type Snapshot = z.infer<typeof SnapshotSchema>;
export type S3Bucket = z.infer<typeof S3BucketSchema>;
export type DynamoTable = z.infer<typeof DynamoTableSchema>;
export type SqsQueue = z.infer<typeof SqsQueueSchema>;
export type ServiceName = keyof Snapshot['resources'];
export type SnapshotResources = Snapshot['resources'];

export const SERVICE_NAMES = ['s3', 'dynamodb', 'sqs'] as const satisfies readonly ServiceName[];
