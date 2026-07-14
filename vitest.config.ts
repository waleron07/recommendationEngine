import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts', 'packages/*/src/index.ts'],
      reporter: ['text', 'lcov'],
      // The core is the load-bearing part; §21 sets its target at 95%.
      // Thresholds get raised as stages land, never lowered.
      thresholds: {
        'packages/core/src/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
})
