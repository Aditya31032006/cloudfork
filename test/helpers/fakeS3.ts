import type { S3Client } from '@aws-sdk/client-s3';
import { vi } from 'vitest';

export function awsError(name: string): Error {
  const err = new Error(`${name} (message that must never be logged)`);
  err.name = name;
  return err;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (input: any) => unknown;

/** A stand-in S3 client: each operation is answered by a handler; unknown operations throw NotImplemented. */
export function fakeS3(handlers: Record<string, Handler>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: { op: string; input: any }[] = [];
  const send = vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
    const op = command.constructor.name.replace(/Command$/, '');
    calls.push({ op, input: command.input });
    const handler = handlers[op];
    if (!handler) throw awsError('NotImplemented');
    return handler(command.input);
  });
  return { client: { send } as unknown as S3Client, calls, ops: () => calls.map((c) => c.op) };
}
