#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { Command, InvalidArgumentError } from 'commander';
import { createSourceSession, createTargetSession } from './aws/clients.js';
import { DEFAULT_ENDPOINT, DEFAULT_SNAPSHOT_FILE, DEFAULT_TWIN_ACCOUNT, resolveRegion } from './config.js';
import type { ResourceResult } from './core/result.js';
import { scan } from './core/scan.js';
import { up } from './core/up.js';
import { ReadOnlyViolationError } from './safety/readOnlyGuard.js';
import { TargetGuardError } from './safety/targetGuard.js';
import { SUPPORTED_SERVICES } from './services/registry.js';
import { loadOrCreateSalt } from './snapshot/fingerprint.js';
import {
  readSnapshot,
  SnapshotNotFoundError,
  SnapshotValidationError,
  writeSnapshot,
} from './snapshot/io.js';
import { SERVICE_NAMES, type ServiceName } from './snapshot/schema.js';
import { createLogger, type Logger } from './util/logger.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

class UsageError extends Error {
  override readonly name = 'UsageError';
}

function parseServices(value: string): ServiceName[] {
  const names = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const name of names) {
    if (!(SERVICE_NAMES as readonly string[]).includes(name)) {
      throw new InvalidArgumentError(`unknown service "${name}" (known: ${SERVICE_NAMES.join(', ')})`);
    }
  }
  return names as ServiceName[];
}

const STATUS_STYLE: Record<string, (s: string) => string> = {
  captured: chalk.green,
  recreated: chalk.green,
  partial: chalk.yellow,
  skipped: chalk.red,
};

function printResults(logger: Logger, results: ResourceResult<string>[]): void {
  for (const r of results) {
    const style = STATUS_STYLE[r.status] ?? ((s: string) => s);
    logger.info(`  ${style(r.status.padEnd(9))} ${r.service} ${r.type} ${chalk.bold(r.name)}`);
    for (const reason of r.reasons) logger.info(chalk.dim(`             ${reason}`));
  }
  const counts = results.reduce<Record<string, number>>(
    (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
    {},
  );
  logger.info(
    `\n  ${Object.entries(counts)
      .map(([status, n]) => `${n} ${status}`)
      .join(', ')}`,
  );
}

const program = new Command()
  .name('cloudfork')
  .description('Fork your real AWS account into Floci, the free local AWS emulator.')
  .version(version)
  .option('--verbose', 'show detailed progress');

function loggerFor(): Logger {
  return createLogger({ verbose: Boolean(program.opts().verbose) });
}

program
  .command('scan')
  .description('read your AWS account (read-only) and save its configuration to a snapshot')
  .option('--profile <aws-profile>', 'AWS profile to read from (default: the standard credential chain)')
  .option('--region <region>', 'region to scan (default: the profile region)')
  .option(
    '--services <list>',
    `comma-separated services (default: ${SUPPORTED_SERVICES.join(',')})`,
    parseServices,
  )
  .option('--sample <n>', 'also copy up to N masked items per table / objects per bucket')
  .option('--out <file>', 'snapshot file to write', DEFAULT_SNAPSHOT_FILE)
  .action(
    async (opts: {
      profile?: string;
      region?: string;
      services?: ServiceName[];
      sample?: string;
      out: string;
    }) => {
      const logger = loggerFor();
      if (opts.sample !== undefined) throw new UsageError('--sample is not implemented yet.');
      const services = opts.services ?? SUPPORTED_SERVICES;
      const unsupported = services.filter((s) => !SUPPORTED_SERVICES.includes(s));
      if (unsupported.length) throw new UsageError(`Not implemented yet: ${unsupported.join(', ')}.`);

      const region = opts.region ?? (await resolveRegion(opts.profile));
      if (!region) throw new UsageError('No region configured for this profile. Pass --region.');

      const session = createSourceSession({ region, ...(opts.profile ? { profile: opts.profile } : {}) });
      const spinner = logger.spinner(`Scanning ${services.join(', ')} in ${region} (read-only)`);
      try {
        const { snapshot, results } = await scan({
          session,
          services,
          salt: await loadOrCreateSalt(),
          logger,
        });
        await writeSnapshot(opts.out, snapshot);
        spinner.succeed(`Wrote ${opts.out}`);
        printResults(logger, results);
      } catch (err) {
        spinner.fail('Scan failed');
        throw err;
      } finally {
        session.destroy();
      }
    },
  );

program
  .command('up')
  .description('recreate a snapshot inside Floci')
  .option('--snapshot <file>', 'snapshot to recreate', DEFAULT_SNAPSHOT_FILE)
  .option('--endpoint <url>', 'Floci endpoint', DEFAULT_ENDPOINT)
  .option('--account <id>', 'Floci account ID for the twin', DEFAULT_TWIN_ACCOUNT)
  .action(async (opts: { snapshot: string; endpoint: string; account: string }) => {
    const logger = loggerFor();
    const snapshot = await readSnapshot(opts.snapshot);
    const session = createTargetSession({
      endpoint: opts.endpoint,
      accountId: opts.account,
      region: snapshot.region,
    });
    const spinner = logger.spinner(
      `Recreating ${opts.snapshot} in ${session.endpoint.host} (account ${opts.account})`,
    );
    try {
      const results = await up({ snapshot, session, logger });
      spinner.succeed(`Twin ready at ${session.endpoint.origin}, account ${opts.account}`);
      printResults(logger, results);
    } catch (err) {
      spinner.fail('up failed');
      throw err;
    } finally {
      session.destroy();
    }
  });

const SAFE_ERRORS = [
  UsageError,
  TargetGuardError,
  ReadOnlyViolationError,
  SnapshotValidationError,
  SnapshotNotFoundError,
];

/** SDK credential errors name the profile and config files, never secrets, and say how to fix it. */
const SAFE_ERROR_NAMES = new Set(['CredentialsProviderError', 'TokenProviderError']);

program.parseAsync().catch((err: unknown) => {
  const logger = loggerFor();
  if (
    SAFE_ERRORS.some((E) => err instanceof E) ||
    err instanceof InvalidArgumentError ||
    (err instanceof Error && SAFE_ERROR_NAMES.has(err.name))
  ) {
    logger.error((err as Error).message);
  } else if (err instanceof Error) {
    // AWS error messages can include ARNs and principals; show them only on request.
    logger.error(
      program.opts().verbose
        ? `${err.name}: ${err.message}`
        : `${err.name} (rerun with --verbose for details)`,
    );
  } else {
    logger.error('Unknown error');
  }
  process.exitCode = 1;
});
