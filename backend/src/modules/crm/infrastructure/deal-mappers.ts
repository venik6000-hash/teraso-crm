import {
  DEAL_DETAIL_ACTIVITY_LIMIT,
  DEAL_DETAIL_TASK_LIMIT,
  dealActivityMetadataSchema,
  type ClientSummaryDto,
  type DealActivityDto,
  type DealDetailDto,
  type DealSummaryDto,
  type DealTaskDto,
  type LeadAttributionDto,
} from '@teraso-crm/contracts'

import { Prisma } from '../../../generated/prisma/client'
import { evaluateDealCriticality } from '../domain/deal-rules'
import { toIsoInstant, toMoneyString } from './serialization'

/* ------------------------------------------------------------------ *
 * Prisma select shapes
 *
 * Response DTOs are strict, so every select below is explicit. Spreading a
 * Prisma row into a DTO would ship whatever column the schema gains next. These
 * selects are the read shape the builders below consume; the repository issues
 * the queries and hands rows straight to the matching builder.
 * ------------------------------------------------------------------ */

export const personSelect = { displayName: true, email: true } as const

export const clientSummarySelect = {
  id: true,
  name: true,
  phoneNormalized: true,
  createdAt: true,
} as const

export const taskSelect = {
  id: true,
  dealId: true,
  kind: true,
  title: true,
  dueAt: true,
  status: true,
  assigneeUserId: true,
  completedAt: true,
  createdAt: true,
  assignee: { select: personSelect },
} as const

export const activitySelect = {
  id: true,
  dealId: true,
  kind: true,
  text: true,
  fromStage: true,
  toStage: true,
  authorUserId: true,
  metadata: true,
  createdAt: true,
  author: { select: personSelect },
} as const

export const dealSummarySelect = {
  id: true,
  stage: true,
  leadClass: true,
  lossReason: true,
  source: true,
  form: true,
  submittedAt: true,
  potentialAmount: true,
  responsibleUserId: true,
  createdAt: true,
  client: { select: clientSummarySelect },
  responsibleUser: { select: personSelect },
} as const

/**
 * Declared apart from the select below because `as const` would make these
 * arrays readonly, which Prisma's generated order-by input rejects. `satisfies`
 * keeps them mutable while still checking them against the model.
 */
const newestTaskFirst = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.DealTaskOrderByWithRelationInput[]

const newestActivityFirst = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.DealActivityOrderByWithRelationInput[]

