/**
 * Calendar dates in filters are Europe/Kyiv days (PRD 10), so they have to be
 * resolved against the zone's real offset rather than a constant: Kyiv is UTC+2
 * in winter and UTC+3 in summer. A hard-coded offset would be wrong for half the
 * year, and a UTC day would place "Сегодня" an hour or two off every evening —
 * after 21:00 UTC in summer it is already tomorrow in Kyiv.
 *
 * Intl is the offset authority here; nothing in this module hard-codes one.
 */
const KYIV_TIME_ZONE = 'Europe/Kyiv'
const DAY_MS = 24 * 60 * 60 * 1000

const kyivParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: KYIV_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** How far Kyiv wall-clock time is ahead of UTC at a given instant. */
function kyivOffsetMs(instant: Date): number {
  const parts = kyivParts.formatToParts(instant)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)

  const wallClock = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  )
  return wallClock - instant.getTime()
}

/**
 * The UTC instant at which a Kyiv wall-clock reading occurred.
 *
 * `wallClock` is a naive `YYYY-MM-DDTHH:mm:ss` with no zone marker — a reading off
 * a clock hanging in Kyiv, which is what a server logging `date('Y-m-d H:i:s')` in
 * that zone writes down.
 *
 * The offset is applied twice on purpose: the first pass uses the offset at the
 * same wall-clock reading interpreted as UTC, which lands within a few hours of
 * the answer, and the second uses the offset actually in force at that candidate.
 * One pass would be wrong on a transition day, where the two readings sit on
 * opposite sides of the clock change.
 */
export function kyivWallClockToUtc(wallClock: string): Date {
  const asUtc = Date.parse(`${wallClock}Z`)
  const firstGuess = asUtc - kyivOffsetMs(new Date(asUtc))
  return new Date(asUtc - kyivOffsetMs(new Date(firstGuess)))
}

/** The UTC instant at which the given Kyiv calendar day begins. */
export function kyivDayStart(isoDate: string): Date {
  return kyivWallClockToUtc(`${isoDate}T00:00:00.000`)
}

/** The exclusive upper bound of a Kyiv calendar day: the start of the next one. */
export function kyivDayEndExclusive(isoDate: string): Date {
  const nextDate = new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + DAY_MS)
  return kyivDayStart(nextDate.toISOString().slice(0, 10))
}

/**
 * The Kyiv calendar date containing an instant, as `YYYY-MM-DD`.
 *
 * This is the inverse of `kyivDayStart` and the only correct way to ask "which
 * day is it in Kyiv": reading `toISOString().slice(0, 10)` off an instant
 * answers with the UTC day, which is already the next date in Kyiv every
 * evening after 21:00 in summer.
 */
export function kyivDateOf(instant: Date): string {
  const parts = kyivParts
    .formatToParts(instant)
    .reduce<Record<string, string>>((accumulator, part) => {
      accumulator[part.type] = part.value
      return accumulator
    }, {})

  return `${parts.year}-${parts.month}-${parts.day}`
}

/** The Kyiv calendar day containing `now`, as a half-open UTC range. */
export function kyivTodayRange(now: Date): { start: Date; end: Date } {
  const isoDate = kyivDateOf(now)

  return { start: kyivDayStart(isoDate), end: kyivDayEndExclusive(isoDate) }
}
