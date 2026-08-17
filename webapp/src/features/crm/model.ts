import {
  DEALS_MAX_PAGE,
  OPEN_DEAL_STAGES,
  dashboardPeriodSchema,
  dealBoardQuerySchema,
  dealCreateSchema,
  dealListQuerySchema,
  dealUpdateSchema,
  taskCreateSchema,
  taskUpdateSchema,
  type AssignableUserDto,
  type DashboardPeriodKind,
  type DealCreateInput,
  type DealListQuery,
  type DealActivityKind,
  type DealDetailDto,
  type DealStage,
  type DealSortField,
  type DealUpdateInput,
  type LeadClass,
  type LossReason,
  type Material,
  type PreferredChannel,
  type TaskCreateInput,
  type TaskKind,
  type TaskStatus,
  type TaskUpdateInput,
} from '@teraso-crm/contracts'

import {
  formatKyivDate,
  formatKyivDateTime,
  toInstantFromKyivInput,
  toKyivDateTimeInput,
} from '@/platform/kyiv-time'
import { urlQueryState } from '@/platform/url-query-state'
import { toFormErrors, type FormErrors } from './validation'

/* ------------------------------------------------------------------ *
 * Destinations
 * ------------------------------------------------------------------ */

/**
 * The deal card's route pattern.
 *
 * The backend denormalizes `dealPath(dealId)` into every notification row and
 * the service worker opens that stored value, so this pattern is not a free
 * choice: crm-list.test.tsx asserts it equals `dealPath('$dealId')`. Change the
 * contract, not this constant.
 */
export const DEAL_DETAIL_ROUTE_PATH = '/app/deals/$dealId'

/* ------------------------------------------------------------------ *
 * Russian labels
 *
 * Enum values cross the wire in English and are shown in Russian. Every state
 * that also carries a colour carries one of these strings too (PRD 7.0: colour
 * is never the only carrier of meaning).
 * ------------------------------------------------------------------ */

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  NEW: 'Новая заявка',
  QUALIFIED: 'Квалификация пройдена',
  PROPOSAL_SENT: 'Предложение отправлено',
  PREPAYMENT: 'Предоплата',
  WON: 'Успех',
  LOST: 'Потеряна',
  ARCHIVED: 'Архив',
}

/**
 * The money that would vanish from the reports if this deal were erased, or
 * `null` when erasing it costs the dashboard nothing.
 *
 * This is the one consequence of a deletion that reaches past the card. PRD 7.8
 * attributes received money by its own payment date rather than by the deal's
 * stage, so deleting a paid deal quietly lowers what a CLOSED period reports —
 * and «удалить» does not say that out loud.
 *
 * The full payment wins when both are present: it is the larger, final figure,
 * and a deal that reached it has already contributed the prepayment too, so
 * naming the bigger number is the honest warning rather than the alarming one.
 *
 * A rule rather than a string, because the reason it exists is a rule: the
 * dialog only has to decide whether to raise its voice.
 */
export function recordedPaymentAmount(deal: DealDetailDto): string | null {
  return deal.fullPaymentAmount ?? deal.prepaymentAmount
}

/**
 * Whether the deal is closed: won, lost or archived.
 *
 * Read from OPEN_DEAL_STAGES rather than listed, because the closed set is
 * exactly the complement of the open one and the backend's reopen rule derives
 * it the same way. A hand-written list here is what would let the card offer
 * «Переоткрыть» on stages the server refuses — or, worse, withhold it from a
 * stage nothing could then leave.
 */
export function isClosedStage(stage: DealStage): boolean {
  return !OPEN_DEAL_STAGES.some((open) => open === stage)
}

export const LEAD_CLASS_LABELS: Record<LeadClass, string> = {
  A: 'Класс A',
  B: 'Класс B',
  C: 'Класс C',
}

export const LEAD_CLASS_DESCRIPTIONS: Record<LeadClass, string> = {
  A: 'Готов купить сейчас',
  B: 'Не хватает одного параметра',
  C: 'Не хватает двух и более параметров или изучает рынок',
}

