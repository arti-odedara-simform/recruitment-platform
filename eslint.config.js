import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      /**
       * The rule that makes PLAN.md §1 hold: no route handler or service may reach the
       * Prisma client directly. Everything goes through a repository that takes an
       * `actor`, so there is no code path that fetches a wide candidate row and trims
       * it afterwards — the serializer never receives the wide shape.
       */
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/client', '**/db/client.js'],
              message:
                'Import the Prisma client only from src/repositories/**. Route handlers ' +
                'and services must go through a scoped repository that takes an actor ' +
                '(PLAN.md §1).',
            },
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // The repositories are the sanctioned home of Prisma access. The process
    // entrypoints are exempt only because they own the pool lifecycle and need the
    // disconnect helper: server.ts for graceful shutdown, the two seed scripts to close
    // the pool when they finish. None of them reads domain data through the client —
    // their writes go through src/repositories/** like everything else.
    files: [
      'src/repositories/**/*.ts',
      'src/db/**/*.ts',
      'src/server.ts',
      'src/seed.ts',
      'src/seed-scale.ts',
      'src/db-rls.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', '*.config.ts', 'prisma.config.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
