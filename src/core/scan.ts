import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { SourceSession } from '../aws/clients.js';
import { serviceModule } from '../services/registry.js';
import type { ReadContext } from '../services/types.js';
import { fingerprintAccount } from '../snapshot/fingerprint.js';
import { parseSnapshot } from '../snapshot/io.js';
import {
  SNAPSHOT_VERSION,
  type ServiceName,
  type Snapshot,
  type SnapshotResources,
} from '../snapshot/schema.js';
import { silentLogger, type Logger } from '../util/logger.js';
import { parseArn, tokenize, type AccountContext } from './arn.js';
import { errorCode, result, type ScanResult } from './result.js';

export interface ScanOptions {
  session: SourceSession;
  services: readonly ServiceName[];
  /** Per-user salt for the account fingerprint (snapshot/fingerprint.ts). */
  salt: Buffer;
  logger?: Logger;
  now?: Date;
}

export interface ScanOutput {
  snapshot: Snapshot;
  results: ScanResult[];
}

export async function identifySource(session: SourceSession): Promise<AccountContext> {
  const identity = await session.sts().send(new GetCallerIdentityCommand({}));
  if (!identity.Account) throw new Error('GetCallerIdentity returned no account ID.');
  return {
    accountId: identity.Account,
    region: session.region,
    partition: (identity.Arn && parseArn(identity.Arn)?.partition) || 'aws',
  };
}

export async function scan(options: ScanOptions): Promise<ScanOutput> {
  const logger = options.logger ?? silentLogger;
  const source = await identifySource(options.session);

  const ctx: ReadContext = {
    session: options.session,
    region: source.region,
    logger,
    capture(schema, raw) {
      const parsed = schema.safeParse(tokenize(raw, source));
      if (parsed.success) return { ok: true, value: parsed.data };
      // Paths and messages only: zod issue messages don't include the offending values.
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      return { ok: false, reason: `unexpected configuration shape (${issues.join('; ')})` };
    },
  };

  const resources: SnapshotResources = {};
  const results: ScanResult[] = [];
  for (const name of options.services) {
    const module = serviceModule(name);
    if (!module) {
      results.push(
        result({ service: name, type: 'service', name }, 'skipped', ['service not supported yet']),
      );
      continue;
    }
    try {
      const out = await module.read(ctx);
      (resources as Record<string, unknown>)[name] = out.resources;
      results.push(...out.results);
    } catch (err) {
      // Omitting the service key marks it "not scanned" in the snapshot.
      results.push(
        result({ service: name, type: 'service', name }, 'skipped', [`listing failed (${errorCode(err)})`]),
      );
    }
  }

  const snapshot = parseSnapshot({
    version: SNAPSHOT_VERSION,
    sourceAccountId: fingerprintAccount(source.accountId, options.salt),
    region: source.region,
    createdAt: (options.now ?? new Date()).toISOString(),
    resources,
  });
  return { snapshot, results };
}