export const LOSS_REASON_LABELS: Record<LossReason, string> = {
  WRONG_NUMBER: 'Левый номер',
  NO_ANSWER: 'Недозвон',
  INAPPROPRIATE: 'Неадекват',
  IGNORED_AFTER_CALL: 'Игнор после звонка',
  IGNORED_AFTER_SCORING: 'Игнор после скоринга',
  CURIOSITY: 'Любопытство',
  CHOSEN_COMPETITOR: 'Выбрал других',
  NEED_DISAPPEARED: 'Пропала потребность',
}

export const MATERIAL_LABELS: Record<Material, string> = {
  WPC: 'ДПК',
  WOOD: 'Дерево',
  FACADE: 'Фасад',
}

export const PREFERRED_CHANNEL_LABELS: Record<PreferredChannel, string> = {
  CALL: 'Звонок',
  TELEGRAM: 'Telegram',
  WHATSAPP: 'WhatsApp',
  VIBER: 'Viber',
}

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  CALL: 'Звонок',
  MESSAGE: 'Написать',
  CLARIFY: 'Уточнить',
  OTHER: 'Другое',
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  ACTIVE: 'Активна',
  COMPLETED: 'Выполнена',
  CANCELLED: 'Отменена',
}

export const ACTIVITY_KIND_LABELS: Record<DealActivityKind, string> = {
  DEAL_CREATED: 'Сделка создана',
  INBOUND_LEAD_RECEIVED: 'Заявка с сайта',
  FIELD_UPDATED: 'Поля изменены',
  STAGE_CHANGED: 'Этап изменён',
  REOPENED: 'Сделка переоткрыта',
  NOTE_ADDED: 'Заметка',
  TASK_CREATED: 'Задача создана',
  TASK_COMPLETED: 'Задача выполнена',
  TASK_CANCELLED: 'Задача отменена',
  TASK_RESCHEDULED: 'Задача перенесена',
}

export const DEAL_SORT_LABELS: Record<DealSortField, string> = {
  submittedAt: 'По дате заявки',
  nearestTaskDueAt: 'По сроку задачи',
  potentialAmount: 'По сумме',
}

/** Field labels used by both the deal card and the manual form. */
export const DEAL_FIELD_LABELS = {
  name: 'Имя',
  phone: 'Телефон',
  source: 'Источник',
  form: 'Форма',
  landingUrl: 'Страница заявки',
  submittedAt: 'Дата заявки',
  leadClass: 'Класс',
  responsible: 'Ответственный',
  stage: 'Этап',
  material: 'Материал',
  areaLabel: 'Площадь',
  budgetLabel: 'Бюджет',
  objectType: 'Тип объекта',
  needTiming: 'Срок потребности',
  preferredChannel: 'Канал связи',
  potentialAmount: 'Потенциальная сумма',
  prepayment: 'Предоплата',
  fullPayment: 'Полная оплата',
  currentNote: 'Текущая заметка',
} as const

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

/**
 * Money is a decimal string on the wire and is only ever formatted, never
 * summed here: totals belong to the dashboard endpoint, which adds them in
 * PostgreSQL where the values are still exact decimals.
 *
 * Intl uses a no-break space as the group separator; it is replaced with a
 * plain space so the rendered value stays greppable in tests and end-to-end
 * selectors. Layout keeps the amount on one line through `whitespace-nowrap`.
 */
const moneyFormatter = new Intl.NumberFormat('uk-UA', {
  style: 'currency',
  currency: 'UAH',
  maximumFractionDigits: 0,
})

export function formatMoney(amount: string | null | undefined) {
  if (amount === null || amount === undefined || amount === '') return '—'
  const value = Number(amount)
  if (!Number.isFinite(value)) return '—'
  return normalizeSpaces(moneyFormatter.format(value))
}

/**
 * Timestamps are presented in Europe/Kyiv (PRD 10). The formatters themselves
 * live in `@/platform/kyiv-time`: they carry no CRM meaning and the notification
 * centre renders the same instants, so keeping them here made that feature
 * import this one for a date formatter and closed an import cycle.
 */
export const formatDateTime = formatKyivDateTime
export const formatDate = formatKyivDate

