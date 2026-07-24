# Teraso CRM MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a Russian-language responsive CRM that ingests Teraso quiz leads, prevents forgotten follow-ups, tracks deals through full payment, and gives the owner sales analytics.

**Architecture:** Import di-sukharev/vibe into the current Git repository and use its React/Vite webapp, Bun/Hono backend, shared Zod contracts, Prisma/PostgreSQL and existing auth. The public Astro website and native mobile branch remain inactive. CRM is one bounded module; notifications are a separate module connected through a narrow application port.

**Tech Stack:** Bun 1.3.14, TypeScript, Hono + Zod OpenAPI, Prisma 7 + PostgreSQL 18, React 19 + Vite + TanStack Query/Form/Router, shadcn/ui, Tailwind CSS, Playwright, Web Push API and web-push 3.6.7.

## Global Constraints

- Preserve the Vibe Apache-2.0 LICENSE and NOTICE; change project identifiers deliberately to teraso-crm.
- Active surfaces: backend, webapp, packages/contracts and Docker Compose PostgreSQL. Defer website and mobile.
- Business time zone is Europe/Kyiv; currency is UAH. Store all money as PostgreSQL Decimal(14,2) and expose it as decimal strings.
- All UI copy, stage labels, task types, loss reasons and validation feedback are in Russian.
- Use the template's local shadcn/ui primitives. Product components do not accept className or style escape hatches.
- An inbound lead automatically receives the task “Первично обработать заявку” due exactly 30 minutes after receipt. Once overdue it is critical.
- Every open deal is expected to keep a future active task, but creation without one is allowed: such a deal is listed under «Без следующего шага» and becomes critical once 30 minutes pass from its creation. An overdue active task always makes the deal critical. Won and lost deals are exempt.
- Push requires a service worker, HTTPS in production and VAPID keys. The template policy requires explicit approval before installing new dependencies: web-push@3.6.7 for push delivery and @dnd-kit/core with @dnd-kit/sortable for board drag-and-drop.
- No deployment, cloud-account setup, remote repository publication or production secrets are part of this plan.

---

## File Structure

~~~text
packages/contracts/src/crm.ts                   Shared CRM enums, DTOs and query schemas
packages/contracts/src/notifications.ts         Push-subscription and inbox schemas
packages/contracts/src/crm.test.ts              Contract validation coverage
backend/prisma/schema.prisma                    CRM persistence models
backend/src/modules/crm/                        Clients, deals, tasks, activity, dashboard and webhook
backend/src/modules/notifications/              Inbox, subscriptions, VAPID delivery and dispatch
backend/src/env.ts                              Webhook/VAPID/scheduler environment validation
backend/src/app.ts                              Module composition and route mounting
backend/src/cron.ts                             Named notification-dispatch job
webapp/public/manifest.webmanifest              PWA metadata
webapp/public/service-worker.js                 Push display and notification click handling
webapp/src/platform/pwa/register.ts             Safe service-worker registration
webapp/src/features/crm/                        Typed API, queries, pages and closed CRM components
webapp/src/features/notifications/              Inbox, bell and browser-permission flow
webapp/src/routes.tsx                           Protected CRM route tree
webapp/e2e/specs/crm.spec.ts                    Browser lead-to-success journey
docs/CRM_INTEGRATION.md                         Quiz webhook protocol and retry policy
docs/OPERATIONS.md                              Scheduler, VAPID, backup and replay runbook
README.md                                       Teraso identity and active/deferred surfaces
~~~

## Task 1: Import Vibe and establish the Teraso baseline

**Files:**
- Create: Vibe template files under backend, webapp, packages/contracts, docs, scripts, .github, .do, docker-compose.yml, README.md, AGENTS.md, CLAUDE.md, package.json, bun.lock, bunfig.toml, LICENSE and NOTICE.
- Modify: package manifests, Docker Compose, examples, README.md, AGENTS.md and CLAUDE.md.
- Preserve: docs/superpowers/specs/2026-07-23-teraso-crm-design.md and this plan.
- Test: scripts/repo-env.test.mjs, scripts/architecture-check.test.mjs and contract tests.

**Consumes:** Approved PRD and Vibe master.

**Produces:** A runnable local full-stack repository named teraso-crm with Vibe authentication and administrator bootstrap intact.

- [ ] **Step 1: Capture the current repository state**

~~~bash
git status --short --branch
git remote -v
git log --oneline -3
~~~

Expected: the current documentation is present and origin is not accidentally the template remote.

- [ ] **Step 2: Import Vibe without replacing local Git history or documentation**

~~~bash
mkdir -p .scratch
git clone --depth 1 https://github.com/di-sukharev/vibe.git .scratch/vibe-template
rsync -a --exclude .git .scratch/vibe-template/ ./
~~~

Expected: all template workspaces are copied while docs/superpowers remains because rsync does not use --delete.

- [ ] **Step 3: Rename only confirmed ownership sites**

Inventory first:

~~~bash
rg -n "web_app_demo|web-app-demo|vibecoding-template|web_app_demo_test" --glob '!bun.lock'
~~~

