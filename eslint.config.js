import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Rule 6: all output goes through util/logger.ts, which only prints resource names.
      'no-console': 'error',
    },
  },
  {
    files: ['src/util/logger.ts', 'examples/**', 'test/**'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
