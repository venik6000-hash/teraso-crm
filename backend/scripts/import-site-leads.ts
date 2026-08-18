import 'dotenv/config'

import { inboundQuizLeadSchema, type InboundQuizLeadInput } from '@teraso-crm/contracts'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { createBackgroundTasks } from '../src/background-tasks'
import { createPrisma, type DbClient } from '../src/db'
import { CrmService } from '../src/modules/crm'
import { kyivWallClockToUtc } from '../src/modules/crm/domain/kyiv-time'
import { createPrismaCrmRepository } from '../src/modules/crm/infrastructure/crm-repository'
import { createLeadNotifier, createNotificationService } from '../src/modules/notifications'
import { createPrismaUsersRepository } from '../src/modules/users/infrastructure/users-repository'

/**
 * Backfills real site leads into the CRM from the site's own lead backup —
 * `public/leads/leads-YYYY-MM.jsonl`, the JSON-lines file `lead_backup()` in
 * `api.php` appends to before it sends a single notification.
 *
 * Why a script and not the webhook. From now on `api.php` delivers every new lead
 * to `POST /api/crm/inbound/quiz` as it arrives, so this script is only for the
 * history that predates that wiring. It cannot go through the HTTP endpoint:
 * `recordInboundQuizLead` bounds `receivedAt` to seven days in the past (a
 * far-backdated lead would otherwise land with a follow-up task already so old
 * that nothing ever flags it), and real history is months old. So the import runs
 * in-process against the same `CrmService` with a clock rewound to each lead's own
 * arrival — exactly how `seed-demo.ts` replays a month of work — and then aligns
 * the `created_at` columns the database defaulted to `now()`.
 *
 * Everything else is the production path: the same service, the same receipt, the
 * same «Первично обработать заявку» task, the same notification. Nothing is
 * hand-inserted, so an imported deal is indistinguishable from one the webhook
 * delivered — including its deduplication.
 *
 * Re-running is safe and is the intended way to top up: an already-imported lead
 * matches its `[source, externalId]` receipt and is reported as a duplicate
 * without writing anything. That is also what makes the overlap with the live
 * webhook harmless — a lead the site already delivered keeps its original deal.
 *
 *   bun run --cwd backend import:site-leads -- <path-to-leads.jsonl> [more.jsonl]
 *   bun run --cwd backend import:site-leads -- --dry-run <path-to-leads.jsonl>
 *   bun run --cwd backend import:site-leads -- --source=teraso.in.ua <path.jsonl>
 *
 * `--dry-run` maps and validates every row and prints the same report without
 * touching the database. Run it first against a fresh export: it names each row
 * the CRM would refuse and why, while the refusal is still cheap to fix.
 *
 * `--source` names which site the export came from, and must match what that
 * site's webhook sends. Two sites feed this CRM — teraso.com.ua and the Meta
 * landing served from teraso.in.ua — and they write different backups: the first
 * stores flat `utm_source`/`utm_campaign` columns and a `lead_<utc-stamp>_<rand>`
 * id, the second nests the same values under `utm` and issues a bare random id.
 * Both shapes are read here, because both are the same kind of evidence.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * The site this import assumes when none is named. It is the integration identity
 * written on every receipt, and it must match what that site's live webhook sends
 * (`source` in its `api.php`), or a lead imported here and later redelivered would
 * fail to match its own receipt and open a second deal for the same submission.
 */
const DEFAULT_SITE_SOURCE = 'teraso.com.ua'

export class ImportArgsError extends Error {}

export type ImportArgs = { dryRun: boolean; paths: string[]; source: string }

export function parseImportArgs(argv: readonly string[]): ImportArgs {
  let dryRun = false
  let source = DEFAULT_SITE_SOURCE
  const paths: string[] = []

  for (const argument of argv) {
    if (argument === '--dry-run') {
      dryRun = true
      continue
    }
    if (argument.startsWith('--source=')) {
      source = argument.slice('--source='.length).trim()
      continue
    }
    // Anything else that looks like a flag is a typo, not a file. Ignoring it
    // would run the whole import under the DEFAULT source, and every lead of the
    // other site would open a second deal under a receipt that never matches.
    if (argument.startsWith('-')) {
      throw new ImportArgsError(
        `Unknown option "${argument}". Expected --dry-run or --source=<host>.`,
      )
    }
    paths.push(argument)
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(source)) {
    throw new ImportArgsError(
      `--source must be the site's hostname, like ${DEFAULT_SITE_SOURCE}; received "${source}".`,
    )
  }
  if (paths.length === 0) {
    throw new ImportArgsError(
      'Usage: bun run --cwd backend import:site-leads -- [--dry-run] [--source=<host>] <leads.jsonl> [...]',
    )
  }

  return { dryRun, paths, source }
}

