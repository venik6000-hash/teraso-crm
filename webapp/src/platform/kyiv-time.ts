/**
 * Europe/Kyiv presentation of instants, and the conversions a date-time input
 * needs to speak that zone.
 *
 * This lives in `platform` rather than inside a feature because it carries no
 * product meaning: PRD 10 pins the whole application to Kyiv, and both the CRM
 * and the notification centre render the same timestamps. Keeping it in
 * `features/crm` made the notification inbox import the CRM feature for a date
 * formatter, which closed an import cycle between the two features — and pulled
 * the board's drag-and-drop and charting dependencies into the notification
 * chunk along with it.
 *
 * Instants arrive as UTC; the owner works in Kyiv, so every timestamp is
 * presented in `Europe/Kyiv` rather than in the browser's own zone. A device set
 * to another zone would otherwise show a task due at a time nobody scheduled.
 */

const KYIV_TIME_ZONE = 'Europe/Kyiv'

const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: KYIV_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: KYIV_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

/** The Kyiv calendar date of an instant, as the `YYYY-MM-DD` a date input takes. */
const isoDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: KYIV_TIME_ZONE })

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: KYIV_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export function formatKyivDateTime(iso: string | null | undefined) {
  const date = toDate(iso)
  return date ? normalizeSpaces(dateTimeFormatter.format(date)) : '—'
}

export function formatKyivDate(iso: string | null | undefined) {
  const date = toDate(iso)
  return date ? normalizeSpaces(dateFormatter.format(date)) : '—'
}

/** Today in Kyiv, as the `YYYY-MM-DD` a `<input type="date">` expects. */
export function kyivToday(now = new Date()) {
  return isoDateFormatter.format(now)
}

/**
 * `<input type="datetime-local">` speaks the browser's own zone, but PRD 10
 * pins task and payment times to Kyiv and the dashboard attributes money to
 * Kyiv day boundaries. A device set to another zone would therefore record a
 * payment on the wrong day, so both directions convert against Kyiv explicitly
 * instead of trusting the host clock.
 */
function kyivOffsetMs(instant: Date) {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(instant).map((part) => [part.type, part.value]),
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
  // One correction pass, because the offset that applies to the resulting
  // instant is not always the one that applied to the guess. The two DST hours
  // are pinned in crm-state.test.tsx: the repeated autumn hour resolves to its
  // second pass and round trips, while the hour the spring change skips
  // resolves an hour later and deliberately does not round trip — a wall-clock
  // time that never happened is answered with the real instant instead.
  return new Date(asUtc.getTime() - kyivOffsetMs(firstPass)).toISOString()
}

function toDate(iso: string | null | undefined) {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Intl separates digit groups with a no-break space; a plain one renders the same. */
function normalizeSpaces(value: string) {
  return value.replace(/[  ]/g, ' ')
}
