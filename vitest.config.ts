import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    // Order matters: the first matching alias wins, so the more specific `@/convex` has to come
    // before `@`, or `@/convex/...` is rewritten to `src/convex/...` and never resolves.
    alias: [
      { find: '@/convex', replacement: resolve(__dirname, './convex') },
      { find: '@', replacement: resolve(__dirname, './src') },
    ],
  },
  test: {
    // `exclude` REPLACES `configDefaults.exclude` rather than extending it, so the defaults have to
    // be spread back in explicitly. Without them the suite loses `**/node_modules/**` (any depth — a
    // workspace's or Playwright's nested install, not just the root one) and `**/.git/**`, and a
    // stray `*.test.ts` in either would be collected. `e2e/**` is the project's own addition: the
    // Playwright specs match the default `*.spec.ts` include pattern but are not unit tests.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    server: { deps: { inline: ['convex-test'] } },
  },
});
