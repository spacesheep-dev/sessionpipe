# Receivers

Who speaks the protocol. A listing carries a conformance badge that CI re-checks by running `sessionpipe-conformance` against the origin at tier 0.

| Receiver | max_tier | Capabilities | Conformance |
|----------|:--------:|--------------|-------------|
| [sessionpipe-receiver](https://github.com/spacesheep-dev/sessionpipe/tree/main/packages/receiver) (reference) | 3 | events, backfill, forget, control, native | pending (M3) |
| [sessionpipe-gui](https://github.com/spacesheep-dev/sessionpipe-gui) ([desktop app](/#gui)) | 3 | events, backfill, forget, control | pending |
| [spacesheep.dev](https://spacesheep.dev) | 2 | events, backfill, forget; sessions-only tokens | pending (M5) |

## List yours

Open a [receiver listing](https://github.com/spacesheep-dev/sessionpipe/issues/new?template=receiver.yml) issue, or a PR that adds one JSON entry under `website/src/receivers/`. CI runs the conformance suite against the URL; the badge follows the result.

## Build one

Serve `GET /.well-known/sessionpipe` and `POST` the events endpoint it names; deduplicate on `(harness.name, session.id, session.seq)`; answer 403 above your `max_tier`; issue sink tokens that can post events and nothing else ([why](https://github.com/spacesheep-dev/sessionpipe/blob/main/SECURITY.md#faq)). The [HTTP binding](/protocol/http/) is the whole contract, and `examples/minimal-receiver/` is 40 lines.
