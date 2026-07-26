import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { e2eWebhookSecret } from './e2e/env'
import { applyE2ePortEnv, resolveE2ePorts } from './e2e/ports'

const frontendRoot = fileURLToPath(new URL('.', import.meta.url))
const repositoryRoot = resolve(frontendRoot, '..')
const backendRoot = resolve(repositoryRoot, 'backend')

const portPlan = await resolveE2ePorts()
applyE2ePortEnv(portPlan)

const backendPort = portPlan.backendPort
const frontendPort = portPlan.webPort
const backendUrl = portPlan.backendUrl
const frontendUrl = portPlan.webUrl
const databaseUrl = portPlan.databaseUrl

function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

const backendEnv = normalizeEnv({
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(backendPort),
  DATABASE_URL: databaseUrl,
  JWT_SECRET:
    process.env.JWT_SECRET ?? 'web-e2e-secret-at-least-thirty-two-characters',
  CORS_ORIGINS: [frontendUrl, 'http://localhost:5173'].join(','),
  COOKIE_SECURE: 'false',
  // The CRM journey posts a signed lead to the site webhook, so the test
  // backend has to be configured to accept one. Without a secret the endpoint
  // correctly fails closed and rejects every delivery with 401.
  TERASO_WEBHOOK_SECRET: process.env.TERASO_WEBHOOK_SECRET ?? e2eWebhookSecret,
  /**
   * A wider auth rate-limit bucket for the test backend only.
   *
   * The limiter meters `/api/auth/*` per IP, and that includes every token
   * refresh, so a full suite — several accounts registering, signing in,
   * restoring sessions in two tabs and walking a deal through the funnel —
   * exhausts the production default of 60/minute from a single loopback
   * address. The result is a 429 in the middle of an unrelated assertion.
   *
   * This does NOT weaken the limiter: its behaviour, including the 429, is
   * covered by the backend integration tests, which exercise it at the real
   * default. Raising it here removes a test artefact that no real user can
   * produce, exactly as the CRM and notification integration suites already do.
   */
  AUTH_RATE_LIMIT_MAX: process.env.AUTH_RATE_LIMIT_MAX ?? '600',
})

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e/specs',
  outputDir: './e2e/.artifacts/test-results',
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/.artifacts/report' }]],
  use: {
    baseURL: frontendUrl,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      name: 'backend',
      command: 'bun run start',
      cwd: backendRoot,
      env: backendEnv,
      url: `${backendUrl}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      name: 'web',
      command: `bun run dev --host 127.0.0.1 --port ${frontendPort}`,
      cwd: frontendRoot,
      env: normalizeEnv({
        ...process.env,
        VITE_API_URL: backendUrl,
      }),
      url: frontendUrl,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
