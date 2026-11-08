import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const crdtPurityMessage = 'packages/crdt must stay pure (see AGENTS.md).';

const forbiddenGlobals = [
  'Date',
  'performance',
  'process',
  'Buffer',
  'require',
  '__dirname',
  '__filename',
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'console',
].map((name) => ({ name, message: `${name} is not allowed. ${crdtPurityMessage}` }));

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '.agent-local/**',
      '.opencode/**',
      '.tools/**',
      '.toolchain/**',
      '.venv/**',
      '.data/**',
      '.pnpm-store/**',
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Plain Node scripts: no type information, so the Node globals they use are declared here.
    files: ['apps/web/scripts/**/*.mjs', 'e2e/support/test-fixtures/**/*.mjs'],
    languageOptions: { globals: { Buffer: 'readonly', setTimeout: 'readonly' } },
  },
  {
    // Playwright fixtures take what they depend on as a destructured first parameter, which is
    // empty for a fixture that depends on nothing.
    files: ['e2e/**/*.ts'],
    rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
  },
  {
    // The CRDT library is pure: no DOM, no Node APIs, no I/O, no wall clock, no ambient randomness.
    files: ['packages/crdt/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...forbiddenGlobals],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: `Inject randomness instead. ${crdtPurityMessage}`,
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'fs/*', 'path', 'os', 'crypto', 'child_process', 'http'],
              message: `Node APIs are not allowed. ${crdtPurityMessage}`,
            },
            {
              group: ['@driftboard/*', 'react', 'react-dom', 'ws', 'better-sqlite3', 'zod'],
              message: `The CRDT library has zero runtime dependencies. ${crdtPurityMessage}`,
            },
          ],
        },
      ],
    },
  },
  prettier,
);
