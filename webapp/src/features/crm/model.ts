import {
  APP_PATH_PREFIX,
  DEALS_MAX_PAGE,
  dealListQuerySchema,
  dealPath,
  type DealListQuery,
  type DealActivityKind,
  type DealStage,
  type DealSortField,
  type LeadClass,
  type LossReason,
  type Material,
  type PreferredChannel,
  type TaskKind,
  type TaskStatus,
} from '@teraso-crm/contracts'
import type { z } from 'zod'

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

export const CRM_PATHS = {
  dashboard: `${APP_PATH_PREFIX}/dashboard`,
  deals: `${APP_PATH_PREFIX}/deals`,
  board: `${APP_PATH_PREFIX}/board`,
  tasks: `${APP_PATH_PREFIX}/tasks`,
  notifications: `${APP_PATH_PREFIX}/notifications`,
} as const

/** Always built from the contract so a link and a stored notification agree. */
export function dealHref(dealId: string) {
  return dealPath(dealId)
}

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
 * Instants arrive as UTC; the owner works in Kyiv (PRD 10), so every timestamp
 * is presented in `Europe/Kyiv` rather than in the browser's own zone.
 */
const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Kyiv',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Kyiv',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

export function formatDateTime(iso: string | null | undefined) {
  const date = toDate(iso)
  return date ? normalizeSpaces(dateTimeFormatter.format(date)) : '—'
}

export function formatDate(iso: string | null | undefined) {
  const date = toDate(iso)
  return date ? normalizeSpaces(dateFormatter.format(date)) : '—'
}

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
 * A staff name falls back to the account email when no display name is set, so
 * `responsibleName` and `authorName` can carry a full address. Dense rows show
 * the local part only: it identifies the person inside a small team, keeps the
 * column from forcing a horizontal scroll on a phone, and avoids repeating a
 * full address in every history entry. Callers pass the untrimmed value as the
 * element's `title`, so nothing is lost.
 */