/** One raw line of the site's lead backup. Every field is optional in practice. */
type SiteLeadRow = Record<string, unknown>

type SkipReason =
  | 'no-phone'
  | 'placeholder-phone'
  | 'test-lead'
  | 'no-timestamp'
  | 'contact-click'
  | 'schema'
  | 'rejected'

type Skipped = { line: number; leadId: string; reason: SkipReason; detail?: string }

/**
 * Words that mark a row as somebody's own test rather than a customer. The backup
 * holds both: QA passes over the live forms wrote «Codex QA — квіз», «TEST DIAG A
 * ignore», «ТЕСТ Claude — не передзвонювати» and similar alongside real
 * submissions, and importing those would put fake people on the board.
 *
 * Matched against the free-text fields only. Not against the phone, and never
 * against `landing_url` or the UTM values: a genuine lead can arrive from a
 * campaign whose name happens to contain «test».
 */
const TEST_MARKERS = [
  'codex',
  'test',
  'тест',
  'e2e',
  'preflight',
  'перевірка',
  'проверка',
  'не обрабатывать',
  'не оброблят',
  'ігнорувати',
  'do not process',
]

function testMarkerIn(row: SiteLeadRow): string | null {
  const haystack = ['name', 'notes', 'summary', 'spec', 'city']
    .map((field) => text(row[field]))
    .join(' ')
    .toLowerCase()
  return TEST_MARKERS.find((marker) => haystack.includes(marker)) ?? null
}

/**
 * Whether the digits look like a real Ukrainian subscriber rather than a filler
 * somebody typed to get past validation.
 *
 * Two rules, both drawn from what the live backup actually contains. A number
 * whose subscriber part is one or two repeated digits is filler — `+380000000000`,
 * `+38 (000) 000-00-04`, `+38011111111` are all in there. And the number must be
 * a Ukrainian one at all: `0055434655864` and `0753585857575` were also typed into
 * the forms, and the CRM would reject them at import with a less obvious error.
 */
function isRealUaPhone(digits: string): boolean {
  const national = digits.startsWith('380')
    ? digits.slice(3)
    : digits.startsWith('0')
      ? digits.slice(1)
      : null
  if (national === null || national.length !== 9) return false
  return new Set(national).size > 2
}

/**
 * The human label `api.php` puts on a lead source, reused so an imported card
 * reads the same as one the webhook delivered. Kept in sync with
 * `lead_source_label()` there.
 */
const FORM_LABELS: Record<string, string> = {
  site_feedback: 'Сайт (форма)',
  quiz: 'Квіз',
  quiz_quick: 'Квіз (швидка)',
  quiz1: 'Чат-квіз',
  consult: 'Консультація',
  consult_quick: 'Консультація (швидка)',
  pool: 'Басейн',
  pool_quick: 'Басейн (швидка)',
  offer: 'Оффер: фото-візуалізація',
  sample: 'Замовлення зразка',
  facade: 'Фасад (лендінг)',
  balcony: 'Балкон (лендінг)',
  commercial: 'Комерція (лендінг)',
  dacha: 'Дача/двір (лендінг)',
  quote: 'Запит прорахунку',
  calc: 'Калькулятор',
  catalog: 'Каталог',
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
}

/**
 * Reads one labelled line out of the quiz `summary` block.
 *
 * The June rows predate the flat qualification columns: back then the quiz wrote
 * everything into `summary` as labelled lines —
 *
 *     Заявка з квізу Teraso
 *
 *     Матеріал: Терасна дошка ДПК
 *     Площа: 12 м²
 *     Монтаж: Ще не вирішив
 *     Терміни: Якнайшвидше
 *     Орієнтовний кошторис: від 32 980 грн
 *
 * — and left `material_interest`, `area_sqm` and the rest empty. The values are
 * the customer's own answers, so recovering them is moving a field, not inventing
 * one. Only the exact labels are read; anything else stays empty.
 */
