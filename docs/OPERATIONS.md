# Operations

The runbook for whoever keeps Teraso CRM running: what to set, what to schedule,
how to prove the site integration works, and what to do when something looks
wrong. It assumes you can open a terminal and paste commands. It does not assume
you write code.

Deployment itself is **out of MVP scope** — nothing here says "deploy now". It
says: when the CRM is deployed, these are the values it needs and these are the
failures that do not announce themselves.

Related documents, which this one deliberately does not repeat:

- [CRM_INTEGRATION.md](CRM_INTEGRATION.md) — the site webhook contract: payload,
  signature, retries, response codes. Give this to whoever maintains
  `teraso.com.ua`.
- [DEPLOYMENT.md](DEPLOYMENT.md) — DigitalOcean App Platform specs and the
  release workflow.
- [LOCAL_DATABASE.md](LOCAL_DATABASE.md) and the root
  [README.md](../README.md) — local PostgreSQL, including the Compose project
  trap.
- [TESTING.md](TESTING.md) — how to run the automated checks.

---

## 1. What is running

Three moving parts. Two of them announce their own failure; one does not.

| Part | What it is | If it stops |
| --- | --- | --- |
| **API** | The backend the browser and the site talk to. | Everything stops at once. Obvious. |
| **Database** | PostgreSQL 18. All the business data. | Everything stops at once. Obvious. |
| **Scheduler** | Two short jobs on a timer (§4). | **Nothing visibly breaks.** The CRM keeps working; task reminders and lead alerts simply never arrive. |

The scheduler is the one to watch. Nobody notices missing notifications for days,
because the screens all still work.

---

## 2. Production environment variables

Names only. Never write a real value into this repository, a ticket, a chat
message, or a screenshot. `backend/.env.example` documents the same list with
inline notes.

### Core — set all of these on every deployment

The first two have no defaults: without them the process does not start.

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. **No default.** On DigitalOcean, bind the managed database component rather than pasting credentials. |
| `JWT_SECRET` | Signs sign-in tokens. **No default**, and production requires 64+ hex characters. **Changing it signs everybody out.** |
| `CORS_ORIGINS` | Comma-separated list of the exact browser origins allowed to call the API — normally just the CRM's own address. HTTPS only in production; no wildcards, no trailing paths. |
| `WEBAPP_ORIGIN` | The public address of the CRM in the browser, used to build links in transactional email such as password reset. Origin only, no path. Falls back to the first `CORS_ORIGINS` entry, so set it explicitly rather than relying on ordering. |
| `COOKIE_SECURE` | Must be `true` in production. With `NODE_ENV=production` the process refuses to start otherwise. |
| `PORT` | Port the API listens on. Defaults to `3000`; set it to whatever the hosting platform expects (the generated DigitalOcean spec uses `8080`). |

Behind a load balancer or CDN, also set `TRUST_PROXY=true` together with
`TRUSTED_PROXY_CLIENT_IP_HEADER` (on DigitalOcean App Platform:
`do-connecting-ip`). Without it every request looks like it comes from the proxy,
and the rate limiter in §11.1 meters your whole company as one visitor.

### Site integration — required for leads to arrive from teraso.com.ua

| Variable | What it is |
| --- | --- |
| `TERASO_WEBHOOK_SECRET` | The shared secret the site signs each lead with. |
| `TERASO_WEBHOOK_MAX_AGE_SECONDS` | Optional. How stale a signature may be. Default 300. |
| `TERASO_WEBHOOK_BODY_LIMIT_BYTES` | Optional. Maximum payload size. Default 65536. |

**Unset is a valid, safe setting**: the endpoint then rejects every delivery with
`401` and the CRM still starts. That is the correct state until the site is
wired up — but it is indistinguishable from a misconfigured deployment unless you
run the check in §5.

Generate the secret, never invent one:

```bash
openssl rand -hex 32
```

Set the identical value on both sides. Rotation is not atomic: while the two
sides disagree, deliveries fail with `401` and the site's normal retry recovers
once both match.

### Browser push — required for phone/desktop notifications

| Variable | What it is |
| --- | --- |
| `VAPID_SUBJECT` | A `mailto:` address or `https://` URL a push provider can use to reach you. |
| `VAPID_PUBLIC_KEY` | Public half of the signing pair. The only one ever sent to a browser. |
| `VAPID_PRIVATE_KEY` | Private half. Never leaves the server. |

