import { extname } from 'node:path';
import { result, type ScanResult } from '../../core/result.js';

/**
 * Chooses which objects `--sample N` copies. Only text formats can be PII-masked, so binaries
 * (images, archives, unknown types) are skipped, and every skip is reported with a reason.
 * Copying itself is done by the S3 reader in phase 2, always through masking/pii.ts.
 */

export const MAX_SAMPLE_OBJECT_BYTES = 5 * 1024 * 1024;

export const MASKABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.json',
  '.jsonl',
  '.ndjson',
  '.csv',
  '.tsv',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
  '.md',
  '.log',
  '.html',
  '.htm',
]);

export interface ListedObject {
  key: string;
  size: number;
}

export interface SamplePlan {
  copy: ListedObject[];
  skipped: ScanResult[];
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Why an object can't be sampled, or undefined if it can. */
export function sampleSkipReason(object: ListedObject): string | undefined {
  if (object.key.endsWith('/') && object.size === 0) return 'folder placeholder with no content';
  const ext = extname(object.key).toLowerCase();
  if (!MASKABLE_EXTENSIONS.has(ext)) {
    return `${ext ? `${ext} files are` : 'files without an extension are'} treated as binary and can't be PII-masked`;
  }
  if (object.size > MAX_SAMPLE_OBJECT_BYTES) {
    return `${megabytes(object.size)} MB is over the ${megabytes(MAX_SAMPLE_OBJECT_BYTES)} MB sample limit`;
  }
  return undefined;
}

/**
 * Walks the listing in order until `limit` objects are chosen. Every object visited is either
 * chosen or reported as skipped; objects after the limit is reached are outside the sample.
 */
export function planObjectSample(
  bucket: string,
  objects: readonly ListedObject[],
  limit: number,
): SamplePlan {
  const plan: SamplePlan = { copy: [], skipped: [] };
  for (const object of objects) {
    if (plan.copy.length >= limit) break;
    const reason = sampleSkipReason(object);
    if (reason) {
      plan.skipped.push(
        result({ service: 's3', type: 'object', name: `${bucket}/${object.key}` }, 'skipped', [reason]),
      );
    } else {
      plan.copy.push(object);
    }
  }
  return plan;
}