function labelled(summary: string, label: string): string {
  const match = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'mu').exec(summary)
  return match ? match[1].trim() : ''
}

/** The area without its unit, so the caller can append a single «м²». */
function areaFrom(row: SiteLeadRow, summary: string): string {
  const flat = text(row.area_sqm)
  if (flat) return flat
  return labelled(summary, 'Площа').replace(/\s*м²\s*$/u, '').trim()
}

function clamp(value: string, max: number): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

/**
 * One click-attribution value, from either backup shape: teraso.com.ua writes the
 * parameters as flat columns, teraso.in.ua nests the same names under `utm`. The
 * flat column wins when a row somehow carries both.
 *
 * Only the parameters the CRM stores are read. `fbclid` and `wbraid` are in the
 * teraso.in.ua backup but have no field on the deal, so they stay in the site's
 * own log rather than being smuggled into a text field the owner reads.
 */
function attributionValue(row: SiteLeadRow, key: string): string {
  const flat = text(row[key])
  if (flat) return flat
  const nested = row.utm
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return ''
  return text((nested as Record<string, unknown>)[key])
}

/**
 * The CRM material, from the free text the quiz and calculator store.
 *
 * The brand names are not guesses: they are the catalog's own product types in
 * `data_store.json` — Tardex, Porch and Woodlux are `wpc_decking`, thermowood and
 * the exotics are `wood_decking`. Facade is tested FIRST, or «Фасадна дошка
 * Tardex» would fall into WPC on the word «tardex».
 *
 * Deliberately conservative beyond that: an unrecognised phrasing yields no
 * material rather than a guess, because a wrong material on the card is worse than
 * an empty one the owner fills in. Mirrors `crm_material()` in `api.php`.
 */
function toMaterial(value: string): InboundQuizLeadInput['material'] {
  const v = value.toLowerCase()
  if (!v) return undefined
  if (has(v, ['фасад', 'facade', 'сайдинг', 'паркан'])) return 'FACADE'
  if (has(v, ['дпк', 'wpc', 'композит', 'tardex', 'porch', 'woodlux'])) return 'WPC'
  if (has(v, ['дерев', 'wood', 'термо', 'акація', 'мербау', 'модрина', 'ясен', 'тік', 'гарапа'])) {
    return 'WOOD'
  }
  return undefined
}

function has(haystack: string, needles: string[]): boolean {
  return needles.some((one) => haystack.includes(one))
}

/** Mirrors `crm_channel()` in `api.php`. */
function toChannel(value: string): InboundQuizLeadInput['preferredChannel'] {
  const v = value.toLowerCase()
  if (!v) return undefined
  if (v.includes('telegram') || v.includes('телеграм') || v.includes('t.me')) return 'TELEGRAM'
  if (v.includes('whatsapp') || v.includes('вотсап') || v.includes('wa.me')) return 'WHATSAPP'
  if (v.includes('viber') || v.includes('вайбер')) return 'VIBER'
  if (v.includes('дзвін') || v.includes('звон') || v.includes('call')) return 'CALL'
  return undefined
}

/**
 * When the lead arrived, in UTC.
 *
 * Preferred source is the `lead_id`, not the row's `time` field, and that is not
 * fussiness: `lead_make_id()` stamps the id with `gmdate('YmdHis')` — UTC by
 * definition — while `time` is `date('Y-m-d H:i:s')`, the web host's wall clock
 * with no offset recorded.
 *
 * The host runs Europe/Kyiv, which is verifiable rather than assumed: every row
 * carrying both fields shows `time` exactly three hours ahead of the id's UTC
 * stamp (`lead_20260715110059…` against `2026-07-15 14:00:59`), and three hours is
 * Kyiv in summer. So for the older rows that predate `lead_id` — the June ones —
 * `time` is read as a Kyiv wall-clock reading and converted with the zone's real
 * offset, which also stays correct across the DST change the raw +3 would miss.
 */
