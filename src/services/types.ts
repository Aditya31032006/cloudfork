import type { z } from 'zod';
import type { SourceSession, TargetSession } from '../aws/clients.js';
import type { AccountContext } from '../core/arn.js';
import type { ResourceRef, ScanResult, UpResult } from '../core/result.js';
import type { ServiceName, SnapshotResources } from '../snapshot/schema.js';
import type { Logger } from '../util/logger.js';

/**
 * How a service plugs into cloudfork. Adding a service means writing a reader (real AWS →
 * snapshot config) and a planner that turns that config into write tasks for the twin.
 */

export type Captured<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ReadContext {
  session: SourceSession;
  region: string;
  logger: Logger;
  /** Tokenizes account IDs/ARNs and validates against the resource schema. */
  capture<T>(schema: z.ZodType<T>, raw: unknown): Captured<T>;
}

export interface ReadOutput<R> {
  resources: R;
  results: ScanResult[];
}

export interface WriteContext {
  session: TargetSession;
  target: AccountContext;
  logger: Logger;
}

export interface WriteTask {
  /** Stable ID such as `s3:bucket:chaicart-photos`, used for dependency ordering. */
  id: string;
  ref: ResourceRef;
  /** IDs of tasks that must run first. A missing dependency is the task's own problem to report. */
  dependsOn: string[];
  run(done: ReadonlyMap<string, UpResult>): Promise<UpResult>;
}

export interface ServiceModule<K extends ServiceName = ServiceName> {
  name: K;
  read(ctx: ReadContext): Promise<ReadOutput<NonNullable<SnapshotResources[K]>>>;
  plan(resources: NonNullable<SnapshotResources[K]>, ctx: WriteContext): WriteTask[];
}

export function taskId(service: ServiceName, type: string, name: string): string {
  return `${service}:${type}:${name}`;
}
