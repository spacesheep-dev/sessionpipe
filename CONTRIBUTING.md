# Contributing to sessionpipe

Thank you. This page is the whole process; if something here is unclear, open a
Discussion and we will fix the page.

## Dev setup

```sh
git clone https://github.com/spacesheep-dev/sessionpipe
cd sessionpipe
npm ci --ignore-scripts
npm run build        # esbuild bundles + declarations, per package
npm test             # vitest
npm run lint         # Biome
npm run typecheck    # tsc --noEmit
npm run schemas      # regenerate schemas/v1 from packages/core/schema/v1.ts
```

Node ≥ 20. CI runs all of the above on Node 20 / 22 / 24 × Linux / macOS / Windows,
plus `npm run schemas -- --check` (generated files must match the commit), the
conformance fixtures, a secret scan over `conformance/`, and the hook-timing benchmark.

On one cell (Linux, Node 22) the tests run as `npm run test:coverage`, with the
threshold in `vitest.config.ts`: every file under `packages/*/src` at 100 % of lines,
branches, functions and statements. A branch only another platform or a failing builtin
reaches is tested by faking that (`process.platform`, one `fs` call); code nothing can
reach is deleted, not ignored. A number never goes down. Run it locally before opening a PR.
Two more gates: a PR that touches `packages/core/src/adapters/` must also touch
`conformance/harness/` (as a spec change must touch `conformance/` or `schemas/`), and
`packages/core/test/registry.test.ts` holds every adapter in the registry to at least
one fixture, and every fixture directory to a registered adapter. A new harness is one
adapter file + fixtures for every event it handles + a row in `spec/ADAPTERS.md`; a
harness payload change is a new fixture, never an edit of a recorded one.

## The ten ground rules

Every PR is checked against these (they are the project's invariants, in
[README](README.md) and the spec):

1. **The spec is the product.** A behaviour lands in `spec/` with a fixture in
   `conformance/` before or with its code.
2. **One source per fact.** Schemas are generated from Zod, never hand-edited. The
   site renders `spec/*.md`. Redaction rules exist once, in core.
3. **The hook path is invisible.** `dist/hook.js` reads stdin, writes one job file,
   spawns a detached worker, exits 0 in under 150 ms p50. It imports only `node:` builtins.
   The one exception is control (spec/CONTROL.md §6): on a machine with control paired,
   a PermissionRequest hook may wait on the daemon's local socket for a signed answer
   (up to the hook's own window), and a Stop hook asks the socket for a queued message
   (a local round trip, ≤ 50 ms). Neither counts toward the 150 ms budget, and neither
   runs at all where control is not paired.
4. **Never lose, never duplicate.** Append-only outbox, cursor advances on 2xx only,
   `seq` per session, receivers dedupe on (harness, session, seq).
5. **Secrets never leave.** The secrets ruleset runs above tier 0 and cannot be
   turned off per sink.
6. **Tier per sink, capped by the receiver.**
7. **Code owns access, state and transport; interpretation belongs to receivers.**
8. **Adapters are the only vendor code** (`packages/core/src/adapters/<harness>.ts`).
9. **No telemetry, ever.**
10. **Public from commit one.**

## Adding an adapter

One PR, touching:

- `packages/core/src/adapters/<harness>.ts`: the mapping from the harness's hook
  payloads to protocol events, and where its config lives.
- `conformance/harness/<harness>/*.json`: **real** payloads recorded from the
  harness, one per event, secrets scrubbed (`npm run fixture-scan` must pass).
  Never invent a payload.
- `spec/ADAPTERS.md`: the harness's row (config file, events, ids, transcript path,
  quirks, the documentation URL, and the statement that only a documented hooks API
  and the person's own local files are used).
- Its unit tests under `packages/core/test/`.

`core` must not name a vendor outside `adapters/`.

## Proposing a spec change

Open a [spec proposal](https://github.com/spacesheep-dev/sessionpipe/issues/new?template=spec-proposal.yml).
It needs a motivation, the exact field change with its requirement level (RFC 2119),
the fixture that would prove it, and a compatibility statement (additive behind a
capability string, or breaking with a protocol integer bump). Decisions are by lazy
consensus: seven days without a maintainer objection, then a PR that carries the
spec text, the schema change (regenerated), and the fixture together.

## Sign-off (DCO)

Every commit must carry a `Signed-off-by:` line with a real name and email,
certifying the [Developer Certificate of Origin 1.1](DCO):

```sh
git commit -s -m "adapters: cursor afterFileEdit → files.changed"
```

There is no CLA. Inbound equals outbound: your contribution is accepted under the
license of the file it touches (Apache-2.0 for code, CC BY 4.0 for `spec/`).

## Commit and PR style

- One change per PR; the title says what changed, in the imperative.
- Include a changeset (`npx changeset`) when a package's behaviour changes.
- The PR template asks for the command output that proves the definition of done.
  Measure before claiming.
- Every source file starts with `// SPDX-License-Identifier: Apache-2.0`.

## Releasing

Merging to `main` publishes nothing. A release is a push to the `production` branch,
by a maintainer:

```sh
git fetch origin
git push origin origin/main:production
```

The [release workflow](.github/workflows/release.yml) then turns the pending changesets
into the next version (a commit on `release/v<version>`), publishes the four packages
to npm with provenance, tags them, makes a GitHub release with the schema tarball, and
opens a PR that brings the version bump back to `main` and merges itself once CI passes.
`production` only moves forward along `main`; a push from anywhere else is refused, and
so is the next release while that PR is still open. A failed run can be re-run as is.

## Review

A maintainer replies within five working days. Small fixes merge on one approval;
spec changes need a fixture and a maintainer approval after the seven-day window.

## Code of conduct

[Contributor Covenant 2.1](CODE_OF_CONDUCT.md). Contact: conduct@sessionpipe.org.
