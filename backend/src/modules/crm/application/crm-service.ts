import type {
  ClientDetailDto,
  ClientLookupQuery,
  ClientLookupResponse,
  DealActivityDto,
  DealBoardQuery,
  DealBoardResponse,
  DealCreateInput,
  DealDetailDto,
  DealListPage,
  DealListQuery,
  DealStageChangeInput,
  DealUpdateInput,
  InboundQuizLeadInput,
  InboundQuizLeadResult,
  NoteCreateInput,
} from '@teraso-crm/contracts'

import type { AuthenticatedPrincipal } from '../../auth'
import { CrmFailure } from '../domain/errors'
import { normalizeUaPhone } from '../domain/phone'
import { silentLeadNotifier, type Clock, type CrmRepository, type LeadNotifier } from './ports'

type CrmServiceDependencies = {
  clock: Clock
  /** Absent means nothing is announced; see `LeadNotifier`. */
  notifier?: LeadNotifier
  repository: CrmRepository
}

/**
 * The inbound statuses that are genuinely a NEW lead worth announcing (PRD 7.7).
 *
 * This branches on the STATUS and never on the HTTP code, because three of the
 * four statuses answer 201: `attached-to-open-deal` also wrote a receipt, so a
 * code-based rule would announce a "new lead" for a deal that already existed and
 * merely received another submission. `duplicate-delivery` persisted nothing at
 * all and would announce the same lead twice.
 */
const ANNOUNCEABLE_INBOUND_STATUSES = new Set<InboundQuizLeadResult['status']>([
  'created',
  'new-deal-for-existing-client',
])

/**
 * Sanity bounds for an inbound lead's own `receivedAt`, which is signed but — unlike
 * `x-teraso-timestamp` — is not otherwise constrained, and which drives both the
 * deal's `submittedAt` and the auto-task's due time.
 *
 * The window is deliberately asymmetric. A legitimate delivery can be well in the
 * past: the site retries a backlog after a CRM outage, and Task 8's end-to-end test
 * backdates on purpose so the auto-task is already overdue. A legitimate delivery is
 * never meaningfully in the future — only clock skew — while a far-future value is
 * the dangerous one: it produces a deal whose follow-up task is due far out, so the
 * lead never turns critical and silently never surfaces. Generous backwards, tight
 * forwards, closes that failure mode without refusing real retries.
 */
const INBOUND_RECEIVED_AT_MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000
const INBOUND_RECEIVED_AT_MAX_FUTURE_MS = 60 * 60 * 1000

/**
 * Use-case orchestration for clients, deals and their history.
 *
 * Authorization is deliberately "authenticated" and nothing finer. PRD 3 gives
 * the owner full access in the MVP and defers the manager role, so every
 * authenticated principal sees every deal; `responsibleUserId` is stored and
 * filterable so the future role split has the data it needs, but it is not a
 * permission boundary yet. Access is enforced at the API (PRD 10), not the UI:
 * the routes mount `requireAuth`, so an unauthenticated request never reaches
 * this class.
 */
export class CrmService {
  constructor(private readonly dependencies: CrmServiceDependencies) {}

  listDeals(input: DealListQuery, _actor: AuthenticatedPrincipal): Promise<DealListPage> {
    return this.dependencies.repository.listDeals(input, this.now())
  }

  /** The board is the list's deals grouped by active stage; it shares the clock. */
  getBoard(input: DealBoardQuery, _actor: AuthenticatedPrincipal): Promise<DealBoardResponse> {
    return this.dependencies.repository.listBoard(input, this.now())
  }

  async getDeal(dealId: string, _actor: AuthenticatedPrincipal): Promise<DealDetailDto> {
    const deal = await this.dependencies.repository.findDeal(dealId, this.now())
    if (!deal) throw dealNotFound()
    return deal
  }

  /**
   * `async` on purpose even though the body is a single call: phone
   * normalization throws, and a method that rejects for one bad input but throws
   * synchronously for another would break any caller using `.catch()`.
   */
  async createDeal(input: DealCreateInput, actor: AuthenticatedPrincipal): Promise<DealDetailDto> {
    return this.dependencies.repository.createDeal({
      input,
      phoneNormalized: normalizeUaPhone(input.phone),
      actorUserId: actor.id,
      now: this.now(),
    })
  }

  async updateDeal(
    dealId: string,
    input: DealUpdateInput,
    actor: AuthenticatedPrincipal,
  ): Promise<DealDetailDto> {
    const deal = await this.dependencies.repository.updateDeal({
      dealId,
      input,
      actorUserId: actor.id,
      now: this.now(),
    })
    if (!deal) throw dealNotFound()
    return deal
  }

