import type { ServiceModule } from '../types.js';
import { readS3 } from './reader.js';
import { planS3 } from './writer.js';

export const s3Module: ServiceModule<'s3'> = {
  name: 's3',
  read: readS3,
  plan: planS3,
};