/**
 * Phones are stored in normalized international form and shown grouped
 * (PRD 7.1). Only the Ukrainian shape is regrouped; anything else is shown
 * exactly as stored rather than guessed at.
 */
export function formatPhone(phoneNormalized: string) {
  const ukrainian = phoneNormalized.match(/^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/)
  if (!ukrainian) return phoneNormalized
  return `+380 ${ukrainian[1]} ${ukrainian[2]} ${ukrainian[3]} ${ukrainian[4]}`
}

/**
 * What an empty owner reads as, in the card, in the queue and in the picker.
 *
 * One constant rather than several literals: the picker's «нет ответственного»
 * option and the card's placeholder are the same product statement, and a form
 * that offered a differently worded emptiness than the card shows afterwards
 * would look like it had saved something.
 */
export const UNASSIGNED_LABEL = 'Не назначен'

/**
 * A staff name falls back to the account email when no display name is set, so
 * `responsibleName` and `authorName` can carry a full address. Dense rows show
 * the local part only: it identifies the person inside a small team, keeps the
 * column from forcing a horizontal scroll on a phone, and avoids repeating a
 * full address in every history entry. Callers pass the untrimmed value as the
 * element's `title`, so nothing is lost.
 */
export function personLabel(value: string | null | undefined, fallback = UNASSIGNED_LABEL) {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  const email = trimmed.match(/^([^@\s]+)@[^@\s]+$/)
  return email ? email[1]! : trimmed
}

/**
 * `landingUrl` is written by an external webhook and rendered as a link, so the
 * scheme is restricted here rather than trusted from the contract, which allows
 * any `z.url()` — including `javascript:` and `data:`. A rejected value is shown
 * as plain text by the caller.
 */
export function safeExternalHref(value: string | null | undefined) {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? value : null
}

/**
 * Deep links only. The CRM never sends a message on the owner's behalf
 * (PRD 7.1); it opens the installed app or its web version.
 */
export function contactLinks(phoneNormalized: string) {
  const number = phoneNormalized.replace(/^\+/, '')
  return {
    call: 'tel:' + phoneNormalized,
    telegram: 'https://t.me/+' + number,
    whatsapp: 'https://wa.me/' + number,
    viber: 'viber://chat?number=%2B' + number,
  }
}

/* ------------------------------------------------------------------ *
 * List query state, carried in the URL
 * ------------------------------------------------------------------ */

/**
 * `phoneSearchDigits` on the server reduces a two-character term to two digits,
 * and every Ukrainian number starts with `38` — so a two-character search
 * matches the whole CRM. The list refuses to run below this length instead.
 */
export const MIN_DEAL_SEARCH_LENGTH = 3

const DEAL_LIST_QUERY_KEYS = [
  'q',
  'stage',
  'leadClass',
  'source',
  'material',
  'needTiming',
  'responsibleUserId',
  'submittedFrom',
  'submittedTo',
  'amountMin',
  'amountMax',
  'noNextStep',
  'overdue',
  'dueToday',
  'isCritical',
  'page',
  'pageSize',
  'sort',
  'direction',
] as const

const dealListUrlState = urlQueryState(dealListQuerySchema, DEAL_LIST_QUERY_KEYS)

/** Raw URL search values -> a complete, valid query. */
export const parseDealListSearch = dealListUrlState.parse

/**
 * The inverse: only what differs from the default view reaches the address bar,
 * so a shared link stays readable and the default list has a clean URL.
 */
export const toDealListSearch = dealListUrlState.serialize

/**
 * The route's `validateSearch`. Carrying the sparse form through the router is
 * deliberate: a route search type with every default spelled out would force
 * every link into the list to repeat them, and the defaults would then show up
 * in shared URLs.
 */
export const cleanDealListSearch = dealListUrlState.clean

/**
 * PRD 7.5 names six quick filters, and they are not one kind of thing.
 *
 * «Без следующего шага», «Просрочено» and «Сегодня» are independent boolean
 * flags that combine freely. «Предоплата», «Успех» and «Потеряно» all select
 * the single-valued `stage` field, so at most one of them can hold — picking a
 * second replaces the first. The filter bar renders the second group as one
 * single-choice control so that limitation is visible rather than discovered.
 */
