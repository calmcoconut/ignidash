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
    // src/lib/schemas; resolve a Clock at the store boundary or pass today's date from a UI
    // call site instead (src/lib/utils/system-clock.ts is the app's single wall-clock read).
    // `new Date(year, month, day)` and other argument-taking constructions stay legal.
    // The import ban closes the loophole of reaching that module directly: patterns cover the
    // `@/` alias and relative paths from any nested subdirectory, in every spelling a module
    // specifier can take — extensionless, and with the explicit `.ts`/`.js`/`.jsx`/`.tsx`
    // extension TypeScript's node16 ESM resolver expects. `'../../utils/system-clock.js'` used
    // to slip through because only the extensionless and `.ts` forms were listed.
    files: ['src/lib/calc/**/*.{ts,tsx}', 'src/lib/schemas/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/lib/utils/system-clock',
                '@/lib/utils/system-clock.js',
                '@/lib/utils/system-clock.ts',
                '**/utils/system-clock',
                '**/utils/system-clock.js',
                '**/utils/system-clock.jsx',
                '**/utils/system-clock.ts',
                '**/utils/system-clock.tsx',
                '../utils/system-clock',
                '../../utils/system-clock',
              ],
              message:
                'Do not import the wall clock into src/lib/calc or src/lib/schemas. Take an explicit Clock (src/lib/calc/clock.ts), or pass an explicit date in from the UI/store boundary (src/lib/utils/system-clock.ts).',
            },
          ],
        },
      ],
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