All three or none. A partial group fails at startup with a message naming the
missing variable — deliberately, so a half-configured pair cannot fail silently
later.

**Leaving all three unset is supported and safe.** The CRM still records every
notification and the bell icon inside the app still shows it; the phone-level
push is simply marked `SKIPPED`. The in-app notification centre is the source of
truth. See §6 for how to tell the two states apart.

### Tuning — safe to leave at defaults

| Variable | Default | Effect |
| --- | --- | --- |
| `NOTIFICATION_TASK_OVERDUE_AFTER_MINUTES` | `15` | Minutes a task waits past its due time before the second, "Просроченная задача" nag. Max 1440. See §11.3. |
| `AUTH_RATE_LIMIT_MAX` | `60` | Write requests allowed per IP per window. See §11.1 before changing. |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `60` | Length of that window. |
| `AUTH_BODY_LIMIT_BYTES` | `65536` | Maximum request size on the authenticated surface. |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | How often the browser silently refreshes its session. |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | How long "stay signed in" lasts. |
| `SESSION_ABSOLUTE_TTL_DAYS` | `90` | Hard ceiling on one sign-in, regardless of activity. |
| `SESSION_RETENTION_DAYS` | `7` | How long dead session rows are kept before the cleanup job removes them. |
| `SHUTDOWN_GRACE_SECONDS` | `20` | Time in-flight requests get to finish during a restart. |

`ADMIN_SEED_EMAIL` and `ADMIN_SEED_PASSWORD` belong **only** to the one-time
pre-deploy bootstrap job that creates the first administrator. They must never
be attached to the running API.

### The generated deployment specs do not cover all of this

`bun run deploy:do:specs` and `.do/backend-app.yaml.example` produce a working
API and database, but as they stand they **do not emit**:

- `TERASO_WEBHOOK_SECRET` — a deployment built from them rejects every lead from
  the site with `401`;
- `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — every push is marked
  `SKIPPED` and `GET /api/notifications/vapid-public-key` answers `404`. The bell
  inside the app keeps working, so **nothing anywhere reports an error**;
- `NOTIFICATION_TASK_OVERDUE_AFTER_MINUTES` — falls back to its default, which is
  fine, but is not tunable from the spec.

They also generate **one** scheduled-job slot
(`DO_BACKEND_CRON_NAME` / `DO_BACKEND_CRON_TASK` / `DO_BACKEND_CRON_SCHEDULE`),
while this CRM needs **two** jobs (§4).

Until the generator is extended, whoever deploys must add those variables and the
second job to the app configuration by hand, on **both** the API service and the
notification job, and then confirm the result with §5 and §6. This is recorded as
follow-up work in §12.

---

## 3. Generating the VAPID pair, once

Browser push is signed with one key pair. Generate it once, keep it forever, and
keep it out of Git.

```bash
cd backend
bunx web-push generate-vapid-keys
```

It prints a public key and a private key. Then:

1. Paste both into your hosting provider's secret store, as
   `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.
2. Set `VAPID_SUBJECT` to a real contact address, e.g. a `mailto:` you read.
3. Clear your terminal history if it recorded the output.
4. Do **not** put them in `backend/.env.example`, a commit, a doc, or a chat.

**Regenerating the pair invalidates every existing subscription.** Everyone who
allowed notifications has to allow them again. Treat the pair as permanent.

`backend/.env` is git-ignored and is for local development only. Local
development does not need push configured at all.

---

## 4. The scheduler

Two jobs. Both are single-shot commands: they run, print one line, and exit.

**Both jobs need the same environment as the API** — at minimum `DATABASE_URL`
and `JWT_SECRET`. The dispatch job additionally needs the **`VAPID_*` group and
`NOTIFICATION_TASK_OVERDUE_AFTER_MINUTES`**: it is the process that actually sends
push, so configuring push on the API alone leaves it disabled where it matters.

### Notification dispatch — every minute

```bash
bun run --cwd backend start:cron -- crm:notifications:dispatch
```

On a normal cron, every minute:

```cron
* * * * * cd /path/to/teraso-crm && bun run --cwd backend start:cron -- crm:notifications:dispatch
```

Announces tasks that have come due, tasks still unfinished past their escalation
delay, and leads that spent their next-step window without a task. Then makes one
best-effort push pass.

Healthy output:

```
Cron crm:notifications:dispatch created 0 notifications and pushed 0.
```