export const DEAL_QUICK_FILTERS = [
  { id: 'noNextStep', label: 'Без следующего шага', kind: 'flag', flag: 'noNextStep' },
  { id: 'overdue', label: 'Просрочено', kind: 'flag', flag: 'overdue' },
  { id: 'dueToday', label: 'Сегодня', kind: 'flag', flag: 'dueToday' },
  { id: 'prepayment', label: 'Предоплата', kind: 'stage', stage: 'PREPAYMENT' },
  { id: 'won', label: 'Успех', kind: 'stage', stage: 'WON' },
  { id: 'lost', label: 'Потеряно', kind: 'stage', stage: 'LOST' },
] as const satisfies ReadonlyArray<
  | { id: string; label: string; kind: 'flag'; flag: 'noNextStep' | 'overdue' | 'dueToday' }
  | { id: string; label: string; kind: 'stage'; stage: DealStage }
>

export type DealQuickFilterId = (typeof DEAL_QUICK_FILTERS)[number]['id']

export function toggleQuickFilter(
  query: DealListQuery,
  id: DealQuickFilterId,
): DealListQuery {
  const filter = DEAL_QUICK_FILTERS.find((candidate) => candidate.id === id)
  if (!filter) return query

  if (filter.kind === 'flag') {
    return { ...query, [filter.flag]: !query[filter.flag], page: 1 }
  }
  return {
    ...query,
    stage: query.stage === filter.stage ? undefined : filter.stage,
    page: 1,
  }
}

export function activeQuickFilterIds(query: DealListQuery): DealQuickFilterId[] {
  return DEAL_QUICK_FILTERS.filter((filter) =>
    filter.kind === 'flag' ? query[filter.flag] : query.stage === filter.stage,
  ).map((filter) => filter.id)
}

/**
 * Every filter currently narrowing the list, named and individually clearable.
 *
 * This is what keeps the controls honest. Three of the six stages are not quick
 * filters, `isCritical` has no control at all (Task 8's dashboard deep-links
 * into it), and any of them can arrive from a shared URL — so a summary built
 * from the query itself, rather than from the controls, is the only rendering
 * that cannot claim "no filters" while the list is filtered.
 */
export function activeDealFilters(
  query: DealListQuery,
): ReadonlyArray<{ key: keyof DealListQuery; label: string; value: string }> {
  const active: Array<{ key: keyof DealListQuery; label: string; value: string }> = []
  const add = (key: keyof DealListQuery, label: string, value: string | undefined | null) => {
    if (value) active.push({ key, label, value })
  }

  add('q', 'Поиск', query.q)
  add('stage', 'Этап', query.stage && DEAL_STAGE_LABELS[query.stage])
  add('leadClass', 'Класс', query.leadClass && LEAD_CLASS_LABELS[query.leadClass])
  add('source', 'Источник', query.source)
  add('material', 'Материал', query.material && MATERIAL_LABELS[query.material])
  add('needTiming', 'Срок потребности', query.needTiming)
  add('responsibleUserId', 'Ответственный', query.responsibleUserId ? 'только мои' : null)
  add('submittedFrom', 'Заявки с', query.submittedFrom)
  add('submittedTo', 'Заявки по', query.submittedTo)
  add('amountMin', 'Сумма от', query.amountMin)
  add('amountMax', 'Сумма до', query.amountMax)
  add('noNextStep', 'Без следующего шага', query.noNextStep ? 'да' : null)
  add('overdue', 'Просрочено', query.overdue ? 'да' : null)
  add('dueToday', 'Сегодня', query.dueToday ? 'да' : null)
  add('isCritical', 'Только критичные', query.isCritical ? 'да' : null)

  return active
}

/** Clears one filter from the summary, whatever kind it is. */
export function clearDealFilter(
  query: DealListQuery,
  key: keyof DealListQuery,
): DealListQuery {
  const cleared =
    key === 'noNextStep' || key === 'overdue' || key === 'dueToday' || key === 'isCritical'
      ? false
      : undefined
  return { ...query, [key]: cleared, page: 1 }
}

