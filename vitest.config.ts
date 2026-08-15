import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths({
    projects: [
      './tsconfig.vitest.json',
    ],
  })],
  server: {
    deps: {
      // Transform the @deepseek-ai SDK packages through Vite so their CSS
      // imports (KaTeX theme sheets etc.) are stripped instead of being
      // loaded by Node as raw files.
      inline: [/@deepseek-ai\//],
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    pool: 'forks',
    environment: 'node',
    css: false,
  },
})