`created 0 ... pushed 0` is normal and means "nothing was due this minute". It is
not a failure.

The job is safe to run as often as the scheduler allows and safe to run twice
concurrently: it never changes a deal's business state, and every record it
writes is keyed on the instant its condition began, so a repeat run writes the
same key and the database collapses it.

It looks **24 hours back**. If the scheduler is stopped for longer than a day,
the notifications for that gap are gone for good — the work items themselves are
not, they are still in the CRM as overdue tasks.

### Session cleanup — daily is enough

```bash
bun run --cwd backend start:cron -- auth:sessions:cleanup
```

```cron
0 3 * * * cd /path/to/teraso-crm && bun run --cwd backend start:cron -- auth:sessions:cleanup
```

Removes dead session rows past `SESSION_RETENTION_DAYS` and expired password-reset
tokens. Housekeeping; skipping it costs disk, not correctness.

Healthy output:

```
Cron auth:sessions:cleanup removed 0 stale sessions and 0 expired password reset tokens.
```

### A typo in the task name fails loudly

An unrecognised task name exits non-zero with
`Unknown cron task "…". Available tasks: …`. It never silently does nothing.

### Cadence on DigitalOcean App Platform

App Platform scheduled jobs cannot run more often than **every 15 minutes**, and
the spec generator enforces that floor (`scripts/do-cron.mjs`). `* * * * *` and
`*/5 * * * *` are rejected with a message naming the limit; the fastest legal
schedule is:

```
*/15 * * * *
```

Both cadences are correct — the job is idempotent either way — but on App Platform
a task-due notification can arrive **up to 15 minutes late**. If minute-level
punctuality matters, run the dispatch job from a scheduler that allows it (a
normal cron on a small VM, for example) rather than trying to shorten the App
Platform schedule.

### If notifications stop arriving

Work down this list; the first three cost nothing.

1. Is the job running at all? Check the scheduler's own run history for the
   one-line summary above.
2. Is the bell inside the CRM showing new items? If **yes**, the dispatch job is
   fine and the problem is push delivery only (§6).
3. If **no**, run the command by hand and read the output.
4. Check `NOTIFICATION_TASK_OVERDUE_AFTER_MINUTES` has not been set to something
   absurd.

---

## 5. Proving the site integration works

Do this after every deployment, after a secret rotation, and whenever someone
says "we sent you a lead and it is not in the CRM".

**Before you start, understand what this creates.** A test lead is a real lead.
It creates a real client and a real deal that **cannot be deleted** from the CRM
(§7). Use an obviously fake name and a `source` you will recognise later, such as
`operations-check`, and afterwards move the deal to «Потеряна» so it leaves the
active funnel. It stays in the history for good; that is by design.

Save this file as `send-test-lead.mjs` **outside the repository** (it does not
contain a secret, but it is not project code):

```js
import { createHmac } from 'node:crypto'

const url = process.env.CRM_URL
const secret = process.env.TERASO_WEBHOOK_SECRET
if (!url || !secret) {
  console.error('Set CRM_URL and TERASO_WEBHOOK_SECRET in the environment first.')
  process.exit(1)
}

const lead = {
  externalId: `lead_healthcheck_${Date.now()}`,
  receivedAt: new Date().toISOString(),
  name: 'Проверка связи',
  phone: '+380671112233',
  source: 'operations-check',
  form: 'Проверка',
  landingUrl: 'https://teraso.com.ua/kviz',
}

const body = JSON.stringify(lead)
const timestamp = Math.floor(Date.now() / 1000).toString()
const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

const response = await fetch(`${url}/api/crm/inbound/quiz`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-teraso-timestamp': timestamp,
    'x-teraso-signature': signature,
  },
  body,
})

console.log(response.status, await response.text())
```

Run it with the secret in the environment, never as a command-line argument —
arguments are visible to anyone who can list processes on that machine:

```bash
export CRM_URL="https://<your-crm-api-host>"
read -rs TERASO_WEBHOOK_SECRET && export TERASO_WEBHOOK_SECRET   # paste, nothing is echoed
bun send-test-lead.mjs        # node send-test-lead.mjs works identically
unset TERASO_WEBHOOK_SECRET
```

### Reading the answer