export function isSearchTermTooShort(term: string) {
  const trimmed = term.trim()
  return trimmed.length > 0 && trimmed.length < MIN_DEAL_SEARCH_LENGTH
}

export function dealListViewState({
  isError,
  isPending,
  itemCount,
  term,
}: {
  isError: boolean
  isPending: boolean
  itemCount?: number
  term: string
}): 'term-too-short' | 'loading' | 'error' | 'empty' | 'ready' {
  if (isSearchTermTooShort(term)) return 'term-too-short'
  if (isPending) return 'loading'
  if (isError) return 'error'
  return itemCount === 0 ? 'empty' : 'ready'
}

/**
 * `total` comes from `COUNT(*) OVER ()` over the returned page, so a request
 * for a page past the end answers with an empty page AND `total: 0` even though
 * matching deals exist. Reporting that as «0 сделок» would tell the owner their
 * CRM is empty, so a past-the-end page is named as such and offers the way back.
 */
export function dealListPager({
  hasNext,
  itemCount,
  page,
  pageSize,
  total,
}: {
  hasNext: boolean
  itemCount: number
  page: number
  pageSize: number
  total: number
}) {
  const isPastEnd = itemCount === 0 && page > 1
  const shown = Math.min(itemCount, pageSize)
  return {
    isPastEnd,
    canGoNext: hasNext && !isPastEnd && page < DEALS_MAX_PAGE,
    canGoPrevious: page > 1,
    summary: isPastEnd
      ? `Страница ${page} пуста — вернитесь к первой странице`
      : `Страница ${page} · показано ${shown} из ${total}`,
  }
}

/* ------------------------------------------------------------------ *
 * Dashboard (PRD 7.8)
 * ------------------------------------------------------------------ */

export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriodKind, string> = {
  today: 'Сегодня',
  week: 'Неделя',
  month: 'Месяц',
  custom: 'Период',
}

const DASHBOARD_PERIOD_KEYS = ['period', 'from', 'to'] as const

const dashboardUrlState = urlQueryState(dashboardPeriodSchema, DASHBOARD_PERIOD_KEYS)

/** Raw URL search values -> a complete, valid period. */
export const parseDashboardPeriod = dashboardUrlState.parse

/** Only what differs from the default month view reaches the address bar. */
export const toDashboardPeriodSearch = dashboardUrlState.serialize

/** The route's `validateSearch`: a stale link degrades to the default period. */
export const cleanDashboardPeriodSearch = dashboardUrlState.clean

/**
 * A step conversion as a whole percentage.
 *
 * The server sends a fraction because a percentage is a presentation choice;
 * rounding here keeps the funnel readable without ever letting the browser
 * recompute the ratio from two counts.
 *
 * `null` means the window held no movement INTO that stage to convert from —
 * the top of the funnel, or deals that arrived before the period. It is shown
 * as «—», never as 0%, which would claim a conversion failure that did not
 * happen.
 */
export { toInstantFromKyivInput, toKyivDateTimeInput }

export function formatShare(share: number | null) {
  return share === null ? '—' : `${Math.round(share * 100)}%`
}

/* ------------------------------------------------------------------ *
 * Board (PRD 7.6)
 * ------------------------------------------------------------------ */

/**
 * The board's URL state.
 *
 * It reuses the list's filter keys minus paging and sorting — the board has
 * neither — through the same `urlQueryState` helper, so a filter arriving from
 * the dashboard's «критичных» counter is honoured identically on both surfaces.
 */
const DEAL_BOARD_QUERY_KEYS = DEAL_LIST_QUERY_KEYS.filter(
  (key): key is Exclude<(typeof DEAL_LIST_QUERY_KEYS)[number], 'page' | 'pageSize' | 'sort' | 'direction'> =>
    key !== 'page' && key !== 'pageSize' && key !== 'sort' && key !== 'direction',
)

const dealBoardUrlState = urlQueryState(dealBoardQuerySchema, DEAL_BOARD_QUERY_KEYS)

export const parseDealBoardSearch = dealBoardUrlState.parse
export const toDealBoardSearch = dealBoardUrlState.serialize
export const cleanDealBoardSearch = dealBoardUrlState.clean