  /**
   * Moves a deal through the funnel. The reachable-stage graph and the
   * payment/loss-reason rules are enforced in the repository transaction (so the
   * read and the write stay atomic); this method only resolves the actor and the
   * clock and maps a missing deal to a not-found failure.
   */
  async changeStage(
    dealId: string,
    input: DealStageChangeInput,
    actor: AuthenticatedPrincipal,
  ): Promise<DealDetailDto> {
    const deal = await this.dependencies.repository.changeStage({
      dealId,
      input,
      actorUserId: actor.id,
      now: this.now(),
    })
    if (!deal) throw dealNotFound()
    return deal
  }

  async addNote(
    dealId: string,
    input: NoteCreateInput,
    actor: AuthenticatedPrincipal,
  ): Promise<DealActivityDto> {
    const activity = await this.dependencies.repository.addNote({
      dealId,
      text: input.text,
      actorUserId: actor.id,
      now: this.now(),
    })
    if (!activity) throw dealNotFound()
    return activity
  }

  async getClient(clientId: string, _actor: AuthenticatedPrincipal): Promise<ClientDetailDto> {
    const client = await this.dependencies.repository.findClient(clientId, this.now())
    if (!client) throw new CrmFailure('not_found', 'Клиент не найден')
    return client
  }

  /**
   * Powers the duplicate-phone warning on the manual deal form (PRD 7.1). An
   * unknown number is an ordinary answer, not a failure, so this returns nulls
   * rather than throwing — the form asks about every number the owner types.
   */
  async lookupClient(
    query: ClientLookupQuery,
    _actor: AuthenticatedPrincipal,
  ): Promise<ClientLookupResponse> {
    return this.dependencies.repository.lookupClientByPhone(
      normalizeUaPhone(query.phone),
      this.now(),
    )
  }

  /**
   * Ingests one signed, schema-valid quiz delivery (PRD 6.1). The transport layer
   * has already verified the HMAC signature and freshness; this method resolves the
   * client's phone identity — throwing a validation failure for a number that
   * cannot identify a Ukrainian client — and hands a single transactional command
   * to the repository, which serializes on the `[source, externalId]` idempotency
   * identity so retried or concurrent deliveries of one lead cannot create a second
   * deal. It returns identifiers and a status only; the raw UTM and click
   * identifiers are persisted as attribution and never echoed (contract note).
   *
   * There is no `actor`: the site is not a CRM user, so inbound history is authored
   * by the system (null author), unlike every bearer-authenticated method above.
   */
  async recordInboundQuizLead(input: InboundQuizLeadInput): Promise<InboundQuizLeadResult> {
    const now = this.now()
    const receivedAt = new Date(input.receivedAt)
    if (!isReceivedAtWithinBounds(receivedAt, now)) {
      throw new CrmFailure('validation', 'Недопустимое время получения заявки')
    }

    /**
     * The contract bounds `externalId` at 1..160 characters but, unlike `source` and
     * the other strings, does not `.trim()` it — that asymmetry is settled in Task 2
     * and is not worth a contract change rippling through five call sites. So it is
     * normalized defensively here and in the repository, and a value that is only
     * whitespace is refused: it would otherwise pass the schema and become a
     * degenerate idempotency key shared by every such delivery.
     */
    if (input.externalId.trim() === '') {
      throw new CrmFailure('validation', 'Не указан внешний идентификатор заявки')
    }

    const result = await this.dependencies.repository.recordInboundQuizLead({
      input,
      phoneNormalized: normalizeUaPhone(input.phone),
      receivedAt,
      now,
    })

    await this.announceNewLead(result, input)
    return result
  }

  /**
   * Announces the lead AFTER the repository transaction has committed — never
   * inside it. A notification for a deal that then rolled back would point at
   * something the CRM does not have, which is worse than a missed alert.
   *
   * A failure here is swallowed on purpose: the lead is already stored, so
   * turning a broken notification path into a 500 would make the site retry a
   * delivery that succeeded, and the recurring dispatcher of PRD 7.7 still
   * surfaces the deal once its next-step window closes.
   */
  private async announceNewLead(result: InboundQuizLeadResult, input: InboundQuizLeadInput) {
    if (!ANNOUNCEABLE_INBOUND_STATUSES.has(result.status)) return

    try {
      await (this.dependencies.notifier ?? silentLeadNotifier).newLeadRecorded({
        dealId: result.dealId,
        clientId: result.clientId,
        clientName: input.name,
        source: input.source,
      })
    } catch (error) {
      console.error('[crm] failed to announce a new inbound lead', error)
    }
  }

  private now(): Date {
    return this.dependencies.clock.now()
  }
}

function dealNotFound() {
  return new CrmFailure('not_found', 'Сделка не найдена')
}

/** See INBOUND_RECEIVED_AT_MAX_PAST_MS for why the window is asymmetric. */
function isReceivedAtWithinBounds(receivedAt: Date, now: Date): boolean {
  const offsetMs = now.getTime() - receivedAt.getTime()
  return offsetMs <= INBOUND_RECEIVED_AT_MAX_PAST_MS && -offsetMs <= INBOUND_RECEIVED_AT_MAX_FUTURE_MS
}
