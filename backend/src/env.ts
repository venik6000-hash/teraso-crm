import { z } from 'zod'

const booleanStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

/**
 * Placeholders that must never survive into a production runtime. They are shared
 * by every secret this file validates, so a value documented in .env.example cannot
 * be promoted by accident.
 */
const knownWeakSecrets = new Set([
  'replace-with-at-least-32-random-characters',
  'replace-with-a-long-random-webhook-secret',
])

/**
 * Length floor for the site webhook secret, in every environment. It guards the
 * only unauthenticated public write endpoint in the system: an attacker who
 * captures one legitimate (timestamp, body, signature) triple can brute-force a
 * short key offline and then inject arbitrary signed leads, so a weak secret must
 * fail at boot rather than at exploitation time. Production additionally requires a
 * generated secret — see validateWebhookSecret.
 */
const TERASO_WEBHOOK_SECRET_MIN_LENGTH = 32

/**
 * Defaults for the optional Teraso webhook limits, applied where the config is
 * consumed (app.ts) rather than in the schema, so adding these tunables does not
 * force every hand-built AppEnv test literal to restate them. Five minutes matches
 * PRD 8's replay window; 64KB matches the auth body limit.
 */
export const WEBHOOK_MAX_AGE_SECONDS_DEFAULT = 300
export const WEBHOOK_BODY_LIMIT_BYTES_DEFAULT = 64 * 1024

const optionalStringSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}, z.string().min(1).optional())

const optionalUrlSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}, z.string().url().optional())

const optionalHttpHeaderNameSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.toLowerCase()
}, z.string().regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/).optional())

/**
 * An optional secret with a length floor. Blank is normalized to "unset" (the
 * consumer decides how to fail closed); any non-blank value must clear the floor,
 * so a short secret is a boot failure rather than a silently weak deployment. The
 * message names the variable and never echoes its value.
 */
const optionalSecretSchema = (variableName: string, minimumLength: number) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }, z.string().min(minimumLength, `${variableName} must be at least ${minimumLength} characters`).optional())

const stringWithDefault = (defaultValue: string) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }, z.string().min(1).default(defaultValue))

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:8081,http://localhost:19006')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  WEBAPP_ORIGIN: optionalUrlSchema,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().nonnegative().max(60).default(10),
  SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().int().positive().default(90),
  SESSION_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(7),
  AUTH_BODY_LIMIT_BYTES: z.coerce.number().int().positive().max(1024 * 1024).default(64 * 1024),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // Teraso site webhook (Task 5, PRD 8 and 10). The signing secret is server-only:
  // when it is unset the inbound route fail-closes and rejects every delivery with
  // 401, so an integration that is not configured yet still boots. A value that IS
  // set must clear the length floor here and, in production, the generated-secret
  // check in validateWebhookSecret. The two limits are optional and fall back to
  // their documented defaults (WEBHOOK_MAX_AGE_SECONDS_DEFAULT /
  // WEBHOOK_BODY_LIMIT_BYTES_DEFAULT) at the point of use in app.ts, so the many
  // hand-built test AppEnv literals need not restate them. The max age is bounded to
  // keep a stale-signature replay window small.
  TERASO_WEBHOOK_SECRET: optionalSecretSchema('TERASO_WEBHOOK_SECRET', TERASO_WEBHOOK_SECRET_MIN_LENGTH),
  TERASO_WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().positive().max(3600).optional(),
  TERASO_WEBHOOK_BODY_LIMIT_BYTES: z.coerce.number().int().positive().max(1024 * 1024).optional(),
  SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().positive().max(60).default(20),
  TRUST_PROXY: booleanStringSchema,
  TRUSTED_PROXY_CLIENT_IP_HEADER: optionalHttpHeaderNameSchema,
  TRUSTED_PROXY_CLIENT_IP_POSITION: z.enum(['first', 'last']).optional(),
  COOKIE_SECURE: booleanStringSchema,
  SPACES_REGION: optionalStringSchema,
  SPACES_BUCKET: optionalStringSchema,
  SPACES_ENDPOINT: optionalUrlSchema,
  SPACES_CDN_BASE_URL: optionalUrlSchema,
  SPACES_ACCESS_KEY_ID: optionalStringSchema,
  SPACES_SECRET_ACCESS_KEY: optionalStringSchema,
  SPACES_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  SPACES_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().max(7 * 24 * 60 * 60).default(15 * 60),
  SPACES_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().max(7 * 24 * 60 * 60).default(5 * 60),
  SPACES_PUBLIC_CACHE_CONTROL: stringWithDefault('public, max-age=31536000, immutable'),
}).superRefine((env, ctx) => {
  validateJwtSecret(env, ctx)
  validateWebhookSecret(env, ctx)
  validateProductionRuntime(env, ctx)
  validateCorsOrigins(env, ctx)
  validateWebappOrigin(env, ctx)
  validateSessionTtls(env, ctx)
  validateTrustedProxy(env, ctx)
  validateStorageEnv(env, ctx)
})

export type AppEnv = z.infer<typeof envSchema>

export function loadEnv(source: Record<string, string | undefined>) {
  return envSchema.parse(source)
}

function validateWebappOrigin(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (!env.WEBAPP_ORIGIN) return

  const url = new URL(env.WEBAPP_ORIGIN)
  if (!['http:', 'https:'].includes(url.protocol)) {
    ctx.addIssue({
      code: 'custom',
      path: ['WEBAPP_ORIGIN'],
      message: 'WEBAPP_ORIGIN must use http or https',
    })
  }
  if (url.origin !== env.WEBAPP_ORIGIN) {
    ctx.addIssue({
      code: 'custom',
      path: ['WEBAPP_ORIGIN'],
      message: 'WEBAPP_ORIGIN must contain an origin only, not a path',
    })
  }
  if ((env.COOKIE_SECURE || env.NODE_ENV === 'production') && url.protocol !== 'https:') {
    ctx.addIssue({
      code: 'custom',
      path: ['WEBAPP_ORIGIN'],
      message: 'WEBAPP_ORIGIN must use HTTPS in production',
    })
  }
}

