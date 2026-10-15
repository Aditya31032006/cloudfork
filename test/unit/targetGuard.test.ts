import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTargetSession } from '../../src/aws/clients.js';
import {
  applyTargetGuard,
  assertSafeTargetEndpoint,
  isAllowedTargetHost,
  isAwsHost,
  TargetGuardError,
} from '../../src/safety/targetGuard.js';

describe('assertSafeTargetEndpoint', () => {
  it.each([undefined, '', '   '])('requires an explicitly configured endpoint (%j)', (endpoint) => {
    expect(() => assertSafeTargetEndpoint(endpoint)).toThrow(/No target endpoint configured/);
  });

  it.each(['localhost:4566', 'not a url'])('rejects malformed endpoint %s', (endpoint) => {
    expect(() => assertSafeTargetEndpoint(endpoint)).toThrow(TargetGuardError);
  });

  it('rejects non-HTTP protocols', () => {
    expect(() => assertSafeTargetEndpoint('ftp://localhost:4566')).toThrow(/http or https/);
  });

  it.each([
    'https://s3.amazonaws.com',
    'https://S3.AmazonAWS.com.', // case and trailing dot
    'https://my-bucket.s3.us-east-1.amazonaws.com',
    'https://dynamodb.us-east-1.amazonaws.com:443',
    'https://sqs.cn-north-1.amazonaws.com.cn',
    'https://s3.dualstack.us-east-1.api.aws',
    'https://abc.lambda-url.us-east-1.on.aws',
    'http://amazonaws.com',
  ])('rejects real AWS endpoint %s', (endpoint) => {
    expect(() => assertSafeTargetEndpoint(endpoint)).toThrow(/real AWS endpoint/);
  });

  it.each(['http://localhost:4566', 'http://127.0.0.1:4566', 'http://floci:4566', 'https://floci.internal'])(
    'accepts emulator endpoint %s',
    (endpoint) => {
      expect(assertSafeTargetEndpoint(endpoint)).toBeInstanceOf(URL);
    },
  );

  it('does not treat look-alike domains as AWS', () => {
    expect(isAwsHost('notamazonaws.com')).toBe(false);
    expect(isAwsHost('amazonaws.com.example.org')).toBe(false);
  });
});

describe('isAllowedTargetHost', () => {
  const allowed = new URL('http://localhost:4566');

  it('allows the configured host and port', () => {
    expect(isAllowedTargetHost(allowed, 'localhost', 4566)).toBe(true);
  });

  it('allows virtual-hosted subdomains of the configured host', () => {
    expect(isAllowedTargetHost(allowed, 'my-bucket.localhost', 4566)).toBe(true);
  });

  it('rejects other ports and hosts', () => {
    expect(isAllowedTargetHost(allowed, 'localhost', 4567)).toBe(false);
    expect(isAllowedTargetHost(allowed, 'localhost', undefined)).toBe(false); // would be port 80
    expect(isAllowedTargetHost(allowed, 'example.com', 4566)).toBe(false);
  });

  it('rejects AWS hosts even on the configured port', () => {
    expect(isAllowedTargetHost(allowed, 's3.amazonaws.com', 4566)).toBe(false);
  });
});

describe('applyTargetGuard on a real SDK client', () => {
  it('blocks a request whose resolved host is real AWS, even if the guard was configured for Floci', async () => {
    const handle = vi.fn();
    // Simulates the SDK resolving somewhere other than the configured endpoint.
    const client = applyTargetGuard(
      new S3Client({
        region: 'us-east-1',
        credentials: { accessKeyId: '222222222222', secretAccessKey: 'x' },
        requestHandler: { handle },
      }),
      new URL('http://localhost:4566'),
    );
    await expect(client.send(new ListBucketsCommand({}))).rejects.toThrow(
      /Blocked a request to s3\.us-east-1\.amazonaws\.com/,
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it('lets requests to the configured endpoint through', async () => {
    const reached = new Error('reached the network layer');
    const handle = vi.fn(async () => {
      throw reached;
    });
    const client = applyTargetGuard(
      new S3Client({
        region: 'us-east-1',
        endpoint: 'http://localhost:4566',
        forcePathStyle: true,
        credentials: { accessKeyId: '222222222222', secretAccessKey: 'x' },
        requestHandler: { handle },
      }),
      new URL('http://localhost:4566'),
    );
    await expect(client.send(new ListBucketsCommand({}))).rejects.toBe(reached);
    expect(handle).toHaveBeenCalledOnce();
  });
});

describe('createTargetSession', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses an AWS endpoint before creating any client', () => {
    expect(() =>
      createTargetSession({
        endpoint: 'https://s3.amazonaws.com',
        accountId: '222222222222',
        region: 'us-east-1',
      }),
    ).toThrow(TargetGuardError);
  });

  it('refuses an unset endpoint', () => {
    expect(() =>
      createTargetSession({ endpoint: '', accountId: '222222222222', region: 'us-east-1' }),
    ).toThrow(TargetGuardError);
  });

  it('refuses account IDs that are not 12 digits', () => {
    expect(() =>
      createTargetSession({ endpoint: 'http://localhost:4566', accountId: '2222', region: 'us-east-1' }),
    ).toThrow(/12-digit/);
  });

  it('never uses real credentials from the environment', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAREALCREDENTIALS');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'real-secret');
    const session = createTargetSession({
      endpoint: 'http://localhost:4566',
      accountId: '222222222222',
      region: 'us-east-1',
    });
    const credentials = await session.s3().config.credentials();
    expect(credentials.accessKeyId).toBe('222222222222');
    expect(credentials.secretAccessKey).not.toBe('real-secret');
    session.destroy();
  });
});
