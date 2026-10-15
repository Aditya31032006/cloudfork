import type { ServiceName } from '../snapshot/schema.js';

export type ScanStatus = 'captured' | 'partial' | 'skipped';
export type UpStatus = 'recreated' | 'partial' | 'skipped';

export interface ResourceRef {
  service: ServiceName;
  /** e.g. `bucket`, `bucket-notifications`, `object`. */
  type: string;
  name: string;
}

export interface ResourceResult<S extends string> extends ResourceRef {
  status: S;
  /** Why the resource is partial or skipped. Names only, never values (rule 6). */
  reasons: string[];
}

export type ScanResult = ResourceResult<ScanStatus>;
export type UpResult = ResourceResult<UpStatus>;

export function result<S extends string>(
  ref: ResourceRef,
  status: S,
  reasons: string[] = [],
): ResourceResult<S> {
  return { ...ref, status, reasons };
}

/**
 * The AWS error code (`AccessDenied`, `NoSuchBucket`), never the message: AWS error messages
 * can contain ARNs, principals and request details.
 */
export function errorCode(err: unknown): string {
  if (err instanceof Error && err.name && err.name !== 'Error') return err.name;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status ? `HTTP ${status}` : 'UnknownError';
}

const UNSUPPORTED_CODES = new Set(['NotImplemented', 'NotSupported', 'UnsupportedOperation', 'HTTP 501']);

/** Human-readable reason for a failed write, distinguishing emulator gaps from other errors. */
export function writeFailure(what: string, err: unknown): string {
  const code = errorCode(err);
  return UNSUPPORTED_CODES.has(code)
    ? `${what}: not supported by the emulator (${code})`
    : `${what}: failed (${code})`;
}
