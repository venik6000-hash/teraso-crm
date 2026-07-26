# Teraso CRM — site integration (quiz webhook)

How the `teraso.com.ua` site delivers a quiz lead to the CRM. The site keeps
sending leads to mail and Telegram; this webhook is an additional, authenticated
delivery that writes the lead into the CRM (PRD §8). It is the only public write
endpoint — everything else requires an authenticated CRM user.

## Endpoint

```
POST /api/crm/inbound/quiz
Content-Type: application/json
```

- **Production is HTTPS only** (PRD §10). The signing secret is a server-only
  secret; it is never shipped to the browser and never appears in a URL.
- The endpoint is **not** behind the bearer-token guard or the auth rate-limiter.
  It authenticates the caller by an HMAC signature (below), not by a login.
- The raw request body is capped by `TERASO_WEBHOOK_BODY_LIMIT_BYTES`
  (default 65536 = 64 KB). A larger body is rejected with `413` before anything
  else runs.

## Authentication — HMAC-SHA256 signature

Every delivery carries two headers:

| Header | Value |
| --- | --- |
| `x-teraso-timestamp` | Unix time **in seconds** of *this* delivery attempt (UTC). |
| `x-teraso-signature` | HMAC-SHA256 as **exactly 64 lowercase hex characters** (`[0-9a-f]`), computed as below. |

The signature encoding is checked strictly: uppercase hex, a shorter or longer
string, or any trailing character is rejected with `401` on format alone, before
the secret is used. Send exactly what `.digest("hex")` returns — Node's default is
already lowercase. (Leading/trailing whitespace around a header value is stripped
by HTTP itself and is harmless.)

### Signing bytes

The signed message is the UTF-8 bytes of the timestamp, a literal `.`, then the
**exact raw JSON body** — the same bytes sent on the wire, byte for byte:

```
signature = HMAC_SHA256( secret, `${x-teraso-timestamp}` + "." + `${raw request body}` )
```

The server verifies the signature against the exact bytes it received, so the
body used to sign and the body sent **must be identical** — do not re-serialize,
pretty-print, or reorder keys between signing and sending, or every signature
will fail. Compare is constant-time on the server.

Node.js reference:

```ts
import { createHmac } from "node:crypto"

const rawBody = JSON.stringify(payload)          // sign these exact bytes...
const timestamp = Math.floor(Date.now() / 1000).toString()
const signature = createHmac("sha256", process.env.TERASO_WEBHOOK_SECRET)
  .update(timestamp + "." + rawBody)
  .digest("hex")

await fetch("https://<crm-host>/api/crm/inbound/quiz", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-teraso-timestamp": timestamp,
    "x-teraso-signature": signature,
  },
  body: rawBody,                                  // ...and send those exact bytes
})
```

### Freshness

The server rejects a signed delivery whose `x-teraso-timestamp` is more than
`TERASO_WEBHOOK_MAX_AGE_SECONDS` (default 300 = 5 minutes) away from server time,
in either direction. Because the timestamp is signed, it cannot be altered
without the secret. See *Retries* for why this never blocks a legitimate resend.

## Request payload

Fields match `inboundQuizLeadSchema` in `packages/contracts/src/crm.ts`. Unknown
keys are **ignored** on purpose, so the site can add fields without coordinating a
CRM release; do not rely on that to smuggle data — only the fields below are read.

| Field | Type / values | Required | Notes |
| --- | --- | --- | --- |
| `externalId` | string, 1–160 | ✅ | The `lead_…` id. Half of the idempotency key (with `source`). |
| `receivedAt` | ISO 8601 **UTC**, `Z` suffix | ✅ | When the lead arrived. **Must be UTC with `Z`** — see below. |
| `name` | string, 1–120 | ✅ | Client name. |
| `phone` | string, 7–40 | ✅ | Any human formatting; normalized to `+380…`. A number that is not a valid Ukrainian phone is a `400`. |
| `source` | string, 1–80 | ✅ | e.g. `teraso.com.ua`. Immutable integration identity on the receipt. |
| `form` | string, 1–80 | ✅ | e.g. `Квіз`. |
| `landingUrl` | URL | ✅ | Page the lead was submitted from. |
| `material` | `WPC` \| `WOOD` \| `FACADE` | — | |
| `areaLabel` | string, ≤80 | — | Free text, e.g. `45 м²`. |
| `budgetLabel` | string, ≤80 | — | The quiz budget. Does **not** set the deal's manual potential amount. |
| `needTiming` | string, ≤120 | — | e.g. `Зараз`. |
| `preferredChannel` | `CALL` \| `TELEGRAM` \| `WHATSAPP` \| `VIBER` | — | |
| `attribution` | object (below) | — | Marketing/click identifiers. Stored, **never** returned. |

