import { defineConfig } from '@playwright/test';

const WEB = 'http://localhost:5173';
const API = 'http://localhost:3001';

/**
 * Browser tests against the real thing: the Vite dev server, the API, and LocalStack (S3, DynamoDB and the
 * worker Lambda). LocalStack must be up with the stack deployed first (`npm run localstack:up` and
 * `npm run localstack:deploy`, which also writes .env.local for the API).
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // One browser at a time: the tests share one API and one LocalStack.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      name: 'API',
      // The smallest part size S3 allows, so a few MiB is already several parts.
      // Run from the API's folder so tsx finds its tsconfig (decorators), as `npm run dev` does.
      command: 'npx tsx --env-file=../../.env.local src/main.ts',
      cwd: '../apps/api',
      url: `${API}/health`,
      env: { PART_SIZE_BYTES: String(5 * 1024 * 1024), SSE_POLL_MS: '500' },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      name: 'Web',
      command: 'npm run dev -w @s3up/web',
      cwd: '..',
      url: WEB,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