function receivedAtOf(row: SiteLeadRow): Date | null {
  const match = /^lead_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(text(row.lead_id))
  if (match) {
    const [, year, month, day, hour, minute, second] = match
    const at = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
    )
    return Number.isNaN(at.getTime()) ? null : at
  }

  const wallClock = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(text(row.time))
  if (!wallClock) return null
  const at = kyivWallClockToUtc(`${wallClock[1]}T${wallClock[2]}`)
  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * The idempotency key. Rows written before `api.php` started stamping a `lead_id`
 * have none, so one is derived — deterministically, from the arrival instant and
 * the phone, the two things that identify a submission — and prefixed `legacy_` so
 * a reconstructed key is never mistaken for one the site issued.
 *
 * Determinism is the whole point: re-running the import recomputes the same key,
 * matches the existing receipt, and writes nothing. A random id would open a
 * duplicate deal on every run.
 */
function externalIdOf(row: SiteLeadRow, receivedAt: Date, phone: string): string {
  const leadId = text(row.lead_id)
  if (leadId) return leadId
  const stamp = receivedAt.toISOString().slice(0, 19).replace(/\D/g, '')
  const digest = createHash('sha256').update(`${receivedAt.toISOString()}|${phone}`).digest('hex')
  return `legacy_${stamp}_${digest.slice(0, 8)}`
}

/**
 * Maps one backup row onto the inbound contract, or explains why it cannot be one.
 *
 * The mapping is the same one `crm_lead_payload()` performs in `api.php`, so a
 * lead imported from the backup and the same lead delivered live produce the same
 * card. Nothing is invented: a field the site did not record is left out.
 *
 * `source` is the site the export came from. It becomes the receipt identity and
 * the fallback landing URL, so the two sites' histories stay distinguishable and
 * neither can be re-imported under the other's name.
 */
export function toInboundLead(
  row: SiteLeadRow,
  source: string,
): { ok: true; lead: InboundQuizLeadInput } | { ok: false; reason: SkipReason; detail?: string } {
  // A messenger tap is an intent, not a submission: it carries no contact, so the
  // CRM would have nobody to open a card for. The site does not forward it either.
  if (text(row.source) === 'contact_click') return { ok: false, reason: 'contact-click' }

  const marker = testMarkerIn(row)
  if (marker) return { ok: false, reason: 'test-lead', detail: `matched «${marker}»` }

  const phone = text(row.phone)
  const digits = phone.match(/\d/g)?.join('') ?? ''
  if (digits.length < 10) return { ok: false, reason: 'no-phone', detail: 'fewer than 10 digits' }
  if (!isRealUaPhone(digits)) return { ok: false, reason: 'placeholder-phone', detail: phone }

  const receivedAt = receivedAtOf(row)
  if (!receivedAt) return { ok: false, reason: 'no-timestamp' }
  const leadId = externalIdOf(row, receivedAt, digits)

  // `page` on teraso.com.ua, `page_url` on teraso.in.ua: the same field, named
  // differently by two generations of the handler.
  const page = text(row.page) || text(row.page_url)
  const landing = text(row.landing_url)
  const landingUrl = /^https?:\/\//i.test(page)
    ? page
    : /^https?:\/\//i.test(landing)
      ? landing
      : `https://${source}/`

  const sourceKey = text(row.source)
  const summary = text(row.summary)
  const area = clamp(areaFrom(row, summary), 76)

  const attribution = {
    metaEventId: clamp(attributionValue(row, 'event_id'), 180),
    utmSource: clamp(attributionValue(row, 'utm_source'), 120),
    utmMedium: clamp(attributionValue(row, 'utm_medium'), 120),
    utmCampaign: clamp(attributionValue(row, 'utm_campaign'), 180),
    utmContent: clamp(attributionValue(row, 'utm_content'), 180),
    utmTerm: clamp(attributionValue(row, 'utm_term'), 180),
    gclid: clamp(attributionValue(row, 'gclid'), 300),
    gbraid: clamp(attributionValue(row, 'gbraid'), 300),
  }
  const hasAttribution = Object.values(attribution).some((one) => one !== undefined)

  const candidate = {
    externalId: leadId,
    receivedAt: receivedAt.toISOString(),
    // The contract requires a name; the offer and sample forms never ask for one.
    // Record the absence plainly rather than inventing a customer.
    name: clamp(text(row.name), 120) ?? 'Без імені',
    phone: phone.slice(0, 40),
    source,
    form: FORM_LABELS[sourceKey] ?? clamp(sourceKey, 80) ?? 'Заявка',
    landingUrl,
    // What the customer wrote, mirroring `crm_lead_payload()` in api.php: the
    // comment and the form's own summary are joined when both are present, because
    // on the feedback form `notes` is the request itself while `summary` carries
    // context such as the preferred channel.
    note: clamp([text(row.notes), summary].filter(Boolean).join('\n\n'), 2000),
    material: toMaterial(text(row.material_interest) || labelled(summary, 'Матеріал')),
    areaLabel: area ? `${area} м²` : undefined,
    budgetLabel: clamp(text(row.estimate_uah) || labelled(summary, 'Орієнтовний кошторис'), 80),
    needTiming: clamp(text(row.timeline) || labelled(summary, 'Терміни'), 120),
    preferredChannel: toChannel(text(row.messenger)),
    attribution: hasAttribution ? attribution : undefined,
  }

  const parsed = inboundQuizLeadSchema.safeParse(candidate)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      ok: false,
      reason: 'schema',
      detail: first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid payload',
    }
  }
  return { ok: true, lead: parsed.data }
}