`attribution` (all optional strings): `metaEventId`, `utmSource`, `utmMedium`,
`utmCampaign`, `utmContent`, `utmTerm`, `gclid`, `gbraid`.

### `receivedAt` must be UTC with a `Z` suffix

The contract uses a strict date-time check that **rejects UTC-offset forms** such
as `2026-07-23T11:30:00+03:00`. Kyiv is `+03:00` in summer, so a naive local
timestamp will be refused with `400`. Convert to UTC and send the `Z` form:

- ✅ `2026-07-23T08:30:00.000Z`
- ❌ `2026-07-23T11:30:00+03:00`

`receivedAt` is the lead's arrival time and stays the same across retries; it is
distinct from `x-teraso-timestamp`, which is the time of the current attempt.

### `receivedAt` must be inside the sanity window

`receivedAt` drives both the deal's submission time and the follow-up task's due
time, so it is bounded relative to server time and a value outside the window is
rejected with `400`:

- **Up to 7 days in the past** — generous, because a legitimate delivery can be an
  old lead replayed from the site's backlog after a CRM outage.
- **Up to 1 hour in the future** — tight, because no legitimate lead arrives from
  the future; that tolerance exists only for clock skew. A far-future `receivedAt`
  would create a deal whose follow-up task is due far out, so the lead would never
  be flagged critical and would silently never surface.

An `externalId` consisting only of whitespace is rejected for the same "fail loud"
reason: it would otherwise become an idempotency key shared by every such delivery.

### Redacted example payload

Identifiers are redacted; the shape is exactly what the site sends.

```json
{
  "externalId": "lead_REDACTED",
  "receivedAt": "2026-07-23T08:30:00.000Z",
  "name": "Олександр",
  "phone": "+38 (0XX) XXX-XX-XX",
  "source": "teraso.com.ua",
  "form": "Квіз",
  "landingUrl": "https://teraso.com.ua/kviz",
  "material": "WPC",
  "areaLabel": "45 м²",
  "budgetLabel": "150000",
  "needTiming": "Зараз",
  "preferredChannel": "TELEGRAM",
  "attribution": {
    "metaEventId": "REDACTED",
    "utmSource": "facebook",
    "utmMedium": "cpc",
    "utmCampaign": "wpc-spring",
    "utmContent": "REDACTED",
    "utmTerm": "REDACTED",
    "gclid": "REDACTED",
    "gbraid": "REDACTED"
  }
}
```

The same `source` + `externalId` pair is how a replay is investigated later,
without ever storing the raw body — the UTM and click identifiers are kept apart
from the operational fields and are not echoed back.

## Responses

The body is always `{ "status", "clientId", "dealId" }` on success — identifiers
and a status only, never the attribution values.

| HTTP | `status` | Meaning |
| --- | --- | --- |
| `201` | `created` | New client and new deal created. |
| `201` | `new-deal-for-existing-client` | Known phone, but no open deal — a fresh deal was created. |
| `201` | `attached-to-open-deal` | Known phone with an open deal — a «Заявка получена» event was added to it; **no** second deal is created, and its stored attribution is left as the first submission's. |
| `200` | `duplicate-delivery` | This `source` + `externalId` was already stored. Returns the **original** `dealId`; writes nothing. |
| `400` | — | `VALIDATION_ERROR`: malformed JSON, a field that fails the schema, or a phone that is not a valid Ukrainian number. |
| `401` | — | Missing, wrong, or stale signature (or the server has no secret configured). |
| `413` | — | Raw body over the limit. |

On a `201` for `created`/`new-deal-for-existing-client`, the CRM also starts an
active follow-up task **«Первично обработать заявку»** due at `receivedAt + 30
minutes`. Because it anchors on `receivedAt`, a backdated lead arrives already
overdue and visibly critical. `attached-to-open-deal` adds no task — the open deal
already has its follow-up path.

