import type { TargetSession } from '../aws/clients.js';
import { TWIN_PARTITION } from '../config.js';
import { serviceModule } from '../services/registry.js';
import type { WriteContext, WriteTask } from '../services/types.js';
import { SERVICE_NAMES, type Snapshot } from '../snapshot/schema.js';
import { silentLogger, type Logger } from '../util/logger.js';
import { detokenize, type AccountContext } from './arn.js';
import { errorCode, result, type UpResult } from './result.js';

export interface UpOptions {
  snapshot: Snapshot;
  session: TargetSession;
  logger?: Logger;
}

export function planUp(
  snapshot: Snapshot,
  ctx: WriteContext,
): { tasks: WriteTask[]; unsupported: UpResult[] } {
  const resources = detokenize(snapshot.resources, ctx.target);
  const tasks: WriteTask[] = [];
  const unsupported: UpResult[] = [];
  for (const name of SERVICE_NAMES) {
    const config = resources[name];
    if (!config) continue;
    const module = serviceModule(name);
    if (!module) {
      unsupported.push(
        result({ service: name, type: 'service', name }, 'skipped', ['service not supported yet']),
      );
      continue;
    }
    // `config` is the resources entry for `name`, so it matches the module's input type.
    tasks.push(...module.plan(config as never, ctx));
  }
  return { tasks, unsupported };
}

/** Recreates the snapshot in the twin. One failing resource never stops the run. */
export async function up(options: UpOptions): Promise<UpResult[]> {
  const logger = options.logger ?? silentLogger;
  const target: AccountContext = {
    accountId: options.session.accountId,
    region: options.snapshot.region,
    partition: TWIN_PARTITION,
  };
  const { tasks, unsupported } = planUp(options.snapshot, { session: options.session, target, logger });

  // Phase 1: tasks run in plan order (each planner emits dependencies first).
  // Phase 2 replaces this with a dependency graph that also detects cycles.
  const done = new Map<string, UpResult>();
  for (const task of tasks) {
    logger.debug(`${task.ref.service}: ${task.ref.type} ${task.ref.name}`);
    let outcome: UpResult;
    try {
      outcome = await task.run(done);
    } catch (err) {
      outcome = result(task.ref, 'skipped', [`unexpected error (${errorCode(err)})`]);
    }
    done.set(task.id, outcome);
  }
  return [...unsupported, ...done.values()];
}