/**
 * Reads one export, keeping the line number for the report.
 *
 * Two shapes are accepted, because the owner has two ways to get the data out and
 * neither should need a conversion step first: the raw `leads-YYYY-MM.jsonl` off
 * the web host (one JSON object per line), and the `{ ok, month, leads: [...] }`
 * body that `api.php?action=leads` returns to the admin inbox.
 */
async function readRows(path: string): Promise<Array<{ line: number; row: SiteLeadRow }>> {
  const contents = await readFile(path, 'utf8')

  try {
    const whole: unknown = JSON.parse(contents)
    if (whole && typeof whole === 'object' && Array.isArray((whole as { leads?: unknown }).leads)) {
      return (whole as { leads: SiteLeadRow[] }).leads
        .filter((row) => row && typeof row === 'object')
        .map((row, index) => ({ line: index + 1, row }))
    }
  } catch {
    // Not a single JSON document — fall through to the line-by-line reader.
  }

  const rows: Array<{ line: number; row: SiteLeadRow }> = []
  contents.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') rows.push({ line: index + 1, row: parsed as SiteLeadRow })
    } catch {
      // A truncated final line is normal for an append-only log; api.php's own
      // inbox skips unparseable lines the same way.
    }
  })
  return rows
}

/**
 * Aligns the `created_at` columns with the moment the lead actually arrived. The
 * services cannot set them (the column defaults to `now()`), and leaving them
 * would put a June lead on the board as created today — wrong on the card, and
 * wrong for the thirty-minute grace window a taskless deal gets, which anchors on
 * `created_at` rather than on `submitted_at` precisely so a backdated deal is not
 * born critical.
 */
async function backdateRows(
  db: DbClient,
  backdate: { clients: Map<string, Date>; deals: Map<string, Date>; tasks: Map<string, Date> },
) {
  for (const [id, createdAt] of backdate.clients) {
    await db.client.update({ where: { id }, data: { createdAt } })
  }
  for (const [id, createdAt] of backdate.deals) {
    await db.deal.update({ where: { id }, data: { createdAt } })
  }
  for (const [id, createdAt] of backdate.tasks) {
    await db.dealTask.update({ where: { id }, data: { createdAt } })
  }
}

/**
 * Dates each «Новая заявка» announcement to the lead that caused it, and marks the
 * ones older than a week as read. The ingestion path stamps a notification when it
 * runs, so without this an imported history would arrive in the inbox as one
 * undifferentiated block of unread records dated to the import.
 */
async function realignNotifications(db: DbClient, deals: Map<string, Date>) {
  const readBefore = new Date(Date.now() - 7 * DAY_MS)
  for (const [dealId, createdAt] of deals) {
    await db.notification.updateMany({
      where: { dealId, kind: 'NEW_LEAD' },
      data: {
        createdAt,
        readAt: createdAt < readBefore ? new Date(createdAt.getTime() + HOUR_MS) : null,
      },
    })
  }
}

