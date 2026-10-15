import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { SnapshotSchema, type Snapshot, type SnapshotResources } from './schema.js';

export class SnapshotValidationError extends Error {
  override readonly name = 'SnapshotValidationError';
  constructor(
    readonly source: string,
    readonly details: string,
  ) {
    super(`Invalid snapshot (${source}):\n${details}`);
  }
}

export class SnapshotNotFoundError extends Error {
  override readonly name = 'SnapshotNotFoundError';
  constructor(readonly path: string) {
    super(`Snapshot ${path} not found. Run \`cloudfork scan\` first, or pass --snapshot <file>.`);
  }
}

export function parseSnapshot(data: unknown, source = 'snapshot'): Snapshot {
  const result = SnapshotSchema.safeParse(data);
  if (!result.success) throw new SnapshotValidationError(source, z.prettifyError(result.error));
  return result.data;
}

function compareNames(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Resources are sorted by name; arrays inside a resource keep their order (CORS rules are ordered). */
function sortResources(resources: SnapshotResources): SnapshotResources {
  const sorted: SnapshotResources = {};
  if (resources.s3) sorted.s3 = { buckets: [...resources.s3.buckets].sort(compareNames) };
  if (resources.dynamodb) sorted.dynamodb = { tables: [...resources.dynamodb.tables].sort(compareNames) };
  if (resources.sqs) sorted.sqs = { queues: [...resources.sqs.queues].sort(compareNames) };
  return sorted;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Canonical form: validated, keys sorted, resources sorted, 2-space indent, trailing newline. */
export function serializeSnapshot(snapshot: Snapshot): string {
  const valid = parseSnapshot(snapshot);
  return `${JSON.stringify(sortKeys({ ...valid, resources: sortResources(valid.resources) }), null, 2)}\n`;
}

export async function writeSnapshot(path: string, snapshot: Snapshot): Promise<void> {
  const text = serializeSnapshot(snapshot);
  // Write-then-rename so an interrupted run never leaves a half-written snapshot behind.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, path);
}

export async function readSnapshot(path: string): Promise<Snapshot> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SnapshotNotFoundError(path);
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SnapshotValidationError(path, 'file is not valid JSON');
  }
  return parseSnapshot(data, path);
}