/**
 * What a drop should do, decided from the two stages alone.
 *
 * This chooses which CONFIRMATION to open, never whether the move is allowed.
 * The reachable-stage graph lives on the server and a copy of it here is exactly
 * how the two would drift, so even a backwards drag is offered to the API — the
 * rejection «Недопустимый переход воронки» comes back, the card never leaves its
 * column, and there is one authority for the funnel instead of two.
 */
export type BoardDropIntent =
  | { kind: 'ignored' }
  | { kind: 'stage'; stage: DealStage }
  | { kind: 'payment'; stage: 'PREPAYMENT' | 'WON' }
  | { kind: 'loss' }
  | { kind: 'archive' }

export function boardDropIntent(currentStage: DealStage, target: DealStage): BoardDropIntent {
  if (currentStage === target) return { kind: 'ignored' }
  if (target === 'LOST') return { kind: 'loss' }
  // Terminal like a loss and confirmed for the same reason, but a separate
  // intent: shelving asks for no reason, so the two open different dialogs.
  if (target === 'ARCHIVED') return { kind: 'archive' }
  // Both paid stages require an amount and a date the contract will not accept
  // as absent, so the card cannot commit without asking (PRD 7.3).
  if (target === 'PREPAYMENT' || target === 'WON') return { kind: 'payment', stage: target }
  return { kind: 'stage', stage: target }
}

/**
 * The stage each confirmed drop commits to.
 *
 * `payment` carries its own stage because there are two of them; the terminal
 * intents name exactly one each, so the mapping lives here rather than as a
 * ternary chain in the page that opens the dialog.
 */
export const BOARD_TERMINAL_DROP_STAGES = {
  loss: 'LOST',
  archive: 'ARCHIVED',
} as const satisfies Record<'loss' | 'archive', DealStage>

/* ------------------------------------------------------------------ *
 * Tasks (PRD 7.4)
 * ------------------------------------------------------------------ */

/**
 * Turns the task form's draft into a validated payload or Russian field errors.
 *
 * The time arrives as the `YYYY-MM-DDTHH:mm` a date-time input produces, which
 * is Kyiv wall-clock time, and leaves as the UTC instant the contract requires.
 * An empty input converts to `''`, which fails the contract's datetime format
 * and surfaces as «Укажите дату и время» — the mandatory-time rule of PRD 7.4
 * enforced by the shared schema rather than by a second check here.
 */
export type TaskDraft = {
  assigneeUserId?: string
  dueAtInput: string
  kind: TaskKind
  title: string
}

export function buildTaskInput(
  draft: TaskDraft,
): { ok: true; value: TaskCreateInput } | { ok: false; errors: FormErrors } {
  const parsed = taskCreateSchema.safeParse({
    kind: draft.kind,
    title: draft.title.trim(),
    dueAt: toInstantFromKyivInput(draft.dueAtInput),
    ...(draft.assigneeUserId ? { assigneeUserId: draft.assigneeUserId } : {}),
  })

  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: toFormErrors(parsed.error.issues) }
}

/**
 * Turns a reschedule draft into the single-key `{ dueAt }` patch
 * `taskUpdateSchema` accepts, or a Russian field error.
 *
 * Only the time changes on a reschedule — kind, title and assignee stay put —
 * so this builds a PATCH rather than reusing `buildTaskInput`, which always
 * assembles a full `TaskCreateInput`. The Kyiv-to-UTC conversion is the same
 * one `buildTaskInput` uses, so a reschedule and a new task agree on what a
 * typed time means without a second timezone implementation to drift from it.
 */
export function buildTaskRescheduleInput(
  dueAtInput: string,
): { ok: true; value: TaskUpdateInput } | { ok: false; errors: FormErrors } {
  const parsed = taskUpdateSchema.safeParse({ dueAt: toInstantFromKyivInput(dueAtInput) })

  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: toFormErrors(parsed.error.issues) }
}