export function personLabel(value: string | null | undefined, fallback = 'Не назначен') {
  if (!value) return fallback
  const email = value.match(/^([^@\s]+)@[^@\s]+$/)
  return email ? email[1]! : value
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

/**
 * `<input type="datetime-local">` speaks the browser's own zone, but PRD 10
 * pins task and payment times to `Europe/Kyiv` and the dashboard attributes
 * money to Kyiv day boundaries. A device set to another zone would therefore
 * record a payment on the wrong day, so the two helpers below convert against
 * Kyiv explicitly instead of trusting the host clock.
 */
const KYIV_TIME_ZONE = 'Europe/Kyiv'

const kyivPartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: KYIV_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** How far Kyiv wall-clock time is ahead of UTC at a given instant. */
function kyivOffsetMs(instant: Date) {
  const parts = Object.fromEntries(
    kyivPartsFormatter.formatToParts(instant).map((part) => [part.type, part.value]),
  )
  const wallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return wallClock - instant.getTime()
}

/** UTC instant -> the `YYYY-MM-DDTHH:mm` Kyiv value a date-time input shows. */
export function toKyivDateTimeInput(iso: string | null | undefined) {
  const date = toDate(iso)
  if (!date) return ''
  return new Date(date.getTime() + kyivOffsetMs(date)).toISOString().slice(0, 16)
}

/** The inverse: a Kyiv `YYYY-MM-DDTHH:mm` value -> a UTC instant for the API. */
export function toInstantFromKyivInput(value: string) {
  if (!value) return ''
  const asUtc = new Date(`${value.length === 16 ? `${value}:00` : value}Z`)
  if (Number.isNaN(asUtc.getTime())) return ''
  const firstPass = new Date(asUtc.getTime() - kyivOffsetMs(asUtc))
  // One correction pass: on the far side of a DST change the offset that
  // applies to the resulting instant is not the one that applied to the guess.
  return new Date(asUtc.getTime() - kyivOffsetMs(firstPass)).toISOString()
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

const DEAL_LIST_DEFAULTS = dealListQuerySchema.parse({})

/**
 * Turns raw URL search values into a valid query.
 *
 * The contract schema is strict and has no idea which key broke, so an unknown
 * or malformed parameter would otherwise throw during navigation and take the
 * whole route down. Unknown keys are dropped up front and invalid ones are
 * removed one round at a time, which degrades a hand-edited or stale URL to the
 * default view instead of an error screen.
 */
export function parseDealListSearch(raw: Record<string, unknown>): DealListQuery {
  let candidate: Record<string, unknown> = {}
  for (const key of DEAL_LIST_QUERY_KEYS) {
    const value = raw[key]
    if (value === undefined || value === null || value === '') continue
    candidate[key] = value
  }

  for (let attempt = 0; attempt <= DEAL_LIST_QUERY_KEYS.length; attempt += 1) {
    const parsed = dealListQuerySchema.safeParse(candidate)
    if (parsed.success) return parsed.data

    const rejected = new Set(
      parsed.error.issues
        .map((issue) => issue.path[0])
        .filter((key): key is string => typeof key === 'string'),
    )
    if (rejected.size === 0) break
    candidate = Object.fromEntries(
      Object.entries(candidate).filter(([key]) => !rejected.has(key)),
    )
  }

  return dealListQuerySchema.parse({})
}

/**
 * The inverse: only what differs from the default view reaches the address bar,
 * so a shared link stays readable and the default list has a clean URL.
 */
export function toDealListSearch(query: DealListQuery): Partial<DealListQuery> {
  const search: Record<string, unknown> = {}
  for (const key of DEAL_LIST_QUERY_KEYS) {
    const value = query[key]
    if (value === undefined || value === DEAL_LIST_DEFAULTS[key]) continue
    search[key] = value
  }
  return search as Partial<DealListQuery>
}

/**
 * The route's `validateSearch`: it keeps the address bar to what the owner
 * actually chose, and the page turns that back into a complete query. Carrying
 * the sparse form through the router is deliberate — a route search type with
 * every default spelled out would force every link into the list to repeat
 * them, and the defaults would show up in shared URLs.
 */
export function cleanDealListSearch(raw: Record<string, unknown>): Partial<DealListQuery> {
  return toDealListSearch(parseDealListSearch(raw))
}

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
 * Validation feedback
 * ------------------------------------------------------------------ */

/**
 * Zod's structural messages are English ("Invalid input: expected string,
 * received undefined"); only the business rules written into the contracts are
 * Russian. Every message the owner can see has to be Russian, so structural
 * issues are translated here, at the form boundary, while an authored contract
 * message is passed through untouched.
 *
 * The two are told apart by looking for Cyrillic in the message rather than by
 * issue code: a contract can attach its own text to any code, and a global Zod
 * error map would reach every other consumer of this package.
 */
export function toRussianMessage(issue: z.core.$ZodIssue): string {
  if (/[А-Яа-яЁё]/.test(issue.message)) return issue.message

  switch (issue.code) {
    case 'invalid_type':
      return 'Заполните поле'
    case 'too_small': {
      const minimum = Number(issue.minimum)
      if (issue.origin === 'string') {
        return minimum <= 1
          ? 'Заполните поле'
          : `Слишком короткое значение: не меньше ${minimum} символов`
      }
      return `Значение не может быть меньше ${minimum}`
    }
    case 'too_big': {
      const maximum = Number(issue.maximum)
      return issue.origin === 'string'
        ? `Слишком длинное значение: не больше ${maximum} символов`
        : `Значение не может быть больше ${maximum}`
    }
    case 'invalid_format':
      switch (issue.format) {
        case 'datetime':
          return 'Укажите дату и время'
        case 'date':
          return 'Укажите дату'
        case 'url':
          return 'Укажите ссылку вида https://example.com'
        case 'uuid':
          return 'Недопустимый идентификатор'
        default:
          return 'Недопустимый формат'
      }
    case 'invalid_value':
      return 'Выберите значение из списка'
    case 'unrecognized_keys':
      return 'Недопустимое поле'
    default:
      return 'Недопустимое значение'
  }
}

/**
 * First message per field, ready to render next to the input.
 *
 * Nested paths are published twice — as `initialTask.dueAt` and as
 * `initialTask` — so a form can point at the exact input when it renders the
 * subfields, and still fall back to one message beside a grouped control.
 */
export function dealFormFieldErrors(
  issues: ReadonlyArray<z.core.$ZodIssue>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const issue of issues) {
    const path = issue.path.filter((part): part is string => typeof part === 'string')
    const message = toRussianMessage(issue)
    const keys = path.length === 0 ? ['_form'] : [path.join('.'), path[0]!]
    for (const key of keys) {
      if (errors[key]) continue
      errors[key] = message
    }
  }
  return errors
}

/**
 * Live phone feedback while the field is being typed. It mirrors the contract's
 * own length bounds instead of guessing at a national format: the server
 * normalizes the number, and a stricter client rule would reject numbers the
 * API accepts.
 */
export function phoneFieldError(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Заполните поле'
  if (!/^\+?[\d\s()-]+$/.test(trimmed)) return 'Номер может содержать только цифры'
  if (trimmed.length < 7) return 'Слишком короткий номер'
  if (trimmed.length > 40) return 'Слишком длинный номер'
  return null
}

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

function toDate(iso: string | null | undefined) {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Intl separates digit groups with a no-break space; a plain one renders the same. */
function normalizeSpaces(value: string) {
  return value.replace(/[\u00a0\u202f]/g, ' ')
}
