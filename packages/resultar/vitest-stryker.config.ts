import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { 'vite-plus/test': 'vitest' } },
  test: { globals: true, include: ['tests/**/*.test.ts'] },
})
