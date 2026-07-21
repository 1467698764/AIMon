import { defineConfig } from 'vitest/config'

process.env.NODE_ENV = 'test'
process.env.DATA_DIR = './data/test'
process.env.AIMON_SECRET = 'test-secret-for-aimon-unit-tests-only'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts'],
    restoreMocks: true,
  },
})
