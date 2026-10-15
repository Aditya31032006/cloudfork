import type { DynamoTable, S3Bucket, Snapshot, SqsQueue } from '../../src/snapshot/schema.js';

export const HASH = 'a'.repeat(64);

export function bucket(overrides: Partial<S3Bucket> = {}): S3Bucket {
  return { name: 'chaicart-photos', ...overrides };
}

export function table(overrides: Partial<DynamoTable> = {}): DynamoTable {
  return {
    name: 'Orders',
    keySchema: [
      { AttributeName: 'orderId', KeyType: 'HASH' },
      { AttributeName: 'createdAt', KeyType: 'RANGE' },
    ],
    attributeDefinitions: [
      { AttributeName: 'orderId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'customerId', AttributeType: 'S' },
    ],
    billingMode: 'PAY_PER_REQUEST',
    globalSecondaryIndexes: [
      {
        name: 'byCustomer',
        keySchema: [{ AttributeName: 'customerId', KeyType: 'HASH' }],
        projection: { ProjectionType: 'ALL' },
      },
    ],
    ttl: { attributeName: 'expiresAt' },
    ...overrides,
  };
}

export function queue(overrides: Partial<SqsQueue> = {}): SqsQueue {
  return {
    name: 'kitchen-orders',
    fifo: false,
    delaySeconds: 0,
    maximumMessageSize: 262_144,
    messageRetentionPeriod: 345_600,
    receiveMessageWaitTimeSeconds: 0,
    visibilityTimeout: 30,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    sourceAccountId: HASH,
    region: 'us-east-1',
    createdAt: '2026-10-15T08:00:00.000Z',
    resources: {
      s3: { buckets: [bucket()] },
      dynamodb: { tables: [table()] },
      sqs: { queues: [queue()] },
    },
    ...overrides,
  };
}
