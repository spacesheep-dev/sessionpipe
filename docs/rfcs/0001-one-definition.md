# RFC 0001 · One definition for sessionpipe: the proto is the ontology

- **Status:** Draft for the maintainer's review
- **Written:** 2026-11-08, scoped down the same day: this RFC is TypeScript only
- **Scope:** the proto as the one definition, and the TypeScript doors over it. A Rust client is RFC 0002, later; nothing here depends on it
- **Rendered:** https://spacesheep.dev/@osomishka-bc4d/one-definition-docs (the same content as a page, in spacesheep's theme; source in thread storage `thr_5k3j4swkzx/one-definition-docs/`)
- **Modelled on:** spacesheep's SSAPI (`proto/spacesheep/v1/`, `tools/doors/`,
  `docs/ssapi/decisions/001`–`031`), the "one definition, three doors, old code" build.

## 0. In one paragraph

Every type sessionpipe knows (an event, a session, a tier, a sink, a control command, a
daemon request, a config file) and every operation it offers (each CLI command, each
daemon call, each receiver endpoint) is defined once, in `proto/sessionpipe/v1/*.proto`.
A generator reads the compiled descriptors with their comments and writes the artefacts
every door needs: the JSON Schemas in `schemas/v1/` (today generated from Zod), TypeScript
types for `sessionpipe-core` and the GUI, Rust types for the native parts, a `doors.json`
table that the CLI, an MCP server and the daemon's socket read, and the usage and docs the
website renders. The hand-written surface shrinks to one handler per call. Everything stays
in TypeScript and on npm: this RFC changes where the truth lives, not a byte a receiver,
the GUI or a harness sees. The proto is also what makes a Rust client possible later
(RFC 0002), but nothing shipped under this RFC depends on it. Every page of documentation
is rendered from the proto, so it cannot drift either.

## 1. What spacesheep did, and what carries over

What the SSAPI build settled (read from the source and decision records, not from the
write-ups, which are in a private space; see §9):

