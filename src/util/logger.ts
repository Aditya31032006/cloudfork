import chalk from 'chalk';
import ora, { type Ora } from 'ora';

/**
 * Rule 6: logs show resource names only, never credentials or data values. Callers pass
 * messages they composed themselves; raw AWS error messages are never forwarded here.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Only shown with --verbose. */
  debug(message: string): void;
  spinner(text: string): Spinner;
}

export interface Spinner {
  update(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

export function createLogger(options: { verbose?: boolean } = {}): Logger {
  return {
    info: (m) => console.error(m),
    warn: (m) => console.error(chalk.yellow(m)),
    error: (m) => console.error(chalk.red(m)),
    debug: (m) => {
      if (options.verbose) console.error(chalk.dim(m));
    },
    spinner: (text) => {
      const s: Ora = ora({ text, stream: process.stderr }).start();
      return {
        update: (t) => {
          s.text = t;
        },
        succeed: (t) => void s.succeed(t),
        fail: (t) => void s.fail(t),
        stop: () => void s.stop(),
      };
    },
  };
}

const noop = () => {};

export const silentLogger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  spinner: () => ({ update: noop, succeed: noop, fail: noop, stop: noop }),
};
