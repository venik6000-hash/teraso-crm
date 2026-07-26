import { describe, expect, test } from 'bun:test'

import { loadEnv } from './env'

describe('loadEnv', () => {
  test('parses defaults and comma-separated origins', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
      JWT_SECRET: '12345678901234567890123456789012',
      CORS_ORIGINS: 'http://localhost:5173, http://localhost:8081',
    })

    expect(env.PORT).toBe(3000)
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900)
    expect(env.REFRESH_REUSE_GRACE_SECONDS).toBe(10)
    expect(env.SESSION_ABSOLUTE_TTL_DAYS).toBe(90)
    expect(env.COOKIE_SECURE).toBe(false)
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:8081'])
    expect(env.SPACES_REGION).toBeUndefined()
    expect(env.SPACES_UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024)
    expect(env.SPACES_UPLOAD_URL_TTL_SECONDS).toBe(900)
    expect(env.SPACES_DOWNLOAD_URL_TTL_SECONDS).toBe(300)
    expect(env.SPACES_PUBLIC_CACHE_CONTROL).toBe('public, max-age=31536000, immutable')
  })

  test('requires complete DigitalOcean Spaces configuration when storage is enabled', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
        JWT_SECRET: '12345678901234567890123456789012',
        SPACES_BUCKET: 'uploads',
      }),
    ).toThrow()
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
        JWT_SECRET: '12345678901234567890123456789012',
        SPACES_CDN_BASE_URL: 'https://images.example.com',
      }),
    ).toThrow()

    const env = loadEnv({
      DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
      JWT_SECRET: '12345678901234567890123456789012',
      SPACES_REGION: 'nyc3',
      SPACES_BUCKET: 'uploads',
      SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com',
      SPACES_CDN_BASE_URL: 'https://images.example.com',
      SPACES_ACCESS_KEY_ID: 'access-key',
      SPACES_SECRET_ACCESS_KEY: 'secret-key',
    })

    expect(env.SPACES_REGION).toBe('nyc3')
    expect(env.SPACES_BUCKET).toBe('uploads')
    expect(env.SPACES_CDN_BASE_URL).toBe('https://images.example.com')
  })

  test('rejects known weak JWT secrets in production-like runtimes', () => {
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
        JWT_SECRET: 'replace-with-at-least-32-random-characters',
      }),
    ).toThrow('JWT_SECRET')

    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
        JWT_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        COOKIE_SECURE: 'true',
        CORS_ORIGINS: 'https://web.example.com',
      }),
    ).toThrow('JWT_SECRET')

    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
        JWT_SECRET: 'a-memorable-human-secret-phrase-that-is-long-enough-to-pass',
        COOKIE_SECURE: 'true',
        CORS_ORIGINS: 'https://web.example.com',
      }),
    ).toThrow('JWT_SECRET')
  })

  test('requires generated secrets, secure cookies, and HTTPS origins in production', () => {
    const productionBase = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
      JWT_SECRET: '0123456789abcdef'.repeat(4),
      COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://web.example.com',
    }

    expect(() => loadEnv(productionBase)).not.toThrow()
    expect(() => loadEnv({ ...productionBase, JWT_SECRET: 'a-memorable-human-secret-phrase-that-is-long-enough-to-pass' }))
      .toThrow('JWT_SECRET')
    expect(() => loadEnv({ ...productionBase, COOKIE_SECURE: 'false' })).toThrow('COOKIE_SECURE')
    expect(() => loadEnv({ ...productionBase, CORS_ORIGINS: 'http://web.example.com' }))
      .toThrow('CORS_ORIGINS')
  })

  /**
   * The webhook secret guards the only unauthenticated public write endpoint in the
   * system, so it gets the same treatment as JWT_SECRET: a length floor in every
   * environment and a generated-secret requirement in production. A weak secret must
   * fail at boot rather than at exploitation time — an attacker who captures one
   * legitimate (timestamp, body, signature) triple can brute-force a short key
   * offline and then inject arbitrary signed leads.
   */
  test('enforces a length floor on the webhook secret in every environment', () => {
    const baseEnv = {
      DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
      JWT_SECRET: '12345678901234567890123456789012',
    }

    expect(() => loadEnv({ ...baseEnv, TERASO_WEBHOOK_SECRET: 'too-short' }))
      .toThrow('TERASO_WEBHOOK_SECRET')
    // 31 characters: one below the floor.
    expect(() => loadEnv({ ...baseEnv, TERASO_WEBHOOK_SECRET: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d' }))
      .toThrow('TERASO_WEBHOOK_SECRET')

    // Unset stays valid: the route fails closed at request time instead, so a
    // deployment that has not configured the site integration yet still boots.
    expect(() => loadEnv(baseEnv)).not.toThrow()
    expect(() => loadEnv({ ...baseEnv, TERASO_WEBHOOK_SECRET: '' })).not.toThrow()
    expect(loadEnv({ ...baseEnv, TERASO_WEBHOOK_SECRET: '' }).TERASO_WEBHOOK_SECRET).toBeUndefined()

    // At the floor, a development secret is accepted outside production.
    expect(() => loadEnv({ ...baseEnv, TERASO_WEBHOOK_SECRET: '0123456789abcdef'.repeat(2) }))
      .not.toThrow()
  })

  test('requires a generated, non-placeholder webhook secret in production-like runtimes', () => {
    const productionBase = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
      JWT_SECRET: '0123456789abcdef'.repeat(4),
      COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://web.example.com',
    }

    // A generated 64-character hex secret is the supported production shape.
    expect(() =>
      loadEnv({ ...productionBase, TERASO_WEBHOOK_SECRET: 'fedcba9876543210'.repeat(4) }),
    ).not.toThrow()

    // Long enough to clear the floor, but memorable rather than generated.
    expect(() =>
      loadEnv({
        ...productionBase,
        TERASO_WEBHOOK_SECRET: 'a-memorable-human-secret-phrase-that-is-long-enough',
      }),
    ).toThrow('TERASO_WEBHOOK_SECRET')

    // The documented placeholder must never reach production.
    expect(() =>
      loadEnv({
        ...productionBase,
        TERASO_WEBHOOK_SECRET: 'replace-with-a-long-random-webhook-secret',
      }),
    ).toThrow('TERASO_WEBHOOK_SECRET')

    // Zero-entropy: one repeated character.
    expect(() =>
      loadEnv({ ...productionBase, TERASO_WEBHOOK_SECRET: 'a'.repeat(64) }),
    ).toThrow('TERASO_WEBHOOK_SECRET')

    // The failure names the variable and never echoes its value.
    const failure = (() => {
      try {
        loadEnv({ ...productionBase, TERASO_WEBHOOK_SECRET: 'a-memorable-human-secret-phrase-that-is-long-enough' })
        return ''
      } catch (error) {
        return String(error)
      }
    })()
    expect(failure).toContain('TERASO_WEBHOOK_SECRET')
    expect(failure).not.toContain('a-memorable-human-secret-phrase')
  })

  test('rejects unsafe production CORS origins', () => {
    const baseEnv = {
      DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
      JWT_SECRET: '12345678901234567890123456789012',
    }

    expect(() =>
      loadEnv({
        ...baseEnv,
        CORS_ORIGINS: '',
      }),
    ).toThrow('CORS_ORIGINS')

    expect(() =>
      loadEnv({
        ...baseEnv,
        CORS_ORIGINS: '*',
      }),
    ).toThrow('CORS_ORIGINS')

    expect(() =>
      loadEnv({
        ...baseEnv,
        CORS_ORIGINS: 'https://web.example.com/path',
      }),
    ).toThrow('CORS_ORIGINS')

    expect(() =>
      loadEnv({
        ...baseEnv,
        COOKIE_SECURE: 'true',
        CORS_ORIGINS: 'http://web.example.com',
      }),
    ).toThrow('CORS_ORIGINS')
  })

  test('requires WEBAPP_ORIGIN to be an HTTP origin and HTTPS in production', () => {
    const baseEnv = {
      DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
      JWT_SECRET: '12345678901234567890123456789012',
    }

    expect(() => loadEnv({ ...baseEnv, WEBAPP_ORIGIN: 'https://web.example.com/path' }))
      .toThrow('WEBAPP_ORIGIN')
    expect(() => loadEnv({ ...baseEnv, WEBAPP_ORIGIN: 'ftp://web.example.com' }))
      .toThrow('WEBAPP_ORIGIN')
    expect(() => loadEnv({ ...baseEnv, WEBAPP_ORIGIN: 'http://localhost:5173' }))
      .not.toThrow()
    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        JWT_SECRET: '0123456789abcdef'.repeat(4),
        COOKIE_SECURE: 'true',
        CORS_ORIGINS: 'https://web.example.com',
        WEBAPP_ORIGIN: 'http://web.example.com',
      }),
    ).toThrow('WEBAPP_ORIGIN')
  })

  test('keeps absolute session lifetime at least as long as refresh lifetime', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
        JWT_SECRET: '12345678901234567890123456789012',
        REFRESH_TOKEN_TTL_DAYS: '30',
        SESSION_ABSOLUTE_TTL_DAYS: '29',
      }),
    ).toThrow('SESSION_ABSOLUTE_TTL_DAYS')
  })

  test('bounds refresh replay tolerance to a short window', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
        JWT_SECRET: '12345678901234567890123456789012',
        REFRESH_REUSE_GRACE_SECONDS: '61',
      }),
    ).toThrow('REFRESH_REUSE_GRACE_SECONDS')
  })

  test('requires an explicit client IP header when a trusted proxy is enabled', () => {
    const baseEnv = {
      DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
      JWT_SECRET: '12345678901234567890123456789012',
      TRUST_PROXY: 'true',
    }

    expect(() => loadEnv(baseEnv)).toThrow('TRUSTED_PROXY_CLIENT_IP_HEADER')
    expect(() =>
      loadEnv({
        ...baseEnv,
        TRUSTED_PROXY_CLIENT_IP_HEADER: 'do-connecting-ip',
      }),
    ).not.toThrow()
  })
})
