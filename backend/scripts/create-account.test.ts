import { describe, expect, test } from 'bun:test'

import type { DbClient } from '../src/db'
import { CreateAccountError, createAccount, parseCreateAccountArgs } from './create-account'

describe('parseCreateAccountArgs', () => {
  test('reads an address, a role and a display name', () => {
    expect(
      parseCreateAccountArgs([
        '--email=Manager@Teraso.com.ua',
        '--role=admin',
        '--display-name=Менеджер',
        '--password=password123',
      ]),
    ).toEqual({
      displayName: 'Менеджер',
      email: 'manager@teraso.com.ua',
      password: 'password123',
      role: 'admin',
    })
  })

  test('defaults to the user role, which is the one that sees no CRM data', () => {
    expect(parseCreateAccountArgs(['--email=a@b.ua']).role).toBe('user')
  })

  /**
   * An account with no password exists but cannot be signed into. That is the
   * safe way to prepare one ahead of time, so it must not be mistaken for a
   * failure to pass --password.
   */
  test('leaves the account locked when no password is supplied anywhere', () => {
    expect(parseCreateAccountArgs(['--email=a@b.ua']).password).toBeUndefined()
  })

  test('prefers an explicit argument but accepts the environment variable', () => {
    expect(parseCreateAccountArgs(['--email=a@b.ua'], { ACCOUNT_PASSWORD: 'from-env-1' }).password)
      .toBe('from-env-1')
    expect(
      parseCreateAccountArgs(['--email=a@b.ua', '--password=explicit1'], {
        ACCOUNT_PASSWORD: 'from-env-1',
      }).password,
    ).toBe('explicit1')
  })

  test.each([
    [['--role=admin'], 'missing address'],
    [['--email=not-an-address'], 'malformed address'],
    [['--email=a@b.ua', '--role=owner'], 'unknown role'],
    [['--email=a@b.ua', '--password=short'], 'password below the floor'],
    [['--email=a@b.ua', '-email=typo'], 'unparsable flag'],
  ])('refuses %p (%s)', (argv) => {
    expect(() => parseCreateAccountArgs(argv)).toThrow(CreateAccountError)
  })

  test('refuses a password past the hashing input limit', () => {
    expect(() => parseCreateAccountArgs(['--email=a@b.ua', `--password=${'x'.repeat(129)}`]))
      .toThrow(CreateAccountError)
  })
})

describe('createAccount', () => {
  test('refuses an address that already has an account instead of shadowing it', async () => {
    let created = false
    const db = {
      user: {
        findUnique: async () => ({ id: 'existing' }),
        create: async () => {
          created = true
          return {}
        },
      },
    } as unknown as DbClient

    await expect(
      createAccount(db, { email: 'taken@teraso.com.ua', role: 'user' }),
    ).rejects.toThrow(CreateAccountError)
    expect(created).toBe(false)
  })

  test('stores a hash, never the password itself', async () => {
    let stored: Record<string, unknown> | undefined
    const db = {
      user: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          stored = data
          return { email: data.email, id: 'created', role: data.role }
        },
      },
    } as unknown as DbClient

    await createAccount(db, {
      email: 'fresh@teraso.com.ua',
      password: 'password123',
      role: 'admin',
    })

    expect(stored?.passwordHash).toBeTypeOf('string')
    expect(stored?.passwordHash).not.toBe('password123')
    expect(String(stored?.passwordHash)).toStartWith('$argon2id$')
    expect(stored?.role).toBe('admin')
  })

  test('stores no hash at all for a locked account', async () => {
    let stored: Record<string, unknown> | undefined
    const db = {
      user: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          stored = data
          return { email: data.email, id: 'created', role: data.role }
        },
      },
    } as unknown as DbClient

    await createAccount(db, { email: 'locked@teraso.com.ua', role: 'user' })

    expect(stored?.passwordHash).toBeNull()
  })
})