| SSAPI | Where it lives | Carries over to sessionpipe? |
|---|---|---|
| One `.proto` per area; Google AIP resources and `field_behavior`; `buf.validate` rules | `proto/spacesheep/v1/` | Yes, same vendored imports |
| Custom options for what a name can't say: `callers`, `replaces`, `renamed`, `secret`, `strict`, `destructive`, `idempotent`, `errors` | `options.proto` | Yes; ours add `tier`, `door`, `daemon`, `harness` (§3) |
| Doors derived by convention from verb + noun: route, MCP tool name, CLI `noun verb` | `tools/doors/doors.mjs` | Yes for the command surface; the wire protocol keeps today's routes |
| One handler per call, keyed `Service.Method`, never told its door | decision 012 | Yes; this is the whole point for `--json` and the MCP door |
| Refusals are one `ErrorInfo` with a stable word; each door maps it (HTTP status, MCP `isError`, exit code 1/2/3) | decision 013, 018 | Yes; today's CLI exits 1 for everything |
| Old names keep working, unlisted, counted; retire 90 days after the switch plus 14 quiet days | decisions 001, 015, 023 | Yes, for CLI spellings and hook entries |
| `doors.json` and generated types are committed; CI diffs them against main; `buf breaking` on the wire | `buf.yaml`, `tools/doors/check.mjs` | Yes; this replaces `scripts/schemas.mjs --check` |
| A gate that runs every call through every door as every caller kind, against a local slot | decision 011, `scripts/doors-check/` | Yes, smaller: three doors, two caller kinds (a person at the terminal, a session's hook) |
| A decision record before any name, input, answer or path changes | `docs/ssapi/decisions/` | Yes: `docs/rfcs/decisions/` |

What was prototype-grade in spacesheep and should not be copied as is:

- The generator reads `ERROR_CODES` and the list of built handlers by **regular
  expressions over TypeScript source**. Ours puts the error words in the proto (an enum)
  and finds handlers by importing the handler table, not by grepping it.
- `doors.json` is read by the CLI **from the server** (`/v1/doors.json`), so the CLI
  can't run offline and its help can drift from the binary. sessionpipe is a local tool:
  the table is compiled into the binary.
- All handlers live in one worker and stamp `via: mcp` whatever the door (decision 020).
  We have no such single worker; see §4 for where handlers run.
- The slot-storage flakiness in the gate (decision 021) is spacesheep's; our gate runs
  against a temp state dir and an in-process receiver, which the test suite already does.

## 2. What is different about sessionpipe

spacesheep is a server with one HTTP API and three doors into it. sessionpipe is a
**client on the person's machine** with a wire protocol out of it. "One definition" here
covers two things that today live in different places:

1. **The wire protocol**: events, the batch, the well-known file, the control channel.
   Today: Zod in `packages/core/schema/v1.ts` (812 lines) → `schemas/v1/*.json` → TS
   types by inference → prose in `spec/*.md`. This is already "one source per fact"; the
   change is only *which* source.
2. **The command surface**: about 45 commands and subcommands dispatched by hand in
   `packages/cli/src/cli.ts` (1 559 lines), with usage as data in `help.ts` (the website
   reads it), `--json` on a handful of them (status, doctor, tail, pool, ask), and the daemon's socket protocol as a TypeScript
   union in `control/local.ts`. Nothing generates any of it; the GUI reaches the CLI by
   spawning it and by matching the string "sessionpipe" in harness configs.

And the one constraint spacesheep did not have: **the hook path**. A harness runs the
hook on every event; today it is `dist/hook.js`, node builtins only, p50 25–35 ms wall,
almost all of it node's start. That number is the reason to want Rust, and the hook is
the one place where a second implementation has to produce byte-identical results
(Antigravity reads its stdout as an answer).

## 3. The proto

```
proto/
  buf.yaml  buf.gen.yaml
  google/api/*.proto  buf/validate/validate.proto      (vendored, as spacesheep)
  sessionpipe/v1/
    options.proto     tier, door, daemon, harness, secret, strict, replaces, renamed, errors
    events.proto      Event, Session, Privacy, every data payload (one message per type)
    http.proto        WellKnown, Batch, BatchResponse, ErrorResponse
    control.proto     the command string's fields, Hello, Grant, Key, Ack, Pair*, Poll
    local.proto       the daemon's socket: wait, stop, permission, event, status, restart, pool, ask
    config.proto      config.json, control.json, the sink entry, update state (strict)
    client_service.proto   ClientService: Connect, Install, Uninstall, Status, Doctor, Tail, Backfill, Forget, Replay, Update, Titles
    sink_service.proto     SinkService: Add, List, Remove, Test; SecretsService: Move
    control_service.proto  ControlService: Pair, SetMode, Status, ListKeys, RemoveKey, Off, Run; FolderService
    pool_service.proto     PoolService: Status, On, Off, Add, Remove, Enable, Disable, Order, Refresh
    agent_service.proto    AgentService: Ask, AskOn, AskOff, AskStatus, AskSetup, Wait, Channel
```

Options this repo needs that spacesheep didn't:

| Option | On | Says |
|---|---|---|
| `tier` | message, field | the lowest tier that carries it (`TYPE_TIER` today, and per field what tier 2 adds over tier 1). `filterEvent` becomes a table walk; `PRIVACY.md`'s tier table is rendered from it |
| `door` | method | which doors a call has: `cli`, `mcp`, `socket`. Unset: `cli` only. `mcp` marks what a session's agent may call (`ask`, `status`, `tail`); `socket` what the GUI and the hooks call on the daemon |
| `daemon` | method | the call runs in the daemon (pool, ask, wait) rather than in the CLI process; the CLI door forwards it over the socket |
| `harness` | enum values | the registry: name, config files, hook events; `ADAPTERS.md`'s table is rendered from it |
| `secret` | field | a token or key: never in a URL or a log; the CLI reads it without echo; `status --json` masks it (today's `storeLabel` logic) |
| `replaces` | method | today's spelling of the command, so `sessionpipe control status` and `sessionpipe status` both keep answering |
| `errors` | method | the refusal words this call can give, from one `ErrorCode` enum in `options.proto` (not read from source text) |

Rules kept from today, now in the proto rather than prose:

- The **protocol integer** stays `1`. `buf breaking` with `WIRE_JSON` on `events.proto`,
  `http.proto` and `control.proto` is the mechanical form of `VERSIONING.md`'s "additive
  only". A field is deprecated with `[deprecated = true]` and its comment keeps the date.
- Every JSON Schema in `schemas/v1/` is generated from the descriptors. **The first
  commit of this RFC must regenerate them with no diff that a v1 receiver can observe**
  (property names, required lists, enums). Additions of `description` text are allowed;
  anything else is a protocol change and needs a fixture.
- The `KNOWN_TYPES` list is the `oneof data` of `Event`; a receiver still must accept an
  unknown type, which is a `google.protobuf.Struct` arm.

## 4. The doors, and where a handler runs

```
                    proto/sessionpipe/v1/*.proto
                               │ buf build (descriptors + comments)
                               ▼
                       tools/doors (generator)
      ┌──────────────┬─────────┴──────────┬────────────────┬──────────────┐
      ▼              ▼                    ▼                ▼              ▼
 schemas/v1/   packages/core/gen/    (RFC 0002: Rust)   shared/doors.json   website/
 (JSON Schema) (protobuf-es TS)      (later)            (the table)         (usage, tier table, adapters table)
                     │                    │                 │
          sessionpipe-core, GUI                          CLI door · MCP door · socket door
```

**One handler per call**, in `packages/cli/src/calls/<area>.ts`, keyed
`"ClientService.Status"`, taking the request message and returning the response
message, refusing with `CallError(code, message, violations?)`. It is told a `CallContext`
(the state dir, the config, the secrets store, a clock, stdout for streaming calls) and
**never which door called it**.

Three doors read the table:

- **CLI** (`packages/cli/src/cli.ts`, shrunk to a door): parses `noun verb` and flags from
  the table, decodes into the request message (the same codec as spacesheep's
  `codec.mjs`: one string into a list at commas, a number given to text as text), runs the
  handler, prints the response either as today's prose (a per-call `render` function,
  kept by hand because wording matters) or as ProtoJSON when `--json` is given. Every
  command gets `--json` and `--help` for free; `help.ts` is deleted and the website reads
  the table.
- **MCP** (`sessionpipe mcp`, new, stdio): the calls whose `door` lists `mcp`, as tools
  with input and output schemas from the table and the safety hints from the verb. This is
  how a Claude Code or Codex session calls `ask` and `status` without a shell, and how
  `ask setup`'s instruction text can shrink to "the sessionpipe MCP server is available".
- **Socket** (`control/local.ts`): the daemon's line-delimited JSON stays line-delimited
  JSON, but each line is the ProtoJSON of a `local.proto` message, so the hook (in either
  language), the waiter, the GUI and the CLI's forwarded `daemon` calls speak one encoding
  with generated types. Today's `op` strings become the `oneof` arm names, so an old hook
  and a new daemon still understand each other during an update.

Handlers that touch the person's keychain, config or hooks run in the CLI process;
handlers marked `daemon` run in the daemon and the CLI forwards. Nothing runs in a
receiver: the receiver side of the wire stays `spec/HTTP.md` and `CONTROL.md`, rendered
from the proto comments, with `packages/receiver` as the reference implementation and
the conformance suite unchanged.

## 5. Later: Rust (RFC 0002, not this one)

> Decided 2026-11-09: one Rust core, bound to Node for `sessionpipe-core`, same repo. See `0002-one-rust-core.md`. The outbox is specified in `spec/OUTBOX.md` with vectors, as its prerequisite.

The proto makes a Rust client possible: every boundary (the hook's job file, the
outbox, the daemon's socket, the wire) becomes a generated message, and the fixtures
and goldens of §6 run on any implementation. The end state would be one Rust binary for
the whole client, with the npm package as a thin installer and `sessionpipe-core` as a
generated library for receiver authors. The order would be hook, worker, CLI, daemon,
delete. That is a separate RFC, written when this one has shipped and sat on spacesheep
for a release cycle. **Nothing in this RFC is designed around it, and nothing here needs
it.** Node stays the requirement for the client until then.

## 6. Zero regression: the proof, not the promise

The people who must notice nothing: every machine reporting to spacesheep.dev, spacesheep's
receiver itself, the GUI, and anyone with hooks installed. Each line is a test, in the
order the risk goes. The first three are the wire; they gate step 1 of §10 alone.

| # | Gate | Holds for | How |
|---|---|---|---|
| 1 | **Schema parity, byte for byte** | spacesheep's receiver, every receiver | `schemas/v1/*.json` generated from the proto diffed against today's committed files. The first PR merges only when the diff is empty. Adding `description` text is a later, separate PR, reviewed as such |
| 2 | **Golden replay** | the events every receiver stores | already the fixtures: `conformance/harness/*` carry the events each payload must produce, `redaction/` and `control-vectors/` their verdicts, all recorded from real runs and green on 0.13.3. `filterEvent`'s output per tier is `conformance/tiers/` (decision 003), recorded from the published 0.13.3. Otherwise: record once what 0.13.3 emits for every fixture in `conformance/harness/`, the 66 redaction vectors and the 136 control vectors, commit as `conformance/golden/`; every later change reproduces them exactly. (This is the twin test of RFC 0002, TypeScript against TypeScript, so it is cheap now and reused later) |
| 3 | **buf breaking against main** | the protocol integer staying 1 | `WIRE_JSON`, `RPC_NO_DELETE` on `events.proto`, `http.proto`, `control.proto`; a removed or retyped field fails CI, so "additive only" is mechanical |
| 4 | **Spacesheep's own test** | hosting on spacesheep.dev | spacesheep's receiver integration test for sessionpipe (it exists for 0.12) runs against each sessionpipe prerelease in spacesheep CI before `npm publish`. Their repo, their terms |
| 5 | **Staging canary** | the live path | before a release, `sessionpipe replay --sink` this machine's outbox into spacesheep staging with the release candidate; accepted, duplicate and rejected counts equal the previous version's |
| 6 | **CLI parity** | scripts and people at the terminal | every command's `--help` and the `--json` of status, doctor, pool and ask snapshotted from 0.13.3; diffed on every PR. No spelling changes under this RFC; `replaces` exists for later |
| 7 | **Harness config parity** | every installed machine | `install` over a 0.13 config: no diff; `uninstall`: byte identical (today's test, kept) |
| 8 | **Hook untouched** | Antigravity's stdout, hook timing | `hook.ts` and the launcher are not in this RFC's diff; `bench:hook` stays under its threshold |
| 9 | **Socket compatibility** | an old hook talking to a new daemon mid-update | each 0.13 request line pinned in a test; `op` names kept as `oneof` arms |
| 10 | **GUI unchanged** | sessionpipe-gui | its spawned `sessionpipe control pair`, its `npx sessionpipe install` text, its "sessionpipe" string match in hook entries all kept; its conformance runner green against the new core |
| 11 | **Coverage** | the 100 % rule | generated code excluded by path; handlers and doors covered as today |

## 7. Documentation is rendered, never written twice

Every comment in the proto is written for the person who will read it on the website, in
`--help`, in an MCP tool's description and in a generated type's doc string. Those are
four renderings of one sentence, so the sentence is written once and the renderers are
tested to print it.

| Page | Rendered from | Replaces |
|---|---|---|
| `sessionpipe.org/protocol/` events table, tier table, field list | `events.proto` comments, `tier` options, `buf.validate` rules | the hand-kept tables in `PROTOCOL.md` and `PRIVACY.md`; the prose around them stays prose |
| `sessionpipe.org/cli/` every command, flag, exit code, example | `doors.json` | `help.ts`, the CLI README's command sections |
| `--help` on every command | `doors.json` compiled into the binary | the same text as the website, by construction |
| MCP tool descriptions and schemas | `doors.json` | nothing today; new |
| `ADAPTERS.md`'s harness table | the `Harness` enum's per-value options | the hand-kept table |
| `schemas/v1/*.json` `description` fields | the same comments | today's schemas have none |
| `docs/rfcs/` and `docs/rfcs/decisions/` | written by hand | the why; the one place prose is the source |

Rules that keep it readable:

- One sentence per method, one per field, written for a person, the first sentence
  standing alone (the generator uses the first sentence where space is short).
- A field with no comment borrows its type's, as spacesheep's generator does; a list
  never borrows, it needs its own line.
- `buf lint` with the `COMMENTS` rules on: a method or field without a comment fails CI.
- The website build fails if any rendered page differs from the committed one, as the
  schemas do today.

## 8. How it grows without touching what is there

"Scalable" here means: each kind of addition is one place, and that place is named.

| To add | You write | Everything else is generated |
|---|---|---|
| an event type | one message in `events.proto` with a `tier`, one arm in `Event.data`, one fixture | its schema, its row on the protocol page, its type in core, `filterEvent`'s rule |
| a field on an event | one line with a comment and a `tier` | same; `buf breaking` proves it is additive |
| a harness | one adapter file (Rust) plus fixtures, one value in the `Harness` enum with its config paths and hook events as options | the adapters table, `install`'s `--<harness>` flag, the hook entries it writes, the mutation suite |
| a command | one `rpc` with a comment, one handler | its CLI spelling, flags, `--help`, `--json`, its MCP tool if `door` says so, its docs page, its usage line |
| a door | one module that reads `doors.json` (a REST door for the daemon, a Tauri door for the desktop app, a Slack door) | nothing else: handlers never knew their door |
| a language binding | one `buf.gen.yaml` plugin line (Swift for the iOS app, Go, Python) | every type, with its comments |
| a sink kind | one message in `config.proto` as a `oneof` arm, one sender | `sink add`'s flags and help |
| a receiver | nothing in this repo: `spec/HTTP.md` and the conformance suite | |
| a refusal word | one enum value with its meaning | its status, exit code, MCP form, and the docs' error table |

What is *not* on the list: editing `cli.ts`, `help.ts`, a README table, a schema file,
`ADAPTERS.md`, or a type by hand. If a change needs one of those, the generator is
missing a rule, and the fix is the rule.

## 9. The gate that keeps the proto the source of truth

CI fails when:

1. `buf lint` or `buf breaking --against main` fails on `proto/`.
2. Any generated file (`schemas/v1/`, `packages/core/gen/`,
   `shared/doors.json`, the website's tables) differs from a fresh generation.
3. A handler exists for a call the table doesn't have, or a call has a `door` and no
   handler (by importing the handler table, not by grepping).
4. A `.proto` change under `events.proto`, `http.proto` or `control.proto` lands without a
   change under `conformance/` (the existing spec-change rule, pointed at the new source).
5. A call lists an error word its handler never throws, or throws one it doesn't list
   (a test that runs every handler's refusal paths; the enum makes a misspelling a type
   error first).
6. The twin test disagrees, once a second implementation exists.

## 10. Order of work

| # | Step | Touches | Done when | Release |
|---|---|---|---|---|
| 1 | `proto/` for the wire: `events`, `http`, `control`, `options`; `tools/doors` writes `schemas/v1/` and `packages/core/gen/v1.ts` (decision 002, unused until step 2); the tier goldens (decision 003) | new files; `scripts/schemas.mjs` retired | gates 1, 3 green; Zod kept one release, held equal to the proto by `tools/doors/test/parity.test.ts` | **built 2026-11-08** on `one-definition/step-1` (decision 001); a patch; then **one release cycle on spacesheep before step 2** |
| 2 | Generated TS types in core; `filterEvent` and `TYPE_TIER` from `tier` options | `packages/core` | goldens unchanged; GUI builds against the new core (gate 10) | minor |
| 3 | The command surface in proto; `doors.json`; the CLI door; status, doctor, sink list first | `packages/cli` | gate 6; every command has `--json`; `help.ts` deleted; website reads the table | minor |
| 4 | `local.proto` and the socket door | `packages/cli/src/control` | gate 9 | minor |
| 5 | `sessionpipe mcp` | `packages/cli` | `ask` and `status` work from a Claude Code session with no shell | minor |
| 6 | Docs rendered from the proto (§7) | `website/`, `spec/` | the rendered pages equal the committed ones in CI | with 3 |

Step 1 is both the smallest step and the entire wire risk, so it goes alone. Steps 2–6
touch nothing a receiver sees; they each ship as a normal minor release with gates 4 and 5
run before publishing. Rust begins only as RFC 0002, after step 6.

## 11. What this RFC could not check

The three spacesheep write-ups (`ssapi-2`, `ssapi-4`, `ssapi-17`) are in @james's
private space; the spacesheep account signed in on this machine (`@osomishka-bc4d`) is
not allowed to read them. This document was written from the SSAPI source and its 31
decision records in the spacesheep clone (`main` at 3d2f3eb0, the `sp0100-rb`
worktree). Anything the write-ups add that isn't in the code, in particular ssapi-17's
review findings, should be folded in once they can be read.
