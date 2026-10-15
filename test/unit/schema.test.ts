import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_TOKEN,
  DynamoTableSchema,
  S3BucketSchema,
  SnapshotSchema,
  SqsQueueSchema,
} from '../../src/snapshot/schema.js';
import { bucket, queue, snapshot, table } from '../helpers/fixtures.js';

function messages(result: { success: boolean; error?: { issues: { message: string }[] } }): string[] {
  return result.error?.issues.map((i) => i.message) ?? [];
}

describe('snapshot schema', () => {
  it('accepts a valid snapshot', () => {
    expect(SnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });

  it('accepts an empty, partially scanned snapshot', () => {
    expect(SnapshotSchema.safeParse(snapshot({ resources: { s3: { buckets: [] } } })).success).toBe(true);
  });

  it('rejects unknown fields at every level', () => {
    expect(SnapshotSchema.safeParse({ ...snapshot(), extra: 1 }).success).toBe(false);
    expect(SnapshotSchema.safeParse(snapshot({ resources: { lambda: {} } as never })).success).toBe(false);
    expect(S3BucketSchema.safeParse({ ...bucket(), CreationDate: 'x' }).success).toBe(false);
  });

  it('requires a hashed account ID, not a raw one', () => {
    expect(SnapshotSchema.safeParse(snapshot({ sourceAccountId: '111111111111' })).success).toBe(false);
  });

  it('rejects other versions', () => {
    expect(SnapshotSchema.safeParse({ ...snapshot(), version: 2 }).success).toBe(false);
  });

  it('accepts resource names containing the account token', () => {
    expect(S3BucketSchema.safeParse(bucket({ name: `cdk-assets-${ACCOUNT_TOKEN}-us-east-1` })).success).toBe(
      true,
    );
    expect(S3BucketSchema.safeParse(bucket({ name: 'Not_A_Bucket' })).success).toBe(false);
  });

  describe('unique names', () => {
    it.each([
      ['s3', { s3: { buckets: [bucket(), bucket()] } }],
      ['dynamodb', { dynamodb: { tables: [table(), table()] } }],
      ['sqs', { sqs: { queues: [queue(), queue()] } }],
    ])('rejects duplicate %s names', (_service, resources) => {
      const parsed = SnapshotSchema.safeParse(snapshot({ resources }));
      expect(parsed.success).toBe(false);
      expect(messages(parsed)).toContainEqual(expect.stringMatching(/^duplicate name/));
    });

    it('allows the same name in different services', () => {
      const resources = {
        dynamodb: { tables: [table({ name: 'orders' })] },
        sqs: { queues: [queue({ name: 'orders' })] },
      };
      expect(SnapshotSchema.safeParse(snapshot({ resources })).success).toBe(true);
    });
  });

  describe('sample keys reference real resources', () => {
    const ref = { file: 'dynamodb/Orders.jsonl', count: 20, sha256: 'b'.repeat(64) };

    it('accepts samples for scanned resources', () => {
      const s = snapshot({ samples: { dynamodb: { Orders: ref }, s3: { 'chaicart-photos': ref } } });
      expect(SnapshotSchema.safeParse(s).success).toBe(true);
    });

    it('rejects a DynamoDB sample for a table not in the snapshot', () => {
      const parsed = SnapshotSchema.safeParse(snapshot({ samples: { dynamodb: { Payments: ref } } }));
      expect(messages(parsed)).toContain('sample refers to unknown dynamodb resource "Payments"');
    });

    it('rejects an S3 sample for a bucket not in the snapshot', () => {
      const parsed = SnapshotSchema.safeParse(snapshot({ samples: { s3: { 'other-bucket': ref } } }));
      expect(messages(parsed)).toContain('sample refers to unknown s3 resource "other-bucket"');
    });

    it('rejects a sample when its service was not scanned at all', () => {
      const parsed = SnapshotSchema.safeParse(
        snapshot({ resources: { s3: { buckets: [] } }, samples: { dynamodb: { Orders: ref } } }),
      );
      expect(parsed.success).toBe(false);
    });

    it.each(['../outside.jsonl', '/etc/passwd', 'C:\\data.jsonl', 'a/../../b'])(
      'rejects sample file path %s that escapes the data directory',
      (file) => {
        const parsed = SnapshotSchema.safeParse(
          snapshot({ samples: { dynamodb: { Orders: { ...ref, file } } } }),
        );
        expect(parsed.success).toBe(false);
      },
    );
  });

  describe('DynamoDB: PROVISIONED ⇔ throughput', () => {
    const throughput = { read: 5, write: 5 };
    const provisionedGsi = (t?: typeof throughput) => [
      {
        name: 'byCustomer',
        keySchema: [{ AttributeName: 'customerId', KeyType: 'HASH' as const }],
        projection: { ProjectionType: 'ALL' as const },
        ...(t ? { throughput: t } : {}),
      },
    ];

    it('accepts PROVISIONED with throughput on the table and its GSIs', () => {
      const t = table({
        billingMode: 'PROVISIONED',
        throughput,
        globalSecondaryIndexes: provisionedGsi(throughput),
      });
      expect(DynamoTableSchema.safeParse(t).success).toBe(true);
    });

    it('rejects PROVISIONED without throughput', () => {
      const parsed = DynamoTableSchema.safeParse(
        table({ billingMode: 'PROVISIONED', globalSecondaryIndexes: provisionedGsi(throughput) }),
      );
      expect(messages(parsed)).toEqual(['PROVISIONED tables require throughput']);
    });

    it('rejects PAY_PER_REQUEST with throughput', () => {
      const parsed = DynamoTableSchema.safeParse(table({ throughput }));
      expect(messages(parsed)).toEqual(['PAY_PER_REQUEST tables must not set throughput']);
    });

    it('rejects a PROVISIONED table whose GSI has no throughput', () => {
      const parsed = DynamoTableSchema.safeParse(
        table({ billingMode: 'PROVISIONED', throughput, globalSecondaryIndexes: provisionedGsi() }),
      );
      expect(messages(parsed)).toEqual(['GSIs of PROVISIONED tables require throughput']);
    });

    it('rejects a PAY_PER_REQUEST table whose GSI has throughput', () => {
      const parsed = DynamoTableSchema.safeParse(
        table({ globalSecondaryIndexes: provisionedGsi(throughput) }),
      );
      expect(messages(parsed)).toEqual(['GSIs of PAY_PER_REQUEST tables must not set throughput']);
    });
  });

  describe('DynamoDB: attributeDefinitions match key attributes exactly', () => {
    it('rejects a key attribute without a definition', () => {
      const t = table();
      const parsed = DynamoTableSchema.safeParse(
        table({
          attributeDefinitions: t.attributeDefinitions.filter((d) => d.AttributeName !== 'createdAt'),
        }),
      );
      expect(messages(parsed)).toEqual(['key attribute "createdAt" has no attribute definition']);
    });

    it('rejects a GSI key attribute without a definition', () => {
      const t = table();
      const parsed = DynamoTableSchema.safeParse(
        table({
          attributeDefinitions: t.attributeDefinitions.filter((d) => d.AttributeName !== 'customerId'),
        }),
      );
      expect(messages(parsed)).toEqual(['key attribute "customerId" has no attribute definition']);
    });

    it('counts LSI keys as used', () => {
      const t = table();
      const parsed = DynamoTableSchema.safeParse(
        table({
          attributeDefinitions: [...t.attributeDefinitions, { AttributeName: 'status', AttributeType: 'S' }],
          localSecondaryIndexes: [
            {
              name: 'byStatus',
              keySchema: [
                { AttributeName: 'orderId', KeyType: 'HASH' },
                { AttributeName: 'status', KeyType: 'RANGE' },
              ],
              projection: { ProjectionType: 'KEYS_ONLY' },
            },
          ],
        }),
      );
      expect(parsed.success).toBe(true);
    });

    it('rejects a definition that no key uses', () => {
      const t = table();
      const parsed = DynamoTableSchema.safeParse(
        table({
          attributeDefinitions: [...t.attributeDefinitions, { AttributeName: 'email', AttributeType: 'S' }],
        }),
      );
      expect(messages(parsed)).toEqual(['attribute definition "email" is not used by any key']);
    });

    it('rejects duplicate definitions', () => {
      const t = table();
      const parsed = DynamoTableSchema.safeParse(
        table({
          attributeDefinitions: [...t.attributeDefinitions, { AttributeName: 'orderId', AttributeType: 'S' }],
        }),
      );
      expect(messages(parsed)).toEqual(['duplicate attribute definition "orderId"']);
    });

    it('rejects a key schema that does not start with HASH', () => {
      const parsed = DynamoTableSchema.safeParse(
        table({
          keySchema: [
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
            { AttributeName: 'orderId', KeyType: 'HASH' },
          ],
        }),
      );
      expect(messages(parsed)).toEqual(['first key must be HASH', 'second key must be RANGE']);
    });

    it('rejects duplicate index names', () => {
      const gsi = table().globalSecondaryIndexes?.[0];
      const parsed = DynamoTableSchema.safeParse(table({ globalSecondaryIndexes: gsi && [gsi, gsi] }));
      expect(messages(parsed)).toEqual(['duplicate index name "byCustomer"']);
    });
  });

  describe('SQS: fifo ⇔ ".fifo" name', () => {
    it('accepts a FIFO queue with a .fifo name and FIFO settings', () => {
      const q = queue({
        name: 'orders.fifo',
        fifo: true,
        contentBasedDeduplication: true,
        fifoThroughputLimit: 'perQueue',
      });
      expect(SqsQueueSchema.safeParse(q).success).toBe(true);
    });

    it('rejects a FIFO queue without the .fifo suffix', () => {
      const parsed = SqsQueueSchema.safeParse(queue({ fifo: true }));
      expect(messages(parsed)).toEqual(['FIFO queue names must end in ".fifo"']);
    });

    it('rejects a standard queue with a .fifo name', () => {
      const parsed = SqsQueueSchema.safeParse(queue({ name: 'orders.fifo' }));
      expect(messages(parsed)).toEqual(['queues named "*.fifo" must be FIFO queues']);
    });

    it.each([
      ['contentBasedDeduplication', { contentBasedDeduplication: false }],
      ['deduplicationScope', { deduplicationScope: 'queue' as const }],
      ['fifoThroughputLimit', { fifoThroughputLimit: 'perQueue' as const }],
    ])('rejects FIFO-only %s on a standard queue', (field, extra) => {
      const parsed = SqsQueueSchema.safeParse(queue(extra));
      expect(messages(parsed)).toEqual([`${field} is only valid on FIFO queues`]);
    });

    it('rejects names over the length limit', () => {
      expect(SqsQueueSchema.safeParse(queue({ name: 'q'.repeat(81) })).success).toBe(false);
      expect(SqsQueueSchema.safeParse(queue({ name: `${'q'.repeat(76)}.fifo`, fifo: true })).success).toBe(
        false,
      );
    });
  });
});