| Response | Meaning |
| --- | --- |
| `201 {"status":"created",...}` | Working. New client, new deal. |
| `201 {"status":"new-deal-for-existing-client",...}` | Working. That phone was already known. |
| `201 {"status":"attached-to-open-deal",...}` | Working. That phone already had an open deal, so the lead was appended to it instead of creating a second one. **This is what a repeat health check returns if you reuse the same phone number** — it is a success. |
| `200 {"status":"duplicate-delivery",...}` | Working. You sent an `externalId` that was already stored; it returned the original deal and wrote nothing. |
| `401` | The secret does not match, is unset on the server, or the clock is skewed by more than `TERASO_WEBHOOK_MAX_AGE_SECONDS`. Recheck the secret on both sides first. |
| `400` | The payload is wrong — the phone is not a valid Ukrainian number, or `receivedAt` is not UTC with a `Z` suffix. Retrying changes nothing; fix the payload. |
| `413` | The payload is over the size limit. |
| No response / `5xx` | The API is down or unreachable. |

Then open the CRM and confirm the deal is visible under «Сделки». If the API
answered `201` but nothing appears on screen, the problem is sign-in or access,
not the integration.

For everything about the payload, the signature and retry rules, see
[CRM_INTEGRATION.md](CRM_INTEGRATION.md).

---

## 6. Telling "push is off" apart from "push is broken"

Push notifications are an extra channel. **The bell inside the CRM is the source
of truth** and always records everything, whether or not the phone buzzes.

**No screen tells you that the server has no VAPID pair**, and this is the single
most important thing in this section. The «Push-уведомления» card in the CRM
reports the *browser's* permission — granted, denied, unsupported, not yet asked —
not the server's configuration. On a deployment with no VAPID pair:

- somebody who has already allowed notifications sees **nothing at all**. The
  re-subscription attempt fails in the background and is deliberately swallowed,
  because the inbox is the source of truth and a supported configuration should
  not raise an alarm at them;
- somebody pressing «Разрешить уведомления» gets a generic «Push не подключился»
  error, which looks like a browser problem.

The reliable check is the API. Signed in, request:

```
GET /api/notifications/vapid-public-key
```

`200` with a public key means push is configured. **`404` means the deployment
shipped without the VAPID group** — see §2 and §3. That endpoint is the only
unambiguous answer.

### Subscriptions are only ever removed when the browser is truly gone

When a push fails, the CRM keeps both the subscription and the notification. It
removes a subscription **only** when the push provider answers `404` or `410` —
the two codes that mean "this browser endpoint no longer exists" (the person
cleared site data, uninstalled, or revoked permission).

Every other failure — timeout, `5xx`, provider outage, network error — leaves the
subscription in place and the notification in the inbox. Nobody has to
re-subscribe after a provider hiccup, and no alert is lost because a push failed.

If somebody stops receiving push but still sees the bell filling up, their old
subscription was probably retired by that rule. **Ask them to reload the CRM.**
As long as their browser permission is still granted, the app re-registers the
subscription automatically on load — there is no button to press. If reloading
does not help, have them check that notifications are still allowed for the site
in their browser settings; once a browser is set to `denied`, only they can undo
it, and the app cannot ask again.

---

## 7. Nothing in the CRM deletes business records

**The normal CRM interface never deletes a client, a deal, a task or a timeline
entry.** Deals leave the funnel by being closed as won or lost, and the history
stays. This is deliberate: the timeline is the record of what was promised to a
customer.

This is not just a UI convention — it is enforced in two independent places:

1. **There is no delete endpoint.** The only `DELETE` in the entire API removes a
   *push subscription*. There is no API call that deletes a client, deal, task or
   activity, so no screen and no script talking to the API can remove one.
2. **The database refuses.** `deal_activities` and `ingestion_receipts` reference
   `deals` with `ON DELETE RESTRICT`. Anyone deleting a deal directly in SQL gets:

   ```
   ERROR:  update or delete on table "deals" violates RESTRICT setting of foreign key
           constraint "deal_activities_deal_id_fkey" on table "deal_activities"
   ```

   Deleting a **client** fails the same way: the client→deal link cascades, the
   cascade reaches a deal that has history, and the RESTRICT stops the whole
   statement. Nothing is deleted.

Two honest caveats:

- The guard is **data-dependent, not structural**. A deal with no timeline entry
  and no ingestion receipt is still deletable. Every deal created through the
  normal flow has history from its first moment, so this is a narrow window, not
  a hole you can drive through — but do not treat RESTRICT as an absolute lock.
- It is a safety net against mistakes, **not a security control**. Anyone with
  direct database credentials can drop the constraint. Guard the database
  credentials.

