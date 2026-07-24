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
import type { Clock, CrmRepository } from './ports'

type CrmServiceDependencies = {
  clock: Clock
  repository: CrmRepository
}

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
    return this.dependencies.repository.recordInboundQuizLead({
      input,
      phoneNormalized: normalizeUaPhone(input.phone),
      receivedAt: new Date(input.receivedAt),
      now: this.now(),
    })
  }

  private now(): Date {
    return this.dependencies.clock.now()
  }
}

function dealNotFound() {
  return new CrmFailure('not_found', 'Сделка не найдена')
}
