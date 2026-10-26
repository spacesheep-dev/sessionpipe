# HTTP binding

> This document is part of the sessionpipe protocol and is licensed under [CC BY 4.0](LICENSE). The words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119. Status: **Draft** (see [VERSIONING.md](VERSIONING.md)).

The protocol's events ([PROTOCOL.md](PROTOCOL.md)) travel to a receiver over HTTPS.
This document is the binding: discovery, the batch request, responses and errors,
retry, idempotency, the control long-poll and the native lane. The header names and
signature scheme are those of [Standard Webhooks](https://www.standardwebhooks.com/),
verbatim.

## 1. Discovery: `GET /.well-known/sessionpipe`

At the receiver's origin root. A sender reads it when a sink is added and re-reads
it at most daily (24 h cache); a receiver MAY set `Cache-Control`.

```json
{
  "protocol": [1],
  "max_tier": 2,
  "capabilities": ["events", "backfill", "forget", "control", "native"],
  "auth": ["bearer"],
  "endpoints": {
    "events":  "/api/sessionpipe/v1/events",
    "control": "/api/sessionpipe/v1/control",
    "native":  "/api/sessionpipe/v1/native"
  },
  "batch":   { "max_events": 50, "max_bytes": 262144 },
  "control": { "wait_max_s": 25, "signing": { "rp_id": "receiver.example", "algs": [-7, -257], "key_types": ["passkey", "device"] }, "files": true }
}
```

| Field | Rule |
|-------|------|
| `protocol` | The protocol integers the receiver accepts. |
| `max_tier` | The highest tier it will store. A sender MUST cap its sink's tier at this value. |
| `capabilities` | `events` is required. `backfill`: accepts `session.backfill`. `forget`: honours `session.forgotten`. `control`: serves the control endpoint. `native`: serves the native lane. Additions to the protocol are announced here ([VERSIONING.md](VERSIONING.md)). |
| `auth` | `bearer` only in v1. |
| `endpoints` | Paths relative to the origin, or absolute URLs. |
| `batch` | The largest request the receiver takes. A sender MUST NOT exceed either bound. Defaults when absent: 50 / 262 144. |
| `control` | Required when `capabilities` lists `control`. `wait_max_s`: the longest long-poll it will hold. `signing.rp_id`: the WebAuthn rp id control keys are enrolled for; `signing.algs`: the COSE algorithms it accepts (`-7`, `-257`). `signing.key_types`: OPTIONAL, the kinds of key the receiver stores and carries whole (`passkey`, `device`; CONTROL.md §2); absent means `["passkey"]`. `files`: OPTIONAL, informational; `true` when it accepts `files` on a `start` and serves `{control}/files/{sha256}` (§3). `inherit`: OPTIONAL; `true` when it shows a machine whose `mode` is `inherit` as that, on its pairing page and wherever it shows the mode, and never as `safe` or `auto`; a daemon pairs in `inherit` mode only with a receiver that says so. ([CONTROL.md §2](CONTROL.md#2-keys-and-enrollment)) |

Schema: [`well-known.json`](https://sessionpipe.org/schema/v1/well-known.json).

## 2. Events: `POST {events}`

Body `{"events":[…]}` — 1 to `batch.max_events` events, at most `batch.max_bytes`
bytes ([`batch.json`](https://sessionpipe.org/schema/v1/batch.json)).

Request headers:

| Header | Rule |
|--------|------|
| `content-type` | `application/json` |
| `authorization` | `Bearer <token>` — the token the person configured for the sink. |
| `sessionpipe-protocol` | `1` — the batch's protocol integer, so a receiver can answer 400 without parsing. |
| `webhook-id` | OPTIONAL. A unique id for this delivery attempt's message (retries reuse it). |
| `webhook-timestamp` | OPTIONAL. Unix seconds. |
| `webhook-signature` | OPTIONAL. `v1,<base64>` — HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<body>` with the secret behind the `whsec_` prefix (base64-decoded). Several space-separated signatures MAY be present; one match is enough. A receiver that verifies MUST reject a timestamp more than 5 minutes off its clock. |

Response `202` with [`batch-response.json`](https://sessionpipe.org/schema/v1/batch-response.json):

```json
{ "accepted": 47, "duplicates": 3, "rejected": [{ "id": "01K6…", "reason": "tier_type" }], "max_tier": 2 }
```

`accepted + duplicates + rejected.length` MUST equal the number of events sent. A
rejected event is one the receiver will never store (its reason says why); the batch
as a whole still succeeded and the sender's cursor moves past it. `max_tier` repeats
the well-known value so a sender learns a lowered cap without a discovery round trip.

### Errors

| Status | Meaning | Sender behaviour |
|-------:|---------|------------------|
| 400 | Malformed body, or `{"reason":"unsupported_protocol","supported":[1]}` | Drop the whole batch; log it. |
| 401 | Bad or missing token | Pause the sink; `doctor` says so. Never retry in a loop. |
| 403 | `{"reason":"tier_above_max","max_tier":N}`: an event's `tier` exceeds the receiver's maximum | Lower the sink's tier to `max_tier`, re-filter, retry. |
| 413 | Batch too large | Halve the batch and retry; a single event over the limit is dropped and logged. |
| 429 | Too many requests, with `retry-after` | Wait as told, then retry. |
| 5xx, network error, timeout | Receiver unavailable | Retry with backoff 2 s · 10 s · 60 s · 5 min · 30 min, then every 30 min, forever. |

Bodies of 4xx/5xx responses SHOULD be [`error.json`](https://sessionpipe.org/schema/v1/error.json).
**The sender's cursor moves only on 202.**

### Idempotency

A receiver MUST deduplicate on `(harness.name, session.id, session.seq)` and count a
repeat in `duplicates`. Order of arrival is not guaranteed; `seq` is the order. A
receiver SHOULD keep at least the highest `seq` per session plus a window of recent
values, so a replay after an outage costs nothing.

### Time

A receiver MUST record its own arrival time beside `time`. The difference is the
delivery latency the project measures (target: p50 under 2 s on a laptop).

## 3. Control: `{control}`

Only when the well-known file lists `control`. The messages, keys and checks are
[CONTROL.md](CONTROL.md); this section is the wire. One machine daemon holds **one**
long-poll per receiver, whatever the number of sessions.

| Request | Auth | Body → answer |
|---------|------|---------------|
| `POST {control}/pair` | the person's sink token, or none (with a `poll_key`) where `control.open_pairing` | [`control-pair.json`](https://sessionpipe.org/schema/v1/control-pair.json) → `201` [`control-pair-started.json`](https://sessionpipe.org/schema/v1/control-pair-started.json) |
| `GET {control}/pair?code=<code>` | the person's sink token, or the `poll_key` for an open pairing | → `200` [`control-paired.json`](https://sessionpipe.org/schema/v1/control-paired.json) (`pending`, `paired` with key, proof and, on a machine's first pairing, its token; `expired`) |
| `POST {control}/hello` | the machine's token | [`control-hello.json`](https://sessionpipe.org/schema/v1/control-hello.json) → `204` |
| `GET {control}?machine=<id>&wait=<s>` | the machine's token | → `200` [`control-poll.json`](https://sessionpipe.org/schema/v1/control-poll.json) when a message is waiting, `204` when none arrived within `wait` (≤ `wait_max_s`) |
| `POST {control}/ack` | the machine's token | [`control-ack.json`](https://sessionpipe.org/schema/v1/control-ack.json) → `202` |
| `POST {control}/off` | the machine's token | → `204`; the machine, its token and its queue are gone |
| `GET {control}/files/{sha256}` | the machine's token | → `200` with the file's bytes and its `content-type`; `404` when there is no such file for this machine's account (never uploaded, or expired) |

- The machine's token opens these machine calls (hello, poll, ack, off, files) for
  that one machine and nothing else of the account. A receiver MUST refuse a sink
  token on them, and the machine's token everywhere else.
- A receiver MUST keep re-delivering a message on every poll until it is acked or its
  `expires_at` passes, then drop it. A `taken` ack pauses redelivery for 35 minutes
  (CONTROL.md §10); a final ack ends it. A machine MAY receive the same message twice; the
  signed nonce makes the second one a `replay`.
- A poll is also the machine's heartbeat: a receiver MAY show a machine that polled
  within `2 × wait_max_s` as online, and SHOULD hand a session the waiter (CONTROL.md
  §8) only while its machine is online.
- **Files.** A receiver that accepts `files` on a `start` or a `prompt` (CONTROL.md §3.1) holds each
  file's bytes, named by the base64url SHA-256 the command carries, and serves them at
  `GET {control}/files/{sha256}` to the machines of the account that uploaded them
  and to no one else. It MUST keep them at least until the command's `expires_at`.
  How the bytes reach the receiver is the receiver's business. The machine checks
  length and hash itself (CONTROL.md §6) and stops reading past the signed `size`;
  a receiver SHOULD send `content-length`. A receiver SHOULD NOT queue a `start` with
  `files` for a machine whose hello did not say `files: true`, nor a `prompt` with
  `files` for one whose hello did not say `prompt_files: true`.
- `401` on a machine call means the token is gone (the machine was removed): the daemon
  stops polling that receiver and says so. `404` on `/pair?code=` means no such pairing.

## 4. Native lane: `POST {native}/<harness>`

Raw hook JSON exactly as a harness's own HTTP hook handler sends it (Claude Code
`type: "http"`, Copilot CLI). The receiver normalises it with core's adapter, stores
it at the tier it declared for the lane (≤ 1), and records `privacy.rulesets: []` —
**no redaction ran at source**. This lane exists for a receiver you own on a machine
you own; a public receiver SHOULD NOT advertise `native`.

## 5. Forget

A `session.forgotten` event (any tier) asks the receiver to delete everything it
holds for that session: events, transcripts, derived data. A receiver that lists
`forget` MUST do so before answering 202 (or within a stated retention window,
documented on its `/.well-known` origin), and MUST answer later reads of the session
as though it never existed.

## 6. Transport requirements

- HTTPS on any host that is not `localhost` / `127.0.0.1` / `[::1]`.
- A sender's request timeout is 15 s; a worker that cannot reach a sink leaves the
  backlog for the next worker.
- A sender MUST send `session.*` and `turn.*` events of one session in `seq` order
  within a batch; across batches order is best effort.

## 7. Delivery scenarios (conformance)

The runner sends and expects, in this order; each is a fixture under
`conformance/delivery/`:

| Scenario | Send | Expect |
|----------|------|--------|
| accept | a valid tier-0 batch | 202, `accepted` = n |
| dedup | the same batch again | 202, `duplicates` = n |
| oversize | a batch over `max_events` or `max_bytes` | 413 |
| tier | an event with `tier` > `max_tier` | 403 with `max_tier` |
| protocol | `sessionpipe-protocol: 99` | 400 `unsupported_protocol` |
| auth | a wrong bearer (`auth: "wrong"` in the fixture) | 401 |
| unknown-type | `type: "x.y"` | 202, stored, retrievable |
| forget | `session.forgotten`, then a read | 202, then nothing |
| control | a queued prompt, a poll, an ack | 200 with the message; 204 after the ack |
| control-expired | a message that expires unpolled | 204 |
| control-double-ack | the same ack twice | 202, 202 |
| control-permission | a permission answer, a poll, an ack with its mode | 200; 202 |
| control-unsupported | a cancel, acked `unsupported` | 202; 204 after |
| control-redelivery | two polls with no ack | the same message both times |
