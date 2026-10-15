import {
  CreateBucketCommand,
  DeleteBucketCommand,
  GetBucketPolicyCommand,
  ListBucketsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { describe, expect, it, vi } from 'vitest';
import { createSourceSession } from '../../src/aws/clients.js';
import {
  applyReadOnlyGuard,
  assertReadOnly,
  isReadOnlyOperation,
  ReadOnlyViolationError,
} from '../../src/safety/readOnlyGuard.js';

const NETWORK = new Error('reached the network layer');

/** An S3 client whose transport records calls instead of sending them. */
function guardedS3(options = {}) {
  const handle = vi.fn(async () => {
    throw NETWORK;
  });
  const client = applyReadOnlyGuard(
    new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      requestHandler: { handle },
    }),
    options,
  );
  return { client, handle };
}

describe('isReadOnlyOperation', () => {
  it.each([
    'ListBuckets',
    'GetBucketPolicy',
    'DescribeTable',
    'GetQueueAttributes',
    'ListQueueTags',
    'GetObject',
  ])('allows %s', (op) => expect(isReadOnlyOperation('AnyClient', op)).toBe(true));

  it.each([
    'PutObject',
    'CreateBucket',
    'DeleteBucket',
    'UpdateTable',
    'SendMessage',
    'ReceiveMessage', // changes message visibility
    'PurgeQueue',
    'BatchWriteItem',
    'TagResource',
    'Listen', // prefix must be followed by an upper-case letter
    'Getaway',
    'Query',
  ])('blocks %s', (op) => expect(isReadOnlyOperation('AnyClient', op)).toBe(false));

  it.each([
    'GetSecretValue',
    'GetParameter',
    'GetParameters',
    'GetParametersByPath',
    'GetSessionToken',
    'GetPasswordData',
  ])('blocks secret-returning read %s even though it starts with Get', (op) =>
    expect(isReadOnlyOperation('AnyClient', op)).toBe(false),
  );

  it('blocks DynamoDB Scan unless sampling is enabled', () => {
    expect(isReadOnlyOperation('DynamoDBClient', 'Scan')).toBe(false);
    expect(isReadOnlyOperation('DynamoDBClient', 'Scan', { allowDynamoDbScan: false })).toBe(false);
    expect(isReadOnlyOperation('DynamoDBClient', 'Scan', { allowDynamoDbScan: true })).toBe(true);
  });

  it('only allows Scan on the DynamoDB client', () => {
    expect(isReadOnlyOperation('S3Client', 'Scan', { allowDynamoDbScan: true })).toBe(false);
  });
});

describe('assertReadOnly', () => {
  it('fails closed when the command cannot be identified', () => {
    expect(() => assertReadOnly('S3Client', undefined)).toThrow(ReadOnlyViolationError);
    expect(() => assertReadOnly(undefined, 'ListBucketsCommand')).toThrow(ReadOnlyViolationError);
  });

  it('strips the Command suffix', () => {
    expect(() => assertReadOnly('S3Client', 'ListBucketsCommand')).not.toThrow();
    expect(() => assertReadOnly('S3Client', 'PutObjectCommand')).toThrow(/Blocked S3Client\.PutObject/);
  });
});

describe('applyReadOnlyGuard on a real SDK client', () => {
  it.each([
    ['PutObject', new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'x' })],
    ['CreateBucket', new CreateBucketCommand({ Bucket: 'b' })],
    ['DeleteBucket', new DeleteBucketCommand({ Bucket: 'b' })],
    ['PutBucketPolicy', new PutBucketPolicyCommand({ Bucket: 'b', Policy: '{}' })],
  ])('blocks %s before any request is sent', async (op, command) => {
    const { client, handle } = guardedS3();
    await expect(client.send(command as never)).rejects.toMatchObject({
      name: 'ReadOnlyViolationError',
      operation: op,
      clientName: 'S3Client',
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it.each([
    ['ListBuckets', new ListBucketsCommand({})],
    ['GetBucketPolicy', new GetBucketPolicyCommand({ Bucket: 'b' })],
  ])('lets %s through to the transport', async (_op, command) => {
    const { client, handle } = guardedS3();
    await expect(client.send(command as never)).rejects.toBe(NETWORK);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('is attached to every client the source session creates', async () => {
    const session = createSourceSession({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    });
    await expect(
      session.s3().send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'x' })),
    ).rejects.toBeInstanceOf(ReadOnlyViolationError);
    // GetCallerIdentity is allowed; it fails only because nothing listens on port 1.
    await expect(session.sts().send(new GetCallerIdentityCommand({}))).rejects.not.toBeInstanceOf(
      ReadOnlyViolationError,
    );
    session.destroy();
  });
});
