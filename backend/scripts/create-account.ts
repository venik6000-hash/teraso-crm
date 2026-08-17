import 'dotenv/config'

import { createPrisma, type DbClient } from '../src/db'
import { hashPassword } from '../src/modules/auth/infrastructure/passwords'

/**
 * Creates one account against a deployment.
 *
 * Teraso CRM has no registration endpoint: it serves one company, so accounts
 * are created by whoever operates the deployment rather than by anyone who
 * reaches the sign-in page. That makes this script the account-creation path,
 * not a convenience wrapper — without it a running deployment cannot gain a
 * second user at all.
 *
 *     bun run --cwd backend create:account -- --email a@b.ua --role admin
 *
 * Omit --password and the account is created locked: it exists and can be
 * granted a role, but no password will authenticate it until one is set. That
 * is the safe default for preparing an account ahead of time.
 *
 * Passwords are read from --password or the ACCOUNT_PASSWORD environment
 * variable. Prefer the variable: an argument is visible in the process list and
 * in shell history to every other user on the machine.
 */

export type CreateAccountInput = {
  displayName?: string
  email: string
  password?: string
  role: 'admin' | 'user'
}

export class CreateAccountError extends Error {}

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128

export function parseCreateAccountArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): CreateAccountInput {
  // Every argument must be recognised. A silently ignored "-role=admin" or a
  // misspelled flag would create an account with different privileges from the
  // ones the operator typed, and they would have no way to tell.
  const known = new Set(['display-name', 'email', 'password', 'role'])
  const values = new Map<string, string>()
  for (const argument of argv) {
    const match = argument.match(/^--([a-zA-Z-]+)=([\s\S]*)$/)
    if (!match) {
      throw new CreateAccountError(
        `Expected --name=value, received "${argument}". Quote values that contain spaces.`,
      )
    }
    if (!known.has(match[1]!)) {
      throw new CreateAccountError(
        `Unknown option "--${match[1]}". Expected one of: ${[...known].map((name) => `--${name}`).join(', ')}.`,
      )
    }
    values.set(match[1]!, match[2]!)
  }

  const email = values.get('email')?.trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CreateAccountError('--email=<address> is required and must be an email address.')
  }

  const role = values.get('role') ?? 'user'
  if (role !== 'admin' && role !== 'user') {
    throw new CreateAccountError(`--role must be "admin" or "user", received "${role}".`)
  }

  const password = values.get('password') ?? env.ACCOUNT_PASSWORD
  if (password !== undefined) {
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      throw new CreateAccountError(
        `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
      )
    }
  }

  const displayName = values.get('display-name')?.trim()

  return { displayName: displayName || undefined, email, password, role }
}

export async function createAccount(db: DbClient, input: CreateAccountInput) {
  const existing = await db.user.findUnique({ where: { email: input.email } })
  if (existing) {
    throw new CreateAccountError(
      `An account already exists for ${input.email}. Change its role from the admin area, or reset its password, instead of creating a second one.`,
    )
  }

  return db.user.create({
    data: {
      displayName: input.displayName ?? null,
      email: input.email,
      passwordHash: input.password ? await hashPassword(input.password) : null,
      role: input.role,
    },
    select: { email: true, id: true, role: true },
  })
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.')
    process.exit(1)
  }

  let input: CreateAccountInput
  try {
    input = parseCreateAccountArgs(process.argv.slice(2), process.env)
  } catch (error) {
    console.error(error instanceof CreateAccountError ? error.message : error)
    process.exit(1)
  }

  const db = createPrisma(databaseUrl)
  try {
    const account = await createAccount(db, input)
    console.log(
      input.password
        ? `Created ${account.role} account ${account.email}.`
        : `Created locked ${account.role} account ${account.email}; no password will authenticate it until one is set.`,
    )
  } catch (error) {
    console.error(error instanceof CreateAccountError ? error.message : error)
    process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}
