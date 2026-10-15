import { S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types';
import { assertAccountId } from '../config.js';
import { applyReadOnlyGuard, type ReadOnlyGuardOptions } from '../safety/readOnlyGuard.js';
import { applyTargetGuard, assertSafeTargetEndpoint } from '../safety/targetGuard.js';

/**
 * The only place AWS clients are constructed. Every source client gets the read-only guard,
 * every target client gets the target guard and fake per-account credentials.
 */

export interface SourceConfig {
  region: string;
  profile?: string;
  /** Overrides the profile; used by tests that treat a Floci account as "prod". */
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  /** Only for tests and for scanning a twin. Real scans use the profile's endpoints. */
  endpoint?: string;
  guard?: ReadOnlyGuardOptions;
}

export interface SourceSession {
  readonly region: string;
  s3(): S3Client;
  sts(): STSClient;
  destroy(): void;
}

export interface TargetConfig {
  endpoint: string;
  accountId: string;
  region: string;
}

export interface TargetSession {
  readonly region: string;
  readonly accountId: string;
  readonly endpoint: URL;
  s3(): S3Client;
  destroy(): void;
}

interface Destroyable {
  destroy(): void;
}

function lazy<T extends Destroyable>(created: Destroyable[], make: () => T): () => T {
  let client: T | undefined;
  return () => {
    if (!client) {
      client = make();
      created.push(client);
    }
    return client;
  };
}

export function createSourceSession(config: SourceConfig): SourceSession {
  const credentials =
    config.credentials ?? (config.profile ? fromIni({ profile: config.profile }) : fromNodeProviderChain());
  const base = {
    region: config.region,
    credentials,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  };
  const created: Destroyable[] = [];
  return {
    region: config.region,
    s3: lazy(created, () =>
      applyReadOnlyGuard(
        new S3Client({ ...base, forcePathStyle: Boolean(config.endpoint), followRegionRedirects: true }),
        config.guard,
      ),
    ),
    sts: lazy(created, () => applyReadOnlyGuard(new STSClient(base), config.guard)),
    destroy: () => created.forEach((c) => c.destroy()),
  };
}

export function createTargetSession(config: TargetConfig): TargetSession {
  const endpoint = assertSafeTargetEndpoint(config.endpoint);
  const accountId = assertAccountId(config.accountId);
  const base = {
    region: config.region,
    endpoint: endpoint.href,
    // Floci isolates accounts by access key ID. Never the user's real credentials.
    credentials: { accessKeyId: accountId, secretAccessKey: 'cloudfork' },
  };
  const created: Destroyable[] = [];
  return {
    region: config.region,
    accountId,
    endpoint,
    s3: lazy(created, () =>
      applyTargetGuard(
        new S3Client({
          ...base,
          forcePathStyle: true,
          // Emulators handle the classic Content-MD5 path more reliably than flexible checksums.
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
        }),
        endpoint,
      ),
    ),
    destroy: () => created.forEach((c) => c.destroy()),
  };
}
