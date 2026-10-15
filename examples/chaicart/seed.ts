/**
 * Seeds a Floci account with the ChaiCart demo "production" account.
 *
 *   npx tsx examples/chaicart/seed.ts [--endpoint http://localhost:4566] [--account 111111111111]
 *
 * Phase 1 seeds S3 only; DynamoDB (Orders) and SQS (kitchen-orders + DLQ) arrive in phase 2.
 */
import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const CHAICART_PROD_ACCOUNT = '111111111111';

export function chaicartPhotosPolicy(accountId: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AppReadsPhotos',
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: ['s3:GetObject'],
        Resource: 'arn:aws:s3:::chaicart-photos/*',
      },
    ],
  };
}

async function createBucket(s3: S3Client, Bucket: string) {
  try {
    await s3.send(new CreateBucketCommand({ Bucket }));
  } catch (err) {
    if ((err as Error).name !== 'BucketAlreadyOwnedByYou') throw err;
  }
}

export async function seedChaiCartS3(s3: S3Client, accountId: string): Promise<void> {
  const Bucket = 'chaicart-photos';
  await createBucket(s3, Bucket);
  await s3.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }));
  await s3.send(
    new PutBucketCorsCommand({
      Bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            ID: 'storefront-uploads',
            AllowedMethods: ['GET', 'PUT'],
            AllowedOrigins: ['https://chaicart.example'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3000,
          },
          { AllowedMethods: ['GET'], AllowedOrigins: ['*'] },
        ],
      },
    }),
  );
  await s3.send(
    new PutBucketTaggingCommand({
      Bucket,
      Tagging: {
        TagSet: [
          { Key: 'app', Value: 'chaicart' },
          { Key: 'env', Value: 'prod' },
          { Key: 'owner', Value: `platform-${accountId}` },
        ],
      },
    }),
  );
  await s3.send(
    new PutBucketPolicyCommand({ Bucket, Policy: JSON.stringify(chaicartPhotosPolicy(accountId)) }),
  );
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'expire-old-versions',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          },
          { ID: 'tmp-uploads', Status: 'Enabled', Filter: { Prefix: 'tmp/' }, Expiration: { Days: 1 } },
        ],
      },
    }),
  );

  // A bucket with no optional configuration at all.
  await createBucket(s3, 'chaicart-exports');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    options: {
      endpoint: { type: 'string', default: 'http://localhost:4566' },
      account: { type: 'string', default: CHAICART_PROD_ACCOUNT },
      region: { type: 'string', default: 'us-east-1' },
    },
  });
  const s3 = new S3Client({
    endpoint: values.endpoint,
    region: values.region,
    forcePathStyle: true,
    credentials: { accessKeyId: values.account, secretAccessKey: 'test' },
  });
  await seedChaiCartS3(s3, values.account);
  console.log(`Seeded ChaiCart S3 into account ${values.account} at ${values.endpoint}`);
}