If a record genuinely must be removed — a duplicate created during testing, a
legal erasure request — that is a deliberate, reviewed database operation with a
fresh backup taken first. It is not a routine action and it has no button.

---

## 8. Investigating a lead the site says it sent

Every accepted delivery writes an **ingestion receipt**. Look it up by the pair
the site controls: `source` plus `externalId`.

```sql
SELECT r.source,
       r.external_id,
       r.received_at,   -- when the site says the lead arrived
       r.created_at,    -- when the CRM stored it
       r.deal_id,
       d.stage
FROM ingestion_receipts r
JOIN deals d ON d.id = r.deal_id
WHERE r.source = 'teraso.com.ua'
  AND r.external_id = 'lead_REDACTED'
ORDER BY r.created_at DESC;
```

### What this can and cannot tell you

**It can tell you:** whether the delivery was ever accepted, exactly when the CRM
stored it, how far the CRM's clock was from the site's `receivedAt`, and which
deal it became. Two rows pointing at one `deal_id` is normal and correct — that
is a second lead from a known phone appended to an open deal.

**It cannot tell you what the site actually sent.** The raw payload is
deliberately **not stored**. The marketing and click identifiers (UTM parameters,
`gclid`, `gbraid`, Meta event id) are kept in a separate `lead_attributions`
table that the API never returns, and the body itself is discarded after
processing.

So when the site claims it sent something different from what you see:

- **No row at all** → the CRM never accepted that delivery. The evidence lives on
  the site's side: its own request log and the HTTP status it received. Ask for
  the status code. `401` means the secret or the clock; `400` means the payload.
- **A row exists** → the delivery was accepted. What the deal looks like now is a
  question about later edits in the CRM, not about the delivery.

The rejection log is the other half of the picture. Search the API's log for:

```
[inbound-quiz] rejected delivery
```

Every rejected delivery is logged with one of four reasons — `signature`, `age`,
`body-limit`, `validation` — and never with the secret, the signature or the body.
For example, a deployment that shipped without `TERASO_WEBHOOK_SECRET` prints:

```
[inbound-quiz] rejected delivery (signature): webhook secret is not configured; failing closed
```

That log is rate-limited to roughly one line per reason per minute, and each line
reports how many repeats it stood in for. A flood of one kind of garbage can
therefore never bury a different kind — but it also means the log shows *that*
rejections happened and *why*, not a line per attempt.

### `source` on a receipt is not `source` on a deal

Two different things that happen to share a word:

- `ingestion_receipts.source` is the **immutable integration identity** captured
  at delivery. It is half the idempotency key. It never changes.
- `deals.source` is an **editable marketing label** the owner can rename in the
  CRM at any time.

Renaming a deal's source does not, and must not, change the receipt. Always
investigate by the receipt.

If your investigation includes a payload example in a ticket, redact the phone,
the `externalId` and every attribution value first — see the redacted example in
[CRM_INTEGRATION.md](CRM_INTEGRATION.md).

---

## 9. Backups and restore

### Owner

**One named person owns backups.** Write their name into the deployment
configuration or wherever your team keeps ownership; this document intentionally
does not name anyone, because a stale name here is worse than no name. Their job
is exactly three things:

1. Confirm the managed database's automatic backups are switched on and that the
   retention window is what the business expects.
2. Run the restore rehearsal below on schedule.
3. Take a manual backup **before** any schema change, bulk data operation or
   deliberate deletion.

### Restore rehearsal, quarterly

A backup nobody has restored is a hypothesis. Rehearse it every three months, and
always after a major change to the database plan.

Restore **to a new, temporary database — never over the live one**, and confirm:

1. The restore completes and the temporary database accepts connections.
2. It carries every migration. Pointed at the restored copy,
   ```bash
   bun run --cwd backend prisma:deploy
   ```
   prints `No pending migrations to apply.` — or applies only what is genuinely
   missing. Anything else means the backup predates a schema change, and §10
   applies.
3. The data is really there — row counts for `clients`, `deals`,
   `deal_activities` and `ingestion_receipts` are in the right ballpark, and the
   most recent deal you remember is present.
4. Write down how long the whole thing took. That number is your real recovery
   time, and it is the only honest input to any promise about downtime.
5. Destroy the temporary database.

Point the CRM at a restored copy only after steps 1–3 pass.

### Incident recovery order

When production data is damaged, order matters more than speed:

1. **Stop the writes.** Take the API offline, or at minimum stop the scheduler,
   so the damage cannot spread while you work.
2. **Take a backup of the damaged state before touching anything.** It is
   evidence, and it is your only way back if the restore goes wrong.
3. **Restore into a new database**, never over the damaged one.
4. **Verify** with the rehearsal checklist above.
5. **Repoint the API** at the verified copy.
6. **Bring the scheduler back up last**, once the API is confirmed healthy.
7. Only then work out what happened.

Do not run `DROP`, `DELETE`, `TRUNCATE` or `docker compose down -v` against a
production database as part of recovery. If a step seems to require one, stop and
get a second person to look at it first.

---

## 10. Migrations

Schema changes are applied by:

```bash
bun run --cwd backend prisma:deploy
```

In the generated DigitalOcean spec this runs automatically as a pre-deploy job
(`bun run db:deploy`), which applies migrations, optionally bootstraps the first
administrator, and then refuses to let the deployment continue unless at least
one administrator has a usable password.

### The two CRM migrations must land together

`20260724020952_crm_core` and `20260724024938_crm_integrity_hardening` are a
pair. **Never apply `crm_core` alone to a database that will then receive
traffic.** The second migration:

- drops `lead_attributions.external_id` — the data in that column is lost;
- adds `ingestion_receipts.received_at` as **NOT NULL with no default**, which
  **fails outright if that table already has rows**.

So a database that ran on `crm_core` alone, received even one lead, and then tried
to catch up will refuse the second migration and be stuck between two states.
`prisma:deploy` applies both in order in a single run, which is why the rule is
simply: never stop halfway.

### Checking for schema drift

Nothing in the automated checks compares the schema definition to what is
actually in the database. `prisma:validate` only checks that the schema file is
syntactically valid. That leaves a real gap: a change made in the schema file and
in the shared contracts, but never turned into a migration, passes every gate
while the live database keeps the old shape.

Run this against a database to compare it with the current schema:

