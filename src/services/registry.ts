import type { ServiceName } from '../snapshot/schema.js';
import { s3Module } from './s3/index.js';
import type { ServiceModule } from './types.js';

/** Services with a reader and writer. DynamoDB and SQS land in phase 2. */
export const SERVICE_MODULES: { [K in ServiceName]?: ServiceModule<K> } = {
  s3: s3Module,
};

export const SUPPORTED_SERVICES = Object.keys(SERVICE_MODULES) as ServiceName[];

export function serviceModule<K extends ServiceName>(name: K): ServiceModule<K> | undefined {
  return SERVICE_MODULES[name] as ServiceModule<K> | undefined;
}