Change each owning source to these values:

~~~text
Product slug: teraso-crm
PostgreSQL development database: teraso_crm
PostgreSQL test database: teraso_crm_test
Cookie prefix: teraso_crm
OpenAPI title: Teraso CRM API
~~~

Preserve LICENSE and NOTICE attribution. In README.md record verbatim: active surfaces are webapp, backend and packages/contracts; deferred surfaces are website and mobile; PostgreSQL runs locally through Docker Compose; deployment is outside MVP.

- [ ] **Step 4: Remove only the template bootstrap blocks**

After the durable choices are in README.md, remove the marked Bootstrap-Only Instructions blocks from AGENTS.md and CLAUDE.md. Retain their modular-monolith, migration, test and dependency policies.

- [ ] **Step 5: Configure uncommitted local environment and validate the baseline**

Create backend/.env and webapp/.env from examples, set a local ADMIN_SEED_PASSWORD, and generate a local JWT_SECRET without printing it. Then run:

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun install
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" docker compose --env-file backend/.env up -d postgres postgres_test
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run --cwd backend prisma:deploy
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run --cwd backend prisma:seed
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run test:contracts
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run architecture:check
~~~

Expected: both database services are healthy, the seeded administrator can log in, and the tests/check pass.

- [ ] **Step 6: Commit the baseline**

~~~bash
git add AGENTS.md CLAUDE.md README.md package.json bun.lock bunfig.toml docker-compose.yml backend webapp website packages scripts .github .do docs LICENSE NOTICE
git commit -m "chore: initialize Teraso CRM from vibe"
~~~

## Task 2: Define CRM contracts and persist the data model

**Files:**
- Create: packages/contracts/src/crm.ts, packages/contracts/src/notifications.ts and packages/contracts/src/crm.test.ts.
- Modify: packages/contracts/src/index.ts and backend/prisma/schema.prisma.
- Test: packages/contracts/src/crm.test.ts, Prisma validation and generated migration.

**Consumes:** Vibe contracts, PostgreSQL UUIDv7 convention and the PRD field set.

**Produces:** Typed API vocabulary and database schema for clients, deals, tasks, history, attribution, notifications and duplicate receipts.

- [ ] **Step 1: Write failing contract tests**

Add tests that reject an unknown A/B/C class, a loss without a loss reason, a task with an invalid due time, an inbound lead without externalId, and a push subscription without endpoint/p256dh/auth.

~~~ts
import { describe, expect, test } from "bun:test"
import { inboundQuizLeadSchema, taskCreateSchema } from "./crm"

describe("CRM contracts", () => {
  test("requires a stable incoming id", () => {
    expect(() => inboundQuizLeadSchema.parse({ phone: "+380935335353" })).toThrow()
  })

  test("requires an ISO due date", () => {
    expect(() => taskCreateSchema.parse({ kind: "CALL", dueAt: "tomorrow" })).toThrow()
  })
})
~~~

- [ ] **Step 2: Run the test and confirm it fails**

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun test packages/contracts/src/crm.test.ts
~~~

Expected: FAIL because crm.ts does not exist.

- [ ] **Step 3: Implement Zod schemas and exports**

Create these exact enum values and export them from packages/contracts/src/index.ts:

~~~ts
export const dealStageSchema = z.enum(["NEW", "QUALIFIED", "PROPOSAL_SENT", "PREPAYMENT", "WON", "LOST"])
export const leadClassSchema = z.enum(["A", "B", "C"])
export const taskKindSchema = z.enum(["CALL", "MESSAGE", "CLARIFY", "OTHER"])
export const taskStatusSchema = z.enum(["ACTIVE", "COMPLETED", "CANCELLED"])
export const lossReasonSchema = z.enum([
  "WRONG_NUMBER", "NO_ANSWER", "INAPPROPRIATE", "IGNORED_AFTER_CALL",
  "IGNORED_AFTER_SCORING", "CURIOSITY", "CHOSEN_COMPETITOR", "NEED_DISAPPEARED",
])
export const materialSchema = z.enum(["WPC", "WOOD", "FACADE"])
export const preferredChannelSchema = z.enum(["CALL", "TELEGRAM", "WHATSAPP", "VIBER"])
~~~

Define schemas for deal list/board filters — including needTiming, responsibleUserId, the quick flags noNextStep, overdue and dueToday, and sorting by submittedAt, nearestTaskDueAt or potentialAmount with direction — create/update deal with an optional initial task, stage change, note, task create/update with an assignee, dashboard periods (today, week, month and custom with from/to dates), incoming quiz payload, notification list, read mutation and push subscription. Money fields are decimal strings such as "65000.00".

