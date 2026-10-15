import { ACCOUNT_TOKEN, PARTITION_TOKEN, REGION_TOKEN } from '../snapshot/schema.js';

/** The account a set of resources belongs to: the source at scan time, the twin at up time. */
export interface AccountContext {
  accountId: string;
  region: string;
  partition: string;
}

export interface Arn {
  partition: string;
  service: string;
  region: string;
  account: string;
  resource: string;
}

const ARN_PATTERN = /^arn:([^:]*):([^:]*):([^:]*):([^:]*):(.*)$/s;

export function parseArn(value: string): Arn | undefined {
  const match = ARN_PATTERN.exec(value);
  if (!match) return undefined;
  const [, partition = '', service = '', region = '', account = '', resource = ''] = match;
  return { partition, service, region, account, resource };
}

export function formatArn(arn: Arn): string {
  return ['arn', arn.partition, arn.service, arn.region, arn.account, arn.resource].join(':');
}

/** Matches only this exact account ID, never other 12-digit numbers or part of a longer number. */
function accountPattern(accountId: string): RegExp {
  if (!/^\d{12}$/.test(accountId)) throw new Error('AWS account IDs are 12 digits.');
  return new RegExp(`(?<!\\d)${accountId}(?!\\d)`, 'g');
}

/**
 * Replaces the source account everywhere in a string (ARNs, bare principals, names such as
 * `cdk-assets-123456789012-us-east-1`) and, inside ARNs, the source region and partition.
 * Other accounts' IDs (cross-account principals) are left alone.
 */
export function tokenizeString(value: string, source: AccountContext): string {
  let out = value;
  const arn = parseArn(out);
  if (arn) {
    out = formatArn({
      ...arn,
      partition: arn.partition === source.partition ? PARTITION_TOKEN : arn.partition,
      region: arn.region === source.region ? REGION_TOKEN : arn.region,
    });
  }
  return out.replace(accountPattern(source.accountId), ACCOUNT_TOKEN);
}

export function detokenizeString(value: string, target: AccountContext): string {
  return value
    .replaceAll(ACCOUNT_TOKEN, target.accountId)
    .replaceAll(REGION_TOKEN, target.region)
    .replaceAll(PARTITION_TOKEN, target.partition);
}

/** Applies `fn` to every string (values and object keys) in a JSON-like value. */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fn(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, child]) => [fn(k), walk(child)]));
    }
    return v;
  };
  return walk(value) as T;
}

export function tokenize<T>(value: T, source: AccountContext): T {
  return mapStrings(value, (s) => tokenizeString(s, source));
}

export function detokenize<T>(value: T, target: AccountContext): T {
  return mapStrings(value, (s) => detokenizeString(s, target));
}