/**
 * Whether completing a task should prompt for the next step.
 *
 * PRD 7.4 is explicit that finishing a task does not satisfy the rule: an open
 * deal still needs a future one. This reads the deal's own task list rather than
 * the clock, so it is not a third copy of the urgency rule — `noNextStep`,
 * `hasOverdueTask` and `isCritical` remain server-computed and authoritative,
 * and this only decides whether to open a dialog a moment earlier than the
 * refetched flags would.
 */
export function shouldPromptNextStep(deal: DealDetailDto, completedTaskId: string): boolean {
  if (isClosedStage(deal.stage)) return false
  return deal.tasks.every((task) => task.id === completedTaskId || task.status !== 'ACTIVE')
}

/* ------------------------------------------------------------------ *
 * Deal forms (PRD 7.1)
 *
 * The manual form and the edit dialog both live inside a portal — a Sheet and a
 * Dialog — so their payload assembly is built here as pure functions over a plain
 * draft. That is not only for testability: the two forms answer the same question
 * differently on purpose (a create has nothing to clear, a PATCH does), and
 * keeping both rules side by side is what makes the difference legible.
 * ------------------------------------------------------------------ */

/**
 * Radix `Select` cannot carry an empty value, so «не задано» needs a sentinel.
 *
 * Exported because the builders below read the drafts the selects produce. Two
 * private copies, one in each form, would be two chances for a form to spell it
 * differently from the builder that has to recognize it — and the failure would
 * be a literal `__not_set__` reaching the API.
 */
export const NOT_SET = '__not_set__'

/**
 * The «Ответственный» options, «Не назначен» first.
 *
 * Unassigned is deliberately a real choice rather than an absence: PRD 7.4's
 * 30-minute grace window exists so a lead can be recorded before it is handed to
 * anybody, and the edit dialog needs a way to say "take this off me".
 */
export function assignableUserOptions(
  users: ReadonlyArray<AssignableUserDto>,
): ReadonlyArray<{ label: string; value: string }> {
  return [
    { label: UNASSIGNED_LABEL, value: NOT_SET },
    ...users.map((user) => ({ label: user.name, value: user.id })),
  ]
}

/** Everything the manual deal form holds, before the contract sees any of it. */
export type DealFormDraft = {
  name: string
  phone: string
  source: string
  form: string
  landingUrl: string
  submittedAt: string
  leadClass: string
  responsibleUserId: string
  material: string
  areaLabel: string
  budgetLabel: string
  objectType: string
  needTiming: string
  preferredChannel: string
  potentialAmount: string
  currentNote: string
  withTask: boolean
  taskKind: TaskKind
  taskTitle: string
  taskDueAt: string
}

/**
 * Turns the manual form's draft into a validated `DealCreateInput`.
 *
 * A blank or unset field is LEFT OUT rather than sent as `null`: on a create
 * there is nothing to clear, which is why `dealCreateSchema` uses `.optional()`
 * where `dealUpdateSchema` uses `.nullish()`.
 *
 * The initial task carries the chosen responsible as its assignee, explicitly.
 * The server would resolve the same person from the deal's own
 * `responsibleUserId`, so this is not a different outcome — it is the payload
 * saying what it means, the rule `taskCreateSchema.assigneeUserId` states and the
 * task dialog already follows. Without it the two paths to a first task produced
 * an assigned task from one and an unassigned task from the other.
 */
export function buildDealCreateInput(
  draft: DealFormDraft,
): { ok: true; value: DealCreateInput } | { ok: false; errors: FormErrors } {
  const payload: Record<string, unknown> = {
    name: draft.name.trim(),
    phone: draft.phone.trim(),
    source: draft.source.trim(),
  }
  const withText = (key: string, value: string) => {
    if (value.trim()) payload[key] = value.trim()
  }
  const withChoice = (key: string, value: string) => {
    if (chosen(value)) payload[key] = value
  }
  const responsibleUserId = chosen(draft.responsibleUserId) ? draft.responsibleUserId : null

  withText('form', draft.form)
  withText('landingUrl', draft.landingUrl)
  if (draft.submittedAt) payload.submittedAt = toInstantFromKyivInput(draft.submittedAt)
  withChoice('leadClass', draft.leadClass)
  withChoice('responsibleUserId', draft.responsibleUserId)
  withChoice('material', draft.material)
  withText('areaLabel', draft.areaLabel)
  withText('budgetLabel', draft.budgetLabel)
  withText('objectType', draft.objectType)
  withText('needTiming', draft.needTiming)
  withChoice('preferredChannel', draft.preferredChannel)
  withText('potentialAmount', draft.potentialAmount)
  withText('currentNote', draft.currentNote)

  if (draft.withTask) {
    payload.initialTask = {
      kind: draft.taskKind,
      title: draft.taskTitle.trim(),
      dueAt: toInstantFromKyivInput(draft.taskDueAt),
      // Absent only when the deal itself has nobody: there is no third party to
      // fall back to, and the server would store null either way.
      ...(responsibleUserId ? { assigneeUserId: responsibleUserId } : {}),
    }
  }

  const parsed = dealCreateSchema.safeParse(payload)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: toFormErrors(parsed.error.issues) }
}

