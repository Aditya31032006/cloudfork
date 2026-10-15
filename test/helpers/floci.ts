import { S3Client } from '@aws-sdk/client-s3';
import { FlociContainer, type StartedFlociContainer } from '@floci/testcontainers';

export const REGION = 'us-east-1';
export const PROD_ACCOUNT = '111111111111';
export const TWIN_ACCOUNT = '222222222222';

export interface Floci {
  endpoint: string;
  stop(): Promise<void>;
}

/** Uses FLOCI_ENDPOINT if set (CI service container), otherwise starts a throwaway container. */
export async function startFloci(): Promise<Floci> {
  const external = process.env.FLOCI_ENDPOINT;
  if (external) return { endpoint: external, stop: async () => {} };
  // S3/DynamoDB/SQS don't start sibling containers, so Floci doesn't need the Docker socket.
  const container: StartedFlociContainer = await new FlociContainer().withoutDockerSocket().start();
  return { endpoint: container.getEndpoint(), stop: () => container.stop().then(() => undefined) };
}

/** An unguarded client for seeding and inspecting Floci directly. Never used by cloudfork itself. */
export function rawS3(endpoint: string, accountId: string): S3Client {
  return new S3Client({
    endpoint,
    region: REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: accountId, secretAccessKey: 'test' },
  });
}

export function credentialsFor(accountId: string) {
  return { accessKeyId: accountId, secretAccessKey: 'test' };
}
