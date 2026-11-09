# RFC 0002 · One Rust core: the client as a local binary, bound to Node for receivers

- **Status:** Decided in principle 2026-11-09 (the maintainer chose one Rust core bound to
  Node over two implementations); work begins after RFC 0001 step 3
- **Depends on:** RFC 0001 steps 1–3 (the wire, the types and the command surface in the
  proto), `spec/OUTBOX.md`, the tier goldens (decision 003)
- **Rendered:** https://spacesheep.dev/@osomishka-bc4d/one-definition-docs (roadmap section)

## 0. In one paragraph

sessionpipe becomes one Rust binary per platform: hook, worker, adapters, privacy, outbox,
CLI, daemon and the MCP server, installable by Homebrew, `curl | sh`, `winget`,
`cargo-binstall` or a plain download, with no Node on the machine. The protocol logic lives
once, in a Rust crate, and `sessionpipe-core` on npm becomes a thin N-API binding to that
crate with the same exported names, so sessionpipe-gui and every other TypeScript receiver
keep importing what they import today while the GUI's native apps share the same crate
directly. The npm package `sessionpipe` becomes an installer of the binary, so `npx sessionpipe
connect` keeps working. Every step is gated by the twin test: both implementations, every
fixture, golden and vector, identical output, until the TypeScript client is deleted.

## 1. The decision: one core, not two

| Option | Who implements `filterEvent`, the verifier, redaction, the outbox reader | Chosen |
|---|---|---|
| Two implementations, one set of vectors | Rust for the client; TypeScript `sessionpipe-core` kept for receivers, both held to the same fixtures | no: drift is caught, not prevented, and two codebases carry the protocol forever |
| **One Rust core, bound to Node** | the Rust crate only; `sessionpipe-core` on npm is an N-API binding (napi-rs) with the same API; the GUI's desktop and mobile apps use the crate directly | **yes** |

What it costs the GUI: its install gains platform binaries as optional dependencies, the
pattern esbuild and Biome use. What it gives: the signer in `sp-identity`, the receiver list
in `sp-receivers` and the verifier in core finally sit in one language with one set of
vectors, and the Node server and the native apps cannot disagree.

Fallback, named now: if the binding cannot cover an API the GUI needs, that function stays
in TypeScript inside the binding package, held to the vectors, until it can.

## 2. The crates

```
crates/
  sp-proto       generated from proto/ (prost + our options); the messages every crate shares
  sp-core        privacy filter, redaction rulesets, outbox (OUTBOX.md), control verifier, ULID, paths
  sp-adapters    one file per harness, driven by conformance/harness fixtures and the mutation suite
  sp-hook        the hook binary's logic: stdin → job file → spawn worker → Antigravity's answer
  sp-worker      a job → the adapter → events → filter → outbox; the drain to sinks
  sp-daemon      the control daemon: poll, verify, deliver, waiter, pool, ask; the local socket
  sp-cli         the doors: CLI (reads doors.json compiled in), MCP over stdio, the socket client
  sp-node        the N-API binding: `sessionpipe-core`'s exports over sp-core and sp-proto
```

The GUI's `apps/crates/sp-identity` and `sp-receivers` move into this workspace or depend on
it; that is the GUI's own RFC.

## 3. Order, each step a release, each gated

| Step | Ships | Gate |
|---|---|---|
| R1 | `sp-hook` inside the npm package as a platform binary; the launcher `exec`s it when present, node otherwise | `bench:hook` p50 < 5 ms; the twin test on every harness fixture and every mutation: identical job files and stdout bytes; OUTBOX.md's vectors |
| R2 | `sp-worker` with `sp-adapters` and `sp-core` | twin test on events; the 66×8 tier goldens; the 66 redaction vectors; two writers in two languages on one outbox |
| R3 | `sp-node`: `sessionpipe-core` on npm becomes the binding; the GUI upgrades | the GUI's own tests and conformance runner green; every exported name present; the control vectors through the binding |
| R4 | `sp-cli`: the three doors from `doors.json` | every command's `--json` identical to the TypeScript door's; the usage table identical |
| R5 | `sp-daemon` | the 136 control vectors; the 19 delivery scenarios; the GUI's conformance runner against it; the socket compatibility test |
| R6 | the TypeScript client deleted; `sessionpipe` on npm is the installer; standalone installs documented | the twin test is deleted with it |

Standalone installs (Homebrew tap, `curl | sh`, `winget`, `cargo-binstall`) start at R1 for
the hook alone and become the whole client at R4. Until R4 a machine with no node still
needs `npx` once for `install` and `connect`; the install page says so.

## 4. Zero disruption, named per consumer

| Consumer | Depends on | Held by |
|---|---|---|
| spacesheep.dev | the wire only; `spacesheep machine on` running `npx sessionpipe`; the client's version string for feature gates | the fixtures; the npm installer; one version line, never restarted at 1.0 |
| sessionpipe-gui (Node) | `sessionpipe-core`'s exports; tailing the outbox files; spawning `sessionpipe control pair`; the string "sessionpipe" in hook entries | the binding keeps every name; OUTBOX.md and its vectors; the CLI's `--json` door (RFC 0001 step 3); the launcher path keeps the word |
| sessionpipe-gui (desktop, iOS, Android) | its own Rust crates | they depend on `sp-core` instead of re-implementing it |
| Every installed machine | hook entries; the outbox; config.json; control.json; the keychain entries | the launcher indirection; OUTBOX.md; `config.proto` (RFC 0001 step 3); the same keychain service and account names |
| Receivers written against `sessionpipe-conformance` | the suite | unchanged; it tests receivers, not the client |

## 5. What this RFC does not decide

- The exact N-API surface: taken from what the GUI imports when R3 begins, nothing more.
- Whether `sessionpipe-receiver` (the reference receiver) stays TypeScript: yes until someone
  needs otherwise; it is the other side of the wire.
- Windows: named pipes, `%LOCALAPPDATA%`, no launcher. R1 ships the Rust hook on Windows as a
  direct entry, as node is today; the launcher stays Unix-only.
- Coverage: `cargo-llvm-cov` at the same 100 % threshold from R1, or the rule dies in the port.
  Where the threshold cannot hold (platform-specific keychain code), the exclusion is named in
  the crate, as `dist/` is today.

## 6. Before any Rust is written

1. `spec/OUTBOX.md` with its vectors (`conformance/outbox/`): the one interface between the
   hook and the GUI that had no spec. Done with this RFC.
2. RFC 0001 step 3: the command surface in the proto, so `sp-cli` is generated from a table
   rather than ported from hand-written dispatch.
3. A Rust toolchain in CI and on a maintainer's machine. The solid Mac has none today.