```bash
cd backend
bunx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

It is read-only — it changes nothing.

| Exit code | Meaning |
| --- | --- |
| `0` | `No difference detected.` The database matches the schema. |
| `2` | Drift. The database and the schema disagree; the printed summary says how. |
| `1` | The command itself failed, e.g. it could not connect. |

Run it after every deployment that included a migration, and any time the CRM
behaves as though a field is missing. Wiring it into a repository script is
recorded as follow-up work in §12.

---

## 11. Things that will surprise you

### 11.1 People get silently signed out when several share one internet connection

The API limits how many **write** requests one IP address may make per minute.
Two independent budgets exist:

- one for `/api/auth/*` — sign in, register, sign out, **and the silent token
  refresh**. The browser holds a 15-minute access token (`ACCESS_TOKEN_TTL_SECONDS`);
  once it expires, the next thing the person does quietly fails with `401`, the
  client refreshes the token and retries. They never see it — unless the refresh
  itself is rate-limited;
- one shared by everything else that writes: account management and every CRM
  write, including marking notifications read and registering for push.

Reads (`GET`) and preflight requests are exempt and never count.

The default is `AUTH_RATE_LIMIT_MAX=60` per 60 seconds, measured **per IP
address**. Several people in one office behind one internet connection look like a
single visitor and share one budget.

**The symptom is not "I cannot log in".** The first thing to hit the ceiling is
the background refresh, which nobody sees. So the failure looks like: *people are
randomly signed out and have to log in again, and it is worse when the whole team
is working.* Over the limit, the API answers `429` with `RATE_LIMITED`.

Three ways out, in order of preference:

1. **Raise `AUTH_RATE_LIMIT_MAX`** to fit the real team size. It is the smallest,
   safest change. This is a genuine trade-off: the limiter exists to slow down
   password guessing, so raise it to what the team needs and no further.
2. **Meter per account rather than per IP** for authenticated requests, so one
   office is not one visitor. This is a code change, not configuration.
3. **Give the token refresh its own budget**, separate from sign-in attempts, so
   routine background traffic can never exhaust the budget that protects
   passwords. This is the correct long-term fix and is recorded in §12.

Note also that behind a proxy this only works if `TRUST_PROXY` and
`TRUSTED_PROXY_CLIENT_IP_HEADER` are set (§2). Without them every request appears
to come from the proxy and the entire company shares one budget with certainty.

Finally: the limit lives in the memory of a single API process. Running more than
one API instance multiplies the effective limit and makes it approximate. Before
scaling horizontally, move this to a shared store or to the edge.

### 11.2 The «Успех» board column grows forever

Won deals are never archived, so that column grows for the life of the system.
The board therefore shows at most **50** cards per column and states the truth
underneath the heading: `Показано 50 из 240`. The badge count is always the real
total.

Nothing needs doing about this. It is documented so that "the board is not showing
all my won deals" is recognised as intended behaviour rather than a bug.

### 11.3 Changing the overdue reminder delay needs a restart

`NOTIFICATION_TASK_OVERDUE_AFTER_MINUTES` controls how long an unfinished task
waits past its due time before the **second**, nagging notification. The first
one always goes out at the due time itself.

There is no screen for this. Change the value in the server environment and
**restart the backend**. Default 15, maximum 1440 (one day) — beyond a day the
dispatcher's own 24-hour lookback would quietly turn it into "never".

Raise it if the follow-up feels naggy; lower it if things slip through.

### 11.4 Local development traps

Two that cost the most time:

- **Never start `postgres_test` by hand.** It binds a port under the wrong Docker
  Compose project and the test runners then fail with *port is already allocated*.
  The full explanation and the one safe cleanup command are in
  "Local PostgreSQL And The Compose Project Trap" in the root
  [README.md](../README.md).
- **`bun` loads `backend/.env` based on the directory you are standing in.** From
  `backend/` a bare `bun` command sees `DATABASE_URL`; from the repository root
  the identical command does not. So the same raw `bun test` can behave
  differently in two terminals, and a database-backed check that passed in one
  quietly skipped the database in the other. Always use the repository's own
  scripts — `bun run test`, `bun run test:backend`,
  `bun run test:backend:integration` — rather than a bare `bun test`.

---

## 12. Known defects and follow-up work

Recorded deliberately. None of these blocks operation.

### Deployment specs are incomplete (§2)

`scripts/prepare-do-specs.mjs` and `.do/backend-app.yaml.example` do not emit
`TERASO_WEBHOOK_SECRET` or the `VAPID_*` group, and generate only one scheduled
job while two are needed. **Impact: a deployment built purely from them has a
dead site webhook and dead push, with no error anywhere.** Until this is fixed,
whoever deploys adds those values and the second job by hand and verifies with §5
and §6.

### No automated schema drift check (§10)

`prisma:validate` is syntax-only, and nothing compares the schema to a real
database. A schema change without a matching migration passes every gate. The
verified command is in §10; the follow-up is to wire it into a repository script
and run it after any migration.

### Typing on the sign-in page can be interrupted by a session change

**Where:** `webapp/src/pages.tsx`, the `GuestAuthPage` wrapper used by the login,
registration and password-reset pages.

**What happens:** the page renders one of three different things depending on the
session state — a loading state, an error state, or the form. When the state
changes, the whole subtree is replaced. If that happens while somebody is typing,
their input is discarded and the fields come back empty.

**When it happens:** as the initial session check settles just after the page
opens; when that check fails and the error state takes over; and when a sign-in
in another browser tab restarts the check in this one.

**Severity:** low but real. It is confusing rather than damaging — nothing is
lost except what was typed. The end-to-end test works around it by retrying its
typing until the value sticks (see `signInAsAdministrator` in
`webapp/e2e/specs/crm.spec.ts`), which is itself evidence that a person would hit
it too.

**Proposed fix, not applied:** keep the form mounted and show loading and error
as an overlay or a banner above it, rather than swapping the subtree; or key the
subtree so the form does not participate in the swap.

### Rate limiting is per IP and includes token refresh (§11.1)

The correct fix is to give the background refresh its own budget, separate from
sign-in attempts. Until then, `AUTH_RATE_LIMIT_MAX` is the dial.

---

## 13. Product decisions worth knowing

Two behaviours that look like bugs if you do not know they were chosen.

**Everyone lands in the CRM after signing in, including the administrator.** The
owner *is* the administrator of the only account a Teraso deployment has, and the
CRM — not user management — is what they open the app to use. `/admin` stays
reachable from the sidebar for the rare account change.

**The dashboard's «Задач на сегодня» and «Просроченных задач» tiles count tasks,
and both link to the task list, not to the deal list.** One deal can carry several
tasks, so a deal-filtered list would show a different number from the one that was
clicked. The tiles link where the number is true.
