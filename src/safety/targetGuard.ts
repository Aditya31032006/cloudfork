import type { MiddlewareStack } from '@smithy/types';

/**
 * Rule 2: the target side may only talk to the explicitly configured Floci endpoint.
 *
 * Checked twice: once on the configured endpoint before any client exists, and again on every
 * outgoing request, so nothing the SDK resolves internally (redirects, ARN-based routing,
 * virtual-hosted buckets) can send a write to real AWS.
 */

const AWS_HOST_SUFFIXES = [
  'amazonaws.com',
  'amazonaws.com.cn',
  'amazonaws.eu',
  'api.aws', // dual-stack endpoints
  'on.aws', // Lambda function URLs
  'c2s.ic.gov',
  'sc2s.sgov.gov',
];

export class TargetGuardError extends Error {
  override readonly name = 'TargetGuardError';
}

export function isAwsHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, ''); // "s3.amazonaws.com." resolves too
  return AWS_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function assertSafeTargetEndpoint(endpoint: string | undefined): URL {
  if (!endpoint?.trim()) {
    throw new TargetGuardError(
      'No target endpoint configured. cloudfork only writes to an explicitly configured ' +
        'Floci endpoint, e.g. --endpoint http://localhost:4566.',
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TargetGuardError(`Target endpoint "${endpoint}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetGuardError(`Target endpoint must use http or https, got "${url.protocol}".`);
  }
  if (isAwsHost(url.hostname)) {
    throw new TargetGuardError(
      `Refusing to write to ${url.hostname}: that is a real AWS endpoint. ` +
        'cloudfork only writes to a local emulator such as Floci.',
    );
  }
  return url;
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

/** True if a request to hostname:port goes to the configured endpoint (subdomains allowed for S3). */
export function isAllowedTargetHost(allowed: URL, hostname: string, port: number | undefined): boolean {
  if (isAwsHost(hostname)) return false;
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  const allowedHost = allowed.hostname.toLowerCase();
  const hostMatches = host === allowedHost || host.endsWith(`.${allowedHost}`);
  const requestPort = port === undefined ? defaultPort(allowed.protocol) : String(port);
  const allowedPort = allowed.port || defaultPort(allowed.protocol);
  return hostMatches && requestPort === allowedPort;
}

export const TARGET_GUARD_NAME = 'cloudforkTargetGuard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = { middlewareStack: MiddlewareStack<any, any> };

interface RequestLike {
  hostname?: unknown;
  port?: unknown;
}

export function applyTargetGuard<C extends AnyClient>(client: C, allowed: URL): C {
  client.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as RequestLike | undefined;
      const hostname = typeof request?.hostname === 'string' ? request.hostname : undefined;
      const port = typeof request?.port === 'number' ? request.port : undefined;
      // Fail closed: a request without a recognisable host is not sent.
      if (!hostname || !isAllowedTargetHost(allowed, hostname, port)) {
        throw new TargetGuardError(
          `Blocked a request to ${hostname ?? 'an unknown host'}: the target client may only ` +
            `talk to ${allowed.host}.`,
        );
      }
      return next(args);
    },
    // Last step before the request is sent, after endpoint resolution and signing.
    { step: 'finalizeRequest', priority: 'low', name: TARGET_GUARD_NAME },
  );
  return client;
}
