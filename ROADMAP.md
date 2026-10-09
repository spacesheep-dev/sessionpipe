# Roadmap

The build plan, mirrored here as checkboxes. A milestone is ticked with the commit
that closed it. Downloads are tracked weekly once published.

| # | Milestone | Days | Done | Closing commit |
|---|-----------|-----:|:----:|----------------|
| M0 | Repository, legal, CI | 1 | ☑ | c8f2c30; all four packages published 2026-09-28: sessionpipe, sessionpipe-core, sessionpipe-receiver, sessionpipe-conformance (unscoped until the @sessionpipe org exists) |
| M1 | Spec v1, schemas, fixtures | 3 | ◐ | 6a4cade (spec, schemas, Codex + partial Claude Code fixtures; Gemini CLI, Antigravity and Claude Code tool-event recordings pending) |
| M2 | Core + CLI + 5 adapters (Claude Code, Codex, Gemini CLI, Antigravity, Devin) | 5 | ◐ | built; sessionpipe@0.1.0 on npm; hook p50 25 ms wall / 1 ms in-process; installed on the maintainer's Mac (Gemini CLI not present there); Devin added 2026-10-08 with its SQLite session store; 408 tests |
| M3 | HTTP sink + reference receiver + conformance runner | 3 | ☐ | |
| M4 | sessionpipe.org | 2 | ◐ | site + Pages workflow shipped early; DNS live; Lighthouse pending |
| M5 | spacesheep speaks sessionpipe (in the spacesheep repo) | 2 | ◐ | receiver live 2026-09-28 (spacesheep PRs 364, 366): well-known + events route, tier 2; the maintainer's Mac reports through it (465 sessions replayed); CLI 2.0 delegation and the conformance run in spacesheep CI pending |
| M6 | Control channel | 3 | ◐ | spec rewritten (PR #24: signed on the device, verified on the machine, one poll per machine); daemon, `sessionpipe wait`, Claude Code delivery modes and hook output built (P3 PR); first receiver: spacesheep |
| M7 | Cursor, Copilot CLI, Droid, Kiro, OpenCode + OTLP sink + launch | 3 | ☐ | |

## Definitions of done

- **M0** — public repo with every legal and open-source file; CI runs lint + typecheck
  + tests + schema-sync on Node 20/22/24 × ubuntu/macos/windows; branch protection
  requires green CI and DCO; Dependabot and secret scanning on; 0.0.0 placeholders of
  each package name claimed on npm.
- **M1** — `spec/PROTOCOL.md`, `HTTP.md`, `PRIVACY.md`, `CONTROL.md`, `ADAPTERS.md`,
  `VERSIONING.md` complete; `schemas/v1/*.json` generated and validated in CI;
  `conformance/` holds real hook payloads for Claude Code, Codex, Gemini CLI and
  Antigravity, the redaction vectors, and the delivery scenarios.
- **M2** — `sessionpipe install` wires the four harnesses; file and stdout sinks
  receive tier 0–3 events; `sessionpipe tail` shows a live session; hook p50 < 150 ms
  by `sessionpipe doctor`; every adapter fixture passes; uninstall leaves configs
  byte-identical.
- **M3** — `npx sessionpipe-receiver` runs on a laptop and in Docker; conformance
  scores it 100 %; the HTTP sink retries on 5xx, splits on 413, drops on 4xx.
- **M4** — site live on sessionpipe.org over HTTPS; `/protocol/` from `spec/`;
  `/schema/v1/event.json` resolves as `application/json`; redirects from the other
  three domains; Lighthouse accessibility ≥ 95.
- **M5** — spacesheep.dev serves the well-known file and the events route, passes
  conformance; CLI 2.0 delegates to sessionpipe; no gap in `/sessions`.
- **M6** — permission answers, prompt delivery at the turn boundary, cancel where the
  harness allows; every outcome acked; fixtures for timeout, expiry, double delivery.
- **M7** — five more adapters on real payloads; OTLP sink in a local Grafana; launch
  materials ready.

## Steps that need the maintainer's own hands

1. Create the public repo (or approve the one the executor created).
2. npm: create the `@sessionpipe` org; first `npm publish` of each package from a
   release tag; enable trusted publishing for the GitHub workflow per package.
3. Reserve `sessionhooks` and `session-hooks` on npm as deprecated aliases.
4. DNS for sessionpipe.org → GitHub Pages; enable HTTPS in Pages settings.
5. Redirects for sessionpipe.com, sessionhooks.org, sessionhooks.com.
6. Email forwarding for security@, conduct@, privacy@, hello@.
7. Repo settings the API cannot set: private vulnerability reporting, the DCO app,
   secret-scanning push protection, Pages custom domain.
8. Approve the M5 push to spacesheep main (a production deploy).
9. Optional: trademark filing; a lawyer's glance at TRADEMARKS.md and the privacy notice.
10. Post the launch.
11. Decide, at the first outside PR, whether the second-maintainer rule applies.

## Metrics

| Metric | Baseline (2026-09-28) | Target at launch |
|--------|----------------------|------------------|
| Hook parent exit p50 / p95 | 123 ms / unknown | < 150 ms / < 400 ms |
| Event → receiver latency p50 | unknown | < 2 s laptop, < 5 s spacesheep |
| Events accepted on first try | unknown | > 99 % |
| Receivers passing conformance | 0 | 2 |
| Machines reporting | 4 | same 4, no gap |
| npm weekly downloads | 0 | tracked weekly here |