const earliestReceiptFirst = [
  { receivedAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.IngestionReceiptOrderByWithRelationInput[]

export const dealDetailSelect = {
  ...dealSummarySelect,
  landingUrl: true,
  material: true,
  areaLabel: true,
  budgetLabel: true,
  objectType: true,
  needTiming: true,
  preferredChannel: true,
  prepaymentAmount: true,
  prepaymentPaidAt: true,
  fullPaymentAmount: true,
  fullPaymentPaidAt: true,
  currentNote: true,
  updatedAt: true,
  /**
   * Both collections are the most recent N, newest first, taking one extra row
   * so `hasMore*` can be answered without a second count. The contract caps them
   * so paging can be added later without a breaking shape change.
   */
  tasks: {
    orderBy: newestTaskFirst,
    take: DEAL_DETAIL_TASK_LIMIT + 1,
    select: taskSelect,
  },
  activities: {
    orderBy: newestActivityFirst,
    take: DEAL_DETAIL_ACTIVITY_LIMIT + 1,
    select: activitySelect,
  },
  attribution: {
    select: {
      metaEventId: true,
      utmSource: true,
      utmMedium: true,
      utmCampaign: true,
      utmContent: true,
      utmTerm: true,
      gclid: true,
      gbraid: true,
    },
  },
  /** `externalId` is projected from the deal's earliest receipt, its only home. */
  ingestionReceipts: {
    orderBy: earliestReceiptFirst,
    take: 1,
    select: { externalId: true },
  },
} as const

export type PersonRow = { displayName: string | null; email: string }
export type DealSummaryRow = Prisma.DealGetPayload<{ select: typeof dealSummarySelect }>
export type DealDetailRow = Prisma.DealGetPayload<{ select: typeof dealDetailSelect }>
export type TaskRow = Prisma.DealTaskGetPayload<{ select: typeof taskSelect }>
export type ActivityRow = Prisma.DealActivityGetPayload<{ select: typeof activitySelect }>

/**
 * The ACTIVE-task facts one deal's urgency needs, both derived from a single read
 * of its active tasks (see `activeTaskFacts` in crm-repository.ts).
 *
 * They are carried together because `evaluateDealCriticality` needs both and one
 * cannot be inferred from the other: `nearest` also fills `nearestActiveTask` on
 * the DTO and decides `hasOverdueTask`, while `hasFutureTask` decides
 * `noNextStep` — a deal can hold an overdue task and a future one at once.
 */
export type DealActiveTasks = {
  readonly nearest: TaskRow | null
  readonly hasFutureTask: boolean
}

/**
 * A deal with no ACTIVE task at all: nothing overdue, and no next step. Shared by
 * every caller, which is why the fields above are readonly.
 */
export const NO_ACTIVE_TASKS: DealActiveTasks = { nearest: null, hasFutureTask: false }

/* ------------------------------------------------------------------ *
 * DTO builders
 *
 * Pure functions from a selected Prisma row to its strict DTO. Every Date and
 * Decimal crosses the wire through `serialization.ts`; urgency is computed here
 * from `evaluateDealCriticality` so it is never recomputed in the browser.
 * ------------------------------------------------------------------ */

/** Never show a nameless person: a user without a display name is shown by email. */
export function personName(person: PersonRow | null): string | null {
  if (!person) return null
  return person.displayName ?? person.email
}

export function toClientSummary(client: {
  id: string
  name: string
  phoneNormalized: string
  createdAt: Date
}): ClientSummaryDto {
  return {
    id: client.id,
    name: client.name,
    phoneNormalized: client.phoneNormalized,
    createdAt: client.createdAt.toISOString(),
  }
}

export function toTaskDto(task: TaskRow): DealTaskDto {
  return {
    id: task.id,
    dealId: task.dealId,
    kind: task.kind,
    title: task.title,
    dueAt: task.dueAt.toISOString(),
    status: task.status,
    assigneeUserId: task.assigneeUserId,
    assigneeName: personName(task.assignee),
    completedAt: toIsoInstant(task.completedAt),
    createdAt: task.createdAt.toISOString(),
  }
}

export function toActivityDto(activity: ActivityRow): DealActivityDto {
  return {
    id: activity.id,
    dealId: activity.dealId,
    kind: activity.kind,
    text: activity.text,
    fromStage: activity.fromStage,
    toStage: activity.toStage,
    authorUserId: activity.authorUserId,
    authorName: personName(activity.author),
    /**
     * Parsed, not cast: `appendActivity` types every write against this schema so
     * a stray key is already a compile error, and parsing on the way out closes
     * the gap in production too — a malformed row fails loudly here instead of
     * shipping to clients and only being caught if a test happens to parse it.
     */
    metadata:
      activity.metadata == null ? null : dealActivityMetadataSchema.parse(activity.metadata),
    createdAt: activity.createdAt.toISOString(),
  }
}

export function toDealSummary(
  deal: DealSummaryRow,
  activeTasks: DealActiveTasks,
  now: Date,
): DealSummaryDto {
  const nearestActiveTask = activeTasks.nearest
  const criticality = evaluateDealCriticality({
    stage: deal.stage,
    now,
    createdAt: deal.createdAt,
    nearestActiveDueAt: nearestActiveTask?.dueAt ?? null,
    hasFutureActiveTask: activeTasks.hasFutureTask,
  })

  return {
    id: deal.id,
    client: toClientSummary(deal.client),
    stage: deal.stage,
    leadClass: deal.leadClass,
    lossReason: deal.lossReason,
    source: deal.source,
    form: deal.form,
    submittedAt: deal.submittedAt.toISOString(),
    potentialAmount: toMoneyString(deal.potentialAmount),
    responsibleUserId: deal.responsibleUserId,
    responsibleName: personName(deal.responsibleUser),
    nearestActiveTask: nearestActiveTask ? toTaskDto(nearestActiveTask) : null,
    isCritical: criticality.isCritical,
    noNextStep: criticality.noNextStep,
    hasOverdueTask: criticality.hasOverdueTask,
    createdAt: deal.createdAt.toISOString(),
  }
}

export function toAttribution(deal: DealDetailRow): LeadAttributionDto | null {
  const attribution = deal.attribution
  const externalId = deal.ingestionReceipts[0]?.externalId ?? null
  if (!attribution && externalId === null) return null

  return {
    externalId,
    metaEventId: attribution?.metaEventId ?? null,
    utmSource: attribution?.utmSource ?? null,
    utmMedium: attribution?.utmMedium ?? null,
    utmCampaign: attribution?.utmCampaign ?? null,
    utmContent: attribution?.utmContent ?? null,
    utmTerm: attribution?.utmTerm ?? null,
    gclid: attribution?.gclid ?? null,
    gbraid: attribution?.gbraid ?? null,
  }
}

export function toDealDetail(
  deal: DealDetailRow,
  activeTasks: DealActiveTasks,
  now: Date,
): DealDetailDto {
  const tasks = deal.tasks.slice(0, DEAL_DETAIL_TASK_LIMIT)
  const activities = deal.activities.slice(0, DEAL_DETAIL_ACTIVITY_LIMIT)

  return {
    ...toDealSummary(deal, activeTasks, now),
    landingUrl: deal.landingUrl,
    material: deal.material,
    areaLabel: deal.areaLabel,
    budgetLabel: deal.budgetLabel,
    objectType: deal.objectType,
    needTiming: deal.needTiming,
    preferredChannel: deal.preferredChannel,
    prepaymentAmount: toMoneyString(deal.prepaymentAmount),
    prepaymentPaidAt: toIsoInstant(deal.prepaymentPaidAt),
    fullPaymentAmount: toMoneyString(deal.fullPaymentAmount),
    fullPaymentPaidAt: toIsoInstant(deal.fullPaymentPaidAt),
    currentNote: deal.currentNote,
    updatedAt: deal.updatedAt.toISOString(),
    tasks: tasks.map(toTaskDto),
    activities: activities.map(toActivityDto),
    hasMoreTasks: deal.tasks.length > DEAL_DETAIL_TASK_LIMIT,
    hasMoreActivities: deal.activities.length > DEAL_DETAIL_ACTIVITY_LIMIT,
    attribution: toAttribution(deal),
  }
}
