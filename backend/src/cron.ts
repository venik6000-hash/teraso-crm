import { createNotificationService } from './modules/notifications'
import { createBackendRuntime, type BackendRuntime } from './runtime'

type CronTask = (runtime: BackendRuntime, now: Date) => Promise<void>

const cronTasks = {
  noop: async () => {
    console.log('Cron noop task completed.')
  },
  'db:ping': async ({ prisma }) => {
    await prisma.$queryRaw`SELECT 1`
    console.log('Cron db:ping task completed.')
  },
  'auth:sessions:cleanup': async ({ env, prisma }, now) => {
    const dayMs = 24 * 60 * 60 * 1000
    const retentionCutoff = new Date(
      now.getTime() - env.SESSION_RETENTION_DAYS * dayMs,
    )
    const absoluteRetentionCutoff = new Date(
      now.getTime() - (env.SESSION_ABSOLUTE_TTL_DAYS + env.SESSION_RETENTION_DAYS) * dayMs,
    )
    const [sessions, resetTokens] = await Promise.all([
      prisma.authSession.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: retentionCutoff } },
            { revokedAt: { lt: retentionCutoff } },
            { createdAt: { lt: absoluteRetentionCutoff } },
          ],
        },
      }),
      prisma.passwordResetToken.deleteMany({
        where: { expiresAt: { lt: now } },
      }),
    ])
    console.log(
      `Cron auth:sessions:cleanup removed ${sessions.count} stale sessions and ${resetTokens.count} expired password reset tokens.`,
    )
  },
  /**
   * The recurring half of PRD 7.7: announce every task that has come due, every
   * task still unfinished past its escalation delay, and every lead that has spent
   * its next-step window without a task — then make one best-effort push pass.
   *
   * It is safe to run as often as the scheduler allows. It never changes a deal's
   * business state, and every record it writes is keyed on the instant its
   * condition began, so a repeat run — or a slow run overlapping the next one —
   * writes the same keys and the unique index collapses them.
   */
  'crm:notifications:dispatch': async ({ backgroundTasks, env, prisma }, now) => {
    const notifications = createNotificationService({
      backgroundTasks,
      db: prisma,
      vapid: env.VAPID_PUBLIC_KEY
        ? {
            subject: env.VAPID_SUBJECT!,
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY!,
          }
        : undefined,
    })
    const summary = await notifications.dispatchDueEvents(now)
    console.log(
      `Cron crm:notifications:dispatch created ${summary.created} notifications and pushed ${summary.delivered}.`,
    )
  },
} satisfies Record<string, CronTask>

export type CronTaskName = keyof typeof cronTasks

export async function runCronTask(
  taskName: string,
  runtime: BackendRuntime,
  now = new Date(),
) {
  const task = cronTasks[taskName as CronTaskName]

  if (!task) {
    throw new Error(`Unknown cron task "${taskName}". Available tasks: ${Object.keys(cronTasks).join(', ')}`)
  }

  await task(runtime, now)
}

export async function main(argv: string[] = Bun.argv.slice(2)) {
  const [taskName] = argv

  if (!taskName) {
    console.error(`Cron task name is required. Available tasks: ${Object.keys(cronTasks).join(', ')}`)
    process.exit(1)
  }

  const runtime = createBackendRuntime()

  try {
    await runCronTask(taskName, runtime)
  } finally {
    await runtime.close()
  }
}

if (import.meta.main) {
  await main()
}