## Idempotency and retries

The webhook is idempotent on `[source, externalId]`. Retried and concurrent
deliveries of one lead are expected (the site retries on timeout), and they can
never create a second deal, receipt, or client — the loser of a race gets the same
deal back.

**When to retry:** on a network failure, a `5xx`, or a `401`. Do **not** retry a
`400`.

- **`x-teraso-timestamp` is the time of the *current* attempt, and the signature
  is recomputed for every retry.** Never resend the original timestamp/signature.
  Because each retry carries a fresh timestamp, **redelivery after CRM downtime
  longer than five minutes still succeeds** — the freshness window is measured
  against the current attempt, not the original one. Reusing the first
  timestamp/signature on a late retry would be rejected as stale.
- **A `401` is retryable** — recompute the signature with a fresh timestamp and
  send again. It usually means clock skew, a stale reused signature, or a secret
  rollover in progress.
- **A `400` (schema validation, bad phone) is *not* retryable.** It is
  deterministic; retrying the same body yields the same `400`. Fix the payload.
- `receivedAt` and `externalId` stay the same across every retry of one lead;
  only the delivery timestamp and its signature change.

## Server configuration

Set in the backend environment only (never in the browser). See
`backend/.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TERASO_WEBHOOK_SECRET` | *(none)* | HMAC secret shared with the site. **Unset ⇒ the endpoint fails closed and rejects every delivery with `401`.** See the strength rules below. |
| `TERASO_WEBHOOK_MAX_AGE_SECONDS` | `300` | Freshness window for `x-teraso-timestamp`, in seconds. |
| `TERASO_WEBHOOK_BODY_LIMIT_BYTES` | `65536` | Maximum raw body size; larger ⇒ `413`. |

### Secret strength

This secret is the *only* thing standing in front of the only unauthenticated
public write endpoint in the system, so it is validated at boot, not at
exploitation time. **Generate it, never type it:**

```sh
openssl rand -hex 32
```

- **Every environment:** a non-empty value must be at least **32 characters**, or
  the process fails to start.
- **Production** (`NODE_ENV=production` or `COOKIE_SECURE=true`): it must also be a
  generated-looking secret — **64+ hex characters**, not a known placeholder, not a
  single repeated character. A memorable passphrase is rejected.
- **Unset is valid and safe**: the endpoint fails closed, so an environment that has
  not wired up the site integration still boots.
- Failures name the variable and never echo its value. Rotate by setting the new
  value on both sides; a delivery signed with the old secret fails `401` and the
  site's normal retry succeeds once both sides agree.

Why it matters: an attacker who captures a single legitimate
`(timestamp, body, signature)` triple can brute-force a weak key **offline** and
then inject arbitrary signed leads — creating clients, deals and tasks, poisoning
attribution, and triggering new-lead notifications at will.

### Rejection logging, flood risk, and the required compensating control

Every rejected delivery is logged server-side with its reason (`signature`, `age`,
`body-limit`, or `validation`) for traceability. The secret, the raw signature, and
the payload body are never written to the log.

Because the endpoint is unauthenticated, that log is itself a target: an attacker
who floods garbage signatures could inflate log volume and bury the genuine
rejection records operators rely on. The application therefore **throttles the
rejection log per reason** — the first occurrence of each distinct reason is logged
immediately, repeats within a 60-second window are counted rather than printed, and
the suppressed count is reported on the next line for that reason. Volume stays
bounded to roughly one line per reason per minute no matter the request rate, and a
flood of one kind can never hide a different kind.

**Accepted residual risk.** The endpoint is deliberately *not* behind the
application's per-IP auth rate-limiter: that limiter would throttle the site's
legitimate retry bursts, which this document explicitly promises to support. The
compute cost of a flood is bounded (one HMAC over at most 64 KB, no database work
before the signature passes), so a flood is an availability and observability
concern rather than a path to compromise.

**Required compensating control:** apply an infrastructure-level rate limit to
`POST /api/crm/inbound/quiz` at the WAF or load balancer, sized above the site's
legitimate retry burst. Operating this is covered in the deployment runbook.