function validateSessionTtls(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (env.SESSION_ABSOLUTE_TTL_DAYS < env.REFRESH_TOKEN_TTL_DAYS) {
    ctx.addIssue({
      code: 'custom',
      path: ['SESSION_ABSOLUTE_TTL_DAYS'],
      message: 'SESSION_ABSOLUTE_TTL_DAYS must be at least REFRESH_TOKEN_TTL_DAYS',
    })
  }
}

function validateTrustedProxy(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (env.TRUST_PROXY && !env.TRUSTED_PROXY_CLIENT_IP_HEADER) {
    ctx.addIssue({
      code: 'custom',
      path: ['TRUSTED_PROXY_CLIENT_IP_HEADER'],
      message: 'TRUSTED_PROXY_CLIENT_IP_HEADER is required when TRUST_PROXY=true',
    })
  }

  if (env.TRUSTED_PROXY_CLIENT_IP_POSITION && !env.TRUSTED_PROXY_CLIENT_IP_HEADER) {
    ctx.addIssue({
      code: 'custom',
      path: ['TRUSTED_PROXY_CLIENT_IP_POSITION'],
      message: 'TRUSTED_PROXY_CLIENT_IP_POSITION requires TRUSTED_PROXY_CLIENT_IP_HEADER',
    })
  }
}

function validateJwtSecret(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (!isProductionLikeRuntime(env)) return

  if (!isGeneratedSecret(env.JWT_SECRET)) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: 'JWT_SECRET must be a non-placeholder random secret in production',
    })
  }
}

/**
 * The site webhook secret gets the same production treatment as JWT_SECRET, for a
 * sharper reason: it authenticates the only unauthenticated public write endpoint
 * in the system (PRD 8), so a guessable value lets an attacker inject arbitrary
 * signed leads — creating clients, deals and tasks and poisoning attribution.
 *
 * An UNSET secret is deliberately not an error: the inbound route fails closed and
 * rejects every delivery, so a deployment that has not wired up the site yet still
 * boots. It is a secret that is set but weak which must stop the process here,
 * rather than surface at exploitation time. The length floor is enforced by the
 * field schema in every environment; this adds the generated-value requirement.
 */
function validateWebhookSecret(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (!isProductionLikeRuntime(env)) return

  const secret = env.TERASO_WEBHOOK_SECRET
  if (secret === undefined) return

  if (!isGeneratedSecret(secret)) {
    ctx.addIssue({
      code: 'custom',
      path: ['TERASO_WEBHOOK_SECRET'],
      message:
        'TERASO_WEBHOOK_SECRET must be a non-placeholder random secret in production; generate one with `openssl rand -hex 32`',
    })
  }
}

function validateProductionRuntime(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (env.NODE_ENV !== 'production') return

  if (!env.COOKIE_SECURE) {
    ctx.addIssue({
      code: 'custom',
      path: ['COOKIE_SECURE'],
      message: 'COOKIE_SECURE must be true in production',
    })
  }
}

function isProductionLikeRuntime(env: z.infer<typeof envSchema>) {
  return env.NODE_ENV === 'production' || env.COOKIE_SECURE
}

/**
 * A secret that looks generated rather than typed: at least 64 hex characters (the
 * `openssl rand -hex 32` shape), not a documented placeholder, and not a single
 * repeated character. Shared by JWT_SECRET and TERASO_WEBHOOK_SECRET so both apply
 * one definition of "strong enough for production" instead of drifting apart.
 */
function isGeneratedSecret(secret: string) {
  return /^[a-fA-F0-9]{64,}$/.test(secret) && !isWeakSecret(secret)
}

function isWeakSecret(secret: string) {
  const normalized = secret.trim().toLowerCase()
  return (
    normalized.length === 0 ||
    knownWeakSecrets.has(normalized) ||
    new Set(normalized).size === 1
  )
}

function validateCorsOrigins(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (env.CORS_ORIGINS.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['CORS_ORIGINS'],
      message: 'CORS_ORIGINS must contain at least one allowed browser origin',
    })
    return
  }

  for (const origin of env.CORS_ORIGINS) {
    if (origin === '*') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must not use wildcard origins when credentials are enabled',
      })
      continue
    }

    let url: URL
    try {
      url = new URL(origin)
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS contains an invalid URL: ${origin}`,
      })
      continue
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must use http or https origins: ${origin}`,
      })
    }

    if (url.origin !== origin) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must contain origins only, not paths: ${origin}`,
      })
    }

    if ((env.COOKIE_SECURE || env.NODE_ENV === 'production') && url.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must use HTTPS when COOKIE_SECURE=true: ${origin}`,
      })
    }
  }
}

function validateStorageEnv(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  const requiredStorageKeys = [
    'SPACES_REGION',
    'SPACES_BUCKET',
    'SPACES_ENDPOINT',
    'SPACES_ACCESS_KEY_ID',
    'SPACES_SECRET_ACCESS_KEY',
  ] as const
  const storageConfigured =
    requiredStorageKeys.some((key) => env[key] !== undefined) || env.SPACES_CDN_BASE_URL !== undefined

  if (!storageConfigured) return

  for (const key of requiredStorageKeys) {
    if (env[key] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is required when DigitalOcean Spaces storage is configured`,
      })
    }
  }
}
