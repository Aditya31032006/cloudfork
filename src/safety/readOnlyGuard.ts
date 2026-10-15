import type { HandlerExecutionContext, MiddlewareStack } from '@smithy/types';

/**
 * Rule 1: the source (real AWS) side may only call List*, Get* and Describe* operations.
 *
 * The IAM policy in iam/readonly-policy.json is the real guarantee. This guard is the second
 * layer: it runs before serialization, so a forbidden call never leaves the process.
 */

const READ_PREFIX = /^(List|Get|Describe)[A-Z]/;

/** Reads that return secret material or mint credentials. Names are copied, values never (rule 3). */
export const DENIED_READS: ReadonlySet<string> = new Set([
  'GetSecretValue', // Secrets Manager
  'GetParameter', // SSM: DescribeParameters lists names without values
  'GetParameters',
  'GetParametersByPath',
  'GetParameterHistory',
  'GetPasswordData', // EC2 Windows admin password
  'GetSessionToken', // STS: mints credentials
  'GetFederationToken',
  'GetRoleCredentials', // SSO
  'GetCredentialsForIdentity', // Cognito Identity
  'GetOpenIdToken',
  'GetAuthorizationToken', // ECR / CodeArtifact
  'GetClusterCredentials', // Redshift: creates temporary DB users
  'GetClusterCredentialsWithIAM',
]);

export interface ReadOnlyGuardOptions {
  /** DynamoDB Scan is needed for `--sample`; it is allowed only when sampling is enabled. */
  allowDynamoDbScan?: boolean;
}

export class ReadOnlyViolationError extends Error {
  override readonly name = 'ReadOnlyViolationError';
  constructor(
    readonly operation: string,
    readonly clientName: string,
  ) {
    super(
      `Blocked ${clientName}.${operation}: cloudfork's source client is read-only ` +
        `(only List*, Get* and Describe* operations are allowed).`,
    );
  }
}

/** `ListBucketsCommand` → `ListBuckets`. */
export function operationName(commandName: string): string {
  return commandName.endsWith('Command') ? commandName.slice(0, -'Command'.length) : commandName;
}

export function isReadOnlyOperation(
  clientName: string,
  operation: string,
  options: ReadOnlyGuardOptions = {},
): boolean {
  if (DENIED_READS.has(operation)) return false;
  if (READ_PREFIX.test(operation)) return true;
  return operation === 'Scan' && clientName === 'DynamoDBClient' && options.allowDynamoDbScan === true;
}

export function assertReadOnly(
  clientName: string | undefined,
  commandName: string | undefined,
  options: ReadOnlyGuardOptions = {},
): void {
  // Fail closed: a call we can't identify is a call we don't allow.
  const client = clientName ?? 'UnknownClient';
  const operation = commandName ? operationName(commandName) : 'UnknownOperation';
  if (!clientName || !commandName || !isReadOnlyOperation(client, operation, options)) {
    throw new ReadOnlyViolationError(operation, client);
  }
}

export const READ_ONLY_GUARD_NAME = 'cloudforkReadOnlyGuard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = { middlewareStack: MiddlewareStack<any, any> };

export function applyReadOnlyGuard<C extends AnyClient>(client: C, options: ReadOnlyGuardOptions = {}): C {
  client.middlewareStack.add(
    (next, context: HandlerExecutionContext) => async (args) => {
      assertReadOnly(context.clientName, context.commandName, options);
      return next(args);
    },
    { step: 'initialize', priority: 'high', name: READ_ONLY_GUARD_NAME },
  );
  return client;
}