~~~ts
export const inboundQuizLeadSchema = z.object({
  externalId: z.string().min(1).max(160),
  receivedAt: z.string().datetime(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(40),
  source: z.string().trim().min(1).max(80),
  form: z.string().trim().min(1).max(80),
  landingUrl: z.string().url(),
  material: materialSchema.optional(),
  areaLabel: z.string().trim().max(80).optional(),
  budgetLabel: z.string().trim().max(80).optional(),
  needTiming: z.string().trim().max(120).optional(),
  preferredChannel: preferredChannelSchema.optional(),
  attribution: z.object({
    metaEventId: z.string().max(180).optional(),
    utmSource: z.string().max(120).optional(),
    utmMedium: z.string().max(120).optional(),
    utmCampaign: z.string().max(180).optional(),
    utmContent: z.string().max(180).optional(),
    utmTerm: z.string().max(180).optional(),
    gclid: z.string().max(300).optional(),
    gbraid: z.string().max(300).optional(),
  }).optional(),
})
~~~

- [ ] **Step 4: Add models declaratively and generate the migration**

Extend schema.prisma with Client, Deal, DealTask, DealActivity, LeadAttribution, IngestionReceipt, Notification and PushSubscription. Add corresponding relationships to User.

Keep these mandatory constraints:

~~~prisma
model Client {
  id              String @id @default(dbgenerated("uuidv7()")) @db.Uuid
  phoneNormalized String @unique @map("phone_normalized")
  deals           Deal[]
}

model IngestionReceipt {
  id         String @id @default(dbgenerated("uuidv7()")) @db.Uuid
  source     String
  externalId String @map("external_id")
  dealId     String @map("deal_id") @db.Uuid
  @@unique([source, externalId], map: "ingestion_receipts_source_external_id_key")
}

model DealTask {
  id     String     @id @default(dbgenerated("uuidv7()")) @db.Uuid
  dueAt  DateTime   @map("due_at")
  status TaskStatus @default(ACTIVE)
  @@index([status, dueAt], map: "deal_tasks_status_due_at_idx")
}
~~~

Deal includes stage, leadClass, lossReason, an editable short currentNote, potential/prepayment/full-payment values and dates, material, area, budget, object type, need timing, preferred channel, source/form/landing URL and responsible user. DealTask stores an assignee user defaulting to the deal’s responsible. DealActivity stores its author user (null for system events such as the inbound webhook); DealActivity.metadata is JSON and records field before/after values. Every new primary key follows Vibe’s PostgreSQL UUIDv7 convention.

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run --cwd backend prisma:migrate -- --name crm_core
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run --cwd backend prisma:validate
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run test:contracts
~~~

Expected: Prisma generates migration SQL itself; schema and contracts pass.

- [ ] **Step 5: Commit the boundary**

~~~bash
git add packages/contracts backend/prisma
git commit -m "feat: define CRM contracts and data model"
~~~

## Task 3: Implement clients, deals and history through authenticated API

**Files:**
- Create: backend/src/modules/crm/index.ts, domain/phone.ts, application/ports.ts, application/crm-service.ts, infrastructure/crm-repository.ts, transport/routes.ts and focused unit/route/integration tests under the same module.
- Modify: backend/src/app.ts and backend/src/contracts.test.ts.
- Test: phone, service, route and PostgreSQL integration tests.

**Consumes:** Task 2 contracts/schema and Vibe requireAuth middleware.

**Produces:** Searchable client/deal APIs with a unified client history instead of duplicate phone records.

- [ ] **Step 1: Write failing phone/domain tests**

~~~ts
import { expect, test } from "bun:test"
import { normalizeUaPhone } from "./phone"

test("normalizes Ukrainian formatting", () => {
  expect(normalizeUaPhone("+38 (093) 533-53-53")).toBe("+380935335353")
})

test("rejects a number that cannot identify a client", () => {
  expect(() => normalizeUaPhone("123")).toThrow("Укажите корректный номер телефона")
})
~~~

- [ ] **Step 2: Verify red state**

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun test backend/src/modules/crm/domain/phone.test.ts
~~~

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement the application boundary**

Keep Hono and Prisma out of application/. Export this public interface:

~~~ts
export interface CrmService {
  listDeals(input: DealListQuery, actor: AuthenticatedPrincipal): Promise<DealListPage>
  getDeal(dealId: string, actor: AuthenticatedPrincipal): Promise<DealDetailDto>
  createDeal(input: DealCreateInput, actor: AuthenticatedPrincipal): Promise<DealDetailDto>
  updateDeal(dealId: string, input: DealUpdateInput, actor: AuthenticatedPrincipal): Promise<DealDetailDto>
  addNote(dealId: string, input: NoteCreateInput, actor: AuthenticatedPrincipal): Promise<DealActivityDto>
}
~~~

normalizeUaPhone strips formatting, converts local 0XXXXXXXXX to +380XXXXXXXXX and rejects every other value. Before creating a deal, the service resolves a client by normalized phone. Updates apply only explicit fields and append FIELD_UPDATED activities; they never erase a populated value through an omitted field.

- [ ] **Step 4: Add thin transport routes**

Mount authenticated routes in app.ts under /api/crm:

~~~text
GET    /api/crm/deals
POST   /api/crm/deals
GET    /api/crm/deals/:dealId
PATCH  /api/crm/deals/:dealId
POST   /api/crm/deals/:dealId/notes
GET    /api/crm/clients/lookup?phone=...
GET    /api/crm/clients/:clientId
~~~

Use shared Zod request/response schemas. Add /api/crm/* to the existing authenticated security middleware loop. Routes call one service method and return DTOs only. Register the lookup route before :clientId so it is not shadowed; it returns the existing client with an open-deal summary or null and powers the duplicate-phone warning in the manual deal form.

- [ ] **Step 5: Make tests green**

Cover unauthenticated 401; first formatted phone creates one client; a second deal with the same phone uses that client; the phone lookup returns that client for the duplicate warning; notes and field updates appear in chronological history with their author; filtering works for name/phone, stage, A/B/C, source, material, need timing, responsible, date and amount; the quick flags noNextStep, overdue and dueToday select the right deals; sorting orders by submission date, nearest task due time and potential amount.

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun test backend/src/modules/crm/domain/phone.test.ts backend/src/modules/crm/application/crm-service.test.ts backend/src/modules/crm/transport/routes.test.ts
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run --cwd backend test:integration
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run architecture:check
~~~

- [ ] **Step 6: Commit the vertical slice**

~~~bash
git add backend/src/app.ts backend/src/modules/crm backend/src/contracts.test.ts
git commit -m "feat: add CRM clients deals and activity API"
~~~

## Task 4: Enforce funnel, payment and task-criticality policy

**Files:**
- Create: backend/src/modules/crm/domain/deal-rules.ts, domain/deal-rules.test.ts and application/task-service.ts.
- Modify: CRM ports, service, repository, routes and CRM integration tests.
- Test: transitions, payment requirements, tasks and criticality.

**Consumes:** Task 3 CRM module.

**Produces:** Auditable stage movement, reasons for loss and server-authoritative next-step rules.

- [ ] **Step 1: Add failing pure-rule tests**

~~~ts
import { expect, test } from "bun:test"
import { evaluateDealCriticality, validateStageChange } from "./deal-rules"

test("cannot enter prepayment without payment fields", () => {
  expect(() => validateStageChange({
    from: "PROPOSAL_SENT",
    to: "PREPAYMENT",
    prepaymentAmount: undefined,
    prepaymentPaidAt: undefined,
  })).toThrow("Укажите сумму и дату предоплаты")
})

test("marks a deal critical after its task is due", () => {
  expect(evaluateDealCriticality({
    stage: "NEW",
    now: new Date("2026-07-23T10:31:00Z"),
    createdAt: new Date("2026-07-23T09:00:00Z"),
    activeDueAt: new Date("2026-07-23T10:30:00Z"),
  }).isCritical).toBe(true)
})

test("gives a fresh taskless deal a 30-minute grace period", () => {
  const state = evaluateDealCriticality({
    stage: "NEW",
    now: new Date("2026-07-23T10:20:00Z"),
    createdAt: new Date("2026-07-23T10:00:00Z"),
    activeDueAt: null,
  })
  expect(state.noNextStep).toBe(true)
  expect(state.isCritical).toBe(false)
})
~~~

- [ ] **Step 2: Confirm the test is red**

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun test backend/src/modules/crm/domain/deal-rules.test.ts
~~~

- [ ] **Step 3: Implement exactly these rules**

~~~text
Active path: NEW -> QUALIFIED -> PROPOSAL_SENT -> PREPAYMENT -> WON
Lost path: NEW|QUALIFIED|PROPOSAL_SENT|PREPAYMENT -> LOST
Reopen: WON|LOST -> NEW and add REOPENED activity
PREPAYMENT requires amount > 0 and paid date
WON requires amount > 0 and paid date
LOST requires one loss reason enum plus an optional comment stored as a note
noNextStep means an open deal with no ACTIVE task due in the future
hasOverdueTask means an open deal with any ACTIVE task due at or before now
Critical means hasOverdueTask, or noNextStep once 30 minutes have passed since deal creation
Won and lost deals are never noNextStep, overdue or critical
~~~

Manual deal creation accepts an optional initial task and never blocks on its absence; a taskless deal follows the 30-minute rule above. The inbound path in Task 5 is the only system-created initial task.

- [ ] **Step 4: Expose task/funnel operations**

~~~text
POST   /api/crm/deals/:dealId/stage
POST   /api/crm/deals/:dealId/tasks
PATCH  /api/crm/tasks/:taskId
GET    /api/crm/deals/board
GET    /api/crm/tasks/critical
~~~

Every transition, task create/complete/cancel/reschedule appends a typed activity with its author. Board/list DTOs include isCritical, noNextStep, hasOverdueTask, nearestActiveTask, stage, class, source, submission time and potential amount so UI code does not calculate urgency.

- [ ] **Step 5: Validate and commit**

Cover five active stages, eight loss reasons, reopening, task exactly at now, completed task, cancelled task, future task clearing criticality, and a taskless open deal inside (not critical) and past (critical) the 30-minute grace window.

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun test backend/src/modules/crm/domain/deal-rules.test.ts backend/src/modules/crm/application/crm-service.test.ts
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run --cwd backend test:integration
git add backend/src/modules/crm
git commit -m "feat: enforce CRM funnel and follow-up rules"
~~~

## Task 5: Ingest signed Teraso quiz leads idempotently

**Files:**
- Create: backend/src/modules/crm/transport/inbound-routes.ts and inbound-routes.test.ts.
- Modify: backend/src/env.ts, backend/.env.example, backend/src/app.ts, CRM index/service/ports/repository and docs/CRM_INTEGRATION.md.
- Test: signature, age, payload, duplicate delivery, existing-client and open-deal tests.

**Consumes:** Task 2 inbound schema and Task 4 task policy.

**Produces:** A site webhook that writes full marketing data, starts a 30-minute response task and cannot create duplicates on retries.

- [ ] **Step 1: Write failing endpoint tests**

Use a test secret and HMAC-SHA256 over timestamp + "." + raw body. Prove valid payload returns 201; identical source/externalId returns 200 and original deal ID; altered body returns 401; an older-than-five-minute payload returns 401; an existing client with an open deal receives an activity rather than a duplicate deal.

~~~ts
const signature = createHmac("sha256", "test-webhook-secret")
  .update(timestamp + "." + rawBody)
  .digest("hex")
~~~

- [ ] **Step 2: Run the endpoint test**

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun test backend/src/modules/crm/transport/inbound-routes.test.ts
~~~

Expected: FAIL because the route is not mounted.

- [ ] **Step 3: Validate raw requests before parsing**

Add TERASO_WEBHOOK_SECRET, TERASO_WEBHOOK_MAX_AGE_SECONDS=300 and TERASO_WEBHOOK_BODY_LIMIT_BYTES=65536 to AppEnv and .env.example. Read raw body once, enforce limit, require x-teraso-timestamp and x-teraso-signature, compare HMAC using timing-safe equality, and reject timestamps outside five minutes before applying inboundQuizLeadSchema. Log every rejected delivery with its reason (signature, age, body limit or validation) to the server log so failed webhooks are traceable.

- [ ] **Step 4: Make one transactional recordInboundQuizLead service**

~~~ts
recordInboundQuizLead(input: InboundQuizLeadInput): Promise<{
  status: "created" | "duplicate-delivery" | "attached-to-open-deal" | "new-deal-for-existing-client"
  clientId: string
  dealId: string
}>
~~~

Transaction order: check [source, externalId] receipt; normalize phone; resolve client; attach activity to open deal or create a new deal; persist receipt and attribution; add INBOUND_LEAD_RECEIVED; for a newly created deal create ACTIVE “Первично обработать заявку” due at receivedAt + 30 minutes. Return only IDs/status, never raw UTM/click identifiers.

- [ ] **Step 5: Document site integration**

Create docs/CRM_INTEGRATION.md with endpoint, headers, signing bytes, payload matching inboundQuizLeadSchema, retry semantics and a redacted version of the supplied quiz payload. State explicitly: x-teraso-timestamp is the time of the current delivery attempt and the signature is recomputed for every retry, so redelivery after CRM downtime longer than five minutes still succeeds; a 401 is retryable with a fresh signature, while a schema-validation 400 is not retryable.

- [ ] **Step 6: Validate and commit**

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun test backend/src/modules/crm/transport/inbound-routes.test.ts
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run --cwd backend test:integration
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run architecture:check
git add backend docs/CRM_INTEGRATION.md
git commit -m "feat: ingest Teraso quiz leads securely"
~~~

## Task 6: Add durable notifications and browser push delivery

**Files:**
- Create: backend/src/modules/notifications/index.ts; application/notification-service.ts and ports.ts; infrastructure/push-repository.ts and web-push-delivery.ts; transport/routes.ts; focused tests.
- Modify: backend/package.json, bun.lock, backend/src/env.ts, backend/.env.example, backend/src/app.ts, backend/src/cron.ts, cron.test.ts and CRM service composition.
- Test: notification service, delivery adapter mock, subscription access and cron idempotency.

**Consumes:** CRM facts from Tasks 3–5 and Vibe named cron runner.

**Produces:** In-app notification inbox, VAPID browser delivery, immediate new-lead alert and recurring due/overdue dispatch.

- [ ] **Step 1: Obtain dependency approval, then install only web-push**

The imported template requires approval before new production dependencies. Ask for permission to add web-push@3.6.7, an MPL-2.0 package that handles VAPID signing and encrypted Web Push payloads. After approval:

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun add --cwd backend web-push@3.6.7
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun add --cwd backend -d @types/web-push
~~~

- [ ] **Step 2: Write red tests for durable/idempotent notification facts**

Test one NEW_LEAD notification after inbound creation; one TASK_DUE event per task and due instant even if cron runs twice; failed push retains inbox record; subscription belongs only to authenticated owner.

~~~ts
test("dispatch is idempotent for a due task", async () => {
  await service.dispatchDueEvents(now)
  await service.dispatchDueEvents(now)
  expect(await repository.countByEventKey("task-due:task-1:2026-07-23T10:30:00.000Z")).toBe(1)
})
~~~

- [ ] **Step 3: Implement public port and records**

~~~ts
export interface NotificationWriter {
  create(input: {
    recipientUserId: string
    kind: "NEW_LEAD" | "TASK_DUE" | "TASK_OVERDUE" | "LEAD_NEEDS_ACTION"
    title: string
    body: string
    href: string
    eventKey: string
  }): Promise<void>
}
~~~

Notification has unique eventKey, read timestamp, delivery state and deal relation. PushSubscription stores a user-owned endpoint with p256dh/auth keys; endpoint is unique. VAPID_SUBJECT, VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are server environment only. Remove subscriptions only when provider returns terminal 404 or 410.

- [ ] **Step 4: Trigger from committed domain facts and cron**

Inject NotificationWriter into CRM at app composition. Generate NEW_LEAD only after inbound transaction commits. Add crm:notifications:dispatch to cron.ts; every run finds TASK_DUE, TASK_OVERDUE and LEAD_NEEDS_ACTION conditions (the last one is a deal noNextStep past its 30-minute grace), creates deterministic event-key records derived from the task or deal id plus the instant the condition began, and then best-effort sends unread notifications. It never changes a deal’s business state and is safe to run every minute.

- [ ] **Step 5: Expose authenticated inbox/subscription API**

~~~text
GET    /api/notifications
POST   /api/notifications/read
POST   /api/notifications/subscriptions
DELETE /api/notifications/subscriptions/:subscriptionId
GET    /api/notifications/vapid-public-key
~~~

Return the public VAPID key only. A user never receives another user’s notification or subscription data.

- [ ] **Step 6: Validate and commit**

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun test backend/src/modules/notifications backend/src/cron.test.ts
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run --cwd backend test:integration
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run architecture:check
git add backend/package.json bun.lock backend/src backend/.env.example
git commit -m "feat: add CRM notifications and push delivery"
~~~

## Task 7: Build CRM list, card and responsive shadcn interface

**Files:**
- Create: webapp/src/features/crm/index.ts, model.ts, api.ts, queries.ts, pages.tsx; components/DealList.tsx, DealFilterBar.tsx, DealDetail.tsx, DealForm.tsx, ActivityTimeline.tsx, ContactActions.tsx, CriticalBadge.tsx and CommandSearch.tsx; webapp/tests/crm-api.test.ts, webapp/tests/crm-list.test.tsx and webapp/tests/crm-detail.test.tsx.
- Modify: webapp/src/routes.tsx, pages.tsx, dashboard/AppSidebar.tsx, dashboard/NavMain.tsx and root-layout.tsx.
- Test: API adapter, URL filter, protected page and form rendering tests.

**Consumes:** Shared contracts, authenticated CRM API, Vibe auth/query setup and installed shadcn primitives.

**Produces:** A usable owner-facing CRM that finds, edits and calls a lead from desktop or phone.

- [ ] **Step 1: Write failing UI/API tests**

Mock fetch using the existing template pattern. Assert listDeals serializes filters, quick flags and sorting; getDeal validates shared DTOs; DealForm warns about an existing client when the phone matches; and critical status always shows text rather than colour alone.

~~~tsx
test("shows explicit urgency text", () => {
  render(<CriticalBadge isCritical />)
  expect(screen.getByText("Требует действия")).toBeTruthy()
})
~~~

- [ ] **Step 2: Verify red state**

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun test webapp/tests/crm-api.test.ts webapp/tests/crm-list.test.tsx webapp/tests/crm-detail.test.tsx
~~~

- [ ] **Step 3: Implement typed data boundary**

api.ts imports authenticatedTransport only, never React. queries.ts defines these exact TanStack keys:

~~~ts
export const crmQueryKeys = {
  deals: (filters: DealListQuery) => ["crm", "deals", filters] as const,
  deal: (dealId: string) => ["crm", "deal", dealId] as const,
  board: (filters: DealBoardQuery) => ["crm", "board", filters] as const,
  dashboard: (period: DashboardPeriod) => ["crm", "dashboard", period] as const,
}
~~~

Mutations invalidate list, deal, board, dashboard and notification keys after success.

- [ ] **Step 4: Build list, filters, card and history**

Use local Table, Input, Select, Badge, Button, Sheet, Dialog, Popover, Calendar, Tabs, Skeleton, Empty, Alert, Command and Sonner primitives. Keep stage/class/source/material/need-timing/responsible/date/sum filter state, the quick filters «Без следующего шага», «Просрочено», «Сегодня», «Предоплата», «Успех» and «Потеряно», and sorting by submission date, nearest task due time or potential amount in URL query parameters. Search covers name and phone. CommandSearch opens on Cmd+K (plus a visible search button on mobile), queries the deal list endpoint by name or phone and navigates to the selected card.

DealForm validates the phone as it is entered and, when the client lookup finds an existing client, shows a non-blocking warning with a link to that client’s card; submission then attaches the deal to the existing client. An initial task is optional at creation.

DealDetail shows client name/phone (rendered in readable formatting), source/date, stage, A/B/C, money fields, material/area/budget/object/need fields, channel, an editable short current note, the immutable timeline where every entry shows its date and author, a reopen action for won and lost deals, and an attribution drawer. Raw UTM identifiers never appear in the default operational header.

Contact actions create only links:

~~~ts
const number = deal.client.phoneNormalized.replace(/^\+/, "")
const contactLinks = {
  call: "tel:" + deal.client.phoneNormalized,
  telegram: "https://t.me/+" + number,
  whatsapp: "https://wa.me/" + number,
  viber: "viber://chat?number=%2B" + number,
}
~~~

- [ ] **Step 5: Compose routes/navigation**

Add protected routes /app/dashboard, /app/deals, /app/board, /app/deals/$dealId, /app/tasks and /app/notifications. Replace demo links with Russian Дашборд, Сделки, Воронка, Задачи, Уведомления and Настройки. Retain the dashboard shell as a closed unit and use Sheet navigation on narrow displays.

- [ ] **Step 6: Validate and commit**

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run --cwd webapp test
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run typecheck:webapp
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run architecture:check
git add webapp
git commit -m "feat: add CRM list and deal detail interface"
~~~

## Task 8: Add board, task workflow, dashboard and installable notification UI

**Files:**
- Create: webapp CRM components DealBoard.tsx, DealBoardCard.tsx, TaskDialog.tsx, TaskQueue.tsx, DashboardMetrics.tsx, FunnelChart.tsx and SourcePerformanceTable.tsx; webapp notification index.ts, api.ts, queries.ts, NotificationBell.tsx, NotificationInbox.tsx and PushPermissionCard.tsx; manifest.webmanifest, service-worker.js, platform/pwa/register.ts; UI tests and e2e/crm.spec.ts.
- Modify: CRM contracts/API/service/repository/routes for dashboard DTO; webapp/package.json and bun.lock for the approved @dnd-kit packages; webapp index.html, main.tsx, root-layout.tsx, CRM pages and routes; backend seed only as required for test journey.
- Test: aggregation, board/task forms, PWA capability, inbox and Playwright journey.

**Consumes:** All earlier backend functionality and the CRM UI from Task 7.

**Produces:** The owner’s daily work surface: Kanban, critical queue, dashboard, in-app notifications and PWA push permission.

- [ ] **Step 1: Write failing metrics, board and PWA tests**

Use fixture deals across dates/stages. Assert pipeline sums only open non-null potential amounts; prepayment totals use prepayment paid date; won totals use full-payment paid date; prepayment is not won; won count matches full payments in the period; funnel counts transitions from STAGE_CHANGED activities inside the period, not the current stage snapshot. Assert board critical label, a drop onto Предоплата opening the payment dialog with rollback on cancel, mandatory task date and inbox fallback when permission is denied.

~~~ts
expect(report).toMatchObject({
  openPipelineAmount: "65000.00",
  prepaymentReceivedAmount: "20000.00",
  wonPaymentAmount: "80000.00",
})
~~~

~~~tsx
test("inbox remains useful after push denial", () => {
  render(<PushPermissionCard permission="denied" />)
  expect(screen.getByText("Уведомления остаются в CRM")).toBeTruthy()
})
~~~

- [ ] **Step 2: Add dashboard contract/API and validate aggregation**

Expose:

~~~text
GET /api/crm/dashboard?period=month
GET /api/crm/dashboard?period=custom&from=2026-07-01&to=2026-07-23
GET /api/crm/deals/board?stage=NEW&isCritical=true
~~~

The board path is the same /api/crm/deals/board that Task 4 mounts. DashboardDto contains openPipelineAmount, prepaymentReceivedAmount, wonPaymentAmount, wonDealCount, newLeadCount, tasksDueTodayCount, overdueTaskCount, noNextStepDealCount, criticalDealCount, funnel and sources. Funnel reports, for each pair of adjacent stages, the count and share of deals that made that transition during the period, computed from STAGE_CHANGED activities. Sources groups by source and UTM source with lead count, open pipeline amount and won count and amount. Aggregate Decimal amounts in PostgreSQL and serialize as strings; never total in the browser.

- [ ] **Step 3: Build board and task controls**

First mirror the web-push flow: ask for approval, then install @dnd-kit/core and @dnd-kit/sortable at the versions confirmed during approval. Render five active stage columns inside a DndContext with pointer, touch and keyboard sensors. Each DealBoardCard shows name, submitted date, source, class, potential amount and nearest task; clicking opens detail, and dragging a card to another column changes its stage through the same endpoint the card form uses. Dropping onto Предоплата or Успех opens the payment dialog, and a dedicated Потеряно drop zone below the columns opens the loss-reason dialog; the stage commits only on confirmation and the card returns to its column on cancel or server rejection. TaskDialog requires type, exact Europe/Kyiv time and text; the assignee defaults to the current user. Completing the last active task on an open deal shows a next-step warning and opens the schedule dialog; server-computed noNextStep/overdue/critical flags remain authoritative.

Use AlertDialog for LOST, require reason selection and allow an optional comment saved as a note. Prepayment/success forms require payment fields. Use Badge and icon/text for every colour-coded state.

- [ ] **Step 4: Build dashboard and PWA**

Top controls select today/week/month/custom. Use shadcn cards for all metrics, shadcn chart primitives for funnel, and accessible source table. Format decimal UAH values through:

~~~ts
new Intl.NumberFormat("uk-UA", {
  style: "currency",
  currency: "UAH",
  maximumFractionDigits: 0,
})
~~~

Create manifest with name/short_name Teraso CRM, start_url /app/dashboard, display standalone, lang ru, theme #18181b and background #fafafa. Service worker accepts { title, body, href }, displays notification, and opens/focuses href on click. It does not cache tokens or CRM customer data.

PushPermissionCard requests browser permission only after click, fetches VAPID public key, subscribes through PushManager, sends the subscription to API and explains fallback on denial/unsupported browser. NotificationBell opens a Sheet inbox, marks notification read and navigates to href.

- [ ] **Step 5: Write the red-to-green browser journey**

Use real test backend and signed test webhook. Send receivedAt more than 30 minutes in the past with a fresh delivery timestamp so the auto-created task is already overdue and the critical state is visible immediately. The seeded administrator must: open new lead; see incoming source/material/area/budget and critical text; add call note; set B; schedule follow-up; move through qualification/proposal/prepayment/full success; see full-payment amount on dashboard; replay same externalId and still see one deal.

Use only these stable test IDs: deal-row-<id>, deal-stage-select, task-due-at, save-task, mark-prepayment, mark-won and dashboard-won-amount.

- [ ] **Step 6: Run complete validation and commit**

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run test:contracts
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run test:backend
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run test:webapp
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run architecture:check
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run typecheck
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run build
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run e2e:webapp -- --grep "quiz lead reaches success"
git add packages/contracts backend webapp
git commit -m "feat: complete Teraso CRM operations workflow"
~~~

## Task 9: Document operation and final proof

**Files:**
- Create: docs/OPERATIONS.md.
- Modify: README.md and docs/TESTING.md only if a new CRM test command is needed.
- Test: repeat complete validation with no uncommitted code changes after documentation.

**Consumes:** Completed user journey from Task 8.

**Produces:** A safe handoff for website integration, VAPID, scheduler, backups and incident recovery.

- [ ] **Step 1: Write operations runbook**

Include: required production variable names without values (database, auth, TERASO_WEBHOOK_SECRET, VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, CORS origins and public webapp URL); one-time VAPID key generation outside Git; cron command bun run --cwd backend start:cron -- crm:notifications:dispatch scheduled every minute; signed test-lead verification; replay investigation by source + externalId using a redacted payload; backup owner and restore rehearsal cadence; rule that normal MVP UI never deletes client/deal/task/activity; removal of a push subscription only after 404/410 while retaining inbox notification.

- [ ] **Step 2: Run final validation**

~~~bash
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run test
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run typecheck
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run build
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run e2e:webapp -- --grep "quiz lead reaches success"
git status --short
~~~

Expected: all checks exit 0 and the only pending change before commit is operations documentation.

- [ ] **Step 3: Commit operational handoff**

~~~bash
git add docs/OPERATIONS.md README.md docs/TESTING.md
git commit -m "docs: add Teraso CRM operations runbook"
~~~

## Coverage Review

| PRD requirement | Tasks |
| --- | --- |
| Client fields, A/B/C and history | 2, 3, 7 |
| Search, filters and click-to-contact | 3, 7 |
| Funnel, payments and lost reasons | 2, 4, 8 |
| Tasks and 30-minute forgotten-lead rule | 4, 5, 6, 8 |
| Website quiz, UTM and duplicate prevention | 2, 5, 8 |
| Push and in-app reminders | 2, 6, 8 |
| Mobile PWA | 7, 8 |
| Dashboard, funnel conversion and sources | 2, 8 |
| Future manager-ready owner model | 2, 3 |
| shadcn/ui visual system | 1, 7, 8 |
| Board drag-and-drop stage change | 4, 8 |
| Quick filters, sorting and command search | 2, 3, 7 |
| Duplicate-phone warning on manual creation | 3, 7 |

## Plan Self-Review

- **Spec coverage:** Every agreed MVP requirement appears in the coverage table.
- **Order:** contracts/schema precede all consumers; CRM logic precedes external webhook/UI; notifications run after business facts exist; E2E finishes the same user flow.
- **Consistency:** identical stage, task, money and notification names are defined once in contracts and used by the backend, webapp and tests.
- **Risk coverage:** tests include invalid phones, access control, invalid payments, the 30-minute grace window for taskless deals, signature tampering, stale/replayed webhook, retry after downtime with a re-signed timestamp, duplicate delivery, cancelled board drops, failed push delivery and denied browser permission.
- **Scope:** messaging sync, automated nurture, price calculation, native apps, multilingual UI and deployment remain out of scope.
