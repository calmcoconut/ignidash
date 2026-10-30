import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  { ignores: ['convex/_generated/**', 'convex/betterAuth/_generated/**'] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  ...compat.extends('prettier'),
  {
    // Determinism: a simulation run must be a pure function of its inputs plus an explicit
    // clock (see src/lib/calc/clock.ts). Wall-clock reads are banned under src/lib/calc and
    // src/lib/schemas; resolve a Clock at the store boundary instead
    // (src/lib/utils/system-clock.ts is the app's single wall-clock read).
    // `new Date(year, month, day)` and other argument-taking constructions stay legal.
    files: ['src/lib/calc/**/*.{ts,tsx}', 'src/lib/schemas/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Do not read the wall clock with new Date() under src/lib/calc or src/lib/schemas. Take an explicit Clock (src/lib/calc/clock.ts) instead; resolve it at the store boundary.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'Do not read the wall clock with Date.now() under src/lib/calc or src/lib/schemas. Take an explicit Clock (src/lib/calc/clock.ts) instead; resolve it at the store boundary.',
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          args: 'none',
        },
      ],
    },
  },
];

export default eslintConfig;
