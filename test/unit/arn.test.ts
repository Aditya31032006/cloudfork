import { describe, expect, it } from 'vitest';
import { detokenize, parseArn, tokenize, tokenizeString, type AccountContext } from '../../src/core/arn.js';
import { ACCOUNT_TOKEN, PARTITION_TOKEN, REGION_TOKEN } from '../../src/snapshot/schema.js';

const prod: AccountContext = { accountId: '111111111111', region: 'us-east-1', partition: 'aws' };
const twin: AccountContext = { accountId: '222222222222', region: 'us-east-1', partition: 'aws' };

describe('parseArn', () => {
  it('splits all six fields and keeps colons in the resource', () => {
    expect(parseArn('arn:aws:sqs:us-east-1:111111111111:kitchen-orders')).toEqual({
      partition: 'aws',
      service: 'sqs',
      region: 'us-east-1',
      account: '111111111111',
      resource: 'kitchen-orders',
    });
    expect(parseArn('arn:aws:lambda:us-east-1:111111111111:function:resize:live')?.resource).toBe(
      'function:resize:live',
    );
  });

  it('returns undefined for non-ARNs', () => {
    expect(parseArn('kitchen-orders')).toBeUndefined();
    expect(parseArn('arn:aws:s3')).toBeUndefined();
  });
});

describe('tokenizeString', () => {
  it('tokenizes partition, region and account in an ARN', () => {
    expect(tokenizeString('arn:aws:sqs:us-east-1:111111111111:kitchen-orders', prod)).toBe(
      `arn:${PARTITION_TOKEN}:sqs:${REGION_TOKEN}:${ACCOUNT_TOKEN}:kitchen-orders`,
    );
  });

  it('leaves S3 ARNs without region/account intact apart from the partition', () => {
    expect(tokenizeString('arn:aws:s3:::chaicart-photos/*', prod)).toBe(
      `arn:${PARTITION_TOKEN}:s3:::chaicart-photos/*`,
    );
  });

  it('leaves other accounts and regions alone', () => {
    expect(tokenizeString('arn:aws:sqs:eu-west-1:999999999999:partner-queue', prod)).toBe(
      `arn:${PARTITION_TOKEN}:sqs:eu-west-1:999999999999:partner-queue`,
    );
  });

  it('tokenizes the account inside names and bare principals', () => {
    expect(tokenizeString('cdk-hnb659fds-assets-111111111111-us-east-1', prod)).toBe(
      `cdk-hnb659fds-assets-${ACCOUNT_TOKEN}-us-east-1`,
    );
    expect(tokenizeString('111111111111', prod)).toBe(ACCOUNT_TOKEN);
  });

  it('only replaces whole 12-digit runs', () => {
    expect(tokenizeString('order-1111111111119', prod)).toBe('order-1111111111119');
    expect(tokenizeString('91111111111110', prod)).toBe('91111111111110');
  });

  it('never replaces 12-digit numbers other than the source account', () => {
    for (const other of ['123456789012', '111111111112', '011111111111', '222222222222']) {
      expect(tokenizeString(other, prod)).toBe(other);
      expect(tokenizeString(`arn:aws:iam::${other}:root`, prod)).toBe(
        `arn:${PARTITION_TOKEN}:iam::${other}:root`,
      );
      expect(tokenizeString(`invoice-${other}`, prod)).toBe(`invoice-${other}`);
    }
  });

  it('refuses a source account that is not a 12-digit ID', () => {
    expect(() => tokenizeString('x', { ...prod, accountId: '.*' })).toThrow(/12 digits/);
  });

  it('does not tokenize region names outside ARNs', () => {
    expect(tokenizeString('logs-us-east-1', prod)).toBe('logs-us-east-1');
  });

  it('leaves IAM policy variables alone', () => {
    expect(tokenizeString('arn:aws:s3:::bucket/${aws:username}/*', prod)).toBe(
      `arn:${PARTITION_TOKEN}:s3:::bucket/\${aws:username}/*`,
    );
  });
});

describe('tokenize / detokenize', () => {
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['arn:aws:iam::111111111111:root', '999999999999'] },
        Action: 's3:GetObject',
        Resource: 'arn:aws:s3:::chaicart-photos/*',
        Condition: { StringEquals: { 'aws:SourceAccount': '111111111111' } },
      },
    ],
  };

  it('removes every occurrence of the source account ID', () => {
    const tokenized = tokenize(policy, prod);
    expect(JSON.stringify(tokenized)).not.toContain('111111111111');
    expect(JSON.stringify(tokenized)).toContain('999999999999');
  });

  it('rewrites a prod policy into the twin account', () => {
    const rewritten = detokenize(tokenize(policy, prod), twin);
    expect(rewritten.Statement[0]?.Principal.AWS).toEqual(['arn:aws:iam::222222222222:root', '999999999999']);
    expect(rewritten.Statement[0]?.Condition.StringEquals['aws:SourceAccount']).toBe('222222222222');
  });

  it('round-trips when the twin is the source', () => {
    expect(detokenize(tokenize(policy, prod), prod)).toEqual(policy);
  });

  it('makes prod and twin config identical once both are tokenized', () => {
    const twinPolicy = detokenize(tokenize(policy, prod), twin);
    expect(tokenize(twinPolicy, twin)).toEqual(tokenize(policy, prod));
  });

  it('rewrites a GovCloud source into the twin partition', () => {
    const gov: AccountContext = {
      accountId: '111111111111',
      region: 'us-gov-west-1',
      partition: 'aws-us-gov',
    };
    const arn = 'arn:aws-us-gov:sqs:us-gov-west-1:111111111111:q';
    expect(detokenize(tokenize(arn, gov), { ...twin, region: 'us-gov-west-1' })).toBe(
      'arn:aws:sqs:us-gov-west-1:222222222222:q',
    );
  });

  it('tokenizes object keys too (e.g. tag keys)', () => {
    expect(tokenize({ 'owner-111111111111': 'x' }, prod)).toEqual({ [`owner-${ACCOUNT_TOKEN}`]: 'x' });
  });

  it('leaves numbers, booleans and null untouched', () => {
    expect(tokenize({ a: 111111111111, b: true, c: null }, prod)).toEqual({
      a: 111111111111,
      b: true,
      c: null,
    });
  });
});