/**
 * The editable fields of a deal, as strings a form can hold. Every key is a
 * `dealUpdateSchema` key, so the diff below maps one to one with no translation
 * table to fall out of step.
 */
export type DealEditDraft = {
  name: string
  source: string
  form: string
  landingUrl: string
  leadClass: string
  responsibleUserId: string
  material: string
  areaLabel: string
  budgetLabel: string
  objectType: string
  needTiming: string
  preferredChannel: string
  potentialAmount: string
}

export function toDealEditDraft(deal: DealDetailDto): DealEditDraft {
  return {
    name: deal.client.name,
    source: deal.source,
    form: deal.form ?? '',
    landingUrl: deal.landingUrl ?? '',
    leadClass: deal.leadClass ?? NOT_SET,
    responsibleUserId: deal.responsibleUserId ?? NOT_SET,
    material: deal.material ?? NOT_SET,
    areaLabel: deal.areaLabel ?? '',
    budgetLabel: deal.budgetLabel ?? '',
    objectType: deal.objectType ?? '',
    needTiming: deal.needTiming ?? '',
    preferredChannel: deal.preferredChannel ?? NOT_SET,
    potentialAmount: deal.potentialAmount ?? '',
  }
}

/**
 * The edit dialog's diff, and the reason it is a diff at all.
 *
 * `dealUpdateSchema` reads an ABSENT key as "leave the stored value alone" and an
 * explicit `null` as "clear it", and the repository honours exactly that
 * distinction (`if (!(field in input)) continue`). So a form that sent its whole
 * draft would be indistinguishable from one asking to overwrite every field with
 * whatever it happened to be showing — including a stale one — while a form that
 * sent `undefined` for an emptied field could never clear anything.
 *
 * Only keys the owner actually changed are emitted, and an emptied field becomes
 * `null`. On `responsibleUserId` that is the difference between «сохранил класс» и
 * «сдал сделку»: picking «Не назначен» must unassign, and touching an unrelated
 * field must not.
 *
 * A draft equal to its origin is refused rather than sent: the API rejects an
 * empty patch by contract, and «Изменений нет» is a truer answer than a request.
 */
export function buildDealUpdateInput(
  initial: DealEditDraft,
  draft: DealEditDraft,
): { ok: true; value: DealUpdateInput } | { ok: false; errors: FormErrors } {
  const changed: Record<string, string | null> = {}
  for (const key of Object.keys(initial) as Array<keyof DealEditDraft>) {
    if (draft[key] === initial[key]) continue
    const value = draft[key].trim()
    changed[key] = value === '' || value === NOT_SET ? null : value
  }

  if (Object.keys(changed).length === 0) {
    return { ok: false, errors: { fields: {}, formMessage: 'Изменений нет' } }
  }

  const parsed = dealUpdateSchema.safeParse(changed)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: toFormErrors(parsed.error.issues) }
}

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

/** Whether a select actually holds a value rather than the «не задано» sentinel. */
function chosen(value: string) {
  return value !== NOT_SET && value !== ''
}

/** Intl separates digit groups with a no-break space; a plain one renders the same. */
function normalizeSpaces(value: string) {
  return value.replace(/[\u00a0\u202f]/g, ' ')
}