async function main() {
  const { dryRun, paths, source } = parseImportArgs(process.argv.slice(2))

  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL is required to import site leads')

  const rows: Array<{ line: number; row: SiteLeadRow }> = []
  for (const path of paths) rows.push(...(await readRows(path)))

  const mapped: Array<{ line: number; lead: InboundQuizLeadInput }> = []
  const skipped: Skipped[] = []
  for (const { line, row } of rows) {
    const result = toInboundLead(row, source)
    if (result.ok) mapped.push({ line, lead: result.lead })
    else skipped.push({ line, leadId: text(row.lead_id) || '(no lead_id)', reason: result.reason, detail: result.detail })
  }

  // Oldest first, so a client who submitted twice gets their deals in the order
  // they actually happened and the second lands on the deal the first opened.
  mapped.sort((a, b) => a.lead.receivedAt.localeCompare(b.lead.receivedAt))

  if (dryRun) {
    report({ imported: 0, duplicates: 0, attached: 0, mapped: mapped.length, skipped, dryRun })
    for (const { lead } of mapped) {
      console.log(`  would import ${lead.externalId}  ${lead.receivedAt}  ${lead.form}`)
    }
    return
  }

  const prisma = createPrisma(databaseUrl)
  const backgroundTasks = createBackgroundTasks()

  try {
    /**
     * A clock the import rewinds to each lead's own arrival. Every activity, task
     * due date and receipt is stamped with `clock.now()`, so a June lead produces
     * the timeline June would have produced — and passes the `receivedAt` sanity
     * bound, which is measured against this clock.
     */
    let at = new Date()
    const clock = { now: () => at }
    const crm = new CrmService({
      assignableUsers: createPrismaUsersRepository(prisma),
      clock,
      // Deliberately NOT the rewound clock: a delivery pass budgets itself against
      // wall-clock time, and one that believes it has overrun abandons its records
      // as PENDING. The announcements are made now and dated afterwards.
      notifier: createLeadNotifier(createNotificationService({ backgroundTasks, db: prisma })),
      repository: createPrismaCrmRepository(prisma),
    })

    const backdate = { clients: new Map<string, Date>(), deals: new Map<string, Date>(), tasks: new Map<string, Date>() }
    let imported = 0
    let duplicates = 0
    let attached = 0

    for (const { line, lead } of mapped) {
      at = new Date(lead.receivedAt)
      let result
      try {
        result = await crm.recordInboundQuizLead(lead)
      } catch (error) {
        skipped.push({
          line,
          leadId: lead.externalId,
          reason: 'rejected',
          detail: error instanceof Error ? error.message : String(error),
        })
        continue
      }

      if (result.status === 'duplicate-delivery') {
        duplicates += 1
        continue
      }
      if (result.status === 'attached-to-open-deal') attached += 1
      else imported += 1

      backdate.deals.set(result.dealId, at)
      backdate.clients.set(result.clientId, at)
      const tasks = await prisma.dealTask.findMany({ where: { dealId: result.dealId }, select: { id: true } })
      for (const task of tasks) backdate.tasks.set(task.id, at)
    }

    await backdateRows(prisma, backdate)
    await realignNotifications(prisma, backdate.deals)
    await backgroundTasks.drain(10_000)

    report({ imported, duplicates, attached, mapped: mapped.length, skipped, dryRun })
  } finally {
    await backgroundTasks.drain(5_000)
    await prisma.$disconnect()
  }
}

const SKIP_LABELS: Record<SkipReason, string> = {
  'no-phone': 'no usable phone (the CRM identifies a client by number)',
  'placeholder-phone': 'filler or non-Ukrainian number',
  'test-lead': 'somebody’s own test, not a customer',
  'no-timestamp': 'neither lead_id nor time carries an arrival instant',
  'contact-click': 'messenger tap, not a submission',
  schema: 'payload rejected by inboundQuizLeadSchema',
  rejected: 'refused by the CRM',
}

function report(summary: {
  imported: number
  duplicates: number
  attached: number
  mapped: number
  skipped: Skipped[]
  dryRun: boolean
}) {
  const prefix = summary.dryRun ? 'Dry run: ' : ''
  console.log(
    `${prefix}${summary.mapped} lead(s) mapped, ${summary.skipped.length} skipped.` +
      (summary.dryRun
        ? ''
        : ` Imported ${summary.imported} new deal(s), attached ${summary.attached} to an open deal, ${summary.duplicates} already present.`),
  )
  if (summary.skipped.length === 0) return
  console.log('Skipped rows:')
  for (const one of summary.skipped) {
    const detail = one.detail ? ` — ${one.detail}` : ''
    console.log(`  line ${one.line} ${one.leadId}: ${SKIP_LABELS[one.reason]}${detail}`)
  }
}

if (import.meta.main) {
  await main()
}
